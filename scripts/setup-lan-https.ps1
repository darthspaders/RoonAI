param(
  [Parameter(Mandatory = $true)][string]$Address,
  [int]$Port = 4433
)
$ErrorActionPreference = 'Stop'
$appRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$tlsRoot = Join-Path $appRoot 'data\lan-https'
if ($Address -notmatch '^(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$') { throw 'Use the current private LAN IPv4 address.' }
if (-not (Get-NetIPAddress -AddressFamily IPv4 | Where-Object IPAddress -eq $Address)) { throw 'The address does not belong to this computer.' }
if ($Port -lt 1024 -or $Port -gt 65535 -or $Port -in @(3777,3797)) { throw 'Choose a separate high TLS port.' }
if (Test-Path -LiteralPath (Join-Path $tlsRoot 'config.json')) { throw 'TLS setup already exists. Preserve its certificate and review renewal separately.' }
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { throw 'The requested TLS port is already in use.' }
New-Item -ItemType Directory -Path $tlsRoot -Force | Out-Null
$owner = [Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $tlsRoot /inheritance:r /grant:r "${owner}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not protect the private TLS directory.' }
$ca = New-SelfSignedCertificate -Type Custom -Subject 'CN=Rabbit Hole LAN CA' -CertStoreLocation 'Cert:\CurrentUser\My' -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeyUsage CertSign,CRLSign,DigitalSignature -TextExtension @('2.5.29.19={critical}{text}ca=1&pathlength=0') -NotAfter (Get-Date).AddYears(2)
$leaf = New-SelfSignedCertificate -Type Custom -Subject 'CN=Rabbit Hole LAN Player' -Signer $ca -CertStoreLocation 'Cert:\CurrentUser\My' -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeyExportPolicy Exportable -KeyUsage DigitalSignature,KeyEncipherment -TextExtension @("2.5.29.17={text}IPAddress=$Address&IPAddress=127.0.0.1&DNS=localhost",'2.5.29.37={text}1.3.6.1.5.5.7.3.1','2.5.29.19={critical}{text}ca=0') -NotAfter (Get-Date).AddMonths(6)
$passwordBytes = New-Object byte[] 32
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($passwordBytes); $rng.Dispose()
$passphrase = [Convert]::ToBase64String($passwordBytes)
Export-PfxCertificate -Cert $leaf -FilePath (Join-Path $tlsRoot 'server.pfx') -Password (ConvertTo-SecureString $passphrase -AsPlainText -Force) | Out-Null
$publicCa = Join-Path $appRoot 'public\rabbit-hole-lan-ca.cer'
Export-Certificate -Cert $ca -FilePath $publicCa | Out-Null
@{ enabled=$true; host=$Address; port=$Port; passphrase=$passphrase; caThumbprint=$ca.Thumbprint; leafThumbprint=$leaf.Thumbprint; expires=$leaf.NotAfter.ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $tlsRoot 'config.json') -Encoding UTF8
# No root trust store, firewall, DNS, cloud or service changes here.
Write-Output ('Prepared local TLS on port ' + $Port + '. Tablet CA installation and an app restart are still required.')
Write-Output ('CA SHA-256: ' + (Get-FileHash -LiteralPath $publicCa -Algorithm SHA256).Hash)
