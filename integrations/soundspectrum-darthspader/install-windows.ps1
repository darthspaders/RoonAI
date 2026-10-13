param(
  [ValidateSet('install', 'remove', 'update')][string]$Action = 'install',
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
if ($ExpectedSid -and $identity.User.Value -ne $ExpectedSid) { throw 'Run the installer as the same Windows user who uses G-Force.' }

if (-not $isAdmin) {
  if ($ElevatedWorker) { throw 'Windows did not grant administrator access.' }
  # Windows displays its own UAC prompt. This helper never accepts or bypasses it.
  $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Action ' + $Action + ' -ElevatedWorker -ExpectedSid "' + $identity.User.Value + '" -NodePath "' + $NodePath + '"'
  Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -ArgumentList $arguments | Out-Null
  Write-Output 'Windows administrator prompt requested. Installer result: ../../data/soundspectrum-darthspader-installer.log'
  exit
}

$logPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../data/soundspectrum-darthspader-installer.log'))
New-Item -ItemType Directory -Path ([System.IO.Path]::GetDirectoryName($logPath)) -Force | Out-Null
Push-Location -LiteralPath $PSScriptRoot
try {
  & $NodePath (Join-Path $PSScriptRoot 'install.cjs') $Action *> $logPath
  if ($LASTEXITCODE -ne 0) { throw 'Installer failed. Review the private installer log; owned partial files can be removed safely.' }
} finally { Pop-Location }
