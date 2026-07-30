use super::*;
use serde_json::Map;

#[test]
fn rollback_binaries_tolerate_newer_additive_migrations() {
    assert!(hosted_migrator().ignore_missing);
}

#[test]
fn authority_manifest_matches_the_node_promotion_fixture() {
    let entries = BTreeMap::from([
        (
            ("record".to_string(), "tasks/a.md".to_string()),
            (
                "01911111-1111-7111-8111-111111111111".to_string(),
                "00".repeat(32),
            ),
        ),
        (
            ("resource".to_string(), "mdbase.yaml".to_string()),
            (String::new(), "ff".repeat(32)),
        ),
    ]);
    assert_eq!(
        authority_manifest_digest_from_hashes(entries),
        "5f4d35b7381929c7a60d2c45ff310899d9b4c0d891a2ada573fb6dc10fc8c51a"
    );
}

#[test]
fn portable_imports_are_canonicalized_by_rust_including_first_class_resources() {
    let record_id = Uuid::new_v4();
    let configuration = "spec_version: 0.3.0\nsettings:\n  types_folder: _types\nx-obsidian:\n  bases:\n    include:\n      - views/**/*.base\n";
    let type_document = "---\nkind: mdbase.type\nname: task\nversion: 1\nmatch:\n  path_glob: tasks/**/*.md\nschema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\n    properties:\n      title:\n        type: string\n---\n\nTask\n";
    let contract_document = "---\nkind: mdbase.contract\ncontract_type: record\nid: example.task\nversion: 1.0.0\nrecord_schema:\n  dialect: json-schema-2020-12\n  ref: ../_schemas/task.json\n---\n";
    let schema_document =
        "{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"type\":\"object\"}\n";
    let record_document = "---\ntitle: One\n---\n\nBody\n";
    let workspace = WorkingSet::materialize(
        [
            ("mdbase.yaml".to_string(), configuration.to_string()),
            (
                "_contracts/task.md".to_string(),
                contract_document.to_string(),
            ),
            (
                "_schemas/task.json".to_string(),
                schema_document.to_string(),
            ),
            ("_types/task.md".to_string(), type_document.to_string()),
            ("views/tasks.base".to_string(), "views: []\n".to_string()),
        ],
        [StoredDocument {
            record_id,
            path: "tasks/one.md".to_string(),
            document: record_document.to_string(),
        }],
    )
    .unwrap();
    let canonical = workspace.snapshot().unwrap();
    let documents = canonical
        .resources
        .iter()
        .map(|resource| SyncResourceDocument {
            path: resource.path.clone(),
            kind: match resource.kind {
                mdbase::runtime::CollectionSnapshotResourceKind::Configuration => "configuration",
                mdbase::runtime::CollectionSnapshotResourceKind::Contract => "contract",
                mdbase::runtime::CollectionSnapshotResourceKind::Schema => "schema",
                mdbase::runtime::CollectionSnapshotResourceKind::Type => "type",
                mdbase::runtime::CollectionSnapshotResourceKind::View => "view",
            }
            .to_string(),
            revision: resource.revision.clone(),
            document: resource.document.clone(),
        })
        .collect();
    let manifest = AuthorityImportManifest {
        protocol_version: CONTROL_PROTOCOL_VERSION,
        collection_id: Uuid::new_v4(),
        source_head: 0,
        source_revision: canonical.revision,
        manifest_digest: "unused".to_string(),
        resources: SyncCollectionResources {
            revision: canonical.resource_revision,
            spec_version: canonical.spec_version,
            types: Vec::new(),
            contracts: Vec::new(),
            documents,
        },
        record_count: 1,
    };
    let records = canonicalize_imported_snapshot(
        &workspace,
        &manifest,
        &[AuthorityImportRecord {
            record_id,
            path: "tasks/one.md".to_string(),
            document: record_document.to_string(),
        }],
    )
    .unwrap();

    assert_eq!(records[0].record.record_id, record_id);
    assert_eq!(records[0].record.types, ["task"]);
    assert!(manifest
        .resources
        .documents
        .iter()
        .any(|resource| resource.kind == "view" && resource.path == "views/tasks.base"));
}

#[test]
fn deleted_record_events_use_the_portable_types_field() {
    let record = SyncRecord {
        record_id: Uuid::new_v4(),
        path: "tasks/deleted.md".to_string(),
        revision: "sha256:deleted".to_string(),
        frontmatter: Default::default(),
        body: String::new(),
        types: vec!["task".to_string()],
    };
    assert_eq!(
        application_change(Some(&record), None),
        (
            "mdbase.record.deleted",
            json!({
                "path": "tasks/deleted.md",
                "before": {},
                "previous_revision": "sha256:deleted",
                "types": ["task"]
            }),
        )
    );
}

#[test]
fn scopes_resources_and_records_consistently() {
    let resources = SyncCollectionResources {
        revision: "example:1".to_string(),
        spec_version: "0.3.0".to_string(),
        types: vec![mdbase_connect_protocol::CollectionTypeDescriptor {
            name: "task".to_string(),
            version: Some(1),
            description: Some("A generic work item.".to_string()),
            path: Some("_types/task.md".to_string()),
            definition: None,
            schema: json!({ "type": "object" }),
            collection: None,
            lifecycle: None,
            extensions: Map::new(),
        }],
        contracts: vec![CollectionContractDescriptor {
            contract_type: "record".to_string(),
            id: "example.work-item".to_string(),
            version: "1.0.0".to_string(),
            digest: format!("sha256:{}", "0".repeat(64)),
            schema: json!({ "type": "object" }),
            binding_schema: None,
            implementations: vec![
                mdbase_connect_protocol::CollectionContractImplementationDescriptor {
                    type_name: "task".to_string(),
                    type_version: 1,
                    type_path: Some("_types/task.md".to_string()),
                    digest: format!("sha256:{}", "1".repeat(64)),
                    fields: [("title".to_string(), "title".to_string())]
                        .into_iter()
                        .collect(),
                    binding: None,
                },
            ],
        }],
        documents: Vec::new(),
    };
    let scoped = scoped_resources(resources, &["other".to_string()]);
    assert!(scoped.types.is_empty());
    assert!(scoped.contracts.is_empty());
    let record = SyncRecord {
        record_id: Uuid::new_v4(),
        path: "tasks/one.md".to_string(),
        revision: "sha256:one".to_string(),
        frontmatter: Default::default(),
        body: String::new(),
        types: vec!["task".to_string()],
    };
    assert!(visible(&record, &[]));
    assert!(visible(&record, &["task".to_string()]));
    assert!(!visible(&record, &["other".to_string()]));
}

#[test]
fn applied_receipts_become_replays_without_changing_the_sequence() {
    let mutation_id = Uuid::new_v4();
    let receipt = previously_applied(SyncMutationReceipt::Applied {
        mutation_id,
        sequence: 9,
        record: None,
    });
    assert!(matches!(
        receipt,
        SyncMutationReceipt::PreviouslyApplied {
            mutation_id: id,
            sequence: 9,
            ..
        } if id == mutation_id
    ));
}

#[test]
fn application_capabilities_bind_operations_mode_and_origin() {
    let capability = RegisterReplica {
        replica_id: Uuid::new_v4(),
        name: "Tasks app".to_string(),
        purpose: ReplicaPurpose::Application,
        mode: SyncReplicaMode::ReadOnly,
        allowed_types: Vec::new(),
        contract_scope: Vec::new(),
        full_collection: true,
        allowed_operations: vec![
            "query".to_string(),
            "list_views".to_string(),
            "execute_view".to_string(),
        ],
        allowed_origin: Some("https://tasks.example".to_string()),
        proof_public_key: None,
        grant_id: Some(Uuid::new_v4()),
        token: "x".repeat(40),
        token_ttl_seconds: Some(3600),
    };
    validate_replica_capability(&capability).unwrap();
    let mut portable_capability = capability.clone();
    portable_capability.allowed_origin = Some("null".to_string());
    let signing_key = p256::ecdsa::SigningKey::random(&mut rand_core::OsRng);
    portable_capability.proof_public_key = Some(
        URL_SAFE_NO_PAD.encode(
            signing_key
                .verifying_key()
                .to_encoded_point(false)
                .as_bytes(),
        ),
    );
    validate_replica_capability(&portable_capability).unwrap();
    let mut proof_without_origin = portable_capability.clone();
    proof_without_origin.allowed_origin = None;
    assert_eq!(
        validate_replica_capability(&proof_without_origin)
            .unwrap_err()
            .code,
        "invalid_authority_proof_key"
    );
    let portable_replica = Replica {
        id: portable_capability.replica_id,
        purpose: portable_capability.purpose,
        mode: portable_capability.mode,
        allowed_types: portable_capability.allowed_types,
        contract_scope: portable_capability.contract_scope,
        full_collection: portable_capability.full_collection,
        allowed_operations: portable_capability.allowed_operations,
        allowed_origin: portable_capability.allowed_origin,
        proof_public_key: portable_capability.proof_public_key,
        grant_id: portable_capability.grant_id,
        scope_epoch: 1,
    };
    authorize_application_operation(&portable_replica, "query", Some("null")).unwrap();
    assert_eq!(
        authorize_application_operation(&portable_replica, "query", None)
            .unwrap_err()
            .code,
        "origin_denied"
    );
    assert_eq!(
        authorize_application_operation(&portable_replica, "query", Some("https://tasks.example"))
            .unwrap_err()
            .code,
        "origin_denied"
    );
    let mut missing_grant = capability.clone();
    missing_grant.grant_id = None;
    assert_eq!(
        validate_replica_capability(&missing_grant)
            .unwrap_err()
            .code,
        "invalid_application_capability"
    );
    let mut contract_capability = capability.clone();
    contract_capability.full_collection = false;
    assert_eq!(
        validate_replica_capability(&contract_capability)
            .unwrap_err()
            .code,
        "invalid_application_scope"
    );
    contract_capability.allowed_types = vec!["task".to_string()];
    contract_capability.allowed_operations = vec!["query".to_string()];
    contract_capability.contract_scope = vec![CollectionContractDescriptor {
        contract_type: "record".to_string(),
        id: "example.task".to_string(),
        version: "1.0.0".to_string(),
        digest: format!("sha256:{}", "0".repeat(64)),
        schema: json!({"type": "object"}),
        binding_schema: None,
        implementations: vec![
            mdbase_connect_protocol::CollectionContractImplementationDescriptor {
                type_name: "task".to_string(),
                type_version: 1,
                type_path: Some("_types/task.md".to_string()),
                digest: format!("sha256:{}", "1".repeat(64)),
                fields: BTreeMap::from([("title".to_string(), "summary".to_string())]),
                binding: None,
            },
        ],
    }];
    validate_replica_capability(&contract_capability).unwrap();
    let contract_replica = Replica {
        id: contract_capability.replica_id,
        purpose: contract_capability.purpose,
        mode: contract_capability.mode,
        allowed_types: contract_capability.allowed_types,
        contract_scope: contract_capability.contract_scope,
        full_collection: contract_capability.full_collection,
        allowed_operations: contract_capability.allowed_operations,
        allowed_origin: contract_capability.allowed_origin,
        proof_public_key: contract_capability.proof_public_key,
        grant_id: contract_capability.grant_id,
        scope_epoch: 1,
    };
    assert_eq!(
        authorize_sync_access(&contract_replica, "query", Some("https://tasks.example"))
            .unwrap_err()
            .code,
        "scope_denied"
    );
    let replica = Replica {
        id: capability.replica_id,
        purpose: capability.purpose,
        mode: capability.mode,
        allowed_types: capability.allowed_types,
        contract_scope: capability.contract_scope,
        full_collection: capability.full_collection,
        allowed_operations: capability.allowed_operations,
        allowed_origin: capability.allowed_origin,
        proof_public_key: capability.proof_public_key,
        grant_id: capability.grant_id,
        scope_epoch: 1,
    };
    authorize_application_operation(&replica, "query", Some("https://tasks.example")).unwrap();
    authorize_application_operation(&replica, "list_views", Some("https://tasks.example")).unwrap();
    authorize_application_operation(&replica, "execute_view", Some("https://tasks.example"))
        .unwrap();
    assert_eq!(
        authorize_application_operation(&replica, "create", None)
            .unwrap_err()
            .code,
        "insufficient_access"
    );
    assert_eq!(
        authorize_application_operation(&replica, "query", Some("https://evil.example"))
            .unwrap_err()
            .code,
        "origin_denied"
    );
    authorize_sync_access(&replica, "query", Some("https://tasks.example")).unwrap();
    assert_eq!(
        authorize_sync_access(&replica, "changes", Some("https://tasks.example"))
            .unwrap_err()
            .code,
        "insufficient_access"
    );
    assert_eq!(
        authorize_sync_access(&replica, "query", Some("https://evil.example"))
            .unwrap_err()
            .code,
        "origin_denied"
    );
}

#[test]
fn authority_request_proofs_bind_the_body_credential_and_timestamp() {
    use p256::ecdsa::{signature::Signer, SigningKey};

    let signing_key = SigningKey::random(&mut rand_core::OsRng);
    let public_key = URL_SAFE_NO_PAD.encode(
        signing_key
            .verifying_key()
            .to_encoded_point(false)
            .as_bytes(),
    );
    let mut proof = AuthorityRequestProof {
        version: AUTHORITY_PROOF_VERSION,
        timestamp: Utc::now().timestamp(),
        nonce: Uuid::new_v4(),
        signature: String::new(),
        method: "POST".to_string(),
        target: "/v1/authorities/example/operations/create".to_string(),
        body: br#"{"title":"proof"}"#.to_vec(),
    };
    let signature: Signature =
        signing_key.sign(authority_proof_message("hsa_secret", &proof).as_bytes());
    proof.signature = URL_SAFE_NO_PAD.encode(signature.to_bytes());
    verify_hosted_request_proof(&public_key, "hsa_secret", &proof).unwrap();

    proof.body = br#"{"title":"tampered"}"#.to_vec();
    assert_eq!(
        verify_hosted_request_proof(&public_key, "hsa_secret", &proof)
            .unwrap_err()
            .code,
        "invalid_authority_proof"
    );
    proof.body = br#"{"title":"proof"}"#.to_vec();
    assert_eq!(
        verify_hosted_request_proof(&public_key, "hsa_other", &proof)
            .unwrap_err()
            .code,
        "invalid_authority_proof"
    );
    proof.timestamp -= 301;
    assert_eq!(
        verify_hosted_request_proof(&public_key, "hsa_secret", &proof)
            .unwrap_err()
            .code,
        "invalid_authority_proof"
    );
}

#[test]
fn mirror_sync_credentials_are_not_browser_capabilities() {
    let replica = Replica {
        id: Uuid::new_v4(),
        purpose: ReplicaPurpose::Mirror,
        mode: SyncReplicaMode::ReadOnly,
        allowed_types: Vec::new(),
        contract_scope: Vec::new(),
        full_collection: false,
        allowed_operations: Vec::new(),
        allowed_origin: None,
        proof_public_key: None,
        grant_id: None,
        scope_epoch: 1,
    };
    authorize_sync_access(&replica, "read", None).unwrap();
    assert_eq!(
        authorize_sync_access(&replica, "read", Some("https://tasks.example"))
            .unwrap_err()
            .code,
        "origin_denied"
    );
}

#[test]
fn sync_mutations_use_their_matching_application_permission() {
    assert_eq!(
        mutation_operation_name(SyncMutationOperation::Create),
        "create"
    );
    assert_eq!(
        mutation_operation_name(SyncMutationOperation::Update),
        "update"
    );
    assert_eq!(
        mutation_operation_name(SyncMutationOperation::Rename),
        "rename"
    );
    assert_eq!(
        mutation_operation_name(SyncMutationOperation::Delete),
        "delete"
    );
}

#[test]
fn rejects_write_operations_on_read_only_application_capabilities() {
    let capability = RegisterReplica {
        replica_id: Uuid::new_v4(),
        name: "Tasks app".to_string(),
        purpose: ReplicaPurpose::Application,
        mode: SyncReplicaMode::ReadOnly,
        allowed_types: vec!["task".to_string()],
        contract_scope: Vec::new(),
        full_collection: false,
        allowed_operations: vec!["create".to_string()],
        allowed_origin: Some("https://tasks.example".to_string()),
        proof_public_key: None,
        grant_id: Some(Uuid::new_v4()),
        token: "x".repeat(40),
        token_ttl_seconds: Some(3600),
    };
    assert_eq!(
        validate_replica_capability(&capability).unwrap_err().code,
        "invalid_application_capability"
    );
}
