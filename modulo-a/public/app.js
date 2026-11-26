/* =============================================================================
 * TechOrders U3 - SPA de operación y monitoreo
 *  - Formulario individual + ráfagas concurrentes controladas
 *  - Tablas con trazabilidad de réplicas (gateway / dominio / auditoría)
 *  - Health Dashboard: nodos, clústeres de BD y eventos de failover
 *  - Failover del lado del cliente entre los dos balanceadores de entrada (:8080 / :8081)
 * ========================================================================== */
'use strict';

// ----------------------------------------------------------------------------- utilidades
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtCLP = (n) => 'CLP ' + Number(n || 0).toLocaleString('es-CL');
const fmtHora = (t) => { const d = new Date(t); return isNaN(d) ? esc(t) : d.toLocaleTimeString('es-CL', { hour12: false }); };
const pct = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const countBy = (arr, f) => arr.reduce((m, x) => { const k = f(x) || '?'; m[k] = (m[k] || 0) + 1; return m; }, {});

// ----------------------------------------------------------------------------- entrada con failover
// Si la página se abrió en :8080 el respaldo es :8081 y viceversa.
const ENTRADAS = (() => {
  const alt = location.port === '8081' ? '8080' : '8081';
  return [location.origin, `${location.protocol}//${location.hostname}:${alt}`];
})();
let entradaIdx = 0;

async function api(path, opts = {}) {
  let lastErr;
  for (let k = 0; k < ENTRADAS.length; k++) {
    const i = (entradaIdx + k) % ENTRADAS.length;
    try {
      const res = await fetch(ENTRADAS[i] + path, {
        ...opts,
        headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
        signal: AbortSignal.timeout(opts.timeout || 30000),
      });
      if (i !== entradaIdx) {
        addClientEvent('entrada', 'FAILOVER CLIENTE', `El balanceador ${ENTRADAS[entradaIdx]} no responde; el SPA cambió a ${ENTRADAS[i]}`, 'failover');
        entradaIdx = i;
      }
      $('#entradaActiva').textContent = new URL(ENTRADAS[entradaIdx]).host;
      return res;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// ----------------------------------------------------------------------------- pestañas
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === b));
  document.querySelectorAll('.tab-panel').forEach((p) => { p.hidden = p.id !== 'tab-' + b.dataset.tab; });
}));

// ----------------------------------------------------------------------------- helpers de presentación
// Insignia de réplica. Si el dato no viene del backend se muestra "—": nunca se
// inventa un nombre de réplica (la trazabilidad debe ser real).
const replica = (v) => (v ? `<span class="replica-badge">${esc(v)}</span>` : '<span class="replica-badge none">—</span>');
const esFailover = (ev) => /FAILOVER|PROMOT|CAÍDA|CAIDA/i.test(ev || '');
function alerta(tipo, html) {
  const a = $('#formMsg'); a.className = `alert alert-${tipo}`; a.innerHTML = html; a.hidden = false;
}

// ----------------------------------------------------------------------------- pedido individual
function renderTraza(d) {
  const t = d.trazabilidad || {};
  const hop = (k, v) => `<span class="hop"><b>${esc(k)}</b>${esc(v ?? '—')}</span>`;
  const a = t.auditoria || {}; const dm = t.dominio || {};
  return `
    <h4>Trazabilidad de la petición ${esc((d.request_id || '').slice(0, 8))}</h4>
    <div class="hops">${hop('Entrada', t.balanceador_entrada)}<span class="arrow">→</span>${hop('Gateway', t.gateway)}</div>
    <div class="hops"><span class="arrow">↳ auditoría</span>${hop('LB interno', a.balanceador_interno)}<span class="arrow">→</span>${hop('Módulo C', a.nodo)}${a.intentos > 1 ? hop('Intentos', a.intentos) : ''}</div>
    <div class="hops"><span class="arrow">↳ dominio</span>${hop('LB interno', dm.balanceador_interno)}<span class="arrow">→</span>${hop('Módulo B', dm.nodo)}${dm.intentos > 1 ? hop('Intentos', dm.intentos) : ''}</div>
    <div class="muted">Latencia total: ${esc(d.latencia_ms)} ms${dm.duplicado ? ' · reintento idempotente (no duplicado)' : ''}</div>`;
}

$('#formPedido').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target; const btn = f.querySelector('button');
  const body = { cliente: f.cliente.value.trim(), producto: f.producto.value.trim(), precio: parseInt(f.precio.value, 10), pago: f.pago.value };
  btn.disabled = true; $('#trazaUltima').hidden = true;
  alerta('info', 'Procesando pedido distribuido...');
  try {
    const res = await api('/api/pedidos', { method: 'POST', body: JSON.stringify(body) });
    const d = await res.json().catch(() => ({}));
    if (res.ok) {
      const t = d.trazabilidad || {};
      alerta('success', `¡Pedido #${esc(d.data.pedido_id)} registrado con éxito!<br><small>Atendido por: <b>${esc(t.gateway || '—')}</b> → <b>${esc((t.dominio || {}).nodo || '—')}</b> / <b>${esc((t.auditoria || {}).nodo || '—')}</b></small>`);
      $('#trazaUltima').innerHTML = renderTraza(d); $('#trazaUltima').hidden = false;
      f.reset(); refreshTablas();
    } else {
      alerta('danger', `Error${d.fase ? ' en fase ' + esc(d.fase) : ''}: ${esc(d.mensaje || 'HTTP ' + res.status)}`);
    }
  } catch (e) {
    alerta('danger', 'Error de comunicación con el Balanceador (ninguna entrada respondió)');
  } finally { btn.disabled = false; }
});

// ----------------------------------------------------------------------------- ráfagas
const CLIENTES = ['Esteban Padilla', 'Franco Jorquera', 'María Vidal', 'Andrés Castillo', 'Camila Rojas'];
const PRODUCTOS = [['Teclado Mecánico RGB', 34990], ['Mouse Inalámbrico Pro', 19990], ['Monitor 24" IPS', 149990], ['Audífonos Studio', 45900], ['SSD NVMe 1TB', 64990]];
const PAGOS = ['Debito', 'Credito', 'Transferencia'];
let rafagaActiva = false;

async function rafaga(n, conc) {
  if (rafagaActiva) return;
  rafagaActiva = true;
  document.querySelectorAll('[data-burst], #burstCustom').forEach((b) => { b.disabled = true; });
  const lote = 'rafaga-' + new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const res = []; let next = 0; const t0 = performance.now();
  const bar = $('#burstBar'); const txt = $('#burstText');
  $('#burstProgress').hidden = false; bar.style.width = '0%';
  $('#burstResult').hidden = true; $('#trazaUltima').hidden = true;
  alerta('info', `Enviando ráfaga de ${n} pedidos con concurrencia ${Math.min(conc, n)}...`);

  // Concurrencia controlada: "conc" trabajadores que se reparten los n pedidos
  async function worker() {
    while (next < n) {
      const i = next++;
      const [prod, precio] = PRODUCTOS[i % PRODUCTOS.length];
      const body = { cliente: CLIENTES[i % CLIENTES.length], producto: `${prod} #${i + 1}`, precio, pago: PAGOS[i % PAGOS.length], lote };
      const s = performance.now();
      try {
        const r = await api('/api/pedidos', { method: 'POST', body: JSON.stringify(body) });
        const d = await r.json().catch(() => ({}));
        res.push({ ok: r.ok, status: r.status, ms: performance.now() - s, t: d.trazabilidad || {} });
      } catch (e) {
        res.push({ ok: false, status: 'red', ms: performance.now() - s, t: {} });
      }
      const done = res.length;
      bar.style.width = `${(done / n) * 100}%`;
      txt.textContent = `Procesando ráfaga: ${done}/${n} (${res.filter((x) => x.ok).length} OK, ${res.filter((x) => !x.ok).length} err)`;
    }
  }
  await Promise.all(Array.from({ length: Math.min(conc, n) }, worker));
  const dur = (performance.now() - t0) / 1000;
  const ok = res.filter((x) => x.ok); const lat = ok.map((x) => x.ms);
  txt.textContent = `Duración ${dur.toFixed(1)} s · concurrencia ${Math.min(conc, n)}`;
  alerta(ok.length === n ? 'success' : 'danger', `Ráfaga finalizada: <b>${ok.length}</b> exitosos, <b>${res.length - ok.length}</b> fallidos.`);

  const dist = (titulo, f) => {
    const m = countBy(ok, f); const max = Math.max(1, ...Object.values(m));
    return `<div class="dist"><h5>${esc(titulo)}</h5>${Object.entries(m).sort().map(([k, v]) =>
      `<div class="bar-row"><span class="replica-badge">${esc(k)}</span><div class="bar"><span style="width:${(v / max) * 100}%"></span></div><span>${v}</span></div>`).join('')}</div>`;
  };
  const errores = countBy(res.filter((x) => !x.ok), (x) => String(x.status));
  $('#burstResult').innerHTML = `
    <div class="kpis">
      <div class="kpi"><b>${ok.length}/${n}</b>exitosos</div>
      <div class="kpi"><b>${(ok.length / dur).toFixed(1)}</b>TPS</div>
      <div class="kpi"><b>${(res.length - ok.length)}</b>errores ${Object.keys(errores).length ? '(' + esc(Object.entries(errores).map(([k, v]) => k + ':' + v).join(', ')) + ')' : ''}</div>
      <div class="kpi"><b>${pct(lat, 0.5).toFixed(0)} ms</b>p50</div>
      <div class="kpi"><b>${pct(lat, 0.95).toFixed(0)} ms</b>p95</div>
      <div class="kpi"><b>${pct(lat, 0.99).toFixed(0)} ms</b>p99</div>
    </div>
    ${dist('Balanceador de entrada', (x) => x.t.balanceador_entrada)}
    ${dist('Gateway (Módulo A)', (x) => x.t.gateway)}
    ${dist('Dominio (Módulo B)', (x) => x.t.dominio && x.t.dominio.nodo)}
    ${dist('Auditoría (Módulo C)', (x) => x.t.auditoria && x.t.auditoria.nodo)}
    <div><span class="muted">Lote:</span> <code>${esc(lote)}</code>
      <button class="btn btn-refresh" id="btnIntegridad">Verificar integridad</button></div>
    <div id="integridadRes" class="muted"></div>`;
  $('#burstResult').hidden = false;
  $('#btnIntegridad').onclick = async () => {
    const out = $('#integridadRes'); out.textContent = 'Consultando PostgreSQL y Redis…';
    try {
      const d = await (await api('/api/integridad?lote=' + encodeURIComponent(lote))).json();
      const okInt = d.pedidos_postgresql === ok.length && d.trazas_redis >= d.pedidos_postgresql;
      out.innerHTML = `${okInt ? '✅' : '⚠️'} Confirmados al cliente: <b>${ok.length}</b> · en PostgreSQL: <b>${esc(d.pedidos_postgresql)}</b> · trazas en Redis: <b>${esc(d.trazas_redis)}</b>
        · particiones: ${esc(Object.entries((d.distribucion || {}).particiones_postgresql || {}).map(([k, v]) => k + '=' + v).join(', '))}`;
    } catch (e) { out.textContent = 'No se pudo verificar: ' + e.message; }
  };
  document.querySelectorAll('[data-burst], #burstCustom').forEach((b) => { b.disabled = false; });
  rafagaActiva = false;
  refreshTablas();
}
document.querySelectorAll('[data-burst]').forEach((b) => b.addEventListener('click', () => rafaga(parseInt(b.dataset.burst, 10), Math.min(100, parseInt($('#burstC').value, 10) || 10))));
$('#burstCustom').addEventListener('click', () => rafaga(Math.min(5000, parseInt($('#burstN').value, 10) || 100), Math.min(100, parseInt($('#burstC').value, 10) || 10)));

// ----------------------------------------------------------------------------- tablas
const vistos = new Set(); let primeraCarga = true;
let auditoriaCache = [];

async function refreshPedidos() {
  try {
    const data = await (await api('/api/pedidos?limit=60')).json();
    if (!Array.isArray(data)) throw new Error(data.mensaje || 'respuesta inválida');
    $('#tbPedidos').innerHTML = data.map((p) => {
      const nuevo = !primeraCarga && !vistos.has(p.pedido_id); vistos.add(p.pedido_id);
      return `<tr class="${nuevo ? 'nuevo' : ''}"><td>${esc(p.pedido_id)}</td><td>${esc(p.cliente)}</td><td>${esc(p.producto)}</td>
        <td>${fmtCLP(p.precio)}</td><td>${replica(p.nodo_gateway)}</td><td>${replica(p.nodo_dominio)}</td>
        <td><span class="status-badge">${esc(p.estado)}</span></td></tr>`;
    }).join('') || '<tr><td colspan="7" class="muted">Sin pedidos.</td></tr>';
    primeraCarga = false;
  } catch (e) {
    $('#tbPedidos').innerHTML = `<tr><td colspan="7"><div class="alert alert-danger">No se pudo consultar el Módulo B: ${esc(e.message)}</div></td></tr>`;
  }
}

function renderAuditoria() {
  const fEvento = $('#filtroEvento').value; const fNodo = $('#filtroAuditoria').value;
  const rows = auditoriaCache.filter((l) => (!fEvento || l.evento === fEvento) && (!fNodo || l.nodo_auditoria === fNodo));
  $('#tbAuditoria').innerHTML = rows.map((l) => {
    const ev = l.evento || '—';
    return `<tr><td><code title="${esc(l.key)}">${esc((l.key || '').slice(0, 22))}…</code></td>
      <td><span class="${esFailover(ev) ? 'failover-badge' : 'status-badge'}">${esc(ev)}</span></td>
      <td>${replica(l.nodo_gateway)}</td><td>${replica(l.nodo_auditoria)}</td>
      <td><small>${esc(l.registrado_en || l.timestamp || '')}</small></td></tr>`;
  }).join('') || '<tr><td colspan="5" class="muted">Sin trazas para el filtro seleccionado.</td></tr>';
}

function opciones(sel, valores, etiquetaTodos) {
  const actual = sel.value;
  sel.innerHTML = `<option value="">${etiquetaTodos}</option>` + valores.map((v) => `<option ${v === actual ? 'selected' : ''}>${esc(v)}</option>`).join('');
}

async function refreshAuditoria() {
  try {
    const data = await (await api('/api/auditoria?limit=60')).json();
    if (!Array.isArray(data)) throw new Error(data.mensaje || 'respuesta inválida');
    auditoriaCache = data;
    // Los filtros se arman con los valores que realmente existen (no con opciones fijas)
    opciones($('#filtroEvento'), [...new Set(data.map((l) => l.evento).filter(Boolean))].sort(), 'Todos los eventos');
    opciones($('#filtroAuditoria'), [...new Set(data.map((l) => l.nodo_auditoria).filter(Boolean))].sort(), 'Todas las réplicas');
    renderAuditoria();
  } catch (e) {
    $('#tbAuditoria').innerHTML = `<tr><td colspan="5"><div class="alert alert-danger">No se pudo consultar el Módulo C: ${esc(e.message)}</div></td></tr>`;
  }
}
$('#filtroEvento').addEventListener('change', renderAuditoria);
$('#filtroAuditoria').addEventListener('change', renderAuditoria);
const refreshTablas = () => Promise.all([refreshPedidos(), refreshAuditoria()]);
$('#btnRefresh').addEventListener('click', refreshTablas);

// ----------------------------------------------------------------------------- eventos
const clientEvents = []; let prevSnapshot = null; const serverEventKeys = new Set();

function addClientEvent(componente, tipo, detalle, clase = '') {
  clientEvents.unshift({ ocurrido_en: new Date().toISOString(), componente, tipo, detalle, origen: 'detectado por el SPA', clase });
  clientEvents.length = Math.min(clientEvents.length, 100);
}

function snapshot(s) {
  const m = {};
  const add = (pref, arr) => (arr || []).forEach((n) => { m[`${pref}:${n.nombre}`] = n.estado; });
  add('Balanceador de entrada', s.balanceadores_entrada?.nodos); add('Gateway', s.gateways?.nodos);
  add('Balanceador interno', s.balanceadores_internos?.nodos); add('Dominio', s.dominio?.nodos); add('Auditoría', s.auditoria?.nodos);
  (s.postgresql?.pgpool || []).forEach((p) => { m[`Pgpool:${p.host}`] = p.estado; });
  (s.postgresql?.nodos || []).forEach((n) => { m[`PostgreSQL:${n.host}`] = n.estado; m[`Rol PostgreSQL:${n.host}`] = n.rol; });
  (s.redis?.nodos || []).forEach((n) => { m[`Redis:${n.addr}`] = n.estado; m[`Rol Redis:${n.addr}`] = n.rol; });
  return m;
}

function detectarCambios(s) {
  const now = snapshot(s);
  if (prevSnapshot) {
    for (const [k, v] of Object.entries(now)) {
      const antes = prevSnapshot[k];
      if (antes === undefined || antes === v) continue;
      const [comp, nodo] = [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)];
      if (comp.startsWith('Rol')) {
        const promovido = v === 'primary' || v === 'maestro';
        addClientEvent(comp.replace('Rol ', ''), promovido ? 'PROMOCIÓN' : 'CAMBIO DE ROL', `${nodo}: ${antes} → ${v}`, promovido ? 'failover' : '');
      } else if (v !== 'UP') {
        addClientEvent(comp, 'CAÍDA', `${nodo} pasó de ${antes} a ${v}`, 'failover');
      } else {
        addClientEvent(comp, 'RECUPERACIÓN', `${nodo} volvió a UP`, 'recovery');
      }
    }
  }
  prevSnapshot = now;
}

function renderEventos(s) {
  const server = (s.eventos_failover || []).map((e) => ({
    ocurrido_en: e.ocurrido_en, componente: e.componente, tipo: e.tipo, clase: 'failover',
    detalle: e.componente === 'postgresql' ? `${e.nodo_caido} caído → nuevo primario ${e.nuevo_primario} (${e.detalle || ''})`
      : `maestros ${e.maestros_antes} → ${e.maestros_ahora}`,
    origen: e.detectado_por ? `servidor (${e.detectado_por})` : 'servidor',
  }));
  server.forEach((e) => serverEventKeys.add(e.ocurrido_en + e.detalle));
  const all = [...server, ...clientEvents].sort((a, b) => new Date(b.ocurrido_en) - new Date(a.ocurrido_en)).slice(0, 80);
  $('#tbEventos').innerHTML = all.map((e) => `<tr class="ev-${e.clase || ''}"><td class="mono">${fmtHora(e.ocurrido_en)}</td><td>${esc(e.componente)}</td>
    <td><span class="${e.clase === 'recovery' ? 'recovery-badge' : e.clase === 'failover' ? 'failover-badge' : 'status-badge'}">${esc(e.tipo)}</span></td>
    <td style="white-space:normal;text-align:left">${esc(e.detalle)}</td><td class="muted">${esc(e.origen)}</td></tr>`).join('')
    || '<tr><td colspan="5" class="muted">Sin eventos.</td></tr>';
  const nf = Math.max(maxFailovers, server.length);
  $('#tabFailovers').hidden = nf === 0; $('#tabFailovers').textContent = nf;
}

// ----------------------------------------------------------------------------- monitor de salud
// Píldora del monitor (estilo de la versión de Alonso), siempre con datos reales
function pill(texto, cls = '') {
  return `<span class="node-pill ${cls}"><span class="dot"></span> ${texto}</span>`;
}
function chip(texto, activos, total) {
  const cls = activos === total ? '' : activos === 0 ? 'down' : 'warn';
  return pill(`${esc(texto)}: ${activos}/${total}`, cls);
}

let maxFailovers = 0;
function renderStrip(s) {
  const pg = s.postgresql || {}; const rd = s.redis || {};
  const replicas = (pg.nodos || []).filter((n) => n.rol === 'standby' && n.estado === 'UP').length;
  const pgCls = pg.estado === 'OK' ? '' : pg.estado === 'DOWN' ? 'down' : 'warn';
  const rdCls = rd.estado === 'OK' ? '' : rd.estado === 'DOWN' || !rd.estado ? 'down' : 'warn';
  // Un failover ya ocurrido no "desaparece": si una BD deja de ser consultable,
  // el contador conserva el máximo observado en vez de bajar.
  maxFailovers = Math.max(maxFailovers, (s.eventos_failover || []).length);
  const nf = maxFailovers;
  $('#statusStrip').innerHTML = [
    chip('Balanceadores', s.balanceadores_entrada.activos, s.balanceadores_entrada.total),
    chip('Mod A', s.gateways.activos, s.gateways.total),
    chip('LB interno', s.balanceadores_internos.activos, s.balanceadores_internos.total),
    chip('Mod B', s.dominio.activos, s.dominio.total),
    chip('Mod C', s.auditoria.activos, s.auditoria.total),
    // Si no hay réplicas de B (o C) vivas no se puede consultar la BD: se informa "desconocido"
    !pg.nodos ? pill('PG: estado desconocido', 'pending')
      : pill(`PG: ${esc(pg.primario ? 'PRIMARY ' + pg.primario : 'SIN PRIMARIO')}+${replicas}`, pgCls),
    !rd.nodos ? pill('Redis: estado desconocido', 'pending')
      : pill(`Redis: ${esc(rd.estado || 'DOWN')} (${esc(rd.maestros ?? 0)} maestros)`, rdCls),
    pill(`Failovers: ${nf}`, nf ? 'failover-alert' : ''),
  ].join('');
}

function vistaLB(s, backend, servidor) {
  // ¿Cómo ven los balanceadores a este servidor? (resultado de sus health checks activos)
  const fuentes = backend === 'gateways' ? s.balanceadores_entrada.nodos : s.balanceadores_internos.nodos;
  return fuentes.map((lb) => {
    const sv = lb.vista && (lb.vista[backend] || []).find((x) => x.servidor === servidor);
    if (!sv) return '';
    const up = String(sv.estado).startsWith('UP');
    return `<span class="replica-badge ${up ? '' : 'down'}" title="${esc(sv.chequeo || '')}">${esc(lb.nombre)}: ${esc(sv.estado)} · ${esc(sv.peticiones)} req</span>`;
  }).join('');
}

function renderLayers(s) {
  const capa = (titulo, c, backend) => `
    <div class="card layer"><div class="card-header card-header-dark"><h3>${esc(titulo)}</h3><span class="count">${c.activos}/${c.total}</span></div>
      <div class="card-body">${c.nodos.map((n) => `
        <div class="node ${n.estado === 'UP' ? '' : 'down'}"><span class="dot"></span>
          <div><div class="name">${esc(n.nombre)}${n.este_nodo ? ' <span class="muted small">(respondió)</span>' : ''}</div>
            <div class="sub">${n.estado === 'UP' ? `${esc(n.latencia_ms)} ms` : esc(n.error || 'sin respuesta')}${n.detalle && n.detalle.uptime_seg !== undefined ? ` · up ${esc(n.detalle.uptime_seg)} s` : ''}</div>
            ${backend ? `<div class="lbview">${vistaLB(s, backend, n.nombre)}</div>` : ''}
          </div><span class="${n.estado === 'UP' ? 'status-badge' : 'failover-badge'}">${esc(n.estado)}</span></div>`).join('')}
      </div></div>`;
  $('#layers').innerHTML =
    capa('Balanceadores de entrada', s.balanceadores_entrada) +
    capa('API Gateway (Módulo A)', s.gateways, 'gateways') +
    capa('Balanceadores internos', s.balanceadores_internos) +
    capa('Dominio (Módulo B)', s.dominio, 'modulo_b') +
    capa('Auditoría (Módulo C)', s.auditoria, 'modulo_c');
}

function renderPG(pg) {
  $('#pgTimeline').textContent = `timeline ${pg.timeline ?? '—'}`;
  if (!pg || pg.estado === 'DOWN' && !pg.nodos) { $('#pgPanel').innerHTML = `<div class="alert alert-danger">Sin acceso al clúster (el módulo que lo consulta no responde): ${esc(pg && pg.error)}</div>`; return; }
  $('#pgPanel').innerHTML = `
    <div class="lbview">${(pg.pgpool || []).map((p) => `<span class="replica-badge ${p.estado === 'UP' ? '' : 'down'}">Pgpool ${esc(p.host)}: ${esc(p.estado)}${p.latencia_ms ? ' · ' + esc(p.latencia_ms) + ' ms' : ''}</span>`).join('')}</div>
    <table class="table"><thead><tr><th>Nodo</th><th>Rol</th><th>Estado</th><th>Replicación</th><th>Retraso</th><th>Lecturas</th></tr></thead><tbody>
    ${(pg.nodos || []).map((n) => `<tr><td><b>${esc(n.host)}</b></td><td><span class="role ${esc(n.rol)}">${esc(n.rol)}</span></td>
      <td><span class="${n.estado === 'UP' ? 'status-badge' : 'failover-badge'}">${esc(n.estado)}</span></td><td>${esc(n.estado_replicacion || (n.rol === 'primary' ? '—' : ''))}</td>
      <td>${esc(n.retraso_replicacion)}</td><td>${esc(n.lecturas)}</td></tr>`).join('')}
    </tbody></table>
    <div class="muted small">Estado: <b>${esc(pg.estado)}</b> · consultado por ${esc(pg.consultado_por || '—')} · el timeline sube en 1 con cada promoción.</div>`;
}

function renderRedis(rd) {
  $('#redisEpoch').textContent = `epoch ${rd.current_epoch ?? '—'}`;
  if (!rd || !rd.nodos) { $('#redisPanel').innerHTML = `<div class="alert alert-danger">Sin acceso al clúster (el módulo que lo consulta no responde): ${esc(rd && rd.error)}</div>`; return; }
  $('#redisPanel').innerHTML = `
    <table class="table"><thead><tr><th>Nodo</th><th>Rol</th><th>Estado</th><th>Hash slots</th><th>Claves</th></tr></thead><tbody>
    ${rd.nodos.map((n) => `<tr><td class="mono">${esc(n.addr)}</td><td><span class="role ${n.rol === 'maestro' ? 'primary' : 'standby'}">${esc(n.rol)}</span></td>
      <td><span class="${n.estado === 'UP' ? 'status-badge' : 'failover-badge'}">${esc(n.estado)}</span></td><td class="mono">${esc(n.slots || '—')}</td><td>${esc(n.claves ?? '—')}</td></tr>`).join('')}
    </tbody></table>
    <div class="muted small">Estado: <b>${esc(rd.estado)}</b> · ${esc(rd.maestros)} maestros activos · 16.384 slots repartidos por CRC16.</div>`;
}

let ultimoEstado = null;
async function refreshEstado() {
  try {
    const s = await (await api('/api/cluster-status', { timeout: 8000 })).json();
    ultimoEstado = s;
    detectarCambios(s); renderStrip(s); renderLayers(s); renderPG(s.postgresql || {}); renderRedis(s.redis || {}); renderEventos(s);
    $('#consultadoPor').textContent = s.consultado_por;
  } catch (e) {
    $('#statusStrip').innerHTML = pill('Sin respuesta de los balanceadores de entrada: estado desconocido', 'down');
    if (ultimoEstado) addClientEvent('Entrada', 'CAÍDA', 'Ningún balanceador de entrada responde: ' + e.message, 'failover');
  }
}

// ----------------------------------------------------------------------------- ciclo de actualización
async function ciclo() {
  if ($('#autoRefresh').checked) {
    await Promise.all([refreshEstado(), $('#tab-operacion').hidden ? null : refreshTablas()]);
  }
  setTimeout(ciclo, 2000);
}
refreshTablas(); ciclo();
