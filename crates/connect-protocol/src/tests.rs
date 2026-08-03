use super::*;

fn fixture_application_security(
    application_id: Uuid,
    connector_id: Uuid,
) -> (FirstContactBinding, ApplicationAuthorizationProof) {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../packages/protocol/test/fixtures/application-authorization-v1.json"
    ))
    .unwrap();
    let mut proof = ApplicationAuthorizationProof {
        binding: serde_json::from_value(fixture["binding"].clone()).unwrap(),
        signature: "A".repeat(86),
    };
    proof.binding.application_id = application_id;
    let first_contact = FirstContactBinding {
        protocol_version: FIRST_CONTACT_PROTOCOL_VERSION,
        application_id,
        application_installation_id: proof.binding.application_installation_id,
        application_agreement_public_key: proof.binding.installation_agreement_public_key.clone(),
        application_signing_public_key: proof.binding.installation_signing_public_key.clone(),
        connector_id,
        connector_agreement_public_key: proof.binding.grant_signing_public_key.clone(),
    };
    (first_contact, proof)
}

fn protocol_schema() -> Value {
    serde_json::from_str(include_str!(
        "../../../packages/protocol/schemas/connect-protocol.v1.schema.json"
    ))
    .unwrap()
}

#[test]
fn file_materialization_defaults_to_metadata_only() {
    let policy = SelectiveSyncPolicy::default();
    assert!(policy.file_classes.is_empty());
    assert!(policy.excluded_folders.is_empty());
    assert!(!policy.includes(FileMediaClass::Image));

    let selected: SelectiveSyncPolicy = serde_json::from_value(serde_json::json!({
        "file_classes": ["image", "pdf"],
        "excluded_folders": ["Private"]
    }))
    .unwrap();
    assert!(selected.includes(FileMediaClass::Image));
    assert!(!selected.includes(FileMediaClass::Audio));
    assert!(
        serde_json::from_value::<SelectiveSyncPolicy>(serde_json::json!({
            "file_classes": [],
            "excluded_folders": [],
            "hidden": true
        }))
        .is_err()
    );
}

fn assert_schema(reference: &str, value: Value) {
    let mut schema = protocol_schema();
    if !reference.is_empty() {
        let object = schema.as_object_mut().unwrap();
        object.remove("oneOf");
        object.insert("$ref".to_string(), Value::String(format!("#{reference}")));
    }
    let file_schema: Value = serde_json::from_str(include_str!(
        "../../../packages/protocol/schemas/files.v1.schema.json"
    ))
    .unwrap();
    let mut options = jsonschema::JSONSchema::options();
    options
        .with_draft(jsonschema::Draft::Draft202012)
        .with_document(
            "https://mdbase.dev/connect/schemas/files.v1.json".to_string(),
            file_schema,
        );
    let validator = options.compile(&schema).unwrap();
    let errors = validator
        .validate(&value)
        .err()
        .map(|errors| errors.map(|error| error.to_string()).collect::<Vec<_>>())
        .unwrap_or_default();
    assert!(
        errors.is_empty(),
        "schema errors: {errors:#?}\nvalue: {value:#}"
    );
}

fn assert_encrypted_schema(value: Value) {
    let schema: Value = serde_json::from_str(include_str!(
        "../../../packages/protocol/schemas/encrypted-relay.v1.schema.json"
    ))
    .unwrap();
    let validator = jsonschema::JSONSchema::options()
        .with_draft(jsonschema::Draft::Draft202012)
        .compile(&schema)
        .unwrap();
    let errors = validator
        .validate(&value)
        .err()
        .map(|errors| errors.map(|error| error.to_string()).collect::<Vec<_>>())
        .unwrap_or_default();
    assert!(
        errors.is_empty(),
        "schema errors: {errors:#?}\nvalue: {value:#}"
    );
}

#[test]
fn generated_connect_problem_metadata_matches_the_wire_schema() {
    let definition = connect_problem_definition("collection_version_unsupported").unwrap();
    assert_eq!(definition.category, ConnectProblemCategory::Compatibility);
    assert_eq!(
        definition.recovery,
        ConnectRecoveryAction::UpgradeCollection
    );
    assert!(connect_problem_definition("future_problem").is_none());

    let schema: Value = serde_json::from_str(include_str!(
        "../../../packages/protocol/schemas/connect-problem.v1.schema.json"
    ))
    .unwrap();
    let validator = jsonschema::JSONSchema::options()
        .with_draft(jsonschema::Draft::Draft202012)
        .compile(&schema)
        .unwrap();
    let problem = ConnectProblem {
        problem_version: CONNECT_PROBLEM_VERSION,
        code: "collection_version_unsupported".to_string(),
        category: definition.category,
        recovery: definition.recovery,
        message: "This collection must be upgraded.".to_string(),
        details: Some(serde_json::json!({
            "current_version": "0.2.0",
            "required_version": "0.3.0"
        })),
        operation_outcome: Some(ConnectOperationOutcome::NotSent),
        trace_id: None,
        server_code: None,
    };
    let value = serde_json::to_value(problem).unwrap();
    let errors = validator
        .validate(&value)
        .err()
        .map(|errors| errors.map(|error| error.to_string()).collect::<Vec<_>>())
        .unwrap_or_default();
    assert!(errors.is_empty(), "schema errors: {errors:#?}");

    let future = ConnectProblem::new("future_problem", "A newer problem occurred.")
        .with_operation_outcome(ConnectOperationOutcome::Rejected);
    assert_eq!(future.code, "unknown");
    assert_eq!(future.server_code.as_deref(), Some("future_problem"));
    assert_eq!(future.category, ConnectProblemCategory::Unknown);
    assert_eq!(future.recovery, ConnectRecoveryAction::None);
}

fn assert_sync_schema(reference: &str, value: Value) {
    let mut schema: Value = serde_json::from_str(include_str!(
        "../../../packages/protocol/schemas/sync.v1.schema.json"
    ))
    .unwrap();
    if !reference.is_empty() {
        let object = schema.as_object_mut().unwrap();
        object.remove("oneOf");
        object.insert("$ref".to_string(), Value::String(format!("#{reference}")));
    }
    let file_schema: Value = serde_json::from_str(include_str!(
        "../../../packages/protocol/schemas/files.v1.schema.json"
    ))
    .unwrap();
    let mut options = jsonschema::JSONSchema::options();
    options
        .with_draft(jsonschema::Draft::Draft202012)
        .with_document(
            "https://mdbase.dev/connect/schemas/files.v1.json".to_string(),
            file_schema,
        );
    let validator = options.compile(&schema).unwrap();
    let errors = validator
        .validate(&value)
        .err()
        .map(|errors| errors.map(|error| error.to_string()).collect::<Vec<_>>())
        .unwrap_or_default();
    assert!(
        errors.is_empty(),
        "sync schema errors: {errors:#?}\nvalue: {value:#}"
    );
}

fn assert_file_schema(reference: &str, value: Value) {
    let mut schema: Value = serde_json::from_str(include_str!(
        "../../../packages/protocol/schemas/files.v1.schema.json"
    ))
    .unwrap();
    let object = schema.as_object_mut().unwrap();
    object.remove("oneOf");
    object.insert("$ref".to_string(), Value::String(format!("#{reference}")));
    let validator = jsonschema::JSONSchema::options()
        .with_draft(jsonschema::Draft::Draft202012)
        .compile(&schema)
        .unwrap();
    let errors = validator
        .validate(&value)
        .err()
        .map(|errors| errors.map(|error| error.to_string()).collect::<Vec<_>>())
        .unwrap_or_default();
    assert!(
        errors.is_empty(),
        "file schema errors: {errors:#?}\nvalue: {value:#}"
    );
}

#[test]
fn rust_file_messages_match_the_canonical_wire_schema() {
    let file = CollectionFileDescriptor {
        file_id: Uuid::parse_str("01911111-1111-7111-8111-111111111111").unwrap(),
        path: "Projects/Launch/diagram.png".to_string(),
        revision: "rev_01K0G8F8XRZ5CNE2X3MQBBSN8S".to_string(),
        content_digest: format!("sha256:{}", "ab".repeat(32)),
        size: 43_821,
        media_type: Some("image/png".to_string()),
        media_class: FileMediaClass::Image,
        modified_at: "2026-08-01T02:03:04Z".to_string(),
    };
    assert_file_schema(
        "/$defs/fileDescriptor",
        serde_json::to_value(&file).unwrap(),
    );

    let move_request = MoveFileRequest {
        protocol_version: FILE_PROTOCOL_VERSION,
        message_type: MoveFileRequestKind::MoveFile,
        mutation_id: Uuid::parse_str("01922222-2222-7222-8222-222222222222").unwrap(),
        file_id: file.file_id,
        if_revision: file.revision.clone(),
        from_path: file.path.clone(),
        path: "Projects/Launch/final.png".to_string(),
        update_references: false,
    };
    assert_file_schema(
        "/$defs/moveFileRequest",
        serde_json::to_value(move_request).unwrap(),
    );
    let delete_request = DeleteFileRequest {
        protocol_version: FILE_PROTOCOL_VERSION,
        message_type: DeleteFileRequestKind::DeleteFile,
        mutation_id: Uuid::parse_str("01933333-3333-7333-8333-333333333333").unwrap(),
        file_id: file.file_id,
        if_revision: file.revision.clone(),
        path: file.path.clone(),
    };
    assert_file_schema(
        "/$defs/deleteFileRequest",
        serde_json::to_value(delete_request).unwrap(),
    );

    let capability = FileCapability {
        kind: FileCapabilityKind::Files,
        protocol_version: FILE_PROTOCOL_VERSION,
        actions: vec![FileAction::List, FileAction::Read, FileAction::Add],
        scope: FileScope::SelectedFolders {
            folders: vec!["Assets".to_string(), "Project exports".to_string()],
        },
    };
    assert_file_schema(
        "/$defs/fileCapability",
        serde_json::to_value(capability).unwrap(),
    );

    let session = FileTransferSession {
        protocol_version: FILE_TRANSFER_PROTOCOL_VERSION,
        message_type: FileTransferSessionKind::FileTransfer,
        transfer_id: Uuid::parse_str("01922222-2222-7222-8222-222222222222").unwrap(),
        direction: FileTransferDirection::Upload,
        protection: FileTransferProtection::GrantAeadV1,
        strategy: FileTransferStrategy::FramedChunks {
            chunk_size: DEFAULT_FILE_CHUNK_BYTES,
        },
        total_size: 3_145_729,
        expires_at: "2026-08-01T02:13:04Z".to_string(),
        received: vec![0, 2],
        uploaded_parts: Vec::new(),
    };
    assert_file_schema(
        "/$defs/transferSession",
        serde_json::to_value(session).unwrap(),
    );

    let prepared_part = PreparedFilePart {
        protocol_version: FILE_TRANSFER_PROTOCOL_VERSION,
        message_type: PreparedFilePartKind::FilePart,
        transfer_id: Uuid::parse_str("01922222-2222-7222-8222-222222222222").unwrap(),
        part_index: 1,
        offset: 8 * 1024 * 1024,
        content_length: 123,
        method: "PUT".to_string(),
        url: "https://example.r2.cloudflarestorage.com/bucket/object?signature=opaque".to_string(),
        headers: BTreeMap::from([("content-length".to_string(), "123".to_string())]),
        expires_at: "2026-08-01T02:13:04Z".to_string(),
    };
    assert_file_schema(
        "/$defs/preparedPart",
        serde_json::to_value(prepared_part).unwrap(),
    );

    let receipt = CommitFileUploadReceipt {
        protocol_version: FILE_PROTOCOL_VERSION,
        message_type: CommitFileUploadReceiptKind::FileUploadCommitted,
        transfer_id: Uuid::parse_str("01922222-2222-7222-8222-222222222222").unwrap(),
        file: file.clone(),
    };
    assert_file_schema(
        "/$defs/commitUploadReceipt",
        serde_json::to_value(receipt).unwrap(),
    );
    assert_file_schema(
        "/$defs/moveFileReceipt",
        serde_json::to_value(MoveFileReceipt {
            protocol_version: FILE_PROTOCOL_VERSION,
            message_type: MoveFileReceiptKind::FileMoved,
            mutation_id: Uuid::parse_str("01922222-2222-7222-8222-222222222222").unwrap(),
            file: file.clone(),
        })
        .unwrap(),
    );
    assert_file_schema(
        "/$defs/deleteFileReceipt",
        serde_json::to_value(DeleteFileReceipt {
            protocol_version: FILE_PROTOCOL_VERSION,
            message_type: DeleteFileReceiptKind::FileDeleted,
            mutation_id: Uuid::parse_str("01933333-3333-7333-8333-333333333333").unwrap(),
            file_id: file.file_id,
            previous_path: file.path,
            revision: "file:deleted".to_string(),
        })
        .unwrap(),
    );
}

#[test]
fn control_request_has_stable_wire_shape() {
    let request = ControlRequest {
        id: Uuid::nil(),
        protocol_version: LOCAL_CONTROL_PROTOCOL_VERSION,
        command: ControlCommand::CollectionList,
    };
    assert_eq!(
        serde_json::to_value(request).unwrap(),
        serde_json::json!({
            "id": "00000000-0000-0000-0000-000000000000",
            "protocol_version": 2,
            "method": "collections.list"
        })
    );
}

#[test]
fn contract_setup_choices_have_an_explicit_discriminated_wire_shape() {
    let contract = ContractRequirement {
        id: "example.task".to_string(),
        version: "1.0.0".to_string(),
        digest: format!("sha256:{}", "0".repeat(64)),
    };
    let choices = [
        ContractSetupChoice {
            contract: contract.clone(),
            mode: ContractSetupMode::Starter,
        },
        ContractSetupChoice {
            contract,
            mode: ContractSetupMode::Existing {
                type_name: "task".to_string(),
                type_revision: format!("sha256:{}", "1".repeat(64)),
                fields: [("title".to_string(), "heading".to_string())]
                    .into_iter()
                    .collect(),
                binding: None,
            },
        },
    ];
    assert_eq!(
        serde_json::to_value(choices).unwrap(),
        serde_json::json!([
            {
                "contract": {
                    "id": "example.task",
                    "version": "1.0.0",
                    "digest": format!("sha256:{}", "0".repeat(64))
                },
                "mode": "starter"
            },
            {
                "contract": {
                    "id": "example.task",
                    "version": "1.0.0",
                    "digest": format!("sha256:{}", "0".repeat(64))
                },
                "mode": "existing",
                "type_name": "task",
                "type_revision": format!("sha256:{}", "1".repeat(64)),
                "fields": { "title": "heading" }
            }
        ])
    );
}

#[test]
fn copied_collection_registration_has_an_explicit_wire_command() {
    let request = ControlRequest {
        id: Uuid::nil(),
        protocol_version: LOCAL_CONTROL_PROTOCOL_VERSION,
        command: ControlCommand::CollectionAddCopy(CollectionPathParams {
            path: "/collections/notes-copy".to_string(),
        }),
    };
    assert_eq!(
        serde_json::to_value(request).unwrap(),
        serde_json::json!({
            "id": "00000000-0000-0000-0000-000000000000",
            "protocol_version": 2,
            "method": "collections.add-copy",
            "params": { "path": "/collections/notes-copy" }
        })
    );
}

#[test]
fn mirror_file_preferences_have_an_explicit_control_command() {
    let replica_id = Uuid::parse_str("01911111-1111-7111-8111-111111111111").unwrap();
    let request = ControlRequest {
        id: Uuid::nil(),
        protocol_version: LOCAL_CONTROL_PROTOCOL_VERSION,
        command: ControlCommand::MirrorConfigureSelectiveSync(MirrorConfigureSelectiveSyncParams {
            replica_id,
            selective_sync: SelectiveSyncPolicy {
                file_classes: vec![FileMediaClass::Image, FileMediaClass::Pdf],
                excluded_folders: vec!["Archive".to_string()],
            },
        }),
    };
    assert_eq!(
        serde_json::to_value(request).unwrap(),
        serde_json::json!({
            "id": "00000000-0000-0000-0000-000000000000",
            "protocol_version": 2,
            "method": "mirrors.configure-selective-sync",
            "params": {
                "replica_id": replica_id,
                "selective_sync": {
                    "file_classes": ["image", "pdf"],
                    "excluded_folders": ["Archive"]
                }
            }
        })
    );
}

#[test]
fn rust_relay_messages_match_the_canonical_wire_schema() {
    let ids = [
        Uuid::parse_str("01911111-1111-7111-8111-111111111111").unwrap(),
        Uuid::parse_str("01922222-2222-7222-8222-222222222222").unwrap(),
        Uuid::parse_str("01933333-3333-7333-8333-333333333333").unwrap(),
        Uuid::parse_str("01944444-4444-7444-8444-444444444444").unwrap(),
    ];
    let (first_contact, application_authorization) = fixture_application_security(ids[3], ids[2]);
    let encryption = GrantEncryption {
        protocol_version: ENCRYPTED_RELAY_PROTOCOL_VERSION,
        suite: RELAY_ENCRYPTION_SUITE.to_string(),
        key_id: "schema-key".to_string(),
        scope_epoch: 1,
        connector_id: ids[2],
        collection_id: ids[2],
        application_agreement_public_key: application_authorization
            .binding
            .grant_agreement_public_key
            .clone(),
        connector_agreement_public_key: first_contact.connector_agreement_public_key.clone(),
    };
    for message in [
        RelayMessage::RelayHello {
            protocol_version: CONTROL_PROTOCOL_VERSION,
            connector_version: "0.1.0-beta.27".to_string(),
            capabilities: RELAY_CAPABILITIES
                .iter()
                .map(|value| (*value).to_string())
                .collect(),
        },
        RelayMessage::RelayWelcome {
            protocol_version: CONTROL_PROTOCOL_VERSION,
            session_id: "42".to_string(),
            capabilities: RELAY_CAPABILITIES
                .iter()
                .map(|value| (*value).to_string())
                .collect(),
        },
        RelayMessage::RelayIncompatible {
            protocol_version: CONTROL_PROTOCOL_VERSION,
            code: "connector_upgrade_required".to_string(),
            message: "Update required.".to_string(),
            update_url: "https://github.com/mdbase-dev/mdbase-connect/releases/latest".to_string(),
        },
        RelayMessage::AuthorizationOfferRequest {
            protocol_version: CONTROL_PROTOCOL_VERSION,
            request_id: ids[0],
            authorization_id: ids[1],
            requirements: ApplicationRequirements::default(),
            provisions: ApplicationProvisions::default(),
        },
        RelayMessage::AuthorizationOfferResponse {
            protocol_version: CONTROL_PROTOCOL_VERSION,
            request_id: ids[0],
            paused: false,
            collections: vec![AuthorizationCollectionOffer {
                collection_id: ids[2],
                display_name: "My tasks".to_string(),
                spec_version: "0.3.0".to_string(),
                contracts: Vec::new(),
                types: Vec::new(),
            }],
        },
        RelayMessage::AuthorizationActivationResponse {
            protocol_version: CONTROL_PROTOCOL_VERSION,
            request_id: ids[0],
            ok: true,
            contracts: Vec::new(),
            contract_setups: Vec::new(),
            error: None,
        },
        RelayMessage::OperationRequest {
            protocol_version: CONTROL_PROTOCOL_VERSION,
            request_id: ids[0],
            grant_id: ids[1],
            collection_id: ids[2],
            application_id: ids[3],
            operation: "query".to_string(),
            input: serde_json::json!({"types": ["task"]}),
        },
        RelayMessage::OperationResponse {
            protocol_version: CONTROL_PROTOCOL_VERSION,
            request_id: ids[0],
            ok: true,
            result: Some(serde_json::json!({"valid": true})),
            problem: None,
        },
        RelayMessage::PolicySnapshot {
            protocol_version: CONTROL_PROTOCOL_VERSION,
            request_id: ids[0],
            revision: format!("sha256:{}", "0".repeat(64)),
            grants: vec![GrantPolicy {
                id: ids[1],
                application_id: ids[3],
                collection_id: ids[2],
                operations: vec!["query".to_string()],
                scope: GrantScope::full_collection(),
                application_name: "Tasks".to_string(),
                application_distribution: "web".to_string(),
                application_homepage: "https://tasks.example".to_string(),
                application_project_url: None,
                application_origin: "https://tasks.example".to_string(),
                application_icon: None,
                collection_name: "My tasks".to_string(),
                notification_criteria: Vec::new(),
                created_at: "2026-07-21T00:00:00Z".to_string(),
                encryption: Some(encryption),
                file_capability: Some(FileCapability {
                    kind: FileCapabilityKind::Files,
                    protocol_version: FILE_PROTOCOL_VERSION,
                    actions: vec![FileAction::List, FileAction::Read],
                    scope: FileScope::SelectedFolders {
                        folders: vec!["Assets".to_string()],
                    },
                }),
                first_contact,
                application_authorization,
            }],
        },
        RelayMessage::PolicyApplied {
            protocol_version: CONTROL_PROTOCOL_VERSION,
            request_id: ids[0],
            revision: format!("sha256:{}", "0".repeat(64)),
            ok: true,
            error: None,
        },
    ] {
        assert_schema("", serde_json::to_value(message).unwrap());
    }
}

#[test]
fn portable_policy_keeps_v1_and_the_exact_opaque_origin() {
    let ids = [
        Uuid::parse_str("01911111-1111-7111-8111-111111111111").unwrap(),
        Uuid::parse_str("01922222-2222-7222-8222-222222222222").unwrap(),
        Uuid::parse_str("01933333-3333-7333-8333-333333333333").unwrap(),
        Uuid::parse_str("01944444-4444-7444-8444-444444444444").unwrap(),
    ];
    let (first_contact, application_authorization) = fixture_application_security(ids[1], ids[3]);
    let message = RelayMessage::PolicySnapshot {
        protocol_version: CONTROL_PROTOCOL_VERSION,
        request_id: ids[3],
        revision: format!("sha256:{}", "0".repeat(64)),
        grants: vec![GrantPolicy {
            id: ids[0],
            application_id: ids[1],
            collection_id: ids[2],
            operations: vec!["query".to_string()],
            scope: GrantScope::full_collection(),
            application_name: "Portable notes".to_string(),
            application_distribution: "portable".to_string(),
            application_homepage: String::new(),
            application_project_url: Some("https://apps.example/portable".to_string()),
            application_origin: "null".to_string(),
            application_icon: None,
            collection_name: "Notes".to_string(),
            notification_criteria: Vec::new(),
            created_at: "2026-07-26T00:00:00Z".to_string(),
            encryption: Some(GrantEncryption {
                protocol_version: 1,
                suite: RELAY_ENCRYPTION_SUITE.to_string(),
                key_id: "portable-key".to_string(),
                scope_epoch: 1,
                connector_id: ids[3],
                collection_id: ids[2],
                application_agreement_public_key: "A".repeat(87),
                connector_agreement_public_key: "B".repeat(87),
            }),
            file_capability: None,
            first_contact,
            application_authorization,
        }],
    };
    assert_schema("", serde_json::to_value(message).unwrap());
}

#[test]
fn rust_encrypted_relay_messages_match_the_canonical_wire_schema() {
    let envelope = EncryptedRelayEnvelope {
        protocol_version: ENCRYPTED_RELAY_PROTOCOL_VERSION,
        suite: RELAY_ENCRYPTION_SUITE.to_string(),
        request_id: Uuid::parse_str("01911111-1111-7111-8111-111111111111").unwrap(),
        grant_id: Uuid::parse_str("01922222-2222-7222-8222-222222222222").unwrap(),
        application_id: Uuid::parse_str("01933333-3333-7333-8333-333333333333").unwrap(),
        connector_id: Uuid::parse_str("01944444-4444-7444-8444-444444444444").unwrap(),
        collection_id: Uuid::parse_str("01955555-5555-7555-8555-555555555555").unwrap(),
        operation: "query".to_string(),
        scope_epoch: 1,
        key_id: "enc_test".to_string(),
        counter: "1".to_string(),
        ciphertext: "opaque_ciphertext".to_string(),
    };
    assert_encrypted_schema(
        serde_json::to_value(RelayMessage::EncryptedOperationRequest {
            envelope: envelope.clone(),
        })
        .unwrap(),
    );
    assert_encrypted_schema(
        serde_json::to_value(RelayMessage::EncryptedOperationResponse { envelope }).unwrap(),
    );
}

#[test]
fn rust_collection_description_matches_the_addressable_schema() {
    let description = CollectionDescription {
        protocol_version: CONTROL_PROTOCOL_VERSION,
        collection_id: Uuid::parse_str("01933333-3333-7333-8333-333333333333").unwrap(),
        display_name: "Tasks".to_string(),
        spec_version: "0.3.0".to_string(),
        operations: vec!["describe".to_string(), "query".to_string()],
        change_cursor: 0,
        types: vec![],
        contracts: vec![],
        configuration: None,
    };
    assert_schema(
        "/$defs/collectionDescription",
        serde_json::to_value(description).unwrap(),
    );
}

#[test]
fn rust_sync_messages_match_the_canonical_wire_schema() {
    let collection_id = Uuid::parse_str("01911111-1111-7111-8111-111111111111").unwrap();
    let replica_id = Uuid::parse_str("01922222-2222-7222-8222-222222222222").unwrap();
    let session_id = Uuid::parse_str("01933333-3333-7333-8333-333333333333").unwrap();
    let snapshot_id = Uuid::parse_str("01944444-4444-7444-8444-444444444444").unwrap();
    let record_id = Uuid::parse_str("01955555-5555-7555-8555-555555555555").unwrap();
    let mutation_id = Uuid::parse_str("01966666-6666-7666-8666-666666666666").unwrap();
    let resources = SyncCollectionResources {
        revision: "resources:1".to_string(),
        spec_version: "0.3.0".to_string(),
        types: Vec::new(),
        contracts: Vec::new(),
        documents: Vec::new(),
    };
    let record = SyncRecord {
        record_id,
        path: "tasks/example.md".to_string(),
        revision: format!("sha256:{}", "2".repeat(64)),
        frontmatter: serde_json::Map::from_iter([
            ("type".to_string(), Value::String("task".to_string())),
            ("title".to_string(), Value::String("Example".to_string())),
        ]),
        body: "Body".to_string(),
        types: vec!["task".to_string()],
    };
    let mutation = SyncMutation {
        mutation_id,
        replica_id,
        scope_epoch: 1,
        operation: SyncMutationOperation::Update,
        record_id,
        base_revision: Some(record.revision.clone()),
        input: serde_json::Map::from_iter([(
            "patch".to_string(),
            serde_json::json!({"status": "done"}),
        )]),
        created_at: "2026-07-21T00:00:00Z".to_string(),
        causal_predecessor: None,
    };
    let file = CollectionFileDescriptor {
        file_id: Uuid::parse_str("01977777-7777-7777-8777-777777777777").unwrap(),
        path: "assets/example.png".to_string(),
        revision: "file:1".to_string(),
        content_digest: format!("sha256:{}", "3".repeat(64)),
        size: 12,
        media_type: Some("image/png".to_string()),
        media_class: FileMediaClass::Image,
        modified_at: "2026-07-21T00:00:00Z".to_string(),
    };
    let file_mutation = SyncFileMutation::FilePut {
        mutation_id: Uuid::parse_str("01988888-8888-7888-8888-888888888888").unwrap(),
        replica_id,
        scope_epoch: 1,
        file_id: file.file_id,
        base_revision: None,
        path: file.path.clone(),
        transfer_id: Uuid::parse_str("01999999-9999-7999-8999-999999999999").unwrap(),
        content_digest: file.content_digest.clone(),
        size: file.size,
        media_type: file.media_type.clone(),
        created_at: "2026-07-21T00:00:00Z".to_string(),
        causal_predecessor: None,
    };

    for (reference, value) in [
        (
            "/$defs/session",
            serde_json::to_value(SyncSession {
                protocol_version: SYNC_PROTOCOL_VERSION,
                session_id,
                replica_id,
                collection_id,
                mode: SyncReplicaMode::ReadWrite,
                scope_epoch: 1,
                retained_after: 0,
                head: 1,
                snapshot_id,
                resources: resources.clone(),
            })
            .unwrap(),
        ),
        (
            "/$defs/snapshotPage",
            serde_json::to_value(SyncSnapshotPage {
                protocol_version: SYNC_PROTOCOL_VERSION,
                snapshot_id,
                scope_epoch: 1,
                cursor: 1,
                records: vec![SyncSnapshotRecord {
                    record: record.clone(),
                    document: "---\ntitle: Task\n---\nDo it.\n".to_string(),
                }],
                next_page: None,
            })
            .unwrap(),
        ),
        (
            "/$defs/fileSnapshotPage",
            serde_json::to_value(SyncFileSnapshotPage {
                protocol_version: SYNC_PROTOCOL_VERSION,
                message_type: SyncFileSnapshotPageKind::FileSnapshotPage,
                snapshot_id,
                scope_epoch: 1,
                cursor: 1,
                files: vec![file.clone()],
                next_page: None,
            })
            .unwrap(),
        ),
        (
            "/$defs/changesPage",
            serde_json::to_value(SyncChangesPage {
                protocol_version: SYNC_PROTOCOL_VERSION,
                scope_epoch: 1,
                events: vec![
                    SyncChange::Put {
                        sequence: 1,
                        record: record.clone(),
                    },
                    SyncChange::FilePut {
                        sequence: 2,
                        file: file.clone(),
                    },
                ],
                cursor: 2,
                head: 2,
                has_more: false,
                reset_required: false,
            })
            .unwrap(),
        ),
        ("/$defs/mutation", serde_json::to_value(&mutation).unwrap()),
        (
            "/$defs/mutation",
            serde_json::to_value(&file_mutation).unwrap(),
        ),
        (
            "/$defs/receipt",
            serde_json::to_value(SyncMutationReceipt::Conflicted {
                mutation_id,
                conflict: SyncConflict {
                    record_id,
                    mutation,
                    current_revision: Some(record.revision.clone()),
                    current: Some(record),
                },
            })
            .unwrap(),
        ),
        (
            "/$defs/receipt",
            serde_json::to_value(SyncFileMutationReceipt::FileApplied {
                mutation_id: file_mutation.mutation_id(),
                sequence: 2,
                file: Some(file),
            })
            .unwrap(),
        ),
    ] {
        assert_sync_schema(reference, value);
    }
}
