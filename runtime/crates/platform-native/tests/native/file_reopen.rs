//! Restart cleanup must respect persisted File identity, not current extensions.
//! Uses real FileStore/SQLite. Seeded confirmed rows model an existing file plus
//! a later catalog update; this is not native public capture activation evidence.
use super::*;
use mdbn_store_file::{
    FileStore, SqlStore,
    testing::{replica as r, wire as w},
};
use r::{
    DeviceSecrets, Host, Replica, ReplicaConfig, UtcOnly,
    log::{EndpointId, pump},
    store::{Content, Expect, FileLocal, FileRow, Publish, bucket16},
};
use w::{
    attachment::FileContent,
    common::{B16, B32},
    intent::{BlobRef, MediaClass},
    unindexed_markdown::FileKindV1,
};
const COL: B16 = B16([7; 16]);
const DEV: B16 = B16([101; 16]);
type DiskStore = FileStore<NativePlatform, SqlStore<SqliteIndex>, SqlDiskDb<SqliteIndex>>;
fn open_store(dir: &std::path::Path) -> DiskStore {
    let idx = Rc::new(RefCell::new(
        SqliteIndex::open(dir.join("state.db"), IndexDurability::Durable).unwrap(),
    ));
    let inner = SqlStore::open(idx.clone()).unwrap();
    FileStore::open(
        Rc::new(platform(&dir.join("vault"))),
        inner,
        SqlDiskDb::open(idx).unwrap(),
        Box::new(mdbn_core::host::FixedClock(1700000000000)),
        mdbn_store_file::Config::default(),
    )
    .unwrap()
}
fn open_replica(store: DiskStore) -> Replica<DiskStore> {
    Replica::open(
        ReplicaConfig {
            collection: COL,
            device_id: DEV,
            replica_id: B16([2; 16]),
            mode: w::client::SyncMode::Synced,
            log_endpoint: EndpointId(1),
            verify: true,
            runtime_version: "file-reopen-test".into(),
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
            entropy: Box::new(r::crypto::TestEntropy::new(2)),
            zones: Box::new(UtcOnly),
        },
        DeviceSecrets {
            sign_sk: [0x31; 32],
            kem_sk: [0x32; 32],
        },
    )
    .unwrap()
}
#[test]
fn live_files_survive_catalog_reclassification_and_cold_reopen_without_deleting_user_files() {
    let dir = scratch("live-file-reopen");
    let vault = dir.join("vault");
    fs::create_dir_all(&vault).unwrap();
    let svc = r::fake::FakeLogService::new();
    r::testkit::TestControlPlane::signed(COL).genesis_with_keys(
        &svc,
        w::policy::CState::E2e,
        DEV,
        &[0x31; 32],
        &[0x32; 32],
    );
    let mut a = open_replica(open_store(&dir));
    let mut log = svc.client(DEV);
    pump(&mut a, &mut log, 200);
    a.tick();
    pump(&mut a, &mut log, 200);
    let mut store = a.into_store();
    let cases = [
        (
            FileKindV1::Ordinary,
            "saved.note",
            "ordinary exact bytes".to_string(),
        ),
        (
            FileKindV1::UnindexedOversizedMarkdown,
            "huge.md",
            "native exact bytes\r\n🪴\0".repeat(60_000),
        ),
    ];
    for (i, (kind, path, bytes)) in cases.iter().enumerate() {
        let id = B16([i as u8 + 60; 16]);
        let hash = revision(bytes.as_bytes());
        let row = FileRow {
            kind: *kind,
            id,
            path: (*path).into(),
            path_key: (*path).into(),
            content: FileContent::Blob(BlobRef {
                plain_hash: hash,
                size: bytes.len() as u64,
                blob_id: B32([71; 32]),
                id_epoch: 1,
                part_size: 1 << 20,
            }),
            media: MediaClass::Other,
            modified_seq: 1,
            bucket: bucket16(&id),
            local: FileLocal::Materialized,
        };
        store
            .commit(Tx {
                files_put: vec![row],
                publish: vec![Publish::Write {
                    id: Some(id),
                    path: (*path).into(),
                    expect: Expect::Absent,
                    content: Content::Text(bytes.clone()),
                }],
                ..Tx::default()
            })
            .unwrap();
    }
    // A legitimate catalog update changes classification but does not promote
    // or delete the live Ordinary file (promotion is an independent operation).
    store
        .commit(Tx {
            resources_put: vec![(
                "mdbase.yaml".into(),
                "spec_version: '0.3.0'\nsettings:\n  record_extensions: [md, note]\n".into(),
            )],
            ..Tx::default()
        })
        .unwrap();
    // Unknown paths have no managed revision. A former managed stray whose
    // bytes were edited must fail the existing conditional-delete comparison.
    fs::write(vault.join("unowned.md"), b"unowned exact bytes").unwrap();
    store
        .commit(Tx {
            publish: vec![
                Publish::Write {
                    id: None,
                    path: "edited-stray.md".into(),
                    expect: Expect::Absent,
                    content: Content::Text("previously managed".into()),
                },
                Publish::Write {
                    id: None,
                    path: "owned-stray.md".into(),
                    expect: Expect::Absent,
                    content: Content::Text("stale managed revision".into()),
                },
            ],
            ..Tx::default()
        })
        .unwrap();
    fs::write(vault.join("edited-stray.md"), b"new user bytes").unwrap();
    drop(store);
    for _ in 0..2 {
        let a = open_replica(open_store(&dir));
        for (i, (kind, path, bytes)) in cases.iter().enumerate() {
            assert_eq!(fs::read(vault.join(path)).unwrap(), bytes.as_bytes());
            let f = a.store().file(&B16([i as u8 + 60; 16])).unwrap().unwrap();
            assert_eq!(f.kind, *kind);
            assert!(a.store().record(&f.id).unwrap().is_none());
        }
        assert_eq!(
            fs::read(vault.join("unowned.md")).unwrap(),
            b"unowned exact bytes"
        );
        assert_eq!(
            fs::read(vault.join("edited-stray.md")).unwrap(),
            b"new user bytes"
        );
        assert!(
            !vault.join("owned-stray.md").exists(),
            "real managed leftovers still cleaned"
        );
        drop(a);
    }
    fs::remove_dir_all(dir).unwrap();
}
