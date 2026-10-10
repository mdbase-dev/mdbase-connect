//! Real-filesystem tests: the portable publish protocol, the file store and
//! SQLite storage on this machine's file system (ext4 on Linux CI, APFS on the
//! macOS runner). Directories live under `CARGO_TARGET_TMPDIR`, never `/tmp`.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

#[path = "native/file_reopen.rs"]
mod file_reopen;
#[path = "native/mirror_candidate.rs"]
mod mirror_candidate;
#[path = "native/native_activation.rs"]
mod native_activation;
#[path = "native/native_snapshot.rs"]
mod native_snapshot;
#[path = "native/query_differential.rs"]
mod query_differential;
#[path = "native/resource_list.rs"]
mod resource_list;
#[path = "native/sql_content.rs"]
mod sql_content;
#[path = "native/sql_faults.rs"]
mod sql_faults;
#[path = "native/sql_fields.rs"]
mod sql_fields;
#[path = "native/sql_query.rs"]
mod sql_query;
#[path = "native/sql_tail.rs"]
mod sql_tail;

use std::cell::{Cell, RefCell};
use std::fs;
use std::path::PathBuf;
use std::rc::Rc;

use mdbn_core::host::Clock;
use mdbn_platform_native::{NativePlatform, OpenOptions, SqliteIndex, SqliteJournal};
use mdbn_store_file::diskdb::SqlDiskDb;
use mdbn_store_file::exec::{Timers, run_ready};
use mdbn_store_file::index::{
    Batch, BatchMode, IndexDurability, IndexErrorKind, IndexStorage, OpenState, SqlValue, Stmt,
};
use mdbn_store_file::journal::{Journal, JournalEntry, Space};
use mdbn_store_file::platform::{FilePlatform, RelPath, ReplaceStrategy};
use mdbn_store_file::publish::{Expect, Names, Options, Outcome, PublishOp, publish, revision};
use mdbn_store_file::stash::{Settled, settle};
use mdbn_store_file::testing::replica::mem::{MemData, MemStore};
use mdbn_store_file::testing::replica::store::{
    AttachmentClass, Content, Expect as RExpect, Observed, Publish, Store, Tx,
};
use mdbn_store_file::{Config, FileStore};

fn scratch(name: &str) -> PathBuf {
    let d = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
        .join("native-tests")
        .join(name);
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

fn rp(s: &str) -> RelPath {
    RelPath::new(s).unwrap()
}

fn platform(dir: &std::path::Path) -> NativePlatform {
    NativePlatform::open(dir, &OpenOptions::default()).unwrap()
}

fn go<P: FilePlatform>(p: &P, op: &PublishOp, n: u64) -> Outcome {
    go_with(p, op, n, &Options::default())
}

fn go_with<P: FilePlatform>(p: &P, op: &PublishOp, n: u64, opts: &Options) -> Outcome {
    let t = Timers::default();
    for d in Names::dirs(&p.capabilities().private_dir) {
        run_ready(&t, p.create_dir_all(&d)).unwrap().unwrap();
    }
    run_ready(
        &t,
        publish(
            p,
            op,
            &Names::for_op(&p.capabilities().private_dir, n),
            opts,
        ),
    )
    .unwrap()
}

#[test]
fn retention_native_recommendation_and_diagnostics() {
    let d = scratch("retention-defaults");
    let p = platform(&d);
    assert_eq!(p.retained_nosync(), cfg!(target_os = "macos"));
    if cfg!(target_os = "macos") {
        assert_eq!(
            p.release_policy(),
            mdbn_store_file::ReleasePolicy::NextLaunch {
                cap_bytes: 256 << 20,
                max_age_ms: mdbn_store_file::MAX_RETENTION_AGE_MS,
            }
        );
    } else {
        assert_eq!(
            p.release_policy(),
            mdbn_store_file::ReleasePolicy::AfterRetention
        );
        assert_eq!(p.diagnostics().backup_exclusion_failures, 0);
    }
}

#[cfg(target_os = "macos")]
#[test]
fn retention_macos_sticky_backup_exclusion_is_visible_to_tmutil() {
    let d = scratch("retention-backup-exclusion");
    let p = platform(&d);
    assert_eq!(p.diagnostics().backup_exclusion_failures, 0);
    let retained = d.join(".mdbase/retained.nosync");
    assert!(retained.is_dir());
    let out = std::process::Command::new("/usr/bin/tmutil")
        .arg("isexcluded")
        .arg(&retained)
        .output()
        .unwrap();
    assert!(out.status.success());
    assert!(
        String::from_utf8(out.stdout)
            .unwrap()
            .contains("[Excluded]")
    );
}

#[test]
fn probe_reports_the_platform_strategy() {
    let d = scratch("probe");
    let p = platform(&d);
    let caps = p.capabilities();
    if cfg!(target_os = "linux") {
        assert_eq!(
            caps.replace,
            ReplaceStrategy::Exchange,
            "ext4/btrfs/xfs support RENAME_EXCHANGE"
        );
    }
    if cfg!(windows) {
        assert_eq!(caps.replace, ReplaceStrategy::LockedInPlace);
    }
    assert_eq!(caps.private_dir.as_str(), ".mdbase");
    assert!(d.join(".mdbase").is_dir());
    // The probe leaves no artifacts. macOS open deliberately creates only the
    // empty, backup-excluded retention directory; other hosts create none.
    let entries: Vec<_> = fs::read_dir(d.join(".mdbase"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    let expected = if cfg!(target_os = "macos") {
        vec![std::ffi::OsString::from("retained.nosync")]
    } else {
        Vec::new()
    };
    assert_eq!(entries, expected, "no unexpected probe artifacts");
    if cfg!(target_os = "macos") {
        let retained = d.join(".mdbase/retained.nosync");
        assert!(fs::symlink_metadata(&retained).unwrap().is_dir());
        assert_eq!(fs::read_dir(retained).unwrap().count(), 0);
    }
}

/// macOS runner only: `MDBN_READONLY_DIR` is a mounted FAT32/exFAT/HFS+
/// volume. FAT32 "succeeds" at RENAME_SWAP with a plain rename, so the
/// capability gate must make the platform read-only, and publishing refuses.
#[test]
#[ignore = "needs MDBN_READONLY_DIR on a volume without RENAME_SWAP"]
fn probe_volume_without_swap_is_read_only() {
    let dir = PathBuf::from(std::env::var_os("MDBN_READONLY_DIR").expect("MDBN_READONLY_DIR"));
    let d = dir.join("ro-probe");
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    let p = platform(&d);
    assert_eq!(p.capabilities().replace, ReplaceStrategy::ReadOnly);
    fs::write(d.join("a.md"), b"user").unwrap();
    let op = PublishOp {
        path: rp("a.md"),
        expect: Expect::Rev(revision(b"user")),
        new: Some(b"ours".to_vec()),
    };
    assert!(matches!(go(&p, &op, 1), Outcome::Failed(_)));
    assert_eq!(fs::read(d.join("a.md")).unwrap(), b"user");
}

#[test]
fn publish_replace_create_delete_and_drift() {
    let d = scratch("publish");
    let p = platform(&d);
    let strategy = p.capabilities().replace;
    let expect = |b: &[u8]| {
        if strategy == ReplaceStrategy::Exchange {
            Expect::Rev(revision(b))
        } else {
            Expect::Bytes(b.to_vec())
        }
    };
    let create = PublishOp {
        path: rp("notes/a.md"),
        expect: Expect::Absent,
        new: Some(b"one\n".to_vec()),
    };
    assert_eq!(go(&p, &create, 1), Outcome::Published { retained: None });
    assert_eq!(fs::read(d.join("notes/a.md")).unwrap(), b"one\n");
    // Create over an existing file drifts.
    assert!(matches!(go(&p, &create, 2), Outcome::Drifted { .. }));

    let replace = PublishOp {
        path: rp("notes/a.md"),
        expect: expect(b"one\n"),
        new: Some(b"two\n".to_vec()),
    };
    let o = go(&p, &replace, 3);
    assert!(matches!(o, Outcome::Published { .. }), "{o:?}");
    assert_eq!(fs::read(d.join("notes/a.md")).unwrap(), b"two\n");
    if let Outcome::Published { retained: Some(r) } = &o {
        let t = Timers::default();
        assert_eq!(run_ready(&t, settle(&p, r)).unwrap(), Settled::Released);
    }

    // The user edits; a publish expecting the old bytes must not clobber it.
    fs::write(d.join("notes/a.md"), b"user\n").unwrap();
    let o = go(&p, &replace, 4);
    assert!(matches!(o, Outcome::Drifted { .. }), "{o:?}");
    assert_eq!(fs::read(d.join("notes/a.md")).unwrap(), b"user\n");

    let del = PublishOp {
        path: rp("notes/a.md"),
        expect: expect(b"user\n"),
        new: None,
    };
    let o = go(&p, &del, 5);
    assert!(matches!(o, Outcome::Published { .. }), "{o:?}");
    assert!(!d.join("notes/a.md").exists());
}

#[cfg(unix)]
#[test]
fn metadata_is_carried_over_on_swap() {
    use std::os::unix::fs::PermissionsExt;
    let d = scratch("meta");
    let p = platform(&d);
    fs::write(d.join("a.md"), b"x").unwrap();
    fs::set_permissions(d.join("a.md"), fs::Permissions::from_mode(0o600)).unwrap();
    let op = PublishOp {
        path: rp("a.md"),
        expect: Expect::Rev(revision(b"x")),
        new: Some(b"y".to_vec()),
    };
    assert!(matches!(go(&p, &op, 1), Outcome::Published { .. }));
    let mode = fs::metadata(d.join("a.md")).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
}

#[test]
fn editor_race_oracle_requires_a_stable_namespace() {
    let d = scratch("race-oracle");
    let visible = d.join("a.md");
    let pending = d.join(".mdbase/tmp/save");
    fs::create_dir_all(pending.parent().unwrap()).unwrap();
    fs::write(&visible, "base\n").unwrap();
    fs::write(&pending, "base\ne1\n").unwrap();
    // The root has already been visited when the walk reaches this entry.
    // A publisher restore can move the only saved inode back there: the walk
    // misses it despite the bytes surviving without interruption.
    assert!(!find_anywhere_with_visit(&d, "\ne1\n", |path| {
        if path == pending {
            fs::rename(&pending, &visible).unwrap();
        }
    }));
    assert_eq!(fs::read_to_string(&visible).unwrap(), "base\ne1\n");
    assert!(find_anywhere(&d, "\ne1\n"));
}

/// An editor saving an append-only buffer (in place and by atomic rename)
/// while the publisher keeps publishing: no editor save may be lost. The
/// oracle: at every save, the previous save's last line must be at the
/// path or in a retained/held file.
#[test]
fn editor_race_loses_nothing() {
    let secs: u64 = std::env::var("MDBN_STRESS_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(3);
    let d = scratch("race");
    let p = platform(&d);
    fs::write(d.join("a.md"), b"base\n").unwrap();
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    // Only the oracle and publisher namespace mutations share this gate.
    // Editor writes remain unlocked and still race the real publish protocol.
    let snapshot = std::sync::Arc::new(std::sync::Mutex::new(()));
    let editor = {
        let d = d.clone();
        let stop = stop.clone();
        let snapshot = snapshot.clone();
        std::thread::spawn(move || {
            let mut buf = String::from("base\n");
            let mut n = 0u64;
            let mut lost = Vec::new();
            while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                n += 1;
                // Adopt what is on disk (as an editor reloads), then type.
                if let Ok(cur) = fs::read_to_string(d.join("a.md"))
                    && !cur.is_empty()
                {
                    buf = cur;
                }
                buf.push_str(&format!("e{n}\n"));
                let res = if n.is_multiple_of(2) {
                    fs::write(d.join("a.md"), &buf)
                } else {
                    let tmp = d.join(format!("a.md.tmp{n}"));
                    fs::write(&tmp, &buf).and_then(|()| fs::rename(&tmp, d.join("a.md")))
                };
                if res.is_err() {
                    n -= 1;
                    continue;
                }
                std::thread::sleep(std::time::Duration::from_micros(300));
                // A live DFS is not a snapshot: a rename into an already-
                // visited directory can be missed, and one scan can itself
                // consume the old timeout. Check every save in a quiescent
                // namespace instead; no retry or relaxed loss assertion.
                let needle = format!("\ne{n}\n");
                let _snapshot = snapshot.lock().unwrap();
                if !find_anywhere(&d, &needle) {
                    lost.push(n);
                }
            }
            (n, lost)
        })
    };
    let t = Timers::default();
    let mut retained = Vec::new();
    let mut held = Vec::new();
    let mut k = 0u64;
    let started = std::time::Instant::now();
    let (mut published, mut drifted) = (0, 0);
    while started.elapsed().as_secs() < secs {
        k += 1;
        let Ok(cur) = fs::read(d.join("a.md")) else {
            continue;
        };
        let mut new = cur.clone();
        new.extend_from_slice(format!("p{k}\n").as_bytes());
        let expect = if p.capabilities().replace == ReplaceStrategy::Exchange {
            Expect::Rev(revision(&cur))
        } else {
            Expect::Bytes(cur.clone())
        };
        let op = PublishOp {
            path: rp("a.md"),
            expect,
            new: Some(new),
        };
        // Durability is not under test here, and fsync on a loaded shared host
        // takes seconds; the protocol's ordering is the same without it.
        let fast = Options {
            sync_temp: false,
            sync_dir: false,
            ..Options::default()
        };
        let outcome = {
            let _publication = snapshot.lock().unwrap();
            go_with(&p, &op, k, &fast)
        };
        match outcome {
            Outcome::Published { retained: r } => {
                published += 1;
                retained.extend(r)
            }
            Outcome::Drifted {
                retained: r,
                preserved,
            } => {
                drifted += 1;
                retained.extend(r);
                held.extend(preserved);
            }
            _ => {}
        }
    }
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    let (saves, lost) = editor.join().unwrap();
    // Settle after the retention: late writes must not be deleted.
    std::thread::sleep(std::time::Duration::from_millis(2_100));
    let mut late = 0;
    for r in &retained {
        if run_ready(&t, settle(&p, r)).unwrap() == Settled::LateWrite {
            late += 1;
        }
    }
    eprintln!(
        "saves={saves} published={published} drifted={drifted} held={} late={late} lost={lost:?}",
        held.len()
    );
    assert!(saves > 10 && published > 3, "the race did not run");
    assert!(lost.is_empty(), "editor saves lost at runtime: {lost:?}");
    let last = format!("\ne{saves}\n");
    assert!(find_anywhere(&d, &last), "final save lost");
}

fn find_anywhere(root: &std::path::Path, needle: &str) -> bool {
    find_anywhere_with_visit(root, needle, |_| {})
}

fn find_anywhere_with_visit(
    root: &std::path::Path,
    needle: &str,
    mut before_read: impl FnMut(&std::path::Path),
) -> bool {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else {
                before_read(&p);
                if fs::read_to_string(&p).is_ok_and(|s| s.contains(needle)) {
                    return true;
                }
            }
        }
    }
    false
}

#[derive(Clone, Default)]
struct WallClock(Rc<Cell<u64>>);

impl Clock for WallClock {
    fn now_ms(&self) -> u64 {
        self.0.get()
    }
}

#[cfg(unix)]
#[test]
fn retention_real_editor_handle_survives_same_launch_and_late_bytes_survive_reopen() {
    use std::io::{Seek as _, Write as _};
    let d = scratch("retention-real-editor");
    let db_path = scratch("retention-real-editor-db").join("index.db");
    let data = Rc::new(RefCell::new(MemData::default()));
    let clock = WallClock::default();
    let open = || {
        let idx = Rc::new(RefCell::new(
            SqliteIndex::open(&db_path, IndexDurability::Durable).unwrap(),
        ));
        FileStore::open(
            Rc::new(platform(&d)),
            MemStore::shared(data.clone()),
            SqlDiskDb::open(idx).unwrap(),
            Box::new(clock.clone()),
            Config {
                release: Some(mdbn_store_file::ReleasePolicy::NextLaunch {
                    cap_bytes: 256 << 20,
                    max_age_ms: mdbn_store_file::MAX_RETENTION_AGE_MS,
                }),
                ..Config::default()
            },
        )
        .unwrap()
    };
    let mut s = open();
    let created = s
        .commit(Tx {
            publish: vec![Publish::Write {
                id: None,
                path: "a.md".into(),
                expect: RExpect::Absent,
                content: Content::Text("old".into()),
            }],
            ..Tx::default()
        })
        .unwrap();
    assert!(created.drifts.is_empty());
    let mut editor = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(d.join("a.md"))
        .unwrap();
    let result = s
        .commit(Tx {
            publish: vec![Publish::Write {
                id: None,
                path: "a.md".into(),
                expect: RExpect::Revision(revision(b"old")),
                content: Content::Text("new".into()),
            }],
            ..Tx::default()
        })
        .unwrap();
    assert!(result.drifts.is_empty());
    clock.0.set(3_000);
    assert!(s.observe(None).unwrap().is_empty());
    assert_eq!(s.stats.reclaimed, 0);
    assert_eq!(s.next_wakeup(), Some(mdbn_store_file::MAX_RETENTION_AGE_MS));
    let retained_dir = d.join(".mdbase").join(if s.platform().retained_nosync() {
        "retained.nosync"
    } else {
        "stash"
    });
    let retained: Vec<_> = fs::read_dir(&retained_dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    assert_eq!(retained.len(), 1);
    assert_eq!(fs::read(&retained[0]).unwrap(), b"old");
    editor.seek(std::io::SeekFrom::Start(0)).unwrap();
    editor.write_all(b"late user bytes").unwrap();
    editor.set_len(15).unwrap();
    editor.sync_all().unwrap();
    drop(editor);
    assert_eq!(fs::read(&retained[0]).unwrap(), b"late user bytes");
    drop(s);
    let mut s = open();
    let observed = s.observe(None).unwrap();
    assert_eq!(observed.len(), 1);
    assert_eq!(observed[0].base, Some(revision(b"old")));
    assert_eq!(
        observed[0].now,
        Some(Observed::Text("late user bytes".into()))
    );
    assert_eq!(fs::read(d.join("a.md")).unwrap(), b"new");
    assert_eq!(fs::read(&retained[0]).unwrap(), b"late user bytes");
    s.commit(Tx {
        ack_observations: vec![observed[0].token],
        ..Tx::default()
    })
    .unwrap();
    assert!(!retained[0].exists());
    assert_eq!(fs::read(d.join("a.md")).unwrap(), b"new");
}

#[test]
fn file_store_on_disk_survives_reopen() {
    let d = scratch("store");
    let db_path = scratch("store-db").join("index.db");
    let data = Rc::new(RefCell::new(MemData::default()));
    let clock = WallClock::default();
    let open = || {
        let idx = Rc::new(RefCell::new(
            SqliteIndex::open(&db_path, IndexDurability::Durable).unwrap(),
        ));
        FileStore::open(
            Rc::new(platform(&d)),
            MemStore::shared(data.clone()),
            SqlDiskDb::open(idx).unwrap(),
            Box::new(clock.clone()),
            Config::default(),
        )
        .unwrap()
    };
    let mut s = open();
    assert!(s.observe(None).unwrap().is_empty());
    let w = |path: &str, expect, text: &str| Publish::Write {
        id: None,
        path: path.into(),
        expect,
        content: Content::Text(text.into()),
    };
    let r = s
        .commit(Tx {
            publish: vec![w("a.md", RExpect::Absent, "hello")],
            ..Tx::default()
        })
        .unwrap();
    assert!(r.drifts.is_empty());
    drop(s);
    // Reopen: the disk state persisted, so nothing is re-observed.
    let mut s = open();
    assert!(s.observe(None).unwrap().is_empty());
    fs::write(d.join("a.md"), b"hello edited").unwrap();
    fs::write(d.join("pic.bin"), [0u8, 159, 146, 150]).unwrap();
    s.request_rescan();
    let obs = s.observe(None).unwrap();
    assert_eq!(obs.len(), 2, "{obs:?}");
    let a = obs.iter().find(|o| o.path == "a.md").unwrap();
    assert_eq!(a.base, Some(revision(b"hello")));
    assert_eq!(a.now, Some(Observed::Text("hello edited".into())));
    let b = obs.iter().find(|o| o.path == "pic.bin").unwrap();
    // A binary file is an attachment: hashed through a range handle, never a
    // blob in the store, and readable again only through a bounded source.
    assert_eq!(
        b.now,
        Some(Observed::Attachment {
            digest: revision(&[0u8, 159, 146, 150]),
            size: 4,
            class: AttachmentClass::Ordinary,
        })
    );
    let mut src = s.attachment_source("pic.bin", 4).unwrap().expect("source");
    let mut buf = [0u8; 3];
    src.read_at(1, &mut buf).unwrap();
    assert_eq!(buf, [159, 146, 150]);
    assert!(src.read_at(2, &mut buf).is_err(), "past the end");
    assert!(
        s.attachment_source("pic.bin", 5).unwrap().is_none(),
        "size changed"
    );
    drop(src);
    s.commit(Tx {
        ack_observations: obs.iter().map(|o| o.token).collect(),
        ..Tx::default()
    })
    .unwrap();
    drop(s);
    let mut s = open();
    s.request_rescan();
    assert!(s.observe(None).unwrap().is_empty());
}

#[test]
fn sqlite_index_batches_and_states() {
    let path = scratch("sqlite").join("i.db");
    let mut idx = SqliteIndex::open(&path, IndexDurability::Durable).unwrap();
    assert_eq!(idx.info().opened, OpenState::Fresh);
    let r = idx
        .run(&Batch {
            mode: BatchMode::Transaction,
            stmts: vec![
                Stmt::new("CREATE TABLE t(a INTEGER, b TEXT, c BLOB)", vec![]),
                Stmt::new(
                    "INSERT INTO t VALUES (?, ?, ?)",
                    vec![
                        SqlValue::Integer(1),
                        SqlValue::Text("x".into()),
                        SqlValue::Blob(vec![1, 2]),
                    ],
                ),
                Stmt::new("SELECT a, b, c FROM t", vec![]),
            ],
        })
        .unwrap();
    assert_eq!(r[1].changes, 1);
    assert_eq!(r[2].columns, 3);
    assert_eq!(
        r[2].rows().next().unwrap(),
        &[
            SqlValue::Integer(1),
            SqlValue::Text("x".into()),
            SqlValue::Blob(vec![1, 2])
        ]
    );
    // A failing transaction applies nothing.
    let e = idx
        .run(&Batch {
            mode: BatchMode::Transaction,
            stmts: vec![
                Stmt::new("INSERT INTO t VALUES (2, 'y', NULL)", vec![]),
                Stmt::new("INSERT INTO nope VALUES (1)", vec![]),
            ],
        })
        .unwrap_err();
    assert_eq!(e.stmt, Some(1));
    let n = idx
        .run(&Batch {
            mode: BatchMode::Autocommit,
            stmts: vec![Stmt::new("SELECT count(*) FROM t", vec![])],
        })
        .unwrap();
    assert_eq!(n[0].values, vec![SqlValue::Integer(1)]);
    // A second runtime cannot open it.
    let e = SqliteIndex::open(&path, IndexDurability::Durable)
        .err()
        .unwrap();
    assert_eq!(e.kind, IndexErrorKind::Busy);
    drop(idx);
    let idx = SqliteIndex::open(&path, IndexDurability::Durable).unwrap();
    assert_eq!(idx.info().opened, OpenState::Existing);
}

#[test]
fn sqlite_index_detects_unclean_and_resets() {
    let path = scratch("sqlite-unclean").join("i.db");
    let idx = SqliteIndex::open(&path, IndexDurability::Disposable).unwrap();
    idx.close_unclean();
    let mut idx = SqliteIndex::open(&path, IndexDurability::Disposable).unwrap();
    assert_eq!(idx.info().opened, OpenState::Unclean);
    idx.reset().unwrap();
    assert_eq!(idx.info().opened, OpenState::Fresh);
}

#[test]
fn sqlite_journal_versions_and_compaction() {
    let path = scratch("journal").join("j.db");
    let j = SqliteJournal::open(&path).unwrap();
    let t = Timers::default();
    let e = |k: &[u8], v: u64, val: Option<&[u8]>| JournalEntry {
        space: Space(1),
        key: k.to_vec(),
        version: v,
        value: val.map(|x| x.to_vec()),
    };
    run_ready(
        &t,
        j.append(vec![e(b"a", 1, Some(b"1")), e(b"b", 2, Some(b"2"))]),
    )
    .unwrap()
    .unwrap();
    // An older version never wins; a delete hides the key.
    run_ready(
        &t,
        j.append(vec![e(b"a", 0, Some(b"old")), e(b"b", 3, None)]),
    )
    .unwrap()
    .unwrap();
    let live = run_ready(&t, j.load()).unwrap().unwrap();
    assert_eq!(live, vec![e(b"a", 1, Some(b"1"))]);
    run_ready(&t, j.compact(live.clone())).unwrap().unwrap();
    drop(j);
    let j = SqliteJournal::open(&path).unwrap();
    assert_eq!(run_ready(&t, j.load()).unwrap().unwrap(), live);
}

#[test]
fn sec033_paths_never_leave_the_root() {
    let d = scratch("sec033");
    let p = platform(&d);
    for seg in ["..", "a/../../x"] {
        assert!(RelPath::new(seg).is_err());
    }
    // `RelPath` already refuses `:`; the native builder refuses it again.
    assert!(RelPath::new("C:evil.md").is_err());
    let ok = p.abs(&rp("a/b.md")).unwrap();
    assert!(ok.starts_with(&d));
    // A publish to a hidden or private path is refused before the platform.
    use mdbn_store_file::platform::portable_violation;
    assert!(portable_violation(".MDBASE/x").is_some());
    assert!(portable_violation("C:evil.md").is_some());
}

/// A retained file an editor still has
/// open is not released (Linux lease check).
#[cfg(target_os = "linux")]
#[test]
fn lease_check_sees_open_editors() {
    use mdbn_store_file::platform::Holders;
    let d = scratch("lease");
    let p = platform(&d);
    fs::write(d.join("a.md"), b"x").unwrap();
    let t = Timers::default();
    assert_eq!(
        run_ready(&t, p.other_holders(&rp("a.md")))
            .unwrap()
            .unwrap(),
        Holders::None
    );
    let editor = fs::OpenOptions::new()
        .write(true)
        .open(d.join("a.md"))
        .unwrap();
    assert_eq!(
        run_ready(&t, p.other_holders(&rp("a.md")))
            .unwrap()
            .unwrap(),
        Holders::Some
    );
    drop(editor);
    assert_eq!(
        run_ready(&t, p.other_holders(&rp("a.md")))
            .unwrap()
            .unwrap(),
        Holders::None
    );
}

/// Link-dense notes (maps of content, long indexes) used to cost one SQL
/// statement per link key. A local-ingest batch of a few such notes went over
/// the 16,384-statement transaction budget, the commit returned `Full` and the
/// replica fenced itself (`apply_reopen_required`): a cold open of a 7k+ note
/// vault never finished. The keys now go in multi-row inserts.
#[test]
fn link_dense_records_commit_within_the_statement_budget() {
    use mdbn_store_file::testing::replica::store::{RecordMeta, RecordRow};
    let dir = scratch("link-dense");
    let idx = SqliteIndex::open(dir.join("i.db"), IndexDurability::Durable).unwrap();
    let mut store = mdbn_store_file::SqlStore::open(Rc::new(RefCell::new(idx))).unwrap();
    let rows: Vec<RecordRow> = (0..3u8)
        .map(|n| {
            let doc = format!("# Map {n}\n");
            let path = format!("maps/{n}.md");
            RecordRow {
                id: mdbn_store_file::testing::B16([n + 1; 16]),
                path_key: mdbn_core::paths::path_key(&path),
                path,
                revision: revision(doc.as_bytes()),
                doc,
                modified_seq: 0,
                bucket: 0,
                meta: RecordMeta {
                    // 3 x 6,001 keys: over 16,384 at one statement per key.
                    links: (0..6_001).map(|k| format!("l:note {k}")).collect(),
                    ..RecordMeta::default()
                },
            }
        })
        .collect();
    store
        .commit(Tx {
            records_put: rows,
            ..Tx::default()
        })
        .expect("a batch of link-dense records commits");
    for key in ["l:note 0", "l:note 49", "l:note 50", "l:note 6000"] {
        let mut found = store.referrers(&[key.to_string()]).unwrap();
        found.sort();
        assert_eq!(
            found,
            (1..=3u8)
                .map(|n| mdbn_store_file::testing::B16([n; 16]))
                .collect::<Vec<_>>(),
            "{key}"
        );
    }
    assert!(store.referrers(&["l:note 6001".into()]).unwrap().is_empty());
}

#[test]
fn sql_store_passes_store_conformance() {
    let dir = scratch("sql-conformance");
    let n = Cell::new(0u32);
    mdbn_store_file::testing::replica::conformance::run(|| {
        n.set(n.get() + 1);
        let idx = SqliteIndex::open(
            dir.join(format!("s{}.db", n.get())),
            IndexDurability::Durable,
        )
        .unwrap();
        mdbn_store_file::SqlStore::open(Rc::new(RefCell::new(idx))).unwrap()
    });
}

#[test]
fn sql_store_passes_tail_conformance() {
    let dir = scratch("sql-tail-conformance");
    let n = Cell::new(0u32);
    mdbn_store_file::testing::replica::conformance::run_tail(|| {
        n.set(n.get() + 1);
        let idx = SqliteIndex::open(
            dir.join(format!("tail{}.db", n.get())),
            IndexDurability::Durable,
        )
        .unwrap();
        mdbn_store_file::SqlStore::open(Rc::new(RefCell::new(idx))).unwrap()
    });
    // run_tail's fourth case deliberately retains one own intent through
    // clear_confirmed. Reopen that actual fixture and inject an own-put abort.
    let path = dir.join("tail4.db");
    let reopen = || {
        mdbn_store_file::SqlStore::open(Rc::new(RefCell::new(
            SqliteIndex::open(&path, IndexDurability::Durable).unwrap(),
        )))
        .unwrap()
    };
    let mut store = reopen();
    let own = store.own_retained(0, 10).unwrap();
    assert_eq!(own.len(), 1);
    let pending = own[0].1.clone();
    store
        .commit(Tx {
            pending_put: vec![pending.clone()],
            ..Tx::default()
        })
        .unwrap();
    store.index().borrow_mut().run(&Batch { mode: BatchMode::Transaction, stmts: vec![Stmt::new("CREATE TRIGGER refuse_own BEFORE INSERT ON st_own BEGIN SELECT RAISE(ABORT,'synthetic own failure'); END", vec![])] }).unwrap();
    assert!(
        store
            .commit(Tx {
                pending_del: vec![pending.mutation.id],
                tail_drop_above: Some(0),
                own_retained_put: vec![(2, pending.clone())],
                ..Tx::default()
            })
            .is_err()
    );
    drop(store);
    let mut store = reopen();
    assert_eq!(
        store.pending_get(&pending.mutation.id).unwrap(),
        Some(pending.clone())
    );
    assert_eq!(store.own_retained(0, 10).unwrap(), own);
    assert_eq!(store.own_retained_stats().unwrap().count, 1);
    assert_eq!(
        store.tail_stats().unwrap().count,
        1,
        "own-put abort rolls back the preceding raw-tail drop"
    );
    // tail::append emits raw/own changes BEFORE pending_del. Abort AFTER the
    // actual pending DELETE to prove that deletion and earlier writes roll back.
    store.index().borrow_mut().run(&Batch { mode: BatchMode::Transaction, stmts: vec![
        Stmt::new("DROP TRIGGER refuse_own", vec![]),
        Stmt::new("CREATE TRIGGER refuse_pending AFTER DELETE ON st_pending BEGIN SELECT RAISE(ABORT,'synthetic pending deletion failure'); END", vec![]),
    ] }).unwrap();
    assert!(
        store
            .commit(Tx {
                pending_del: vec![pending.mutation.id],
                tail_drop_above: Some(0),
                own_retained_put: vec![(2, pending.clone())],
                ..Tx::default()
            })
            .is_err()
    );
    drop(store);
    let mut store = reopen();
    assert_eq!(
        store.pending_get(&pending.mutation.id).unwrap(),
        Some(pending)
    );
    assert_eq!(store.own_retained(0, 10).unwrap(), own);
    assert_eq!(store.own_retained_stats().unwrap().count, 1);
    assert_eq!(store.tail_stats().unwrap().count, 1);
    store
        .commit(Tx {
            tail_drop_above: Some(0),
            ..Tx::default()
        })
        .unwrap();
    let own_stats = store.own_retained_stats().unwrap();
    assert_eq!(own_stats.count, 1);
    assert!(own_stats.bytes > 0);
    drop(store);
    let store = reopen();
    assert_eq!(store.tail_stats().unwrap(), Default::default());
    assert_eq!(store.own_retained(0, 10).unwrap(), own);
    assert_eq!(store.own_retained_stats().unwrap(), own_stats);
}

#[test]
fn file_store_over_sql_store_survives_reopen() {
    use mdbn_store_file::SqlStore;
    let d = scratch("sqlfs");
    let db_path = scratch("sqlfs-db").join("collection.db");
    let clock = WallClock::default();
    let open = || {
        let idx = Rc::new(RefCell::new(
            SqliteIndex::open(&db_path, IndexDurability::Durable).unwrap(),
        ));
        FileStore::open(
            Rc::new(platform(&d)),
            SqlStore::open(idx.clone()).unwrap(),
            SqlDiskDb::open(idx).unwrap(),
            Box::new(clock.clone()),
            Config::default(),
        )
        .unwrap()
    };
    let mut s = open();
    s.commit(Tx {
        meta: vec![("k".into(), Some(b"v".to_vec()))],
        publish: vec![Publish::Write {
            id: None,
            path: "x/a.md".into(),
            expect: RExpect::Absent,
            content: Content::Text("hello".into()),
        }],
        ..Tx::default()
    })
    .unwrap();
    drop(s);
    let mut s = open();
    assert_eq!(s.meta("k").unwrap(), Some(b"v".to_vec()));
    assert!(s.observe(None).unwrap().is_empty());
    assert_eq!(fs::read(d.join("x/a.md")).unwrap(), b"hello");
}

/// Snapshot-install staging on real SQLite survives a restart: rows staged
/// before a crash are still staged (and invisible) after reopening, through a
/// FileStore over the SqlStore, and swap in atomically after the restart; a
/// discard after a restart leaves the prior confirmed state untouched. Staged
/// rows never touch the disk.
#[test]
fn sql_staging_survives_a_restart_through_the_file_store() {
    use mdbn_store_file::SqlStore;
    use mdbn_store_file::testing::replica::conformance::record;
    use mdbn_store_file::testing::replica::store::{Page, Stage};
    let d = scratch("sqlstage");
    let db_path = scratch("sqlstage-db").join("collection.db");
    let clock = WallClock::default();
    let open = || {
        let idx = Rc::new(RefCell::new(
            SqliteIndex::open(&db_path, IndexDurability::Durable).unwrap(),
        ));
        FileStore::open(
            Rc::new(platform(&d)),
            SqlStore::open(idx.clone()).unwrap(),
            SqlDiskDb::open(idx).unwrap(),
            Box::new(clock.clone()),
            Config::default(),
        )
        .unwrap()
    };
    let all = Page {
        after: None,
        limit: 100,
    };
    let paths = |s: &dyn Store| {
        s.records(all)
            .unwrap()
            .into_iter()
            .map(|r| r.path)
            .collect::<Vec<_>>()
    };
    let mut s = open();
    assert!(s.stages(), "FileStore stages through its SqlStore");
    s.commit(Tx {
        records_put: vec![record(1, "old.md", "old")],
        ..Tx::default()
    })
    .unwrap();
    s.commit(Tx {
        stage: Stage::Put,
        records_put: vec![record(2, "a.md", "a")],
        ..Tx::default()
    })
    .unwrap();
    drop(s); // a crash between chunks

    let mut s = open();
    assert_eq!(paths(&s), vec!["old.md"], "staged rows stay invisible");
    s.commit(Tx {
        stage: Stage::Put,
        records_put: vec![record(3, "b.md", "b")],
        ..Tx::default()
    })
    .unwrap();
    drop(s);

    let mut s = open();
    let mut head = s.head().unwrap();
    head.seq = 5;
    s.commit(Tx {
        stage: Stage::Swap,
        head: Some(head),
        ..Tx::default()
    })
    .unwrap();
    assert_eq!(paths(&s), vec!["a.md", "b.md"], "staged across restarts");
    assert_eq!(s.head().unwrap().seq, 5);
    assert!(!d.join("a.md").exists(), "staging never publishes");
    // A later install that is abandoned: discard after a restart.
    s.commit(Tx {
        stage: Stage::Put,
        records_put: vec![record(4, "c.md", "c")],
        ..Tx::default()
    })
    .unwrap();
    drop(s);
    let mut s = open();
    s.commit(Tx {
        stage: Stage::Discard,
        ..Tx::default()
    })
    .unwrap();
    s.commit(Tx {
        stage: Stage::Swap,
        ..Tx::default()
    })
    .unwrap();
    assert!(
        paths(&s).is_empty(),
        "nothing left staged after the discard"
    );
}

/// The app-local tentative store over a Disposable SQLite index (as OPFS
/// reports): the raw SqlStore refuses it, the typed composition opens it,
/// passes store conformance, keeps pending rows across a reopen, never holds
/// the keyring, and fences after an uncertain commit.
mod tentative {
    use super::*;
    use mdbn_store_file::index::{IndexError, IndexInfo, StmtResult};
    use mdbn_store_file::testing::replica::conformance::{id, pending_row, record};
    use mdbn_store_file::testing::replica::store::{KeyringPersistence, StoreError, meta_keys};
    use mdbn_store_file::{SqlStore, SqlStoreLimits, TentativeStore};

    /// An index whose next transaction applies, then reports an error (a COMMIT
    /// that lands before it throws).
    struct Flaky {
        inner: SqliteIndex,
        fail_next: bool,
    }
    impl IndexStorage for Flaky {
        fn info(&self) -> IndexInfo {
            self.inner.info()
        }
        fn run(&mut self, batch: &Batch) -> Result<Vec<StmtResult>, IndexError> {
            let r = self.inner.run(batch)?;
            if self.fail_next && batch.mode == BatchMode::Transaction {
                self.fail_next = false;
                return Err(IndexError::new(
                    IndexErrorKind::Other,
                    "commit outcome unknown",
                ));
            }
            Ok(r)
        }
        fn reset(&mut self) -> Result<(), IndexError> {
            self.inner.reset()
        }
    }

    fn disposable(path: &std::path::Path) -> Rc<RefCell<SqliteIndex>> {
        Rc::new(RefCell::new(
            SqliteIndex::open(path, IndexDurability::Disposable).unwrap(),
        ))
    }

    #[test]
    fn opens_where_the_raw_sql_store_refuses_and_passes_conformance() {
        let dir = scratch("tentative-conformance");
        assert!(SqlStore::open(disposable(&dir.join("raw.db"))).is_err());
        let s =
            TentativeStore::open(disposable(&dir.join("t.db")), SqlStoreLimits::MOBILE).unwrap();
        assert_eq!(s.durability(), IndexDurability::Disposable);
        assert_eq!(s.keyring_persistence(), KeyringPersistence::RebuildOnOpen);
        assert!(s.fenced().is_none());
        let n = Cell::new(0u32);
        mdbn_store_file::testing::replica::conformance::run(|| {
            n.set(n.get() + 1);
            TentativeStore::open(
                disposable(&dir.join(format!("c{}.db", n.get()))),
                SqlStoreLimits::MOBILE,
            )
            .unwrap()
        });
    }

    #[test]
    fn pending_survives_a_reopen_and_the_keyring_never_lands() {
        let path = scratch("tentative-reopen").join("t.db");
        let open = || TentativeStore::open(disposable(&path), SqlStoreLimits::MOBILE);
        let mut s = open().unwrap();
        s.commit(Tx {
            pending_put: vec![pending_row(1, 7)],
            records_put: vec![record(2, "a.md", "a")],
            ..Tx::default()
        })
        .unwrap();
        // The keyring is refused before anything runs, and does not fence.
        let err = s
            .commit(Tx {
                meta: vec![(meta_keys::KEYRING.into(), Some(vec![1, 2, 3]))],
                records_put: vec![record(3, "b.md", "b")],
                ..Tx::default()
            })
            .unwrap_err();
        assert!(matches!(err, StoreError::Io(_)));
        assert!(s.fenced().is_none());
        assert_eq!(s.meta(meta_keys::KEYRING).unwrap(), None);
        assert!(s.record(&id(3)).unwrap().is_none(), "nothing of it applied");
        drop(s);
        let s = open().unwrap();
        assert!(
            s.pending_get(&id(7)).unwrap().is_some(),
            "not yet synced, kept"
        );
        assert_eq!(s.pending_count().unwrap(), 1);
        assert!(s.record(&id(2)).unwrap().is_some());
        drop(s);
        // A database that somehow holds key material does not open.
        let mut raw = SqlStore::open(Rc::new(RefCell::new(
            SqliteIndex::open(&path, IndexDurability::Durable).unwrap(),
        )))
        .unwrap();
        raw.commit(Tx {
            meta: vec![(meta_keys::KEYRING.into(), Some(vec![9]))],
            ..Tx::default()
        })
        .unwrap();
        drop(raw);
        assert!(matches!(open(), Err(StoreError::Corrupt(_))));
    }

    #[test]
    fn an_uncertain_commit_fences_until_reopen() {
        let path = scratch("tentative-fence").join("t.db");
        let idx = Rc::new(RefCell::new(Flaky {
            inner: SqliteIndex::open(&path, IndexDurability::Disposable).unwrap(),
            fail_next: false,
        }));
        let mut s = TentativeStore::open(idx.clone(), SqlStoreLimits::MOBILE).unwrap();
        idx.borrow_mut().fail_next = true;
        let err = s
            .commit(Tx {
                pending_put: vec![pending_row(1, 7)],
                ..Tx::default()
            })
            .unwrap_err();
        assert!(
            matches!(err, StoreError::Io(_)),
            "never CommitAborted: {err:?}"
        );
        assert!(s.fenced().is_some());
        assert!(s.pending_count().is_err(), "reads fail while fenced");
        assert!(
            s.commit(Tx {
                records_put: vec![record(2, "a.md", "a")],
                ..Tx::default()
            })
            .is_err(),
            "commits fail while fenced"
        );
        drop(s);
        drop(idx);
        // Reopen: the commit did land; the replica reconciles by original ID.
        let s = TentativeStore::open(
            Rc::new(RefCell::new(
                SqliteIndex::open(&path, IndexDurability::Disposable).unwrap(),
            )),
            SqlStoreLimits::MOBILE,
        )
        .unwrap();
        assert!(s.fenced().is_none());
        assert!(s.pending_get(&id(7)).unwrap().is_some());
        assert!(s.record(&id(2)).unwrap().is_none());
    }

    /// The app composition end to end: a replica over the tentative store on a
    /// Disposable index, with the production sealer. No commit ever carries the
    /// keyring (the store would refuse it); after a reopen the replica rebuilds
    /// its keys from the log with the device KEM key and decrypts an entry it
    /// had not applied, while a capture made before the rebuild stays pending
    /// ("not yet synced") until the log confirms it.
    #[test]
    fn app_replica_never_stores_the_keyring_and_decrypts_after_reopen() {
        use mdbn_store_file::testing::replica as rp;
        use mdbn_store_file::testing::wire;
        use rp::api::{ClientApi, SessionAuth, SessionId};
        use rp::fake::FakeLogService;
        use rp::log::EndpointId;
        use rp::{DeviceSecrets, Host, Replica, ReplicaConfig, UtcOnly};
        use wire::client::{HelloParams, ReceiptState, SubmitParams};
        use wire::common::{B16, Text, Version};
        use wire::intent::{Create, Op};

        let col = B16([7; 16]);
        let dev = B16([101; 16]);
        let (sign, kem) = ([0x31u8; 32], [0x32u8; 32]);
        let svc = FakeLogService::new();
        rp::testkit::TestControlPlane::signed(col).genesis_with_keys(
            &svc,
            wire::policy::CState::E2e,
            dev,
            &sign,
            &kem,
        );
        type App = Replica<TentativeStore<SqliteIndex>>;
        let open_store = |path: &std::path::Path| {
            TentativeStore::open(disposable(path), SqlStoreLimits::MOBILE).unwrap()
        };
        let open = |store, replica: u8, seed: u8| -> (App, SessionId) {
            let mut r = Replica::open(
                ReplicaConfig {
                    collection: col,
                    device_id: dev,
                    replica_id: B16([replica; 16]),
                    mode: wire::client::SyncMode::Synced,
                    log_endpoint: EndpointId(1),
                    verify: true,
                    runtime_version: "app-test".into(),
                    trusted_roots: vec![rp::testkit::signed_root()],
                    trusted_signers: vec![],
                    e2e: false,
                    user_enabled_cloud_copy: false,
                    chosen_state: None,
                    expected_genesis: None,
                    key_grants_only: false,
                    policy_pins: None,
                },
                store,
                Box::new(rp::plan::CorePlanner),
                Box::new(rp::seal::KeyringSealer::new(col, dev, &sign, &kem)),
                Host {
                    clock: Box::new(mdbn_core::host::FixedClock(1_700_000_000_000)),
                    entropy: Box::new(rp::crypto::TestEntropy::new(seed)),
                    zones: Box::new(UtcOnly),
                },
                DeviceSecrets {
                    sign_sk: sign,
                    kem_sk: kem,
                },
            )
            .expect("open");
            let (s, _) = r
                .hello(
                    SessionAuth::Host,
                    HelloParams {
                        versions: vec![Version { major: 1, minor: 0 }],
                        client_name: "app".into(),
                        client_version: "0".into(),
                        features: None,
                        timezone: None,
                    },
                )
                .unwrap();
            (r, s)
        };
        let settle = |r: &mut App| {
            let mut c = svc.client(dev);
            for _ in 0..20 {
                rp::log::pump(r, &mut c, 100);
                r.tick();
            }
        };
        let create = |r: &mut App, s, id: u8, path: &str, doc: &str, m: u8| {
            r.submit(
                s,
                SubmitParams {
                    ops: vec![Op::Create(Create {
                        id: B16([id; 16]),
                        path: Some(path.into()),
                        type_name: None,
                        frontmatter: None,
                        body: None,
                        document: Some(Text::Inline(doc.into())),
                    })],
                    mutation_id: Some(B16([m; 16])),
                    conflict_mode: None,
                    timezone: None,
                    allow_partial: None,
                    mutation_ids: None,
                    dry_run: None,
                    include: None,
                    wait: None,
                },
            )
            .unwrap()
            .remove(0)
        };
        let doc = |r: &App, id: u8| r.store().record(&B16([id; 16])).unwrap().map(|r| r.doc);

        let dir = scratch("tentative-app");
        let path = dir.join("app.db");
        let (mut a, s) = open(open_store(&path), 1, 1);
        settle(&mut a);
        assert!(!a.testing_epoch_keys().is_empty(), "keyed");
        create(&mut a, s, 1, "first.md", "first secret", 0x11);
        settle(&mut a);
        assert_eq!(a.store().pending_count().unwrap(), 0);
        assert!(a.store().fenced().is_none(), "no commit was refused");
        drop(a);

        // The same device on another store writes something the app has not seen.
        let (mut b, s) = open(open_store(&dir.join("other.db")), 2, 2);
        settle(&mut b);
        create(&mut b, s, 2, "second.md", "second secret", 0x22);
        settle(&mut b);
        drop(b);

        let (mut a, s) = open(open_store(&path), 1, 3);
        assert!(a.keyring_rebuilding(), "no keys at rest");
        assert_eq!(doc(&a, 1).as_deref(), Some("first secret"));
        let r = create(&mut a, s, 3, "offline.md", "offline", 0x33);
        assert_eq!(r.state, ReceiptState::Pending, "not yet synced, not saved");
        settle(&mut a);
        assert!(!a.keyring_rebuilding() && !a.keyring_rebuild_failed());
        assert_eq!(doc(&a, 2).as_deref(), Some("second secret"), "decrypted");
        assert_eq!(
            a.store().pending_count().unwrap(),
            0,
            "the capture appended"
        );
        assert!(a.store().fenced().is_none());
        assert_eq!(a.store().meta(meta_keys::KEYRING).unwrap(), None);
        drop(a);
        // Nothing in the database file is the keyring row.
        let raw = SqlStore::open(Rc::new(RefCell::new(
            SqliteIndex::open(&path, IndexDurability::Durable).unwrap(),
        )))
        .unwrap();
        assert_eq!(raw.meta(meta_keys::KEYRING).unwrap(), None);
    }
}

/// Symlink-confinement fixture: `root/shared -> outside/` (a folder outside the root),
/// `root/alias -> root/inside/` (a folder inside it) and `root/link.md ->
/// outside/secret.md`. Returns (root, outside).
#[cfg(unix)]
fn linked_fixture(tag: &str) -> (PathBuf, PathBuf) {
    let d = scratch(tag);
    let (root, outside) = (d.join("root"), d.join("outside"));
    fs::create_dir_all(root.join("inside")).unwrap();
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("secret.md"), b"outside the root").unwrap();
    fs::write(root.join("inside/real.md"), b"inside").unwrap();
    std::os::unix::fs::symlink(&outside, root.join("shared")).unwrap();
    std::os::unix::fs::symlink(root.join("inside"), root.join("alias")).unwrap();
    std::os::unix::fs::symlink(outside.join("secret.md"), root.join("link.md")).unwrap();
    (root, outside)
}

/// No platform operation follows a symlink in any component, whether
/// it points outside the root or inside it. Reads, writes, creates, renames,
/// removes and flushes through a link are refused; stat reports `Other`.
#[cfg(unix)]
#[test]
fn platform_never_follows_a_symlink_in_any_component() {
    use mdbn_store_file::platform::{FileKind, FlushScope};
    let (root, outside) = linked_fixture("links-platform");
    let p = platform(&root);
    let t = Timers::default();
    fn ok<T, E>(r: Result<T, E>) -> bool {
        r.is_ok()
    }
    for path in ["shared/secret.md", "alias/real.md", "link.md"] {
        let m = run_ready(&t, p.stat(&rp(path))).unwrap().unwrap();
        assert_eq!(m.kind, FileKind::Other, "{path}");
        assert!(!ok(run_ready(&t, p.read(&rp(path))).unwrap()), "{path}");
        assert!(
            !ok(run_ready(&t, p.read_range(&rp(path), 0, 4)).unwrap()),
            "{path}"
        );
        assert!(
            !ok(run_ready(&t, p.open_range_read(&rp(path))).unwrap()),
            "{path}"
        );
        assert!(
            !ok(run_ready(&t, p.append(&rp(path), b"x")).unwrap()),
            "{path}"
        );
        assert!(
            !ok(run_ready(&t, p.flush(FlushScope::File(rp(path)))).unwrap()),
            "{path}"
        );
    }
    for dir in ["shared", "alias"] {
        assert!(!ok(run_ready(&t, p.list(&rp(dir))).unwrap()), "{dir}");
        assert!(
            !ok(run_ready(&t, p.create_dir_all(&rp(&format!("{dir}/sub")))).unwrap()),
            "{dir}"
        );
        assert!(
            !ok(run_ready(&t, p.write_new(&rp(&format!("{dir}/new.md")), b"x", false)).unwrap()),
            "{dir}"
        );
        assert!(
            !ok(run_ready(
                &t,
                p.rename_noreplace(&rp("inside/real.md"), &rp(&format!("{dir}/moved.md")))
            )
            .unwrap()),
            "{dir}"
        );
    }
    assert!(!ok(
        run_ready(&t, p.remove_file(&rp("shared/secret.md"))).unwrap()
    ));
    assert!(!ok(run_ready(
        &t,
        p.copy_metadata(&rp("inside/real.md"), &rp("shared/secret.md"))
    )
    .unwrap()));
    if p.capabilities().replace == ReplaceStrategy::Exchange {
        assert!(!ok(run_ready(
            &t,
            p.exchange(&rp("inside/real.md"), &rp("shared/secret.md"))
        )
        .unwrap()));
    }
    // The root lists the links as `Other`; nothing outside changed.
    let listed = run_ready(&t, p.list(&RelPath::ROOT)).unwrap().unwrap();
    for name in ["shared", "alias", "link.md"] {
        let e = listed.iter().find(|e| e.name == name).unwrap();
        assert_eq!(e.kind, FileKind::Other, "{name}");
    }
    assert_eq!(
        fs::read(outside.join("secret.md")).unwrap(),
        b"outside the root"
    );
    let mut names: Vec<_> = fs::read_dir(&outside)
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    names.sort();
    assert_eq!(names, ["secret.md"]);
    // Real folders still work.
    assert_eq!(
        run_ready(&t, p.read(&rp("inside/real.md")))
            .unwrap()
            .unwrap()
            .bytes,
        b"inside"
    );
    assert_eq!(fs::read(root.join("inside/real.md")).unwrap(), b"inside");
}

/// Symlink confinement through the file store: a full scan and explicit events never ingest
/// a file behind a symlink (outside or inside the root), the links are
/// counted as unsupported, and a publish under a symlinked folder drifts
/// without writing anything outside the root.
#[cfg(unix)]
#[test]
fn file_store_never_ingests_or_publishes_through_a_symlink() {
    let (root, outside) = linked_fixture("links-store");
    let db_path = scratch("links-store-db").join("index.db");
    let idx = Rc::new(RefCell::new(
        SqliteIndex::open(&db_path, IndexDurability::Durable).unwrap(),
    ));
    let mut s = FileStore::open(
        Rc::new(platform(&root)),
        MemStore::shared(Rc::new(RefCell::new(MemData::default()))),
        SqlDiskDb::open(idx).unwrap(),
        Box::new(WallClock::default()),
        Config::default(),
    )
    .unwrap();
    s.request_rescan();
    let obs = s.observe(None).unwrap();
    let paths: Vec<_> = obs.iter().map(|o| o.path.as_str()).collect();
    assert_eq!(paths, ["inside/real.md"], "{obs:?}");
    assert_eq!(s.stats.unsupported_entries, 3);
    let events: Vec<String> = ["shared/secret.md", "alias/real.md", "link.md"]
        .map(String::from)
        .to_vec();
    assert!(s.observe(Some(&events)).unwrap().is_empty());
    let r = s
        .commit(Tx {
            ack_observations: obs.iter().map(|o| o.token).collect(),
            publish: vec![
                Publish::Write {
                    id: None,
                    path: "shared/new.md".into(),
                    expect: RExpect::Absent,
                    content: Content::Text("remote".into()),
                },
                Publish::Write {
                    id: None,
                    path: "alias/new.md".into(),
                    expect: RExpect::Absent,
                    content: Content::Text("remote".into()),
                },
            ],
            ..Tx::default()
        })
        .unwrap();
    let mut reasons: Vec<_> = r.drifts.iter().map(|d| d.reason.as_str()).collect();
    reasons.sort();
    assert_eq!(reasons, ["symlink_in_path", "symlink_in_path"]);
    assert!(!outside.join("new.md").exists());
    assert!(!root.join("inside/new.md").exists());
}
