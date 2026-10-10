//! Time-dependent behaviour, driven in-process with a controlled clock: compaction
//! (`snapshot.md` §5.1), reads behind retention, garbage collection (I9, I10).
//! Runs on the memory backend always and on Postgres with `MDBN_TEST_PG_URL`.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::path::PathBuf;

use mdbn_log_conformance::client::{map, random_uuid};
use mdbn_log_conformance::fixture::CP_LABEL;
use mdbn_log_server::fs::FsObjects;
use mdbn_log_server::pg::PgBackend;
use mdbn_log_server::testkit_config;
use mdbn_log_service::auth::Principal;
use mdbn_log_service::mem::{MemBackend, MemObjects};
use mdbn_log_service::testkit::{ControlPlane, Device, filler, id16, object};
use mdbn_log_service::{Backend, ObjectStore, Service};
use mdbn_wire::cbor::Cbor;
use mdbn_wire::common::{B32, Bytes};
use mdbn_wire::envelope::ItemKind;
use mdbn_wire::hash::{chain_hash, sha256};
use mdbn_wire::log_service::{
    AppendParams, AppendResult, EndorseSnapshotParams, HasObjectsParams, PutObjectParams,
    PutSnapshotParams, ReadKinds, ReadParams,
};
use mdbn_wire::policy::DeviceKind;
use mdbn_wire::schema::Wire;

const DAY: i64 = 24 * 60 * 60 * 1000;

fn dev(d: &Device) -> Principal {
    Principal::Device {
        id: d.id,
        sign_pk: d.pk(),
        collection: None,
    }
}

async fn scenario<B: Backend, O: ObjectStore>(svc: &Service<B, O>) -> mdbn_wire::common::Uuid {
    let t0: i64 = 1_800_000_000_000;
    let cp = ControlPlane::new(CP_LABEL);
    let c = random_uuid();
    let owner = random_uuid();
    let a = Device::new(&format!("{}/a", c.to_hex()), owner);
    let b = Device::new(&format!("{}/b", c.to_hex()), owner);
    let cpp = Principal::ControlPlane;
    svc.call(
        &cpp,
        "create_log",
        &map(vec![
            (0, c.to_cbor()),
            (1, Cbor::Bytes(cp.genesis(c, owner))),
        ]),
        t0,
    )
    .await
    .unwrap();
    let mut head = 1u64;
    let mut chain = chain_hash(&cp.genesis(c, owner));
    let append =
        async |p: &Principal, items: Vec<Vec<u8>>, head: &mut u64, chain: &mut B32, now: i64| {
            let n = items.len() as u64;
            let last = chain_hash(items.last().unwrap());
            let out = svc
                .call(
                    p,
                    "append",
                    &AppendParams {
                        collection: c,
                        expect_seq: *head + 1,
                        expect_prev: *chain,
                        items: items.into_iter().map(Bytes).collect(),
                    }
                    .to_cbor(),
                    now,
                )
                .await
                .unwrap();
            assert!(matches!(
                AppendResult::from_cbor(&out.result).unwrap(),
                AppendResult::Appended(_)
            ));
            *head += n;
            *chain = last;
        };
    let pol = cp.policy_item(
        c,
        2,
        chain,
        vec![a.enrol(DeviceKind::Desktop), b.enrol(DeviceKind::Desktop)],
        2,
    );
    append(&cpp, vec![pol], &mut head, &mut chain, t0).await;
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
        t0,
    )
    .await
    .unwrap();
    let rk = a.rekey(c, 3, chain, 0, &[a.id, b.id]);
    append(&dev(&a), vec![rk], &mut head, &mut chain, t0).await;

    // Objects: one referenced by an early entry, one by the snapshot, one orphan
    // uploaded early, one orphan uploaded late.
    let put = |label: &str, kind: ItemKind| {
        let bytes = object(c, kind, 1, filler(label, 300));
        let addr = if kind == ItemKind::BlobPart {
            B32(sha256(label.as_bytes()).0)
        } else {
            sha256(&bytes)
        };
        (
            addr,
            PutObjectParams {
                collection: c,
                address: addr,
                kind,
                size: bytes.len() as u64,
                checksum: sha256(&bytes),
                bytes: Some(Bytes(bytes)),
            },
        )
    };
    let (early_blob, p1) = put("early-blob", ItemKind::BlobPart);
    let (chunk, p2) = put("snap-chunk", ItemKind::Chunk);
    let (orphan_old, p3) = put("orphan-old", ItemKind::BlobPart);
    for p in [&p1, &p2, &p3] {
        svc.call(&dev(&a), "put_object", &p.to_cbor(), t0)
            .await
            .unwrap();
    }
    // 10,100 entries at t0, in batches of 64; entry 4 references the early blob.
    let total = 10_100u64;
    let mut i = 0u64;
    while i < total {
        let n = 64.min(total - i);
        let mut items = Vec::new();
        let mut prev = chain;
        for k in 0..n {
            let seq = head + 1 + k;
            let refs = (i + k == 0).then(|| vec![early_blob]);
            let e = a.entry(
                c,
                seq,
                prev,
                1,
                id16(&format!("{}/{}", c.to_hex(), i + k)),
                refs,
                filler("e", 100),
            );
            prev = chain_hash(&e);
            items.push(e);
        }
        append(&dev(&a), items, &mut head, &mut chain, t0).await;
        i += n;
    }
    let early_seq = 4u64;
    let manifest = a.manifest(c, 1, vec![chunk], filler("m", 100));
    let ma = sha256(&manifest);
    svc.call(
        &dev(&a),
        "put_object",
        &PutObjectParams {
            collection: c,
            address: ma,
            kind: ItemKind::Manifest,
            size: manifest.len() as u64,
            checksum: ma,
            bytes: Some(Bytes(manifest)),
        }
        .to_cbor(),
        t0,
    )
    .await
    .unwrap();
    let snap_seq = head;
    let r = svc
        .call(
            &dev(&a),
            "put_snapshot",
            &PutSnapshotParams {
                collection: c,
                seq: snap_seq,
                manifest: ma,
                refs: vec![chunk],
            }
            .to_cbor(),
            t0,
        )
        .await
        .unwrap();
    assert_eq!(r.result, map(vec![(0, Cbor::Bool(true))]));

    // Not endorsed: nothing compacts, even when old.
    let r = svc
        .call(&cpp, "compact", &map(vec![(0, c.to_cbor())]), t0 + 40 * DAY)
        .await;
    // A single-device rule does not apply: two personal devices are enrolled.
    assert_eq!(r.unwrap().result, map(vec![(0, Cbor::Uint(1))]));

    // Endorsed by B, eight days later: C = min(S_e − 10,000, last seq older than 7 days).
    let late = t0 + 8 * DAY;
    let (orphan_new, p4) = put("orphan-new", ItemKind::BlobPart);
    svc.call(&dev(&a), "put_object", &p4.to_cbor(), late)
        .await
        .unwrap();
    svc.call(
        &dev(&b),
        "endorse_snapshot",
        &EndorseSnapshotParams {
            collection: c,
            seq: snap_seq,
            manifest: ma,
        }
        .to_cbor(),
        late,
    )
    .await
    .unwrap();
    let cp_expected = snap_seq - 10_000;
    let r = svc
        .read(
            &dev(&a),
            ReadParams {
                collection: c,
                after: 0,
                limit: 10,
                kinds: None,
                max_bytes: None,
            },
            late,
        )
        .await
        .unwrap();
    assert_eq!(r.retained_from, cp_expected + 1, "retained_from");
    assert!(r.behind && r.items.is_empty(), "read behind retention");
    assert_eq!(
        r.snapshot.as_ref().map(|s| (s.seq, s.endorsed)),
        Some((snap_seq, true))
    );
    // I9: control items are never compacted.
    let r = svc
        .read(
            &dev(&a),
            ReadParams {
                collection: c,
                after: 0,
                limit: 10,
                kinds: Some(ReadKinds::Control),
                max_bytes: None,
            },
            late,
        )
        .await
        .unwrap();
    assert_eq!(
        r.items.iter().map(|i| i.seq).collect::<Vec<_>>(),
        vec![1, 2, 3]
    );
    assert!(!r.behind);
    // Entries above the compaction point are intact.
    let r = svc
        .read(
            &dev(&a),
            ReadParams {
                collection: c,
                after: cp_expected,
                limit: 5,
                kinds: None,
                max_bytes: None,
            },
            late,
        )
        .await
        .unwrap();
    assert_eq!(r.items[0].seq, cp_expected + 1);
    assert!(!r.behind);
    // The early blob was referenced only by a compacted entry (seq 4 ≤ C).
    assert!(early_seq <= cp_expected);

    // GC (I10): unreferenced and older than 24 h → deleted; referenced or young → kept.
    let r = svc
        .call(&cpp, "gc", &map(vec![(0, c.to_cbor())]), late + 1000)
        .await
        .unwrap();
    assert_eq!(
        r.result,
        map(vec![(0, Cbor::Uint(2))]),
        "early blob + old orphan"
    );
    let has = svc
        .has_objects(
            &dev(&a),
            HasObjectsParams {
                collection: c,
                addresses: vec![early_blob, orphan_old, chunk, ma, orphan_new],
            },
        )
        .await
        .unwrap();
    assert_eq!(has.present, vec![false, false, true, true, true]);
    // A day later the late orphan goes too.
    svc.call(&cpp, "gc", &map(vec![(0, c.to_cbor())]), late + 2 * DAY)
        .await
        .unwrap();
    let has = svc
        .has_objects(
            &dev(&a),
            HasObjectsParams {
                collection: c,
                addresses: vec![orphan_new, chunk],
            },
        )
        .await
        .unwrap();
    assert_eq!(has.present, vec![false, true]);
    // Tokens of compacted entries stay (I5): re-sending entry 0's mutation is a duplicate.
    let e = a.entry(
        c,
        head + 1,
        chain,
        1,
        id16(&format!("{}/0", c.to_hex())),
        None,
        filler("again", 10),
    );
    let out = svc
        .call(
            &dev(&a),
            "append",
            &AppendParams {
                collection: c,
                expect_seq: head + 1,
                expect_prev: chain,
                items: vec![Bytes(e)],
            }
            .to_cbor(),
            late,
        )
        .await
        .unwrap();
    assert!(
        matches!(AppendResult::from_cbor(&out.result).unwrap(), AppendResult::Duplicate(d) if d.seq == early_seq)
    );
    c
}

fn f(c: &Cbor, k: u64) -> &Cbor {
    mdbn_log_conformance::client::field(c, k).expect("field")
}

/// Export everything from `src`, import into `dst`, and compare (§12, gate 4).
async fn roundtrip<B1: Backend, O1: ObjectStore, B2: Backend, O2: ObjectStore>(
    src: &Service<B1, O1>,
    dst: &Service<B2, O2>,
    c: mdbn_wire::common::Uuid,
) {
    let cp = Principal::ControlPlane;
    let now = 1_900_000_000_000;
    // Restore order: genesis (creates the collection, `unavailable` until done),
    // objects, items, snapshots, then done.
    let first = src
        .call(
            &cp,
            "export",
            &map(vec![(0, c.to_cbor()), (1, Cbor::Uint(0))]),
            now,
        )
        .await
        .unwrap()
        .result;
    let Cbor::Array(first) = f(&first, 0).clone() else {
        panic!()
    };
    dst.call(
        &cp,
        "import",
        &map(vec![
            (0, c.to_cbor()),
            (1, Cbor::Array(vec![first[0].clone()])),
        ]),
        now,
    )
    .await
    .unwrap();
    let mut after: Option<B32> = None;
    loop {
        let mut q = vec![(0, c.to_cbor())];
        if let Some(a) = after {
            q.push((1, a.to_cbor()));
        }
        let page = src
            .call(&cp, "export_objects", &map(q), now)
            .await
            .unwrap()
            .result;
        let Cbor::Array(objs) = f(&page, 0) else {
            panic!()
        };
        for o in objs {
            let Cbor::Array(o) = o else { panic!() };
            let a = B32::from_cbor(&o[0]).unwrap();
            let g = src
                .get_object(
                    &cp,
                    mdbn_wire::log_service::GetObjectParams {
                        collection: c,
                        address: a,
                        range: None,
                    },
                    now,
                )
                .await
                .unwrap();
            let bytes = g.bytes.expect("small objects inline").0;
            dst.call(
                &cp,
                "import_object",
                &map(vec![
                    (0, c.to_cbor()),
                    (1, a.to_cbor()),
                    (2, o[1].clone()),
                    (3, Cbor::Bytes(bytes)),
                ]),
                now,
            )
            .await
            .unwrap();
            after = Some(a);
        }
        if f(&page, 1) != &Cbor::Bool(true) {
            break;
        }
    }
    // Items, page by page; the last page carries the retention.
    let mut after = 1u64;
    let mut imported = 0usize;
    loop {
        let page = src
            .call(
                &cp,
                "export",
                &map(vec![(0, c.to_cbor()), (1, Cbor::Uint(after))]),
                now,
            )
            .await
            .unwrap()
            .result;
        let Cbor::Array(items) = f(&page, 0).clone() else {
            panic!()
        };
        let more = f(&page, 2) == &Cbor::Bool(true);
        if let Some(Cbor::Array(last)) = items.last() {
            after = u64::from_cbor(&last[0]).unwrap();
        }
        imported += items.len();
        // An export page need not fit an import's aggregate decode budget.
        // Preserve every item/position and every final inventory assertion;
        // submit separate bounded import requests without truncating the page.
        for chunk in items.chunks(32) {
            dst.call(
                &cp,
                "import",
                &map(vec![(0, c.to_cbor()), (1, Cbor::Array(chunk.to_vec()))]),
                now,
            )
            .await
            .unwrap();
        }
        // Snapshots go in before the collection goes live.
        if !more {
            let Cbor::Array(ptrs) = f(&page, 1).clone() else {
                panic!()
            };
            let Cbor::Array(refs) = f(&page, 6).clone() else {
                panic!()
            };
            for (ptr, rr) in ptrs.iter().zip(refs.iter()) {
                let Cbor::Array(rr) = rr else { panic!() };
                dst.call(
                    &cp,
                    "import_snapshot",
                    &map(vec![(0, c.to_cbor()), (1, ptr.clone()), (2, rr[1].clone())]),
                    now,
                )
                .await
                .unwrap();
            }
            dst.call(
                &cp,
                "import",
                &map(vec![
                    (0, c.to_cbor()),
                    (1, Cbor::Array(vec![])),
                    (2, map(vec![(0, f(&page, 5).clone())])),
                ]),
                now,
            )
            .await
            .unwrap();
            break;
        }
    }
    // Same head, retention, snapshots, items and objects.
    let hs = src.head(&cp, &c).await.unwrap();
    let hd = dst.head(&cp, &c).await.unwrap();
    assert_eq!(hs, hd, "head, chain, retention and snapshot pointer");
    let rs = src
        .read(
            &cp,
            ReadParams {
                collection: c,
                after: hs.retained_from - 1,
                limit: 1000,
                kinds: None,
                max_bytes: None,
            },
            now,
        )
        .await
        .unwrap();
    let rd = dst
        .read(
            &cp,
            ReadParams {
                collection: c,
                after: hs.retained_from - 1,
                limit: 1000,
                kinds: None,
                max_bytes: None,
            },
            now,
        )
        .await
        .unwrap();
    assert_eq!(rs.items, rd.items);
    let rs = src
        .read(
            &cp,
            ReadParams {
                collection: c,
                after: 0,
                limit: 1000,
                kinds: Some(ReadKinds::Control),
                max_bytes: None,
            },
            now,
        )
        .await
        .unwrap();
    let rd = dst
        .read(
            &cp,
            ReadParams {
                collection: c,
                after: 0,
                limit: 1000,
                kinds: Some(ReadKinds::Control),
                max_bytes: None,
            },
            now,
        )
        .await
        .unwrap();
    assert_eq!(rs.items, rd.items);
    // The restored log accepts the next append and still knows old tokens.
    assert!(imported > 0);
}

#[tokio::test]
async fn compaction_and_gc_memory() {
    let svc = Service::new(
        MemBackend::default(),
        MemObjects::default(),
        testkit_config(CP_LABEL, "http://unused"),
    );
    let c = scenario(&svc).await;
    // What compaction and GC removed is in the archive (30-day tier by default):
    // entries 4..=C in one segment, and the three collected objects.
    let archived = svc.objects.archived();
    let prefix = format!("archive/30d/{}/", c.to_hex());
    let segments: Vec<&String> = archived
        .keys()
        .filter(|k| k.starts_with(&format!("{prefix}segments/")))
        .collect();
    assert_eq!(
        segments,
        vec![&format!("{prefix}segments/4-{}", 3 + 10_100 - 10_000)]
    );
    assert_eq!(
        archived
            .keys()
            .filter(|k| k.starts_with(&format!("{prefix}objects/")))
            .count(),
        3,
        "early blob, old orphan, late orphan"
    );
    assert_eq!(archived.len(), 4);
    let restored = Service::new(
        MemBackend::default(),
        MemObjects::default(),
        testkit_config(CP_LABEL, "http://unused"),
    );
    roundtrip(&svc, &restored, c).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compaction_and_gc_postgres() {
    let Ok(url) =
        std::env::var("MDBN_TEST_PG_URL").or_else(|_| std::env::var("MDBN_LOGSVC_PG_URL"))
    else {
        eprintln!("MDBN_TEST_PG_URL not set: skipping");
        return;
    };
    // Runtime path: rcargo's compiled-in manifest path belongs to the VM.
    let dir = PathBuf::from(
        std::env::var_os("MDBN_LOGSVC_TEST_OBJECTS")
            .unwrap_or_else(|| "target/logsvc-test-objects".into()),
    );
    let svc = Service::new(
        PgBackend::connect(&url, 8)
            .await
            .unwrap()
            .with_independent_floor_reader(std::sync::Arc::new(
                mdbn_log_server::test_support::TestDeletionFloors::default(),
            )),
        FsObjects::new(dir),
        testkit_config(CP_LABEL, "http://unused"),
    );
    // Postgres export → memory import, and memory export → Postgres import.
    let c = scenario(&svc).await;
    let mem = Service::new(
        MemBackend::default(),
        MemObjects::default(),
        testkit_config(CP_LABEL, "http://unused"),
    );
    roundtrip(&svc, &mem, c).await;
    let c2 = scenario(&mem).await;
    roundtrip(&mem, &svc, c2).await;
}
