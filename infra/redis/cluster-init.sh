#!/bin/sh
# =============================================================================
# Inicializa el Redis Cluster una sola vez (contenedor efímero redis-cluster-init).
# Crea 3 maestros + 3 réplicas y reparte los 16.384 hash slots.
# Si el clúster ya existe (reinicios posteriores), no hace nada.
# =============================================================================
set -e
NODES="${REDIS_NODES:?Defina REDIS_NODES='ip:puerto ip:puerto ...'}"
FIRST=$(echo "$NODES" | awk '{print $1}')
FIRST_HOST=${FIRST%:*}; FIRST_PORT=${FIRST#*:}

for n in $NODES; do
  h=${n%:*}; p=${n#*:}
  until redis-cli -h "$h" -p "$p" ping 2>/dev/null | grep -q PONG; do
    echo "[cluster-init] esperando a $n ..."; sleep 1
  done
done

KNOWN=$(redis-cli -h "$FIRST_HOST" -p "$FIRST_PORT" cluster info | grep cluster_known_nodes | cut -d: -f2 | tr -d '\r')
if [ "${KNOWN:-1}" -gt 1 ]; then
  echo "[cluster-init] El clúster ya existe ($KNOWN nodos). Nada que hacer."
  redis-cli -h "$FIRST_HOST" -p "$FIRST_PORT" cluster info | grep -E 'cluster_state|cluster_size'
  exit 0
fi

echo "[cluster-init] Creando Redis Cluster con: $NODES"
# shellcheck disable=SC2086
redis-cli --cluster create $NODES --cluster-replicas 1 --cluster-yes

until redis-cli -h "$FIRST_HOST" -p "$FIRST_PORT" cluster info | grep -q 'cluster_state:ok'; do sleep 1; done
echo "[cluster-init] Clúster listo:"
redis-cli -h "$FIRST_HOST" -p "$FIRST_PORT" cluster nodes
