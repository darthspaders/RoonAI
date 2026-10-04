param([Parameter(Mandatory=$true)][string]$PackagePath, [Parameter(Mandatory=$true)][string]$RuntimeRoot)
$ErrorActionPreference = 'Stop'
$resolvedRoot = [IO.Path]::GetFullPath($RuntimeRoot)
$rootPrefix = $resolvedRoot.TrimEnd('\') + '\'
$packageDirectory = Join-Path $resolvedRoot '_packages'
$cabinetDirectory = Join-Path $packageDirectory 'expanded'
New-Item -ItemType Directory -Path $cabinetDirectory -Force | Out-Null
if (-not ('SoundSpectrumMsiStream' -as [type])) { Add-Type -Path (Join-Path $PSScriptRoot 'soundspectrum-msi-stream.cs') }
$msiReader = New-Object -ComObject WindowsInstaller.Installer
$database = $msiReader.OpenDatabase([IO.Path]::GetFullPath($PackagePath),0)

function Read-MsiRows([string]$Query, [int]$Columns) {
  $view = $database.OpenView($Query)
  $null = $view.Execute()
  try {
    while ($record = $view.Fetch()) {
      $values = @()
      for ($column = 1; $column -le $Columns; $column++) { $values += $record.StringData($column) }
      Write-Output -NoEnumerate $values
    }
  } finally { $null = $view.Close() }
}

$directories = @{}
foreach ($row in (Read-MsiRows 'SELECT `Directory`, `Directory_Parent`, `DefaultDir` FROM `Directory`' 3)) {
  $directories[$row[0]] = @($row[1], $row[2])
}
$components = @{}
foreach ($row in (Read-MsiRows 'SELECT `Component`, `Directory_` FROM `Component`' 2)) { $components[$row[0]] = $row[1] }
$paths = @{ SDKROOTDIR = $resolvedRoot }
function Resolve-MsiDirectory([string]$Id, [int]$Depth=0) {
  if ($Depth -gt 50) { throw 'Unexpected MSI directory nesting.' }
  if ($paths.ContainsKey($Id)) { return $paths[$Id] }
  if (-not $directories.ContainsKey($Id)) { throw "Unknown MSI directory '$Id'." }
  $directory = $directories[$Id]
  if (-not $directory[0]) { throw 'Runtime file was outside the GStreamer SDK root.' }
  $parentPath = Resolve-MsiDirectory $directory[0] ($Depth+1)
  $name = ($directory[1] -split ':')[0]
  $name = ($name -split '\|')[-1]
  if ($name -eq '.') { $result = $parentPath } else { $result = [IO.Path]::GetFullPath((Join-Path $parentPath $name)) }
  if ($result -ne $resolvedRoot -and -not $result.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'MSI directory escaped the local runtime root.' }
  $paths[$Id] = $result
  return $result
}

foreach ($row in (Read-MsiRows 'SELECT `Cabinet` FROM `Media`' 1)) {
  $cabinetName = $row[0].TrimStart('#')
  if ($cabinetName -notmatch '^cab[0-9]+\.cab$') { throw 'Unexpected MSI cabinet.' }
  $cabinetPath = Join-Path $packageDirectory $cabinetName
  [SoundSpectrumMsiStream]::Extract($PackagePath, $cabinetName, $cabinetPath)
  $expandProcess = Start-Process -FilePath (Join-Path $env:WINDIR 'System32\expand.exe') -ArgumentList @('-F:*', ('"' + $cabinetPath + '"'), ('"' + $cabinetDirectory + '"')) -WindowStyle Hidden -PassThru -Wait -RedirectStandardOutput (Join-Path $packageDirectory 'expand-output.txt') -RedirectStandardError (Join-Path $packageDirectory 'expand-error.txt')
  if ($expandProcess.ExitCode -ne 0) { throw "GStreamer cabinet extraction failed ($($expandProcess.ExitCode))." }
}
$fileCount = 0
foreach ($row in (Read-MsiRows 'SELECT `File`, `Component_`, `FileName` FROM `File`' 3)) {
  $sourceName = $row[0]
  if ($sourceName -ne [IO.Path]::GetFileName($sourceName)) { throw 'Unexpected MSI cabinet filename.' }
  $fileName = ($row[2] -split '\|')[-1]
  if ($fileName -ne [IO.Path]::GetFileName($fileName)) { throw 'Unexpected MSI runtime filename.' }
  $destinationDirectory = Resolve-MsiDirectory $components[$row[1]]
  New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
  $sourcePath = Join-Path $cabinetDirectory $sourceName
  $destinationPath = [IO.Path]::GetFullPath((Join-Path $destinationDirectory $fileName))
  if (-not $destinationPath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'MSI runtime file escaped its local root.' }
  Copy-Item -LiteralPath $sourcePath -Destination $destinationPath -Force
  $fileCount++
}
[ordered]@{extracted=$fileCount;root=$resolvedRoot} | ConvertTo-Json -Compress | Write-Verbose
