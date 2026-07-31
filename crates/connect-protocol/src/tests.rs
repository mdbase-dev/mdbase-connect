use super::*;

fn protocol_schema() -> Value {
    serde_json::from_str(include_str!(
        "../../../packages/protocol/schemas/connect-protocol.v1.schema.json"
    ))
    .unwrap()
}

fn assert_schema(reference: &str, value: Value) {
    let mut schema = protocol_schema();
    if !reference.is_empty() {
        let object = schema.as_object_mut().unwrap();
        object.remove("oneOf");
        object.insert("$ref".to_string(), Value::String(format!("#{reference}")));
    }
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
        "sync schema errors: {errors:#?}\nvalue: {value:#}"
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
            "protocol_version": 1,
            "method": "collections.list"
        })
    );
}

#[test]
fn contract_setup_choices_have_an_explicit_discriminated_wire_shape() {
    let contract = ContractRequirement {
        id: "example.task".to_string(),
        version: "1.0.0".to_string(),
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
                "contract": { "id": "example.task", "version": "1.0.0" },
                "mode": "starter"
            },
            {
                "contract": { "id": "example.task", "version": "1.0.0" },
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
            "protocol_version": 1,
            "method": "collections.add-copy",
            "params": { "path": "/collections/notes-copy" }
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
    for message in [
        RelayMessage::RelayHello {
            protocol_version: CONTROL_PROTOCOL_VERSION,
            connector_version: "0.1.0-beta.21".to_string(),
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
            error: None,
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
                encryption: None,
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
            "/$defs/changesPage",
            serde_json::to_value(SyncChangesPage {
                protocol_version: SYNC_PROTOCOL_VERSION,
                scope_epoch: 1,
                events: vec![SyncChange::Put {
                    sequence: 1,
                    record: record.clone(),
                }],
                cursor: 1,
                head: 1,
                has_more: false,
                reset_required: false,
            })
            .unwrap(),
        ),
        ("/$defs/mutation", serde_json::to_value(&mutation).unwrap()),
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
    ] {
        assert_sync_schema(reference, value);
    }
}
