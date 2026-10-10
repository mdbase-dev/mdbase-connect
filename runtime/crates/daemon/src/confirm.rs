//! On-screen confirmation of access-widening actions.
//!
//! On Linux and Windows any process of the user can read the keychain entry the
//! control endpoint's caller check uses, so the API alone can't prove that the user
//! wants to approve an app, approve a device, reveal a recovery key or turn approval
//! off. For those, **the daemon itself** shows a native dialog and proceeds only
//! when the user clicks the confirming button:
//! - macOS: `osascript` (`display dialog`, with a timeout);
//! - Windows: PowerShell `System.Windows.Forms.MessageBox`;
//! - Linux: `zenity --question`, else `kdialog --yesno`.
//!
//! No dialog available (a headless machine, an SSH session without a display)
//! means **no**: the action is refused with `confirmation_unavailable`. A dialog
//! that times out (2 minutes) also means no.
//!
//! Dialog text names the app, the collection and the key fingerprint, so a user
//! can compare it with what the app showed. It never contains secrets.

use std::time::Duration;

/// How long a dialog waits.
pub const TIMEOUT: Duration = Duration::from_secs(120);

/// The user's answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Answer {
    /// Confirmed.
    Yes,
    /// Declined, or timed out.
    No,
    /// No way to ask on this machine.
    Unavailable,
}

/// Something that can ask the user.
pub trait Confirmer: Send + Sync {
    /// Ask; blocking work runs off the async runtime.
    fn ask<'a>(&'a self, title: &'a str, message: &'a str)
    -> crate::session::BoxFuture<'a, Answer>;
}

/// Native OS dialogs.
#[derive(Debug, Default)]
pub struct NativeDialog;

fn sanitize(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_control() || *c == '\n')
        .map(|c| {
            if matches!(c, '"' | '\\' | '`' | '$') {
                '\''
            } else {
                c
            }
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn command(title: &str, message: &str) -> Option<std::process::Command> {
    let script = format!(
        "set r to display dialog \"{}\" with title \"{}\" buttons {{\"Cancel\", \"Allow\"}} default button \"Cancel\" cancel button \"Cancel\" with icon caution giving up after {}\nif (gave up of r is false) and (button returned of r is \"Allow\") then\nreturn \"MDBASE_ALLOW\"\nelse\nreturn \"MDBASE_DENY\"\nend if",
        sanitize(message),
        sanitize(title),
        TIMEOUT.as_secs()
    );
    let mut c = std::process::Command::new("/usr/bin/osascript");
    c.arg("-e").arg(script);
    Some(c)
}

#[cfg(windows)]
fn command(title: &str, message: &str) -> Option<std::process::Command> {
    let script = format!(
        "Add-Type -AssemblyName System.Windows.Forms; \
         $r = [System.Windows.Forms.MessageBox]::Show(\"{}\", \"{}\", 'YesNo', 'Warning', 'Button2'); \
         if ($r -eq 'Yes') {{ exit 0 }} else {{ exit 1 }}",
        sanitize(message).replace('\n', "`n"),
        sanitize(title)
    );
    let mut c = std::process::Command::new("powershell.exe");
    c.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
    Some(c)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn command(title: &str, message: &str) -> Option<std::process::Command> {
    if std::env::var_os("DISPLAY").is_none() && std::env::var_os("WAYLAND_DISPLAY").is_none() {
        return None;
    }
    let which = |b: &str| {
        std::env::var_os("PATH")
            .map(|p| std::env::split_paths(&p).any(|d| d.join(b).is_file()))
            .unwrap_or(false)
    };
    if which("zenity") {
        let mut c = std::process::Command::new("zenity");
        c.args([
            "--question",
            "--default-cancel",
            "--ok-label=Allow",
            "--cancel-label=Cancel",
            &format!("--title={}", sanitize(title)),
            &format!("--text={}", sanitize(message)),
            &format!("--timeout={}", TIMEOUT.as_secs()),
        ]);
        return Some(c);
    }
    if which("kdialog") {
        let mut c = std::process::Command::new("kdialog");
        c.args([
            "--title",
            &sanitize(title),
            "--warningyesno",
            &sanitize(message),
        ]);
        return Some(c);
    }
    None
}

// macOS process success is not consent: display dialog can succeed on timeout.
fn dialog_answer(success: bool, output: &[u8], explicit: bool) -> Answer {
    if success && (!explicit || output == b"MDBASE_ALLOW\n") {
        Answer::Yes
    } else {
        Answer::No
    }
}

impl Confirmer for NativeDialog {
    fn ask<'a>(
        &'a self,
        title: &'a str,
        message: &'a str,
    ) -> crate::session::BoxFuture<'a, Answer> {
        let (title, message) = (title.to_string(), message.to_string());
        Box::pin(async move {
            let Some(mut cmd) = command(&title, &message) else {
                return Answer::Unavailable;
            };
            cmd.stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null());
            let mut cmd = tokio::process::Command::from(cmd);
            cmd.kill_on_drop(true);
            match tokio::time::timeout(TIMEOUT + Duration::from_secs(5), cmd.output()).await {
                Ok(Ok(out)) => {
                    dialog_answer(out.status.success(), &out.stdout, cfg!(target_os = "macos"))
                }
                Ok(Err(_)) => Answer::Unavailable,
                Err(_) => Answer::No,
            }
        })
    }
}

/// A fixed answer (tests).
#[derive(Debug)]
pub struct Fixed(pub Answer);

impl Confirmer for Fixed {
    fn ask<'a>(&'a self, _t: &'a str, _m: &'a str) -> crate::session::BoxFuture<'a, Answer> {
        let a = self.0;
        Box::pin(async move { a })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_output_requires_explicit_mac_consent() {
        assert_eq!(dialog_answer(true, b"MDBASE_ALLOW\n", true), Answer::Yes);
        for output in [
            b"MDBASE_DENY\n".as_slice(),
            b"gave up:true",
            b"",
            b"MDBASE_ALLOW",
            b"garbage",
            b"MDBASE_ALLOW\nextra",
        ] {
            assert_eq!(dialog_answer(true, output, true), Answer::No);
        }
        assert_eq!(dialog_answer(false, b"MDBASE_ALLOW\n", true), Answer::No);
        assert_eq!(dialog_answer(false, b"", false), Answer::No);
        assert_eq!(dialog_answer(true, b"", false), Answer::Yes);
    }

    #[test]
    fn sanitize_strips_quotes_and_controls() {
        assert_eq!(sanitize("a\"b\\c`$d\u{7}e\nf"), "a'b'c''de\nf");
    }
}
