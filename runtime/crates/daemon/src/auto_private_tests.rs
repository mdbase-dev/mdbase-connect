use super::*;
use std::sync::Mutex;

fn entry(id: &str, origin: Origin, mode: SyncMode, paused: bool) -> Entry {
    Entry {
        id: id.into(),
        name: id.into(),
        description: None,
        root: std::path::PathBuf::from("/nonexistent/auto-private"),
        replica_id: "0192f0c1-7e1a-7b3c-8d4e-5f6a7b8c9d0e".into(),
        mode,
        origin,
        added_at_ms: 0,
        paused,
        ever_e2e: false,
        owner_account: None,
        device: None,
    }
}

#[test]
fn only_taken_over_local_collections_qualify() {
    let empty = || true;
    let full = || false;
    // A taken-over local collection, serving.
    assert!(wants(
        &entry("a", Origin::MigratedLocal, SyncMode::Local, false),
        false,
        full
    ));
    // Already synced (Private or cloud copy): nothing to do.
    for mode in [SyncMode::SyncedE2e, SyncMode::Synced] {
        assert!(!wants(
            &entry("a", Origin::MigratedLocal, mode, false),
            true,
            empty
        ));
    }
    // Hosted collections are joined, never taken over; local collections
    // created or adopted here stay as the user made them.
    for origin in [Origin::Joined, Origin::Created, Origin::Adopted] {
        assert!(!wants(
            &entry("a", origin, SyncMode::Local, false),
            false,
            full
        ));
    }
    // Paused by the user: turning sync on would resume it, so it waits.
    assert!(!wants(
        &entry("a", Origin::MigratedLocal, SyncMode::Local, true),
        false,
        full
    ));
    // Paused by an interrupted sync enable (journal, or an empty folder): finish it.
    assert!(wants(
        &entry("a", Origin::MigratedLocal, SyncMode::Local, true),
        true,
        full
    ));
    assert!(wants(
        &entry("a", Origin::MigratedLocal, SyncMode::Local, true),
        false,
        empty
    ));
}

#[test]
fn candidates_follow_the_adopt_journal() {
    let dir = crate::testutil::TestDir::new("auto-private-candidates");
    let collections = dir.path().join("collections");
    std::fs::create_dir_all(&collections).unwrap();
    let paused = entry(
        "4c18af2e-b04a-4b77-b83e-493c3695962e",
        Origin::MigratedLocal,
        SyncMode::Local,
        true,
    );
    let serving = entry(
        "5d29b03f-c15b-4c88-a94f-5a4d47a6a73f",
        Origin::MigratedLocal,
        SyncMode::Local,
        false,
    );
    let entries = [paused.clone(), serving.clone()];
    assert_eq!(candidates(&entries, &collections), vec![serving.id.clone()]);
    std::fs::write(crate::adopt::Journal::path(&collections, &paused.id), b"{}").unwrap();
    assert_eq!(
        candidates(&entries, &collections),
        vec![paused.id.clone(), serving.id.clone()]
    );
}

#[tokio::test]
async fn a_failed_attempt_is_recorded_and_retried_until_it_succeeds() {
    let state = State::default();
    let ids = vec!["a".to_string(), "b".to_string()];
    let calls = Mutex::new(Vec::new());
    // First pass: `a` is offline, `b` succeeds.
    let pass = run(
        &state,
        ids.clone(),
        |id| {
            calls.lock().unwrap().push(id.clone());
            async move {
                if id == "a" {
                    Err("sync_unreachable".to_string())
                } else {
                    Ok(())
                }
            }
        },
        || false,
    )
    .await;
    assert_eq!(pass.enabled, vec!["b".to_string()]);
    assert_eq!(
        pass.failed,
        vec![("a".to_string(), "sync_unreachable".to_string())]
    );
    assert!(pass.pending());
    assert_eq!(state.failure("a").as_deref(), Some("sync_unreachable"));
    assert_eq!(state.failure("b"), None);
    // Next start / sign-in: only `a` is still a candidate, and now succeeds.
    let pass = run(
        &state,
        vec!["a".to_string()],
        |_| async { Ok(()) },
        || false,
    )
    .await;
    assert_eq!(pass.enabled, vec!["a".to_string()]);
    assert!(!pass.pending());
    assert_eq!(state.failure("a"), None);
    assert_eq!(*calls.lock().unwrap(), ids);
}

#[tokio::test]
async fn a_pass_stops_between_collections_and_forgets_settled_failures() {
    let state = State::default();
    defer(&state, &["a".into(), "b".into()], "not_signed_in");
    assert_eq!(state.failure("b").as_deref(), Some("not_signed_in"));
    // `b` is no longer a candidate (synced by the user meanwhile): forgotten.
    let pass = run(&state, vec!["a".into()], |_| async { Ok(()) }, || true).await;
    assert_eq!(pass, Pass::default());
    assert_eq!(state.failure("b"), None);
    assert_eq!(state.failure("a").as_deref(), Some("not_signed_in"));
}

#[test]
fn backoff_doubles_up_to_the_cap() {
    assert_eq!(backoff(0), FIRST_BACKOFF);
    assert_eq!(backoff(1), FIRST_BACKOFF * 2);
    assert_eq!(backoff(5), MAX_BACKOFF);
    assert_eq!(backoff(u32::MAX), MAX_BACKOFF);
}
