param([string]$OutputDirectory)
$ErrorActionPreference='Stop'
$taskRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if(-not $OutputDirectory){$OutputDirectory=Join-Path $taskRoot 'data/soundspectrum-native-clock/build'}
$taskOut=[IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($taskOut)|Out-Null
$taskVc='C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars64.bat'
$taskCompilerEnvironment=& cmd.exe /d /c ('call "'+$taskVc+'" >nul && set')
if($LASTEXITCODE -ne 0){throw 'Compiler unavailable.'}
foreach($taskLine in $taskCompilerEnvironment){if($taskLine -match '^([^=]+)=(.*)$'){[Environment]::SetEnvironmentVariable($matches[1],$matches[2],'Process')}}
& cl.exe /nologo /LD /O2 /MT /EHsc /std:c++17 /W4 (Join-Path $PSScriptRoot 'adapter.cpp') ('/Fo'+(Join-Path $taskOut 'adapter.obj')) ('/Fe'+(Join-Path $taskOut 'native-clock.dll')) /link /Brepro user32.lib comctl32.lib bcrypt.lib
if($LASTEXITCODE -ne 0){throw 'Adapter build failed.'}
& cl.exe /nologo /O2 /MT /EHsc /std:c++17 /W4 (Join-Path $PSScriptRoot 'launcher.cpp') ('/Fo'+(Join-Path $taskOut 'launcher.obj')) ('/Fe'+(Join-Path $taskOut 'native-clock-launcher.exe')) /link /SUBSYSTEM:WINDOWS /Brepro user32.lib shell32.lib advapi32.lib bcrypt.lib
if($LASTEXITCODE -ne 0){throw 'Launcher build failed.'}
& cl.exe /nologo /O2 /MT /EHsc /std:c++17 /W4 (Join-Path $PSScriptRoot 'common.test.cpp') ('/Fo'+(Join-Path $taskOut 'common.test.obj')) ('/Fe'+(Join-Path $taskOut 'common.test.exe')) /link bcrypt.lib
if($LASTEXITCODE -ne 0){throw 'Tests build failed.'}
& (Join-Path $taskOut 'common.test.exe')
if($LASTEXITCODE -ne 0){throw 'Common validation failed.'}
$taskReceipt=@{version=1;builtAt=[DateTime]::UtcNow.ToString('o');files=@{}}
foreach($taskName in @('common.hpp','adapter.cpp','launcher.cpp','build.ps1')){$taskReceipt.files[$taskName]=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $taskName)).Hash.ToLowerInvariant()}
foreach($taskName in @('native-clock.dll','native-clock-launcher.exe')){$taskReceipt.files[$taskName]=(Get-FileHash -LiteralPath (Join-Path $taskOut $taskName)).Hash.ToLowerInvariant()}
[IO.File]::WriteAllText((Join-Path $taskOut 'build.json'),($taskReceipt|ConvertTo-Json -Depth 5),(New-Object Text.UTF8Encoding($false)))
[IO.File]::WriteAllText((Join-Path $taskOut 'adapter.sha256'),$taskReceipt.files['native-clock.dll'],(New-Object Text.UTF8Encoding($false)))
$taskReceipt|ConvertTo-Json -Depth 5
