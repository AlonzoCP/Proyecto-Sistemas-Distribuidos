#!/usr/bin/env bash
# =============================================================================
# failover_command de Pgpool-II
# Argumentos (ver pgpool.conf): %d %h %p %m %H %r %P %M
#   $1 FAILED_ID    nodo que falló          $5 NEW_MAIN_HOST  host candidato
#   $2 FAILED_HOST                          $6 NEW_MAIN_PORT
#   $3 FAILED_PORT                          $7 OLD_PRIMARY_ID primario antes de la falla
#   $4 NEW_MAIN_ID  nodo candidato          $8 OLD_MAIN_ID
#
# Si falló una RÉPLICA: no hay nada que promover (Pgpool la saca del pool).
# Si falló el PRIMARIO: se promueve la réplica con pg_promote() por la red
# (no requiere SSH) y se registra el evento en ha_eventos.
# =============================================================================
FAILED_ID="$1"; FAILED_HOST="$2"; FAILED_PORT="$3"
NEW_MAIN_ID="$4"; NEW_MAIN_HOST="$5"; NEW_MAIN_PORT="$6"
OLD_PRIMARY_ID="$7"; OLD_MAIN_ID="$8"

export PGPASSWORD="${PGPOOL_SR_CHECK_PASSWORD:-postgres}"
export PGCONNECT_TIMEOUT=3
PGUSER="${PGPOOL_SR_CHECK_USER:-postgres}"
DB="${PGPOOL_EVENT_DB:-negocio_db}"
ME="${PGPOOL_NODE_NAME:-$(hostname)}"

log() { echo "[failover.sh][$ME] $(date -u +%FT%TZ) $*"; }

log "Falla detectada en nodo $FAILED_ID ($FAILED_HOST:$FAILED_PORT). Primario anterior=$OLD_PRIMARY_ID, candidato=$NEW_MAIN_ID ($NEW_MAIN_HOST)"

if [ "$FAILED_ID" != "$OLD_PRIMARY_ID" ]; then
  log "El nodo caído era una RÉPLICA: no se promueve nada."
  # Sin réplica, el primario no puede esperar su confirmación: pasa a asíncrono
  # para no bloquear las escrituras hasta que la réplica vuelva (failback.sh).
  /opt/pgpool/sync.sh ''
  exit 0
fi

if [ -z "$NEW_MAIN_HOST" ] || [ "$NEW_MAIN_ID" -lt 0 ] 2>/dev/null; then
  log "No hay réplica disponible para promover."
  exit 1
fi

INICIO=$(date +%s.%N)
log "Promoviendo $NEW_MAIN_HOST a PRIMARIO con pg_promote()..."
psql -h "$NEW_MAIN_HOST" -p "$NEW_MAIN_PORT" -U "$PGUSER" -d postgres -tAc "SELECT pg_promote(true, 30)" \
  || log "pg_promote devolvió error (puede que ya estuviera promovido)"

for _ in $(seq 1 30); do
  r=$(psql -h "$NEW_MAIN_HOST" -p "$NEW_MAIN_PORT" -U "$PGUSER" -d postgres -tAc "SELECT pg_is_in_recovery()" 2>/dev/null)
  [ "$r" = "f" ] && break
  sleep 1
done
FIN=$(date +%s.%N)
DUR=$(awk "BEGIN{printf \"%.2f\", $FIN-$INICIO}")
log "Promoción completada en ${DUR}s. Nuevo primario: $NEW_MAIN_HOST"
# El nuevo primario aún no tiene réplica: asíncrono hasta que el ex-primario se reincorpore
/opt/pgpool/sync.sh ''

psql -h "$NEW_MAIN_HOST" -p "$NEW_MAIN_PORT" -U "$PGUSER" -d "$DB" -v ON_ERROR_STOP=0 -q -c \
  "INSERT INTO ha_eventos (componente, tipo, nodo_caido, nuevo_primario, detectado_por, detalle)
   VALUES ('postgresql', 'FAILOVER', '$FAILED_HOST', '$NEW_MAIN_HOST', '$ME', 'promocion en ${DUR}s')" \
  || log "No se pudo registrar el evento en ha_eventos"

exit 0
