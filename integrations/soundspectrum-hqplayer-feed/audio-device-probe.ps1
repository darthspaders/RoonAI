param([string]$RenderId = '', [string]$CaptureId = '')

# Read-only endpoint metadata. This helper never opens an audio client, changes
# a default device, enables Listen, or edits registry/driver settings.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Get-Endpoint([string]$Direction, [string]$EndpointId) {
  $prefix = if ($Direction -eq 'Render') { '{0.0.0.00000000}.' } else { '{0.0.1.00000000}.' }
  $root = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\' + $Direction
  $keys = if ($EndpointId) {
    if (-not $EndpointId.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid endpoint direction.' }
    $guid = $EndpointId.Substring($prefix.Length)
    if ($guid -notmatch '^\{[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}\}$') { throw 'An exact endpoint ID is required.' }
    $keyPath = Join-Path $root $guid
    if (Test-Path -LiteralPath $keyPath) { @(Get-Item -LiteralPath $keyPath) } else { @() }
  } else { @(Get-ChildItem -LiteralPath $root) }
  @($keys | ForEach-Object {
    $state = Get-ItemProperty -LiteralPath $_.PSPath
    $properties = Get-ItemProperty -LiteralPath (Join-Path $_.PSPath 'Properties')
    $interface = [string]$properties.'{b3f8fa53-0004-438e-9003-51a46e139bfc},6'
    if ($EndpointId -or $interface -eq 'SoundSpectrum Audio Cable') {
      $description = [string]$properties.'{a45c254e-df1c-4efd-8020-67d146a850e0},2'
      $listenKnown = $false
      $listenEnabled = $null
      if ($Direction -eq 'Capture') {
        $bytes = $properties.'{24dbb0fc-9311-4b3d-9cf0-18ff155639d4},1'
        # The installed endpoint stores a serialized VT_BOOL: type 11, one
        # value, 16-bit VARIANT_BOOL at offset 8. Any other form fails closed.
        if ($bytes -is [byte[]] -and $bytes.Length -eq 12 -and
            [BitConverter]::ToUInt32($bytes, 0) -eq 11 -and
            [BitConverter]::ToUInt32($bytes, 4) -eq 1 -and
            [BitConverter]::ToUInt16($bytes, 10) -eq 0) {
          $value = [BitConverter]::ToUInt16($bytes, 8)
          if ($value -eq 0 -or $value -eq 65535) { $listenKnown = $true; $listenEnabled = ($value -ne 0) }
        }
      }
      [pscustomobject]@{
        id = $prefix + $_.PSChildName.ToLowerInvariant()
        sourceId = $_.PSChildName.Trim('{}').ToLowerInvariant()
        state = [int]$state.DeviceState
        description = $description
        interfaceName = $interface
        name = $description + ' (' + $interface + ')'
        deviceIdentity = [string]$properties.'{b3f8fa53-0004-438e-9003-51a46e139bfc},2'
        listenKnown = $listenKnown
        listenEnabled = $listenEnabled
      }
    }
  })
}

@{ render = @(Get-Endpoint 'Render' $RenderId); capture = @(Get-Endpoint 'Capture' $CaptureId) } | ConvertTo-Json -Depth 5 -Compress
