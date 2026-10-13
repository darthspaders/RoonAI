param([switch]$Test)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$buildFolder = Join-Path $projectRoot 'data\nasa-wallpaper-info\bin'
New-Item -ItemType Directory -Path $buildFolder -Force | Out-Null
$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$compiler = Join-Path $framework 'csc.exe'
$references = @('System.dll','System.Core.dll','System.Web.Extensions.dll','System.Runtime.Serialization.dll','System.Xml.dll','System.Xml.Linq.dll','System.Drawing.dll','System.Windows.Forms.dll','WPF\WindowsBase.dll','WPF\PresentationCore.dll','WPF\PresentationFramework.dll','System.Xaml.dll') | ForEach-Object { '/reference:' + (Join-Path $framework $_) }
$common = @('/nologo','/platform:x64','/optimize+','/warn:4') + $references
if ($Test) {
    & $compiler @common '/target:exe' ('/out:' + (Join-Path $buildFolder 'Catalog.Tests.exe')) (Join-Path $PSScriptRoot 'Catalog.cs') (Join-Path $PSScriptRoot 'Catalog.Tests.cs')
    if ($LASTEXITCODE -ne 0) { throw 'Catalog tests did not compile.' }
    & (Join-Path $buildFolder 'Catalog.Tests.exe')
    if ($LASTEXITCODE -ne 0) { throw 'Catalog tests failed.' }
} else {
    & $compiler @common '/target:winexe' ('/win32manifest:' + (Join-Path $PSScriptRoot 'app.manifest')) ('/out:' + (Join-Path $buildFolder 'NasaDesktopInfo.exe')) (Join-Path $PSScriptRoot 'Catalog.cs') (Join-Path $PSScriptRoot 'Native.cs') (Join-Path $PSScriptRoot 'DesktopInfo.cs')
    if ($LASTEXITCODE -ne 0) { throw 'Desktop information helper did not compile.' }
    Write-Output (Join-Path $buildFolder 'NasaDesktopInfo.exe')
}
