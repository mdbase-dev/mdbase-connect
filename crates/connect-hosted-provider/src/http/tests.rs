use super::*;

#[test]
fn fresh_application_setup_v2_accepts_only_explicit_v2_before_provider_access() {
    assert_eq!(
        ensure_fresh_application_setup_v2(&ApplicationRequirements::default())
            .unwrap_err()
            .code,
        "application_semantic_version_mismatch"
    );
    for version in [0, 1, 2, 3, u8::MAX] {
        let requirements: ApplicationRequirements = serde_json::from_value(json!({
            "capabilities": { "contract_version": version }
        }))
        .unwrap();
        let result = ensure_fresh_application_setup_v2(&requirements);
        if version == 2 {
            result.unwrap();
        } else {
            assert_eq!(
                result.unwrap_err().code,
                "application_semantic_version_mismatch"
            );
        }
    }
}

#[test]
fn internal_credentials_are_checked_by_digest() {
    let hash: [u8; 32] = Sha256::digest(b"a-long-test-token-that-is-over-32-characters").into();
    assert!(bool::from(hash.ct_eq(&hash)));
    let other: [u8; 32] = Sha256::digest(b"another-long-test-token-that-is-different").into();
    assert!(!bool::from(hash.ct_eq(&other)));
}
