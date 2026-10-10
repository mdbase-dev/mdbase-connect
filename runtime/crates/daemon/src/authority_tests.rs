use super::*;
use crate::access::CachedGrant;
use crate::registry::Origin;

const ALICE: &str = "11111111-1111-4111-8111-111111111111";
const BOB: &str = "22222222-2222-4222-8222-222222222222";
const DEVICE: &str = "33333333-3333-4333-8333-333333333333";
const COLLECTION: &str = "44444444-4444-4444-8444-444444444444";
const GRANT: &str = "55555555-5555-4555-8555-555555555555";

fn fence(epoch: u64, account: Option<&str>) -> (AccountRecord, CloudConfig) {
    (
        AccountRecord {
            schema_version: 1,
            epoch,
            signed_in: true,
            connector_id: Some("connector".into()),
            account_id: account.map(str::to_string),
        },
        CloudConfig {
            schema_version: 1,
            account_epoch: epoch,
            connector_id: Some("connector".into()),
            ..Default::default()
        },
    )
}
fn registration() -> Entry {
    Entry {
        id: COLLECTION.into(),
        name: "test".into(),
        root: "/test".into(),
        replica_id: GRANT.into(),
        mode: SyncMode::Local,
        origin: Origin::Created,
        added_at_ms: 0,
        paused: false,
        ever_e2e: false,
        owner_account: Some(ALICE.into()),
        device: Some(DEVICE.into()),
    }
}
fn registry(entry: Entry) -> Registry {
    Registry {
        collections: vec![entry],
        ..Default::default()
    }
}
fn fixture() -> (Authority, CollectionAuthority, AccessList) {
    let authority = Authority::default();
    let (record, config) = fence(1, Some(ALICE));
    authority
        .publish_account(&record, &config, account_id(DEVICE).unwrap())
        .unwrap();
    authority.publish_registry(&registry(registration()));
    let cached = CachedGrant {
        grant: GRANT.into(),
        account_id: Some(ALICE.into()),
        collection: COLLECTION.into(),
        app_id: "test-app".into(),
        app_name: "test".into(),
        client_pk: crate::secrets::hex(&[7; 32]),
        capabilities: vec![capability::READ.into()],
        folders: Some(vec!["Photos".into()]),
        legacy_only: false,
    };
    let mut access = AccessList::default();
    let now = crate::fsutil::now_ms() as u64;
    access.sync_from_control_plane(COLLECTION, &[cached], now, now + 60_000);
    authority.publish_access(&access);
    let source = authority.source(account_id(COLLECTION).unwrap()).unwrap();
    (authority, source, access)
}

#[test]
fn missing_invalid_service_and_old_fences_deny_without_inference() {
    for value in [
        None,
        Some(""),
        Some("SERVICE_ACCOUNT"),
        Some("00000000-0000-0000-0000-000000000000"),
        Some("AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"),
    ] {
        let authority = Authority::default();
        let (record, config) = fence(1, value);
        assert!(!record.permits(&config));
        assert_eq!(record.active_account(), None);
        assert_eq!(
            authority.publish_account(&record, &config, account_id(DEVICE).unwrap()),
            Err(Deny::AccountMissing)
        );
        assert!(authority.source(account_id(COLLECTION).unwrap()).is_err());
    }
}

#[test]
fn registry_account_device_and_collection_must_match_and_missing_never_backfills() {
    let (authority, source, _) = fixture();
    assert_eq!(source.authorize(None), Ok(Role::Owner));
    for entry in [
        Entry {
            owner_account: None,
            ..registration()
        },
        Entry {
            owner_account: Some(BOB.into()),
            ..registration()
        },
        Entry {
            device: None,
            ..registration()
        },
        Entry {
            device: Some(BOB.into()),
            ..registration()
        },
        Entry {
            id: BOB.into(),
            ..registration()
        },
    ] {
        authority.publish_registry(&registry(entry));
        assert_eq!(source.authorize(None), Err(Deny::RegistrationMismatch));
        assert!(source.owner_identity().is_none());
        assert!(source.grant(&account_id(GRANT).unwrap()).is_none());
    }
}

#[test]
fn grants_require_independent_account_consent_and_never_gain_owner() {
    let (authority, source, mut access) = fixture();
    let id = account_id(GRANT).unwrap();
    let granted = source.grant(&id).unwrap();
    assert_eq!(granted.account, account_id(ALICE).unwrap());
    assert_eq!(granted.role, Role::Viewer);
    assert_eq!(granted.file_folders, Some(vec!["Photos".into()]));
    for account in [
        None,
        Some(BOB.into()),
        Some("00000000-0000-0000-0000-000000000000".into()),
    ] {
        access.entries[0].grant.account_id = account;
        authority.publish_access(&access);
        assert!(source.grant(&id).is_none());
    }
    access.entries[0].grant.account_id = Some(ALICE.into());
    access.entries[0]
        .grant
        .capabilities
        .push(capability::EDIT.into());
    authority.publish_access(&access);
    assert_eq!(source.grant(&id).unwrap().role, Role::Editor);
    access.revoke(GRANT).unwrap();
    authority.publish_access(&access);
    assert!(source.grant(&id).is_none());
}

#[test]
fn monotonic_expiry_and_reopen_drop_grants_even_with_future_wall_deadline() {
    let (authority, source, mut access) = fixture();
    let id = account_id(GRANT).unwrap();
    access
        .monotonic_leases
        .insert(COLLECTION.into(), std::time::Instant::now());
    authority.publish_access(&access);
    assert!(source.grant(&id).is_none());
    let dir = crate::testutil::TestDir::new("authority-reopen");
    let file = dir.path().join("access.json");
    access.save(&file).unwrap();
    let reopened = AccessList::load(&file).unwrap();
    assert!(reopened.monotonic_leases.is_empty());
    assert_eq!(reopened.entries[0].grant.account_id.as_deref(), Some(ALICE));
    authority.publish_access(&reopened);
    assert!(source.grant(&id).is_none());
}

#[test]
fn logout_and_same_account_repair_never_revive_old_source() {
    let (authority, old, access) = fixture();
    authority.invalidate(2);
    assert_eq!(old.active_account(), None);
    assert_eq!(old.authorize(None), Err(Deny::AccountMissing));
    assert!(old.grant(&account_id(GRANT).unwrap()).is_none());
    let (record, config) = fence(3, Some(ALICE));
    authority
        .publish_account(&record, &config, account_id(DEVICE).unwrap())
        .unwrap();
    authority.publish_access(&access);
    assert_eq!(old.active_account(), None);
    assert!(old.grant(&account_id(GRANT).unwrap()).is_none());
    let fresh = authority.source(account_id(COLLECTION).unwrap()).unwrap();
    assert!(fresh.grant(&account_id(GRANT).unwrap()).is_some());
    let (record, config) = fence(1, Some(BOB));
    assert_eq!(
        authority.publish_account(&record, &config, account_id(DEVICE).unwrap()),
        Err(Deny::AccountMissing)
    );
    assert_eq!(fresh.active_account(), account_id(ALICE));
    let (same_epoch, config) = fence(3, Some(BOB));
    assert_eq!(
        authority.publish_account(&same_epoch, &config, account_id(DEVICE).unwrap()),
        Err(Deny::AccountMissing)
    );
    assert_eq!(fresh.active_account(), account_id(ALICE));
}

#[test]
fn conversion_ignores_original_owner_and_uses_current_member_device_role() {
    use mdbn_replica::policy::DeviceState;
    use mdbn_wire::policy::DeviceKind;
    let (authority, source, _) = fixture();
    let entry = Entry {
        mode: SyncMode::Synced,
        owner_account: Some(BOB.into()),
        device: None,
        ..registration()
    };
    authority.publish_registry(&registry(entry)); // host publishes only AFTER conversion commit
    assert!(source.owner_identity().is_none());
    assert_eq!(source.authorize(None), Err(Deny::PolicyRequired));
    let mut policy = PolicyState::new(); // explicit synthetic policy fixture, not runtime evidence
    let alice = account_id(ALICE).unwrap();
    let device = account_id(DEVICE).unwrap();
    policy.members.insert(alice, Role::Editor);
    policy.devices.insert(
        device,
        DeviceState {
            account: alice,
            kind: DeviceKind::Desktop,
            sign_pk: B32([1; 32]),
            kem_pk: B32([2; 32]),
            noise_pk: B32([3; 32]),
            active: true,
            keyed: true,
            introduced_by: None,
            delivered_by: None,
            local_root: None,
            sas_commit: None,
        },
    );
    let collection = account_id(COLLECTION).unwrap();
    assert_eq!(
        source.authorize(Some((collection, &policy))),
        Ok(Role::Editor)
    );
    policy.members.insert(alice, Role::Viewer);
    assert_eq!(
        source.authorize(Some((collection, &policy))),
        Ok(Role::Viewer)
    );
    assert_eq!(
        source.authorize(Some((device, &policy))),
        Err(Deny::RegistrationMismatch)
    );
    policy.devices.get_mut(&device).unwrap().account = account_id(BOB).unwrap();
    assert_eq!(
        source.authorize(Some((collection, &policy))),
        Err(Deny::MembershipMissing)
    );
    policy.devices.get_mut(&device).unwrap().account = alice;
    policy.members.remove(&alice);
    assert_eq!(
        source.authorize(Some((collection, &policy))),
        Err(Deny::MembershipMissing)
    );
}

#[test]
fn approval_noise_publication_uses_held_identity_and_denies_missing_stale_or_paused_source() {
    let (authority, source, _) = fixture();
    assert_eq!(source.device_noise_pk(), None); // UUID/account alone is not Noise custody.
    let mut identity = crate::secrets::DeviceIdentity::generate().unwrap();
    identity.device_id = account_id(DEVICE).unwrap().0;
    let (record, config) = fence(1, Some(ALICE));
    authority
        .publish_account_identity(&record, &config, &identity)
        .unwrap();
    let expected =
        x25519_dalek::PublicKey::from(&x25519_dalek::StaticSecret::from(*identity.noise_secret()));
    assert_eq!(source.device_noise_pk(), Some(B32(*expected.as_bytes())));
    let mut paused = registration();
    paused.paused = true;
    authority.publish_registry(&registry(paused));
    assert_eq!(source.device_noise_pk(), None);
    authority.publish_registry(&registry(registration()));
    authority.invalidate(2);
    let (record, config) = fence(2, Some(ALICE));
    authority
        .publish_account_identity(&record, &config, &identity)
        .unwrap();
    assert_eq!(source.device_noise_pk(), None);
    assert_eq!(
        authority
            .source(account_id(COLLECTION).unwrap())
            .unwrap()
            .device_noise_pk(),
        Some(B32(*expected.as_bytes()))
    );
}

#[test]
fn approval_epoch_requires_current_enabled_source_and_never_revives_after_account_aba() {
    let (authority, source, _) = fixture();
    assert_eq!(source.authority_epoch(), Some(1));
    let mut paused = registration();
    paused.paused = true;
    authority.publish_registry(&registry(paused));
    assert_eq!(source.authority_epoch(), None);
    authority.publish_registry(&registry(registration()));
    assert_eq!(source.authority_epoch(), Some(1));
    authority.invalidate(2);
    assert_eq!(source.authority_epoch(), None);
    let (record, config) = fence(2, Some(ALICE));
    authority
        .publish_account(&record, &config, account_id(DEVICE).unwrap())
        .unwrap();
    assert_eq!(source.authority_epoch(), None);
    assert_eq!(
        authority
            .source(account_id(COLLECTION).unwrap())
            .unwrap()
            .authority_epoch(),
        Some(2)
    );
}

#[test]
fn poisoned_projection_fails_closed() {
    let (authority, source, _) = fixture();
    let _ = std::panic::catch_unwind(|| {
        let _lock = authority.0.write().unwrap();
        panic!("test-only poison");
    });
    assert_eq!(source.active_account(), None);
    assert_eq!(source.authority_epoch(), None);
    assert_eq!(source.device_noise_pk(), None);
    assert_eq!(source.owner_identity(), None);
    assert!(source.grant(&account_id(GRANT).unwrap()).is_none());
}

#[test]
fn native_replica_adapter_forwards_only_held_noise_and_live_opened_epoch() {
    use mdbn_replica::policy::GrantSource;
    let (authority, source, _) = fixture();
    let bridge = crate::runtime::AuthoritySource(source.clone());
    assert_eq!(bridge.authority_epoch(), Some(1));
    assert_eq!(bridge.device_noise_pk(), None);
    let mut identity = crate::secrets::DeviceIdentity::generate().unwrap();
    identity.device_id = account_id(DEVICE).unwrap().0;
    let (record, config) = fence(1, Some(ALICE));
    authority
        .publish_account_identity(&record, &config, &identity)
        .unwrap();
    let expected =
        x25519_dalek::PublicKey::from(&x25519_dalek::StaticSecret::from(*identity.noise_secret()));
    assert_eq!(bridge.device_noise_pk(), Some(B32(*expected.as_bytes())));
    assert_eq!(bridge.authority_epoch(), source.authority_epoch());
    let mut paused = registration();
    paused.paused = true;
    authority.publish_registry(&registry(paused));
    assert_eq!(bridge.authority_epoch(), None);
    assert_eq!(bridge.device_noise_pk(), None);
    authority.publish_registry(&registry(registration()));
    authority.invalidate(2);
    let (record, config) = fence(2, Some(ALICE));
    authority
        .publish_account_identity(&record, &config, &identity)
        .unwrap();
    assert_eq!(bridge.authority_epoch(), None);
    assert_eq!(bridge.device_noise_pk(), None); // same-account ABA cannot revive old bridge.
    let fresh =
        crate::runtime::AuthoritySource(authority.source(account_id(COLLECTION).unwrap()).unwrap());
    assert_eq!(fresh.authority_epoch(), Some(2));
    assert_eq!(fresh.device_noise_pk(), Some(B32(*expected.as_bytes())));
    authority.publish_registry(&Registry::default());
    assert_eq!(fresh.authority_epoch(), None);
    assert_eq!(fresh.device_noise_pk(), None);
}

#[test]
fn native_replica_adapter_poison_and_different_account_deny_hooks() {
    use mdbn_replica::policy::GrantSource;
    let (authority, source, _) = fixture();
    let bridge = crate::runtime::AuthoritySource(source);
    authority.invalidate(2);
    let (record, config) = fence(2, Some(BOB));
    authority
        .publish_account(&record, &config, account_id(DEVICE).unwrap())
        .unwrap();
    assert_eq!(bridge.active_account(), None);
    assert_eq!(bridge.authority_epoch(), None);
    assert_eq!(bridge.device_noise_pk(), None);
    let fresh =
        crate::runtime::AuthoritySource(authority.source(account_id(COLLECTION).unwrap()).unwrap());
    let _ = std::panic::catch_unwind(|| {
        let _lock = authority.0.write().unwrap();
        panic!("test-only poisoned authority");
    });
    assert_eq!(fresh.authority_epoch(), None);
    assert_eq!(fresh.device_noise_pk(), None);
}
