param([Parameter(Mandatory=$true)][string]$LanAddress,[string]$RuntimeRoot='', [int]$ObsPort=4565,[int]$HttpPort=8899,[int]$ApiPort=9996,[int]$UdpPort=8199)
$ErrorActionPreference='Stop'
if(-not $RuntimeRoot){$RuntimeRoot=Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'data\soundspectrum-obs-webrtc'}
$taskRoot=[IO.Path]::GetFullPath($RuntimeRoot)
$taskIp=$null
if(-not [Net.IPAddress]::TryParse($LanAddress,[ref]$taskIp) -or $taskIp.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or
  $taskIp.ToString() -ne $LanAddress -or
  $LanAddress -notmatch '^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)'){throw 'A private LAN IPv4 address is required.'}
$taskPorts=@($ObsPort,$HttpPort,$ApiPort,$UdpPort)
if(@($taskPorts|Select-Object -Unique).Count -ne 4 -or @($taskPorts|Where-Object{$_ -lt 1024 -or $_ -gt 65535}).Count){throw 'Four distinct unprivileged ports are required.'}
foreach($taskName in @('owner.lock','runtime.json','obs','mediamtx')){if(Test-Path -LiteralPath (Join-Path $taskRoot $taskName)){throw 'An existing prepared or owned runtime is present. Preparation will not overwrite it.'}}
New-Item -ItemType Directory -Path $taskRoot -Force|Out-Null
$taskDownloads=Join-Path $taskRoot 'downloads'
New-Item -ItemType Directory -Path $taskDownloads -Force|Out-Null
$taskAssets=@(
  @{name='OBS-Studio-32.2.2-Windows-x64.zip';url='https://github.com/obsproject/obs-studio/releases/download/32.2.2/OBS-Studio-32.2.2-Windows-x64.zip';hash='4d6e40e3ab155f56b30de517380566a206d74b63cdf5ad49aa596924768f97e1';folder='obs'},
  @{name='mediamtx_v1.21.1_windows_amd64.zip';url='https://github.com/bluenviron/mediamtx/releases/download/v1.21.1/mediamtx_v1.21.1_windows_amd64.zip';hash='faa97974861eb75a68b5aa326c78e7e7a6f670b5ef191bace78e715130381f23';folder='mediamtx'}
)
Add-Type -AssemblyName System.IO.Compression.FileSystem
foreach($taskAsset in $taskAssets){
  $taskArchive=Join-Path $taskDownloads $taskAsset.name
  if(-not(Test-Path -LiteralPath $taskArchive)){
    $taskPart=$taskArchive+'.part'
    Invoke-WebRequest -Uri $taskAsset.url -OutFile $taskPart -UseBasicParsing
    if((Get-FileHash -LiteralPath $taskPart -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskAsset.hash){throw 'Official archive checksum did not match.'}
    Move-Item -LiteralPath $taskPart -Destination $taskArchive
  }
  if((Get-FileHash -LiteralPath $taskArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskAsset.hash){throw 'Prepared archive checksum did not match.'}
  $taskDestination=[IO.Path]::GetFullPath((Join-Path $taskRoot $taskAsset.folder))
  if(-not $taskDestination.StartsWith($taskRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Preparation target left its runtime directory.'}
  $taskZip=[IO.Compression.ZipFile]::OpenRead($taskArchive)
  try{foreach($taskEntry in $taskZip.Entries){
    $taskResolved=[IO.Path]::GetFullPath((Join-Path $taskDestination $taskEntry.FullName))
    if(-not $taskResolved.StartsWith($taskDestination+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'An archive member left the extraction directory.'}
  }}finally{$taskZip.Dispose()}
  Expand-Archive -LiteralPath $taskArchive -DestinationPath $taskDestination
}
$taskObsRoot=Join-Path $taskRoot 'obs'
$taskObsExecutable=Join-Path $taskObsRoot 'bin\64bit\obs64.exe'
$taskRelayExecutable=Join-Path $taskRoot 'mediamtx\mediamtx.exe'
if(-not(Test-Path -LiteralPath $taskObsExecutable -PathType Leaf) -or -not(Test-Path -LiteralPath $taskRelayExecutable -PathType Leaf)){throw 'Official archive layout did not match the expected runtime.'}
if((Get-Item -LiteralPath $taskObsExecutable).VersionInfo.ProductVersion -ne '32.2.2'){throw 'The prepared OBS version did not match.'}
$taskConfig=@{version=1;obsVersion='32.2.2';mediaMtxVersion='1.21.1';obsRoot=$taskObsRoot;obsExecutable=$taskObsExecutable;relayExecutable=$taskRelayExecutable;lanAddress=$LanAddress;ports=@{obs=$ObsPort;http=$HttpPort;api=$ApiPort;udp=$UdpPort}}
[IO.File]::WriteAllText((Join-Path $taskRoot 'runtime.json'),($taskConfig|ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $taskRoot 'archives.json'),($taskAssets|Select-Object name,url,hash|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
Write-Output 'Separate video transport files prepared. No video or audio process was launched.'
