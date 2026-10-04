param(
  [ValidateSet("Install", "Run")][string]$Action = "Install",
  [string]$NodePath
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$TaskName = "Rabbit Hole services"

if ($Action -eq "Run") {
  try {
    if (-not $NodePath -or -not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
      throw "The configured Node.js executable is missing. Reinstall the Rabbit Hole background task."
    }
    Set-Location -LiteralPath $Root
    & $NodePath (Join-Path $PSScriptRoot "start-all.js")
    exit $LASTEXITCODE
  } catch {
    Add-Content -LiteralPath (Join-Path $Root "service-supervisor.log") -Value "[$([DateTime]::UtcNow.ToString('o'))] Background launcher failed: $($_.Exception.Message)"
    exit 1
  }
}

$BackgroundScript = Join-Path $PSScriptRoot "background-task.ps1"
$Existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($Existing -and -not ($Existing.Actions | Where-Object { $_.Arguments.Contains('-File "' + $BackgroundScript + '"') })) {
  throw "A different installation owns the '$TaskName' task. It was not changed."
}
$NodePath = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
  throw "Could not resolve a single Node.js executable. The background task was not changed."
}
$PowerShellPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$Arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $BackgroundScript + '" -Action Run -NodePath "' + $NodePath + '"'
$TaskAction = New-ScheduledTaskAction -Execute $PowerShellPath -Argument $Arguments -WorkingDirectory $Root
$UserId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$Principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Limited
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $UserId
$RecoveryTrigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Minutes 1)
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $TaskName -Action $TaskAction -Principal $Principal -Trigger @($Trigger, $RecoveryTrigger) -Settings $Settings -Description "Runs the existing Rabbit Hole app and MCP supervisor independently of Codex or a terminal. Starts at sign-in and checks once a minute; a running instance is left alone." -Force | Out-Null
Write-Host "Installed '$TaskName' for $UserId. Run npm run restart to use it."
