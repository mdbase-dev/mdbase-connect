//! Resource-data assessment, lock compaction and guarded-output regressions.
use mdbn_core::ids::{Hash, revision};
use mdbn_core::intent::Op;
use mdbn_core::packs::{AssessOptions, Lock, load_pack};
use mdbn_core::plan::Effect;
use mdbn_core::setup::configuration::{
    ConfigurationDeclaration, ConfigurationOperation, ConfigurationPredicate,
    ConfigurationProvision, ConfigurationRequirement,
};
use mdbn_core::setup::envelope::{
    CollectionSetup, CollectionSetupTypePack, MAX_RESOURCE_PATH_BYTES, MAX_RESOURCE_SOURCE_BYTES,
    apply_collection_resources, assess_collection_resources,
};
use mdbn_core::setup::receipts::{PROVISION_LOCK_PATH, ProvisionLock};
use mdbn_core::state::{MemState, Overlay, StateView};
use mdbn_core::types::{CONFIG_PATH, LOCK_PATH};
use mdbn_core::value::Value;

fn setup() -> CollectionSetup {
    CollectionSetup {
        application_id: "app.reader".into(),
        declaration_digest: Hash::of(b"declaration"),
        configuration: ConfigurationDeclaration {
            requirements: vec![ConfigurationRequirement {
                id: "base-extension".into(),
                path: "/settings/record_extensions".into(),
                predicate: ConfigurationPredicate::Contains,
                value: Value::string("base"),
            }],
            provisions: vec![ConfigurationProvision {
                requirement: "base-extension".into(),
                path: "/settings/record_extensions".into(),
                operation: ConfigurationOperation::SetAdd,
                value: Value::string("base"),
            }],
        },
        type_packs: Vec::new(),
    }
}
fn pack(name: &str) -> CollectionSetupTypePack {
    let document = format!(
        "---\nkind: mdbase.type\nname: {name}\nschema:\n  dialect: json-schema-2020-12\n  value: {{type: object}}\n---\n"
    );
    let manifest = format!(
        "kind: mdbase.type-pack\nid: example.{name}\nversion: 1.0.0\nresources:\n  - kind: type\n    mode: managed\n    source: type.md\n    target: _types/{name}.md\n    digest: {}\n",
        revision(&document)
    );
    CollectionSetupTypePack {
        pack: load_pack(&manifest, &|_| Some(document.clone())).unwrap(),
        options: AssessOptions {
            installed_by: "app.reader".into(),
            ..Default::default()
        },
    }
}
fn overlay_ops<'a>(state: &'a MemState, ops: Vec<Op>) -> Overlay<'a> {
    let mut overlay = Overlay::new(state);
    for op in ops {
        match op {
            Op::ResourcePut(r) => overlay.apply_effect(&Effect::PutResource {
                path: r.path,
                doc: r.doc,
            }),
            Op::ResourceDelete(r) => overlay.apply_effect(&Effect::RemoveResource { path: r.path }),
            _ => panic!("resource API returned a non-resource operation"),
        }
    }
    overlay
}
#[test]
fn config_preserves_user_values_and_records_only_scalar_contributions() {
    let mut state = MemState::new();
    state.insert_resource(
        CONFIG_PATH,
        "spec_version: '0.3.0'\nsettings:\n  record_extensions: [md, txt]\nx-user: keep\n",
    );
    let a = assess_collection_resources(&state, &setup()).unwrap();
    assert!(a.applicable);
    let dto = a.to_value();
    assert_eq!(dto.get("scope").and_then(Value::as_str), Some("resources"));
    for absent in ["collection_revision", "files", "file_absence"] {
        assert!(dto.get(absent).is_none());
    }
    let (_, ops) = apply_collection_resources(&state, &setup(), a.assessment_digest).unwrap();
    assert!(
        matches!(&ops[0], Op::ResourcePut(r) if r.path == CONFIG_PATH && r.base_revision == state.resource(CONFIG_PATH).as_deref().map(revision) && !r.must_not_exist)
    );
    let overlay = overlay_ops(&state, ops);
    let config = overlay.resource(CONFIG_PATH).unwrap();
    assert!(config.contains("x-user: keep"));
    assert_eq!(
        overlay.catalog().settings().record_extensions,
        vec!["md", "txt", "base"]
    );
    let ledger = ProvisionLock::parse(&overlay.resource(PROVISION_LOCK_PATH).unwrap()).unwrap();
    assert_eq!(ledger.contributions.len(), 1);
    assert_eq!(ledger.contributions[0].path, "/settings/record_extensions");
    assert!(
        state.resource(PROVISION_LOCK_PATH).is_none(),
        "assessment never commits"
    );
}
#[test]
fn two_packs_emit_one_combined_lock_with_the_first_absence_guard() {
    let state = MemState::new();
    let mut declaration = setup();
    declaration.type_packs = vec![pack("one"), pack("two")];
    let a = assess_collection_resources(&state, &declaration).unwrap();
    assert!(a.applicable);
    let (_, ops) = apply_collection_resources(&state, &declaration, a.assessment_digest).unwrap();
    let locks: Vec<_> = ops
        .iter()
        .filter_map(|op| match op {
            Op::ResourcePut(r) if r.path == LOCK_PATH => Some(r),
            _ => None,
        })
        .collect();
    assert_eq!(locks.len(), 1);
    assert!(locks[0].must_not_exist);
    assert_eq!(locks[0].base_revision, None);
    let lock = Lock::parse(&locks[0].doc).unwrap();
    assert!(lock.receipt("example.one").is_some());
    assert!(lock.receipt("example.two").is_some());
    assert_eq!(
        ops.iter()
            .filter(|op| matches!(op, Op::ResourcePut(r) if r.path == PROVISION_LOCK_PATH))
            .count(),
        1
    );
    let overlay = overlay_ops(&state, ops);
    assert!(overlay.catalog().is_valid());
}
#[test]
fn existing_lock_keeps_its_original_revision_not_an_intermediate_revision() {
    let state = MemState::new();
    let mut declaration = setup();
    declaration.type_packs = vec![pack("one")];
    let a = assess_collection_resources(&state, &declaration).unwrap();
    let (_, ops) = apply_collection_resources(&state, &declaration, a.assessment_digest).unwrap();
    let installed = overlay_ops(&state, ops);
    let old = installed.resource(LOCK_PATH).unwrap();
    declaration.type_packs.push(pack("two"));
    let a = assess_collection_resources(&installed, &declaration).unwrap();
    let (_, ops) =
        apply_collection_resources(&installed, &declaration, a.assessment_digest).unwrap();
    let locks: Vec<_> = ops
        .iter()
        .filter_map(|op| match op {
            Op::ResourcePut(r) if r.path == LOCK_PATH => Some(r),
            _ => None,
        })
        .collect();
    assert_eq!(locks.len(), 1);
    assert_eq!(locks[0].base_revision, Some(revision(&old)));
    assert!(!locks[0].must_not_exist);
    assert!(
        Lock::parse(&locks[0].doc)
            .unwrap()
            .receipt("example.two")
            .is_some()
    );
}
#[test]
fn any_inventory_or_declaration_change_invalidates_apply() {
    let mut state = MemState::new();
    let a = assess_collection_resources(&state, &setup()).unwrap();
    state.insert_resource("_types/unrelated.md", "changed");
    assert_eq!(
        apply_collection_resources(&state, &setup(), a.assessment_digest)
            .unwrap_err()
            .code,
        "concurrent_modification"
    );
    let a = assess_collection_resources(&state, &setup()).unwrap();
    let mut declaration = setup();
    declaration.declaration_digest = Hash::of(b"different");
    assert_eq!(
        apply_collection_resources(&state, &declaration, a.assessment_digest)
            .unwrap_err()
            .code,
        "concurrent_modification"
    );
}
#[test]
fn conflict_is_visible_and_cannot_return_partial_operations() {
    let mut state = MemState::new();
    state.insert_resource(CONFIG_PATH, "settings:\n  record_extensions: bad-shape\n");
    let a = assess_collection_resources(&state, &setup()).unwrap();
    assert!(!a.applicable);
    assert_eq!(
        apply_collection_resources(&state, &setup(), a.assessment_digest)
            .unwrap_err()
            .code,
        "collection_setup_conflict"
    );
    assert!(state.resource(PROVISION_LOCK_PATH).is_none());
}
#[test]
fn source_and_path_limits_fail_explicitly() {
    let mut state = MemState::new();
    state.insert_resource("_types/huge.md", &"x".repeat(MAX_RESOURCE_SOURCE_BYTES + 1));
    assert_eq!(
        assess_collection_resources(&state, &setup())
            .unwrap_err()
            .code,
        "collection_setup_limit_exceeded"
    );
    let mut state = MemState::new();
    state.insert_resource(
        &format!("_types/{}.md", "x".repeat(MAX_RESOURCE_PATH_BYTES)),
        "x",
    );
    assert_eq!(
        assess_collection_resources(&state, &setup())
            .unwrap_err()
            .code,
        "collection_setup_limit_exceeded"
    );
}
