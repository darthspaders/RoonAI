param([ValidateSet('identity','terminate')][string]$Action,[int]$ProcessId,[string]$ExpectedExecutable,[string]$StartTimeTicks='', [string]$ExpectedMarker='')
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
if($ProcessId -le 0 -or [string]::IsNullOrWhiteSpace($ExpectedExecutable)){throw 'An exact HLS helper identity is required.'}
$taskCandidate=Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
if($null -eq $taskCandidate){@{exited=$true}|ConvertTo-Json -Compress;exit}
$taskHandle=$taskCandidate.Handle
$taskActual=$taskCandidate.MainModule.FileName
$taskTicks=$taskCandidate.StartTime.ToUniversalTime().Ticks.ToString()
if(-not [string]::Equals([IO.Path]::GetFullPath($taskActual),[IO.Path]::GetFullPath($ExpectedExecutable),[StringComparison]::OrdinalIgnoreCase) -or ($StartTimeTicks -and $taskTicks -ne $StartTimeTicks)){
  @{identityChanged=$true}|ConvertTo-Json -Compress;exit
}
if($ExpectedMarker){
  if($ExpectedMarker.Length -lt 32 -or $ExpectedMarker.Length -gt 2048){throw 'Invalid HLS ownership marker.'}
  $taskCommand=(Get-CimInstance Win32_Process -Filter ('ProcessId = '+$ProcessId)).CommandLine
  if(-not $taskCommand -or -not $taskCommand.Contains($ExpectedMarker)){@{identityChanged=$true}|ConvertTo-Json -Compress;exit}
  if($taskCandidate.HasExited){@{exited=$true}|ConvertTo-Json -Compress;exit}
}
if($Action -eq 'terminate'){
  if(-not $StartTimeTicks -or -not $ExpectedMarker){throw 'Exact HLS start identity and marker are required.'}
  $taskCandidate.Kill()
  if(-not $taskCandidate.WaitForExit(3000)){throw 'The owned HLS helper did not exit.'}
  @{terminated=$true}|ConvertTo-Json -Compress
}else{@{pid=$taskCandidate.Id;executable=$taskActual;startTimeTicks=$taskTicks}|ConvertTo-Json -Compress}
