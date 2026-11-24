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

fn cli_mode_arg(mode: &str) -> &str {
    match mode {
        "cloud_copy" => "cloud-copy",
        other => other,
    }
}

fn cli_col_arg(arg: &str) -> String {
    let clean = crate::control::terminal_text(arg);
    if clean.is_empty() || clean.chars().any(char::is_whitespace) {
        format!("{clean:?}")
    } else {
        clean.into_owned()
    }
}

fn format_device_list(
    devices: &[String],
    device_names: Option<&serde_json::Map<String, Value>>,
) -> String {
    devices
        .iter()
        .map(|id| {
            let short = crate::server::short_device_id(id);
            match device_names
                .and_then(|map| map.get(id))
                .and_then(Value::as_str)
                .filter(|name| !name.trim().is_empty())
            {
                Some(name) => format!("{} ({short})", crate::control::terminal_text(name)),
                None => crate::control::terminal_text(short).into_owned(),
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn mode_attention_notice(notices: &[crate::control::Notice]) -> Option<&crate::control::Notice> {
    notices
        .iter()
        .find(|n| n.code.starts_with("mode_switch_") && n.code != "mode_switch_in_progress")
}

fn next_step_for_notice(
    notice: &crate::control::Notice,
    col_arg: &str,
    cli_target: &str,
) -> Option<String> {
    match notice.code.as_str() {
        "mode_switch_devices_need_update" => Some(format!(
            "Next step: once those devices are updated or removed, run `mdbase sync mode {col_arg} {cli_target}`."
        )),
        "mode_switch_keyed_owner_required" => Some(format!(
            "Next step: run `mdbase sync mode {col_arg} {cli_target}` on an owner device holding this collection's trusted key."
        )),
        "mode_switch_paused" => Some(format!(
            "Next step: resume the collection with `mdbase collection resume {col_arg}`."
        )),
        "mode_switch_sign_in_required" => {
            Some("Next step: sign in with `mdbase account sign-in`.".into())
        }
        _ => None,
    }
}

/// Human-readable output for `mdbase sync mode-status`.
pub(super) fn format_mode_status(
    name: &str,
    col_arg: &str,
    status: &Value,
    notices: &[crate::control::Notice],
    now_ms: u64,
) -> String {
    use crate::control::terminal_text;
    use crate::server::{format_wait_phrase, mode_label};

    let name = terminal_text(name);
    let col_arg = cli_col_arg(col_arg);
    let current = status
        .get("current_mode")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let execution_available = status
        .get("execution_available")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let attention = mode_attention_notice(notices);
    let Some(change) = status.get("change").filter(|v| !v.is_null()) else {
        let mut lines = vec![format!(
            "{name}: {} (no switch in progress).",
            mode_label(current)
        )];
        if !execution_available {
            lines.push("Switching modes isn't available for this collection yet.".into());
        }
        if let Some(notice) = attention {
            lines.push(terminal_text(&notice.message).into_owned());
        }
        return lines.join("\n");
    };

    let phase = change
        .get("phase")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let target = change
        .get("target_mode")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let source = change
        .get("source_mode")
        .and_then(Value::as_str)
        .unwrap_or(current);
    let target_label = mode_label(target);
    let source_label = mode_label(source);
    let cli_target = cli_mode_arg(target);

    let mut lines = Vec::new();
    match phase {
        "waiting_for_token_expiry" => {
            lines.push(format!(
                "{name}: {source_label} (switching to {target_label})."
            ));
            let wait = change
                .get("retry_at")
                .and_then(Value::as_str)
                .and_then(|raw| format_wait_phrase(raw, now_ms));
            match wait {
                Some(wait) => lines.push(format!(
                    "Status: waiting {wait} for older app connections to expire."
                )),
                None => lines.push("Status: waiting for older app connections to expire.".into()),
            }
            if let Some(notice) = attention {
                lines.push(terminal_text(&notice.message).into_owned());
                if let Some(step) = next_step_for_notice(notice, &col_arg, cli_target) {
                    lines.push(step);
                }
            } else {
                lines.push("mdbase will continue this switch in the background.".into());
            }
        }
        "publishing_policy" => {
            lines.push(format!(
                "{name}: {source_label} (switching to {target_label})."
            ));
            lines.push("Status: publishing the mode change.".into());
            if let Some(notice) = attention {
                lines.push(terminal_text(&notice.message).into_owned());
                if let Some(step) = next_step_for_notice(notice, &col_arg, cli_target) {
                    lines.push(step);
                }
            } else {
                lines.push("mdbase will finish this switch in the background.".into());
            }
        }
        "finishing" => {
            lines.push(format!(
                "{name}: {source_label} (switching to {target_label})."
            ));
            if target == "private" {
                lines.push("Status: rotating collection keys and removing the cloud copy.".into());
            } else {
                lines.push("Status: finishing cloud copy setup.".into());
            }
            if let Some(notice) = attention {
                lines.push(terminal_text(&notice.message).into_owned());
                if let Some(step) = next_step_for_notice(notice, &col_arg, cli_target) {
                    lines.push(step);
                }
            } else {
                lines.push("mdbase will finish this switch in the background.".into());
            }
        }
        "waiting_for_devices" => {
            lines.push(format!(
                "{name}: {source_label} (switch to {target_label} paused)."
            ));
            let devices: Vec<String> = change
                .get("devices")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect();
            let list = format_device_list(
                &devices,
                change.get("device_names").and_then(Value::as_object),
            );
            if list.is_empty() {
                lines.push("Status: update or remove older devices before continuing.".into());
            } else {
                lines.push(format!(
                    "Status: update or remove older devices before continuing: {list}."
                ));
            }
            lines.push(format!(
                "Next step: once those devices are updated or removed, run `mdbase sync mode {col_arg} {cli_target}`."
            ));
        }
        "waiting_for_device" => {
            lines.push(format!(
                "{name}: {source_label} (switch to {target_label} waiting)."
            ));
            if let Some(notice) = attention {
                lines.push(format!("Status: {}", terminal_text(&notice.message)));
                if let Some(step) = next_step_for_notice(notice, &col_arg, cli_target) {
                    lines.push(step);
                }
            } else {
                lines.push(
                    "Status: waiting for an owner device with this collection's trusted key."
                        .into(),
                );
                lines.push(format!(
                    "Next step: run `mdbase sync mode {col_arg} {cli_target}` on an owner device holding this collection's trusted key."
                ));
            }
        }
        "abandoned" => {
            lines.push(format!(
                "{name}: {} (previous switch to {target_label} was abandoned).",
                mode_label(current)
            ));
            lines.push(
                "Status: waiting for an owner device with this collection's trusted key to finish rotating keys."
                    .into(),
            );
        }
        "complete" => {
            lines.push(format!("{name}: {target_label} (switch complete)."));
        }
        "cancelled" => {
            lines.push(format!(
                "{name}: {} (switch cancelled).",
                mode_label(current)
            ));
        }
        other => {
            lines.push(format!(
                "{name}: {} (switching to {target_label}: {}).",
                mode_label(current),
                terminal_text(other)
            ));
        }
    }
    lines.join("\n")
}

/// Human-readable output for `mdbase sync mode`.
pub(super) fn format_mode_change(
    name: &str,
    col_arg: &str,
    result: &Value,
    notices: &[crate::control::Notice],
    now_ms: u64,
) -> String {
    use crate::control::terminal_text;
    use crate::server::{format_wait_phrase, mode_label};

    let name = terminal_text(name);
    let col_arg = cli_col_arg(col_arg);
    let phase = result
        .get("phase")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let target = result
        .get("target_mode")
        .and_then(Value::as_str)
        .unwrap_or("");
    let target_label = if target.is_empty() {
        "the new mode"
    } else {
        mode_label(target)
    };
    let cli_target = cli_mode_arg(target);
    let attention = mode_attention_notice(notices);

    let mut lines = Vec::new();
    match phase {
        "complete" => {
            lines.push(format!("Switched {name} to {target_label}."));
            lines.push("Apps connected to this collection will need to be reconnected.".into());
        }
        "cancelled" => {
            lines.push(format!("Cancelled the mode switch for {name}."));
        }
        "abandoned" => {
            lines.push(format!(
                "The previous mode switch for {name} was abandoned."
            ));
            lines.push(
                "Waiting for an owner device with this collection's trusted key to finish rotating keys."
                    .into(),
            );
        }
        "waiting_for_token_expiry" => {
            let wait = result
                .get("retry_at")
                .and_then(Value::as_str)
                .and_then(|raw| format_wait_phrase(raw, now_ms));
            match wait {
                Some(wait) => lines.push(format!(
                    "Switching {name} to {target_label}: waiting {wait} for older app connections to expire."
                )),
                None => lines.push(format!(
                    "Switching {name} to {target_label}: waiting for older app connections to expire."
                )),
            }
            lines.push(format!(
                "mdbase will continue in the background. Check progress with `mdbase sync mode-status {col_arg}`."
            ));
        }
        "publishing_policy" => {
            lines.push(format!(
                "Switching {name} to {target_label}: publishing the mode change."
            ));
            lines.push(format!(
                "mdbase will continue in the background. Check progress with `mdbase sync mode-status {col_arg}`."
            ));
        }
        "finishing" => {
            if target == "private" {
                lines.push(format!(
                    "Switching {name} to {target_label}: rotating collection keys and removing the cloud copy."
                ));
            } else {
                lines.push(format!(
                    "Switching {name} to {target_label}: finishing cloud copy setup."
                ));
            }
            lines.push(format!(
                "mdbase will continue in the background. Check progress with `mdbase sync mode-status {col_arg}`."
            ));
        }
        "waiting_for_devices" => {
            let devices: Vec<String> = result
                .get("devices")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect();
            let list = format_device_list(
                &devices,
                result.get("device_names").and_then(Value::as_object),
            );
            if list.is_empty() {
                lines.push(format!(
                    "Switch to {target_label} for {name} is paused: update or remove older devices."
                ));
            } else {
                lines.push(format!(
                    "Switch to {target_label} for {name} is paused: update or remove older devices ({list})."
                ));
            }
            lines.push(format!(
                "Once those devices are updated or removed, run `mdbase sync mode {col_arg} {cli_target}`."
            ));
        }
        "waiting_for_device" => {
            if let Some(notice) = attention {
                lines.push(terminal_text(&notice.message).into_owned());
                if let Some(step) = next_step_for_notice(notice, &col_arg, cli_target) {
                    lines.push(step);
                }
            } else {
                lines.push(format!(
                    "Switch to {target_label} for {name} is waiting for an owner device with this collection's trusted key."
                ));
                lines.push(format!(
                    "Check progress with `mdbase sync mode-status {col_arg}`."
                ));
            }
        }
        other => {
            lines.push(format!(
                "Switch to {target_label} for {name}: {}.",
                terminal_text(other)
            ));
            lines.push(format!(
                "Check progress with `mdbase sync mode-status {col_arg}`."
            ));
        }
    }
    lines.join("\n")
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

#[cfg(test)]
mod mode_output_tests {
    use super::*;
    use crate::control::Notice;

    // 2026-01-01T00:00:00Z in Unix ms.
    const NOW_MS: u64 = 1_767_225_600_000;

    #[test]
    fn mode_status_formats_idle_and_unavailable() {
        let idle = format_mode_status(
            "Notes",
            "Notes",
            &json!({
                "current_mode": "private",
                "execution_available": true,
                "change": null,
            }),
            &[],
            NOW_MS,
        );
        assert_eq!(idle, "Notes: Private (no switch in progress).");

        let unavailable = format_mode_status(
            "Notes",
            "Notes",
            &json!({
                "current_mode": "cloud_copy",
                "execution_available": false,
                "change": null,
            }),
            &[],
            NOW_MS,
        );
        assert!(unavailable.contains("Notes: Cloud copy (no switch in progress)."));
        assert!(unavailable.contains("isn't available"));
    }

    #[test]
    fn mode_status_formats_token_expiry_countdown_and_finishing() {
        let drain = format_mode_status(
            "Notes",
            "Notes",
            &json!({
                "current_mode": "cloud_copy",
                "execution_available": true,
                "change": {
                    "source_mode": "cloud_copy",
                    "target_mode": "private",
                    "phase": "waiting_for_token_expiry",
                    "retry_at": "2026-01-01T00:12:00Z",
                },
            }),
            &[],
            NOW_MS,
        );
        assert!(drain.contains("Notes: Cloud copy (switching to Private)."));
        assert!(drain.contains("waiting about 12 min for older app connections to expire"));
        assert!(drain.contains("in the background"));

        let finishing = format_mode_status(
            "My Notes",
            "My Notes",
            &json!({
                "current_mode": "cloud_copy",
                "execution_available": true,
                "change": {
                    "source_mode": "private",
                    "target_mode": "cloud_copy",
                    "phase": "finishing",
                },
            }),
            &[],
            NOW_MS,
        );
        assert!(finishing.contains("My Notes: Private (switching to Cloud copy)."));
        assert!(finishing.contains("finishing cloud copy setup"));
    }

    #[test]
    fn mode_output_lists_device_names_or_short_ids_and_next_step() {
        let id_named = "11111111-1111-4111-8111-111111111111";
        let id_unnamed = "abcdef01-2222-4222-8222-222222222222";
        let out = format_mode_change(
            "Notes",
            "Notes",
            &json!({
                "target_mode": "private",
                "phase": "waiting_for_devices",
                "devices": [id_named, id_unnamed],
                "device_names": {
                    id_named: "Work Laptop",
                },
            }),
            &[],
            NOW_MS,
        );
        assert!(out.contains("Work Laptop (11111111)"));
        assert!(out.contains("abcdef01"));
        assert!(!out.contains(id_named));
        assert!(!out.contains(id_unnamed));
        assert!(out.contains("mdbase sync mode Notes private"));
    }

    #[test]
    fn mode_status_surfaces_driver_notice_for_waiting_for_device() {
        let notices = vec![Notice {
            path: None,
            code: "mode_switch_devices_need_update".into(),
            message: "Switch to Private is paused: update or remove older devices (Old Mac (deadbeef)), then try again.".into(),
        }];
        let out = format_mode_status(
            "Notes",
            "My Notes",
            &json!({
                "current_mode": "cloud_copy",
                "execution_available": true,
                "change": {
                    "source_mode": "cloud_copy",
                    "target_mode": "private",
                    "phase": "waiting_for_device",
                },
            }),
            &notices,
            NOW_MS,
        );
        assert!(out.contains("Old Mac (deadbeef)"));
        assert!(out.contains("mdbase sync mode \"My Notes\" private"));
    }

    #[test]
    fn mode_change_formats_complete_cancelled_and_background_continuation() {
        let done = format_mode_change(
            "Notes",
            "Notes",
            &json!({ "phase": "complete", "target_mode": "private" }),
            &[],
            NOW_MS,
        );
        assert!(done.contains("Switched Notes to Private."));
        assert!(done.contains("reconnected"));

        let cancelled = format_mode_change(
            "Notes",
            "Notes",
            &json!({ "phase": "cancelled" }),
            &[],
            NOW_MS,
        );
        assert_eq!(cancelled, "Cancelled the mode switch for Notes.");

        let bg = format_mode_change(
            "Notes",
            "Notes",
            &json!({ "phase": "finishing", "target_mode": "private" }),
            &[],
            NOW_MS,
        );
        assert!(bg.contains("rotating collection keys and removing the cloud copy"));
        assert!(bg.contains("mdbase sync mode-status Notes"));
    }
}
