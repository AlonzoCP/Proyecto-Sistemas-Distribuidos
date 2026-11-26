"""
Módulo B - Servicio de Dominio (Python / FastAPI) - TechOrders U3

Cambios respecto a la U2:
  * Conexión a PostgreSQL a través de Pgpool-II con libpq multi-host
    ("pgpool-1,pgpool-2"): si un Pgpool cae, la siguiente conexión usa el otro.
  * Pool de conexiones (ThreadedConnectionPool) en vez de una conexión por petición.
  * Reintentos con exponential backoff ante errores de conexión (failover de BD):
    la conexión rota se descarta y se reintenta sin reiniciar el servicio.
  * Idempotencia: INSERT ... ON CONFLICT (request_id) DO NOTHING. Un reintento del
    Gateway nunca duplica un pedido.
  * Trazabilidad: cada pedido guarda nodo_dominio (HOSTNAME de esta réplica).
  * Stateless: no guarda nada en memoria ni en disco del contenedor.
  * /cluster/db: estado de los nodos PostgreSQL vistos por Pgpool-II + eventos de failover.
"""
import logging
import os
import random
import socket
import threading
import time
import uuid
from contextlib import contextmanager
from typing import Optional

import psycopg2
import psycopg2.extras
from fastapi import FastAPI, HTTPException, Query
from psycopg2.pool import ThreadedConnectionPool
from pydantic import BaseModel, Field

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("modulo-b")

NODE = os.getenv("NODE_NAME") or socket.gethostname()
DB_HOSTS = os.getenv("DB_HOSTS", "pgpool-1,pgpool-2")
DB_PORT = os.getenv("DB_PORT", "5432")
DB_NAME = os.getenv("DB_NAME", "negocio_db")
DB_USER = os.getenv("DB_USER", "postgres")
DB_PASS = os.getenv("DB_PASSWORD", "postgres")
POOL_MAX = int(os.getenv("DB_POOL_MAX", "20"))
DB_RETRIES = int(os.getenv("DB_RETRIES", "6"))

hosts = [h.strip() for h in DB_HOSTS.split(",") if h.strip()]
_ports = [p.strip() for p in DB_PORT.split(",")]
ports = _ports if len(_ports) == len(hosts) else [_ports[0]] * len(hosts)
DSN = (
    f"host={','.join(hosts)} port={','.join(ports)} "
    f"dbname={DB_NAME} user={DB_USER} password={DB_PASS} "
    f"connect_timeout=3 application_name={NODE} client_encoding=UTF8 "
    "keepalives=1 keepalives_idle=5 keepalives_interval=2 keepalives_count=2"
)

psycopg2.extras.register_uuid()
app = FastAPI(title="Modulo B - Dominio")
_pool: Optional[ThreadedConnectionPool] = None
# ThreadedConnectionPool lanza error si se agota; el semáforo hace que las peticiones
# ESPEREN un cupo (hasta POOL_WAIT s) en vez de fallar de inmediato bajo carga.
_pool_slots = threading.BoundedSemaphore(POOL_MAX)
POOL_WAIT = float(os.getenv("DB_POOL_WAIT_S", "10"))
STARTED = time.time()


# --------------------------------------------------------------------------- acceso a BD

def get_pool() -> ThreadedConnectionPool:
    global _pool
    if _pool is None:
        _pool = ThreadedConnectionPool(1, POOL_MAX, DSN)
    return _pool


@contextmanager
def db_conn():
    if not _pool_slots.acquire(timeout=POOL_WAIT):
        raise HTTPException(status_code=503, detail="Servicio saturado: sin conexiones disponibles")
    try:
        pool = get_pool()
        conn = pool.getconn()
    except Exception:
        _pool_slots.release()
        raise
    broken = False
    try:
        yield conn
        conn.commit()
    except (psycopg2.OperationalError, psycopg2.InterfaceError):
        broken = True
        raise
    except Exception:
        try:
            conn.rollback()
        except Exception:
            broken = True
        raise
    finally:
        pool.putconn(conn, close=broken or conn.closed != 0)
        _pool_slots.release()


def with_retry(fn, desc: str):
    """Ejecuta fn(conn) reintentando con exponential backoff + jitter si la conexión
    falla (por ejemplo, durante un failover de PostgreSQL o la caída de un Pgpool)."""
    delay = 0.2
    for intento in range(1, DB_RETRIES + 1):
        try:
            with db_conn() as conn:
                return fn(conn)
        except (psycopg2.OperationalError, psycopg2.InterfaceError) as e:
            if intento == DB_RETRIES:
                log.error("[%s] %s falló tras %d intentos: %s", NODE, desc, intento, e)
                raise HTTPException(status_code=503, detail=f"Base de datos no disponible: {e}")
            espera = delay + random.uniform(0, delay / 2)
            log.warning("[%s] %s: error de conexión (intento %d/%d), reintento en %.2fs: %s",
                        NODE, desc, intento, DB_RETRIES, espera, str(e).strip())
            time.sleep(espera)
            delay = min(delay * 2, 3.0)
        except psycopg2.Error as e:
            log.error("[%s] %s: error SQL: %s", NODE, desc, e)
            raise HTTPException(status_code=500, detail=str(e))


@app.middleware("http")
async def add_node_header(request, call_next):
    response = await call_next(request)
    response.headers["X-Node"] = NODE
    return response


@app.on_event("startup")
def startup():
    for i in range(1, 31):
        try:
            with_retry(lambda c: c.cursor().execute("SELECT 1"), "conexión inicial")
            log.info("[%s] Conectado a PostgreSQL vía Pgpool-II (%s)", NODE, DB_HOSTS)
            return
        except Exception as e:  # noqa: BLE001
            log.warning("[%s] BD no disponible aún (%s). Reintento %d/30", NODE, e, i)
            time.sleep(2)


# --------------------------------------------------------------------------- modelos

class Pedido(BaseModel):
    request_id: Optional[uuid.UUID] = None
    cliente: str = Field(min_length=1, max_length=100)
    producto: str = Field(min_length=1, max_length=100)
    precio: int = Field(gt=0)
    pago: str = Field(min_length=1, max_length=50)
    timestamp: Optional[str] = None
    lote: Optional[str] = Field(default=None, max_length=64)
    nodo_gateway: Optional[str] = Field(default=None, max_length=64)


# --------------------------------------------------------------------------- endpoints

@app.post("/procesar-pedido")
def procesar_pedido(pedido: Pedido):
    rid = pedido.request_id or uuid.uuid4()

    def tx(conn):
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(
            """INSERT INTO pedidos (request_id, cliente, producto, precio, pago, estado,
                                    lote, nodo_gateway, nodo_dominio)
               VALUES (%s, %s, %s, %s, %s, 'RECIBIDO', %s, %s, %s)
               ON CONFLICT (request_id) DO NOTHING
               RETURNING pedido_id, nodo_dominio, creado_en""",
            (rid, pedido.cliente, pedido.producto, pedido.precio, pedido.pago,
             pedido.lote, pedido.nodo_gateway, NODE),
        )
        row = cur.fetchone()
        duplicado = row is None
        if duplicado:
            # Reintento de una petición ya persistida: devolver el pedido original
            cur.execute("SELECT pedido_id, nodo_dominio, creado_en FROM pedidos WHERE request_id = %s", (rid,))
            row = cur.fetchone()
        return row, duplicado

    row, duplicado = with_retry(tx, "insertar pedido")
    return {
        "status": "Procesado",
        "pedido_id": row["pedido_id"],
        "request_id": str(rid),
        "cliente": pedido.cliente,
        "producto": pedido.producto,
        "precio": pedido.precio,
        "pago": pedido.pago,
        "nodo": NODE,                          # réplica que atendió ESTA llamada
        "nodo_dominio": row["nodo_dominio"],   # réplica que persistió el pedido
        "duplicado": duplicado,
        "timestamp": row["creado_en"].isoformat(),
    }


@app.get("/pedidos")
def listar_pedidos(limit: int = Query(50, ge=1, le=500)):
    def q(conn):
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        # Lectura balanceada por Pgpool-II (puede atenderla la réplica)
        cur.execute(
            """SELECT pedido_id, request_id, cliente, producto, precio, pago, estado, lote,
                      nodo_gateway, nodo_dominio, creado_en
               FROM pedidos ORDER BY pedido_id DESC LIMIT %s""",
            (limit,),
        )
        return cur.fetchall()

    rows = with_retry(q, "listar pedidos")
    return [
        {**r, "request_id": str(r["request_id"]), "timestamp": r["creado_en"].isoformat(),
         "creado_en": r["creado_en"].isoformat()}
        for r in rows
    ]


@app.get("/pedidos/stats")
def stats_pedidos(lote: str):
    """Conteo y distribución por réplica de los pedidos de un lote (pruebas de integridad).
    Se fuerza la lectura en el PRIMARIO para no contar con retraso de replicación."""
    def q(conn):
        cur = conn.cursor()
        cur.execute("/*NO LOAD BALANCE*/ SELECT count(*) FROM pedidos WHERE lote = %s", (lote,))
        total = cur.fetchone()[0]
        cur.execute("/*NO LOAD BALANCE*/ SELECT nodo_dominio, count(*) FROM pedidos WHERE lote = %s GROUP BY 1", (lote,))
        por_dom = dict(cur.fetchall())
        cur.execute("/*NO LOAD BALANCE*/ SELECT coalesce(nodo_gateway,'?'), count(*) FROM pedidos WHERE lote = %s GROUP BY 1", (lote,))
        por_gw = dict(cur.fetchall())
        cur.execute("/*NO LOAD BALANCE*/ SELECT tableoid::regclass::text, count(*) FROM pedidos WHERE lote = %s GROUP BY 1 ORDER BY 1", (lote,))
        por_particion = dict(cur.fetchall())
        return total, por_dom, por_gw, por_particion

    total, por_dom, por_gw, por_part = with_retry(q, "stats lote")
    return {"lote": lote, "total_pedidos": total, "por_nodo_dominio": por_dom,
            "por_nodo_gateway": por_gw, "por_particion": por_part}


def _probe_pgpool(host: str, port: str) -> dict:
    """Verifica individualmente una instancia de Pgpool-II."""
    t0 = time.time()
    try:
        c = psycopg2.connect(host=host, port=port, dbname=DB_NAME, user=DB_USER,
                             password=DB_PASS, connect_timeout=2)
        try:
            cur = c.cursor()
            cur.execute("SHOW POOL_NODES")
            cols = [d[0] for d in cur.description]
            nodos = [dict(zip(cols, r)) for r in cur.fetchall()]
        finally:
            c.close()
        return {"host": f"{host}:{port}", "estado": "UP", "latencia_ms": round((time.time() - t0) * 1000, 1), "nodos": nodos}
    except Exception as e:  # noqa: BLE001
        return {"host": f"{host}:{port}", "estado": "DOWN", "error": str(e).strip()[:160], "nodos": []}


@app.get("/cluster/db")
def cluster_db():
    pgpools = [_probe_pgpool(h, p) for h, p in zip(hosts, ports)]
    vista = next((p for p in pgpools if p["estado"] == "UP"), None)

    nodos = []
    if vista:
        for n in vista["nodos"]:
            nodos.append({
                "id": n.get("node_id"),
                "host": n.get("hostname"),
                "estado": "UP" if n.get("status") in ("up", "waiting") else "DOWN",
                "pg_status": n.get("pg_status"),
                "rol": n.get("role"),
                "pg_rol": n.get("pg_role"),
                "lecturas": n.get("select_cnt"),
                "retraso_replicacion": n.get("replication_delay"),
                "estado_replicacion": n.get("replication_state"),
                "ultimo_cambio": n.get("last_status_change"),
            })

    eventos, timeline = [], None
    try:
        def q(conn):
            cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
            cur.execute("/*NO LOAD BALANCE*/ SELECT ocurrido_en, componente, tipo, nodo_caido, nuevo_primario, "
                        "detectado_por, detalle FROM ha_eventos ORDER BY id DESC LIMIT 20")
            ev = cur.fetchall()
            cur.execute("/*NO LOAD BALANCE*/ SELECT timeline_id FROM pg_control_checkpoint()")
            return ev, cur.fetchone()["timeline_id"]
        ev, timeline = with_retry(q, "eventos HA")
        eventos = [{**e, "ocurrido_en": e["ocurrido_en"].isoformat()} for e in ev]
    except HTTPException:
        pass

    primarios = [n for n in nodos if n["rol"] == "primary" and n["estado"] == "UP"]
    caidos = [n for n in nodos if n["estado"] != "UP"]
    if not vista or not primarios:
        estado = "DOWN"
    elif caidos or any(p["estado"] != "UP" for p in pgpools):
        estado = "DEGRADADO"
    else:
        estado = "OK"
    return {
        "estado": estado,
        "primario": primarios[0]["host"] if primarios else None,
        "timeline": timeline,   # aumenta en 1 con cada promoción (failover)
        "pgpool": [{k: v for k, v in p.items() if k != "nodos"} for p in pgpools],
        "nodos": nodos,
        "eventos": eventos,
        "consultado_por": NODE,
    }


@app.get("/health")
async def health_check():
    # Liveness. Es "async" a propósito: se atiende en el event loop y no en el pool de
    # hilos donde esperan las peticiones a la BD. Así una réplica saturada sigue
    # respondiendo su health check y el balanceador no la retira por error (lo que
    # provocaría una falla en cascada al pasar toda la carga a la otra réplica).
    # El estado de la BD se consulta en /cluster/db, no aquí.
    return {"status": "UP", "modulo": "modulo-b-dominio", "nodo": NODE,
            "uptime_seg": int(time.time() - STARTED)}
