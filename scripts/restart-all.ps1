$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Ports = @(3777, 3797)

foreach ($Port in $Ports) {
  $Connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  foreach ($Connection in $Connections) {
    $ProcessId = $Connection.OwningProcess
    if ($ProcessId -and $ProcessId -ne $PID) {
      Write-Host "Stopping process $ProcessId on port $Port"
      Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
}

Start-Sleep -Seconds 1
Write-Host "Starting Rabbit Hole and Rabbit Hole MCP"
Start-Process -FilePath "npm.cmd" -ArgumentList "start" -WorkingDirectory $Root -WindowStyle Hidden
