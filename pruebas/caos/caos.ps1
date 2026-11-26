# =============================================================================
# Funciones de inyección de fallos - TechOrders U3
# Se cargan desde los scripts de escenario con:  . "$PSScriptRoot\caos.ps1"
# También se pueden usar a mano en una consola:
#   . .\pruebas\caos\caos.ps1
#   Matar-Contenedor modulo-b-1 -Lote manual
#   Get-PrimarioPG
#   Agregar-Latencia modulo-b-1 -Ms 300 -PerdidaPct 10 -Lote manual
# Requiere: Docker Desktop y el stack levantado (docker compose up -d).
# Funciona en Windows PowerShell 5.1 y PowerShell 7 (pwsh, también Linux/Mac).
# =============================================================================

$Global:Proyecto   = 'techorders'
$Global:Raiz       = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Global:Resultados = Join-Path $Global:Raiz 'resultados'
$Global:UrlEntrada = 'http://localhost:8080'
$Global:IpsRedis   = @{
  '172.29.30.11' = 'redis-1'; '172.29.30.12' = 'redis-2'; '172.29.30.13' = 'redis-3'
  '172.29.30.14' = 'redis-4'; '172.29.30.15' = 'redis-5'; '172.29.30.16' = 'redis-6'
}
New-Item -ItemType Directory -Force -Path $Global:Resultados | Out-Null

function Ahora { (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') }

# Registra cada inyección con marca de tiempo UTC (se cruza con el CSV de la sonda)
function Registrar-Evento([string]$Texto, [string]$Lote = 'manual') {
  $linea = "$(Ahora);$Texto"
  Add-Content -Path (Join-Path $Global:Resultados "eventos-$Lote.log") -Value $linea
  Write-Host "[$(Get-Date -Format HH:mm:ss.fff)] $Texto" -ForegroundColor Yellow
}

# ----------------------------------------------------------------------------- contenedores
function Matar-Contenedor([string]$Nombre, [string]$Lote = 'manual') {
  Registrar-Evento "KILL $Nombre" $Lote
  docker kill $Nombre | Out-Null
}

function Iniciar-Contenedor([string]$Nombre, [string]$Lote = 'manual') {
  Registrar-Evento "START $Nombre" $Lote
  docker start $Nombre | Out-Null
}

# ----------------------------------------------------------------------------- PostgreSQL
function Get-PoolNodes {
  foreach ($pp in 'pgpool-1', 'pgpool-2') {
    $out = docker exec -e PGPASSWORD=postgres $pp psql -h 127.0.0.1 -U postgres -d postgres -tA -F '|' -c 'show pool_nodes' 2>$null
    if ($LASTEXITCODE -eq 0 -and $out) {
      return $out | Where-Object { $_ -match '\|' } | ForEach-Object {
        $c = $_.Split('|')
        [pscustomobject]@{ id = $c[0]; host = $c[1]; status = $c[3]; pg_status = $c[4]; rol = $c[6]; pg_rol = $c[7]; replicacion = $c[11] }
      }
    }
  }
  Write-Warning 'Ningún Pgpool respondió'
}

function Get-PrimarioPG { (Get-PoolNodes | Where-Object { $_.rol -eq 'primary' -and $_.status -eq 'up' } | Select-Object -First 1).host }

function Matar-PrimarioPG([string]$Lote = 'manual') {
  $p = Get-PrimarioPG
  if (-not $p) { Write-Warning 'No se encontró primario'; return $null }
  Registrar-Evento "KILL primario PostgreSQL $p" $Lote
  docker kill $p | Out-Null
  return $p
}

# ----------------------------------------------------------------------------- Redis
function Get-NodosRedis {
  foreach ($r in 'redis-1', 'redis-2', 'redis-3', 'redis-4', 'redis-5', 'redis-6') {
    $out = docker exec $r redis-cli cluster nodes 2>$null
    if ($LASTEXITCODE -eq 0 -and $out) {
      return $out | ForEach-Object {
        $f = $_ -split ' '
        $ip = ($f[1] -split ':')[0]
        [pscustomobject]@{ contenedor = $Global:IpsRedis[$ip]; ip = $ip; flags = $f[2]; estado = $f[7]; slots = ($f[8..($f.Length - 1)] -join ' ') }
      }
    }
  }
  Write-Warning 'Ningún nodo Redis respondió'
}

function Matar-MaestroRedis([string]$Lote = 'manual') {
  $m = Get-NodosRedis | Where-Object { $_.flags -match 'master' -and $_.flags -notmatch 'fail' -and $_.slots } | Select-Object -First 1
  if (-not $m) { Write-Warning 'No se encontró maestro'; return $null }
  Registrar-Evento "KILL maestro Redis $($m.contenedor) ($($m.ip), slots $($m.slots))" $Lote
  docker kill $m.contenedor | Out-Null
  return $m.contenedor
}

# ----------------------------------------------------------------------------- red
# tc netem desde un contenedor auxiliar que comparte el namespace de red del objetivo
# (no modifica la imagen del servicio ni agrega componentes al camino de los datos).
function Agregar-Latencia([string]$Nombre, [int]$Ms = 300, [int]$JitterMs = 50, [int]$PerdidaPct = 0, [string]$Lote = 'manual') {
  Registrar-Evento "NETEM $Nombre delay=${Ms}ms jitter=${JitterMs}ms loss=${PerdidaPct}%" $Lote
  $cmd = "for i in `$(ls /sys/class/net | grep -v lo); do tc qdisc replace dev `$i root netem delay ${Ms}ms ${JitterMs}ms loss ${PerdidaPct}%; done; tc qdisc show"
  docker run --rm --net "container:$Nombre" --cap-add NET_ADMIN nicolaka/netshoot sh -c $cmd
}

function Quitar-Latencia([string]$Nombre, [string]$Lote = 'manual') {
  Registrar-Evento "NETEM-OFF $Nombre" $Lote
  $cmd = "for i in `$(ls /sys/class/net | grep -v lo); do tc qdisc del dev `$i root 2>/dev/null; done; true"
  docker run --rm --net "container:$Nombre" --cap-add NET_ADMIN nicolaka/netshoot sh -c $cmd | Out-Null
}

function Desconectar-Red([string]$Nombre, [string]$Red = 'red-datos', [string]$Lote = 'manual') {
  Registrar-Evento "PARTICION $Nombre desconectado de $Red" $Lote
  docker network disconnect "$($Global:Proyecto)_$Red" $Nombre
}

function Conectar-Red([string]$Nombre, [string]$Red = 'red-datos', [string]$Ip = '', [string]$Lote = 'manual') {
  Registrar-Evento "RECONEXION $Nombre a $Red" $Lote
  if ($Ip) { docker network connect --ip $Ip "$($Global:Proyecto)_$Red" $Nombre }
  else { docker network connect "$($Global:Proyecto)_$Red" $Nombre }
}

# ----------------------------------------------------------------------------- medición
# Lanza un proceso en segundo plano con su salida en resultados/
function Iniciar-Proceso([string]$Nombre, [string[]]$Argumentos, [string]$Lote) {
  $out = Join-Path $Global:Resultados "$Nombre-$Lote.txt"
  $err = Join-Path $Global:Resultados "$Nombre-$Lote.err.txt"
  Write-Host "Iniciando $Nombre -> $out" -ForegroundColor Cyan
  return Start-Process -FilePath 'docker' -ArgumentList $Argumentos -WorkingDirectory $Global:Raiz `
    -RedirectStandardOutput $out -RedirectStandardError $err -NoNewWindow -PassThru
}

function Iniciar-Sonda([string]$Lote, [int]$DuracionS = 300, [int]$IntervaloMs = 200) {
  Iniciar-Proceso 'sonda' @('compose', '--profile', 'pruebas', 'run', '--rm', '-e', "LOTE=$Lote-sonda",
    '-e', "DURACION_S=$DuracionS", '-e', "INTERVALO_MS=$IntervaloMs", 'sonda') $Lote
}

function Iniciar-K6([string]$Script, [string]$Lote, [string[]]$Extra = @(), [switch]$Csv) {
  $a = @('compose', '--profile', 'pruebas', 'run', '--rm', '-e', "LOTE=$Lote") + $Extra + @('k6', 'run')
  if ($Csv) { $a += @('--out', "csv=/resultados/k6-$Lote.csv") }
  $a += "/scripts/$Script"
  Iniciar-Proceso 'k6' $a $Lote
}

# Captura CPU/RAM de cada contenedor cada ~2 s mientras el proceso indicado siga vivo
function Iniciar-Stats([string]$Lote) {
  $archivo = Join-Path $Global:Resultados "docker-stats-$Lote.csv"
  'timestamp,contenedor,cpu_pct,mem_uso,mem_pct,red_io' | Set-Content $archivo
  return Start-Job -ArgumentList $archivo -ScriptBlock {
    param($archivo)
    while ($true) {
      $ts = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
      docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}},{{.MemPerc}},{{.NetIO}}' |
        ForEach-Object { "$ts,$_" } | Add-Content $archivo
      Start-Sleep -Seconds 2
    }
  }
}

function Guardar-Logs([string]$Lote, [string]$Desde) {
  $dir = Join-Path $Global:Resultados "logs-$Lote"
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  foreach ($c in 'pgpool-1', 'pgpool-2', 'pg-1', 'pg-2', 'lb-1', 'lb-2', 'lb-int-1', 'lb-int-2',
                 'modulo-a-1', 'modulo-a-2', 'modulo-b-1', 'modulo-b-2', 'modulo-c-1', 'modulo-c-2',
                 'redis-1', 'redis-2', 'redis-3', 'redis-4', 'redis-5', 'redis-6') {
    docker logs --timestamps --since $Desde $c *> (Join-Path $dir "$c.log")
  }
  Write-Host "Logs guardados en $dir" -ForegroundColor Cyan
}

function Verificar-Integridad([string]$Lote) {
  Start-Sleep -Seconds 3
  try {
    $r = Invoke-RestMethod "$($Global:UrlEntrada)/api/integridad?lote=$Lote" -TimeoutSec 60
  } catch {
    $r = Invoke-RestMethod "http://localhost:8081/api/integridad?lote=$Lote" -TimeoutSec 60
  }
  $r | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $Global:Resultados "integridad-$Lote.json")
  Write-Host "Integridad lote ${Lote}: PostgreSQL=$($r.pedidos_postgresql)  Redis=$($r.trazas_redis)  trazas sin pedido=$($r.trazas_sin_pedido)" -ForegroundColor Green
  return $r
}

function Guardar-EstadoCluster([string]$Lote, [string]$Etiqueta) {
  try {
    Invoke-RestMethod "$($Global:UrlEntrada)/api/cluster-status" -TimeoutSec 15 | ConvertTo-Json -Depth 8 |
      Set-Content (Join-Path $Global:Resultados "cluster-status-$Lote-$Etiqueta.json")
  } catch { Write-Warning "No se pudo guardar cluster-status ($Etiqueta)" }
}

function Esperar-Hasta([datetime]$Inicio, [int]$Segundo) {
  $obj = $Inicio.AddSeconds($Segundo)
  $resto = ($obj - (Get-Date)).TotalMilliseconds
  if ($resto -gt 0) { Start-Sleep -Milliseconds ([int]$resto) }
}

function Esperar-Saludable([int]$TimeoutS = 120) {
  # Espera hasta que todos los contenedores con healthcheck estén "healthy"
  $fin = (Get-Date).AddSeconds($TimeoutS)
  while ((Get-Date) -lt $fin) {
    $mal = docker ps -a --filter "label=com.docker.compose.project=$($Global:Proyecto)" --format '{{.Names}} {{.Status}}' |
      Where-Object { $_ -notmatch '\(healthy\)' -and $_ -notmatch '^redis-cluster-init ' }
    if (-not $mal) { Write-Host 'Todos los contenedores están healthy.' -ForegroundColor Green; return }
    Start-Sleep -Seconds 3
  }
  Write-Warning "Hay contenedores que no están healthy:`n$($mal -join "`n")"
}
