[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$OutPath,

  [switch]$PreviewOnly,

  [string]$IdentityName,

  [string]$Publisher,

  [string]$PublisherDisplayName,

  [string]$PackageVersion
)

$ErrorActionPreference = "Stop"

function Get-SinglePackageFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Description,

    [Parameter(Mandatory = $true)]
    [object[]]$Files
  )

  if ($Files.Count -ne 1) {
    throw "Expected exactly one $Description, found $($Files.Count)"
  }
  $Files[0]
}

$packageDirectory = Get-SinglePackageFile `
  -Description "packaged application directory" `
  -Files @(
    Get-ChildItem $OutPath -Directory |
      Where-Object { $_.Name -like "mdbase connect-win32-*" }
  )
$application = Get-SinglePackageFile `
  -Description "packaged application executable" `
  -Files @(
    Get-ChildItem $packageDirectory.FullName -File -Filter "mdbase-connect.exe"
  )
$connector = Get-SinglePackageFile `
  -Description "packaged connector CLI" `
  -Files @(
    Get-ChildItem (Join-Path $packageDirectory.FullName "resources") `
      -File `
      -Filter "mdbase.exe"
  )
$installer = Get-SinglePackageFile `
  -Description "Squirrel installer" `
  -Files @(
    Get-ChildItem (Join-Path $OutPath "make") -Recurse -File -Filter "*.exe" |
      Where-Object { $_.Name -match "Setup" }
  )
$portable = Get-SinglePackageFile `
  -Description "portable Windows archive" `
  -Files @(
    Get-ChildItem (Join-Path $OutPath "make") -Recurse -File -Filter "*.zip"
  )
foreach ($file in @($application, $connector, $installer)) {
  $signature = Get-AuthenticodeSignature $file.FullName
  if ($signature.Status -ne "NotSigned") {
    throw "Expected unsigned GitHub preview executable, got $($signature.Status): $($file.FullName)"
  }
}

if ($PreviewOnly) {
  $storePackages = @(
    Get-ChildItem (Join-Path $OutPath "make") -Recurse -File -Filter "*.appx"
  )
  if ($storePackages.Count -ne 0) {
    throw "Preview-only build unexpectedly produced a Microsoft Store AppX package"
  }
  Write-Output "Verified unsigned setup preview: $($installer.FullName)"
  Write-Output "Verified unsigned portable preview: $($portable.FullName)"
  exit 0
}

foreach ($value in @{
  IdentityName = $IdentityName
  Publisher = $Publisher
  PublisherDisplayName = $PublisherDisplayName
  PackageVersion = $PackageVersion
}.GetEnumerator()) {
  if ([string]::IsNullOrWhiteSpace([string]$value.Value)) {
    throw "$($value.Key) is required when verifying a Microsoft Store package"
  }
}

$storePackage = Get-SinglePackageFile `
  -Description "Microsoft Store AppX package" `
  -Files @(
    Get-ChildItem (Join-Path $OutPath "make") -Recurse -File -Filter "*.appx"
  )

function Find-WindowsSdkTool {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  $tool = Get-Command $Name -ErrorAction SilentlyContinue
  if ($tool) {
    return $tool
  }

  $sdkRoot = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
  $tool = Get-ChildItem $sdkRoot -Recurse -File -Filter $Name |
    Where-Object { $_.DirectoryName -match "\\x64$" } |
    Sort-Object FullName -Descending |
    Select-Object -First 1
  if (-not $tool) {
    throw "Could not find $Name in the Windows SDK"
  }
  $tool
}

$signTool = Find-WindowsSdkTool -Name "signtool.exe"
& $signTool.FullName verify /pa /v $storePackage.FullName
if ($LASTEXITCODE -ne 0) {
  throw "Store package development signature verification failed"
}

$makeAppx = Find-WindowsSdkTool -Name "makeappx.exe"
$unpacked = Join-Path $env:RUNNER_TEMP "mdbase-connect-appx"
& $makeAppx.FullName unpack /p $storePackage.FullName /d $unpacked /o
if ($LASTEXITCODE -ne 0) {
  throw "Could not unpack Store package"
}

[xml]$manifest = Get-Content (Join-Path $unpacked "AppxManifest.xml")
$identity = $manifest.Package.Identity
$properties = $manifest.Package.Properties
$applicationNode = $manifest.Package.Applications.Application
if ($identity.Name -ne $IdentityName) {
  throw "Store identity name does not match Partner Center"
}
if ($identity.Publisher -ne $Publisher) {
  throw "Store publisher does not match Partner Center"
}
if ($identity.Version -ne $PackageVersion) {
  throw "Unexpected Store package version: $($identity.Version)"
}
if ([string]$properties.PublisherDisplayName -ne $PublisherDisplayName) {
  throw "Store publisher display name does not match Partner Center"
}
if ($applicationNode.Executable -ne "app\mdbase-connect.exe") {
  throw "Unexpected Store package executable: $($applicationNode.Executable)"
}
$storeConnector = Join-Path $unpacked "app\resources\mdbase.exe"
if (-not (Test-Path $storeConnector -PathType Leaf)) {
  throw "Microsoft Store package does not contain the connector CLI"
}
if ((Get-Item $storeConnector).Length -eq 0) {
  throw "Microsoft Store package contains an empty connector CLI"
}

Write-Output "Verified Store package: $($storePackage.FullName)"
Write-Output "Verified unsigned setup preview: $($installer.FullName)"
Write-Output "Verified unsigned portable preview: $($portable.FullName)"
