//! Serialized reference floor reads share the enclosing request budget.
use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::task::{Context, Poll, Waker};

use mdbn_log_service::auth::Principal;
use mdbn_log_service::decode::{Budget, MAX_NODES, Usage};
use mdbn_log_service::deletion::CollectionDeletionRecord;
use mdbn_log_service::mem::{MemBackend, MemObjects};
use mdbn_log_service::testkit::{ControlPlane, id16};
use mdbn_log_service::{Backend, Code, Mode, Result, Service, Txn};
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::common::Uuid;
use mdbn_wire::schema::Wire;

#[derive(Default)]
struct SerializedFloor {
    inner: MemBackend,
    reads: AtomicUsize,
    usage: std::sync::Mutex<Vec<(Usage, Usage)>>,
}
impl Backend for SerializedFloor {
    type Txn<'a> = <MemBackend as Backend>::Txn<'a>;
    async fn collection_deletion_floor(
        &self,
        _: &Uuid,
    ) -> Result<Option<CollectionDeletionRecord>> {
        panic!("request-scoped lookup bypassed the enclosing budget")
    }
    async fn collection_deletion_floor_with_budget(
        &self,
        c: &Uuid,
        budget: &Budget,
    ) -> Result<Option<CollectionDeletionRecord>> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        let raw = cbor::encode(&Cbor::Array(vec![Cbor::Uint(1), c.to_cbor(), Cbor::Null])).unwrap();
        let before = budget.usage();
        budget.raw(&raw)?;
        self.usage.lock().unwrap().push((before, budget.usage()));
        Ok(None) // only this independently owned serialized reference fixture
    }
    async fn begin(&self, c: &Uuid, mode: Mode) -> Result<Self::Txn<'_>> {
        self.inner.begin(c, mode).await
    }
    async fn credentials_revoked(&self, c: &Uuid) -> Result<bool> {
        self.inner.credentials_revoked(c).await
    }
    async fn revoke_credentials(&self, c: &Uuid, now: i64) -> Result<()> {
        self.inner.revoke_credentials(c, now).await
    }
}
fn config() -> mdbn_log_service::Config {
    let cp = ControlPlane::new("floor-budget");
    mdbn_log_service::Config {
        roots: vec![cp.root_pk()],
        token_issuers: vec![cp.issuer_pk()],
        url_secret: vec![71; 32],
        public_base: "http://fixture.test".into(),
    }
}
fn ready<T>(f: impl Future<Output = T>) -> T {
    let mut f = std::pin::pin!(f);
    match f.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
        Poll::Ready(v) => v,
        Poll::Pending => panic!("reference fixture waited"),
    }
}
#[test]
fn floor_decode_cannot_reset_an_exhausted_request_or_create_collection() {
    let cp = ControlPlane::new("floor-budget");
    let c = id16("floor-budget/collection");
    let svc = Service::new(SerializedFloor::default(), MemObjects::default(), config());
    let params = Cbor::Map(vec![
        (Cbor::Uint(0), c.to_cbor()),
        (
            Cbor::Uint(1),
            Cbor::Bytes(cp.genesis(c, id16("floor-budget/owner"))),
        ),
    ]);
    let budget = Budget::from_usage(Usage {
        nodes: MAX_NODES,
        ..Usage::default()
    })
    .unwrap();
    let error = ready(svc.call_with_budget(
        &Principal::ControlPlane,
        "create_log",
        &params,
        1000,
        &budget,
    ))
    .unwrap_err();
    assert_eq!(error.code, Code::Invalid);
    assert_eq!(error.reason.as_deref(), Some("cbor_nodes"));
    assert_eq!(svc.backend.reads.load(Ordering::SeqCst), 1);
    let mut tx = ready(svc.backend.inner.begin(&c, Mode::Read)).unwrap();
    assert!(ready(tx.load()).unwrap().is_none());
}
#[test]
fn repeated_floor_reads_charge_the_same_outer_ledger() {
    let cp = ControlPlane::new("floor-budget");
    let c = id16("floor-budget/collection");
    let svc = Service::new(SerializedFloor::default(), MemObjects::default(), config());
    let params = Cbor::Map(vec![
        (Cbor::Uint(0), c.to_cbor()),
        (
            Cbor::Uint(1),
            Cbor::Bytes(cp.genesis(c, id16("floor-budget/owner"))),
        ),
    ]);
    let budget = Budget::default();
    let first = ready(svc.call_with_budget(
        &Principal::ControlPlane,
        "create_log",
        &params,
        1000,
        &budget,
    ))
    .unwrap();
    let duplicate = ready(svc.call_with_budget(
        &Principal::ControlPlane,
        "create_log",
        &params,
        1000,
        &budget.clone(),
    ))
    .unwrap();
    assert_eq!(duplicate.result, first.result);
    let reads = svc.backend.reads.load(Ordering::SeqCst);
    assert_eq!(reads, 3); // initial creation + retry's initial and existing-state checks
    let usage = svc.backend.usage.lock().unwrap();
    for (before, after) in usage.iter() {
        assert_eq!(after.nodes - before.nodes, 4);
        assert_eq!(after.work_bytes - before.work_bytes, 20);
    }
    for pair in usage.windows(2) {
        assert!(pair[1].0.nodes >= pair[0].1.nodes);
        assert!(pair[1].0.work_bytes >= pair[0].1.work_bytes);
    }
    let last = usage.last().unwrap().1;
    assert!(budget.usage().nodes >= last.nodes);
    assert!(budget.usage().work_bytes >= last.work_bytes);
}
