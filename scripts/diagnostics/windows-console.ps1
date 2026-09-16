param([Parameter(Mandatory)][int]$DaemonPid, [Parameter(Mandatory)][string]$Report)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Console diagnostics are restricted to disposable GitHub Windows runners.'
}
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ConsoleProbe {
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint processId);
    [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
}
'@
# A separate disposable process detaches only its OWN console before inspecting
# the actual scheduled daemon. No windows are hidden, closed, or reparented.
[ConsoleProbe]::FreeConsole() | Out-Null
$attached = [ConsoleProbe]::AttachConsole($DaemonPid)
$errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
$window = [ConsoleProbe]::GetConsoleWindow()
@{
    daemonPid = $DaemonPid
    attached = $attached
    attachError = $(if ($attached) { 0 } else { $errorCode })
    hasConsoleWindow = $window -ne [IntPtr]::Zero
    visible = [ConsoleProbe]::IsWindowVisible($window)
} | ConvertTo-Json | Set-Content -Encoding UTF8 $Report
[ConsoleProbe]::FreeConsole() | Out-Null
if (-not $attached) { throw "Could not inspect daemon console: $errorCode" }
