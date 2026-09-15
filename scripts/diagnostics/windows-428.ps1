param(
    [ValidateSet('fresh', 'upgrade')][string]$Scenario = 'fresh',
    [switch]$Child,
    [string]$Root
)
$ErrorActionPreference = 'Stop'

if (-not $Child) {
    if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
        throw 'This destructive-account diagnostic is restricted to a disposable GitHub Windows runner.'
    }
    $Root = Join-Path $env:PUBLIC ('mdbase-428-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $Root | Out-Null
    Copy-Item $PSCommandPath (Join-Path $Root 'diagnostic.ps1')
    Copy-Item (Join-Path $env:RUNNER_TEMP 'issue428-binaries') (Join-Path $Root 'binaries') -Recurse
    $user = 'mdbase428test'
    $password = ConvertTo-SecureString ('Aa1!' + [guid]::NewGuid().ToString('N')) -AsPlainText -Force
    $localUser = New-LocalUser -Name $user -Password $password -Description 'Disposable issue 428 diagnostic'
    Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class TestUserProfile {
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    public static extern int CreateProfile(string sid, string userName, StringBuilder profilePath, uint size);
}
'@
    $profilePath = New-Object System.Text.StringBuilder(260)
    $created = [TestUserProfile]::CreateProfile($localUser.SID.Value, $user, $profilePath, 260)
    if ($created -ne 0) { throw "Could not create disposable Windows profile: HRESULT $created" }
    $usersGroup = Get-LocalGroup -SID 'S-1-5-32-545'
    Add-LocalGroupMember -Group $usersGroup -Member $user
    $account = "$env:COMPUTERNAME\$user"
    & icacls.exe $Root /grant "${account}:(OI)(CI)M" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not grant fixture access.' }
    try {
        $credential = New-Object System.Management.Automation.PSCredential($account, $password)
        $process = Start-Process "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
            -Credential $credential -LoadUserProfile -WorkingDirectory $Root `
            -ArgumentList @('-NoProfile', '-File', (Join-Path $Root 'diagnostic.ps1'), '-Child', '-Scenario', $Scenario, '-Root', $Root) `
            -PassThru -RedirectStandardOutput (Join-Path $Root 'child.stdout') -RedirectStandardError (Join-Path $Root 'child.stderr')
        if (-not $process.WaitForExit(180000)) { $process.Kill(); throw 'Standard-user diagnostic timed out.' }
        $process.Refresh()
        $report = Join-Path $Root 'result.json'
        if (-not (Test-Path $report)) {
            Get-Content (Join-Path $Root 'child.stderr')
            throw 'Standard-user diagnostic produced no report.'
        }
        New-Item -ItemType Directory -Force (Join-Path $env:GITHUB_WORKSPACE '.artifacts/issue428') | Out-Null
        Copy-Item $report (Join-Path $env:GITHUB_WORKSPACE ".artifacts/issue428/$Scenario.json")
        Get-Content $report
        if ($process.ExitCode -ne 0) { throw "Diagnostic child exited $($process.ExitCode)." }
    } finally {
        # Task/account names exist only inside this newly provisioned runner.
        $ErrorActionPreference = 'Continue'
        & schtasks.exe /Delete /F /TN 'mdbase connect' 2>$null | Out-Null
        & schtasks.exe /Delete /F /TN 'mdbase-428-scoped' 2>$null | Out-Null
        & schtasks.exe /Delete /F /TN 'mdbase-428-once' 2>$null | Out-Null
        Get-CimInstance Win32_Process -Filter "Name='mdbase.exe'" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        Remove-LocalUser -Name $user
    }
    exit
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$report = [ordered]@{
    scenario = $Scenario
    windows = [Environment]::OSVersion.VersionString
    standardUser = -not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    results = @()
}
if (-not $report.standardUser) { throw 'Refusing an elevated or administrator test token.' }
# A newly created CI account has never had Explorer initialize its known folders.
# Materialize them via the Windows known-folder API, not a product state override.
$env:USERPROFILE = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile, [Environment+SpecialFolderOption]::Create)
$env:LOCALAPPDATA = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData, [Environment+SpecialFolderOption]::Create)
$env:APPDATA = [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData, [Environment+SpecialFolderOption]::Create)
$env:HOME = $env:USERPROFILE
$report['knownFoldersReady'] = [bool]($env:USERPROFILE -and $env:LOCALAPPDATA -and $env:APPDATA)
if (-not $report.knownFoldersReady) { throw 'Standard-user profile initialization failed.' }

function Invoke-Probe([string]$Name, [string]$Program, [string[]]$Arguments) {
    $before = Get-Date
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $output = & $Program @Arguments 2>&1 | Out-String
    $code = $LASTEXITCODE
    $ErrorActionPreference = $old
    $report.results += [ordered]@{ name = $Name; exitCode = $code; elapsedMs = [int]((Get-Date) - $before).TotalMilliseconds; output = $output.Trim() }
}
function Binary([string]$Version) {
    $files = @(Get-ChildItem (Join-Path $Root "binaries/$Version") -Recurse -Filter mdbase.exe)
    if ($files.Count -ne 1) { throw 'Expected exactly one public release CLI executable.' }
    return $files[0].FullName
}

try {
    if ($Scenario -eq 'upgrade') {
        $old = Binary '96'
        Invoke-Probe 'beta96-direct-start' $old @('--json', 'connect', 'daemon', 'start')
        Invoke-Probe 'beta96-status' $old @('--json', 'connect', 'daemon', 'status')
        Invoke-Probe 'beta96-stop' $old @('--json', 'connect', 'daemon', 'stop')
        Invoke-Probe 'beta97-service-install' (Binary '97') @('--json', 'connect', 'daemon', 'install')
    }
    $binary = Binary '99'
    Invoke-Probe 'beta99-service-install' $binary @('--json', 'connect', 'daemon', 'install')
    Invoke-Probe 'beta99-status' $binary @('--json', 'connect', 'daemon', 'status')
    Invoke-Probe 'query-product-task' 'schtasks.exe' @('/Query', '/TN', 'mdbase connect', '/FO', 'LIST')

    # Compare default all-user ONLOGON with a non-logon trigger and an explicitly
    # same-user logon trigger. Only harmless cmd.exe actions are registered.
    $action = "$env:SystemRoot\System32\cmd.exe /c exit 0"
    Invoke-Probe 'current-unscoped-onlogon-command' 'schtasks.exe' @('/Create', '/F', '/SC', 'ONLOGON', '/TN', 'mdbase connect', '/TR', $action, '/RL', 'LIMITED')
    Invoke-Probe 'same-user-once-command' 'schtasks.exe' @('/Create', '/F', '/SC', 'ONCE', '/ST', '23:59', '/TN', 'mdbase-428-once', '/TR', $action, '/RL', 'LIMITED')
    $sid = $identity.User.Value
    $xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>$sid</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>$sid</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings>
  <Actions Context="Author"><Exec><Command>$env:SystemRoot\System32\cmd.exe</Command><Arguments>/c exit 0</Arguments></Exec></Actions>
</Task>
"@
    $xmlPath = Join-Path $Root 'scoped-task.xml'
    $xml | Set-Content -Encoding Unicode $xmlPath
    Invoke-Probe 'explicit-user-logon-create' 'schtasks.exe' @('/Create', '/F', '/TN', 'mdbase-428-scoped', '/XML', $xmlPath)
    Invoke-Probe 'explicit-user-logon-replace' 'schtasks.exe' @('/Create', '/F', '/TN', 'mdbase-428-scoped', '/XML', $xmlPath)
    Invoke-Probe 'explicit-user-logon-run' 'schtasks.exe' @('/Run', '/TN', 'mdbase-428-scoped')
    foreach ($name in @('explicit-user-logon-create', 'explicit-user-logon-replace')) {
        if (($report.results | Where-Object { $_.name -eq $name }).exitCode -ne 0) { throw "Scoped task probe failed: $name" }
    }
} catch {
    $report['error'] = $_.Exception.Message
    throw
} finally {
    $report | ConvertTo-Json -Depth 12 | Set-Content -Encoding UTF8 (Join-Path $Root 'result.json')
}
