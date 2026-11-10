//! On-screen confirmation of access-widening actions.
//!
//! On Linux and Windows any process of the user can read the keychain entry the
//! control endpoint's caller check uses, so the API alone can't prove that the user
//! wants to approve an app, turn approval off, link Obsidian or change who can read
//! a collection. For those, **the daemon itself** starts a dialog process and
//! proceeds only when the user clicks the confirming button:
//! - macOS: `osascript` (`display dialog`, with a timeout);
//! - Windows: PowerShell `System.Windows.Forms.MessageBox`;
//! - Linux: the mdbase connect app (`mdbase-connect --mdbase-confirm=<prompt>`),
//!   else `zenity --question`, else `kdialog --yesno`.
//!
//! The answer is trusted because the daemon spawned the process and reads it from
//! that child's own stdout or exit status: no control method registers or answers
//! a confirmation. The app is found on the daemon's `PATH` exactly as zenity is,
//! and must print `MDBASE_ALLOW` (an exit status alone is not consent).
//!
//! No dialog available (a headless machine, an SSH session without a display)
//! means **no**: the action is refused with `confirmation_unavailable`. A dialog
//! that times out (2 minutes) also means no.
//!
//! The prompt names the action, the app (or computer) and the collection, with
//! Allow and Deny. It never contains secrets or key material.

use std::time::Duration;

use serde::Serialize;

/// How long a dialog waits.
pub const TIMEOUT: Duration = Duration::from_secs(120);

/// The longest [`NativeDialog`] takes to answer: the dialog's own timeout, plus
/// a grace period before its process is killed.
pub const ANSWER_BOUND: Duration = Duration::from_secs(TIMEOUT.as_secs() + 5);

/// Version of the prompt the app receives (`apps/desktop/src/main/confirmation.ts`).
const PROMPT_VERSION: u32 = 1;

/// The line the app prints to stdout when the user clicked Allow.
const ALLOW: &[u8] = b"MDBASE_ALLOW\n";

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

/// What the user is asked to confirm. The app words each kind in the user's
/// language; native dialogs use [`Prompt::title`] and [`Prompt::message`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Prompt {
    /// Let an app use a collection through this computer.
    ApproveApp {
        /// The app's name.
        app: String,
        /// The collection's name.
        collection: String,
        /// Capability IDs (`collection.read`, ...).
        capabilities: Vec<String>,
        /// Folders, or the whole collection.
        folders: Option<Vec<String>>,
        /// The app key's fingerprint, to compare with the app's request.
        key: String,
    },
    /// Let new apps use local collections without asking first.
    DisableApproval,
    /// Let Obsidian on this computer use a collection.
    LinkObsidian {
        /// The collection's name.
        collection: String,
    },
    /// Switch a collection to Private, or to a cloud copy.
    CollectionMode {
        /// The collection's name.
        collection: String,
        /// Private (else cloud copy).
        private: bool,
    },
}

impl Prompt {
    /// English title for native dialogs.
    pub fn title(&self) -> &'static str {
        match self {
            Prompt::ApproveApp { .. } => "Approve app access",
            Prompt::DisableApproval => "Turn off approval",
            Prompt::LinkObsidian { .. } => "Link Obsidian",
            Prompt::CollectionMode { private: true, .. } => "Make private",
            Prompt::CollectionMode { private: false, .. } => "Turn on cloud copy",
        }
    }

    /// English question for native dialogs.
    pub fn message(&self) -> String {
        match self {
            Prompt::ApproveApp {
                app,
                collection,
                capabilities,
                folders,
                key,
            } => format!(
                "Allow {app} to use the collection \"{collection}\" through this computer?\n\nAccess: {}\nFolders: {}\nApp key: {key}\n\nCompare this key with the app's access request in your browser.",
                crate::access::plain_capabilities(capabilities),
                folders
                    .as_ref()
                    .map(|f| f.join(", "))
                    .unwrap_or_else(|| "whole collection".into()),
            ),
            Prompt::DisableApproval => "Let new apps use your local collections without asking you first?\n\nYou will still be notified.".into(),
            Prompt::LinkObsidian { collection } => {
                format!("Let Obsidian on this computer use \"{collection}\"?")
            }
            Prompt::CollectionMode { collection, private: true } => format!(
                "Make \"{collection}\" private?\n\nOnly your devices will read new content after the switch finishes. mdbase may still read older content."
            ),
            Prompt::CollectionMode { collection, private: false } => format!(
                "Turn on cloud copy for \"{collection}\"?\n\nmdbase will be able to read and serve this collection, including its existing history, even when your devices are off."
            ),
        }
    }

    /// The app's `--mdbase-confirm` argument. The English title and message let an
    /// app older than a newer daemon still show a kind it does not know.
    fn app_argument(&self) -> String {
        let mut value = serde_json::json!(self);
        value["v"] = PROMPT_VERSION.into();
        value["title"] = self.title().into();
        value["message"] = self.message().into();
        format!("--mdbase-confirm={value}")
    }
}

/// Something that can ask the user.
pub trait Confirmer: Send + Sync {
    /// Ask; blocking work runs off the async runtime.
    fn ask<'a>(&'a self, prompt: &'a Prompt) -> crate::session::BoxFuture<'a, Answer>;
}

/// Dialogs the daemon starts itself.
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

/// A dialog process, and whether only an explicit [`ALLOW`] line is consent.
type Dialog = (std::process::Command, bool);

#[cfg(target_os = "macos")]
fn command(prompt: &Prompt) -> Option<Dialog> {
    let script = format!(
        "set r to display dialog \"{}\" with title \"{}\" buttons {{\"Deny\", \"Allow\"}} default button \"Deny\" cancel button \"Deny\" with icon caution giving up after {}\nif (gave up of r is false) and (button returned of r is \"Allow\") then\nreturn \"MDBASE_ALLOW\"\nelse\nreturn \"MDBASE_DENY\"\nend if",
        sanitize(&prompt.message()),
        sanitize(prompt.title()),
        TIMEOUT.as_secs()
    );
    let mut c = std::process::Command::new("/usr/bin/osascript");
    c.arg("-e").arg(script);
    // macOS process success is not consent: display dialog can succeed on timeout.
    Some((c, true))
}

#[cfg(windows)]
fn command(prompt: &Prompt) -> Option<Dialog> {
    let script = format!(
        "Add-Type -AssemblyName System.Windows.Forms; \
         $r = [System.Windows.Forms.MessageBox]::Show(\"{}\", \"{}\", 'YesNo', 'Warning', 'Button2'); \
         if ($r -eq 'Yes') {{ exit 0 }} else {{ exit 1 }}",
        sanitize(&prompt.message()).replace('\n', "`n"),
        sanitize(prompt.title())
    );
    let mut c = std::process::Command::new("powershell.exe");
    c.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
    Some((c, false))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn command(prompt: &Prompt) -> Option<Dialog> {
    if std::env::var_os("DISPLAY").is_none() && std::env::var_os("WAYLAND_DISPLAY").is_none() {
        return None;
    }
    linux_command(prompt, std::env::var_os("PATH").as_deref())
}

/// The first dialog program on `path`: the app, then zenity, then kdialog.
#[cfg(all(unix, not(target_os = "macos")))]
fn linux_command(prompt: &Prompt, path: Option<&std::ffi::OsStr>) -> Option<Dialog> {
    let which = |b: &str| {
        path.and_then(|p| {
            std::env::split_paths(p)
                .map(|d| d.join(b))
                .find(|f| f.is_file())
        })
    };
    if let Some(app) = which("mdbase-connect") {
        let mut c = std::process::Command::new(app);
        c.arg(prompt.app_argument());
        return Some((c, true));
    }
    let (title, message) = (sanitize(prompt.title()), sanitize(&prompt.message()));
    if let Some(zenity) = which("zenity") {
        let mut c = std::process::Command::new(zenity);
        c.args([
            "--question",
            "--default-cancel",
            "--ok-label=Allow",
            "--cancel-label=Deny",
            &format!("--title={title}"),
            &format!("--text={message}"),
            &format!("--timeout={}", TIMEOUT.as_secs()),
        ]);
        return Some((c, false));
    }
    if let Some(kdialog) = which("kdialog") {
        let mut c = std::process::Command::new(kdialog);
        c.args([
            "--title",
            &title,
            "--yes-label",
            "Allow",
            "--no-label",
            "Deny",
            "--warningyesno",
            &message,
        ]);
        return Some((c, false));
    }
    None
}

fn dialog_answer(success: bool, output: &[u8], explicit: bool) -> Answer {
    if success && (!explicit || output == ALLOW) {
        Answer::Yes
    } else {
        Answer::No
    }
}

/// Run a dialog and read its answer.
async fn run(dialog: Option<Dialog>) -> Answer {
    let Some((mut cmd, explicit)) = dialog else {
        return Answer::Unavailable;
    };
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    let mut cmd = tokio::process::Command::from(cmd);
    cmd.kill_on_drop(true);
    match tokio::time::timeout(ANSWER_BOUND, cmd.output()).await {
        Ok(Ok(out)) => dialog_answer(out.status.success(), &out.stdout, explicit),
        Ok(Err(_)) => Answer::Unavailable,
        Err(_) => Answer::No,
    }
}

impl Confirmer for NativeDialog {
    fn ask<'a>(&'a self, prompt: &'a Prompt) -> crate::session::BoxFuture<'a, Answer> {
        Box::pin(run(command(prompt)))
    }
}

/// A fixed answer (tests).
#[derive(Debug)]
pub struct Fixed(pub Answer);

impl Confirmer for Fixed {
    fn ask<'a>(&'a self, _p: &'a Prompt) -> crate::session::BoxFuture<'a, Answer> {
        let a = self.0;
        Box::pin(async move { a })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_dialogs_require_the_allow_line() {
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

    #[test]
    fn the_app_receives_a_versioned_prompt_with_english_for_unknown_kinds() {
        let prompt = Prompt::ApproveApp {
            app: "Fixture \"app\"".into(),
            collection: "Notes".into(),
            capabilities: vec!["collection.read".into()],
            folders: None,
            key: "ABCD-EFGH".into(),
        };
        let argument = prompt.app_argument();
        let json = argument.strip_prefix("--mdbase-confirm=").unwrap();
        let value: serde_json::Value = serde_json::from_str(json).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "v": 1, "kind": "approve_app", "app": "Fixture \"app\"", "collection": "Notes",
                "capabilities": ["collection.read"], "folders": null, "key": "ABCD-EFGH",
                "title": "Approve app access", "message": prompt.message(),
            })
        );
        assert!(prompt.message().contains("whole collection"));
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    mod linux {
        use super::super::*;
        use crate::testutil::TestDir;
        use std::os::unix::fs::PermissionsExt;

        fn program(dir: &TestDir, name: &str, body: &str) {
            let path = dir.path().join(name);
            std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        async fn ask(dir: &TestDir) -> Answer {
            let prompt = Prompt::CollectionMode {
                collection: "Notes".into(),
                private: false,
            };
            run(linux_command(&prompt, Some(dir.path().as_os_str()))).await
        }

        #[tokio::test]
        async fn the_app_is_asked_before_zenity_and_must_print_allow() {
            let dir = TestDir::new("confirm-app");
            program(&dir, "zenity", "exit 0");
            program(
                &dir,
                "mdbase-connect",
                r#"case "$1" in --mdbase-confirm=*'"kind":"collection_mode"'*) echo MDBASE_ALLOW;; esac"#,
            );
            assert_eq!(ask(&dir).await, Answer::Yes);
            // An exit status alone is not consent, and zenity is not asked instead.
            for body in ["exit 0", "echo MDBASE_ALLOW; exit 1", "echo MDBASE_DENY"] {
                program(&dir, "mdbase-connect", body);
                assert_eq!(ask(&dir).await, Answer::No, "{body}");
            }
        }

        #[tokio::test]
        async fn without_the_app_zenity_answers_and_without_either_nobody_can() {
            let dir = TestDir::new("confirm-zenity");
            assert_eq!(ask(&dir).await, Answer::Unavailable);
            program(&dir, "zenity", "exit 1");
            assert_eq!(ask(&dir).await, Answer::No);
            program(&dir, "zenity", "exit 0");
            assert_eq!(ask(&dir).await, Answer::Yes);
            let prompt = Prompt::DisableApproval;
            assert_eq!(run(linux_command(&prompt, None)).await, Answer::Unavailable);
        }
    }
}
