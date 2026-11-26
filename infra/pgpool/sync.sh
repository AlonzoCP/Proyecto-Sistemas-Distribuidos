#!/usr/bin/env bash
# =============================================================================
# Ajusta synchronous_standby_names en el PRIMARIO actual.
#   sync.sh '*'  -> replicación SEMISÍNCRONA: el commit espera a la réplica (RPO = 0)
#   sync.sh ''   -> replicación ASÍNCRONA: se usa cuando no hay réplica disponible,
#                   para que las escrituras no queden bloqueadas esperándola
# Lo invocan failover.sh (réplica caída / tras promover) y failback.sh (réplica de vuelta).
# Si PGPOOL_SYNC_REPLICATION=off, no hace nada (modo asíncrono permanente).
# =============================================================================
VALOR="$1"
[ "${PGPOOL_SYNC_REPLICATION:-on}" = "on" ] || exit 0
export PGPASSWORD="${PGPOOL_SR_CHECK_PASSWORD:-postgres}"
export PGCONNECT_TIMEOUT=3
PGUSER="${PGPOOL_SR_CHECK_USER:-postgres}"
ME="${PGPOOL_NODE_NAME:-$(hostname)}"

for hp in "${PG1_HOST:-pg-1}:${PG1_PORT:-5432}" "${PG2_HOST:-pg-2}:${PG2_PORT:-5432}"; do
  h="${hp%:*}"; p="${hp#*:}"
  r=$(psql -h "$h" -p "$p" -U "$PGUSER" -d postgres -tAc "SELECT pg_is_in_recovery()" 2>/dev/null)
  if [ "$r" = "f" ]; then
    psql -h "$h" -p "$p" -U "$PGUSER" -d postgres -q \
      -c "ALTER SYSTEM SET synchronous_standby_names = '$VALOR'" -c "SELECT pg_reload_conf()" >/dev/null \
      && echo "[sync.sh][$ME] $(date -u +%FT%TZ) primario $hp: synchronous_standby_names='$VALOR' ($( [ -n "$VALOR" ] && echo SEMISINCRONA || echo ASINCRONA ))"
    exit 0
  fi
done
echo "[sync.sh][$ME] no se encontró primario para ajustar la replicación"
exit 0
