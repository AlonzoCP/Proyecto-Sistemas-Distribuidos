from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
import psycopg2
import os
import time

app = FastAPI()

# Variables de entorno obtenidas del docker-compose (DNS interno)
DB_HOST = os.getenv("DB_HOST", "db-relacional")
DB_NAME = os.getenv("DB_NAME", "negocio_db")
DB_USER = os.getenv("DB_USER", "postgres")
DB_PASS = os.getenv("DB_PASSWORD", "postgres")

# Modelo del Payload esperado desde Módulo A
class Pedido(BaseModel):
    cliente: str
    producto: str
    precio: int = Field(gt=0)
    pago: str
    timestamp: str

def get_db_connection():
    return psycopg2.connect(host=DB_HOST, database=DB_NAME, user=DB_USER, password=DB_PASS)

# Crear tabla automáticamente al iniciar el contenedor
@app.on_event("startup")
def startup():
    max_retries = 10
    for i in range(1, max_retries + 1):
        try:
            conn = get_db_connection()
            cur = conn.cursor()
            cur.execute('''
                CREATE TABLE IF NOT EXISTS pedidos (
                    pedido_id SERIAL PRIMARY KEY,
                    cliente VARCHAR(100),
                    producto VARCHAR(100),
                    precio NUMERIC,
                    pago VARCHAR(50),
                    timestamp VARCHAR(50),
                    estado VARCHAR(50)
                )
            ''')
            conn.commit()
            cur.close()
            conn.close()
            print(f"[Módulo B] Base de datos inicializada correctamente")
            return
        except Exception as e:
            print(f"[Módulo B] PostgreSQL no listo aún ({e}). Reintentando {i}/{max_retries} en 2s...")
            time.sleep(2)
    print("[Módulo B] Advertencia: No se pudo inicializar la BD tras varios intentos.")

# Endpoint interno expuesto en el puerto 5000
@app.post("/procesar-pedido")
def procesar_pedido(pedido: Pedido):
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        
        # Inserción en BD 1 (PostgreSQL) con estado RECIBIDO
        cur.execute(
            """INSERT INTO pedidos (cliente, producto, precio, pago, timestamp, estado) 
               VALUES (%s, %s, %s, %s, %s, %s) RETURNING pedido_id""",
            (pedido.cliente, pedido.producto, pedido.precio, pedido.pago, pedido.timestamp, "RECIBIDO")
        )
        pedido_id = cur.fetchone()[0]
        conn.commit()
        cur.close()
        conn.close()

        # Respuesta hacia el Módulo A
        return {
            "status": "Procesado",
            "pedido_id": pedido_id,
            "cliente": pedido.cliente,
            "producto": pedido.producto,
            "precio": pedido.precio,
            "pago": pedido.pago,
            "timestamp": pedido.timestamp
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# Endpoint de salud para monitoreo
@app.get("/health")
def health_check():
    return {"status": "UP", "modulo": "modulo-b-dominio"}

# Endpoint para listar todos los pedidos almacenados en la base de datos
@app.get("/pedidos")
def listar_pedidos():
    conn = get_db_connection()
    if not conn:
        raise HTTPException(status_code=500, detail="Error de conexión a PostgreSQL")

    try:
        cursor = conn.cursor()
        cursor.execute("SELECT pedido_id, cliente, producto, precio, pago, timestamp, estado FROM pedidos ORDER BY timestamp DESC;")
        rows = cursor.fetchall()
        cursor.close()
        conn.close()

        pedidos = []
        for r in rows:
            pedidos.append({
                "pedido_id": r[0],
                "cliente": r[1],
                "producto": r[2],
                "precio": int(r[3]),
                "pago": r[4],
                "timestamp": str(r[5]),
                "estado": r[6]
            })
        return pedidos
    except Exception as e:
        if conn:
            conn.close()
        raise HTTPException(status_code=500, detail=str(e))