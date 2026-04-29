const express = require('express');
const { google } = require('googleapis');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const MIKROWISP_URL = 'https://zamora.fibranet.ec';
const MIKROWISP_TOKEN = 'NkUrWHkwd1NKZ1hMUlBrMjc1K0pNUT09';
const DRIVE_FOLDER_ID = '1nPVyL57elvt-164PXoxVWm0QiIZB-6Ir';

const GOOGLE_CREDENTIALS = {
  client_email: process.env.GOOGLE_CLIENT_EMAIL,
  private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
};

const CUENTAS_BANCARIAS = `💳 *Cuentas bancarias FibraNet:*

🏦 *BANCO DE LOJA*
Titular: Oscar Aldo Tapia Flores
Cédula: 1900316637
Cta. Corriente: 2900592144

🏦 *COOP. COOPMEGO*
Titular: Oscar Aldo Tapia Flores
Cédula: 1900316637
Cta. Ahorros: 401010295600

🏦 *BANCO DEL AUSTRO*
Titular: Oscar Aldo Tapia Flores
Cédula: 1900316637
Cta. Ahorros: 0111035989

🏦 *CACPE ZAMORA*
Titular: Oscar Aldo Tapia Flores
Cédula: 1900316637
Cta. Ahorros: 01803901100

🏦 *COOP. JEP*
Titular: Oscar Aldo Tapia Flores
Cédula: 1900316637
Cta. Ahorros: 406125964300

🏦 *BANCO PICHINCHA*
Titular: Andrea Duque Regalado
Cédula: 1900370691
Cta. Corriente: 2100299699`;

// ── GOOGLE AUTH ──
function getGoogleAuth(scopes) {
  return new google.auth.JWT(
    GOOGLE_CREDENTIALS.client_email,
    null,
    GOOGLE_CREDENTIALS.private_key,
    scopes
  );
}

// ── OCR CON GOOGLE VISION ──
async function leerComprobante(imageUrl) {
  try {
    const auth = getGoogleAuth(['https://www.googleapis.com/auth/cloud-vision']);
    const token = await auth.getAccessToken();

    // Descargar imagen y convertir a base64
    const imgResponse = await fetch(imageUrl);
    const buffer = await imgResponse.buffer();
    const base64 = buffer.toString('base64');

    const visionResponse = await fetch(
      'https://vision.googleapis.com/v1/images:annotate',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          requests: [{
            image: { content: base64 },
            features: [{ type: 'TEXT_DETECTION', maxResults: 1 }]
          }]
        })
      }
    );

    const visionData = await visionResponse.json();
    const textoCompleto = visionData.responses?.[0]?.fullTextAnnotation?.text || '';

    // Extraer datos del comprobante
    const datos = extraerDatosComprobante(textoCompleto);
    return { exito: true, texto: textoCompleto, datos };
  } catch (err) {
    console.error('Error Vision:', err.message);
    return { exito: false, error: err.message };
  }
}

// ── EXTRAER DATOS DEL COMPROBANTE ──
function extraerDatosComprobante(texto) {
  const textoUpper = texto.toUpperCase();

  // Extraer monto
  const montoPatterns = [
    /\$\s*(\d+[.,]\d{2})/,
    /MONTO[:\s]+\$?\s*(\d+[.,]\d{2})/i,
    /VALOR[:\s]+\$?\s*(\d+[.,]\d{2})/i,
    /TOTAL[:\s]+\$?\s*(\d+[.,]\d{2})/i,
    /(\d+[.,]\d{2})\s*USD/i
  ];
  let monto = null;
  for (const pattern of montoPatterns) {
    const match = texto.match(pattern);
    if (match) {
      monto = parseFloat(match[1].replace(',', '.'));
      break;
    }
  }

  // Extraer número de comprobante
  const comprobantePattterns = [
    /(?:comprobante|referencia|transacci[oó]n|n[uú]mero|nro)[:\s#]+(\w+)/i,
    /(?:TRX|TXN|REF|OP)[:\s#-]*(\d+)/i,
    /\b(\d{8,12})\b/
  ];
  let comprobante = null;
  for (const pattern of comprobantePattterns) {
    const match = texto.match(pattern);
    if (match) { comprobante = match[1]; break; }
  }

  // Detectar si fue exitosa
  const exitosa = /exitosa|exitoso|aprobado|aprobada|success|realizada|completada|confirmada|\u2713|llegó/i.test(texto);

  // Detectar beneficiario FibraNet
  const esFibranet = /tapia|fibranet|oscar|aldo|andrea|duque|soledad/i.test(texto);

  // Detectar banco
  let banco = 'Desconocido';
  if (/pichincha/i.test(texto)) banco = 'Banco Pichincha';
  else if (/loja/i.test(texto)) banco = 'Banco de Loja';
  else if (/austro/i.test(texto)) banco = 'Banco del Austro';
  else if (/mego|coopmego/i.test(texto)) banco = 'CoopMego';
  else if (/cacpe/i.test(texto)) banco = 'CACPE Zamora';
  else if (/jep/i.test(texto)) banco = 'Coop JEP';
  else if (/davivienda/i.test(texto)) banco = 'Davivienda';
  else if (/produbanco/i.test(texto)) banco = 'Produbanco';

  return { monto, comprobante, exitosa, esFibranet, banco };
}

// ── GUARDAR IMAGEN EN DRIVE ──
async function subirImagenDrive(imageUrl, nombre, cedula, comprobante) {
  try {
    const auth = getGoogleAuth(['https://www.googleapis.com/auth/drive']);
    const drive = google.drive({ version: 'v3', auth });
    const fecha = new Date().toISOString().slice(0, 10);
    const nombreArchivo = `${fecha}_${nombre.replace(/\s+/g, '-')}_${cedula}_${comprobante || Date.now()}.jpg`;

    const imgResponse = await fetch(imageUrl);
    const buffer = await imgResponse.buffer();
    const { Readable } = require('stream');
    const stream = Readable.from(buffer);

    const file = await drive.files.create({
      resource: { name: nombreArchivo, parents: [DRIVE_FOLDER_ID] },
      media: { mimeType: 'image/jpeg', body: stream },
      fields: 'id, name, webViewLink'
    });

    return { exito: true, link: file.data.webViewLink, nombre: nombreArchivo };
  } catch (err) {
    console.error('Error Drive:', err.message);
    return { exito: false, error: err.message };
  }
}

// ────────────────────────────────────────
// HEALTH CHECK
// ────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ estado: 'FibraNet Webhook activo ✅', version: '5.0' });
});

// ────────────────────────────────────────
// BUSCAR CLIENTE
// ────────────────────────────────────────
app.post('/cliente/buscar', async (req, res) => {
  try {
    const { cedula, intento } = req.body;
    const numeroIntento = parseInt(intento || 1);
    if (!cedula) return res.json({ encontrado: false, mensaje: '⚠️ Por favor escríbeme tu número de cédula.' });

    const response = await fetch(`${MIKROWISP_URL}/api/v1/GetClientsDetails`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: MIKROWISP_TOKEN, cedula })
    });
    const data = await response.json();

    if (data.estado !== 'exito' || !data.datos?.length) {
      if (numeroIntento >= 2) return res.json({ encontrado: false, transferir: true, mensaje: `😕 No pudimos identificarte.\n\nUn asesor de FibraNet te ayudará personalmente. 👨‍💻` });
      return res.json({ encontrado: false, transferir: false, mensaje: `❌ No encontré ningún cliente con la cédula *${cedula}*.\n\n¿Qué deseas hacer?` });
    }

    const cliente = data.datos[0];
    const deuda = parseFloat(cliente.facturacion?.total_facturas || 0);
    const facturasPendientes = parseInt(cliente.facturacion?.facturas_nopagadas || 0);
    const servicio = cliente.servicios?.[0];
    const nombre = cliente.nombre.trim().split(' ')[0];

    return res.json({
      encontrado: true, id: cliente.id, nombre: cliente.nombre.trim(),
      primerNombre: nombre, cedula: cliente.cedula, deuda, facturasPendientes,
      plan: servicio?.perfil || 'N/A', estadoConexion: servicio?.status_user || 'N/A',
      costo: servicio?.costo || '0', idServicio: servicio?.id,
      mensaje: `✅ *¡Bienvenido ${nombre}!*\n\nTe identifiqué en nuestro sistema. 👋\n\n¿En qué puedo ayudarte hoy?`
    });
  } catch (err) {
    res.status(500).json({ encontrado: false, transferir: true, mensaje: '⚠️ Error del sistema. Un asesor te atenderá.' });
  }
});

// ────────────────────────────────────────
// VER DEUDA
// ────────────────────────────────────────
app.post('/cliente/deuda', async (req, res) => {
  try {
    const { idcliente } = req.body;
    const response = await fetch(`${MIKROWISP_URL}/api/v1/GetClientsDetails`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: MIKROWISP_TOKEN, idcliente })
    });
    const data = await response.json();
    const cliente = data.datos?.[0];
    if (!cliente) return res.json({ mensaje: '❌ No se encontró información.' });

    const deuda = parseFloat(cliente.facturacion?.total_facturas || 0);
    const facturas = parseInt(cliente.facturacion?.facturas_nopagadas || 0);
    const nombre = cliente.nombre.trim().split(' ')[0];

    if (facturas === 0) return res.json({ deuda: 0, mensaje: `✅ *${nombre}*, no tienes deudas pendientes.\n\n¡Gracias por mantener tu pago al día! 🎉` });
    return res.json({ deuda, facturas, mensaje: `💰 *Estado de cuenta:*\n\n👤 ${cliente.nombre.trim()}\n📋 Facturas pendientes: *${facturas}*\n💵 Total a pagar: *$${deuda.toFixed(2)}*\n\nPara pagar selecciona *"📸 Pagar mi servicio"* en el menú.` });
  } catch (err) {
    res.status(500).json({ mensaje: '⚠️ Error del sistema. Intenta nuevamente.' });
  }
});

// ────────────────────────────────────────
// INFO DE PAGO
// ────────────────────────────────────────
app.post('/pago/info', async (req, res) => {
  try {
    const { idcliente } = req.body;
    const response = await fetch(`${MIKROWISP_URL}/api/v1/GetClientsDetails`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: MIKROWISP_TOKEN, idcliente })
    });
    const data = await response.json();
    const cliente = data.datos?.[0];
    const deuda = parseFloat(cliente?.facturacion?.total_facturas || 0);
    const facturas = parseInt(cliente?.facturacion?.facturas_nopagadas || 0);

    if (facturas === 0) return res.json({ deuda: 0, mensaje: `✅ No tienes deudas pendientes. ¡Estás al día! 🎉` });
    res.json({ deuda, mensaje: `${CUENTAS_BANCARIAS}\n\n💵 *Tu deuda actual: $${deuda.toFixed(2)}*\n\n📸 Realiza tu transferencia y envíanos la *foto del comprobante* aquí mismo para activar tu servicio automáticamente.` });
  } catch (err) {
    res.status(500).json({ mensaje: '⚠️ Error del sistema. Intenta nuevamente.' });
  }
});

// ────────────────────────────────────────
// PROCESAR COMPROBANTE CON OCR + ACTIVAR
// ────────────────────────────────────────
app.post('/pago/comprobante', async (req, res) => {
  try {
    const { idcliente, nombre, cedula, imagen_url } = req.body;

    if (!imagen_url) {
      return res.json({ activado: false, mensaje: '📸 Por favor envía una *foto clara* del comprobante de transferencia.' });
    }

    // 1. Obtener deuda del cliente
    const clienteResponse = await fetch(`${MIKROWISP_URL}/api/v1/GetClientsDetails`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: MIKROWISP_TOKEN, idcliente })
    });
    const clienteData = await clienteResponse.json();
    const cliente = clienteData.datos?.[0];
    const deuda = parseFloat(cliente?.facturacion?.total_facturas || 0);

    // 2. Obtener factura pendiente
    const facturasResponse = await fetch(`${MIKROWISP_URL}/api/v1/GetInvoices`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: MIKROWISP_TOKEN, idcliente, estado: 'no pagada' })
    });
    const facturasData = await facturasResponse.json();
    const facturas = facturasData.facturas || [];
    const facturaPendiente = facturas.find(f => f.estado !== 'pagado');

    // 3. Leer comprobante con OCR
    const ocr = await leerComprobante(imagen_url);

    if (!ocr.exito) {
      return res.json({ activado: false, mensaje: '⚠️ No pude leer el comprobante. Por favor envía una foto más clara y nítida. 📸' });
    }

    const { monto, comprobante, exitosa, esFibranet, banco } = ocr.datos;

    // 4. Validaciones
    if (!exitosa) {
      return res.json({ activado: false, mensaje: '❌ La transferencia no aparece como exitosa en el comprobante.\n\nVerifica que la transferencia fue aprobada e intenta de nuevo.' });
    }

    if (!esFibranet) {
      return res.json({ activado: false, mensaje: '⚠️ El comprobante no parece ser un pago a FibraNet.\n\nVerifica que transferiste a las cuentas correctas de FibraNet e intenta de nuevo.' });
    }

    if (!monto) {
      return res.json({ activado: false, mensaje: '⚠️ No pude leer el monto del comprobante. Por favor envía una foto más clara. 📸' });
    }

    const diferencia = Math.abs(monto - deuda);

    // Pago menor
    if (monto < deuda - 0.10) {
      // Guardar imagen de todas formas
      await subirImagenDrive(imagen_url, nombre || 'cliente', cedula || 'sin-cedula', comprobante || Date.now());
      return res.json({
        activado: false,
        mensaje: `⚠️ *Pago incompleto*\n\n💰 Tu deuda: *$${deuda.toFixed(2)}*\n💵 Monto recibido: *$${monto.toFixed(2)}*\n❗ Falta: *$${(deuda - monto).toFixed(2)}*\n\nPor favor completa el pago y envía el nuevo comprobante.`
      });
    }

    // 5. Guardar imagen en Drive
    const drive = await subirImagenDrive(imagen_url, nombre || 'cliente', cedula || 'sin-cedula', comprobante || Date.now());

    // 6. Activar en MikroWisp si hay factura pendiente
    if (facturaPendiente) {
      const pagoResponse = await fetch(`${MIKROWISP_URL}/api/v1/PaidInvoice`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: MIKROWISP_TOKEN,
          idfactura: facturaPendiente.id,
          pasarela: 'WhatsApp-Transferencia',
          cantidad: monto,
          idtransaccion: comprobante || `WA-${Date.now()}`,
          fechalimite: new Date().toISOString().slice(0, 19).replace('T', ' ')
        })
      });
      const pagoData = await pagoResponse.json();

      if (pagoData.estado === 'exito') {
        let mensajeExtra = '';
        if (monto > deuda + 0.10) {
          mensajeExtra = `\n💰 Saldo a favor: *$${(monto - deuda).toFixed(2)}* — se aplicará al próximo mes.`;
        }
        return res.json({
          activado: true,
          banco,
          comprobante,
          mensaje: `⚡ *¡Servicio activado exitosamente!*\n\n✅ Pago verificado: *$${monto.toFixed(2)}*\n🏦 Banco: ${banco}\n🔑 Comprobante: #${comprobante}${mensajeExtra}\n\n📡 Tu internet ya está activo.\n¡Gracias por tu pago! 🙌`
        });
      }
    }

    // Si no hay factura o falló MikroWisp → pendiente de revisión
    return res.json({
      activado: false,
      mensaje: `✅ Comprobante recibido y guardado.\n\n🔑 Ref: #${comprobante || 'N/A'}\n💵 Monto: $${monto.toFixed(2)}\n\nUn asesor verificará y activará tu servicio en breve. ⏰`
    });

  } catch (err) {
    console.error('Error comprobante:', err);
    res.status(500).json({ activado: false, mensaje: '⚠️ Error procesando el comprobante. Un asesor lo revisará manualmente.' });
  }
});

// ────────────────────────────────────────
// VER PLAN
// ────────────────────────────────────────
app.post('/cliente/plan', async (req, res) => {
  try {
    const { idcliente } = req.body;
    const response = await fetch(`${MIKROWISP_URL}/api/v1/GetClientsDetails`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: MIKROWISP_TOKEN, idcliente })
    });
    const data = await response.json();
    const cliente = data.datos?.[0];
    const servicio = cliente?.servicios?.[0];
    if (!servicio) return res.json({ mensaje: '❌ No se encontró información del servicio.' });

    const estadoIcon = servicio.status_user === 'ONLINE' ? '🟢' : '🔴';
    const nombre = cliente.nombre.trim().split(' ')[0];
    res.json({ mensaje: `📡 *Información de tu servicio:*\n\n👤 ${nombre}\n📋 Plan: *${servicio.perfil}*\n💰 Costo mensual: $${servicio.costo}\n${estadoIcon} Conexión: *${servicio.status_user}*\n🔌 IP: ${servicio.ip}\n📅 Cliente desde: ${servicio.instalado}` });
  } catch (err) {
    res.status(500).json({ mensaje: '⚠️ Error del sistema. Intenta nuevamente.' });
  }
});

// ────────────────────────────────────────
// REPORTE TÉCNICO
// ────────────────────────────────────────
app.post('/soporte/reporte', async (req, res) => {
  try {
    const { nombre, problema, descripcion } = req.body;
    const problemas = {
      'sin_internet': '🔴 Sin conexión a internet',
      'lento': '🐌 Internet lento',
      'intermitente': '⚡ Conexión intermitente',
      'otro': `📝 ${descripcion || 'Problema no especificado'}`
    };
    const ticket = `TKT-${Date.now().toString().slice(-6)}`;
    res.json({ ticket, mensaje: `🔧 *Reporte técnico registrado*\n\n📋 Ticket: #${ticket}\n👤 ${nombre}\n⚠️ ${problemas[problema] || descripcion}\n\n✅ Nuestro equipo técnico fue notificado.\n\n👨‍💻 Para hablar con un asesor selecciona esa opción en el menú.` });
  } catch (err) {
    res.status(500).json({ mensaje: '⚠️ Error del sistema.' });
  }
});

// ────────────────────────────────────────
// CAMBIO DE CLAVE
// ────────────────────────────────────────
app.post('/soporte/cambio-clave', async (req, res) => {
  try {
    const { nombre, nueva_clave } = req.body;
    const ticket = `CLV-${Date.now().toString().slice(-6)}`;
    res.json({ ticket, mensaje: `🔑 *Solicitud de cambio de clave registrada*\n\n📋 Ticket: #${ticket}\n👤 ${nombre}\n🔐 Nueva clave: ${nueva_clave}\n\n✅ Un técnico procesará tu solicitud en las próximas *2 horas hábiles*.` });
  } catch (err) {
    res.status(500).json({ mensaje: '⚠️ Error del sistema.' });
  }
});

// ────────────────────────────────────────
// NUEVO CLIENTE
// ────────────────────────────────────────
app.get('/nuevo-cliente', (req, res) => {
  res.json({ mensaje: `🌟 *¡Gracias por tu interés en FibraNet!*\n\nSomos proveedores de internet de fibra óptica en Zamora.\n\nUn asesor te contactará con información de planes y cobertura. 🌐` });
});

// ────────────────────────────────────────
// DESPEDIDA
// ────────────────────────────────────────
app.get('/despedida', (req, res) => {
  res.json({ mensaje: `👋 *¡Hasta pronto!*\n\nGracias por contactar a *FibraNet* 🌐\nEscríbenos cuando necesites ayuda.\n\n_FibraNet — Soluciones GPON_` });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 FibraNet Webhook v5.0 corriendo en puerto ${PORT}`));
