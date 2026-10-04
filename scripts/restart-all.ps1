$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Ports = @(3777, 3797)
$PidFile = Join-Path $Root "data\service-supervisor.pid"
$BackgroundScript = Join-Path $PSScriptRoot "background-task.ps1"
$BackgroundTask = Get-ScheduledTask -TaskName "Rabbit Hole services" -ErrorAction SilentlyContinue
if ($BackgroundTask -and -not ($BackgroundTask.Actions | Where-Object { $_.Arguments.Contains('-File "' + $BackgroundScript + '"') })) {
  throw "A different installation owns the Rabbit Hole background task. No services were stopped."
}

function Stop-ProcessSafely {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [int]$WaitMs = 8000
  )

  $Process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if (-not $Process) { return }

  Stop-Process -Id $ProcessId -ErrorAction SilentlyContinue
  $Deadline = (Get-Date).AddMilliseconds($WaitMs)
  do {
    Start-Sleep -Milliseconds 200
    $Process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  } while ($Process -and (Get-Date) -lt $Deadline)

  if ($Process) {
    Write-Host "Process $ProcessId did not exit gracefully; stopping it forcefully"
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
  }
}

if ($BackgroundTask) {
  # Suspend all triggers while the intentional restart replaces the old processes.
  Disable-ScheduledTask -InputObject $BackgroundTask | Out-Null
}

try {
  if ($BackgroundTask) {
    Stop-ScheduledTask -InputObject $BackgroundTask
    $TaskStopDeadline = (Get-Date).AddSeconds(10)
    while ((Get-ScheduledTask -TaskName $BackgroundTask.TaskName).State -eq "Running") {
      if ((Get-Date) -gt $TaskStopDeadline) { throw "The Rabbit Hole background task has not stopped. No replacement was launched." }
      Start-Sleep -Milliseconds 200
    }
  }

  if (Test-Path -LiteralPath $PidFile) {
    $SupervisorId = (Get-Content -Raw -LiteralPath $PidFile -ErrorAction SilentlyContinue).Trim()
    $Supervisor = Get-CimInstance Win32_Process -Filter "ProcessId=$SupervisorId" -ErrorAction SilentlyContinue
    if ($Supervisor -and $Supervisor.CommandLine -match "scripts[\\/]start-all\.js") {
      Write-Host "Stopping Rabbit Hole supervisor $SupervisorId"
      Stop-ProcessSafely -ProcessId ([int]$SupervisorId)
    }
  }

  foreach ($Port in $Ports) {
    $Connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    foreach ($Connection in $Connections) {
      $ProcessId = $Connection.OwningProcess
      if ($ProcessId -and $ProcessId -ne $PID) {
        Write-Host "Stopping process $ProcessId on port $Port"
        Stop-ProcessSafely -ProcessId $ProcessId
      }
    }
  }

  Start-Sleep -Seconds 1
} finally {
  if ($BackgroundTask) { Enable-ScheduledTask -InputObject $BackgroundTask | Out-Null }
}
Write-Host "Starting Rabbit Hole and Rabbit Hole MCP"
if ($BackgroundTask) {
  Start-ScheduledTask -InputObject $BackgroundTask
  Write-Host "Started through Windows Task Scheduler (independent of this terminal)."
} else {
  Start-Process -FilePath "npm.cmd" -ArgumentList "start" -WorkingDirectory $Root -WindowStyle Hidden
}

$StartupDeadline = (Get-Date).AddSeconds(30)
do {
  $Ready = $true
  foreach ($HealthUrl in @("http://127.0.0.1:3777/api/status", "http://127.0.0.1:3797/health")) {
    try {
      $Response = Invoke-WebRequest -UseBasicParsing -Uri $HealthUrl -TimeoutSec 2
      if ($Response.StatusCode -ne 200) { $Ready = $false }
    } catch { $Ready = $false }
  }
  if ($Ready) {
    Write-Host "Rabbit Hole and MCP are responding on ports 3777 and 3797."
    return
  }
  Start-Sleep -Milliseconds 500
} while ((Get-Date) -lt $StartupDeadline)
throw "Rabbit Hole did not become ready within 30 seconds. Check service-supervisor.log."
