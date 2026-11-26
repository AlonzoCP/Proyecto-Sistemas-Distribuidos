FROM postgres:16-bookworm

COPY ha-entrypoint.sh /usr/local/bin/ha-entrypoint.sh
COPY initdb/ /docker-entrypoint-initdb.d/

# sed: defensa extra por si el repo se clonó en Windows con fin de línea CRLF
RUN sed -i 's/\r$//' /usr/local/bin/ha-entrypoint.sh /docker-entrypoint-initdb.d/* \
 && chmod +x /usr/local/bin/ha-entrypoint.sh /docker-entrypoint-initdb.d/*.sh

ENTRYPOINT ["ha-entrypoint.sh"]

# Parámetros para streaming replication (async) y para soportar 2 instancias de Pgpool-II
CMD ["postgres", \
     "-c", "listen_addresses=*", \
     "-c", "wal_level=replica", \
     "-c", "hot_standby=on", \
     "-c", "max_wal_senders=10", \
     "-c", "wal_keep_size=512MB", \
     "-c", "wal_log_hints=on", \
     "-c", "max_connections=200"]
