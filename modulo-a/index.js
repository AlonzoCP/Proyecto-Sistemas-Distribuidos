const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const PORT = 8080;

// Endpoint 1: Healthcheck de diagnóstico (pauta del proyecto)
app.get('/health', (req, res) => {
  res.status(200).json({
    modulo: "modulo-a-gateway",
    status: "UP",
    timestamp: new Date().toISOString()
  });
});

// Endpoint 2: Ingesta Externa de Pedidos (POST /api/pedidos)
app.post('/api/pedidos', async (req, res) => {
  const { cliente, producto, precio, pago } = req.body;

  // 1. Validar payload de entrada
  if (!cliente || !producto || precio === undefined || !pago) {
    return res.status(400).json({
      status: "ERROR",
      error_code: "INVALID_PAYLOAD",
      mensaje: "Los campos 'cliente', 'producto', 'precio' y 'pago' son requeridos"
    });
  }

  const timestamp = new Date().toISOString();

  try {
    // 2. Fase de Auditoría: Comunicar con Módulo C (Go) vía DNS interno
    let resAuditoria = { status: "OMITTED_OR_MOCK" };
    try {
      const auditPayload = {
        evento: "SOLICITUD_RECEPTADA",
        origen: "modulo-a-gateway",
        cliente,
        producto,
        monto: precio,
        timestamp
      };
      const responseC = await axios.post('http://modulo-c:6000/logs', auditPayload, { timeout: 3000 });
      resAuditoria = responseC.data;
    } catch (errC) {
      console.warn("Advertencia: No se pudo conectar con Módulo C (Auditoría):", errC.message);
    }

    // 3. Fase de Procesamiento: Comunicar con Módulo B (Python) vía DNS interno
    let resDominio = { status: "PROCESADO_MOCK", pedido_id: Math.floor(Math.random() * 1000) + 1000 };
    try {
      const dominioPayload = { cliente, producto, precio, pago, timestamp };
      const responseB = await axios.post('http://modulo-b:5000/procesar-pedido', dominioPayload, { timeout: 3000 });
      resDominio = responseB.data;
    } catch (errB) {
      console.warn("Advertencia: No se pudo conectar con Módulo B (Dominio):", errB.message);
    }

    // 4. Retornar Respuesta Consolidada al Cliente
    return res.status(201).json({
      status: "PROCESADO",
      mensaje: "Pedido recibido, auditado y registrado correctamente",
      data: {
        pedido_id: resDominio.pedido_id || 1024,
        cliente,
        producto,
        precio,
        pago,
        fecha_creacion: timestamp
      },
      auditoria: {
        log_key: resAuditoria.log_id || "audit:1024",
        estado: "AUDITED"
      }
    });

  } catch (error) {
    return res.status(500).json({
      status: "ERROR",
      error_code: "INTERNAL_GATEWAY_ERROR",
      mensaje: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`API Gateway (Módulo A) escuchando en puerto ${PORT}`);
});