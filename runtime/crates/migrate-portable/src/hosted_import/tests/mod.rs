//! Driver tests against the fake world: zero lost acknowledged writes, crash
//! injection at every action, lost append replies, rollback before cutover at
//! every point, pause, and fail-closed compares.

mod both;
mod gen0;
mod world;

use std::collections::BTreeMap;

use world::{Faults, LState, LogItem, Next, World};

use super::replay::{effect, take_batch};

fn fixed_park(k: &Key, p: &str) -> crate::Result<String> {
    Ok(park_path(k, p))
}
use super::*;
use crate::budget::{MAX_BATCH_BYTES, MAX_BATCH_EFFECTS};

const COLLECTION: &str = "0192f0c1-7e1a-7b3c-8d4e-5f6a7b8c9d0e";

struct Run {
    step: Step,
    /// Poll index at which each step was first reached.
    reached: BTreeMap<Step, usize>,
    failure: Option<String>,
}

/// Drive to a terminal step. `rollback_at`: request a rollback at that poll.
fn run(world: &mut World, spill: &mut dyn Spill, rollback_at: Option<usize>) -> Run {
    run_mode(world, spill, rollback_at, false)
}

fn run_mode(
    world: &mut World,
    spill: &mut dyn Spill,
    rollback_at: Option<usize>,
    fence_first: bool,
) -> Run {
    let mut driver = Driver::resume_mode(spill, COLLECTION, fence_first).unwrap();
    let mut reached = BTreeMap::new();
    for poll in 0..200_000usize {
        world.tick();
        if rollback_at == Some(poll) {
            let can = driver.checkpoint().step.can_roll_back();
            let r = driver.rollback(spill, "operator");
            assert_eq!(r.is_ok(), can || driver.checkpoint().step.is_terminal());
        }
        let action = driver.poll(spill).unwrap();
        reached.entry(driver.checkpoint().step).or_insert(poll);
        match action {
            Action::Done(step) => {
                return Run {
                    step,
                    reached,
                    failure: driver.checkpoint().failure.clone(),
                };
            }
            Action::Wait(_) | Action::Continue => continue,
            _ => {}
        }
        match world.perform(&action, spill) {
            Next::Crash => {
                world.crash();
                driver = Driver::resume_mode(spill, COLLECTION, fence_first).unwrap();
            }
            Next::Outcome(o) => driver.complete(spill, o).unwrap(),
        }
    }
    panic!("no progress");
}

/// Everything a routed migration must prove.
/// Every placement of one generation, paged through the spill.
fn placements(spill: &mut dyn Spill, g: Generation) -> BTreeMap<Key, Meta> {
    let mut out = BTreeMap::new();
    let mut after: Option<Key> = None;
    loop {
        let page = spill.placements_page(g, after.as_ref(), 1000).unwrap();
        let Some((last, _)) = page.last() else {
            return out;
        };
        after = Some(last.clone());
        out.extend(page);
    }
}

fn assert_routed(world: &World, spill: &mut dyn Spill) {
    assert!(world.routed);
    assert_eq!(world.legacy.state, LState::Migrated);
    assert_eq!(
        world.legacy.pending(),
        0,
        "an accepted write was left behind"
    );
    assert_eq!(world.legacy.acked_after_fence, 0);
    let state = world.fold();
    let got: BTreeMap<Key, _> = state
        .iter()
        .map(|(k, m)| (k.clone(), (m.content, m.size, m.class)))
        .collect();
    assert_eq!(
        got,
        world::expected(&world.legacy),
        "new state != legacy at S_final"
    );
    let fin = placements(spill, Generation::Final);
    for (k, m) in &state {
        assert_eq!(m.path, fin[k].path, "path is the S_final placement");
    }
    let count = |f: fn(&LogItem) -> bool| world.log.iter().filter(|i| f(i)).count();
    assert_eq!(count(|i| matches!(i, LogItem::Base(_))), 1);
    assert_eq!(count(|i| matches!(i, LogItem::Cutover(_))), 1);
    assert_eq!(
        world.duplicate_appends, 0,
        "a retry produced a second effect"
    );
}

fn assert_rolled_back(world: &World) {
    assert!(!world.routed);
    assert_eq!(world.legacy.state, LState::Active);
    assert!(world.legacy.revoked.is_empty(), "un-revoked");
    assert!(
        !world.log.iter().any(|i| matches!(i, LogItem::Cutover(_))),
        "no cutover after a rollback"
    );
}

fn faults() -> Faults {
    Faults {
        transient: 5,
        unknown: 15,
        crash: 2,
        stale: 3,
        unverified: 10,
        pause: 30,
        writes: 30,
        ..Faults::default()
    }
}

#[derive(Default, Debug)]
struct Coverage {
    crashes: u64,
    lost_replies: u64,
    parks: u64,
    deletes: u64,
    oversized: u64,
    renamed: u64,
    replay_batches: u64,
}

fn cover(c: &mut Coverage, world: &World, spill: &mut dyn Spill) {
    c.crashes += world.crashes;
    c.lost_replies += world.lost_replies;
    for item in &world.log {
        if let LogItem::Mutation(_, effects) = item {
            c.replay_batches += 1;
            for e in effects {
                match e {
                    Effect::Park { .. } => c.parks += 1,
                    Effect::Delete { .. } => c.deletes += 1,
                    Effect::Put { .. } => {}
                }
            }
        }
    }
    let fin = placements(spill, Generation::Final);
    {
        c.oversized += fin
            .values()
            .filter(|m| m.class == Class::UnindexedMarkdown)
            .count() as u64;
        c.renamed += fin
            .iter()
            .filter(|(k, m)| world.legacy.ents.get(*k).is_some_and(|e| e.path != m.path))
            .count() as u64;
    }
}

#[test]
fn random_runs_route_with_zero_lost_acknowledged_writes() {
    let mut routed = 0;
    let mut gave_up = 0;
    let mut c = Coverage::default();
    for seed in 0..400 {
        let mut world = World::new(seed, faults());
        let mut spill = MemSpill::default();
        let r = run(&mut world, &mut spill, None);
        cover(&mut c, &world, &mut spill);
        match r.step {
            Step::Routed => {
                assert_routed(&world, &mut spill);
                routed += 1;
            }
            Step::RolledBack => {
                // The only acceptable stop: crashes before the base exhausted the
                // retry budget. Legacy must be untouched.
                assert_eq!(
                    r.failure.as_deref(),
                    Some("import restarted too often"),
                    "seed {seed}"
                );
                assert_rolled_back(&world);
                gave_up += 1;
            }
            s => panic!("seed {seed}: ended at {s:?}: {:?}", r.failure),
        }
    }
    assert!(routed >= 390, "routed {routed}, gave up {gave_up}");
    // The faults and shapes the proof relies on actually occurred.
    assert!(c.crashes > 100, "{c:?}");
    assert!(c.lost_replies > 100, "{c:?}");
    assert!(c.parks > 20, "{c:?}");
    assert!(c.deletes > 100, "{c:?}");
    assert!(c.oversized > 50, "{c:?}");
    assert!(c.renamed > 100, "{c:?}");
    assert!(c.replay_batches > 300, "{c:?}");
}

/// A fault-free run, to learn how many actions a migration takes.
fn baseline(seed: u64) -> usize {
    let mut world = World::new(
        seed,
        Faults {
            writes: 30,
            ..Faults::default()
        },
    );
    let mut spill = MemSpill::default();
    assert_eq!(run(&mut world, &mut spill, None).step, Step::Routed);
    assert_routed(&world, &mut spill);
    world.actions
}

#[test]
fn a_crash_at_every_action_before_or_after_its_effect_loses_nothing() {
    for seed in [3u64, 17, 42] {
        let n = baseline(seed);
        for k in 0..n + 20 {
            for after in [false, true] {
                let mut world = World::new(
                    seed,
                    Faults {
                        writes: 30,
                        crash_at: Some(k),
                        crash_after: after,
                        ..Faults::default()
                    },
                );
                let mut spill = MemSpill::default();
                let r = run(&mut world, &mut spill, None);
                assert_eq!(
                    r.step,
                    Step::Routed,
                    "seed {seed} crash at {k} after {after}"
                );
                assert_routed(&world, &mut spill);
            }
        }
    }
}

#[test]
fn every_append_reply_lost_is_settled_by_log_evidence() {
    for seed in 0..40 {
        for performed in [false, true] {
            let mut world = World::new(
                seed,
                Faults {
                    writes: 30,
                    all_unknown: true,
                    unknown_performed: performed,
                    ..Faults::default()
                },
            );
            let mut spill = MemSpill::default();
            // With every reply lost and never performed, nothing can progress
            // past the first append: that must stall, not duplicate or skip.
            if !performed {
                let mut driver = Driver::resume(&mut spill, COLLECTION).unwrap();
                for _ in 0..2_000 {
                    world.tick();
                    let a = driver.poll(&mut spill).unwrap();
                    if matches!(a, Action::Wait(_) | Action::Continue) {
                        continue;
                    }
                    assert!(!matches!(a, Action::Done(_)));
                    let Next::Outcome(o) = world.perform(&a, &mut spill) else {
                        unreachable!()
                    };
                    driver.complete(&mut spill, o).unwrap();
                }
                assert_eq!(driver.checkpoint().step, Step::BaseIntent);
                assert!(world.log.is_empty());
                continue;
            }
            let r = run(&mut world, &mut spill, None);
            assert_eq!(r.step, Step::Routed, "seed {seed}");
            assert_routed(&world, &mut spill);
        }
    }
}

#[test]
fn rollback_before_cutover_at_every_point_restores_legacy() {
    for seed in [5u64, 29] {
        let mut world = World::new(
            seed,
            Faults {
                writes: 30,
                ..Faults::default()
            },
        );
        let mut spill = MemSpill::default();
        let base = run(&mut world, &mut spill, None);
        let cutover_at = base.reached[&Step::CutoverIntent];
        for at in 0..cutover_at + 5 {
            let mut world = World::new(
                seed,
                Faults {
                    writes: 30,
                    ..Faults::default()
                },
            );
            let mut spill = MemSpill::default();
            let r = run(&mut world, &mut spill, Some(at));
            // The step is saved during the poll at `cutover_at`; a rollback
            // requested just before that poll still wins.
            if at <= cutover_at {
                assert_eq!(r.step, Step::RolledBack, "seed {seed} rollback at {at}");
                assert_rolled_back(&world);
                // Acknowledged writes are all still in legacy (applied or pending).
                assert_eq!(world.legacy.acked_after_fence, 0);
            } else {
                assert_eq!(r.step, Step::Routed, "seed {seed}: refused after cutover");
                assert_routed(&world, &mut spill);
            }
        }
    }
}

#[test]
fn paused_rollout_never_fences() {
    let mut world = World::new(
        9,
        Faults {
            writes: 30,
            ..Faults::default()
        },
    );
    world.paused = true;
    let mut spill = MemSpill::default();
    let mut driver = Driver::resume(&mut spill, COLLECTION).unwrap();
    let mut waits = 0;
    for _ in 0..5_000 {
        world.tick();
        let a = driver.poll(&mut spill).unwrap();
        match a {
            Action::Wait(Wait::Paused) => waits += 1,
            Action::Wait(_) | Action::Continue => {}
            Action::Done(s) => panic!("ended at {s:?}"),
            a => {
                let Next::Outcome(o) = world.perform(&a, &mut spill) else {
                    unreachable!()
                };
                driver.complete(&mut spill, o).unwrap();
            }
        }
        assert_eq!(world.legacy.state, LState::Active, "fenced while paused");
    }
    assert!(waits > 100);
    assert_eq!(driver.checkpoint().step, Step::Shadowed);
    world.paused = false;
    // Resumes from the durable checkpoint and completes.
    let r = run(&mut world, &mut spill, None);
    assert_eq!(r.step, Step::Routed);
    assert_routed(&world, &mut spill);
}

#[test]
fn a_shadow_mismatch_rolls_back_and_a_late_mismatch_fails_closed() {
    // A corrupt generation 0 (a placement silently dropped before staging) is
    // caught by the fresh-rebuild compare before anything is fenced.
    let mut world = World::new(
        11,
        Faults {
            writes: 30,
            ..Faults::default()
        },
    );
    let mut spill = MemSpill::default();
    let mut driver = Driver::resume(&mut spill, COLLECTION).unwrap();
    let mut corrupted = false;
    let step = loop {
        world.tick();
        let a = driver.poll(&mut spill).unwrap();
        match a {
            Action::Done(s) => break s,
            Action::Wait(_) | Action::Continue => continue,
            Action::ImportGen0 { .. } if !corrupted => {
                // Report progress past the first placement without staging it.
                let page = spill.placements_page(Generation::S0, None, 1).unwrap();
                corrupted = true;
                driver
                    .complete(
                        &mut spill,
                        Outcome::Gen0Progress {
                            last: page.last().map(|(k, _)| k.clone()),
                            done: false,
                        },
                    )
                    .unwrap();
            }
            a => {
                let Next::Outcome(o) = world.perform(&a, &mut spill) else {
                    unreachable!()
                };
                driver.complete(&mut spill, o).unwrap();
            }
        }
    };
    assert_eq!(step, Step::RolledBack);
    assert!(
        driver
            .checkpoint()
            .failure
            .as_deref()
            .unwrap()
            .contains("S0 compare")
    );
    assert_rolled_back(&world);

    // After the cutover a mismatch cannot roll back: it stops, legacy read-only,
    // nothing routed. Drop one effect of a replay batch; the replica refuses the
    // next dependent mutation, or the barrier-F compare catches the difference.
    let mut stopped = 0;
    for seed in 12..40 {
        let mut world = World::new(
            seed,
            Faults {
                writes: 30,
                ..Faults::default()
            },
        );
        let mut spill = MemSpill::default();
        let mut driver = Driver::resume(&mut spill, COLLECTION).unwrap();
        let mut dropped = false;
        let step = loop {
            world.tick();
            let a = driver.poll(&mut spill).unwrap();
            let a = match a {
                Action::Done(s) => break s,
                Action::Wait(_) | Action::Continue => continue,
                Action::Replay(mut b) if !dropped && b.effects.len() > 1 => {
                    b.effects.pop();
                    dropped = true;
                    Action::Replay(b)
                }
                a => a,
            };
            let Next::Outcome(o) = world.perform(&a, &mut spill) else {
                unreachable!()
            };
            driver.complete(&mut spill, o).unwrap();
        };
        if !dropped {
            assert_eq!(step, Step::Routed);
            continue;
        }
        stopped += 1;
        assert_eq!(step, Step::Failed, "seed {seed}");
        assert!(!world.routed);
        assert_eq!(world.legacy.state, LState::Migrating, "read-only, retained");
        assert!(driver.rollback(&mut spill, "x").is_ok(), "terminal: no-op");
        assert_eq!(driver.checkpoint().step, Step::Failed);
    }
    assert!(stopped >= 5, "stopped {stopped}");
}

#[test]
fn checkpoint_round_trips() {
    let mut cp = Checkpoint::new(COLLECTION);
    assert_eq!(Checkpoint::from_bytes(&cp.to_bytes().unwrap()).unwrap(), cp);
    cp.step = Step::Replaying;
    cp.revoked = vec!["r1".into()];
    cp.s0_digest = Some(vec![1, 2, 3]);
    cp.replay_pass = 2;
    cp.replay_after = Some(vec![1, b'a']);
    cp.intent_mutation = Some(mdbn_wire::common::B16([7; 16]));
    cp.fenced = true;
    assert_eq!(Checkpoint::from_bytes(&cp.to_bytes().unwrap()).unwrap(), cp);
    assert!(Checkpoint::from_bytes(b"junk").is_err());
    assert!(Step::Revoked.can_roll_back());
    assert!(!Step::CutoverIntent.can_roll_back());
}

fn meta(class: Class, path: &str, size: u64) -> Meta {
    Meta {
        class,
        path: path.into(),
        content: mdbn_wire::common::B32([1; 32]),
        size,
    }
}

fn key(i: u64) -> Key {
    Key {
        kind: crate::preflight::EntityKind::Record,
        id: format!("00000000-0000-4000-8000-{i:012x}"),
    }
}

#[test]
fn replay_batches_respect_both_budgets_and_never_split_an_effect() {
    // 1,200 small creates: batches of at most 500 effects.
    let rows: Vec<_> = (0..1_200)
        .map(|i| {
            (
                key(i),
                None,
                Some(meta(Class::Record, &format!("n{i}.md"), 10)),
            )
        })
        .collect();
    let (e, last) = take_batch(2, &rows, &mut fixed_park).unwrap().unwrap();
    assert_eq!(e.len(), MAX_BATCH_EFFECTS);
    assert_eq!(last, key(499));
    // 300 KiB records: one per batch by bytes, except a lone record up to 1 MiB.
    let rows: Vec<_> = (0..3)
        .map(|i| {
            (
                key(i),
                None,
                Some(meta(Class::Record, &format!("n{i}.md"), 300 << 10)),
            )
        })
        .collect();
    let (e, _) = take_batch(2, &rows, &mut fixed_park).unwrap().unwrap();
    assert_eq!(e.len(), 1);
    let big = vec![(key(0), None, Some(meta(Class::Record, "big.md", 900 << 10)))];
    let (e, _) = take_batch(2, &big, &mut fixed_park).unwrap().unwrap();
    assert_eq!(e.len(), 1, "a lone 900 KiB record travels alone");
    let rows = vec![
        (key(0), None, Some(meta(Class::Record, "a.md", 100))),
        (key(1), None, Some(meta(Class::Record, "big.md", 900 << 10))),
    ];
    let (e, last) = take_batch(2, &rows, &mut fixed_park).unwrap().unwrap();
    assert_eq!(
        (e.len(), last),
        (1, key(0)),
        "nothing joins an over-budget effect"
    );
    // Attachments and oversized documents cost a descriptor, not their bytes.
    let rows: Vec<_> = (0..600)
        .map(|i| {
            (
                key(i),
                None,
                Some(meta(Class::Attachment, &format!("f{i}.png"), 1 << 30)),
            )
        })
        .collect();
    let (e, _) = take_batch(2, &rows, &mut fixed_park).unwrap().unwrap();
    assert!(e.len() <= MAX_BATCH_EFFECTS);
    assert!(e.iter().map(Effect::bytes).sum::<u64>() <= MAX_BATCH_BYTES as u64);
}

#[test]
fn replay_passes_clear_then_settle() {
    let a = meta(Class::Record, "a.md", 1);
    let b = meta(Class::Record, "b.md", 1);
    let k = key(1);
    let eff = |pass, s0: Option<&Meta>, fin: Option<&Meta>| {
        effect(pass, &k, s0, fin, &mut fixed_park).unwrap()
    };
    // Swap: the entity at a.md moves to b.md.
    assert!(matches!(
        eff(1, Some(&a), Some(&b)),
        Some(Effect::Park { .. })
    ));
    let Some(Effect::Put { from: Some(f), .. }) = eff(2, Some(&a), Some(&b)) else {
        panic!("pass 2 puts")
    };
    assert_eq!(f.path, park_path(&k, "a.md"));
    assert!(f.path.ends_with(".md") && mdbn_core::paths::check_path(&f.path).is_ok());
    // A case-only change keeps its path key: no parking.
    let a2 = meta(Class::Record, "A.md", 1);
    assert_eq!(eff(1, Some(&a), Some(&a2)), None);
    // Deleted in pass 1, created in pass 2.
    assert!(matches!(
        eff(1, Some(&a), None),
        Some(Effect::Delete { .. })
    ));
    assert_eq!(eff(2, Some(&a), None), None);
    assert!(matches!(
        eff(2, None, Some(&a)),
        Some(Effect::Put { from: None, .. })
    ));
}

#[test]
fn an_account_deleted_at_any_point_ends_terminal_without_rollback() {
    let n = baseline(21);
    for k in (0..n).step_by(3) {
        let mut world = World::new(
            21,
            Faults {
                writes: 30,
                ..Faults::default()
            },
        );
        let mut spill = MemSpill::default();
        let mut driver = Driver::resume(&mut spill, COLLECTION).unwrap();
        let mut actions = 0;
        let step = loop {
            world.tick();
            let a = driver.poll(&mut spill).unwrap();
            match a {
                Action::Done(s) => break s,
                Action::Wait(_) | Action::Continue => continue,
                _ => {}
            }
            if actions == k {
                world.deleted = true;
            }
            actions += 1;
            assert!(actions < 100_000, "no progress");
            let Next::Outcome(o) = world.perform(&a, &mut spill) else {
                unreachable!()
            };
            driver.complete(&mut spill, o).unwrap();
        };
        if world.deleted {
            assert_eq!(step, Step::Gone, "deleted at action {k}");
            assert!(!world.routed);
            assert!(driver.rollback(&mut spill, "x").is_ok(), "terminal");
            assert_eq!(driver.checkpoint().step, Step::Gone);
        }
    }
}

/// Fence-first: legacy is fenced and drained before the import, so the replay is
/// empty: no replay mutation ever reaches the log. Faulty runs, a crash at every
/// action and rollback at every point all hold, with zero lost writes.
#[test]
fn fence_first_imports_at_the_drained_head_with_an_empty_replay() {
    let no_replay = |w: &World| !w.log.iter().any(|i| matches!(i, LogItem::Mutation(..)));
    for seed in 0..150 {
        let mut world = World::new(seed, faults());
        let mut spill = MemSpill::default();
        let r = run_mode(&mut world, &mut spill, None, true);
        match r.step {
            Step::Routed => {
                assert_routed(&world, &mut spill);
                assert!(no_replay(&world), "seed {seed}");
            }
            Step::RolledBack => {
                assert_eq!(
                    r.failure.as_deref(),
                    Some("import restarted too often"),
                    "seed {seed}"
                );
                assert_rolled_back(&world);
            }
            s => panic!("seed {seed}: {s:?} {:?}", r.failure),
        }
    }
    let quiet = Faults {
        writes: 30,
        ..Faults::default()
    };
    let mut base_world = World::new(8, quiet);
    let mut base_spill = MemSpill::default();
    let base = run_mode(&mut base_world, &mut base_spill, None, true);
    assert_eq!(base.step, Step::Routed);
    let n = base_world.actions;
    for k in 0..n + 10 {
        for after in [false, true] {
            let mut world = World::new(
                8,
                Faults {
                    crash_at: Some(k),
                    crash_after: after,
                    ..quiet
                },
            );
            let mut spill = MemSpill::default();
            assert_eq!(
                run_mode(&mut world, &mut spill, None, true).step,
                Step::Routed,
                "crash at {k}"
            );
            assert_routed(&world, &mut spill);
            assert!(no_replay(&world));
        }
    }
    let cut = base.reached[&Step::CutoverIntent];
    for at in 0..=cut {
        let mut world = World::new(8, quiet);
        let mut spill = MemSpill::default();
        assert_eq!(
            run_mode(&mut world, &mut spill, Some(at), true).step,
            Step::RolledBack,
            "rollback at {at}"
        );
        assert_rolled_back(&world);
    }
}

#[test]
fn fence_first_reports_fenced_to_the_rollout_before_its_import() {
    let mut world = World::new(
        4,
        Faults {
            writes: 30,
            ..Faults::default()
        },
    );
    let mut spill = MemSpill::default();
    let mut driver = Driver::resume_mode(&mut spill, COLLECTION, true).unwrap();
    loop {
        let a = driver.poll(&mut spill).unwrap();
        if matches!(a, Action::Fence) {
            assert_eq!(driver.checkpoint().step, Step::Created);
            assert_eq!(
                driver.status_step(),
                Step::Fenced,
                "mid-cutover for the pause gate"
            );
            break;
        }
        if matches!(a, Action::Wait(_) | Action::Continue) {
            continue;
        }
        let Next::Outcome(o) = world.perform(&a, &mut spill) else {
            unreachable!()
        };
        driver.complete(&mut spill, o).unwrap();
    }
}

/// Parking paths are allocated against both namespaces, deterministically,
/// and an impossible allocation is refused (the driver checks before cutover).
#[test]
fn parking_paths_avoid_every_occupied_name_and_are_stable() {
    use super::replay::{MAX_PARK_CANDIDATES, allocate_park};
    use crate::namespace::claim_key;
    let k = key(7);
    let base = park_path(&k, "notes/a.md");
    let mut spill = MemSpill::default();
    assert_eq!(allocate_park(&mut spill, &k, "notes/a.md").unwrap(), base);
    // An unrelated entity occupies the base name in S0, its first variant in Final.
    spill.claim(Generation::S0, &claim_key(&base)).unwrap();
    let second = mdbn_core::paths::suffixed(&base, 2);
    spill
        .claim(Generation::Final, &claim_key(&second.to_uppercase()))
        .unwrap();
    let got = allocate_park(&mut spill, &k, "notes/a.md").unwrap();
    assert_eq!(
        got,
        mdbn_core::paths::suffixed(&base, 3),
        "skips both namespaces, case-folded"
    );
    assert_eq!(
        allocate_park(&mut spill, &k, "notes/a.md").unwrap(),
        got,
        "deterministic on resume"
    );
    for n in 1..=MAX_PARK_CANDIDATES {
        let c = if n == 1 {
            base.clone()
        } else {
            mdbn_core::paths::suffixed(&base, n)
        };
        spill.claim(Generation::S0, &claim_key(&c)).unwrap();
    }
    assert!(
        allocate_park(&mut spill, &k, "notes/a.md").is_err(),
        "refused when nothing is free"
    );
}

/// End to end: an unrelated live entity sits exactly at the base parking path
/// of an entity that moves during the window. The replay parks around it (the
/// allocation skips occupied names in both namespaces), so the run routes with no
/// collision, the occupant untouched; with a crash at every action it resumes to
/// the same allocation.
#[test]
fn a_parking_name_occupant_is_never_overwritten_and_resume_is_stable() {
    use world::{LEnt, uuid};
    let scenario = |crash_at: Option<usize>| {
        let mut world = World::new(
            33,
            Faults {
                writes: 0,
                crash_at,
                crash_after: true,
                ..Faults::default()
            },
        );
        let mover = Key {
            kind: crate::preflight::EntityKind::Record,
            id: uuid(0x50),
        };
        let occupant = Key {
            kind: crate::preflight::EntityKind::Record,
            id: uuid(0x51),
        };
        let ent = |path: String| LEnt {
            table: Table::Records,
            content: mdbn_wire::hash::sha256(path.as_bytes()),
            path,
            size: 3,
        };
        world.legacy.put(mover.clone(), ent("move-me.md".into()));
        world
            .legacy
            .put(occupant.clone(), ent(park_path(&mover, "move-me.md")));
        let mut spill = MemSpill::default();
        let mut driver = Driver::resume(&mut spill, COLLECTION).unwrap();
        let mut moved = false;
        let step = loop {
            let a = driver.poll(&mut spill).unwrap();
            if !moved && driver.checkpoint().step == Step::Shadowed {
                // The user moves the entity after the import, before the fence.
                world.legacy.put(mover.clone(), ent("moved.md".into()));
                moved = true;
            }
            match a {
                Action::Done(s) => break s,
                Action::Wait(_) | Action::Continue => continue,
                _ => {}
            }
            match world.perform(&a, &mut spill) {
                Next::Crash => {
                    world.crash();
                    driver = Driver::resume(&mut spill, COLLECTION).unwrap();
                }
                Next::Outcome(o) => driver.complete(&mut spill, o).unwrap(),
            }
        };
        assert_eq!(step, Step::Routed, "crash at {crash_at:?}");
        assert_routed(&world, &mut spill);
        let state = world.fold();
        assert_eq!(
            state[&occupant].path,
            park_path(&mover, "move-me.md"),
            "occupant kept"
        );
        assert_eq!(state[&mover].path, "moved.md");
        let parked: Vec<String> = world
            .log
            .iter()
            .flat_map(|i| match i {
                LogItem::Mutation(_, e) => e.clone(),
                _ => vec![],
            })
            .filter_map(|e| match e {
                Effect::Park { to, .. } => Some(to),
                _ => None,
            })
            .collect();
        assert_eq!(parked.len(), 1);
        assert_ne!(
            parked[0],
            park_path(&mover, "move-me.md"),
            "allocated around the occupant"
        );
        world.actions
    };
    let n = scenario(None);
    for k in 0..n {
        scenario(Some(k));
    }
}

/// When no parking name can be allocated (every candidate occupied), the
/// driver refuses during its pre-cutover check and rolls back: nothing after the
/// cutover intent, legacy active again.
#[test]
fn an_unallocatable_parking_name_rolls_back_before_cutover() {
    use super::replay::MAX_PARK_CANDIDATES;
    use world::{LEnt, uuid};
    let mut world = World::new(34, Faults::default());
    let mover = Key {
        kind: crate::preflight::EntityKind::Record,
        id: uuid(0x60),
    };
    let ent = |path: String| LEnt {
        table: Table::Records,
        content: mdbn_wire::hash::sha256(path.as_bytes()),
        path,
        size: 3,
    };
    world.legacy.put(mover.clone(), ent("move-me.md".into()));
    let base = park_path(&mover, "move-me.md");
    for n in 1..=MAX_PARK_CANDIDATES {
        let p = if n == 1 {
            base.clone()
        } else {
            mdbn_core::paths::suffixed(&base, n)
        };
        world.legacy.put(
            Key {
                kind: crate::preflight::EntityKind::Record,
                id: uuid(0x1000 + n),
            },
            ent(p),
        );
    }
    let mut spill = MemSpill::default();
    let mut driver = Driver::resume(&mut spill, COLLECTION).unwrap();
    let mut moved = false;
    let step = loop {
        let a = driver.poll(&mut spill).unwrap();
        if !moved && driver.checkpoint().step == Step::Shadowed {
            world.legacy.put(mover.clone(), ent("moved.md".into()));
            moved = true;
        }
        match a {
            Action::Done(s) => break s,
            Action::Wait(_) | Action::Continue => continue,
            _ => {}
        }
        let Next::Outcome(o) = world.perform(&a, &mut spill) else {
            unreachable!()
        };
        driver.complete(&mut spill, o).unwrap();
    };
    assert_eq!(step, Step::RolledBack);
    assert!(
        driver
            .checkpoint()
            .failure
            .as_deref()
            .unwrap()
            .contains("before cutover")
    );
    assert_rolled_back(&world);
}
