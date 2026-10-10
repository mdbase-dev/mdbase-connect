//! The snapshot install gate in a shipped configuration (the shipped gate is
//! enforced explicitly, since a workspace build may unify the `testing`
//! feature into this test binary): install and endorsement
//! are reachable exactly when the store stages persistently within the bounded
//! staging condition). A replica over a store without a staging area that is
//! behind retention reports `upgrade_required` and does not start an install.
use mdbn_core::host::{Entropy, FixedClock};
use mdbn_replica::crypto::CsprngEntropy;
use mdbn_replica::log::{EndpointId, LogPort, LogRequest, LogResponse};
use mdbn_replica::mem::MemStore;
use mdbn_replica::replica::{DeviceSecrets, Host, Replica, ReplicaConfig, UtcOnly};
use mdbn_replica::seal::KeyringSealer;
use mdbn_wire::client::{IncidentKind, SyncMode};
use mdbn_wire::common::{B16, B32};
use mdbn_wire::log_service::ReadResult;

struct FixtureEntropy;
impl Entropy for FixtureEntropy {
    fn fill(&mut self, buf: &mut [u8]) {
        buf.fill(7);
    }
}
impl CsprngEntropy for FixtureEntropy {}

fn open(store: MemStore) -> Replica<MemStore> {
    let collection = B16([1; 16]);
    let device = B16([2; 16]);
    Replica::open(
        ReplicaConfig {
            collection,
            device_id: device,
            replica_id: B16([3; 16]),
            mode: SyncMode::Synced,
            log_endpoint: EndpointId(1),
            verify: false,
            runtime_version: "test".into(),
            trusted_roots: vec![],
            trusted_signers: vec![],
            e2e: false,
            user_enabled_cloud_copy: false,
            chosen_state: None,
            expected_genesis: None,
            key_grants_only: false,
            policy_pins: None,
        },
        store,
        Box::new(mdbn_replica::plan::CorePlanner),
        Box::new(KeyringSealer::new(collection, device, &[1; 32], &[2; 32])),
        Host {
            clock: Box::new(FixedClock(0)),
            entropy: Box::new(FixtureEntropy),
            zones: Box::new(UtcOnly),
        },
        DeviceSecrets {
            sign_sk: [1; 32],
            kem_sk: [2; 32],
        },
    )
    .map(|mut r| {
        r.enforce_shipped_install_gate();
        r
    })
    .unwrap()
}

/// Answer the replica's calls as a service that compacted everything: the
/// first read is `behind`. Returns the methods it asked for after that.
fn behind(r: &mut Replica<MemStore>) -> Vec<&'static str> {
    let mut after_behind = Vec::new();
    let mut answered = false;
    for _ in 0..10 {
        let calls = r.take_log_calls();
        if calls.is_empty() {
            r.tick();
            if r.take_log_calls().is_empty() && answered {
                break;
            }
        }
        for c in calls {
            if answered {
                after_behind.push(c.request.method());
            }
            let reply = match c.request {
                LogRequest::Subscribe { .. } => Ok(LogResponse::Subscribed {
                    head: 50,
                    head_chain: B32([5; 32]),
                }),
                LogRequest::Read(_) if !answered => {
                    answered = true;
                    Ok(LogResponse::Read(ReadResult {
                        items: vec![],
                        head: 50,
                        head_chain: B32([5; 32]),
                        retained_from: 40,
                        behind: true,
                        snapshot: None,
                        more: false,
                    }))
                }
                _ => Err(mdbn_replica::log::LogError::Offline),
            };
            r.on_log_reply(c.id, reply);
        }
    }
    after_behind
}

#[test]
fn install_is_available_exactly_over_a_staging_store() {
    assert!(open(MemStore::new()).snapshot_install_available());
    assert!(!open(MemStore::new().without_staging()).snapshot_install_available());
}

#[test]
fn a_staging_store_installs_when_behind_in_a_shipped_build() {
    let mut r = open(MemStore::new());
    let calls = behind(&mut r);
    assert!(r.installing(), "the install started");
    assert!(
        calls.contains(&"read"),
        "it reads the control items first: {calls:?}"
    );
    assert!(
        !r.sync_status()
            .incidents
            .iter()
            .any(|i| i.kind == IncidentKind::UpgradeRequired)
    );
}

#[test]
fn a_store_without_staging_reports_instead_of_installing() {
    let mut r = open(MemStore::new().without_staging());
    behind(&mut r);
    assert!(!r.installing());
    assert!(
        r.sync_status()
            .incidents
            .iter()
            .any(|i| i.kind == IncidentKind::UpgradeRequired)
    );
}
