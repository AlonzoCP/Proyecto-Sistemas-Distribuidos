# Proyecto de Sistemas Distribuidos

Sistema de arquitectura distribuida políglota y heterogénea orquestado mediante contenedores Docker. Implementa un API Gateway en Node.js, un Servicio de Dominio en Python/FastAPI con PostgreSQL, y un Servicio de Auditoría en Go con Redis, todos aislados en una subred privada de Docker (`red-aislada`).

---

## Procedimiento de Despliegue y Verificación en Vivo

Ejecutar la siguiente secuencia de comandos desde la terminal de **PowerShell** en la carpeta raíz del proyecto (`Proyecto-Sistemas-Distribuidos`):

### 1. Construcción de las Imágenes de los Contenedores
Construye las imágenes actualizadas de todos los microservicios:
```powershell
docker compose up --build
```

### 2. Levantamiento del Entorno en Segundo Plano
Despliega los 5 contenedores y la red virtual privada:
```powershell
docker compose up -d
```

### 3. Verificación de Contenedores y Mapeo de Puertos
Valida que todos los contenedores estén en estado Running y que únicamente el Módulo A exponga su puerto hacia el Host:
```powershell
docker ps
```

### 4. Inspección de Logs en Tiempo Real
En otra ventana de PowerShell, puedes ejecutar el seguimiento continuo de trazas:
```powershell
docker compose logs -f
```

### 5. Prueba de Ingesta de Datos de Extremo a Extremo
Envía peticiones de prueba HTTP POST al API Gateway para validar la transacción y la orquestación distribuida:
```powershell
Invoke-RestMethod -Uri "http://localhost:8080/api/pedidos" -Method Post -ContentType "application/json" -Body '{"cliente": "Esteban Castillo", "producto": "Teclado Mecánico", "precio": 14990, "pago": "Debito"}'
```

```powershell
Invoke-RestMethod -Uri "http://localhost:8080/api/pedidos" -Method Post -ContentType "application/json" -Body '{"cliente": "Andrés Padilla", "producto": "Audífonos JBL", "precio": 29990, "pago": "Debito"}'
```

### 6. Inspección de la Red Virtual Private
Muestra los detalles del puente de red y la asignación de IPs internas de Docker:
```powershell
docker network inspect proyecto-sistemas-distribuidos_red-aislada
```

### 7. Prueba de Conectividad Interactiva (Resolución DNS Interna)
Conexión interactiva desde Módulo A hacia Módulo B:
```powershell
docker exec -it modulo-a wget -qO- http://modulo-b:5000/health
```

Conexión interactiva desde Módulo A hacia Módulo C:
```powershell
docker exec -it modulo-a wget -qO- http://modulo-c:6000/health
```

### 8. Prueba de Acceso Público al API Gateway (Módulo A)
Comprueba la disponibilidad del punto de entrada externo:
```powershell
curl.exe http://localhost:8080/health
```

### 9. Pruebas de Aislamiento de Red (Puertos Privados No Expuestos)
Intento de acceso directo al Módulo B desde el Host:
```powershell
curl.exe http://localhost:5000
```

Intento de acceso directo al Módulo B desde el Host:
```powershell
curl.exe http://localhost:6000
```

### 10. Detener y Desmontar el Entorno
Finaliza y remueve todos los contenedores y la red virtual privada:
```powershell
docker compose down
```