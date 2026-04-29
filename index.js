const express = require('express');
const { google } = require('googleapis');
const fetch = require('node-fetch');
const app = express();
app.use(express.json({ limit: '50mb' }));

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

// ── GOOGLE DRIVE: subir imagen ──
async function subirImagenDrive(imageUrl, nombre, cedula, comprobante) {
  try {
    const auth = new google.auth.JWT(
      GOOGLE_CREDENTIALS.client_email,
      null,
      GOOGLE_CREDENTIALS.private_key,
      ['https://www.googleapis.com/auth/drive']
    );
    const drive = google.drive({ version: 'v3', auth });
    const fecha = new Date().toISOString().slice(0, 10);
    const nombreArchivo = `${fecha}_${nombre.replace(/\s+/g, '-')}_${cedula}_${comprobante}.jpg`;

    // Descargar imagen
    const imgResponse = await fetch(imageUrl);
    const buffer = await imgResponse.buffer();
    const { Readable } = require('stream');
    const stream = Readable.from(buffer);

    const fileMetadata = { name: nombreArchivo, parents: [DRIVE_FOLDER_ID] };
    const media = { mimeType: 'image/jpeg', body: stream };

    const file = await drive.files.create({
      resource: fileMetadata,
      media,
      fields: 'id, name, webViewLink'
    });

    return { exito: true, link: file.data.webViewLink, nombre: nombreArchivo };
  } catch (err) {
    console.error('Error Drive:', err.message);
    return { exito: false, error: err.message };
  }
}

// ── HEALTH CHECK ──
app.get('/', (req, res) => {
  res.json({ estado: 'FibraNet Webhook activo ✅', version: '4.0' });
});

// ── BUSCAR CLIENTE ──
app.post('/cliente/buscar', async (req, res) => {
  try {
    const { cedula, intento } = req.body;
    const numeroIntento = parseInt(intento || 1);
    if (!cedula) return res.json({ encontrado: false, transferir: false, mensaje: '⚠️ Por favor escríbeme tu número de cédula.' });

    const response = await fetch(`${MIKROWISP_URL}/api/v1/GetClientsDetails`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: MIKROWISP_TOKEN, cedula })
    });
    const data = await response.json();

    if (data.estado !== 'exito' || !data.datos?.length) {
      if (numeroIntento >= 2) {
        return res.json({ encontrado: false, transferir: true, mensaje: `😕 No pudimos identificarte con la cédula *${cedula}*.\n\nUn asesor de FibraNet te ayudará personalmente. Por favor espera un momento. 👨‍💻` });
      }
      return res.json({ encontrado: false, transferir: false, nuevoIntento: true, mensaje: `❌ No encontré ningún cliente con la cédula *${cedula}*.\n\n¿Qué deseas hacer?` });
    }

    const cliente = data.datos[0];
    const deuda = parseFloat(cliente.facturacion?.total_facturas || 0);
    const facturasPendientes = parseInt(cliente.facturacion?.facturas_nopagadas || 0);
    const servicio = cliente.servicios?.[0];
    const nombre = cliente.nombre.trim().split(' ')[0];

    return res.json({
      encontrado: true, transferir: false,
      id: cliente.id, nombre: cliente.nombre.trim(), primerNombre: nombre,
      cedula: cliente.cedula, estado: cliente.estado, deuda, facturasPendientes,
      plan: servicio?.perfil || 'N/A', estadoConexion: servicio?.status_user || 'N/A',
      costo: servicio?.costo || '0', idServicio: servicio?.id,
      instalado: servicio?.instalado || 'N/A', ip: servicio?.ip || 'N/A',
      mensaje: `✅ *¡Bienvenido ${nombre}!*\n\nTe identifiqué en nuestro sistema. 👋\n\n¿En qué puedo ayudarte hoy?`
    });
  } catch (err) {
    res.status(500).json({ encontrado: false, transferir: true, mensaje: '⚠️ Hubo un error en el sistema. Un asesor te atenderá en un momento.' });
  }
});

// ── VER DEUDA ──
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

// ── INFO DE PAGO ──
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

// ── PROCESAR PAGO + GUARDAR EN DRIVE ──
app.post('/pago/procesar', async (req, res) => {
  try {
    const { idfactura, cantidad, idtransaccion, numero_comprobante, nombre, cedula, imagen_url } = req.body;
    const txId = idtransaccion || numero_comprobante || `WA-${Date.now()}`;

    // Guardar imagen en Drive si existe
    let linkDrive = null;
    if (imagen_url && nombre && cedula) {
      const resultado = await subirImagenDrive(imagen_url, nombre, cedula, txId);
      if (resultado.exito) linkDrive = resultado.link;
    }

    const response = await fetch(`${MIKROWISP_URL}/api/v1/PaidInvoice`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: MIKROWISP_TOKEN, idfactura,
        pasarela: 'WhatsApp-Transferencia', cantidad,
        idtransaccion: txId,
        fechalimite: new Date().toISOString().slice(0, 19).replace('T', ' ')
      })
    });
    const data = await response.json();

    if (data.estado === 'exito') {
      return res.json({ activado: true, linkDrive, mensaje: `⚡ *¡Servicio activado exitosamente!*\n\n✅ Pago: $${cantidad}\n🔑 Comprobante: #${txId}\n📡 Tu internet ya está activo.\n\n¡Gracias por tu pago! 🙌` });
    }
    return res.json({ activado: false, linkDrive, mensaje: `⚠️ Tu comprobante fue recibido y está siendo verificado.\n\n🔑 Ref: #${txId}\n\nTe notificaremos cuando tu servicio sea activado.` });
  } catch (err) {
    res.status(500).json({ activado: false, mensaje: '⚠️ Error del sistema. Tu pago será revisado manualmente.' });
  }
});

// ── FACTURAS PENDIENTES ──
app.post('/cliente/facturas', async (req, res) => {
  try {
    const { idcliente } = req.body;
    const response = await fetch(`${MIKROWISP_URL}/api/v1/GetInvoices`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: MIKROWISP_TOKEN, idcliente, estado: 'no pagada' })
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ mensaje: '⚠️ Error del sistema.' });
  }
});

// ── VER PLAN ──
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

// ── REPORTE TÉCNICO ──
app.post('/soporte/reporte', async (req, res) => {
  try {
    const { nombre, problema, descripcion } = req.body;
    const problemas = { 'sin_internet': '🔴 Sin conexión a internet', 'lento': '🐌 Internet lento', 'intermitente': '⚡ Conexión intermitente', 'otro': `📝 ${descripcion || 'Problema no especificado'}` };
    const descripcionProblema = problemas[problema] || descripcion || 'Problema técnico';
    const ticket = `TKT-${Date.now().toString().slice(-6)}`;
    res.json({ ticket, mensaje: `🔧 *Reporte técnico registrado*\n\n📋 Ticket: #${ticket}\n👤 ${nombre}\n⚠️ ${descripcionProblema}\n\n✅ Nuestro equipo técnico fue notificado y atenderá tu caso a la brevedad.\n\n👨‍💻 Para hablar con un asesor selecciona esa opción en el menú.` });
  } catch (err) {
    res.status(500).json({ mensaje: '⚠️ Error del sistema. Intenta nuevamente.' });
  }
});

// ── CAMBIO DE CLAVE ──
app.post('/soporte/cambio-clave', async (req, res) => {
  try {
    const { nombre, nueva_clave } = req.body;
    const ticket = `CLV-${Date.now().toString().slice(-6)}`;
    res.json({ ticket, mensaje: `🔑 *Solicitud de cambio de clave registrada*\n\n📋 Ticket: #${ticket}\n👤 ${nombre}\n🔐 Nueva clave: ${nueva_clave}\n\n✅ Un técnico procesará tu solicitud en las próximas *2 horas hábiles*.\n\n👨‍💻 Para hablar con un asesor selecciona esa opción en el menú.` });
  } catch (err) {
    res.status(500).json({ mensaje: '⚠️ Error del sistema. Intenta nuevamente.' });
  }
});

// ── NUEVO CLIENTE ──
app.get('/nuevo-cliente', (req, res) => {
  res.json({ mensaje: `🌟 *¡Gracias por tu interés en FibraNet!*\n\nSomos proveedores de internet de fibra óptica en Zamora.\n\nUn asesor de ventas se comunicará contigo para darte información sobre nuestros planes y cobertura.\n\n¡Bienvenido a la familia FibraNet! 🌐` });
});

// ── DESPEDIDA ──
app.get('/despedida', (req, res) => {
  res.json({ mensaje: `👋 *¡Hasta pronto!*\n\nGracias por contactar a *FibraNet* 🌐\nSi necesitas ayuda escríbenos cuando quieras.\n\n_FibraNet — Soluciones GPON_` });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 FibraNet Webhook v4.0 corriendo en puerto ${PORT}`));
