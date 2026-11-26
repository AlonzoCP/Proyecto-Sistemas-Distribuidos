# Plan de Pruebas de Resiliencia, Caos y Estrés — TechOrders U3

**Grupo G** — Juan Guzmán, Alonso Cabello, Cristóbal Vidal
Ingeniería Civil en Computación, Universidad de Talca
Entrega parcial: viernes 27/11/2026 · Ejecución y defensa: miércoles 09/12/2026

---

## 1. Objetivo y alcance

Verificar empíricamente que la arquitectura extendida de TechOrders:

1. **Sigue atendiendo** pedidos cuando caen contenedores de cualquier capa (balanceo, aplicación, persistencia).
2. **Se recupera sola**, sin reiniciar aplicaciones ni intervenir a mano, y en cuánto tiempo (RTO).
3. **No pierde ni duplica** transacciones confirmadas al cliente (RPO e integridad).
4. **Se comporta de forma predecible** ante red degradada, sobrecarga transaccional y crecimiento de usuarios, e identificar su punto de quiebre.

Se ejecutan los cuatro escenarios exigidos por la pauta: (1) caída abrupta de contenedores, (2) fallos y degradación de red, (3) sobrecarga de transacciones y (4) estrés por demanda de usuarios.

## 2. Sistema bajo prueba

| Capa | Componentes (contenedores) | Mecanismo de alta disponibilidad |
|---|---|---|
| Entrada (`red-frontend`) | `lb-1` (:8080), `lb-2` (:8081) — HAProxy 3.0 | Round Robin, health check **activo** `GET /health` cada 2 s, reintento L7 en otro gateway, failover del SPA entre :8080 y :8081 |
| Gateway | `modulo-a-1`, `modulo-a-2` — Node.js | Stateless, timeouts de 3 s, **reintentos con exponential backoff + jitter** (5 intentos) alternando balanceador interno |
| Balanceo interno (`red-servicios`) | `lb-int-1`, `lb-int-2` — HAProxy 3.0 | Least Connections, health check activo, retiro automático del pool, DNS dinámico de Docker |
| Dominio | `modulo-b-1`, `modulo-b-2` — FastAPI | Stateless, pool de conexiones, reintentos ante caída de BD, **idempotencia por `request_id`** |
| Auditoría | `modulo-c-1`, `modulo-c-2` — Go | Stateless, cliente Redis Cluster, escritura idempotente (`SET NX`) |
| BD relacional (`red-datos`) | `pg-1`, `pg-2` (PostgreSQL 16) + `pgpool-1`, `pgpool-2` (Pgpool-II con watchdog) | Streaming replication **semisíncrona con degradación automática**, failover automático con `pg_promote()`, reincorporación automática del ex-primario, lectura balanceada |
| BD clave-valor (`red-datos`) | `redis-1` … `redis-6` (Redis 7.4 Cluster, 3 maestros + 3 réplicas) | Elección automática de maestro (`cluster-node-timeout` 5 s), sharding en 16.384 hash slots, AOF |

**Trazabilidad para las pruebas.** Cada pedido lleva un `request_id` (UUID) y un `lote` (etiqueta de la prueba). La respuesta indica qué balanceador, gateway y réplicas de B y C atendieron cada fase. El endpoint `GET /api/integridad?lote=X` compara los pedidos en PostgreSQL con las trazas en Redis para ese lote y entrega la distribución por réplica y por partición.

## 3. Herramientas

| Herramienta | Uso | Ubicación en el repositorio |
|---|---|---|
| **k6 1.0** (contenedor `grafana/k6`) | Generación de carga: tasa constante, rampas de tasa y de usuarios; TPS, p95/p99, errores | `pruebas/k6/*.js` |
| **Sonda de disponibilidad** (Node.js) | 1 pedido cada 200 ms con marca de tiempo en ms; calcula ventanas de indisponibilidad y RTO observado | `pruebas/sonda/sonda.js` |
| **Scripts de caos** (PowerShell 5.1/7) | `docker kill/start`, búsqueda del primario PG y de un maestro Redis, `tc netem` (latencia/pérdida), `docker network disconnect` (particiones), captura de `docker stats` y logs | `pruebas/caos/*.ps1` |
| **`tc netem` vía `nicolaka/netshoot`** | Inyección de latencia y pérdida de paquetes en el namespace de red del contenedor objetivo, sin modificar su imagen | función `Agregar-Latencia` |
| **Análisis** (Python, librería estándar) | Tabla de RTO por falla (sonda + registro de eventos) y tabla por etapa para el punto de quiebre | `pruebas/analisis/rto.py`, `pruebas/analisis/por_etapa.py` |
| **Health Dashboard** (SPA) | Evidencia visual de nodos caídos, promociones y eventos de failover | `http://localhost:8080` → pestaña *Monitor de salud* |
| **Página de estadísticas HAProxy** | Estado de cada servidor según los health checks y peticiones atendidas | `http://localhost:8404/stats`, `:8405/stats` |

> Se eligió `tc netem` en lugar de Toxiproxy porque Toxiproxy debe ubicarse **en el camino de los datos** (los servicios se conectan al proxy), lo que agregaría un nuevo punto único de falla y obligaría a cambiar la configuración de los servicios. `tc netem` actúa sobre la interfaz del contenedor objetivo desde un contenedor auxiliar efímero.

## 4. Métricas y cómo se miden

| Métrica | Definición | Fuente |
|---|---|---|
| **Tiempo de detección** | Desde la inyección hasta que el componente de HA reacciona (servidor fuera del pool, promoción iniciada) | Logs con timestamp de HAProxy / Pgpool (`failover.sh`) / Redis; `eventos-<lote>.log` |
| **RTO observado** | Desde la inyección hasta la primera respuesta correcta después del último fallo visto por el cliente. Si no hubo fallos, RTO = 0 | Sonda + `rto.py` |
| **RPO** | Pedidos confirmados al cliente (HTTP 200) que no están en PostgreSQL tras la recuperación | k6 `pedidos_confirmados` vs `GET /api/integridad` |
| **Integridad** | Confirmados = filas en PostgreSQL = trazas en Redis; 0 duplicados (garantizado por `PRIMARY KEY (request_id)`) | `GET /api/integridad` |
| **Disponibilidad** | % de peticiones exitosas de la sonda durante la prueba | Resumen de la sonda |
| **Throughput (TPS)** | Pedidos confirmados por segundo | k6 `pedidos_confirmados` (rate) |
| **Latencia p50/p95/p99** | Percentiles de `POST /api/pedidos` y de las lecturas | k6 `latencia_pedido`, `latencia_lectura` |
| **Tasa de error 5xx** | Respuestas 5xx o sin respuesta / total | k6 `errores_5xx` |
| **Reintentos internos** | Reintentos del Gateway hacia B/C que el cliente no vio | k6 `reintentos_internos` (desde `trazabilidad`) |
| **Distribución de carga** | Pedidos atendidos por cada réplica y por partición | `GET /api/integridad` |
| **CPU / RAM por contenedor** | Uso durante la prueba (muestreo cada ~2 s) | `docker-stats-<lote>.csv` |

**Tiempos teóricos de detección según la configuración** (para comparar con lo medido):

| Componente | Parámetros | Detección esperada |
|---|---|---|
| HAProxy (servidor muerto) | `inter 2s fastinter 500ms fall 2` + reintento L7 inmediato | El cliente no ve el error (reintento); el pool se actualiza en ≤ 3 s |
| Pgpool-II (proceso muerto → conexión rechazada) | `failover_on_backend_error = on` | < 1 s |
| Pgpool-II (partición, sin RST) | `health_check_period 2`, `timeout 2`, `max_retries 2`, `retry_delay 1` | ≈ 6–8 s |
| Redis Cluster | `cluster-node-timeout 5000` + elección | ≈ 5–7 s |

## 5. Escenarios

### Escenario 1 — Caída abrupta de contenedores (Chaos Testing)

**Objetivo.** Verificar la continuidad del servicio y medir detección y RTO al matar (`docker kill`, equivalente a un corte de energía del contenedor) réplicas de aplicación y el nodo primario de cada base de datos con tráfico activo.

**Carga.** k6 `e1-caida-nodos.js`: 20 pedidos/s constantes durante 5 min, más un operador consultando el dashboard cada 2 s. La sonda corre en paralelo.

**Procedimiento automatizado** (`.\pruebas\caos\escenario1-caida-nodos.ps1`):

| t (s) | Acción | Comportamiento esperado |
|---|---|---|
| 30 | `kill modulo-b-1` | HAProxy interno lo saca del pool; el Gateway reintenta en `modulo-b-2`. **0 errores** para el cliente |
| 60 | `start modulo-b-1` | Vuelve al pool tras 2 health checks OK (≈ 1–2 s) |
| 75 | `kill modulo-a-1` | HAProxy de entrada reintenta en `modulo-a-2` con el mismo `X-Request-Id`. **0 errores** |
| 105 | `start modulo-a-1` | Reincorporación automática |
| 120 | `kill modulo-c-1` | Igual que B; trazas en `modulo-c-2` |
| 150 | `start modulo-c-1` | Reincorporación automática |
| 165 | `kill` del **primario PostgreSQL** (detectado con `SHOW POOL_NODES`) | Pgpool ejecuta `failover.sh`, promueve la réplica (`pg_promote`), la deja en asíncrono (aún no tiene réplica) y registra el evento en `ha_eventos`; el Módulo B reintenta con backoff; el *timeline* sube en 1; RPO = 0 por la replicación semisíncrona |
| 225 | `start` del ex-primario | `ha-entrypoint.sh` detecta que el par ya es primario, se re-clona como réplica; Pgpool lo reincorpora (`auto_failback`) y `failback.sh` restablece la replicación semisíncrona |
| 240 | `kill` de un **maestro Redis** | Su réplica es elegida maestro en ≈ 5–7 s; las escrituras a los otros 2 shards no se detienen |
| 280 | `start` del ex-maestro | Vuelve como réplica del nuevo maestro |

**Criterios de éxito.**
- Caída de réplicas de aplicación (A, B, C): 0 errores para el cliente; RTO = 0.
- Caída del primario PostgreSQL: RTO ≤ 15 s; RPO = 0 pedidos confirmados perdidos.
- Caída de un maestro Redis: RTO ≤ 15 s; las escrituras de los otros shards no se interrumpen.
- Tasa de error 5xx total < 1 %; integridad: confirmados = PostgreSQL = Redis.
- Todos los nodos vuelven a `UP` sin intervención manual (salvo el `docker start` que simula la reparación).

**Evidencia.** `k6-<lote>.txt`, `sonda-<lote>-sonda-resumen.json`, tabla de `rto.py`, capturas del Health Dashboard en t≈170 y t≈245, `cluster-status-<lote>-*.json`, logs de `pgpool-*`.

### Escenario 2 — Fallos y degradación de la comunicación de red

**Objetivo.** Validar timeouts, reintentos con exponential backoff y el comportamiento ante particiones (incluida la prevención de *split-brain*).

**Carga.** k6 `e2-red.js`: 15 pedidos/s + 5 lecturas/s durante 6 min 30 s. Sonda en paralelo.

**Procedimiento automatizado** (`.\pruebas\caos\escenario2-red.ps1`):

| Sub-caso | t (s) | Falla inyectada | Comportamiento esperado |
|---|---|---|---|
| 2a Réplica lenta | 30–90 | Latencia 300 ± 50 ms en `modulo-b-1` | Sin errores; sube la latencia de la mitad de los pedidos (p95 ≈ +300 ms) |
| 2b Balanceador inestable | 100–160 | 30 % de pérdida de paquetes en `lb-int-1` | Retransmisiones TCP y algunos timeouts; el Gateway reintenta alternando a `lb-int-2`. Errores < 1 %, más reintentos internos |
| 2c Réplica más lenta que el timeout | 170–230 | Latencia 4000 ms en `modulo-c-1` (timeout del Gateway = 3 s) | El Gateway corta a los 3 s y reintenta en otra réplica; latencia de esos pedidos ≈ 3,2 s; 0 errores. Se documenta que el health check (liveness) no retira una réplica lenta |
| 2d Partición del primario PG | 240–290 | `docker network disconnect red-datos <primario>` | Pgpool no recibe respuesta → detección por health check (≈ 6–8 s) → promoción de la réplica. Al reconectar, se reinicia el ex-primario y se reincorpora como réplica. **Debe quedar un solo primario** (`detach_false_primary` + `ha-entrypoint.sh`) |
| 2e Réplica sin acceso a Redis | 320–360 | `modulo-c-1` desconectado de `red-datos` | `modulo-c-1` sigue vivo para HAProxy pero responde 503; el Gateway reintenta en `modulo-c-2`. Se mide el costo en latencia |

**Criterios de éxito.** Errores 5xx < 5 % en toda la prueba; 0 pedidos confirmados perdidos; un único primario PostgreSQL al final; reintentos internos visibles en `reintentos_internos` y en los logs del Gateway.

### Escenario 3 — Sobrecarga de transacciones

**Objetivo.** Saturar los pools de conexiones (psycopg2 → Pgpool-II → PostgreSQL) y la replicación con escrituras concurrentes, y comprobar que **no se pierden transacciones confirmadas**.

**Carga.** k6 `e3-sobrecarga.js` (`ramping-arrival-rate`): 10 → 50 → 100 → 200 → 400 pedidos/s, 1 min sostenido a 400/s, 30 s de bajada. Hasta 1.500 VUs. Se exporta CSV para el análisis por etapa.

**Procedimiento.** `.\pruebas\caos\escenario3-sobrecarga.ps1 [-TasaMax 400]` → captura `docker stats`, ejecuta la rampa, espera 10 s a que termine la replicación y compara confirmados con persistidos.

**Métricas.** TPS máximo sostenido, p95/p99 por etapa (`por_etapa.py`), errores 5xx por etapa, CPU/RAM de `modulo-b-*`, `pgpool-*` y `pg-*`, retraso de replicación (`SHOW POOL_NODES`), distribución por partición (`pedidos_p0..p3`).

**Criterios de éxito.** RPO = 0 (confirmados = filas en PostgreSQL), 0 duplicados, errores 5xx < 5 % hasta la etapa de 200 pedidos/s; se documenta la tasa a la que p95 supera 3 s o los errores superan 5 % (límite de capacidad). Las 4 particiones deben recibir ≈ 25 % cada una.

### Escenario 4 — Estrés por demanda de usuarios

**Objetivo.** Determinar el punto de quiebre con usuarios concurrentes que combinan lecturas del dashboard y escrituras, y verificar el reparto efectivo entre réplicas.

**Carga.** k6 `e4-usuarios.js` (`ramping-vus`): 25 → 50 → 100 → 200 → 300 usuarios (1 min por etapa) + 1 min sostenido. Cada usuario: 20 % `POST /api/pedidos`, 30 % `GET /api/pedidos`, 30 % `GET /api/auditoria`, 20 % `GET /api/cluster-status`, con 1 s de espera entre acciones.

**Procedimiento.** `.\pruebas\caos\escenario4-usuarios.ps1 [-VusMax 300]`.

**Definición de punto de quiebre.** Primer intervalo de 30 s con p95 > 1.000 ms o errores > 5 % (`por_etapa.py`).

**Métricas.** Req/s y TPS por etapa, p95/p99 de lecturas y escrituras, uso de CPU/RAM por contenedor (identificar el cuello de botella), reparto por réplica (estadísticas de HAProxy y `GET /api/integridad`).

**Criterios de éxito.** Sin errores hasta 100 usuarios; reparto entre réplicas con diferencia < 10 % (Round Robin); identificar y justificar el componente que limita (CPU de una capa, conexiones de Pgpool, lecturas de Redis).

## 6. Matriz resumen

| # | Escenario | Inyección | Herramienta | Métrica principal | Criterio de éxito |
|---|---|---|---|---|---|
| 1a | Caída réplica B / A / C | `docker kill` | PowerShell + k6 + sonda | Errores cliente, RTO | 0 errores, RTO = 0 |
| 1b | Caída primario PG | `docker kill` del primario | Pgpool-II | Detección, RTO, RPO | RTO ≤ 15 s, RPO = 0 |
| 1c | Caída maestro Redis | `docker kill` del maestro | Redis Cluster | RTO, shards no afectados | RTO ≤ 15 s |
| 2a–c | Latencia / pérdida | `tc netem` | netshoot + k6 | p95, reintentos, timeouts | Errores < 5 % |
| 2d | Partición primario PG | `docker network disconnect` | Pgpool-II | Detección, split-brain | Un solo primario |
| 2e | Réplica sin BD | `docker network disconnect` | k6 | Latencia, reintentos | 0 pedidos perdidos |
| 3 | Sobrecarga escrituras | 10 → 400 pedidos/s | k6 | TPS, p95/p99, 5xx, integridad | RPO = 0 |
| 4 | Estrés usuarios | 25 → 300 VUs | k6 | Punto de quiebre, CPU/RAM | Quiebre identificado y justificado |

## 7. Procedimiento general de ejecución

1. **Preparación**: `docker compose down -v` (datos limpios) → `docker compose up -d --build` → esperar a que todos los contenedores estén *healthy* (los scripts lo verifican con `Esperar-Saludable`).
2. **Línea base**: ráfaga de 200 pedidos desde la interfaz y verificación de integridad (debe ser 200/200/200).
3. **Ejecución**: un escenario a la vez, con el Health Dashboard abierto para tomar capturas.
4. **Repeticiones**: cada escenario se ejecuta **3 veces**; en el informe se reporta la mediana y el rango.
5. **Entre escenarios**: verificar que todos los nodos volvieron a `UP` y que hay un solo primario.
6. **Recolección**: todo queda en `resultados/` (k6, sonda, eventos, integridad, logs, docker stats).
7. **Análisis**: `python pruebas\analisis\rto.py ...` y `python pruebas\analisis\por_etapa.py ...` generan las tablas en formato Markdown para el informe.

**Equipo de ejecución.** Se registra el hardware del computador donde se ejecutan (CPU, RAM, recursos asignados a Docker Desktop), porque los resultados de capacidad (escenarios 3 y 4) dependen de él.

## 8. Pruebas preliminares de validación (25/11)

Antes de cerrar el plan se validaron los mecanismos de HA en un laboratorio local que ejecuta los mismos servicios y configuraciones sin contenedores (procesos reales de PostgreSQL 16, Pgpool-II 4.3 con watchdog, Redis 7 Cluster de 6 nodos, HAProxy 2.8, y los módulos A, B y C). Los valores son indicativos: la ejecución oficial será sobre Docker.

| Prueba | Carga | Resultado |
|---|---|---|
| Kill `modulo-b-1`, un gateway y `modulo-c-1` (secuencial) | 500 pedidos, 8 concurrentes | **500/500 OK**, 0 errores, p99 = 0,16 s, integridad 500 = 500 = 500 |
| Kill del primario PostgreSQL — replicación **asíncrona** (2 corridas) | 600 pedidos, 6 concurrentes | 600/600 OK al cliente, promoción en 0,19–0,22 s. En una de las dos corridas: **599 en PostgreSQL → RPO = 1** (ver hallazgo 1) |
| Kill del primario PostgreSQL — replicación **semisíncrona** | 600 pedidos, 6 concurrentes | **600/600 OK y 600 en PostgreSQL → RPO = 0**, promoción en 0,23 s, latencia máx. 3,2 s |
| Kill de la réplica PostgreSQL (semisíncrona) | 500 pedidos, 6 concurrentes | **500/500 OK**, el primario pasa a asíncrono en < 1 s, latencia máx. 0,43 s; al volver la réplica, failback automático a semisíncrono |
| Kill del primario PostgreSQL (acceso directo, sin reintentos) | 1 inserción cada 200 ms | 1 inserción fallida, corte ≈ 0,3 s |
| Reinicio del ex-primario | — | Reincorporado como réplica automáticamente y re-agregado por Pgpool en < 30 s |
| Kill de un maestro Redis | 1 escritura cada 200 ms directo al Módulo C | 1/100 fallida (bloqueo de 4 s en el shard caído), réplica promovida, evento registrado |
| Kill de 1 gateway (sonda) | 1 pedido cada 200 ms | 0 fallos, p99 = 113 ms (reintento de HAProxy) |
| Kill de **ambos** gateways por 3 s (sonda) | 1 pedido cada 200 ms | RTO observado = 4,2–4,4 s (3 s caídos + ≈ 1,4 s hasta 2 health checks OK) |
| Ráfaga desde la interfaz | 50 y 120 pedidos | 0 errores, reparto exacto 25/25 por réplica en cada capa |

**Hallazgos que ya produjeron cambios en el diseño:**

1. **Pérdida de una transacción confirmada con replicación asíncrona.** Al matar el primario, un commit ya confirmado al cliente no alcanzó a llegar a la réplica; tras la promoción y la reincorporación del ex-primario (que se re-clona), ese pedido desapareció (600 confirmados, 599 persistidos). Se cambió a **replicación semisíncrona con degradación automática**: el primario confirma solo cuando la réplica recibió el commit (`synchronous_standby_names='*'`); si la réplica cae, `failover.sh` lo pasa a asíncrono para no bloquear escrituras, y `failback.sh` restablece el modo semisíncrono cuando la réplica vuelve. Tras el cambio: RPO = 0.
2. **Falla en cascada por health check bloqueado.** Al caer `modulo-b-1`, toda la carga pasó a `modulo-b-2`; su `/health` era síncrono y esperaba en el mismo pool de hilos que las peticiones a la BD, dejó de responder y HAProxy lo retiró también: caída total del dominio. Se corrigió haciendo `/health` asíncrono (event loop) y limitando el pool de conexiones con un semáforo que hace esperar en vez de fallar. Tras el cambio: 500/500 OK.
3. **Dimensionamiento de Pgpool.** Si la suma de los pools de los clientes supera `num_init_children`, Pgpool encola en silencio y la latencia sube a > 10 s. Regla adoptada: `num_init_children (64) ≥ Σ DB_POOL_MAX de las réplicas de B (2 × 20)`, considerando que si cae un Pgpool todas las conexiones van al otro.
4. **Codificación.** Nombres con tilde fallaban si la base no era UTF-8; se fuerza `client_encoding=UTF8` en el cliente.
5. **Clave de partición e idempotencia.** PostgreSQL exige que la clave de partición forme parte de toda restricción `UNIQUE`; por eso se particiona por `HASH(request_id)` y no por `pedido_id`, lo que permite a la vez la idempotencia de los reintentos.
6. **Estado persistido de Pgpool.** Si un contenedor de Pgpool se reinicia mientras un nodo está caído, el archivo `pgpool_status` lo dejaba marcado *down* aunque se recuperara. Pgpool arranca ahora con `-D` y vuelve a detectar el estado real.

## 9. Riesgos y limitaciones conocidas

| Riesgo / limitación | Impacto | Mitigación / cómo se documenta |
|---|---|---|
| Todo corre en un solo computador (Docker Desktop) | Las "particiones" son simuladas y la capacidad depende del equipo | Registrar hardware; las particiones se hacen sobre redes virtuales reales |
| Replicación semisíncrona con 2 nodos | Mientras la réplica está caída, el primario opera en asíncrono: si **ambos** fallan en esa ventana se pueden perder los últimos commits. Además, entre la caída de la réplica y su detección (≈ 1–8 s) las escrituras esperan | Se mide la latencia en el escenario de caída de la réplica; un tercer nodo PostgreSQL eliminaría la ventana |
| Health checks de tipo *liveness* | Una réplica viva pero sin acceso a su BD, o muy lenta, sigue en el pool | Es deliberado (evita fallas en cascada); los reintentos del Gateway cubren el caso. Se evidencia en 2c y 2e |
| Watchdog de Pgpool con 2 instancias | Con `enable_consensus_with_half_votes`, 1 voto basta; no protege una partición entre Pgpools | Documentado; la solución completa usa 3 instancias |
| Sin IP virtual en la entrada | Si cae `lb-1`, un cliente externo (no el SPA) debe usar `:8081` | El SPA cambia solo de entrada; en producción se usaría VRRP/keepalived o un balanceador de nube |
| `pedido_id` con saltos tras un failover | Las secuencias se pre-asignan en bloques de 32 | No es pérdida de datos; la integridad se verifica por `request_id` |

## 10. Cronograma

| Fecha | Actividad | Responsable |
|---|---|---|
| 25–27/11 | Plan de pruebas (este documento), scripts y validación preliminar | Equipo |
| 28/11–02/12 | Levantar el stack completo en Docker, corregir problemas de entorno, capturas de la interfaz | Equipo |
| 03–04/12 | Ejecución de escenarios 1 y 2 (3 repeticiones c/u) | Por definir |
| 05–06/12 | Ejecución de escenarios 3 y 4 (3 repeticiones c/u) | Por definir |
| 07–08/12 | Análisis, tablas, gráficos e informe final; ensayo de la defensa | Equipo |
| 09/12 | Demostración en vivo (escenario 1 completo + 2d desde la interfaz) | Equipo |

## 11. Plantillas de tablas para el informe final

**Tabla A — Recuperación por falla (escenarios 1 y 2)** — generada por `rto.py`

| Falla inyectada | Fallos cliente | Detección (ms) | RTO (ms) | Latencia máx. (ms) | Códigos |
|---|---|---|---|---|---|

**Tabla B — Resumen por escenario** — desde `k6-<lote>.txt`

| Escenario | Repetición | Confirmados | Fallidos | Errores 5xx % | TPS | p50 | p95 | p99 | Reintentos internos | RPO |
|---|---|---|---|---|---|---|---|---|---|---|

**Tabla C — Capacidad por etapa (escenarios 3 y 4)** — generada por `por_etapa.py`

| Intervalo | VUs | Req/s | TPS pedidos | p50 ms | p95 ms | p99 ms | Errores % | Estado |
|---|---|---|---|---|---|---|---|---|

**Tabla D — Uso de recursos en el pico** — desde `docker-stats-<lote>.csv`

| Contenedor | CPU % máx. | RAM máx. | Observación |
|---|---|---|---|
