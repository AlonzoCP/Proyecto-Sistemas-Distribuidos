# =============================================================================
# ESCENARIO 4 - Estrés por demanda de usuarios (lecturas + escrituras)
#   .\pruebas\caos\escenario4-usuarios.ps1           (≈ 7 min, hasta 300 usuarios)
#   .\pruebas\caos\escenario4-usuarios.ps1 -VusMax 500
# El CSV de k6 (resultados\k6-<lote>.csv) permite calcular p95 y errores por
# etapa para ubicar el punto de quiebre; docker-stats-<lote>.csv da CPU/RAM.
# =============================================================================
param([int]$VusMax = 300, [string]$Lote = "e4-$(Get-Date -Format yyyyMMddHHmmss)")
. "$PSScriptRoot\caos.ps1"

Write-Host "=== ESCENARIO 4: estrés de usuarios (lote $Lote) ===" -ForegroundColor Green
Esperar-Saludable
$desde = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
$stats = Iniciar-Stats $Lote
$k6 = Iniciar-K6 'e4-usuarios.js' $Lote @('-e', "VUS_MAX=$VusMax") -Csv
Registrar-Evento "INICIO rampa hasta $VusMax usuarios" $Lote
$k6.WaitForExit()
Registrar-Evento 'FIN rampa' $Lote
Stop-Job $stats; Remove-Job $stats
Guardar-EstadoCluster $Lote 'despues'
Verificar-Integridad $Lote | Out-Null
Guardar-Logs $Lote $desde
python "$PSScriptRoot\..\analisis\por_etapa.py" (Join-Path $Global:Resultados "k6-$Lote.csv") 2>$null
if ($LASTEXITCODE -ne 0) { Write-Host 'Para el análisis por etapa ejecute: python pruebas\analisis\por_etapa.py resultados\k6-<lote>.csv' }
