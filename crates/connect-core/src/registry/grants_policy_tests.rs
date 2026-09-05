use super::*;

fn declaration_evidence() -> serde_json::Value {
    serde_json::json!({
        "id": "dev.mdbase.fixture",
        "requirements": {
            "capabilities": {"contract_version": 2, "required": [], "optional": []},
            "configuration": []
        },
        "provisions": {"configuration": [], "type_packs": []},
        "unknown": {"preserve": [3, 1, 2]}
    })
}

#[test]
fn application_declaration_verified_summary_and_revoked_replay_roundtrip() {
    let directory = tempfile::tempdir().unwrap();
    let registry = CollectionRegistry::open(directory.path()).unwrap();
    let mut grant = super::super::tests::signed_test_grant(&registry, vec!["query".into()]);
    // Existing authorization-v4 test key, signing the complete Node-canonical evidence.
    grant
        .application_authorization
        .binding
        .application_manifest_digest =
        "492822461ec05e5383dd907e65b76ac68917d2c85e8de32a65f44317a3676b67".into();
    grant.application_authorization.signature =
        "9U6t2UIoZEAgE65Ih49geQ5RG6tZp50ckg32wfL5u1UTyRl7OPMW1QhCb9EUOkVklAawihmnEx3mFsJy-EE9-A"
            .into();
    grant.application_declaration = Some(declaration_evidence());
    registry.upsert_grant(&grant).unwrap();
    let identity = registry.grant_mutation_identity(grant.id).unwrap().unwrap();
    assert_eq!(
        registry.list_grants().unwrap()[0].application_declaration,
        grant.application_declaration
    );
    drop(registry);
    let registry = CollectionRegistry::open(directory.path()).unwrap();
    assert_eq!(
        registry
            .grant_context(grant.id)
            .unwrap()
            .unwrap()
            .application_declaration,
        grant.application_declaration
    );
    registry.replace_grants(&[]).unwrap();
    let replay = registry
        .grant_replay_context(grant.id, "key-1")
        .unwrap()
        .unwrap();
    assert!(replay.revoked);
    assert_eq!(
        replay.grant.application_declaration,
        grant.application_declaration
    );
    assert_eq!(replay.grant_snapshot_digest, identity.1);
}

#[test]
fn application_declaration_cache_roundtrips_without_changing_signed_authority() {
    let directory = tempfile::tempdir().unwrap();
    let registry = CollectionRegistry::open(directory.path()).unwrap();
    let mut grant = super::super::tests::signed_test_grant(&registry, vec!["query".into()]);
    let evidence = declaration_evidence();
    registry.upsert_grant(&grant).unwrap();
    let identity = registry.grant_mutation_identity(grant.id).unwrap();
    assert!(serde_json::to_value(&grant)
        .unwrap()
        .get("application_declaration")
        .is_none());
    grant.application_declaration = Some(evidence.clone());
    registry.upsert_grant(&grant).unwrap();
    assert_eq!(
        registry.grant_mutation_identity(grant.id).unwrap(),
        identity
    );
    let stored: String = registry
        .authority
        .connection()
        .unwrap()
        .query_row(
            "SELECT application_declaration FROM grants WHERE id = ?1",
            [grant.id.to_string()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&stored).unwrap(),
        evidence
    );
    // Mismatched evidence stays cached, but cannot become trusted summary/setup data.
    let summary = registry.grant_context(grant.id).unwrap().unwrap();
    assert!(summary.application_declaration.is_none());
    assert_eq!(summary.operations, grant.operations);
    assert!(serde_json::to_value(summary)
        .unwrap()
        .get("application_declaration")
        .is_none());
    let connector_id = grant.encryption.as_ref().unwrap().connector_id;
    let now = super::super::authority_store::current_time_ms();
    registry
        .replace_remote_grants_at_revision(
            connector_id,
            "with-evidence",
            1,
            now,
            now + 60_000,
            &[grant.clone()],
        )
        .unwrap();
    let expected = canonical_policy_authority_digest(connector_id, &[grant.clone()]).unwrap();
    assert_eq!(
        registry.remote_policy_authority().unwrap().authority_digest,
        Some(expected.clone())
    );
    drop(registry);
    let registry = CollectionRegistry::open(directory.path()).unwrap();
    assert_eq!(
        registry.remote_policy_authority().unwrap().authority_digest,
        Some(expected)
    );
    assert_eq!(
        registry.grant_mutation_identity(grant.id).unwrap(),
        identity
    );
    grant.application_declaration = None;
    registry.upsert_grant(&grant).unwrap();
    let stored: Option<String> = registry
        .authority
        .connection()
        .unwrap()
        .query_row(
            "SELECT application_declaration FROM grants WHERE id = ?1",
            [grant.id.to_string()],
            |row| row.get(0),
        )
        .unwrap();
    assert!(stored.is_none());
    let replay = registry
        .grant_replay_context(grant.id, "key-1")
        .unwrap()
        .unwrap();
    assert!(replay.grant.application_declaration.is_none());
}

#[test]
fn application_declaration_migration_upgrades_existing_authority_without_inventing_evidence() {
    let directory = tempfile::tempdir().unwrap();
    let registry = CollectionRegistry::open(directory.path()).unwrap();
    let grant = super::super::tests::signed_test_grant(&registry, vec!["query".into()]);
    registry.upsert_grant(&grant).unwrap();
    let identity = registry.grant_mutation_identity(grant.id).unwrap();
    drop(registry);
    let connection = Connection::open(directory.path().join("authority.sqlite")).unwrap();
    connection
        .execute_batch(
            "ALTER TABLE grants DROP COLUMN application_declaration;
         ALTER TABLE revoked_grant_replay_material DROP COLUMN application_declaration;
         DELETE FROM authority_schema_migrations WHERE version = 4;
         PRAGMA user_version = 3;",
        )
        .unwrap();
    drop(connection);
    for _ in 0..2 {
        let registry = CollectionRegistry::open(directory.path()).unwrap();
        assert_eq!(
            registry.grant_mutation_identity(grant.id).unwrap(),
            identity
        );
        let summary = registry.grant_context(grant.id).unwrap().unwrap();
        assert!(summary.application_declaration.is_none());
        assert_eq!(summary.operations, grant.operations);
    }
}

#[test]
fn application_declaration_summary_rejects_unverified_binding() {
    let directory = tempfile::tempdir().unwrap();
    let registry = CollectionRegistry::open(directory.path()).unwrap();
    let grant = super::super::tests::signed_test_grant(&registry, vec!["query".into()]);
    let mut proof = grant.application_authorization;
    proof.binding.application_manifest_digest = "0".repeat(64);
    assert!(authenticated_summary_declaration(&proof, Some("{}")).is_err());
}

#[test]
fn legacy_can_upgrade_to_lease_but_cannot_return_after_restart() {
    let directory = tempfile::tempdir().unwrap();
    let connector_id = Uuid::new_v4();
    {
        let registry = CollectionRegistry::open(directory.path()).unwrap();
        registry
            .replace_legacy_remote_grants_at_revision("legacy-one", &[])
            .unwrap();
        registry
            .replace_legacy_remote_grants_at_revision("legacy-two", &[])
            .unwrap();
        let authority = registry.remote_policy_authority().unwrap();
        assert_eq!(authority.mode, RemotePolicyAuthorityMode::LegacyAckV0);
        assert!(!authority.fresh);
        assert!(registry.remote_policy_is_usable().unwrap());
    }
    {
        let registry = CollectionRegistry::open(directory.path()).unwrap();
        let now = super::super::authority_store::current_time_ms();
        registry
            .replace_remote_grants_at_revision(connector_id, "lease", 1, now, now + 60_000, &[])
            .unwrap();
    }
    let registry = CollectionRegistry::open(directory.path()).unwrap();
    assert_eq!(
        registry.remote_policy_authority().unwrap().mode,
        RemotePolicyAuthorityMode::LeaseV1
    );
    assert!(registry
        .replace_legacy_remote_grants_at_revision("legacy-again", &[])
        .is_err());
}

#[test]
fn protocol_v1_fixture_round_trips_exact_grant_policy_and_digests() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../test-fixtures/protocol-v1-policy-canonical.json"
    ))
    .unwrap();
    assert_eq!(fixture["protocol_version"], 1);
    let wire_body = &fixture["normalized_wire_body"];
    let mut grants: Vec<GrantPolicy> = serde_json::from_value(wire_body["grants"].clone()).unwrap();
    assert_eq!(serde_json::to_value(&grants).unwrap(), wire_body["grants"]);
    grants.reverse();

    let connector_id: Uuid = serde_json::from_value(wire_body["connector_id"].clone()).unwrap();
    assert_eq!(
        canonical_policy_authority_digest(connector_id, &grants).unwrap(),
        fixture["authority_digest"].as_str().unwrap()
    );
    let mut normalized = grants;
    normalized.sort_by_key(|grant| grant.id);
    let reconstructed_wire = serde_json::json!({
        "connector_id": connector_id,
        "sequence": wire_body["sequence"],
        "lease_issued_at_ms": wire_body["lease_issued_at_ms"],
        "lease_expires_at_ms": wire_body["lease_expires_at_ms"],
        "grants": &normalized,
    });
    let reconstructed_authority = serde_json::json!({
        "connector_id": connector_id,
        "grants": &normalized,
    });
    assert_eq!(reconstructed_authority, fixture["authority_body"]);
    let canonical = String::from_utf8(serde_jcs::to_vec(&reconstructed_wire).unwrap()).unwrap();
    let authority_canonical =
        String::from_utf8(serde_jcs::to_vec(&reconstructed_authority).unwrap()).unwrap();
    assert_eq!(
        canonical,
        fixture["normalized_wire_canonical"].as_str().unwrap()
    );
    assert_eq!(
        authority_canonical,
        fixture["authority_canonical"].as_str().unwrap()
    );
    assert_eq!(
        format!("sha256:{:x}", Sha256::digest(canonical.as_bytes())),
        fixture["revision"].as_str().unwrap()
    );
    assert_eq!(
        fixture["revision"],
        "sha256:ccfe7bb1eb75acbec1abe0ee2e8a0c13f1d2be3e2cb47aa30cf6ba6bc3d982ea"
    );
    assert_eq!(
        fixture["authority_digest"],
        "sha256:141ae510bcd2582cc075046327940a622d68a87355e1f11fb7358bf5fe0803fd"
    );
}
