#!/usr/bin/env bash
# Genera la configuración de Pgpool-II a partir de variables de entorno y lo arranca.
set -euo pipefail

CONF_DIR="${PGPOOL_CONF_DIR:-/etc/pgpool2}"
TEMPLATE="${PGPOOL_TEMPLATE:-/opt/pgpool/pgpool.conf.template}"

# Valores por defecto (sobrescribibles desde docker-compose)
export PGPOOL_PORT="${PGPOOL_PORT:-5432}"
export PCP_PORT="${PCP_PORT:-9898}"
export PGPOOL_NUM_INIT_CHILDREN="${PGPOOL_NUM_INIT_CHILDREN:-64}"
export PG1_HOST="${PG1_HOST:-pg-1}"  PG1_PORT="${PG1_PORT:-5432}" PG1_NAME="${PG1_NAME:-pg-1}"
export PG2_HOST="${PG2_HOST:-pg-2}"  PG2_PORT="${PG2_PORT:-5432}" PG2_NAME="${PG2_NAME:-pg-2}"
export PGPOOL_SR_CHECK_USER="${PGPOOL_SR_CHECK_USER:-postgres}"
export PGPOOL_SR_CHECK_PASSWORD="${PGPOOL_SR_CHECK_PASSWORD:-postgres}"
export PGPOOL1_HOST="${PGPOOL1_HOST:-pgpool-1}" PGPOOL1_PORT="${PGPOOL1_PORT:-5432}"
export PGPOOL1_WD_PORT="${PGPOOL1_WD_PORT:-9000}" PGPOOL1_HB_PORT="${PGPOOL1_HB_PORT:-9694}"
export PGPOOL2_HOST="${PGPOOL2_HOST:-pgpool-2}" PGPOOL2_PORT="${PGPOOL2_PORT:-5432}"
export PGPOOL2_WD_PORT="${PGPOOL2_WD_PORT:-9000}" PGPOOL2_HB_PORT="${PGPOOL2_HB_PORT:-9694}"
export PGPOOL_NODE_ID="${PGPOOL_NODE_ID:-0}"
export PGPOOL_WD_PRIORITY="${PGPOOL_WD_PRIORITY:-1}"
export PGPOOL_NODE_NAME="${PGPOOL_NODE_NAME:-$(hostname)}"
APP_USER="${APP_DB_USER:-postgres}"
APP_PASS="${APP_DB_PASSWORD:-postgres}"
PCP_USER="${PCP_USER:-pcpadmin}"
PCP_PASS="${PCP_PASSWORD:-pcpadmin}"

mkdir -p "$CONF_DIR"
envsubst < "$TEMPLATE" > "$CONF_DIR/pgpool.conf"
echo "$PGPOOL_NODE_ID" > "$CONF_DIR/pgpool_node_id"

# Contraseñas en texto (prefijo TEXT) para que Pgpool pueda autenticar con SCRAM hacia los backends
{
  echo "${APP_USER}:TEXT${APP_PASS}"
  if [ "$PGPOOL_SR_CHECK_USER" != "$APP_USER" ]; then
    echo "${PGPOOL_SR_CHECK_USER}:TEXT${PGPOOL_SR_CHECK_PASSWORD}"
  fi
} > "$CONF_DIR/pool_passwd"
chmod 600 "$CONF_DIR/pool_passwd"

cat > "$CONF_DIR/pool_hba.conf" <<EOF
local   all  all                trust
host    all  all  0.0.0.0/0     scram-sha-256
host    all  all  ::/0          scram-sha-256
EOF

echo "${PCP_USER}:$(pg_md5 "$PCP_PASS")" > "$CONF_DIR/pcp.conf"
# .pcppass para usar pcp_* sin pedir contraseña (healthcheck / scripts de prueba)
echo "*:*:${PCP_USER}:${PCP_PASS}" > "${HOME:-/root}/.pcppass"
chmod 600 "${HOME:-/root}/.pcppass"

echo "[pgpool-entrypoint] Iniciando $PGPOOL_NODE_NAME (watchdog id $PGPOOL_NODE_ID)"
# -D: descarta el estado guardado (pgpool_status). Si el contenedor de Pgpool se
# reinicia mientras un nodo estaba caído, se vuelve a detectar el estado real de los
# nodos en vez de dejar marcado "down" para siempre un nodo que ya se recuperó.
exec pgpool -n -D -f "$CONF_DIR/pgpool.conf" -F "$CONF_DIR/pcp.conf" -a "$CONF_DIR/pool_hba.conf"
