#!/usr/bin/env bash
# =============================================================================
# Entrypoint HA para nodos PostgreSQL (pg-1 / pg-2)
#
# Decide el rol del nodo ANTES de arrancar PostgreSQL:
#   1. Sin datos y el par es primario        -> se clona como réplica (pg_basebackup)
#   2. Sin datos y INITIAL_ROLE=standby      -> espera al primario y se clona
#   3. Sin datos y INITIAL_ROLE=primary      -> initdb normal (docker-entrypoint.sh)
#   4. Con datos, era primario, pero el par
#      ya es primario (hubo failover)        -> ex-primario obsoleto: se descarta
#                                               su copia y se reincorpora como réplica
#   5. Con datos en cualquier otro caso      -> arranca tal cual
#
# El caso 4 evita el "split-brain": un primario caído que vuelve nunca
# compite con el nodo que Pgpool-II promovió mientras estaba abajo.
# =============================================================================
set -euo pipefail

PGDATA="${PGDATA:-/var/lib/postgresql/data}"
PGPORT="${PGPORT:-5432}"
PEER_HOST="${PEER_HOST:?Debe definir PEER_HOST}"
PEER_PORT="${PEER_PORT:-5432}"
INITIAL_ROLE="${INITIAL_ROLE:-standby}"
NODE_NAME="${NODE_NAME:-$(hostname)}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
REPL_USER="${REPLICATION_USER:-replicator}"
REPL_PASS="${REPLICATION_PASSWORD:-replicator}"
export PGPASSWORD="${POSTGRES_PASSWORD:-postgres}"
export PGCONNECT_TIMEOUT=3

log() { echo "[ha-entrypoint][$NODE_NAME] $(date -u +%FT%TZ) $*"; }

as_postgres() {
  if [ "$(id -u)" = "0" ]; then gosu postgres "$@"; else "$@"; fi
}

# Devuelve: primary | standby | down
peer_role() {
  local r
  r=$(psql -h "$PEER_HOST" -p "$PEER_PORT" -U "$POSTGRES_USER" -d postgres \
           -tAc "SELECT pg_is_in_recovery()" 2>/dev/null) || { echo down; return; }
  if [ "$r" = "f" ]; then echo primary; else echo standby; fi
}

clone_from_peer() {
  log "Clonando datos desde el primario $PEER_HOST:$PEER_PORT (pg_basebackup)..."
  mkdir -p "$PGDATA"
  find "$PGDATA" -mindepth 1 -delete
  if [ "$(id -u)" = "0" ]; then chown postgres:postgres "$PGDATA"; fi
  chmod 700 "$PGDATA"
  until as_postgres env PGPASSWORD="$REPL_PASS" pg_basebackup \
          -h "$PEER_HOST" -p "$PEER_PORT" -U "$REPL_USER" \
          -D "$PGDATA" -X stream -c fast; do
    log "pg_basebackup falló; reintentando en 3s..."
    find "$PGDATA" -mindepth 1 -delete
    sleep 3
  done
  # Configuración de réplica: conexión de streaming hacia el par.
  # application_name = NODE_NAME para que Pgpool-II (auto_failback) reconozca el nodo.
  cat >> "$PGDATA/postgresql.auto.conf" <<EOF
primary_conninfo = 'host=$PEER_HOST port=$PEER_PORT user=$REPL_USER password=$REPL_PASS application_name=$NODE_NAME'
EOF
  as_postgres touch "$PGDATA/standby.signal"
  log "Clonación terminada: el nodo arrancará como RÉPLICA de $PEER_HOST"
}

if [ -s "$PGDATA/PG_VERSION" ]; then
  if [ ! -f "$PGDATA/standby.signal" ]; then
    role=$(peer_role)
    if [ "$role" = "primary" ]; then
      log "Este nodo era PRIMARIO pero $PEER_HOST ya fue promovido (failover). Reincorporando como réplica."
      clone_from_peer
    else
      log "Arrancando como PRIMARIO con datos existentes (par: $role)"
    fi
  else
    log "Arrancando como RÉPLICA con datos existentes"
  fi
else
  role=$(peer_role)
  if [ "$role" = "primary" ]; then
    clone_from_peer
  elif [ "$INITIAL_ROLE" = "standby" ]; then
    log "Esperando a que $PEER_HOST esté disponible como primario..."
    until [ "$(peer_role)" = "primary" ]; do sleep 2; done
    clone_from_peer
  else
    log "Inicialización como PRIMARIO (initdb)"
  fi
fi

exec docker-entrypoint.sh "$@"
