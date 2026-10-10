//! Real exclusive-index admission before native platform/file-store constructors.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]
use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use mdbn_local_host::{Error, HostLock, StoreOptions, SystemClock, open_store};
use mdbn_platform_native::SqliteIndex;
use mdbn_replica::mirror_admission::{Fence, META};
use mdbn_store_file::SqlStore;
use mdbn_store_file::index::{Batch, BatchMode, IndexDurability, IndexStorage, SqlValue, Stmt};

fn directory(tag: &str) -> PathBuf {
    let p = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
        .join("guarded-open")
        .join(tag);
    let _ = std::fs::remove_dir_all(&p);
    std::fs::create_dir_all(&p).unwrap();
    p
}
fn listing(root: &Path) -> Vec<(PathBuf, Option<Vec<u8>>)> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(root).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            out.push((path.clone(), None));
            out.extend(listing(&path));
        } else {
            out.push((path.clone(), Some(std::fs::read(&path).unwrap())));
        }
    }
    out.sort();
    out
}
#[test]
fn closed_admission_refuses_before_native_probe_dirs_and_file_store_database_io() {
    for (tag, marker) in [
        ("joining", Fence::new([1; 16], 3).unwrap().encode().unwrap()),
        (
            "detached",
            Fence::new([1; 16], 3).unwrap().detached().encode().unwrap(),
        ),
        ("future", vec![0x81, 2]),
        ("malformed", vec![0]),
    ] {
        let dir = directory(tag);
        let root = dir.join("user-folder");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("note.md"), b"unacknowledged outside edit\n").unwrap();
        let opts = StoreOptions {
            state_dir: Some(dir.join("private-state")),
            ..StoreOptions::default()
        };
        std::fs::create_dir_all(opts.state_dir(&root)).unwrap();
        {
            let index = Rc::new(RefCell::new(
                SqliteIndex::open(opts.index_path(&root), IndexDurability::Durable).unwrap(),
            ));
            let _inner = SqlStore::open_with_limits(index.clone(), opts.limits).unwrap();
            index
                .borrow_mut()
                .run(&Batch {
                    mode: BatchMode::Transaction,
                    stmts: vec![Stmt::new(
                        "INSERT INTO st_meta(k,v) VALUES(?,?)",
                        vec![SqlValue::Text(META.into()), SqlValue::Blob(marker.clone())],
                    )],
                })
                .unwrap();
        }
        // Preserve actual caller host-lock ordering. Its permitted lock metadata
        // is part of the baseline; neither constructor may add or change anything.
        let _host = HostLock::try_acquire(&root, &opts.private_dir, None).unwrap();
        let before = listing(&root);
        let error = open_store(&root, &opts, Box::new(SystemClock))
            .err()
            .expect("closed opener");
        assert!(matches!(error, Error::Store(_)), "{error:?}");
        assert_eq!(
            listing(&root),
            before,
            "NativePlatform probe/nosync/private dirs must not run"
        );
        let mut index =
            SqliteIndex::open(opts.index_path(&root), IndexDurability::Durable).unwrap();
        let reports = index.run(&Batch { mode: BatchMode::Autocommit, stmts: vec![
            Stmt::new("SELECT v FROM st_meta WHERE k=?", vec![SqlValue::Text(META.into())]),
            Stmt::new("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('fs_state','fs_seen')", vec![]),
        ] }).unwrap();
        assert_eq!(reports[0].values, vec![SqlValue::Blob(marker)]);
        assert!(
            reports[1].values.is_empty(),
            "SqlDiskDb/FileStore constructors must not run"
        );
    }
}
#[test]
fn active_store_keeps_the_same_exclusive_index_through_native_open_and_lifetime() {
    let dir = directory("exclusive-lifetime");
    let root = dir.join("user-folder");
    std::fs::create_dir_all(&root).unwrap();
    let opts = StoreOptions {
        state_dir: Some(dir.join("private-state")),
        ..StoreOptions::default()
    };
    let _host = HostLock::try_acquire(&root, &opts.private_dir, None).unwrap();
    let store = open_store(&root, &opts, Box::new(SystemClock)).unwrap();
    let error = SqliteIndex::open(opts.index_path(&root), IndexDurability::Durable)
        .err()
        .expect("exclusive index");
    assert_eq!(error.kind, mdbn_store_file::index::IndexErrorKind::Busy);
    drop(store);
    SqliteIndex::open(opts.index_path(&root), IndexDurability::Durable).unwrap();
}
