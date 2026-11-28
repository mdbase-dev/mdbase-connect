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

/// Keep the original device.pending field for scripts using older CLI releases.
pub(super) fn pending_json(mut devices: Value) -> Value {
    if let Some(rows) = devices.as_array_mut() {
        for row in rows {
            if let Some(code) = row.get("sas") {
                row["approval_code"] = code.clone();
            }
        }
    }
    devices
}

#[test]
fn pending_json_exposes_the_status_key_and_preserves_the_original_code() {
    let rows = pending_json(json!([{"sas": "012345"}, {"device": "waiting"}]));
    assert_eq!(rows[0], json!({"sas": "012345", "approval_code": "012345"}));
    assert_eq!(rows[1], json!({"device": "waiting"}));
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

pub(super) fn print_mode(out: &Output, collection: &CollectionStatus, value: &Value, status: bool) {
    if out.json {
        out.value(value);
    } else {
        println!(
            "{}",
            format_mode(
                &collection.id,
                &collection.name,
                value,
                status,
                crate::fsutil::now_ms() as u64
            )
        );
    }
}

fn format_mode(id: &str, name: &str, value: &Value, status: bool, now_ms: u64) -> String {
    use crate::control::terminal_text;
    use crate::server::{
        format_mode_devices, format_wait_phrase, mode_label, mode_switch_unavailable_message,
    };

    let name = terminal_text(name);
    let mut lines = Vec::new();
    let record = if status {
        let current_raw = value["current_mode"].as_str().unwrap_or_default();
        let current = mode_label(current_raw);
        lines.push(format!("{name}: {current}."));
        if value["change"].is_null() {
            lines.push(if value["execution_available"] == false {
                let target = if current_raw == "private" {
                    "cloud_copy"
                } else {
                    "private"
                };
                mode_switch_unavailable_message(target).into()
            } else {
                "No switch in progress.".into()
            });
            return lines.join("\n");
        }
        &value["change"]
    } else {
        value
    };
    let target = record["target_mode"].as_str().unwrap_or_default();
    let label = mode_label(target);
    let mode_arg = if target == "cloud_copy" {
        "cloud-copy"
    } else {
        "private"
    };
    let retry = format!("Run `mdbase sync mode {id} {mode_arg}` to continue.");
    let check = format!("Run `mdbase sync mode-status {id}` for progress.");
    let local = &value["local"];
    let code = local["code"].as_str().unwrap_or_default();
    let message = local["message"].as_str().map(terminal_text);
    let phase = record["phase"].as_str().unwrap_or_default();
    let (progress, action) = match (phase, code) {
        ("complete", _) => (
            format!("{name} is set to {label}."),
            record["request_id"]
                .as_str()
                .map(|_| "Reconnect apps that need access to this collection.".into()),
        ),
        ("cancelled", _) if record["request_id"].is_null() => {
            ("There is no active mode switch to cancel.".into(), None)
        }
        ("cancelled", _) => ("The mode switch was cancelled.".into(), None),
        _ if record["retry_scheduled"] == true && record["cancel_requested"] == true => (
            format!("Cancellation of the switch to {label} is pending."),
            Some(check),
        ),
        ("abandoned", _) => (
            "The mode switch was abandoned. A keyed owner device must finish rotating the keys."
                .into(),
            None,
        ),
        ("waiting_for_devices", _) => (
            format!(
                "Update or remove older devices before continuing: {}.",
                terminal_text(&format_mode_devices(record))
            ),
            Some(retry),
        ),
        (
            _,
            "mode_switch_devices_need_update"
            | "mode_switch_confirmation_required"
            | "mode_switch_keyed_owner_required"
            | "mode_switch_waiting_for_device"
            | "mode_switch_paused"
            | "mode_switch_sign_in_required"
            | "mode_switch_attention",
        ) => {
            let action = match code {
                "mode_switch_sign_in_required" => "Run `mdbase account sign-in`.".into(),
                "mode_switch_paused" => format!("Run `mdbase collection resume {id}`."),
                _ => retry,
            };
            (message.unwrap_or_default().into_owned(), Some(action))
        }
        (_, "mode_switch_refreshing") => (message.unwrap_or_default().into_owned(), Some(check)),
        ("waiting_for_token_expiry", _) => {
            let wait = record["retry_at"]
                .as_str()
                .and_then(|raw| format_wait_phrase(raw, now_ms))
                .map(|wait| format!(" {wait}"))
                .unwrap_or_default();
            (
                format!("Switching to {label}. Waiting{wait} for older app connections to expire."),
                Some(check),
            )
        }
        ("publishing_policy", _) => (format!("Publishing the switch to {label}."), Some(check)),
        ("finishing", _) => (format!("Finishing the switch to {label}."), Some(check)),
        ("waiting_for_device", "") => (
            format!("The switch to {label} is waiting for a keyed owner device."),
            Some(retry),
        ),
        _ if record["retry_scheduled"] == true => (
            format!("A retry for the switch to {label} is scheduled."),
            Some(check),
        ),
        _ => (
            format!("The switch to {label} is in progress."),
            Some(check),
        ),
    };
    lines.push(progress);
    if matches!(
        phase,
        "waiting_for_token_expiry" | "publishing_policy" | "finishing"
    ) && matches!(code, "mode_switch_in_progress" | "mode_switch_token_drain")
    {
        lines.push("This computer is continuing the switch.".into());
    }
    lines.extend(action);
    lines.join("\n")
}

#[cfg(test)]
#[test]
fn mode_renderer_uses_request_bound_progress_and_device_names() {
    let request = "11111111-1111-4111-8111-111111111111";
    let device = "22222222-2222-4222-8222-222222222222";
    let mut status = json!({
        "current_mode":"cloud_copy",
        "change":{"request_id":request,"target_mode":"private","phase":"finishing"}
    });
    let remote = format_mode(request, "Notes", &status, true, 0);
    assert!(remote.contains("Finishing the switch to Private"));
    assert!(!remote.contains("This computer"));
    status["local"] = json!({"code":"mode_switch_in_progress"});
    assert!(format_mode(request, "Notes", &status, true, 0).contains("This computer"));

    let refused = json!({
        "request_id":request, "target_mode":"private", "phase":"waiting_for_devices",
        "devices":[device], "device_names": {device:"ThinkPad"}
    });
    let out = format_mode(request, "Notes", &refused, false, 0);
    assert!(out.contains("ThinkPad (22222222)"));
    assert!(out.contains(&format!("sync mode {request} private")));
}

#[cfg(test)]
#[test]
fn mode_renderer_reports_locally_owned_token_drain_and_pending_cancellation() {
    let mut status = json!({
        "current_mode": "cloud_copy",
        "change": {"request_id": "request", "target_mode": "private", "phase": "waiting_for_token_expiry",
                   "retry_at": "2026-01-01T00:00:20Z"},
    });
    let now = 1_767_225_600_000;
    let render = |value: &Value| format_mode("notes", "Notes", value, true, now);
    let waiting = render(&status);
    assert!(waiting.contains("Waiting about 20 s for older app connections to expire."));
    assert!(!waiting.contains("This computer"));
    status["local"] = json!({"code": "mode_switch_token_drain"});
    assert!(render(&status).contains("This computer is continuing the switch."));

    let pending =
        json!({"target_mode": "private", "retry_scheduled": true, "cancel_requested": true});
    assert!(
        format_mode("notes", "Notes", &pending, false, now)
            .contains("Cancellation of the switch to Private is pending.")
    );
}

#[cfg(test)]
#[test]
fn mode_renderer_distinguishes_terminal_results_and_parked_notices() {
    for (record, expected) in [
        (
            json!({"phase": "cancelled"}),
            "There is no active mode switch to cancel.",
        ),
        (
            json!({"phase": "cancelled", "request_id": "request"}),
            "The mode switch was cancelled.",
        ),
        (
            json!({"phase": "complete", "target_mode": "private"}),
            "Notes is set to Private.",
        ),
        (
            json!({"phase": "complete", "target_mode": "private", "request_id": "request"}),
            "Reconnect apps",
        ),
        (
            json!({"phase": "abandoned"}),
            "The mode switch was abandoned.",
        ),
        (
            json!({"retry_scheduled": true, "target_mode": "private"}),
            "A retry for the switch to Private is scheduled.",
        ),
        (
            json!({"local": {"code": "mode_switch_sign_in_required", "message": "Sign in with the account that owns this collection."}}),
            "Run `mdbase account sign-in`.",
        ),
    ] {
        let out = format_mode("notes", "Notes", &record, false, 0);
        assert!(out.contains(expected), "{out}");
        if record["phase"] == "complete" && record["request_id"].is_null() {
            assert!(!out.contains("Reconnect apps"));
        }
    }
}

#[cfg(test)]
#[test]
fn mode_status_explains_next_step_when_switching_is_unavailable() {
    let cloud = json!({
        "current_mode": "cloud_copy",
        "execution_available": false,
        "change": null,
    });
    let out = format_mode("notes", "Notes", &cloud, true, 0);
    assert!(out.contains("Notes: Cloud copy."));
    assert!(out.contains("Switching this collection isn't available yet."));
    assert!(out.contains("mdbase collection add"));
    assert!(out.contains("--mode private"));

    let private = json!({
        "current_mode": "private",
        "execution_available": false,
        "change": null,
    });
    let out = format_mode("notes", "Notes", &private, true, 0);
    assert!(out.contains("Notes: Private."));
    assert!(out.contains("Switching this collection isn't available yet."));
    assert!(out.contains("--mode cloud-copy"));
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
