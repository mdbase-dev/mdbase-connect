//! Final object quota/accounting belongs to the exclusive collection TX.
//! Local deterministic futures and opaque test objects; no server/provider I/O.
use std::future::{Future, poll_fn};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::task::{Context, Poll, Waker};

use mdbn_log_service::auth::Principal;
use mdbn_log_service::backend::Verified;
use mdbn_log_service::mem::{MemBackend, MemObjects};
use mdbn_log_service::model::{CollectionMeta, ObjectMeta, RetentionTier};
use mdbn_log_service::service::{staging_key, verify_upload};
use mdbn_log_service::testkit::{ControlPlane, Device, id16, object};
use mdbn_log_service::{
    Archive, Backend, Code, Config, Mode, ObjectStore, Result, Service, Txn, Write,
};
use mdbn_wire::cbor::Cbor;
use mdbn_wire::common::{B32, Bytes, Uuid};
use mdbn_wire::envelope::ItemKind;
use mdbn_wire::hash::sha256;
use mdbn_wire::log_service::{AppendParams, CommitObjectParams, PutObjectParams, PutStatus};
use mdbn_wire::policy::DeviceKind;
use mdbn_wire::schema::Wire;

const NOW: i64 = 1_000;
fn ready<T>(f: impl Future<Output = T>) -> T {
    let mut f = std::pin::pin!(f);
    match f.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
        Poll::Ready(v) => v,
        Poll::Pending => panic!("uncontended operation waited"),
    }
}
fn race<A: Future, B: Future>(a: A, b: B) -> (A::Output, B::Output) {
    let mut a = std::pin::pin!(a);
    let mut b = std::pin::pin!(b);
    let (mut ar, mut br) = (None, None);
    let mut cx = Context::from_waker(Waker::noop());
    for _ in 0..8 {
        if ar.is_none()
            && let Poll::Ready(v) = a.as_mut().poll(&mut cx)
        {
            ar = Some(v);
        }
        if br.is_none()
            && let Poll::Ready(v) = b.as_mut().poll(&mut cx)
        {
            br = Some(v);
        }
        (ar, br) = match (ar, br) {
            (Some(a), Some(b)) => return (a, b),
            unfinished => unfinished,
        };
    }
    panic!("deterministic race did not finish");
}

/// Both commits reach their final object-store write before either can record
/// metadata. Their initial authorization/preflight reads have already finished.
struct RacingObjects {
    inner: MemObjects,
    collection: Uuid,
    streamed: bool,
    armed: AtomicBool,
    arrivals: AtomicUsize,
}
impl Archive for RacingObjects {
    async fn put_segment(
        &self,
        c: &Uuid,
        tier: RetentionTier,
        from: u64,
        to: u64,
        bytes: Vec<u8>,
    ) -> Result<()> {
        self.inner.put_segment(c, tier, from, to, bytes).await
    }
    async fn archive_object(&self, c: &Uuid, tier: RetentionTier, address: &B32) -> Result<()> {
        self.inner.archive_object(c, tier, address).await
    }
}
impl ObjectStore for RacingObjects {
    async fn put(&self, key: &str, bytes: Vec<u8>) -> Result<()> {
        self.inner.put(key, bytes).await
    }
    async fn put_new(&self, key: &str, bytes: Vec<u8>) -> Result<bool> {
        if self.armed.load(Ordering::SeqCst) {
            self.arrivals.fetch_add(1, Ordering::SeqCst);
            poll_fn(|_| {
                if self.arrivals.load(Ordering::SeqCst) >= 2 {
                    Poll::Ready(())
                } else {
                    Poll::Pending
                }
            })
            .await;
        }
        self.inner.put_new(key, bytes).await
    }
    async fn get(&self, key: &str, range: Option<(u64, u64)>) -> Result<Option<Vec<u8>>> {
        self.inner.get(key, range).await
    }
    async fn delete(&self, key: &str) -> Result<()> {
        self.inner.delete(key).await
    }
    async fn verified_meta(&self, key: &str) -> Result<Option<Verified>> {
        if !self.streamed {
            return Ok(None);
        }
        let Some(bytes) = self.inner.get(key, None).await? else {
            return Ok(None);
        };
        // Actual protocol/checksum verification, not a fabricated trusted record.
        Ok(Some(verify_upload(
            &self.collection,
            &sha256(&bytes),
            &bytes,
        )?))
    }
}
struct Fixture {
    svc: Service<MemBackend, RacingObjects>,
    collection: Uuid,
    principal: Principal,
    device: Uuid,
}
impl Fixture {
    fn new(streamed: bool) -> Self {
        let cp = ControlPlane::new("object-commit-quota");
        let collection = id16("object-commit-quota/collection");
        let owner = id16("object-commit-quota/owner");
        let dev = Device::new("object-commit-quota/device", owner);
        let svc = Service::new(
            MemBackend::default(),
            RacingObjects {
                inner: MemObjects::default(),
                collection,
                streamed,
                armed: AtomicBool::new(false),
                arrivals: AtomicUsize::new(0),
            },
            Config {
                roots: vec![cp.root_pk()],
                token_issuers: vec![cp.issuer_pk()],
                url_secret: vec![0x51; 32],
                public_base: "https://fixture.test".into(),
            },
        );
        ready(svc.call(
            &Principal::ControlPlane,
            "create_log",
            &Cbor::Map(vec![
                (Cbor::Uint(0), collection.to_cbor()),
                (Cbor::Uint(1), Cbor::Bytes(cp.genesis(collection, owner))),
            ]),
            NOW,
        ))
        .unwrap();
        let head = ready(svc.head(&Principal::ControlPlane, &collection)).unwrap();
        ready(svc.append(
            &Principal::ControlPlane,
            AppendParams {
                collection,
                expect_seq: head.head + 1,
                expect_prev: head.head_chain,
                items: vec![Bytes(cp.policy_item(
                    collection,
                    head.head + 1,
                    head.head_chain,
                    vec![dev.enrol(DeviceKind::Desktop)],
                    2,
                ))],
            },
            NOW,
        ))
        .unwrap();
        Self {
            svc,
            collection,
            principal: Principal::Device {
                id: dev.id,
                sign_pk: dev.pk(),
                collection: Some(collection),
            },
            device: dev.id,
        }
    }
    fn state(&self) -> (CollectionMeta, Vec<ObjectMeta>) {
        ready(async {
            let mut tx = self
                .svc
                .backend
                .begin(&self.collection, Mode::Read)
                .await
                .unwrap();
            (
                tx.load().await.unwrap().unwrap().meta,
                tx.list_objects(None, 100).await.unwrap(),
            )
        })
    }
    fn accounting(&self, used: u64, quota: u64) {
        ready(async {
            let mut tx = self
                .svc
                .backend
                .begin(&self.collection, Mode::Write)
                .await
                .unwrap();
            let mut state = tx.load().await.unwrap().unwrap();
            state.meta.used_bytes = used;
            state.meta.quotas.storage_bytes = quota;
            tx.write(Write::PutMeta(state.meta));
            tx.commit().await.unwrap();
        });
    }
    fn staged(&self, byte: u8) -> (CommitObjectParams, u64) {
        let bytes = object(self.collection, ItemKind::BlobPart, 1, vec![byte; 32]);
        let address = sha256(&bytes);
        let size = bytes.len() as u64;
        verify_upload(&self.collection, &address, &bytes).unwrap();
        let p = ready(self.svc.put_object(
            &self.principal,
            PutObjectParams {
                collection: self.collection,
                address,
                kind: ItemKind::BlobPart,
                size,
                checksum: address,
                bytes: None,
            },
            NOW,
        ))
        .unwrap();
        assert_eq!(p.status, PutStatus::Upload);
        assert!(
            ready(self.svc.objects.put_new(
                &staging_key(&self.collection, &address, &self.device),
                bytes
            ))
            .unwrap()
        );
        (
            CommitObjectParams {
                collection: self.collection,
                address,
            },
            size,
        )
    }
}

#[test]
fn racing_staged_uploads_with_one_object_of_quota_left_commit_exactly_one() {
    for streamed in [false, true] {
        let f = Fixture::new(streamed);
        let (a, size) = f.staged(1);
        let (b, bsize) = f.staged(2);
        assert_eq!(size, bsize);
        let used = f.state().0.used_bytes;
        // One remaining object debit (wire-byte quota, not an object-count quota).
        let quota = used + size;
        f.accounting(used, quota);
        f.svc.objects.armed.store(true, Ordering::SeqCst);
        let (ar, br) = race(
            f.svc.commit_object(&f.principal, a.clone(), NOW),
            f.svc.commit_object(&f.principal, b.clone(), NOW),
        );
        assert_eq!(
            f.svc.objects.arrivals.load(Ordering::SeqCst),
            2,
            "both uploads raced before final accounting"
        );
        let (winner, loser) = match (ar, br) {
            (Ok(true), Err(e)) => {
                assert_eq!(e.code, Code::QuotaExceeded);
                (a, b)
            }
            (Err(e), Ok(true)) => {
                assert_eq!(e.code, Code::QuotaExceeded);
                (b, a)
            }
            outcomes => panic!("exactly one commit must succeed: {outcomes:?}"),
        };
        let (state, objects) = f.state();
        assert_eq!(state.used_bytes, quota);
        assert_eq!(objects.len(), 1);
        assert_eq!(objects[0].address, winner.address);
        let staged = staging_key(&f.collection, &loser.address, &f.device);
        assert!(
            ready(f.svc.objects.get(&staged, None)).unwrap().is_some(),
            "quota refusal preserves staged bytes"
        );
        // Current quota shrink cannot turn an already-committed retry into a
        // second charge, failure or lost original success.
        f.accounting(quota, 0);
        assert!(ready(f.svc.commit_object(&f.principal, winner, NOW)).unwrap());
        assert_eq!(f.state().0.used_bytes, quota);
        assert_eq!(
            ready(f.svc.commit_object(&f.principal, loser.clone(), NOW))
                .unwrap_err()
                .code,
            Code::QuotaExceeded
        );
        f.accounting(quota, quota + size);
        assert!(ready(f.svc.commit_object(&f.principal, loser, NOW)).unwrap());
        let (state, objects) = f.state();
        assert_eq!(state.used_bytes, quota + size);
        assert_eq!(objects.len(), 2);
        assert!(ready(f.svc.objects.get(&staged, None)).unwrap().is_none());
    }
}

#[test]
fn final_accounting_overflow_is_typed_quota_refusal_without_metadata_change() {
    for streamed in [false, true] {
        let f = Fixture::new(streamed);
        let (q, size) = f.staged(3);
        let used = u64::MAX - size + 1;
        f.accounting(used, u64::MAX);
        assert_eq!(
            ready(f.svc.commit_object(&f.principal, q.clone(), NOW))
                .unwrap_err()
                .code,
            Code::QuotaExceeded
        );
        let (state, objects) = f.state();
        assert_eq!(state.used_bytes, used);
        assert!(objects.is_empty());
        assert!(
            ready(
                f.svc
                    .objects
                    .get(&staging_key(&f.collection, &q.address, &f.device), None)
            )
            .unwrap()
            .is_some()
        );
        // Advisory PUT arithmetic is also checked, never a panic/wrapped charge.
        let err = ready(f.svc.put_object(
            &f.principal,
            PutObjectParams {
                collection: f.collection,
                address: q.address,
                kind: ItemKind::BlobPart,
                size,
                checksum: q.address,
                bytes: None,
            },
            NOW,
        ))
        .unwrap_err();
        assert_eq!(err.code, Code::QuotaExceeded);
        assert_eq!(f.state().0.used_bytes, used);
    }
}

#[test]
fn inline_uploads_share_the_same_atomic_final_quota_debit() {
    let f = Fixture::new(false);
    let a = object(f.collection, ItemKind::BlobPart, 1, vec![4; 32]);
    let b = object(f.collection, ItemKind::BlobPart, 1, vec![5; 32]);
    let size = a.len() as u64;
    assert_eq!(b.len() as u64, size);
    let used = f.state().0.used_bytes;
    f.accounting(used, used + size);
    let params = |bytes: Vec<u8>| {
        let address = sha256(&bytes);
        PutObjectParams {
            collection: f.collection,
            address,
            kind: ItemKind::BlobPart,
            size,
            checksum: address,
            bytes: Some(Bytes(bytes)),
        }
    };
    let a = params(a);
    let b = params(b);
    f.svc.objects.armed.store(true, Ordering::SeqCst);
    let (ar, br) = race(
        f.svc.put_object(&f.principal, a.clone(), NOW),
        f.svc.put_object(&f.principal, b.clone(), NOW),
    );
    assert_eq!(f.svc.objects.arrivals.load(Ordering::SeqCst), 2);
    let winner = match (ar, br) {
        (Ok(r), Err(e)) => {
            assert_eq!(r.status, PutStatus::Stored);
            assert_eq!(e.code, Code::QuotaExceeded);
            a
        }
        (Err(e), Ok(r)) => {
            assert_eq!(r.status, PutStatus::Stored);
            assert_eq!(e.code, Code::QuotaExceeded);
            b
        }
        outcomes => panic!("exactly one inline store must succeed: {outcomes:?}"),
    };
    let (state, objects) = f.state();
    assert_eq!(state.used_bytes, used + size);
    assert_eq!(objects.len(), 1);
    assert_eq!(objects[0].address, winner.address);
    f.accounting(used + size, 0);
    assert_eq!(
        ready(f.svc.put_object(&f.principal, winner, NOW))
            .unwrap()
            .status,
        PutStatus::Exists
    );
    assert_eq!(f.state().0.used_bytes, used + size);
}

#[test]
fn final_transaction_uses_quota_changed_during_object_store_await() {
    for streamed in [false, true] {
        let f = Fixture::new(streamed);
        let (q, size) = f.staged(6);
        let used = f.state().0.used_bytes;
        f.accounting(used, used + size);
        f.svc.objects.armed.store(true, Ordering::SeqCst);
        let mut commit = std::pin::pin!(f.svc.commit_object(&f.principal, q.clone(), NOW));
        assert!(
            commit
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop()))
                .is_pending()
        );
        assert_eq!(f.svc.objects.arrivals.load(Ordering::SeqCst), 1);
        // The old eligibility/metadata read has completed; no transaction is
        // held across object I/O. The authoritative final TX must reload quota.
        f.accounting(used, used + size - 1);
        f.svc.objects.arrivals.store(2, Ordering::SeqCst);
        let result = match commit
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
        {
            Poll::Ready(result) => result,
            Poll::Pending => panic!("released commit unexpectedly pending"),
        };
        assert_eq!(result.unwrap_err().code, Code::QuotaExceeded);
        let (state, objects) = f.state();
        assert_eq!(state.used_bytes, used);
        assert!(objects.is_empty());
        assert!(
            ready(
                f.svc
                    .objects
                    .get(&staging_key(&f.collection, &q.address, &f.device), None)
            )
            .unwrap()
            .is_some()
        );
    }
}
