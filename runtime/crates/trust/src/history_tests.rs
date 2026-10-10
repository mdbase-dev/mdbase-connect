//! Identity-history fixtures only; no operational key generation/signing.
use super::*;
use mdbn_replica::crypto::sign::DeviceSigner;

fn base() -> Trust {
    let value: serde_json::Value =
        serde_json::from_str(include_str!("../tests/fixtures/next-trust.v1.json")).unwrap();
    let p = &value["payload"];
    let context = Context {
        sha256: hex_exact(value["sha256"].as_str().unwrap(), "fixture").unwrap(),
        environment: "lab".into(),
        control_plane_origin: p["control_plane_origin"].as_str().unwrap().into(),
        log_origin: p["log_origin"].as_str().unwrap().into(),
        source: serde_json::from_value(p["source"].clone()).unwrap(),
    };
    // Certificate expiry is 20000, but historical authentication still holds.
    verify(
        value["canonical_utf8"].as_str().unwrap().as_bytes(),
        &context,
        30000,
    )
    .unwrap()
}
fn canonical(trust: &mut Trust) {
    trust.policy_pins.roots.sort_by_key(|root| root.root_id);
    trust.policy_pins.policy_keys.sort_by_key(|key| key.key_id);
    trust.roots = trust
        .policy_pins
        .roots
        .iter()
        .map(|root| root.root_pk.0)
        .collect();
}
fn add_root(trust: &mut Trust) -> B16 {
    let pk = DeviceSigner::from_seed(&[0x43; 32]).public();
    let id = key_id(&pk);
    trust.policy_pins.roots.push(RootPin {
        root_id: id,
        root_pk: B32(pk),
    });
    canonical(trust);
    id
}
fn add_key(trust: &mut Trust, root_id: B16) {
    let pk = DeviceSigner::from_seed(&[0x44; 32]).public();
    trust.policy_pins.policy_keys.push(PolicyKeyPin {
        key_id: key_id(&pk),
        policy_pk: B32(pk),
        root_id,
    });
    canonical(trust);
}

#[test]
fn identical_history_including_expired_certification_is_retained() {
    let trust = base();
    assert_eq!(
        require_append_only(&trust, std::slice::from_ref(&trust)),
        Ok(())
    );
}
#[test]
fn new_keys_and_roots_are_append_only() {
    let previous = base();
    let mut current = previous.clone();
    let root = add_root(&mut current);
    add_key(&mut current, root);
    assert_eq!(require_append_only(&current, &[previous]), Ok(()));
}
#[test]
fn unused_historical_root_cannot_be_pruned() {
    let current = base();
    let mut previous = current.clone();
    add_root(&mut previous);
    assert!(
        require_append_only(&current, &[previous])
            .unwrap_err()
            .0
            .contains("historical root")
    );
}
#[test]
fn historical_key_cannot_be_pruned() {
    let current = base();
    let mut previous = current.clone();
    let root = previous.policy_pins.roots[0].root_id;
    add_key(&mut previous, root);
    assert!(
        require_append_only(&current, &[previous])
            .unwrap_err()
            .0
            .contains("historical policy tuple")
    );
}
#[test]
fn same_policy_key_cannot_change_its_certifying_root() {
    let mut previous = base();
    let other = add_root(&mut previous);
    let mut current = previous.clone();
    current.policy_pins.policy_keys[0].root_id = other;
    assert!(
        require_append_only(&current, &[previous])
            .unwrap_err()
            .0
            .contains("historical policy tuple")
    );
}
#[test]
fn changed_key_bytes_or_reused_ids_refuse() {
    let previous = base();
    let mut root_changed = previous.clone();
    root_changed.policy_pins.roots[0].root_pk = B32(DeviceSigner::from_seed(&[0x45; 32]).public());
    canonical(&mut root_changed);
    assert!(require_append_only(&root_changed, std::slice::from_ref(&previous)).is_err());
    let mut key_changed = previous.clone();
    key_changed.policy_pins.policy_keys[0].policy_pk =
        B32(DeviceSigner::from_seed(&[0x46; 32]).public());
    assert!(require_append_only(&key_changed, &[previous]).is_err());
}
#[test]
fn every_retained_asset_matters_not_just_the_latest() {
    let current = base();
    let latest = current.clone();
    let mut older = current.clone();
    let root = add_root(&mut older);
    add_key(&mut older, root);
    assert_eq!(
        require_append_only(&current, std::slice::from_ref(&latest)),
        Ok(())
    );
    assert!(require_append_only(&current, &[older, latest]).is_err());
}
#[test]
fn empty_or_oversized_history_never_bootstraps_or_truncates() {
    let current = base();
    assert!(require_append_only(&current, &[]).is_err());
    assert!(require_append_only(&current, &vec![current.clone(); MAX_HISTORY_ASSETS + 1]).is_err());
}
#[test]
fn environments_cannot_be_mixed() {
    let current = base();
    let mut previous = current.clone();
    previous.environment = "staging".into();
    assert!(require_append_only(&current, &[previous]).is_err());
}
#[test]
fn independently_authorized_origin_change_does_not_remove_pins() {
    let previous = base();
    let mut current = previous.clone();
    current.log_origin = "https://new-log.example.test".into();
    assert_eq!(require_append_only(&current, &[previous]), Ok(()));
}
#[test]
fn malformed_mirrored_roots_or_ordering_refuse() {
    let previous = base();
    let mut current = previous.clone();
    current.roots.clear();
    assert!(require_append_only(&current, std::slice::from_ref(&previous)).is_err());
    let mut current = previous.clone();
    add_root(&mut current);
    current.policy_pins.roots.reverse();
    current.roots.reverse();
    assert!(require_append_only(&current, &[previous]).is_err());
}
