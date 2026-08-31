use super::*;

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
