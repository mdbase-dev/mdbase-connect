//! The unit, plist and task definitions, as pure functions of the registered binary
//! (so they are tested on every OS, whatever the host).
//!
//! The service always runs the **installed profile**, so no `--state-dir` is passed
//! (passing one would make it an isolated profile, `paths::Target`).

use std::path::Path;

/// The arguments after the binary: run the daemon in the foreground.
pub const RUN_ARGS: [&str; 2] = ["daemon", "run"];

/// systemd user unit.
pub fn systemd_unit(exe: &Path) -> String {
    let exec = std::iter::once(systemd_quote(&exe.to_string_lossy()))
        .chain(RUN_ARGS.iter().map(|a| systemd_quote(a)))
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        "# Written by `mdbase service install`. Changes are overwritten on reinstall.\n\
         [Unit]\n\
         Description=mdbase daemon\n\
         Documentation=https://mdbase.dev\n\
         After=network-online.target\n\
         Wants=network-online.target\n\
         \n\
         [Service]\n\
         Type=simple\n\
         ExecStart={exec}\n\
         Restart=on-failure\n\
         RestartSec=2\n\
         TimeoutStopSec=20\n\
         NoNewPrivileges=true\n\
         PrivateTmp=true\n\
         ProtectSystem=full\n\
         \n\
         [Install]\n\
         WantedBy=default.target\n"
    )
}

/// The binary an `ExecStart=` line written by [`systemd_unit`] runs.
pub fn systemd_exec_binary(unit: &str) -> Option<String> {
    let line = unit.lines().find_map(|l| l.strip_prefix("ExecStart="))?;
    let rest = line.strip_prefix('"')?;
    let mut out = String::new();
    let mut chars = rest.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => out.push(chars.next()?),
            '"' => return Some(out),
            '$' | '%' => {
                // `$$` and `%%` are the escapes systemd_quote writes.
                if chars.next()? != c {
                    return None;
                }
                out.push(c);
            }
            c => out.push(c),
        }
    }
    None
}

/// One systemd command-line word: double-quoted, with `\`, `"`, `$` and `%`
/// escaped (systemd.service(5) "Command lines", systemd.unit(5) specifiers).
fn systemd_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '\\' | '"' => {
                out.push('\\');
                out.push(c);
            }
            '$' => out.push_str("$$"),
            '%' => out.push_str("%%"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// launchd agent. `KeepAlive` restarts only after a failure, so a graceful
/// `shutdown` (exit 0) stays stopped until `service start` or the next login.
pub fn launchd_plist(label: &str, exe: &Path) -> String {
    let args = std::iter::once(exe.to_string_lossy().into_owned())
        .chain(RUN_ARGS.iter().map(|a| a.to_string()))
        .map(|a| format!("\t\t<string>{}</string>\n", xml_escape(&a)))
        .collect::<String>();
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
         <plist version=\"1.0\">\n\
         <dict>\n\
         \t<key>Label</key>\n\
         \t<string>{label}</string>\n\
         \t<key>ProgramArguments</key>\n\
         \t<array>\n\
         {args}\
         \t</array>\n\
         \t<key>RunAtLoad</key>\n\
         \t<true/>\n\
         \t<key>KeepAlive</key>\n\
         \t<dict>\n\
         \t\t<key>SuccessfulExit</key>\n\
         \t\t<false/>\n\
         \t</dict>\n\
         \t<key>ThrottleInterval</key>\n\
         \t<integer>10</integer>\n\
         \t<key>ProcessType</key>\n\
         \t<string>Interactive</string>\n\
         </dict>\n\
         </plist>\n",
        label = xml_escape(label),
    )
}

/// The binary a plist written by [`launchd_plist`] runs.
pub fn launchd_binary(plist: &str) -> Option<String> {
    let after = plist.split("<key>ProgramArguments</key>").nth(1)?;
    let start = after.find("<string>")? + "<string>".len();
    let end = after[start..].find("</string>")? + start;
    Some(xml_unescape(&after[start..end]))
}

/// Task Scheduler task: at logon of this user only, in the user's interactive
/// session (the Credential Manager is unavailable elsewhere), least privilege,
/// restarted after a failure, never stopped for running long or on battery.
pub fn task_xml(user_sid: &str, exe: &Path) -> String {
    let args = RUN_ARGS.join(" ");
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-16\"?>\r\n\
         <Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">\r\n\
         \x20 <RegistrationInfo>\r\n\
         \x20   <Description>mdbase daemon (written by `mdbase service install`)</Description>\r\n\
         \x20 </RegistrationInfo>\r\n\
         \x20 <Triggers>\r\n\
         \x20   <LogonTrigger>\r\n\
         \x20     <Enabled>true</Enabled>\r\n\
         \x20     <UserId>{sid}</UserId>\r\n\
         \x20   </LogonTrigger>\r\n\
         \x20 </Triggers>\r\n\
         \x20 <Principals>\r\n\
         \x20   <Principal id=\"Author\">\r\n\
         \x20     <UserId>{sid}</UserId>\r\n\
         \x20     <LogonType>InteractiveToken</LogonType>\r\n\
         \x20     <RunLevel>LeastPrivilege</RunLevel>\r\n\
         \x20   </Principal>\r\n\
         \x20 </Principals>\r\n\
         \x20 <Settings>\r\n\
         \x20   <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>\r\n\
         \x20   <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>\r\n\
         \x20   <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>\r\n\
         \x20   <AllowHardTerminate>true</AllowHardTerminate>\r\n\
         \x20   <StartWhenAvailable>true</StartWhenAvailable>\r\n\
         \x20   <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>\r\n\
         \x20   <IdleSettings>\r\n\
         \x20     <StopOnIdleEnd>false</StopOnIdleEnd>\r\n\
         \x20     <RestartOnIdle>false</RestartOnIdle>\r\n\
         \x20   </IdleSettings>\r\n\
         \x20   <AllowStartOnDemand>true</AllowStartOnDemand>\r\n\
         \x20   <Enabled>true</Enabled>\r\n\
         \x20   <Hidden>false</Hidden>\r\n\
         \x20   <RunOnlyIfIdle>false</RunOnlyIfIdle>\r\n\
         \x20   <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>\r\n\
         \x20   <Priority>7</Priority>\r\n\
         \x20   <RestartOnFailure>\r\n\
         \x20     <Interval>PT1M</Interval>\r\n\
         \x20     <Count>999</Count>\r\n\
         \x20   </RestartOnFailure>\r\n\
         \x20 </Settings>\r\n\
         \x20 <Actions Context=\"Author\">\r\n\
         \x20   <Exec>\r\n\
         \x20     <Command>{cmd}</Command>\r\n\
         \x20     <Arguments>{args}</Arguments>\r\n\
         \x20   </Exec>\r\n\
         \x20 </Actions>\r\n\
         </Task>\r\n",
        sid = xml_escape(user_sid),
        cmd = xml_escape(&exe.to_string_lossy()),
        args = xml_escape(&args),
    )
}

/// `(command, enabled)` from a task's XML (ours, or as `schtasks /Query /XML` prints it).
pub fn task_command_and_enabled(xml: &str) -> Option<(String, bool)> {
    let cmd = between(xml, "<Command>", "</Command>").map(xml_unescape)?;
    // The task-level <Enabled> is the last one in <Settings>; triggers have their own.
    let settings = between(xml, "<Settings>", "</Settings>").unwrap_or("");
    let enabled = between(settings, "<Enabled>", "</Enabled>")
        .map(|v| v.trim() == "true")
        .unwrap_or(true);
    Some((cmd.trim().to_string(), enabled))
}

/// UTF-16LE with a BOM: what `schtasks /XML` reliably accepts for non-ASCII paths.
pub fn utf16le_with_bom(s: &str) -> Vec<u8> {
    let mut out = vec![0xFF, 0xFE];
    for unit in s.encode_utf16() {
        out.extend_from_slice(&unit.to_le_bytes());
    }
    out
}

fn between<'a>(s: &'a str, open: &str, close: &str) -> Option<&'a str> {
    let start = s.find(open)? + open.len();
    let end = s[start..].find(close)? + start;
    Some(&s[start..end])
}

fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c => out.push(c),
        }
    }
    out
}

fn xml_unescape(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const AWKWARD: &str = "/home/a b/\"q\"/$HOME/100%/x\\y/<&>/mdbase";

    #[test]
    fn systemd_unit_runs_the_installed_profile_and_round_trips_awkward_paths() {
        let unit = systemd_unit(&PathBuf::from(AWKWARD));
        let exec = unit
            .lines()
            .find(|l| l.starts_with("ExecStart="))
            .expect("ExecStart");
        assert!(exec.ends_with(" \"daemon\" \"run\""), "{exec}");
        assert!(!unit.contains("--state-dir"));
        assert!(exec.contains("$$HOME") && exec.contains("100%%"), "{exec}");
        assert_eq!(systemd_exec_binary(&unit).as_deref(), Some(AWKWARD));
        assert!(unit.contains("Restart=on-failure"));
        assert!(unit.contains("WantedBy=default.target"));
    }

    #[test]
    fn plist_round_trips_and_restarts_only_on_failure() {
        let plist = launchd_plist("dev.mdbase.daemon", &PathBuf::from(AWKWARD));
        assert_eq!(launchd_binary(&plist).as_deref(), Some(AWKWARD));
        assert!(plist.contains("<string>daemon</string>\n\t\t<string>run</string>"));
        assert!(plist.contains("<key>SuccessfulExit</key>\n\t\t<false/>"));
        assert!(!plist.contains("--state-dir"));
    }

    #[test]
    fn task_is_scoped_to_the_user_and_round_trips() {
        let exe = PathBuf::from(r"C:\Users\A & B\AppData\Local\mdbase\state\runtime\mdbase.exe");
        let xml = task_xml("S-1-5-21-1-2-3-1001", &exe);
        assert_eq!(
            xml.matches("<UserId>S-1-5-21-1-2-3-1001</UserId>").count(),
            2
        );
        assert!(xml.contains("<LogonType>InteractiveToken</LogonType>"));
        assert!(xml.contains("<RunLevel>LeastPrivilege</RunLevel>"));
        assert!(xml.contains("<Arguments>daemon run</Arguments>"));
        assert!(xml.contains("A &amp; B"));
        let (cmd, enabled) = task_command_and_enabled(&xml).expect("parse");
        assert_eq!(PathBuf::from(cmd), exe);
        assert!(enabled);
        let disabled = xml.replace(
            "<Enabled>true</Enabled>\r\n    <Hidden>",
            "<Enabled>false</Enabled>\r\n    <Hidden>",
        );
        assert_eq!(
            task_command_and_enabled(&disabled).map(|t| t.1),
            Some(false)
        );
    }

    #[test]
    fn utf16_has_a_bom() {
        assert_eq!(utf16le_with_bom("é"), vec![0xFF, 0xFE, 0xE9, 0x00]);
    }
}
