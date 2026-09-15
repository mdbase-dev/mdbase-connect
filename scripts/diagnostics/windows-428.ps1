param(
    [ValidateSet('fresh', 'upgrade')][string]$Scenario = 'fresh',
    [switch]$Child,
    [string]$Root
)
$ErrorActionPreference = 'Stop'

if (-not $Child) {
    if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
        throw 'Account/lifecycle tests are restricted to disposable GitHub Windows runners.'
    }
    $Root = Join-Path $env:PUBLIC ('mdbase-428-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $Root | Out-Null
    Copy-Item $PSCommandPath (Join-Path $Root 'diagnostic.ps1')
    Copy-Item (Join-Path $env:RUNNER_TEMP 'issue428-binaries') (Join-Path $Root 'binaries') -Recurse
    $user = 'mdbase428test'
    $password = ConvertTo-SecureString ('Aa1!' + [guid]::NewGuid().ToString('N')) -AsPlainText -Force
    $localUser = New-LocalUser -Name $user -Password $password -Description 'Disposable issue 428 qualification'
    Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class TestUserProfile {
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    public static extern int CreateProfile(string sid, string userName, StringBuilder profilePath, uint size);
}
'@
    $process = $null
    try {
        $profilePath = New-Object System.Text.StringBuilder(260)
        $created = [TestUserProfile]::CreateProfile($localUser.SID.Value, $user, $profilePath, 260)
        if ($created -ne 0) { throw "Could not create Windows test profile: HRESULT $created" }
        Add-LocalGroupMember -Group (Get-LocalGroup -SID 'S-1-5-32-545') -Member $user
        & icacls.exe $Root /grant "${env:COMPUTERNAME}\${user}:(OI)(CI)M" | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Could not grant fixture access.' }
        # Use Process directly: no PowerShell Start-Process job-tree wait when a
        # tested CLI launches its long-running background daemon.
        $info = [Diagnostics.ProcessStartInfo]::new((Get-Process -Id $PID).Path)
        $info.UseShellExecute = $false
        $info.UserName = $user
        $info.Domain = $env:COMPUTERNAME
        $info.Password = $password
        $info.LoadUserProfile = $true
        $info.WorkingDirectory = $Root
        foreach ($arg in @('-NoProfile', '-File', (Join-Path $Root 'diagnostic.ps1'), '-Child', '-Scenario', $Scenario, '-Root', $Root)) { $info.ArgumentList.Add($arg) }
        $process = [Diagnostics.Process]::Start($info)
        if (-not $process.WaitForExit(240000)) { $process.Kill($true); throw 'Native lifecycle child timed out; partial results retained.' }
        if ($process.ExitCode -ne 0) { throw "Native lifecycle child failed with exit $($process.ExitCode)." }
    } finally {
        $old = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        if ($process -and -not $process.HasExited) { $process.Kill($true) }
        Get-CimInstance Win32_Process -Filter "Name='mdbase.exe'" | Where-Object { $_.ExecutablePath -like "$Root\*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        & schtasks.exe /Delete /F /TN 'mdbase connect' 2>$null | Out-Null
        Remove-LocalUser -Name $user
        $report = Join-Path $Root 'result.json'
        if (Test-Path $report) {
            New-Item -ItemType Directory -Force (Join-Path $env:GITHUB_WORKSPACE '.artifacts/issue428') | Out-Null
            Copy-Item $report (Join-Path $env:GITHUB_WORKSPACE ".artifacts/issue428/$Scenario.json")
            Get-Content $report
        }
        $ErrorActionPreference = $old
    }
    exit
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$report = [ordered]@{
    scenario = $Scenario
    windows = [Environment]::OSVersion.VersionString
    standardUser = -not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    results = @()
    activeProbe = $null
}
function Save-Report { $report | ConvertTo-Json -Depth 12 | Set-Content -Encoding UTF8 (Join-Path $Root 'result.json') }
function Invoke-Probe([string]$Name, [string]$Program, [string[]]$Arguments) {
    $report.activeProbe = $Name
    Save-Report
    $info = [Diagnostics.ProcessStartInfo]::new($Program)
    $info.UseShellExecute = $false
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    foreach ($arg in $Arguments) { $info.ArgumentList.Add($arg) }
    $before = Get-Date
    $p = [Diagnostics.Process]::Start($info)
    $stdout = $p.StandardOutput.ReadToEndAsync()
    $stderr = $p.StandardError.ReadToEndAsync()
    if (-not $p.WaitForExit(25000)) { $p.Kill($true); throw "Probe timed out: $Name" }
    # Bound stream completion as well; inherited pipe handles must not hang CI.
    if (-not [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($stdout, $stderr), 3000)) { throw "Probe output did not close: $Name" }
    $result = [ordered]@{ name = $Name; exitCode = $p.ExitCode; elapsedMs = [int]((Get-Date) - $before).TotalMilliseconds; stdout = $stdout.Result.Trim(); stderr = $stderr.Result.Trim() }
    $report.results += $result
    $report.activeProbe = $null
    Save-Report
    return $result
}
function Binary([string]$Version) {
    $files = @(Get-ChildItem (Join-Path $Root "binaries/$Version") -Recurse -Filter mdbase.exe)
    if ($files.Count -ne 1) { throw 'Expected one public release CLI executable.' }
    return $files[0].FullName
}
function Require-Success($Result) { if ($Result.exitCode -ne 0) { throw "Failed probe: $($Result.name)" } }
function Wait-Running([string]$Binary, [bool]$Expected) {
    for ($i = 0; $i -lt 15; $i++) {
        $result = Invoke-Probe "daemon-running-$Expected-$i" $Binary @('--state-dir', $state, '--json', 'connect', 'daemon', 'status')
        if ($result.exitCode -eq 0 -and ($result.stdout | ConvertFrom-Json).running -eq $Expected) { return }
        Start-Sleep -Milliseconds 500
    }
    throw "Task did not bring daemon running state to $Expected in this logon session."
}
try {
    if (-not $report.standardUser) { throw 'Refusing an administrator test token.' }
    # Replace inherited runner-administrator environment with the profile that
    # Windows registered for this authenticated SID. No product state overrides.
    $profileKey = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$($identity.User.Value)"
    $env:USERPROFILE = [Environment]::ExpandEnvironmentVariables((Get-ItemProperty $profileKey).ProfileImagePath)
    $env:LOCALAPPDATA = Join-Path $env:USERPROFILE 'AppData\Local'
    $env:APPDATA = Join-Path $env:USERPROFILE 'AppData\Roaming'
    $env:HOME = $env:USERPROFILE
    $env:TEMP = Join-Path $env:LOCALAPPDATA 'Temp'
    $env:TMP = $env:TEMP
    New-Item -ItemType Directory -Force $env:LOCALAPPDATA, $env:APPDATA, $env:TEMP | Out-Null
    $binary = Binary '99'
    $probe = Join-Path $Root 'binaries/windows-service-probe.exe'
    $state = Join-Path $Root 'state & notes'
    $oldInstall = Invoke-Probe 'official-beta99-unscoped-install' $binary @('--json', 'connect', 'daemon', 'install')
    if ($oldInstall.exitCode -eq 0 -or $oldInstall.stderr -notmatch 'Access is denied') { throw 'Original standard-user registration failure was not reproduced.' }

    $initial = if ($Scenario -eq 'upgrade') { Binary '96' } else { $binary }
    Require-Success (Invoke-Probe 'production-scoped-install' $probe @('install', $initial, $state))
    $task = Get-ScheduledTask -TaskName 'mdbase connect'
    $report['task'] = @{ triggerMatchesUser = ($task.Triggers[0].UserId -eq $identity.User.Value); principalMatchesUser = ($task.Principal.UserId -eq $identity.User.Value -or $task.Principal.UserId -eq $identity.Name); runLevel = [string]$task.Principal.RunLevel; logonType = [string]$task.Principal.LogonType }
    if (-not $report.task.triggerMatchesUser -or -not $report.task.principalMatchesUser -or $report.task.runLevel -ne 'Limited') { throw 'Task identity/least-privilege invariant failed.' }
    Wait-Running $initial $true
    Require-Success (Invoke-Probe 'stop-before-replacement' $probe @('stop'))
    Wait-Running $initial $false
    Require-Success (Invoke-Probe 'production-scoped-replacement' $probe @('install', $binary, $state))
    Wait-Running $binary $true
    Require-Success (Invoke-Probe 'stop-before-cold-start' $probe @('stop'))
    Wait-Running $binary $false
    Require-Success (Invoke-Probe 'production-scoped-cold-start' $probe @('start'))
    Wait-Running $binary $true
    Require-Success (Invoke-Probe 'final-stop' $probe @('stop'))
    Wait-Running $binary $false
    Require-Success (Invoke-Probe 'production-uninstall' $probe @('uninstall'))
    if (Get-ScheduledTask -TaskName 'mdbase connect' -ErrorAction SilentlyContinue) { throw 'Task remained after uninstall.' }
    $report['passed'] = $true
} catch {
    $report['error'] = $_.Exception.Message
    $report['passed'] = $false
    throw
} finally { Save-Report }
