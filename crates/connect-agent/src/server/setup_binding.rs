use super::*;

pub(super) fn validate_collection_setup_binding(
    input: &serde_json::Value,
    grant: &mdbase_connect_protocol::GrantSummary,
) -> Result<(), ConnectError> {
    // The registry authenticates these binding values from the exact grant proof.
    // V2 requires complete evidence: never fall back to caller-supplied labels.
    if grant.contracts.semantic_capabilities == 2 {
        let declaration = grant
            .application_declaration
            .as_ref()
            .ok_or_else(declaration_mismatch)?;
        return mdbase_connect_protocol::verify_application_setup_declaration_v2(
            declaration,
            &grant.application_declaration_id,
            &grant.application_manifest_digest,
        )
        .and_then(|verified| verified.validate_setup_input(input))
        .map_err(|_| declaration_mismatch());
    }

    // Keep legacy v1 binding semantics separate; unknown versions are not legacy.
    if grant.contracts.semantic_capabilities != 1 || input.get("setup").is_some() {
        return Err(declaration_mismatch());
    }
    let application_id = input["application_id"].as_str();
    let declaration_digest = input["declaration_digest"].as_str();
    if application_id != Some(grant.application_declaration_id.as_str())
        || declaration_digest
            != Some(format!("sha256:{}", grant.application_manifest_digest).as_str())
    {
        return Err(declaration_mismatch());
    }
    Ok(())
}

/// Activation is a separate pre-grant setup path. Verify the signed declaration
/// before its typed requirements/provisions can reach provisioning (including
/// contract requirements, which are outside the operation setup projection).
/// The caller must first validate the activation proof and connector binding.
pub(super) fn validate_activation_setup_binding(
    grant: &mdbase_connect_protocol::GrantPolicy,
    requirements: &mdbase_connect_protocol::ApplicationRequirements,
    provisions: &mdbase_connect_protocol::ApplicationProvisions,
) -> Result<(), ConnectError> {
    let binding = &grant.application_authorization.binding;
    if !requirements.valid_for_semantic_contract(binding.contracts.semantic_capabilities) {
        return Err(declaration_mismatch());
    }
    if binding.contracts.semantic_capabilities == 1 {
        return Ok(());
    }
    if binding.contracts.semantic_capabilities != 2 {
        return Err(declaration_mismatch());
    }
    let declaration = grant
        .application_declaration
        .as_ref()
        .ok_or_else(declaration_mismatch)?;
    mdbase_connect_protocol::verify_application_setup_declaration_v2(
        declaration,
        &binding.application_declaration_id,
        &binding.application_manifest_digest,
    )
    .map_err(|_| declaration_mismatch())?;
    let declared_requirements: mdbase_connect_protocol::ApplicationRequirements =
        serde_json::from_value(declaration["requirements"].clone())
            .map_err(|_| declaration_mismatch())?;
    let declared_provisions: mdbase_connect_protocol::ApplicationProvisions =
        serde_json::from_value(declaration["provisions"].clone())
            .map_err(|_| declaration_mismatch())?;
    if requirements != &declared_requirements || provisions != &declared_provisions {
        return Err(declaration_mismatch());
    }
    Ok(())
}

fn declaration_mismatch() -> ConnectError {
    ConnectError::ApplicationDeclarationMismatch(
        "Collection setup must use canonical top-level fields matching the exact application declaration bound to this grant."
            .to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use mdbase_connect_protocol::{ConnectContractRequirements, GrantScope, GrantSummary};
    use uuid::Uuid;

    // Same complete declaration and independently Node-generated digest as the
    // protocol's node_canonical_declaration_fixture; never rehash changed input.
    fn v2_fixture() -> (GrantSummary, serde_json::Value) {
        let declaration = serde_json::json!({
            "manifest_version": 1, "id": "dev.mdbase.fixture", "name": "Café 🦀",
            "distribution": "portable", "description": "e\u{301} ≠ é",
            "requirements": {
                "access": "full_collection", "contracts": [],
                "capabilities": {"contract_version": 2, "required": []},
                "configuration": [{"id":"tags", "path":"/x-fixture/tags", "predicate":"contains", "value":"é"}]
            },
            "provisions": {
                "configuration": [{"requirement":"tags", "operation":"set_add", "path":"/x-fixture/tags", "value":"é"}],
                "type_packs": []
            },
            "notifications": {"criteria": []}
        });
        let mut grant = legacy_grant();
        grant.contracts.semantic_capabilities = 2;
        grant.application_declaration_id = "dev.mdbase.fixture".to_string();
        grant.application_manifest_digest =
            "5a89bc3776758737e20c3606fc21c77bdfe8f3e795e6bd8c54233fc6ed2baaec".to_string();
        let input = serde_json::json!({
            "application_id": grant.application_declaration_id,
            "declaration_digest": format!("sha256:{}", grant.application_manifest_digest),
            "requirements": {"configuration": declaration["requirements"]["configuration"]},
            "provisions": declaration["provisions"]
        });
        grant.application_declaration = Some(declaration);
        (grant, input)
    }

    #[test]
    fn unknown_setup_contract_is_not_treated_as_legacy() {
        let (mut grant, input) = v2_fixture();
        grant.contracts.semantic_capabilities = 99;
        assert_eq!(
            validate_collection_setup_binding(&input, &grant)
                .unwrap_err()
                .code(),
            "application_declaration_mismatch"
        );
    }

    #[test]
    fn v2_local_dispatch_rejects_changed_setup_before_collection_side_effects() {
        let dir = tempfile::tempdir().unwrap();
        let registry = CollectionRegistry::open(dir.path().join("state")).unwrap();
        let root = dir.path().join("collection");
        let collection = registry
            .create(&root, Some("Setup binding"), "UTC")
            .unwrap();
        let watcher = CollectionWatchService::start(registry.clone());
        let state = AgentState::new(registry.clone(), watcher, None);
        let (mut grant, exact) = v2_fixture();
        grant.collection_id = collection.id;
        let before = std::fs::read(root.join("mdbase.yaml")).unwrap();
        let mut bad_inputs = Vec::new();
        for pointer in [
            "/requirements/configuration/0/value",
            "/provisions/configuration/0/value",
        ] {
            let mut changed = exact.clone();
            *changed.pointer_mut(pointer).unwrap() = serde_json::json!("unapproved");
            bad_inputs.push(changed);
        }
        let mut changed = exact.clone();
        changed["provisions"]["type_packs"] = serde_json::json!([{"manifest":{"id":"unapproved"}}]);
        bad_inputs.push(changed);
        let mut nested = exact.clone();
        nested["setup"] = exact.clone();
        bad_inputs.push(nested);
        let mut omitted = exact.clone();
        omitted.as_object_mut().unwrap().remove("requirements");
        bad_inputs.push(omitted);
        for operation in ["assess_collection_setup", "apply_collection_setup"] {
            for input in &bad_inputs {
                let error = state
                    .scoped_operation("test", collection.id, operation, input, &grant)
                    .unwrap_err();
                assert_eq!(
                    error.code(),
                    "application_declaration_mismatch",
                    "{operation}: {input}"
                );
            }
            let mut absent = grant.clone();
            absent.application_declaration = None;
            assert_eq!(
                state
                    .scoped_operation("test", collection.id, operation, &exact, &absent)
                    .unwrap_err()
                    .code(),
                "application_declaration_mismatch"
            );
            let mut tampered = grant.clone();
            tampered.application_declaration.as_mut().unwrap()["name"] =
                serde_json::json!("changed evidence");
            assert_eq!(
                state
                    .scoped_operation("test", collection.id, operation, &exact, &tampered)
                    .unwrap_err()
                    .code(),
                "application_declaration_mismatch"
            );
        }
        assert_eq!(std::fs::read(root.join("mdbase.yaml")).unwrap(), before);

        let assessment = state
            .scoped_operation(
                "test",
                collection.id,
                "assess_collection_setup",
                &exact,
                &grant,
            )
            .unwrap();
        assert_eq!(assessment["valid"], true, "{assessment}");
        let mut apply = exact.clone();
        for field in [
            "assessment_digest",
            "collection_revision",
            "provision_digest",
        ] {
            apply[format!("expected_{field}")] = assessment["result"][field].clone();
        }
        let applied = state
            .scoped_operation(
                "test",
                collection.id,
                "apply_collection_setup",
                &apply,
                &grant,
            )
            .unwrap();
        assert_eq!(applied["valid"], true, "{applied}");
        let config = std::fs::read_to_string(root.join("mdbase.yaml")).unwrap();
        assert!(config.contains("é"), "{config}");

        // Runtime input still reaches typed parsing and CAS rather than being
        // mistaken for declared content or silently dropped by the binding gate.
        for (operation, field) in [
            ("assess_collection_setup", "contract_setups"),
            ("assess_collection_setup", "type_pack_adoptions"),
            ("apply_collection_setup", "contract_setups"),
            ("apply_collection_setup", "type_pack_adoptions"),
            ("apply_collection_setup", "allow_type_pack_downgrades"),
        ] {
            let mut malformed = apply.clone();
            malformed[field] = serde_json::json!(false);
            assert_eq!(
                state
                    .scoped_operation("test", collection.id, operation, &malformed, &grant)
                    .unwrap_err()
                    .code(),
                "invalid_input",
                "{operation}: {field}"
            );
        }
        apply["expected_assessment_digest"] = serde_json::json!("stale");
        let stale = state
            .scoped_operation(
                "test",
                collection.id,
                "apply_collection_setup",
                &apply,
                &grant,
            )
            .unwrap();
        assert_eq!(stale["valid"], false, "{stale}");
    }

    #[tokio::test]
    async fn v2_initial_setup_issuance_is_denied_but_retained_policy_still_executes() {
        use base64::Engine;
        use p256::ecdsa::{signature::Signer, Signature, SigningKey};
        let dir = tempfile::tempdir().unwrap();
        let registry = CollectionRegistry::open(dir.path().join("state")).unwrap();
        let root = dir.path().join("collection");
        let collection = registry
            .create(&root, Some("Activation binding"), "UTC")
            .unwrap();
        let watcher = CollectionWatchService::start(registry.clone());
        let state = AgentState::new(registry.clone(), watcher, None);
        let (mut summary, _) = v2_fixture();
        summary.collection_id = collection.id;
        summary.application_distribution = "portable".to_string();
        let application = RelayIdentity::generate();
        let authorization_id = Uuid::new_v4();
        let mut proof = crate::test_support::application_security(
            crate::test_support::TestApplicationSecurityParams {
                application_id: summary.application_id,
                authorization_id,
                collection_id: collection.id,
                operations: &summary.operations,
                distribution: "portable",
                grant_agreement_public_key: application.public_key(),
                file_capability: None,
            },
        )
        .proof;
        // Sign the unchanged Node declaration's real digest, not a placeholder.
        let signing = SigningKey::random(&mut rand_core::OsRng);
        let encoding = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        proof.binding.installation_signing_public_key =
            encoding.encode(signing.verifying_key().to_encoded_point(false).as_bytes());
        proof.binding.application_installation_id =
            mdbase_connect_protocol::application_installation_id(
                &proof.binding.installation_signing_public_key,
            )
            .unwrap();
        proof.binding.application_declaration_id = summary.application_declaration_id.clone();
        proof.binding.application_manifest_digest = summary.application_manifest_digest.clone();
        proof.binding.contracts.semantic_capabilities = 2;
        let signature: Signature = signing.sign(&proof.binding.signing_message().unwrap());
        proof.signature = encoding.encode(signature.normalize_s().unwrap_or(signature).to_bytes());
        proof.verify().unwrap();
        summary.encryption = Some(mdbase_connect_protocol::GrantEncryption {
            protocol_version: mdbase_connect_protocol::GRANT_ENCRYPTION_PROTOCOL_VERSION,
            suite: mdbase_connect_protocol::RELAY_ENCRYPTION_SUITE.to_string(),
            key_id: "setup-activation".to_string(),
            scope_epoch: 1,
            connector_id: Uuid::new_v4(),
            collection_id: collection.id,
            application_agreement_public_key: application.public_key(),
            connector_agreement_public_key: state.relay_public_key(),
        });
        let mut policy = serde_json::to_value(&summary).unwrap();
        policy["application_authorization"] = serde_json::to_value(proof).unwrap();
        let grant: mdbase_connect_protocol::GrantPolicy = serde_json::from_value(policy).unwrap();
        grant.validate_application_security().unwrap();
        let declaration = summary.application_declaration.as_ref().unwrap();
        let requirements: mdbase_connect_protocol::ApplicationRequirements =
            serde_json::from_value(declaration["requirements"].clone()).unwrap();
        let provisions: mdbase_connect_protocol::ApplicationProvisions =
            serde_json::from_value(declaration["provisions"].clone()).unwrap();
        assert_eq!(
            state
                .ensure_application_types(
                    collection.id,
                    "bundle:dev.mdbase.fixture",
                    &summary.application_manifest_digest,
                    &requirements,
                    &provisions,
                    &[]
                )
                .await
                .unwrap_err()
                .code(),
            "application_declaration_mismatch"
        );
        let request = RelayMessage::AuthorizationActivationRequest {
            protocol_version: CONTROL_PROTOCOL_VERSION,
            request_id: Uuid::new_v4(),
            authorization_id,
            application_declaration_id: summary.application_declaration_id,
            application_manifest_digest: summary.application_manifest_digest,
            collection_id: collection.id,
            requirements,
            provisions,
            contract_setups: Vec::new(),
            grant: Box::new(grant.clone()),
        };
        let before = std::fs::read(root.join("mdbase.yaml")).unwrap();
        let types_before = registry.describe(collection.id).unwrap().types;
        for absent in [false, true] {
            let mut bad = request.clone();
            if let RelayMessage::AuthorizationActivationRequest {
                grant,
                requirements,
                provisions,
                ..
            } = &mut bad
            {
                if absent {
                    grant.application_declaration = None;
                } else {
                    provisions.configuration[0].value = serde_json::json!("unapproved");
                }
                // Retain the v2 security boundary assertion independently of
                // the earlier fresh-issuance gate on the activation path.
                assert_eq!(
                    validate_activation_setup_binding(grant, requirements, provisions)
                        .unwrap_err()
                        .code(),
                    "application_declaration_mismatch"
                );
            }
            let response = state.handle_relay_message(bad).unwrap();
            assert!(
                matches!(response, RelayMessage::AuthorizationActivationResponse { ok: false, error: Some(ControlError { ref code, ref message, .. }), .. } if code == "access_denied" && message.contains("issuance is unavailable")),
                "{response:?}"
            );
            assert_eq!(std::fs::read(root.join("mdbase.yaml")).unwrap(), before);
            assert!(registry.list_grants().unwrap().is_empty());
        }
        let assert_denied = || {
            let response = state.handle_relay_message(request.clone()).unwrap();
            assert!(
                matches!(response, RelayMessage::AuthorizationActivationResponse {
                ok: false, setup_assessment: None, provision_receipt: None,
                error: Some(ControlError { ref code, ref message, .. }), ..
            } if code == "access_denied" && message.contains("issuance is unavailable")),
                "{response:?}"
            );
            assert_eq!(std::fs::read(root.join("mdbase.yaml")).unwrap(), before);
            assert_eq!(
                serde_json::to_value(registry.describe(collection.id).unwrap().types).unwrap(),
                serde_json::to_value(&types_before).unwrap()
            );
        };
        assert_denied();
        assert!(registry.list_grants().unwrap().is_empty());

        // Authenticated, leased policy restore is not issuance, even with an
        // empty cache. Restored v2 authority keeps ordinary setup execution.
        let connector_id = grant.encryption.as_ref().unwrap().connector_id;
        let now = chrono::Utc::now().timestamp_millis();
        registry
            .replace_remote_grants_at_revision(
                connector_id,
                "retained-v2",
                1,
                now,
                now + 60_000,
                &[grant.clone()],
            )
            .unwrap();
        assert_denied(); // Existing installation does not bypass activation.
        let stored = registry.grant_context(grant.id).unwrap().unwrap();
        assert_eq!(stored.contracts.semantic_capabilities, 2);
        let (_, mut exact) = v2_fixture();
        let assessment = state
            .scoped_operation(
                "test",
                collection.id,
                "assess_collection_setup",
                &exact,
                &stored,
            )
            .unwrap();
        assert_eq!(assessment["valid"], true, "{assessment}");
        for field in [
            "assessment_digest",
            "collection_revision",
            "provision_digest",
        ] {
            exact[format!("expected_{field}")] = assessment["result"][field].clone();
        }
        let applied = state
            .scoped_operation(
                "test",
                collection.id,
                "apply_collection_setup",
                &exact,
                &stored,
            )
            .unwrap();
        assert_eq!(applied["valid"], true, "{applied}");
        assert!(std::fs::read_to_string(root.join("mdbase.yaml"))
            .unwrap()
            .contains("é"));
        registry
            .replace_remote_grants_at_revision(
                connector_id,
                "revoked-v2",
                2,
                now,
                now + 60_000,
                &[],
            )
            .unwrap();
        assert!(registry.grant_context(grant.id).unwrap().is_none());
    }

    fn legacy_grant() -> GrantSummary {
        GrantSummary {
            application_declaration: None,
            id: Uuid::new_v4(),
            application_id: Uuid::new_v4(),
            application_declaration_id: "dev.mdbase.tasks".to_string(),
            application_manifest_digest: "a".repeat(64),
            application_name: "Tasks".to_string(),
            application_distribution: "web".to_string(),
            application_homepage: "https://tasks.example".to_string(),
            application_project_url: None,
            application_origin: Some("https://tasks.example".to_string()),
            application_icon: None,
            collection_id: Uuid::new_v4(),
            collection_name: "Tasks".to_string(),
            operations: vec!["assess_collection_setup".to_string()],
            scope: GrantScope::full_collection(),
            notification_criteria: Vec::new(),
            created_at: "2026-08-23T00:00:00Z".to_string(),
            encryption: None,
            file_capability: None,
            contracts: ConnectContractRequirements {
                semantic_capabilities: 1,
                ..ConnectContractRequirements::current(false)
            },
        }
    }

    #[test]
    fn collection_setup_mismatch_uses_the_authorization_recovery_code() {
        let grant = legacy_grant();
        let exact = serde_json::json!({
            "application_id": "dev.mdbase.tasks",
            "declaration_digest": format!("sha256:{}", "a".repeat(64)),
        });
        validate_collection_setup_binding(&exact, &grant).unwrap();

        for ambiguous in [
            serde_json::json!({
                "application_id": "dev.mdbase.other",
                "declaration_digest": format!("sha256:{}", "b".repeat(64)),
                "setup": {
                    "application_id": "dev.mdbase.tasks",
                    "declaration_digest": format!("sha256:{}", "a".repeat(64)),
                }
            }),
            serde_json::json!({
                "application_id": "dev.mdbase.tasks",
                "declaration_digest": format!("sha256:{}", "a".repeat(64)),
                "setup": {
                    "application_id": "dev.mdbase.other",
                    "declaration_digest": format!("sha256:{}", "b".repeat(64)),
                }
            }),
        ] {
            assert_eq!(
                validate_collection_setup_binding(&ambiguous, &grant)
                    .unwrap_err()
                    .code(),
                "application_declaration_mismatch"
            );
        }

        for mismatch in [
            serde_json::json!({
                "application_id": "dev.mdbase.other",
                "declaration_digest": format!("sha256:{}", "a".repeat(64)),
            }),
            serde_json::json!({
                "application_id": "dev.mdbase.tasks",
                "declaration_digest": format!("sha256:{}", "b".repeat(64)),
            }),
        ] {
            assert_eq!(
                validate_collection_setup_binding(&mismatch, &grant)
                    .unwrap_err()
                    .code(),
                "application_declaration_mismatch"
            );
        }
    }
}
