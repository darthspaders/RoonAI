param([string]$SdkRoot)
$ErrorActionPreference='Stop'
$taskRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
if(-not $SdkRoot){$SdkRoot=Join-Path $taskRoot 'data/soundspectrum-srt-high-bitrate/development-1.26.11/sdk'}
$taskSdk=[IO.Path]::GetFullPath($SdkRoot)
$taskOut=Join-Path $taskRoot 'data/soundspectrum-hls/native'
$taskSource=Join-Path $PSScriptRoot 'hls-wgc.cpp'
if(-not (Test-Path -LiteralPath (Join-Path $taskSdk 'include/gstreamer-1.0/gst/gst.h'))){throw 'Pinned GStreamer SDK unavailable.'}
[IO.Directory]::CreateDirectory($taskOut)|Out-Null
$taskVc='C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars64.bat'
$taskCompilerEnvironment=& cmd.exe /d /c ('call "'+$taskVc+'" >nul && set')
if($LASTEXITCODE -ne 0){throw 'Compiler environment unavailable.'}
foreach($taskLine in $taskCompilerEnvironment){if($taskLine -match '^([^=]+)=(.*)$'){[Environment]::SetEnvironmentVariable($matches[1],$matches[2],'Process')}}
$taskExe=Join-Path $taskOut 'hls-wgc.exe'
$taskObj=Join-Path $taskOut 'hls-wgc.obj'
$taskRsp=Join-Path $taskOut 'hls-wgc.rsp'
$taskArgs=@('/nologo','/TP','/std:c++17','/EHsc','/O2','/MD','/W4','/DWIN32_LEAN_AND_MEAN','/DNOMINMAX','/DGST_USE_UNSTABLE_API')
foreach($taskInclude in @('include','include/gstreamer-1.0','include/glib-2.0','lib/glib-2.0/include','lib/gstreamer-1.0/include')){$taskArgs+=('/I"'+(Join-Path $taskSdk $taskInclude).Replace('\','/')+'"')}
$taskArgs+=('/Fe"'+$taskExe.Replace('\','/')+'"')
$taskArgs+=('/Fo"'+$taskObj.Replace('\','/')+'"')
$taskArgs+=('"'+$taskSource.Replace('\','/')+'"')
$taskArgs+=@('/link','/Brepro',('/LIBPATH:"'+(Join-Path $taskSdk 'lib').Replace('\','/')+'"'),'gstd3d11-1.0.lib','gstapp-1.0.lib','gstvideo-1.0.lib','gstbase-1.0.lib','gstreamer-1.0.lib','gobject-2.0.lib','glib-2.0.lib','d3d11.lib','dxgi.lib','runtimeobject.lib','windowsapp.lib','user32.lib')
[IO.File]::WriteAllText($taskRsp,($taskArgs -join ' '),(New-Object Text.UTF8Encoding($false)))
& cl.exe ('@'+$taskRsp)
if($LASTEXITCODE -ne 0){throw 'Owned HLS capture helper build failed.'}
$taskReceipt=@{version='hls-wgc-3';protocol=1;gstreamerVersion='1.26.11';windowsSdk='10.0.19041.0';builtAt=[DateTime]::UtcNow.ToString('o');sourceSha256=(Get-FileHash -LiteralPath $taskSource -Algorithm SHA256).Hash.ToLowerInvariant();executableSha256=(Get-FileHash -LiteralPath $taskExe -Algorithm SHA256).Hash.ToLowerInvariant();buildScriptSha256=(Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant();executed=$false}
[IO.File]::WriteAllText((Join-Path $taskOut 'build.json'),($taskReceipt|ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))
$taskReceipt|ConvertTo-Json -Compress
