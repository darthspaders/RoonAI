param([ValidateSet('identity','terminate')][string]$Action,[int]$ProcessId,[string]$ExpectedExecutable,[string]$StartTimeTicks='')
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
if($ProcessId -le 0 -or [string]::IsNullOrWhiteSpace($ExpectedExecutable)){throw 'An exact helper identity is required.'}
$taskCandidate=Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
if($null -eq $taskCandidate){@{exited=$true}|ConvertTo-Json -Compress;exit}
# Retain this process's kernel handle while checking identity and terminating it.
$taskHandle=$taskCandidate.Handle
$taskActual=$taskCandidate.MainModule.FileName
if(-not [string]::Equals([IO.Path]::GetFullPath($taskActual),[IO.Path]::GetFullPath($ExpectedExecutable),[StringComparison]::OrdinalIgnoreCase)){throw 'Helper executable identity changed.'}
$taskTicks=$taskCandidate.StartTime.ToUniversalTime().Ticks.ToString()
if($StartTimeTicks -and $taskTicks -ne $StartTimeTicks){throw 'Helper start identity changed.'}
if($Action -eq 'terminate'){
  if(-not $StartTimeTicks){throw 'An exact start identity is required.'}
  $taskCandidate.Kill()
  if(-not $taskCandidate.WaitForExit(3000)){throw 'The owned helper did not exit.'}
  @{terminated=$true}|ConvertTo-Json -Compress
}else{@{pid=$taskCandidate.Id;executable=$taskActual;startTimeTicks=$taskTicks}|ConvertTo-Json -Compress}
