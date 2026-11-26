# Imagen propia de Pgpool-II construida sobre la imagen oficial de PostgreSQL
# (trae el repositorio apt.postgresql.org y los clientes psql/pg_isready).
FROM postgres:16-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends pgpool2 gettext-base \
 && rm -rf /var/lib/apt/lists/*

COPY pgpool.conf.template entrypoint.sh failover.sh /opt/pgpool/
RUN sed -i 's/\r$//' /opt/pgpool/* && chmod +x /opt/pgpool/*.sh

EXPOSE 5432 9898 9000 9694/udp

ENTRYPOINT ["/opt/pgpool/entrypoint.sh"]
