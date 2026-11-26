// =============================================================================
// ESCENARIO 2 - Fallos y degradación de red
// Tráfico constante mientras se inyecta latencia / pérdida de paquetes (tc netem)
// y particiones de red (docker network disconnect). Mide timeouts y reintentos.
//   docker compose --profile pruebas run --rm -e LOTE=e2 k6 run /scripts/e2-red.js
// Variables: TASA (15), DURACION (6m)
// =============================================================================
import { crearPedido, leer, verificarIntegridad, resumen } from './lib.js';

export const options = {
  scenarios: {
    escrituras: {
      executor: 'constant-arrival-rate',
      rate: parseInt(__ENV.TASA || '15', 10),
      timeUnit: '1s',
      duration: __ENV.DURACION || '6m',
      preAllocatedVUs: 50,
      maxVUs: 400,
      exec: 'escribir',
    },
    lecturas: {
      executor: 'constant-arrival-rate',
      rate: 5, timeUnit: '1s',
      duration: __ENV.DURACION || '6m',
      preAllocatedVUs: 10, maxVUs: 100,
      exec: 'leerPedidos',
    },
  },
  thresholds: {
    errores_5xx: ['rate<0.05'],
    'latencia_pedido': ['p(95)<5000'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export function escribir() { crearPedido(); }
export function leerPedidos() { leer('/api/pedidos?limit=20', 'GET /api/pedidos'); }
export function teardown() { verificarIntegridad(); }
export const handleSummary = resumen('e2-red');
