//! Genuine durable SQLite native snapshot staging, authenticated swap and reopen.
#[test]
fn real_oversized_observation_uploads_native_and_acknowledges_with_capture() {
    let dir = scratch("native-observation");
    let vault = dir.join("vault");
    fs::create_dir_all(&vault).unwrap();
    let idx = Rc::new(RefCell::new(
        SqliteIndex::open(dir.join("state.db"), IndexDurability::Durable).unwrap(),
    ));
    let store = mdbn_store_file::FileStore::open(
        Rc::new(platform(&vault)),
        SqlStore::open(idx.clone()).unwrap(),
        SqlDiskDb::open(idx.clone()).unwrap(),
        Box::new(mdbn_core::host::FixedClock(1700000000000)),
        mdbn_store_file::Config::default(),
    )
    .unwrap();
    let svc = r::fake::FakeLogService::new();
    r::testkit::TestControlPlane::signed(COL).genesis_with_keys(
        &svc,
        CState::E2e,
        DEV,
        &[0x31; 32],
        &[0x32; 32],
    );
    let mut a = open_store(store, 3);
    settle(&mut a, &svc);
    let bytes = "---\r\ntitle: source\r\n---\r\n🪴\0exact\r\n"
        .repeat(60_000)
        .into_bytes();
    assert!(bytes.len() > 1_048_576);
    fs::write(vault.join("observed.md"), &bytes).unwrap();
    let observations = a.store_mut().observe(None).unwrap();
    assert!(observations.iter().any(|o| matches!(
        o.now,
        Some(r::store::Observed::Attachment {
            class: r::store::AttachmentClass::OversizedMarkdown,
            ..
        })
    )));
    a.ingest(observations);
    assert_eq!(
        a.store().disk_revision("observed.md"),
        None,
        "unacknowledged observation does not become managed disk state"
    );
    let mut log = svc.client(DEV);
    let mut held = None;
    for _ in 0..128 {
        for call in a.take_log_calls() {
            if matches!(call.request, LogRequest::Append(_)) {
                assert!(held.is_none());
                held = Some(call);
            } else {
                let reply = log.call(call.request);
                a.on_log_reply(call.id, reply);
            }
        }
        if held.is_some() {
            break;
        }
        a.tick();
    }
    let call = held.expect("observation captured before native append");
    let pending = a.store().pending(None, 10).unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].mutation.source, w::intent::Source::External);
    assert!(!pending[0].refs.is_empty());
    assert!(a.store().file_at("observed.md").unwrap().is_none());
    assert_eq!(
        a.store().disk_revision("observed.md"),
        Some(w::hash::sha256(&bytes)),
        "capture and exact-byte evidence acknowledgement precede append together"
    );
    let reply = log.call(call.request);
    a.on_log_reply(call.id, reply);
    settle(&mut a, &svc);
    assert_eq!(
        a.store()
            .files(Page {
                after: None,
                limit: 10
            })
            .unwrap()
            .len(),
        1
    );
    let id = a.store().file_at("observed.md").unwrap().unwrap();
    assert_eq!(
        a.store().file(&id).unwrap().unwrap().kind,
        FileKindV1::UnindexedOversizedMarkdown
    );
    assert!(a.store().record(&id).unwrap().is_none());
    assert!(a.store().pending(None, 10).unwrap().is_empty());
    assert_eq!(fs::read(vault.join("observed.md")).unwrap(), bytes);
    assert_eq!(
        a.store().disk_revision("observed.md"),
        Some(w::hash::sha256(&bytes)),
        "capture acknowledges exact observed bytes"
    );
    assert!(
        a.sync_status().incidents.is_empty(),
        "{:?}",
        a.sync_status().incidents
    );
    let old = a.store().file(&id).unwrap().unwrap().content;
    let mut changed = bytes.clone();
    changed[0] = b'!';
    fs::write(vault.join("observed.md"), &changed).unwrap();
    a.store_mut().request_rescan();
    let observations = a.store_mut().observe(None).unwrap();
    a.ingest(observations);
    settle(&mut a, &svc);
    let replaced = a.store().file(&id).unwrap().unwrap();
    assert_ne!(replaced.content, old);
    assert_eq!(replaced.content.plain_hash(), w::hash::sha256(&changed));
    assert_eq!(a.store().file_at("observed.md").unwrap(), Some(id));
    assert!(a.store().tombstone(&id).unwrap().is_none());
    assert_eq!(fs::read(vault.join("observed.md")).unwrap(), changed);
    assert!(a.sync_status().incidents.is_empty());
    let head = a.head();
    drop(a);
    drop(idx);
    let idx = Rc::new(RefCell::new(
        SqliteIndex::open(dir.join("state.db"), IndexDurability::Durable).unwrap(),
    ));
    let store = mdbn_store_file::FileStore::open(
        Rc::new(platform(&vault)),
        SqlStore::open(idx.clone()).unwrap(),
        SqlDiskDb::open(idx).unwrap(),
        Box::new(mdbn_core::host::FixedClock(1700000000000)),
        mdbn_store_file::Config::default(),
    )
    .unwrap();
    let mut a = open_store(store, 3);
    settle(&mut a, &svc);
    assert_eq!(a.head(), head);
    assert_eq!(a.store().file_at("observed.md").unwrap(), Some(id));
    assert_eq!(
        a.store().file(&id).unwrap().unwrap().content,
        replaced.content
    );
    assert_eq!(fs::read(vault.join("observed.md")).unwrap(), changed);
    assert!(
        a.store_mut().observe(None).unwrap().is_empty(),
        "reopen does not reupload confirmed observation"
    );
    drop(a);
    fs::remove_dir_all(dir).unwrap();
}
use super::*;
use mdbn_store_file::{
    SqlStore,
    testing::{replica as r, wire as w},
};
use r::{
    DeviceSecrets, Host, Replica, ReplicaConfig, UtcOnly,
    log::{EndpointId, LogClient, LogPort, LogPush, LogRequest},
    store::{Page, meta_keys},
};
use w::{common::B16, policy::CState, unindexed_markdown::FileKindV1};
const COL: B16 = B16([7; 16]);
const DEV: B16 = B16([101; 16]);
type App = Replica<SqlStore<SqliteIndex>>;
type DiskApp = Replica<
    mdbn_store_file::FileStore<NativePlatform, SqlStore<SqliteIndex>, SqlDiskDb<SqliteIndex>>,
>;

fn disk_replica(dir: &std::path::Path, replica: u8) -> DiskApp {
    disk_replica_clock(
        dir,
        replica,
        Box::new(mdbn_core::host::FixedClock(1700000000000)),
    )
}
fn disk_replica_clock(dir: &std::path::Path, replica: u8, clock: Box<dyn Clock>) -> DiskApp {
    let idx = Rc::new(RefCell::new(
        SqliteIndex::open(dir.join("state.db"), IndexDurability::Durable).unwrap(),
    ));
    let store = mdbn_store_file::FileStore::open(
        Rc::new(platform(&dir.join("vault"))),
        SqlStore::open(idx.clone()).unwrap(),
        SqlDiskDb::open(idx).unwrap(),
        clock,
        mdbn_store_file::Config::default(),
    )
    .unwrap();
    open_store(store, replica)
}

fn hold_native_call(
    a: &mut DiskApp,
    svc: &r::fake::FakeLogService,
    objects: bool,
) -> r::log::LogCall {
    let mut log = svc.client(DEV);
    for _ in 0..128 {
        let mut held = None;
        for call in a.take_log_calls() {
            let target = if objects {
                matches!(call.request, LogRequest::PutObject { .. })
            } else {
                matches!(call.request, LogRequest::Append(_))
            };
            if target {
                assert!(held.is_none());
                held = Some(call);
            } else {
                let reply = log.call(call.request);
                a.on_log_reply(call.id, reply);
            }
        }
        if let Some(call) = held {
            return call;
        }
        a.tick();
    }
    panic!("native upload/capture did not reach its requested boundary");
}

#[test]
fn native_observation_restart_at_upload_pending_and_lost_append_reply() {
    for point in 0..3 {
        let dir = scratch(&format!("native-observation-restart-{point}"));
        let vault = dir.join("vault");
        fs::create_dir_all(&vault).unwrap();
        let svc = r::fake::FakeLogService::new();
        r::testkit::TestControlPlane::signed(COL).genesis_with_keys(
            &svc,
            CState::E2e,
            DEV,
            &[0x31; 32],
            &[0x32; 32],
        );
        let mut a = disk_replica(&dir, 3);
        settle(&mut a, &svc);
        let base = a.head();
        let bytes = "CRLF\r\n🪴\0exact\r\n".repeat(140_000).into_bytes();
        assert!(bytes.len() > 1_048_576);
        fs::write(vault.join("restart.md"), &bytes).unwrap();
        let observations = a.store_mut().observe(None).unwrap();
        a.ingest(observations);
        let call = hold_native_call(&mut a, &svc, point == 0);
        if point == 0 {
            assert!(a.store().pending(None, 10).unwrap().is_empty());
            assert_eq!(a.store().disk_revision("restart.md"), None);
        } else {
            assert_eq!(a.store().pending(None, 10).unwrap().len(), 1);
            assert_eq!(
                a.store().disk_revision("restart.md"),
                Some(w::hash::sha256(&bytes))
            );
        }
        if point == 2 {
            let mut log = svc.client(DEV);
            let _landed_reply = log.call(call.request);
        }
        assert_eq!(svc.head(&COL).0, base.seq + u64::from(point == 2));
        drop(a);
        assert_eq!(fs::read(vault.join("restart.md")).unwrap(), bytes);
        let mut a = disk_replica(&dir, 3);
        let observations = a.store_mut().observe(None).unwrap();
        if point == 0 {
            assert!(
                !observations.is_empty(),
                "unacknowledged upload rediscovered on cold reopen"
            );
        }
        a.ingest(observations);
        settle(&mut a, &svc);
        assert_eq!(
            svc.head(&COL).0,
            base.seq + 1,
            "restart point {point}: only one native entry; status={:?}, failure={:?}, pending={:?}",
            a.sync_status(),
            a.attachment_ingest_failure("restart.md"),
            a.store().pending(None, 10).unwrap()
        );
        assert_eq!(a.head().seq, base.seq + 1);
        let id = a.store().file_at("restart.md").unwrap().unwrap();
        assert_eq!(
            a.store().file(&id).unwrap().unwrap().kind,
            FileKindV1::UnindexedOversizedMarkdown
        );
        assert!(a.store().record(&id).unwrap().is_none());
        assert!(a.store().tombstone(&id).unwrap().is_none());
        assert!(a.store().pending(None, 10).unwrap().is_empty());
        assert_eq!(fs::read(vault.join("restart.md")).unwrap(), bytes);
        assert!(
            a.sync_status().incidents.is_empty(),
            "{:?}",
            a.sync_status().incidents
        );
        drop(a);
        fs::remove_dir_all(dir).unwrap();
    }
}

#[test]
fn native_observation_newer_bytes_cancel_outstanding_upload_reply() {
    let dir = scratch("native-observation-superseded");
    let vault = dir.join("vault");
    fs::create_dir_all(&vault).unwrap();
    let svc = r::fake::FakeLogService::new();
    r::testkit::TestControlPlane::signed(COL).genesis_with_keys(
        &svc,
        CState::E2e,
        DEV,
        &[0x31; 32],
        &[0x32; 32],
    );
    let mut a = disk_replica(&dir, 3);
    settle(&mut a, &svc);
    let base = a.head();
    let old = vec![b'x'; 2_097_153];
    let new = vec![b'y'; 2_097_153];
    fs::write(vault.join("newer.md"), &old).unwrap();
    let observations = a.store_mut().observe(None).unwrap();
    a.ingest(observations);
    let old_call = hold_native_call(&mut a, &svc, true);
    assert!(a.store().pending(None, 10).unwrap().is_empty());
    fs::write(vault.join("newer.md"), &new).unwrap();
    a.store_mut().request_rescan();
    let observations = a.store_mut().observe(None).unwrap();
    assert!(
        !observations.is_empty(),
        "new observation before old upload completes"
    );
    a.ingest(observations);
    let mut log = svc.client(DEV);
    let reply = log.call(old_call.request);
    a.on_log_reply(old_call.id, reply);
    settle(&mut a, &svc);
    assert_eq!(
        svc.head(&COL).0,
        base.seq + 1,
        "superseded bytes never capture/append"
    );
    let id = a.store().file_at("newer.md").unwrap().unwrap();
    assert_eq!(
        a.store().file(&id).unwrap().unwrap().content.plain_hash(),
        w::hash::sha256(&new)
    );
    assert_eq!(fs::read(vault.join("newer.md")).unwrap(), new);
    assert!(
        a.sync_status().incidents.is_empty(),
        "{:?}",
        a.sync_status().incidents
    );
    drop(a);
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn native_observation_reverse_exact_cap_and_empty_keep_identity_and_exact_bytes() {
    for size in [1_048_576, 0] {
        let dir = scratch(&format!("native-observation-reverse-{size}"));
        let vault = dir.join("vault");
        fs::create_dir_all(&vault).unwrap();
        let svc = r::fake::FakeLogService::new();
        r::testkit::TestControlPlane::signed(COL).genesis_with_keys(
            &svc,
            CState::E2e,
            DEV,
            &[0x31; 32],
            &[0x32; 32],
        );
        let clock = WallClock(Rc::new(Cell::new(1700000000000)));
        let mut a = disk_replica_clock(&dir, 3, Box::new(clock.clone()));
        settle(&mut a, &svc);
        fs::write(vault.join("reverse.md"), vec![b'x'; 2_097_153]).unwrap();
        let observations = a.store_mut().observe(None).unwrap();
        a.ingest(observations);
        settle(&mut a, &svc);
        let id = a.store().file_at("reverse.md").unwrap().unwrap();
        let prior = a.store().file(&id).unwrap().unwrap().content;
        let base = a.head();
        let bytes = vec![b'z'; size];
        fs::write(vault.join("reverse.md"), &bytes).unwrap();
        a.store_mut().request_rescan();
        let mut observations = a.store_mut().observe(None).unwrap();
        if size == 0 {
            assert!(
                observations.is_empty(),
                "truncate is rechecked after quiet window"
            );
            clock.0.set(clock.0.get() + 101);
            observations = a.store_mut().observe(None).unwrap();
        }
        assert!(
            observations
                .iter()
                .any(|o| matches!(o.now, Some(r::store::Observed::Text(_)))),
            "reverse size {size}: observations={observations:?}"
        );
        a.ingest(observations);
        let call = hold_native_call(&mut a, &svc, false);
        let pending = a.store().pending(None, 10).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].mutation.source, w::intent::Source::External);
        assert_eq!(pending[0].uploads.len(), 1);
        assert!(!pending[0].refs.is_empty());
        let [w::attachment_runtime_v1::Op::UnindexedMarkdownToRecord(op)] =
            pending[0].mutation.ops.as_slice()
        else {
            panic!("observed reverse requires critical16");
        };
        assert_eq!(op.id, id);
        assert_eq!(op.prior.content, prior);
        assert!(
            a.store().record(&id).unwrap().is_none(),
            "no record before append"
        );
        assert_eq!(
            a.store().disk_revision("reverse.md"),
            Some(w::hash::sha256(&bytes))
        );
        let mut log = svc.client(DEV);
        let reply = log.call(call.request);
        a.on_log_reply(call.id, reply);
        settle(&mut a, &svc);
        assert_eq!(a.head().seq, base.seq + 1);
        assert!(a.store().file(&id).unwrap().is_none());
        assert_eq!(
            a.store().record(&id).unwrap().unwrap().doc.as_bytes(),
            bytes
        );
        assert!(a.store().tombstone(&id).unwrap().is_none());
        assert_eq!(fs::read(vault.join("reverse.md")).unwrap(), bytes);
        assert!(
            a.sync_status().incidents.is_empty(),
            "{:?}",
            a.sync_status().incidents
        );
        let head = a.head();
        drop(a);
        let mut a = disk_replica(&dir, 3);
        settle(&mut a, &svc);
        assert_eq!(a.head(), head);
        assert_eq!(
            a.store().record(&id).unwrap().unwrap().doc.as_bytes(),
            bytes
        );
        assert_eq!(fs::read(vault.join("reverse.md")).unwrap(), bytes);
        assert!(a.store().tombstone(&id).unwrap().is_none());
        drop(a);
        fs::remove_dir_all(dir).unwrap();
    }
}

#[test]
fn native_observation_move_keeps_authoritative_identity() {
    native_observed_move(false);
}

#[test]
fn native_observation_move_and_edit_keeps_authoritative_identity() {
    native_observed_move(true);
}

#[test]
fn native_observation_move_and_reverse_keeps_authoritative_identity() {
    for size in [1_048_576, 0] {
        native_observed_move_case(false, Some(size), 0);
    }
}

#[test]
fn native_observation_pending_move_restart_keeps_authoritative_identity() {
    for (edit, reverse) in [
        (false, None),
        (true, None),
        (false, Some(1_048_576)),
        (false, Some(0)),
    ] {
        native_observed_move_case(edit, reverse, 1);
    }
}

#[test]
fn native_observation_move_lost_append_reply_keeps_authoritative_identity() {
    for (edit, reverse) in [
        (false, None),
        (true, None),
        (false, Some(1_048_576)),
        (false, Some(0)),
    ] {
        native_observed_move_case(edit, reverse, 2);
    }
}

#[test]
fn native_observation_pending_move_supersession_uses_only_latest_bytes() {
    native_observed_move_case(true, None, 3);
    native_observed_move_case(false, Some(1_048_576), 3);
}

fn native_observed_move(edit: bool) {
    native_observed_move_case(edit, None, 0);
}

fn native_observed_move_case(edit: bool, reverse: Option<usize>, restart: u8) {
    let dir = scratch(&format!(
        "native-observation-move-{edit}-{reverse:?}-{restart}"
    ));
    let vault = dir.join("vault");
    fs::create_dir_all(&vault).unwrap();
    let svc = r::fake::FakeLogService::new();
    r::testkit::TestControlPlane::signed(COL).genesis_with_keys(
        &svc,
        CState::E2e,
        DEV,
        &[0x31; 32],
        &[0x32; 32],
    );
    let clock = WallClock(Rc::new(Cell::new(1700000000000)));
    let mut a = disk_replica_clock(&dir, 3, Box::new(clock.clone()));
    settle(&mut a, &svc);
    let mut bytes = vec![b'x'; 2_097_153];
    fs::write(vault.join("before.md"), &bytes).unwrap();
    let observations = a.store_mut().observe(None).unwrap();
    a.ingest(observations);
    settle(&mut a, &svc);
    let id = a.store().file_at("before.md").unwrap().unwrap();
    let prior = a.store().file(&id).unwrap().unwrap().content;
    let base = a.head();
    fs::rename(vault.join("before.md"), vault.join("after.md")).unwrap();
    if let Some(size) = reverse {
        bytes = vec![b'z'; size];
        fs::write(vault.join("after.md"), &bytes).unwrap();
    } else if edit {
        bytes[0] = b'z';
        fs::write(vault.join("after.md"), &bytes).unwrap();
    }
    a.store_mut().request_rescan();
    let mut observations = a.store_mut().observe(None).unwrap();
    clock.0.set(clock.0.get() + 251);
    observations.extend(a.store_mut().observe(None).unwrap());
    clock.0.set(clock.0.get() + 3000);
    observations.extend(a.store_mut().observe(None).unwrap());
    assert!(
        observations
            .iter()
            .any(|o| o.path == "after.md" && o.moved_from.as_deref() == Some("before.md")),
        "real FileStore must recognize the native move: {observations:?}"
    );
    a.ingest(observations);
    if restart != 0 {
        let call = hold_native_call(&mut a, &svc, false);
        let pending = a.store().pending(None, 10).unwrap();
        assert_eq!(pending.len(), 1);
        assert!(matches!(pending[0].mutation.ops.as_slice(),
            [w::attachment_runtime_v1::Op::Legacy(w::intent::Op::FileMove(op))] if op.id == id));
        assert!(!pending[0].refs.is_empty());
        assert_eq!(a.store().file_at("before.md").unwrap(), Some(id));
        assert!(a.store().file_at("after.md").unwrap().is_none());
        if restart == 3 {
            // Supersede the continuation while the metadata Append is held.
            // The metadata still moves only the original authenticated source;
            // the subsequent capture must name the NEW observed bytes only.
            bytes[0] = b'q';
            fs::write(vault.join("after.md"), &bytes).unwrap();
            a.store_mut().request_rescan();
            let observations = a.store_mut().observe(None).unwrap();
            a.ingest(observations);
            let mut log = svc.client(DEV);
            let reply = log.call(call.request);
            a.on_log_reply(call.id, reply);
        } else if restart == 2 {
            // The service durably accepts the signed metadata move, but the
            // caller receives no outcome. Reopen must discover it, not mint a
            // new identity or append another move.
            let mut log = svc.client(DEV);
            log.call(call.request).unwrap();
            assert_eq!(svc.head(&COL).0, base.seq + 1);
        }
        drop(a);
        a = disk_replica_clock(&dir, 3, Box::new(clock.clone()));
        let mut observations = a.store_mut().observe(None).unwrap();
        clock.0.set(clock.0.get() + 251);
        observations.extend(a.store_mut().observe(None).unwrap());
        clock.0.set(clock.0.get() + 3000);
        observations.extend(a.store_mut().observe(None).unwrap());
        a.ingest(observations);
    }
    settle(&mut a, &svc);
    assert_eq!(
        a.head().seq,
        base.seq + if edit || reverse.is_some() { 2 } else { 1 }
    );
    assert_eq!(
        svc.head(&COL).0,
        a.head().seq,
        "metadata move never duplicates after reopen"
    );
    if reverse.is_some() {
        assert!(a.store().file(&id).unwrap().is_none());
        assert_eq!(a.store().record_at("after.md").unwrap(), Some(id));
        assert_eq!(
            a.store().record(&id).unwrap().unwrap().doc.as_bytes(),
            bytes
        );
        assert!(a.store().tombstone(&id).unwrap().is_none());
        assert_eq!(fs::read(vault.join("after.md")).unwrap(), bytes);
        assert!(!vault.join("before.md").exists());
        let head = a.head();
        drop(a);
        let mut a = disk_replica(&dir, 3);
        settle(&mut a, &svc);
        assert_eq!(a.head(), head);
        assert_eq!(a.store().record_at("after.md").unwrap(), Some(id));
        assert_eq!(
            a.store().record(&id).unwrap().unwrap().doc.as_bytes(),
            bytes
        );
        assert_eq!(fs::read(vault.join("after.md")).unwrap(), bytes);
        assert!(a.store().tombstone(&id).unwrap().is_none());
        drop(a);
        fs::remove_dir_all(dir).unwrap();
        return;
    }
    assert_eq!(
        a.store().file_at("after.md").unwrap(),
        Some(id),
        "default native move must not stall or mint another identity; failure={:?}; incidents={:?}",
        a.attachment_ingest_failure("after.md"),
        a.sync_status().incidents,
    );
    assert!(a.store().file_at("before.md").unwrap().is_none());
    let row = a.store().file(&id).unwrap().unwrap();
    assert_eq!(row.kind, FileKindV1::UnindexedOversizedMarkdown);
    assert_eq!(row.content.plain_hash(), w::hash::sha256(&bytes));
    if !edit {
        assert_eq!(row.content, prior);
    }
    assert!(a.store().record(&id).unwrap().is_none());
    assert!(a.store().tombstone(&id).unwrap().is_none());
    assert_eq!(fs::read(vault.join("after.md")).unwrap(), bytes);
    assert!(!vault.join("before.md").exists());
    let head = a.head();
    drop(a);
    let mut a = disk_replica(&dir, 3);
    settle(&mut a, &svc);
    assert_eq!(a.head(), head);
    assert_eq!(a.store().file_at("after.md").unwrap(), Some(id));
    assert_eq!(fs::read(vault.join("after.md")).unwrap(), bytes);
    assert!(a.store().tombstone(&id).unwrap().is_none());
    drop(a);
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn native_observation_rejected_move_retains_identity_and_disk_evidence() {
    for fault in ["missing", "corrupt", "catalog"] {
        let dir = scratch(&format!("native-move-fence-{fault}"));
        let vault = dir.join("vault");
        fs::create_dir_all(&vault).unwrap();
        let svc = r::fake::FakeLogService::new();
        r::testkit::TestControlPlane::signed(COL).genesis_with_keys(
            &svc,
            CState::E2e,
            DEV,
            &[0x31; 32],
            &[0x32; 32],
        );
        let clock = WallClock(Rc::new(Cell::new(1700000000000)));
        let mut a = disk_replica_clock(&dir, 3, Box::new(clock.clone()));
        settle(&mut a, &svc);
        let bytes = vec![b'x'; 2_097_153];
        fs::write(vault.join("before.md"), &bytes).unwrap();
        let observations = a.store_mut().observe(None).unwrap();
        a.ingest(observations);
        settle(&mut a, &svc);
        let id = a.store().file_at("before.md").unwrap().unwrap();
        let prior = a.store().file(&id).unwrap().unwrap().content;
        let head = a.head();
        fs::rename(vault.join("before.md"), vault.join("after.md")).unwrap();
        a.store_mut().request_rescan();
        let mut observations = a.store_mut().observe(None).unwrap();
        clock.0.set(clock.0.get() + 251);
        observations.extend(a.store_mut().observe(None).unwrap());
        clock.0.set(clock.0.get() + 3000);
        observations.extend(a.store_mut().observe(None).unwrap());
        a.ingest(observations);
        let pending = a.store().pending(None, 10).unwrap();
        assert_eq!(pending.len(), 1);
        let mutation = pending[0].mutation.id;
        let key = format!("native_move/{}", mutation.to_hex());
        let tx = match fault {
            "missing" => Tx {
                meta: vec![(key, None)],
                ..Tx::default()
            },
            "corrupt" => Tx {
                meta: vec![(key, Some(vec![0xff]))],
                ..Tx::default()
            },
            "catalog" => Tx {
                resources_put: vec![("mdbase.yaml".into(), "spec_version: '0.3.0'\n".into())],
                ..Tx::default()
            },
            _ => unreachable!(),
        };
        a.store_mut().commit(tx).unwrap();
        settle(&mut a, &svc);
        assert_eq!(
            svc.head(&COL).0,
            head.seq,
            "{fault}: no stale metadata append"
        );
        assert_eq!(a.store().file_at("before.md").unwrap(), Some(id));
        assert_eq!(a.store().file(&id).unwrap().unwrap().content, prior);
        assert!(
            a.store().file_at("after.md").unwrap().is_none(),
            "{fault}: never mint another identity"
        );
        assert!(a.store().record_at("after.md").unwrap().is_none());
        assert!(a.store().tombstone(&id).unwrap().is_none());
        assert_eq!(fs::read(vault.join("after.md")).unwrap(), bytes);
        assert!(
            a.attachment_ingest_failure("after.md").is_some()
                || !a.sync_status().incidents.is_empty()
        );
        drop(a);
        fs::remove_dir_all(dir).unwrap();
    }
}

fn settle_authenticated<S: Store>(a: &mut Replica<S>, svc: &r::fake::FakeLogService) {
    let mut log = svc.client(DEV);
    let mut session = a.bind_authenticated_log(a.log_endpoint(), COL).unwrap();
    for _ in 0..40 {
        for _ in 0..200 {
            for push in log.poll_pushes() {
                let _ = a.on_authenticated_log_push(&session, |_| Ok(push));
            }
            let calls = match a.take_authenticated_log_calls(&session) {
                Ok(calls) => calls,
                Err(
                    r::replica::LogSessionError::Stale | r::replica::LogSessionError::WrongBinding,
                ) => {
                    session = a.bind_authenticated_log(a.log_endpoint(), COL).unwrap();
                    continue;
                }
                Err(e) => panic!("persistent native authenticated transport: {e:?}"),
            };
            if calls.is_empty() {
                break;
            }
            for (call, scope) in calls {
                let reply = log.call(call.request);
                let _ = a.on_authenticated_log_reply(scope, |_, _| reply);
            }
        }
        a.tick();
    }
}

#[test]
fn native_observation_acknowledged_move_overwritten_gap_recovers_current_source_and_cold_reopens() {
    let dir = scratch("native-watcher-lost-tail-fallback");
    let vault = dir.join("vault");
    fs::create_dir_all(&vault).unwrap();
    let svc = r::fake::FakeLogService::new();
    r::testkit::TestControlPlane::signed(COL).genesis_with_keys(
        &svc,
        CState::E2e,
        DEV,
        &[0x31; 32],
        &[0x32; 32],
    );
    let clock = WallClock(Rc::new(Cell::new(1700000000000)));
    let mut a = disk_replica_clock(&dir, 3, Box::new(clock.clone()));
    settle(&mut a, &svc);
    let bytes = vec![b'x'; 1_048_577];
    fs::write(vault.join("before.md"), &bytes).unwrap();
    let observations = a.store_mut().observe(None).unwrap();
    a.ingest(observations);
    settle(&mut a, &svc);
    let id = a.store().file_at("before.md").unwrap().unwrap();
    let mut b = open(&dir.join("other.db"), 4);
    settle(&mut b, &svc);
    assert_eq!(a.head(), b.head());
    let common = a.head();
    fs::rename(vault.join("before.md"), vault.join("after.md")).unwrap();
    a.store_mut().request_rescan();
    let mut observations = a.store_mut().observe(None).unwrap();
    clock.0.set(clock.0.get() + 251);
    observations.extend(a.store_mut().observe(None).unwrap());
    clock.0.set(clock.0.get() + 3000);
    observations.extend(a.store_mut().observe(None).unwrap());
    a.ingest(observations);
    let pending = a.store().pending(None, 10).unwrap();
    assert_eq!(pending.len(), 1);
    let mutation = pending[0].mutation.id;
    settle(&mut a, &svc);
    assert_eq!(a.head().seq, common.seq + 1);
    assert!(a.store().pending_get(&mutation).unwrap().is_none());
    assert_eq!(
        a.store().receipt(&mutation).unwrap().unwrap().seq,
        common.seq + 1
    );
    assert_eq!(b.head(), common);
    svc.lose_tail(&COL, 1);
    let changed = vec![b'y'; 1_048_578];
    let proof = b
        .prepare_unindexed_markdown_capture(
            id,
            "before.md".into(),
            Box::new(Source(changed.clone())),
        )
        .unwrap();
    let upload = b.start_unindexed_markdown_upload(proof).unwrap();
    settle(&mut b, &svc);
    let prepared = b.take_prepared_unindexed_upload(&upload).unwrap();
    b.capture_prepared_unindexed_upload(prepared).unwrap();
    settle(&mut b, &svc);
    let current = b.store().file(&id).unwrap().unwrap().content;
    a.on_log_push(LogPush::Reconnected);
    // Prefix proof is accepted ONLY through the authenticated native reply
    // scopes. Legacy LogPort delivery cannot qualify a surviving prefix.
    settle_authenticated(&mut a, &svc);
    settle_authenticated(&mut b, &svc);
    assert_eq!(a.repair_status(), None, "{:?}", a.sync_status());
    assert_eq!(a.repair_stats().rolled_back, 1);
    assert_eq!(a.repair_stats().resurrected, 1);
    assert_eq!(a.store().file_at("after.md").unwrap(), Some(id));
    assert_eq!(a.store().file(&id).unwrap().unwrap().content, current);
    assert!(a.store().receipt(&mutation).unwrap().unwrap().seq > common.seq + 1);
    assert!(a.store().pending_get(&mutation).unwrap().is_none());
    assert!(a.store().tombstone(&id).unwrap().is_none());
    assert!(a.store().record(&id).unwrap().is_none());
    assert_eq!(a.head(), b.head());
    assert_eq!(a.stats.verify_mismatch, 0);
    assert_eq!(b.stats.verify_mismatch, 0);
    // New confirmed current-source bytes may publish only against the managed
    // prior source; the user's real path/identity must survive recovery/reopen.
    assert_eq!(fs::read(vault.join("after.md")).unwrap(), changed);
    let head = a.head();
    drop(a);
    let mut a = disk_replica_clock(&dir, 3, Box::new(clock));
    settle(&mut a, &svc);
    assert_eq!(a.head(), head);
    assert_eq!(a.store().file_at("after.md").unwrap(), Some(id));
    assert_eq!(a.store().file(&id).unwrap().unwrap().content, current);
    assert_eq!(fs::read(vault.join("after.md")).unwrap(), changed);
    assert!(a.store().pending(None, 10).unwrap().is_empty());
    drop(a);
    drop(b);
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn native_observation_delete_waits_for_missing_window_and_retains_full_tomb_on_reopen() {
    let dir = scratch("native-observation-delete");
    let vault = dir.join("vault");
    fs::create_dir_all(&vault).unwrap();
    let svc = r::fake::FakeLogService::new();
    r::testkit::TestControlPlane::signed(COL).genesis_with_keys(
        &svc,
        CState::E2e,
        DEV,
        &[0x31; 32],
        &[0x32; 32],
    );
    let clock = WallClock(Rc::new(Cell::new(1700000000000)));
    let mut a = disk_replica_clock(&dir, 3, Box::new(clock.clone()));
    settle(&mut a, &svc);
    fs::write(vault.join("delete.md"), vec![b'x'; 2_097_153]).unwrap();
    let observations = a.store_mut().observe(None).unwrap();
    a.ingest(observations);
    settle(&mut a, &svc);
    let id = a.store().file_at("delete.md").unwrap().unwrap();
    let content = a.store().file(&id).unwrap().unwrap().content;
    let base = a.head();
    fs::remove_file(vault.join("delete.md")).unwrap();
    a.store_mut().request_rescan();
    assert!(
        a.store_mut().observe(None).unwrap().is_empty(),
        "one missing stat is not deletion"
    );
    clock.0.set(clock.0.get() + 251);
    assert!(
        a.store_mut().observe(None).unwrap().is_empty(),
        "recheck still waits for move window"
    );
    clock.0.set(clock.0.get() + 3000);
    let observations = a.store_mut().observe(None).unwrap();
    assert_eq!(observations.len(), 1);
    assert!(observations[0].now.is_none());
    a.ingest(observations);
    settle(&mut a, &svc);
    assert_eq!(a.head().seq, base.seq + 1);
    assert!(a.store().file(&id).unwrap().is_none());
    assert!(a.store().record(&id).unwrap().is_none());
    let tomb = a.store().tombstone(&id).unwrap().unwrap();
    assert_eq!(
        tomb.last,
        r::store::TombstoneLast::UnindexedMarkdown(
            w::unindexed_markdown::UnindexedMarkdownPayloadV1 { content }
        )
    );
    assert!(!vault.join("delete.md").exists());
    assert!(
        a.sync_status().incidents.is_empty(),
        "{:?}",
        a.sync_status().incidents
    );
    let head = a.head();
    drop(a);
    let mut a = disk_replica(&dir, 3);
    settle(&mut a, &svc);
    assert_eq!(a.head(), head);
    assert_eq!(a.store().tombstone(&id).unwrap(), Some(tomb));
    assert!(!vault.join("delete.md").exists());
    drop(a);
    fs::remove_dir_all(dir).unwrap();
}

struct Source(Vec<u8>);
impl r::replica::AttachmentSource for Source {
    fn len(&self) -> u64 {
        self.0.len() as u64
    }
    fn read_at(&mut self, o: u64, b: &mut [u8]) -> Result<(), String> {
        b.copy_from_slice(&self.0[o as usize..o as usize + b.len()]);
        Ok(())
    }
}
fn open(path: &std::path::Path, replica: u8) -> App {
    let store = SqlStore::open(Rc::new(RefCell::new(
        SqliteIndex::open(path, IndexDurability::Durable).unwrap(),
    )))
    .unwrap();
    open_store(store, replica)
}
fn open_store<S: Store>(store: S, replica: u8) -> Replica<S> {
    assert!(store.stages());
    let mut a = Replica::open(
        ReplicaConfig {
            collection: COL,
            device_id: DEV,
            replica_id: B16([replica; 16]),
            mode: w::client::SyncMode::Synced,
            log_endpoint: EndpointId(1),
            verify: true,
            runtime_version: "native-snapshot-test".into(),
            trusted_roots: vec![r::testkit::signed_root()],
            trusted_signers: vec![],
            e2e: false,
            user_enabled_cloud_copy: false,
            chosen_state: None,
            expected_genesis: None,
            key_grants_only: false,
            policy_pins: None,
        },
        store,
        Box::new(r::plan::CorePlanner),
        Box::new(r::seal::KeyringSealer::new(
            COL,
            DEV,
            &[0x31; 32],
            &[0x32; 32],
        )),
        Host {
            clock: Box::new(mdbn_core::host::FixedClock(1700000000000)),
            entropy: Box::new(r::crypto::TestEntropy::new(replica)),
            zones: Box::new(UtcOnly),
        },
        DeviceSecrets {
            sign_sk: [0x31; 32],
            kem_sk: [0x32; 32],
        },
    )
    .unwrap();
    a.enforce_shipped_install_gate();
    assert!(a.snapshot_install_available());
    a
}
fn settle<S: Store>(a: &mut Replica<S>, svc: &r::fake::FakeLogService) {
    let mut c = svc.client(DEV);
    for _ in 0..40 {
        r::log::pump(a, &mut c, 200);
        a.tick();
    }
}
#[test]
fn durable_native_snapshot_full_source_fence_atomic_swap_and_reopen() {
    let dir = scratch("native-watcher-snapshot-auth");
    let svc = r::fake::FakeLogService::new();
    r::testkit::TestControlPlane::signed(COL).genesis_with_keys(
        &svc,
        CState::E2e,
        DEV,
        &[0x31; 32],
        &[0x32; 32],
    );
    let mut a = open(&dir.join("a.db"), 1);
    settle(&mut a, &svc);
    let id = B16([61; 16]);
    let bytes = vec![b'x'; 2097153];
    let p = a
        .prepare_unindexed_markdown_capture(id, "huge.md".into(), Box::new(Source(bytes)))
        .unwrap();
    let upload = a.start_unindexed_markdown_upload(p).unwrap();
    settle(&mut a, &svc);
    let p = a.take_prepared_unindexed_upload(&upload).unwrap();
    let refs = p
        .refs()
        .iter()
        .copied()
        .collect::<std::collections::BTreeSet<_>>();
    a.capture_prepared_unindexed_upload(p).unwrap();
    settle(&mut a, &svc);
    let f = a.store().file(&id).unwrap().unwrap();
    assert_eq!(f.kind, FileKindV1::UnindexedOversizedMarkdown);
    let digest = r::replica::state_digest(a.store()).unwrap();
    a.build_snapshot_now().unwrap();
    settle(&mut a, &svc);
    assert_eq!(a.stats.snapshots_built, 1);
    svc.compact(&COL, a.head().seq);
    let db = dir.join("b.db");
    let mut b = open(&db, 2);
    let mut log = svc.client(DEV);
    let mut held = None;
    for _ in 0..128 {
        for c in b.take_log_calls() {
            if matches!(&c.request,LogRequest::GetObject{address,..} if refs.contains(address)) {
                held = Some(c);
                break;
            }
            let reply = log.call(c.request);
            b.on_log_reply(c.id, reply);
        }
        if held.is_some() {
            break;
        }
        b.tick();
    }
    let call = held.expect("native source authentication before swap");
    assert!(b.installing());
    assert_eq!(b.stats.snapshots_installed, 0);
    assert!(b.store().file(&id).unwrap().is_none());
    assert!(
        b.store()
            .meta("replica.unindexed_byte_proofs")
            .unwrap()
            .is_none()
    );
    let reply = log.call(call.request);
    b.on_log_reply(call.id, reply);
    settle(&mut b, &svc);
    assert!(!b.installing(), "{:?}", b.sync_status().incidents);
    assert_eq!(b.stats.snapshots_installed, 1);
    assert_eq!(b.store().file(&id).unwrap().unwrap(), f);
    assert_eq!(r::replica::state_digest(b.store()).unwrap(), digest);
    assert!(
        b.store()
            .meta("replica.unindexed_byte_proofs")
            .unwrap()
            .is_some()
    );
    // A normal signed tail performs reverse16 after the compacted snapshot.
    let mut doc = b"---\r\ntitle: exact\r\n---\r\n\0text\r\n".to_vec();
    doc.resize(1_048_576, b'y');
    let p = a
        .prepare_unindexed_markdown_reindex(id, "huge.md".into(), Box::new(Source(doc.clone())))
        .unwrap();
    let u = a.start_unindexed_markdown_reindex_upload(p).unwrap();
    settle(&mut a, &svc);
    let p = a.take_prepared_unindexed_reindex_upload(&u).unwrap();
    a.capture_prepared_unindexed_reindex_upload(p).unwrap();
    settle(&mut a, &svc);
    b.on_log_push(LogPush::Head {
        collection: COL,
        head: a.head().seq,
        head_chain: a.head().chain,
    });
    settle(&mut b, &svc);
    assert!(b.store().file(&id).unwrap().is_none());
    assert_eq!(b.store().record(&id).unwrap().unwrap().doc.as_bytes(), doc);
    assert!(b.store().tombstone(&id).unwrap().is_none());
    assert_eq!(b.head(), a.head());
    let digest = r::replica::state_digest(b.store()).unwrap();
    let head = b.head();
    drop(b);
    let mut b = open(&db, 2);
    assert_eq!(b.store().head().unwrap(), head);
    assert!(b.store().file(&id).unwrap().is_none());
    assert_eq!(b.store().record(&id).unwrap().unwrap().doc.as_bytes(), doc);
    assert_eq!(r::replica::state_digest(b.store()).unwrap(), digest);
    settle(&mut b, &svc);
    assert!(
        b.sync_status().incidents.is_empty(),
        "{:?}",
        b.sync_status().incidents
    );
    assert_eq!(
        b.store()
            .records(Page {
                after: None,
                limit: 10
            })
            .unwrap()
            .len(),
        1
    );
    assert!(b.store().meta(meta_keys::KEYRING).unwrap().is_some());
}

#[test]
fn signed_native_receiving_materializes_real_files_and_reverse_preserves_user_edits() {
    let dir = scratch("native-watcher-signed-placement");
    let vault = dir.join("vault");
    fs::create_dir_all(&vault).unwrap();
    let svc = r::fake::FakeLogService::new();
    r::testkit::TestControlPlane::signed(COL).genesis_with_keys(
        &svc,
        CState::E2e,
        DEV,
        &[0x31; 32],
        &[0x32; 32],
    );
    let mut a = open(&dir.join("writer.db"), 1);
    let open_reader = || {
        let index = Rc::new(RefCell::new(
            SqliteIndex::open(dir.join("reader.db"), IndexDurability::Durable).unwrap(),
        ));
        let store = FileStore::open(
            Rc::new(platform(&vault)),
            SqlStore::open(index.clone()).unwrap(),
            SqlDiskDb::open(index).unwrap(),
            Box::new(mdbn_core::host::FixedClock(1700000000000)),
            Config::default(),
        )
        .unwrap();
        if store.file(&B16([71; 16])).unwrap().is_some() {
            assert!(
                vault.join("placed.md").exists(),
                "removed during FileStore open"
            );
        }
        open_store(store, 2)
    };
    let mut b = open_reader();
    settle(&mut a, &svc);
    settle(&mut b, &svc);
    let id = B16([71; 16]);
    let bytes = vec![b'x'; 2_097_153];
    let p = a
        .prepare_unindexed_markdown_capture(id, "placed.md".into(), Box::new(Source(bytes.clone())))
        .unwrap();
    let upload = a.start_unindexed_markdown_upload(p).unwrap();
    settle(&mut a, &svc);
    let p = a.take_prepared_unindexed_upload(&upload).unwrap();
    a.capture_prepared_unindexed_upload(p).unwrap();
    settle(&mut a, &svc);
    b.on_log_push(LogPush::Head {
        collection: COL,
        head: a.head().seq,
        head_chain: a.head().chain,
    });
    settle(&mut b, &svc);
    assert_eq!(b.head(), a.head());
    assert_eq!(
        b.store().file(&id).unwrap().unwrap().kind,
        FileKindV1::UnindexedOversizedMarkdown
    );
    assert!(
        vault.join("placed.md").exists(),
        "materialization {:?}; incidents {:?}",
        b.attachment_fetch_status(&id),
        b.sync_status().incidents
    );
    assert_eq!(fs::read(vault.join("placed.md")).unwrap(), bytes);
    assert!(b.store().tombstone(&id).unwrap().is_none());
    drop(b);
    let mut b = open_reader();
    assert!(
        vault.join("placed.md").exists(),
        "removed during open: row {:?}; status {:?}; incidents {:?}",
        b.store().file(&id).unwrap(),
        b.attachment_fetch_status(&id),
        b.sync_status().incidents
    );
    settle(&mut b, &svc);
    assert!(
        vault.join("placed.md").exists(),
        "removed during settling: row {:?}; status {:?}; incidents {:?}",
        b.store().file(&id).unwrap(),
        b.attachment_fetch_status(&id),
        b.sync_status().incidents
    );
    assert_eq!(fs::read(vault.join("placed.md")).unwrap(), bytes);
    // A real user edit is not overwritten by the subsequent confirmed reverse.
    let user = b"user changed the local file\r\n";
    fs::write(vault.join("placed.md"), user).unwrap();
    let doc = b"---\r\ntitle: reverse\r\n---\r\nexact\0text\r\n".to_vec();
    let p = a
        .prepare_unindexed_markdown_reindex(id, "placed.md".into(), Box::new(Source(doc.clone())))
        .unwrap();
    let upload = a.start_unindexed_markdown_reindex_upload(p).unwrap();
    settle(&mut a, &svc);
    let p = a.take_prepared_unindexed_reindex_upload(&upload).unwrap();
    a.capture_prepared_unindexed_reindex_upload(p).unwrap();
    settle(&mut a, &svc);
    b.on_log_push(LogPush::Head {
        collection: COL,
        head: a.head().seq,
        head_chain: a.head().chain,
    });
    settle(&mut b, &svc);
    assert_eq!(b.head(), a.head());
    assert!(b.store().file(&id).unwrap().is_none());
    assert_eq!(b.store().record(&id).unwrap().unwrap().doc.as_bytes(), doc);
    assert!(b.store().tombstone(&id).unwrap().is_none());
    assert_eq!(fs::read(vault.join("placed.md")).unwrap(), user);
}
