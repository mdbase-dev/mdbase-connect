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
    let (materializes, indexed) = (
        store.materializes_attachments(),
        store.query_index_supported(),
    );
    assert!(materializes, "the native store materializes attachments");
    let mut s = KeychainKeyring::new(store, None, &C).unwrap();
    assert_eq!(s.materializes_attachments(), materializes);
    assert_eq!(s.query_index_supported(), indexed);
    let source = s.attachment_source("photo.bin", 4096).unwrap();
    assert_eq!(source.map(|src| src.len()), Some(4096));
}
