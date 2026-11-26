// =============================================================================
// ESCENARIO 1 - Caída abrupta de contenedores (Chaos Testing)
// Tráfico de escritura CONSTANTE mientras el script de caos mata réplicas de
// aplicación, el primario PostgreSQL y un maestro Redis.
//   docker compose --profile pruebas run --rm -e LOTE=e1 k6 run /scripts/e1-caida-nodos.js
// Variables: TASA (pedidos/s, 20), DURACION (5m)
// =============================================================================
import { crearPedido, leer, verificarIntegridad, resumen } from './lib.js';

export const options = {
  scenarios: {
    escrituras: {
      executor: 'constant-arrival-rate',
      rate: parseInt(__ENV.TASA || '20', 10),
      timeUnit: '1s',
      duration: __ENV.DURACION || '5m',
      preAllocatedVUs: 50,
      maxVUs: 300,
      exec: 'escribir',
    },
    dashboard: {                       // un operador mirando el Health Dashboard
      executor: 'constant-arrival-rate',
      rate: 1, timeUnit: '2s',
      duration: __ENV.DURACION || '5m',
      preAllocatedVUs: 2, maxVUs: 5,
      exec: 'monitorear',
    },
  },
  thresholds: {
    errores_5xx: ['rate<0.01'],                  // < 1 % de errores aun con nodos cayendo
    'latencia_pedido': ['p(95)<2000'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export function escribir() { crearPedido(); }
export function monitorear() { leer('/api/cluster-status', 'GET /api/cluster-status'); }
export function teardown() { verificarIntegridad(); }
export const handleSummary = resumen('e1-caida-nodos');
