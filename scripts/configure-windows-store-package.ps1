[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$IdentityName,

  [Parameter(Mandatory = $true)]
  [string]$Publisher,

  [Parameter(Mandatory = $true)]
  [string]$PublisherDisplayName,

  [Parameter(Mandatory = $true)]
  [string]$PackageVersion,

  [string]$EnvironmentFile = $env:GITHUB_ENV
)

$ErrorActionPreference = "Stop"

foreach ($value in @{
  IdentityName = $IdentityName
  Publisher = $Publisher
  PublisherDisplayName = $PublisherDisplayName
  PackageVersion = $PackageVersion
  EnvironmentFile = $EnvironmentFile
}.GetEnumerator()) {
  if ([string]::IsNullOrWhiteSpace($value.Value)) {
    throw "$($value.Key) is required"
  }
}

$versionParts = $PackageVersion.Split(".")
if ($versionParts.Count -ne 4) {
  throw "Microsoft Store package version must contain four integer components"
}

$parsedVersionParts = foreach ($part in $versionParts) {
  $parsed = 0
  if (-not [int]::TryParse($part, [ref]$parsed) -or $parsed -lt 0 -or $parsed -gt 65535) {
    throw "Invalid Microsoft Store package version component: $part"
  }
  $parsed
}
if ($parsedVersionParts[0] -eq 0) {
  throw "Microsoft Store package version major component cannot be zero"
}
if ($parsedVersionParts[3] -ne 0) {
  throw "Microsoft Store package version revision component must be zero"
}

$certificatePath = Join-Path $env:RUNNER_TEMP "mdbase-connect-store-dev.pfx"
$certificateDerPath = Join-Path $env:RUNNER_TEMP "mdbase-connect-store-dev.cer"
$certificatePassword = [guid]::NewGuid().ToString("N")
Write-Output "::add-mask::$certificatePassword"
$securePassword = ConvertTo-SecureString $certificatePassword -AsPlainText -Force

$certificate = New-SelfSignedCertificate `
  -Type Custom `
  -Subject $Publisher `
  -KeyAlgorithm RSA `
  -KeyLength 3072 `
  -HashAlgorithm SHA256 `
  -KeyUsage DigitalSignature `
  -KeyExportPolicy Exportable `
  -CertStoreLocation "Cert:\CurrentUser\My" `
  -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3")
Export-Certificate `
  -Cert $certificate `
  -FilePath $certificateDerPath | Out-Null
Import-Certificate `
  -FilePath $certificateDerPath `
  -CertStoreLocation "Cert:\LocalMachine\TrustedPeople" | Out-Null
Export-PfxCertificate `
  -Cert $certificate `
  -FilePath $certificatePath `
  -Password $securePassword | Out-Null

@(
  "WINDOWS_STORE_IDENTITY_NAME=$IdentityName"
  "WINDOWS_STORE_PUBLISHER=$Publisher"
  "WINDOWS_STORE_PUBLISHER_DISPLAY_NAME=$PublisherDisplayName"
  "WINDOWS_STORE_PACKAGE_VERSION=$PackageVersion"
  "WINDOWS_STORE_DEV_CERT=$certificatePath"
  "WINDOWS_STORE_DEV_CERT_PASSWORD=$certificatePassword"
) | Add-Content -LiteralPath $EnvironmentFile
