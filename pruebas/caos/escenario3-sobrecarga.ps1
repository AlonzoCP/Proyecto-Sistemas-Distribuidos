# =============================================================================
# ESCENARIO 3 - Sobrecarga de transacciones (escrituras concurrentes crecientes)
#   .\pruebas\caos\escenario3-sobrecarga.ps1             (≈ 5 min, hasta 400 pedidos/s)
#   .\pruebas\caos\escenario3-sobrecarga.ps1 -TasaMax 200
# Mide TPS, p95/p99, errores 5xx, uso de CPU/RAM y verifica que no se pierdan
# pedidos confirmados (k6 confirmados = filas PostgreSQL = trazas Redis).
# =============================================================================
param([int]$TasaMax = 400, [string]$Lote = "e3-$(Get-Date -Format yyyyMMddHHmmss)")
. "$PSScriptRoot\caos.ps1"

Write-Host "=== ESCENARIO 3: sobrecarga transaccional (lote $Lote) ===" -ForegroundColor Green
Esperar-Saludable
$desde = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
$stats = Iniciar-Stats $Lote
$k6 = Iniciar-K6 'e3-sobrecarga.js' $Lote @('-e', "TASA_MAX=$TasaMax") -Csv
Registrar-Evento "INICIO rampa hasta $TasaMax pedidos/s" $Lote
$k6.WaitForExit()
Registrar-Evento 'FIN rampa' $Lote
Stop-Job $stats; Remove-Job $stats

Start-Sleep -Seconds 10   # deja terminar la replicación
Guardar-EstadoCluster $Lote 'despues'
$int = Verificar-Integridad $Lote
$txt = Get-Content (Join-Path $Global:Resultados "k6-$Lote.txt") -Raw
if ($txt -match 'Pedidos confirmados\s*:\s*(\d+)') {
  $conf = [int]$Matches[1]
  $perdidos = $conf - [int]$int.pedidos_postgresql
  Write-Host "Confirmados al cliente: $conf | Persistidos: $($int.pedidos_postgresql) | Perdidos: $perdidos" -ForegroundColor $(if ($perdidos -eq 0) { 'Green' } else { 'Red' })
}
Guardar-Logs $Lote $desde
