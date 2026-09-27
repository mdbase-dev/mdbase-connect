use super::*;
use serde_json::json;

#[test]
fn people_consent_roundtrips_without_expanding_legacy_authority() {
    let input = json!({
        "contracts": [], "configuration": [],
        "capabilities": {"contract_version":2,"required":["collection.read"]},
        "people": {"version":1,"required":["identity"],"optional":["members"]}
    });
    let requirements: ApplicationRequirements = serde_json::from_value(input.clone()).unwrap();
    assert!(requirements.valid_for_semantic_contract(2));
    assert!(!requirements.valid_for_semantic_contract(1));
    assert_eq!(serde_json::to_value(requirements).unwrap(), input);
    let mut optional_only = input.clone();
    optional_only["people"] = json!({"version":1,"optional":["identity","members"]});
    let requirements: ApplicationRequirements = serde_json::from_value(optional_only).unwrap();
    assert!(requirements.valid_for_semantic_contract(2));
    for people in [
        json!({"version":1}),
        json!({"version":2,"required":["identity"]}),
        json!({"version":1,"required":[]}),
        json!({"version":1,"required":["identity"],"optional":[]}),
        json!({"version":1,"required":["identity","identity"]}),
        json!({"version":1,"required":["identity"],"optional":["identity"]}),
        json!({"version":1,"optional":["emails"]}),
    ] {
        let mut invalid = input.clone();
        invalid["people"] = people;
        let requirements: ApplicationRequirements = serde_json::from_value(invalid).unwrap();
        assert!(!requirements.valid_for_semantic_contract(2));
    }
    let mut unknown = input.clone();
    unknown["people"] = json!({"version":1,"permissions":["identity"]});
    assert!(serde_json::from_value::<ApplicationRequirements>(unknown).is_err());
}

#[test]
fn fresh_issuance_advertisement_matches_artifact_policy_not_retained_readers() {
    assert_eq!(
        FRESH_APPLICATION_AUTHORIZATION_CAPABILITIES
            .contains(&APPLICATION_AUTHORIZATION_V2_ISSUANCE_CAPABILITY),
        permits_fresh_application_authorization(2)
    );
    assert!(ConnectContractSupport::default()
        .semantic_capabilities
        .contains(&2));
    assert!(FRESH_APPLICATION_AUTHORIZATION_CAPABILITIES
        .iter()
        .all(|capability| *capability == APPLICATION_AUTHORIZATION_V2_ISSUANCE_CAPABILITY));
}

#[test]
fn file_declaration_versions_roundtrip_without_synthesizing_legacy_fields() {
    for (version, files) in [
        (
            1,
            json!({"actions": ["read"], "scope": {"kind":"collection"}}),
        ),
        (
            2,
            json!({"required": [], "optional": ["read"], "scope": {"kind":"collection"}}),
        ),
        (
            2,
            json!({"required": ["read"], "scope": {"kind":"collection"}}),
        ),
    ] {
        let input = json!({
            "contracts": [], "configuration": [],
            "capabilities": {"contract_version":version, "required": []},
            "files": files
        });
        let requirements: ApplicationRequirements = serde_json::from_value(input.clone()).unwrap();
        assert!(requirements.valid_for_semantic_contract(version));
        assert!(!requirements.valid_for_semantic_contract(3 - version));
        assert_eq!(serde_json::to_value(&requirements).unwrap(), input);
        assert_eq!(
            serde_jcs::to_vec(&requirements).unwrap(),
            serde_jcs::to_vec(&input).unwrap()
        );
    }
    let legacy = json!({"contracts": [], "configuration": []});
    let requirements: ApplicationRequirements = serde_json::from_value(legacy.clone()).unwrap();
    assert!(requirements.valid_for_semantic_contract(1));
    assert!(!requirements.valid_for_semantic_contract(2));
    assert_eq!(serde_json::to_value(requirements).unwrap(), legacy);
}

#[test]
fn malformed_file_declarations_never_fall_back_to_legacy() {
    for fields in [
        json!({}),
        json!({"optional": ["read"]}),
        json!({"actions": ["read"], "required": []}),
        json!({"actions": ["read"], "optional": []}),
        json!({"actions": ["read"], "required": null}),
        json!({"actions": ["read"], "future": true}),
        json!({"required": [], "optional": null}),
        json!({"required": [], "future": true}),
        json!({"actions": ["unknown"]}),
    ] {
        let mut input = fields;
        input["scope"] = json!({"kind":"collection"});
        assert!(
            serde_json::from_value::<ApplicationFileRequirement>(input.clone()).is_err(),
            "{input}"
        );
    }
}

#[test]
fn capability_ids_dispatch_to_exact_catalog_without_aliases() {
    for (version, valid_id, invalid_id) in [
        (1, "records.update", "records.edit"),
        (2, "records.edit", "records.update"),
    ] {
        let mut requirements: ApplicationRequirements = serde_json::from_value(json!({
            "capabilities": {"contract_version": version, "required": [valid_id]}
        }))
        .unwrap();
        assert!(requirements.valid_for_semantic_contract(version));
        assert!(!requirements.valid_for_semantic_contract(99));
        assert_eq!(
            serde_json::to_value(&requirements).unwrap()["capabilities"]["required"],
            json!([valid_id])
        );
        requirements.capabilities.as_mut().unwrap().required = vec![invalid_id.into()];
        assert!(!requirements.valid_for_semantic_contract(version));
        requirements.capabilities.as_mut().unwrap().required = vec![valid_id.into()];
        requirements.capabilities.as_mut().unwrap().optional = vec![valid_id.into()];
        assert!(!requirements.valid_for_semantic_contract(version));
    }
    assert_eq!(
        application_capability_operations_for_contract_version(1, "records.update"),
        Some(["update"].as_slice())
    );
    assert_eq!(
        application_capability_operations_for_contract_version(2, "records.edit"),
        Some(["update", "rename"].as_slice())
    );
    assert_eq!(
        application_capability_operations_for_contract_version(99, "records.edit"),
        None
    );
}
