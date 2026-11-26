# =============================================================================
# ESCENARIO 1 - Caída abrupta de contenedores con tráfico activo
#   .\pruebas\caos\escenario1-caida-nodos.ps1            (≈ 6 min)
#   .\pruebas\caos\escenario1-caida-nodos.ps1 -Tasa 40
#
# Línea de tiempo (segundos desde el inicio, tráfico constante todo el tiempo):
#   t=30  kill modulo-b-1        t=60  start modulo-b-1
#   t=75  kill modulo-a-1        t=105 start modulo-a-1
#   t=120 kill modulo-c-1        t=150 start modulo-c-1
#   t=165 kill PRIMARIO PG       t=225 start (vuelve como réplica)
#   t=240 kill MAESTRO Redis     t=280 start (vuelve como réplica)
# Resultados en .\resultados\ : sonda (RTO por ventana), k6 (TPS, p95/p99,
# errores), eventos (marcas de tiempo), integridad, logs, docker stats.
# =============================================================================
param([int]$Tasa = 20, [string]$Lote = "e1-$(Get-Date -Format yyyyMMddHHmmss)")
. "$PSScriptRoot\caos.ps1"

Write-Host "=== ESCENARIO 1: caída de contenedores (lote $Lote) ===" -ForegroundColor Green
Esperar-Saludable
Guardar-EstadoCluster $Lote 'antes'
$desde = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')

$stats = Iniciar-Stats $Lote
$sonda = Iniciar-Sonda $Lote -DuracionS 320
$k6    = Iniciar-K6 'e1-caida-nodos.js' $Lote @('-e', "TASA=$Tasa", '-e', 'DURACION=5m')
$t0 = Get-Date
Registrar-Evento 'INICIO tráfico' $Lote

Esperar-Hasta $t0 30;  Matar-Contenedor   'modulo-b-1' $Lote
Esperar-Hasta $t0 60;  Iniciar-Contenedor 'modulo-b-1' $Lote
Esperar-Hasta $t0 75;  Matar-Contenedor   'modulo-a-1' $Lote
Esperar-Hasta $t0 105; Iniciar-Contenedor 'modulo-a-1' $Lote
Esperar-Hasta $t0 120; Matar-Contenedor   'modulo-c-1' $Lote
Esperar-Hasta $t0 150; Iniciar-Contenedor 'modulo-c-1' $Lote
Esperar-Hasta $t0 165; $pg = Matar-PrimarioPG $Lote
Esperar-Hasta $t0 185; Guardar-EstadoCluster $Lote 'tras-failover-pg'
Esperar-Hasta $t0 225; if ($pg) { Iniciar-Contenedor $pg $Lote }
Esperar-Hasta $t0 240; $rd = Matar-MaestroRedis $Lote
Esperar-Hasta $t0 260; Guardar-EstadoCluster $Lote 'tras-failover-redis'
Esperar-Hasta $t0 280; if ($rd) { Iniciar-Contenedor $rd $Lote }

Write-Host 'Esperando fin de k6 y sonda...' -ForegroundColor Cyan
$k6.WaitForExit(); $sonda.WaitForExit()
Registrar-Evento 'FIN tráfico' $Lote
Stop-Job $stats; Remove-Job $stats

Start-Sleep -Seconds 20   # reincorporación de nodos
Guardar-EstadoCluster $Lote 'despues'
Verificar-Integridad $Lote | Out-Null
Guardar-Logs $Lote $desde
Write-Host "`nListo. Revise resultados\k6-$Lote.txt, resultados\sonda-$Lote-sonda-resumen.json y resultados\eventos-$Lote.log" -ForegroundColor Green
