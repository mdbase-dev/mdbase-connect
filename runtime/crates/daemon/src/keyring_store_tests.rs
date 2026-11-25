//! The keyring never reaches the index; write-once generations commit atomically
//! with the state, and nothing is deleted.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering::SeqCst};

use mdbn_replica::mem::MemStore;
use mdbn_replica::store::{Store, StoreError, Tx, meta_keys};
use mdbn_wire::common::B16;

use super::*;
use crate::secrets::{MemoryStore, SecretError, SecretStore};

const C: B16 = B16([0x0c; 16]);

/// A credential store that can refuse writes, drop them silently, or claim every
/// entry already exists; it records every name written.
#[derive(Default)]
struct Flaky {
    inner: MemoryStore,
    refuse_set: AtomicBool,
    drop_writes: AtomicBool,
    claim_exists: AtomicBool,
    written: std::sync::Mutex<Vec<String>>,
    deletes: std::sync::atomic::AtomicUsize,
}
impl SecretStore for Flaky {
    fn get(&self, n: &str) -> Result<Option<zeroize::Zeroizing<Vec<u8>>>, SecretError> {
        if self.claim_exists.load(SeqCst) {
            return Ok(Some(zeroize::Zeroizing::new(b"other".to_vec())));
        }
        self.inner.get(n)
    }
    fn set(&self, n: &str, v: &[u8]) -> Result<(), SecretError> {
        if self.refuse_set.load(SeqCst) {
            return Err(SecretError::Unavailable("locked".into()));
        }
        self.written.lock().unwrap().push(n.to_string());
        if self.drop_writes.load(SeqCst) {
            return Ok(());
        }
        self.inner.set(n, v)
    }
    fn delete(&self, n: &str) -> Result<(), SecretError> {
        self.deletes.fetch_add(1, SeqCst);
        self.inner.delete(n)
    }
    fn backend(&self) -> &'static str {
        "flaky"
    }
}

fn tx(keyring: Option<Option<&[u8]>>, policy: &[u8]) -> Tx {
    let mut meta = vec![(meta_keys::POLICY.to_string(), Some(policy.to_vec()))];
    if let Some(k) = keyring {
        meta.push((meta_keys::KEYRING.to_string(), k.map(<[u8]>::to_vec)));
    }
    Tx {
        meta,
        ..Tx::default()
    }
}

fn open(
    data: &std::rc::Rc<std::cell::RefCell<mdbn_replica::mem::MemData>>,
    s: &Arc<Flaky>,
) -> KeychainKeyring<MemStore> {
    let secrets: Arc<dyn SecretStore> = s.clone();
    KeychainKeyring::new(MemStore::shared(data.clone()), Some(secrets), &C).unwrap()
}

fn generation(s: &KeychainKeyring<MemStore>) -> Option<Generation> {
    s.inner()
        .meta(GENERATION_META)
        .unwrap()
        .map(|b| b.try_into().unwrap())
}

fn has(s: &Flaky, g: &Generation) -> bool {
    s.inner.get(&keyring_name(&C, g)).unwrap().is_some()
}

fn keyring(s: &KeychainKeyring<MemStore>) -> Option<Vec<u8>> {
    s.meta(meta_keys::KEYRING).unwrap()
}

fn policy(s: &KeychainKeyring<MemStore>) -> Option<Vec<u8>> {
    s.inner().meta(meta_keys::POLICY).unwrap()
}

fn all_distinct(secrets: &Flaky) -> bool {
    let w = secrets.written.lock().unwrap();
    let set: std::collections::BTreeSet<_> = w.iter().collect();
    set.len() == w.len()
}

#[test]
fn generations_commit_with_the_state_and_nothing_is_deleted() {
    let secrets = Arc::new(Flaky::default());
    let data = MemStore::new().data();
    let mut s = open(&data, &secrets);
    s.commit(tx(Some(Some(b"k1")), b"p1")).unwrap();
    let g1 = generation(&s).unwrap();
    assert_eq!(
        s.inner().meta(meta_keys::KEYRING).unwrap(),
        None,
        "not in the index"
    );
    assert_eq!(s.meta(GENERATION_META).unwrap(), None, "internal");
    assert_eq!(s.meta(RETAINED_META).unwrap(), None, "internal");
    s.commit(tx(Some(Some(b"k2")), b"p2")).unwrap();
    let g2 = generation(&s).unwrap();
    assert_ne!(g1, g2);
    assert!(has(&secrets, &g1) && has(&secrets, &g2), "g1 retained");
    assert_eq!(s.retained().unwrap(), vec![g1]);
    // Commits without a keyring change keep the generation.
    s.commit(tx(None, b"p3")).unwrap();
    drop(s);
    let s = open(&data, &secrets);
    assert_eq!(keyring(&s).as_deref(), Some(&b"k2"[..]));
    assert_eq!(policy(&s).as_deref(), Some(&b"p3"[..]));
    assert_eq!(secrets.deletes.load(SeqCst), 0);
}

#[test]
fn a_caller_cannot_set_the_internal_reference() {
    let secrets = Arc::new(Flaky::default());
    let data = MemStore::new().data();
    let mut s = open(&data, &secrets);
    s.commit(tx(Some(Some(b"k1")), b"p1")).unwrap();
    let g1 = generation(&s).unwrap();
    let mut t = tx(None, b"p2");
    t.meta.push((GENERATION_META.into(), Some(vec![9; 16])));
    t.meta.push((RETAINED_META.into(), Some(vec![9; 16])));
    s.commit(t).unwrap();
    assert_eq!(generation(&s), Some(g1));
    assert!(s.retained().unwrap().is_empty());
}

#[test]
fn an_aborted_index_commit_keeps_the_old_pair_and_never_reuses_its_entry() {
    let secrets = Arc::new(Flaky::default());
    let data = MemStore::new().data();
    let mut s = open(&data, &secrets);
    s.commit(tx(Some(Some(b"k1")), b"p1")).unwrap();
    // The credential write succeeds, then the index commit aborts.
    s.inner().fail_commits(1);
    assert!(s.commit(tx(Some(Some(b"k2")), b"p2")).is_err());
    drop(s);
    let mut s = open(&data, &secrets);
    assert_eq!(keyring(&s).as_deref(), Some(&b"k1"[..]));
    assert_eq!(policy(&s).as_deref(), Some(&b"p1"[..]));
    // A retry writes a fresh generation; the orphan stays, unreferenced.
    s.commit(tx(Some(Some(b"k2")), b"p2")).unwrap();
    assert_eq!(keyring(&s).as_deref(), Some(&b"k2"[..]));
    assert_eq!(secrets.written.lock().unwrap().len(), 3);
    assert!(all_distinct(&secrets));
    assert_eq!(secrets.deletes.load(SeqCst), 0);
}

#[test]
fn an_uncertain_commit_that_landed_reads_its_own_generation() {
    let secrets = Arc::new(Flaky::default());
    let data = MemStore::new().data();
    let mut s = open(&data, &secrets);
    s.commit(tx(Some(Some(b"k1")), b"p1")).unwrap();
    // Applied, then reported as failed: the index holds the new pair.
    s.inner().fail_after_commit(1);
    assert!(s.commit(tx(Some(Some(b"k2")), b"p2")).is_err());
    drop(s);
    let s = open(&data, &secrets);
    assert_eq!(keyring(&s).as_deref(), Some(&b"k2"[..]));
    assert_eq!(policy(&s).as_deref(), Some(&b"p2"[..]));
}

#[test]
fn a_refused_dropped_or_existing_credential_write_commits_nothing() {
    for flag in ["refuse", "drop", "exists"] {
        let secrets = Arc::new(Flaky::default());
        let data = MemStore::new().data();
        let mut s = open(&data, &secrets);
        s.commit(tx(Some(Some(b"k1")), b"p1")).unwrap();
        let g1 = generation(&s);
        match flag {
            "refuse" => secrets.refuse_set.store(true, SeqCst),
            "drop" => secrets.drop_writes.store(true, SeqCst),
            _ => secrets.claim_exists.store(true, SeqCst),
        }
        let before = secrets.written.lock().unwrap().len();
        let e = s.commit(tx(Some(Some(b"k2")), b"p2")).unwrap_err();
        match flag {
            "exists" => {
                assert!(matches!(e, StoreError::Corrupt(_)), "{flag}: {e:?}");
                assert_eq!(
                    secrets.written.lock().unwrap().len(),
                    before,
                    "no overwrite"
                );
            }
            _ => assert!(matches!(e, StoreError::Io(_)), "{flag}: {e:?}"),
        }
        assert_eq!(policy(&s).as_deref(), Some(&b"p1"[..]), "{flag}");
        assert_eq!(generation(&s), g1, "{flag}");
        secrets.claim_exists.store(false, SeqCst);
        assert_eq!(keyring(&s).as_deref(), Some(&b"k1"[..]), "{flag}");
    }
}

#[test]
fn removal_commits_absence_deletes_nothing_and_a_new_keyring_is_fresh() {
    let secrets = Arc::new(Flaky::default());
    let data = MemStore::new().data();
    let mut s = open(&data, &secrets);
    s.commit(tx(Some(Some(b"k1")), b"p1")).unwrap();
    let g1 = generation(&s).unwrap();
    s.commit(tx(Some(None), b"p2")).unwrap();
    assert_eq!(keyring(&s), None, "no committed generation");
    assert!(has(&secrets, &g1));
    s.commit(tx(Some(Some(b"k3")), b"p3")).unwrap();
    let g3 = generation(&s).unwrap();
    assert_ne!(g1, g3, "removal never resets to a reused name");
    assert_eq!(s.retained().unwrap(), vec![g1]);
    // An aborted removal keeps the keyring.
    s.inner().fail_commits(1);
    assert!(s.commit(tx(Some(None), b"p4")).is_err());
    assert_eq!(keyring(&s).as_deref(), Some(&b"k3"[..]));
    assert_eq!(secrets.deletes.load(SeqCst), 0);
    assert!(all_distinct(&secrets));
}

#[test]
fn a_missing_committed_generation_fails_closed() {
    let secrets = Arc::new(Flaky::default());
    let data = MemStore::new().data();
    let mut s = open(&data, &secrets);
    s.commit(tx(Some(Some(b"k1")), b"p1")).unwrap();
    let g = generation(&s).unwrap();
    secrets.inner.delete(&keyring_name(&C, &g)).unwrap();
    assert!(matches!(s.meta(meta_keys::KEYRING), Err(StoreError::Io(_))));
}

#[test]
fn an_index_holding_a_plaintext_keyring_is_refused() {
    let mut inner = MemStore::new();
    inner.commit(tx(Some(Some(b"leaked")), b"p")).unwrap();
    let secrets: Arc<dyn SecretStore> = Arc::new(MemoryStore::default());
    let r = KeychainKeyring::new(inner, Some(secrets), &C);
    assert!(matches!(r, Err(StoreError::Corrupt(_))));
}

#[test]
fn local_only_passes_through() {
    let mut s = KeychainKeyring::new(MemStore::new(), None, &C).unwrap();
    s.commit(tx(Some(Some(b"k")), b"p")).unwrap();
    assert_eq!(
        s.inner().meta(meta_keys::KEYRING).unwrap().as_deref(),
        Some(&b"k"[..])
    );
}

/// The wrapper is transparent for everything but the keyring: the native store's
/// attachment-v1 disk operations and query index reach the replica through it
/// (the trait defaults would silently disable attachment ingest).
#[test]
fn attachments_and_the_query_index_pass_through() {
    use std::cell::RefCell;
    use std::rc::Rc;

    use mdbn_platform_native::{NativePlatform, OpenOptions, SqliteIndex};
    use mdbn_store_file::diskdb::SqlDiskDb;
    use mdbn_store_file::index::IndexDurability;
    use mdbn_store_file::{Config as FsConfig, FileStore, SqlStore, SqlStoreLimits};

    struct Clock;
    impl mdbn_core::host::Clock for Clock {
        fn now_ms(&self) -> u64 {
            1_700_000_000_000
        }
    }
    let dir = crate::testutil::TestDir::new("keyring-att");
    let root = dir.path().join("folder");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("photo.bin"), [7u8; 4096]).unwrap();
    let platform = Rc::new(NativePlatform::open(&root, &OpenOptions::default()).unwrap());
    let index = Rc::new(RefCell::new(
        SqliteIndex::open(dir.path().join("index.sqlite"), IndexDurability::Durable).unwrap(),
    ));
    let inner = SqlStore::open_with_limits(index.clone(), SqlStoreLimits::DESKTOP).unwrap();
    let db = SqlDiskDb::open(index).unwrap();
    let store = FileStore::open(platform, inner, db, Box::new(Clock), FsConfig::default()).unwrap();
    let (materializes, indexed, projection) = (
        store.materializes_attachments(),
        store.query_index_supported(),
        store.query_projection_state().unwrap(),
    );
    assert!(materializes, "the native store materializes attachments");
    let state = projection
        .clone()
        .expect("the native store has a raw projection");
    let mut s = KeychainKeyring::new(store, None, &C).unwrap();
    assert_eq!(s.materializes_attachments(), materializes);
    assert_eq!(s.query_index_supported(), indexed);
    // Bases views read the raw projection (#1130).
    assert_eq!(s.query_projection_state().unwrap(), projection);
    let request = mdbn_replica::store_query::QueryProjectionRequest {
        generation: state.generation,
        head: state.head,
        predicate: mdbn_replica::store_query::QueryPredicate::All,
        bases_candidate: None,
        bases_records: None,
        after: None,
        limit: 1,
        max_bytes: 4096,
        fields: Vec::new(),
        tags: false,
        full_frontmatter: false,
    };
    assert_eq!(
        format!("{:?}", s.query_projection_page(&request)),
        format!("{:?}", s.inner.query_projection_page(&request)),
    );
    let source = s.attachment_source("photo.bin", 4096).unwrap();
    assert_eq!(source.map(|src| src.len()), Some(4096));
}

/// Real keyring-wrapped desktop daemon composition
/// (`KeychainKeyring<FileStore<NativePlatform, SqlStore<SqliteIndex>, SqlDiskDb<SqliteIndex>>>`):
/// - Non-keyring-mutating control items (`Policy`, other-device `KeyGrant`)
///   batch inside the deferred-durability window without writing the keychain.
/// - Keyring-mutating control items (`Rekey`) close any prior window before
///   writing the OS keychain, and never add empty `BEGIN IMMEDIATE`/`COMMIT`
///   barriers before standalone commits.
/// - Bare `SqlStore<SqliteIndex>` wrapped in `KeychainKeyring` reports
///   `durability_deferred()` truthfully and closes its window before writing
///   the OS keychain.
#[test]
fn daemon_keyring_composition_batches_control_items_without_empty_barriers() {
    use std::cell::{Cell, RefCell};
    use std::rc::Rc;
    use std::sync::atomic::AtomicU64;

    use mdbn_platform_native::{NativePlatform, OpenOptions, SqliteIndex};
    use mdbn_replica::log::{EndpointId, LogClient};
    use mdbn_replica::{DeviceSecrets, Host, Replica, ReplicaConfig, UtcOnly};
    use mdbn_store_file::diskdb::SqlDiskDb;
    use mdbn_store_file::index::{
        Batch, BatchMode, BorrowedBlob, IndexDurability, IndexError, IndexInfo, IndexStorage,
        StmtResult,
    };
    use mdbn_store_file::{Config as FsConfig, FileStore, SqlStore, SqlStoreLimits};
    use mdbn_wire::client::SyncMode;
    use mdbn_wire::common::B32;
    use mdbn_wire::schema::Wire;

    const COL: B16 = B16([0x41; 16]);
    const DEV: B16 = B16([101; 16]);
    const OTHER: B16 = B16([102; 16]);
    const SIGN: [u8; 32] = [0x31; 32];
    const KEM: [u8; 32] = [0x32; 32];

    struct Clock;
    impl mdbn_core::host::Clock for Clock {
        fn now_ms(&self) -> u64 {
            1_700_000_000_000
        }
    }

    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
    struct Stats {
        alone: u64,
        in_window: u64,
        nonempty_windows: u64,
        empty_window_closes: u64,
    }
    impl Stats {
        /// Actual SQLite barriers: standalone writes + non-empty window closes.
        /// (`SqliteIndex` makes empty window closes free with zero barriers.)
        fn synced(self) -> u64 {
            self.alone + self.nonempty_windows
        }
        fn since(self, earlier: Self) -> Self {
            Self {
                alone: self.alone - earlier.alone,
                in_window: self.in_window - earlier.in_window,
                nonempty_windows: self.nonempty_windows - earlier.nonempty_windows,
                empty_window_closes: self.empty_window_closes - earlier.empty_window_closes,
            }
        }
    }

    struct CountedSqlite {
        inner: SqliteIndex,
        windows: bool,
        open: bool,
        uncommitted_in_window: Arc<AtomicU64>,
        stats: Rc<Cell<Stats>>,
    }
    impl CountedSqlite {
        fn note_batch(&mut self, batch: &Batch) {
            let reads = batch.stmts.iter().all(|s| {
                let head = s.sql.trim_start().to_ascii_lowercase();
                head.starts_with("select") || head.starts_with("with")
            });
            if reads {
                return;
            }
            let mut st = self.stats.get();
            if self.open {
                assert_eq!(batch.mode, BatchMode::Transaction);
                st.in_window += 1;
                self.uncommitted_in_window.fetch_add(1, SeqCst);
            } else {
                st.alone += 1;
            }
            self.stats.set(st);
        }
    }
    impl IndexStorage for CountedSqlite {
        fn info(&self) -> IndexInfo {
            self.inner.info()
        }
        fn run(&mut self, batch: &Batch) -> Result<Vec<StmtResult>, IndexError> {
            self.note_batch(batch);
            self.inner.run(batch)
        }
        fn run_with_borrowed_blob(
            &mut self,
            batch: &Batch,
            blob: BorrowedBlob<'_>,
        ) -> Result<Vec<StmtResult>, IndexError> {
            self.note_batch(batch);
            self.inner.run_with_borrowed_blob(batch, blob)
        }
        fn reset(&mut self) -> Result<(), IndexError> {
            self.inner.reset()
        }
        fn defer_sync(&mut self, on: bool) -> Result<bool, IndexError> {
            if !self.windows {
                return Ok(false);
            }
            let deferring = self.inner.defer_sync(on)?;
            assert!(deferring, "durable SqliteIndex must support windows");
            if self.open && !on {
                let mut st = self.stats.get();
                if self.uncommitted_in_window.swap(0, SeqCst) > 0 {
                    st.nonempty_windows += 1;
                } else {
                    st.empty_window_closes += 1;
                }
                self.stats.set(st);
            }
            self.open = on;
            Ok(true)
        }
    }

    /// SecretStore that asserts every keychain write happens strictly after
    /// durable SQLite state (zero uncommitted writes in any open window).
    struct CheckedSecrets {
        inner: MemoryStore,
        uncommitted_in_window: Arc<AtomicU64>,
        writes: AtomicU64,
    }
    impl SecretStore for CheckedSecrets {
        fn get(&self, n: &str) -> Result<Option<zeroize::Zeroizing<Vec<u8>>>, SecretError> {
            self.inner.get(n)
        }
        fn set(&self, n: &str, v: &[u8]) -> Result<(), SecretError> {
            assert_eq!(
                self.uncommitted_in_window.load(SeqCst),
                0,
                "keychain write must never happen while uncommitted writes sit in an open window"
            );
            self.writes.fetch_add(1, SeqCst);
            self.inner.set(n, v)
        }
        fn delete(&self, n: &str) -> Result<(), SecretError> {
            self.inner.delete(n)
        }
        fn backend(&self) -> &'static str {
            "checked"
        }
    }

    fn open_replica<S: Store>(store: S) -> Replica<S> {
        Replica::open(
            ReplicaConfig {
                collection: COL,
                device_id: DEV,
                replica_id: B16([2; 16]),
                mode: SyncMode::Synced,
                log_endpoint: EndpointId(1),
                verify: true,
                runtime_version: "daemon-keyring-window-test".into(),
                trusted_roots: vec![mdbn_replica::testkit::signed_root()],
                trusted_signers: vec![],
                e2e: false,
                user_enabled_cloud_copy: false,
                chosen_state: None,
                expected_genesis: None,
                key_grants_only: false,
                policy_pins: None,
            },
            store,
            Box::new(mdbn_replica::plan::CorePlanner),
            Box::new(mdbn_replica::seal::KeyringSealer::new(
                COL, DEV, &SIGN, &KEM,
            )),
            Host {
                clock: Box::new(Clock),
                entropy: Box::new(mdbn_replica::crypto::TestEntropy::new(2)),
                zones: Box::new(UtcOnly),
            },
            DeviceSecrets {
                sign_sk: SIGN,
                kem_sk: KEM,
            },
        )
        .unwrap()
    }

    fn settle<S: Store>(r: &mut Replica<S>, client: &mut dyn LogClient) {
        for _ in 0..40 {
            mdbn_replica::log::pump(r, client, 200);
            r.tick();
        }
    }

    // Part A: Control-only page with genesis Policy, initial Rekey, 20
    // DeviceEnrol Policy items, and a KeyGrant for another device.
    let svc = mdbn_replica::fake::FakeLogService::new();
    let mut cp = mdbn_replica::testkit::TestControlPlane::signed(COL);
    cp.genesis_with_keys(&svc, mdbn_wire::policy::CState::E2e, DEV, &SIGN, &KEM);
    cp.append(
        &svc,
        vec![mdbn_wire::policy::PolicyOp::DeviceEnrol(
            mdbn_wire::policy::DeviceEnrol {
                device: OTHER,
                account: mdbn_replica::testkit::TEST_OWNER,
                kind: mdbn_wire::policy::DeviceKind::Desktop,
                sign_pk: B32([0x51; 32]),
                kem_pk: B32(mdbn_replica::crypto::hpke::KemKeyPair::from_secret(&[0x52; 32]).pk),
                noise_pk: B32([0x53; 32]),
                sas_commit: None,
                local_root: None,
            },
        )],
    );
    let mut writer = open_replica(MemStore::new());
    let mut writer_client = svc.client(DEV);
    settle(&mut writer, &mut writer_client);
    // Append a KeyGrant for OTHER (does not change DEV's keyring).
    let writer_keys = writer.testing_epoch_keys();
    let epoch1_key = writer_keys
        .iter()
        .find(|(e, _)| *e == 1)
        .map(|(_, k)| **k)
        .unwrap();
    let mut kg_rng = mdbn_replica::crypto::TestEntropy::new(77);
    let other_kem_pk = mdbn_replica::crypto::hpke::KemKeyPair::from_secret(&[0x52; 32]).pk;
    let kg_payload = mdbn_replica::crypto::keys::build_key_grant(
        &COL,
        1,
        &mdbn_replica::crypto::Secret32(epoch1_key),
        &mdbn_replica::crypto::keys::Recipient {
            device: OTHER,
            kem_pk: other_kem_pk,
        },
        &mut kg_rng,
    )
    .unwrap();
    let mut kg_item = mdbn_wire::envelope::Item {
        kind: mdbn_wire::envelope::ItemKind::KeyGrant,
        collection: COL,
        seq: Some(svc.head(&COL).0 + 1),
        prev: Some(svc.head(&COL).1),
        epoch: None,
        signer: Some(DEV),
        salt: None,
        idem: None,
        refs: None,
        stream: None,
        body: mdbn_wire::common::Bytes(kg_payload.to_bytes().unwrap()),
        sig: None,
    };
    mdbn_replica::crypto::sign::DeviceSigner::from_seed(&SIGN)
        .sign_item(&mut kg_item)
        .unwrap();
    svc.push_raw(&COL, kg_item.to_bytes().unwrap());
    for b in 1..=20u8 {
        cp.append(
            &svc,
            vec![mdbn_wire::policy::PolicyOp::DeviceEnrol(
                mdbn_wire::policy::DeviceEnrol {
                    device: B16([b.wrapping_add(120); 16]),
                    account: mdbn_replica::testkit::TEST_OWNER,
                    kind: mdbn_wire::policy::DeviceKind::Desktop,
                    sign_pk: B32([b; 32]),
                    kem_pk: B32([b.wrapping_add(1); 32]),
                    noise_pk: B32([b.wrapping_add(2); 32]),
                    sas_commit: None,
                    local_root: None,
                },
            )],
        );
    }
    let head_a = svc.head(&COL).0;
    assert_eq!(head_a, 24);

    let run_daemon = |tag: &str,
                      svc: &mdbn_replica::fake::FakeLogService,
                      expected_head: u64,
                      windows: bool|
     -> (Stats, u64) {
        let dir = crate::testutil::TestDir::new(tag);
        let root = dir.path().join("folder");
        std::fs::create_dir_all(&root).unwrap();
        let platform = Rc::new(NativePlatform::open(&root, &OpenOptions::default()).unwrap());
        let uncommitted = Arc::new(AtomicU64::new(0));
        let stats = Rc::new(Cell::new(Stats::default()));
        let index = Rc::new(RefCell::new(CountedSqlite {
            inner: SqliteIndex::open(dir.path().join("index.sqlite"), IndexDurability::Durable)
                .unwrap(),
            windows,
            open: false,
            uncommitted_in_window: uncommitted.clone(),
            stats: stats.clone(),
        }));
        let sql = SqlStore::open_with_limits(index.clone(), SqlStoreLimits::DESKTOP).unwrap();
        let db = SqlDiskDb::open(index).unwrap();
        let fs_store =
            FileStore::open(platform, sql, db, Box::new(Clock), FsConfig::default()).unwrap();
        let checked = Arc::new(CheckedSecrets {
            inner: MemoryStore::default(),
            uncommitted_in_window: uncommitted,
            writes: AtomicU64::new(0),
        });
        let secrets: Arc<dyn SecretStore> = checked.clone();
        let store = KeychainKeyring::new(fs_store, Some(secrets.clone()), &COL).unwrap();
        let mut reader = open_replica(store);
        let opened = stats.get();
        let mut client = svc.client(DEV);
        settle(&mut reader, &mut client);
        assert_eq!(reader.head().seq, expected_head);
        assert!(!reader.requires_reopen());
        assert!(!reader.store().durability_deferred());
        let expected_keys: Vec<_> = reader
            .testing_epoch_keys()
            .into_iter()
            .map(|(e, k)| (e, *k))
            .collect();
        let delta = stats.get().since(opened);
        let keyring_writes = checked.writes.load(SeqCst);
        drop(reader);

        // Reopen from disk + keychain to verify durability of head and keyring.
        let platform2 = Rc::new(NativePlatform::open(&root, &OpenOptions::default()).unwrap());
        let index2 = Rc::new(RefCell::new(
            SqliteIndex::open(dir.path().join("index.sqlite"), IndexDurability::Durable).unwrap(),
        ));
        let sql2 = SqlStore::open_with_limits(index2.clone(), SqlStoreLimits::DESKTOP).unwrap();
        let db2 = SqlDiskDb::open(index2).unwrap();
        let fs2 =
            FileStore::open(platform2, sql2, db2, Box::new(Clock), FsConfig::default()).unwrap();
        let store2 = KeychainKeyring::new(fs2, Some(secrets), &COL).unwrap();
        let reopened = open_replica(store2);
        assert_eq!(reopened.head().seq, expected_head);
        let reopened_keys: Vec<_> = reopened
            .testing_epoch_keys()
            .into_iter()
            .map(|(e, k)| (e, *k))
            .collect();
        assert_eq!(reopened_keys, expected_keys);
        (delta, keyring_writes)
    };

    let (off_a, kw_off_a) = run_daemon("keyring-ctl-off", &svc, head_a, false);
    let (on_a, kw_on_a) = run_daemon("keyring-ctl-on", &svc, head_a, true);
    assert_eq!(kw_off_a, 1, "only the initial Rekey mutates the keyring");
    assert_eq!(kw_on_a, 1, "only the initial Rekey mutates the keyring");
    assert_eq!(off_a.in_window, 0);
    assert_eq!(
        on_a.in_window,
        head_a - 1,
        "all {} non-keyring control items batch in windows: {on_a:?}",
        head_a - 1
    );
    assert_eq!(
        on_a.empty_window_closes, 0,
        "no empty window closes on control page: {on_a:?}"
    );
    assert_eq!(on_a.in_window, off_a.alone - on_a.alone);
    assert!(
        on_a.synced() < off_a.synced(),
        "windows must cut synced commits on desktop daemon: off={off_a:?} on={on_a:?}"
    );

    // Part B: Consecutive keyring-mutating items (multiple Rekeys) in one page:
    // desktop must never pay an extra empty barrier before each standalone commit.
    let svc_b = mdbn_replica::fake::FakeLogService::new();
    let mut cp_b = mdbn_replica::testkit::TestControlPlane::signed(COL);
    cp_b.genesis_with_keys(&svc_b, mdbn_wire::policy::CState::E2e, DEV, &SIGN, &KEM);
    for b in 1..=4u8 {
        let victim = B16([b.wrapping_add(150); 16]);
        cp_b.append(
            &svc_b,
            vec![mdbn_wire::policy::PolicyOp::DeviceEnrol(
                mdbn_wire::policy::DeviceEnrol {
                    device: victim,
                    account: mdbn_replica::testkit::TEST_OWNER,
                    kind: mdbn_wire::policy::DeviceKind::Desktop,
                    sign_pk: B32([b; 32]),
                    kem_pk: B32([b.wrapping_add(1); 32]),
                    noise_pk: B32([b.wrapping_add(2); 32]),
                    sas_commit: None,
                    local_root: None,
                },
            )],
        );
    }
    let mut writer_b = open_replica(MemStore::new());
    let mut writer_b_client = svc_b.client(DEV);
    settle(&mut writer_b, &mut writer_b_client);
    for b in 1..=4u8 {
        cp_b.revoke(&svc_b, B16([b.wrapping_add(150); 16]));
        settle(&mut writer_b, &mut writer_b_client);
    }
    let head_b = svc_b.head(&COL).0;
    let (off_b, kw_off_b) = run_daemon("keyring-rekeys-off", &svc_b, head_b, false);
    let (on_b, kw_on_b) = run_daemon("keyring-rekeys-on", &svc_b, head_b, true);
    assert!(kw_on_b >= 2, "expected multiple Rekeys, got {kw_on_b}");
    assert_eq!(kw_off_b, kw_on_b);
    assert!(
        on_b.synced() <= off_b.synced(),
        "windows must never add barriers over standalone commits: off={off_b:?} on={on_b:?}"
    );

    // Part C: KeychainKeyring over bare SqlStore<SqliteIndex> closes an open
    // deferred window before writing to the OS keychain (requires truthful
    // SqlStore::durability_deferred()).
    let dir_c = crate::testutil::TestDir::new("keyring-bare-sql");
    let uncommitted_c = Arc::new(AtomicU64::new(0));
    let stats_c = Rc::new(Cell::new(Stats::default()));
    let index_c = Rc::new(RefCell::new(CountedSqlite {
        inner: SqliteIndex::open(dir_c.path().join("bare.sqlite"), IndexDurability::Durable)
            .unwrap(),
        windows: true,
        open: false,
        uncommitted_in_window: uncommitted_c.clone(),
        stats: stats_c.clone(),
    }));
    let bare_sql = SqlStore::open_with_limits(index_c, SqlStoreLimits::DESKTOP).unwrap();
    let checked_c = Arc::new(CheckedSecrets {
        inner: MemoryStore::default(),
        uncommitted_in_window: uncommitted_c.clone(),
        writes: AtomicU64::new(0),
    });
    let secrets_c: Arc<dyn SecretStore> = checked_c.clone();
    let mut wrapped = KeychainKeyring::new(bare_sql, Some(secrets_c), &COL).unwrap();
    wrapped.defer_durability(true).unwrap();
    assert!(
        wrapped.durability_deferred(),
        "bare SqlStore must report durability_deferred() == true"
    );
    wrapped.commit(tx(None, b"p1")).unwrap();
    assert_eq!(
        uncommitted_c.load(SeqCst),
        1,
        "non-keyring commit stays uncommitted inside the open window"
    );
    // CheckedSecrets::set asserts uncommitted_c == 0, proving KeychainKeyring
    // closed the bare SqlStore's window BEFORE writing to the OS keychain.
    wrapped.commit(tx(Some(Some(b"k1")), b"p2")).unwrap();
    assert!(!wrapped.durability_deferred());
    assert_eq!(uncommitted_c.load(SeqCst), 0);
    assert_eq!(checked_c.writes.load(SeqCst), 1);
    assert_eq!(stats_c.get().nonempty_windows, 1);
}
