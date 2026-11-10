//! Human and JSON output, the terminal confirmation and plain-word account problems.

use super::*;

pub(super) struct Output {
    pub(super) json: bool,
    /// `--yes`: the caller already confirmed; skip terminal prompts.
    pub(super) yes: bool,
}

impl Output {
    pub(super) fn value(&self, v: &Value) {
        println!("{}", serde_json::to_string_pretty(v).unwrap_or_default());
    }

    pub(super) fn error(&self, e: &ClientError) -> ExitCode {
        let (code, obj) = match e {
            ClientError::NotRunning => (
                3,
                ControlError::unavailable(
                    "daemon_not_running",
                    "the mdbase daemon is not running; start it with `mdbase daemon start`",
                ),
            ),
            ClientError::Remote(err) => (
                if err.reason.as_deref() == Some("not_ready") {
                    3
                } else {
                    1
                },
                err.clone(),
            ),
            other => (
                1,
                ControlError::unavailable("daemon_unreachable", other.to_string()),
            ),
        };
        if self.json {
            self.value(&json!({ "error": obj }));
        } else {
            eprintln!("error: {}", obj.message);
            if let Some(r) = &obj.reason {
                eprintln!("       ({}: {r})", obj.code);
            }
        }
        ExitCode::from(code)
    }
}

pub(super) fn migrate_print(out: &Output, v: &Value) {
    if out.json {
        out.value(v);
        return;
    }
    let waiting = v
        .get("waiting_for_migration_batch")
        .and_then(Value::as_bool)
        == Some(true);
    if waiting {
        println!(
            "Waiting for migration batch: automatic takeover needs Connect's permission after the account flips."
        );
    }
    let Some(r) = v.get("record").filter(|r| !r.is_null()) else {
        if !waiting {
            println!("No takeover: no old mdbase Connect state was found for this profile.");
        }
        return;
    };
    if let Some(retirement) = v.get("retirement").filter(|r| !r.is_null()) {
        if retirement["retired"] == true {
            println!("Legacy connector retirement confirmed.");
        } else {
            println!(
                "Legacy connector retirement pending ({}).",
                retirement["reason"].as_str().unwrap_or("not_confirmed")
            );
        }
    }
    println!(
        "takeover: {}",
        r.get("state").and_then(Value::as_str).unwrap_or("?")
    );
    if let Some(held) = v.get("held_interrupted_writes").and_then(Value::as_u64)
        && held > 0
    {
        println!(
            "Interrupted legacy write/delete intents held: {held}. See retained takeover evidence."
        );
    }
    if v.get("revived").and_then(Value::as_bool) == Some(true) {
        println!("warning: the old mdbase Connect daemon is running again (old_connector_revived)");
    }
    if let Some(cs) = r.get("collections").and_then(Value::as_object) {
        for (id, c) in cs {
            let field = |k: &str| c.get(k).and_then(Value::as_u64).unwrap_or(0);
            println!(
                "  {id}  {}{}  rolled forward {}, held {}, {}",
                c.get("state").and_then(Value::as_str).unwrap_or("?"),
                c.get("reason")
                    .and_then(Value::as_str)
                    .map(|r| format!(" ({r})"))
                    .unwrap_or_default(),
                field("rolled_forward"),
                field("holds"),
                if c.get("registered").and_then(Value::as_bool) == Some(true) {
                    "registered"
                } else {
                    "not registered"
                }
            );
        }
    }
}

pub(super) fn print_status(s: &DaemonStatus) {
    let r = &s.readiness;
    if r.ready {
        println!(
            "Daemon: ready (version {}, pid {})",
            r.binary_version, s.pid
        );
    } else {
        println!(
            "Daemon: not ready: {:?} (version {}, pid {})",
            r.safe_reason, r.binary_version, s.pid
        );
    }
    if let Some(d) = &s.device {
        println!("Device: {}", d.device_id);
    }
    if let Some(u) = &s.account.pairing {
        println!("Sign-in waiting for approval: {u}");
    }
    if let Some(e) = &s.account.last_error {
        println!("Account problem: {}", account_problem(e));
    }
    println!(
        "Account: {}",
        if s.account.signed_in {
            if s.account.online {
                "signed in"
            } else {
                "signed in, offline"
            }
        } else {
            "not signed in"
        }
    );
    if s.collections.is_empty() {
        println!("No collections.");
    }
    for c in &s.collections {
        print_collection(c);
    }
}

pub(super) fn display_code(code: &str) -> String {
    if code.len() == 6 && code.bytes().all(|b| b.is_ascii_digit()) {
        format!("{} {}", &code[..3], &code[3..])
    } else {
        code.into()
    }
}

pub(super) fn print_collection(c: &CollectionStatus) {
    let mode = match c.mode {
        SyncMode::Local => "local only",
        SyncMode::Synced => "synced",
        SyncMode::SyncedE2e => "synced, end-to-end encrypted",
    };
    let state = serde_json::to_value(c.state)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default();
    let reason = c
        .reason
        .as_deref()
        .map(|r| format!(" ({r})"))
        .unwrap_or_default();
    println!("  {}  {}", c.id, c.name);
    println!("      {}  [{mode}]  {state}{reason}", c.root.display());
    if let Some(code) = &c.approval_code {
        println!(
            "      Check this code matches on your other computer: {}",
            display_code(code)
        );
    }
    if let Some(s) = &c.sync {
        println!(
            "      confirmed through {}, {} pending, {} held, {} conflicts, {}",
            s.confirmed_through, s.pending, s.holds, s.unresolved, s.connection
        );
    }
    if let Some(failure) = &c.last_sync_failure {
        println!(
            "      last sync failure: {:?}, {:?}, confirmed through {}, generation {:?}, persisted {:?}",
            failure.kind, failure.stage, failure.seq, failure.generation, failure.persisted
        );
    }
    for n in &c.notices {
        if let Some(path) = &n.path {
            println!("      ! {path:?}: {}", n.message);
        } else {
            println!("      ! {}", n.message);
        }
    }
}

/// Ask on the terminal; `false` when stdin is not a terminal.
pub(super) fn confirm(out: &Output, question: &str) -> bool {
    if out.yes {
        return true;
    }
    if !std::io::stdin().is_terminal() {
        eprintln!("{question} Refusing without a terminal to confirm on.");
        return false;
    }
    eprint!("{question} [y/N] ");
    let mut line = String::new();
    std::io::stdin().read_line(&mut line).is_ok() && matches!(line.trim(), "y" | "Y" | "yes")
}

/// The daemon reports account problems as reason codes; say them in plain words.
pub(super) fn account_problem(reason: &str) -> &'static str {
    match reason {
        "system_clock_wrong" => {
            "this computer's system clock looks wrong; check its date and time to reconnect"
        }
        "sign_in_failed" => "sign-in did not finish; try again",
        "sign_in_expired" => "the sign-in request expired; start again",
        "sign_in_cancelled" => "sign-in was cancelled; start again",
        "sign_in_required" => "sign in to mdbase on this computer again",
        "authentication_required" => {
            "mdbase no longer accepts this computer's sign-in; sign out and sign in again"
        }
        "device_registration_failed" => {
            "mdbase could not register this computer yet; it keeps trying while running"
        }
        "incompatible_version" => "this version of mdbase is too old for the service; update it",
        "credential_store_unavailable" => {
            "this computer's secure storage is unavailable; unlock the keychain or restart mdbase"
        }
        "account_state" => "the account settings could not be saved; check free disk space",
        "environment_mismatch" => {
            "this computer is signed in to a different mdbase environment than this build; sign out and sign in again"
        }
        "account_cleanup_failed" => "signing out did not finish; sign out again",
        _ => "this computer could not connect to the account; mdbase keeps trying while running",
    }
}

#[cfg(test)]
mod device_cli_tests {
    use super::*;

    #[test]
    fn comparison_code_keeps_leading_zeroes() {
        assert_eq!(display_code("012345"), "012 345");
    }

    #[test]
    fn desktop_carries_the_code_already_shown_at_allow() {
        let cli = Cli::try_parse_from([
            "mdbase",
            "--json",
            "device",
            "approve",
            "device-id",
            "collection-id",
            "--checked-code",
            "012345",
        ])
        .unwrap();
        assert!(matches!(cli.command, Command::Device(DeviceCmd::Approve {
            checked_code: Some(code), ..
        }) if code == "012345"));
    }
}

#[cfg(test)]
mod yes_tests {
    use super::*;

    /// Apps run privileged commands without a terminal; `--yes` (after their own
    /// confirmation) is the only way past the CLI prompt. The daemon still confirms.
    #[test]
    fn yes_skips_only_the_cli_prompt() {
        let cli = Cli::try_parse_from(["mdbase", "--json", "--yes", "access", "approve", "g"])
            .expect("--yes parses as a global flag");
        let out = Output {
            json: cli.json,
            yes: cli.yes,
        };
        assert!(confirm(&out, "Approve?"));
        let cli = Cli::try_parse_from(["mdbase", "--json", "access", "approve", "g"]).unwrap();
        assert!(!cli.yes);
    }
}
