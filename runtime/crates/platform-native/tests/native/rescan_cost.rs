//! What a no-change rescan and a warm open cost per file, as counts.
//!
//! Timing a scan depends on the machine; these are the SQL statements,
//! directory opens, `fstatat` calls and document reads of the shipped
//! composition (replica over `FileStore`, `SqlStore` on real SQLite and the
//! real file system), taken at two collection sizes with the same folders. The
//! difference between the sizes is the cost of one more file, free of whatever
//! an open or a pass costs once.
//!
//! Per file added, notes two folders down:
//!
//! | | SQL statements | directory opens | `fstatat` | files read |
//! |---|---|---|---|---|
//! | rescan, a `stat` per file | 1 (admission fence) | 3 | 1 | 0 |
//! | rescan, metadata from the listing | 0 | 0 | 1 | 0 |
//! | warm open, a `stat` per file | 3 (fence, two record reads) | 3 | 1 | 0 |
//! | warm open, metadata from the listing | 1 per 1024 records | 0 | 1 | 0 |
use super::*;
use mdbn_store_file::index::{BorrowedBlob, IndexError, IndexInfo, StmtResult};
use mdbn_store_file::{
    SqlStore,
    testing::{replica as r, wire as w},
};
use r::mirror_admission::META;
use r::{DeviceSecrets, Host, Replica, ReplicaConfig, UtcOnly};
use std::collections::BTreeMap;
use w::common::B16;

const COL: B16 = B16([7; 16]);
const DEV: B16 = B16([101; 16]);
/// Every note is two folders down: resolving one path opens the root and both.
const FOLDERS: [&str; 4] = ["a/x", "a/y", "b/x", "b/y"];

/// SQL statements by text; the admission fence's read is keyed apart from
/// other metadata reads.
type Statements = Rc<RefCell<BTreeMap<String, u64>>>;

struct Counted {
    inner: SqliteIndex,
    statements: Statements,
}
impl IndexStorage for Counted {
    fn info(&self) -> IndexInfo {
        self.inner.info()
    }
    fn run(&mut self, batch: &Batch) -> Result<Vec<StmtResult>, IndexError> {
        let mut statements = self.statements.borrow_mut();
        for s in &batch.stmts {
            let fence = s.sql == "SELECT v FROM st_meta WHERE k = ?"
                && s.params.first() == Some(&SqlValue::Text(META.into()));
            let key = if fence { FENCE } else { s.sql.as_str() };
            *statements.entry(key.to_string()).or_default() += 1;
        }
        drop(statements);
        self.inner.run(batch)
    }
    fn run_with_borrowed_blob(
        &mut self,
        batch: &Batch,
        blob: BorrowedBlob<'_>,
    ) -> Result<Vec<StmtResult>, IndexError> {
        self.inner.run_with_borrowed_blob(batch, blob)
    }
    fn reset(&mut self) -> Result<(), IndexError> {
        self.inner.reset()
    }
    fn defer_sync(&mut self, on: bool) -> Result<bool, IndexError> {
        self.inner.defer_sync(on)
    }
}
const FENCE: &str = "admission fence read";

type DiskStore = FileStore<NativePlatform, SqlStore<Counted>, SqlDiskDb<Counted>>;

/// One measured step.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Cost {
    /// Every SQL statement.
    statements: u64,
    /// Of those, reads of the admission fence.
    fence_reads: u64,
    /// Of those, reads of one record by ID.
    record_point_reads: u64,
    dir_opens: u64,
    stats: u64,
    file_opens: u64,
    /// Documents read and hashed by the file store.
    files_read: u64,
}

struct Probe {
    statements: Statements,
    clock: WallClock,
    dir: PathBuf,
}
impl Probe {
    fn open(&self) -> Replica<DiskStore> {
        let idx = Rc::new(RefCell::new(Counted {
            inner: SqliteIndex::open(self.dir.join("state.db"), IndexDurability::Durable).unwrap(),
            statements: self.statements.clone(),
        }));
        let inner = SqlStore::open(idx.clone()).unwrap();
        let store = FileStore::open(
            Rc::new(platform(&self.dir.join("vault"))),
            inner,
            SqlDiskDb::open(idx).unwrap(),
            Box::new(self.clock.clone()),
            mdbn_store_file::Config::default(),
        )
        .unwrap();
        Replica::open(
            ReplicaConfig {
                collection: COL,
                device_id: DEV,
                replica_id: B16([2; 16]),
                mode: w::client::SyncMode::LocalOnly,
                log_endpoint: r::log::EndpointId(0),
                verify: false,
                runtime_version: "rescan-cost-test".into(),
                trusted_roots: Vec::new(),
                trusted_signers: vec![DEV],
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
                clock: Box::new(self.clock.clone()),
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

    /// The counters now: SQL since the last [`Probe::reset`], the platform's
    /// and the store's since `rep` was opened.
    fn cost(&self, rep: &Replica<DiskStore>) -> Cost {
        let statements = self.statements.borrow();
        let sys = rep.store().platform().syscalls();
        Cost {
            statements: statements.values().sum(),
            fence_reads: statements.get(FENCE).copied().unwrap_or(0),
            record_point_reads: statements
                .iter()
                .filter(|(sql, _)| sql.as_str() == "SELECT row FROM st_rec WHERE id = ?")
                .map(|(_, n)| n)
                .sum(),
            dir_opens: sys.dir_opens,
            stats: sys.stats,
            file_opens: sys.file_opens,
            files_read: rep.store().stats.files_read,
        }
    }

    fn reset(&self) {
        self.statements.borrow_mut().clear();
    }
}

impl std::ops::Sub for Cost {
    type Output = Cost;
    fn sub(self, o: Cost) -> Cost {
        Cost {
            statements: self.statements - o.statements,
            fence_reads: self.fence_reads - o.fence_reads,
            record_point_reads: self.record_point_reads - o.record_point_reads,
            dir_opens: self.dir_opens - o.dir_opens,
            stats: self.stats - o.stats,
            file_opens: self.file_opens - o.file_opens,
            files_read: self.files_read - o.files_read,
        }
    }
}

/// Ingest a folder of `per_folder` notes in each of [`FOLDERS`], then measure
/// one no-change rescan and one warm open (store open, replica open, first
/// scan) of it.
fn measure(tag: &str, per_folder: usize) -> (Cost, Cost) {
    let dir = scratch(tag);
    let vault = dir.join("vault");
    for folder in FOLDERS {
        fs::create_dir_all(vault.join(folder)).unwrap();
        for i in 0..per_folder {
            fs::write(
                vault.join(folder).join(format!("note-{i:04}.md")),
                format!("---\ntitle: {folder} {i}\n---\nBody of {folder} {i}.\n"),
            )
            .unwrap();
        }
    }
    let files = (FOLDERS.len() * per_folder) as u64;
    let probe = Probe {
        statements: Statements::default(),
        clock: WallClock::default(),
        dir,
    };
    probe.clock.0.set(1_700_000_000_000);
    let mut rep = probe.open();
    for _ in 0..64 {
        if rep.store().record_count().unwrap() == files {
            break;
        }
        rep.store_mut().request_rescan();
        rep.observe(None).unwrap();
        rep.tick();
        probe.clock.0.set(probe.clock.0.get() + 5_000);
    }
    assert_eq!(rep.store().record_count().unwrap(), files);
    // Let every timer of the first ingest run down: the measured pass must be
    // a rescan of a folder nothing is happening in.
    for _ in 0..4 {
        probe.clock.0.set(probe.clock.0.get() + 5_000);
        rep.store_mut().request_rescan();
        rep.observe(None).unwrap();
        rep.tick();
    }

    probe.reset();
    let before = probe.cost(&rep);
    rep.store_mut().request_rescan();
    rep.observe(None).unwrap();
    let rescan = probe.cost(&rep) - before;
    assert_eq!(rep.store().record_count().unwrap(), files);

    drop(rep);
    probe.reset();
    let mut rep = probe.open();
    rep.observe(None).unwrap();
    let warm = probe.cost(&rep);
    assert_eq!(rep.store().record_count().unwrap(), files);
    for folder in FOLDERS {
        assert_eq!(
            fs::read_to_string(vault.join(folder).join("note-0000.md")).unwrap(),
            format!("---\ntitle: {folder} 0\n---\nBody of {folder} 0.\n"),
            "a warm open leaves an unchanged file alone"
        );
    }
    drop(rep);
    fs::remove_dir_all(&probe.dir).unwrap();
    (rescan, warm)
}

#[cfg(unix)]
#[test]
fn a_no_change_rescan_and_a_warm_open_cost_one_stat_per_file() {
    const SMALL: usize = 40;
    const LARGE: usize = 340;
    let added = (FOLDERS.len() * (LARGE - SMALL)) as u64;
    let (rescan_small, warm_small) = measure("rescan-cost-small", SMALL);
    let (rescan_large, warm_large) = measure("rescan-cost-large", LARGE);
    // Shown with `--nocapture`.
    eprintln!(
        "rescan: {SMALL} per folder {rescan_small:?}\n        {LARGE} per folder {rescan_large:?}"
    );
    eprintln!(
        "warm open: {SMALL} per folder {warm_small:?}\n           {LARGE} per folder {warm_large:?}"
    );

    // One more unchanged file costs a rescan one `fstatat` through the handle
    // its folder is listed with: no statement, no path resolution, no read.
    assert_eq!(
        rescan_large - rescan_small,
        Cost {
            stats: added,
            ..Cost::default()
        },
        "rescan of {SMALL} per folder {rescan_small:?}, of {LARGE} {rescan_large:?}"
    );
    // The admission fence is still read before every platform operation of a
    // pass: there is one per folder listed, not one per file.
    assert!(rescan_small.fence_reads >= FOLDERS.len() as u64);

    // A warm open reads the records in pages to compare them with what the
    // folder was last known to hold, then scans as above.
    let warm = warm_large - warm_small;
    assert_eq!(
        Cost {
            statements: 0,
            ..warm
        },
        Cost {
            stats: added,
            ..Cost::default()
        },
        "warm open of {SMALL} per folder {warm_small:?}, of {LARGE} {warm_large:?}"
    );
    assert!(
        warm.statements <= added / 256,
        "{} statements for {added} more records",
        warm.statements
    );
}
