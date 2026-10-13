param([switch]$Install)
$ErrorActionPreference='Stop'
$taskRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskBuild=Join-Path $taskRoot 'data/soundspectrum-native-clock/build'
# A packaged desktop host can virtualize LocalAppData: files visible here may be
# absent to an ordinary Task Scheduler process. Use a shared user-profile path.
$taskBase=[IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.rabbit-hole/native-clock'))
$taskName='Rabbit Hole native visualizer clock'
if(-not $Install){Write-Output 'Prepared only. -Install deploys validated adapter files and the current-user logon/recovery task.';exit 0}
# Upgrades must not replace an adapter still loaded in a live visualizer.
$taskNative=Get-Process -ErrorAction SilentlyContinue|Where-Object {$_.ProcessName -in @('WhiteCap Standalone.x64','Aeon Standalone.x64','G-Force Standalone.x64')}
if($taskNative){throw 'Close standalone visualizers before installing/upgrading the native clock.'}
$taskReceipt=Get-Content -LiteralPath (Join-Path $taskBuild 'build.json') -Raw|ConvertFrom-Json
foreach($taskNameToCheck in @('common.hpp','adapter.cpp','launcher.cpp','build.ps1')){if((Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $taskNameToCheck)).Hash.ToLowerInvariant() -ne $taskReceipt.files.$taskNameToCheck){throw 'Source/build mismatch.'}}
foreach($taskNameToCheck in @('native-clock.dll','native-clock-launcher.exe')){if((Get-FileHash -LiteralPath (Join-Path $taskBuild $taskNameToCheck)).Hash.ToLowerInvariant() -ne $taskReceipt.files.$taskNameToCheck){throw 'Binary/build mismatch.'}}
$taskValidationFile=Join-Path $taskBuild 'validated-products.json'
$taskValidation=Get-Content -LiteralPath $taskValidationFile -Raw|ConvertFrom-Json
if($taskValidation.adapterSha256 -ne $taskReceipt.files.'native-clock.dll'){throw 'Validation does not identify this adapter build.'}
if(-not $taskValidation.products -or $taskValidation.products[0] -ne 'WhiteCap' -or @($taskValidation.products|Where-Object {$_ -notin @('WhiteCap','Aeon','G-Force')}).Count){throw 'Validated products invalid.'}
$taskExisting=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
$taskVersion=$taskReceipt.files.'native-clock.dll'.Substring(0,16)+'-'+$taskReceipt.files.'native-clock-launcher.exe'.Substring(0,12)+'-'+($taskValidation.products -join '-')
$taskDestination=Join-Path $taskBase $taskVersion
$taskExe=Join-Path $taskDestination 'native-clock-launcher.exe'
if($taskExisting -and ($taskExisting.Description -ne 'Rabbit Hole owned standalone native clock v1' -or -not ([IO.Path]::GetFullPath($taskExisting.Actions.Execute).StartsWith([IO.Path]::GetFullPath($taskBase)+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)))){throw 'Unrelated task has the requested name.'}
# Stage a complete version before touching the current task. Keep old versions recoverable.
[IO.Directory]::CreateDirectory($taskDestination)|Out-Null
foreach($taskFile in @('native-clock.dll','native-clock-launcher.exe','adapter.sha256','build.json','validated-products.json')){
 $taskSource=Join-Path $taskBuild $taskFile;$taskTarget=Join-Path $taskDestination $taskFile
 if((Test-Path -LiteralPath $taskTarget) -and (Get-FileHash -LiteralPath $taskSource).Hash -eq (Get-FileHash -LiteralPath $taskTarget).Hash){continue}
 Copy-Item -LiteralPath $taskSource -Destination $taskTarget -Force
 if((Get-FileHash -LiteralPath $taskSource).Hash -ne (Get-FileHash -LiteralPath $taskTarget).Hash){throw 'Staged installation verification failed.'}
}
[IO.File]::WriteAllText((Join-Path $taskDestination 'enabled.txt'),(($taskValidation.products -join "`r`n")+"`r`n"),(New-Object Text.UTF8Encoding($false)))
$taskIdentity=[Security.Principal.WindowsIdentity]::GetCurrent().Name
$taskAction=New-ScheduledTaskAction -Execute $taskExe -WorkingDirectory $taskDestination
$taskTrigger=New-ScheduledTaskTrigger -AtLogOn -User $taskIdentity
$taskRecoveryTrigger=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$taskPrincipal=New-ScheduledTaskPrincipal -UserId $taskIdentity -LogonType Interactive -RunLevel Limited
$taskSettings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
$taskPreviousXml=if($taskExisting){Export-ScheduledTask -TaskName $taskName}else{$null}
$taskRegistered=$false
try{
 if($taskExisting){
  Disable-ScheduledTask -TaskName $taskName|Out-Null
  # Ask the verified owner to release its session mutex, then stop scheduling.
  # A task state transition alone is not proof that its GUI process has exited.
  & $taskExisting.Actions.Execute --stop-watcher
  Stop-ScheduledTask -TaskName $taskName
  for($taskAttempt=0;$taskAttempt -lt 30;$taskAttempt++){
   $taskOld=@(Get-Process -Name native-clock-launcher -ErrorAction SilentlyContinue|Where-Object {$_.Path -eq $taskExisting.Actions.Execute})
   if(-not $taskOld.Count){break};Start-Sleep -Milliseconds 100
  }
  if($taskOld.Count){throw 'Previous owned watcher did not exit; upgrade aborted.'}
 }
 if(Get-Process -ErrorAction SilentlyContinue|Where-Object {$_.ProcessName -in @('WhiteCap Standalone.x64','Aeon Standalone.x64','G-Force Standalone.x64')}){throw 'Native launch raced installation; existing watcher will be restored.'}
 # Explicit repeating trigger also recovers exits not classified as a failed run
 # by this Windows scheduler. IgnoreNew and the watcher mutex prevent duplicates.
 Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger @($taskTrigger,$taskRecoveryTrigger) -Principal $taskPrincipal -Settings $taskSettings -Description 'Rabbit Hole owned standalone native clock v1' -Force|Out-Null
 $taskRegistered=$true
 Export-ScheduledTask -TaskName $taskName | Set-Content -LiteralPath (Join-Path $taskBuild 'installed-task.private.xml') -Encoding UTF8
 Start-ScheduledTask -TaskName $taskName
 for($taskAttempt=0;$taskAttempt -lt 10;$taskAttempt++){Start-Sleep -Milliseconds 500;if((Get-ScheduledTask -TaskName $taskName).State -eq 'Running'){break}}
 if((Get-ScheduledTask -TaskName $taskName).State -ne 'Running'){$taskInfo=Get-ScheduledTaskInfo -TaskName $taskName;throw ('Installed watcher did not remain running. Task result: '+$taskInfo.LastTaskResult)}
}catch{
 if($taskRegistered){Disable-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue|Out-Null;& $taskExe --stop-watcher;Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue}
 if($taskPreviousXml){Register-ScheduledTask -TaskName $taskName -Xml $taskPreviousXml -Force|Out-Null;Start-ScheduledTask -TaskName $taskName}
 elseif($taskRegistered){Unregister-ScheduledTask -TaskName $taskName -Confirm:$false}
 throw
}
$taskFinal=Get-ScheduledTask -TaskName $taskName
@{task=$taskName;state=[string]$taskFinal.State;installed=$taskDestination;products=$taskValidation.products;adapterSha256=$taskReceipt.files.'native-clock.dll';vendorBinariesModified=$false}|ConvertTo-Json -Depth 4
