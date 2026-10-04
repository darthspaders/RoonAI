$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$LogFile = Join-Path $Root "data\beatport-fast-backfill.log"
$Worker = Join-Path $Root "scripts\beatport-enrichment-backfill.js"

function Write-BackfillLog {
  param([string]$Message)
  Add-Content -LiteralPath $LogFile -Value "[$(Get-Date -Format o)] $Message"
}

Write-BackfillLog "Fast standalone Beatport backfill started at the worker safety cap (approximately 0.5 requests/second)."

try {
  while ($true) {
    $batch = & node $Worker --limit 500 --delay-ms 0 --jitter 0 2>&1
    foreach ($line in $batch) {
      Add-Content -LiteralPath $LogFile -Value ([string]$line)
    }

    $exitCode = $LASTEXITCODE
    $text = $batch -join "`n"
    if ($exitCode -ne 0) {
      Write-BackfillLog "Backfill worker exited with code $exitCode; Rabbit Hole will be restarted."
      break
    }
    if ($text -match '"scanned"\s*:\s*0') {
      Write-BackfillLog "No eligible tracks remain; Rabbit Hole will be restarted."
      break
    }
    Start-Sleep -Seconds 1
  }
} catch {
  Write-BackfillLog "Backfill supervisor error: $($_.Exception.Message)"
} finally {
  if (-not @(Get-NetTCPConnection -LocalPort 3777 -State Listen -ErrorAction SilentlyContinue).Count) {
    Write-BackfillLog "Starting Rabbit Hole and Rabbit Hole MCP."
    Start-Process -FilePath "npm.cmd" -ArgumentList "start" -WorkingDirectory $Root -WindowStyle Hidden | Out-Null
  } else {
    Write-BackfillLog "Rabbit Hole is already listening; no restart was needed."
  }
}
