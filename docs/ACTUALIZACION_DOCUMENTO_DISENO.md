# Actualización del Documento de Diseño U3 — TechOrders

Textos listos para reemplazar o completar en `[SD] Documento de Diseño U3`. Reflejan lo que está **implementado y probado** en la rama `unidad-3`.

## 0. Cambios respecto a la versión del 20/11

| Tema | Versión 20/11 | Versión actual | Motivo |
|---|---|---|---|
| Balanceadores | 1 NGINX (`nginx-lb`) para entrada e interno | **2 HAProxy de entrada** (`lb-1` :8080, `lb-2` :8081) y **2 HAProxy internos** (`lb-int-1`, `lb-int-2`) | La pauta exige health checks **activos**; NGINX de código abierto solo tiene chequeos pasivos (los activos son de NGINX Plus). Además, un único balanceador seguía siendo un SPOF |
| Réplicas de B y C | 2 en el texto, "x3" en el diagrama | **2 réplicas** de A, B y C | Consistencia; la pauta pide 2 o 3 |
| Puerto del Módulo A | 8080 público | 8080 **interno** (sin publicar); el puerto público lo tienen los balanceadores | El puerto 8080 del host lo ocupa `lb-1` |
| Pgpool-II | 1 instancia | **2 instancias con watchdog** (`pgpool-1`, `pgpool-2`) | Pgpool único era un SPOF |
| Replicación PostgreSQL | "sincronizada" | **Semisíncrona con degradación automática** | Con replicación asíncrona se perdió 1 pedido confirmado al matar el primario. La síncrona pura bloquea las escrituras si cae la réplica; la degradación automática evita ese bloqueo |
| Redis | "Cluster/Sentinel", 2 nodos | **Redis Cluster de 6 nodos** (3 maestros + 3 réplicas) | Sentinel necesita ≥ 3 sentinels y no particiona; Cluster necesita ≥ 3 maestros. Cluster da elección **y** sharding |
| Particionamiento PostgreSQL | HASH por id del pedido | **HASH por `request_id`** (UUID de la transacción) | En PostgreSQL toda restricción UNIQUE debe incluir la clave de partición; así `request_id` es a la vez clave de partición e idempotencia |
| Claves de auditoría | `log:<fecha>-<contador en memoria>` | `log:<request_id>` | El contador en memoria colisionaba entre réplicas (pérdida de trazas) y violaba el diseño stateless |

## 1. Introducción — párrafo corregido

> Todos los componentes críticos pasan a ejecutarse con al menos dos instancias activas: dos balanceadores de entrada, dos réplicas de cada módulo de aplicación (A, B y C), dos balanceadores internos, dos instancias de Pgpool-II, un clúster PostgreSQL primario-réplica y un Redis Cluster de seis nodos. Las réplicas de aplicación operan en modo activo-activo y sin estado, por lo que cualquiera puede atender cualquier petición; ante la caída de una, el tráfico se redirige automáticamente a las restantes sin intervención manual.

## 2. Módulos — textos corregidos

**Módulo Balanceador y Reverse Proxy**
- *Réplicas:* `lb-1`, `lb-2` (entrada, `red-frontend`); `lb-int-1`, `lb-int-2` (internos, `red-servicios`).
- *Tecnología:* HAProxy 3.0.
- *Puertos:* `lb-1` → 8080 y `lb-2` → 8081 publicados al host (estadísticas en 8404/8405). Los internos exponen :5000 (→ Módulo B) y :6000 (→ Módulo C) solo dentro de `red-servicios`.
- *Justificación:* **Round Robin** en la entrada (gateways homogéneos: reparto exacto y predecible) y **Least Connections** en los internos (el costo de cada llamada a B/C varía; con +300 ms en una réplica, Round Robin le envió el 47 % del tráfico y Least Connections el 19 %), ambos con **health checks activos** (`GET /health` cada 2 s; 2 fallos sacan al servidor del pool y 2 éxitos lo reincorporan), reintento L7 automático en otro servidor si la conexión falla y re-resolución DNS de los contenedores. Si cae `lb-1`, la interfaz cambia sola a `lb-2`.

**Módulo A** — *Puerto:* 8080 interno (no publicado). Recibe tráfico solo desde `lb-1`/`lb-2`. Pertenece a `red-frontend` y `red-servicios`.

**Motor de Base de Datos 1** — *Réplicas:* `pg-1`, `pg-2` (PostgreSQL 16) y `pgpool-1`, `pgpool-2` (Pgpool-II con watchdog). *Puerto:* 5432 en cada Pgpool; el Módulo B se conecta con libpq multi-host `host=pgpool-1,pgpool-2`.

**Motor de Base de Datos 2** — *Réplicas:* `redis-1` … `redis-6` (Redis 7.4 Cluster: 3 maestros + 3 réplicas, IPs fijas 172.29.30.11–16). *Puerto:* 6379.

**Pertenencia a redes**

| Contenedor | red-frontend | red-servicios | red-datos |
|---|:-:|:-:|:-:|
| lb-1, lb-2 | ✔ | | |
| modulo-a-1, modulo-a-2 | ✔ | ✔ | |
| lb-int-1, lb-int-2 | | ✔ | |
| modulo-b-*, modulo-c-* | | ✔ | ✔ |
| pgpool-*, pg-*, redis-* | | | ✔ |

`red-servicios` y `red-datos` se declaran `internal: true`: no tienen salida a Internet ni acceso desde el host.

## 3. Estrategia de Alta Disponibilidad (texto completo)

Para garantizar la continuidad operativa de TechOrders ante caídas de contenedores, degradación de red o pérdida de nodos de base de datos, la arquitectura elimina todo punto único de falla mediante redundancia activa en cada capa y conmutación automática, sin reiniciar aplicaciones.

**3.1. Balanceo de carga y health checks.** Los balanceadores HAProxy distribuyen el tráfico con Round Robin en la entrada y Least Connections en la capa interna, y ejecutan health checks **activos**: cada 2 s envían `GET /health` a cada réplica; tras 2 fallos consecutivos la retiran del pool y tras 2 éxitos la reincorporan (al detectar una falla, el intervalo baja a 500 ms). Si una petición falla al conectar o el servidor muere a mitad de la respuesta, HAProxy la reintenta en otra réplica (`retry-on conn-failure empty-response`, `option redispatch`). Los nombres de los contenedores se re-resuelven contra el DNS de Docker cada 5 s, de modo que un contenedor reiniciado con otra IP vuelve al pool sin recargar la configuración.

Cada servicio expone `/health` como prueba de **vida (liveness)**: responde 200 mientras el proceso atiende, e informa el estado de su base de datos sin fallar por ella. Es deliberado: si el health check dependiera de la base de datos, una falla de PostgreSQL retiraría todas las réplicas del Módulo B a la vez y agravaría la caída. En el Módulo B el endpoint es asíncrono para no competir con las peticiones que esperan conexión a la BD; en las pruebas preliminares, la versión síncrona provocó una falla en cascada.

| Servicio | Endpoint | Respuesta |
|---|---|---|
| Módulo A | `GET /health` | `{"modulo":"modulo-a-gateway","status":"UP","nodo":"modulo-a-1","uptime_seg":38}` |
| Módulo B | `GET /health` | `{"status":"UP","modulo":"modulo-b-dominio","nodo":"modulo-b-1","uptime_seg":376}` |
| Módulo C | `GET /health` | `{"modulo":"modulo-c-auditoria","status":"UP","nodo":"modulo-c-1","redis":"UP","uptime_seg":752}` |
| HAProxy | `GET :8404/lb-health` | 200 |

**3.2. Diseño stateless y trazabilidad.** Ninguna réplica guarda sesiones, contadores ni archivos locales: todo el estado vive en PostgreSQL y Redis. Cada contenedor obtiene su identificador desde `NODE_NAME`/`HOSTNAME` y lo devuelve en el encabezado `X-Served-By`/`X-Node` y en el JSON de respuesta, lo que permite saber qué balanceador, gateway y réplicas de B y C procesaron cada fase. El pedido guarda además `nodo_gateway` y `nodo_dominio`, y la traza de auditoría guarda `nodo_auditoria`.

**3.3. Tolerancia a fallos en la comunicación interna.** El Gateway llama a B y C a través de los balanceadores internos con un timeout de 3 s por intento y hasta 5 intentos con *exponential backoff* y *jitter* (esperas base de 200, 400, 800 y 1.600 ms, con tope de 2 s), alternando entre `lb-int-1` y `lb-int-2`. Se reintenta ante errores de red, timeouts y respuestas 502/503/504; los errores 4xx no se reintentan. Para que reintentar sea seguro, cada pedido tiene un `request_id` (UUID) que se conserva en todos los reintentos: el Módulo B inserta con `ON CONFLICT (request_id) DO NOTHING` y el Módulo C con `SET NX`, por lo que un reintento nunca duplica un pedido ni una traza. El `request_id` lo genera el balanceador de entrada (`X-Request-Id`) o el cliente (`Idempotency-Key`).

**3.4. Failover automático de PostgreSQL.** `pg-1` y `pg-2` replican por streaming replication **semisíncrona**: el primario confirma un commit al cliente solo cuando la réplica ya lo recibió (`synchronous_standby_names = '*'`), por lo que una caída del primario no pierde transacciones confirmadas (RPO = 0). Si cae la réplica, Pgpool-II pasa el primario a asíncrono para no bloquear las escrituras y lo vuelve a semisíncrono cuando la réplica se reincorpora. Dos instancias de Pgpool-II con watchdog vigilan los nodos (health check cada 2 s, y detección inmediata ante error de conexión con `failover_on_backend_error`). Si cae el primario, el líder del watchdog ejecuta `failover.sh`, que promueve la réplica con `SELECT pg_promote()` por la red y registra el evento en la tabla `ha_eventos`. Pgpool cierra las sesiones afectadas y el Módulo B reintenta con backoff sobre la nueva topología, sin reiniciarse. Cuando el ex-primario vuelve, su script de arranque detecta que el otro nodo ya es primario, descarta su copia obsoleta, se re-clona con `pg_basebackup` y arranca como réplica; Pgpool lo reincorpora solo (`auto_failback`). `detach_false_primary` evita que dos primarios atiendan a la vez (split-brain). El Módulo B se conecta con libpq multi-host (`pgpool-1,pgpool-2`), así que la caída de un Pgpool tampoco interrumpe el servicio. *Medido en laboratorio:* promoción en 0,23 s y 600/600 pedidos confirmados y persistidos durante la caída del primario (RPO = 0); 500/500 durante la caída de la réplica.

**3.5. Failover automático de Redis.** Redis Cluster con 3 maestros y 3 réplicas. Si un maestro no responde durante `cluster-node-timeout` (5 s), su réplica es elegida maestro por votación de los demás maestros. El cliente `go-redis ClusterClient` del Módulo C recibe las redirecciones `MOVED`, recarga la topología y reintenta (hasta 6 veces con backoff), sin reiniciarse. Durante la elección solo se afectan las claves del shard caído; los otros dos siguen atendiendo (`cluster-require-full-coverage no`). El Módulo C detecta el cambio de maestros con un `GETSET` atómico sobre `ha:redis:maestros` y lo registra en `ha:redis:eventos`, que muestra el Health Dashboard.

**3.6. Resumen de eliminación de SPOF**

| Componente | Instancias | Si cae una instancia… |
|---|---|---|
| Balanceador de entrada | 2 | El SPA usa la otra entrada (:8081) |
| API Gateway | 2 | HAProxy reintenta en la otra réplica; el cliente no ve error |
| Balanceador interno | 2 | El Gateway alterna al otro en el siguiente intento |
| Dominio / Auditoría | 2 + 2 | HAProxy la retira del pool; el Gateway reintenta |
| Pgpool-II | 2 | libpq usa el otro host |
| PostgreSQL | 2 | Promoción automática de la réplica |
| Redis | 6 | La réplica del shard es elegida maestro |

## 4. Estrategia de Escalabilidad (texto completo)

**4.1. Escalabilidad horizontal de los microservicios.** Como las réplicas no guardan estado, agregar capacidad consiste en declarar un nuevo servicio en `docker-compose.yml` (por ejemplo `modulo-b-3`) y una línea `server` en el backend correspondiente de HAProxy. No se modifica el código. Al aumentar réplicas del Módulo B se debe respetar `num_init_children` de Pgpool (64) ≥ Σ `DB_POOL_MAX` de las réplicas.

**4.2. Particionamiento nativo en PostgreSQL.** La tabla `pedidos` se particiona por **HASH** sobre `request_id` en 4 particiones. Cada inserción cae en una partición según el hash del UUID, lo que reparte uniformemente las escrituras concurrentes y mantiene índices B-Tree más pequeños por partición. Las consultas por `request_id` (idempotencia) leen una sola partición (*partition pruning*). Se eligió `request_id` y no `pedido_id` como clave porque PostgreSQL exige que toda restricción `PRIMARY KEY`/`UNIQUE` de una tabla particionada incluya la clave de partición: así la misma columna sirve para repartir y para garantizar la idempotencia.

```sql
CREATE TABLE pedidos (
    request_id    UUID          NOT NULL,
    pedido_id     BIGSERIAL     NOT NULL,
    cliente       VARCHAR(100)  NOT NULL,
    producto      VARCHAR(100)  NOT NULL,
    precio        INTEGER       NOT NULL CHECK (precio > 0),
    pago          VARCHAR(50)   NOT NULL,
    estado        VARCHAR(30)   NOT NULL DEFAULT 'RECIBIDO',
    lote          VARCHAR(64),
    nodo_gateway  VARCHAR(64),
    nodo_dominio  VARCHAR(64)   NOT NULL,
    creado_en     TIMESTAMPTZ   NOT NULL DEFAULT now(),
    PRIMARY KEY (request_id)
) PARTITION BY HASH (request_id);

CREATE TABLE pedidos_p0 PARTITION OF pedidos FOR VALUES WITH (MODULUS 4, REMAINDER 0);
CREATE TABLE pedidos_p1 PARTITION OF pedidos FOR VALUES WITH (MODULUS 4, REMAINDER 1);
CREATE TABLE pedidos_p2 PARTITION OF pedidos FOR VALUES WITH (MODULUS 4, REMAINDER 2);
CREATE TABLE pedidos_p3 PARTITION OF pedidos FOR VALUES WITH (MODULUS 4, REMAINDER 3);

CREATE INDEX idx_pedidos_pedido_id ON pedidos (pedido_id DESC);  -- se crea en cada partición
```

*Medido:* 500 pedidos de una prueba quedaron repartidos 138 / 117 / 112 / 133 entre las 4 particiones.

Además, Pgpool-II balancea las **lecturas** (`SELECT`) entre el primario y la réplica (`load_balance_mode`), mientras las escrituras van siempre al primario. Las consultas de verificación de integridad usan `/*NO LOAD BALANCE*/` para leer del primario y evitar el retraso de replicación.

**4.3. Sharding horizontal en Redis Cluster.** Redis Cluster divide el espacio de claves en **16.384 hash slots**; cada clave se asigna al slot `CRC16(clave) mod 16384` y cada maestro es dueño de un rango (≈ 5.461 slots cada uno: 0–5460, 5461–10922, 10923–16383). Las trazas `log:<request_id>` se reparten así entre los 3 maestros y las ráfagas de escritura se procesan en paralelo. Para listar trazas sin el comando `KEYS` (que bloquea Redis y en un clúster solo ve un nodo), el Módulo C mantiene 16 índices ordenados `audit:idx:{0..15}`; el *hash tag* `{n}` fija el slot de cada índice, de modo que también quedan repartidos entre los maestros. El listado consulta los 16 índices en paralelo y mezcla los resultados. Para escalar se agrega un nuevo par maestro-réplica y se migra una parte de los slots con `redis-cli --cluster reshard`. *Medido:* 18 / 19 / 20 claves por maestro con 57 trazas; ~650–710 con 2.000.

## 5. Contratos de interfaces actualizados

### 5.1 `POST /api/pedidos` (Cliente → lb-1/lb-2 → Módulo A)

Request (opcionalmente con encabezado `Idempotency-Key: <uuid>`):

```json
{ "cliente": "Esteban Padilla", "producto": "Teclado Mecánico", "precio": 14990, "pago": "Debito", "lote": "rafaga-20261125172245" }
```

Response 200 (real, del laboratorio; en Docker `balanceador_entrada` es `lb-1` o `lb-2`):

```json
{
  "status": "PROCESADO",
  "mensaje": "Pedido recibido, auditado y registrado correctamente",
  "request_id": "0921ba9c-a472-4b1b-b74c-fc4cfc7edf7b",
  "data": { "pedido_id": 2273, "cliente": "Esteban Padilla", "producto": "Teclado Mecánico",
            "precio": 14990, "pago": "Debito", "lote": null,
            "fecha_creacion": "2026-11-25T14:29:47.705774-03:00" },
  "auditoria": { "log_key": "log:0921ba9c-a472-4b1b-b74c-fc4cfc7edf7b", "estado": "Auditado" },
  "trazabilidad": {
    "balanceador_entrada": "lb-1",
    "gateway": "modulo-a-2",
    "auditoria": { "balanceador_interno": "lb-int-2", "nodo": "modulo-c-2", "nodo_persistencia": "modulo-c-2", "intentos": 1 },
    "dominio":   { "balanceador_interno": "lb-int-2", "nodo": "modulo-b-1", "nodo_persistencia": "modulo-b-1", "intentos": 1, "duplicado": false }
  },
  "latencia_ms": 16
}
```

Encabezados de respuesta: `X-Served-By` (gateway), `X-LB-Node` (balanceador de entrada), `X-Request-Id`.
`intentos > 1` indica que el Gateway reintentó; `duplicado: true` indica que era un reintento de un pedido ya persistido (idempotencia).

Errores:

```json
// 400 - payload inválido
{ "status": "ERROR", "error_code": "INVALID_PAYLOAD", "mensaje": "Los campos 'cliente', 'producto', 'precio' (entero > 0) y 'pago' son requeridos" }

// 502 - una fase falló tras agotar los reintentos
{ "status": "ERROR", "fase": "DOMINIO", "request_id": "…", "mensaje": "No se pudo registrar el pedido en el servicio de dominio",
  "detalle": "dominio no disponible tras 5 intentos: …", "intentos": [ { "intento": 1, "lb": "lb-int-1", "status": 503, "ms": 12 }, … ],
  "trazabilidad": { … }, "latencia_ms": 4210 }
```

### 5.2 `GET /api/cluster-status` (Health Dashboard)

Consolida, en una llamada, el estado de cada capa. Abreviado (una instancia por capa):

```json
{
  "timestamp": "2026-11-25T17:29:47.849Z",
  "consultado_por": "modulo-a-2",
  "latencia_ms": 114,
  "balanceadores_entrada": { "activos": 2, "total": 2, "nodos": [
    { "nombre": "lb-1", "estado": "UP", "latencia_ms": 17,
      "vista": { "gateways": [ { "servidor": "modulo-a-1", "estado": "UP", "peticiones": 772, "chequeo": "L7OK" },
                               { "servidor": "modulo-a-2", "estado": "UP", "peticiones": 577, "chequeo": "L7OK" } ] } } ] },
  "gateways":               { "activos": 2, "total": 2, "nodos": [ { "nombre": "modulo-a-1", "estado": "UP", "latencia_ms": 16, "detalle": { "uptime_seg": 38 } } ] },
  "balanceadores_internos": { "activos": 2, "total": 2, "nodos": [ { "nombre": "lb-int-1", "estado": "UP",
      "vista": { "modulo_b": [ { "servidor": "modulo-b-1", "estado": "UP", "peticiones": 335, "chequeo": "L7OK" } ],
                 "modulo_c": [ { "servidor": "modulo-c-1", "estado": "UP", "peticiones": 456, "chequeo": "L7OK" } ] } } ] },
  "dominio":   { "activos": 2, "total": 2, "nodos": [ { "nombre": "modulo-b-1", "estado": "UP", "latencia_ms": 16 } ] },
  "auditoria": { "activos": 2, "total": 2, "nodos": [ { "nombre": "modulo-c-1", "estado": "UP", "latencia_ms": 17 } ] },
  "postgresql": {
    "estado": "OK", "primario": "pg-2", "timeline": 3,
    "pgpool": [ { "host": "pgpool-1:5432", "estado": "UP", "latencia_ms": 39.4 }, { "host": "pgpool-2:5432", "estado": "UP", "latencia_ms": 44.9 } ],
    "nodos": [ { "id": "0", "host": "pg-1", "estado": "UP", "rol": "standby", "estado_replicacion": "streaming", "retraso_replicacion": "0", "lecturas": "21" },
               { "id": "1", "host": "pg-2", "estado": "UP", "rol": "primary", "lecturas": "76" } ],
    "eventos": [ { "ocurrido_en": "2026-11-25T14:17:25-03:00", "tipo": "FAILOVER", "nodo_caido": "pg-1", "nuevo_primario": "pg-2",
                   "detectado_por": "pgpool-2", "detalle": "promocion en 0.22s" } ]
  },
  "redis": {
    "estado": "OK", "maestros": 3, "current_epoch": "7",
    "nodos": [ { "addr": "172.29.30.11:6379", "rol": "replica", "estado": "UP", "claves": 787 },
               { "addr": "172.29.30.12:6379", "rol": "maestro", "estado": "UP", "slots": "5461-10922", "claves": 771 } ],
    "eventos": [ { "tipo": "FAILOVER", "maestros_antes": "…11,…12,…13", "maestros_ahora": "…12,…13,…14", "nodos_con_falla": "172.29.30.11:6379" } ]
  },
  "eventos_failover": [ "… eventos de PostgreSQL y Redis ordenados por fecha …" ]
}
```

`vista` es el estado que cada balanceador asigna a sus servidores según sus health checks activos (leído de la página de estadísticas de HAProxy). `timeline` aumenta en 1 con cada promoción de PostgreSQL.

### 5.3 `GET /api/integridad?lote=X` (verificación de pruebas)

```json
{ "lote": "caos4", "pedidos_postgresql": 500, "trazas_redis": 500, "trazas_sin_pedido": 0,
  "distribucion": { "dominio": { "modulo-b-1": 67, "modulo-b-2": 433 }, "auditoria": { "modulo-c-1": 203, "modulo-c-2": 297 },
                    "gateway": { "modulo-a-1": 133, "modulo-a-2": 367 },
                    "particiones_postgresql": { "pedidos_p0": 138, "pedidos_p1": 117, "pedidos_p2": 112, "pedidos_p3": 133 } } }
```

### 5.4 Contratos internos (cambios)

| Llamada | Request agrega | Response agrega |
|---|---|---|
| A → C `POST /logs` | `request_id`, `nodo_gateway`, `pago`, `lote` | `nodo`, `nodo_auditoria`, `duplicado`; `log_id` = `log:<request_id>` |
| A → B `POST /procesar-pedido` | `request_id`, `lote`, `nodo_gateway` | `request_id`, `nodo`, `nodo_dominio`, `duplicado` |
| A → B `GET /cluster/db` | — | estado de Pgpool, nodos PostgreSQL, eventos y timeline |
| A → C `GET /cluster/redis` | — | nodos, slots, claves por nodo y eventos de failover |
| A → B/C `GET /pedidos/stats`, `/logs/stats` | `?lote=` | conteos y distribución por réplica |

## 6. Diagramas

- Topología extendida: `docs/diagramas/topologia-u3.png` (fuente editable `topologia-u3.mmd`). Para mantener el estilo del documento, basta actualizar `diagrama_u3.drawio` con: 2 HAProxy de entrada, 2 HAProxy internos, 2 réplicas de B y C (no 3), 2 Pgpool y Redis Cluster de 6 nodos.
- Secuencia extendida: `docs/diagramas/secuencia-u3.png` (fuente `secuencia-u3.mmd`).
- Capturas de la interfaz: `docs/capturas/`.

## 7. Diseño y prototipo de la interfaz (texto completo)

La interfaz evoluciona a una SPA servida por el API Gateway (`modulo-a/public/`: `index.html`, `app.js`, `styles.css`), sin dependencias externas, de modo que la demostración funciona aunque no haya Internet. Mantiene la identidad visual de la versión anterior (paleta verde, cabecera con la marca, tablas con encabezado verde oscuro) y se organiza en dos pestañas: **Operación** y **Monitor de salud**. Cubre los tres requisitos de la pauta:

**1. Formulario individual y generador de ráfagas controladas.** El formulario registra un pedido y muestra su traza completa: balanceador de entrada → gateway → balanceador interno → réplica de C, y balanceador interno → réplica de B, con el número de intentos si hubo reintentos. El generador envía 10, 50 o una cantidad libre de pedidos (hasta 5.000) con una concurrencia configurable (hasta 100 peticiones simultáneas). Al terminar informa exitosos y fallidos, TPS, latencias p50/p95/p99 y la **distribución por réplica** en cada capa, lo que evidencia el Round Robin. El botón *Verificar integridad* compara lo confirmado al cliente con lo persistido en PostgreSQL y Redis, y muestra el reparto entre las 4 particiones.

**2. Historial y auditoría con la réplica que atendió cada petición.** La tabla de pedidos (PostgreSQL) muestra el **gateway** y el **nodo de dominio** que procesó cada pedido. La tabla de auditoría (Redis) muestra la clave, el evento, el **gateway** y el **nodo de auditoría**, con filtros por tipo de evento y por réplica construidos a partir de los datos reales. Si un dato de réplica no existe, se muestra "—": la interfaz nunca rellena un nombre de réplica.

**3. Health Dashboard en tiempo real.** Cada 2 s consulta `GET /api/cluster-status`:
- La **barra de estado** resume cada capa con un indicador verde (todas las réplicas activas), ámbar (degradada) o rojo (sin réplicas). Muestra también el primario PostgreSQL y el estado del Redis Cluster; si una base no puede consultarse, se informa *estado desconocido* en vez de un valor supuesto.
- El **Monitor de salud** muestra cada nodo con su latencia, cómo lo ven los health checks de cada HAProxy y cuántas peticiones le envió, los nodos PostgreSQL (rol, estado de replicación, retraso, *timeline*) y los nodos Redis (rol, hash slots, claves).
- El **historial de eventos** une los failover registrados por el servidor (promociones de PostgreSQL y cambios de maestro en Redis) con los cambios de estado que el propio SPA detecta entre consultas (caídas, recuperaciones, cambios de rol).
- Si el balanceador `lb-1` deja de responder, el SPA cambia automáticamente a `lb-2` (:8081) y lo registra como evento.

Capturas: `docs/capturas/01-operacion.png` (ráfaga de 100 pedidos con reparto 50/50 e integridad 100 = 100 = 100), `02-monitor-sano.png` y `03-monitor-falla.png` (caída de `modulo-b-1` detectada por ambos balanceadores internos).

*Nota de integración:* la interfaz combina la propuesta visual de la rama `Rama_Alonso` (indicadores con punto de color, formulario y ráfagas en una misma tarjeta, insignias de réplica, filtro por evento) con la lógica conectada al backend U3. Respecto de esa propuesta se corrigió que los indicadores mostraban valores fijos (por ejemplo "Mod B: 2/2" con el módulo caído) y que las tablas rellenaban nombres de réplica cuando el dato no existía; también se escapan los textos ingresados por el usuario antes de insertarlos en la página.
