//! Deterministic terminal-deletion/publication races, no external I/O.
use std::future::{Future, poll_fn};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::task::{Context, Poll, Waker};

use mdbn_log_service::auth::Principal;
use mdbn_log_service::backend::Verified;
use mdbn_log_service::deletion::CollectionDeletionRecord;
use mdbn_log_service::mem::{MemBackend, MemObjects};
use mdbn_log_service::model::{CollectionMeta, ObjectMeta, RetentionTier, Status, object_key};
use mdbn_log_service::service::{staging_key, verify_upload};
use mdbn_log_service::testkit::{ControlPlane, Device, id16, object};
use mdbn_log_service::{Archive, Backend, Code, Config, Mode, ObjectStore, Result, Service, Txn};
use mdbn_wire::cbor::Cbor;
use mdbn_wire::common::{B32, Bytes, Uuid};
use mdbn_wire::envelope::ItemKind;
use mdbn_wire::hash::sha256;
use mdbn_wire::log_service::{
    AppendParams, CommitObjectParams, PutObjectParams, PutStatus, SeqItem,
};
use mdbn_wire::policy::DeviceKind;
use mdbn_wire::schema::Wire;

const NOW: i64 = 1_000;
fn ready<T>(f: impl Future<Output = T>) -> T {
    let mut f = std::pin::pin!(f);
    match f.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
        Poll::Ready(v) => v,
        Poll::Pending => panic!("uncontended future waited"),
    }
}
fn pending<F: Future>(f: std::pin::Pin<&mut F>) {
    assert!(f.poll(&mut Context::from_waker(Waker::noop())).is_pending());
}
#[derive(Default)]
struct Gate {
    armed: AtomicBool,
    waiting: AtomicBool,
    released: AtomicBool,
}
impl Gate {
    fn arm(&self) {
        self.waiting.store(false, Ordering::SeqCst);
        self.released.store(false, Ordering::SeqCst);
        self.armed.store(true, Ordering::SeqCst);
    }
    async fn hit(&self) {
        if self.armed.swap(false, Ordering::SeqCst) {
            self.waiting.store(true, Ordering::SeqCst);
            poll_fn(|_| {
                if self.released.load(Ordering::SeqCst) {
                    Poll::Ready(())
                } else {
                    Poll::Pending
                }
            })
            .await;
        }
    }
    fn release(&self) {
        assert!(self.waiting.load(Ordering::SeqCst));
        self.released.store(true, Ordering::SeqCst);
    }
}
#[derive(Default)]
struct GateBackend {
    inner: MemBackend,
    dedup: Gate,
    floor_reply: Mutex<Option<Result<Option<CollectionDeletionRecord>>>>,
}
impl Backend for GateBackend {
    type Txn<'a> = <MemBackend as Backend>::Txn<'a>;
    async fn collection_deletion_floor(
        &self,
        c: &Uuid,
    ) -> Result<Option<CollectionDeletionRecord>> {
        if let Some(reply) = self.floor_reply.lock().unwrap().clone() {
            return reply;
        }
        self.inner.collection_deletion_floor(c).await
    }
    async fn begin(&self, c: &Uuid, mode: Mode) -> Result<Self::Txn<'_>> {
        if mode == Mode::Write {
            self.dedup.hit().await;
        }
        self.inner.begin(c, mode).await
    }
    async fn credentials_revoked(&self, d: &Uuid) -> Result<bool> {
        self.inner.credentials_revoked(d).await
    }
    async fn revoke_credentials(&self, d: &Uuid, now: i64) -> Result<()> {
        self.inner.revoke_credentials(d, now).await
    }
}
struct GateObjects {
    inner: MemObjects,
    collection: Uuid,
    streamed: bool,
    publish: Gate,
    cleanup: Gate,
}
impl Archive for GateObjects {
    async fn put_segment(
        &self,
        c: &Uuid,
        t: RetentionTier,
        f: u64,
        to: u64,
        bytes: Vec<u8>,
    ) -> Result<()> {
        self.inner.put_segment(c, t, f, to, bytes).await
    }
    async fn archive_object(&self, c: &Uuid, t: RetentionTier, a: &B32) -> Result<()> {
        self.inner.archive_object(c, t, a).await
    }
}
impl ObjectStore for GateObjects {
    async fn put(&self, k: &str, b: Vec<u8>) -> Result<()> {
        self.inner.put(k, b).await
    }
    async fn put_new(&self, k: &str, b: Vec<u8>) -> Result<bool> {
        let stored = self.inner.put_new(k, b).await?;
        self.publish.hit().await;
        Ok(stored)
    }
    async fn get(&self, k: &str, r: Option<(u64, u64)>) -> Result<Option<Vec<u8>>> {
        self.inner.get(k, r).await
    }
    async fn delete(&self, k: &str) -> Result<()> {
        self.inner.delete(k).await?;
        self.cleanup.hit().await;
        Ok(())
    }
    async fn verified_meta(&self, k: &str) -> Result<Option<Verified>> {
        if !self.streamed {
            return Ok(None);
        }
        let Some(b) = self.inner.get(k, None).await? else {
            return Ok(None);
        };
        Ok(Some(verify_upload(&self.collection, &sha256(&b), &b)?))
    }
}
struct Fixture {
    svc: Service<GateBackend, GateObjects>,
    cp: ControlPlane,
    collection: Uuid,
    owner: Uuid,
    device: Uuid,
    principal: Principal,
}
impl Fixture {
    fn new(streamed: bool) -> Self {
        let cp = ControlPlane::new("object-publication-gone");
        let collection = id16("object-publication-gone/collection");
        let owner = id16("object-publication-gone/owner");
        let d = Device::new("object-publication-gone/device", owner);
        let svc = Service::new(
            GateBackend::default(),
            GateObjects {
                inner: MemObjects::default(),
                collection,
                streamed,
                publish: Gate::default(),
                cleanup: Gate::default(),
            },
            Config {
                roots: vec![cp.root_pk()],
                token_issuers: vec![cp.issuer_pk()],
                url_secret: vec![71; 32],
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
        let h = ready(svc.head(&Principal::ControlPlane, &collection)).unwrap();
        ready(svc.append(
            &Principal::ControlPlane,
            AppendParams {
                collection,
                expect_seq: h.head + 1,
                expect_prev: h.head_chain,
                items: vec![Bytes(cp.policy_item(
                    collection,
                    h.head + 1,
                    h.head_chain,
                    vec![d.enrol(DeviceKind::Desktop)],
                    2,
                ))],
            },
            NOW,
        ))
        .unwrap();
        Self {
            svc,
            cp,
            collection,
            owner,
            device: d.id,
            principal: Principal::Device {
                id: d.id,
                sign_pk: d.pk(),
                collection: Some(collection),
            },
        }
    }
    fn faulty_floor_replies(&self) -> Vec<Result<Option<CollectionDeletionRecord>>> {
        let valid = CollectionDeletionRecord {
            collection: self.collection,
            deletion_id: id16("floor-matrix/deletion"),
            lifecycle_epoch: u64::MAX,
        };
        vec![
            Err(CollectionDeletionRecord::unavailable()),
            Ok(Some(CollectionDeletionRecord {
                collection: id16("floor-matrix/foreign"),
                ..valid
            })),
            Ok(Some(CollectionDeletionRecord {
                collection: mdbn_wire::common::B16([0; 16]),
                ..valid
            })),
            Ok(Some(CollectionDeletionRecord {
                deletion_id: mdbn_wire::common::B16([0; 16]),
                ..valid
            })),
            Ok(Some(CollectionDeletionRecord {
                lifecycle_epoch: 0,
                ..valid
            })),
        ]
    }
    fn inline(&self) -> PutObjectParams {
        let b = object(self.collection, ItemKind::BlobPart, 1, vec![7; 32]);
        let address = sha256(&b);
        PutObjectParams {
            collection: self.collection,
            address,
            kind: ItemKind::BlobPart,
            size: b.len() as u64,
            checksum: address,
            bytes: Some(Bytes(b)),
        }
    }
    fn staged(&self) -> CommitObjectParams {
        let mut q = self.inline();
        let bytes = q.bytes.take().unwrap().0;
        assert_eq!(
            ready(self.svc.put_object(&self.principal, q.clone(), NOW))
                .unwrap()
                .status,
            PutStatus::Upload
        );
        ready(self.svc.objects.put_new(
            &staging_key(&self.collection, &q.address, &self.device),
            bytes,
        ))
        .unwrap();
        CommitObjectParams {
            collection: self.collection,
            address: q.address,
        }
    }
    fn delete(&self, c: Uuid) {
        let floor = self
            .svc
            .backend
            .inner
            .record_collection_deletion(CollectionDeletionRecord {
                collection: c,
                deletion_id: id16("object-publication-gone/deletion"),
                lifecycle_epoch: u64::MAX,
            })
            .unwrap();
        let o = ready(self.svc.call(
            &Principal::ControlPlane,
            "delete_log",
            &Cbor::Map(vec![
                (Cbor::Uint(0), c.to_cbor()),
                (Cbor::Uint(1), floor.deletion_id.to_cbor()),
                (Cbor::Uint(2), Cbor::Uint(floor.lifecycle_epoch)),
            ]),
            NOW,
        ))
        .unwrap();
        assert!(o.notice.unwrap().gone);
    }
    fn state(&self, c: Uuid) -> (CollectionMeta, Vec<ObjectMeta>) {
        ready(async {
            let mut tx = self.svc.backend.inner.begin(&c, Mode::Read).await.unwrap();
            (
                tx.load().await.unwrap().unwrap().meta,
                tx.list_objects(None, 100).await.unwrap(),
            )
        })
    }
}

#[test]
fn deletion_during_raw_or_verified_copy_refuses_metadata_and_preserves_staging() {
    for streamed in [false, true] {
        let f = Fixture::new(streamed);
        let q = f.staged();
        let before = f.state(f.collection).0.used_bytes;
        f.svc.objects.publish.arm();
        let mut commit = std::pin::pin!(f.svc.commit_object(&f.principal, q.clone(), NOW));
        pending(commit.as_mut());
        f.delete(f.collection);
        f.svc.objects.publish.release();
        assert_eq!(ready(commit).unwrap_err().code, Code::Gone);
        let (m, objects) = f.state(f.collection);
        assert_eq!(m.status, Status::Gone);
        assert_eq!(m.used_bytes, before);
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
        // I8 write-once final bytes are NOT blindly deleted on metadata refusal.
        assert!(
            ready(
                f.svc
                    .objects
                    .get(&object_key(&f.collection, &q.address), None)
            )
            .unwrap()
            .is_some()
        );
    }
}

#[test]
fn inline_store_after_delete_refuses_even_if_a_peer_committed_the_same_object() {
    for peer in [false, true] {
        let f = Fixture::new(false);
        let q = f.inline();
        let before = f.state(f.collection).0.used_bytes;
        f.svc.objects.publish.arm();
        let mut put = std::pin::pin!(f.svc.put_object(&f.principal, q.clone(), NOW));
        pending(put.as_mut());
        if peer {
            assert_eq!(
                ready(f.svc.put_object(&f.principal, q.clone(), NOW))
                    .unwrap()
                    .status,
                PutStatus::Stored
            );
        }
        f.delete(f.collection);
        f.svc.objects.publish.release();
        assert_eq!(ready(put).unwrap_err().code, Code::Gone);
        let (m, objects) = f.state(f.collection);
        assert_eq!(m.status, Status::Gone);
        assert_eq!(objects.len(), usize::from(peer));
        assert_eq!(m.used_bytes, before + if peer { q.size } else { 0 });
    }
}

#[test]
fn committed_fast_dedup_after_early_authorization_cannot_override_gone() {
    for put in [false, true] {
        let f = Fixture::new(false);
        let q = f.inline();
        ready(f.svc.put_object(&f.principal, q.clone(), NOW)).unwrap();
        f.svc.backend.dedup.arm();
        if put {
            let mut request = std::pin::pin!(f.svc.put_object(&f.principal, q.clone(), NOW));
            pending(request.as_mut());
            f.delete(f.collection);
            f.svc.backend.dedup.release();
            assert_eq!(ready(request).unwrap_err().code, Code::Gone);
        } else {
            let mut request = std::pin::pin!(f.svc.commit_object(
                &f.principal,
                CommitObjectParams {
                    collection: f.collection,
                    address: q.address
                },
                NOW
            ));
            pending(request.as_mut());
            f.delete(f.collection);
            f.svc.backend.dedup.release();
            assert_eq!(ready(request).unwrap_err().code, Code::Gone);
        }
        assert_eq!(f.state(f.collection).1.len(), 1);
    }
}

#[test]
fn deletion_during_staging_cleanup_refuses_a_late_success_receipt() {
    for streamed in [false, true] {
        let f = Fixture::new(streamed);
        let q = f.staged();
        f.svc.objects.cleanup.arm();
        let mut request = std::pin::pin!(f.svc.commit_object(&f.principal, q, NOW));
        pending(request.as_mut());
        assert_eq!(
            f.state(f.collection).1.len(),
            1,
            "publication preceded cleanup"
        );
        f.delete(f.collection);
        f.svc.objects.cleanup.release();
        assert_eq!(ready(request).unwrap_err().code, Code::Gone);
        assert_eq!(f.state(f.collection).0.status, Status::Gone);
    }
}

#[test]
fn independent_floor_during_copy_refuses_without_collection_gone() {
    for streamed in [false, true] {
        let f = Fixture::new(streamed);
        let q = f.staged();
        let before = f.state(f.collection).0.used_bytes;
        f.svc.objects.publish.arm();
        let mut request = std::pin::pin!(f.svc.commit_object(&f.principal, q.clone(), NOW));
        pending(request.as_mut());
        f.svc
            .backend
            .inner
            .record_collection_deletion(CollectionDeletionRecord {
                collection: f.collection,
                deletion_id: id16("floor-only/copy"),
                lifecycle_epoch: u64::MAX,
            })
            .unwrap();
        f.svc.objects.publish.release();
        assert_eq!(ready(request).unwrap_err().code, Code::Gone);
        let (meta, objects) = f.state(f.collection);
        assert_eq!(
            meta.status,
            Status::Live,
            "registry denial precedes collection Gone"
        );
        assert_eq!(meta.used_bytes, before);
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
#[test]
fn independent_floor_after_early_dedup_lookup_refuses_without_local_gone() {
    let f = Fixture::new(false);
    let q = f.inline();
    ready(f.svc.put_object(&f.principal, q.clone(), NOW)).unwrap();
    f.svc.backend.dedup.arm();
    let mut request = std::pin::pin!(f.svc.put_object(&f.principal, q, NOW));
    pending(request.as_mut());
    f.svc
        .backend
        .inner
        .record_collection_deletion(CollectionDeletionRecord {
            collection: f.collection,
            deletion_id: id16("floor-only/dedup"),
            lifecycle_epoch: 1,
        })
        .unwrap();
    f.svc.backend.dedup.release();
    assert_eq!(ready(request).unwrap_err().code, Code::Gone);
    assert_eq!(f.state(f.collection).0.status, Status::Live);
    assert_eq!(f.state(f.collection).1.len(), 1);
}
#[test]
fn independent_floor_refuses_import_final_live_without_local_gone() {
    let f = Fixture::new(false);
    let c = id16("floor-only/importing");
    ready(f.svc.call(
        &Principal::ControlPlane,
        "import",
        &Cbor::Map(vec![
            (Cbor::Uint(0), c.to_cbor()),
            (
                Cbor::Uint(1),
                Cbor::Array(
                    vec![SeqItem { seq: 1, item: Bytes(f.cp.genesis(c, f.owner)) }.to_cbor()],
                ),
            ),
        ]),
        NOW,
    ))
    .unwrap();
    f.svc
        .backend
        .inner
        .record_collection_deletion(CollectionDeletionRecord {
            collection: c,
            deletion_id: id16("floor-only/restore"),
            lifecycle_epoch: 1,
        })
        .unwrap();
    let result = ready(f.svc.call(
        &Principal::ControlPlane,
        "import",
        &Cbor::Map(vec![
            (Cbor::Uint(0), c.to_cbor()),
            (Cbor::Uint(1), Cbor::Array(vec![])),
            (
                Cbor::Uint(2),
                Cbor::Map(vec![(Cbor::Uint(0), Cbor::Uint(1))]),
            ),
        ]),
        NOW,
    ));
    assert_eq!(result.unwrap_err().code, Code::Gone);
    assert_eq!(f.state(c).0.status, Status::Importing);
}
#[test]
fn cp_importing_object_path_remains_valid_but_late_delete_still_wins() {
    for delete in [false, true] {
        let f = Fixture::new(false);
        let c = id16("object-publication-gone/importing");
        let genesis = f.cp.genesis(c, f.owner);
        ready(f.svc.call(
            &Principal::ControlPlane,
            "import",
            &Cbor::Map(vec![
                (Cbor::Uint(0), c.to_cbor()),
                (
                    Cbor::Uint(1),
                    Cbor::Array(vec![SeqItem { seq: 1, item: Bytes(genesis) }.to_cbor()]),
                ),
            ]),
            NOW,
        ))
        .unwrap();
        assert_eq!(f.state(c).0.status, Status::Importing);
        let b = object(c, ItemKind::BlobPart, 1, vec![19; 32]);
        let params = Cbor::Map(vec![
            (Cbor::Uint(0), c.to_cbor()),
            (Cbor::Uint(1), sha256(&b).to_cbor()),
            (Cbor::Uint(2), Cbor::Uint(ItemKind::BlobPart.value())),
            (Cbor::Uint(3), Cbor::Bytes(b)),
        ]);
        if delete {
            let before = f.state(c).0.used_bytes;
            f.svc.objects.publish.arm();
            let mut request =
                std::pin::pin!(
                    f.svc
                        .call(&Principal::ControlPlane, "import_object", &params, NOW)
                );
            pending(request.as_mut());
            f.delete(c);
            f.svc.objects.publish.release();
            assert_eq!(ready(request).unwrap_err().code, Code::Gone);
            let (m, objects) = f.state(c);
            assert_eq!(m.status, Status::Gone);
            assert_eq!(m.used_bytes, before);
            assert!(objects.is_empty());
        } else {
            ready(
                f.svc
                    .call(&Principal::ControlPlane, "import_object", &params, NOW),
            )
            .unwrap();
            assert_eq!(f.state(c).0.status, Status::Importing);
            assert_eq!(f.state(c).1.len(), 1);
        }
    }
}

#[test]
fn unknown_or_malformed_floor_refuses_before_object_bytes_or_metadata() {
    let f = Fixture::new(false);
    let q = f.inline();
    let before = f.state(f.collection);
    for reply in f.faulty_floor_replies() {
        *f.svc.backend.floor_reply.lock().unwrap() = Some(reply);
        let error = ready(f.svc.put_object(&f.principal, q.clone(), NOW)).unwrap_err();
        assert_eq!(error.code, Code::Unavailable);
        assert_eq!(
            error.reason.as_deref(),
            Some("collection_deletion_floor_unavailable")
        );
        assert_eq!(f.state(f.collection), before);
        assert!(
            ready(
                f.svc
                    .objects
                    .get(&object_key(&f.collection, &q.address), None)
            )
            .unwrap()
            .is_none(),
            "unknown floor must not authorize even raw object storage"
        );
    }
}

#[test]
fn unknown_or_malformed_floor_after_copy_refuses_metadata_and_keeps_staging() {
    for streamed in [false, true] {
        let template = Fixture::new(streamed);
        for reply in template.faulty_floor_replies() {
            let f = Fixture::new(streamed);
            let q = f.staged();
            let before = f.state(f.collection);
            f.svc.objects.publish.arm();
            let mut request = std::pin::pin!(f.svc.commit_object(&f.principal, q.clone(), NOW));
            pending(request.as_mut());
            *f.svc.backend.floor_reply.lock().unwrap() = Some(reply);
            f.svc.objects.publish.release();
            assert_eq!(ready(request).unwrap_err().code, Code::Unavailable);
            assert_eq!(
                f.state(f.collection),
                before,
                "no metadata/quota/Live mutation"
            );
            assert!(
                ready(
                    f.svc
                        .objects
                        .get(&staging_key(&f.collection, &q.address, &f.device), None)
                )
                .unwrap()
                .is_some()
            );
            assert!(
                ready(
                    f.svc
                        .objects
                        .get(&object_key(&f.collection, &q.address), None)
                )
                .unwrap()
                .is_some(),
                "preserve already-copied I8 bytes; not erasure proof"
            );
        }
    }
}

#[test]
fn unknown_or_malformed_floor_after_dedup_wait_cannot_return_exists() {
    let template = Fixture::new(false);
    for put in [false, true] {
        for reply in template.faulty_floor_replies() {
            let f = Fixture::new(false);
            let q = f.inline();
            ready(f.svc.put_object(&f.principal, q.clone(), NOW)).unwrap();
            let before = f.state(f.collection);
            f.svc.backend.dedup.arm();
            let commit = CommitObjectParams {
                collection: f.collection,
                address: q.address,
            };
            let mut request = std::pin::pin!(async {
                if put {
                    f.svc
                        .put_object(&f.principal, q.clone(), NOW)
                        .await
                        .map(|_| ())
                } else {
                    f.svc
                        .commit_object(&f.principal, commit, NOW)
                        .await
                        .map(|_| ())
                }
            });
            pending(request.as_mut());
            *f.svc.backend.floor_reply.lock().unwrap() = Some(reply);
            f.svc.backend.dedup.release();
            assert_eq!(ready(request).unwrap_err().code, Code::Unavailable);
            assert_eq!(f.state(f.collection), before);
        }
    }
}

#[test]
fn floor_unavailable_during_cleanup_refuses_late_success_without_undoing_commit() {
    for streamed in [false, true] {
        let f = Fixture::new(streamed);
        let q = f.staged();
        f.svc.objects.cleanup.arm();
        let mut request = std::pin::pin!(f.svc.commit_object(&f.principal, q, NOW));
        pending(request.as_mut());
        let committed = f.state(f.collection);
        assert_eq!(committed.1.len(), 1);
        *f.svc.backend.floor_reply.lock().unwrap() =
            Some(Err(CollectionDeletionRecord::unavailable()));
        f.svc.objects.cleanup.release();
        assert_eq!(ready(request).unwrap_err().code, Code::Unavailable);
        assert_eq!(
            f.state(f.collection),
            committed,
            "unknown outcome must preserve committed bytes/accounting"
        );
    }
}
