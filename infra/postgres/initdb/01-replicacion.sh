#!/usr/bin/env bash
# Se ejecuta SOLO en el primer arranque del nodo primario (initdb).
# Crea el rol de replicación y habilita conexiones de streaming en pg_hba.conf.
# Las réplicas copian este pg_hba.conf con pg_basebackup.
set -euo pipefail

REPL_USER="${REPLICATION_USER:-replicator}"
REPL_PASS="${REPLICATION_PASSWORD:-replicator}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<SQL
CREATE ROLE ${REPL_USER} WITH REPLICATION LOGIN PASSWORD '${REPL_PASS}';
SQL

echo "host replication ${REPL_USER} all scram-sha-256" >> "$PGDATA/pg_hba.conf"

# Replicación SEMISÍNCRONA: un commit se confirma al cliente solo cuando la réplica
# ya lo recibió (RPO = 0 ante la caída del primario). Si la réplica cae, Pgpool-II
# (failover.sh / sync.sh) pasa el primario a asíncrono para no bloquear escrituras,
# y lo vuelve a semisíncrono cuando la réplica se reincorpora (failback.sh).
# Se fija con ALTER SYSTEM (postgresql.auto.conf) y no con "-c" porque los
# parámetros de línea de comandos no se pueden cambiar después en caliente.
if [ "${SYNC_REPLICATION:-on}" = "on" ]; then
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
    -c "ALTER SYSTEM SET synchronous_standby_names = '*'" \
    -c "ALTER SYSTEM SET synchronous_commit = 'on'"
fi
