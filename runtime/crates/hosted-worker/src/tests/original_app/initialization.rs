use super::*;
use crate::runtime::initialization::Initialization::{Confirmed, Pending, Refused};
use mdbn_core::{
    ids::{Hash, revision},
    packs::{AssessOptions, load_pack},
    setup::{
        configuration::ConfigurationDeclaration,
        envelope::{
            CollectionSetup, CollectionSetupTypePack, apply_collection_resources,
            assess_collection_resources,
        },
    },
    state::MemState,
};
use mdbn_replica::{ClientApi, SessionAuth};
use mdbn_wire::intent::{DocVersion, Document, ResourcePut};

const REQUEST: B16 = B16([0x61; 16]);
const CONFIG: &str = "mdbase.yaml";
const README: &str = "_mdbase/README.md";

fn readme(store: &impl Store) -> Option<mdbn_replica::store::RecordRow> {
    let id = store
        .record_at(&mdbn_core::paths::path_key(README))
        .unwrap()?;
    store.record(&id).unwrap()
}

fn write(hosted: &mut AppHosted, ops: Vec<Op>) {
    let engine = hosted.e.replica_mut();
    let (session, _) = engine
        .hello(
            SessionAuth::Host,
            HelloParams {
                versions: vec![Version { major: 1, minor: 4 }],
                client_name: "test".into(),
                client_version: "1".into(),
                features: None,
                timezone: None,
            },
        )
        .unwrap();
    engine
        .submit_logged(
            session,
            SubmitParams {
                ops,
                mutation_id: None,
                conflict_mode: None,
                timezone: None,
                allow_partial: None,
                mutation_ids: None,
                dry_run: None,
                include: None,
                wait: None,
                validation: None,
            },
        )
        .unwrap();
    engine.close(session);
    hosted.pump(false);
}

fn setup_targets(config: Option<&str>) -> Vec<String> {
    let mut state = MemState::new();
    if let Some(config) = config {
        state.insert_resource(CONFIG, config);
    }
    let note = "---\nkind: mdbase.type\nname: note\nversion: 1\nschema:\n  dialect: json-schema-2020-12\n  value: {type: object}\n---\n";
    let contract = "---\nkind: mdbase.contract\nid: example.note\nversion: 1.0.0\ncontract_type: record\nrecord_schema:\n  dialect: json-schema-2020-12\n  value: {type: object}\n---\n";
    let manifest = format!(
        "kind: mdbase.type-pack\nid: example.notes\nversion: 1.0.0\nresources:\n  - kind: type\n    mode: managed\n    source: note.md\n    target: _types/note.md\n    digest: {}\n  - kind: contract\n    mode: managed\n    source: contract.md\n    target: _contracts/example.note.md\n    digest: {}\n",
        revision(note),
        revision(contract)
    );
    let mut setup = CollectionSetup {
        application_id: "example.application".into(),
        declaration_digest: Hash::of(b"declared"),
        configuration: ConfigurationDeclaration {
            requirements: vec![],
            provisions: vec![],
        },
        type_packs: vec![CollectionSetupTypePack {
            pack: load_pack(&manifest, &|path| match path {
                "note.md" => Some(note.into()),
                "contract.md" => Some(contract.into()),
                _ => None,
            })
            .unwrap(),
            options: AssessOptions {
                installed_by: "example.application".into(),
                ..Default::default()
            },
        }],
    };
    setup.resolve_installer_targets(&state).unwrap();
    let assessment = assess_collection_resources(&state, &setup, &Default::default()).unwrap();
    let (_, ops) = apply_collection_resources(
        &state,
        &setup,
        assessment.assessment_digest,
        &Default::default(),
    )
    .unwrap();
    ops.into_iter()
        .filter_map(|op| match op {
            mdbn_core::intent::Op::ResourcePut(put) if put.path.ends_with(".md") => Some(put.path),
            _ => None,
        })
        .collect()
}

#[test]
fn portal_initialization_is_atomic_logged_and_replays_without_overwriting_edits() {
    let (svc, _) = genesis_fixture();
    let mut hosted = open(&svc);
    hosted.pump(false);
    let before = svc.head(&COL).0;
    assert_eq!(
        hosted
            .e
            .initialize_collection(REQUEST, Some("Australia/Melbourne"), true),
        Pending
    );
    assert_eq!(
        hosted
            .e
            .initialize_collection(REQUEST, Some("Australia/Melbourne"), false),
        Pending
    );
    assert_eq!(svc.head(&COL).0, before);
    for call in hosted.e.take_log_calls() {
        assert!(matches!(call.request, LogRequest::Append(_)));
        assert!(hosted.log.call(call.request).is_ok());
    }
    assert_eq!(svc.head(&COL).0, before + 1);
    drop(hosted);

    let mut joined = open_with_entropy(&svc, 3);
    joined.pump(false);
    let store = joined.e.replica().store();
    let config = store.resource(CONFIG).unwrap().unwrap();
    assert_eq!(
        mdbn_core::types::Catalog::load([(CONFIG, config.as_str())])
            .settings()
            .timezone
            .as_deref(),
        Some("Australia/Melbourne"),
    );
    let original = readme(store).unwrap();
    assert_eq!(
        original.doc,
        include_str!("../../../../../../templates/mdbase/README.md")
    );
    assert_eq!(
        setup_targets(Some(&config)),
        ["_mdbase/types/note.md", "_mdbase/contracts/example.note.md"]
    );

    let edited_config = format!("{config}# owner edit\n");
    let edited_readme = "# Edited by the owner\n";
    write(
        &mut joined,
        vec![
            Op::ResourcePut(ResourcePut {
                path: CONFIG.into(),
                doc: Text::Inline(edited_config.clone()),
                base_revision: None,
                must_not_exist: None,
            }),
            Op::Document(Document {
                id: original.id,
                base: Some(DocVersion {
                    path: README.into(),
                    doc: Text::Inline(original.doc),
                }),
                new: Some(DocVersion {
                    path: README.into(),
                    doc: Text::Inline(edited_readme.into()),
                }),
                if_revision: Some(original.revision),
            }),
        ],
    );
    let edited_head = svc.head(&COL).0;
    assert_eq!(edited_head, before + 2);
    let mut retried = open_with_entropy(&svc, 4);
    retried.pump(false);
    assert_eq!(
        retried
            .e
            .initialize_collection(REQUEST, Some("Australia/Melbourne"), true),
        Confirmed
    );
    retried.pump(false);
    let store = retried.e.replica().store();
    assert_eq!(
        store.resource(CONFIG).unwrap().as_deref(),
        Some(edited_config.as_str())
    );
    assert_eq!(readme(store).unwrap().doc, edited_readme);
    assert_eq!(svc.head(&COL).0, edited_head);
}

#[test]
fn portal_initialization_omits_missing_or_unrecognized_timezones() {
    for timezone in [None, Some("local"), Some("Mars/Olympus"), Some("CET")] {
        let (svc, _) = genesis_fixture();
        let mut hosted = open(&svc);
        hosted.pump(false);
        assert_eq!(
            hosted.e.initialize_collection(REQUEST, timezone, true),
            Pending
        );
        hosted.pump(false);
        assert_eq!(
            hosted.e.initialize_collection(REQUEST, timezone, false),
            Confirmed
        );
        let config = hosted
            .e
            .replica()
            .store()
            .resource(CONFIG)
            .unwrap()
            .unwrap();
        let catalog = mdbn_core::types::Catalog::load([(CONFIG, config.as_str())]);
        assert!(catalog.is_valid());
        assert_eq!(catalog.settings().timezone, None);
    }
}

#[test]
fn ordinary_open_keeps_root_defaults_and_seed_conflicts_do_not_partially_write() {
    let (svc, _, _, _) = fixture();
    let mut hosted = open(&svc);
    hosted.pump(false);
    let store = hosted.e.replica().store();
    assert_eq!(store.resource(CONFIG).unwrap(), None);
    assert!(readme(store).is_none());
    assert_eq!(
        setup_targets(None),
        ["_types/note.md", "_contracts/example.note.md"]
    );
    write(
        &mut hosted,
        vec![Op::Create(Create {
            id: B16([0x62; 16]),
            path: Some(README.into()),
            type_name: None,
            frontmatter: None,
            body: None,
            document: Some(Text::Inline("# Existing\n".into())),
        })],
    );
    assert_eq!(
        hosted.e.initialize_collection(REQUEST, Some("UTC"), true),
        Pending
    );
    hosted.pump(false);
    assert_eq!(
        hosted.e.initialize_collection(REQUEST, Some("UTC"), false),
        Refused
    );
    let store = hosted.e.replica().store();
    assert_eq!(store.resource(CONFIG).unwrap(), None);
    assert_eq!(readme(store).unwrap().doc, "# Existing\n");
}
