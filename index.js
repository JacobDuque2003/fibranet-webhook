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

let ultimoPingMercately = null;

// ════════════════════════════════════════════════════════
// 🎓 NUEVO EN v5.2: FUNCIÓN PARA CAPITALIZAR NOMBRES
// ════════════════════════════════════════════════════════
// Convierte "JACOB DUQUE LOPEZ" → "Jacob Duque Lopez"
// Convierte "maría josé pérez" → "María José Pérez"
function capitalizarNombre(nombre) {
  if (!nombre || typeof nombre !== 'string') return '';

  return nombre
    .trim()                        // Quita espacios al inicio y final
    .toLowerCase()                 // Todo a minúsculas: "jacob duque"
    .split(/\s+/)                  // Divide por espacios: ["jacob", "duque"]
    .filter(palabra => palabra)    // Quita palabras vacías
    .map(palabra => {              // Por cada palabra...
      return palabra.charAt(0).toUpperCase() + palabra.slice(1);
    })
    .join(' ');                    // Une de nuevo: "Jacob Duque"
}

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

function getGoogleAuth(scopes) {
  return new google.auth.JWT(
    GOOGLE_CREDENTIALS.client_email,
    null,
    GOOGLE_CREDENTIALS.private_key,
    scopes
  );
}

app.use((req, res, next) => {
  const rutasMercately = ['/cliente/buscar', '/cliente/deuda', '/cliente/plan', '/pago/info', '/pago/comprobante', '/soporte/reporte', '/soporte/cambio-clave'];
  if (rutasMercately.some(r => req.path === r)) {
    ultimoPingMercately = new Date();
  }
  next();
});

async function leerComprobante(imageUrl) {
  try {
    const auth = getGoogleAuth(['https://www.googleapis.com/auth/cloud-vision']);
    const token = await auth.getAccessToken();

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

    const datos = extraerDatosComprobante(textoCompleto);
    return { exito: true, texto: textoCompleto, datos };
  } catch (err) {
    console.error('Error Vision:', err.message);
    return { exito: false, error: err.message };
  }
}

function extraerDatosComprobante(texto) {
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

  const exitosa = /exitosa|exitoso|aprobado|aprobada|success|realizada|completada|confirmada|\u2713|llegó/i.test(texto);
  const esFibranet = /tapia|fibranet|oscar|aldo|andrea|duque|soledad/i.test(texto);

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

// ════════════════════════════════════════════════════════
// FUNCIONES DE VERIFICACIÓN PARA HEALTH CHECK
// ════════════════════════════════════════════════════════

async function verificarMikroWisp() {
  const inicio = Date.now();
  try {
    const response = await fetch(`${MIKROWISP_URL}/api/v1/GetClientsDetails`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: MIKROWISP_TOKEN, limit: 1 })
    });
    const tiempo = Date.now() - inicio;
    const data = await response.json();

    if (response.ok && data.estado) {
      return { estado: 'ok', mensaje: `API respondió correctamente`, tiempo_respuesta_ms: tiempo, url: MIKROWISP_URL };
    } else {
      return { estado: 'error', mensaje: 'API respondió pero con error', tiempo_respuesta_ms: tiempo, detalle: data };
    }
  } catch (err) {
    return { estado: 'error', mensaje: 'No se pudo conectar a MikroWisp', error: err.message, tiempo_respuesta_ms: Date.now() - inicio };
  }
}

async function verificarGoogleDrive() {
  const inicio = Date.now();
  try {
    if (!process.env.GOOGLE_CLIENT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
      return { estado: 'error', mensaje: 'Variables de entorno faltantes (GOOGLE_CLIENT_EMAIL o GOOGLE_PRIVATE_KEY)' };
    }
    const auth = getGoogleAuth(['https://www.googleapis.com/auth/drive']);
    const drive = google.drive({ version: 'v3', auth });
    const result = await drive.files.get({ fileId: DRIVE_FOLDER_ID, fields: 'id, name' });
    return { estado: 'ok', mensaje: `Carpeta accesible: "${result.data.name}"`, tiempo_respuesta_ms: Date.now() - inicio, carpeta_id: DRIVE_FOLDER_ID };
  } catch (err) {
    return { estado: 'error', mensaje: 'No se pudo acceder a Google Drive', error: err.message, tiempo_respuesta_ms: Date.now() - inicio };
  }
}

async function verificarGoogleVision() {
  const inicio = Date.now();
  try {
    if (!process.env.GOOGLE_CLIENT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
      return { estado: 'error', mensaje: 'Variables de entorno faltantes' };
    }
    const auth = getGoogleAuth(['https://www.googleapis.com/auth/cloud-vision']);
    const token = await auth.getAccessToken();
    if (token && token.token) {
      return { estado: 'ok', mensaje: 'API autenticada correctamente', tiempo_respuesta_ms: Date.now() - inicio };
    } else {
      return { estado: 'error', mensaje: 'No se obtuvo token de acceso' };
    }
  } catch (err) {
    return { estado: 'error', mensaje: 'No se pudo autenticar con Google Vision', error: err.message, tiempo_respuesta_ms: Date.now() - inicio };
  }
}

function verificarMercately() {
  if (!ultimoPingMercately) {
    return { estado: 'desconocido', mensaje: 'Aún no se ha recibido ningún ping de Mercately desde que el servidor arrancó', ultimo_ping: null };
  }
  const ahora = new Date();
  const minutosTranscurridos = Math.floor((ahora - ultimoPingMercately) / 60000);
  if (minutosTranscurridos < 60) {
    return { estado: 'ok', mensaje: `Último ping recibido hace ${minutosTranscurridos} minuto(s)`, ultimo_ping: ultimoPingMercately.toISOString(), minutos_transcurridos: minutosTranscurridos };
  } else if (minutosTranscurridos < 360) {
    return { estado: 'advertencia', mensaje: `Último ping hace ${Math.floor(minutosTranscurridos / 60)} hora(s) - revisa si Mercately está activo`, ultimo_ping: ultimoPingMercately.toISOString(), minutos_transcurridos: minutosTranscurridos };
  } else {
    return { estado: 'error', mensaje: `Sin pings hace más de 6 horas - posible desconexión`, ultimo_ping: ultimoPingMercately.toISOString(), minutos_transcurridos: minutosTranscurridos };
  }
}

// ════════════════════════════════════════════════════════
// ENDPOINT /health - JSON TÉCNICO
// ════════════════════════════════════════════════════════
app.get('/health', async (req, res) => {
  const inicio = Date.now();
  const [mikrowisp, drive, vision] = await Promise.all([verificarMikroWisp(), verificarGoogleDrive(), verificarGoogleVision()]);
  const mercately = verificarMercately();
  const todos_ok = mikrowisp.estado === 'ok' && drive.estado === 'ok' && vision.estado === 'ok' && (mercately.estado === 'ok' || mercately.estado === 'desconocido');

  res.json({
    estado_general: todos_ok ? '✅ TODO OPERATIVO' : '⚠️ HAY PROBLEMAS',
    timestamp: new Date().toISOString(),
    tiempo_total_ms: Date.now() - inicio,
    servicios: {
      railway: { estado: 'ok', mensaje: 'Servidor v5.2 funcionando', version: '5.2', node: process.version, uptime_segundos: Math.floor(process.uptime()) },
      mikrowisp,
      google_drive: drive,
      google_vision: vision,
      mercately
    }
  });
});

// ════════════════════════════════════════════════════════
// ENDPOINT /status - DASHBOARD HTML
// ════════════════════════════════════════════════════════
app.get('/status', async (req, res) => {
  const [mikrowisp, drive, vision] = await Promise.all([verificarMikroWisp(), verificarGoogleDrive(), verificarGoogleVision()]);
  const mercately = verificarMercately();
  const railway = { estado: 'ok', mensaje: `v5.2 · Uptime: ${Math.floor(process.uptime() / 60)} min` };
  const todos_ok = mikrowisp.estado === 'ok' && drive.estado === 'ok' && vision.estado === 'ok' && (mercately.estado === 'ok' || mercately.estado === 'desconocido');

  const colorEstado = (e) => e === 'ok' ? '#22c55e' : e === 'advertencia' ? '#f59e0b' : e === 'desconocido' ? '#6b7280' : '#ef4444';
  const iconoEstado = (e) => e === 'ok' ? '🟢' : e === 'advertencia' ? '🟡' : e === 'desconocido' ? '⚪' : '🔴';
  const tiempoLocal = new Date().toLocaleString('es-EC', { timeZone: 'America/Guayaquil' });

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="refresh" content="30">
<title>FibraNet · Estado del Sistema</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); color: #f1f5f9; min-height: 100vh; padding: 20px; }
  .container { max-width: 800px; margin: 0 auto; }
  .header { text-align: center; margin-bottom: 30px; padding: 30px 20px; background: rgba(255,255,255,0.05); border-radius: 16px; border: 1px solid rgba(255,255,255,0.1); }
  .logo { font-size: 32px; font-weight: 700; margin-bottom: 8px; }
  .logo span { color: #60a5fa; }
  .subtitle { color: #94a3b8; font-size: 14px; }
  .estado-general { margin-top: 16px; padding: 12px 24px; border-radius: 999px; display: inline-block; font-weight: 600; background: ${todos_ok ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)'}; color: ${todos_ok ? '#22c55e' : '#ef4444'}; border: 1px solid ${todos_ok ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}; }
  .servicios { display: grid; gap: 16px; }
  .servicio { background: rgba(255,255,255,0.05); border-radius: 12px; padding: 20px; border: 1px solid rgba(255,255,255,0.1); transition: transform 0.2s; }
  .servicio:hover { transform: translateY(-2px); }
  .servicio-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
  .servicio-nombre { font-size: 18px; font-weight: 600; display: flex; align-items: center; gap: 10px; }
  .servicio-icono { font-size: 24px; }
  .servicio-mensaje { color: #cbd5e1; font-size: 14px; margin-top: 8px; }
  .servicio-detalle { color: #64748b; font-size: 12px; margin-top: 6px; }
  .badge { padding: 4px 12px; border-radius: 999px; font-size: 12px; font-weight: 600; text-transform: uppercase; }
  .footer { text-align: center; margin-top: 30px; color: #64748b; font-size: 13px; }
  .footer a { color: #60a5fa; text-decoration: none; }
  .auto-refresh { display: inline-block; margin-top: 8px; padding: 4px 12px; background: rgba(96,165,250,0.1); border-radius: 999px; font-size: 11px; color: #60a5fa; }
</style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">📡 Fibra<span>Net</span></div>
      <div class="subtitle">Panel de Estado del Sistema · v5.2</div>
      <div class="estado-general">${todos_ok ? '✅ TODO OPERATIVO' : '⚠️ REVISAR SERVICIOS'}</div>
    </div>
    <div class="servicios">
      <div class="servicio" style="border-left: 4px solid ${colorEstado(railway.estado)}">
        <div class="servicio-header">
          <div class="servicio-nombre"><span class="servicio-icono">🚂</span>Railway (Servidor)</div>
          <span class="badge" style="background: ${colorEstado(railway.estado)}20; color: ${colorEstado(railway.estado)}">${iconoEstado(railway.estado)} ${railway.estado.toUpperCase()}</span>
        </div>
        <div class="servicio-mensaje">${railway.mensaje}</div>
        <div class="servicio-detalle">Node ${process.version} · Puerto ${process.env.PORT || 3000}</div>
      </div>
      <div class="servicio" style="border-left: 4px solid ${colorEstado(mikrowisp.estado)}">
        <div class="servicio-header">
          <div class="servicio-nombre"><span class="servicio-icono">🌐</span>MikroWisp (ISP)</div>
          <span class="badge" style="background: ${colorEstado(mikrowisp.estado)}20; color: ${colorEstado(mikrowisp.estado)}">${iconoEstado(mikrowisp.estado)} ${mikrowisp.estado.toUpperCase()}</span>
        </div>
        <div class="servicio-mensaje">${mikrowisp.mensaje}</div>
        ${mikrowisp.tiempo_respuesta_ms ? `<div class="servicio-detalle">Tiempo de respuesta: ${mikrowisp.tiempo_respuesta_ms}ms · ${MIKROWISP_URL}</div>` : ''}
        ${mikrowisp.error ? `<div class="servicio-detalle" style="color:#ef4444">Error: ${mikrowisp.error}</div>` : ''}
      </div>
      <div class="servicio" style="border-left: 4px solid ${colorEstado(drive.estado)}">
        <div class="servicio-header">
          <div class="servicio-nombre"><span class="servicio-icono">📁</span>Google Drive</div>
          <span class="badge" style="background: ${colorEstado(drive.estado)}20; color: ${colorEstado(drive.estado)}">${iconoEstado(drive.estado)} ${drive.estado.toUpperCase()}</span>
        </div>
        <div class="servicio-mensaje">${drive.mensaje}</div>
        ${drive.tiempo_respuesta_ms ? `<div class="servicio-detalle">Tiempo de respuesta: ${drive.tiempo_respuesta_ms}ms</div>` : ''}
        ${drive.error ? `<div class="servicio-detalle" style="color:#ef4444">Error: ${drive.error}</div>` : ''}
      </div>
      <div class="servicio" style="border-left: 4px solid ${colorEstado(vision.estado)}">
        <div class="servicio-header">
          <div class="servicio-nombre"><span class="servicio-icono">👁️</span>Google Vision (OCR)</div>
          <span class="badge" style="background: ${colorEstado(vision.estado)}20; color: ${colorEstado(vision.estado)}">${iconoEstado(vision.estado)} ${vision.estado.toUpperCase()}</span>
        </div>
        <div class="servicio-mensaje">${vision.mensaje}</div>
        ${vision.tiempo_respuesta_ms ? `<div class="servicio-detalle">Tiempo de respuesta: ${vision.tiempo_respuesta_ms}ms</div>` : ''}
        ${vision.error ? `<div class="servicio-detalle" style="color:#ef4444">Error: ${vision.error}</div>` : ''}
      </div>
      <div class="servicio" style="border-left: 4px solid ${colorEstado(mercately.estado)}">
        <div class="servicio-header">
          <div class="servicio-nombre"><span class="servicio-icono">💬</span>Mercately (Chatbot)</div>
          <span class="badge" style="background: ${colorEstado(mercately.estado)}20; color: ${colorEstado(mercately.estado)}">${iconoEstado(mercately.estado)} ${mercately.estado.toUpperCase()}</span>
        </div>
        <div class="servicio-mensaje">${mercately.mensaje}</div>
        ${mercately.ultimo_ping ? `<div class="servicio-detalle">Último contacto: ${new Date(mercately.ultimo_ping).toLocaleString('es-EC', { timeZone: 'America/Guayaquil' })}</div>` : ''}
      </div>
    </div>
    <div class="footer">
      <div>📍 Zamora, Ecuador · ${tiempoLocal}</div>
      <div class="auto-refresh">🔄 Auto-actualización cada 30 segundos</div>
      <div style="margin-top: 12px;"><a href="/health">Ver JSON técnico (/health)</a></div>
    </div>
  </div>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

app.get('/', (req, res) => {
  res.json({ estado: 'FibraNet Webhook activo ✅', version: '5.2' });
});

// ════════════════════════════════════════════════════════
// 🎓 BUSCAR CLIENTE - ACTUALIZADO EN v5.2
// ════════════════════════════════════════════════════════
app.post('/cliente/buscar', async (req, res) => {
  try {
    const { cedula, intento } = req.body;
    const numeroIntento = parseInt(intento || 1);

    // 🎓 Log para debugging - vemos qué llega de Mercately
    console.log(`📞 [BUSCAR] Cédula recibida: "${cedula}" | Intento: ${numeroIntento}`);

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

    // 🎓 v5.2: Capitalización profesional
    // MikroWisp guarda "JACOB DUQUE" → lo convertimos a "Jacob Duque"
    const nombreCompleto = capitalizarNombre(cliente.nombre);
    const primerNombre = nombreCompleto.split(' ')[0];

    console.log(`✅ [BUSCAR] Cliente encontrado: ${nombreCompleto} (cédula: ${cliente.cedula})`);

    return res.json({
      encontrado: true,
      id: cliente.id,
      nombre: nombreCompleto,        // "Jacob Duque" (antes era "JACOB DUQUE")
      primerNombre: primerNombre,    // "Jacob" (antes era "JACOB")
      cedula: cliente.cedula,
      deuda,
      facturasPendientes,
      plan: servicio?.perfil || 'N/A',
      estadoConexion: servicio?.status_user || 'N/A',
      costo: servicio?.costo || '0',
      idServicio: servicio?.id,
      mensaje: `✅ *¡Bienvenido ${primerNombre}!*\n\nTe identifiqué en nuestro sistema. 👋\n\n¿En qué puedo ayudarte hoy?`
    });
  } catch (err) {
    console.error('Error buscar cliente:', err);
    res.status(500).json({ encontrado: false, transferir: true, mensaje: '⚠️ Error del sistema. Un asesor te atenderá.' });
  }
});

// ────────────────────────────────────────
// VER DEUDA - v5.2 con capitalización
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
    const nombreCompleto = capitalizarNombre(cliente.nombre);
    const primerNombre = nombreCompleto.split(' ')[0];

    if (facturas === 0) return res.json({ deuda: 0, mensaje: `✅ *${primerNombre}*, no tienes deudas pendientes.\n\n¡Gracias por mantener tu pago al día! 🎉` });
    return res.json({ deuda, facturas, mensaje: `💰 *Estado de cuenta:*\n\n👤 ${nombreCompleto}\n📋 Facturas pendientes: *${facturas}*\n💵 Total a pagar: *$${deuda.toFixed(2)}*\n\nPara pagar selecciona *"📸 Pagar mi servicio"* en el menú.` });
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
// PROCESAR COMPROBANTE
// ────────────────────────────────────────
app.post('/pago/comprobante', async (req, res) => {
  try {
    const { idcliente, nombre, cedula, imagen_url } = req.body;
    if (!imagen_url) return res.json({ activado: false, mensaje: '📸 Por favor envía una *foto clara* del comprobante de transferencia.' });

    const clienteResponse = await fetch(`${MIKROWISP_URL}/api/v1/GetClientsDetails`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: MIKROWISP_TOKEN, idcliente })
    });
    const clienteData = await clienteResponse.json();
    const cliente = clienteData.datos?.[0];
    const deuda = parseFloat(cliente?.facturacion?.total_facturas || 0);

    const facturasResponse = await fetch(`${MIKROWISP_URL}/api/v1/GetInvoices`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: MIKROWISP_TOKEN, idcliente, estado: 'no pagada' })
    });
    const facturasData = await facturasResponse.json();
    const facturas = facturasData.facturas || [];
    const facturaPendiente = facturas.find(f => f.estado !== 'pagado');

    const ocr = await leerComprobante(imagen_url);
    if (!ocr.exito) return res.json({ activado: false, mensaje: '⚠️ No pude leer el comprobante. Por favor envía una foto más clara y nítida. 📸' });

    const { monto, comprobante, exitosa, esFibranet, banco } = ocr.datos;

    if (!exitosa) return res.json({ activado: false, mensaje: '❌ La transferencia no aparece como exitosa en el comprobante.\n\nVerifica que la transferencia fue aprobada e intenta de nuevo.' });
    if (!esFibranet) return res.json({ activado: false, mensaje: '⚠️ El comprobante no parece ser un pago a FibraNet.\n\nVerifica que transferiste a las cuentas correctas de FibraNet e intenta de nuevo.' });
    if (!monto) return res.json({ activado: false, mensaje: '⚠️ No pude leer el monto del comprobante. Por favor envía una foto más clara. 📸' });

    if (monto < deuda - 0.10) {
      await subirImagenDrive(imagen_url, nombre || 'cliente', cedula || 'sin-cedula', comprobante || Date.now());
      return res.json({ activado: false, mensaje: `⚠️ *Pago incompleto*\n\n💰 Tu deuda: *$${deuda.toFixed(2)}*\n💵 Monto recibido: *$${monto.toFixed(2)}*\n❗ Falta: *$${(deuda - monto).toFixed(2)}*\n\nPor favor completa el pago y envía el nuevo comprobante.` });
    }

    const drive = await subirImagenDrive(imagen_url, nombre || 'cliente', cedula || 'sin-cedula', comprobante || Date.now());

    if (facturaPendiente) {
      const pagoResponse = await fetch(`${MIKROWISP_URL}/api/v1/PaidInvoice`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: MIKROWISP_TOKEN, idfactura: facturaPendiente.id, pasarela: 'WhatsApp-Transferencia', cantidad: monto, idtransaccion: comprobante || `WA-${Date.now()}`, fechalimite: new Date().toISOString().slice(0, 19).replace('T', ' ') })
      });
      const pagoData = await pagoResponse.json();

      if (pagoData.estado === 'exito') {
        let mensajeExtra = '';
        if (monto > deuda + 0.10) mensajeExtra = `\n💰 Saldo a favor: *$${(monto - deuda).toFixed(2)}* — se aplicará al próximo mes.`;
        return res.json({ activado: true, banco, comprobante, mensaje: `⚡ *¡Servicio activado exitosamente!*\n\n✅ Pago verificado: *$${monto.toFixed(2)}*\n🏦 Banco: ${banco}\n🔑 Comprobante: #${comprobante}${mensajeExtra}\n\n📡 Tu internet ya está activo.\n¡Gracias por tu pago! 🙌` });
      }
    }

    return res.json({ activado: false, mensaje: `✅ Comprobante recibido y guardado.\n\n🔑 Ref: #${comprobante || 'N/A'}\n💵 Monto: $${monto.toFixed(2)}\n\nUn asesor verificará y activará tu servicio en breve. ⏰` });

  } catch (err) {
    console.error('Error comprobante:', err);
    res.status(500).json({ activado: false, mensaje: '⚠️ Error procesando el comprobante. Un asesor lo revisará manualmente.' });
  }
});

// ────────────────────────────────────────
// VER PLAN - v5.2 con capitalización
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
    const primerNombre = capitalizarNombre(cliente.nombre).split(' ')[0];

    res.json({ mensaje: `📡 *Información de tu servicio:*\n\n👤 ${primerNombre}\n📋 Plan: *${servicio.perfil}*\n💰 Costo mensual: $${servicio.costo}\n${estadoIcon} Conexión: *${servicio.status_user}*\n🔌 IP: ${servicio.ip}\n📅 Cliente desde: ${servicio.instalado}` });
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
    const nombreBonito = capitalizarNombre(nombre || 'Cliente');
    res.json({ ticket, mensaje: `🔧 *Reporte técnico registrado*\n\n📋 Ticket: #${ticket}\n👤 ${nombreBonito}\n⚠️ ${problemas[problema] || descripcion}\n\n✅ Nuestro equipo técnico fue notificado.\n\n👨‍💻 Para hablar con un asesor selecciona esa opción en el menú.` });
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
    const nombreBonito = capitalizarNombre(nombre || 'Cliente');
    res.json({ ticket, mensaje: `🔑 *Solicitud de cambio de clave registrada*\n\n📋 Ticket: #${ticket}\n👤 ${nombreBonito}\n🔐 Nueva clave: ${nueva_clave}\n\n✅ Un técnico procesará tu solicitud en las próximas *2 horas hábiles*.` });
  } catch (err) {
    res.status(500).json({ mensaje: '⚠️ Error del sistema.' });
  }
});

app.get('/nuevo-cliente', (req, res) => {
  res.json({ mensaje: `🌟 *¡Gracias por tu interés en FibraNet!*\n\nSomos proveedores de internet de fibra óptica en Zamora.\n\nUn asesor te contactará con información de planes y cobertura. 🌐` });
});

app.get('/despedida', (req, res) => {
  res.json({ mensaje: `👋 *¡Hasta pronto!*\n\nGracias por contactar a *FibraNet* 🌐\nEscríbenos cuando necesites ayuda.\n\n_FibraNet — Soluciones GPON_` });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 FibraNet Webhook v5.2 corriendo en puerto ${PORT}`));

Upgrade to v5.2: capitalize names from MikroWisp + add debug logs
