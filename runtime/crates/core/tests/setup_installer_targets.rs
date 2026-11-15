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
    let assessment = assess_collection_resources(&state, &setup, &Default::default()).unwrap();
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
    let assessment = assess_collection_resources(&state, &initial, &Default::default()).unwrap();
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
fn contract(version: &str) -> String {
    format!(
        "---\nkind: mdbase.contract\nid: example.note\nversion: {version}\ncontract_type: record\nrecord_schema:\n  dialect: json-schema-2020-12\n  value: {{type: object}}\n---\n"
    )
}
/// Pack `version` places each `(contract version, target)`, sourced from
/// `contracts/example.note/<contract version>.md`.
fn contract_setup(version: &str, contracts: &[(&str, &str)]) -> CollectionSetup {
    let mut manifest =
        format!("kind: mdbase.type-pack\nid: example.notes\nversion: {version}\nresources:\n");
    for (contract_version, target) in contracts {
        manifest.push_str(&format!(
            "  - kind: contract\n    mode: managed\n    source: contracts/example.note/{contract_version}.md\n    target: {target}\n    digest: {}\n",
            mdbn_core::ids::revision(&contract(contract_version))
        ));
    }
    let mut setup = setup();
    setup.type_packs[0].pack = load_pack(&manifest, &|source| {
        let version = source.strip_prefix("contracts/example.note/")?;
        Some(contract(version.strip_suffix(".md")?))
    })
    .unwrap();
    setup
}
#[test]
fn shared_installer_never_redirects_a_resource_onto_a_path_its_pack_declares() {
    // 1.0.0 installed contract 1.0.0 at the unversioned path; 2.0.0 puts the
    // newer contract there and moves 1.0.0 aside.
    let mut state = MemState::new();
    let mut initial = contract_setup("1.0.0", &[("1.0.0", "_contracts/example.note.md")]);
    initial.resolve_installer_targets(&state).unwrap();
    let assessment = assess_collection_resources(&state, &initial, &Default::default()).unwrap();
    state.insert_resource(
        mdbn_core::types::LOCK_PATH,
        &assessment.type_packs[0].lock_document,
    );
    state.insert_resource("_contracts/example.note.md", &contract("1.0.0"));

    let mut upgrade = contract_setup(
        "2.0.0",
        &[
            ("1.1.0", "_contracts/example.note.md"),
            ("1.0.0", "_contracts/example.note/1.0.0.md"),
        ],
    );
    upgrade.resolve_installer_targets(&state).unwrap();
    assert!(
        upgrade.type_packs[0].options.target_overrides.is_empty(),
        "the moved contract must not reclaim the path the newer one declares"
    );
    let assessment = assess_collection_resources(&state, &upgrade, &Default::default()).unwrap();
    assert!(assessment.applicable);
    let targets: Vec<_> = assessment.type_packs[0]
        .resources
        .iter()
        .map(|resource| resource.target.as_str())
        .collect();
    assert_eq!(
        targets,
        [
            "_contracts/example.note.md",
            "_contracts/example.note/1.0.0.md"
        ]
    );
}
