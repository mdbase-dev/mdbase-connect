//! Requests to the daemon: call bounds, collection and device resolution.

use super::*;

pub(super) async fn call(
    profile: &Profile,
    method: &str,
    params: Value,
) -> Result<Value, ClientError> {
    let mut c = ControlClient::connect(&profile.control).await?;
    if crate::control::PRIVILEGED.contains(&method) {
        let store = crate::secrets::store_for(&profile.secret_namespace(), &profile.state_dir);
        c.authenticate(store.as_ref()).await?;
    }
    // Authentication/connect failures above happen before dispatch. Once
    // dispatch is attempted, a missing/invalid reply cannot prove refusal.
    let result = c.call_within(method, params, call_timeout(method)).await;
    match (result, unknown_outcome(method)) {
        (
            Err(ClientError::Io(_) | ClientError::Protocol(_) | ClientError::Timeout),
            Some(message),
        ) => Err(ClientError::Remote(ControlError::unavailable(
            "outcome_unknown",
            message,
        ))),
        (other, _) => other,
    }
}

fn call_timeout(method: &str) -> Duration {
    match method {
        Method::MIGRATE_START => MIGRATE_START_TIMEOUT,
        Method::DEVICE_APPROVE => DEVICE_APPROVE_TIMEOUT,
        Method::COLLECTION_MODE => COLLECTION_MODE_TIMEOUT,
        Method::ACCESS_APPROVE | Method::SETTINGS_SET => CONFIRM_TIMEOUT,
        _ => crate::client::CALL_TIMEOUT,
    }
}

/// What to say when a dispatched call's reply is missing or unreadable, for
/// calls whose effect a retry must not assume.
fn unknown_outcome(method: &str) -> Option<&'static str> {
    match method {
        Method::COLLECTION_DELETE => Some(
            "The deletion outcome is unknown. Check this collection in your account before taking further action; do not automatically retry.",
        ),
        Method::COLLECTION_MODE => Some(
            "The switch outcome is unknown. Check `mdbase sync mode-status` before switching again.",
        ),
        _ => None,
    }
}

/// `migrate start` answers only after the takeover run: the journal drain alone may
/// take [`crate::takeover::DRAIN`], so the ordinary call bound would report a
/// still-running takeover as an unreachable daemon.
const MIGRATE_START_TIMEOUT: Duration = Duration::from_secs(600);
const _: () = assert!(MIGRATE_START_TIMEOUT.as_secs() > crate::takeover::DRAIN.as_secs() * 2);

/// `device approve` answers once the other computer has answered (its challenge
/// lives two minutes) and the key grant is applied.
const DEVICE_APPROVE_TIMEOUT: Duration = Duration::from_secs(240);

/// Approving an app or turning approval off waits for the daemon's on-screen
/// confirmation, then does an ordinary call's work.
const CONFIRM_TIMEOUT: Duration = Duration::from_secs(
    crate::confirm::ANSWER_BOUND.as_secs() + crate::client::CALL_TIMEOUT.as_secs(),
);

/// `sync mode` waits for the on-screen confirmation, then makes up to five
/// control-plane requests (status, reservation, challenge, proof, cancellation),
/// each bounded like an ordinary call.
const COLLECTION_MODE_TIMEOUT: Duration = Duration::from_secs(
    crate::confirm::ANSWER_BOUND.as_secs() + 5 * crate::client::CALL_TIMEOUT.as_secs(),
);

/// A waiting computer's full device ID from an ID or unique prefix, and the
/// resolved collection (if one was named).
pub(super) async fn pending_device(
    profile: &Profile,
    device: &str,
    collection: Option<String>,
) -> Result<(String, Option<String>), ClientError> {
    let collection = match collection {
        Some(c) => Some(resolve(profile, &c).await?),
        None => None,
    };
    if crate::attest::uuid_bytes(device).is_some() {
        return Ok((device.to_ascii_lowercase(), collection));
    }
    let v = call(
        profile,
        Method::DEVICE_PENDING,
        json!({ "collection": collection }),
    )
    .await?;
    let list: Vec<PendingDevice> =
        serde_json::from_value(v).map_err(|e| ClientError::Protocol(e.to_string()))?;
    let mut ids: Vec<&str> = list
        .iter()
        .map(|d| d.device.as_str())
        .filter(|d| !device.is_empty() && d.starts_with(&device.to_ascii_lowercase()))
        .collect();
    ids.sort_unstable();
    ids.dedup();
    match ids.as_slice() {
        [one] => Ok((one.to_string(), collection)),
        [] => Err(ClientError::Remote(ControlError::not_found(format!(
            "no waiting computer matches {device} (see `mdbase device pending`)"
        )))),
        _ => Err(ClientError::Remote(ControlError::invalid(
            "ambiguous_device",
            format!("{device} matches more than one waiting computer; use more of its ID"),
        ))),
    }
}

/// The registered collections and their state.
pub(crate) async fn collections(profile: &Profile) -> Result<Vec<CollectionStatus>, ClientError> {
    let list = call(profile, Method::COLLECTION_LIST, json!({})).await?;
    serde_json::from_value(list).map_err(|e| ClientError::Protocol(e.to_string()))
}

/// Resolve a collection argument: exact ID, unique ID prefix, or exact name.
pub(super) async fn resolve(profile: &Profile, arg: &str) -> Result<String, ClientError> {
    Ok(pick(&collections(profile).await?, arg)?.id.clone())
}

/// The collection `arg` names: exact ID, unique ID prefix, or exact name.
pub(crate) fn pick<'a>(
    list: &'a [CollectionStatus],
    arg: &str,
) -> Result<&'a CollectionStatus, ControlError> {
    if let Some(exact) = list.iter().find(|c| c.id == arg) {
        return Ok(exact);
    }
    let matches: Vec<&CollectionStatus> = list
        .iter()
        .filter(|c| c.name == arg || (arg.len() >= 4 && c.id.starts_with(arg)))
        .collect();
    match matches.as_slice() {
        [one] => Ok(one),
        [] => Err(ControlError::not_found(format!(
            "no registered collection matches {arg:?}"
        ))),
        _ => Err(ControlError::invalid(
            "ambiguous_collection",
            format!("{arg:?} matches several collections; use the ID"),
        )),
    }
}

pub(super) async fn simple(
    profile: &Profile,
    out: &Output,
    method: &str,
    collection: &str,
    mut extra: Value,
) -> Result<ExitCode, ClientError> {
    let id = resolve(profile, collection).await?;
    if let Value::Object(m) = &mut extra {
        m.insert("collection".into(), Value::String(id));
    }
    let v = call(profile, method, extra).await?;
    if out.json {
        out.value(&v);
    } else if let Ok(c) = serde_json::from_value::<CollectionStatus>(v.clone()) {
        print_collection(&c);
    } else {
        println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
    }
    Ok(ExitCode::SUCCESS)
}

#[cfg(test)]
mod mode_cli_tests {
    use super::*;
    #[test]
    fn confirmation_gated_calls_outlast_the_on_screen_answer() {
        let answered = crate::confirm::ANSWER_BOUND + crate::client::CALL_TIMEOUT;
        for method in [
            Method::COLLECTION_MODE,
            Method::ACCESS_APPROVE,
            Method::SETTINGS_SET,
        ] {
            assert!(call_timeout(method) >= answered, "{method}");
        }
        assert_eq!(
            call_timeout(Method::COLLECTION_MODE_STATUS),
            crate::client::CALL_TIMEOUT
        );
    }

    #[test]
    fn a_lost_mode_switch_reply_is_unknown_not_refused() {
        assert!(
            unknown_outcome(Method::COLLECTION_MODE)
                .is_some_and(|message| message.contains("mdbase sync mode-status"))
        );
        assert!(unknown_outcome(Method::COLLECTION_DELETE).is_some());
        assert!(unknown_outcome(Method::ACCESS_APPROVE).is_none());
    }

    #[test]
    fn sync_files_only_sets_with_an_explicit_flag() {
        let cli = Cli::try_parse_from(["mdbase", "sync", "files", "notes"]).unwrap();
        assert!(matches!(
            cli.command,
            Command::Sync(SyncCmd::Files { set: false, .. })
        ));
        assert!(
            Cli::try_parse_from(["mdbase", "sync", "files", "notes", "--types", "pdf"]).is_err()
        );
        let cli = Cli::try_parse_from([
            "mdbase",
            "sync",
            "files",
            "notes",
            "--set",
            "--types",
            "image,pdf",
            "--exclude",
            "Videos",
            "--max-size",
            "10",
        ])
        .unwrap();
        let Command::Sync(SyncCmd::Files {
            types,
            exclude,
            max_size,
            ..
        }) = cli.command
        else {
            panic!("not sync files");
        };
        assert_eq!(types, Some(vec!["image".into(), "pdf".into()]));
        assert_eq!(exclude, ["Videos"]);
        assert_eq!(max_size, Some(10));
    }
    #[test]
    fn mode_commands_preserve_explicit_target_and_resume() {
        let cli = Cli::try_parse_from([
            "mdbase",
            "sync",
            "mode",
            "collection",
            "private",
            "--resume",
        ])
        .unwrap();
        assert!(matches!(
            cli.command,
            Command::Sync(SyncCmd::Mode {
                mode: SyncKind::Private,
                resume: true,
                ..
            })
        ));
        let cli =
            Cli::try_parse_from(["mdbase", "sync", "mode", "collection", "cloud-copy"]).unwrap();
        assert!(matches!(
            cli.command,
            Command::Sync(SyncCmd::Mode {
                mode: SyncKind::CloudCopy,
                resume: false,
                ..
            })
        ));
        assert!(Cli::try_parse_from(["mdbase", "sync", "mode", "collection", "public"]).is_err());
        assert!(Cli::try_parse_from(["mdbase", "sync", "mode-status", "collection"]).is_ok());
    }
}
