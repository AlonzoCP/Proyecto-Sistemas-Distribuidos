#!/usr/bin/env node
/* =============================================================================
 * Sonda de disponibilidad (RTO) - TechOrders U3
 *
 * Envía un pedido cada INTERVALO_MS alternando entre los balanceadores de
 * entrada y registra cada resultado en un CSV con marca de tiempo en ms.
 * Al terminar calcula las VENTANAS DE INDISPONIBILIDAD (fallos consecutivos):
 * la más larga es el tiempo de recuperación observado por el cliente (RTO).
 *
 * Uso (dentro de Docker):
 *   docker compose --profile pruebas run --rm sonda
 *   docker compose --profile pruebas run --rm -e DURACION_S=180 -e LOTE=e1 sonda
 * Variables: BASE_URLS, INTERVALO_MS (200), DURACION_S (120), LOTE, TIMEOUT_MS (5000)
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const BASES = (process.env.BASE_URLS || 'http://lb-1:8080,http://lb-2:8080').split(',').map((s) => s.trim());
const INTERVALO = parseInt(process.env.INTERVALO_MS || '200', 10);
const DURACION = parseInt(process.env.DURACION_S || '120', 10) * 1000;
const TIMEOUT = parseInt(process.env.TIMEOUT_MS || '5000', 10);
const LOTE = process.env.LOTE || 'sonda-' + new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
const DIR = process.env.DIR_RESULTADOS || '/resultados';

fs.mkdirSync(DIR, { recursive: true });
const archivo = path.join(DIR, `sonda-${LOTE}.csv`);
const out = fs.createWriteStream(archivo);
out.write('ts_iso,epoch_ms,ok,status,latencia_ms,entrada,gateway,nodo_auditoria,nodo_dominio,intentos_b,request_id\n');

const muestras = [];
let n = 0;

async function enviar() {
  const base = BASES[n % BASES.length];
  const i = n++;
  const t0 = Date.now();
  let fila;
  try {
    const r = await fetch(`${base}/api/pedidos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cliente: 'Sonda RTO', producto: `Sonda #${i}`, precio: 1000, pago: 'Debito', lote: LOTE }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const d = await r.json().catch(() => ({}));
    const t = d.trazabilidad || {};
    fila = { t0, ok: r.ok, status: r.status, ms: Date.now() - t0, entrada: t.balanceador_entrada || base,
      gw: t.gateway || '', aud: (t.auditoria || {}).nodo || '', dom: (t.dominio || {}).nodo || '',
      intentos: (t.dominio || {}).intentos || '', rid: d.request_id || '' };
  } catch (e) {
    fila = { t0, ok: false, status: e.name === 'TimeoutError' ? 'timeout' : 'red', ms: Date.now() - t0, entrada: base,
      gw: '', aud: '', dom: '', intentos: '', rid: '' };
  }
  muestras.push(fila);
  out.write([new Date(fila.t0).toISOString(), fila.t0, fila.ok ? 1 : 0, fila.status, fila.ms, fila.entrada,
    fila.gw, fila.aud, fila.dom, fila.intentos, fila.rid].join(',') + '\n');
  if (!fila.ok) console.log(`${new Date(fila.t0).toISOString()} FALLO status=${fila.status} (${fila.ms} ms) via ${fila.entrada}`);
}

function resumen() {
  muestras.sort((a, b) => a.t0 - b.t0);
  const ventanas = [];
  let actual = null;
  for (const m of muestras) {
    if (!m.ok) {
      if (!actual) actual = { inicio: m.t0, fin: m.t0 + m.ms, fallos: 0 };
      actual.fin = Math.max(actual.fin, m.t0 + m.ms); actual.fallos++;
    } else if (actual) {
      actual.recuperado = m.t0 + m.ms; // primera respuesta correcta después de la ventana
      ventanas.push(actual); actual = null;
    }
  }
  if (actual) ventanas.push(actual);
  const ok = muestras.filter((m) => m.ok);
  const lat = ok.map((m) => m.ms).sort((a, b) => a - b);
  const p = (q) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * q))] : 0);
  const res = {
    lote: LOTE, total: muestras.length, exitosas: ok.length, fallidas: muestras.length - ok.length,
    disponibilidad_pct: +(100 * ok.length / Math.max(1, muestras.length)).toFixed(3),
    latencia_ms: { p50: p(0.5), p95: p(0.95), p99: p(0.99), max: lat[lat.length - 1] || 0 },
    ventanas_indisponibilidad: ventanas.map((v) => ({
      inicio: new Date(v.inicio).toISOString(), fallos: v.fallos,
      duracion_ms: (v.recuperado || v.fin) - v.inicio,
      recuperado_en: v.recuperado ? new Date(v.recuperado).toISOString() : null,
    })),
  };
  res.rto_observado_ms = Math.max(0, ...res.ventanas_indisponibilidad.map((v) => v.duracion_ms));
  fs.writeFileSync(path.join(DIR, `sonda-${LOTE}-resumen.json`), JSON.stringify(res, null, 2));
  console.log('\n===== RESUMEN SONDA =====');
  console.log(JSON.stringify(res, null, 2));
  console.log(`CSV: ${archivo}`);
}

console.log(`Sonda ${LOTE}: 1 pedido cada ${INTERVALO} ms durante ${DURACION / 1000} s contra ${BASES.join(' | ')}`);
const inicio = Date.now();
const pendientes = new Set();
const timer = setInterval(() => {
  if (Date.now() - inicio >= DURACION) {
    clearInterval(timer);
    Promise.all(pendientes).then(() => { out.end(resumen); });
    return;
  }
  const pr = enviar().finally(() => pendientes.delete(pr));
  pendientes.add(pr);
}, INTERVALO);
