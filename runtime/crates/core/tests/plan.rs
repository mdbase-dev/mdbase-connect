//! Intent planning: behaviour per `intent.md`, and determinism properties.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use mdbn_core::ids::{Hash, Uuid, revision};
use mdbn_core::intent::{
    BaseField, ConflictMode, Create, Delete, Mutation, Op, OpClock, Rename, ResourcePut, Source,
    Update,
};
use mdbn_core::plan::{ConflictKind, Effect, PlanOptions, Planned, RejectCode, Stage, Status};
use mdbn_core::state::{MemState, Overlay, StateView};
use mdbn_core::value::{Map, Value};

const CONFIG: &str = "spec_version: \"0.3.0\"\nsettings:\n  validation: warn\n";
const TASK: &str = "---\nkind: mdbase.type\nname: task\nmatch:\n  path_glob: \"tasks/**/*.md\"\nschema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\n    properties:\n      title: {type: string}\ncollection:\n  path:\n    pattern: \"tasks/{title}.md\"\n  unique:\n    - field: code\n      enforce: write\nlifecycle:\n  on_create:\n    set:\n      id: {uuid: true}\n      created: {now: true}\n  on_update:\n    set:\n      modified: {now: true}\n---\n";

fn id(n: u8) -> Uuid {
    let mut b = [0u8; 16];
    b[0] = 0x01;
    b[15] = n;
    Uuid(b)
}

fn base_state() -> MemState {
    let mut s = MemState::new();
    s.insert_resource("mdbase.yaml", CONFIG);
    s.insert_resource("_types/task.md", TASK);
    s.insert_record(
        id(1),
        "tasks/a.md",
        "---\ntitle: A\nstatus: open\ncode: X\n---\nBody A\n",
    );
    s.insert_record(id(2), "notes/b.md", "---\ntitle: B\n---\nSee [[a]].\n");
    s
}

fn mutation(ops: Vec<Op>) -> Mutation {
    Mutation {
        id: id(200),
        origin: id(201),
        base_seq: 0,
        clock: OpClock {
            instant_ms: 1_767_225_600_000,
            tz: "UTC".into(),
            local_date: "2026-01-01".into(),
        },
        seed: [7; 32],
        source: Source::Api,
        ops,
        on_behalf: None,
        conflict_mode: ConflictMode::Record,
        validated_at: None,
        room: None,
    }
}

fn head() -> PlanOptions {
    PlanOptions { stage: Stage::Head }
}

fn patch(pairs: &[(&str, Value)]) -> Option<Map> {
    Some(
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), v.clone()))
            .collect(),
    )
}

fn doc_of(p: &Planned, rid: Uuid) -> String {
    p.effects
        .iter()
        .find_map(|e| match e {
            Effect::PutRecord { id, doc, .. } if *id == rid => Some(doc.clone()),
            _ => None,
        })
        .unwrap()
}

#[test]
fn create_runs_lifecycle_from_the_captured_clock_and_seed() {
    let s = base_state();
    let m = mutation(vec![Op::Create(Create {
        id: id(10),
        type_name: Some("task".into()),
        frontmatter: patch(&[("title", Value::string("New"))]),
        ..Create::default()
    })]);
    let p = mdbn_core::plan(&m, &s, &head()).unwrap();
    assert_eq!(p.status, Status::Applied);
    let Effect::PutRecord { path, doc, .. } = &p.effects[0] else {
        panic!("{p:?}")
    };
    assert_eq!(path, "tasks/New.md");
    assert!(
        doc.contains("created: \"2026-01-01T00:00:00.000Z\""),
        "{doc}"
    );
    // The same mutation re-planned gives the same generated id.
    assert_eq!(p, mdbn_core::plan(&m, &s, &head()).unwrap());
    // A different seed gives a different id.
    let mut m2 = m.clone();
    m2.seed = [8; 32];
    assert_ne!(
        doc_of(&mdbn_core::plan(&m2, &s, &head()).unwrap(), id(10)),
        *doc
    );
}

#[test]
fn explicit_path_conflict_and_derived_suffix() {
    let s = base_state();
    let taken = mutation(vec![Op::Create(Create {
        id: id(10),
        path: Some("Tasks/A.md".into()),
        ..Create::default()
    })]);
    let r = mdbn_core::plan(&taken, &s, &head()).unwrap_err();
    assert_eq!(
        (r.code, r.reason.as_deref()),
        (RejectCode::Conflict, Some("path_taken"))
    );
    let derived = mutation(vec![Op::Create(Create {
        id: id(10),
        type_name: Some("task".into()),
        frontmatter: patch(&[("title", Value::string("a"))]),
        ..Create::default()
    })]);
    let p = mdbn_core::plan(&derived, &s, &head()).unwrap();
    assert!(matches!(&p.effects[0], Effect::PutRecord { path, .. } if path == "tasks/a (2).md"));
}

#[test]
fn concurrent_field_edit_is_recorded_not_lost() {
    let s = base_state();
    // The caller saw status: draft; the record holds open now.
    let m = mutation(vec![Op::Update(Update {
        id: id(1),
        patch: patch(&[("status", Value::string("done"))]),
        base: vec![BaseField {
            key: "status".into(),
            observed: Some(Value::string("draft")),
        }],
        ..Update::default()
    })]);
    let p = mdbn_core::plan(&m, &s, &head()).unwrap();
    assert_eq!(p.status, Status::Conflicted);
    assert_eq!(p.conflicts[0].kind, ConflictKind::Field);
    assert_eq!(p.conflicts[0].field.as_deref(), Some("status"));
    // conflict_mode reject turns it into a rejection.
    let mut strict = m.clone();
    strict.conflict_mode = ConflictMode::Reject;
    assert_eq!(
        mdbn_core::plan(&strict, &s, &head()).unwrap_err().code,
        RejectCode::Conflict
    );
    // A matching base applies cleanly.
    let mut ok = m;
    let Op::Update(u) = &mut ok.ops[0] else {
        unreachable!()
    };
    u.base[0].observed = Some(Value::string("open"));
    let p = mdbn_core::plan(&ok, &s, &head()).unwrap();
    assert_eq!(p.status, Status::Applied);
    assert!(doc_of(&p, id(1)).contains("status: done"));
}

#[test]
fn cas_and_superseded_delete() {
    let s = base_state();
    let stale = Hash::of(b"nope");
    let m = mutation(vec![Op::Update(Update {
        id: id(1),
        patch: patch(&[("x", Value::Int(1))]),
        if_revision: Some(stale),
        ..Update::default()
    })]);
    let r = mdbn_core::plan(&m, &s, &head()).unwrap_err();
    assert_eq!(r.reason.as_deref(), Some("revision"));
    let del = mutation(vec![Op::Delete(Delete {
        id: id(1),
        base_revision: Some(stale),
        if_revision: None,
    })]);
    let p = mdbn_core::plan(&del, &s, &head()).unwrap();
    assert_eq!(p.status, Status::Conflicted);
    assert!(p.effects.is_empty());
    let current = revision(&s.record(&id(1)).unwrap().source);
    let del = mutation(vec![Op::Delete(Delete {
        id: id(1),
        base_revision: Some(current),
        if_revision: None,
    })]);
    let p = mdbn_core::plan(&del, &s, &head()).unwrap();
    assert!(matches!(p.effects[0], Effect::RemoveRecord { .. }));
}

#[test]
fn rename_checks_from_rewrites_refs_and_aliases() {
    let s = base_state();
    let stale = mutation(vec![Op::Rename(Rename {
        id: id(1),
        from: "tasks/old.md".into(),
        to: "tasks/z.md".into(),
        update_refs: true,
        if_revision: None,
    })]);
    assert_eq!(
        mdbn_core::plan(&stale, &s, &head())
            .unwrap_err()
            .reason
            .as_deref(),
        Some("renamed")
    );
    let m = mutation(vec![Op::Rename(Rename {
        id: id(1),
        from: "tasks/a.md".into(),
        to: "tasks/z.md".into(),
        update_refs: true,
        if_revision: None,
    })]);
    let p = mdbn_core::plan(&m, &s, &head()).unwrap();
    assert_eq!(p.aliases[0].path, "tasks/a.md");
    assert!(doc_of(&p, id(2)).contains("[[z]]"), "{p:?}");
}

#[test]
fn dry_runs_report_link_rewrites_and_broken_backlinks() {
    let s = base_state();
    let submit = PlanOptions {
        stage: Stage::Submit {
            level: mdbn_core::intent::Level::Warn,
        },
    };
    // notes/b.md links to [[a]] (tasks/a.md).
    let del = mutation(vec![Op::Delete(Delete {
        id: id(1),
        ..Delete::default()
    })]);
    let p = mdbn_core::plan(&del, &s, &submit).unwrap();
    assert_eq!(p.broken_links.len(), 1);
    assert_eq!(
        (
            p.broken_links[0].path.as_str(),
            p.broken_links[0].value.as_str()
        ),
        ("notes/b.md", "[[a]]")
    );
    assert_eq!(p.broken_links[0].target, id(1));
    // Not computed at head.
    assert!(
        mdbn_core::plan(&del, &s, &head())
            .unwrap()
            .broken_links
            .is_empty()
    );

    let rename = |update_refs| {
        mutation(vec![Op::Rename(Rename {
            id: id(1),
            from: "tasks/a.md".into(),
            to: "tasks/z.md".into(),
            update_refs,
            if_revision: None,
        })])
    };
    let p = mdbn_core::plan(&rename(false), &s, &submit).unwrap();
    assert!(p.link_rewrites.is_empty());
    assert_eq!(p.broken_links.len(), 1);
    let p = mdbn_core::plan(&rename(true), &s, &submit).unwrap();
    assert!(p.broken_links.is_empty());
    assert_eq!(
        (
            p.link_rewrites[0].old_value.as_str(),
            p.link_rewrites[0].new_value.as_str()
        ),
        ("[[a]]", "[[z]]")
    );
}

#[test]
fn enforced_uniqueness_rejects_at_head() {
    let s = base_state();
    let m = mutation(vec![Op::Create(Create {
        id: id(10),
        path: Some("tasks/c.md".into()),
        frontmatter: patch(&[("title", Value::string("C")), ("code", Value::string("X"))]),
        ..Create::default()
    })]);
    let r = mdbn_core::plan(&m, &s, &head()).unwrap_err();
    assert_eq!(r.reason.as_deref(), Some("duplicate_value"));
}

#[test]
fn batches_are_atomic_and_reject_repeated_paths() {
    let s = base_state();
    let m = mutation(vec![
        Op::Update(Update {
            id: id(1),
            patch: patch(&[("x", Value::Int(1))]),
            ..Update::default()
        }),
        Op::Update(Update {
            id: id(1),
            patch: patch(&[("y", Value::Int(1))]),
            ..Update::default()
        }),
    ]);
    assert_eq!(
        mdbn_core::plan(&m, &s, &head())
            .unwrap_err()
            .reason
            .as_deref(),
        Some("duplicate_batch_path")
    );
    let m = mutation(vec![
        Op::Update(Update {
            id: id(1),
            patch: patch(&[("x", Value::Int(1))]),
            ..Update::default()
        }),
        Op::Update(Update {
            id: id(99),
            patch: patch(&[("y", Value::Int(1))]),
            ..Update::default()
        }),
    ]);
    let r = mdbn_core::plan(&m, &s, &head()).unwrap_err();
    assert_eq!((r.code, r.op_index), (RejectCode::NotFound, Some(1)));
}

#[test]
fn must_not_exist_guards_resource_creates() {
    let s = base_state();
    let put = |path: &str, must_not_exist, base_revision| {
        mutation(vec![Op::ResourcePut(ResourcePut {
            path: path.into(),
            doc: TASK.replace("name: task", "name: other"),
            base_revision,
            must_not_exist,
        })])
    };
    let r = mdbn_core::plan(&put("_types/task.md", true, None), &s, &head()).unwrap_err();
    assert_eq!(
        (r.code, r.reason.as_deref()),
        (RejectCode::Conflict, Some("path_taken"))
    );
    assert!(mdbn_core::plan(&put("_types/new.md", true, None), &s, &head()).is_ok());
    let r = mdbn_core::plan(
        &put("_types/new.md", true, Some(Hash::of(b"x"))),
        &s,
        &head(),
    )
    .unwrap_err();
    assert_eq!(r.code, RejectCode::InvalidRequest);
    // Without the flag a put replaces blindly, as before.
    assert!(mdbn_core::plan(&put("_types/task.md", false, None), &s, &head()).is_ok());
}

#[test]
fn resource_writes_end_the_batch_and_must_stay_valid() {
    let s = base_state();
    let good = mutation(vec![Op::ResourcePut(ResourcePut {
        path: "_types/note.md".into(),
        doc: TASK
            .replace("name: task", "name: note")
            .replace("tasks/", "notes/"),
        base_revision: None,
        must_not_exist: false,
    })]);
    let p = mdbn_core::plan(&good, &s, &head()).unwrap();
    assert!(p.ends_batch);
    let bad = mutation(vec![Op::ResourcePut(ResourcePut {
        path: "mdbase.yaml".into(),
        doc: "spec_version: \"9\"\n".into(),
        base_revision: None,
        must_not_exist: false,
    })]);
    assert_eq!(
        mdbn_core::plan(&bad, &s, &head()).unwrap_err().code,
        RejectCode::InvalidRecord
    );
}

// ------------------------------------------------------------- properties

/// splitmix64: a tiny deterministic generator for the property tests.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

fn random_op(rng: &mut Rng, n: u8) -> Op {
    let target = id(1 + u8::try_from(rng.below(4)).unwrap());
    let word = |rng: &mut Rng| {
        Value::string(["open", "done", "x", "y"][usize::try_from(rng.below(4)).unwrap()])
    };
    match rng.below(5) {
        0 => Op::Create(Create {
            id: id(100 + n),
            type_name: Some("task".into()),
            frontmatter: patch(&[("title", word(rng))]),
            ..Create::default()
        }),
        1 => Op::Update(Update {
            id: target,
            patch: patch(&[("status", word(rng))]),
            base: if rng.below(2) == 0 {
                vec![BaseField {
                    key: "status".into(),
                    observed: Some(word(rng)),
                }]
            } else {
                Vec::new()
            },
            ..Update::default()
        }),
        2 => Op::Update(Update {
            id: target,
            add: vec![("tags".into(), vec![word(rng)])],
            body: Some(format!("body {}\n", rng.below(3))),
            ..Update::default()
        }),
        3 => Op::Delete(Delete {
            id: target,
            ..Delete::default()
        }),
        _ => Op::Rename(Rename {
            id: target,
            from: "tasks/a.md".into(),
            to: format!("tasks/r{}.md", rng.below(3)),
            update_refs: true,
            if_revision: None,
        }),
    }
}

#[test]
fn planning_is_deterministic_and_overlay_transparent() {
    for seed in 0..300u64 {
        let mut rng = Rng(seed);
        let mut state = base_state();
        state.insert_record(id(3), "tasks/c.md", "---\ntitle: C\ntags: [x]\n---\n");
        for step in 0..8u8 {
            let m = {
                let mut m = mutation(vec![random_op(&mut rng, step)]);
                m.seed = [u8::try_from(seed % 251).unwrap(); 32];
                m
            };
            let a = mdbn_core::plan(&m, &state, &head());
            // Same inputs, same output.
            assert_eq!(a, mdbn_core::plan(&m, &state, &head()), "seed {seed}");
            // An empty overlay is invisible.
            let ov = Overlay::new(&state);
            assert_eq!(a, mdbn_core::plan(&m, &ov, &head()), "seed {seed}");
            // Applying the result and planning over the overlay agrees with a
            // materialized state.
            if let Ok(p) = &a {
                let mut ov = Overlay::new(&state);
                ov.apply(p);
                let mut next = state.clone();
                next.apply(p);
                let probe = mutation(vec![random_op(&mut Rng(seed ^ 0xabc), 50)]);
                assert_eq!(
                    mdbn_core::plan(&probe, &ov, &head()),
                    mdbn_core::plan(&probe, &next, &head()),
                    "seed {seed}"
                );
                assert_eq!(ov.record_ids(), next.record_ids());
                state = next;
            }
        }
    }
}

#[test]
fn resurrection_restores_resource_creates_despite_new_occupants() {
    let mut state = base_state();
    let desired = TASK.replace(
        "title: {type: string}",
        "title: {type: string, minLength: 2}",
    );
    let write = mutation(vec![Op::ResourcePut(ResourcePut {
        path: "_types/task.md".into(),
        doc: desired.clone(),
        base_revision: None,
        must_not_exist: true,
    })]);
    for stage in [
        Stage::Submit {
            level: mdbn_core::intent::Level::Warn,
        },
        Stage::Head,
    ] {
        let rejected = mdbn_core::plan(&write, &state, &PlanOptions { stage }).unwrap_err();
        assert_eq!(rejected.reason.as_deref(), Some("path_taken"));
    }
    let options = PlanOptions {
        stage: Stage::Resurrect,
    };
    let restored = mdbn_core::plan(&write, &state, &options).unwrap();
    assert_eq!(restored.status, Status::Merged);
    assert!(restored.ends_batch);
    assert_eq!(
        restored.effects,
        vec![Effect::PutResource {
            path: "_types/task.md".into(),
            doc: desired.clone()
        }]
    );
    let issue = restored
        .issues
        .iter()
        .find(|i| i.issue.code == "concurrent_modification")
        .unwrap();
    assert_eq!(
        issue.issue.details,
        Some(Value::string(revision(TASK).to_string()))
    );
    assert!(
        restored
            .issues
            .iter()
            .all(|i| i.issue.code != "resurrect_skipped")
    );
    assert_eq!(restored, mdbn_core::plan(&write, &state, &options).unwrap());
    state.apply(&restored);
    assert_eq!(
        state.resource("_types/task.md").as_deref(),
        Some(desired.as_str())
    );
    // Replaying the same create-only write still resolves its stale condition,
    // but equal bytes need no new effect and never become resurrect_skipped.
    let noop = mdbn_core::plan(&write, &state, &options).unwrap();
    assert!(noop.effects.is_empty());
    assert_eq!(noop.status, Status::Merged);
    assert!(
        noop.issues
            .iter()
            .any(|i| i.issue.code == "concurrent_modification")
    );
}

#[test]
fn resurrection_and_head_do_not_compute_submit_only_broken_backlinks() {
    let state = base_state();
    let write = mutation(vec![Op::Delete(Delete {
        id: id(1),
        ..Delete::default()
    })]);
    let submit = mdbn_core::plan(
        &write,
        &state,
        &PlanOptions {
            stage: Stage::Submit {
                level: mdbn_core::intent::Level::Warn,
            },
        },
    )
    .unwrap();
    assert_eq!(submit.broken_links.len(), 1);
    assert_eq!(submit.broken_links[0].id, id(2));
    for stage in [Stage::Head, Stage::Resurrect] {
        let planned = mdbn_core::plan(&write, &state, &PlanOptions { stage }).unwrap();
        assert!(planned.broken_links.is_empty());
        assert_eq!(planned.effects, submit.effects);
        assert_eq!(
            planned,
            mdbn_core::plan(&write, &state, &PlanOptions { stage }).unwrap()
        );
    }
}

#[test]
fn resurrection_resolves_every_s_class_check() {
    let s = base_state();
    let resurrect = PlanOptions {
        stage: Stage::Resurrect,
    };
    // Explicit path taken → suffixed, reported.
    let taken = mutation(vec![Op::Create(Create {
        id: id(10),
        path: Some("tasks/a.md".into()),
        frontmatter: patch(&[("title", Value::string("X"))]),
        ..Create::default()
    })]);
    assert!(mdbn_core::plan(&taken, &s, &head()).is_err());
    let p = mdbn_core::plan(&taken, &s, &resurrect).unwrap();
    assert!(matches!(&p.effects[0], Effect::PutRecord { path, .. } if path == "tasks/a (2).md"));
    assert!(p.issues.iter().any(|i| i.issue.code == "record_renamed"));
    assert_eq!(p.status, Status::Merged);
    // Stale CAS → applied, merged.
    let cas = mutation(vec![Op::Update(Update {
        id: id(1),
        patch: patch(&[("x", Value::Int(1))]),
        if_revision: Some(Hash::of(b"stale")),
        ..Update::default()
    })]);
    assert!(mdbn_core::plan(&cas, &s, &head()).is_err());
    let p = mdbn_core::plan(&cas, &s, &resurrect).unwrap();
    assert!(doc_of(&p, id(1)).contains("x: 1"));
    // Stale CAS on delete → superseded.
    let del = mutation(vec![Op::Delete(Delete {
        id: id(1),
        base_revision: None,
        if_revision: Some(Hash::of(b"stale")),
    })]);
    let p = mdbn_core::plan(&del, &s, &resurrect).unwrap();
    assert_eq!(p.status, Status::Conflicted);
    assert!(p.effects.is_empty());
    // Rename race: stale `from` and a taken `to`.
    let mut s2 = base_state();
    s2.insert_record(id(5), "tasks/z.md", "---\ntitle: Z\n---\n");
    let ren = mutation(vec![Op::Rename(Rename {
        id: id(1),
        from: "tasks/old.md".into(),
        to: "tasks/z.md".into(),
        update_refs: false,
        if_revision: None,
    })]);
    assert!(mdbn_core::plan(&ren, &s2, &head()).is_err());
    let p = mdbn_core::plan(&ren, &s2, &resurrect).unwrap();
    assert!(matches!(&p.effects[0], Effect::PutRecord { path, .. } if path == "tasks/z (2).md"));
    // Enforced uniqueness → applied and reported.
    let dup = mutation(vec![Op::Create(Create {
        id: id(11),
        path: Some("tasks/c.md".into()),
        frontmatter: patch(&[("title", Value::string("C")), ("code", Value::string("X"))]),
        ..Create::default()
    })]);
    assert!(mdbn_core::plan(&dup, &s, &head()).is_err());
    let p = mdbn_core::plan(&dup, &s, &resurrect).unwrap();
    assert!(p.issues.iter().any(|i| i.issue.code == "duplicate_value"));
    // Update of a deleted record → recreated, the delete recorded.
    let mut s3 = base_state();
    let gone = mdbn_core::plan(
        &mutation(vec![Op::Delete(Delete {
            id: id(1),
            ..Delete::default()
        })]),
        &s3,
        &head(),
    )
    .unwrap();
    s3.apply(&gone);
    let p = mdbn_core::plan(&cas, &s3, &resurrect).unwrap();
    assert_eq!(p.status, Status::Conflicted);
    assert!(p.conflicts.iter().any(|c| c.kind == ConflictKind::Delete));
}

#[test]
fn resurrection_never_rejects_random_writes() {
    let resurrect = PlanOptions {
        stage: Stage::Resurrect,
    };
    let mut rejected_at_head = 0;
    for seed in 0..300u64 {
        let mut rng = Rng(seed);
        let mut state = base_state();
        state.insert_record(id(3), "tasks/c.md", "---\ntitle: C\ntags: [x]\n---\n");
        for step in 0..8u8 {
            let mut m = mutation(vec![random_op(&mut rng, step)]);
            if rng.below(3) == 0
                && let Op::Update(u) = &mut m.ops[0]
            {
                u.if_revision = Some(Hash::of(b"stale"));
            }
            if mdbn_core::plan(&m, &state, &head()).is_err() {
                rejected_at_head += 1;
            }
            let p = mdbn_core::plan(&m, &state, &resurrect).unwrap_or_else(|r| {
                panic!("seed {seed}: resurrection rejected {:?}: {r:?}", m.ops[0])
            });
            assert_eq!(
                p,
                mdbn_core::plan(&m, &state, &resurrect).unwrap(),
                "deterministic"
            );
            state.apply(&p);
        }
    }
    assert!(
        rejected_at_head > 100,
        "only {rejected_at_head} head rejections exercised"
    );
}
