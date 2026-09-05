use super::*;
#[path = "../../tests/support/setup_evidence.rs"]
mod fixture;

#[test]
fn installed_setup_proof_binds_exact_policy_and_raw_projection() {
    let collection = Uuid::new_v4();
    let (evidence, input, key) = fixture::setup_evidence(collection);
    let policy = RegisterReplica {
        replica_id: Uuid::new_v4(),
        name: "setup".into(),
        purpose: ReplicaPurpose::Application,
        mode: SyncReplicaMode::ReadWrite,
        allowed_types: vec![],
        contract_scope: vec![],
        full_collection: true,
        allowed_operations: vec!["assess_collection_setup".into()],
        operation_transport_protocol: Some(3),
        operation_transport_recovery_protocols: vec![2],
        file_capability: None,
        allowed_origin: Some("null".into()),
        proof_public_key: Some(key),
        grant_id: Some(Uuid::new_v4()),
        application_declaration_id: Some("dev.mdbase.fixture".into()),
        application_declaration_digest: Some(input["declaration_digest"].as_str().unwrap().into()),
        application_setup_evidence: Some(evidence.clone()),
        token: "x".repeat(40),
        token_ttl_seconds: None,
    };
    validate_setup_evidence_policy(collection, &policy).unwrap(); // narrowed operation subset
    let verify = |policy: &RegisterReplica| {
        verified_setup_evidence(
            collection,
            policy.purpose,
            policy.proof_public_key.as_deref(),
            policy.application_declaration_id.as_deref(),
            policy.application_declaration_digest.as_deref(),
            policy.operation_transport_protocol,
            &policy.operation_transport_recovery_protocols,
            &policy.allowed_operations,
            policy.file_capability.as_ref(),
            policy.application_setup_evidence.as_ref().unwrap(),
        )
    };
    let verified = verify(&policy).unwrap();
    verified.validate_setup_input(&input).unwrap();
    for changed in [
        json!({"provisions": {"configuration":[], "type_packs":[]}}),
        json!({"unexpected":true}),
        json!({"setup":input}),
    ] {
        let mut altered = input.clone();
        altered
            .as_object_mut()
            .unwrap()
            .extend(changed.as_object().unwrap().clone());
        assert!(verified.validate_setup_input(&altered).is_err());
    }
    let mut altered = policy.clone();
    altered.proof_public_key = None;
    assert!(verify(&altered).is_err());
    altered = policy.clone();
    altered.application_declaration_id = Some("dev.mdbase.other".into());
    assert!(verify(&altered).is_err());
    altered = policy.clone();
    altered.operation_transport_recovery_protocols.clear();
    assert!(verify(&altered).is_err());
    altered = policy.clone();
    altered.allowed_operations.push("delete".into());
    assert!(verify(&altered).is_err());
    altered = policy.clone();
    altered.file_capability = Some(FileCapability {
        kind: mdbase_connect_protocol::FileCapabilityKind::Files,
        protocol_version: mdbase_connect_protocol::FILE_PROTOCOL_VERSION,
        actions: vec![mdbase_connect_protocol::FileAction::Read],
        scope: mdbase_connect_protocol::FileScope::Collection,
    });
    assert!(verify(&altered).is_err());
    for evidence in [
        Value::Null,
        json!({"application_declaration":evidence["application_declaration"]}),
        {
            let mut value = evidence.clone();
            value["application_authorization"]["signature"] = json!("tampered");
            value
        },
        {
            let mut value = evidence.clone();
            value["application_declaration"]["provisions"]["configuration"][0]["value"] =
                json!("tampered");
            value
        },
    ] {
        altered = policy.clone();
        altered.application_setup_evidence = Some(evidence);
        assert!(verify(&altered).is_err());
    }
    assert!(validate_setup_evidence_policy(Uuid::new_v4(), &policy).is_err());
}
