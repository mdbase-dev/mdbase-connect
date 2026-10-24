//! Reviewed adoption binds transient choices, never changes signed provision identity.
use mdbn_core::{
    ids::{FileId, Hash, revision},
    intent::{Op, OpClock},
    packs::{AssessOptions, load_pack},
    setup::{
        capture::{SetupSourceObservation, SetupStateView},
        configuration::ConfigurationDeclaration,
        envelope::{
            CollectionSetup, CollectionSetupTypePack, apply_reviewed_collection_setup,
            assess_collection_setup, assess_reviewed_collection_setup,
        },
    },
    state::{MemState, StateView, StoredFile},
    validate::Issue,
};
use std::collections::BTreeMap;
const PATH: &str = "_types/note.md";
const DOC: &str = "---\nkind: mdbase.type\nname: note\nversion: 1\nschema:\n  dialect: json-schema-2020-12\n  value: {type: object}\n---\n";
struct View(MemState);
impl SetupStateView for View {
    fn state(&self) -> &dyn StateView {
        &self.0
    }
    fn collection_revision(&self) -> Hash {
        Hash::of(b"frozen-head")
    }
    fn file_page(&self, _: Option<FileId>, _: usize) -> Result<Vec<StoredFile>, Box<Issue>> {
        Ok(vec![])
    }
    fn source(&self, _: &StoredFile, _: usize) -> Result<SetupSourceObservation, Box<Issue>> {
        panic!("empty complete file inventory")
    }
}
fn fixture() -> (View, CollectionSetup, OpClock, String) {
    let existing = format!("{DOC}Existing unmanaged note type.\n");
    let mut state = MemState::new();
    state.insert_resource("mdbase.yaml", "spec_version: '0.3.0'\n");
    state.insert_resource(PATH, &existing);
    let manifest = format!(
        "kind: mdbase.type-pack\nid: example.notes\nversion: 1.0.0\nresources:\n  - kind: type\n    mode: managed\n    source: note.md\n    target: {PATH}\n    digest: {}\n",
        revision(DOC)
    );
    let setup = CollectionSetup {
        application_id: "example.application".into(),
        declaration_digest: Hash::of(b"signed"),
        configuration: ConfigurationDeclaration {
            requirements: vec![],
            provisions: vec![],
        },
        type_packs: vec![CollectionSetupTypePack {
            pack: load_pack(&manifest, &|_| Some(DOC.into())).unwrap(),
            options: AssessOptions {
                installed_by: "example.application".into(),
                ..Default::default()
            },
        }],
    };
    (
        View(state),
        setup,
        OpClock {
            instant_ms: 0,
            tz: "UTC".into(),
            local_date: "1970-01-01".into(),
        },
        existing,
    )
}
#[test]
fn reviewed_choice_has_actual_cas_and_stable_provision_identity() {
    let (view, setup, clock, existing) = fixture();
    let original = setup.clone();
    let conflict = assess_collection_setup(&view, &setup, &clock).unwrap();
    assert!(!conflict.applicable);
    let decisions = BTreeMap::from([(PATH.into(), revision(&existing))]);
    let review = assess_reviewed_collection_setup(&view, &setup, &clock, &decisions, &[]).unwrap();
    assert!(review.applicable);
    assert_eq!(review.provision_digest, conflict.provision_digest);
    let (_, ops) = apply_reviewed_collection_setup(
        &view,
        &setup,
        &clock,
        &decisions,
        &[],
        review.collection_revision,
        review.assessment_digest,
    )
    .unwrap();
    let puts: Vec<_> = ops
        .iter()
        .filter_map(|op| match op {
            Op::ResourcePut(p) if p.path == PATH => Some(p),
            _ => None,
        })
        .collect();
    assert_eq!(puts.len(), 1);
    assert_eq!(puts[0].base_revision, Some(revision(&existing)));
    assert!(!puts[0].must_not_exist);
    assert_eq!(puts[0].doc, DOC);
    assert_eq!(
        setup, original,
        "transient adoption must not enter pack options or signed declaration"
    );
}
#[test]
fn decision_bytes_are_bound_even_if_a_provider_reuses_its_head_token() {
    let (mut view, setup, clock, existing) = fixture();
    let first = BTreeMap::from([(PATH.into(), revision(&existing))]);
    let review = assess_reviewed_collection_setup(&view, &setup, &clock, &first, &[]).unwrap();
    let edited = format!("{existing}Owner edit.\n");
    view.0.insert_resource(PATH, &edited);
    assert!(
        apply_reviewed_collection_setup(
            &view,
            &setup,
            &clock,
            &first,
            &[],
            review.collection_revision,
            review.assessment_digest
        )
        .is_err()
    );
    let second = BTreeMap::from([(PATH.into(), revision(&edited))]);
    let changed = assess_reviewed_collection_setup(&view, &setup, &clock, &second, &[]).unwrap();
    assert_ne!(changed.assessment_digest, review.assessment_digest);
    assert_eq!(changed.provision_digest, review.provision_digest);
    assert!(
        apply_reviewed_collection_setup(
            &view,
            &setup,
            &clock,
            &second,
            &[],
            review.collection_revision,
            review.assessment_digest
        )
        .is_err()
    );
}
