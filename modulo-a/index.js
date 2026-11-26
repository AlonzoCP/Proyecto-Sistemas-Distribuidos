// =============================================================================
// Módulo A - API Gateway (Node.js / Express) - TechOrders U3
//
// Cambios respecto a la U2:
//   - Stateless: identifica su réplica con NODE_NAME/HOSTNAME y no guarda estado.
//   - Llama a B y C a través de los balanceadores internos (lb-int-1 / lb-int-2)
//     con timeouts estrictos y reintentos con exponential backoff + jitter,
//     alternando de balanceador en cada intento.
//   - Idempotencia: cada pedido lleva un request_id (Idempotency-Key del cliente,
//     X-Request-Id generado por el balanceador de entrada o un UUID nuevo). Los
//     reintentos reutilizan el mismo request_id, así nunca se duplica un pedido.
//   - Trazabilidad: la respuesta indica qué balanceador, gateway y réplicas de
//     B y C atendieron cada fase.
//   - GET /api/cluster-status: estado de todos los nodos para el Health Dashboard.
// =============================================================================
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const os = require('os');

const NODE = process.env.NODE_NAME || os.hostname();
const PORT = parseInt(process.env.PORT || '8080', 10);
const STARTED = Date.now();

const list = (v, def) => (v || def).split(',').map((s) => s.trim()).filter(Boolean);
// Balanceadores internos: cada uno expone :5000 (-> Módulo B) y :6000 (-> Módulo C)
const INTERNAL_LBS = list(process.env.INTERNAL_LBS, 'lb-int-1,lb-int-2');
const EDGE_LBS = list(process.env.EDGE_LBS, 'lb-1,lb-2');
const GATEWAY_NODES = list(process.env.GATEWAY_NODES, 'modulo-a-1:8080,modulo-a-2:8080');
const B_NODES = list(process.env.SERVICE_B_NODES, 'modulo-b-1:5000,modulo-b-2:5000');
const C_NODES = list(process.env.SERVICE_C_NODES, 'modulo-c-1:6000,modulo-c-2:6000');
const LB_STATS_PORT = process.env.LB_STATS_PORT || '8404';

const RETRY = {
  intentos: parseInt(process.env.RETRY_MAX_ATTEMPTS || '5', 10),
  timeoutMs: parseInt(process.env.RETRY_TIMEOUT_MS || '3000', 10),
  baseMs: parseInt(process.env.RETRY_BASE_MS || '200', 10),
  maxMs: parseInt(process.env.RETRY_MAX_BACKOFF_MS || '2000', 10),
};

const PORTS = { dominio: 5000, auditoria: 6000 };
const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const http = axios.create({ validateStatus: () => true });

function toUUID(v) {
  if (!v || !UUID_RE.test(v)) return null;
  const h = v.replace(/-/g, '').toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Llama a un servicio interno a través de los balanceadores internos con
 * reintentos y exponential backoff. Reintenta ante errores de red, timeouts y
 * respuestas 502/503/504. No reintenta errores 4xx (son errores del cliente).
 */
async function callService(servicio, method, path, data) {
  const start = Math.floor(Math.random() * INTERNAL_LBS.length);
  const historial = [];
  let ultimoError = null;
  for (let i = 0; i < RETRY.intentos; i++) {
    const lb = INTERNAL_LBS[(start + i) % INTERNAL_LBS.length];
    const url = `http://${lb}:${PORTS[servicio]}${path}`;
    const t0 = Date.now();
    try {
      const res = await http.request({ method, url, data, timeout: RETRY.timeoutMs });
      historial.push({ intento: i + 1, lb, status: res.status, ms: Date.now() - t0 });
      if (![502, 503, 504].includes(res.status)) {
        return { res, lb, intentos: i + 1, historial };
      }
      ultimoError = new Error(`HTTP ${res.status} desde ${servicio}`);
    } catch (err) {
      historial.push({ intento: i + 1, lb, error: err.code || err.message, ms: Date.now() - t0 });
      ultimoError = err;
    }
    if (i < RETRY.intentos - 1) {
      const backoff = Math.min(RETRY.baseMs * 2 ** i, RETRY.maxMs);
      const espera = backoff / 2 + Math.random() * (backoff / 2); // jitter
      console.warn(`[${NODE}] ${servicio} ${method} ${path} falló (intento ${i + 1}/${RETRY.intentos}): ${ultimoError.message}. Reintento en ${Math.round(espera)}ms`);
      await sleep(espera);
    }
  }
  const e = new Error(`${servicio} no disponible tras ${RETRY.intentos} intentos: ${ultimoError && ultimoError.message}`);
  e.historial = historial;
  throw e;
}

// ----------------------------------------------------------------------------- app

const app = express();
app.use(express.json({ limit: '100kb' }));

// Trazabilidad y CORS (el SPA puede usar el balanceador de respaldo :8081 si cae el principal)
app.use((req, res, next) => {
  res.set('X-Served-By', NODE);
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Idempotency-Key');
  res.set('Access-Control-Expose-Headers', 'X-Served-By, X-LB-Node, X-Request-Id');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.static('public'));

app.get('/health', (req, res) => {
  res.json({ modulo: 'modulo-a-gateway', status: 'UP', nodo: NODE,
    uptime_seg: Math.round((Date.now() - STARTED) / 1000), timestamp: new Date().toISOString() });
});

// ----------------------------------------------------------------------------- POST /api/pedidos

app.post('/api/pedidos', async (req, res) => {
  const t0 = Date.now();
  const { cliente, producto, precio, pago, lote } = req.body || {};
  if (!cliente || !producto || !Number.isInteger(precio) || precio <= 0 || !pago) {
    return res.status(400).json({ status: 'ERROR', error_code: 'INVALID_PAYLOAD',
      mensaje: "Los campos 'cliente', 'producto', 'precio' (entero > 0) y 'pago' son requeridos" });
  }
  // request_id estable entre reintentos: cliente > balanceador de entrada > nuevo
  const requestId = toUUID(req.get('Idempotency-Key')) || toUUID(req.body.request_id)
    || toUUID(req.get('X-Request-Id')) || crypto.randomUUID();
  res.set('X-Request-Id', requestId);
  const timestamp = new Date().toISOString();
  const traza = {
    balanceador_entrada: req.get('X-LB-Node') || null,
    gateway: NODE,
  };

  // Fase 1: Auditoría (Módulo C)
  let aud;
  try {
    aud = await callService('auditoria', 'post', '/logs', {
      request_id: requestId, evento: 'SOLICITUD_ENTRANTE', origen: 'modulo_a_gateway',
      nodo_gateway: NODE, cliente, producto, precio, pago, lote: lote || '', timestamp,
    });
    if (aud.res.status !== 200 || aud.res.data.status !== 'Guardado') throw new Error(`Respuesta inesperada de auditoría (${aud.res.status})`);
    traza.auditoria = { balanceador_interno: aud.lb, nodo: aud.res.data.nodo,
      nodo_persistencia: aud.res.data.nodo_auditoria, intentos: aud.intentos };
  } catch (err) {
    console.warn(`[${NODE}] Fase auditoría falló: ${err.message}`);
    return res.status(502).json({ status: 'ERROR', fase: 'AUDITORIA', request_id: requestId,
      mensaje: 'No se pudo registrar la auditoría del pedido', detalle: err.message,
      intentos: err.historial, trazabilidad: traza, latencia_ms: Date.now() - t0 });
  }

  // Fase 2: Procesamiento de negocio (Módulo B)
  let dom;
  try {
    dom = await callService('dominio', 'post', '/procesar-pedido', {
      request_id: requestId, cliente, producto, precio, pago, timestamp,
      lote: lote || null, nodo_gateway: NODE,
    });
    if (dom.res.status !== 200) throw new Error(`Respuesta inesperada de dominio (${dom.res.status}): ${JSON.stringify(dom.res.data).slice(0, 200)}`);
    traza.dominio = { balanceador_interno: dom.lb, nodo: dom.res.data.nodo,
      nodo_persistencia: dom.res.data.nodo_dominio, intentos: dom.intentos, duplicado: dom.res.data.duplicado };
  } catch (err) {
    console.warn(`[${NODE}] Fase dominio falló: ${err.message}`);
    return res.status(502).json({ status: 'ERROR', fase: 'DOMINIO', request_id: requestId,
      mensaje: 'No se pudo registrar el pedido en el servicio de dominio', detalle: err.message,
      intentos: err.historial, trazabilidad: traza, latencia_ms: Date.now() - t0 });
  }

  const d = dom.res.data;
  return res.status(200).json({
    status: 'PROCESADO',
    mensaje: 'Pedido recibido, auditado y registrado correctamente',
    request_id: requestId,
    data: { pedido_id: d.pedido_id, cliente, producto, precio, pago, lote: lote || null, fecha_creacion: d.timestamp },
    auditoria: { log_key: aud.res.data.log_id, estado: 'Auditado' },
    trazabilidad: traza,
    latencia_ms: Date.now() - t0,
  });
});

// ----------------------------------------------------------------------------- lecturas

app.get('/api/pedidos', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 500);
  try {
    const r = await callService('dominio', 'get', `/pedidos?limit=${limit}`);
    res.set('X-Dominio-Node', r.res.headers['x-node'] || '');
    return res.status(r.res.status).json(r.res.data);
  } catch (err) {
    return res.status(502).json({ status: 'ERROR', mensaje: 'No se pudo obtener la lista de pedidos', detalle: err.message });
  }
});

app.get('/api/auditoria', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 500);
  const evento = req.query.evento ? `&evento=${encodeURIComponent(req.query.evento)}` : '';
  try {
    const r = await callService('auditoria', 'get', `/logs?limit=${limit}${evento}`);
    return res.status(r.res.status).json(r.res.data);
  } catch (err) {
    return res.status(502).json({ status: 'ERROR', mensaje: 'No se pudo obtener los logs de auditoría', detalle: err.message });
  }
});

// Verificación de integridad de una prueba: pedidos en PostgreSQL vs trazas en Redis
app.get('/api/integridad', async (req, res) => {
  const lote = req.query.lote;
  if (!lote) return res.status(400).json({ status: 'ERROR', mensaje: 'parámetro lote requerido' });
  try {
    const q = encodeURIComponent(lote);
    const [b, c] = await Promise.all([
      callService('dominio', 'get', `/pedidos/stats?lote=${q}`),
      callService('auditoria', 'get', `/logs/stats?lote=${q}`),
    ]);
    const pedidos = b.res.data.total_pedidos;
    const trazas = c.res.data.total_trazas;
    return res.json({
      lote, pedidos_postgresql: pedidos, trazas_redis: trazas,
      trazas_sin_pedido: trazas - pedidos, // solicitudes auditadas cuyo registro en B falló
      distribucion: {
        dominio: b.res.data.por_nodo_dominio, auditoria: c.res.data.por_nodo_auditoria,
        gateway: b.res.data.por_nodo_gateway, particiones_postgresql: b.res.data.por_particion,
      },
    });
  } catch (err) {
    return res.status(502).json({ status: 'ERROR', mensaje: err.message });
  }
});

// ----------------------------------------------------------------------------- GET /api/cluster-status

async function probe(nombre, url, timeout = 1500) {
  const t0 = Date.now();
  try {
    const r = await http.get(url, { timeout });
    return { nombre, estado: r.status === 200 ? 'UP' : 'DOWN', http: r.status,
      latencia_ms: Date.now() - t0, detalle: typeof r.data === 'object' ? r.data : undefined };
  } catch (err) {
    return { nombre, estado: 'DOWN', error: err.code || err.message, latencia_ms: Date.now() - t0 };
  }
}

// Lee la vista del balanceador (página de estadísticas CSV de HAProxy):
// qué servidores de cada backend considera UP o DOWN según sus health checks.
async function lbView(lb) {
  try {
    const r = await http.get(`http://${lb}:${LB_STATS_PORT}/stats;csv`, { timeout: 1500 });
    if (r.status !== 200) return null;
    const lines = String(r.data).trim().split('\n');
    const header = lines[0].replace(/^# /, '').split(',');
    const idx = (k) => header.indexOf(k);
    const out = {};
    for (const line of lines.slice(1)) {
      const f = line.split(',');
      const px = f[idx('pxname')]; const sv = f[idx('svname')];
      if (sv === 'FRONTEND' || sv === 'BACKEND' || px === 'stats') continue;
      (out[px] = out[px] || []).push({ servidor: sv, estado: f[idx('status')],
        peticiones: Number(f[idx('stot')]) || 0, chequeo: f[idx('check_status')] });
    }
    return out;
  } catch {
    return null;
  }
}

app.get('/api/cluster-status', async (req, res) => {
  const t0 = Date.now();
  const [edge, gws, ints, bs, cs, db, redis] = await Promise.all([
    Promise.all(EDGE_LBS.map(async (h) => ({ ...(await probe(h, `http://${h}:${LB_STATS_PORT}/lb-health`)), vista: await lbView(h) }))),
    Promise.all(GATEWAY_NODES.map((h) => (h.startsWith(NODE + ':')
      ? { nombre: h.split(':')[0], estado: 'UP', latencia_ms: 0, este_nodo: true }
      : probe(h.split(':')[0], `http://${h}/health`)))),
    Promise.all(INTERNAL_LBS.map(async (h) => ({ ...(await probe(h, `http://${h}:${LB_STATS_PORT}/lb-health`)), vista: await lbView(h) }))),
    Promise.all(B_NODES.map((h) => probe(h.split(':')[0], `http://${h}/health`))),
    Promise.all(C_NODES.map((h) => probe(h.split(':')[0], `http://${h}/health`))),
    callService('dominio', 'get', '/cluster/db').then((r) => r.res.data).catch((e) => ({ estado: 'DOWN', error: e.message })),
    callService('auditoria', 'get', '/cluster/redis').then((r) => r.res.data).catch((e) => ({ estado: 'DOWN', error: e.message })),
  ]);

  const capa = (arr) => ({ activos: arr.filter((n) => n.estado === 'UP').length, total: arr.length, nodos: arr });
  const eventos = [
    ...((db && db.eventos) || []).map((e) => ({ ...e, componente: 'postgresql' })),
    ...((redis && redis.eventos) || []),
  ].sort((a, b) => new Date(b.ocurrido_en) - new Date(a.ocurrido_en)); // fechas con distinta zona horaria

  res.json({
    timestamp: new Date().toISOString(),
    consultado_por: NODE,
    latencia_ms: Date.now() - t0,
    balanceadores_entrada: capa(edge),
    gateways: capa(gws),
    balanceadores_internos: capa(ints),
    dominio: capa(bs),
    auditoria: capa(cs),
    postgresql: db,
    redis,
    eventos_failover: eventos,
  });
});

app.listen(PORT, process.env.BIND_ADDR || '0.0.0.0', () => {
  console.log(`API Gateway (Módulo A) [${NODE}] escuchando en puerto ${PORT}; LBs internos: ${INTERNAL_LBS.join(', ')}`);
});
