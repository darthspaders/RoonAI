param(
  [string]$RuntimeRoot = ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\data\soundspectrum-gstreamer\1.26.11')))
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$version = '1.26.11'
$packageName = "gstreamer-1.0-msvc-x86_64-$version.msi"
$packageUrl = "https://gstreamer.freedesktop.org/data/pkg/windows/$version/msvc/$packageName"
$resolvedRoot = [IO.Path]::GetFullPath($RuntimeRoot)

# Read-only MSI cabinet extraction copies this official runtime into an app-local
# directory. It never executes installation, changes PATH, or installs drivers.
New-Item -ItemType Directory -Path $resolvedRoot -Force | Out-Null
$existing = Get-ChildItem -LiteralPath $resolvedRoot -Filter 'gst-launch-1.0.exe' -File -Recurse | Select-Object -First 1
if (-not $existing) {
  $packages = Join-Path $resolvedRoot '_packages'
  New-Item -ItemType Directory -Path $packages -Force | Out-Null
  $packagePath = Join-Path $packages $packageName
  $checksumContent = (Invoke-WebRequest -Uri "$packageUrl.sha256sum" -UseBasicParsing).Content
  $checksumText = if ($checksumContent -is [byte[]]) { [Text.Encoding]::UTF8.GetString($checksumContent) } else { [string]$checksumContent }
  if ($checksumText -notmatch '(?i)\b([a-f0-9]{64})\b') {
    throw 'The official GStreamer SHA-256 checksum was missing.'
  }
  $expectedHash = $Matches[1].ToUpperInvariant()
  if (-not (Test-Path -LiteralPath $packagePath) -or (Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash -ne $expectedHash) {
    & node (Join-Path $PSScriptRoot 'soundspectrum-download.cjs') $packageUrl $packagePath
    if ($LASTEXITCODE -ne 0) { throw "GStreamer download failed (exit $LASTEXITCODE)." }
  }
  if ((Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash -ne $expectedHash) {
    throw 'GStreamer download failed its official SHA-256 checksum.'
  }
  & (Join-Path $PSScriptRoot 'soundspectrum-extract.ps1') -PackagePath $packagePath -RuntimeRoot $resolvedRoot
  $existing = Get-ChildItem -LiteralPath $resolvedRoot -Filter 'gst-launch-1.0.exe' -File -Recurse | Select-Object -First 1
}
if (-not $existing) { throw 'Extracted GStreamer runtime did not contain gst-launch-1.0.exe.' }
$inspectPath = Join-Path $existing.DirectoryName 'gst-inspect-1.0.exe'
foreach ($element in @('d3d11screencapturesrc', 'd3d11convert', 'd3d11download', 'jpegenc', 'multipartmux', 'fdsink')) {
  $inspectionProcess = New-Object Diagnostics.Process
  $inspectionProcess.StartInfo.FileName = $inspectPath
  $inspectionProcess.StartInfo.Arguments = $element
  $inspectionProcess.StartInfo.UseShellExecute = $false
  $inspectionProcess.StartInfo.CreateNoWindow = $true
  $inspectionProcess.StartInfo.RedirectStandardOutput = $true
  $inspectionProcess.StartInfo.RedirectStandardError = $true
  $null = $inspectionProcess.Start()
  $outputTask = $inspectionProcess.StandardOutput.ReadToEndAsync()
  $errorTask = $inspectionProcess.StandardError.ReadToEndAsync()
  if (-not $inspectionProcess.WaitForExit(30000)) { $inspectionProcess.Kill(); throw 'GStreamer inspection timed out.' }
  $inspection = $outputTask.Result + $errorTask.Result
  $inspectionExit = $inspectionProcess.ExitCode
  $inspectionProcess.Dispose()
  if ($inspectionExit -ne 0) { throw "GStreamer element '$element' is unavailable: $inspection" }
  if ($element -eq 'd3d11screencapturesrc' -and ($inspection -notmatch 'window-capture-mode' -or $inspection -notmatch 'Windows Graphics Capture')) {
    throw 'GStreamer does not support the required Windows Graphics Capture client-area mode.'
  }
}
# The background task may have a different inherited environment from this
# terminal. Save the exact checked runtime in the app's ignored local data.
$runtimeDataDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\data'))
New-Item -ItemType Directory -Path $runtimeDataDirectory -Force | Out-Null
$runtimeConfigPath = Join-Path $runtimeDataDirectory 'soundspectrum-runtime.json'
$runtimeTemporaryPath = Join-Path $runtimeDataDirectory ("soundspectrum-runtime.$PID.tmp")
$runtimeConfig = [ordered]@{ version = $version; executable = $existing.FullName; root = $resolvedRoot; source = $packageUrl; capture = 'window-client-wgc' } | ConvertTo-Json
[IO.File]::WriteAllText($runtimeTemporaryPath, $runtimeConfig, (New-Object Text.UTF8Encoding($false)))
Move-Item -LiteralPath $runtimeTemporaryPath -Destination $runtimeConfigPath -Force
[ordered]@{ ready = $true; version = $version; root = $resolvedRoot; executable = $existing.FullName; capture = 'window-client-wgc'; audio = $false } | ConvertTo-Json -Compress
