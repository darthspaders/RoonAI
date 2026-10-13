$ErrorActionPreference = 'Stop'
$nasaRoot = Join-Path $PSScriptRoot '../../data/nasa-whitecap/library'
$nasaStability = Join-Path $nasaRoot 'stability.json'
if (-not (Test-Path -LiteralPath $nasaStability)) { throw 'Record a successful live stability check before enabling maintenance.' }
if (-not ((Get-Content -LiteralPath $nasaStability -Raw | ConvertFrom-Json).verified)) { throw 'Initial stability has not been verified.' }
$nasaNode = (Get-Command node.exe).Source
$nasaScript = Join-Path $PSScriptRoot 'maintenance.cjs'
$nasaPython = $env:RH_TEST_PYTHON
if (-not $nasaPython -or -not (Test-Path -LiteralPath $nasaPython)) { throw 'Set RH_TEST_PYTHON to the verified Python/Pillow runtime.' }
$nasaCommand = "`$env:RH_TEST_PYTHON = '$($nasaPython.Replace("'","''"))'; & '$($nasaNode.Replace("'","''"))' '$($nasaScript.Replace("'","''"))'"
$nasaEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($nasaCommand))
$nasaAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand $nasaEncoded"
$nasaTrigger = New-ScheduledTaskTrigger -Daily -At '12:30'
$nasaPrincipal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$nasaSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
# Do not replace an unrelated task; this exact task name is owned by this add-on.
$nasaTask = Get-ScheduledTask -TaskName 'Rabbit Hole NASA library' -ErrorAction SilentlyContinue
if ($nasaTask -and $nasaTask.Description -ne 'Rabbit Hole native NASA image library maintenance v1') { throw 'Unowned scheduled task preserved.' }
Register-ScheduledTask -TaskName 'Rabbit Hole NASA library' -Description 'Rabbit Hole native NASA image library maintenance v1' -Action $nasaAction -Trigger $nasaTrigger -Principal $nasaPrincipal -Settings $nasaSettings -Force | Out-Null
