param([Parameter(Mandatory=$true)][string]$Python)
$ErrorActionPreference = 'Stop'
$appRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$envRoot = Join-Path $appRoot 'data/nasa-whitecap/preprocessing/venv'
$workerPython = Join-Path $envRoot 'Scripts/python.exe'
# Use the existing link guard before writing the isolated environment.
Push-Location $appRoot
try {
    node -e "require('./integrations/soundspectrum-nasa-backgrounds/library.cjs').noLinks('data/nasa-whitecap/preprocessing/venv').catch(e=>{console.error(e.message);process.exitCode=1})"
    if ($LASTEXITCODE -ne 0) { throw 'Unsafe preprocessing environment path' }
    if (-not (Test-Path -LiteralPath $workerPython)) {
        & $Python -m venv $envRoot
        if ($LASTEXITCODE -ne 0) { throw 'Preprocessing venv creation failed' }
    }
    & $workerPython -m pip install --disable-pip-version-check --only-binary=:all: -r (Join-Path $PSScriptRoot 'requirements.txt')
    if ($LASTEXITCODE -ne 0) { throw 'Preprocessing dependency installation failed' }
    & $workerPython -m pip check
    if ($LASTEXITCODE -ne 0) { throw 'Preprocessing dependency check failed' }
    Write-Output "Offline preprocessing environment ready: $workerPython"
} finally { Pop-Location }
