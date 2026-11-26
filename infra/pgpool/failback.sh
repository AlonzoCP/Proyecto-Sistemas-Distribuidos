#!/usr/bin/env bash
# failback_command de Pgpool-II: un nodo vuelve al pool (p. ej. el ex-primario
# reincorporado como réplica por auto_failback). Con la réplica de vuelta se
# restablece la replicación semisíncrona (RPO = 0).
# Argumentos: %d %h %p
echo "[failback.sh][${PGPOOL_NODE_NAME:-$(hostname)}] $(date -u +%FT%TZ) nodo $1 ($2:$3) reincorporado al pool"
/opt/pgpool/sync.sh '*'
exit 0
