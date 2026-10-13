param([ValidateSet('identity','terminate','listener')][string]$Action,[int]$ProcessId,[string]$ExpectedExecutable,[string]$StartTimeTicks='', [string]$LocalAddress='', [int]$LocalPort=0)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
if($ProcessId -le 0 -or [string]::IsNullOrWhiteSpace($ExpectedExecutable)){throw 'An exact helper identity is required.'}
$taskCandidate=Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
if($null -eq $taskCandidate){@{exited=$true;listening=$false}|ConvertTo-Json -Compress;exit}
# Retain this exact kernel handle while checking identity and its private listener.
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
}elseif($Action -eq 'listener'){
  if(-not $StartTimeTicks -or $LocalPort -lt 1024 -or $LocalPort -gt 65535 -or $LocalAddress -notmatch '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)'){throw 'An exact private listener is required.'}
  $taskSockets=@(Get-NetUDPEndpoint -LocalPort $LocalPort -ErrorAction SilentlyContinue)
  $taskOwned=@($taskSockets|Where-Object {$_.OwningProcess -eq $ProcessId -and $_.LocalAddress -eq $LocalAddress})
  if($taskCandidate.HasExited){throw 'The owned listener process ended.'}
  @{listening=($taskOwned.Count -eq 1 -and $taskSockets.Count -eq 1)}|ConvertTo-Json -Compress
}else{@{pid=$taskCandidate.Id;executable=$taskActual;startTimeTicks=$taskTicks}|ConvertTo-Json -Compress}
