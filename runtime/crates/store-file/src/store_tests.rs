//! `FileStore` over the in-memory platform, `MemStore` and `MemDiskDb`.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use mdbn_core::host::Clock;
use mdbn_replica::mem::{MemData, MemStore};
use mdbn_replica::store::{
    AttachmentClass, Content, Expect as RExpect, Observation, Observed, Provenance, Publish, Store,
    Tx,
};
use mdbn_wire::common::{B16, Uuid};

use crate::diskdb::{DiskDb, Kind, MemDiskDb};
use crate::platform::{CaseSensitivity, FileEvent, FileEventKind, RelPath, ReplaceStrategy};
use crate::publish::revision;
use crate::store::{Config, FileStore};
use crate::testing::MemPlatform;

#[derive(Clone, Default)]
struct TestClock(Rc<Cell<u64>>);

impl Clock for TestClock {
    fn now_ms(&self) -> u64 {
        self.0.get()
    }
}

impl TestClock {
    fn advance(&self, ms: u64) {
        self.0.set(self.0.get() + ms);
    }
}

type Fs = FileStore<MemPlatform, MemStore, MemDiskDb>;

struct World {
    p: Rc<MemPlatform>,
    data: Rc<RefCell<MemData>>,
    db: MemDiskDb,
    clock: TestClock,
}

impl World {
    fn new(strategy: ReplaceStrategy, case: CaseSensitivity) -> World {
        World {
            p: Rc::new(MemPlatform::new(strategy, case)),
            data: Rc::new(RefCell::new(MemData::default())),
            db: MemDiskDb::default(),
            clock: TestClock::default(),
        }
    }

    fn open(&self) -> Fs {
        self.open_with(Config::default())
    }

    fn open_with(&self, cfg: Config) -> Fs {
        FileStore::open(
            self.p.clone(),
            MemStore::shared(self.data.clone()),
            self.db.clone(),
            Box::new(self.clock.clone()),
            cfg,
        )
        .unwrap()
    }
}

// Closed mirror gate: each native effect entry point is independently checked,
// in BOTH phases. Injecting through shared MemStore simulates persisted startup
// metadata; the production driver must persist it before the first FileStore open.
fn closed_mirror_effect(effect: fn(&mut Fs) -> bool) {
    use mdbn_replica::mirror_admission::Fence;
    for detached in [false, true] {
        let w = World::new(ReplaceStrategy::Exchange, CaseSensitivity::Sensitive);
        let mut s = w.open();
        w.p.fs.write_replace("local.md", b"user bytes").unwrap();
        let mut inner = MemStore::shared(w.data.clone());
        let f = Fence::new([1; 16], 1).unwrap();
        f.persist(&mut inner).unwrap();
        if detached {
            f.detached().persist(&mut inner).unwrap();
        }
        let ops = w.p.fs.ops();
        let paths = w.p.fs.paths();
        let rows = w.db.load().unwrap();
        assert!(
            effect(&mut s),
            "closed entry must refuse, not report success"
        );
        assert_eq!(w.p.fs.ops(), ops, "no native operation may run");
        assert_eq!(w.p.fs.paths(), paths);
        assert_eq!(w.p.fs.get("local.md"), Some(b"user bytes".to_vec()));
        assert_eq!(w.db.load().unwrap(), rows, "no intent/evidence cleanup");
    }
}
#[test]
fn mirror_gate_retains_nonempty_observation_and_later_user_edits_across_reopen() {
    use mdbn_replica::mirror_admission::Fence;
    for detached in [false, true] {
        let w = World::new(ReplaceStrategy::Exchange, CaseSensitivity::Sensitive);
        let mut s = w.open();
        assert!(publish(&mut s, write("local.md", RExpect::Absent, "base bytes")).is_empty());
        // A writer opened the old inode before a guarded replacement. Its
        // late write becomes durable retained evidence, not a transient scan.
        let old_inode = w.p.fs.open_fd("local.md").unwrap();
        assert!(
            publish(
                &mut s,
                write("local.md", rev("base bytes"), "confirmed bytes")
            )
            .is_empty()
        );
        w.p.fs.write_inode(old_inode, b"queued user edit");
        w.p.fs.close_fd(old_inode);
        w.clock.advance(Config::default().retention_ms + 1);
        let obs = s.observe(None).unwrap();
        assert_eq!(obs.len(), 1);
        assert_eq!(text(&obs[0]), Some("queued user edit"));
        assert_eq!(obs[0].base, Some(revision(b"base bytes")));
        let rows = w.db.load().unwrap();
        assert!(
            rows.iter().any(|(kind, _, _)| *kind == Kind::Observation),
            "nonempty durable observation fixture"
        );
        let evidence_paths: Vec<_> = rows
            .iter()
            .filter(|(kind, _, _)| *kind == Kind::Observation)
            .map(|(_, _, bytes)| {
                crate::codec::EvidenceRec::from_bytes(bytes)
                    .unwrap()
                    .evidence
            })
            .collect();
        for path in &evidence_paths {
            assert_eq!(
                w.p.fs.get(path.as_str()),
                Some(b"queued user edit".to_vec())
            );
        }
        let mut inner = MemStore::shared(w.data.clone());
        let fence = Fence::new([1; 16], 1).unwrap();
        fence.persist(&mut inner).unwrap();
        if detached {
            fence.detached().persist(&mut inner).unwrap();
        }
        // OS/tool writes remain possible. The older observation must not be
        // acknowledged, replaced or hidden because the user edited again.
        w.p.fs
            .write_in_place("local.md", b"edit while closed")
            .unwrap();
        w.p.fs.write_replace("new.md", b"new while closed").unwrap();
        s.on_events(&[event("local.md"), event("new.md")]);
        let ops = w.p.fs.ops();
        let paths = w.p.fs.paths();
        assert!(s.observe(None).is_err());
        assert!(
            s.commit(Tx {
                ack_observations: vec![obs[0].token],
                ..Tx::default()
            })
            .is_err()
        );
        assert_eq!(
            w.db.load().unwrap(),
            rows,
            "old observation/evidence/known state remain exact"
        );
        assert_eq!(w.p.fs.ops(), ops);
        drop(s);
        let reopened = FileStore::open(
            w.p.clone(),
            MemStore::shared(w.data.clone()),
            w.db.clone(),
            Box::new(w.clock.clone()),
            Config::default(),
        );
        assert!(reopened.is_err());
        assert_eq!(
            w.p.fs.ops(),
            ops,
            "closed reopen cannot settle or clean evidence"
        );
        assert_eq!(w.p.fs.paths(), paths);
        assert_eq!(w.db.load().unwrap(), rows);
        for path in &evidence_paths {
            assert_eq!(
                w.p.fs.get(path.as_str()),
                Some(b"queued user edit".to_vec())
            );
        }
        assert_eq!(w.p.fs.get("local.md"), Some(b"edit while closed".to_vec()));
        assert_eq!(w.p.fs.get("new.md"), Some(b"new while closed".to_vec()));
        let loaded = Fence::load(&inner).unwrap().unwrap();
        assert_eq!(
            loaded.phase,
            if detached {
                mdbn_replica::mirror_admission::Phase::Detached
            } else {
                mdbn_replica::mirror_admission::Phase::Joining
            }
        );
        assert_eq!(loaded.pending, 1);
    }
}

macro_rules! mirror_gate_test {
    ($name:ident, $effect:expr) => {
        #[test]
        fn $name() {
            closed_mirror_effect($effect);
        }
    };
}
mirror_gate_test!(mirror_gate_observe_cleanup, |s| s.observe(None).is_err());
mirror_gate_test!(mirror_gate_attachment_stage, |s| s
    .attachment_stage(&key(2), 0, b"new")
    .is_err());
mirror_gate_test!(mirror_gate_attachment_unstage_cleanup, |s| s
    .attachment_unstage(&key(2))
    .is_err());
mirror_gate_test!(mirror_gate_attachment_publish_adopt, |s| s
    .attachment_publish(&key(2), revision(b"new"), "local.md", RExpect::Absent)
    .is_err());
mirror_gate_test!(mirror_gate_attachment_delete, |s| s
    .attachment_remove(id(2), "local.md", revision(b"user bytes"))
    .is_err());
mirror_gate_test!(mirror_gate_attachment_move, |s| s
    .attachment_move(id(2), "local.md", "new.md", revision(b"user bytes"))
    .is_err());
mirror_gate_test!(mirror_gate_record_resource_publish, |s| s
    .commit(Tx {
        publish: vec![write("local.md", rev("user bytes"), "remote")],
        ..Tx::default()
    })
    .is_err());
mirror_gate_test!(mirror_gate_record_resource_delete, |s| s
    .commit(Tx {
        publish: vec![Publish::Delete {
            id: Some(id(1)),
            path: "local.md".into(),
            expect: rev("user bytes")
        }],
        ..Tx::default()
    })
    .is_err());
mirror_gate_test!(mirror_gate_record_resource_move, |s| s
    .commit(Tx {
        publish: vec![Publish::Move {
            id: id(1),
            from: "local.md".into(),
            to: "new.md".into(),
            expect: rev("user bytes"),
            content: None
        }],
        ..Tx::default()
    })
    .is_err());
mirror_gate_test!(mirror_gate_observation_ack_cleanup, |s| s
    .commit(Tx {
        ack_observations: vec![mdbn_replica::store::ObservationId(1)],
        ..Tx::default()
    })
    .is_err());
mirror_gate_test!(mirror_gate_snapshot_stage, |s| s
    .commit(Tx {
        stage: mdbn_replica::store::Stage::Put,
        resources_put: vec![("type.yaml".into(), "{}".into())],
        ..Tx::default()
    })
    .is_err());
mirror_gate_test!(mirror_gate_snapshot_swap, |s| s
    .commit(Tx {
        stage: mdbn_replica::store::Stage::Swap,
        ..Tx::default()
    })
    .is_err());
mirror_gate_test!(mirror_gate_snapshot_discard_cleanup, |s| s
    .commit(Tx {
        stage: mdbn_replica::store::Stage::Discard,
        ..Tx::default()
    })
    .is_err());
mirror_gate_test!(mirror_gate_adopt_clear_confirmed, |s| s
    .commit(Tx {
        clear_confirmed: true,
        ..Tx::default()
    })
    .is_err());
mirror_gate_test!(mirror_gate_blob_cleanup, |s| s
    .commit(Tx {
        blobs_del: vec![revision(b"user bytes")],
        ..Tx::default()
    })
    .is_err());

#[test]
fn mirror_gate_file_store_open_skips_private_dirs_and_intent_recovery() {
    use mdbn_replica::mirror_admission::Fence;
    for detached in [false, true] {
        let w = World::new(ReplaceStrategy::Exchange, CaseSensitivity::Sensitive);
        w.p.fs.write_replace("local.md", b"user bytes").unwrap();
        let mut inner = MemStore::shared(w.data.clone());
        let f = Fence::new([1; 16], 1).unwrap();
        f.persist(&mut inner).unwrap();
        if detached {
            f.detached().persist(&mut inner).unwrap();
        }
        let ops = w.p.fs.ops();
        assert!(
            FileStore::open(
                w.p.clone(),
                inner,
                w.db.clone(),
                Box::new(w.clock.clone()),
                Config::default()
            )
            .is_err()
        );
        assert_eq!(w.p.fs.ops(), ops);
        assert_eq!(w.p.fs.get("local.md"), Some(b"user bytes".to_vec()));
    }
}

fn next_launch_config(cap_bytes: u64) -> Config {
    Config {
        release: Some(crate::ReleasePolicy::NextLaunch {
            cap_bytes,
            max_age_ms: 10_000,
        }),
        ..Config::default()
    }
}

#[test]
fn retention_platform_default_and_journaled_directory_survive_reopen() {
    let w = World::new(ReplaceStrategy::Exchange, CaseSensitivity::Sensitive);
    w.p.retained_nosync.set(true);
    w.p.release.set(crate::ReleasePolicy::NextLaunch {
        cap_bytes: 100,
        max_age_ms: 10_000,
    });
    let mut s = w.open();
    publish(&mut s, write("a.md", RExpect::Absent, "old"));
    publish(&mut s, write("a.md", rev("old"), "new"));
    assert!(
        w.p.fs
            .paths()
            .iter()
            .any(|p| p.starts_with(".mdbase/retained.nosync/"))
    );
    assert!(
        !w.p.fs
            .paths()
            .iter()
            .any(|p| p.starts_with(".mdbase/stash/"))
    );
    w.clock.advance(3_000);
    assert!(s.observe(None).unwrap().is_empty());
    assert_eq!(s.next_wakeup(), Some(10_000));
    drop(s);
    let mut s = w.open();
    assert!(s.observe(None).unwrap().is_empty());
    assert_eq!(w.p.fs.paths(), vec!["a.md".to_string()]);
}

#[test]
fn retention_intent_recovery_uses_persisted_directory_not_current_recommendation() {
    use crate::codec::{IntentRec, counter_bytes};
    use crate::publish::{Expect, PublishOp};
    use mdbn_wire::cbor::{self, Cbor};
    for legacy in [false, true] {
        let w = World::new(ReplaceStrategy::Exchange, CaseSensitivity::Sensitive);
        // Intentionally opposite to the intent's stored choice.
        w.p.retained_nosync.set(legacy);
        let rec = IntentRec {
            strategy: ReplaceStrategy::Exchange,
            op: PublishOp {
                path: RelPath::new("a.md").unwrap(),
                expect: Expect::Rev(revision(b"old")),
                new: None,
            },
            n: 42,
            id: None,
            retained_nosync: !legacy,
        };
        let mut bytes = rec.to_bytes();
        if legacy {
            let Cbor::Array(mut fields) = cbor::decode(&bytes).unwrap() else {
                panic!("array");
            };
            fields.truncate(6);
            bytes = cbor::encode(&Cbor::Array(fields)).unwrap();
        }
        let retained = if legacy {
            ".mdbase/stash/42"
        } else {
            ".mdbase/retained.nosync/42"
        };
        w.p.fs.write_in_place(retained, b"old").unwrap();
        w.db.clone()
            .apply(vec![
                (Kind::Intent, counter_bytes(42), Some(bytes)),
                (Kind::Counter, b"name".to_vec(), Some(counter_bytes(43))),
            ])
            .unwrap();
        let mut s = w.open_with(next_launch_config(100));
        assert_eq!(s.stats.recovered, 1);
        assert!(
            w.db.load()
                .unwrap()
                .iter()
                .all(|(kind, _, _)| *kind != Kind::Intent)
        );
        let rows: Vec<_> =
            w.db.load()
                .unwrap()
                .into_iter()
                .filter(|(kind, _, _)| *kind == Kind::Retained)
                .collect();
        assert_eq!(rows.len(), 1);
        assert_eq!(String::from_utf8(rows[0].1.clone()).unwrap(), retained);
        // Late writes through the recovered retained inode remain real evidence.
        w.p.fs.write_in_place(retained, b"late user write").unwrap();
        w.clock.advance(3_000);
        drop(s);
        s = w.open_with(next_launch_config(100));
        let observed = s.observe(None).unwrap();
        assert_eq!(observed.len(), 1);
        assert_eq!(text(&observed[0]), Some("late user write"));
        assert_eq!(observed[0].base, Some(revision(b"old")));
        assert!(w.p.fs.paths().contains(&retained.to_string()));
    }
}

#[test]
fn retention_next_launch_keeps_this_sessions_inode_and_preserves_late_write_on_reopen() {
    let w = World::new(ReplaceStrategy::Exchange, CaseSensitivity::Sensitive);
    let mut s = w.open_with(next_launch_config(100));
    publish(&mut s, write("a.md", RExpect::Absent, "old"));
    let inode = w.p.fs.ino("a.md").unwrap();
    publish(&mut s, write("a.md", rev("old"), "new"));
    w.clock.advance(3_000);
    assert!(s.observe(None).unwrap().is_empty());
    assert_eq!(w.p.fs.inode_bytes(inode), Some(b"old".to_vec()));
    assert_eq!(s.next_wakeup(), Some(10_000));
    w.p.fs.write_inode(inode, b"late user write");
    drop(s);
    let mut reopened = w.open_with(next_launch_config(100));
    let observed = reopened.observe(None).unwrap();
    assert_eq!(observed.len(), 1);
    assert_eq!(text(&observed[0]), Some("late user write"));
    assert_eq!(observed[0].base, Some(revision(b"old")));
    assert_eq!(reopened.stats.reclaimed, 0);
    assert_eq!(w.p.fs.inode_bytes(inode), Some(b"late user write".to_vec()));
    ack(&mut reopened, &observed);
    assert_eq!(w.p.fs.paths(), vec!["a.md".to_string()]);
}

#[test]
fn retention_cap_and_age_still_preserve_busy_or_changed_files_and_report_without_paths() {
    for cap in [0, 100] {
        let w = World::new(ReplaceStrategy::Exchange, CaseSensitivity::Sensitive);
        let mut s = w.open_with(next_launch_config(cap));
        publish(&mut s, write("private-name.md", RExpect::Absent, "old"));
        let inode = w.p.fs.open_fd("private-name.md").unwrap();
        publish(&mut s, write("private-name.md", rev("old"), "new"));
        w.clock.advance(if cap == 0 { 3_000 } else { 10_001 });
        assert!(s.observe(None).unwrap().is_empty());
        assert_eq!(w.p.fs.inode_bytes(inode), Some(b"old".to_vec()));
        assert_eq!(s.stats.reclaimed, 0);
        w.p.fs.write_inode(inode, b"late");
        w.p.fs.close_fd(inode);
        let observed = s.observe(None).unwrap();
        assert_eq!(observed.len(), 1);
        assert_eq!(text(&observed[0]), Some("late"));
        assert_eq!(s.stats.reclaimed, 1);
        let diagnostics = s.take_reclaimed();
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics[0].size, Some(3));
        assert!(!format!("{diagnostics:?}").contains("private-name"));
        assert!(s.take_reclaimed().is_empty());
        assert_eq!(w.p.fs.inode_bytes(inode), Some(b"late".to_vec()));
    }
}

#[test]
fn retention_session_exhaustion_and_future_rows_refuse_before_directory_io() {
    let w = World::new(ReplaceStrategy::Exchange, CaseSensitivity::Sensitive);
    w.db.clone()
        .apply(vec![(
            Kind::Counter,
            b"retention-session".to_vec(),
            Some(crate::codec::counter_bytes(u64::MAX)),
        )])
        .unwrap();
    let before = w.p.fs.ops();
    let result = FileStore::open(
        w.p.clone(),
        MemStore::shared(w.data.clone()),
        w.db.clone(),
        Box::new(w.clock.clone()),
        next_launch_config(100),
    );
    assert!(matches!(
        result,
        Err(mdbn_replica::store::StoreError::Corrupt(_))
    ));
    assert_eq!(w.p.fs.ops(), before);
    let w = World::new(ReplaceStrategy::Exchange, CaseSensitivity::Sensitive);
    let row = crate::codec::RetainedRec {
        r: crate::publish::Retained {
            path: RelPath::new(".mdbase/stash/1").unwrap(),
            expect: revision(b"old"),
        },
        user_path: "a.md".into(),
        since: 0,
        session: 1,
        size: Some(3),
        id: None,
    };
    w.db.clone()
        .apply(vec![(
            Kind::Retained,
            row.r.path.as_str().as_bytes().to_vec(),
            Some(row.to_bytes()),
        )])
        .unwrap();
    let before = w.p.fs.ops();
    let result = FileStore::open(
        w.p.clone(),
        MemStore::shared(w.data.clone()),
        w.db.clone(),
        Box::new(w.clock.clone()),
        next_launch_config(100),
    );
    assert!(matches!(
        result,
        Err(mdbn_replica::store::StoreError::Corrupt(_))
    ));
    assert_eq!(w.p.fs.ops(), before);
}

#[test]
fn stable_empty_edit_is_observed_after_one_quiet_recheck() {
    for explicit in [false, true] {
        let w = World::new(ReplaceStrategy::Exchange, CaseSensitivity::Sensitive);
        let mut s = w.open();
        assert!(publish(&mut s, write("empty.md", RExpect::Absent, "original\n")).is_empty());
        w.p.fs.write_in_place("empty.md", b"").unwrap();
        s.request_rescan();
        assert!(
            s.observe(None).unwrap().is_empty(),
            "a truncate is not immediately a stable empty edit"
        );
        assert_eq!(s.disk_revision("empty.md"), Some(revision(b"original\n")));
        w.clock.advance(99);
        assert!(
            s.observe(None).unwrap().is_empty(),
            "quiet window has not elapsed"
        );
        w.clock.advance(2);
        let paths = vec!["empty.md".to_string()];
        let obs = s.observe(explicit.then_some(paths.as_slice())).unwrap();
        assert_eq!(
            obs.len(),
            1,
            "stable empty file must not be deferred forever"
        );
        assert_eq!(text(&obs[0]), Some(""));
        assert_eq!(obs[0].base, Some(revision(b"original\n")));
        assert_eq!(
            s.disk_revision("empty.md"),
            Some(revision(b"original\n")),
            "only acknowledgement advances disk state"
        );
        ack(&mut s, &obs);
        assert_eq!(s.disk_revision("empty.md"), Some(revision(b"")));
        w.clock.advance(200);
        s.request_rescan();
        assert!(
            s.observe(None).unwrap().is_empty(),
            "acknowledged empty edit is not emitted twice"
        );
    }
}

#[test]
fn rescan_before_quiet_deadline_retains_dirty_recheck() {
    let w = World::new(ReplaceStrategy::Exchange, CaseSensitivity::Sensitive);
    let mut s = w.open();
    assert!(publish(&mut s, write("later.md", RExpect::Absent, "old\n")).is_empty());
    // A writer signals before finishing its write. A rescan still sees the old
    // bytes, but must retain the future quiet deadline for its final recheck.
    s.on_events(&[event("later.md")]);
    s.request_rescan();
    assert!(s.observe(None).unwrap().is_empty());
    w.clock.advance(50);
    w.p.fs.write_in_place("later.md", b"finished\n").unwrap();
    w.clock.advance(51);
    let obs = s.observe(None).unwrap();
    assert_eq!(obs.len(), 1, "rescan must not retire a future dirty marker");
    assert_eq!(text(&obs[0]), Some("finished\n"));
    assert_eq!(obs[0].base, Some(revision(b"old\n")));
}

#[test]
fn truncate_then_write_during_quiet_recheck_never_emits_empty() {
    let w = World::new(ReplaceStrategy::Exchange, CaseSensitivity::Sensitive);
    let mut s = w.open();
    assert!(publish(&mut s, write("edit.md", RExpect::Absent, "old\n")).is_empty());
    w.p.fs.write_in_place("edit.md", b"").unwrap();
    s.request_rescan();
    assert!(s.observe(None).unwrap().is_empty());
    w.clock.advance(50);
    w.p.fs.write_in_place("edit.md", b"replacement\n").unwrap();
    s.on_events(&[event("edit.md")]);
    w.clock.advance(99);
    assert!(s.observe(None).unwrap().is_empty());
    w.clock.advance(2);
    let obs = s.observe(None).unwrap();
    assert_eq!(obs.len(), 1);
    assert_eq!(text(&obs[0]), Some("replacement\n"));
    assert_eq!(obs[0].base, Some(revision(b"old\n")));
}

fn id(n: u8) -> Uuid {
    B16([n; 16])
}

fn write(path: &str, expect: RExpect, text: &str) -> Publish {
    Publish::Write {
        id: Some(id(1)),
        path: path.into(),
        expect,
        content: Content::Text(text.into()),
    }
}

fn rev(s: &str) -> RExpect {
    RExpect::Revision(revision(s.as_bytes()))
}

fn publish(s: &mut Fs, p: Publish) -> Vec<mdbn_replica::store::Drift> {
    s.commit(Tx {
        publish: vec![p],
        ..Tx::default()
    })
    .unwrap()
    .drifts
}

fn ack(s: &mut Fs, obs: &[Observation]) {
    s.commit(Tx {
        ack_observations: obs.iter().map(|o| o.token).collect(),
        ..Tx::default()
    })
    .unwrap();
}

fn text(o: &Observation) -> Option<&str> {
    match &o.now {
        Some(Observed::Text(t)) => Some(t),
        _ => None,
    }
}

fn event(path: &str) -> FileEvent {
    FileEvent {
        kind: FileEventKind::Changed,
        path: RelPath::new(path).unwrap(),
        id: None,
        cookie: None,
    }
}

const ALL: [ReplaceStrategy; 3] = [
    ReplaceStrategy::Exchange,
    ReplaceStrategy::LockedInPlace,
    ReplaceStrategy::GuardedInPlace,
];

#[test]
fn store_conformance() {
    mdbn_replica::conformance::run(|| {
        World::new(ReplaceStrategy::Exchange, CaseSensitivity::Sensitive).open()
    });
}

#[test]
fn inner_abort_cannot_certify_outer_file_durability() {
    let w = World::new(ReplaceStrategy::Exchange, CaseSensitivity::Sensitive);
    let mut s = w.open();
    s.inner().fail_commits(1);
    // Observing a binary file no longer commits anything to the inner store
    // (it is streamed as an attachment, never staged as a blob).
    w.p.fs.write_replace("photo.png", &[0xff]).unwrap();
    s.request_rescan();
    w.clock.advance(1000);
    s.observe(None).unwrap();
    let error = s.commit(Tx::default()).unwrap_err();
    assert!(
        matches!(error, mdbn_replica::store::StoreError::Io(_)),
        "the forwarding site must downgrade an inner strong abort"
    );
}

#[test]
fn publish_then_external_edit_round_trip() {
    for strategy in ALL {
        let w = World::new(strategy, CaseSensitivity::Sensitive);
        let mut s = w.open();
        assert!(s.observe(None).unwrap().is_empty());
        assert!(publish(&mut s, write("notes/a.md", RExpect::Absent, "hello\n")).is_empty());
        assert_eq!(w.p.fs.get("notes/a.md").unwrap(), b"hello\n");
        // Our own publish is not observed back.
        s.request_rescan();
        assert!(s.observe(None).unwrap().is_empty(), "{strategy:?}");

        assert!(
            publish(
                &mut s,
                write("notes/a.md", rev("hello\n"), "hello\nworld\n")
            )
            .is_empty()
        );
        w.p.fs
            .write_in_place("notes/a.md", b"hello\nworld\nuser\n")
            .unwrap();
        s.on_events(&[event("notes/a.md")]);
        assert!(
            s.observe(None).unwrap().is_empty(),
            "quiescence not over yet"
        );
        w.clock.advance(150);
        let obs = s.observe(None).unwrap();
        assert_eq!(obs.len(), 1, "{strategy:?} {obs:?}");
        assert_eq!(obs[0].base, Some(revision(b"hello\nworld\n")));
        assert_eq!(text(&obs[0]), Some("hello\nworld\nuser\n"));
        ack(&mut s, &obs);
        s.request_rescan();
        w.clock.advance(5_000);
        assert!(s.observe(None).unwrap().is_empty(), "{strategy:?}");
        // The next publish expects the ingested bytes.
        assert!(
            publish(
                &mut s,
                write("notes/a.md", rev("hello\nworld\nuser\n"), "v3\n")
            )
            .is_empty()
        );
        assert_eq!(w.p.fs.get("notes/a.md").unwrap(), b"v3\n");
    }
}

#[test]
fn drift_reports_and_keeps_user_bytes() {
    for strategy in ALL {
        let w = World::new(strategy, CaseSensitivity::Sensitive);
        let mut s = w.open();
        w.p.fs.write_in_place("a.md", b"user").unwrap();
        let d = publish(&mut s, write("a.md", rev("old"), "new"));
        assert_eq!(d.len(), 1, "{strategy:?}");
        assert_eq!(d[0].reason, "changed");
        assert_eq!(w.p.fs.get("a.md").unwrap(), b"user");
        let d = publish(&mut s, write("b.md", rev("old"), "new"));
        assert_eq!(d[0].reason, "missing", "{strategy:?}");
        let d = publish(&mut s, write("a.md", RExpect::Absent, "new"));
        assert_eq!(d.len(), 1, "{strategy:?}");
        assert_eq!(w.p.fs.get("a.md").unwrap(), b"user");
    }
}

#[test]
fn delete_needs_recheck_and_window() {
    let w = World::new(ReplaceStrategy::Exchange, CaseSensitivity::Sensitive);
    let mut s = w.open();
    publish(&mut s, write("a.md", RExpect::Absent, "x"));
    w.p.fs.unlink("a.md");
    s.on_events(&[event("a.md")]);
    w.clock.advance(150);
    assert!(
        s.observe(None).unwrap().is_empty(),
        "single missing is not a delete"
    );
    w.clock.advance(300);
    assert!(
        s.observe(None).unwrap().is_empty(),
        "confirmed, waiting for the move window"
    );
    w.clock.advance(3_000);
    let obs = s.observe(None).unwrap();
    assert_eq!(obs.len(), 1);
    assert_eq!(obs[0].now, None);
    assert_eq!(obs[0].base, Some(revision(b"x")));
    ack(&mut s, &obs);
    assert!(s.disk_state("a.md").is_none());
}

#[test]
fn vim_style_save_is_an_edit_not_a_delete() {
    let w = World::new(ReplaceStrategy::Exchange, CaseSensitivity::Sensitive);
    let mut s = w.open();
    publish(&mut s, write("a.md", RExpect::Absent, "x"));
    w.p.fs.rename_over("a.md", "a.md~");
    s.on_events(&[event("a.md")]);
    w.clock.advance(150);
    assert!(s.observe(None).unwrap().is_empty());
    w.p.fs.write_replace("a.md", b"x edited").unwrap();
    w.p.fs.unlink("a.md~");
    s.on_events(&[event("a.md")]);
    w.clock.advance(300);
    let obs = s.observe(None).unwrap();
    assert_eq!(obs.len(), 1, "{obs:?}");
    assert_eq!(text(&obs[0]), Some("x edited"));
    assert_eq!(obs[0].moved_from, None);
}

#[test]
fn moves_pair_by_content_and_by_file_id() {
    // Pure rename, and a rename with an edit (same inode).
    for edit in [false, true] {
        let w = World::new(ReplaceStrategy::Exchange, CaseSensitivity::Sensitive);
        let mut s = w.open();
        publish(
            &mut s,
            write("a.md", RExpect::Absent, "line one\nline two\n"),
        );
        w.p.fs.rename_over("a.md", "dir/b.md");
        if edit {
            w.p.fs
                .write_in_place("dir/b.md", b"line one\nline two\nthree\n")
                .unwrap();
        }
        s.on_events(&[event("a.md"), event("dir/b.md")]);
        w.clock.advance(150);
        let mut obs = s.observe(None).unwrap();
        w.clock.advance(300);
        obs.extend(s.observe(None).unwrap());
        assert_eq!(obs.len(), 1, "edit={edit} {obs:?}");
        assert_eq!(obs[0].path, "dir/b.md");
        assert_eq!(obs[0].moved_from.as_deref(), Some("a.md"));
        assert_eq!(obs[0].base, Some(revision(b"line one\nline two\n")));
        ack(&mut s, &obs);
        assert!(s.disk_state("a.md").is_none());
        assert!(s.disk_state("dir/b.md").is_some());
    }
}

#[test]
fn copy_is_a_create() {
    let w = World::new(ReplaceStrategy::Exchange, CaseSensitivity::Sensitive);
    let mut s = w.open();
    publish(&mut s, write("a.md", RExpect::Absent, "same"));
    w.p.fs.write_replace("b.md", b"same").unwrap();
    s.on_events(&[event("b.md")]);
    w.clock.advance(150);
    assert!(
        s.observe(None).unwrap().is_empty(),
        "could be a move: waits"
    );
    w.clock.advance(3_000);
    let obs = s.observe(None).unwrap();
    assert_eq!(obs.len(), 1);
    assert_eq!(obs[0].path, "b.md");
    assert_eq!(obs[0].base, None);
    assert_eq!(obs[0].moved_from, None);
}

#[test]
fn late_write_into_displaced_inode_is_observed() {
    let w = World::new(ReplaceStrategy::Exchange, CaseSensitivity::Sensitive);
    let mut s = w.open();
    publish(&mut s, write("a.md", RExpect::Absent, "v1"));
    let old = w.p.fs.ino("a.md").unwrap();
    publish(&mut s, write("a.md", rev("v1"), "v2"));
    // An editor that opened the file before the swap saves into the old inode.
    w.p.fs.write_inode(old, b"v1 plus typing");
    w.clock.advance(2_100);
    let obs = s.observe(None).unwrap();
    assert_eq!(obs.len(), 1, "{obs:?}");
    assert_eq!(obs[0].path, "a.md");
    assert_eq!(obs[0].base, Some(revision(b"v1")));
    assert_eq!(text(&obs[0]), Some("v1 plus typing"));
    assert_eq!(obs[0].provenance, Provenance::Normal);
    ack(&mut s, &obs);
    // Evidence released: only the user file remains.
    assert_eq!(w.p.fs.paths(), vec!["a.md".to_string()]);
}

#[test]
fn crash_mid_publish_recovers_on_reopen() {
    for strategy in ALL {
        for k in 0..12 {
            let w = World::new(strategy, CaseSensitivity::Sensitive);
            let mut s = w.open();
            publish(&mut s, write("a.md", RExpect::Absent, "old"));
            w.p.fs.crash_at(w.p.fs.ops() + k);
            let r = s.commit(Tx {
                publish: vec![write("a.md", rev("old"), "new")],
                ..Tx::default()
            });
            drop(s);
            w.p.fs.restart();
            let mut s = w.open();
            let at = w.p.fs.get("a.md").unwrap();
            assert!(
                at == b"old" || at == b"new",
                "{strategy:?} k={k} {r:?} {at:?}"
            );
            w.clock.advance(5_000);
            let obs = s.observe(None).unwrap();
            assert!(obs.is_empty(), "{strategy:?} k={k}: {obs:?}");
            // Whatever state it is in, the next publish against it works.
            let cur = String::from_utf8(at).unwrap();
            assert!(
                publish(&mut s, write("a.md", rev(&cur), "next")).is_empty(),
                "{strategy:?} k={k}"
            );
            w.clock.advance(5_000);
            s.observe(None).unwrap();
            assert_eq!(
                w.p.fs.paths(),
                vec!["a.md".to_string()],
                "{strategy:?} k={k}"
            );
        }
    }
}

#[test]
fn move_publish_and_case_only_rename() {
    for strategy in [ReplaceStrategy::Exchange, ReplaceStrategy::LockedInPlace] {
        let w = World::new(strategy, CaseSensitivity::Insensitive);
        let mut s = w.open();
        publish(&mut s, write("a.md", RExpect::Absent, "body"));
        let mv = |from: &str, to: &str| Publish::Move {
            id: id(1),
            from: from.into(),
            to: to.into(),
            expect: rev("body"),
            content: None,
        };
        assert!(
            publish(&mut s, mv("a.md", "dir/b.md")).is_empty(),
            "{strategy:?}"
        );
        assert!(w.p.fs.paths().contains(&"dir/b.md".to_string()));
        assert!(!w.p.fs.paths().contains(&"a.md".to_string()));
        assert!(
            publish(&mut s, mv("dir/b.md", "dir/B.md")).is_empty(),
            "{strategy:?}"
        );
        assert!(
            w.p.fs.paths().contains(&"dir/B.md".to_string()),
            "{:?}",
            w.p.fs.paths()
        );
        assert!(!w.p.fs.paths().contains(&"dir/b.md".to_string()));
        w.clock.advance(5_000);
        s.request_rescan();
        assert!(s.observe(None).unwrap().is_empty(), "{strategy:?}");
        assert_eq!(w.p.fs.paths(), vec!["dir/B.md".to_string()]);
    }
}

#[test]
fn private_and_hidden_paths_are_ignored() {
    let w = World::new(ReplaceStrategy::Exchange, CaseSensitivity::Sensitive);
    let mut s = w.open();
    w.p.fs.write_in_place(".obsidian/app.json", b"{}").unwrap();
    w.p.fs.write_in_place(".mdbase/tmp/99", b"x").unwrap();
    w.p.fs.write_in_place("n.md", b"note").unwrap();
    let obs = s.observe(None).unwrap();
    assert_eq!(obs.len(), 1);
    assert_eq!(obs[0].path, "n.md");
}

#[test]
fn sec033_non_portable_paths_are_never_published() {
    let w = World::new(ReplaceStrategy::Exchange, CaseSensitivity::Insensitive);
    let mut s = w.open();
    for bad in [
        ".obsidian/plugins/x/main.js",
        ".MDBASE/stash/1",
        ".mdbase./x",
        "C:evil.md",
        "CON.md",
        "a/.git/hooks/pre-commit",
    ] {
        let d = publish(&mut s, write(bad, RExpect::Absent, "payload"));
        assert_eq!(d.len(), 1, "{bad}");
        assert_eq!(d[0].reason, "invalid_path", "{bad}");
    }
    assert!(w.p.fs.paths().is_empty(), "{:?}", w.p.fs.paths());
}

/// Crash at op `k` of a publish of "new" over "old" at `path`. If op `k` is the
/// in-place write itself, emulate the write having landed before the process
/// died (the in-memory platform fails crashed ops without effect).
fn crash_publish_at(w: &World, s: &mut Fs, path: &str, k: u64) {
    let base = w.p.fs.ops();
    w.p.fs.crash_at(base + k);
    let _ = s.commit(Tx {
        publish: vec![write(path, rev("old"), "new")],
        ..Tx::default()
    });
    w.p.fs.restart();
    let crashed_write = w.p.fs.log().iter().any(|l| {
        l.starts_with(&format!("{} ", base + k))
            && (l.contains("locked_overwrite") || l.contains("guarded_replace"))
    });
    if crashed_write {
        w.p.fs.write_in_place(path, b"new").unwrap();
    }
}

/// A publish recovered as done is made durable before its
/// bytes are recorded as known: the directory entry for a swap, the file data
/// for an in-place write; then one device-level commit point.
#[test]
fn recovered_publish_is_flushed_before_it_is_recorded() {
    for (strategy, want) in [
        (ReplaceStrategy::Exchange, "flush Dir("),
        (ReplaceStrategy::LockedInPlace, "flush File("),
        (ReplaceStrategy::GuardedInPlace, "flush File("),
    ] {
        let mut checked = 0;
        for k in 0..12 {
            let w = World::new(strategy, CaseSensitivity::Sensitive);
            let mut s = w.open();
            publish(&mut s, write("d/a.md", RExpect::Absent, "old"));
            crash_publish_at(&w, &mut s, "d/a.md", k);
            drop(s);
            let before = w.p.fs.log().len();
            let s = w.open();
            if w.p.fs.get("d/a.md").as_deref() != Some(b"new") || s.stats.recovered == 0 {
                continue;
            }
            let after: Vec<String> = w.p.fs.log()[before..].to_vec();
            assert!(
                after.iter().any(|l| l.contains(want)),
                "{strategy:?} k={k}: {after:?}"
            );
            assert!(
                after.iter().any(|l| l.contains("flush Full")),
                "{strategy:?} k={k}: {after:?}"
            );
            checked += 1;
        }
        assert!(
            checked > 0,
            "{strategy:?}: no crash point recovered a publish"
        );
    }
}

/// A failed device-level commit point cannot retire the recovery intent or
/// record new bytes as known, even if File/Dir fsync succeeded. Reopen retries;
/// if the drive cache rolled back, the old disk view still triggers replica
/// reconciliation rather than treating the rollback as an external user edit.
#[test]
fn failed_full_recovery_flush_keeps_intents_for_retry() {
    for strategy in ALL {
        for power_loss in [false, true] {
            let mut checked = 0;
            for k in 0..12 {
                let w = World::new(strategy, CaseSensitivity::Sensitive);
                let mut s = w.open();
                publish(&mut s, write("a.md", RExpect::Absent, "old"));
                crash_publish_at(&w, &mut s, "a.md", k);
                drop(s);
                let before = w.db.load().unwrap();
                if w.p.fs.get("a.md").as_deref() != Some(b"new")
                    || !before.iter().any(|(kind, _, _)| *kind == Kind::Intent)
                {
                    continue;
                }
                let log_start = w.p.fs.log().len();
                w.p.fs.set_fail_full_flushes(true);
                let opened = FileStore::open(
                    w.p.clone(),
                    MemStore::shared(w.data.clone()),
                    w.db.clone(),
                    Box::new(w.clock.clone()),
                    Config::default(),
                );
                assert!(opened.is_err(), "{strategy:?} k={k}: Full must fail open");
                let log = w.p.fs.log();
                let recovery = &log[log_start..];
                assert!(
                    recovery
                        .iter()
                        .any(|l| l.contains("flush File(") || l.contains("flush Dir(")),
                    "{strategy:?} k={k}: {recovery:?}"
                );
                assert!(
                    recovery.iter().any(|l| l.contains("flush Full")),
                    "{strategy:?} k={k}: {recovery:?}"
                );
                assert_eq!(
                    w.db.load().unwrap(),
                    before,
                    "{strategy:?} k={k}: no known-byte/intent batch may commit"
                );
                w.p.fs.set_fail_full_flushes(false);
                if power_loss {
                    // Emulate a drive-cache rollback after failed Full. File
                    // and directory fsync alone did not guarantee these bytes.
                    w.p.fs.write_in_place("a.md", b"old").unwrap();
                }
                let mut s = w.open();
                if power_loss {
                    assert_eq!(
                        s.disk_revision("a.md"),
                        Some(revision(b"old")),
                        "{strategy:?} k={k}: rollback must not be trusted as new"
                    );
                    // The replica reconciles its confirmed new row against
                    // this old disk revision and republishes it, not vice versa.
                    assert!(publish(&mut s, write("a.md", rev("old"), "new")).is_empty());
                }
                assert_eq!(w.p.fs.get("a.md").as_deref(), Some(b"new".as_slice()));
                assert_eq!(s.disk_revision("a.md"), Some(revision(b"new")));
                drop(s);
                assert!(
                    !w.db
                        .load()
                        .unwrap()
                        .iter()
                        .any(|(kind, _, _)| *kind == Kind::Intent)
                );
                assert_eq!(w.open().disk_revision("a.md"), Some(revision(b"new")));
                checked += 1;
            }
            assert!(checked > 0, "{strategy:?}: no failed-Full recovery checked");
        }
    }
}

/// A recovery flush that fails (e.g. a sharing violation on Windows) does not
/// stop the store opening, and the bytes are not recorded as known: the path
/// is re-observed instead of trusted.
#[test]
fn failed_recovery_flush_is_not_fatal() {
    let mut checked = 0;
    for k in 0..12 {
        let w = World::new(ReplaceStrategy::LockedInPlace, CaseSensitivity::Sensitive);
        let mut s = w.open();
        publish(&mut s, write("a.md", RExpect::Absent, "old"));
        crash_publish_at(&w, &mut s, "a.md", k);
        drop(s);
        if w.p.fs.get("a.md").as_deref() != Some(b"new") {
            continue;
        }
        w.p.fs.set_fail_flushes(true);
        let s = FileStore::open(
            w.p.clone(),
            MemStore::shared(w.data.clone()),
            w.db.clone(),
            Box::new(w.clock.clone()),
            Config::default(),
        )
        .expect("a failed recovery flush must not stop the store opening");
        w.p.fs.set_fail_flushes(false);
        if s.stats.recovered == 0 {
            continue;
        }
        assert_ne!(
            s.disk_state("a.md").map(|d| d.rev),
            Some(revision(b"new")),
            "k={k}: unflushed bytes must not be recorded as known"
        );
        checked += 1;
    }
    assert!(checked > 0);
}

/// The replica reconciles the folder at open from these disk-state queries,
/// including recovery after a crash.
#[test]
fn store_reports_disk_state_through_the_trait() {
    let w = World::new(ReplaceStrategy::Exchange, CaseSensitivity::Sensitive);
    let mut s = w.open();
    publish(&mut s, write("b.md", RExpect::Absent, "b"));
    publish(&mut s, write("a.md", RExpect::Absent, "a"));
    let st: &dyn Store = &s;
    assert_eq!(st.disk_revision("a.md").unwrap(), Some(revision(b"a")));
    assert_eq!(st.disk_revision("c.md").unwrap(), None);
    assert_eq!(
        st.disk_paths().unwrap(),
        vec![
            ("a.md".to_string(), revision(b"a")),
            ("b.md".to_string(), revision(b"b"))
        ]
    );
    drop(s);
    let s = w.open();
    assert_eq!(
        Store::disk_paths(&s).unwrap().len(),
        2,
        "persisted across reopen"
    );
}

/// Non-portable paths found on disk are ignored by ingest,
/// never reported (so never held).
#[test]
fn ingest_ignores_non_portable_paths() {
    let w = World::new(ReplaceStrategy::Exchange, CaseSensitivity::Sensitive);
    let mut s = w.open();
    for p in [
        "GIT~1/config",
        "a\u{200c}.md",
        "CON.md",
        "q?.md",
        "dir /a.md",
        ".obsidian/x.json",
    ] {
        w.p.fs.write_in_place(p, b"x").unwrap();
    }
    w.p.fs.write_in_place("ok.md", b"fine").unwrap();
    let obs = s.observe(None).unwrap();
    let paths: Vec<&str> = obs.iter().map(|o| o.path.as_str()).collect();
    assert_eq!(paths, vec!["ok.md"]);
}

// ---------------------------------------------------------------- attachment-v1 files

fn key(n: u8) -> mdbn_replica::store::StageKey {
    mdbn_replica::store::StageKey {
        file: id(n),
        manifest: mdbn_wire::common::B32([n; 32]),
    }
}

/// Stage `bytes` in pieces of `piece`, as the replica does chunk by chunk.
fn stage(s: &mut Fs, k: &mdbn_replica::store::StageKey, bytes: &[u8], piece: usize) {
    let mut at = 0;
    for p in bytes.chunks(piece) {
        s.attachment_stage(k, at as u64, p).unwrap();
        at += p.len();
        assert_eq!(
            s.attachment_staged(k).unwrap(),
            at as u64,
            "durable resume point"
        );
    }
}

#[test]
fn attachment_files_are_staged_placed_moved_and_removed_without_echo() {
    for strategy in [ReplaceStrategy::Exchange, ReplaceStrategy::LockedInPlace] {
        let w = World::new(strategy, CaseSensitivity::Sensitive);
        let mut s = w.open();
        assert!(s.materializes_attachments());
        assert!(s.observe(None).unwrap().is_empty());
        let v1: Vec<u8> = (0..10_000u32).map(|i| (i % 251) as u8).collect();
        let k1 = key(1);
        stage(&mut s, &k1, &v1, 4096);
        // Staging lives in the private directory: never observed.
        s.request_rescan();
        assert!(s.observe(None).unwrap().is_empty(), "{strategy:?}");
        let r1 = revision(&v1);
        assert_eq!(
            s.attachment_publish(&k1, r1, "media/a.bin", RExpect::Absent)
                .unwrap(),
            None
        );
        assert_eq!(w.p.fs.get("media/a.bin").unwrap(), v1);
        assert_eq!(s.attachment_staged(&k1).unwrap(), 0, "staging consumed");
        assert_eq!(Store::disk_revision(&s, "media/a.bin").unwrap(), Some(r1));
        // Echo fence: our own placement is not observed back.
        s.request_rescan();
        assert!(s.observe(None).unwrap().is_empty(), "{strategy:?}");

        // Replace with a new version, conditional on the old one.
        let v2 = b"version two".to_vec();
        let k2 = key(2);
        stage(&mut s, &k2, &v2, 4);
        let r2 = revision(&v2);
        assert_eq!(
            s.attachment_publish(&k2, r2, "media/a.bin", RExpect::Revision(r1))
                .unwrap(),
            None,
            "{strategy:?}"
        );
        assert_eq!(w.p.fs.get("media/a.bin").unwrap(), v2);
        s.request_rescan();
        assert!(s.observe(None).unwrap().is_empty(), "{strategy:?}");

        // Rename: the same inode moves, nothing is rewritten.
        let ino = w.p.fs.ino("media/a.bin");
        assert_eq!(
            s.attachment_move(id(1), "media/a.bin", "media/b/a.bin", r2)
                .unwrap(),
            None
        );
        assert_eq!(w.p.fs.get("media/a.bin"), None);
        assert_eq!(w.p.fs.ino("media/b/a.bin"), ino);
        assert_eq!(Store::disk_revision(&s, "media/a.bin").unwrap(), None);
        assert_eq!(Store::disk_revision(&s, "media/b/a.bin").unwrap(), Some(r2));
        s.request_rescan();
        w.clock.advance(10_000);
        assert!(s.observe(None).unwrap().is_empty(), "{strategy:?}");

        // Delete = unlink, only of the expected bytes.
        assert_eq!(
            s.attachment_remove(id(1), "media/b/a.bin", r2).unwrap(),
            None
        );
        assert_eq!(w.p.fs.get("media/b/a.bin"), None);
        assert_eq!(Store::disk_revision(&s, "media/b/a.bin").unwrap(), None);
        s.request_rescan();
        w.clock.advance(10_000);
        assert!(s.observe(None).unwrap().is_empty(), "{strategy:?}");
    }
}

#[test]
fn attachment_operations_never_clobber_user_bytes() {
    for strategy in [ReplaceStrategy::Exchange, ReplaceStrategy::LockedInPlace] {
        let w = World::new(strategy, CaseSensitivity::Sensitive);
        let mut s = w.open();
        let v1 = b"ours".to_vec();
        let r1 = revision(&v1);
        let k = key(1);
        stage(&mut s, &k, &v1, 2);
        // A user file already at the path: the create drifts, staging is kept.
        w.p.fs.write_replace("a.bin", b"user").unwrap();
        assert_eq!(
            s.attachment_publish(&k, r1, "a.bin", RExpect::Absent)
                .unwrap()
                .as_deref(),
            Some("changed")
        );
        assert_eq!(w.p.fs.get("a.bin").unwrap(), b"user");
        assert_eq!(s.attachment_staged(&k).unwrap(), 4);
        // Replace, remove and move all check the expected revision first.
        assert_eq!(
            s.attachment_publish(&k, r1, "a.bin", RExpect::Revision(revision(b"old")))
                .unwrap()
                .as_deref(),
            Some("changed")
        );
        assert_eq!(
            s.attachment_remove(id(1), "a.bin", revision(b"old"))
                .unwrap()
                .as_deref(),
            Some("changed")
        );
        assert_eq!(
            s.attachment_move(id(1), "a.bin", "b.bin", revision(b"old"))
                .unwrap()
                .as_deref(),
            Some("changed")
        );
        assert_eq!(w.p.fs.get("a.bin").unwrap(), b"user");
        assert_eq!(w.p.fs.get("b.bin"), None);
        // Restaging from zero starts over; unstage drops it.
        s.attachment_stage(&k, 0, b"x").unwrap();
        assert_eq!(s.attachment_staged(&k).unwrap(), 1);
        assert!(
            s.attachment_stage(&k, 5, b"gap").is_err(),
            "contiguous only"
        );
        s.attachment_unstage(&k).unwrap();
        assert_eq!(s.attachment_staged(&k).unwrap(), 0);
    }
}

#[test]
fn the_vault_strategy_does_not_materialize_attachments() {
    let w = World::new(ReplaceStrategy::GuardedInPlace, CaseSensitivity::Sensitive);
    let s = w.open();
    assert!(!s.materializes_attachments());
}

// ---------------------------------------------------------------- attachment ingest (T6)

fn attachment(o: &Observation) -> Option<(mdbn_wire::common::Hash, u64, AttachmentClass)> {
    match &o.now {
        Some(Observed::Attachment {
            digest,
            size,
            class,
        }) => Some((*digest, *size, *class)),
        _ => None,
    }
}

/// Observe after the quiet and move windows.
fn settle_obs(w: &World, s: &mut Fs) -> Vec<Observation> {
    let mut obs = s.observe(None).unwrap();
    w.clock.advance(3_500);
    obs.extend(s.observe(None).unwrap());
    obs
}

#[test]
fn ingest_classifies_text_records_attachments_and_oversized_markdown() {
    let w = World::new(ReplaceStrategy::Exchange, CaseSensitivity::Sensitive);
    let cap = crate::store::RECORD_CAP_BYTES as usize;
    let small_md = "# note\n".repeat(10);
    let at_cap = "a".repeat(cap);
    let over_cap = "b".repeat(cap + 1);
    let yaml = "k: v\n";
    let bin = [0u8, 1, 2, 255];
    let bad_md = [b'#', b' ', 0xff, 0xfe];
    w.p.fs
        .write_replace("notes/a.md", small_md.as_bytes())
        .unwrap();
    w.p.fs
        .write_replace("notes/cap.md", at_cap.as_bytes())
        .unwrap();
    w.p.fs
        .write_replace("notes/big.md", over_cap.as_bytes())
        .unwrap();
    w.p.fs
        .write_replace("types/t.yaml", yaml.as_bytes())
        .unwrap();
    w.p.fs.write_replace("media/x.bin", &bin).unwrap();
    w.p.fs.write_replace("notes/bad.md", &bad_md).unwrap();
    let mut s = w.open();
    let obs = settle_obs(&w, &mut s);
    let get = |p: &str| obs.iter().find(|o| o.path == p).expect(p);
    assert_eq!(text(get("notes/a.md")), Some(small_md.as_str()));
    assert_eq!(
        text(get("notes/cap.md")).map(str::len),
        Some(cap),
        "exactly the cap is still a record"
    );
    assert_eq!(text(get("types/t.yaml")), Some(yaml));
    assert_eq!(
        attachment(get("notes/big.md")),
        Some((
            revision(over_cap.as_bytes()),
            cap as u64 + 1,
            AttachmentClass::OversizedMarkdown
        ))
    );
    assert_eq!(
        attachment(get("media/x.bin")),
        Some((revision(&bin), 4, AttachmentClass::Ordinary))
    );
    assert_eq!(
        attachment(get("notes/bad.md")),
        Some((revision(&bad_md), 4, AttachmentClass::Ordinary)),
        "undecodable text is not a record"
    );
    // Large files never reach the inner store's blob cache.
    assert_eq!(s.blob_size(&revision(&bin)).unwrap(), None);
    assert_eq!(s.stats.files_streamed, 2);
}

#[test]
fn a_50_mb_file_is_hashed_and_read_in_bounded_pieces_never_whole() {
    let w = World::new(ReplaceStrategy::Exchange, CaseSensitivity::Sensitive);
    const LEN: u64 = 50 << 20;
    let ino = w.p.fs.write_synthetic("media/video.mp4", LEN);
    let mut s = w.open();
    let obs = settle_obs(&w, &mut s);
    assert_eq!(obs.len(), 1);
    let (digest, size, class) = attachment(&obs[0]).expect("attachment");
    assert_eq!((size, class), (LEN, AttachmentClass::Ordinary));
    // The expected hash, computed in the same bounded pieces.
    let mut h = mdbn_replica::attachments::WholeFileHasher::default();
    let mut at = 0;
    while at < LEN {
        let b = w.p.fs.synthetic_range(ino, at, 1 << 20);
        at += b.len() as u64;
        h.update(&b);
    }
    assert_eq!(digest, h.finish());
    assert_eq!(w.p.fs.synthetic_whole_reads(), 0, "never read whole");
    assert!(w.p.fs.max_ranged_read() <= crate::platform::MAX_READ_AT as usize);
    assert_eq!(w.p.fs.open_ranges(), 0, "the handle is closed");

    // The upload source streams it the same way, and is refused once the file
    // changes under it.
    let mut src = s
        .attachment_source("media/video.mp4", LEN)
        .unwrap()
        .expect("source");
    assert_eq!(src.len(), LEN);
    let mut buf = vec![0u8; 8 << 20];
    let mut h = mdbn_replica::attachments::WholeFileHasher::default();
    let mut at = 0;
    while at < LEN {
        let n = (LEN - at).min(buf.len() as u64) as usize;
        src.read_at(at, &mut buf[..n]).unwrap();
        h.update(&buf[..n]);
        at += n as u64;
    }
    assert_eq!(h.finish(), digest);
    assert!(src.read_at(LEN - 1, &mut buf[..2]).is_err(), "past the end");
    assert!(
        src.read_at(0, &mut vec![0u8; (8 << 20) + 1]).is_err(),
        "over 8 MiB"
    );
    w.p.fs.write_inode(ino, b"replaced");
    assert!(src.read_at(0, &mut buf[..4]).is_err(), "source_changed");
    drop(src);
    assert_eq!(w.p.fs.open_ranges(), 0);
    assert_eq!(w.p.fs.synthetic_whole_reads(), 0);
    assert!(
        s.attachment_source("media/video.mp4", LEN)
            .unwrap()
            .is_none(),
        "a size change is refused up front"
    );
}

#[test]
fn an_attachment_rename_pairs_as_a_move_without_reading_it_whole() {
    let w = World::new(ReplaceStrategy::Exchange, CaseSensitivity::Sensitive);
    w.p.fs.write_synthetic("media/a.bin", 20 << 20);
    let mut s = w.open();
    let obs = settle_obs(&w, &mut s);
    let (digest, _, _) = attachment(&obs[0]).unwrap();
    ack(&mut s, &obs);
    assert_eq!(s.disk_revision("media/a.bin"), Some(digest));

    w.p.fs.rename_over("media/a.bin", "media/b.bin");
    s.on_events(&[event("media/a.bin"), event("media/b.bin")]);
    w.clock.advance(150);
    let mut obs = s.observe(None).unwrap();
    w.clock.advance(300);
    obs.extend(s.observe(None).unwrap());
    assert_eq!(obs.len(), 1, "{obs:?}");
    assert_eq!(obs[0].path, "media/b.bin");
    assert_eq!(obs[0].moved_from.as_deref(), Some("media/a.bin"));
    assert_eq!(obs[0].base, Some(digest));
    assert_eq!(attachment(&obs[0]).map(|a| a.0), Some(digest));
    ack(&mut s, &obs);
    assert_eq!(s.disk_revision("media/b.bin"), Some(digest));
    assert_eq!(s.disk_revision("media/a.bin"), None);
    assert_eq!(w.p.fs.synthetic_whole_reads(), 0);
}

/// A deferred-durability window covers plain commits (ingest acknowledgements)
/// and is closed, as a barrier, before anything touches files: a publish, an
/// observe (retained/move settlement), or the caller closing it.
#[test]
fn deferred_window_closes_before_outside_effects() {
    let w = World::new(ReplaceStrategy::Exchange, CaseSensitivity::Sensitive);
    let mut s = w.open();
    w.p.fs.write_in_place("a.md", b"one\n").unwrap();
    w.p.fs.write_in_place("b.md", b"two\n").unwrap();
    let obs = s.observe(None).unwrap();
    assert_eq!(obs.len(), 2);

    s.defer_durability(true).unwrap();
    assert!(w.data.borrow().deferred);
    ack(&mut s, &obs[..1]);
    assert!(
        w.data.borrow().deferred,
        "a plain acknowledgement stays deferred"
    );
    assert!(publish(&mut s, write("c.md", RExpect::Absent, "three\n")).is_empty());
    assert!(
        !w.data.borrow().deferred,
        "a publish closes the window first"
    );
    assert_eq!(w.data.borrow().windows, (1, 1));

    s.defer_durability(true).unwrap();
    ack(&mut s, &obs[1..]);
    s.request_rescan();
    assert!(s.observe(None).unwrap().is_empty());
    assert!(!w.data.borrow().deferred, "observe closes the window first");

    s.defer_durability(true).unwrap();
    s.defer_durability(false).unwrap();
    s.defer_durability(false).unwrap();
    assert_eq!(w.data.borrow().windows, (3, 3));
}

/// A disk database that does not follow the window (an independent one, say)
/// keeps every commit durable: no window opens. One that follows is closed
/// after the inner store, so acknowledgements never outlive their commits.
#[test]
fn deferred_window_needs_a_following_disk_db_and_closes_inner_first() {
    struct Db {
        rows: MemDiskDb,
        follows: bool,
        inner: Rc<RefCell<MemData>>,
        closes: Rc<RefCell<Vec<bool>>>,
    }
    impl DiskDb for Db {
        fn load(&self) -> Result<Vec<crate::diskdb::Row>, crate::diskdb::DbError> {
            self.rows.load()
        }
        fn apply(
            &mut self,
            changes: Vec<crate::diskdb::Change>,
        ) -> Result<(), crate::diskdb::DbError> {
            self.rows.apply(changes)
        }
        fn defer_sync(&mut self, on: bool) -> Result<bool, crate::diskdb::DbError> {
            if !on {
                // Recorded: was the inner store's window already closed?
                self.closes.borrow_mut().push(!self.inner.borrow().deferred);
            }
            Ok(self.follows)
        }
    }
    for follows in [false, true] {
        let w = World::new(ReplaceStrategy::Exchange, CaseSensitivity::Sensitive);
        let closes = Rc::new(RefCell::new(Vec::new()));
        let mut s = FileStore::open(
            w.p.clone(),
            MemStore::shared(w.data.clone()),
            Db {
                rows: w.db.clone(),
                follows,
                inner: w.data.clone(),
                closes: closes.clone(),
            },
            Box::new(w.clock.clone()),
            Config::default(),
        )
        .unwrap();
        w.p.fs.write_in_place("a.md", b"one\n").unwrap();
        let obs = s.observe(None).unwrap();
        s.defer_durability(true).unwrap();
        assert_eq!(w.data.borrow().deferred, follows);
        s.commit(Tx {
            ack_observations: obs.iter().map(|o| o.token).collect(),
            ..Tx::default()
        })
        .unwrap();
        s.defer_durability(false).unwrap();
        assert!(!w.data.borrow().deferred);
        if follows {
            assert_eq!(*closes.borrow(), vec![true], "inner closes first");
        } else {
            assert_eq!(w.data.borrow().windows, (0, 0), "no window opened");
        }
    }
}

/// An attachment the replica leaves unacknowledged (local-only) is re-offered
/// by every full scan and after a reopen, but hashed again only when its size,
/// times or file ID change: an outside edit while closed is still seen, a
/// delete drops the memo.
#[test]
fn unacknowledged_attachments_are_not_rehashed_until_they_change() {
    let w = World::new(ReplaceStrategy::Exchange, CaseSensitivity::Sensitive);
    w.p.fs.write_replace("media/x.bin", &[1u8; 64]).unwrap();
    w.p.fs.write_replace("media/y.bin", &[2u8; 64]).unwrap();
    let mut s = w.open();
    let obs = settle_obs(&w, &mut s);
    assert_eq!(obs.len(), 2);
    assert_eq!(s.stats.files_streamed, 2);
    s.request_rescan();
    assert!(s.observe(None).unwrap().is_empty(), "still outstanding");
    assert_eq!(s.stats.files_streamed, 2, "a rescan reuses the hashes");
    drop(s);

    // Reopen (memo persisted): both are re-offered without hashing.
    let mut s = w.open();
    let obs = settle_obs(&w, &mut s);
    assert_eq!(obs.len(), 2);
    assert_eq!(attachment(&obs[0]).map(|a| a.0), Some(revision(&[1u8; 64])));
    assert_eq!(s.stats.files_streamed, 0);
    assert_eq!(s.stats.hashes_reused, 2);
    drop(s);

    // Changed while closed (same size, new bytes and times): hashed again.
    w.p.fs.write_in_place("media/x.bin", &[3u8; 64]).unwrap();
    w.p.fs.unlink("media/y.bin");
    let mut s = w.open();
    let obs = settle_obs(&w, &mut s);
    let x = obs.iter().find(|o| o.path == "media/x.bin").unwrap();
    assert_eq!(attachment(x).map(|a| a.0), Some(revision(&[3u8; 64])));
    assert_eq!(s.stats.files_streamed, 1);
    assert!(
        !w.db
            .load()
            .unwrap()
            .iter()
            .any(|(k, p, _)| *k == Kind::Seen && p == b"media/y.bin"),
        "a deleted file's memo is dropped"
    );
}

/// `SqlDiskDb` follows a window only when its index backend supports one: over
/// a backend that keeps every transaction durable (wasm, DO, any default
/// `IndexStorage`), no window opens and the inner store stays durable too.
#[test]
fn sql_disk_db_follows_only_a_backend_that_defers() {
    use crate::diskdb::SqlDiskDb;
    use crate::index::{Batch, IndexError, IndexInfo, IndexStorage, StmtResult};
    struct Stub(bool);
    impl IndexStorage for Stub {
        fn info(&self) -> IndexInfo {
            IndexInfo {
                durability: crate::index::IndexDurability::Durable,
                opened: crate::index::OpenState::Fresh,
                sqlite_version: 3_045_000,
            }
        }
        fn run(&mut self, batch: &Batch) -> Result<Vec<StmtResult>, IndexError> {
            Ok(vec![StmtResult::default(); batch.stmts.len()])
        }
        fn reset(&mut self) -> Result<(), IndexError> {
            Ok(())
        }
        fn defer_sync(&mut self, _on: bool) -> Result<bool, IndexError> {
            Ok(self.0)
        }
    }
    for supports in [false, true] {
        let w = World::new(ReplaceStrategy::Exchange, CaseSensitivity::Sensitive);
        let db = SqlDiskDb::open(Rc::new(RefCell::new(Stub(supports)))).unwrap();
        let mut s = FileStore::open(
            w.p.clone(),
            MemStore::shared(w.data.clone()),
            db,
            Box::new(w.clock.clone()),
            Config::default(),
        )
        .unwrap();
        s.defer_durability(true).unwrap();
        assert_eq!(w.data.borrow().deferred, supports, "supports={supports}");
        s.defer_durability(false).unwrap();
        assert!(!w.data.borrow().deferred);
    }
}
