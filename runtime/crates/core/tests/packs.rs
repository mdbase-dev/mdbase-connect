//! Type packs: assessment is deterministic and binds live state; apply is one
//! mutation and a current pack writes nothing.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use mdbn_core::ids::{Uuid, revision};
use mdbn_core::intent::{ConflictMode, Mutation, OpClock, Source};
use mdbn_core::packs::{
    Action, AssessOptions, PackStatus, apply_type_pack, assess_type_pack, load_pack,
};
use mdbn_core::plan::{PlanOptions, Stage};
use mdbn_core::state::{MemState, StateView};

const TYPE: &str = "---\nkind: mdbase.type\nname: note\nversion: 1\nschema:\n  dialect: json-schema-2020-12\n  value: {type: object}\n---\n";

fn manifest() -> String {
    format!(
        "kind: mdbase.type-pack\nid: example.notes\nversion: 1.0.0\nresources:\n  - kind: type\n    mode: managed\n    source: note.md\n    target: _types/note.md\n    digest: {}\n",
        revision(TYPE)
    )
}

fn opts() -> AssessOptions {
    AssessOptions {
        installed_by: "dev.example.tests".into(),
        ..AssessOptions::default()
    }
}

fn apply(state: &mut MemState, ops: Vec<mdbn_core::intent::Op>) {
    let m = Mutation {
        id: Uuid::NIL,
        origin: Uuid::NIL,
        base_seq: 0,
        clock: OpClock {
            instant_ms: 0,
            tz: "UTC".into(),
            local_date: "1970-01-01".into(),
        },
        seed: [0; 32],
        source: Source::Api,
        ops,
        on_behalf: None,
        conflict_mode: ConflictMode::Record,
        validated_at: None,
        room: None,
    };
    let p = mdbn_core::plan(&m, &*state, &PlanOptions { stage: Stage::Head }).unwrap();
    state.apply(&p);
}

#[test]
fn assess_apply_and_reassess() {
    let pack = load_pack(&manifest(), &|s| (s == "note.md").then(|| TYPE.to_owned())).unwrap();
    let mut state = MemState::new();
    let a = assess_type_pack(&state, &pack, &opts()).unwrap();
    assert_eq!(a.status, PackStatus::Install);
    assert_eq!(
        a,
        assess_type_pack(&state, &pack, &opts()).unwrap(),
        "deterministic"
    );
    // Another state gives another digest.
    let mut other = MemState::new();
    other.insert_resource("_types/note.md", TYPE);
    assert_ne!(
        a.assessment_digest,
        assess_type_pack(&other, &pack, &opts())
            .unwrap()
            .assessment_digest
    );

    let (_, ops) = apply_type_pack(&state, &pack, &opts(), &a.assessment_digest).unwrap();
    assert_eq!(ops.len(), 2, "the type and the lock, in one mutation");
    apply(&mut state, ops);
    assert_eq!(state.catalog().types().len(), 1);

    let again = assess_type_pack(&state, &pack, &opts()).unwrap();
    assert_eq!(again.status, PackStatus::Current);
    assert_eq!(again.resources[0].action, Action::Unchanged);
    let (_, ops) = apply_type_pack(&state, &pack, &opts(), &again.assessment_digest).unwrap();
    assert!(ops.is_empty(), "a current pack writes nothing");

    // A stale digest is a concurrent modification.
    state.insert_resource("_types/note.md", &format!("{TYPE}\nedited\n"));
    let e = apply_type_pack(&state, &pack, &opts(), &again.assessment_digest).unwrap_err();
    assert_eq!(e.code, "concurrent_modification");
}

#[test]
fn invalid_pack_paths_never_reach_source_callback() {
    for path in [
        "C:escape.md",
        "a/./note.md",
        "a/../note.md",
        "a//note.md",
        "a/CON.md",
        ".mdbase/state",
        "a/trailing.",
    ] {
        for (key, original) in [("source", "note.md"), ("target", "_types/note.md")] {
            let manifest =
                manifest().replace(&format!("{key}: {original}"), &format!("{key}: {path}"));
            let calls = std::cell::Cell::new(0);
            let issue = load_pack(&manifest, &|_| {
                calls.set(calls.get() + 1);
                Some(TYPE.to_owned())
            })
            .unwrap_err();
            assert_eq!(issue.code, "invalid_type_pack", "{key}: {path}");
            assert_eq!(
                calls.get(),
                0,
                "invalid {key} must be rejected before source loading"
            );
        }
    }
}

#[test]
fn assessment_rechecks_public_pack_and_override_paths() {
    let pack = load_pack(&manifest(), &|s| (s == "note.md").then(|| TYPE.to_owned())).unwrap();
    let state = MemState::new();
    let mut options = opts();
    options
        .target_overrides
        .insert("_types/note.md".into(), "_types/CON.md".into());
    assert_eq!(
        assess_type_pack(&state, &pack, &options).unwrap_err().code,
        "invalid_type_pack"
    );
    for source in [true, false] {
        let mut constructed = pack.clone();
        if source {
            constructed.resources[0].source = "C:escape.md".into();
        } else {
            constructed.resources[0].target = "_types/CON.md".into();
        }
        assert_eq!(
            assess_type_pack(&state, &constructed, &opts())
                .unwrap_err()
                .code,
            "invalid_type_pack"
        );
    }
}

#[test]
fn apply_rejects_desired_document_changed_after_review() {
    let mut pack = load_pack(&manifest(), &|s| (s == "note.md").then(|| TYPE.to_owned())).unwrap();
    let state = MemState::new();
    let assessment = assess_type_pack(&state, &pack, &opts()).unwrap();
    pack.resources[0].document = TYPE.replace("version: 1", "version: 2");
    assert_eq!(
        apply_type_pack(&state, &pack, &opts(), &assessment.assessment_digest)
            .unwrap_err()
            .code,
        "invalid_type_pack",
        "changed desired bytes must not be emitted under the reviewed digest"
    );
}

#[test]
fn assessment_binds_all_ordered_desired_inputs_not_just_manifest_identity() {
    let pack = load_pack(&manifest(), &|s| (s == "note.md").then(|| TYPE.to_owned())).unwrap();
    let state = MemState::new();
    let before = assess_type_pack(&state, &pack, &opts()).unwrap();
    for field in ["document", "source", "mode", "kind"] {
        let mut changed = pack.clone();
        match field {
            "document" => {
                changed.resources[0].document = TYPE.replace("version: 1", "version: 2");
                changed.resources[0].digest = revision(&changed.resources[0].document);
            }
            "source" => changed.resources[0].source = "other.md".into(),
            "mode" => changed.resources[0].mode = mdbn_core::packs::Mode::Seed,
            "kind" => changed.resources[0].kind = "schema".into(),
            _ => unreachable!(),
        }
        assert_eq!(
            changed.digest, pack.digest,
            "same declared manifest identity"
        );
        let reassessed = assess_type_pack(&state, &changed, &opts()).unwrap();
        assert_ne!(
            before.assessment_digest, reassessed.assessment_digest,
            "{field}"
        );
        assert_eq!(
            apply_type_pack(&state, &changed, &opts(), &before.assessment_digest)
                .unwrap_err()
                .code,
            "concurrent_modification",
            "{field}"
        );
    }
}

#[test]
fn seed_baselines_are_revalidated_and_bound_after_review() {
    let mut pack = load_pack(&manifest(), &|s| (s == "note.md").then(|| TYPE.to_owned())).unwrap();
    let resource = &mut pack.resources[0];
    resource.mode = mdbn_core::packs::Mode::Seed;
    resource.document = TYPE.replace("version: 1", "version: 3");
    resource.digest = revision(&resource.document);
    resource.baselines.push(mdbn_core::packs::Baseline {
        digest: revision(TYPE),
        document: TYPE.into(),
        version: Some(1),
    });
    let state = MemState::new();
    let before = assess_type_pack(&state, &pack, &opts()).unwrap();
    let mut inconsistent = pack.clone();
    inconsistent.resources[0].baselines[0]
        .document
        .push_str("different baseline bytes\n");
    assert_eq!(
        apply_type_pack(&state, &inconsistent, &opts(), &before.assessment_digest)
            .unwrap_err()
            .code,
        "invalid_type_pack"
    );
    let mut changed = inconsistent;
    changed.resources[0].baselines[0].digest =
        revision(&changed.resources[0].baselines[0].document);
    assert_ne!(
        assess_type_pack(&state, &changed, &opts())
            .unwrap()
            .assessment_digest,
        before.assessment_digest
    );
    assert_eq!(
        apply_type_pack(&state, &changed, &opts(), &before.assessment_digest)
            .unwrap_err()
            .code,
        "concurrent_modification"
    );
}

#[test]
fn assessment_binds_resource_and_baseline_order() {
    let mut pack = load_pack(&manifest(), &|s| (s == "note.md").then(|| TYPE.to_owned())).unwrap();
    pack.resources[0].mode = mdbn_core::packs::Mode::Seed;
    pack.resources[0].document = TYPE.replace("version: 1", "version: 3");
    pack.resources[0].digest = revision(&pack.resources[0].document);
    for version in [1, 2] {
        let document = TYPE.replace("version: 1", &format!("version: {version}"));
        pack.resources[0]
            .baselines
            .push(mdbn_core::packs::Baseline {
                digest: revision(&document),
                document,
                version: Some(version),
            });
    }
    let mut extra = pack.resources[0].clone();
    extra.mode = mdbn_core::packs::Mode::Managed;
    extra.source = "extra.md".into();
    extra.target = "_types/extra.md".into();
    extra.document = TYPE.replace("name: note", "name: extra");
    extra.digest = revision(&extra.document);
    extra.baselines.clear();
    pack.resources.push(extra);
    let state = MemState::new();
    let before = assess_type_pack(&state, &pack, &opts()).unwrap();
    for baseline in [false, true] {
        let mut changed = pack.clone();
        if baseline {
            changed.resources[0].baselines.swap(0, 1);
        } else {
            changed.resources.swap(0, 1);
        }
        assert_eq!(
            apply_type_pack(&state, &changed, &opts(), &before.assessment_digest)
                .unwrap_err()
                .code,
            "concurrent_modification"
        );
    }
}

#[test]
fn creates_never_overwrite_a_concurrent_create() {
    let pack = load_pack(&manifest(), &|s| (s == "note.md").then(|| TYPE.to_owned())).unwrap();
    let state = MemState::new();
    let a = assess_type_pack(&state, &pack, &opts()).unwrap();
    let (_, ops) = apply_type_pack(&state, &pack, &opts(), &a.assessment_digest).unwrap();
    // Someone else creates the type before the pack's mutation reaches head.
    let mut head = MemState::new();
    head.insert_resource("_types/note.md", &TYPE.replace("version: 1", "version: 9"));
    let m = Mutation {
        id: Uuid::NIL,
        origin: Uuid::NIL,
        base_seq: 0,
        clock: OpClock {
            instant_ms: 0,
            tz: "UTC".into(),
            local_date: "1970-01-01".into(),
        },
        seed: [0; 32],
        source: Source::Api,
        ops,
        on_behalf: None,
        conflict_mode: ConflictMode::Record,
        validated_at: None,
        room: None,
    };
    let r = mdbn_core::plan(&m, &head, &PlanOptions { stage: Stage::Head }).unwrap_err();
    assert_eq!(r.reason.as_deref(), Some("path_taken"));
}
