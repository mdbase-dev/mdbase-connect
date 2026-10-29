//! SEEDED-HOLD branch fixture, NOT native hold-generation or live acceptance.
//! Child of capture_stop_tests: reuse the same isolated native/loopback fixture.
//! Requires bugfix1's capture_fixture_frozen observer and shared bootstrap check.
use super::*;
use mdbn_wire::client::{Hold, HoldReason};
use mdbn_wire::snapshot::TextOrBlob;

#[tokio::test]
async fn complete_seeded_hold_capture_refuses_only_holds_and_resumes_original_local() {
    let f = capture_fixture("capture-complete-seeded-hold").await;
    let original = f
        .daemon
        .inner
        .lock()
        .await
        .registry
        .get(&f.id)
        .unwrap()
        .clone();
    // Settle through the original actor's actual full observation, not a sleep,
    // fake count, seeded receipt or second SQLite connection.
    let inventory = f
        .runtime
        .inventory()
        .await
        .expect("original observation inventory");
    let before = f
        .runtime
        .test_seed_hold(None)
        .await
        .expect("successful native ledger reads");
    assert_eq!(before.inventory, inventory);
    assert_eq!(
        (before.pending, before.conflicts, before.holds.len()),
        (0, 0, 0)
    );
    assert!(
        !before.receipts.is_empty(),
        "must compare genuine confirmed mutations"
    );
    assert!(
        before.local_receipts.iter().any(Option::is_some),
        "must compare actual original local receipt classification"
    );
    let (record, path) = inventory
        .0
        .iter()
        .find(|(_, path)| path == "original.md")
        .expect("original confirmed record")
        .clone();
    assert!(inventory.1.iter().any(|path| path == "mdbase.yaml"));
    let text = String::from_utf8(f.note.clone()).unwrap();
    let hold = Hold {
        id: mdbn_wire::common::B16(record),
        path,
        reason: HoldReason::EditorBusy,
        since: 0,
        base: Some(TextOrBlob::Text(text.clone())),
        mine: TextOrBlob::Text(text.clone()),
        theirs: Some(TextOrBlob::Text(text)),
        saves: 0,
    };
    let seeded = f
        .runtime
        .test_seed_hold(Some(hold.clone()))
        .await
        .expect("typed hold committed durably on original actor");
    assert_eq!(seeded.inventory, before.inventory);
    assert_eq!(seeded.head, before.head);
    assert_eq!(seeded.receipts, before.receipts);
    assert_eq!(seeded.local_receipts, before.local_receipts);
    assert_eq!((seeded.pending, seeded.conflicts), (0, 0));
    assert_eq!(seeded.holds, vec![hold.clone()]);
    let (status, _, _) = f.runtime.readiness().await.unwrap();
    assert!(
        status.incidents.is_empty(),
        "known holds control cannot mask an ingestion incident"
    );

    let outcome = f
        .daemon
        .enable_sync(EnableSync {
            collection: f.id.clone(),
            mode: None,
            accept_takeover_holds: false,
        })
        .await;
    assert_eq!(
        outcome.unwrap_err().reason.as_deref(),
        Some("holds_pending")
    );
    // This is the actual Frozen returned by the original actor, not a second
    // attempted freeze or a locally constructed successful snapshot.
    let frozen = f
        .runtime
        .capture_fixture_frozen()
        .expect("ordinary enable_sync called original freeze")
        .expect("complete known source capture, not failed/unknown None");
    assert_eq!(frozen.inventory, before.inventory);
    assert_eq!((frozen.holds, frozen.unresolved), (1, 0));
    assert!(f.runtime.readiness().await.is_none(), "old actor joined");

    let barrier = {
        let mut inner = f.daemon.inner.lock().await;
        let entry = inner.registry.get(&f.id).unwrap();
        assert_eq!(entry.id, original.id);
        assert_eq!(entry.root, original.root);
        assert_eq!(entry.replica_id, original.replica_id);
        assert_eq!(entry.owner_account, original.owner_account);
        assert_eq!(entry.device, original.device);
        assert_eq!(entry.mode, SyncMode::Local);
        assert!(!entry.paused, "known successful holds refusal can resume");
        let host = inner
            .hosts
            .iter_mut()
            .find(|h| h.entry().id == f.id)
            .unwrap();
        host.refresh();
        host.barrier()
            .expect("original store's opener, no replacement identity")
    };
    tokio::time::timeout(Duration::from_secs(20), barrier.wait())
        .await
        .expect("same-source resume startup barrier completes");
    f.daemon.serving(&f.id).await.unwrap();
    let resumed = f
        .daemon
        .inner
        .lock()
        .await
        .hosts
        .iter()
        .find(|h| h.entry().id == f.id)
        .unwrap()
        .runtime()
        .unwrap();
    let after = resumed
        .test_seed_hold(None)
        .await
        .expect("resumed actual ledger");
    assert_eq!(after.inventory, before.inventory);
    assert_eq!(after.head, before.head);
    assert_eq!(
        after.receipts, before.receipts,
        "no duplicate original mutation"
    );
    assert_eq!(
        after.local_receipts, before.local_receipts,
        "receipt classification retained"
    );
    assert_eq!(after.holds, vec![hold], "exact durable typed hold retained");
    assert_eq!((after.pending, after.conflicts), (0, 0));
    let saved = Registry::load(&f.daemon.profile.registry_file()).unwrap();
    assert!(!saved.get(&f.id).unwrap().paused);
    assert_eq!(saved.get(&f.id).unwrap().replica_id, original.replica_id);
    let journal =
        crate::adopt::Journal::path(&f.daemon.profile.state_dir.join("collections"), &f.id);
    assert!(crate::adopt::Journal::load(&journal).unwrap().is_none());
    assert_no_collection_bootstrap(&f);
    assert_eq!(
        std::fs::read(f.folder.path().join("original.md")).unwrap(),
        f.note
    );
    assert_eq!(
        std::fs::read(f.folder.path().join("mdbase.yaml")).unwrap(),
        CAPTURE_CONFIG
    );
    close_fixture(&f).await;
}
