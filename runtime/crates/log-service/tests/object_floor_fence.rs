//! Object publication against the independent deletion floor, adversarially:
//! the floor appears at every possible lookup of an in-flight put/commit, a
//! put arrives after the floor, and requests are replayed. The oracle is the
//! deletion-safety guarantee itself, not the number or position of checks:
//! nothing is published after the floor exists, and a success reply is only
//! ever given for an object published before it.
use std::future::Future;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::task::{Context, Poll, Waker};

use mdbn_log_service::auth::Principal;
use mdbn_log_service::deletion::CollectionDeletionRecord;
use mdbn_log_service::mem::{MemBackend, MemObjects};
use mdbn_log_service::model::{CollectionState, ObjectMeta, SnapshotRow, StoredItem};
use mdbn_log_service::service::staging_key;
use mdbn_log_service::testkit::{ControlPlane, Device, id16, object};
use mdbn_log_service::{Backend, Code, Config, Mode, ObjectStore, Result, Service, Txn, Write};
use mdbn_wire::cbor::Cbor;
use mdbn_wire::common::{B16, B32, Bytes, Uuid};
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
        Poll::Pending => panic!("uncontended future waited"),
    }
}

/// Event clock shared by floor lookups and commits, so the oracle can order
/// "floor written" against "object published" without trusting the service.
#[derive(Default)]
struct Clock {
    tick: AtomicUsize,
    lookups: AtomicUsize,
    /// Write the floor during this (1-based) lookup, before it is answered.
    floor_at_lookup: Mutex<Option<usize>>,
    floor_tick: Mutex<Option<usize>>,
    publish_ticks: Mutex<Vec<usize>>,
}
impl Clock {
    fn next(&self) -> usize {
        self.tick.fetch_add(1, Ordering::SeqCst) + 1
    }
}

#[derive(Default)]
struct FloorBackend {
    inner: MemBackend,
    clock: Clock,
    collection: Mutex<Option<Uuid>>,
    /// Model the Durable Object: commit itself refuses a publishing write set
    /// on the floor, with no await between that lookup and applying it.
    fence_at_commit: bool,
}
impl FloorBackend {
    fn write_floor(&self, c: Uuid) {
        if self.clock.floor_tick.lock().unwrap().is_some() {
            return;
        }
        self.inner
            .record_collection_deletion(CollectionDeletionRecord {
                collection: c,
                deletion_id: id16("floor-fence/deletion"),
                lifecycle_epoch: 7,
            })
            .unwrap();
        *self.clock.floor_tick.lock().unwrap() = Some(self.clock.next());
    }
}
struct CountingTxn<'a> {
    inner: <MemBackend as Backend>::Txn<'a>,
    backend: &'a FloorBackend,
    collection: Uuid,
    publishes: bool,
}
impl Txn for CountingTxn<'_> {
    async fn load(&mut self) -> Result<Option<CollectionState>> {
        self.inner.load().await
    }
    async fn items(&mut self, a: u64, l: u64, m: u64, c: bool) -> Result<Vec<StoredItem>> {
        self.inner.items(a, l, m, c).await
    }
    async fn tokens(&mut self, t: &[B16], now: i64) -> Result<Vec<Option<u64>>> {
        self.inner.tokens(t, now).await
    }
    async fn objects(&mut self, a: &[B32]) -> Result<Vec<Option<ObjectMeta>>> {
        self.inner.objects(a).await
    }
    async fn snapshots(&mut self) -> Result<Vec<SnapshotRow>> {
        self.inner.snapshots().await
    }
    async fn last_seq_at_or_before(&mut self, t: i64) -> Result<u64> {
        self.inner.last_seq_at_or_before(t).await
    }
    async fn entry_bytes_through(&mut self, c: u64) -> Result<u64> {
        self.inner.entry_bytes_through(c).await
    }
    async fn gc_candidates(&mut self, b: i64, l: u64) -> Result<Vec<ObjectMeta>> {
        self.inner.gc_candidates(b, l).await
    }
    async fn snapshot_refs(&mut self, s: u64) -> Result<Vec<B32>> {
        self.inner.snapshot_refs(s).await
    }
    async fn list_objects(&mut self, a: Option<B32>, l: u64) -> Result<Vec<ObjectMeta>> {
        self.inner.list_objects(a, l).await
    }
    fn write(&mut self, w: Write) {
        self.publishes |= matches!(w, Write::PutObject(ref m) if m.committed);
        self.inner.write(w);
    }
    async fn commit(self) -> Result<()> {
        let publishes = self.publishes;
        if publishes
            && self.backend.fence_at_commit
            && self
                .backend
                .collection_deletion_floor(&self.collection)
                .await?
                .is_some()
        {
            return Err(mdbn_log_service::ServiceError::new(Code::Gone));
        }
        self.inner.commit().await?;
        if publishes {
            let clock = &self.backend.clock;
            let t = clock.next();
            clock.publish_ticks.lock().unwrap().push(t);
        }
        Ok(())
    }
}
impl Backend for FloorBackend {
    type Txn<'a> = CountingTxn<'a>;
    async fn begin(&self, c: &Uuid, mode: Mode) -> Result<CountingTxn<'_>> {
        Ok(CountingTxn {
            inner: self.inner.begin(c, mode).await?,
            backend: self,
            collection: *c,
            publishes: false,
        })
    }
    fn fences_deletion_floor_at_commit(&self) -> bool {
        self.fence_at_commit
    }
    async fn collection_deletion_floor(
        &self,
        c: &Uuid,
    ) -> Result<Option<CollectionDeletionRecord>> {
        let n = self.clock.lookups.fetch_add(1, Ordering::SeqCst) + 1;
        if *self.clock.floor_at_lookup.lock().unwrap() == Some(n)
            && *self.collection.lock().unwrap() == Some(*c)
        {
            self.write_floor(*c);
        }
        self.clock.next();
        self.inner.collection_deletion_floor(c).await
    }
    async fn credentials_revoked(&self, d: &Uuid) -> Result<bool> {
        self.inner.credentials_revoked(d).await
    }
    async fn revoke_credentials(&self, d: &Uuid, now: i64) -> Result<()> {
        self.inner.revoke_credentials(d, now).await
    }
}

struct Fixture {
    svc: Service<FloorBackend, MemObjects>,
    collection: Uuid,
    device: Uuid,
    principal: Principal,
}
impl Fixture {
    fn new() -> Self {
        Self::with(false)
    }
    fn with(fence_at_commit: bool) -> Self {
        let cp = ControlPlane::new("floor-fence");
        let collection = id16("floor-fence/collection");
        let owner = id16("floor-fence/owner");
        let d = Device::new("floor-fence/device", owner);
        let svc = Service::new(
            FloorBackend {
                fence_at_commit,
                ..Default::default()
            },
            MemObjects::default(),
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
        *svc.backend.collection.lock().unwrap() = Some(collection);
        Self {
            svc,
            collection,
            device: d.id,
            principal: Principal::Device {
                id: d.id,
                sign_pk: d.pk(),
                collection: Some(collection),
            },
        }
    }
    fn inline(&self, fill: u8) -> PutObjectParams {
        let b = object(self.collection, ItemKind::BlobPart, 1, vec![fill; 32]);
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
    /// Stage an upload the way a direct-upload client does, then return the commit.
    fn staged(&self, fill: u8) -> CommitObjectParams {
        let mut q = self.inline(fill);
        let bytes = q.bytes.take().unwrap().0;
        let r = ready(self.svc.put_object(&self.principal, q.clone(), NOW)).unwrap();
        assert_eq!(r.status, PutStatus::Upload);
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
    fn committed(&self) -> Vec<ObjectMeta> {
        ready(async {
            let mut tx = self
                .svc
                .backend
                .inner
                .begin(&self.collection, Mode::Read)
                .await
                .unwrap();
            tx.list_objects(None, 100).await.unwrap()
        })
    }
    fn used_bytes(&self) -> u64 {
        ready(async {
            let mut tx = self
                .svc
                .backend
                .inner
                .begin(&self.collection, Mode::Read)
                .await
                .unwrap();
            tx.load().await.unwrap().unwrap().meta.used_bytes
        })
    }
    fn arm(&self, at: usize) {
        self.svc.backend.clock.lookups.store(0, Ordering::SeqCst);
        *self.svc.backend.clock.floor_at_lookup.lock().unwrap() = Some(at);
    }
    fn lookups(&self) -> usize {
        self.svc.backend.clock.lookups.load(Ordering::SeqCst)
    }
    /// The guarantee: no publication at or after the floor, and success only
    /// for a publication strictly before it.
    fn assert_safe(&self, ok: bool) {
        let clock = &self.svc.backend.clock;
        let floor = *clock.floor_tick.lock().unwrap();
        let publishes = clock.publish_ticks.lock().unwrap().clone();
        if let Some(floor) = floor {
            assert!(
                publishes.iter().all(|t| *t < floor),
                "published after the floor: {publishes:?} vs floor {floor}"
            );
            assert!(!ok, "success reply after the floor was observable");
        } else {
            assert!(ok);
        }
    }
}

#[test]
fn deletion_racing_an_inline_put_at_every_floor_lookup_never_publishes_after_it() {
    // Measure the request once, then write the floor during each of its lookups.
    let probe = Fixture::new();
    probe.arm(usize::MAX);
    ready(probe.svc.put_object(&probe.principal, probe.inline(3), NOW)).unwrap();
    let lookups = probe.lookups();
    // The deletion-floor registry is global: one put is not nine round trips.
    assert!(lookups <= 3, "inline put made {lookups} floor lookups");
    for at in 1..=lookups + 1 {
        let f = Fixture::new();
        let before = f.used_bytes();
        f.arm(at);
        let r = ready(f.svc.put_object(&f.principal, f.inline(3), NOW));
        if let Err(e) = &r {
            assert_eq!(e.code, Code::Gone, "lookup {at}");
        }
        f.assert_safe(r.is_ok());
        if f.committed().is_empty() {
            assert_eq!(f.used_bytes(), before, "quota charged without publication");
        }
    }
}

#[test]
fn a_commit_fenced_inline_put_answers_at_its_commit_without_another_floor_lookup() {
    // One lookup before the R2 write, one inside the publishing commit. A third
    // is a further registry round trip on every inline put and decides nothing.
    let probe = Fixture::with(true);
    probe.arm(usize::MAX);
    let r = ready(probe.svc.put_object(&probe.principal, probe.inline(3), NOW)).unwrap();
    assert_eq!(r.status, PutStatus::Stored);
    assert_eq!(probe.lookups(), 2, "commit-fenced inline put floor lookups");
    for at in 1..=3 {
        let f = Fixture::with(true);
        let before = f.used_bytes();
        f.arm(at);
        let r = ready(f.svc.put_object(&f.principal, f.inline(3), NOW));
        if let Err(e) = &r {
            assert_eq!(e.code, Code::Gone, "lookup {at}");
        }
        f.assert_safe(r.is_ok());
        if f.committed().is_empty() {
            assert_eq!(f.used_bytes(), before, "quota charged without publication");
        }
    }
    // A dedup reply was not published by this request: it still reads the floor.
    let f = Fixture::with(true);
    let q = f.inline(4);
    ready(f.svc.put_object(&f.principal, q.clone(), NOW)).unwrap();
    f.svc.backend.write_floor(f.collection);
    let e = ready(f.svc.put_object(&f.principal, q, NOW)).unwrap_err();
    assert_eq!(e.code, Code::Gone);
}

#[test]
fn deletion_racing_a_staged_commit_at_every_floor_lookup_never_publishes_after_it() {
    let probe = Fixture::new();
    let q = probe.staged(5);
    probe.arm(usize::MAX);
    assert!(ready(probe.svc.commit_object(&probe.principal, q, NOW)).unwrap());
    let lookups = probe.lookups();
    assert!(lookups <= 3, "commit made {lookups} floor lookups");
    for at in 1..=lookups + 1 {
        let f = Fixture::new();
        let q = f.staged(5);
        f.arm(at);
        let r = ready(f.svc.commit_object(&f.principal, q.clone(), NOW));
        if let Err(e) = &r {
            assert_eq!(e.code, Code::Gone, "lookup {at}");
        }
        f.assert_safe(matches!(r, Ok(true)));
    }
}

#[test]
fn put_after_the_floor_is_refused_on_every_path_without_effects() {
    let f = Fixture::new();
    let published = f.inline(9);
    ready(f.svc.put_object(&f.principal, published.clone(), NOW)).unwrap();
    let staged = f.staged(10);
    f.svc.backend.write_floor(f.collection);
    let used = f.used_bytes();
    let objects = f.committed();
    // Fresh inline bytes, a direct-upload request, the staged commit, and a
    // dedup of an object published before the floor: all Gone.
    for r in [
        ready(f.svc.put_object(&f.principal, f.inline(11), NOW)).map(|_| ()),
        ready(f.svc.put_object(
            &f.principal,
            {
                let mut q = f.inline(12);
                q.bytes = None;
                q
            },
            NOW,
        ))
        .map(|_| ()),
        ready(f.svc.commit_object(&f.principal, staged, NOW)).map(|_| ()),
        ready(f.svc.put_object(&f.principal, published, NOW)).map(|_| ()),
    ] {
        assert_eq!(r.unwrap_err().code, Code::Gone);
    }
    assert_eq!(f.committed(), objects);
    assert_eq!(f.used_bytes(), used);
    f.assert_safe(false);
}

#[test]
fn replayed_and_concurrent_duplicate_puts_publish_once_and_replay_after_floor_is_refused() {
    let f = Fixture::new();
    let q = f.inline(21);
    let before = f.used_bytes();
    // Two identical puts in flight together (parallel client puts, or a client
    // retry racing its first attempt), then a later replay of the same frame.
    let (a, b) = block_on(async {
        futures_join(
            f.svc.put_object(&f.principal, q.clone(), NOW),
            f.svc.put_object(&f.principal, q.clone(), NOW),
        )
        .await
    });
    let statuses = [a.unwrap().status, b.unwrap().status];
    assert!(statuses.contains(&PutStatus::Stored));
    let replay = ready(f.svc.put_object(&f.principal, q.clone(), NOW)).unwrap();
    assert_eq!(replay.status, PutStatus::Exists);
    assert_eq!(f.committed().len(), 1);
    assert_eq!(f.used_bytes(), before + q.size, "quota charged once");
    // A commit replay for the already-published address is idempotent too.
    let commit = CommitObjectParams {
        collection: f.collection,
        address: q.address,
    };
    assert!(ready(f.svc.commit_object(&f.principal, commit.clone(), NOW)).unwrap());
    f.svc.backend.write_floor(f.collection);
    assert_eq!(
        ready(f.svc.put_object(&f.principal, q, NOW))
            .unwrap_err()
            .code,
        Code::Gone
    );
    assert_eq!(
        ready(f.svc.commit_object(&f.principal, commit, NOW))
            .unwrap_err()
            .code,
        Code::Gone
    );
    assert_eq!(f.committed().len(), 1);
    assert_eq!(f.svc.backend.clock.publish_ticks.lock().unwrap().len(), 1);
}

/// Drive a future that may wait on the collection lock held by its sibling.
fn block_on<T>(f: impl Future<Output = T>) -> T {
    let mut f = std::pin::pin!(f);
    for _ in 0..10_000 {
        if let Poll::Ready(v) = f.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
            return v;
        }
    }
    panic!("concurrent duplicate puts never completed")
}

/// Poll two futures to completion on one thread (no runtime dependency).
async fn futures_join<A: Future, B: Future>(a: A, b: B) -> (A::Output, B::Output) {
    let mut a = std::pin::pin!(a);
    let mut b = std::pin::pin!(b);
    let (mut ra, mut rb) = (None, None);
    std::future::poll_fn(|cx| {
        if ra.is_none()
            && let Poll::Ready(v) = a.as_mut().poll(cx)
        {
            ra = Some(v);
        }
        if rb.is_none()
            && let Poll::Ready(v) = b.as_mut().poll(cx)
        {
            rb = Some(v);
        }
        if ra.is_some() && rb.is_some() {
            Poll::Ready(())
        } else {
            Poll::Pending
        }
    })
    .await;
    (ra.unwrap(), rb.unwrap())
}
