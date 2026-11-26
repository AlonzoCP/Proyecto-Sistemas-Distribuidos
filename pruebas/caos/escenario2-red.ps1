# =============================================================================
# ESCENARIO 2 - Fallos y degradación de la comunicación de red
#   .\pruebas\caos\escenario2-red.ps1          (≈ 7 min)
#
# Línea de tiempo (tráfico constante):
#   t=30-90   2a Latencia 300±50 ms en modulo-b-1 (réplica lenta)
#   t=100-160 2b Pérdida de 30 % de paquetes en lb-int-1 (balanceador inestable)
#   t=170-230 2c Latencia 4000 ms en modulo-c-1 (supera el timeout de 3 s del Gateway)
#   t=240-290 2d PARTICIÓN: primario PG aislado de red-datos -> failover;
#             al reconectar se reinicia el ex-primario para que se reincorpore
#             como réplica (prevención de split-brain)
#   t=320-360 2e PARTICIÓN: modulo-c-1 sin acceso a Redis (vivo para HAProxy)
# =============================================================================
param([int]$Tasa = 15, [string]$Lote = "e2-$(Get-Date -Format yyyyMMddHHmmss)")
. "$PSScriptRoot\caos.ps1"

Write-Host "=== ESCENARIO 2: degradación de red (lote $Lote) ===" -ForegroundColor Green
Write-Host 'Descargando imagen auxiliar nicolaka/netshoot (tc netem)...'
docker pull -q nicolaka/netshoot | Out-Null
Esperar-Saludable
Guardar-EstadoCluster $Lote 'antes'
$desde = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')

$stats = Iniciar-Stats $Lote
$sonda = Iniciar-Sonda $Lote -DuracionS 390
$k6    = Iniciar-K6 'e2-red.js' $Lote @('-e', "TASA=$Tasa", '-e', 'DURACION=6m30s')
$t0 = Get-Date
Registrar-Evento 'INICIO tráfico' $Lote

# 2a - réplica lenta
Esperar-Hasta $t0 30;  Agregar-Latencia 'modulo-b-1' -Ms 300 -JitterMs 50 -Lote $Lote
Esperar-Hasta $t0 90;  Quitar-Latencia  'modulo-b-1' $Lote
# 2b - balanceador interno con pérdida de paquetes
Esperar-Hasta $t0 100; Agregar-Latencia 'lb-int-1' -Ms 20 -JitterMs 10 -PerdidaPct 30 -Lote $Lote
Esperar-Hasta $t0 160; Quitar-Latencia  'lb-int-1' $Lote
# 2c - réplica de auditoría más lenta que el timeout del Gateway
Esperar-Hasta $t0 170; Agregar-Latencia 'modulo-c-1' -Ms 4000 -JitterMs 0 -Lote $Lote
Esperar-Hasta $t0 230; Quitar-Latencia  'modulo-c-1' $Lote
# 2d - partición del primario PostgreSQL
Esperar-Hasta $t0 240; $pg = Get-PrimarioPG
if ($pg) {
  Desconectar-Red $pg 'red-datos' $Lote
  Esperar-Hasta $t0 260; Guardar-EstadoCluster $Lote 'particion-pg'
  Esperar-Hasta $t0 290; Conectar-Red $pg 'red-datos' -Lote $Lote
  Registrar-Evento "RESTART $pg (ex-primario aislado: se reincorpora como réplica)" $Lote
  docker restart $pg | Out-Null
}
# 2e - réplica de auditoría sin acceso a Redis
Esperar-Hasta $t0 320; Desconectar-Red 'modulo-c-1' 'red-datos' $Lote
Esperar-Hasta $t0 360; Conectar-Red 'modulo-c-1' 'red-datos' -Lote $Lote

Write-Host 'Esperando fin de k6 y sonda...' -ForegroundColor Cyan
$k6.WaitForExit(); $sonda.WaitForExit()
Registrar-Evento 'FIN tráfico' $Lote
Stop-Job $stats; Remove-Job $stats
Start-Sleep -Seconds 20
Guardar-EstadoCluster $Lote 'despues'
Write-Host 'Nodos PostgreSQL al final (debe haber UN solo primario):' -ForegroundColor Cyan
Get-PoolNodes | Format-Table
Verificar-Integridad $Lote | Out-Null
Guardar-Logs $Lote $desde
Write-Host "`nListo. Revise resultados\k6-$Lote.txt y resultados\sonda-$Lote-sonda-resumen.json" -ForegroundColor Green
