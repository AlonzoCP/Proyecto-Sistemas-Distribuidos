-- =============================================================================
-- Esquema TechOrders - Unidad 3
-- Se ejecuta una sola vez, en el primario, sobre la base POSTGRES_DB (negocio_db).
-- Las réplicas lo reciben por streaming replication.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Tabla de pedidos con PARTICIONAMIENTO NATIVO POR HASH
--
-- Clave de partición: request_id (UUID generado por el API Gateway por cada
-- transacción). Se particiona por request_id y no por pedido_id porque en
-- PostgreSQL toda restricción UNIQUE / PRIMARY KEY de una tabla particionada
-- debe incluir la clave de partición. Así request_id es a la vez:
--   * la clave de partición (distribución uniforme en 4 particiones), y
--   * la clave de idempotencia (un reintento del Gateway no duplica el pedido).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pedidos (
    request_id    UUID          NOT NULL,
    pedido_id     BIGSERIAL     NOT NULL,
    cliente       VARCHAR(100)  NOT NULL,
    producto      VARCHAR(100)  NOT NULL,
    precio        INTEGER       NOT NULL CHECK (precio > 0),
    pago          VARCHAR(50)   NOT NULL,
    estado        VARCHAR(30)   NOT NULL DEFAULT 'RECIBIDO',
    lote          VARCHAR(64),             -- etiqueta de la prueba/ráfaga que generó el pedido
    nodo_gateway  VARCHAR(64),             -- réplica del Módulo A que recibió la petición
    nodo_dominio  VARCHAR(64)   NOT NULL,  -- réplica del Módulo B que persistió el pedido
    creado_en     TIMESTAMPTZ   NOT NULL DEFAULT now(),
    PRIMARY KEY (request_id)
) PARTITION BY HASH (request_id);

CREATE TABLE IF NOT EXISTS pedidos_p0 PARTITION OF pedidos FOR VALUES WITH (MODULUS 4, REMAINDER 0);
CREATE TABLE IF NOT EXISTS pedidos_p1 PARTITION OF pedidos FOR VALUES WITH (MODULUS 4, REMAINDER 1);
CREATE TABLE IF NOT EXISTS pedidos_p2 PARTITION OF pedidos FOR VALUES WITH (MODULUS 4, REMAINDER 2);
CREATE TABLE IF NOT EXISTS pedidos_p3 PARTITION OF pedidos FOR VALUES WITH (MODULUS 4, REMAINDER 3);

-- Índices definidos en la tabla padre: PostgreSQL los crea en cada partición.
CREATE INDEX IF NOT EXISTS idx_pedidos_pedido_id ON pedidos (pedido_id DESC);
CREATE INDEX IF NOT EXISTS idx_pedidos_lote      ON pedidos (lote);

-- -----------------------------------------------------------------------------
-- Registro de eventos de alta disponibilidad (failover / reincorporación).
-- Lo escribe el script de failover de Pgpool-II después de promover una réplica.
-- El Health Dashboard lo muestra como historial de conmutaciones.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ha_eventos (
    id            BIGSERIAL     PRIMARY KEY,
    ocurrido_en   TIMESTAMPTZ   NOT NULL DEFAULT now(),
    componente    VARCHAR(30)   NOT NULL,     -- 'postgresql'
    tipo          VARCHAR(30)   NOT NULL,     -- 'FAILOVER'
    nodo_caido    VARCHAR(64),
    nuevo_primario VARCHAR(64),
    detectado_por VARCHAR(64),                -- instancia de Pgpool-II que ejecutó el failover
    detalle       TEXT
);

-- Datos iniciales
INSERT INTO pedidos (request_id, cliente, producto, precio, pago, estado, lote, nodo_gateway, nodo_dominio) VALUES
  (gen_random_uuid(), 'Esteban Padilla', 'Teclado Mecánico RGB',   29990,  'Debito',        'RECIBIDO', 'seed', 'seed', 'seed'),
  (gen_random_uuid(), 'Andrés Castillo', 'Audífonos Inalámbricos', 45900,  'Credito',       'RECIBIDO', 'seed', 'seed', 'seed'),
  (gen_random_uuid(), 'María Vidal',     'Monitor 24 Pulgadas',    149000, 'Transferencia', 'RECIBIDO', 'seed', 'seed', 'seed');
