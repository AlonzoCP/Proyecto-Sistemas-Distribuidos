CREATE TABLE IF NOT EXISTS pedidos (
    pedido_id SERIAL PRIMARY KEY,
    cliente VARCHAR(100) NOT NULL,
    producto VARCHAR(100) NOT NULL,
    precio NUMERIC(10,2) NOT NULL,
    pago VARCHAR(50) NOT NULL,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    estado VARCHAR(50) NOT NULL
);

INSERT INTO pedidos (cliente, producto, precio, pago, estado) VALUES
('Esteban Padilla', 'Teclado Mecánico RGB', 29990, 'Debito', 'RECIBIDO'),
('Andrés Castillo', 'Audífonos Inalámbricos', 45900, 'Credito', 'RECIBIDO'),
('María Vidal', 'Monitor 24 Pulgadas', 149000, 'Transferencia', 'RECIBIDO');