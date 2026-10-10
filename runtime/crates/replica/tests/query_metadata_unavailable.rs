//! Public Replica API denial regression; synthetic trusted host, no crypto acceptance.
use mdbn_core::host::{Entropy, FixedClock};
use mdbn_replica::api::{ClientApi, ErrorCode, SessionAuth};
use mdbn_replica::crypto::CsprngEntropy;
use mdbn_replica::log::EndpointId;
use mdbn_replica::mem::MemStore;
use mdbn_replica::replica::{DeviceSecrets, Host, Replica, ReplicaConfig, UtcOnly};
use mdbn_replica::seal::KeyringSealer;
use mdbn_wire::client::{HelloParams, Include, SyncMode};
use mdbn_wire::common::{B16, Value, Version};

// Synthetic entropy is confined to this test executable. Startup may consume
// it; the read/denial paths below must not. This is not crypto qualification.
struct FixtureEntropy(std::rc::Rc<std::cell::Cell<usize>>);
impl Entropy for FixtureEntropy {
    fn fill(&mut self, buf: &mut [u8]) {
        self.0.set(self.0.get() + 1);
        buf.fill(7);
    }
}
impl CsprngEntropy for FixtureEntropy {}
fn include() -> Include {
    Include {
        effective: None,
        body: None,
        document: None,
        diagnostics: None,
    }
}

#[test]
fn grouped_and_summary_requests_fail_before_legacy_execution() {
    let collection = B16([1; 16]);
    let device = B16([2; 16]);
    let entropy_calls = std::rc::Rc::new(std::cell::Cell::new(0));
    let mut replica = Replica::open(
        ReplicaConfig {
            collection,
            device_id: device,
            replica_id: B16([3; 16]),
            mode: SyncMode::LocalOnly,
            log_endpoint: EndpointId(1),
            verify: false,
            runtime_version: "test".into(),
            trusted_roots: vec![],
            trusted_signers: vec![],
            e2e: false,
            user_enabled_cloud_copy: false,
            chosen_state: None,
            expected_genesis: None,
            policy_pins: None,
            key_grants_only: false,
        },
        MemStore::new(),
        Box::new(mdbn_replica::plan::CorePlanner),
        Box::new(KeyringSealer::new(collection, device, &[1; 32], &[2; 32])),
        Host {
            clock: Box::new(FixedClock(0)),
            entropy: Box::new(FixtureEntropy(entropy_calls.clone())),
            zones: Box::new(UtcOnly),
        },
        DeviceSecrets {
            sign_sk: [1; 32],
            kem_sk: [2; 32],
        },
    )
    .unwrap();
    let (session, _) = replica
        .hello(
            SessionAuth::Host,
            HelloParams {
                versions: vec![Version { major: 1, minor: 0 }],
                client_name: "denial-fixture".into(),
                client_version: "0".into(),
                features: None,
                timezone: None,
            },
        )
        .unwrap();
    let startup_entropy_calls = entropy_calls.get();
    let plain = replica
        .query(session, Value::Map(vec![]), include())
        .unwrap();
    assert!(plain.records.is_empty());
    for query in [
        Value::Map(vec![(
            "group_by".into(),
            Value::List(vec![Value::Map(vec![(
                "field".into(),
                Value::Text("status".into()),
            )])]),
        )]),
        Value::Map(vec![(
            "summaries".into(),
            Value::List(vec![Value::Map(vec![
                ("field".into(), Value::Text("status".into())),
                ("function".into(), Value::Text("count".into())),
            ])]),
        )]),
    ] {
        let error = replica
            .query(session, query.clone(), include())
            .unwrap_err();
        assert_eq!(error.code(), Some(ErrorCode::InvalidRequest));
        assert_eq!(
            error.problem().reason.as_deref(),
            Some("query_profile_unavailable")
        );
        let error = replica.subscribe(session, query, include()).unwrap_err();
        assert_eq!(
            error.problem().reason.as_deref(),
            Some("query_profile_unavailable")
        );
    }
    assert!(
        replica
            .query(session, Value::Map(vec![]), include())
            .unwrap()
            .records
            .is_empty()
    );
    assert_eq!(entropy_calls.get(), startup_entropy_calls);
}
