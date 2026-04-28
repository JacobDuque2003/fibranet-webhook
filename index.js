const express = require('express');
const app = express();
app.use(express.json());

const MIKROWISP_URL = 'https://zamora.fibranet.ec';
const MIKROWISP_TOKEN = 'NkUrWHkwd1NKZ1hMUlBrMjc1K0pNUT09';

// Ruta de prueba
app.get('/', (req, res) => {
  res.json({ estado: 'FibraNet Webhook activo ✅', version: '1.0' });
});

// Webhook principal - recibe eventos de Mercately
app.post('/webhook/mercately', async (req, res) => {
  try {
    const body = req.body;
    console.log('Evento recibido:', JSON.stringify(body));
    res.json({ estado: 'recibido' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Buscar cliente por cédula
app.post('/cliente/buscar', async (req, res) => {
  try {
    const { cedula } = req.body;
    const response = await fetch(`${MIKROWISP_URL}/api/v1/GetClientsDetails`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: MIKROWISP_TOKEN, cedula })
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Obtener facturas pendientes
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

// Pagar factura y activar cliente
app.post('/cliente/pagar', async (req, res) => {
  try {
    const { idfactura, cantidad, idtransaccion } = req.body;
    const response = await fetch(`${MIKROWISP_URL}/api/v1/PaidInvoice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: MIKROWISP_TOKEN,
        idfactura,
        pasarela: 'WhatsApp-Transferencia',
        cantidad,
        idtransaccion,
        fechalimite: new Date().toISOString().slice(0, 19).replace('T', ' ')
      })
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
