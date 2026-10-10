//! Publish, settle and recovery against the in-memory platform, including a
//! user write injected before every operation and a crash at every operation.

use std::rc::Rc;

use crate::exec::{Timers, run_ready};
use crate::platform::{CaseSensitivity, FilePlatform, LockShare, RelPath, ReplaceStrategy};
use crate::publish::{Expect, Names, Options, Outcome, PublishOp, Retained, publish, revision};
use crate::recover::{Intent, State, recover};
use crate::stash::{Settled, settle};
use crate::testing::{MemFs, MemPlatform};

const STRATEGIES: [ReplaceStrategy; 3] = [
    ReplaceStrategy::Exchange,
    ReplaceStrategy::LockedInPlace,
    ReplaceStrategy::GuardedInPlace,
];

fn rp(s: &str) -> RelPath {
    RelPath::new(s).unwrap()
}

fn setup(strategy: ReplaceStrategy, case: CaseSensitivity) -> MemPlatform {
    let p = MemPlatform::new(strategy, case);
    let t = Timers::default();
    for d in Names::dirs(&p.capabilities().private_dir) {
        run_ready(&t, p.create_dir_all(&d)).unwrap().unwrap();
    }
    p
}

fn names(p: &MemPlatform, n: u64) -> Names {
    Names::for_op(&p.capabilities().private_dir, n)
}

fn go(p: &MemPlatform, op: &PublishOp, n: u64) -> Outcome {
    run_ready(
        &Timers::default(),
        publish(p, op, &names(p, n), &Options::default()),
    )
    .unwrap()
}

fn expect_for(strategy: ReplaceStrategy, old: &[u8]) -> Expect {
    // In-place strategies journal the old bytes; exchange needs only the revision.
    if strategy == ReplaceStrategy::Exchange {
        Expect::Rev(revision(old))
    } else {
        Expect::Bytes(old.to_vec())
    }
}

fn replace_op(strategy: ReplaceStrategy, path: &str, old: &[u8], new: &[u8]) -> PublishOp {
    PublishOp {
        path: rp(path),
        expect: expect_for(strategy, old),
        new: Some(new.to_vec()),
    }
}

/// Every byte string present anywhere (paths, retained and preserved files).
fn all_contents(fs: &MemFs) -> Vec<Vec<u8>> {
    fs.paths().iter().filter_map(|p| fs.get(p)).collect()
}

fn settle_all(p: &MemPlatform, rs: &[Retained]) -> Vec<Settled> {
    let t = Timers::default();
    rs.iter()
        .map(|r| run_ready(&t, settle(p, r)).unwrap())
        .collect()
}

fn retained_of(o: &Outcome) -> Vec<Retained> {
    match o {
        Outcome::Published { retained } | Outcome::Drifted { retained, .. } => {
            retained.iter().cloned().collect()
        }
        _ => vec![],
    }
}

#[test]
fn replace_create_delete_happy_path() {
    for s in STRATEGIES {
        let p = setup(s, CaseSensitivity::Sensitive);
        p.fs.write_in_place("notes/a.md", b"old").unwrap();
        let o = go(&p, &replace_op(s, "notes/a.md", b"old", b"new"), 1);
        assert!(matches!(o, Outcome::Published { .. }), "{s:?} {o:?}");
        assert_eq!(p.fs.get("notes/a.md").unwrap(), b"new");
        assert!(
            settle_all(&p, &retained_of(&o))
                .iter()
                .all(|x| *x == Settled::Released)
        );

        let create = PublishOp {
            path: rp("new/dir/b.md"),
            expect: Expect::Absent,
            new: Some(b"b".to_vec()),
        };
        assert!(
            matches!(go(&p, &create, 2), Outcome::Published { .. }),
            "{s:?}"
        );
        assert_eq!(p.fs.get("new/dir/b.md").unwrap(), b"b");

        let del = PublishOp {
            path: rp("notes/a.md"),
            expect: expect_for(s, b"new"),
            new: None,
        };
        let o = go(&p, &del, 3);
        assert!(matches!(o, Outcome::Published { .. }), "{s:?} {o:?}");
        assert_eq!(p.fs.get("notes/a.md"), None);
        assert!(
            settle_all(&p, &retained_of(&o))
                .iter()
                .all(|x| *x == Settled::Released)
        );
        // Only the user files remain: no temp, stash or held leftovers.
        assert_eq!(p.fs.paths(), vec!["new/dir/b.md".to_string()], "{s:?}");
    }
}

#[test]
fn drift_never_overwrites() {
    for s in STRATEGIES {
        let p = setup(s, CaseSensitivity::Sensitive);
        p.fs.write_in_place("a.md", b"user edit").unwrap();
        let o = go(&p, &replace_op(s, "a.md", b"old", b"new"), 1);
        assert!(matches!(o, Outcome::Drifted { .. }), "{s:?} {o:?}");
        assert_eq!(p.fs.get("a.md").unwrap(), b"user edit", "{s:?}");
        settle_all(&p, &retained_of(&o));

        let del = PublishOp {
            path: rp("a.md"),
            expect: expect_for(s, b"old"),
            new: None,
        };
        assert!(matches!(go(&p, &del, 2), Outcome::Drifted { .. }), "{s:?}");
        assert_eq!(p.fs.get("a.md").unwrap(), b"user edit", "{s:?}");
    }
}

#[test]
fn create_collides_on_case_insensitive_volume() {
    for s in [ReplaceStrategy::Exchange, ReplaceStrategy::LockedInPlace] {
        let p = setup(s, CaseSensitivity::Insensitive);
        p.fs.write_in_place("Notes/A.md", b"theirs").unwrap();
        let create = PublishOp {
            path: rp("Notes/a.md"),
            expect: Expect::Absent,
            new: Some(b"ours".to_vec()),
        };
        assert!(matches!(go(&p, &create, 1), Outcome::Drifted { .. }));
        assert_eq!(p.fs.get("Notes/A.md").unwrap(), b"theirs");
        assert_eq!(p.fs.paths(), vec!["Notes/A.md".to_string()]);
    }
}

#[test]
fn windows_lock_busy_backs_off() {
    let p = setup(ReplaceStrategy::LockedInPlace, CaseSensitivity::Insensitive);
    p.fs.write_in_place("a.md", b"old").unwrap();
    let t = Timers::default();
    let held = run_ready(&t, p.lock(&rp("a.md"), LockShare::Read))
        .unwrap()
        .unwrap();
    assert_eq!(
        go(
            &p,
            &replace_op(ReplaceStrategy::LockedInPlace, "a.md", b"old", b"new"),
            1
        ),
        Outcome::Busy
    );
    run_ready(&t, p.unlock(held)).unwrap().unwrap();
    assert!(matches!(
        go(
            &p,
            &replace_op(ReplaceStrategy::LockedInPlace, "a.md", b"old", b"new"),
            2
        ),
        Outcome::Published { .. }
    ));
}

#[test]
fn late_write_into_displaced_inode_is_kept() {
    let p = setup(ReplaceStrategy::Exchange, CaseSensitivity::Sensitive);
    p.fs.write_in_place("a.md", b"old").unwrap();
    let old_ino = p.fs.ino("a.md").unwrap();
    let o = go(
        &p,
        &replace_op(ReplaceStrategy::Exchange, "a.md", b"old", b"new"),
        1,
    );
    // An editor that opened the file before the swap writes now.
    p.fs.write_inode(old_ino, b"old + typing");
    let r = retained_of(&o);
    assert_eq!(settle_all(&p, &r), vec![Settled::LateWrite]);
    assert_eq!(p.fs.get(r[0].path.as_str()).unwrap(), b"old + typing");
}

/// A user action injected before every operation of the publish: the user's
/// bytes must survive somewhere (path, preserved or late-write retained), and
/// the path must hold either the new bytes or a user version.
#[test]
fn concurrent_user_write_at_every_step() {
    // Each action returns whether the user's write went through (a locked
    // file refuses it, as Windows does with a sharing violation).
    type Action = fn(&MemFs) -> bool;
    let actions: [(&str, Action); 4] = [
        ("in-place", |fs| fs.write_in_place("a.md", b"USER").is_ok()),
        ("replace", |fs| fs.write_replace("a.md", b"USER").is_ok()),
        ("delete", |fs| {
            fs.unlink("a.md");
            true
        }),
        ("in-place-then-replace", |fs| {
            let a = fs.write_in_place("a.md", b"USER1").is_ok();
            fs.write_replace("a.md", b"USER").is_ok() || a
        }),
    ];
    for s in STRATEGIES {
        for (name, act) in actions {
            for k in 0..14 {
                let p = setup(s, CaseSensitivity::Sensitive);
                p.fs.write_in_place("a.md", b"old").unwrap();
                let base = p.fs.ops();
                let acted = Rc::new(std::cell::Cell::new(false));
                let a2 = acted.clone();
                p.fs.before_op(base + k, move |fs| a2.set(act(fs)));
                let o = go(&p, &replace_op(s, "a.md", b"old", b"new"), 1);
                let mut late = vec![];
                for (r, st) in retained_of(&o).iter().zip(settle_all(&p, &retained_of(&o))) {
                    if st == Settled::LateWrite {
                        late.push(p.fs.get(r.path.as_str()).unwrap());
                    }
                }
                let at_path = p.fs.get("a.md");
                let everywhere = all_contents(&p.fs);
                let ctx = format!(
                    "{s:?} {name} before op {k}: {o:?}, path={at_path:?}, log={:?}",
                    p.fs.log()
                );
                if acted.get() && name != "delete" {
                    assert!(
                        everywhere.iter().any(|b| b.starts_with(b"USER")),
                        "user bytes lost: {ctx}"
                    );
                }
                match &at_path {
                    Some(b) => assert!(
                        b == b"new" || b.starts_with(b"USER") || b == b"old",
                        "{ctx}"
                    ),
                    None => assert!(name == "delete", "{ctx}"),
                }
                if matches!(o, Outcome::Published { .. }) && at_path.as_deref() != Some(b"new") {
                    // Published, then the user changed it: fine only if their
                    // write happened after ours (it is at the path).
                    assert!(
                        at_path.is_none() || at_path.as_deref().unwrap().starts_with(b"USER"),
                        "{ctx}"
                    );
                }
                let _ = late;
            }
        }
    }
}

/// Crash at every operation of every kind of publish, then recover: the path
/// holds exactly the old or the new bytes, the state says which, and after
/// settling nothing is left in the private directory.
#[test]
fn crash_at_every_step_then_recover() {
    let t = Timers::default();
    for s in STRATEGIES {
        for kind in ["replace", "create", "delete"] {
            for k in 0..14 {
                let p = setup(s, CaseSensitivity::Sensitive);
                let op = match kind {
                    "replace" => {
                        p.fs.write_in_place("d/a.md", b"old").unwrap();
                        replace_op(s, "d/a.md", b"old", b"new")
                    }
                    "create" => PublishOp {
                        path: rp("d/a.md"),
                        expect: Expect::Absent,
                        new: Some(b"new".to_vec()),
                    },
                    _ => {
                        p.fs.write_in_place("d/a.md", b"old").unwrap();
                        PublishOp {
                            path: rp("d/a.md"),
                            expect: expect_for(s, b"old"),
                            new: None,
                        }
                    }
                };
                let base = p.fs.ops();
                p.fs.crash_at(base + k);
                let n = names(&p, 7);
                let _ = run_ready(&t, publish(&p, &op, &n, &Options::default())).unwrap();
                p.fs.restart();
                let it = Intent {
                    strategy: s,
                    op: op.clone(),
                    names: n,
                };
                let rec = run_ready(&t, recover(&p, &it)).unwrap().unwrap();
                let at = p.fs.get("d/a.md");
                let ctx = format!(
                    "{s:?} {kind} crash at {k}: {rec:?} at={at:?} log={:?}",
                    p.fs.log()
                );
                assert!(rec.preserved.is_empty(), "{ctx}");
                let want_new: Option<&[u8]> = if kind == "delete" { None } else { Some(b"new") };
                let want_old: Option<&[u8]> = if kind == "create" { None } else { Some(b"old") };
                match rec.state {
                    State::Published => assert_eq!(at.as_deref(), want_new, "{ctx}"),
                    State::NotPublished => assert_eq!(at.as_deref(), want_old, "{ctx}"),
                    State::Drifted => panic!("no user activity, yet drifted: {ctx}"),
                }
                for st in settle_all(&p, &rec.retained) {
                    assert_eq!(st, Settled::Released, "{ctx}");
                }
                let mut left = p.fs.paths();
                left.retain(|x| x != "d/a.md");
                assert!(left.is_empty(), "leftovers {left:?}: {ctx}");
            }
        }
    }
}

#[test]
fn torn_in_place_write_is_rewritten() {
    let t = Timers::default();
    for s in [
        ReplaceStrategy::LockedInPlace,
        ReplaceStrategy::GuardedInPlace,
    ] {
        let p = setup(s, CaseSensitivity::Insensitive);
        let old = b"the old content of the note".to_vec();
        let new = b"NEW CONTENT".to_vec();
        // Crash mid-overwrite: a prefix of new over the rest of old.
        let mut torn = new[..4].to_vec();
        torn.extend_from_slice(&old[4..]);
        p.fs.write_in_place("a.md", &torn).unwrap();
        let it = Intent {
            strategy: s,
            op: PublishOp {
                path: rp("a.md"),
                expect: Expect::Bytes(old.clone()),
                new: Some(new.clone()),
            },
            names: names(&p, 1),
        };
        let rec = run_ready(&t, recover(&p, &it)).unwrap().unwrap();
        assert_eq!(rec.state, State::Published, "{s:?}");
        assert_eq!(p.fs.get("a.md").unwrap(), new);

        // A real user edit is not mistaken for a torn write.
        p.fs.write_in_place("a.md", b"the old content, edited by the user")
            .unwrap();
        let rec = run_ready(&t, recover(&p, &it)).unwrap().unwrap();
        assert_eq!(rec.state, State::Drifted, "{s:?}");
        assert_eq!(
            p.fs.get("a.md").unwrap(),
            b"the old content, edited by the user"
        );
    }
}

#[test]
fn queued_platform_runs_the_same_protocol() {
    // The protocol suspends on every operation under the host queue and
    // produces the same result once the host performs them.
    use crate::exec::Tasks;
    use crate::host::{FileOp, FileOpOutput, QueuedPlatform};

    let mem = Rc::new(setup(
        ReplaceStrategy::GuardedInPlace,
        CaseSensitivity::Sensitive,
    ));
    mem.fs.write_in_place("a.md", b"old").unwrap();
    let (qp, host) = QueuedPlatform::new(mem.capabilities().clone());
    let qp = Rc::new(qp);
    let mut tasks = Tasks::default();
    let q2 = qp.clone();
    let n = names(&mem, 1);
    tasks.spawn(async move {
        let op = PublishOp {
            path: RelPath::new("a.md").unwrap(),
            expect: Expect::Rev(revision(b"old")),
            new: Some(b"new".to_vec()),
        };
        publish(&*q2, &op, &n, &Options::default()).await
    });
    let t = Timers::default();
    let mut rounds = 0;
    let out = loop {
        if let Some((_, o)) = tasks.run().pop() {
            break o;
        }
        for (id, op) in host.take_requests() {
            let r = match op {
                FileOp::Read { path } => run_ready(&t, mem.read(&path))
                    .unwrap()
                    .map(FileOpOutput::Read),
                FileOp::GuardedReplace { path, expect, new } => {
                    run_ready(&t, mem.guarded_replace(&path, &expect, &new))
                        .unwrap()
                        .map(FileOpOutput::Guarded)
                }
                other => panic!("unexpected {other:?}"),
            };
            host.complete(id, r);
        }
        rounds += 1;
        assert!(rounds < 10);
    };
    assert_eq!(out, Outcome::Published { retained: None });
    assert_eq!(mem.fs.get("a.md").unwrap(), b"new");
}

/// A crash while
/// writing a create's temp (the create half of a move) is "not started": the
/// torn temp is ours, not user bytes, and the path stays absent.
#[test]
fn torn_create_temp_is_not_started() {
    let t = Timers::default();
    for s in [ReplaceStrategy::Exchange, ReplaceStrategy::LockedInPlace] {
        let p = setup(s, CaseSensitivity::Sensitive);
        let n = names(&p, 3);
        p.fs.write_in_place(n.tmp.as_str(), b"new con").unwrap();
        let it = Intent {
            strategy: s,
            op: PublishOp {
                path: rp("moved/b.md"),
                expect: Expect::Absent,
                new: Some(b"new content".to_vec()),
            },
            names: n,
        };
        let rec = run_ready(&t, recover(&p, &it)).unwrap().unwrap();
        assert_eq!(rec.state, State::NotPublished, "{s:?}");
        assert!(rec.preserved.is_empty(), "{s:?} {rec:?}");
        assert_eq!(settle_all(&p, &rec.retained), vec![Settled::Released]);
        assert!(p.fs.paths().is_empty(), "{:?}", p.fs.paths());
    }
}

/// An editor opened the file
/// before the swap and writes after the retention. With a lease check the
/// retained inode is kept while the fd is open, so the late write lands in a
/// file that still exists and is found by the next settle.
#[test]
fn open_fd_keeps_the_retained_file_until_closed() {
    let p = setup(ReplaceStrategy::Exchange, CaseSensitivity::Sensitive);
    p.fs.write_in_place("a.md", b"old").unwrap();
    let ino = p.fs.open_fd("a.md").unwrap();
    let o = go(
        &p,
        &replace_op(ReplaceStrategy::Exchange, "a.md", b"old", b"new"),
        1,
    );
    let r = retained_of(&o);
    // Retention passed, but the editor still holds its fd.
    assert_eq!(settle_all(&p, &r), vec![Settled::Busy]);
    assert!(p.fs.get(r[0].path.as_str()).is_some());
    p.fs.write_inode(ino, b"old + late save");
    p.fs.close_fd(ino);
    assert_eq!(settle_all(&p, &r), vec![Settled::LateWrite]);
    assert_eq!(p.fs.get(r[0].path.as_str()).unwrap(), b"old + late save");
}
