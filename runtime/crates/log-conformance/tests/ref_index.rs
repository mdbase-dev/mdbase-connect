//! Snapshot ref-index objects (`sealed-envelope.md` §4.3, `log-service-api.md`
//! §7): `put_snapshot` expands every index it names into the snapshot's stored
//! refs, so garbage collection retains everything reachable through an index,
//! frees what no retained snapshot reaches any more, and keeps `used_bytes`
//! exact. Depth-2, malformed, oversized and incomplete indices are refused.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use mdbn_log_conformance::client::{map, random_uuid};
use mdbn_log_conformance::fixture::CP_LABEL;
use mdbn_log_server::testkit_config;
use mdbn_log_service::auth::Principal;
use mdbn_log_service::error::{Code, ServiceError};
use mdbn_log_service::mem::{MemBackend, MemObjects};
use mdbn_log_service::testkit::{ControlPlane, Device, filler, id16, object};
use mdbn_log_service::{Backend, Mode, Service, Txn};
use mdbn_wire::cbor::Cbor;
use mdbn_wire::common::{B32, Bytes, Uuid};
use mdbn_wire::envelope::ItemKind;
use mdbn_wire::hash::{chain_hash, sha256};
use mdbn_wire::log_service::{
    AppendParams, AppendResult, HasObjectsParams, PutObjectParams, PutSnapshotParams,
};
use mdbn_wire::policy::DeviceKind;
use mdbn_wire::ref_index::{
    MAX_REF_INDEX_ENTRIES, MAX_REF_INDICES, pack_ref_indices, ref_index_item,
};
use mdbn_wire::schema::Wire;

const DAY: i64 = 24 * 60 * 60 * 1000;
const T0: i64 = 1_800_000_000_000;

type Svc = Service<MemBackend, MemObjects>;

fn dev(d: &Device) -> Principal {
    Principal::Device {
        id: d.id,
        sign_pk: d.pk(),
        collection: None,
    }
}

struct Fx {
    svc: Svc,
    c: Uuid,
    a: Device,
    head: u64,
    chain: B32,
}

impl Fx {
    async fn new() -> Fx {
        let svc = Service::new(
            MemBackend::default(),
            MemObjects::default(),
            testkit_config(CP_LABEL, "http://unused"),
        );
        let cp = ControlPlane::new(CP_LABEL);
        let c = random_uuid();
        let owner = random_uuid();
        let a = Device::new(&format!("{}/a", c.to_hex()), owner);
        let b = Device::new(&format!("{}/b", c.to_hex()), owner);
        let cpp = Principal::ControlPlane;
        let genesis = cp.genesis(c, owner);
        svc.call(
            &cpp,
            "create_log",
            &map(vec![(0, c.to_cbor()), (1, Cbor::Bytes(genesis.clone()))]),
            T0,
        )
        .await
        .unwrap();
        svc.call(
            &cpp,
            "set_quota",
            &map(vec![
                (0, c.to_cbor()),
                (
                    1,
                    Cbor::Array(vec![
                        Cbor::Uint(1 << 40),
                        Cbor::Uint(1 << 30),
                        Cbor::Uint(1 << 40),
                        Cbor::Uint(1 << 30),
                    ]),
                ),
            ]),
            T0,
        )
        .await
        .unwrap();
        let mut fx = Fx {
            svc,
            c,
            a,
            head: 1,
            chain: chain_hash(&genesis),
        };
        let pol = cp.policy_item(
            c,
            2,
            fx.chain,
            vec![
                fx.a.enrol(DeviceKind::Desktop),
                b.enrol(DeviceKind::Desktop),
            ],
            2,
        );
        fx.append(&cpp, vec![pol]).await.unwrap();
        let rk = fx.a.rekey(c, 3, fx.chain, 0, &[fx.a.id, b.id]);
        fx.append(&dev(&fx.a), vec![rk]).await.unwrap();
        fx
    }

    async fn append(&mut self, p: &Principal, items: Vec<Vec<u8>>) -> Result<(), ServiceError> {
        let n = items.len() as u64;
        let last = chain_hash(items.last().unwrap());
        let out = self
            .svc
            .call(
                p,
                "append",
                &AppendParams {
                    collection: self.c,
                    expect_seq: self.head + 1,
                    expect_prev: self.chain,
                    items: items.into_iter().map(Bytes).collect(),
                }
                .to_cbor(),
                T0,
            )
            .await?;
        assert!(matches!(
            AppendResult::from_cbor(&out.result).unwrap(),
            AppendResult::Appended(_)
        ));
        self.head += n;
        self.chain = last;
        Ok(())
    }

    async fn entry(&mut self, refs: Option<Vec<B32>>) -> Result<(), ServiceError> {
        let e = self.a.entry(
            self.c,
            self.head + 1,
            self.chain,
            1,
            id16(&format!("{}/{}", self.c.to_hex(), self.head)),
            refs,
            filler("e", 50),
        );
        let p = dev(&self.a);
        self.append(&p, vec![e]).await
    }

    async fn put(&self, kind: ItemKind, address: B32, bytes: Vec<u8>) -> Result<(), ServiceError> {
        self.svc
            .call(
                &dev(&self.a),
                "put_object",
                &PutObjectParams {
                    collection: self.c,
                    address,
                    kind,
                    size: bytes.len() as u64,
                    checksum: sha256(&bytes),
                    bytes: Some(Bytes(bytes)),
                }
                .to_cbor(),
                T0,
            )
            .await
            .map(|_| ())
    }

    /// A blob part, by label.
    async fn blob(&self, label: &str) -> B32 {
        let a = B32(sha256(label.as_bytes()).0);
        self.put(
            ItemKind::BlobPart,
            a,
            object(self.c, ItemKind::BlobPart, 1, filler(label, 64)),
        )
        .await
        .unwrap();
        a
    }

    /// Upload the ref-index objects listing `refs`; their addresses.
    async fn indices(&self, refs: &[B32]) -> Vec<B32> {
        let mut refs = refs.to_vec();
        refs.sort();
        refs.dedup();
        let mut out = Vec::new();
        for (a, bytes) in pack_ref_indices(self.c, &refs).unwrap() {
            self.put(ItemKind::RefIndex, a, bytes).await.unwrap();
            out.push(a);
        }
        out
    }

    /// Register a snapshot at the head naming `refs` (plus a fresh manifest).
    async fn snapshot(&mut self, refs: Vec<B32>) -> Result<B32, ServiceError> {
        self.entry(None).await.unwrap();
        let manifest = self.a.manifest(
            self.c,
            1,
            refs.clone(),
            filler(&format!("m{}", self.head), 64),
        );
        let ma = sha256(&manifest);
        self.put(ItemKind::Manifest, ma, manifest).await.unwrap();
        let r = self
            .svc
            .call(
                &dev(&self.a),
                "put_snapshot",
                &PutSnapshotParams {
                    collection: self.c,
                    seq: self.head,
                    manifest: ma,
                    refs,
                }
                .to_cbor(),
                T0,
            )
            .await?;
        assert_eq!(r.result, map(vec![(0, Cbor::Bool(true))]));
        Ok(ma)
    }

    async fn present(&self, addresses: &[B32]) -> Vec<bool> {
        let mut out = Vec::new();
        for part in addresses.chunks(1024) {
            out.extend(
                self.svc
                    .has_objects(
                        &dev(&self.a),
                        HasObjectsParams {
                            collection: self.c,
                            addresses: part.to_vec(),
                        },
                    )
                    .await
                    .unwrap()
                    .present,
            );
        }
        out
    }

    async fn gc(&self, now: i64) -> u64 {
        let mut total = 0;
        loop {
            let r = self
                .svc
                .call(
                    &Principal::ControlPlane,
                    "gc",
                    &map(vec![(0, self.c.to_cbor())]),
                    now,
                )
                .await
                .unwrap();
            let Cbor::Map(m) = r.result else { panic!() };
            let Cbor::Uint(n) = m[0].1 else { panic!() };
            if n == 0 {
                return total;
            }
            total += n;
        }
    }

    /// `used_bytes`, and the exact sum of committed object sizes and item bytes.
    async fn accounting(&self) -> (u64, u64) {
        let mut tx = self.svc.backend.begin(&self.c, Mode::Read).await.unwrap();
        let st = tx.load().await.unwrap().unwrap();
        let mut objects = 0;
        let mut after = None;
        loop {
            let page = tx.list_objects(after, 1000).await.unwrap();
            let Some(last) = page.last() else { break };
            after = Some(last.address);
            objects += page.iter().map(|o| o.size).sum::<u64>();
        }
        let items: u64 = tx
            .items(0, u64::MAX, u64::MAX, false)
            .await
            .unwrap()
            .iter()
            .map(|i| i.bytes.len() as u64)
            .sum();
        (st.meta.used_bytes, objects + items)
    }
}

fn reason(e: &ServiceError) -> (Code, Option<&str>, Option<&str>) {
    (e.code, e.reason.as_deref(), e.message.as_deref())
}

#[tokio::test]
async fn gc_follows_ref_indices_and_accounting_stays_exact() {
    let mut fx = Fx::new().await;
    // 20,000 members: more than two indices' worth, far past one request's
    // direct refs budget.
    let mut members = Vec::new();
    for i in 0..20_000 {
        members.push(fx.blob(&format!("m{i}")).await);
    }
    members.sort();
    let orphan = fx.blob("orphan").await;
    let idx1 = fx.indices(&members).await;
    assert_eq!(idx1.len(), 20_000usize.div_ceil(MAX_REF_INDEX_ENTRIES));
    let m1 = fx.snapshot(idx1.clone()).await.unwrap();

    let (used, exact) = fx.accounting().await;
    assert_eq!(used, exact, "used_bytes before GC");
    // Only the orphan is unreferenced.
    assert_eq!(fx.gc(T0 + 2 * DAY).await, 1);
    let (used, exact) = fx.accounting().await;
    assert_eq!(used, exact, "used_bytes after GC");
    assert!(fx.present(&members).await.iter().all(|p| *p));
    assert!(fx.present(&idx1).await.iter().all(|p| *p));
    assert_eq!(fx.present(&[orphan, m1]).await, vec![false, true]);

    // Two later snapshots drop the first 100 members; the first snapshot is no
    // longer retained, so those members and its indices become garbage.
    let kept = members[100..].to_vec();
    let idx2 = fx.indices(&kept).await;
    fx.snapshot(idx2.clone()).await.unwrap();
    fx.snapshot(idx2.clone()).await.unwrap();
    let stale_indices = idx1.iter().filter(|a| !idx2.contains(a)).count() as u64;
    assert_eq!(fx.gc(T0 + 4 * DAY).await, 100 + stale_indices + 1);
    let (used, exact) = fx.accounting().await;
    assert_eq!(used, exact, "used_bytes after second GC");
    assert!(fx.present(&members[..100]).await.iter().all(|p| !*p));
    assert!(fx.present(&kept).await.iter().all(|p| *p));
    assert!(fx.present(&idx2).await.iter().all(|p| *p));
}

#[tokio::test]
async fn bad_ref_indices_are_refused() {
    let mut fx = Fx::new().await;
    let blob = fx.blob("member").await;
    let chunk_bytes = object(fx.c, ItemKind::Chunk, 1, filler("chunk", 64));
    let chunk = sha256(&chunk_bytes);
    fx.put(ItemKind::Chunk, chunk, chunk_bytes).await.unwrap();
    let good = fx.indices(&[blob, chunk]).await;

    // Depth 2: an index listing another index.
    let deep = fx.indices(&good).await;
    let e = fx.snapshot(deep.clone()).await.unwrap_err();
    assert_eq!(
        reason(&e),
        (Code::Invalid, Some("kind"), Some("ref-index depth"))
    );

    // A missing member.
    let ghost = B32([0xee; 32]);
    let mut with_ghost = vec![blob, ghost];
    with_ghost.sort();
    let gi = fx.indices(&with_ghost).await;
    let e = fx.snapshot(gi).await.unwrap_err();
    assert_eq!(e.code, Code::RefsMissing);
    assert_eq!(
        e.details,
        Some(Cbor::Array(vec![Cbor::Bytes(ghost.0.to_vec())]))
    );

    // A member that is a manifest.
    let manifest = fx.a.manifest(fx.c, 1, vec![blob], filler("mm", 10));
    let ma = sha256(&manifest);
    fx.put(ItemKind::Manifest, ma, manifest).await.unwrap();
    let mi = fx.indices(&[ma]).await;
    let e = fx.snapshot(mi).await.unwrap_err();
    assert_eq!(
        reason(&e),
        (Code::Invalid, Some("kind"), Some("ref-index member kind"))
    );

    // More indices than a snapshot may name.
    let mut many = Vec::new();
    for i in 0..=MAX_REF_INDICES {
        let b = fx.blob(&format!("many{i}")).await;
        many.extend(fx.indices(&[b]).await);
    }
    let e = fx.snapshot(many).await.unwrap_err();
    assert_eq!(e.code, Code::TooLarge);

    // Malformed uploads: unsorted, oversized, ragged, signed.
    let mut item = ref_index_item(fx.c, &[blob]).unwrap();
    item.body = Bytes(
        mdbn_wire::ref_index::RefIndexPayload {
            addresses: Bytes([chunk.0, blob.0].concat()),
        }
        .to_bytes()
        .unwrap(),
    );
    let order_ok = chunk < blob;
    let bytes = item.to_bytes().unwrap();
    let r = fx.put(ItemKind::RefIndex, sha256(&bytes), bytes).await;
    assert_eq!(r.is_ok(), order_ok, "only strictly ascending addresses");
    let over: Vec<u8> = (0..=MAX_REF_INDEX_ENTRIES as u64)
        .flat_map(|i| {
            let mut a = [0u8; 32];
            a[..8].copy_from_slice(&i.to_be_bytes());
            a
        })
        .collect();
    item.body = Bytes(
        mdbn_wire::ref_index::RefIndexPayload {
            addresses: Bytes(over),
        }
        .to_bytes()
        .unwrap(),
    );
    let bytes = item.to_bytes().unwrap();
    let e = fx
        .put(ItemKind::RefIndex, sha256(&bytes), bytes)
        .await
        .unwrap_err();
    assert_eq!(reason(&e).1, Some("ref_index"));
    let mut signed = ref_index_item(fx.c, &[blob]).unwrap();
    signed.signer = Some(fx.a.id);
    let bytes = signed.to_bytes().unwrap();
    let e = fx
        .put(ItemKind::RefIndex, sha256(&bytes), bytes)
        .await
        .unwrap_err();
    assert_eq!(e.code, Code::Invalid);

    // An entry may not reference an index: only snapshots are expanded.
    let e = fx.entry(Some(good.clone())).await.unwrap_err();
    assert_eq!(
        reason(&e),
        (
            Code::Invalid,
            Some("kind"),
            Some("ref-index outside a snapshot")
        )
    );

    // The good index still registers, and keeps both members.
    fx.snapshot(good).await.unwrap();
    fx.gc(T0 + 2 * DAY).await;
    assert_eq!(fx.present(&[blob, chunk]).await, vec![true, true]);
}
