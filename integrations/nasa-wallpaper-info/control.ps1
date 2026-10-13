param([ValidateSet('start','stop','inspect','details','render-caption','enable-startup','disable-startup','status')][string]$Action = 'status')
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$stateFolder = Join-Path $projectRoot 'data\nasa-wallpaper-info'
$program = Join-Path $stateFolder 'bin\NasaDesktopInfo.exe'
$startupLink = Join-Path ([Environment]::GetFolderPath('Startup')) 'Rabbit Hole NASA Information.lnk'
if ($Action -eq 'status') {
    $statusFile = Join-Path $stateFolder 'status.json'
    if (Test-Path -LiteralPath $statusFile) {
        $recorded = Get-Content -LiteralPath $statusFile -Raw | ConvertFrom-Json
        $liveProcess = Get-Process -Id $recorded.pid -ErrorAction SilentlyContinue
        $recorded | Add-Member -NotePropertyName processAlive -NotePropertyValue ([bool]($liveProcess -and $liveProcess.Path -eq $program)) -Force
        $recorded | ConvertTo-Json -Depth 6
    } else { Write-Output 'NASA desktop information has not been started.' }
    Write-Output ('Start with Windows: ' + (Test-Path -LiteralPath $startupLink))
    return
}
if ($Action -eq 'disable-startup') {
    if (Test-Path -LiteralPath $startupLink) {
        $existing = (New-Object -ComObject WScript.Shell).CreateShortcut($startupLink)
        if ($existing.TargetPath -ne $program) { throw 'The shortcut belongs to another target; it was left unchanged.' }
        Remove-Item -LiteralPath $startupLink
    }
    Write-Output 'NASA desktop information will no longer start at sign-in. Current display is unchanged.'
    return
}
if (!(Test-Path -LiteralPath $program)) { throw 'Build first: powershell -File integrations/nasa-wallpaper-info/build.ps1' }
if ($Action -eq 'enable-startup') {
    $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($startupLink)
    if ((Test-Path -LiteralPath $startupLink) -and $shortcut.TargetPath -ne $program) { throw 'The shortcut belongs to another target; it was left unchanged.' }
    $shortcut.TargetPath = $program
    $shortcut.WorkingDirectory = $projectRoot
    $shortcut.Arguments = '--root "' + $projectRoot + '"'
    $shortcut.Description = 'Desktop-only titles and details for the existing NASA wallpaper catalog.'
    $shortcut.Save()
    Write-Output 'NASA desktop information will start for this user at sign-in.'
    return
}
$arguments = @('--root', ('"' + $projectRoot + '"'))
if ($Action -ne 'start') { $arguments += '--' + $Action }
$child = Start-Process -FilePath $program -ArgumentList $arguments -WindowStyle Hidden -PassThru
if ($Action -eq 'inspect') {
    if (!$child.WaitForExit(30000)) { throw 'Wallpaper inspection has not completed in 30 seconds.' }
    if ($child.ExitCode -ne 0) { throw 'Inspect failed; see data/nasa-wallpaper-info/error.json.' }
    Get-Content -LiteralPath (Join-Path $stateFolder 'inspection.json')
} else { Write-Output ('NASA desktop information: ' + $Action + ' requested.') }
