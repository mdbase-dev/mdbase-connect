use super::*;
use mdbn_wire::client::{Connection, Incident, SyncMode};

fn status(kind: IncidentKind, details: Option<Value>) -> SyncStatus {
    SyncStatus {
        grant: None,
        mode: SyncMode::Synced,
        confirmed_through: 3,
        head_known: 8,
        pending: 0,
        oldest_pending: None,
        holds: 0,
        unresolved: 0,
        connection: Connection::Online,
        installing: None,
        resyncing: None,
        confirmed_head: None,
        incidents: vec![Incident { kind, details }],
    }
}

#[test]
fn projects_every_terminal_kind_without_remote_details() {
    for (input, expected) in [
        (IncidentKind::Integrity, Kind::Integrity),
        (
            IncidentKind::VerificationMismatch,
            Kind::VerificationMismatch,
        ),
        (IncidentKind::KeyInconsistent, Kind::KeyInconsistent),
        (IncidentKind::AccessRevoked, Kind::AccessRevoked),
        (IncidentKind::Gone, Kind::Gone),
        (IncidentKind::UpgradeRequired, Kind::UpgradeRequired),
    ] {
        let f = Failure::project(
            &status(
                input,
                Some(Value::Text(
                    "DO-NOT-COPY /private/path keys=document payload".into(),
                )),
            ),
            &None,
        )
        .unwrap();
        assert_eq!(f.kind, expected);
        assert_eq!(f.stage, Stage::SyncedReadiness);
        assert_eq!(
            f.seq, 3,
            "confirmed position, not head-known or a guessed failed frame"
        );
        assert_eq!(f.generation, None);
        assert_eq!(f.persisted, Some(false));
        let json = serde_json::to_string(&f).unwrap();
        for forbidden in [
            "DO-NOT-COPY",
            "/private/path",
            "keys=",
            "document",
            "payload",
        ] {
            assert!(!json.contains(forbidden));
        }
    }
}

#[test]
fn only_exact_static_cause_is_allowlisted() {
    let f = Failure::project(
        &status(
            IncidentKind::Integrity,
            Some(Value::Text(RESOURCE_DEFERRED.into())),
        ),
        &Some(mdbn_replica::AdoptStatus::Done),
    )
    .unwrap();
    assert_eq!(f.cause, Some(Cause::ResourceIngestDeferred));
    assert_eq!(f.stage, Stage::ResourceIngestion);
    assert_eq!(
        f.generation, None,
        "a sticky Done status cannot prove the current generation"
    );
    for details in [
        Value::Text(format!("{RESOURCE_DEFERRED} user content")),
        Value::Map(vec![(
            "message".into(),
            Value::Text(RESOURCE_DEFERRED.into()),
        )]),
    ] {
        let f = Failure::project(&status(IncidentKind::Integrity, Some(details)), &None).unwrap();
        assert_eq!(f.cause, None);
    }
}

#[test]
fn waiting_is_not_fatal_and_adopt_error_text_is_discarded() {
    let s = status(IncidentKind::WaitingForKey, None);
    assert_eq!(Failure::project(&s, &None), None);
    assert_eq!(
        Failure::project(&s, &Some(mdbn_replica::AdoptStatus::Pending)),
        None
    );
    let f = Failure::project(
        &s,
        &Some(mdbn_replica::AdoptStatus::Failed(
            "private-document-path-and-keys".into(),
        )),
    )
    .unwrap();
    assert_eq!(f.kind, Kind::AdoptionFailed);
    assert_eq!(f.stage, Stage::GenerationZeroAdoption);
    assert_eq!(f.generation, Some(0));
    assert!(
        !serde_json::to_string(&f)
            .unwrap()
            .contains("private-document")
    );
}

#[tokio::test]
async fn failure_is_durable_before_stop_and_survives_reopen() {
    let dir = crate::testutil::TestDir::new("fatal-durable");
    crate::fsutil::ensure_private_dir(dir.path()).unwrap();
    let shared = Shared::default();
    let closed = std::sync::atomic::AtomicBool::new(false);
    let mut f = Failure::project(
        &status(
            IncidentKind::Integrity,
            Some(Value::Text(RESOURCE_DEFERRED.into())),
        ),
        &Some(mdbn_replica::AdoptStatus::Done),
    )
    .unwrap();
    f.paths = vec!["_types/problem.md".into()];
    retain_and_stop(
        &shared,
        dir.path(),
        f.clone(),
        || {
            assert_eq!(
                shared.lock().unwrap().as_ref().unwrap().kind,
                Kind::Integrity
            );
            assert_eq!(
                shared.lock().unwrap().as_ref().unwrap().persisted,
                Some(false)
            );
            closed.store(true, std::sync::atomic::Ordering::SeqCst);
        },
        async {
            assert!(
                closed.load(std::sync::atomic::Ordering::SeqCst),
                "close the serving gate before querying the actor"
            );
            tokio::task::yield_now().await;
            assert!(closed.load(std::sync::atomic::Ordering::SeqCst));
            f.paths.clone()
        },
        async {
            assert!(closed.load(std::sync::atomic::Ordering::SeqCst));
            let saved = Failure::load(dir.path()).unwrap().unwrap();
            assert_eq!(
                shared.lock().unwrap().as_ref().unwrap().persisted,
                Some(true),
                "stop cannot be polled before the writer confirmed file + directory fsync"
            );
            assert_eq!(
                saved.persisted, None,
                "receipt presence cannot prove the original fsync outcome"
            );
            assert_eq!(saved.seq, 3);
            assert_eq!(saved.cause, Some(Cause::ResourceIngestDeferred));
            assert_eq!(saved.paths, ["_types/problem.md"]);
        },
    )
    .await;
    let reopened = Failure::load(dir.path()).unwrap().unwrap();
    let mut expected = shared.lock().unwrap().clone().unwrap();
    expected.persisted = None;
    assert_eq!(reopened, expected);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(dir.path().join(FILE))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

#[tokio::test]
async fn persistence_failure_still_closes_and_stops_without_claiming_durability() {
    let dir = crate::testutil::TestDir::new("fatal-io-error");
    let not_dir = dir.path().join("not-a-directory");
    std::fs::write(&not_dir, b"synthetic fixture").unwrap();
    let shared = Shared::default();
    let closed = std::sync::atomic::AtomicBool::new(false);
    let f = Failure::project(&status(IncidentKind::KeyInconsistent, None), &None).unwrap();
    retain_and_stop(
        &shared,
        &not_dir,
        f,
        || closed.store(true, std::sync::atomic::Ordering::SeqCst),
        async { Vec::new() },
        async {
            assert!(closed.load(std::sync::atomic::Ordering::SeqCst));
            assert_eq!(
                shared.lock().unwrap().as_ref().unwrap().persisted,
                Some(false)
            );
        },
    )
    .await;
    assert_eq!(
        shared.lock().unwrap().as_ref().unwrap().kind,
        Kind::KeyInconsistent
    );
}

#[tokio::test]
async fn rename_then_directory_fsync_failure_never_claims_original_durability_on_reopen() {
    let dir = crate::testutil::TestDir::new("fatal-post-rename");
    crate::fsutil::ensure_private_dir(dir.path()).unwrap();
    let shared = Shared::default();
    let closed = std::sync::atomic::AtomicBool::new(false);
    let f = Failure::project(&status(IncidentKind::Integrity, None), &None).unwrap();
    let stopped = std::sync::atomic::AtomicBool::new(false);
    retain_and_stop_using(
        &shared,
        dir.path(),
        f,
        || closed.store(true, std::sync::atomic::Ordering::SeqCst),
        async { Vec::new() },
        async {
            assert!(closed.load(std::sync::atomic::Ordering::SeqCst));
            assert_eq!(
                shared.lock().unwrap().as_ref().unwrap().persisted,
                Some(false)
            );
            let recovered = Failure::load(dir.path()).unwrap().unwrap();
            assert_eq!(recovered.kind, Kind::Integrity);
            assert_eq!(recovered.persisted, None);
            stopped.store(true, std::sync::atomic::Ordering::SeqCst);
        },
        |path, bytes| {
            use std::io::Write;
            assert!(closed.load(std::sync::atomic::Ordering::SeqCst));
            let tmp = path.with_extension("injected-temp");
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&tmp)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            drop(file);
            std::fs::rename(&tmp, path)?;
            // Exact partial boundary: file + rename succeeded, parent fsync
            // now fails. Do not hide this as a pre-write failure.
            Err(io::Error::other("injected directory fsync failure"))
        },
    )
    .await;
    assert!(
        stopped.load(std::sync::atomic::Ordering::SeqCst),
        "stop must still be polled after post-rename fsync failure"
    );
    assert_eq!(Failure::load(dir.path()).unwrap().unwrap().persisted, None);
}

#[test]
fn malformed_future_or_content_bearing_persistence_is_refused() {
    let dir = crate::testutil::TestDir::new("fatal-malformed");
    crate::fsutil::ensure_private_dir(dir.path()).unwrap();
    let mut f = Failure::project(&status(IncidentKind::Integrity, None), &None).unwrap();
    f.persisted = None;
    let mut value = serde_json::to_value(Stored {
        schema_version: 1,
        failure: f,
        paths: Vec::new(),
        paths_omitted: None,
    })
    .unwrap();
    value["failure"]["message"] = serde_json::json!("never accept content");
    crate::fsutil::write_atomic(&dir.path().join(FILE), &serde_json::to_vec(&value).unwrap())
        .unwrap();
    assert!(Failure::load(dir.path()).is_err());
    value["failure"].as_object_mut().unwrap().remove("message");
    value["schema_version"] = serde_json::json!(3);
    crate::fsutil::write_atomic(&dir.path().join(FILE), &serde_json::to_vec(&value).unwrap())
        .unwrap();
    assert!(Failure::load(dir.path()).is_err());
    value["schema_version"] = serde_json::json!(1);
    value["failure"]["persisted"] = serde_json::json!(true);
    crate::fsutil::write_atomic(&dir.path().join(FILE), &serde_json::to_vec(&value).unwrap())
        .unwrap();
    assert!(
        Failure::load(dir.path()).is_err(),
        "disk cannot assert original fsync success"
    );
    crate::fsutil::write_atomic(&dir.path().join(FILE), &vec![b' '; MAX_BYTES as usize + 1])
        .unwrap();
    assert!(Failure::load(dir.path()).is_err());
}

#[cfg(unix)]
#[test]
fn diagnostic_symlink_is_not_followed() {
    let dir = crate::testutil::TestDir::new("fatal-symlink");
    let other = crate::testutil::TestDir::new("fatal-symlink-other");
    std::fs::write(other.path().join("source"), b"never read").unwrap();
    std::os::unix::fs::symlink(other.path().join("source"), dir.path().join(FILE)).unwrap();
    assert!(Failure::load(dir.path()).is_err());
}

#[test]
fn large_path_lists_preserve_the_failure_with_an_explicit_omitted_count() {
    let dir = crate::testutil::TestDir::new("fatal-path-bound");
    crate::fsutil::ensure_private_dir(dir.path()).unwrap();
    let mut f = Failure::project(&status(IncidentKind::Integrity, None), &None).unwrap();
    f.set_paths(
        (0..100)
            .map(|n| format!("_types/{n}-{}.md", "x".repeat(512)))
            .collect(),
    );
    assert!(!f.paths.is_empty());
    assert_eq!(f.paths.len() as u64 + f.paths_omitted.unwrap(), 100);
    f.persist_using(dir.path(), crate::fsutil::write_atomic)
        .unwrap();
    assert!(std::fs::metadata(dir.path().join(FILE)).unwrap().len() <= MAX_BYTES);
    let recovered = Failure::load(dir.path()).unwrap().unwrap();
    assert_eq!(recovered.kind, Kind::Integrity);
    assert_eq!(recovered.paths, f.paths);
    assert_eq!(recovered.paths_omitted, f.paths_omitted);
}

#[test]
fn saved_path_details_do_not_expand_the_strict_control_failure_shape() {
    let mut f = Failure::project(
        &status(
            IncidentKind::Integrity,
            Some(Value::Text(RESOURCE_DEFERRED.into())),
        ),
        &None,
    )
    .unwrap();
    f.set_paths(vec!["_types/task.md".into()]);
    let json = serde_json::to_value(&f).unwrap();
    let keys = json
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(
        keys,
        ["kind", "stage", "seq", "generation", "cause", "persisted"]
            .into_iter()
            .collect()
    );
    assert!(serde_json::from_value::<Failure>(json).is_ok());
}

#[test]
fn the_log_detail_is_bounded_text_and_never_enters_the_failure() {
    let text = format!(
        "attachment_unavailable: notes/a.md:\nbad\u{7}{}",
        "é".repeat(600)
    );
    let s = status(IncidentKind::Integrity, Some(Value::Text(text)));
    let detail = log_detail(&s).unwrap();
    assert!(detail.starts_with("attachment_unavailable: notes/a.md: bad "));
    assert!(!detail.chars().any(char::is_control));
    assert!(detail.len() <= LOG_DETAIL_BYTES + '…'.len_utf8());
    assert!(detail.ends_with('…'));
    let json = serde_json::to_string(&Failure::project(&s, &None).unwrap()).unwrap();
    assert!(!json.contains("attachment_unavailable"));
    // Maps and absent details give no text; waiting incidents are not terminal.
    assert_eq!(log_detail(&status(IncidentKind::Integrity, None)), None);
    assert_eq!(
        log_detail(&status(
            IncidentKind::WaitingForKey,
            Some(Value::Text("x".into()))
        )),
        None
    );
}

#[tokio::test]
async fn clearing_forgets_the_failure_in_memory_and_on_disk() {
    let dir = crate::testutil::TestDir::new("failure-clear");
    crate::fsutil::ensure_private_dir(dir.path()).unwrap();
    let shared = Shared::default();
    let failure = Failure::project(&status(IncidentKind::Integrity, None), &None).unwrap();
    retain_and_stop(
        &shared,
        dir.path(),
        failure,
        || {},
        async { Vec::new() },
        async {},
    )
    .await;
    assert!(Failure::load(dir.path()).unwrap().is_some());
    clear(&shared, dir.path());
    assert!(shared.lock().unwrap().is_none());
    assert_eq!(Failure::load(dir.path()).unwrap(), None);
    // Idempotent: nothing left to remove is not an error.
    clear(&shared, dir.path());
}
