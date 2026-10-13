param(
  [ValidateSet('plan', 'plan-update', 'install', 'update', 'remove')][string]$Action = 'plan',
  [switch]$ElevatedWorker,
  [string]$ExpectedSid = '',
  [string]$NodePath = ''
)

$ErrorActionPreference = 'Stop'
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
$isAdmin = $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $NodePath) { $NodePath = (Get-Command node.exe -ErrorAction Stop).Source }
if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw 'Node.js was not found.' }
if ($ExpectedSid -and $identity.User.Value -ne $ExpectedSid) { throw 'Use the same Windows account that runs G-Force.' }

# Planning reads local files only and never asks for elevation or writes a log.
if ($Action -in @('plan', 'plan-update')) {
  & $NodePath (Join-Path $PSScriptRoot 'install.cjs') $Action
  if ($LASTEXITCODE -ne 0) { throw 'Meters installation plan failed; no installation was attempted.' }
  exit
}
if (-not $isAdmin) {
  if ($ElevatedWorker) { throw 'Windows did not grant administrator access.' }
  $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Action ' + $Action + ' -ElevatedWorker -ExpectedSid "' + $identity.User.Value + '" -NodePath "' + $NodePath + '"'
  Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -ArgumentList $arguments | Out-Null
  Write-Output 'Windows administrator prompt requested. Result: ../../data/soundspectrum-meters-installer.log'
  exit
}
$logPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../data/soundspectrum-meters-installer.log'))
New-Item -ItemType Directory -Path ([System.IO.Path]::GetDirectoryName($logPath)) -Force | Out-Null
Push-Location -LiteralPath $PSScriptRoot
try {
  & $NodePath (Join-Path $PSScriptRoot 'install.cjs') $Action *> $logPath
  if ($LASTEXITCODE -ne 0) { throw 'Meters installer stopped; review its private log. Existing journals allow guarded resume or removal.' }
} finally { Pop-Location }
