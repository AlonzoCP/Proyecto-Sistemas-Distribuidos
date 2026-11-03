const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(express.static('public')); // Servir archivos estáticos desde la carpeta 'public'

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
  if (!cliente || !producto || !Number.isInteger(precio) || precio <= 0 || !pago) {
    return res.status(400).json({
      status: "ERROR",
      error_code: "INVALID_PAYLOAD",
      mensaje: "Los campos 'cliente', 'producto', 'precio' y 'pago' son requeridos"
    });
  }

  const timestamp = new Date().toISOString();

  try {
    // 2. Fase de Auditoría: Comunicar con Módulo C (Go) vía DNS interno
    try {
      const auditPayload = {
        evento: "SOLICITUD_ENTRANTE",
        origen: "modulo_a_gateway",
        cliente,
        producto,
        precio,
        timestamp
      };
      const responseC = await axios.post('http://modulo-c:6000/logs', auditPayload, { timeout: 3000 });
      const resAuditoria = responseC.data;

      // La auditoría es parte de la transacción: no continuar si no fue persistida.
      if (responseC.status < 200 || responseC.status >= 300 || resAuditoria.status !== "Guardado") {
        return res.status(502).json({
          status: "ERROR",
          mensaje: "No se pudo registrar la auditoría del pedido"
        });
      }

      // 3. Fase de Procesamiento: Comunicar con Módulo B (Python) vía DNS interno
      try {
        const dominioPayload = { cliente, producto, precio, pago, timestamp };
        const responseB = await axios.post('http://modulo-b:5000/procesar-pedido', dominioPayload, { timeout: 3000 });
        const resDominio = responseB.data;

        return res.status(200).json({
          status: "PROCESADO",
          mensaje: "Pedido recibido, auditado y registrado correctamente",
          data: {
            pedido_id: resDominio.pedido_id,
            cliente,
            producto,
            precio,
            pago,
            fecha_creacion: timestamp
          },
          auditoria: {
            log_key: resAuditoria.log_id,
            estado: "Auditado"
          },
          "auditoría": {
            log_key: resAuditoria.log_id,
            estado: "Auditado"
          }
        });
      } catch (errB) {
        console.warn("Advertencia: No se pudo registrar el pedido en Módulo B (Dominio):", errB.message);
        return res.status(502).json({
          status: "ERROR",
          mensaje: "No se pudo registrar el pedido en el servicio de dominio"
        });
      }
    } catch (errC) {
      console.warn("Advertencia: No se pudo conectar con Módulo C (Auditoría):", errC.message);
      return res.status(502).json({
        status: "ERROR",
        mensaje: "No se pudo registrar la auditoría del pedido"
      });
    }

  } catch (error) {
    return res.status(500).json({
      status: "ERROR",
      error_code: "INTERNAL_GATEWAY_ERROR",
      mensaje: error.message
    });
  }
});

// Obtener todos los pedidos desde el Módulo B
app.get('/api/pedidos', async (req, res) => {
  try {
    const responseB = await axios.get('http://modulo-b:5000/pedidos', { timeout: 3000 });
    return res.status(200).json(responseB.data);
  } catch (err) {
    return res.status(502).json({ status: "ERROR", mensaje: "No se pudo obtener la lista de pedidos" });
  }
});

// Obtener todas las trazas de auditoría desde el Módulo C
app.get('/api/auditoria', async (req, res) => {
  try {
    const responseC = await axios.get('http://modulo-c:6000/logs', { timeout: 3000 });
    return res.status(200).json(responseC.data);
  } catch (err) {
    return res.status(502).json({ status: "ERROR", mensaje: "No se pudo obtener los logs de auditoría" });
  }
});

app.listen(PORT, () => {
  console.log(`API Gateway (Módulo A) escuchando en puerto ${PORT}`);
});