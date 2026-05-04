const express = require('express');
const { google } = require('googleapis');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const { Pool } = require('pg');
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

const DIAS_PROMESA = 10;
const DIAS_AVISO_RECORDATORIO = 8;
const CONTADORA_EMAIL = 'jiduque@utpl.edu.ec';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'fibranet-admin-2026';
const SESION_TTL_MS = 10 * 60 * 1000; // 10 minutos

const GOOGLE_CREDENTIALS = {
  client_email: process.env.GOOGLE_CLIENT_EMAIL,
  private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
};

let ultimoPingMercately = null;

// ════════════════════════════════════════════════════════
// v7.0: POSTGRESQL - BASE DE DATOS PERSISTENTE
// ════════════════════════════════════════════════════════

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Inicializar tablas en PostgreSQL
async function inicializarDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pagos_pendientes (
        id SERIAL PRIMARY KEY,
        cedula VARCHAR(20) NOT NULL,
        nombre VARCHAR(200),
        idcliente INTEGER,
        telefono VARCHAR(30),
        plan VARCHAR(100),
        servicios JSONB,
        deuda DECIMAL(10,2),
        idfacturas JSONB,
        fecha_recibido TIMESTAMP DEFAULT NOW(),
        fecha_limite TIMESTAMP,
        estado VARCHAR(30) DEFAULT 'PENDIENTE',
        aviso_recordatorio_enviado BOOLEAN DEFAULT FALSE,
        promesa_registrada BOOLEAN DEFAULT FALSE
      );

      CREATE TABLE IF NOT EXISTS pagos_verificados (
        id SERIAL PRIMARY KEY,
        cedula VARCHAR(20),
        nombre VARCHAR(200),
        idcliente INTEGER,
        telefono VARCHAR(30),
        plan VARCHAR(100),
        servicios JSONB,
        deuda DECIMAL(10,2),
        idfacturas JSONB,
        fecha_recibido TIMESTAMP,
        fecha_verificado TIMESTAMP DEFAULT NOW(),
        estado VARCHAR(30) DEFAULT 'VERIFICADO'
      );

      CREATE TABLE IF NOT EXISTS pagos_rechazados (
        id SERIAL PRIMARY KEY,
        cedula VARCHAR(20),
        nombre VARCHAR(200),
        idcliente INTEGER,
        telefono VARCHAR(30),
        plan VARCHAR(100),
        servicios JSONB,
        deuda DECIMAL(10,2),
        fecha_recibido TIMESTAMP,
        fecha_rechazado TIMESTAMP DEFAULT NOW(),
        estado VARCHAR(30) DEFAULT 'RECHAZADO'
      );

      CREATE TABLE IF NOT EXISTS lista_negra (
        cedula VARCHAR(20) PRIMARY KEY,
        fecha_agregado TIMESTAMP DEFAULT NOW(),
        motivo VARCHAR(200)
      );
    `);
    console.log('✅ [DB] PostgreSQL inicializado correctamente');
  } catch (err) {
    console.error('❌ [DB] Error inicializando PostgreSQL:', err.message);
    console.log('⚠️ [DB] Usando RAM como fallback');
  }
}

// ════════════════════════════════════════════════════════
// FUNCIONES DE BASE DE DATOS
// ════════════════════════════════════════════════════════

async function agregarPagoPendiente(pago) {
  try {
    await pool.query(`
      INSERT INTO pagos_pendientes 
      (cedula, nombre, idcliente, telefono, plan, servicios, deuda, idfacturas, fecha_recibido, fecha_limite, estado)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PENDIENTE')
    `, [
      pago.cedula, pago.nombre, pago.idcliente, pago.telefono,
      pago.plan, JSON.stringify(pago.servicios), pago.deuda,
      JSON.stringify(pago.idfacturas || []),
      pago.fecha_recibido, pago.fecha_limite
    ]);
    console.log(`💾 [DB] Pago guardado en PostgreSQL: ${pago.cedula}`);
    return true;
  } catch (err) {
    console.error('❌ [DB] Error guardando pago:', err.message);
    return false;
  }
}

async function estaEnListaNegra(cedula) {
  try {
    const result = await pool.query('SELECT cedula FROM lista_negra WHERE cedula=$1', [cedula]);
    return result.rows.length > 0;
  } catch (err) {
    console.error('❌ [DB] Error lista negra:', err.message);
    return false;
  }
}

async function tienePagoPendiente(cedula) {
  try {
    const result = await pool.query(
      "SELECT * FROM pagos_pendientes WHERE cedula=$1 AND estado='PENDIENTE'", [cedula]
    );
    return result.rows.length > 0 ? result.rows[0] : null;
  } catch (err) {
    console.error('❌ [DB] Error verificando pendiente:', err.message);
    return null;
  }
}

async function obtenerPagosPendientes() {
  try {
    const result = await pool.query(
      "SELECT * FROM pagos_pendientes WHERE estado='PENDIENTE' ORDER BY fecha_recibido DESC"
    );
    return result.rows;
  } catch (err) {
    console.error('❌ [DB] Error obteniendo pendientes:', err.message);
    return [];
  }
}

async function obtenerPagosVerificados() {
  try {
    const result = await pool.query(
      "SELECT * FROM pagos_verificados ORDER BY fecha_verificado DESC LIMIT 50"
    );
    return result.rows;
  } catch (err) {
    return [];
  }
}

async function obtenerPagosRechazados() {
  try {
    const result = await pool.query(
      "SELECT * FROM pagos_rechazados ORDER BY fecha_rechazado DESC LIMIT 50"
    );
    return result.rows;
  } catch (err) {
    return [];
  }
}

async function contarListaNegra() {
  try {
    const result = await pool.query('SELECT COUNT(*) FROM lista_negra');
    return parseInt(result.rows[0].count);
  } catch (err) {
    return 0;
  }
}

// ════════════════════════════════════════════════════════
// v7.0: SISTEMA DE SESIONES (10 MINUTOS)
// ════════════════════════════════════════════════════════

const sesionesClientes = new Map();

function guardarSesion(telefono, cedula, nombre, clientes) {
  sesionesClientes.set(telefono, { cedula, nombre, clientes, timestamp: Date.now() });
  console.log(`💾 [SESION] Guardada: ${telefono} (${nombre})`);
  setTimeout(() => {
    if (sesionesClientes.has(telefono)) {
      sesionesClientes.delete(telefono);
      console.log(`🗑️ [SESION] Expirada: ${telefono}`);
    }
  }, SESION_TTL_MS);
}

function obtenerSesion(telefono) {
  const sesion = sesionesClientes.get(telefono);
  if (!sesion) return null;
  if (Date.now() - sesion.timestamp > SESION_TTL_MS) {
    sesionesClientes.delete(telefono);
    return null;
  }
  sesion.timestamp = Date.now();
  return sesion;
}

function cerrarSesion(telefono) {
  if (sesionesClientes.has(telefono)) {
    sesionesClientes.delete(telefono);
    console.log(`🚪 [SESION] Cerrada: ${telefono}`);
    return true;
  }
  return false;
}

// ════════════════════════════════════════════════════════
// SISTEMA DE CACHÉ
// ════════════════════════════════════════════════════════

const cacheClientes = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

// ════════════════════════════════════════════════════════
// UTILIDADES
// ════════════════════════════════════════════════════════

function capitalizarNombre(nombre) {
  if (!nombre || typeof nombre !== 'string') return '';
  return nombre.trim().toLowerCase().split(/\s+/).filter(p => p)
    .map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

async function buscarClientePorCedula(cedula, useCache = true) {
  if (!cedula) return { exito: false, error: 'Cédula vacía' };
  if (useCache) {
    const cached = cacheClientes.get(cedula);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
      return { exito: true, clientes: cached.data };
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
    cacheClientes.set(cedula, { data: data.datos, timestamp: Date.now() });
    return { exito: true, clientes: data.datos };
  } catch (err) {
    console.error('Error buscar cliente:', err.message);
    return { exito: false, error: err.message };
  }
}

// ════════════════════════════════════════════════════════
// v7.0: FUNCIONES MIKROWISP - FACTURACIÓN
// ════════════════════════════════════════════════════════

// Obtener facturas pendientes de un cliente
async function obtenerFacturasPendientes(idcliente) {
  try {
    const response = await fetch(`${MIKROWISP_URL}/api/v1/GetInvoices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: MIKROWISP_TOKEN,
        idcliente: idcliente,
        estado: 'pendiente'
      })
    });
    const data = await response.json();
    if (data.estado === 'exito' && data.datos?.length > 0) {
      console.log(`📋 [FAKTURAS] Cliente ${idcliente}: ${data.datos.length} facturas pendientes`);
      return data.datos;
    }
    return [];
  } catch (err) {
    console.error('❌ [FAKTURAS] Error obteniendo facturas:', err.message);
    return [];
  }
}

// Registrar promesa de pago en MikroWisp (evita corte automático por 10 días)
async function registrarPromesaPago(idfactura, fechaLimite) {
  try {
    const fechaStr = fechaLimite.toISOString().split('T')[0]; // YYYY-MM-DD
    const response = await fetch(`${MIKROWISP_URL}/api/v1/PromesaPago`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: MIKROWISP_TOKEN,
        idfactura: parseInt(idfactura),
        fechalimite: fechaStr,
        descripcion: 'Promesa de pago registrada via WhatsApp - FibraNet Bot'
      })
    });
    const data = await response.json();
    console.log(`📝 [PROMESA] Factura ${idfactura}: ${JSON.stringify(data)}`);
    return data.estado === 'exito';
  } catch (err) {
    console.error('❌ [PROMESA] Error registrando promesa:', err.message);
    return false;
  }
}

// Pagar factura en MikroWisp (cuando contadora verifica)
async function pagarFacturaMikroWisp(idfactura, monto) {
  try {
    const response = await fetch(`${MIKROWISP_URL}/api/v1/PaidInvoice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: MIKROWISP_TOKEN,
        idfactura: parseInt(idfactura),
        pasarela: 'WhatsApp-FibraNet',
        cantidad: parseFloat(monto),
        idtransaccion: `WA-${Date.now()}`
      })
    });
    const data = await response.json();
    console.log(`💳 [PAGO] Factura ${idfactura}: ${JSON.stringify(data)}`);
    return data.estado === 'exito';
  } catch (err) {
    console.error('❌ [PAGO] Error pagando factura:', err.message);
    return false;
  }
}

// ════════════════════════════════════════════════════════
// ACTIVACIÓN/SUSPENSIÓN EN MIKROWISP
// ════════════════════════════════════════════════════════

async function activarServicioMikroWisp(idcliente) {
  try {
    const response = await fetch(`${MIKROWISP_URL}/api/v1/ActiveService`, {
      method: 'POST',
      headers: { 'accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: MIKROWISP_TOKEN, idcliente: parseInt(idcliente) })
    });
    const data = await response.json();
    console.log(`🔧 [MIKROWISP] Activación ${idcliente}:`, JSON.stringify(data));
    if (data.estado === 'exito') return true;
    if (data.mensaje?.toLowerCase().includes('activo')) {
      console.log(`✅ [MIKROWISP] Ya estaba ACTIVO - OK`);
      return true;
    }
    return false;
  } catch (err) {
    console.error('❌ Error activar:', err.message);
    return false;
  }
}

async function suspenderServicioMikroWisp(idcliente, motivo) {
  try {
    const response = await fetch(`${MIKROWISP_URL}/api/v1/SetStatusClient`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: MIKROWISP_TOKEN, idcliente, estado: 'retirado', motivo })
    });
    const data = await response.json();
    return data.estado === 'exito';
  } catch (err) {
    console.error('❌ Error suspender:', err.message);
    return false;
  }
}

// ════════════════════════════════════════════════════════
// NOTIFICACIÓN A LA CONTADORA
// ════════════════════════════════════════════════════════

async function notificarContadora(asunto, mensaje) {
  try {
    console.log(`📧 [EMAIL] Asunto: ${asunto}`);
    console.log(`📧 [EMAIL] ${mensaje.substring(0, 150)}...`);
    console.log(`✅ [EMAIL] Simulado → ${CONTADORA_EMAIL}`);
    return true;
  } catch (err) {
    console.error('❌ [EMAIL] Error:', err.message);
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
  const rutas = ['/cliente/buscar', '/cliente/sesion', '/cliente/salir', '/cliente/deuda', '/cliente/plan', '/pago/info', '/pago/comprobante', '/soporte/reporte', '/soporte/cambio-clave', '/despedida'];
  if (rutas.some(r => req.path === r)) ultimoPingMercately = new Date();
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
    const data = await response.json();
    if (response.ok && data.estado) return { estado: 'ok', mensaje: 'API respondió correctamente', tiempo_respuesta_ms: Date.now() - inicio };
    return { estado: 'error', mensaje: 'Error en respuesta' };
  } catch (err) {
    return { estado: 'error', mensaje: err.message };
  }
}

async function verificarPostgreSQL() {
  try {
    await pool.query('SELECT 1');
    return { estado: 'ok', mensaje: 'PostgreSQL conectado ✅' };
  } catch (err) {
    return { estado: 'error', mensaje: err.message };
  }
}

async function verificarMercatelyAPI() {
  try {
    if (!MERCATELY_API_KEY) return { estado: 'error', mensaje: 'API Key no configurada' };
    const response = await fetch(`${MERCATELY_API_URL}/customers?page=1&per_page=1`, {
      method: 'GET', headers: { 'Api-Key': MERCATELY_API_KEY, 'Content-Type': 'application/json' }
    });
    if (response.ok) return { estado: 'ok', mensaje: 'API conectada' };
    return { estado: 'error', mensaje: `HTTP ${response.status}` };
  } catch (err) {
    return { estado: 'error', mensaje: err.message };
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

app.get('/', (req, res) => res.json({ estado: 'FibraNet Webhook activo ✅', version: '7.2 (Fix error HTTP 400)' }));

app.get('/health', async (req, res) => {
  const [mikrowisp, mercatelyApi, postgresql] = await Promise.all([
    verificarMikroWisp(), verificarMercatelyAPI(), verificarPostgreSQL()
  ]);
  const mercately = verificarMercately();
  const pendientes = await obtenerPagosPendientes();
  const listaNegra = await contarListaNegra();
  res.json({
    estado_general: '✅',
    version: '7.2 (Fix error HTTP 400)',
    servicios: { mikrowisp, mercately_api: mercatelyApi, mercately_chatbot: mercately, postgresql },
    pagos: { pendientes: pendientes.length, lista_negra: listaNegra },
    sesiones: { activas: sesionesClientes.size, ttl_minutos: 10 }
  });
});

app.get('/status', async (req, res) => {
  const [mikrowisp, mercatelyApi, postgresql] = await Promise.all([
    verificarMikroWisp(), verificarMercatelyAPI(), verificarPostgreSQL()
  ]);
  const mercately = verificarMercately();
  const todos_ok = mikrowisp.estado === 'ok' && postgresql.estado === 'ok';
  const colorEstado = (e) => e === 'ok' ? '#22c55e' : e === 'advertencia' ? '#f59e0b' : e === 'desconocido' ? '#6b7280' : '#ef4444';
  const iconoEstado = (e) => e === 'ok' ? '🟢' : e === 'advertencia' ? '🟡' : e === 'desconocido' ? '⚪' : '🔴';
  const tiempoLocal = new Date().toLocaleString('es-EC', { timeZone: 'America/Guayaquil' });
  const pendientes = await obtenerPagosPendientes();
  const listaNegra = await contarListaNegra();

  const html = `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta http-equiv="refresh" content="30"><title>FibraNet · Estado</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,sans-serif;background:linear-gradient(135deg,#0f172a 0%,#1e293b 100%);color:#f1f5f9;min-height:100vh;padding:20px}.container{max-width:800px;margin:0 auto}.header{text-align:center;margin-bottom:30px;padding:30px 20px;background:rgba(255,255,255,0.05);border-radius:16px}.logo{font-size:32px;font-weight:700}.logo span{color:#60a5fa}.subtitle{color:#94a3b8;font-size:14px;margin-top:8px}.estado-general{margin-top:16px;padding:12px 24px;border-radius:999px;display:inline-block;font-weight:600;background:${todos_ok ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)'};color:${todos_ok ? '#22c55e' : '#ef4444'}}.servicios{display:grid;gap:16px;margin-top:20px}.servicio{background:rgba(255,255,255,0.05);border-radius:12px;padding:20px}.servicio-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}.servicio-nombre{font-size:16px;font-weight:600}.badge{padding:4px 12px;border-radius:999px;font-size:12px;font-weight:600}.metricas{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:16px}.metrica{background:rgba(96,165,250,0.05);border:1px solid rgba(96,165,250,0.2);border-radius:12px;padding:16px;text-align:center}.metrica-numero{font-size:28px;font-weight:700;color:#60a5fa}.metrica-label{font-size:11px;color:#94a3b8;margin-top:4px}.footer{text-align:center;margin-top:30px;color:#64748b;font-size:13px}.footer a{color:#60a5fa;text-decoration:none}.db-badge{background:rgba(34,197,94,0.15);color:#22c55e;padding:4px 12px;border-radius:999px;font-size:12px;font-weight:600;display:inline-block;margin-top:8px}</style>
</head><body><div class="container">
<div class="header">
<div class="logo">📡 Fibra<span>Net</span></div>
<div class="subtitle">Panel de Estado · v7.0</div>
<div class="db-badge">🗄️ PostgreSQL - Datos Persistentes</div>
<div class="estado-general">${todos_ok ? '✅ TODO OPERATIVO' : '⚠️ REVISAR'}</div>
</div>
<div class="servicios">
<div class="servicio" style="border-left:4px solid ${colorEstado(postgresql.estado)}"><div class="servicio-header"><div class="servicio-nombre">🗄️ PostgreSQL</div><span class="badge" style="background:${colorEstado(postgresql.estado)}20;color:${colorEstado(postgresql.estado)}">${iconoEstado(postgresql.estado)} ${postgresql.estado.toUpperCase()}</span></div><div style="color:#cbd5e1;font-size:14px;margin-top:8px">${postgresql.mensaje}</div></div>
<div class="servicio" style="border-left:4px solid ${colorEstado(mikrowisp.estado)}"><div class="servicio-header"><div class="servicio-nombre">🌐 MikroWisp</div><span class="badge" style="background:${colorEstado(mikrowisp.estado)}20;color:${colorEstado(mikrowisp.estado)}">${iconoEstado(mikrowisp.estado)} ${mikrowisp.estado.toUpperCase()}</span></div><div style="color:#cbd5e1;font-size:14px;margin-top:8px">${mikrowisp.mensaje}</div></div>
<div class="servicio" style="border-left:4px solid ${colorEstado(mercatelyApi.estado)}"><div class="servicio-header"><div class="servicio-nombre">🔑 Mercately API</div><span class="badge" style="background:${colorEstado(mercatelyApi.estado)}20;color:${colorEstado(mercatelyApi.estado)}">${iconoEstado(mercatelyApi.estado)} ${mercatelyApi.estado.toUpperCase()}</span></div><div style="color:#cbd5e1;font-size:14px;margin-top:8px">${mercatelyApi.mensaje}</div></div>
<div class="servicio" style="border-left:4px solid ${colorEstado(mercately.estado)}"><div class="servicio-header"><div class="servicio-nombre">💬 Mercately Chatbot</div><span class="badge" style="background:${colorEstado(mercately.estado)}20;color:${colorEstado(mercately.estado)}">${iconoEstado(mercately.estado)} ${mercately.estado.toUpperCase()}</span></div><div style="color:#cbd5e1;font-size:14px;margin-top:8px">${mercately.mensaje}</div></div>
</div>
<div class="metricas">
<div class="metrica"><div class="metrica-numero">${pendientes.length}</div><div class="metrica-label">Pendientes</div></div>
<div class="metrica"><div class="metrica-numero">${sesionesClientes.size}</div><div class="metrica-label">Sesiones activas</div></div>
<div class="metrica"><div class="metrica-numero">${listaNegra}</div><div class="metrica-label">Lista Negra</div></div>
</div>
<div class="footer"><div>📍 Zamora, Ecuador · ${tiempoLocal}</div><div style="margin-top:8px"><a href="/admin/${ADMIN_TOKEN}">📊 Dashboard Contadora</a> · <a href="/health">Ver JSON</a></div></div>
</div></body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// ════════════════════════════════════════════════════════
// ENDPOINTS DE SESIÓN
// ════════════════════════════════════════════════════════

app.post('/cliente/sesion', async (req, res) => {
  try {
    const { telefono } = req.body;
    if (!telefono) return res.json({ tiene_sesion: false });
    const sesion = obtenerSesion(telefono);
    if (sesion) {
      return res.json({
        tiene_sesion: true,
        cedula: sesion.cedula,
        nombre: sesion.nombre,
        mensaje: `¡Hola de nuevo ${sesion.nombre}! ¿En qué puedo ayudarte?`
      });
    }
    return res.json({ tiene_sesion: false });
  } catch (error) {
    res.status(500).json({ tiene_sesion: false });
  }
});

app.post('/cliente/salir', async (req, res) => {
  try {
    const { telefono } = req.body;
    cerrarSesion(telefono);
    return res.json({
      sesion_cerrada: true,
      mensaje: "👋 *¡Hasta pronto!*\n\nGracias por contactar a *FibraNet* 🌐\n\nSi necesitas ayuda nuevamente, solo escríbeme."
    });
  } catch (error) {
    res.status(500).json({ sesion_cerrada: false });
  }
});

// ════════════════════════════════════════════════════════
// ENDPOINTS DE CHATBOT
// ════════════════════════════════════════════════════════

app.post('/cliente/buscar', async (req, res) => {
  try {
    const { cedula, telefono, intento } = req.body;
    const numeroIntento = parseInt(intento || 1);
    console.log(`📞 [BUSCAR] Cédula: "${cedula}" | Tel: ${telefono}`);

    if (!cedula) return res.status(400).json({ encontrado: false, mensaje: '⚠️ Por favor escríbeme tu número de cédula.' });

    const resultado = await buscarClientePorCedula(cedula);
    if (!resultado.exito) {
      // v7.2: Retornar HTTP 400 para que Mercately vaya por rama "Error"
      if (numeroIntento >= 2) {
        return res.status(400).json({
          encontrado: false,
          transferir: true,
          mensaje: `😕 No encontramos ningún cliente con esa cédula.\n\nUn asesor te ayudará. 👨‍💻\n\n📞 *098 877 3995*`
        });
      }
      return res.status(400).json({
        encontrado: false,
        transferir: false,
        mensaje: `❌ No encontré ningún cliente con la cédula *${cedula}*.\n\n¿Deseas intentar con otra cédula o hablar con un asesor?`
      });
    }

    const clientes = resultado.clientes;
    const clientesVistos = new Set();
    const clientesUnicos = [];
    clientes.forEach(c => {
      if (!clientesVistos.has(c.id)) { clientesVistos.add(c.id); clientesUnicos.push(c); }
    });

    const primerCliente = clientesUnicos[0];
    let deudaTotal = 0, facturasTotal = 0;
    clientesUnicos.forEach(c => {
      deudaTotal += parseFloat(c.facturacion?.total_facturas || 0);
      facturasTotal += parseInt(c.facturacion?.facturas_nopagadas || 0);
    });

    const nombreCompleto = capitalizarNombre(primerCliente.nombre);

    let tieneSesionActiva = false;
    if (telefono) {
      const sesionExistente = obtenerSesion(telefono);
      if (sesionExistente) tieneSesionActiva = true;
    }

    if (telefono) guardarSesion(telefono, cedula, nombreCompleto, clientesUnicos);

    const mensajeBienvenida = tieneSesionActiva
      ? `📋 ¿En qué más podemos ayudarle?`
      : `✅ *Identidad verificada*\n\nBienvenido(a) Sr(a). *${nombreCompleto}*\n\n📋 ¿En qué podemos ayudarle hoy?`;

    return res.json({
      encontrado: true,
      id: primerCliente.id,
      nombre: nombreCompleto,
      cedula,
      deuda: deudaTotal,
      facturasPendientes: facturasTotal,
      plan: clientesUnicos.length > 1 ? `${clientesUnicos.length} servicios` : (clientesUnicos[0].servicios?.[0]?.perfil || 'N/A'),
      mensaje: mensajeBienvenida
    });
  } catch (err) {
    console.error('❌ [BUSCAR] Error:', err);
    res.status(500).json({ encontrado: false, transferir: true, mensaje: '⚠️ Error del sistema.' });
  }
});

app.post('/cliente/deuda', async (req, res) => {
  try {
    const { cedula, telefono } = req.body;
    let resultado;
    if (telefono) {
      const sesion = obtenerSesion(telefono);
      if (sesion) resultado = { exito: true, clientes: sesion.clientes };
    }
    if (!resultado && cedula) resultado = await buscarClientePorCedula(cedula);
    if (!resultado?.exito) return res.json({ mensaje: '❌ No se encontró información del cliente.' });

    const clientes = resultado.clientes;
    let deudaTotal = 0, facturasTotal = 0;
    clientes.forEach(c => {
      deudaTotal += parseFloat(c.facturacion?.total_facturas || 0);
      facturasTotal += parseInt(c.facturacion?.facturas_nopagadas || 0);
    });

    if (facturasTotal === 0) {
      return res.json({ deuda: 0, mensaje: `✅ *Estimado(a) cliente*, no tiene deudas pendientes.\n\n¡Gracias por mantener su pago al día! 🎉` });
    }

    let desglose = '';
    if (clientes.length > 1) {
      desglose = '\n\n📋 *Desglose por servicio:*\n';
      clientes.forEach((c, index) => {
        const deuda = parseFloat(c.facturacion?.total_facturas || 0);
        const facturas = parseInt(c.facturacion?.facturas_nopagadas || 0);
        if (deuda > 0) desglose += `\n${index + 1}. ${c.nombre.trim()}\n   💵 $${deuda.toFixed(2)} (${facturas} factura${facturas > 1 ? 's' : ''})`;
      });
    }

    return res.json({
      deuda: deudaTotal,
      facturas: facturasTotal,
      mensaje: `💰 *Estado de cuenta*\n\n💵 Total a pagar: *$${deudaTotal.toFixed(2)}*\n📋 Facturas pendientes: *${facturasTotal}*${desglose}\n\nPara pagar seleccione *"📸 Pagar mi servicio"* en el menú.`
    });
  } catch (err) {
    res.status(500).json({ mensaje: '⚠️ Error del sistema.' });
  }
});

app.post('/pago/info', async (req, res) => {
  try {
    const { cedula, telefono } = req.body;
    let resultado;
    if (telefono) {
      const sesion = obtenerSesion(telefono);
      if (sesion) resultado = { exito: true, clientes: sesion.clientes };
    }
    if (!resultado && cedula) resultado = await buscarClientePorCedula(cedula);
    if (!resultado?.exito) return res.json({ mensaje: '❌ No se encontró información del cliente.' });

    const clientes = resultado.clientes;
    let deudaTotal = 0, facturasTotal = 0;
    clientes.forEach(c => {
      deudaTotal += parseFloat(c.facturacion?.total_facturas || 0);
      facturasTotal += parseInt(c.facturacion?.facturas_nopagadas || 0);
    });

    if (facturasTotal === 0) return res.json({ deuda: 0, mensaje: `✅ No tiene deudas pendientes. ¡Está al día! 🎉` });

    res.json({
      deuda: deudaTotal,
      mensaje: `${CUENTAS_BANCARIAS}\n\n💵 *Su deuda total: $${deudaTotal.toFixed(2)}*\n\n📸 Realice su transferencia y envíenos la *foto del comprobante* aquí mismo para activar su${clientes.length > 1 ? 's' : ''} servicio${clientes.length > 1 ? 's' : ''}.`
    });
  } catch (err) {
    res.status(500).json({ mensaje: '⚠️ Error del sistema.' });
  }
});

// ════════════════════════════════════════════════════════
// v7.0: PROCESAR COMPROBANTE CON PROMESA DE PAGO EN MIKROWISP
// ════════════════════════════════════════════════════════

app.post('/pago/comprobante', async (req, res) => {
  try {
    const { cedula, telefono, nombre_contacto } = req.body;
    console.log(`📸 [COMPROBANTE v7.0] Cédula: "${cedula}" | Tel: ${telefono}`);

    let resultadoCliente;
    if (telefono) {
      const sesion = obtenerSesion(telefono);
      if (sesion) resultadoCliente = { exito: true, clientes: sesion.clientes };
    }
    if (!resultadoCliente && cedula) resultadoCliente = await buscarClientePorCedula(cedula);
    if (!resultadoCliente?.exito) return res.json({ activado: false, mensaje: '❌ No se encontró información del cliente.' });

    const clientes = resultadoCliente.clientes;
    const primerCliente = clientes[0];
    const nombreCompleto = nombre_contacto || capitalizarNombre(primerCliente.nombre);
    const telefonoFinal = telefono || primerCliente.movil || primerCliente.telefono || '';
    const cedulaFinal = cedula || primerCliente.cedula;

    let deudaTotal = 0;
    clientes.forEach(c => { deudaTotal += parseFloat(c.facturacion?.total_facturas || 0); });

    if (deudaTotal === 0) return res.json({ activado: false, mensaje: `✅ Estimado(a) ${nombreCompleto}, no tiene deudas pendientes.\n\n¡Está al día! 🎉` });

    if (await estaEnListaNegra(cedulaFinal)) {
      return res.json({ activado: false, mensaje: `⚠️ Por seguridad, su pago será verificado manualmente.\n\nUn asesor le contactará. 📞` });
    }

    if (await tienePagoPendiente(cedulaFinal)) {
      return res.json({
        activado: true,
        mensaje: `✅ *${nombreCompleto}*, ya tenemos su comprobante registrado.\n\nSu${clientes.length > 1 ? 's' : ''} servicio${clientes.length > 1 ? 's están' : ' está'} activo${clientes.length > 1 ? 's' : ''} y ${clientes.length > 1 ? 'serán verificados' : 'será verificado'} en breve.`
      });
    }

    // PASO 1: Activar servicio en MikroWisp
    let serviciosActivados = 0;
    for (const cliente of clientes) {
      const activado = await activarServicioMikroWisp(cliente.id);
      if (activado) {
        serviciosActivados++;
        console.log(`✅ [COMPROBANTE] Activado: ${cliente.nombre} (ID: ${cliente.id})`);
      }
    }

    // PASO 2: Obtener facturas pendientes y registrar promesas de pago
    const ahora = new Date();
    const fechaLimite = new Date(ahora.getTime() + DIAS_PROMESA * 24 * 60 * 60 * 1000);
    const todasLasFacturas = [];
    let promesasRegistradas = 0;

    for (const cliente of clientes) {
      const facturas = await obtenerFacturasPendientes(cliente.id);
      for (const factura of facturas) {
        todasLasFacturas.push({ id: factura.id, monto: factura.total, idcliente: cliente.id });
        const promesaOk = await registrarPromesaPago(factura.id, fechaLimite);
        if (promesaOk) {
          promesasRegistradas++;
          console.log(`📝 [COMPROBANTE] Promesa registrada: Factura ${factura.id}`);
        }
      }
    }

    console.log(`📝 [COMPROBANTE] Promesas registradas: ${promesasRegistradas}/${todasLasFacturas.length}`);

    // PASO 3: Guardar en PostgreSQL
    const listaServicios = clientes.map(c => ({
      id: c.id, nombre: c.nombre, plan: c.servicios?.[0]?.perfil || 'N/A'
    }));

    const pago = {
      cedula: cedulaFinal,
      nombre: nombreCompleto,
      idcliente: primerCliente.id,
      telefono: telefonoFinal,
      plan: clientes.length > 1 ? `${clientes.length} servicios` : (clientes[0].servicios?.[0]?.perfil || 'N/A'),
      servicios: listaServicios,
      idfacturas: todasLasFacturas,
      deuda: deudaTotal,
      fecha_recibido: ahora.toISOString(),
      fecha_limite: fechaLimite.toISOString()
    };

    await agregarPagoPendiente(pago);

    // PASO 4: Notificar contadora
    await notificarContadora('🔔 NUEVO PAGO PENDIENTE - FibraNet', `
NUEVO PAGO PENDIENTE

Cliente: ${nombreCompleto}
Cédula: ${cedulaFinal}
Teléfono: ${telefonoFinal}
Deuda: $${deudaTotal.toFixed(2)}
Servicios activados: ${serviciosActivados}/${clientes.length}
Promesas de pago registradas: ${promesasRegistradas} (MikroWisp NO cortará por ${DIAS_PROMESA} días)
Fecha límite: ${fechaLimite.toLocaleString('es-EC', { timeZone: 'America/Guayaquil' })}

Dashboard: https://mindful-commitment-production.up.railway.app/admin/${ADMIN_TOKEN}
`);

    return res.json({
      activado: true,
      mensaje: `✅ *¡Pago recibido!*\n\nHemos recibido su comprobante.\nSu${clientes.length > 1 ? 's' : ''} servicio${clientes.length > 1 ? 's se están activando' : ' se está activando'}.\n\n📡 Estimado(a) Sr(a). *${nombreCompleto}*\nDisfrute de su internet 🌐\n\n¡Gracias por confiar en FibraNet!`
    });

  } catch (err) {
    console.error('❌ [COMPROBANTE] Error:', err);
    res.status(500).json({ activado: false, mensaje: '⚠️ Error procesando el pago.' });
  }
});

app.post('/cliente/plan', async (req, res) => {
  try {
    const { cedula, telefono } = req.body;
    let resultado;
    if (telefono) {
      const sesion = obtenerSesion(telefono);
      if (sesion) resultado = { exito: true, clientes: sesion.clientes };
    }
    if (!resultado && cedula) resultado = await buscarClientePorCedula(cedula, false);
    if (!resultado?.exito) return res.json({ mensaje: '❌ No se encontró información del cliente.' });

    const clientes = resultado.clientes;

    // v7.1: Fix servicios correctos por cliente
    // MikroWisp repite servicios entre clientes
    // Solución: Para cada cliente, usar el servicio con ID más alto (el propio de ese cliente)
    // Y filtrar servicios que ya aparecieron en clientes anteriores
    
    const clientesVistos = new Set();
    const serviciosYaAsignados = new Set();
    const clientesUnicos = [];

    clientes.forEach(cliente => {
      if (!clientesVistos.has(cliente.id)) {
        clientesVistos.add(cliente.id);
        
        // Filtrar servicios que ya fueron asignados a otro cliente
        const serviciosPropios = (cliente.servicios || []).filter(s => !serviciosYaAsignados.has(s.id));
        
        if (serviciosPropios.length > 0) {
          // Usar el servicio con ID más alto (el más reciente = el real de este cliente)
          const servicioReal = serviciosPropios.reduce((max, s) => s.id > max.id ? s : max, serviciosPropios[0]);
          serviciosYaAsignados.add(servicioReal.id);
          clientesUnicos.push({ ...cliente, servicioReal });
        } else {
          // Si todos los servicios ya fueron asignados, usar el de mayor ID
          const servicios = cliente.servicios || [];
          if (servicios.length > 0) {
            const servicioReal = servicios.reduce((max, s) => s.id > max.id ? s : max, servicios[0]);
            clientesUnicos.push({ ...cliente, servicioReal });
          }
        }
      }
    });

    console.log(`📡 [PLAN] Clientes únicos: ${clientesUnicos.length}`);

    if (clientesUnicos.length === 1) {
      const cliente = clientesUnicos[0];
      const servicio = cliente.servicioReal;
      const estadoIcon = cliente.estado === 'ACTIVO' ? '🟢' : '🔴';
      const estadoTexto = cliente.estado === 'ACTIVO' ? 'CONECTADO' : cliente.estado;
      return res.json({
        mensaje: `📡 *Información de su servicio*\n\n👤 ${cliente.nombre.trim()}\n📋 Plan: *${servicio.perfil}*\n💰 Costo mensual: $${servicio.costo}/mes\n${estadoIcon} Estado: *${estadoTexto}*`
      });
    } else {
      let mensaje = `📡 *Sus servicios contratados*\n`;
      clientesUnicos.forEach((cliente, index) => {
        const servicio = cliente.servicioReal;
        const estadoIcon = cliente.estado === 'ACTIVO' ? '🟢' : '🔴';
        const estadoTexto = cliente.estado === 'ACTIVO' ? 'CONECTADO' : cliente.estado;
        mensaje += `\n${index + 1}. *${cliente.nombre.trim()}*\n   📋 ${servicio.perfil}\n   💰 $${servicio.costo}/mes\n   ${estadoIcon} ${estadoTexto}\n`;
      });
      return res.json({ mensaje });
    }
  } catch (err) {
    console.error('❌ [PLAN] Error:', err);
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
      if (r.exito && r.clientes?.length > 0) nombreCliente = capitalizarNombre(r.clientes[0].nombre);
    }
    res.json({ ticket, mensaje: `🔧 *Reporte registrado*\n\n📋 #${ticket}\n👤 ${nombreCliente}\n⚠️ ${problemas[problema] || descripcion}\n\n✅ Equipo técnico notificado.` });
  } catch (err) {
    res.status(500).json({ mensaje: '⚠️ Error del sistema.' });
  }
});

app.post('/soporte/cambio-clave', async (req, res) => {
  try {
    const { cedula, nueva_clave } = req.body;
    if (!nueva_clave || nueva_clave.length < 8) {
      return res.json({
        error: true, valida: false,
        mensaje: `⚠️ *Contraseña muy corta*\n\nDebe tener *mínimo 8 caracteres*.\n\n📝 Recomendaciones:\n• Mínimo 8 caracteres\n• Combina letras y números\n• Sin espacios\n\n🔄 Por favor, envía tu nueva contraseña:`
      });
    }
    const ticket = `CLV-${Date.now().toString().slice(-6)}`;
    let nombreCliente = 'Cliente';
    if (cedula) {
      const r = await buscarClientePorCedula(cedula);
      if (r.exito && r.clientes?.length > 0) nombreCliente = capitalizarNombre(r.clientes[0].nombre);
    }
    res.json({ ticket, error: false, valida: true, mensaje: `🔑 *Solicitud registrada*\n\n📋 #${ticket}\n👤 ${nombreCliente}\n🔐 Nueva clave: ${nueva_clave}\n\n✅ Se procesará en *2h hábiles*.` });
  } catch (err) {
    res.status(500).json({ mensaje: '⚠️ Error del sistema.' });
  }
});

app.get('/nuevo-cliente', (req, res) => res.json({ mensaje: `🌟 *¡Gracias por su interés!*\n\nUn asesor le contactará. 🌐` }));
app.get('/despedida', (req, res) => res.json({ mensaje: `👋 *¡Hasta pronto!*\n\nGracias por contactar a *FibraNet* 🌐` }));
app.post('/despedida', (req, res) => {
  const { telefono } = req.body;
  if (telefono) cerrarSesion(telefono);
  res.json({ mensaje: `👋 *¡Hasta pronto!*\n\nGracias por contactar a *FibraNet* 🌐` });
});

// ════════════════════════════════════════════════════════
// v7.0: DASHBOARD DE ADMINISTRACIÓN
// ════════════════════════════════════════════════════════

app.get('/admin/:token', async (req, res) => {
  if (req.params.token !== ADMIN_TOKEN) return res.status(403).send('<h1>Acceso denegado</h1>');

  const ahora = new Date();
  const [pendientes, verificados, rechazados, listaNegra] = await Promise.all([
    obtenerPagosPendientes(),
    obtenerPagosVerificados(),
    obtenerPagosRechazados(),
    contarListaNegra()
  ]);

  const html = `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Admin · FibraNet</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,sans-serif;background:#f1f5f9;color:#0f172a;min-height:100vh;padding:20px}
.container{max-width:1200px;margin:0 auto}
h1{font-size:28px;margin-bottom:24px}
h1 span{color:#3b82f6}
h2{margin-top:32px;margin-bottom:16px;font-size:20px}
.metricas{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px}
.metrica{background:#fff;border-radius:12px;padding:20px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,0.05)}
.metrica-numero{font-size:32px;font-weight:700}
.metrica-pendiente{color:#f59e0b}.metrica-verificado{color:#22c55e}.metrica-rechazado{color:#ef4444}.metrica-negra{color:#6b7280}
.metrica-label{font-size:12px;color:#64748b;margin-top:4px;text-transform:uppercase;font-weight:600}
.tarjeta{background:#fff;border-radius:12px;padding:20px;margin-bottom:12px;box-shadow:0 1px 3px rgba(0,0,0,0.05);border-left:4px solid #f59e0b}
.tarjeta.urgente{border-left-color:#ef4444;background:#fef2f2}
.tarjeta.verificada{border-left-color:#22c55e;background:#f0fdf4}
.tarjeta.rechazada{border-left-color:#ef4444;background:#fef2f2}
.tarjeta-titulo{font-size:18px;font-weight:600;margin-bottom:4px}
.tarjeta-info{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:16px;margin-top:12px}
.info-item{display:flex;flex-direction:column}
.info-label{font-size:11px;color:#64748b;text-transform:uppercase;font-weight:600}
.info-valor{font-size:14px;color:#0f172a;font-weight:500}
.botones{display:flex;gap:8px;flex-wrap:wrap}
.btn{padding:10px 20px;border-radius:8px;border:none;cursor:pointer;font-weight:600;font-size:14px;text-decoration:none;display:inline-block}
.btn-verificar{background:#22c55e;color:#fff}.btn-verificar:hover{background:#16a34a}
.btn-rechazar{background:#ef4444;color:#fff}.btn-rechazar:hover{background:#dc2626}
.vacio{background:#fff;border-radius:12px;padding:40px;text-align:center;color:#64748b}
.urgencia{display:inline-block;padding:4px 8px;border-radius:4px;font-size:11px;font-weight:600;margin-left:8px}
.urgencia.alta{background:#fee2e2;color:#dc2626}.urgencia.media{background:#fef3c7;color:#d97706}.urgencia.baja{background:#dbeafe;color:#2563eb}
.db-badge{background:#dcfce7;color:#16a34a;padding:8px 16px;border-radius:8px;font-size:13px;font-weight:600;margin-bottom:20px;display:inline-block}
.promesa-badge{background:#dbeafe;color:#2563eb;padding:3px 8px;border-radius:4px;font-size:11px;font-weight:600;margin-left:8px}
.toggle-historico{cursor:pointer;user-select:none;padding:12px;background:#fff;border-radius:8px;margin-bottom:12px;display:flex;justify-content:space-between;align-items:center}
.toggle-historico:hover{background:#f8fafc}
.historico-contenido{display:none}.historico-contenido.activo{display:block}
</style>
</head><body><div class="container">
<h1>📊 <span>FibraNet</span> · Panel de Verificación</h1>
<div class="db-badge">🗄️ PostgreSQL - Datos persistentes v7.0</div>

<div class="metricas">
<div class="metrica"><div class="metrica-numero metrica-pendiente">${pendientes.length}</div><div class="metrica-label">⏰ Pendientes</div></div>
<div class="metrica"><div class="metrica-numero metrica-verificado">${verificados.length}</div><div class="metrica-label">✅ Verificados</div></div>
<div class="metrica"><div class="metrica-numero metrica-rechazado">${rechazados.length}</div><div class="metrica-label">❌ Rechazados</div></div>
<div class="metrica"><div class="metrica-numero metrica-negra">${listaNegra}</div><div class="metrica-label">🚫 Lista Negra</div></div>
</div>

<h2>⏰ Pagos pendientes de verificación</h2>

${pendientes.length === 0 ? '<div class="vacio">🎉 No hay pagos pendientes</div>' : pendientes.map(p => {
  const fechaRecibido = new Date(p.fecha_recibido);
  const fechaLimite = new Date(p.fecha_limite);
  const diasRestantes = Math.floor((fechaLimite - ahora) / (24 * 60 * 60 * 1000));
  const esUrgente = diasRestantes <= 2;
  let urgenciaClass = 'baja', urgenciaTexto = `${diasRestantes} días`;
  if (diasRestantes <= 0) { urgenciaClass = 'alta'; urgenciaTexto = 'VENCIDO'; }
  else if (diasRestantes <= 2) { urgenciaClass = 'alta'; urgenciaTexto = `⚠️ ${diasRestantes}d`; }
  else if (diasRestantes <= 5) { urgenciaClass = 'media'; }
  const servicios = typeof p.servicios === 'string' ? JSON.parse(p.servicios) : p.servicios;
  const idfacturas = typeof p.idfacturas === 'string' ? JSON.parse(p.idfacturas) : (p.idfacturas || []);
  return `<div class="tarjeta ${esUrgente ? 'urgente' : ''}">
<div>
  <div class="tarjeta-titulo">${p.nombre} <span class="urgencia ${urgenciaClass}">${urgenciaTexto}</span>${idfacturas.length > 0 ? '<span class="promesa-badge">📝 Promesa en MikroWisp</span>' : ''}</div>
  <div style="font-size:12px;color:#64748b">📅 ${fechaRecibido.toLocaleString('es-EC', { timeZone: 'America/Guayaquil' })}</div>
</div>
<div class="tarjeta-info">
  <div class="info-item"><div class="info-label">🆔 Cédula</div><div class="info-valor">${p.cedula}</div></div>
  <div class="info-item"><div class="info-label">📞 WhatsApp</div><div class="info-valor">${p.telefono || 'N/A'}</div></div>
  <div class="info-item"><div class="info-label">💰 Deuda</div><div class="info-valor">$${parseFloat(p.deuda).toFixed(2)}</div></div>
  <div class="info-item"><div class="info-label">📋 Servicios</div><div class="info-valor">${servicios ? servicios.map(s => s.nombre).join(', ') : p.plan}</div></div>
</div>
<div class="botones">
  <button class="btn btn-verificar" onclick="verificar('${p.cedula}')">✅ Verificar</button>
  <button class="btn btn-rechazar" onclick="rechazar('${p.cedula}')">❌ Rechazar</button>
</div>
</div>`;
}).join('')}

<div style="margin-top:24px">
<h2>📜 Historial</h2>
<div class="toggle-historico" onclick="toggleHistorico('verificados')">
<span>✅ Pagos verificados (${verificados.length})</span><span id="icon-verificados">▼</span>
</div>
<div id="historico-verificados" class="historico-contenido">
${verificados.length === 0 ? '<div class="vacio">No hay registros</div>' : verificados.map(p => {
  const fr = new Date(p.fecha_recibido);
  const fv = new Date(p.fecha_verificado);
  return `<div class="tarjeta verificada">
<div class="tarjeta-titulo">${p.nombre}</div>
<div style="font-size:12px;color:#64748b;margin:4px 0">📅 Recibido: ${fr.toLocaleString('es-EC', { timeZone: 'America/Guayaquil' })}</div>
<div style="font-size:12px;color:#16a34a;margin-bottom:12px">✅ Verificado: ${fv.toLocaleString('es-EC', { timeZone: 'America/Guayaquil' })}</div>
<div class="tarjeta-info">
<div class="info-item"><div class="info-label">🆔 Cédula</div><div class="info-valor">${p.cedula}</div></div>
<div class="info-item"><div class="info-label">📞 Teléfono</div><div class="info-valor">${p.telefono || 'N/A'}</div></div>
<div class="info-item"><div class="info-label">💰 Deuda</div><div class="info-valor">$${parseFloat(p.deuda).toFixed(2)}</div></div>
</div></div>`;
}).join('')}
</div>

<div class="toggle-historico" onclick="toggleHistorico('rechazados')" style="margin-top:12px">
<span>❌ Pagos rechazados (${rechazados.length})</span><span id="icon-rechazados">▼</span>
</div>
<div id="historico-rechazados" class="historico-contenido">
${rechazados.length === 0 ? '<div class="vacio">No hay registros</div>' : rechazados.map(p => {
  const fr = new Date(p.fecha_recibido);
  const fre = new Date(p.fecha_rechazado);
  return `<div class="tarjeta rechazada">
<div class="tarjeta-titulo">${p.nombre}</div>
<div style="font-size:12px;color:#64748b;margin:4px 0">📅 Recibido: ${fr.toLocaleString('es-EC', { timeZone: 'America/Guayaquil' })}</div>
<div style="font-size:12px;color:#dc2626;margin-bottom:12px">❌ Rechazado: ${fre?.toLocaleString('es-EC', { timeZone: 'America/Guayaquil' }) || 'N/A'}</div>
<div class="tarjeta-info">
<div class="info-item"><div class="info-label">🆔 Cédula</div><div class="info-valor">${p.cedula}</div></div>
<div class="info-item"><div class="info-label">📞 Teléfono</div><div class="info-valor">${p.telefono || 'N/A'}</div></div>
<div class="info-item"><div class="info-label">💰 Deuda</div><div class="info-valor">$${parseFloat(p.deuda).toFixed(2)}</div></div>
</div></div>`;
}).join('')}
</div>
</div>
</div>

<script>
function toggleHistorico(tipo) {
  const c = document.getElementById('historico-' + tipo);
  const i = document.getElementById('icon-' + tipo);
  c.classList.toggle('activo');
  i.textContent = c.classList.contains('activo') ? '▲' : '▼';
}
async function verificar(cedula) {
  if (!confirm('¿Confirmar pago verificado?\\n\\nEsto pagará la factura en MikroWisp.')) return;
  const res = await fetch('/admin/${ADMIN_TOKEN}/verificar', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cedula })
  });
  const data = await res.json();
  alert(data.exito ? '✅ Verificado y factura pagada en MikroWisp' : '❌ Error: ' + data.error);
  if (data.exito) location.reload();
}
async function rechazar(cedula) {
  if (!confirm('⚠️ ¿RECHAZAR?\\n\\nEsto cortará el servicio y agregará a lista negra.')) return;
  const res = await fetch('/admin/${ADMIN_TOKEN}/rechazar', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cedula })
  });
  const data = await res.json();
  alert(data.exito ? '❌ Rechazado y servicio cortado' : '❌ Error: ' + data.error);
  if (data.exito) location.reload();
}
setTimeout(() => location.reload(), 30000);
</script>
</body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// ════════════════════════════════════════════════════════
// v7.0: VERIFICAR PAGO - PAGA FACTURA EN MIKROWISP
// ════════════════════════════════════════════════════════

app.post('/admin/:token/verificar', async (req, res) => {
  if (req.params.token !== ADMIN_TOKEN) return res.status(403).json({ error: 'Acceso denegado' });
  try {
    const { cedula } = req.body;
    const result = await pool.query(
      "SELECT * FROM pagos_pendientes WHERE cedula=$1 AND estado='PENDIENTE'", [cedula]
    );
    if (result.rows.length === 0) return res.json({ exito: false, error: 'No encontrado' });

    const pago = result.rows[0];
    const idfacturas = typeof pago.idfacturas === 'string' ? JSON.parse(pago.idfacturas) : (pago.idfacturas || []);

    // PAGAR FACTURAS EN MIKROWISP
    let facturasPagadas = 0;
    for (const factura of idfacturas) {
      const pagado = await pagarFacturaMikroWisp(factura.id, factura.monto || pago.deuda);
      if (pagado) {
        facturasPagadas++;
        console.log(`💳 [VERIFICAR] Factura ${factura.id} pagada en MikroWisp`);
      }
    }

    // Mover a verificados en PostgreSQL
    await pool.query(`
      INSERT INTO pagos_verificados (cedula, nombre, idcliente, telefono, plan, servicios, deuda, idfacturas, fecha_recibido, fecha_verificado)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
    `, [pago.cedula, pago.nombre, pago.idcliente, pago.telefono, pago.plan, pago.servicios, pago.deuda, pago.idfacturas, pago.fecha_recibido]);

    await pool.query("DELETE FROM pagos_pendientes WHERE cedula=$1 AND estado='PENDIENTE'", [cedula]);

    // Notificar cliente por WhatsApp
    if (pago.telefono) {
      try {
        await fetch(`${MERCATELY_API_URL}/whatsapp_messages`, {
          method: 'POST',
          headers: { 'Api-Key': MERCATELY_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            phone_number: pago.telefono,
            message: `✅ *Pago confirmado*\n\nEstimado(a) ${pago.nombre}, su pago ha sido verificado y registrado.\n\n¡Gracias por confiar en FibraNet! 🌐`
          })
        });
      } catch (e) { console.error('Error notificar:', e.message); }
    }

    console.log(`✅ [ADMIN] Verificado: ${cedula} | Facturas pagadas en MikroWisp: ${facturasPagadas}`);
    res.json({ exito: true, facturasPagadas });
  } catch (err) {
    console.error('❌ [ADMIN-VERIFICAR] Error:', err);
    res.status(500).json({ exito: false, error: err.message });
  }
});

app.post('/admin/:token/rechazar', async (req, res) => {
  if (req.params.token !== ADMIN_TOKEN) return res.status(403).json({ error: 'Acceso denegado' });
  try {
    const { cedula } = req.body;
    const result = await pool.query(
      "SELECT * FROM pagos_pendientes WHERE cedula=$1 AND estado='PENDIENTE'", [cedula]
    );
    if (result.rows.length === 0) return res.json({ exito: false, error: 'No encontrado' });

    const pago = result.rows[0];
    const servicios = typeof pago.servicios === 'string' ? JSON.parse(pago.servicios) : (pago.servicios || []);

    // Suspender servicios en MikroWisp
    if (servicios.length > 0) {
      for (const servicio of servicios) {
        await suspenderServicioMikroWisp(servicio.id, 'Pago rechazado - comprobante inválido');
      }
    } else {
      await suspenderServicioMikroWisp(pago.idcliente, 'Pago rechazado');
    }

    // Mover a rechazados
    await pool.query(`
      INSERT INTO pagos_rechazados (cedula, nombre, idcliente, telefono, plan, servicios, deuda, fecha_recibido, fecha_rechazado)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
    `, [pago.cedula, pago.nombre, pago.idcliente, pago.telefono, pago.plan, pago.servicios, pago.deuda, pago.fecha_recibido]);

    await pool.query("DELETE FROM pagos_pendientes WHERE cedula=$1 AND estado='PENDIENTE'", [cedula]);

    // Agregar a lista negra
    await pool.query(
      "INSERT INTO lista_negra (cedula, motivo) VALUES ($1,$2) ON CONFLICT (cedula) DO NOTHING",
      [cedula, 'Comprobante rechazado por contadora']
    );

    // Notificar cliente
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
    console.error('❌ [ADMIN-RECHAZAR] Error:', err);
    res.status(500).json({ exito: false, error: err.message });
  }
});

// ════════════════════════════════════════════════════════
// v7.0: CRON DE VENCIMIENTOS
// ════════════════════════════════════════════════════════

async function verificarVencimientos() {
  try {
    console.log(`⏰ [CRON] Verificando vencimientos...`);
    const ahora = new Date();
    const pendientes = await obtenerPagosPendientes();

    for (const pago of pendientes) {
      const fechaLimite = new Date(pago.fecha_limite);
      const diasRestantes = Math.floor((fechaLimite - ahora) / (24 * 60 * 60 * 1000));

      if (diasRestantes <= (DIAS_PROMESA - DIAS_AVISO_RECORDATORIO) && !pago.aviso_recordatorio_enviado) {
        await notificarContadora('⚠️ RECORDATORIO - FibraNet', `
RECORDATORIO: ${pago.nombre} (${pago.cedula})
Quedan ${diasRestantes} días para verificar
Dashboard: https://mindful-commitment-production.up.railway.app/admin/${ADMIN_TOKEN}
`);
        await pool.query(
          "UPDATE pagos_pendientes SET aviso_recordatorio_enviado=TRUE WHERE cedula=$1 AND estado='PENDIENTE'",
          [pago.cedula]
        );
      }

      if (diasRestantes <= 0) {
        console.log(`🔴 [CRON] Auto-corte: ${pago.cedula}`);
        const servicios = typeof pago.servicios === 'string' ? JSON.parse(pago.servicios) : (pago.servicios || []);

        if (servicios.length > 0) {
          for (const servicio of servicios) {
            await suspenderServicioMikroWisp(servicio.id, 'Auto-corte - promesa vencida');
          }
        } else {
          await suspenderServicioMikroWisp(pago.idcliente, 'Auto-corte');
        }

        await pool.query(`
          INSERT INTO pagos_rechazados (cedula, nombre, idcliente, telefono, plan, servicios, deuda, fecha_recibido, fecha_rechazado, estado)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),'AUTO_CORTADO')
        `, [pago.cedula, pago.nombre, pago.idcliente, pago.telefono, pago.plan, pago.servicios, pago.deuda, pago.fecha_recibido]);

        await pool.query("DELETE FROM pagos_pendientes WHERE cedula=$1 AND estado='PENDIENTE'", [pago.cedula]);

        if (pago.telefono) {
          try {
            await fetch(`${MERCATELY_API_URL}/whatsapp_messages`, {
              method: 'POST',
              headers: { 'Api-Key': MERCATELY_API_KEY, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                phone_number: pago.telefono,
                message: `⚠️ *Estimado cliente*\n\nSu pago no fue confirmado en el plazo establecido.\n\nContacte:\n\n📞 098 877 3995\n\n_FibraNet_`
              })
            });
          } catch (e) { console.error('Error notificar:', e.message); }
        }
      }
    }
    console.log(`⏰ [CRON] Completado`);
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

async function iniciar() {
  await inicializarDB();
  app.listen(PORT, () => {
    console.log(`🚀 FibraNet Webhook v7.2 (Fix error HTTP 400) en puerto ${PORT}`);
    console.log(`📊 Promesa de Pago: ${DIAS_PROMESA} días`);
    console.log(`🗄️ PostgreSQL: ${process.env.DATABASE_URL ? 'Configurado ✅' : 'SIN CONFIGURAR ❌'}`);
    console.log(`🕐 Sesiones: 10 minutos`);
    console.log(`📧 Contadora: ${CONTADORA_EMAIL}`);
  });
}

iniciar();
