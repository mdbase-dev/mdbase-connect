//! Actual signed explicit capture, placement, authenticated snapshot and reopen.
#[path = "native_activation/binary_holds.rs"]
mod binary_holds;

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
    let dir = scratch("native-snapshot-auth");
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
    let dir = scratch("native-signed-placement");
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
