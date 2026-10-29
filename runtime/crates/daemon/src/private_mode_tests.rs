use super::*;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
static NEXT: AtomicU64 = AtomicU64::new(0);
const ID: &str = "33333333-3333-3333-3333-333333333333";
const SIGNER: &str = "44444444-4444-4444-8444-444444444444";
const MEMBER: &str = "77777777-7777-4777-8777-777777777777";
struct Fixture {
    profile: Profile,
    registry: Registry,
    trust: crate::trust::Trust,
    dir: PathBuf,
    root: PathBuf,
    choice: Choice,
}
impl Fixture {
    fn new() -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../target")
            .join(format!(
                "private-mode-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        std::fs::create_dir_all(&root).unwrap();
        let profile = Profile::isolated(&root).unwrap();
        let dir = profile.collection_dir(ID);
        std::fs::create_dir_all(&dir).unwrap();
        let trust = crate::trust::Trust {
            environment: "lab".into(),
            cp_origin: "https://cp.example.dev".into(),
            log_origin: "https://log.example.dev".into(),
            roots: vec![[0xab; 32]],
            policy_pins: crate::trust::pins_for([0xab; 32], [0xcd; 32]),
        };
        let cfg = crate::sync::SyncConfig {
            schema_version: 2,
            environment: "lab".into(),
            collection_id: ID.into(),
            log_url: trust.log_origin.clone(),
            genesis_hash: "cd".repeat(32),
            chosen_state: "cloud_copy".into(),
            trusted_signers: vec![],
            user_enabled_cloud_copy: true,
        };
        cfg.save(&dir.join(crate::sync::FILE), &[0x33; 16], &trust)
            .unwrap();
        let registry = Registry {
            collections: vec![Entry {
                id: ID.into(),
                name: "notes".into(),
                description: None,
                root: root.join("notes"),
                replica_id: ID.into(),
                mode: SyncMode::Synced,
                origin: Origin::Created,
                added_at_ms: 1,
                paused: false,
                ever_e2e: false,
                owner_account: Some("55555555-5555-4555-8555-555555555555".into()),
                device: Some("66666666-6666-4666-8666-666666666666".into()),
            }],
            ..Registry::default()
        };
        registry.save(&profile.registry_file()).unwrap();
        let choice = Choice {
            collection: ID.into(),
            account: registry.collections[0].owner_account.clone().unwrap(),
            device: registry.collections[0].device.clone().unwrap(),
            genesis: cfg.genesis_hash,
            signer: SIGNER.into(),
            trusted_signers: vec![SIGNER.into(), MEMBER.into()],
            cloud_copy: false,
            receiver_read: false,
        };
        Self {
            profile,
            registry,
            trust,
            dir,
            root,
            choice,
        }
    }
    fn journal(&self) {
        crate::fsutil::write_atomic(
            &self.dir.join(FILE),
            &serde_json::to_vec(&self.choice).unwrap(),
        )
        .unwrap();
    }
    fn cfg(&self) -> crate::sync::SyncConfig {
        crate::sync::SyncConfig::load(&self.dir.join(crate::sync::FILE))
            .unwrap()
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn private_choice_projection_restarts_before_and_between_each_host_write() {
    for boundary in 0..4 {
        let mut f = Fixture::new();
        f.journal();
        if boundary == 1 || boundary == 3 {
            let mut cfg = f.cfg();
            cfg.chosen_state = "private".into();
            cfg.user_enabled_cloud_copy = false;
            cfg.trusted_signers.push(SIGNER.into());
            cfg.save(&f.dir.join(crate::sync::FILE), &[0x33; 16], &f.trust)
                .unwrap();
        }
        if boundary == 2 || boundary == 3 {
            f.registry.collections[0].mode = SyncMode::SyncedE2e;
            f.registry.collections[0].ever_e2e = true;
            f.registry.save(&f.profile.registry_file()).unwrap();
        }
        let mut reopened = Registry::load(&f.profile.registry_file()).unwrap();
        replay(&f.profile, &mut reopened, &f.trust).unwrap();
        assert_eq!(reopened.collections[0].mode, SyncMode::SyncedE2e);
        assert!(reopened.collections[0].ever_e2e);
        assert_eq!(f.cfg().chosen_state, "private");
        assert!(!f.cfg().user_enabled_cloud_copy);
        assert_eq!(f.cfg().trusted_signers, vec![SIGNER, MEMBER]);
        assert!(!f.dir.join(FILE).exists());
        replay(&f.profile, &mut reopened, &f.trust).unwrap();
        assert_eq!(
            f.cfg().trusted_signers,
            vec![SIGNER, MEMBER],
            "retry never adds another trust anchor"
        );
    }
}
#[test]
fn projection_is_bound_to_registration_and_original_genesis() {
    for field in [
        "account",
        "device",
        "collection",
        "genesis",
        "signer",
        "trusted_signers",
    ] {
        let mut f = Fixture::new();
        match field {
            "account" => f.choice.account = ID.into(),
            "device" => f.choice.device = ID.into(),
            "collection" => f.choice.collection = SIGNER.into(),
            "genesis" => f.choice.genesis = "ff".repeat(32),
            "trusted_signers" => f.choice.trusted_signers.push("not-a-device".into()),
            _ => f.choice.signer = "not-a-device".into(),
        }
        f.journal();
        let before = f.cfg();
        assert!(replay(&f.profile, &mut f.registry, &f.trust).is_err());
        assert_eq!(f.cfg(), before);
        assert!(f.dir.join(FILE).exists());
    }
}
#[test]
fn no_verified_replica_projection_means_no_local_mode_change() {
    let mut f = Fixture::new();
    replay(&f.profile, &mut f.registry, &f.trust).unwrap();
    assert_eq!(f.registry.collections[0].mode, SyncMode::Synced);
    assert_eq!(f.cfg().chosen_state, "cloud_copy");
    assert!(f.cfg().trusted_signers.is_empty());
}

#[test]
fn cloud_choice_projection_replays_each_host_boundary_but_keeps_pending_consent() {
    for (receiver_read, boundary) in [false, true]
        .into_iter()
        .flat_map(|read| (0..4).map(move |boundary| (read, boundary)))
    {
        let mut f = Fixture::new();
        let mut cfg = f.cfg();
        cfg.chosen_state = "private".into();
        cfg.user_enabled_cloud_copy = false;
        cfg.save(&f.dir.join(crate::sync::FILE), &[0x33; 16], &f.trust)
            .unwrap();
        f.registry.collections[0].mode = SyncMode::SyncedE2e;
        f.registry.collections[0].ever_e2e = true;
        f.registry.save(&f.profile.registry_file()).unwrap();
        f.choice.cloud_copy = true;
        f.choice.receiver_read = receiver_read;
        f.journal();
        if boundary == 1 || boundary == 3 {
            let mut cfg = f.cfg();
            cfg.chosen_state = "cloud_copy".into();
            cfg.user_enabled_cloud_copy = true;
            cfg.save(&f.dir.join(crate::sync::FILE), &[0x33; 16], &f.trust)
                .unwrap();
        }
        if boundary == 2 || boundary == 3 {
            f.registry.collections[0].mode = SyncMode::Synced;
            f.registry.save(&f.profile.registry_file()).unwrap();
        }
        let mut reopened = Registry::load(&f.profile.registry_file()).unwrap();
        replay(&f.profile, &mut reopened, &f.trust).unwrap();
        assert_eq!(reopened.collections[0].mode, SyncMode::Synced);
        assert!(reopened.collections[0].ever_e2e);
        assert_eq!(f.cfg().chosen_state, "cloud_copy");
        assert!(f.cfg().user_enabled_cloud_copy);
        assert_eq!(f.cfg().trusted_signers, vec![SIGNER, MEMBER]);
        assert!(
            f.dir.join(FILE).exists() != receiver_read,
            "only an explicit source journal waits for actor consent; a receiver never calls ChooseCloud"
        );
        replay(&f.profile, &mut reopened, &f.trust).unwrap();
        assert_eq!(f.cfg().trusted_signers, vec![SIGNER, MEMBER]);
    }
}

#[test]
fn explicit_cloud_intent_supersedes_private_projection_but_not_the_reverse() {
    let mut f = Fixture::new();
    f.journal();
    let private = f.choice.clone();
    let mut cloud = private.clone();
    cloud.cloud_copy = true;
    persist(&f.profile, &mut f.registry, &f.trust, &f.dir, &cloud).unwrap();
    assert_eq!(f.cfg().chosen_state, "cloud_copy");
    assert!(persist(&f.profile, &mut f.registry, &f.trust, &f.dir, &private).is_err());
    assert_eq!(load(&f.dir.join(FILE)).unwrap(), Some(cloud));
}

#[test]
fn cloud_projection_keeps_identity_and_original_genesis_guards() {
    for field in ["account", "device", "genesis"] {
        let mut f = Fixture::new();
        f.choice.cloud_copy = true;
        match field {
            "account" => f.choice.account = ID.into(),
            "device" => f.choice.device = ID.into(),
            _ => f.choice.genesis = "ff".repeat(32),
        }
        f.journal();
        let before = f.cfg();
        assert!(replay(&f.profile, &mut f.registry, &f.trust).is_err());
        assert_eq!(f.cfg(), before);
        assert!(f.dir.join(FILE).exists());
    }
}
