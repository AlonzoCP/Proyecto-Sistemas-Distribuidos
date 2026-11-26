// =============================================================================
// ESCENARIO 4 - Estrés por demanda de usuarios
// Usuarios concurrentes crecientes con comportamiento mixto: 80 % lecturas del
// dashboard (pedidos, auditoría, estado del clúster) y 20 % escrituras, con
// "think time" de 1 s. El punto de quiebre se obtiene del CSV por etapa.
//   docker compose --profile pruebas run --rm -e LOTE=e4 k6 run --out csv=/resultados/k6-e4.csv /scripts/e4-usuarios.js
// Variable: VUS_MAX (300)
// =============================================================================
import { sleep } from 'k6';
import { crearPedido, leer, verificarIntegridad, resumen } from './lib.js';

const MAX = parseInt(__ENV.VUS_MAX || '300', 10);

export const options = {
  scenarios: {
    usuarios: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { target: Math.round(MAX / 12), duration: '1m' },   //  25 usuarios
        { target: Math.round(MAX / 6), duration: '1m' },    //  50
        { target: Math.round(MAX / 3), duration: '1m' },    // 100
        { target: Math.round(MAX * 2 / 3), duration: '1m' },// 200
        { target: MAX, duration: '1m' },                    // 300
        { target: MAX, duration: '1m' },                    // sostenido
        { target: 0, duration: '30s' },
      ],
      gracefulRampDown: '20s',
    },
  },
  thresholds: {
    errores_5xx: [{ threshold: 'rate<0.05', abortOnFail: false }],
    'latencia_lectura': [{ threshold: 'p(95)<1000', abortOnFail: false }],
    'latencia_pedido': [{ threshold: 'p(95)<2000', abortOnFail: false }],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  const r = Math.random();
  if (r < 0.2) crearPedido();
  else if (r < 0.5) leer('/api/pedidos?limit=50', 'GET /api/pedidos');
  else if (r < 0.8) leer('/api/auditoria?limit=50', 'GET /api/auditoria');
  else leer('/api/cluster-status', 'GET /api/cluster-status');
  sleep(1);
}
export function teardown() { verificarIntegridad(); }
export const handleSummary = resumen('e4-usuarios');
