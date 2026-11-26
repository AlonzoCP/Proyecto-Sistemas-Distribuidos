// =============================================================================
// Utilidades compartidas por los escenarios k6 de TechOrders U3
// =============================================================================
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

export const BASES = (__ENV.BASE_URLS || 'http://lb-1:8080,http://lb-2:8080').split(',').map((s) => s.trim());
export const LOTE = __ENV.LOTE || `k6-${Date.now()}`;
const HEADERS = { 'Content-Type': 'application/json' };

// Métricas propias
export const pedidosConfirmados = new Counter('pedidos_confirmados');   // 200 recibido por el cliente
export const pedidosFallidos = new Counter('pedidos_fallidos');
export const errores5xx = new Rate('errores_5xx');                      // 5xx o sin respuesta
export const latPedido = new Trend('latencia_pedido', true);
export const latLectura = new Trend('latencia_lectura', true);
export const reintentosInternos = new Counter('reintentos_internos');   // reintentos del Gateway hacia B/C

const CLIENTES = ['Camila Rojas', 'María Vidal', 'Andrés Castillo', 'Franco Inzunza', 'Esteban Padilla'];
const PRODUCTOS = [['SSD NVMe 1TB', 64990], ['Monitor 24 IPS', 149900], ['Audifonos Studio', 45990], ['Mouse Inalambrico', 19990]];

function base() {
  // Reparte el tráfico entre los dos balanceadores de entrada
  return BASES[(__VU + __ITER) % BASES.length];
}

export function crearPedido() {
  const [producto, precio] = PRODUCTOS[__ITER % PRODUCTOS.length];
  const body = JSON.stringify({
    cliente: CLIENTES[__VU % CLIENTES.length], producto, precio,
    pago: __ITER % 2 ? 'Credito' : 'Debito', lote: LOTE,
  });
  const res = http.post(`${base()}/api/pedidos`, body, {
    headers: HEADERS, timeout: '30s', tags: { name: 'POST /api/pedidos' },
  });
  const ok = res.status === 200;
  latPedido.add(res.timings.duration);
  errores5xx.add(res.status === 0 || res.status >= 500);
  if (ok) {
    pedidosConfirmados.add(1);
    try {
      const t = res.json('trazabilidad') || {};
      const extra = ((t.dominio && t.dominio.intentos) || 1) - 1 + ((t.auditoria && t.auditoria.intentos) || 1) - 1;
      if (extra > 0) reintentosInternos.add(extra);
    } catch (e) { /* respuesta no JSON */ }
  } else {
    pedidosFallidos.add(1);
  }
  check(res, { 'pedido confirmado (200)': () => ok });
  return res;
}

export function leer(path, nombre) {
  const res = http.get(`${base()}${path}`, { timeout: '15s', tags: { name: nombre } });
  latLectura.add(res.timings.duration);
  errores5xx.add(res.status === 0 || res.status >= 500);
  check(res, { [`${nombre} 200`]: (r) => r.status === 200 });
  return res;
}

// Al final de la prueba: compara lo confirmado al cliente con lo persistido
export function verificarIntegridad() {
  const res = http.get(`${BASES[0]}/api/integridad?lote=${encodeURIComponent(LOTE)}`, { timeout: '60s' });
  console.log(`[integridad] lote=${LOTE} -> ${res.status} ${res.body}`);
}

function fmt(v) { return v === undefined ? '-' : (Math.round(v * 100) / 100).toString(); }

// Resumen propio (sin dependencias remotas): JSON completo en /resultados + texto en consola
export function resumen(nombre) {
  return function handleSummary(data) {
    const m = data.metrics;
    const val = (k, f) => (m[k] && m[k].values ? m[k].values[f] : undefined);
    const lineas = [
      '', `================ RESUMEN ${nombre} (lote ${LOTE}) ================`,
      `Pedidos confirmados : ${fmt(val('pedidos_confirmados', 'count'))}`,
      `Pedidos fallidos    : ${fmt(val('pedidos_fallidos', 'count'))}`,
      `Tasa errores 5xx    : ${fmt((val('errores_5xx', 'rate') || 0) * 100)} %`,
      `Throughput pedidos  : ${fmt(val('pedidos_confirmados', 'rate'))} TPS`,
      `Latencia pedido ms  : p50=${fmt(val('latencia_pedido', 'med'))} p95=${fmt(val('latencia_pedido', 'p(95)'))} p99=${fmt(val('latencia_pedido', 'p(99)'))} max=${fmt(val('latencia_pedido', 'max'))}`,
      `Latencia lectura ms : p95=${fmt(val('latencia_lectura', 'p(95)'))} p99=${fmt(val('latencia_lectura', 'p(99)'))}`,
      `Reintentos internos : ${fmt(val('reintentos_internos', 'count'))}`,
      `Peticiones HTTP     : ${fmt(val('http_reqs', 'count'))} (${fmt(val('http_reqs', 'rate'))}/s)`,
      `VUs máximos         : ${fmt(val('vus_max', 'max'))}`,
      ...Object.entries(data.root_group && data.root_group.checks ? data.root_group.checks : {}).map(
        ([, c]) => `Check "${c.name}": ${c.passes} ok / ${c.fails} fallos`),
      '',
    ];
    return {
      stdout: lineas.join('\n'),
      [`/resultados/k6-${nombre}-${LOTE}.json`]: JSON.stringify(data, null, 2),
    };
  };
}
