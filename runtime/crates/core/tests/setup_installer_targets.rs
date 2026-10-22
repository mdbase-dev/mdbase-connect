//! Installer configuration folders and retained lock-receipt targets share one Core policy.
use mdbn_core::{
    ids::Hash,
    packs::{AssessOptions, load_pack},
    setup::{
        configuration::ConfigurationDeclaration,
        envelope::{CollectionSetup, CollectionSetupTypePack, assess_collection_resources},
    },
    state::MemState,
};
fn setup() -> CollectionSetup {
    let source = "---\nkind: mdbase.type\nname: note\nversion: 1\nschema:\n  dialect: json-schema-2020-12\n  value: {type: object}\n---\n";
    let manifest = format!(
        "kind: mdbase.type-pack\nid: example.notes\nversion: 1.0.0\nresources:\n  - kind: type\n    mode: managed\n    source: note.md\n    target: _types/note.md\n    digest: {}\n",
        mdbn_core::ids::revision(source)
    );
    CollectionSetup {
        application_id: "example.application".into(),
        declaration_digest: Hash::of(b"declared"),
        configuration: ConfigurationDeclaration {
            requirements: vec![],
            provisions: vec![],
        },
        type_packs: vec![CollectionSetupTypePack {
            pack: load_pack(&manifest, &|_| Some(source.into())).unwrap(),
            options: AssessOptions {
                installed_by: "example.application".into(),
                ..Default::default()
            },
        }],
    }
}
#[test]
fn shared_installer_uses_current_configured_folder_for_new_pack() {
    let mut state = MemState::new();
    state.insert_resource(
        "mdbase.yaml",
        "spec_version: '0.3.0'\nsettings:\n  types_folder: schemas\n",
    );
    let mut setup = setup();
    setup.resolve_installer_targets(&state).unwrap();
    assert_eq!(
        setup.type_packs[0]
            .options
            .target_overrides
            .get("_types/note.md")
            .map(String::as_str),
        Some("schemas/note.md")
    );
    let assessment = assess_collection_resources(&state, &setup).unwrap();
    assert!(assessment.applicable);
    assert_eq!(
        assessment.type_packs[0].resources[0].target,
        "schemas/note.md"
    );
}
#[test]
fn shared_installer_never_moves_recorded_targets_after_folder_change() {
    let mut state = MemState::new();
    state.insert_resource(
        "mdbase.yaml",
        "spec_version: '0.3.0'\nsettings:\n  types_folder: schemas\n",
    );
    let mut initial = setup();
    initial.resolve_installer_targets(&state).unwrap();
    let assessment = assess_collection_resources(&state, &initial).unwrap();
    state.insert_resource(
        mdbn_core::types::LOCK_PATH,
        &assessment.type_packs[0].lock_document,
    );
    state.insert_resource(
        "mdbase.yaml",
        "spec_version: '0.3.0'\nsettings:\n  types_folder: other\n",
    );
    let mut subsequent = setup();
    subsequent.resolve_installer_targets(&state).unwrap();
    assert_eq!(
        subsequent.type_packs[0]
            .options
            .target_overrides
            .get("_types/note.md")
            .map(String::as_str),
        Some("schemas/note.md")
    );
}
