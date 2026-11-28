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
fn assessment_refuses_overrides_that_merge_two_targets() {
    let mut options = opts();
    options
        .target_overrides
        .insert(SEED.into(), "_contracts/example.note.md".into());
    assert_eq!(
        assess_type_pack(&MemState::new(), &seed_pack(1), &options)
            .unwrap_err()
            .code,
        "invalid_type_pack"
    );
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

#[test]
fn folder_overrides_install_into_configured_definition_folders() {
    let pack = load_pack(&manifest(), &|s| (s == "note.md").then(|| TYPE.to_owned())).unwrap();
    let mut state = MemState::new();
    state.insert_resource(
        "mdbase.yaml",
        "spec_version: '0.3.0'\nsettings:\n  types_folder: Types\n",
    );
    let overrides = mdbn_core::packs::folder_target_overrides(&state, &pack);
    assert_eq!(
        overrides.into_iter().collect::<Vec<_>>(),
        vec![("_types/note.md".to_owned(), "Types/note.md".to_owned())]
    );
    let opts = AssessOptions {
        target_overrides: mdbn_core::packs::folder_target_overrides(&state, &pack),
        ..opts()
    };
    let a = assess_type_pack(&state, &pack, &opts).unwrap();
    let (_, ops) = apply_type_pack(&state, &pack, &opts, &a.assessment_digest).unwrap();
    apply(&mut state, ops);
    assert_eq!(state.catalog().types()[0].source_path, "Types/note.md");
    // Default folders need no overrides.
    assert!(mdbn_core::packs::folder_target_overrides(&MemState::new(), &pack).is_empty());
}

#[test]
fn schemas_follow_the_contracts_parent_and_relative_refs_resolve_after_install() {
    let contract = CONTRACT.replace(
        "value: {type: object, properties: {title: {type: string}}, required: [title]}",
        "ref: ../../schemas/example.note/1.0.0.schema.json",
    );
    let schema =
        r#"{"type":"object","properties":{"title":{"type":"string"}},"required":["title"]}"#;
    let resources = [
        ("type", "_types/note.md", SEED_V1),
        (
            "contract",
            "_contracts/example.note/1.0.0.md",
            contract.as_str(),
        ),
        ("schema", "schemas/example.note/1.0.0.schema.json", schema),
        ("schema", "_schemas/tasknotes/settings.json", schema),
    ];
    let mut manifest =
        "kind: mdbase.type-pack\nid: example.notes\nversion: 1.0.0\nresources:\n".to_owned();
    for (kind, target, document) in resources {
        manifest.push_str(&format!(
            "  - kind: {kind}\n    mode: managed\n    source: {target}\n    target: {target}\n    digest: {}\n", revision(document)
        ));
    }
    let pack = load_pack(&manifest, &|source| {
        resources
            .iter()
            .find(|(_, path, _)| *path == source)
            .map(|(_, _, document)| (*document).to_owned())
    })
    .unwrap();
    for prefix in ["", "_mdbase/", "nested/metadata/"] {
        let mut state = MemState::new();
        let (types, contracts) = if prefix.is_empty() {
            ("_types".to_owned(), "_contracts".to_owned())
        } else {
            (format!("{prefix}types"), format!("{prefix}contracts"))
        };
        state.insert_resource("mdbase.yaml", &format!(
            "spec_version: '0.3.0'\nsettings:\n  types_folder: {types}\n  contracts_folder: {contracts}\n"
        ));
        let overrides = mdbn_core::packs::folder_target_overrides(&state, &pack);
        if prefix.is_empty() {
            assert!(overrides.is_empty());
        } else {
            assert_eq!(overrides.len(), 4);
            assert_eq!(
                overrides["schemas/example.note/1.0.0.schema.json"],
                format!("{prefix}schemas/example.note/1.0.0.schema.json")
            );
            assert_eq!(
                overrides["_schemas/tasknotes/settings.json"],
                format!("{prefix}_schemas/tasknotes/settings.json")
            );
        }
        let options = AssessOptions {
            target_overrides: overrides,
            ..opts()
        };
        let assessment = assess_type_pack(&state, &pack, &options).unwrap();
        assert!(assessment.applicable(), "{prefix}: {:?}", assessment.issues);
        let (_, ops) =
            apply_type_pack(&state, &pack, &options, &assessment.assessment_digest).unwrap();
        apply(&mut state, ops);
        assert!(
            state
                .resource(&format!("{prefix}schemas/example.note/1.0.0.schema.json"))
                .is_some()
        );
        assert!(
            state
                .resource(&format!("{prefix}_schemas/tasknotes/settings.json"))
                .is_some()
        );
        assert_eq!(state.catalog().contracts().len(), 1);
        assert!(
            state.catalog().issues().is_empty(),
            "{:?}",
            state.catalog().issues()
        );
        assert_eq!(
            assess_type_pack(&state, &pack, &options).unwrap().status,
            PackStatus::Current
        );
    }
}

#[test]
fn edited_seed_upgrades_keep_the_publishers_bytes_for_upgraded_entries() {
    let base = "---\nkind: mdbase.type\nname: note\nversion: 1\nschema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\n    required: [id, digest]\n    properties:\n      id: { type: string, minLength: 1 }\n      digest: { type: string, pattern: '^sha256:[0-9a-f]{64}$' }\ncollection:\n  path:\n    folder: notes\n---\n# Note\n";
    let desired = base
        .replace("version: 1", "version: 2")
        .replace("[id, digest]", "[id, digest, state]")
        .replace(
            "      digest:",
            "      state: { enum: [active, done] }\n      digest:",
        );
    let mut pack = load_pack(&manifest(), &|s| (s == "note.md").then(|| TYPE.to_owned())).unwrap();
    let resource = &mut pack.resources[0];
    resource.mode = mdbn_core::packs::Mode::Seed;
    resource.document = desired.clone();
    resource.digest = revision(&desired);
    resource.baselines.push(mdbn_core::packs::Baseline {
        digest: revision(base),
        document: base.into(),
        version: Some(1),
    });
    let mut state = MemState::new();
    state.insert_resource(
        "_types/note.md",
        &base.replace("folder: notes", "folder: inbox"),
    );
    state.insert_resource(
        "mdbase.lock.yaml",
        &format!(
            "kind: mdbase.type-pack-lock\nlock_version: 1\npacks:\n  - id: example.notes\n    version: 1.0.0\n    digest: {base}\n    installed_by: dev.example.tests\n    resources:\n      - kind: type\n        mode: seed\n        source: note.md\n        target: _types/note.md\n        digest: {base}\n        origin_digest: {base}\n",
            base = revision(base)
        ),
    );
    let a = assess_type_pack(&state, &pack, &opts()).unwrap();
    assert_eq!(a.resources[0].action, Action::Update);
    assert_eq!(
        a.resources[0].document.as_deref(),
        Some(desired.replace("folder: notes", "folder: inbox").as_str()),
        "the user's edit survives and every upgraded entry is the publisher's text"
    );
}

// ---------------------------------------------------------------- seeds

const CONTRACT: &str = "---\nkind: mdbase.contract\nid: example.note\nversion: 1.0.0\ncontract_type: record\nrecord_schema:\n  dialect: json-schema-2020-12\n  value: {type: object, properties: {title: {type: string}}, required: [title]}\n---\n";
const SEED_V1: &str = "---\nkind: mdbase.type\nname: note\nversion: 1\ndescription: A note.\nschema:\n  dialect: json-schema-2020-12\n  value: {type: object, properties: {title: {type: string}}}\nimplements:\n  - contract: example.note\n    version: ^1.0.0\n    fields: {title: title}\n---\n# Note\n";
const SEED_V2: &str = "---\nkind: mdbase.type\nname: note\nversion: 2\ndescription: A note with tags.\nschema:\n  dialect: json-schema-2020-12\n  value: {type: object, properties: {title: {type: string}, tags: {type: array}}}\nimplements:\n  - contract: example.note\n    version: ^1.0.0\n    fields: {title: title}\n---\n# Note\n";
/// `SEED_V1` as another writer re-serialises it: sorted keys, block style.
const SEED_V1_REWRITTEN: &str = "---\ndescription: A note.\nimplements:\n- contract: example.note\n  fields:\n    title: title\n  version: ^1.0.0\nkind: mdbase.type\nname: note\nschema:\n  dialect: json-schema-2020-12\n  value:\n    properties:\n      title:\n        type: string\n    type: object\nversion:\n  1\n---\n# Note\n";
const SEED: &str = "_types/note.md";

/// A contract plus a seed type; `version` 2 lists version 1 as its baseline.
fn seed_pack(version: u32) -> mdbn_core::packs::Pack {
    let seed = if version == 1 { SEED_V1 } else { SEED_V2 };
    let mut manifest = format!(
        "kind: mdbase.type-pack\nid: example.notes\nversion: {version}.0.0\nresources:\n  - kind: contract\n    mode: managed\n    source: contract.md\n    target: _contracts/example.note.md\n    digest: {}\n  - kind: type\n    mode: seed\n    source: note.md\n    target: {SEED}\n    digest: {}\n",
        revision(CONTRACT),
        revision(seed)
    );
    if version == 2 {
        manifest.push_str(&format!(
            "    upgrade_from:\n      - digest: {}\n        version: 1\n        document: |\n",
            revision(SEED_V1)
        ));
        for line in SEED_V1.lines() {
            manifest.push_str(&format!("          {line}\n"));
        }
    }
    load_pack(&manifest, &|s| match s {
        "contract.md" => Some(CONTRACT.to_owned()),
        "note.md" => Some(seed.to_owned()),
        _ => None,
    })
    .unwrap()
}

#[test]
fn existing_seed_requires_review_only_when_it_lacks_the_pack_contract() {
    let pack = seed_pack(1);
    let mut state = MemState::new();
    let plan = |state: &MemState| {
        assess_type_pack(state, &pack, &opts())
            .unwrap()
            .resources
            .into_iter()
            .find(|r| r.target == SEED)
            .unwrap()
    };
    state.insert_resource(SEED, SEED_V1_REWRITTEN);
    assert_eq!(plan(&state).action, Action::Preserve);
    state.insert_resource(SEED, &SEED_V1.replace("A note.", "My custom note."));
    assert!(plan(&state).reason.is_none());

    state.insert_resource(SEED, TYPE);
    let vacant = plan(&state);
    assert_eq!(vacant.action, Action::Conflict);
    assert!(vacant.reason.is_some() && vacant.replaceable());
    assert_eq!(vacant.live, Some(revision(TYPE)));

    state.insert_record(Uuid([1; 16]), "existing.md", "---\ntype: note\n---\n");
    let used = plan(&state);
    assert!(used.in_use && !used.replaceable());
    assert_eq!(used.document, None);

    state.insert_resource(
        "_types/other.md",
        &SEED_V1.replace("name: note", "name: other"),
    );
    let supported = plan(&state);
    assert_eq!(supported.action, Action::Preserve);
    assert!(supported.reason.is_none());

    // A receipt distinguishes a person's later edit from a first-install collision.
    assert!(plan(&legacy_seed(1, TYPE)).reason.is_none());
}

/// Install `version`, then leave the receipt as a legacy installer wrote it
/// (no seed origins) and the seed as `live`.
fn legacy_seed(version: u32, live: &str) -> MemState {
    let mut state = MemState::new();
    let pack = seed_pack(version);
    let a = assess_type_pack(&state, &pack, &opts()).unwrap();
    let (_, ops) = apply_type_pack(&state, &pack, &opts(), &a.assessment_digest).unwrap();
    apply(&mut state, ops);
    let lock: String = state
        .resource(mdbn_core::types::LOCK_PATH)
        .unwrap()
        .lines()
        .filter(|l| !l.trim_start().starts_with("origin_digest:"))
        .map(|l| format!("{l}\n"))
        .collect();
    state.insert_resource(mdbn_core::types::LOCK_PATH, &lock);
    state.insert_resource(SEED, live);
    state
}

fn seed_plan(state: &MemState) -> mdbn_core::packs::PlannedResource {
    let a = assess_type_pack(state, &seed_pack(2), &opts()).unwrap();
    a.resources.into_iter().find(|r| r.target == SEED).unwrap()
}

fn field(doc: &str, path: &[&str]) -> Option<mdbn_core::value::Value> {
    let d = mdbn_core::doc::Document::parse(doc, mdbn_core::doc::RecordFormat::Markdown);
    let mut v = mdbn_core::value::Value::Map(d.frontmatter().clone());
    for k in path {
        v = v.get(k)?.clone();
    }
    Some(v)
}

#[test]
fn a_rewritten_desired_seed_is_current_and_records_its_origin() {
    let rewritten = SEED_V1_REWRITTEN
        .replace("version:\n  1", "version:\n  2")
        .replace("description: A note.", "description: A note with tags.")
        .replace(
            "        type: string\n",
            "        type: string\n      tags:\n        type: array\n",
        );
    let mut state = legacy_seed(2, &rewritten);
    let p = seed_plan(&state);
    assert_eq!((p.action, p.reason.as_deref()), (Action::Preserve, None));
    assert_eq!(p.origin, Some(revision(SEED_V2)));
    let pack = seed_pack(2);
    let a = assess_type_pack(&state, &pack, &opts()).unwrap();
    assert_eq!(a.lock_action, Action::Update, "the origin is recorded");
    let (_, ops) = apply_type_pack(&state, &pack, &opts(), &a.assessment_digest).unwrap();
    assert_eq!(ops.len(), 1, "only the lock is written");
    apply(&mut state, ops);
    assert_eq!(state.resource(SEED).as_deref(), Some(rewritten.as_str()));
}

#[test]
fn a_rewritten_baseline_seed_upgrades_to_the_exact_desired_bytes() {
    let p = seed_plan(&legacy_seed(1, SEED_V1_REWRITTEN));
    assert_eq!(p.action, Action::Update);
    assert_eq!(p.document.as_deref(), Some(SEED_V2));
    assert_eq!(p.upgrade_baseline, Some((revision(SEED_V1), Some(1))));
    assert_eq!(p.origin, Some(revision(SEED_V2)));
}

#[test]
fn a_customised_seed_without_an_origin_merges_against_the_inferred_baseline() {
    let customised = SEED_V1_REWRITTEN.replace(
        "        type: string\n",
        "        type: string\n        minLength: 3\n",
    );
    let mut state = legacy_seed(1, &customised);
    let p = seed_plan(&state);
    assert_eq!(p.action, Action::Update, "{:?}", p.reason);
    assert_eq!(p.upgrade_baseline, Some((revision(SEED_V1), Some(1))));
    assert_eq!(p.origin, Some(revision(SEED_V2)));
    let merged = p.document.as_deref().unwrap();
    let property = |name: &str| field(merged, &["schema", "value", "properties", name]);
    assert_eq!(
        property("title").and_then(|t| t.get("minLength").cloned()),
        Some(mdbn_core::value::Value::Int(3))
    );
    assert!(property("tags").is_some());
    assert_eq!(
        field(merged, &["version"]),
        Some(mdbn_core::value::Value::Int(2))
    );
    let pack = seed_pack(2);
    let a = assess_type_pack(&state, &pack, &opts()).unwrap();
    assert!(a.applicable(), "{:?}", a.issues);
    let (_, ops) = apply_type_pack(&state, &pack, &opts(), &a.assessment_digest).unwrap();
    apply(&mut state, ops);
    // The recorded origin makes the customised type plainly current.
    let p = seed_plan(&state);
    assert_eq!((p.action, p.reason.as_deref()), (Action::Preserve, None));
}

#[test]
fn a_seed_that_cannot_merge_but_implements_the_pack_is_kept_as_it_is() {
    let competing = SEED_V1_REWRITTEN.replace("description: A note.", "description: My notes.");
    let p = seed_plan(&legacy_seed(1, &competing));
    assert_eq!((p.action, p.reason.as_deref()), (Action::Preserve, None));
    assert_eq!(p.origin, None);
    assert!(!p.replaceable());
}

#[test]
fn an_inferred_merge_must_still_implement_the_desired_contracts() {
    // The user dropped the implementation: the merge is clean but the result
    // no longer implements example.note, so it is not taken as an upgrade.
    let start = SEED_V1_REWRITTEN.find("implements:").unwrap();
    let end = SEED_V1_REWRITTEN.find("kind: mdbase.type").unwrap();
    let unimplemented = format!(
        "{}{}",
        &SEED_V1_REWRITTEN[..start],
        &SEED_V1_REWRITTEN[end..]
    );
    let p = seed_plan(&legacy_seed(1, &unimplemented));
    assert_eq!(p.action, Action::Preserve);
    assert!(p.reason.unwrap().contains("no upgrade baseline applies"));
}

#[test]
fn a_kept_seed_with_records_cannot_be_replaced() {
    let start = SEED_V1_REWRITTEN.find("implements:").unwrap();
    let end = SEED_V1_REWRITTEN.find("kind: mdbase.type").unwrap();
    let unimplemented = format!(
        "{}{}",
        &SEED_V1_REWRITTEN[..start],
        &SEED_V1_REWRITTEN[end..]
    );
    let mut state = legacy_seed(1, &unimplemented);
    assert!(seed_plan(&state).replaceable());
    state.insert_record(
        mdbn_core::ids::Uuid([1; 16]),
        "notes/a.md",
        "---\ntype: note\n---\nBody\n",
    );
    let p = seed_plan(&state);
    assert!(p.reason.is_some() && p.in_use);
    assert!(!p.replaceable());
}

#[test]
fn an_unmergeable_seed_is_replaced_only_by_a_choice_bound_to_its_digest() {
    let competing = SEED_V1_REWRITTEN.replace("description: A note.", "description: My notes.");
    let mut state = legacy_seed(1, &competing);
    let pack = seed_pack(2);
    let choose = |digest| AssessOptions {
        adopt: std::collections::BTreeMap::from([(SEED.to_owned(), digest)]),
        ..opts()
    };
    let chosen = choose(revision(&competing));
    let a = assess_type_pack(&state, &pack, &chosen).unwrap();
    let p = a.resources.iter().find(|r| r.target == SEED).unwrap();
    assert_eq!(p.action, Action::Update);
    assert_eq!(p.document.as_deref(), Some(SEED_V2));
    assert_eq!(p.origin, Some(revision(SEED_V2)));
    let (_, ops) = apply_type_pack(&state, &pack, &chosen, &a.assessment_digest).unwrap();
    let write = ops
        .iter()
        .find_map(|op| match op {
            mdbn_core::intent::Op::ResourcePut(r) if r.path == SEED => Some(r),
            _ => None,
        })
        .unwrap();
    assert_eq!(write.base_revision, Some(revision(&competing)));
    apply(&mut state, ops);
    let p = seed_plan(&state);
    assert_eq!((p.action, p.reason.as_deref()), (Action::Preserve, None));
}

#[test]
fn a_stale_seed_adoption_is_refused() {
    let competing = SEED_V1_REWRITTEN.replace("description: A note.", "description: My notes.");
    let state = legacy_seed(1, &competing);
    let stale = AssessOptions {
        adopt: std::collections::BTreeMap::from([(SEED.to_owned(), revision(SEED_V1))]),
        ..opts()
    };
    let a = assess_type_pack(&state, &seed_pack(2), &stale).unwrap();
    let p = a.resources.iter().find(|r| r.target == SEED).unwrap();
    assert_eq!(p.action, Action::Conflict);
    assert!(p.reason.as_deref().unwrap().contains("stale"));
    assert!(!a.applicable());
    let other = AssessOptions {
        adopt: std::collections::BTreeMap::from([(
            "_types/other.md".to_owned(),
            revision(&competing),
        )]),
        ..opts()
    };
    assert!(assess_type_pack(&state, &seed_pack(2), &other).is_err());
}

/// A contract at `_contracts/…` and a type implementing it at `_types/…`, as the
/// bundled packs declare them.
fn canonical_contract_pack() -> mdbn_core::packs::Pack {
    let resources = [
        ("contract", "_contracts/example.note/1.0.0.md", CONTRACT),
        ("type", "_types/note.md", SEED_V1),
    ];
    let mut manifest =
        "kind: mdbase.type-pack\nid: example.notes\nversion: 1.0.0\nresources:\n".to_owned();
    for (kind, target, document) in resources {
        manifest.push_str(&format!(
            "  - kind: {kind}\n    mode: managed\n    source: {target}\n    target: {target}\n    digest: {}\n",
            revision(document)
        ));
    }
    load_pack(&manifest, &|source| {
        resources
            .iter()
            .find(|(_, path, _)| *path == source)
            .map(|(_, _, document)| (*document).to_owned())
    })
    .unwrap()
}

#[test]
fn default_overrides_install_canonical_targets_into_nested_definition_folders() {
    // The hosted layout: `_contracts/…` and `_types/…` are not resource paths.
    let pack = canonical_contract_pack();
    let mut state = MemState::new();
    state.insert_resource(
        "mdbase.yaml",
        "spec_version: '0.3.0'\nsettings:\n  types_folder: _mdbase/types\n  contracts_folder: _mdbase/contracts\n",
    );
    let overrides = mdbn_core::packs::default_target_overrides(&state, &pack).unwrap();
    assert_eq!(
        overrides.into_iter().collect::<Vec<_>>(),
        vec![
            (
                "_contracts/example.note/1.0.0.md".to_owned(),
                "_mdbase/contracts/example.note/1.0.0.md".to_owned()
            ),
            (
                "_types/note.md".to_owned(),
                "_mdbase/types/note.md".to_owned()
            ),
        ]
    );
    let options = AssessOptions {
        target_overrides: mdbn_core::packs::default_target_overrides(&state, &pack).unwrap(),
        ..opts()
    };
    let a = assess_type_pack(&state, &pack, &options).unwrap();
    assert!(a.applicable(), "{:?}", a.issues);
    let (_, ops) = apply_type_pack(&state, &pack, &options, &a.assessment_digest).unwrap();
    apply(&mut state, ops);
    assert!(
        state
            .resource("_mdbase/contracts/example.note/1.0.0.md")
            .is_some()
    );
    assert_eq!(
        state.catalog().types()[0].source_path,
        "_mdbase/types/note.md"
    );
    assert_eq!(state.catalog().contracts().len(), 1);
    assert!(state.resource("_contracts/example.note/1.0.0.md").is_none());

    // Installed: the receipt's targets are the default, so the pack is current.
    let installed = AssessOptions {
        target_overrides: mdbn_core::packs::default_target_overrides(&state, &pack).unwrap(),
        ..opts()
    };
    assert_eq!(installed.target_overrides, options.target_overrides);
    assert_eq!(
        assess_type_pack(&state, &pack, &installed).unwrap().status,
        PackStatus::Current
    );
}

#[test]
fn default_overrides_leave_root_layout_targets_unchanged() {
    let pack = canonical_contract_pack();
    let mut state = MemState::new();
    state.insert_resource("mdbase.yaml", "spec_version: '0.3.0'\n");
    assert!(
        mdbn_core::packs::default_target_overrides(&state, &pack)
            .unwrap()
            .is_empty()
    );
    let a = assess_type_pack(&state, &pack, &opts()).unwrap();
    let (_, ops) = apply_type_pack(&state, &pack, &opts(), &a.assessment_digest).unwrap();
    apply(&mut state, ops);
    assert!(state.resource("_contracts/example.note/1.0.0.md").is_some());
    assert_eq!(state.catalog().types()[0].source_path, "_types/note.md");
    // Installed at the canonical targets: still no overrides.
    assert!(
        mdbn_core::packs::default_target_overrides(&state, &pack)
            .unwrap()
            .is_empty()
    );
}
