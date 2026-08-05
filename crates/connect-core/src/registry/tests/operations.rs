use super::*;
use mdbase_connect_protocol::{
    ConfigurationOperation, ConfigurationPredicate, ConfigurationProvision,
    ConfigurationRequirement,
};

#[test]
fn portable_mutation_results_produce_targeted_invalidations() {
    let output = serde_json::to_value(mdbase::v03::OperationResult {
        valid: true,
        result: json!({
            "from": "old.md",
            "to": "new.md",
            "references_updated": [{"path": "linked.md"}],
        }),
        diagnostics: vec![],
    })
    .unwrap();
    assert_eq!(
        operation_invalidation(
            "rename",
            &json!({"from": "old.md", "to": "new.md"}),
            &output,
        ),
        CollectionInvalidation::Records(
            ["linked.md", "new.md", "old.md"]
                .into_iter()
                .map(str::to_string)
                .collect()
        )
    );
    assert_eq!(
        operation_invalidation(
            "update",
            &json!({"path": "private.md"}),
            &json!({"valid": false}),
        ),
        CollectionInvalidation::None,
    );
    assert_eq!(
        operation_invalidation(
            "rename",
            &json!({"from": "old.md", "to": "new.md", "dry_run": true}),
            &json!({"valid": true, "result": {"would_rename": true}}),
        ),
        CollectionInvalidation::None,
    );
    assert_eq!(
        operation_invalidation("update_type", &json!({}), &json!({"valid": true})),
        CollectionInvalidation::All,
    );
}

#[test]
fn generic_operation_uses_v03_envelope() {
    let state = tempdir().unwrap();
    let collection_parent = tempdir().unwrap();
    let root = collection_parent.path().join("notes");
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let collection = registry.create(&root, Some("Notes")).unwrap();

    let result = registry
        .operation(
            collection.id,
            "create",
            &json!({
                "path": "hello.md",
                "frontmatter": { "title": "Hello" },
                "body": "World"
            }),
        )
        .unwrap();
    assert_eq!(result["valid"], true);
    assert!(result["result"]["revision"].as_str().is_some());
    for field in [
        "path",
        "revision",
        "types",
        "frontmatter",
        "effective_frontmatter",
        "body",
        "file",
    ] {
        assert!(
            result["result"].get(field).is_some(),
            "create omitted {field}: {result:#}"
        );
    }

    let read = registry
        .operation(collection.id, "read", &json!({ "path": "hello.md" }))
        .unwrap();
    assert_eq!(read["valid"], true);
    assert_eq!(read["result"]["frontmatter"]["title"], "Hello");
    assert_eq!(read["result"]["effective_frontmatter"]["title"], "Hello");

    let update = registry
        .operation(
            collection.id,
            "update",
            &json!({ "path": "hello.md", "patch": { "status": "done" } }),
        )
        .unwrap();
    assert_eq!(update["valid"], true);
    assert_eq!(update["result"]["frontmatter"]["status"], "done");
    assert_eq!(update["result"]["effective_frontmatter"]["status"], "done");
    assert_eq!(update["result"]["file"]["name"], "hello.md");
}

#[test]
fn legacy_description_only_advertises_executable_operations() {
    let state = tempdir().unwrap();
    let collection_parent = tempdir().unwrap();
    let root = collection_parent.path().join("legacy");
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("mdbase.yaml"), "spec_version: 0.2.0\n").unwrap();
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let collection = registry.add(&root).unwrap();

    let description = registry.describe(collection.id).unwrap();

    assert!(description.operations.contains(&"read".to_string()));
    assert!(description.operations.contains(&"query".to_string()));
    assert!(description.operations.contains(&"validate".to_string()));
    for operation in ["create", "update", "delete", "rename"] {
        assert!(!description.operations.contains(&operation.to_string()));
    }
    assert!(!description.operations.contains(&"read_type".to_string()));
}

#[test]
fn legacy_records_are_read_only_until_explicit_migration() {
    let state = tempdir().unwrap();
    let collection_parent = tempdir().unwrap();
    let root = collection_parent.path().join("legacy");
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("mdbase.yaml"), "spec_version: 0.2.0\n").unwrap();
    let document = "---\ntitle: Legacy\n---\nBody\n";
    fs::write(root.join("legacy.md"), document).unwrap();
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let collection = registry.add(&root).unwrap();

    let read = registry
        .operation(collection.id, "read", &json!({"path": "legacy.md"}))
        .unwrap();
    assert_eq!(read["valid"], true, "{read}");
    assert_eq!(read["result"]["frontmatter"]["title"], "Legacy");

    let query = registry
        .operation(
            collection.id,
            "query",
            &json!({"where": "title == 'Legacy'", "include_body": true}),
        )
        .unwrap();
    assert_eq!(query["valid"], true, "{query}");
    assert_eq!(query["result"]["results"].as_array().unwrap().len(), 1);
    assert_eq!(query["result"]["results"][0]["body"], "Body\n");

    let unsupported_query = registry
        .operation(collection.id, "query", &json!({"folder": "private"}))
        .unwrap();
    assert_eq!(unsupported_query["valid"], false, "{unsupported_query}");
    assert_eq!(
        unsupported_query["diagnostics"][0]["code"],
        "invalid_request"
    );

    let operations = [
        (
            "create",
            json!({
                "path": "new.md",
                "frontmatter": {"title": "New"},
                "body": ""
            }),
        ),
        (
            "update",
            json!({"path": "legacy.md", "patch": {"title": "Changed"}}),
        ),
        ("delete", json!({"path": "legacy.md"})),
        ("rename", json!({"from": "legacy.md", "to": "renamed.md"})),
    ];
    for (operation, input) in operations {
        let result = registry
            .operation(collection.id, operation, &input)
            .unwrap();
        assert_eq!(result["valid"], false, "{operation}: {result}");
        assert_eq!(
            result["diagnostics"][0]["code"], "migration_required",
            "{operation}: {result}"
        );
        assert_eq!(
            result["diagnostics"][0]["details"],
            json!({ "current_version": "0.2.0", "required_version": "0.3.0" }),
            "{operation}: {result}"
        );
    }
    assert_eq!(
        fs::read_to_string(root.join("legacy.md")).unwrap(),
        document
    );
    assert!(!root.join("new.md").exists());
    assert!(!root.join("renamed.md").exists());
}

#[test]
fn invalid_collection_setup_preserves_actionable_diagnostics() {
    let state = tempdir().unwrap();
    let collection_parent = tempdir().unwrap();
    let root = collection_parent.path().join("invalid-setup");
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let collection = registry.create(&root, Some("Invalid setup")).unwrap();

    fs::create_dir_all(root.join("_types")).unwrap();
    fs::write(
        root.join("_types/broken.md"),
        "---\nkind: mdbase.type\nname: broken\nversion: nope\n---\n",
    )
    .unwrap();
    let error = registry.describe(collection.id).unwrap_err();
    match error {
        ConnectError::CollectionInvalid {
            code, diagnostics, ..
        } => {
            assert_eq!(code, "collection_type_registry_invalid");
            assert!(diagnostics.iter().any(|diagnostic| {
                diagnostic["path"] == "_types/broken.md" && diagnostic["severity"] == "error"
            }));
        }
        other => panic!("unexpected error: {other:?}"),
    }

    fs::remove_file(root.join("_types/broken.md")).unwrap();
    fs::write(root.join("mdbase.yaml"), "spec_version: [0, 3, 0]\n").unwrap();
    let error = registry.describe(collection.id).unwrap_err();
    match error {
        ConnectError::CollectionInvalid {
            code, diagnostics, ..
        } => {
            assert_eq!(code, "collection_configuration_invalid");
            assert!(diagnostics.iter().any(|diagnostic| {
                diagnostic["path"] == "mdbase.yaml" && diagnostic["severity"] == "error"
            }));
        }
        other => panic!("unexpected error: {other:?}"),
    }
}

#[test]
fn type_operations_are_revision_safe_and_require_full_collection_scope() {
    let state = tempdir().unwrap();
    let collection_parent = tempdir().unwrap();
    let root = collection_parent.path().join("typed");
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let collection = registry.create(&root, Some("Typed")).unwrap();
    let document = r#"---
kind: mdbase.type
name: project
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    properties:
      title: { type: string }
---
"#;

    let created = registry
        .operation(collection.id, "create_type", &json!({"document": document}))
        .unwrap();
    assert_eq!(created["valid"], true, "{created}");
    assert_eq!(created["result"]["path"], "_types/project.md");
    let revision = created["result"]["revision"].as_str().unwrap();

    let read = registry
        .operation(collection.id, "read_type", &json!({"name": "project"}))
        .unwrap();
    assert_eq!(read["result"]["revision"], revision);

    let updated = registry
        .operation(
            collection.id,
            "update_type",
            &json!({
                "name": "project",
                "if_revision": revision,
                "document": document.replace("version: 1", "version: 2")
            }),
        )
        .unwrap();
    assert_eq!(updated["valid"], true, "{updated}");
    assert_ne!(updated["result"]["revision"], revision);

    let contract_scope = unavailable_contract_scope();
    assert!(matches!(
        registry.scoped_operation(
            collection.id,
            "read_type",
            &json!({"name": "project"}),
            &contract_scope
        ),
        Err(ConnectError::AccessDenied(_))
    ));
}

#[test]
fn installs_type_packs_as_full_collection_operations_and_provisions_idempotently() {
    let state = tempdir().unwrap();
    let collection_parent = tempdir().unwrap();
    let root = collection_parent.path().join("provisioned");
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let collection = registry.create(&root, Some("Provisioned")).unwrap();
    let contract_document = r#"---
kind: mdbase.contract
contract_type: record
id: workout.record
version: 1.0.0
record_schema:
  dialect: json-schema-2020-12
  value:
    type: object
    additionalProperties: false
    properties:
      type: { const: workout }
---
"#;
    let requirements = ApplicationRequirements {
        contracts: vec![ContractRequirement {
            id: "workout.record".to_string(),
            version: "1.0.0".to_string(),
            digest: mdbase::data_contracts::data_contract_digest(
                &serde_yaml::from_str::<serde_json::Value>(
                    contract_document
                        .strip_prefix("---\n")
                        .and_then(|value| value.strip_suffix("---\n"))
                        .expect("contract fixture has frontmatter fences"),
                )
                .expect("contract fixture is valid YAML"),
            ),
        }],
        ..Default::default()
    };
    let type_document = r#"---
kind: mdbase.type
name: workout
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    properties:
      type: { const: workout }
implements:
  - contract: workout.record
    version: 1.0.0
    fields:
      type: type
---
"#;
    let auxiliary_document = r#"---
kind: mdbase.type
name: workout_note
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    properties:
      type: { const: workout_note }
---
"#;
    let resources = [
        (
            "contract.md",
            "_contracts/workout.record.md",
            "contract",
            contract_document,
        ),
        ("workout.md", "_types/workout.md", "type", type_document),
        (
            "workout-note.md",
            "_types/workout_note.md",
            "type",
            auxiliary_document,
        ),
    ];
    let provision = TypePackProvision {
        manifest: mdbase_connect_protocol::TypePackManifest {
            kind: "mdbase.type-pack".to_string(),
            id: "example.workout".to_string(),
            version: "1.0.0".to_string(),
            name: Some("Workout".to_string()),
            description: None,
            resources: resources
                .iter()
                .map(|(source, target, kind, document)| {
                    mdbase_connect_protocol::TypePackManifestResource {
                        kind: (*kind).to_string(),
                        mode: "managed".to_string(),
                        source: (*source).to_string(),
                        target: (*target).to_string(),
                        digest: format!("sha256:{:x}", Sha256::digest(document.as_bytes())),
                    }
                })
                .collect(),
            extensions: Default::default(),
        },
        resources: resources
            .iter()
            .map(
                |(source, _, _, document)| mdbase_connect_protocol::TypePackSourceResource {
                    source: (*source).to_string(),
                    document: (*document).to_string(),
                },
            )
            .collect(),
        provides: requirements.contracts.clone(),
    };
    let assessed = registry
        .operation(
            collection.id,
            "assess_type_pack",
            &json!({
                "provision": provision,
                "installed_by": "dev.mdbase.tests",
            }),
        )
        .unwrap();
    assert_eq!(assessed["valid"], true, "{assessed}");
    let installed = registry
        .operation(
            collection.id,
            "apply_type_pack",
            &json!({
                "provision": provision,
                "installed_by": "dev.mdbase.tests",
                "expected_assessment_digest": assessed["result"]["assessment_digest"],
            }),
        )
        .unwrap();
    assert_eq!(installed["valid"], true, "{installed}");
    assert_eq!(installed["result"]["desired"]["id"], "example.workout");
    assert_eq!(
        installed["result"]["resources"].as_array().unwrap().len(),
        3
    );
    assert!(matches!(
        registry.scoped_operation(
            collection.id,
            "apply_type_pack",
            &json!({
                "provision": provision,
                "installed_by": "dev.mdbase.tests",
                "expected_assessment_digest": assessed["result"]["assessment_digest"],
            }),
            &unavailable_contract_scope()
        ),
        Err(ConnectError::AccessDenied(_))
    ));

    let provisions = ApplicationProvisions {
        type_packs: vec![provision],
        configuration: Vec::new(),
    };

    let contracts = registry
        .provision_application_setup(
            collection.id,
            "dev.mdbase.tests",
            &format!("sha256:{}", "0".repeat(64)),
            &requirements,
            &provisions,
            &[],
        )
        .unwrap();
    assert!(contracts.contracts.iter().any(|contract| {
        contract.id == requirements.contracts[0].id
            && contract.version == requirements.contracts[0].version
    }));
    assert!(root.join("_contracts/workout.record.md").is_file());
    assert!(root.join("_types/workout.md").is_file());
    assert!(root.join("_types/workout_note.md").is_file());
    registry
        .provision_application_setup(
            collection.id,
            "dev.mdbase.tests",
            &format!("sha256:{}", "0".repeat(64)),
            &requirements,
            &provisions,
            &[],
        )
        .unwrap();
}

#[test]
fn provision_maps_a_contract_to_an_existing_type_without_installing_the_starter() {
    let state = tempdir().unwrap();
    let parent = tempdir().unwrap();
    let root = parent.path().join("notes");
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let collection = registry.create(&root, Some("Notes")).unwrap();
    let original = r#"---
# Keep this comment and the existing layout.
kind: mdbase.type
name: note
version: 3
description: Existing notes
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [heading]
    additionalProperties: true
    properties:
      heading: { type: string }
      state: { type: string }
---
This body is documentation and must remain byte-for-byte intact.
"#;
    fs::create_dir_all(root.join("_types")).unwrap();
    fs::write(root.join("_types/note.md"), original).unwrap();
    let description = registry.describe(collection.id).unwrap();
    let note = description
        .types
        .iter()
        .find(|candidate| candidate.name == "note")
        .unwrap();
    let (requirements, provision) = work_item_provision();
    let setup = ContractSetupChoice {
        contract: requirements.contracts[0].clone(),
        mode: ContractSetupMode::Existing {
            type_name: "note".to_string(),
            type_revision: note.revision.clone().unwrap(),
            fields: [
                ("title".to_string(), "heading".to_string()),
                ("status".to_string(), "state".to_string()),
            ]
            .into_iter()
            .collect(),
            binding: None,
        },
    };

    let contracts = registry
        .provision_application_setup(
            collection.id,
            "dev.mdbase.tests",
            &format!("sha256:{}", "0".repeat(64)),
            &requirements,
            &ApplicationProvisions {
                type_packs: vec![provision],
                configuration: Vec::new(),
            },
            &[setup],
        )
        .unwrap();

    assert!(!root.join("_types/work_item.md").exists());
    let document = fs::read_to_string(root.join("_types/note.md")).unwrap();
    assert!(document.contains("# Keep this comment and the existing layout."));
    assert!(document
        .ends_with("---\nThis body is documentation and must remain byte-for-byte intact.\n"));
    assert!(document.contains("contract: example.work-item"));
    assert!(document.contains("title: heading"));
    assert_eq!(contracts.contracts.len(), 1);
    assert_eq!(contracts.contracts[0].implementations.len(), 1);
    assert_eq!(contracts.contracts[0].implementations[0].type_name, "note");
    assert_eq!(contracts.contracts[0].implementations[0].type_version, 3);
}

#[test]
fn stale_existing_type_setup_leaves_contract_and_type_unchanged() {
    let state = tempdir().unwrap();
    let parent = tempdir().unwrap();
    let root = parent.path().join("notes");
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let collection = registry.create(&root, Some("Notes")).unwrap();
    let original = r#"---
kind: mdbase.type
name: note
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    properties:
      heading: { type: string }
---
"#;
    fs::create_dir_all(root.join("_types")).unwrap();
    fs::write(root.join("_types/note.md"), original).unwrap();
    let (requirements, provision) = work_item_provision();
    let setup = ContractSetupChoice {
        contract: requirements.contracts[0].clone(),
        mode: ContractSetupMode::Existing {
            type_name: "note".to_string(),
            type_revision: format!("sha256:{}", "0".repeat(64)),
            fields: [("title".to_string(), "heading".to_string())]
                .into_iter()
                .collect(),
            binding: None,
        },
    };

    let error = registry
        .provision_application_setup(
            collection.id,
            "dev.mdbase.tests",
            &format!("sha256:{}", "0".repeat(64)),
            &requirements,
            &ApplicationProvisions {
                type_packs: vec![provision],
                configuration: Vec::new(),
            },
            &[setup],
        )
        .unwrap_err();

    assert_eq!(error.code(), "access_denied");
    assert!(error.to_string().contains("changed after it was reviewed"));
    assert_eq!(
        fs::read_to_string(root.join("_types/note.md")).unwrap(),
        original
    );
    assert!(!root.join("_contracts/example.work-item.md").exists());
    assert!(!root.join("_types/work_item.md").exists());
}

#[test]
fn application_setup_preserves_local_configuration_and_is_idempotent() {
    let state = tempdir().unwrap();
    let parent = tempdir().unwrap();
    let root = parent.path().join("notes");
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let collection = registry.create(&root, Some("Notes")).unwrap();
    let description = registry.describe(collection.id).unwrap();
    assert!(description
        .operations
        .contains(&"assess_collection_setup".to_string()));
    assert!(description
        .operations
        .contains(&"apply_collection_setup".to_string()));
    let config_path = root.join("mdbase.yaml");
    let mut config: serde_yaml::Value =
        serde_yaml::from_str(&fs::read_to_string(&config_path).unwrap()).unwrap();
    let mut user_extension = serde_yaml::Mapping::new();
    user_extension.insert(
        serde_yaml::Value::String("display_name".to_string()),
        serde_yaml::Value::String("Notes".to_string()),
    );
    config.as_mapping_mut().unwrap().insert(
        serde_yaml::Value::String("x-unrelated".to_string()),
        serde_yaml::Value::Mapping(user_extension),
    );
    fs::write(&config_path, serde_yaml::to_string(&config).unwrap()).unwrap();
    let requirements = ApplicationRequirements {
        contracts: Vec::new(),
        configuration: vec![ConfigurationRequirement {
            id: "tasknotes-base-sources".to_string(),
            path: "/x-obsidian/bases/include".to_string(),
            predicate: ConfigurationPredicate::Contains,
            value: Value::String("views/tasknotes/**/*.base".to_string()),
        }],
        ..Default::default()
    };
    let provisions = ApplicationProvisions {
        type_packs: Vec::new(),
        configuration: vec![ConfigurationProvision {
            requirement: "tasknotes-base-sources".to_string(),
            operation: ConfigurationOperation::SetAdd,
            path: "/x-obsidian/bases/include".to_string(),
            value: Value::String("views/tasknotes/**/*.base".to_string()),
        }],
    };
    let digest = format!("sha256:{}", "a".repeat(64));
    let first = registry
        .provision_application_setup(
            collection.id,
            "dev.mdbase.tasknotes",
            &digest,
            &requirements,
            &provisions,
            &[],
        )
        .unwrap();
    assert_eq!(first.assessment["status"], "provision");
    let config = fs::read_to_string(root.join("mdbase.yaml")).unwrap();
    assert!(config.contains("views/tasknotes/**/*.base"));
    assert!(config.contains("x-unrelated:"), "{config}");
    assert!(config.contains("display_name: Notes"), "{config}");
    let second = registry
        .provision_application_setup(
            collection.id,
            "dev.mdbase.tasknotes",
            &digest,
            &requirements,
            &provisions,
            &[],
        )
        .unwrap();
    assert_eq!(second.assessment["status"], "current");
    assert_eq!(
        fs::read_to_string(root.join("mdbase.yaml")).unwrap(),
        config
    );
}

#[test]
fn scoped_conditional_writers_share_one_collection_serialization_gate() {
    let state = tempdir().unwrap();
    let collection_parent = tempdir().unwrap();
    let root = collection_parent.path().join("tasks");
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let collection = registry.create(&root, Some("Tasks")).unwrap();
    write_work_item_contract(&root);
    fs::write(
        root.join("_types/task.md"),
        r#"---
kind: mdbase.type
name: task
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    additionalProperties: true
    properties:
      type: { const: task }
      title: { type: string }
implements:
  - contract: example.work-item
    version: 1.0.0
    fields:
      title: title
---
"#,
    )
    .unwrap();
    let created = registry
        .operation(
            collection.id,
            "create",
            &json!({
                "path": "task.md",
                "type": "task",
                "frontmatter": {"type": "task", "title": "Original"},
            }),
        )
        .unwrap();
    assert_eq!(created["valid"], true, "{created}");
    let revision = created["result"]["revision"]
        .as_str()
        .expect("create result has a revision")
        .to_string();
    let scope = work_item_scope(&registry, collection.id);
    let barrier = Arc::new(Barrier::new(3));

    let writers = ["First", "Second"].map(|title| {
        let registry = registry.clone();
        let barrier = barrier.clone();
        let scope = scope.clone();
        let revision = revision.clone();
        thread::spawn(move || {
            barrier.wait();
            registry
                .scoped_operation(
                    collection.id,
                    "update",
                    &json!({
                        "path": "task.md",
                        "patch": {"title": title},
                        "if_revision": revision,
                    }),
                    &scope,
                )
                .unwrap()
        })
    });
    barrier.wait();
    let results = writers.map(|writer| writer.join().unwrap());

    assert_eq!(
        results
            .iter()
            .filter(|result| result["valid"] == true)
            .count(),
        1
    );
    assert_eq!(
        results
            .iter()
            .filter(|result| result["valid"] == false)
            .count(),
        1
    );
    assert!(results.iter().any(|result| {
        result["diagnostics"].as_array().is_some_and(|diagnostics| {
            diagnostics
                .iter()
                .any(|diagnostic| diagnostic["code"] == "concurrent_modification")
        })
    }));
}

#[test]
fn full_collection_scope_lists_and_executes_saved_views() {
    let state = tempdir().unwrap();
    let collection_parent = tempdir().unwrap();
    let root = collection_parent.path().join("views");
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let collection = registry.create(&root, Some("Views")).unwrap();
    fs::write(
        root.join("_types/view.md"),
        r#"---
kind: mdbase.type
name: view
version: 1
schema:
  dialect: json-schema-2020-12
  value: { type: object }
---
"#,
    )
    .unwrap();
    fs::write(
        root.join("_types/task.md"),
        r#"---
kind: mdbase.type
name: task
version: 1
schema:
  dialect: json-schema-2020-12
  value: { type: object }
---
"#,
    )
    .unwrap();
    fs::create_dir_all(root.join("tasks")).unwrap();
    fs::create_dir_all(root.join("views")).unwrap();
    fs::write(
        root.join("tasks/one.md"),
        "---\ntype: task\ntitle: One\n---\n",
    )
    .unwrap();
    fs::write(
        root.join("views/tasks.md"),
        r#"---
type: view
id: task.views
version: 1
name: Task views
query:
  types: [task]
views:
  - id: all
    name: All tasks
    select: [title]
    presentation:
      type: example.list
---
"#,
    )
    .unwrap();

    let listed = registry
        .operation(collection.id, "list_views", &json!({}))
        .unwrap();
    assert_eq!(listed["valid"], true, "{listed}");
    assert_eq!(listed["result"]["meta"]["total_count"], 1);
    assert_eq!(listed["result"]["views"][0]["id"], "task.views");

    let executed = registry
        .operation(
            collection.id,
            "execute_view",
            &json!({ "path": "views/tasks.md", "view": "all" }),
        )
        .unwrap();
    assert_eq!(executed["valid"], true, "{executed}");
    assert_eq!(executed["result"]["meta"]["total_count"], 1);
    assert_eq!(executed["result"]["results"][0]["path"], "tasks/one.md");

    let source = registry
        .operation(
            collection.id,
            "read_view_source",
            &json!({ "path": "views/tasks.md" }),
        )
        .unwrap();
    let changed = source["result"]["document"]
        .as_str()
        .unwrap()
        .replace("All tasks", "Every task");
    let updated = registry
        .operation(
            collection.id,
            "update_view_source",
            &json!({
                "path": "views/tasks.md",
                "if_revision": source["result"]["revision"],
                "document": changed,
            }),
        )
        .unwrap();
    assert_eq!(updated["valid"], true, "{updated}");
    let listed = registry
        .operation(collection.id, "list_views", &json!({}))
        .unwrap();
    assert_eq!(
        listed["result"]["views"][0]["views"][0]["name"],
        "Every task"
    );
}

#[test]
fn change_pages_resume_by_cursor_and_omit_record_snapshots() {
    let state = tempdir().unwrap();
    let collection_parent = tempdir().unwrap();
    let root = collection_parent.path().join("notes");
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let collection = registry.create(&root, Some("Notes")).unwrap();
    let event = mdbase::watch::WatchEvent {
        event_type: "mdbase.record.modified".to_string(),
        sequence: 7,
        occurred_at: "2026-07-20T12:00:00.000Z".to_string(),
        payload: json!({
            "path": "note.md",
            "before": {"title": "Before"},
            "after": {"title": "After"},
            "changed_fields": ["title"],
            "revision": "sha256:after"
        }),
    };
    assert_eq!(registry.append_change(collection.id, &event).unwrap(), 1);

    let initial = registry.changes(collection.id, &json!({})).unwrap();
    assert!(initial.events.is_empty());
    assert_eq!(initial.cursor, 1);
    let page = registry
        .changes(collection.id, &json!({"after": 0}))
        .unwrap();
    assert_eq!(page.events.len(), 1);
    assert_eq!(page.events[0].payload["path"], "note.md");
    assert!(page.events[0].payload.get("before").is_none());
    assert!(page.events[0].payload.get("after").is_none());
    assert_eq!(page.cursor, 1);
}
