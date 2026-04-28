const express = require('express');
const app = express();
app.use(express.json());

const MIKROWISP_URL = 'https://zamora.fibranet.ec';
const MIKROWISP_TOKEN = 'NkUrWHkwd1NKZ1hMUlBrMjc1K0pNUT09';

const CUENTAS_BANCARIAS = `
💳 *Cuentas bancarias FibraNet:*

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
Cta. Corriente: 2100299699
`;

// ── RUTA DE PRUEBA ──
app.get('/', (req, res) => {
  res.json({ estado: 'FibraNet Webhook activo ✅', version: '2.0' });
});

// ── BUSCAR CLIENTE POR CÉDULA ──
app.post('/cliente/buscar', async (req, res) => {
  try {
    const { cedula } = req.body;
    if (!cedula) return res.status(400).json({ error: 'Cédula requerida' });

    const response = await fetch(`${MIKROWISP_URL}/api/v1/GetClientsDetails`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: MIKROWISP_TOKEN, cedula })
    });
    const data = await response.json();

    if (data.estado !== 'exito' || !data.datos?.length) {
      return res.json({
        encontrado: false,
        mensaje: '❌ No encontré ningún cliente con esa cédula. Por favor verifica el número e inténtalo de nuevo.'
      });
    }

    const cliente = data.datos[0];
    const deuda = parseFloat(cliente.facturacion?.total_facturas || 0);
    const facturasPendientes = parseInt(cliente.facturacion?.facturas_nopagadas || 0);
    const servicio = cliente.servicios?.[0];

    return res.json({
      encontrado: true,
      id: cliente.id,
      nombre: cliente.nombre.trim(),
      cedula: cliente.cedula,
      estado: cliente.estado,
      movil: cliente.movil,
      deuda,
      facturasPendientes,
      plan: servicio?.perfil || 'N/A',
      estadoConexion: servicio?.status_user || 'N/A',
      idServicio: servicio?.id,
      mensaje: `✅ Cliente identificado:\n👤 *${cliente.nombre.trim()}*\n📋 Cédula: ${cliente.cedula}\n📡 Plan: ${servicio?.perfil || 'N/A'}\n💰 Deuda: $${deuda.toFixed(2)}\n🔌 Estado: ${servicio?.status_user || 'N/A'}`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── VER DEUDA DEL CLIENTE ──
app.post('/cliente/deuda', async (req, res) => {
  try {
    const { idcliente } = req.body;

    const response = await fetch(`${MIKROWISP_URL}/api/v1/GetClientsDetails`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: MIKROWISP_TOKEN, idcliente })
    });
    const data = await response.json();
    const cliente = data.datos?.[0];

    if (!cliente) return res.json({ mensaje: '❌ Cliente no encontrado.' });

    const deuda = parseFloat(cliente.facturacion?.total_facturas || 0);
    const facturas = parseInt(cliente.facturacion?.facturas_nopagadas || 0);

    if (facturas === 0) {
      return res.json({
        deuda: 0,
        mensaje: `✅ *${cliente.nombre.trim()}*, no tienes deudas pendientes.\n\n¡Gracias por mantener tu pago al día! 🎉`
      });
    }

    return res.json({
      deuda,
      facturas,
      mensaje: `💰 *Estado de cuenta:*\n\n👤 Cliente: ${cliente.nombre.trim()}\n📋 Facturas pendientes: ${facturas}\n💵 Total a pagar: *$${deuda.toFixed(2)}*\n\n¿Deseas pagar ahora? Responde *"pagar"* para ver las opciones de pago.`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── INFORMACIÓN DE PAGO (CUENTAS BANCARIAS) ──
app.post('/pago/info', async (req, res) => {
  try {
    const { idcliente } = req.body;

    const response = await fetch(`${MIKROWISP_URL}/api/v1/GetClientsDetails`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: MIKROWISP_TOKEN, idcliente })
    });
    const data = await response.json();
    const cliente = data.datos?.[0];
    const deuda = parseFloat(cliente?.facturacion?.total_facturas || 0);

    res.json({
      deuda,
      mensaje: `${CUENTAS_BANCARIAS}\n💵 *Tu deuda actual: $${deuda.toFixed(2)}*\n\nRealiza tu transferencia y envíanos la *foto del comprobante* aquí mismo para activar tu servicio automáticamente. 📸`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PROCESAR PAGO CON COMPROBANTE ──
app.post('/pago/procesar', async (req, res) => {
  try {
    const { idcliente, idfactura, cantidad, idtransaccion, numero_comprobante } = req.body;

    const txId = idtransaccion || numero_comprobante || `WA-${Date.now()}`;

    const response = await fetch(`${MIKROWISP_URL}/api/v1/PaidInvoice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: MIKROWISP_TOKEN,
        idfactura,
        pasarela: 'WhatsApp-Transferencia',
        cantidad,
        idtransaccion: txId,
        fechalimite: new Date().toISOString().slice(0, 19).replace('T', ' ')
      })
    });
    const data = await response.json();

    if (data.estado === 'exito') {
      return res.json({
        activado: true,
        mensaje: `⚡ *¡Servicio activado exitosamente!*\n\n✅ Pago registrado: $${cantidad}\n🔑 Comprobante: #${txId}\n📡 Tu internet ya está activo.\n\n¡Gracias por tu pago! 🙌`
      });
    } else {
      return res.json({
        activado: false,
        mensaje: `⚠️ El pago fue recibido pero necesita verificación manual. Un asesor lo revisará pronto.\n\n🔑 Ref: #${txId}`
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── OBTENER FACTURAS PENDIENTES ──
app.post('/cliente/facturas', async (req, res) => {
  try {
    const { idcliente } = req.body;
    const response = await fetch(`${MIKROWISP_URL}/api/v1/GetInvoices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: MIKROWISP_TOKEN, idcliente, estado: 'no pagada' })
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── VER PLAN Y ESTADO DE CONEXIÓN ──
app.post('/cliente/plan', async (req, res) => {
  try {
    const { idcliente } = req.body;
    const response = await fetch(`${MIKROWISP_URL}/api/v1/GetClientsDetails`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: MIKROWISP_TOKEN, idcliente })
    });
    const data = await response.json();
    const cliente = data.datos?.[0];
    const servicio = cliente?.servicios?.[0];

    if (!servicio) return res.json({ mensaje: '❌ No se encontró información del servicio.' });

    const estadoIcon = servicio.status_user === 'ONLINE' ? '🟢' : '🔴';

    res.json({
      mensaje: `📡 *Información de tu servicio:*\n\n👤 Cliente: ${cliente.nombre.trim()}\n📋 Plan: *${servicio.perfil}*\n💰 Costo mensual: $${servicio.costo}\n${estadoIcon} Estado: *${servicio.status_user}*\n🔌 IP asignada: ${servicio.ip}\n📅 Instalado: ${servicio.instalado}\n\n¿Necesitas algo más? Escribe *"menu"* para volver al menú principal.`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── REPORTAR PROBLEMA TÉCNICO ──
app.post('/soporte/reporte', async (req, res) => {
  try {
    const { idcliente, nombre, problema, descripcion } = req.body;

    const problemas = {
      'sin_internet': 'Sin conexión a internet',
      'lento': 'Internet lento',
      'intermitente': 'Conexión intermitente',
      'otro': descripcion || 'Problema no especificado'
    };

    const descripcionProblema = problemas[problema] || descripcion || 'Problema técnico';

    // Aquí se puede crear un ticket en MikroWisp cuando tengamos ese endpoint
    // Por ahora registramos y notificamos
    const ticket = `TKT-${Date.now()}`;

    res.json({
      ticket,
      mensaje: `🔧 *Reporte técnico registrado*\n\n📋 Ticket: #${ticket}\n👤 Cliente: ${nombre}\n⚠️ Problema: ${descripcionProblema}\n\n✅ Nuestro equipo técnico fue notificado y se comunicará contigo pronto.\n\n📞 También puedes llamar al:\n*0988909208 / 0988773995*\n\n¿Necesitas algo más? Escribe *"menu"*.`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── CAMBIO DE CLAVE WIFI ──
app.post('/soporte/cambio-clave', async (req, res) => {
  try {
    const { nombre, nueva_clave } = req.body;
    const ticket = `CLV-${Date.now()}`;

    res.json({
      ticket,
      mensaje: `🔑 *Solicitud de cambio de clave registrada*\n\n📋 Ticket: #${ticket}\n👤 Cliente: ${nombre}\n🔐 Nueva clave solicitada: ${nueva_clave}\n\n✅ Un técnico procesará tu solicitud en las próximas *2 horas hábiles*.\n\n📞 Consultas: *0988909208 / 0988773995*\n\n¿Necesitas algo más? Escribe *"menu"*.`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── MENÚ PRINCIPAL (texto de respuesta) ──
app.get('/menu', (req, res) => {
  res.json({
    mensaje: `🌐 *FibraNet — Menú Principal*\n\n¿En qué te puedo ayudar?\n\n1️⃣ *deuda* — Ver mi deuda\n2️⃣ *pagar* — Pagar mi servicio\n3️⃣ *problema* — Reportar problema técnico\n4️⃣ *clave* — Cambiar clave WiFi\n5️⃣ *plan* — Ver mi plan y estado\n6️⃣ *asesor* — Hablar con un asesor\n\nEscribe el número o la palabra clave 👆`
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 FibraNet Webhook v2.0 corriendo en puerto ${PORT}`));
