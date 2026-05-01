const express = require('express');
const { google } = require('googleapis');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ════════════════════════════════════════════════════════
// CONFIGURACIÓN
// ════════════════════════════════════════════════════════

const MIKROWISP_URL = 'https://zamora.fibranet.ec';
const MIKROWISP_TOKEN = 'NkUrWHkwd1NKZ1hMUlBrMjc1K0pNUT09';
const DRIVE_FOLDER_ID = '1nPVyL57elvt-164PXoxVWm0QiIZB-6Ir';

const MERCATELY_API_URL = 'https://app.mercately.com/retailers/api/v1';
const MERCATELY_API_KEY = process.env.MERCATELY_API_KEY;

// 🎓 v6.1.1: Configuración del sistema de promesa de pago
const DIAS_PROMESA = 10;
const DIAS_AVISO_RECORDATORIO = 8;
const CONTADORA_EMAIL = 'jiduque@utpl.edu.ec';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'fibranet-admin-2026';

const GOOGLE_CREDENTIALS = {
  client_email: process.env.GOOGLE_CLIENT_EMAIL,
  private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
};

let ultimoPingMercately = null;

// ════════════════════════════════════════════════════════
// 🎓 v6.1.1: BASE DE DATOS EN MEMORIA RAM
// ════════════════════════════════════════════════════════

let pagosDB = {
  pendientes: [],
  verificados: [],
  rechazados: [],
  lista_negra: []
};

// Funciones simplificadas para DB en RAM
function obtenerPagosDB() {
  return Promise.resolve(pagosDB);
}

function guardarPagosDB(db) {
  pagosDB = db;
  console.log(`💾 [RAM DB] Guardado: ${db.pendientes.length} pendientes, ${db.verificados.length} verificados`);
  return Promise.resolve(true);
}

async function agregarPagoPendiente(pago) {
  pagosDB.pendientes.push(pago);
  return true;
}

async function estaEnListaNegra(cedula) {
  return pagosDB.lista_negra.includes(cedula);
}

async function tienePagoPendiente(cedula) {
  return pagosDB.pendientes.find(p => p.cedula === cedula);
}

// ════════════════════════════════════════════════════════
// SISTEMA DE CACHÉ
// ════════════════════════════════════════════════════════

const cacheClientes = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

const clientesYaSaludados = new Map();
const TIEMPO_RESET_AUTOMATICO_MS = 4 * 60 * 60 * 1000;

// ════════════════════════════════════════════════════════
// UTILIDADES
// ════════════════════════════════════════════════════════

function capitalizarNombre(nombre) {
  if (!nombre || typeof nombre !== 'string') return '';
  return nombre.trim().toLowerCase().split(/\s+/).filter(p => p)
    .map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

function yaFueSaludado(cedula) {
  const timestamp = clientesYaSaludados.get(cedula);
  if (!timestamp) return false;
  if (Date.now() - timestamp > TIEMPO_RESET_AUTOMATICO_MS) {
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

function getGoogleAuth(scopes) {
  return new google.auth.JWT(GOOGLE_CREDENTIALS.client_email, null, GOOGLE_CREDENTIALS.private_key, scopes);
}

async function buscarClientePorCedula(cedula, useCache = true) {
  if (!cedula) return { exito: false, error: 'Cédula vacía' };

  if (useCache) {
    const cached = cacheClientes.get(cedula);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
      console.log(`💾 [CACHE] Cliente ${cedula} del caché`);
      return { exito: true, cliente: cached.data };
    }
  }

  try {
    const response = await fetch(`${MIKROWISP_URL}/api/v1/GetClientsDetails`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: MIKROWISP_TOKEN, cedula })
    });
    const data = await response.json();
    if (data.estado !== 'exito' || !data.datos?.length) return { exito: false, error: 'Cliente no encontrado' };

    cacheClientes.set(cedula, { data: data.datos[0], timestamp: Date.now() });
    return { exito: true, cliente: data.datos[0] };
  } catch (err) {
    console.error('Error buscar cliente:', err.message);
    return { exito: false, error: err.message };
  }
}

// ════════════════════════════════════════════════════════
// NOTIFICACIÓN A LA CONTADORA VIA EMAIL
// ════════════════════════════════════════════════════════

async function notificarContadora(asunto, mensaje) {
  try {
    console.log(`📧 [EMAIL] Enviando a ${CONTADORA_EMAIL}`);
    console.log(`📧 [EMAIL] Asunto: ${asunto}`);
    console.log(`📧 [EMAIL] Mensaje: ${mensaje.substring(0, 100)}...`);
    
    // Por ahora solo logueamos - en producción aquí iría SendGrid, Mailgun, etc.
    // Para Railway puedes usar variables de entorno con SMTP
    
    console.log(`✅ [EMAIL] Email simulado enviado a ${CONTADORA_EMAIL}`);
    return true;
  } catch (err) {
    console.error('❌ [EMAIL] Error:', err.message);
    return false;
  }
}

// ════════════════════════════════════════════════════════
// ACTIVACIÓN/SUSPENSIÓN EN MIKROWISP
// ════════════════════════════════════════════════════════

async function activarServicioMikroWisp(idcliente) {
  try {
    const response = await fetch(`${MIKROWISP_URL}/api/v1/SetStatusClient`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: MIKROWISP_TOKEN,
        idcliente: idcliente,
        estado: 'activo',
        motivo: 'Pago recibido - Promesa 10 días'
      })
    });
    const data = await response.json();
    return data.estado === 'exito';
  } catch (err) {
    console.error('❌ Error activar servicio:', err.message);
    return false;
  }
}

async function suspenderServicioMikroWisp(idcliente, motivo) {
  try {
    const response = await fetch(`${MIKROWISP_URL}/api/v1/SetStatusClient`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: MIKROWISP_TOKEN,
        idcliente: idcliente,
        estado: 'retirado',
        motivo: motivo
      })
    });
    const data = await response.json();
    return data.estado === 'exito';
  } catch (err) {
    console.error('❌ Error suspender:', err.message);
    return false;
  }
}

// ════════════════════════════════════════════════════════
// CUENTAS BANCARIAS
// ════════════════════════════════════════════════════════

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

// ════════════════════════════════════════════════════════
// MIDDLEWARE
// ════════════════════════════════════════════════════════

app.use((req, res, next) => {
  const rutasMercately = ['/cliente/buscar', '/cliente/deuda', '/cliente/plan', '/pago/info', '/pago/comprobante', '/soporte/reporte', '/soporte/cambio-clave', '/despedida'];
  if (rutasMercately.some(r => req.path === r)) {
    ultimoPingMercately = new Date();
  }
  next();
});

// ════════════════════════════════════════════════════════
// HEALTH CHECKS
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
    if (response.ok && data.estado) return { estado: 'ok', mensaje: `API respondió correctamente`, tiempo_respuesta_ms: tiempo };
    return { estado: 'error', mensaje: 'API respondió pero con error', tiempo_respuesta_ms: tiempo };
  } catch (err) {
    return { estado: 'error', mensaje: 'No se pudo conectar', error: err.message };
  }
}

async function verificarMercatelyAPI() {
  const inicio = Date.now();
  try {
    if (!MERCATELY_API_KEY) return { estado: 'error', mensaje: 'API Key no configurada' };
    const response = await fetch(`${MERCATELY_API_URL}/customers?page=1&per_page=1`, {
      method: 'GET',
      headers: { 'Api-Key': MERCATELY_API_KEY, 'Content-Type': 'application/json' }
    });
    if (response.ok) return { estado: 'ok', mensaje: 'API conectada', tiempo_respuesta_ms: Date.now() - inicio };
    return { estado: 'error', mensaje: `Error HTTP ${response.status}` };
  } catch (err) {
    return { estado: 'error', mensaje: 'No conectado', error: err.message };
  }
}

function verificarMercately() {
  if (!ultimoPingMercately) return { estado: 'desconocido', mensaje: 'Sin pings aún' };
  const minutos = Math.floor((new Date() - ultimoPingMercately) / 60000);
  if (minutos < 60) return { estado: 'ok', mensaje: `Último ping hace ${minutos} min` };
  if (minutos < 360) return { estado: 'advertencia', mensaje: `Hace ${Math.floor(minutos / 60)}h` };
  return { estado: 'error', mensaje: 'Sin pings hace más de 6h' };
}

// ════════════════════════════════════════════════════════
// ENDPOINTS BÁSICOS
// ════════════════════════════════════════════════════════

app.get('/', (req, res) => res.json({ estado: 'FibraNet Webhook activo ✅', version: '6.1.1 (RAM)' }));

app.get('/health', async (req, res) => {
  const [mikrowisp, mercatelyApi] = await Promise.all([
    verificarMikroWisp(), verificarMercatelyAPI()
  ]);
  const mercately = verificarMercately();

  res.json({
    estado_general: '✅',
    version: '6.1.1 (RAM)',
    servicios: { mikrowisp, mercately_api: mercatelyApi, mercately_chatbot: mercately },
    pagos: {
      pendientes: pagosDB.pendientes.length,
      verificados_total: pagosDB.verificados.length,
      rechazados_total: pagosDB.rechazados.length,
      lista_negra: pagosDB.lista_negra.length
    },
    sesiones: { clientes_saludados: clientesYaSaludados.size },
    nota: 'DB en RAM - se resetea al reiniciar servidor'
  });
});

app.get('/status', async (req, res) => {
  const [mikrowisp, mercatelyApi] = await Promise.all([
    verificarMikroWisp(), verificarMercatelyAPI()
  ]);
  const mercately = verificarMercately();
  const railway = { estado: 'ok', mensaje: `v6.1.1 (RAM) · Uptime: ${Math.floor(process.uptime() / 60)} min` };
  const todos_ok = mikrowisp.estado === 'ok' && mercatelyApi.estado === 'ok';
  const colorEstado = (e) => e === 'ok' ? '#22c55e' : e === 'advertencia' ? '#f59e0b' : e === 'desconocido' ? '#6b7280' : '#ef4444';
  const iconoEstado = (e) => e === 'ok' ? '🟢' : e === 'advertencia' ? '🟡' : e === 'desconocido' ? '⚪' : '🔴';
  const tiempoLocal = new Date().toLocaleString('es-EC', { timeZone: 'America/Guayaquil' });

  const html = `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="refresh" content="30"><title>FibraNet · Estado</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,sans-serif;background:linear-gradient(135deg,#0f172a 0%,#1e293b 100%);color:#f1f5f9;min-height:100vh;padding:20px}.container{max-width:800px;margin:0 auto}.header{text-align:center;margin-bottom:30px;padding:30px 20px;background:rgba(255,255,255,0.05);border-radius:16px}.logo{font-size:32px;font-weight:700;margin-bottom:8px}.logo span{color:#60a5fa}.subtitle{color:#94a3b8;font-size:14px}.estado-general{margin-top:16px;padding:12px 24px;border-radius:999px;display:inline-block;font-weight:600;background:${todos_ok ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)'};color:${todos_ok ? '#22c55e' : '#ef4444'}}.servicios{display:grid;gap:16px}.servicio{background:rgba(255,255,255,0.05);border-radius:12px;padding:20px}.servicio-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}.servicio-nombre{font-size:18px;font-weight:600}.badge{padding:4px 12px;border-radius:999px;font-size:12px;font-weight:600}.metricas{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:16px}.metrica{background:rgba(96,165,250,0.05);border:1px solid rgba(96,165,250,0.2);border-radius:12px;padding:16px;text-align:center}.metrica-numero{font-size:28px;font-weight:700;color:#60a5fa}.metrica-label{font-size:11px;color:#94a3b8;margin-top:4px}.footer{text-align:center;margin-top:30px;color:#64748b;font-size:13px}.footer a{color:#60a5fa;text-decoration:none}.aviso-ram{background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.3);border-radius:12px;padding:12px;margin-top:16px;text-align:center;color:#fbbf24;font-size:13px}</style>
</head><body><div class="container">
<div class="header"><div class="logo">📡 Fibra<span>Net</span></div><div class="subtitle">Panel de Estado · v6.1.1 (RAM) - Promesa de Pago</div><div class="estado-general">${todos_ok ? '✅ TODO OPERATIVO' : '⚠️ REVISAR'}</div></div>
<div class="servicios">
<div class="servicio" style="border-left:4px solid ${colorEstado(railway.estado)}"><div class="servicio-header"><div class="servicio-nombre">🚂 Railway</div><span class="badge" style="background:${colorEstado(railway.estado)}20;color:${colorEstado(railway.estado)}">${iconoEstado(railway.estado)} OK</span></div><div style="color:#cbd5e1;font-size:14px;margin-top:8px">${railway.mensaje}</div></div>
<div class="servicio" style="border-left:4px solid ${colorEstado(mikrowisp.estado)}"><div class="servicio-header"><div class="servicio-nombre">🌐 MikroWisp</div><span class="badge" style="background:${colorEstado(mikrowisp.estado)}20;color:${colorEstado(mikrowisp.estado)}">${iconoEstado(mikrowisp.estado)} ${mikrowisp.estado.toUpperCase()}</span></div><div style="color:#cbd5e1;font-size:14px;margin-top:8px">${mikrowisp.mensaje}</div></div>
<div class="servicio" style="border-left:4px solid ${colorEstado(mercatelyApi.estado)}"><div class="servicio-header"><div class="servicio-nombre">🔑 Mercately API</div><span class="badge" style="background:${colorEstado(mercatelyApi.estado)}20;color:${colorEstado(mercatelyApi.estado)}">${iconoEstado(mercatelyApi.estado)} ${mercatelyApi.estado.toUpperCase()}</span></div><div style="color:#cbd5e1;font-size:14px;margin-top:8px">${mercatelyApi.mensaje}</div></div>
<div class="servicio" style="border-left:4px solid ${colorEstado(mercately.estado)}"><div class="servicio-header"><div class="servicio-nombre">💬 Mercately Chatbot</div><span class="badge" style="background:${colorEstado(mercately.estado)}20;color:${colorEstado(mercately.estado)}">${iconoEstado(mercately.estado)} ${mercately.estado.toUpperCase()}</span></div><div style="color:#cbd5e1;font-size:14px;margin-top:8px">${mercately.mensaje}</div></div>
</div>
<div class="metricas">
<div class="metrica"><div class="metrica-numero">${pagosDB.pendientes.length}</div><div class="metrica-label">Pendientes</div></div>
<div class="metrica"><div class="metrica-numero">${pagosDB.verificados.length}</div><div class="metrica-label">Verificados</div></div>
<div class="metrica"><div class="metrica-numero">${pagosDB.rechazados.length}</div><div class="metrica-label">Rechazados</div></div>
<div class="metrica"><div class="metrica-numero">${pagosDB.lista_negra.length}</div><div class="metrica-label">Lista Negra</div></div>
</div>
<div class="aviso-ram">⚠️ Base de datos en RAM - Los datos se resetean si el servidor reinicia</div>
<div class="footer"><div>📍 Zamora, Ecuador · ${tiempoLocal}</div><div style="margin-top:8px"><a href="/admin/${ADMIN_TOKEN}">📊 Dashboard Contadora</a> · <a href="/health">Ver JSON</a></div></div>
</div></body></html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// ════════════════════════════════════════════════════════
// ENDPOINTS DE CHATBOT
// ════════════════════════════════════════════════════════

app.post('/cliente/buscar', async (req, res) => {
  try {
    const { cedula, intento } = req.body;
    const numeroIntento = parseInt(intento || 1);
    console.log(`📞 [BUSCAR] Cédula: "${cedula}"`);

    if (!cedula) return res.json({ encontrado: false, mensaje: '⚠️ Por favor escríbeme tu número de cédula.' });

    const resultado = await buscarClientePorCedula(cedula);
    if (!resultado.exito) {
      if (numeroIntento >= 2) return res.json({ encontrado: false, transferir: true, mensaje: `😕 No pudimos identificarle.\n\nUn asesor le ayudará. 👨‍💻` });
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
    } else {
      mensajeBienvenida = `📋 ¿En qué más podemos ayudarle?`;
    }

    return res.json({
      encontrado: true, id: cliente.id, nombre: nombreCompleto,
      cedula: cliente.cedula, deuda, facturasPendientes,
      plan: servicio?.perfil || 'N/A', mensaje: mensajeBienvenida
    });
  } catch (err) {
    res.status(500).json({ encontrado: false, transferir: true, mensaje: '⚠️ Error del sistema.' });
  }
});

app.post('/cliente/deuda', async (req, res) => {
  try {
    const { cedula } = req.body;
    if (!cedula) return res.json({ mensaje: '⚠️ Error: no se identificó al cliente.' });

    const resultado = await buscarClientePorCedula(cedula);
    if (!resultado.exito) return res.json({ mensaje: '❌ No se encontró información del cliente.' });

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
    res.status(500).json({ mensaje: '⚠️ Error del sistema.' });
  }
});

app.post('/pago/info', async (req, res) => {
  try {
    const { cedula } = req.body;
    if (!cedula) return res.json({ mensaje: '⚠️ Error: no se identificó al cliente.' });

    const resultado = await buscarClientePorCedula(cedula);
    if (!resultado.exito) return res.json({ mensaje: '❌ No se encontró información del cliente.' });

    const cliente = resultado.cliente;
    const deuda = parseFloat(cliente.facturacion?.total_facturas || 0);
    const facturas = parseInt(cliente.facturacion?.facturas_nopagadas || 0);

    if (facturas === 0) return res.json({ deuda: 0, mensaje: `✅ No tiene deudas pendientes. ¡Está al día! 🎉` });

    res.json({ deuda, mensaje: `${CUENTAS_BANCARIAS}\n\n💵 *Su deuda actual: $${deuda.toFixed(2)}*\n\n📸 Realice su transferencia y envíenos la *foto del comprobante* aquí mismo para activar su servicio.` });
  } catch (err) {
    res.status(500).json({ mensaje: '⚠️ Error del sistema.' });
  }
});

// ════════════════════════════════════════════════════════
// 🎓 v6.1.1: PROCESAR COMPROBANTE CON PROMESA DE PAGO
// ════════════════════════════════════════════════════════
app.post('/pago/comprobante', async (req, res) => {
  try {
    const { cedula } = req.body;
    console.log(`📸 [COMPROBANTE v6.1.1] Cédula: "${cedula}"`);

    if (!cedula) return res.json({ activado: false, mensaje: '⚠️ Error: no se identificó al cliente.' });

    const resultadoCliente = await buscarClientePorCedula(cedula);
    if (!resultadoCliente.exito) {
      return res.json({ activado: false, mensaje: '❌ No se encontró información del cliente.' });
    }

    const cliente = resultadoCliente.cliente;
    const idcliente = cliente.id;
    const nombreCompleto = capitalizarNombre(cliente.nombre);
    const deuda = parseFloat(cliente.facturacion?.total_facturas || 0);
    const telefono = cliente.movil || cliente.telefono || '';
    const servicio = cliente.servicios?.[0];

    console.log(`👤 [COMPROBANTE] ${nombreCompleto} | Deuda: $${deuda.toFixed(2)}`);

    if (deuda === 0) {
      return res.json({ activado: false, mensaje: `✅ Estimado(a) ${nombreCompleto}, no tiene deudas pendientes.\n\n¡Está al día! 🎉` });
    }

    if (await estaEnListaNegra(cedula)) {
      console.log(`🚫 [COMPROBANTE] Cliente en lista negra: ${cedula}`);
      return res.json({
        activado: false,
        mensaje: `⚠️ Por seguridad, su pago será verificado manualmente.\n\nUn asesor le contactará. 📞`
      });
    }

    if (await tienePagoPendiente(cedula)) {
      console.log(`⚠️ [COMPROBANTE] Ya tiene pago pendiente: ${cedula}`);
      return res.json({
        activado: true,
        mensaje: `✅ *${nombreCompleto}*, ya tenemos su comprobante registrado.\n\nSu servicio está activo y será verificado en breve.`
      });
    }

    // Intentar activar servicio en MikroWisp (pero continuar si falla)
    const activado = await activarServicioMikroWisp(idcliente);
    if (activado) {
      console.log(`⚡ [COMPROBANTE] Servicio activado en MikroWisp: ${cedula}`);
    } else {
      console.log(`⚠️ [COMPROBANTE] MikroWisp falló, pero continuamos. Contadora activará manualmente: ${cedula}`);
    }

    // Guardar en RAM
    const ahora = new Date();
    const fechaLimite = new Date(ahora.getTime() + DIAS_PROMESA * 24 * 60 * 60 * 1000);

    const pago = {
      cedula: cedula,
      nombre: nombreCompleto,
      idcliente: idcliente,
      telefono: telefono,
      plan: servicio?.perfil || 'N/A',
      deuda: deuda,
      fecha_recibido: ahora.toISOString(),
      fecha_limite: fechaLimite.toISOString(),
      estado: 'PENDIENTE',
      aviso_recordatorio_enviado: false
    };

    await agregarPagoPendiente(pago);
    console.log(`💾 [COMPROBANTE] Pago guardado en RAM`);

    // Notificar a la contadora por email
    const asunto = '🔔 NUEVO PAGO PENDIENTE - FibraNet';
    const mensajeContadora = `
NUEVO PAGO PENDIENTE DE VERIFICACIÓN

Cliente: ${nombreCompleto}
Cédula: ${cedula}
Teléfono: ${telefono}
Deuda: $${deuda.toFixed(2)}
Plan: ${servicio?.perfil || 'N/A'}
Fecha: ${ahora.toLocaleString('es-EC', { timeZone: 'America/Guayaquil' })}

Plazo de verificación: ${DIAS_PROMESA} días
Vence: ${fechaLimite.toLocaleString('es-EC', { timeZone: 'America/Guayaquil' })}

Dashboard: https://mindful-commitment-production.up.railway.app/admin/${ADMIN_TOKEN}
`;

    await notificarContadora(asunto, mensajeContadora);

    return res.json({
      activado: true,
      mensaje: `✅ *¡Pago recibido!*\n\nHemos recibido su comprobante.\nSu servicio se está activando.\n\n📡 Estimado(a) Sr(a). *${nombreCompleto}*\nDisfrute de su internet 🌐\n\n¡Gracias por confiar en FibraNet!`
    });

  } catch (err) {
    console.error('❌ [COMPROBANTE] Error:', err);
    res.status(500).json({ activado: false, mensaje: '⚠️ Error procesando el pago.' });
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
    res.status(500).json({ mensaje: '⚠️ Error del sistema.' });
  }
});

app.post('/soporte/reporte', async (req, res) => {
  try {
    const { cedula, problema, descripcion } = req.body;
    const problemas = {
      'sin_internet': '🔴 Sin conexión',
      'lento': '🐌 Internet lento',
      'intermitente': '⚡ Intermitente',
      'otro': `📝 ${descripcion || 'Otro'}`
    };
    const ticket = `TKT-${Date.now().toString().slice(-6)}`;
    let nombreCliente = 'Cliente';
    if (cedula) {
      const r = await buscarClientePorCedula(cedula);
      if (r.exito) nombreCliente = capitalizarNombre(r.cliente.nombre);
    }
    res.json({ ticket, mensaje: `🔧 *Reporte registrado*\n\n📋 #${ticket}\n👤 ${nombreCliente}\n⚠️ ${problemas[problema] || descripcion}\n\n✅ Equipo técnico notificado.` });
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
      const r = await buscarClientePorCedula(cedula);
      if (r.exito) nombreCliente = capitalizarNombre(r.cliente.nombre);
    }
    res.json({ ticket, mensaje: `🔑 *Solicitud registrada*\n\n📋 #${ticket}\n👤 ${nombreCliente}\n🔐 Nueva clave: ${nueva_clave}\n\n✅ Se procesará en *2h hábiles*.` });
  } catch (err) {
    res.status(500).json({ mensaje: '⚠️ Error del sistema.' });
  }
});

app.get('/nuevo-cliente', (req, res) => {
  res.json({ mensaje: `🌟 *¡Gracias por su interés!*\n\nUn asesor le contactará. 🌐` });
});

app.get('/despedida', (req, res) => res.json({ mensaje: `👋 *¡Hasta pronto!*\n\nGracias por contactar a *FibraNet* 🌐` }));

app.post('/despedida', (req, res) => {
  const { cedula } = req.body;
  if (cedula) reiniciarSaludo(cedula);
  res.json({ mensaje: `👋 *¡Hasta pronto!*\n\nGracias por contactar a *FibraNet* 🌐` });
});

// ════════════════════════════════════════════════════════
// 🎓 v6.1.1: DASHBOARD DE ADMINISTRACIÓN
// ════════════════════════════════════════════════════════

app.get('/admin/:token', async (req, res) => {
  if (req.params.token !== ADMIN_TOKEN) {
    return res.status(403).send('<h1>Acceso denegado</h1>');
  }

  const ahora = new Date();

  const html = `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Admin · FibraNet</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,sans-serif;background:#f1f5f9;color:#0f172a;min-height:100vh;padding:20px}
.container{max-width:1200px;margin:0 auto}
h1{font-size:28px;margin-bottom:24px;color:#0f172a}
h1 span{color:#3b82f6}
.metricas{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px}
.metrica{background:#fff;border-radius:12px;padding:20px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,0.05)}
.metrica-numero{font-size:32px;font-weight:700}
.metrica-pendiente{color:#f59e0b}
.metrica-verificado{color:#22c55e}
.metrica-rechazado{color:#ef4444}
.metrica-negra{color:#6b7280}
.metrica-label{font-size:12px;color:#64748b;margin-top:4px;text-transform:uppercase;font-weight:600}
.tarjeta{background:#fff;border-radius:12px;padding:20px;margin-bottom:12px;box-shadow:0 1px 3px rgba(0,0,0,0.05);border-left:4px solid #f59e0b}
.tarjeta.urgente{border-left-color:#ef4444;background:#fef2f2}
.tarjeta-header{display:flex;justify-content:space-between;align-items:start;margin-bottom:12px;flex-wrap:wrap;gap:8px}
.tarjeta-titulo{font-size:18px;font-weight:600}
.tarjeta-info{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:16px}
.info-item{display:flex;flex-direction:column}
.info-label{font-size:11px;color:#64748b;text-transform:uppercase;font-weight:600}
.info-valor{font-size:14px;color:#0f172a;font-weight:500}
.botones{display:flex;gap:8px;flex-wrap:wrap}
.btn{padding:10px 20px;border-radius:8px;border:none;cursor:pointer;font-weight:600;font-size:14px}
.btn-verificar{background:#22c55e;color:#fff}
.btn-verificar:hover{background:#16a34a}
.btn-rechazar{background:#ef4444;color:#fff}
.btn-rechazar:hover{background:#dc2626}
.vacio{background:#fff;border-radius:12px;padding:40px;text-align:center;color:#64748b}
.urgencia{display:inline-block;padding:4px 8px;border-radius:4px;font-size:11px;font-weight:600;margin-left:8px}
.urgencia.alta{background:#fee2e2;color:#dc2626}
.urgencia.media{background:#fef3c7;color:#d97706}
.urgencia.baja{background:#dbeafe;color:#2563eb}
.aviso-ram{background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.3);border-radius:12px;padding:12px;margin-bottom:20px;text-align:center;color:#d97706;font-size:13px;font-weight:600}
</style>
</head><body>
<div class="container">
<h1>📊 <span>FibraNet</span> · Panel de Verificación</h1>
<div class="aviso-ram">⚠️ Base de datos en RAM - Los datos se resetean si el servidor reinicia</div>

<div class="metricas">
<div class="metrica"><div class="metrica-numero metrica-pendiente">${pagosDB.pendientes.length}</div><div class="metrica-label">⏰ Pendientes</div></div>
<div class="metrica"><div class="metrica-numero metrica-verificado">${pagosDB.verificados.length}</div><div class="metrica-label">✅ Verificados</div></div>
<div class="metrica"><div class="metrica-numero metrica-rechazado">${pagosDB.rechazados.length}</div><div class="metrica-label">❌ Rechazados</div></div>
<div class="metrica"><div class="metrica-numero metrica-negra">${pagosDB.lista_negra.length}</div><div class="metrica-label">🚫 Lista Negra</div></div>
</div>

<h2 style="margin-bottom:16px;color:#0f172a;font-size:20px">⏰ Pagos pendientes de verificación</h2>

${pagosDB.pendientes.length === 0 ? '<div class="vacio">🎉 No hay pagos pendientes</div>' : pagosDB.pendientes.map(p => {
  const fechaRecibido = new Date(p.fecha_recibido);
  const fechaLimite = new Date(p.fecha_limite);
  const diasRestantes = Math.floor((fechaLimite - ahora) / (24 * 60 * 60 * 1000));
  const esUrgente = diasRestantes <= 2;
  let urgenciaClass = 'baja';
  let urgenciaTexto = `${diasRestantes} días`;
  if (diasRestantes <= 0) { urgenciaClass = 'alta'; urgenciaTexto = 'VENCIDO'; }
  else if (diasRestantes <= 2) { urgenciaClass = 'alta'; urgenciaTexto = `⚠️ ${diasRestantes}d`; }
  else if (diasRestantes <= 5) { urgenciaClass = 'media'; urgenciaTexto = `${diasRestantes} días`; }

  return `<div class="tarjeta ${esUrgente ? 'urgente' : ''}">
<div class="tarjeta-header">
<div><div class="tarjeta-titulo">${p.nombre} <span class="urgencia ${urgenciaClass}">${urgenciaTexto}</span></div>
<div style="font-size:12px;color:#64748b">📅 ${fechaRecibido.toLocaleString('es-EC', { timeZone: 'America/Guayaquil' })}</div></div>
</div>
<div class="tarjeta-info">
<div class="info-item"><div class="info-label">🆔 Cédula</div><div class="info-valor">${p.cedula}</div></div>
<div class="info-item"><div class="info-label">📞 Teléfono</div><div class="info-valor">${p.telefono || 'N/A'}</div></div>
<div class="info-item"><div class="info-label">💰 Deuda</div><div class="info-valor">$${p.deuda.toFixed(2)}</div></div>
<div class="info-item"><div class="info-label">📋 Plan</div><div class="info-valor">${p.plan}</div></div>
</div>
<div class="botones">
<button class="btn btn-verificar" onclick="verificar('${p.cedula}')">✅ Verificar</button>
<button class="btn btn-rechazar" onclick="rechazar('${p.cedula}')">❌ Rechazar</button>
</div>
</div>`;
}).join('')}

</div>

<script>
async function verificar(cedula) {
  if (!confirm('¿Confirmar pago verificado?')) return;
  const res = await fetch('/admin/${ADMIN_TOKEN}/verificar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cedula })
  });
  const data = await res.json();
  alert(data.exito ? '✅ Verificado' : '❌ Error: ' + data.error);
  if (data.exito) location.reload();
}

async function rechazar(cedula) {
  if (!confirm('⚠️ ¿RECHAZAR?\\n\\nEsto cortará el servicio y agregará a lista negra.')) return;
  const res = await fetch('/admin/${ADMIN_TOKEN}/rechazar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cedula })
  });
  const data = await res.json();
  alert(data.exito ? '❌ Rechazado' : '❌ Error: ' + data.error);
  if (data.exito) location.reload();
}

setTimeout(() => location.reload(), 30000);
</script>
</body></html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

app.post('/admin/:token/verificar', async (req, res) => {
  if (req.params.token !== ADMIN_TOKEN) return res.status(403).json({ error: 'Acceso denegado' });

  try {
    const { cedula } = req.body;
    const indice = pagosDB.pendientes.findIndex(p => p.cedula === cedula);
    if (indice === -1) return res.json({ exito: false, error: 'No encontrado' });

    const pago = pagosDB.pendientes[indice];
    pago.estado = 'VERIFICADO';
    pago.fecha_verificado = new Date().toISOString();

    pagosDB.pendientes.splice(indice, 1);
    pagosDB.verificados.push(pago);

    if (pago.telefono) {
      try {
        await fetch(`${MERCATELY_API_URL}/whatsapp_messages`, {
          method: 'POST',
          headers: { 'Api-Key': MERCATELY_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            phone_number: pago.telefono,
            message: `✅ *Pago confirmado*\n\nEstimado(a) ${pago.nombre}, su pago ha sido verificado.\n\n¡Gracias por confiar en FibraNet! 🌐`
          })
        });
      } catch (e) { console.error('Error notificar:', e.message); }
    }

    console.log(`✅ [ADMIN] Verificado: ${cedula}`);
    res.json({ exito: true });
  } catch (err) {
    res.status(500).json({ exito: false, error: err.message });
  }
});

app.post('/admin/:token/rechazar', async (req, res) => {
  if (req.params.token !== ADMIN_TOKEN) return res.status(403).json({ error: 'Acceso denegado' });

  try {
    const { cedula } = req.body;
    const indice = pagosDB.pendientes.findIndex(p => p.cedula === cedula);
    if (indice === -1) return res.json({ exito: false, error: 'No encontrado' });

    const pago = pagosDB.pendientes[indice];
    pago.estado = 'RECHAZADO';
    pago.fecha_rechazado = new Date().toISOString();

    await suspenderServicioMikroWisp(pago.idcliente, 'Pago rechazado');

    pagosDB.pendientes.splice(indice, 1);
    pagosDB.rechazados.push(pago);
    if (!pagosDB.lista_negra.includes(cedula)) {
      pagosDB.lista_negra.push(cedula);
    }

    if (pago.telefono) {
      try {
        await fetch(`${MERCATELY_API_URL}/whatsapp_messages`, {
          method: 'POST',
          headers: { 'Api-Key': MERCATELY_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            phone_number: pago.telefono,
            message: `⚠️ *Estimado cliente*\n\nSu pago no pudo ser confirmado.\n\nContacte a un asesor:\n\n📞 098 877 3995\n\n_FibraNet_`
          })
        });
      } catch (e) { console.error('Error notificar:', e.message); }
    }

    console.log(`❌ [ADMIN] Rechazado: ${cedula}`);
    res.json({ exito: true });
  } catch (err) {
    res.status(500).json({ exito: false, error: err.message });
  }
});

// ════════════════════════════════════════════════════════
// 🎓 v6.1.1: VERIFICACIÓN DE VENCIMIENTOS
// ════════════════════════════════════════════════════════

async function verificarVencimientos() {
  try {
    console.log(`⏰ [CRON] Verificando vencimientos...`);
    const ahora = new Date();
    const pendientesActualizados = [];

    for (const pago of pagosDB.pendientes) {
      const fechaLimite = new Date(pago.fecha_limite);
      const diasRestantes = Math.floor((fechaLimite - ahora) / (24 * 60 * 60 * 1000));

      if (diasRestantes <= (DIAS_PROMESA - DIAS_AVISO_RECORDATORIO) && !pago.aviso_recordatorio_enviado) {
        const asunto = '⚠️ RECORDATORIO - Verificación pendiente - FibraNet';
        const mensaje = `
RECORDATORIO - Verificación pendiente

Cliente: ${pago.nombre}
Cédula: ${pago.cedula}
Recibido hace: ${DIAS_AVISO_RECORDATORIO} días

Quedan ${diasRestantes} días para verificar

Dashboard: https://mindful-commitment-production.up.railway.app/admin/${ADMIN_TOKEN}
`;
        await notificarContadora(asunto, mensaje);
        pago.aviso_recordatorio_enviado = true;
        console.log(`📨 [CRON] Recordatorio: ${pago.cedula}`);
      }

      if (diasRestantes <= 0) {
        console.log(`🔴 [CRON] Auto-corte: ${pago.cedula}`);
        await suspenderServicioMikroWisp(pago.idcliente, 'Auto-corte falta verificación');
        pago.estado = 'AUTO_CORTADO';
        pago.fecha_auto_cortado = ahora.toISOString();
        pagosDB.rechazados.push(pago);

        if (pago.telefono) {
          try {
            await fetch(`${MERCATELY_API_URL}/whatsapp_messages`, {
              method: 'POST',
              headers: { 'Api-Key': MERCATELY_API_KEY, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                phone_number: pago.telefono,
                message: `⚠️ *Estimado cliente*\n\nSu pago aún no ha sido confirmado.\n\nContacte:\n\n📞 098 877 3995\n\n_FibraNet_`
              })
            });
          } catch (e) { console.error('Error notificar:', e.message); }
        }

        await notificarContadora('🔴 AUTO-CORTE - FibraNet', `
AUTO-CORTE POR FALTA DE VERIFICACIÓN

Cliente: ${pago.nombre}
Cédula: ${pago.cedula}

Servicio suspendido automáticamente.
`);
        continue;
      }

      pendientesActualizados.push(pago);
    }

    pagosDB.pendientes = pendientesActualizados;
    console.log(`⏰ [CRON] Verificación completada`);
  } catch (err) {
    console.error('❌ [CRON] Error:', err.message);
  }
}

setInterval(verificarVencimientos, 60 * 60 * 1000);
setTimeout(verificarVencimientos, 60 * 1000);

// ════════════════════════════════════════════════════════
// SERVIDOR
// ════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 FibraNet Webhook v6.1.1 (RAM) en puerto ${PORT}`);
  console.log(`📊 Sistema: Promesa de Pago ${DIAS_PROMESA} días`);
  console.log(`💾 Base de datos en RAM - se resetea al reiniciar`);
  console.log(`👤 Contadora: ${CONTADORA_TELEFONO}`);
});
