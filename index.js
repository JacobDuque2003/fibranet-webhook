const express = require('express');
const { google } = require('googleapis');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const MIKROWISP_URL = 'https://zamora.fibranet.ec';
const MIKROWISP_TOKEN = 'NkUrWHkwd1NKZ1hMUlBrMjc1K0pNUT09';
const DRIVE_FOLDER_ID = '1nPVyL57elvt-164PXoxVWm0QiIZB-6Ir';

// 🎓 NUEVO EN v6.0: Variables de Mercately API
const MERCATELY_API_URL = 'https://app.mercately.com/retailers/api/v1';
const MERCATELY_API_KEY = process.env.MERCATELY_API_KEY;

const GOOGLE_CREDENTIALS = {
  client_email: process.env.GOOGLE_CLIENT_EMAIL,
  private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
};

let ultimoPingMercately = null;

const clientesYaSaludados = new Map();
const TIEMPO_RESET_AUTOMATICO_MS = 4 * 60 * 60 * 1000;

function yaFueSaludado(cedula) {
  const timestamp = clientesYaSaludados.get(cedula);
  if (!timestamp) return false;
  const ahora = Date.now();
  if (ahora - timestamp > TIEMPO_RESET_AUTOMATICO_MS) {
    clientesYaSaludados.delete(cedula);
    return false;
  }
  return true;
}

function marcarComoSaludado(cedula) {
  clientesYaSaludados.set(cedula, Date.now());
}

function reiniciarSaludo(cedula) {
  clientesYaSaludados.delete(cedula);
}

function capitalizarNombre(nombre) {
  if (!nombre || typeof nombre !== 'string') return '';
  return nombre.trim().toLowerCase().split(/\s+/).filter(p => p)
    .map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

async function buscarClientePorCedula(cedula) {
  if (!cedula) return { exito: false, error: 'Cédula vacía' };
  try {
    const response = await fetch(`${MIKROWISP_URL}/api/v1/GetClientsDetails`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: MIKROWISP_TOKEN, cedula })
    });
    const data = await response.json();
    if (data.estado !== 'exito' || !data.datos?.length) return { exito: false, error: 'Cliente no encontrado' };
    return { exito: true, cliente: data.datos[0] };
  } catch (err) {
    console.error('Error buscar cliente:', err.message);
    return { exito: false, error: err.message };
  }
}

// ════════════════════════════════════════════════════════
// 🎓 NUEVO EN v6.0: FUNCIONES PARA API DE MERCATELY
// ════════════════════════════════════════════════════════

// Buscar customer_id en Mercately por teléfono
async function buscarCustomerMercately(telefono) {
  try {
    // Limpiar el teléfono - asegurarse que tenga el formato correcto
    const telefonoLimpio = telefono.replace(/\s+/g, '').replace(/[^0-9+]/g, '');

    console.log(`🔍 [MERCATELY API] Buscando customer con teléfono: ${telefonoLimpio}`);

    const response = await fetch(
      `${MERCATELY_API_URL}/whatsapp_conversations?page=1&results_per_page=100`,
      {
        method: 'GET',
        headers: { 'Api-Key': MERCATELY_API_KEY, 'Content-Type': 'application/json' }
      }
    );

    if (!response.ok) {
      console.error(`❌ [MERCATELY API] Error HTTP: ${response.status}`);
      return { exito: false, error: `HTTP ${response.status}` };
    }

    const data = await response.json();
    const conversaciones = data.whatsapp_conversations || [];

    console.log(`📞 [MERCATELY API] Total conversaciones: ${conversaciones.length}`);

    // Buscar la conversación que coincida con el teléfono
    // Probamos varias variantes del teléfono
    const variantes = [
      telefonoLimpio,
      telefonoLimpio.startsWith('+') ? telefonoLimpio : `+${telefonoLimpio}`,
      telefonoLimpio.startsWith('593') ? telefonoLimpio : `593${telefonoLimpio.replace(/^0/, '')}`,
      telefonoLimpio.startsWith('+593') ? telefonoLimpio : `+593${telefonoLimpio.replace(/^0/, '')}`
    ];

    const conversacion = conversaciones.find(c => {
      const phoneClient = (c.phone || '').replace(/\s+/g, '');
      return variantes.some(v => phoneClient === v || phoneClient.endsWith(v.slice(-9)));
    });

    if (!conversacion) {
      console.log(`❌ [MERCATELY API] No se encontró conversación para ${telefonoLimpio}`);
      console.log(`📋 [MERCATELY API] Teléfonos disponibles:`, conversaciones.slice(0, 5).map(c => c.phone));
      return { exito: false, error: 'Conversación no encontrada en Mercately' };
    }

    console.log(`✅ [MERCATELY API] Customer encontrado: ID ${conversacion.customer_id}, Tel: ${conversacion.phone}`);
    return { exito: true, customer_id: conversacion.customer_id, conversacion };

  } catch (err) {
    console.error('❌ [MERCATELY API] Error:', err.message);
    return { exito: false, error: err.message };
  }
}

// Obtener mensajes de un customer específico
async function obtenerMensajesCustomer(customer_id) {
  try {
    console.log(`📨 [MERCATELY API] Obteniendo mensajes de customer_id: ${customer_id}`);

    const response = await fetch(
      `${MERCATELY_API_URL}/customers/${customer_id}/whatsapp_conversations?page=1`,
      {
        method: 'GET',
        headers: { 'Api-Key': MERCATELY_API_KEY, 'Content-Type': 'application/json' }
      }
    );

    if (!response.ok) {
      console.error(`❌ [MERCATELY API] Error HTTP: ${response.status}`);
      return { exito: false, error: `HTTP ${response.status}` };
    }

    const data = await response.json();
    const mensajes = data.whatsapp_conversations || [];

    console.log(`📨 [MERCATELY API] Total mensajes: ${mensajes.length}`);

    return { exito: true, mensajes };
  } catch (err) {
    console.error('❌ [MERCATELY API] Error obtener mensajes:', err.message);
    return { exito: false, error: err.message };
  }
}

// Obtener la URL de la última imagen enviada por el cliente
async function obtenerUltimaImagenComprobante(telefono) {
  try {
    // 1. Buscar customer_id por teléfono
    const resultadoCustomer = await buscarCustomerMercately(telefono);
    if (!resultadoCustomer.exito) {
      return { exito: false, error: resultadoCustomer.error };
    }

    const customer_id = resultadoCustomer.customer_id;

    // 2. Obtener mensajes del customer
    const resultadoMensajes = await obtenerMensajesCustomer(customer_id);
    if (!resultadoMensajes.exito) {
      return { exito: false, error: resultadoMensajes.error };
    }

    // 3. Buscar el último mensaje INBOUND con imagen
    // Los mensajes vienen ordenados por fecha (más reciente primero suele ser)
    const mensajesConImagen = resultadoMensajes.mensajes.filter(m =>
      m.direction === 'inbound' &&
      m.content_media_url &&
      m.content_media_url.length > 0 &&
      (m.content_media_type?.includes('image') || m.content_type === 'image')
    );

    if (mensajesConImagen.length === 0) {
      console.log(`❌ [MERCATELY API] No hay mensajes con imagen del cliente`);
      console.log(`📋 [MERCATELY API] Últimos mensajes:`, resultadoMensajes.mensajes.slice(0, 3).map(m => ({
        direction: m.direction, content_type: m.content_type, has_media: !!m.content_media_url
      })));
      return { exito: false, error: 'Sin imagen reciente del cliente' };
    }

    // Ordenar por fecha descendente (más reciente primero)
    mensajesConImagen.sort((a, b) => new Date(b.created_time) - new Date(a.created_time));
    const ultimaImagen = mensajesConImagen[0];

    console.log(`✅ [MERCATELY API] Última imagen encontrada:`);
    console.log(`   📅 Fecha: ${ultimaImagen.created_time}`);
    console.log(`   🔗 URL: ${ultimaImagen.content_media_url.substring(0, 100)}`);
    console.log(`   📄 Tipo: ${ultimaImagen.content_media_type}`);

    return {
      exito: true,
      url: ultimaImagen.content_media_url,
      tipo: ultimaImagen.content_media_type,
      fecha: ultimaImagen.created_time,
      customer_id
    };

  } catch (err) {
    console.error('❌ [MERCATELY API] Error obtener última imagen:', err.message);
    return { exito: false, error: err.message };
  }
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
  return new google.auth.JWT(GOOGLE_CREDENTIALS.client_email, null, GOOGLE_CREDENTIALS.private_key, scopes);
}

app.use((req, res, next) => {
  const rutasMercately = ['/cliente/buscar', '/cliente/deuda', '/cliente/plan', '/pago/info', '/pago/comprobante', '/soporte/reporte', '/soporte/cambio-clave', '/despedida'];
  if (rutasMercately.some(r => req.path === r)) {
    ultimoPingMercately = new Date();
  }
  next();
});

async function leerComprobante(imageUrl) {
  try {
    const auth = getGoogleAuth(['https://www.googleapis.com/auth/cloud-vision']);
    const token = await auth.getAccessToken();

    console.log(`👁️ [VISION] Descargando imagen desde: ${imageUrl.substring(0, 100)}`);

    // Descargar la imagen (Mercately puede requerir autenticación, pero las URLs de content_media_url suelen ser públicas)
    const imgResponse = await fetch(imageUrl);

    if (!imgResponse.ok) {
      console.error(`❌ [VISION] No se pudo descargar imagen: HTTP ${imgResponse.status}`);
      return { exito: false, error: `No se pudo descargar imagen: HTTP ${imgResponse.status}` };
    }

    const buffer = await imgResponse.buffer();
    const base64 = buffer.toString('base64');

    console.log(`👁️ [VISION] Imagen descargada (${buffer.length} bytes), enviando a Vision API...`);

    const visionResponse = await fetch('https://vision.googleapis.com/v1/images:annotate', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{ image: { content: base64 }, features: [{ type: 'TEXT_DETECTION', maxResults: 1 }] }]
      })
    });

    const visionData = await visionResponse.json();
    const textoCompleto = visionData.responses?.[0]?.fullTextAnnotation?.text || '';

    console.log(`👁️ [VISION] Texto extraído (${textoCompleto.length} chars)`);

    const datos = extraerDatosComprobante(textoCompleto);
    return { exito: true, texto: textoCompleto, datos };
  } catch (err) {
    console.error('❌ [VISION] Error:', err.message);
    return { exito: false, error: err.message };
  }
}

function extraerDatosComprobante(texto) {
  const montoPatterns = [/\$\s*(\d+[.,]\d{2})/, /MONTO[:\s]+\$?\s*(\d+[.,]\d{2})/i, /VALOR[:\s]+\$?\s*(\d+[.,]\d{2})/i, /TOTAL[:\s]+\$?\s*(\d+[.,]\d{2})/i, /(\d+[.,]\d{2})\s*USD/i];
  let monto = null;
  for (const pattern of montoPatterns) {
    const match = texto.match(pattern);
    if (match) { monto = parseFloat(match[1].replace(',', '.')); break; }
  }
  const comprobantePattterns = [/(?:comprobante|referencia|transacci[oó]n|n[uú]mero|nro)[:\s#]+(\w+)/i, /(?:TRX|TXN|REF|OP)[:\s#-]*(\d+)/i, /\b(\d{8,12})\b/];
  let comprobante = null;
  for (const pattern of comprobantePattterns) {
    const match = texto.match(pattern);
    if (match) { comprobante = match[1]; break; }
  }
  const exitosa = /exitosa|exitoso|aprobado|aprobada|success|realizada|completada|confirmada|correctamente|\u2713|llegó/i.test(texto);
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
  else if (/guayaquil/i.test(texto)) banco = 'Banco Guayaquil';
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
// HEALTH CHECK Y STATUS
// ════════════════════════════════════════════════════════

async function verificarMikroWisp() {
  const inicio = Date.now();
  try {
    const response = await fetch(`${MIKROWISP_URL}/api/v1/GetClientsDetails`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: MIKROWISP_TOKEN, limit: 1 })
    });
    const tiempo = Date.now() - inicio;
    const data = await response.json();
    if (response.ok && data.estado) return { estado: 'ok', mensaje: `API respondió correctamente`, tiempo_respuesta_ms: tiempo, url: MIKROWISP_URL };
    return { estado: 'error', mensaje: 'API respondió pero con error', tiempo_respuesta_ms: tiempo, detalle: data };
  } catch (err) {
    return { estado: 'error', mensaje: 'No se pudo conectar a MikroWisp', error: err.message, tiempo_respuesta_ms: Date.now() - inicio };
  }
}

async function verificarGoogleDrive() {
  const inicio = Date.now();
  try {
    if (!process.env.GOOGLE_CLIENT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) return { estado: 'error', mensaje: 'Variables de entorno faltantes' };
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
    if (!process.env.GOOGLE_CLIENT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) return { estado: 'error', mensaje: 'Variables de entorno faltantes' };
    const auth = getGoogleAuth(['https://www.googleapis.com/auth/cloud-vision']);
    const token = await auth.getAccessToken();
    if (token && token.token) return { estado: 'ok', mensaje: 'API autenticada correctamente', tiempo_respuesta_ms: Date.now() - inicio };
    return { estado: 'error', mensaje: 'No se obtuvo token de acceso' };
  } catch (err) {
    return { estado: 'error', mensaje: 'No se pudo autenticar con Google Vision', error: err.message, tiempo_respuesta_ms: Date.now() - inicio };
  }
}

// 🎓 v6.0: Verificar API de Mercately
async function verificarMercatelyAPI() {
  const inicio = Date.now();
  try {
    if (!MERCATELY_API_KEY) return { estado: 'error', mensaje: 'MERCATELY_API_KEY no configurada en variables de entorno' };

    const response = await fetch(`${MERCATELY_API_URL}/whatsapp_conversations?page=1&results_per_page=1`, {
      method: 'GET',
      headers: { 'Api-Key': MERCATELY_API_KEY, 'Content-Type': 'application/json' }
    });

    const tiempo = Date.now() - inicio;

    if (response.ok) {
      const data = await response.json();
      return { estado: 'ok', mensaje: `API conectada (${data.results || 0} conversaciones)`, tiempo_respuesta_ms: tiempo };
    } else {
      return { estado: 'error', mensaje: `Error HTTP ${response.status}`, tiempo_respuesta_ms: tiempo };
    }
  } catch (err) {
    return { estado: 'error', mensaje: 'No se pudo conectar a Mercately API', error: err.message, tiempo_respuesta_ms: Date.now() - inicio };
  }
}

function verificarMercately() {
  if (!ultimoPingMercately) return { estado: 'desconocido', mensaje: 'Aún no se ha recibido ningún ping de Mercately desde que el servidor arrancó', ultimo_ping: null };
  const ahora = new Date();
  const minutosTranscurridos = Math.floor((ahora - ultimoPingMercately) / 60000);
  if (minutosTranscurridos < 60) return { estado: 'ok', mensaje: `Último ping recibido hace ${minutosTranscurridos} minuto(s)`, ultimo_ping: ultimoPingMercately.toISOString(), minutos_transcurridos: minutosTranscurridos };
  if (minutosTranscurridos < 360) return { estado: 'advertencia', mensaje: `Último ping hace ${Math.floor(minutosTranscurridos / 60)} hora(s)`, ultimo_ping: ultimoPingMercately.toISOString(), minutos_transcurridos: minutosTranscurridos };
  return { estado: 'error', mensaje: `Sin pings hace más de 6 horas - posible desconexión`, ultimo_ping: ultimoPingMercately.toISOString(), minutos_transcurridos: minutosTranscurridos };
}

app.get('/health', async (req, res) => {
  const inicio = Date.now();
  const [mikrowisp, drive, vision, mercatelyApi] = await Promise.all([
    verificarMikroWisp(), verificarGoogleDrive(), verificarGoogleVision(), verificarMercatelyAPI()
  ]);
  const mercately = verificarMercately();
  const todos_ok = mikrowisp.estado === 'ok' && drive.estado === 'ok' && vision.estado === 'ok' && mercatelyApi.estado === 'ok' && (mercately.estado === 'ok' || mercately.estado === 'desconocido');

  res.json({
    estado_general: todos_ok ? '✅ TODO OPERATIVO' : '⚠️ HAY PROBLEMAS',
    timestamp: new Date().toISOString(),
    tiempo_total_ms: Date.now() - inicio,
    servicios: {
      railway: { estado: 'ok', mensaje: 'Servidor v6.0 funcionando', version: '6.0', node: process.version, uptime_segundos: Math.floor(process.uptime()) },
      mikrowisp, google_drive: drive, google_vision: vision, mercately_api: mercatelyApi, mercately_chatbot: mercately
    },
    sesiones: { clientes_saludados_activos: clientesYaSaludados.size, tiempo_reset_automatico_horas: TIEMPO_RESET_AUTOMATICO_MS / (60 * 60 * 1000) }
  });
});

app.get('/status', async (req, res) => {
  const [mikrowisp, drive, vision, mercatelyApi] = await Promise.all([
    verificarMikroWisp(), verificarGoogleDrive(), verificarGoogleVision(), verificarMercatelyAPI()
  ]);
  const mercately = verificarMercately();
  const railway = { estado: 'ok', mensaje: `v6.0 · Uptime: ${Math.floor(process.uptime() / 60)} min` };
  const todos_ok = mikrowisp.estado === 'ok' && drive.estado === 'ok' && vision.estado === 'ok' && mercatelyApi.estado === 'ok' && (mercately.estado === 'ok' || mercately.estado === 'desconocido');
  const colorEstado = (e) => e === 'ok' ? '#22c55e' : e === 'advertencia' ? '#f59e0b' : e === 'desconocido' ? '#6b7280' : '#ef4444';
  const iconoEstado = (e) => e === 'ok' ? '🟢' : e === 'advertencia' ? '🟡' : e === 'desconocido' ? '⚪' : '🔴';
  const tiempoLocal = new Date().toLocaleString('es-EC', { timeZone: 'America/Guayaquil' });

  const html = `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="refresh" content="30"><title>FibraNet · Estado del Sistema</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:linear-gradient(135deg,#0f172a 0%,#1e293b 100%);color:#f1f5f9;min-height:100vh;padding:20px}.container{max-width:800px;margin:0 auto}.header{text-align:center;margin-bottom:30px;padding:30px 20px;background:rgba(255,255,255,0.05);border-radius:16px;border:1px solid rgba(255,255,255,0.1)}.logo{font-size:32px;font-weight:700;margin-bottom:8px}.logo span{color:#60a5fa}.subtitle{color:#94a3b8;font-size:14px}.estado-general{margin-top:16px;padding:12px 24px;border-radius:999px;display:inline-block;font-weight:600;background:${todos_ok ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)'};color:${todos_ok ? '#22c55e' : '#ef4444'};border:1px solid ${todos_ok ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}}.servicios{display:grid;gap:16px}.servicio{background:rgba(255,255,255,0.05);border-radius:12px;padding:20px;border:1px solid rgba(255,255,255,0.1);transition:transform 0.2s}.servicio:hover{transform:translateY(-2px)}.servicio-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}.servicio-nombre{font-size:18px;font-weight:600;display:flex;align-items:center;gap:10px}.servicio-icono{font-size:24px}.servicio-mensaje{color:#cbd5e1;font-size:14px;margin-top:8px}.servicio-detalle{color:#64748b;font-size:12px;margin-top:6px}.badge{padding:4px 12px;border-radius:999px;font-size:12px;font-weight:600;text-transform:uppercase}.footer{text-align:center;margin-top:30px;color:#64748b;font-size:13px}.footer a{color:#60a5fa;text-decoration:none}.auto-refresh{display:inline-block;margin-top:8px;padding:4px 12px;background:rgba(96,165,250,0.1);border-radius:999px;font-size:11px;color:#60a5fa}.sesiones{background:rgba(96,165,250,0.05);border:1px solid rgba(96,165,250,0.2);border-radius:12px;padding:16px;margin-top:16px;text-align:center;color:#94a3b8;font-size:13px}.sesiones strong{color:#60a5fa}</style>
</head><body><div class="container">
<div class="header"><div class="logo">📡 Fibra<span>Net</span></div><div class="subtitle">Panel de Estado del Sistema · v6.0</div><div class="estado-general">${todos_ok ? '✅ TODO OPERATIVO' : '⚠️ REVISAR SERVICIOS'}</div></div>
<div class="servicios">
<div class="servicio" style="border-left:4px solid ${colorEstado(railway.estado)}"><div class="servicio-header"><div class="servicio-nombre"><span class="servicio-icono">🚂</span>Railway (Servidor)</div><span class="badge" style="background:${colorEstado(railway.estado)}20;color:${colorEstado(railway.estado)}">${iconoEstado(railway.estado)} ${railway.estado.toUpperCase()}</span></div><div class="servicio-mensaje">${railway.mensaje}</div><div class="servicio-detalle">Node ${process.version} · Puerto ${process.env.PORT || 3000}</div></div>
<div class="servicio" style="border-left:4px solid ${colorEstado(mikrowisp.estado)}"><div class="servicio-header"><div class="servicio-nombre"><span class="servicio-icono">🌐</span>MikroWisp (ISP)</div><span class="badge" style="background:${colorEstado(mikrowisp.estado)}20;color:${colorEstado(mikrowisp.estado)}">${iconoEstado(mikrowisp.estado)} ${mikrowisp.estado.toUpperCase()}</span></div><div class="servicio-mensaje">${mikrowisp.mensaje}</div>${mikrowisp.tiempo_respuesta_ms ? `<div class="servicio-detalle">Tiempo de respuesta: ${mikrowisp.tiempo_respuesta_ms}ms</div>` : ''}${mikrowisp.error ? `<div class="servicio-detalle" style="color:#ef4444">Error: ${mikrowisp.error}</div>` : ''}</div>
<div class="servicio" style="border-left:4px solid ${colorEstado(drive.estado)}"><div class="servicio-header"><div class="servicio-nombre"><span class="servicio-icono">📁</span>Google Drive</div><span class="badge" style="background:${colorEstado(drive.estado)}20;color:${colorEstado(drive.estado)}">${iconoEstado(drive.estado)} ${drive.estado.toUpperCase()}</span></div><div class="servicio-mensaje">${drive.mensaje}</div>${drive.tiempo_respuesta_ms ? `<div class="servicio-detalle">Tiempo de respuesta: ${drive.tiempo_respuesta_ms}ms</div>` : ''}${drive.error ? `<div class="servicio-detalle" style="color:#ef4444">Error: ${drive.error}</div>` : ''}</div>
<div class="servicio" style="border-left:4px solid ${colorEstado(vision.estado)}"><div class="servicio-header"><div class="servicio-nombre"><span class="servicio-icono">👁️</span>Google Vision (OCR)</div><span class="badge" style="background:${colorEstado(vision.estado)}20;color:${colorEstado(vision.estado)}">${iconoEstado(vision.estado)} ${vision.estado.toUpperCase()}</span></div><div class="servicio-mensaje">${vision.mensaje}</div>${vision.tiempo_respuesta_ms ? `<div class="servicio-detalle">Tiempo de respuesta: ${vision.tiempo_respuesta_ms}ms</div>` : ''}${vision.error ? `<div class="servicio-detalle" style="color:#ef4444">Error: ${vision.error}</div>` : ''}</div>
<div class="servicio" style="border-left:4px solid ${colorEstado(mercatelyApi.estado)}"><div class="servicio-header"><div class="servicio-nombre"><span class="servicio-icono">🔑</span>Mercately API</div><span class="badge" style="background:${colorEstado(mercatelyApi.estado)}20;color:${colorEstado(mercatelyApi.estado)}">${iconoEstado(mercatelyApi.estado)} ${mercatelyApi.estado.toUpperCase()}</span></div><div class="servicio-mensaje">${mercatelyApi.mensaje}</div>${mercatelyApi.tiempo_respuesta_ms ? `<div class="servicio-detalle">Tiempo de respuesta: ${mercatelyApi.tiempo_respuesta_ms}ms</div>` : ''}${mercatelyApi.error ? `<div class="servicio-detalle" style="color:#ef4444">Error: ${mercatelyApi.error}</div>` : ''}</div>
<div class="servicio" style="border-left:4px solid ${colorEstado(mercately.estado)}"><div class="servicio-header"><div class="servicio-nombre"><span class="servicio-icono">💬</span>Mercately (Chatbot)</div><span class="badge" style="background:${colorEstado(mercately.estado)}20;color:${colorEstado(mercately.estado)}">${iconoEstado(mercately.estado)} ${mercately.estado.toUpperCase()}</span></div><div class="servicio-mensaje">${mercately.mensaje}</div>${mercately.ultimo_ping ? `<div class="servicio-detalle">Último contacto: ${new Date(mercately.ultimo_ping).toLocaleString('es-EC', { timeZone: 'America/Guayaquil' })}</div>` : ''}</div>
</div>
<div class="sesiones">👥 Clientes en sesión activa: <strong>${clientesYaSaludados.size}</strong> · Reset automático: <strong>${TIEMPO_RESET_AUTOMATICO_MS / (60 * 60 * 1000)} horas</strong></div>
<div class="footer"><div>📍 Zamora, Ecuador · ${tiempoLocal}</div><div class="auto-refresh">🔄 Auto-actualización cada 30 segundos</div><div style="margin-top:12px;"><a href="/health">Ver JSON técnico (/health)</a></div></div>
</div></body></html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

app.get('/', (req, res) => {
  res.json({ estado: 'FibraNet Webhook activo ✅', version: '6.0' });
});

// ════════════════════════════════════════════════════════
// ENDPOINTS PRINCIPALES
// ════════════════════════════════════════════════════════

app.post('/cliente/buscar', async (req, res) => {
  try {
    const { cedula, intento } = req.body;
    const numeroIntento = parseInt(intento || 1);

    console.log(`📞 [BUSCAR] Cédula: "${cedula}" | Intento: ${numeroIntento}`);

    if (!cedula) return res.json({ encontrado: false, mensaje: '⚠️ Por favor escríbeme tu número de cédula.' });

    const resultado = await buscarClientePorCedula(cedula);

    if (!resultado.exito) {
      if (numeroIntento >= 2) return res.json({ encontrado: false, transferir: true, mensaje: `😕 No pudimos identificarle.\n\nUn asesor de FibraNet le ayudará personalmente. 👨‍💻` });
      return res.json({ encontrado: false, transferir: false, mensaje: `❌ No encontré ningún cliente con la cédula *${cedula}*.\n\n¿Qué desea hacer?` });
    }

    const cliente = resultado.cliente;
    const deuda = parseFloat(cliente.facturacion?.total_facturas || 0);
    const facturasPendientes = parseInt(cliente.facturacion?.facturas_nopagadas || 0);
    const servicio = cliente.servicios?.[0];
    const nombreCompleto = capitalizarNombre(cliente.nombre);
    const esPrimeraVez = !yaFueSaludado(cliente.cedula);

    let mensajeBienvenida;
    if (esPrimeraVez) {
      mensajeBienvenida = `✅ *Identidad verificada*\n\nBienvenido(a) Sr(a). *${nombreCompleto}*\n\n📋 ¿En qué podemos ayudarle hoy?`;
      marcarComoSaludado(cliente.cedula);
      console.log(`👋 [BUSCAR] Primera vez para ${nombreCompleto}`);
    } else {
      mensajeBienvenida = `📋 ¿En qué más podemos ayudarle?`;
      console.log(`🔄 [BUSCAR] ${nombreCompleto} ya fue saludado`);
    }

    return res.json({
      encontrado: true, id: cliente.id, nombre: nombreCompleto,
      primerNombre: nombreCompleto.split(' ')[0], cedula: cliente.cedula,
      telefono: cliente.movil || cliente.telefono || '',
      deuda, facturasPendientes,
      plan: servicio?.perfil || 'N/A', estadoConexion: servicio?.status_user || 'N/A',
      costo: servicio?.costo || '0', idServicio: servicio?.id, esPrimeraVez,
      mensaje: mensajeBienvenida
    });
  } catch (err) {
    console.error('Error buscar cliente:', err);
    res.status(500).json({ encontrado: false, transferir: true, mensaje: '⚠️ Error del sistema. Un asesor le atenderá.' });
  }
});

app.post('/cliente/deuda', async (req, res) => {
  try {
    const { cedula } = req.body;
    if (!cedula) return res.json({ mensaje: '⚠️ Error: no se identificó al cliente. Por favor escriba "pago" para empezar de nuevo.' });

    const resultado = await buscarClientePorCedula(cedula);
    if (!resultado.exito) return res.json({ mensaje: '❌ No se encontró información del cliente. Escriba "pago" para empezar de nuevo.' });

    const cliente = resultado.cliente;
    const deuda = parseFloat(cliente.facturacion?.total_facturas || 0);
    const facturas = parseInt(cliente.facturacion?.facturas_nopagadas || 0);
    const nombreCompleto = capitalizarNombre(cliente.nombre);

    if (facturas === 0) return res.json({ deuda: 0, mensaje: `✅ *Estimado(a) cliente*, no tiene deudas pendientes.\n\n👤 ${nombreCompleto}\n\n¡Gracias por mantener su pago al día! 🎉` });

    return res.json({
      deuda, facturas,
      mensaje: `💰 *Estado de cuenta*\n\n👤 ${nombreCompleto}\n📋 Facturas pendientes: *${facturas}*\n💵 Total a pagar: *$${deuda.toFixed(2)}*\n\nPara pagar seleccione *"📸 Pagar mi servicio"* en el menú.`
    });
  } catch (err) {
    res.status(500).json({ mensaje: '⚠️ Error del sistema. Intente nuevamente.' });
  }
});

app.post('/pago/info', async (req, res) => {
  try {
    const { cedula } = req.body;
    if (!cedula) return res.json({ mensaje: '⚠️ Error: no se identificó al cliente. Escriba "pago" para empezar de nuevo.' });

    const resultado = await buscarClientePorCedula(cedula);
    if (!resultado.exito) return res.json({ mensaje: '❌ No se encontró información del cliente.' });

    const cliente = resultado.cliente;
    const deuda = parseFloat(cliente.facturacion?.total_facturas || 0);
    const facturas = parseInt(cliente.facturacion?.facturas_nopagadas || 0);

    if (facturas === 0) return res.json({ deuda: 0, mensaje: `✅ No tiene deudas pendientes. ¡Está al día! 🎉` });

    res.json({ deuda, mensaje: `${CUENTAS_BANCARIAS}\n\n💵 *Su deuda actual: $${deuda.toFixed(2)}*\n\n📸 Realice su transferencia y envíenos la *foto del comprobante* aquí mismo para activar su servicio automáticamente.` });
  } catch (err) {
    res.status(500).json({ mensaje: '⚠️ Error del sistema. Intente nuevamente.' });
  }
});

// ════════════════════════════════════════════════════════
// 🎓 v6.0: PROCESAR COMPROBANTE - Ahora usa API de Mercately
// ════════════════════════════════════════════════════════
app.post('/pago/comprobante', async (req, res) => {
  try {
    const { cedula } = req.body;

    console.log(`📸 [COMPROBANTE v6.0] ===== INICIO =====`);
    console.log(`📸 [COMPROBANTE] Cédula: "${cedula}"`);

    if (!cedula) {
      return res.json({ activado: false, mensaje: '⚠️ Error: no se identificó al cliente. Escriba "pago" para empezar.' });
    }

    // 1. Buscar cliente en MikroWisp para obtener teléfono
    const resultadoCliente = await buscarClientePorCedula(cedula);
    if (!resultadoCliente.exito) {
      return res.json({ activado: false, mensaje: '❌ No se encontró información del cliente.' });
    }

    const cliente = resultadoCliente.cliente;
    const idcliente = cliente.id;
    const nombreCompleto = capitalizarNombre(cliente.nombre);
    const deuda = parseFloat(cliente.facturacion?.total_facturas || 0);
    const telefono = cliente.movil || cliente.telefono || '';

    console.log(`👤 [COMPROBANTE] Cliente: ${nombreCompleto} | Tel: ${telefono} | Deuda: $${deuda.toFixed(2)}`);

    if (!telefono) {
      console.error(`❌ [COMPROBANTE] Cliente sin teléfono registrado`);
      return res.json({ activado: false, mensaje: '⚠️ No se encontró su teléfono registrado. Contacte a un asesor.' });
    }

    // 2. 🎓 v6.0: Obtener la última imagen del cliente vía API de Mercately
    console.log(`🔍 [COMPROBANTE] Buscando imagen en Mercately API...`);
    const resultadoImagen = await obtenerUltimaImagenComprobante(telefono);

    if (!resultadoImagen.exito) {
      console.error(`❌ [COMPROBANTE] Error obtener imagen: ${resultadoImagen.error}`);
      return res.json({
        activado: false,
        mensaje: '⚠️ No pude encontrar el comprobante enviado. Por favor envíelo nuevamente. 📸'
      });
    }

    const imagen_url = resultadoImagen.url;
    console.log(`✅ [COMPROBANTE] Imagen obtenida desde Mercately API`);

    // 3. Obtener factura pendiente
    const facturasResponse = await fetch(`${MIKROWISP_URL}/api/v1/GetInvoices`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: MIKROWISP_TOKEN, idcliente, estado: 'no pagada' })
    });
    const facturasData = await facturasResponse.json();
    const facturas = facturasData.facturas || [];
    const facturaPendiente = facturas.find(f => f.estado !== 'pagado');

    // 4. Hacer OCR
    const ocr = await leerComprobante(imagen_url);
    if (!ocr.exito) {
      return res.json({ activado: false, mensaje: '⚠️ No pude leer el comprobante. Por favor envíe una foto más clara y nítida. 📸' });
    }

    const { monto, comprobante, exitosa, esFibranet, banco } = ocr.datos;
    console.log(`📊 [COMPROBANTE] OCR: $${monto} | Banco: ${banco} | Exitosa: ${exitosa} | FibraNet: ${esFibranet}`);

    // 5. Validaciones
    if (!exitosa) return res.json({ activado: false, mensaje: '❌ La transferencia no aparece como exitosa en el comprobante.\n\nVerifique que la transferencia fue aprobada e intente de nuevo.' });
    if (!esFibranet) return res.json({ activado: false, mensaje: '⚠️ El comprobante no parece ser un pago a FibraNet.\n\nVerifique que transfirió a las cuentas correctas de FibraNet e intente de nuevo.' });
    if (!monto) return res.json({ activado: false, mensaje: '⚠️ No pude leer el monto del comprobante. Por favor envíe una foto más clara. 📸' });

    // 6. Pago menor
    if (monto < deuda - 0.10) {
      await subirImagenDrive(imagen_url, nombreCompleto, cedula, comprobante || Date.now());
      return res.json({
        activado: false,
        mensaje: `⚠️ *Pago incompleto*\n\n💰 Su deuda: *$${deuda.toFixed(2)}*\n💵 Monto recibido: *$${monto.toFixed(2)}*\n❗ Falta: *$${(deuda - monto).toFixed(2)}*\n\nPor favor complete el pago y envíe el nuevo comprobante.`
      });
    }

    // 7. Guardar en Drive
    const drive = await subirImagenDrive(imagen_url, nombreCompleto, cedula, comprobante || Date.now());
    console.log(`✅ [COMPROBANTE] Drive: ${drive.nombre}`);

    // 8. Activar en MikroWisp
    if (facturaPendiente) {
      const pagoResponse = await fetch(`${MIKROWISP_URL}/api/v1/PaidInvoice`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: MIKROWISP_TOKEN, idfactura: facturaPendiente.id,
          pasarela: 'WhatsApp-Transferencia', cantidad: monto,
          idtransaccion: comprobante || `WA-${Date.now()}`,
          fechalimite: new Date().toISOString().slice(0, 19).replace('T', ' ')
        })
      });
      const pagoData = await pagoResponse.json();

      if (pagoData.estado === 'exito') {
        let mensajeExtra = '';
        if (monto > deuda + 0.10) mensajeExtra = `\n💰 Saldo a favor: *$${(monto - deuda).toFixed(2)}* — se aplicará al próximo mes.`;
        console.log(`✅ [COMPROBANTE] Servicio activado: ${nombreCompleto}`);
        return res.json({
          activado: true, banco, comprobante,
          mensaje: `⚡ *¡Servicio activado exitosamente!*\n\n✅ Pago verificado: *$${monto.toFixed(2)}*\n🏦 Banco: ${banco}\n🔑 Comprobante: #${comprobante}${mensajeExtra}\n\n📡 Su internet ya está activo.\n¡Gracias por su pago! 🙌`
        });
      }
    }

    return res.json({
      activado: false,
      mensaje: `✅ Comprobante recibido y guardado.\n\n🔑 Ref: #${comprobante || 'N/A'}\n💵 Monto: $${monto.toFixed(2)}\n\nUn asesor verificará y activará su servicio en breve. ⏰`
    });

  } catch (err) {
    console.error('❌ [COMPROBANTE] Error:', err);
    res.status(500).json({ activado: false, mensaje: '⚠️ Error procesando el comprobante. Un asesor lo revisará manualmente.' });
  }
});

app.post('/cliente/plan', async (req, res) => {
  try {
    const { cedula } = req.body;
    if (!cedula) return res.json({ mensaje: '⚠️ Error: no se identificó al cliente.' });

    const resultado = await buscarClientePorCedula(cedula);
    if (!resultado.exito) return res.json({ mensaje: '❌ No se encontró información del cliente.' });

    const cliente = resultado.cliente;
    const servicio = cliente.servicios?.[0];
    if (!servicio) return res.json({ mensaje: '❌ No se encontró información del servicio.' });

    const estadoIcon = servicio.status_user === 'ONLINE' ? '🟢' : '🔴';
    const nombreCompleto = capitalizarNombre(cliente.nombre);

    res.json({
      mensaje: `📡 *Información de su servicio*\n\n👤 ${nombreCompleto}\n📋 Plan: *${servicio.perfil}*\n💰 Costo mensual: $${servicio.costo}\n${estadoIcon} Conexión: *${servicio.status_user}*\n📅 Cliente desde: ${servicio.instalado}`
    });
  } catch (err) {
    res.status(500).json({ mensaje: '⚠️ Error del sistema. Intente nuevamente.' });
  }
});

app.post('/soporte/reporte', async (req, res) => {
  try {
    const { cedula, problema, descripcion } = req.body;
    const problemas = {
      'sin_internet': '🔴 Sin conexión a internet',
      'lento': '🐌 Internet lento',
      'intermitente': '⚡ Conexión intermitente',
      'otro': `📝 ${descripcion || 'Problema no especificado'}`
    };
    const ticket = `TKT-${Date.now().toString().slice(-6)}`;
    let nombreCliente = 'Cliente';
    if (cedula) {
      const resultado = await buscarClientePorCedula(cedula);
      if (resultado.exito) nombreCliente = capitalizarNombre(resultado.cliente.nombre);
    }
    res.json({ ticket, mensaje: `🔧 *Reporte técnico registrado*\n\n📋 Ticket: #${ticket}\n👤 ${nombreCliente}\n⚠️ ${problemas[problema] || descripcion}\n\n✅ Nuestro equipo técnico fue notificado.` });
  } catch (err) {
    res.status(500).json({ mensaje: '⚠️ Error del sistema.' });
  }
});

app.post('/soporte/cambio-clave', async (req, res) => {
  try {
    const { cedula, nueva_clave } = req.body;
    const ticket = `CLV-${Date.now().toString().slice(-6)}`;
    let nombreCliente = 'Cliente';
    if (cedula) {
      const resultado = await buscarClientePorCedula(cedula);
      if (resultado.exito) nombreCliente = capitalizarNombre(resultado.cliente.nombre);
    }
    res.json({ ticket, mensaje: `🔑 *Solicitud de cambio de clave registrada*\n\n📋 Ticket: #${ticket}\n👤 ${nombreCliente}\n🔐 Nueva clave: ${nueva_clave}\n\n✅ Un técnico procesará su solicitud en las próximas *2 horas hábiles*.` });
  } catch (err) {
    res.status(500).json({ mensaje: '⚠️ Error del sistema.' });
  }
});

app.get('/nuevo-cliente', (req, res) => {
  res.json({ mensaje: `🌟 *¡Gracias por su interés en FibraNet!*\n\nSomos proveedores de internet de fibra óptica en Zamora.\n\nUn asesor le contactará. 🌐` });
});

app.get('/despedida', (req, res) => {
  res.json({ mensaje: `👋 *¡Hasta pronto!*\n\nGracias por contactar a *FibraNet* 🌐\n\n_FibraNet — Soluciones GPON_` });
});

app.post('/despedida', (req, res) => {
  const { cedula } = req.body;
  if (cedula) reiniciarSaludo(cedula);
  res.json({ mensaje: `👋 *¡Hasta pronto!*\n\nGracias por contactar a *FibraNet* 🌐\n\n_FibraNet — Soluciones GPON_` });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 FibraNet Webhook v6.0 corriendo en puerto ${PORT}`));
