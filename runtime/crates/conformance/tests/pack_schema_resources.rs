//! Spec 05A pack evolution through the actual guarded resource planner.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use mdbn_core::ids::{Uuid, revision};
use mdbn_core::intent::{ConflictMode, Mutation, Op, OpClock, Source};
use mdbn_core::packs::{
    Action, AssessOptions, Lock, Pack, PackStatus, apply_type_pack, assess_type_pack, load_pack,
};
use mdbn_core::plan::{PlanOptions, Planned, Rejection, Stage};
use mdbn_core::state::{MemState, StateView};
use mdbn_core::types::LOCK_PATH;

const CONTRACT_PATH: &str = "_contracts/example.note.md";
const TYPE_PATH: &str = "_types/note.md";
const SCHEMA_PATH: &str = "_schemas/notes/note.schema.json";

fn options() -> AssessOptions {
    AssessOptions {
        installed_by: "dev.example.conformance".into(),
        ..AssessOptions::default()
    }
}

fn pack(version: u32, external_schema: bool) -> Pack {
    make_pack(version, external_schema, external_schema)
}

fn make_pack(version: u32, external_schema: bool, include_schema: bool) -> Pack {
    let schema = format!(
        r#"{{"$defs":{{"note":{{"type":"object","properties":{{"title":{{"type":"string","minLength":{version}}}}},"required":["title"]}}}}}}"#
    );
    let wrapper = if external_schema {
        "  ref: ../_schemas/notes/note.schema.json#/$defs/note\n".to_owned()
    } else {
        format!(
            "  value: {{type: object, properties: {{title: {{type: string, minLength: {version}}}}}, required: [title]}}\n"
        )
    };
    let contract = format!(
        "---\nkind: mdbase.contract\nid: example.note\nversion: {version}.0.0\ncontract_type: record\nrecord_schema:\n  dialect: json-schema-2020-12\n{wrapper}---\n"
    );
    let type_document = format!(
        "---\nkind: mdbase.type\nname: note\nversion: {version}\nmatch:\n  path_glob: notes/**\nschema:\n  dialect: json-schema-2020-12\n  value: {{type: object, properties: {{title: {{type: string, minLength: {version}}}}}, required: [title]}}\nimplements:\n  - contract: example.note\n    version: {version}.0.0\n    fields: {{title: title}}\n---\n"
    );
    // Contract first and lock last: no caller-side ordering workaround.
    let mut resources = vec![
        ("contract", "contract.md", CONTRACT_PATH, contract),
        ("type", "type.md", TYPE_PATH, type_document),
    ];
    if include_schema {
        resources.push(("schema", "schema.json", SCHEMA_PATH, schema));
    }
    let mut manifest =
        format!("kind: mdbase.type-pack\nid: example.notes\nversion: {version}.0.0\nresources:\n");
    for (kind, source, target, document) in &resources {
        manifest.push_str(&format!(
            "  - kind: {kind}\n    mode: managed\n    source: {source}\n    target: {target}\n    digest: {}\n",
            revision(document)
        ));
    }
    load_pack(&manifest, &|source| {
        resources
            .iter()
            .find(|(_, name, _, _)| *name == source)
            .map(|(_, _, _, document)| document.clone())
    })
    .unwrap()
}

fn plan(state: &MemState, ops: Vec<Op>) -> Result<Planned, Box<Rejection>> {
    mdbn_core::plan(
        &Mutation {
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
        },
        state,
        &PlanOptions { stage: Stage::Head },
    )
    .map_err(Box::new)
}

fn reviewed_ops(state: &MemState, pack: &Pack) -> Vec<Op> {
    let assessment = assess_type_pack(state, pack, &options()).unwrap();
    assert!(assessment.applicable(), "{:?}", assessment.issues);
    apply_type_pack(state, pack, &options(), &assessment.assessment_digest)
        .unwrap()
        .1
}

fn install(state: &mut MemState, pack: &Pack) {
    let result = plan(state, reviewed_ops(state, pack)).unwrap();
    assert!(result.ends_batch);
    state.apply(&result);
}

#[test]
fn contract_type_and_schema_apply_upgrade_and_retire_atomically() {
    let mut state = MemState::new();
    let user_id = Uuid([42; 16]);
    let user_bytes = "---\ntitle: A sufficiently long title\n---\nUser body.\n";
    state.insert_record(user_id, "notes/user.md", user_bytes);
    for version in [1, 2, 3] {
        let desired = pack(version, version < 3);
        let assessment = assess_type_pack(&state, &desired, &options()).unwrap();
        assert_eq!(
            assessment.status,
            if version == 1 {
                PackStatus::Install
            } else {
                PackStatus::Upgrade
            }
        );
        let ops = reviewed_ops(&state, &desired);
        assert!(matches!(ops.first(), Some(Op::ResourcePut(r)) if r.path == CONTRACT_PATH));
        assert!(matches!(ops.last(), Some(Op::ResourcePut(r)) if r.path == LOCK_PATH));
        if version < 3 {
            let schema = ops
                .iter()
                .find_map(|op| match op {
                    Op::ResourcePut(r) if r.path == SCHEMA_PATH => Some(r),
                    _ => None,
                })
                .unwrap();
            assert_eq!(schema.must_not_exist, version == 1);
            assert_eq!(
                schema.base_revision,
                state.resource(SCHEMA_PATH).map(|d| revision(&d))
            );
        } else {
            assert!(ops.iter().any(|op| matches!(op, Op::ResourceDelete(r) if r.path == SCHEMA_PATH && r.base_revision == state.resource(SCHEMA_PATH).map(|d| revision(&d)))));
            assert_eq!(
                assessment
                    .resources
                    .iter()
                    .find(|r| r.target == SCHEMA_PATH)
                    .unwrap()
                    .action,
                Action::Delete
            );
        }
        for offset in 0..ops.len() {
            for reverse in [false, true] {
                let mut reordered = ops.clone();
                reordered.rotate_left(offset);
                if reverse {
                    reordered.reverse();
                }
                let mut probe = state.clone();
                probe.apply(&plan(&state, reordered).unwrap());
                for resource in &desired.resources {
                    assert_eq!(
                        probe.resource(&resource.target).as_deref(),
                        Some(resource.document.as_str())
                    );
                }
                assert_eq!(probe.resource(SCHEMA_PATH).is_some(), version < 3);
                assert_eq!(probe.record(&user_id).unwrap().source.as_ref(), user_bytes);
            }
        }
        let result = plan(&state, ops).unwrap();
        assert!(result.ends_batch);
        assert_eq!(
            result.effects.len(),
            4,
            "contract, type, schema and lock in one plan"
        );
        state.apply(&result);
        assert!(state.catalog().is_valid());
        assert!(
            state.catalog().issues().is_empty(),
            "{:?}",
            state.catalog().issues()
        );
        assert_eq!(state.catalog().contracts().len(), 1);
        assert_eq!(state.catalog().implementations().len(), 1);
        assert_eq!(state.record(&user_id).unwrap().source.as_ref(), user_bytes);
        let lock = Lock::parse(&state.resource(LOCK_PATH).unwrap()).unwrap();
        let receipt = lock.receipt("example.notes").unwrap();
        assert_eq!(receipt.version, format!("{version}.0.0"));
        assert_eq!(receipt.resources.len(), if version < 3 { 3 } else { 2 });
        assert_eq!(state.resource(SCHEMA_PATH).is_some(), version < 3);
        assert_eq!(state.catalog().is_resource_path(SCHEMA_PATH), version < 3);
        assert!(
            !state
                .catalog()
                .is_resource_path("_schemas/untracked.schema.json")
        );
        assert!(state.catalog().is_record_path("_schemas/user-note.md"));
        let current = assess_type_pack(&state, &desired, &options()).unwrap();
        assert_eq!(current.status, PackStatus::Current);
        assert!(
            apply_type_pack(&state, &desired, &options(), &current.assessment_digest)
                .unwrap()
                .1
                .is_empty()
        );
    }
}

fn published_tasknotes_pack() -> Pack {
    let published: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/tasknotes.task-0.3.0-rc.18.json")).unwrap();
    load_pack(&published["manifest"].to_string(), &|source| {
        published["resources"]
            .as_array()
            .unwrap()
            .iter()
            .find(|resource| resource["source"].as_str() == Some(source))
            .and_then(|resource| resource["document"].as_str())
            .map(str::to_owned)
    })
    .unwrap()
}

#[test]
fn published_tasknotes_pack_installs_and_upgrades_its_declared_seed_baseline() {
    let desired = published_tasknotes_pack();
    assert_eq!(
        mdbn_core::ids::Hash::of(include_bytes!("fixtures/tasknotes.task-0.3.0-rc.18.json"))
            .to_string(),
        "sha256:9a9ebc26e6f63ad2fc3d92f87d38f6c140a3af90408de47d667ae7b9ba0dc9ef"
    );
    assert_eq!(
        desired.digest.to_string(),
        "sha256:2baa081621dadce611db7215597f156c5035bfaa425722554818291a8753736e"
    );
    let seed = desired
        .resources
        .iter()
        .find(|resource| resource.kind == "type")
        .unwrap();
    for baseline in [None, Some(&seed.baselines[0])] {
        let mut state = MemState::new();
        if let Some(baseline) = baseline {
            state.insert_resource(&seed.target, &baseline.document);
        }
        install(&mut state, &desired);
        assert!(
            state.catalog().issues().is_empty(),
            "{:?}",
            state.catalog().issues()
        );
        for resource in &desired.resources {
            assert_eq!(
                state.resource(&resource.target).as_deref(),
                Some(resource.document.as_str())
            );
            assert!(state.catalog().is_resource_path(&resource.target));
        }
        let lock = Lock::parse(&state.resource(LOCK_PATH).unwrap()).unwrap();
        assert_eq!(lock.receipt("tasknotes.task").unwrap().resources.len(), 4);
        assert_eq!(
            assess_type_pack(&state, &desired, &options())
                .unwrap()
                .status,
            PackStatus::Current
        );
        assert!(reviewed_ops(&state, &desired).is_empty());
    }
}

#[test]
fn unreferenced_managed_schema_uses_lock_classification() {
    let mut state = MemState::new();
    install(&mut state, &make_pack(1, false, true));
    assert!(state.catalog().is_resource_path(SCHEMA_PATH));
    assert!(
        !state
            .catalog()
            .is_resource_path("_schemas/untracked.schema.json")
    );
    install(&mut state, &pack(2, false));
    assert!(state.resource(SCHEMA_PATH).is_none());
    assert!(!state.catalog().is_resource_path(SCHEMA_PATH));
}

#[test]
fn registered_contract_schema_remains_a_resource_without_pack_lock() {
    use mdbn_core::intent::ResourceDelete;
    let mut state = MemState::new();
    install(&mut state, &pack(1, true));
    let removal = Op::ResourceDelete(ResourceDelete {
        path: LOCK_PATH.into(),
        base_revision: state.resource(LOCK_PATH).map(|d| revision(&d)),
    });
    state.apply(&plan(&state, vec![removal]).unwrap());
    assert!(state.resource(LOCK_PATH).is_none());
    assert!(state.catalog().is_resource_path(SCHEMA_PATH));
    assert!(
        !state
            .catalog()
            .is_resource_path("_schemas/untracked.schema.json")
    );
}

#[test]
fn schema_changes_cannot_invalidate_an_unchanged_contract() {
    use mdbn_core::intent::{ResourceDelete, ResourcePut};
    use mdbn_core::plan::RejectCode;
    let mut state = MemState::new();
    install(&mut state, &pack(1, true));
    let invalid = Op::ResourcePut(ResourcePut {
        path: SCHEMA_PATH.into(),
        doc: "{\"type\":7}".into(),
        base_revision: state.resource(SCHEMA_PATH).map(|d| revision(&d)),
        must_not_exist: false,
    });
    let removal = Op::ResourceDelete(ResourceDelete {
        path: SCHEMA_PATH.into(),
        base_revision: state.resource(SCHEMA_PATH).map(|d| revision(&d)),
    });
    let lock = Op::ResourcePut(ResourcePut {
        path: LOCK_PATH.into(),
        doc: state.resource(LOCK_PATH).unwrap().to_string(),
        base_revision: state.resource(LOCK_PATH).map(|d| revision(&d)),
        must_not_exist: false,
    });
    for ops in [vec![invalid.clone()], vec![invalid, lock], vec![removal]] {
        let rejection = plan(&state, ops).unwrap_err();
        assert_eq!(rejection.code, RejectCode::InvalidRecord);
        assert!(
            rejection
                .issues
                .iter()
                .any(|i| i.location.as_deref() == Some(CONTRACT_PATH))
        );
        assert!(state.catalog().issues().is_empty());
    }
}

#[test]
fn undeclared_schema_is_not_a_resource_write() {
    use mdbn_core::intent::ResourcePut;
    let state = MemState::new();
    let ops = vec![Op::ResourcePut(ResourcePut {
        path: SCHEMA_PATH.into(),
        doc: "{\"type\":\"object\"}".into(),
        base_revision: None,
        must_not_exist: true,
    })];
    assert_eq!(
        plan(&state, ops).unwrap_err().reason.as_deref(),
        Some("not_a_resource_path")
    );
}

#[test]
fn schema_create_update_and_delete_keep_original_guards() {
    let mut state = MemState::new();
    let initial = pack(1, true);
    let create = reviewed_ops(&state, &initial);
    let mut concurrent = state.clone();
    concurrent.insert_resource(SCHEMA_PATH, "{\"type\":\"object\"}");
    assert_eq!(
        plan(&concurrent, create).unwrap_err().reason.as_deref(),
        Some("path_taken")
    );
    assert!(concurrent.resource(CONTRACT_PATH).is_none());
    assert!(concurrent.resource(TYPE_PATH).is_none());
    assert!(concurrent.resource(LOCK_PATH).is_none());
    install(&mut state, &initial);
    for desired in [pack(2, true), pack(3, false)] {
        let ops = reviewed_ops(&state, &desired);
        let mut changed = state.clone();
        changed.insert_resource(SCHEMA_PATH, "{\"type\":\"object\"}");
        assert_eq!(
            plan(&changed, ops).unwrap_err().reason.as_deref(),
            Some("revision")
        );
        for path in [CONTRACT_PATH, TYPE_PATH, LOCK_PATH] {
            assert_eq!(changed.resource(path), state.resource(path));
        }
        let conflict = assess_type_pack(&changed, &desired, &options()).unwrap();
        assert_eq!(conflict.status, PackStatus::Conflict);
        assert_eq!(
            apply_type_pack(&changed, &desired, &options(), &conflict.assessment_digest)
                .unwrap_err()
                .code,
            "type_pack_conflict"
        );
    }
}

const BASE_CONFIG: &str = "spec_version: '0.3.0'\nsettings:\n  record_extensions: [md, base]\n";
const BASE_DOC: &str = "# preserve source\r\nviews:\r\n  - type: table\r\n    name: Today\r\n";

fn source_create(id: Uuid, path: &str) -> Op {
    Op::Create(mdbn_core::intent::Create {
        id,
        path: Some(path.into()),
        type_name: None,
        frontmatter: None,
        body: None,
        document: Some(BASE_DOC.into()),
    })
}

fn source_setup_ops(state: &MemState) -> Vec<Op> {
    let mut ops = vec![Op::ResourcePut(mdbn_core::intent::ResourcePut {
        path: "mdbase.yaml".into(),
        doc: BASE_CONFIG.into(),
        base_revision: state.resource("mdbase.yaml").map(|doc| revision(&doc)),
        must_not_exist: state.resource("mdbase.yaml").is_none(),
    })];
    let pack_ops = reviewed_ops(state, &published_tasknotes_pack());
    assert_eq!(pack_ops.len(), 5, "published pack remains unchanged");
    ops.extend(pack_ops);
    ops
}

#[test]
fn resource_prefix_and_yaml_source_creates_share_one_atomic_plan() {
    use mdbn_core::paths::path_key;
    use mdbn_core::state::PathHolder;
    let mut state = MemState::new();
    assert!(!state.catalog().is_record_path("views/Today.base"));
    let mut ops = source_setup_ops(&state);
    let paths = ["Today", "Upcoming", "Calendar", "Projects", "Archive"];
    for (n, name) in paths.iter().enumerate() {
        ops.push(source_create(
            Uuid([80 + u8::try_from(n).unwrap(); 16]),
            &format!("views/{name}.base"),
        ));
    }
    let result = plan(&state, ops).unwrap();
    assert!(result.ends_batch);
    assert!(state.resource(LOCK_PATH).is_none());
    assert!(
        state.record(&Uuid([80; 16])).is_none(),
        "planning is not a commit"
    );
    state.apply(&result);
    assert!(state.catalog().is_valid());
    for (n, name) in paths.iter().enumerate() {
        let id = Uuid([80 + u8::try_from(n).unwrap(); 16]);
        let path = format!("views/{name}.base");
        assert!(state.catalog().is_record_path(&path));
        assert!(!state.catalog().is_resource_path(&path));
        assert_eq!(
            state.at_path_key(&path_key(&path)),
            Some(PathHolder::Record(id))
        );
        assert_eq!(state.record(&id).unwrap().source.as_ref(), BASE_DOC);
        assert!(state.resource(&path).is_none());
    }
    assert_eq!(
        Lock::parse(&state.resource(LOCK_PATH).unwrap())
            .unwrap()
            .receipt("tasknotes.task")
            .unwrap()
            .resources
            .len(),
        4
    );
}

#[test]
fn mixed_plan_late_occupied_source_refuses_without_partial_setup() {
    let mut state = MemState::new();
    state.insert_resource("mdbase.yaml", BASE_CONFIG);
    let existing = Uuid([99; 16]);
    let existing_doc = "# user owned\nviews: []\n";
    state.insert_record(existing, "views/Upcoming.base", existing_doc);
    let mut ops = source_setup_ops(&state);
    ops.push(source_create(Uuid([80; 16]), "views/Today.base"));
    ops.push(source_create(Uuid([81; 16]), "views/Upcoming.base"));
    assert_eq!(
        plan(&state, ops).unwrap_err().reason.as_deref(),
        Some("path_taken")
    );
    assert_eq!(
        state.record(&existing).unwrap().source.as_ref(),
        existing_doc
    );
    assert!(state.record(&Uuid([80; 16])).is_none());
    assert!(state.resource(LOCK_PATH).is_none());
    assert_eq!(state.resource("mdbase.yaml").as_deref(), Some(BASE_CONFIG));
    for resource in &published_tasknotes_pack().resources {
        assert!(state.resource(&resource.target).is_none());
    }
}

#[test]
fn ordinary_create_cannot_borrow_a_later_configuration() {
    let state = MemState::new();
    let mut ops = source_setup_ops(&state);
    ops.insert(0, source_create(Uuid([80; 16]), "views/Today.base"));
    assert_eq!(
        plan(&state, ops).unwrap_err().reason.as_deref(),
        Some("not_a_record_path")
    );
    assert!(state.resource("mdbase.yaml").is_none());
    assert!(state.record(&Uuid([80; 16])).is_none());
}

#[test]
fn mixed_record_create_keeps_resource_create_and_revision_guards() {
    let desired = pack(1, true);
    let mut fresh = MemState::new();
    let mut ops = reviewed_ops(&fresh, &desired);
    ops.push(source_create(Uuid([80; 16]), "views/seed.md"));
    fresh.insert_resource(SCHEMA_PATH, "{\"type\":\"object\"}");
    assert_eq!(
        plan(&fresh, ops).unwrap_err().reason.as_deref(),
        Some("path_taken")
    );
    assert!(fresh.resource(CONTRACT_PATH).is_none());
    assert!(fresh.record(&Uuid([80; 16])).is_none());
    let mut state = MemState::new();
    install(&mut state, &desired);
    let mut ops = reviewed_ops(&state, &pack(2, true));
    ops.push(source_create(Uuid([81; 16]), "views/seed.md"));
    let prior_contract = state.resource(CONTRACT_PATH);
    state.insert_resource(SCHEMA_PATH, "{\"type\":\"object\"}");
    assert_eq!(
        plan(&state, ops).unwrap_err().reason.as_deref(),
        Some("revision")
    );
    assert_eq!(state.resource(CONTRACT_PATH), prior_contract);
    assert!(state.record(&Uuid([81; 16])).is_none());
}

#[test]
fn invalid_final_catalog_is_not_hidden_by_a_mixed_operation() {
    let state = MemState::new();
    let mut ops = reviewed_ops(&state, &pack(1, true));
    let schema = ops
        .iter_mut()
        .find_map(|op| match op {
            Op::ResourcePut(resource) if resource.path == SCHEMA_PATH => Some(resource),
            _ => None,
        })
        .unwrap();
    schema.doc = "{\"type\":7}".into();
    // The ordinary create succeeds under the initial catalog; final resource
    // validation must still reject the later invalid referenced schema.
    ops.insert(0, source_create(Uuid([80; 16]), "views/seed.md"));
    let rejection = plan(&state, ops).unwrap_err();
    assert_eq!(rejection.code, mdbn_core::plan::RejectCode::InvalidRecord);
    assert!(
        rejection
            .issues
            .iter()
            .any(|issue| issue.location.as_deref() == Some(CONTRACT_PATH))
    );
    assert!(state.resource(LOCK_PATH).is_none());
    assert!(state.record(&Uuid([80; 16])).is_none());
}
