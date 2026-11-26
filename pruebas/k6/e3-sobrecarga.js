// =============================================================================
// ESCENARIO 3 - Sobrecarga de transacciones
// Escrituras concurrentes crecientes para saturar pools de conexiones (Pgpool,
// psycopg2) y la replicación. Al final se verifica que no se perdió ningún
// pedido confirmado (k6 confirmados == filas en PostgreSQL == trazas en Redis).
//   docker compose --profile pruebas run --rm -e LOTE=e3 k6 run --out csv=/resultados/k6-e3.csv /scripts/e3-sobrecarga.js
// Variable: TASA_MAX (400 pedidos/s)
// =============================================================================
import { crearPedido, verificarIntegridad, resumen } from './lib.js';

const MAX = parseInt(__ENV.TASA_MAX || '400', 10);

export const options = {
  scenarios: {
    sobrecarga: {
      executor: 'ramping-arrival-rate',
      startRate: 10,
      timeUnit: '1s',
      preAllocatedVUs: 100,
      maxVUs: 1500,
      stages: [
        { target: Math.round(MAX * 0.125), duration: '30s' },   //  50/s
        { target: Math.round(MAX * 0.25), duration: '1m' },     // 100/s
        { target: Math.round(MAX * 0.5), duration: '1m' },      // 200/s
        { target: MAX, duration: '1m' },                        // 400/s
        { target: MAX, duration: '1m' },                        // sostenido
        { target: 0, duration: '30s' },                         // estabilización
      ],
      exec: 'escribir',
    },
  },
  thresholds: {
    // Umbrales informativos: el objetivo es encontrar el límite, no "pasar"
    errores_5xx: [{ threshold: 'rate<0.05', abortOnFail: false }],
    'latencia_pedido': [{ threshold: 'p(95)<3000', abortOnFail: false }],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export function escribir() { crearPedido(); }
export function teardown() { verificarIntegridad(); }
export const handleSummary = resumen('e3-sobrecarga');
