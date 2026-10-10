//! Complete pure envelope staging, not authenticated provider publication.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use mdbn_core::ids::{FileId, Hash, Uuid, revision};
use mdbn_core::intent::{BlobRef, FileContent, Op, OpClock};
use mdbn_core::plan::Effect;
use mdbn_core::setup::{
    capture::{SetupSourceObservation, SetupStateView},
    configuration::{
        ConfigurationDeclaration, ConfigurationOperation, ConfigurationPredicate,
        ConfigurationProvision, ConfigurationRequirement,
    },
    envelope::{
        CollectionSetup, apply_collection_setup, assess_collection_setup,
        collection_setup_source_requirements,
    },
    receipts::{PROVISION_LOCK_PATH, ProvisionLock},
};
use mdbn_core::state::{MemState, Overlay, StateView, StoredFile};
use mdbn_core::validate::{Issue, Severity, Tier};
use mdbn_core::value::Value;
use std::collections::BTreeMap;
fn id(n: u8) -> Uuid {
    Uuid([n; 16])
}
fn clock() -> OpClock {
    OpClock {
        instant_ms: 0,
        tz: "UTC".into(),
        local_date: "1970-01-01".into(),
    }
}
struct Fixture {
    state: MemState,
    files: Vec<StoredFile>,
    sources: BTreeMap<FileId, String>,
    revision: Hash,
    available: bool,
    page_limit: usize,
    repeat_page: bool,
}
impl Fixture {
    fn new() -> Self {
        let mut state = MemState::new();
        state.insert_resource("mdbase.yaml", "spec_version: '0.3.0'\n");
        Self {
            state,
            files: Vec::new(),
            sources: BTreeMap::new(),
            revision: Hash::of(b"head"),
            available: true,
            page_limit: 128,
            repeat_page: false,
        }
    }
    fn file(&mut self, n: u8, path: &str, doc: &str) {
        let blob = BlobRef {
            plain_hash: revision(doc),
            size: doc.len() as u64,
            blob_id: [n; 32],
            id_epoch: 1,
            part_size: 8_388_608,
        };
        self.state.apply_effect(&Effect::PutFile {
            id: id(n),
            path: path.into(),
            blob,
        });
        self.files.push(self.state.file(&id(n)).unwrap());
        self.files.sort_by_key(|f| f.id);
        self.sources.insert(id(n), doc.into());
    }
}
impl SetupStateView for Fixture {
    fn state(&self) -> &dyn StateView {
        &self.state
    }
    fn collection_revision(&self) -> Hash {
        self.revision
    }
    fn file_page(
        &self,
        after: Option<FileId>,
        limit: usize,
    ) -> Result<Vec<StoredFile>, Box<Issue>> {
        if !self.available {
            return Err(Box::new(Issue::new(
                "unavailable",
                Severity::Error,
                Tier::Request,
                "no inventory",
            )));
        }
        Ok(self
            .files
            .iter()
            .filter(|f| self.repeat_page || after.is_none_or(|a| f.id > a))
            .take(limit.min(self.page_limit))
            .cloned()
            .collect())
    }
    fn source(&self, file: &StoredFile, _: usize) -> Result<SetupSourceObservation, Box<Issue>> {
        self.sources
            .get(&file.id)
            .cloned()
            .map(SetupSourceObservation::Utf8)
            .ok_or_else(|| {
                Box::new(Issue::new(
                    "unavailable",
                    Severity::Error,
                    Tier::Request,
                    "missing source",
                ))
            })
    }
}
#[test]
fn prospective_requirements_never_fetch_source_or_bypass_complete_inventory() {
    let mut f = Fixture::new();
    f.file(1, "tasks.base", "views: []\n");
    f.file(2, "other.bin", "opaque");
    f.sources.clear();
    let requests = collection_setup_source_requirements(&f, &setup(), &clock()).unwrap();
    assert!(requests.applicable);
    assert_eq!(requests.files, vec![f.files[0].clone()]);
    assert_eq!(requests.collection_revision, f.revision);
    assert_eq!(
        assess_collection_setup(&f, &setup(), &clock())
            .unwrap_err()
            .code,
        "collection_setup_metadata_unavailable"
    );
    f.available = false;
    assert_eq!(
        collection_setup_source_requirements(&f, &setup(), &clock())
            .unwrap_err()
            .code,
        "collection_setup_metadata_unavailable"
    );
}
#[test]
fn requirements_and_full_assessment_use_the_same_prospective_catalog() {
    let mut f = Fixture::new();
    f.file(1, "tasks.base", "views: []\n");
    f.file(2, "current.md", "---\na: true\n---\n");
    f.file(3, "raw.txt", "raw");
    let requests = collection_setup_source_requirements(&f, &setup(), &clock()).unwrap();
    let assessment = assess_collection_setup(&f, &setup(), &clock()).unwrap();
    assert_eq!(
        requests.files,
        assessment
            .files
            .iter()
            .map(|a| a.file.clone())
            .collect::<Vec<_>>()
    );
    assert_eq!(requests.provision_digest, assessment.provision_digest);
    assert_eq!(requests.applicable, assessment.applicable);
    assert!(
        !f.state.catalog().is_record_path("tasks.base"),
        "preflight does not mutate existing catalog"
    );
}
#[test]
fn requirements_keep_above_cap_metadata_without_demanding_source() {
    let mut f = Fixture::new();
    f.file(1, "big.base", &"x".repeat(1_048_577));
    f.sources.clear();
    let requests = collection_setup_source_requirements(&f, &setup(), &clock()).unwrap();
    assert_eq!(requests.files, f.files);
    let assessment = assess_collection_setup(&f, &setup(), &clock()).unwrap();
    assert_eq!(
        assessment.files[0].diagnostic.as_deref(),
        Some("record_too_large")
    );
}
#[test]
fn requirements_block_conflicts_and_malformed_receipts_before_source_io() {
    let mut f = Fixture::new();
    f.file(1, "tasks.base", "views: []\n");
    f.sources.clear();
    f.state.insert_resource(
        "mdbase.yaml",
        "spec_version: '0.3.0'\nsettings:\n  record_extensions: false\n",
    );
    let requests = collection_setup_source_requirements(&f, &setup(), &clock()).unwrap();
    assert!(!requests.applicable);
    assert!(requests.files.is_empty());
    f.state.insert_resource(PROVISION_LOCK_PATH, "not-a-ledger");
    assert!(collection_setup_source_requirements(&f, &setup(), &clock()).is_err());
}
#[test]
fn requirement_inventory_short_pages_continue_and_repeated_pages_refuse() {
    let mut f = Fixture::new();
    f.file(1, "a.base", "views: []\n");
    f.file(2, "b.base", "views: []\n");
    f.sources.clear();
    f.page_limit = 1;
    assert_eq!(
        collection_setup_source_requirements(&f, &setup(), &clock())
            .unwrap()
            .files,
        f.files
    );
    f.repeat_page = true;
    assert_eq!(
        collection_setup_source_requirements(&f, &setup(), &clock())
            .unwrap_err()
            .code,
        "collection_setup_metadata_unavailable"
    );
}
fn apply_ops(f: &mut Fixture, ops: Vec<Op>, c: &OpClock) {
    let m = mdbn_core::intent::Mutation {
        id: id(90),
        origin: id(91),
        base_seq: 0,
        clock: c.clone(),
        seed: [0; 32],
        source: mdbn_core::intent::Source::Api,
        ops,
        on_behalf: None,
        conflict_mode: mdbn_core::intent::ConflictMode::Record,
        validated_at: None,
        room: None,
    };
    let p = mdbn_core::plan(
        &m,
        &f.state,
        &mdbn_core::plan::PlanOptions {
            stage: mdbn_core::plan::Stage::Head,
        },
    )
    .unwrap();
    f.state.apply(&p);
    f.files.retain(|row| f.state.file(&row.id).is_some());
    f.revision = Hash::of(b"applied head");
}
fn setup() -> CollectionSetup {
    CollectionSetup {
        application_id: "app.reader".into(),
        declaration_digest: Hash::of(b"declaration"),
        type_packs: Vec::new(),
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
    }
}
#[test]
fn reviewed_config_promotions_and_shared_receipts_are_one_operation_set() {
    let mut f = Fixture::new();
    f.file(1, "views/default.base", "# keep\r\nviews: []\r\n");
    f.file(2, "views/broken.base", "views: [");
    let s = setup();
    let c = clock();
    let a = assess_collection_setup(&f, &s, &c).unwrap();
    assert!(a.applicable);
    assert_eq!(a.files.len(), 2);
    assert_eq!(a.files[0].action, "promote");
    assert_eq!(
        a.files[1].diagnostic.as_deref(),
        Some("invalid_frontmatter")
    );
    let (_, ops) =
        apply_collection_setup(&f, &s, &c, a.collection_revision, a.assessment_digest).unwrap();
    assert_eq!(ops.len(), 3);
    assert!(matches!(&ops[0],Op::ResourcePut(r) if r.path=="mdbase.yaml"));
    assert!(matches!(&ops[1], Op::OrdinaryFileToRecord(_)));
    assert!(matches!(&ops[2],Op::ResourcePut(r) if r.path==PROVISION_LOCK_PATH));
    assert!(f.state.record(&id(1)).is_none());
    assert!(f.state.resource(PROVISION_LOCK_PATH).is_none());
    let mut overlay = Overlay::new(&f.state);
    for op in ops {
        match op {
            Op::ResourcePut(r) => overlay.apply_effect(&Effect::PutResource {
                path: r.path,
                doc: r.doc,
            }),
            Op::OrdinaryFileToRecord(p) => overlay.apply_effect(&Effect::ReindexOrdinaryFile {
                id: p.id,
                path: p.path,
                doc: p.doc,
            }),
            _ => panic!("unexpected op"),
        }
    }
    assert_eq!(
        &*overlay.record(&id(1)).unwrap().source,
        "# keep\r\nviews: []\r\n"
    );
    assert!(overlay.file(&id(2)).is_some());
    let lock = ProvisionLock::parse(&overlay.resource(PROVISION_LOCK_PATH).unwrap()).unwrap();
    assert_eq!(
        lock.contributions[0].contributors[0].application_id,
        "app.reader"
    );
    assert_eq!(
        overlay.catalog().settings().record_extensions,
        vec!["md", "base"]
    );
}
fn note_pack(application: &str) -> mdbn_core::setup::envelope::CollectionSetupTypePack {
    let doc = "---\nkind: mdbase.type\nname: note\nversion: 1\nschema:\n  dialect: json-schema-2020-12\n  value: {type: object}\n---\n";
    let manifest = format!(
        "kind: mdbase.type-pack\nid: example.notes\nversion: 1.0.0\nresources:\n  - kind: type\n    mode: managed\n    source: note.md\n    target: _types/note.md\n    digest: {}\n",
        revision(doc)
    );
    mdbn_core::setup::envelope::CollectionSetupTypePack {
        pack: mdbn_core::packs::load_pack(&manifest, &|_| Some(doc.into())).unwrap(),
        options: mdbn_core::packs::AssessOptions {
            installed_by: application.into(),
            ..Default::default()
        },
    }
}

#[test]
fn short_pages_are_not_eof_and_repeated_pages_refuse() {
    let mut f = Fixture::new();
    f.file(1, "one.base", "views: []\n");
    f.file(2, "two.base", "views: []\n");
    f.page_limit = 1;
    let a = assess_collection_setup(&f, &setup(), &clock()).unwrap();
    assert_eq!(a.files.len(), 2);
    f.repeat_page = true;
    assert_eq!(
        assess_collection_setup(&f, &setup(), &clock())
            .unwrap_err()
            .code,
        "collection_setup_metadata_unavailable"
    );
}

#[test]
fn setup_resources_do_not_shadow_file_or_record_holders() {
    for path in ["mdbase.yaml", "mdbase.lock.yaml", "_types/note.md"] {
        for record in [false, true] {
            let mut f = Fixture::new();
            let mut s = setup();
            s.type_packs.push(note_pack(&s.application_id));
            if record {
                f.state.insert_record(id(10), path, "secret: held\n");
            } else {
                f.file(10, path, "secret: held\n");
            }
            let e = assess_collection_setup(&f, &s, &clock()).unwrap_err();
            assert_eq!(e.code, "collection_setup_namespace_conflict");
            assert!(e.message.contains(path));
            assert!(!e.message.contains("secret"));
            assert!(f.state.resource(PROVISION_LOCK_PATH).is_none());
        }
    }
}

#[test]
fn later_pack_assessments_are_not_omitted_after_a_conflicting_pack() {
    let mut f = Fixture::new();
    let mut s = setup();
    let p = note_pack(&s.application_id);
    f.state.insert_resource(
        "_types/note.md",
        "---\nkind: mdbase.type\nname: other\nversion: 1\n---\n",
    );
    s.type_packs.push(p.clone());
    let mut later = p;
    later.pack.id = "example.later".into();
    later.pack.resources[0].target = "_types/later.md".into();
    s.type_packs.push(later);
    let a = assess_collection_setup(&f, &s, &clock()).unwrap();
    assert!(!a.applicable);
    assert_eq!(a.type_packs.len(), 2);
    assert_eq!(
        apply_collection_setup(&f, &s, &clock(), a.collection_revision, a.assessment_digest)
            .unwrap_err()
            .code,
        "collection_setup_conflict"
    );
    assert!(f.state.resource(PROVISION_LOCK_PATH).is_none());
}

#[test]
fn reapply_is_idempotent_even_with_a_new_capture_clock() {
    let mut f = Fixture::new();
    f.file(1, "v.base", "views: []\n");
    let s = setup();
    let c = clock();
    let first = assess_collection_setup(&f, &s, &c).unwrap();
    let (_, ops) = apply_collection_setup(
        &f,
        &s,
        &c,
        first.collection_revision,
        first.assessment_digest,
    )
    .unwrap();
    apply_ops(&mut f, ops, &c);
    let mut later = c.clone();
    later.instant_ms += 1_000;
    let again = assess_collection_setup(&f, &s, &later).unwrap();
    assert_eq!(first.provision_digest, again.provision_digest);
    let (_, ops) = apply_collection_setup(
        &f,
        &s,
        &later,
        again.collection_revision,
        again.assessment_digest,
    )
    .unwrap();
    assert!(ops.is_empty());
    let ledger = ProvisionLock::parse(&f.state.resource(PROVISION_LOCK_PATH).unwrap()).unwrap();
    assert_eq!(ledger.contributions[0].contributors.len(), 1);
}

#[test]
fn nested_pack_receipts_and_configuration_commit_in_the_same_plan() {
    let mut f = Fixture::new();
    let mut s = setup();
    let doc = "---\nkind: mdbase.type\nname: note\nversion: 1\nschema:\n  dialect: json-schema-2020-12\n  value: {type: object}\n---\n";
    let manifest = format!(
        "kind: mdbase.type-pack\nid: example.notes\nversion: 1.0.0\nresources:\n  - kind: type\n    mode: managed\n    source: note.md\n    target: _types/note.md\n    digest: {}\n",
        revision(doc)
    );
    let pack = mdbn_core::packs::load_pack(&manifest, &|_| Some(doc.into())).unwrap();
    s.type_packs
        .push(mdbn_core::setup::envelope::CollectionSetupTypePack {
            pack,
            options: mdbn_core::packs::AssessOptions {
                installed_by: s.application_id.clone(),
                ..Default::default()
            },
        });
    let c = clock();
    let a = assess_collection_setup(&f, &s, &c).unwrap();
    assert!(a.applicable);
    assert_eq!(a.type_packs.len(), 1);
    let (_, ops) =
        apply_collection_setup(&f, &s, &c, a.collection_revision, a.assessment_digest).unwrap();
    assert_eq!(ops.len(), 4);
    apply_ops(&mut f, ops, &c);
    assert!(f.state.resource("mdbase.lock.yaml").is_some());
    assert!(f.state.resource(PROVISION_LOCK_PATH).is_some());
    assert!(f.state.catalog().type_named("note").is_some());
    let a = assess_collection_setup(&f, &s, &c).unwrap();
    let (_, ops) =
        apply_collection_setup(&f, &s, &c, a.collection_revision, a.assessment_digest).unwrap();
    assert!(ops.is_empty());
}

#[test]
fn stale_head_or_actual_declaration_changes_refuse_whole_apply() {
    let mut f = Fixture::new();
    f.file(1, "v.base", "views: []\n");
    let mut s = setup();
    let c = clock();
    let a = assess_collection_setup(&f, &s, &c).unwrap();
    f.revision = Hash::of(b"new head");
    assert_eq!(
        apply_collection_setup(&f, &s, &c, a.collection_revision, a.assessment_digest)
            .unwrap_err()
            .code,
        "concurrent_modification"
    );
    f.revision = a.collection_revision;
    s.configuration.provisions[0].value = Value::string("yaml");
    s.configuration.requirements[0].value = Value::string("yaml");
    assert_eq!(
        apply_collection_setup(&f, &s, &c, a.collection_revision, a.assessment_digest)
            .unwrap_err()
            .code,
        "concurrent_modification"
    );
    assert!(f.state.resource(PROVISION_LOCK_PATH).is_none());
}
#[test]
fn missing_inventory_source_and_changed_descriptor_are_not_empty_success() {
    let s = setup();
    let c = clock();
    let mut f = Fixture::new();
    f.available = false;
    assert_eq!(
        assess_collection_setup(&f, &s, &c).unwrap_err().code,
        "collection_setup_metadata_unavailable"
    );
    f.available = true;
    f.file(1, "v.base", "views: []\n");
    f.sources.clear();
    assert_eq!(
        assess_collection_setup(&f, &s, &c).unwrap_err().code,
        "collection_setup_metadata_unavailable"
    );
    f.sources.insert(id(1), "views: []\n".into());
    f.files[0].content = FileContent::Blob(BlobRef {
        plain_hash: Hash::of(b"different"),
        size: 10,
        blob_id: [8; 32],
        id_epoch: 1,
        part_size: 1,
    });
    assert_eq!(
        assess_collection_setup(&f, &s, &c).unwrap_err().code,
        "concurrent_modification"
    );
}
#[test]
fn original_external_envelope_shape_decodes_without_manifest_configuration_bypass() {
    let s = setup();
    let Value::Map(mut value) = s.configuration.to_value() else {
        unreachable!()
    };
    for key in ["requirements", "provisions"] {
        let clauses = value.remove(key).unwrap();
        let mut block = mdbn_core::value::Map::new();
        block.insert("configuration", clauses);
        value.insert(key, Value::Map(block));
    }
    value.insert("application_id", Value::string(s.application_id.clone()));
    value.insert(
        "declaration_digest",
        Value::string(s.declaration_digest.to_string()),
    );
    let decoded =
        CollectionSetup::from_value(&Value::Map(value.clone()), &|_| panic!("no packs")).unwrap();
    assert_eq!(decoded, s);
    value.insert("configuration", Value::Null);
    assert_eq!(
        CollectionSetup::from_value(&Value::Map(value), &|_| panic!(
            "unknown field must refuse first"
        ))
        .unwrap_err()
        .code,
        "invalid_collection_setup"
    );
}

#[test]
fn source_hash_failure_is_provider_unavailable_not_a_parse_receipt() {
    let mut f = Fixture::new();
    f.file(1, "v.base", "views: []\n");
    f.sources.insert(id(1), "views: {}\n".into());
    assert_eq!(
        assess_collection_setup(&f, &setup(), &clock())
            .unwrap_err()
            .code,
        "collection_setup_metadata_unavailable"
    );
    assert!(f.state.resource(PROVISION_LOCK_PATH).is_none());
}

#[test]
fn occupied_receipt_namespace_refuses_before_any_staging() {
    for record in [false, true] {
        let mut f = Fixture::new();
        if record {
            f.state.insert_record(id(1), PROVISION_LOCK_PATH, "x: 1\n");
        } else {
            f.file(1, PROVISION_LOCK_PATH, "x: 1\n");
        }
        let e = assess_collection_setup(&f, &setup(), &clock()).unwrap_err();
        assert_eq!(e.code, "collection_setup_namespace_conflict");
        assert!(e.message.contains("Rename mdbase.provisions.yaml"));
        assert!(f.state.resource(PROVISION_LOCK_PATH).is_none());
    }
}
#[test]
fn private_configuration_conflict_suppresses_all_operations() {
    let mut f = Fixture::new();
    f.state.insert_resource(
        "mdbase.yaml",
        "spec_version: '0.3.0'\nsettings:\n  record_extensions: SECRET\n",
    );
    let a = assess_collection_setup(&f, &setup(), &clock()).unwrap();
    assert!(!a.applicable);
    assert!(!format!("{:?}", a.configuration.configuration).contains("SECRET"));
    assert_eq!(
        apply_collection_setup(
            &f,
            &setup(),
            &clock(),
            a.collection_revision,
            a.assessment_digest
        )
        .unwrap_err()
        .code,
        "collection_setup_conflict"
    );
}
