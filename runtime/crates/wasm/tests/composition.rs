//! Trusted composition plumbing only; not browser storage or network qualification.
use mdbn_core::host::{Clock, Entropy};
use mdbn_replica::log::{CallId, EndpointId, LogPort, LogPush, LogRequest, LogResponse};
use mdbn_replica::mem::MemStore;
use mdbn_replica::store::{Head, Store, Tx, meta_keys};
use mdbn_replica::{DeviceSecrets, Host, QueryExecutionProfile, ReplicaConfig};
use mdbn_wasm::runtime::Runtime;
use mdbn_wire::client::SyncMode;
use mdbn_wire::common::{B16, B32};
use mdbn_wire::policy::CState;

struct Fixed;
impl Clock for Fixed {
    fn now_ms(&self) -> u64 {
        1_791_100_000_000
    }
}
impl Entropy for Fixed {
    fn fill(&mut self, bytes: &mut [u8]) {
        bytes.fill(7);
    }
}
// Deterministic entropy is confined to this native test harness.
impl mdbn_replica::crypto::CsprngEntropy for Fixed {}
fn host() -> Host {
    Host {
        clock: Box::new(Fixed),
        entropy: Box::new(Fixed),
        zones: Box::new(mdbn_replica::replica::UtcOnly),
    }
}
fn secrets() -> DeviceSecrets {
    DeviceSecrets {
        sign_sk: [4; 32],
        kem_sk: [5; 32],
    }
}
fn config() -> ReplicaConfig {
    ReplicaConfig {
        collection: B16([1; 16]),
        replica_id: B16([2; 16]),
        device_id: B16([3; 16]),
        mode: SyncMode::LocalOnly,
        log_endpoint: EndpointId(37),
        verify: true,
        runtime_version: "composition-test".into(),
        trusted_roots: vec![[9; 32]],
        e2e: false,
        trusted_signers: vec![B16([3; 16])],
        user_enabled_cloud_copy: false,
        chosen_state: None,
        key_grants_only: false,
        expected_genesis: None,
        policy_pins: None,
    }
}

#[test]
fn compose_uses_the_provided_store_and_reopens_without_replacing_it() {
    let mut store = MemStore::new();
    store
        .commit(Tx {
            meta: vec![("host.marker".into(), Some(vec![8]))],
            ..Tx::default()
        })
        .unwrap();
    let rt = Runtime::compose(
        config(),
        store,
        host(),
        secrets(),
        QueryExecutionProfile::Desktop,
    )
    .unwrap();
    assert_eq!(rt.query_execution_profile(), QueryExecutionProfile::Desktop);
    let store = rt.into_store();
    assert_eq!(store.meta("host.marker").unwrap(), Some(vec![8]));
    let reopened = Runtime::compose(
        config(),
        store,
        host(),
        secrets(),
        QueryExecutionProfile::MemoryConstrained,
    )
    .unwrap();
    assert_eq!(
        reopened.query_execution_profile(),
        QueryExecutionProfile::MemoryConstrained
    );
    assert_eq!(
        reopened.into_store().meta("host.marker").unwrap(),
        Some(vec![8])
    );
}

#[test]
fn composed_reopen_preserves_replica_identity_guard() {
    let first = Runtime::compose(
        config(),
        MemStore::new(),
        host(),
        secrets(),
        QueryExecutionProfile::MemoryConstrained,
    )
    .unwrap();
    let mut other = config();
    other.collection = B16([99; 16]);
    let error = Runtime::compose(
        other,
        first.into_store(),
        host(),
        secrets(),
        QueryExecutionProfile::MemoryConstrained,
    )
    .unwrap_err();
    assert!(error.0.contains("another collection or replica"));
}

#[test]
fn composed_warm_store_must_match_the_host_genesis_pin() {
    let mut store = MemStore::new();
    store
        .commit(Tx {
            head: Some(Head {
                seq: 1,
                chain: B32([7; 32]),
            }),
            meta: vec![(meta_keys::GENESIS.into(), Some(vec![7; 32]))],
            ..Tx::default()
        })
        .unwrap();
    let mut cfg = config();
    cfg.mode = SyncMode::Synced;
    cfg.expected_genesis = Some(B32([8; 32]));
    cfg.chosen_state = Some(CState::E2e);
    cfg.e2e = true;
    let error = Runtime::compose(
        cfg,
        store,
        host(),
        secrets(),
        QueryExecutionProfile::MemoryConstrained,
    )
    .unwrap_err();
    assert!(error.0.contains("different genesis"));
}

#[test]
fn composed_log_port_keeps_endpoint_call_identity_and_lifecycle() {
    let mut cfg = config();
    cfg.mode = SyncMode::Synced;
    cfg.e2e = true;
    cfg.chosen_state = Some(CState::E2e);
    cfg.expected_genesis = Some(B32([8; 32]));
    let mut rt = Runtime::compose(
        cfg,
        MemStore::new(),
        host(),
        secrets(),
        QueryExecutionProfile::MemoryConstrained,
    )
    .unwrap();
    let calls = rt.take_log_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].endpoint, EndpointId(37));
    assert!(
        matches!(calls[0].request, LogRequest::Subscribe { collection, after: 0, .. } if collection == B16([1; 16]))
    );
    let response = || {
        Ok(LogResponse::Subscribed {
            head: 2,
            head_chain: B32([6; 32]),
        })
    };
    rt.on_log_reply(CallId(999), response());
    assert!(
        rt.take_log_calls().is_empty(),
        "unknown replies do not consume the real call"
    );
    rt.on_log_reply(calls[0].id, response());
    let next = rt.take_log_calls();
    assert!(next.iter().any(|call| matches!(&call.request, LogRequest::Read(p) if p.collection == B16([1; 16]) && p.after == 0)));
    assert!(next.iter().all(|call| call.endpoint == EndpointId(37)));
    rt.on_log_push(LogPush::Disconnected);
    rt.on_log_push(LogPush::Reconnected);
    assert!(
        rt.take_log_calls()
            .iter()
            .any(|call| matches!(call.request, LogRequest::Subscribe { .. }))
    );
}
