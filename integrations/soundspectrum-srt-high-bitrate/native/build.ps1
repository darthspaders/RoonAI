param(
  [Parameter(Mandatory=$true)][string]$SdkRoot,
  [string]$VcVars='C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars64.bat'
)
$ErrorActionPreference='Stop'
$taskRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$taskOutput=Join-Path $taskRoot 'data/soundspectrum-srt-high-bitrate/patched-plugin'
$taskBuild=Join-Path $taskOutput 'build'
$taskSdk=[IO.Path]::GetFullPath($SdkRoot)
if(-not (Test-Path -LiteralPath (Join-Path $taskSdk 'include/gstreamer-1.0/gst/gst.h'))) { throw 'Expected pinned GStreamer developer root.' }
if(-not (Test-Path -LiteralPath $VcVars)) { throw 'MSVC x64 environment script unavailable.' }
$taskPrepared=& node (Join-Path $PSScriptRoot 'prepare.cjs')
if($LASTEXITCODE -ne 0) { throw 'Pinned patch preparation failed.' }
$taskPreparation=$taskPrepared|ConvertFrom-Json
# Obtain the compiler environment once. No shell is used for file operations.
$taskEnvironment=& cmd.exe /d /c ('call "'+$VcVars+'" >nul && set')
if($LASTEXITCODE -ne 0) { throw 'MSVC environment initialization failed.' }
foreach($taskLine in $taskEnvironment) {
  if($taskLine -match '^([^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1],$matches[2],'Process') }
}
$taskCl=(Get-Command cl.exe -ErrorAction Stop).Source
$taskUtf8=New-Object Text.UTF8Encoding($false)
$taskSlash={param($p) $p.Replace('\','/')}
$taskUnitArgs=@('/nologo','/TC','/W4','/WX','/O2','/MD',
  ('/Fe"'+(& $taskSlash (Join-Path $taskBuild 'listener-backpressure.test.exe'))+'"'),
  ('/Fo"'+(& $taskSlash (Join-Path $taskBuild 'listener-backpressure.test.obj'))+'"'),
  ('"'+(& $taskSlash (Join-Path $taskBuild 'listener-backpressure.test.c'))+'"'))
$taskUnitRsp=Join-Path $taskBuild 'unit.rsp'
[IO.File]::WriteAllLines($taskUnitRsp,$taskUnitArgs,$taskUtf8)
& $taskCl ('@'+$taskUnitRsp)
if($LASTEXITCODE -ne 0) { throw 'Native regression compilation failed.' }
& (Join-Path $taskBuild 'listener-backpressure.test.exe')
if($LASTEXITCODE -ne 0) { throw 'Native regression cases failed.' }
$taskArgs=@('/nologo','/TC','/LD','/O2','/MD','/W3','/DHAVE_CONFIG_H','/DGST_USE_UNSTABLE_API','/DWIN32_LEAN_AND_MEAN','/DSRT_DYNAMIC')
foreach($taskInclude in @($taskBuild,(Join-Path $taskSdk 'include'),(Join-Path $taskSdk 'include/gstreamer-1.0'),(Join-Path $taskSdk 'include/glib-2.0'),(Join-Path $taskSdk 'lib/glib-2.0/include'))) {
  $taskArgs+=('/I"'+(& $taskSlash $taskInclude)+'"')
}
$taskArgs+=('/Fo"'+(& $taskSlash $taskBuild)+'/"')
foreach($taskSource in @('gstsrt.c','gstsrtelement.c','gstsrtplugin.c','gstsrtobject.c','gstsrtsink.c','gstsrtsrc.c','gstsrt-enumtypes.c')) {
  $taskArgs+=('"'+(& $taskSlash (Join-Path $taskBuild $taskSource))+'"')
}
$taskDll=Join-Path $taskOutput 'gstsrt.dll'
$taskSrtLib=if(Test-Path -LiteralPath (Join-Path $taskSdk 'lib/srt.lib')) {'srt.lib'} else {'libsrt.lib'}
$taskArgs+=@('/link',('/OUT:"'+(& $taskSlash $taskDll)+'"'),('/IMPLIB:"'+(& $taskSlash (Join-Path $taskBuild 'gstsrt.lib'))+'"'),('/LIBPATH:"'+(& $taskSlash (Join-Path $taskSdk 'lib'))+'"'),
 'gstbase-1.0.lib','gstreamer-1.0.lib','gio-2.0.lib','gobject-2.0.lib','glib-2.0.lib',$taskSrtLib,'ws2_32.lib')
$taskRsp=Join-Path $taskBuild 'plugin.rsp'
[IO.File]::WriteAllText($taskRsp,($taskArgs -join ' '),$taskUtf8)
& $taskCl ('@'+$taskRsp)
if($LASTEXITCODE -ne 0) { throw 'Isolated SRT plugin compilation failed.' }
foreach($taskHarness in @('listener-stop','listener-recovery')) {
$taskStopArgs=@('/nologo','/TC','/O2','/MD','/W3','/DWIN32_LEAN_AND_MEAN','/DSRT_DYNAMIC')
foreach($taskInclude in @((Join-Path $taskSdk 'include'),(Join-Path $taskSdk 'include/gstreamer-1.0'),(Join-Path $taskSdk 'include/glib-2.0'),(Join-Path $taskSdk 'lib/glib-2.0/include'))) {
  $taskStopArgs+=('/I"'+(& $taskSlash $taskInclude)+'"')
}
$taskStopArgs+=@(('/Fe"'+(& $taskSlash (Join-Path $taskBuild ($taskHarness+'.test.exe')))+'"'),('/Fo"'+(& $taskSlash (Join-Path $taskBuild ($taskHarness+'.test.obj')))+'"'),
  ('"'+(& $taskSlash (Join-Path $taskBuild ($taskHarness+'.test.c')))+'"'),'/link',('/LIBPATH:"'+(& $taskSlash (Join-Path $taskSdk 'lib'))+'"'),
  'gstreamer-1.0.lib','gobject-2.0.lib','glib-2.0.lib',$taskSrtLib,'ws2_32.lib')
$taskStopRsp=Join-Path $taskBuild ($taskHarness+'.rsp')
[IO.File]::WriteAllText($taskStopRsp,($taskStopArgs -join ' '),$taskUtf8)
& $taskCl ('@'+$taskStopRsp)
if($LASTEXITCODE -ne 0) { throw 'Actual listener regression compilation failed.' }
}
$taskHash=(Get-FileHash -LiteralPath $taskDll -Algorithm SHA256).Hash.ToLowerInvariant()
$taskManifest=@{version=1;revision='listener-backpressure-2';sha256=$taskHash}
[IO.File]::WriteAllText((Join-Path $taskOutput 'backpressure-plugin.json'),($taskManifest|ConvertTo-Json),$taskUtf8)
$taskSources=@{}
Get-ChildItem -LiteralPath $PSScriptRoot -File | Where-Object {$_.Extension -in '.c','.h','.cjs','.ps1','.json'} | ForEach-Object {
  $taskSources[$_.Name]=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
}
$taskReceipt=@{revision='listener-backpressure-2';upstreamVersion='1.26.11';pluginVersion='1.26.11.2';builtAt=[DateTime]::UtcNow.ToString('o');sha256=$taskHash;preparation=$taskPreparation;sources=$taskSources;compiler=$taskCl;sdkRoot=$taskSdk;nativeRegressionCases=13;sharedRuntimeReplaced=$false}
[IO.File]::WriteAllText((Join-Path $taskOutput 'build-receipt.json'),($taskReceipt|ConvertTo-Json -Depth 7),$taskUtf8)
$taskManifest|ConvertTo-Json -Compress
