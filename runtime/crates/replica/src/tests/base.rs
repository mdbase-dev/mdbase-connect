//! The `base` item (`snapshot.md` §7) through the engine: a generation 0 written by
//! [`Gen0Writer`] installs on every replica at the base's position with its legacy
//! IDs (directly or through ref-index objects); a base whose manifest does not
//! open, or whose state digest differs, fails closed before the base; a
//! non-staging store refuses in a shipped build; pre-history segment parts are
//! never fetched, and [`check_base`] is what refuses a bad segment list.

use mdbn_wire::client::IncidentKind;
use mdbn_wire::common::{B16, B32, B64, Bytes};
use mdbn_wire::envelope::{Item, ItemKind};
use mdbn_wire::intent::BlobRef;
use mdbn_wire::log_service::AppendParams;
use mdbn_wire::schema::Wire;
use mdbn_wire::snapshot::{BasePayload, BaseSource};

use super::engine::{COL, Node, node, settle};
use crate::fake::FakeLogService;
use crate::log::{LogClient, LogPort, LogRequest};
use crate::mem::MemStore;
use crate::replica::base::{BaseError, Gen0Base, build_base, check_base};
use crate::replica::gen0::{DigestCounts, Gen0Record, Gen0Writer, StateDigestStream};
use crate::seal::{PlainSealer, Sealer};
use crate::store::Store;

fn segment(i: u8, size: u64) -> BlobRef {
    BlobRef {
        plain_hash: mdbn_wire::hash::sha256(&[i]),
        size,
        blob_id: B32([0x40 + i; 32]),
        id_epoch: 1,
        part_size: 8 << 20,
    }
}

/// The part addresses the test sealer derives (every node's sealer agrees).
fn parts(b: &BlobRef) -> Option<Vec<B32>> {
    PlainSealer::for_device(B16([1; 16])).blob_part_addresses(b)
}

/// Append a base signed by node 1's device at the current head, with the given
/// `refs`. Every ref is stored first (opaque bytes: the service only checks that a
/// referenced object exists).
fn append_base(svc: &FakeLogService, payload: &BasePayload, refs: Vec<B32>) -> u64 {
    let mut c = svc.client(B16([101; 16]));
    for address in &refs {
        c.call(LogRequest::PutObject {
            collection: COL,
            address: *address,
            kind: ItemKind::BlobPart,
            bytes: vec![0xee; 8],
        })
        .unwrap();
    }
    append_base_only(svc, payload, refs)
}

/// Append a base whose refs are already stored.
fn append_base_only(svc: &FakeLogService, payload: &BasePayload, refs: Vec<B32>) -> u64 {
    let mut c = svc.client(B16([101; 16]));
    let (seq, prev) = svc.head(&COL);
    let item = Item {
        kind: ItemKind::Base,
        collection: COL,
        seq: Some(seq + 1),
        prev: Some(prev),
        epoch: Some(1),
        signer: Some(B16([101; 16])),
        salt: Some(B16([0; 16])),
        idem: None,
        refs: Some(refs),
        stream: None,
        body: Bytes(payload.to_bytes().unwrap()),
        sig: Some(B64([0; 64])),
    };
    c.call(LogRequest::Append(AppendParams {
        collection: COL,
        expect_seq: seq + 1,
        expect_prev: prev,
        items: vec![Bytes(item.to_bytes().unwrap())],
    }))
    .unwrap();
    seq + 1
}

fn spec() -> Gen0Base {
    Gen0Base::new(B32([0xa2; 32]), B32([0xd0; 32]), BaseSource::HostedImport)
        .legacy_collection(B16([0x4c; 16]))
        .prehistory(vec![segment(0, 20 << 20), segment(1, 10)])
}

fn fresh() -> (FakeLogService, Node) {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    settle(&mut [&mut a]);
    (svc, a)
}

fn read_to(a: &mut Node, p: u64) {
    a.r.on_log_push(crate::log::LogPush::Head {
        collection: COL,
        head: p,
        head_chain: B32([0; 32]),
    });
    settle(&mut [a]);
}

#[test]
fn a_base_whose_manifest_does_not_open_fails_closed_and_segments_are_never_fetched() {
    let (svc, mut a) = fresh();
    let (payload, refs) = build_base(B16([1; 16]), &spec(), &parts).unwrap();
    assert_eq!(refs.len(), 1 + 3 + 1, "manifest and every part");
    let p = append_base(&svc, &payload, refs.clone());
    read_to(&mut a, p);
    read_to(&mut a, p);
    // The named manifest is fetched; its bytes are not that address, so the
    // install fails closed: nothing installed, nothing void, stopped before the base.
    assert_eq!(a.r.head().seq, p - 1);
    assert_eq!(a.r.stats.voided, 0);
    assert_eq!(a.r.stalled, Some((IncidentKind::Integrity, p)));
    let gets = svc.object_gets(&COL);
    assert!(gets.contains(&payload.manifest), "the manifest is fetched");
    let segment_parts: Vec<B32> = refs
        .iter()
        .copied()
        .filter(|r| *r != payload.manifest)
        .collect();
    assert!(
        gets.iter().all(|g| !segment_parts.contains(g)),
        "no get for a segment part: {gets:?}"
    );
}

/// The generation 0 of `records` written by node `a`'s own sealer, uploaded, and
/// its `base` appended by `a`'s device. Returns the base position and digest.
fn write_gen0(
    svc: &FakeLogService,
    a: &mut Node,
    resources: Vec<(String, String)>,
    records: Vec<Gen0Record>,
    bits: u64,
    extra_refs: &[B32],
    corrupt_digest: bool,
) -> (u64, B32, Vec<B32>) {
    let settings = crate::convert::winclusion(&Default::default());
    // The streamed digest over the same rows, in key order.
    let mut sorted = records.clone();
    sorted.sort_by(|x, y| x.id.cmp(&y.id));
    let mut res = resources.clone();
    res.sort_by(|x, y| x.0.as_bytes().cmp(y.0.as_bytes()));
    let mut d = StateDigestStream::new(
        DigestCounts {
            resources: res.len() as u64,
            records: sorted.len() as u64,
            ..DigestCounts::default()
        },
        &settings,
    );
    for (p, t) in &res {
        d.resource(p, t).unwrap();
    }
    for r in &sorted {
        d.record(r.id, &r.path, mdbn_wire::hash::sha256(r.doc.as_bytes()))
            .unwrap();
    }
    let mut digest = d.finish().unwrap();
    if corrupt_digest {
        digest.0[0] ^= 1;
    }

    let mut w = Gen0Writer::new(COL, bits, false, false);
    let r = &mut a.r;
    let mut objects = w
        .resources(r.sealer.as_mut(), r.host.entropy.as_mut(), resources)
        .unwrap();
    for b in 0..w.buckets() {
        let mine: Vec<Gen0Record> = records
            .iter()
            .filter(|x| w.bucket_of(&x.id) == b)
            .cloned()
            .collect();
        let refs: &[B32] = if b == 0 { extra_refs } else { &[] };
        objects.extend(
            w.bucket(
                r.sealer.as_mut(),
                r.host.entropy.as_mut(),
                b,
                mine,
                vec![],
                refs,
            )
            .unwrap(),
        );
    }
    let device = r.cfg.device_id;
    let (more, m) = w
        .finish(
            r.sealer.as_mut(),
            r.host.entropy.as_mut(),
            digest,
            settings,
            device,
        )
        .unwrap();
    objects.extend(more);
    objects.extend(m.ref_indices.clone());
    objects.push(m.manifest.clone());
    let mut c = svc.client(B16([101; 16]));
    for a in extra_refs {
        c.call(LogRequest::PutObject {
            collection: COL,
            address: *a,
            kind: ItemKind::BlobPart,
            bytes: vec![0xee; 8],
        })
        .unwrap();
    }
    for o in &objects {
        c.call(LogRequest::PutObject {
            collection: COL,
            address: o.address,
            kind: o.kind,
            bytes: o.bytes.clone(),
        })
        .unwrap();
    }
    let spec = Gen0Base::new(m.manifest.address, m.state_digest, BaseSource::Folder);
    let (payload, _) = build_base(B16([1; 16]), &spec, &parts).unwrap();
    let p = append_base_only(svc, &payload, m.base_refs.clone());
    (p, digest, m.base_refs)
}

fn recs(n: usize) -> Vec<Gen0Record> {
    (0..n)
        .map(|i| {
            let mut id = [0u8; 16];
            id[..8].copy_from_slice(&(i as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15).to_be_bytes());
            id[15] = i as u8;
            Gen0Record {
                id: B16(id),
                path: format!("notes/{i}.md"),
                doc: format!("# note {i}\n\nlegacy body {i}\n"),
            }
        })
        .collect()
}

#[test]
fn a_generation_zero_base_installs_on_every_replica_with_legacy_ids() {
    let (svc, mut a) = fresh();
    let records = recs(40);
    let resources = vec![("mdbase.yaml".to_string(), "name: x\n".to_string())];
    let (p, digest, _) = write_gen0(&svc, &mut a, resources, records.clone(), 2, &[], false);
    read_to(&mut a, p);
    read_to(&mut a, p);
    let mut b = node(&svc, 2, MemStore::new());
    read_to(&mut b, p);
    read_to(&mut b, p);
    for n in [&a, &b] {
        assert_eq!(n.r.head().seq, p, "the head is the base");
        assert_eq!(n.r.stalled, None);
        assert_eq!(n.r.stats.voided, 0);
        assert_eq!(crate::replica::state_digest(&n.r.store).unwrap(), digest);
        for r in &records {
            let got = n.r.store.record(&r.id).unwrap().expect("legacy ID kept");
            assert_eq!(
                (got.path.as_str(), got.doc.as_str()),
                (r.path.as_str(), r.doc.as_str())
            );
        }
        assert_eq!(n.r.store.resources().unwrap().len(), 1);
    }
}

#[test]
fn a_generation_zero_with_ref_indices_installs() {
    let (svc, mut a) = fresh();
    // More refs than one request names directly: the manifest goes through ref-index
    // objects, and the base names only the manifest.
    let extra: Vec<B32> = (0..5_000u32)
        .map(|i| mdbn_wire::hash::sha256(&i.to_be_bytes()))
        .collect();
    let (p, digest, base_refs) = write_gen0(&svc, &mut a, vec![], recs(3), 0, &extra, false);
    assert_eq!(base_refs.len(), 1, "an item never names an index");
    let mut b = node(&svc, 2, MemStore::new());
    read_to(&mut b, p);
    read_to(&mut b, p);
    assert_eq!(b.r.head().seq, p);
    assert_eq!(crate::replica::state_digest(&b.r.store).unwrap(), digest);
}

#[test]
fn a_base_with_a_wrong_state_digest_fails_closed() {
    let (svc, mut a) = fresh();
    let (p, _, _) = write_gen0(&svc, &mut a, vec![], recs(5), 0, &[], true);
    let mut b = node(&svc, 2, MemStore::new());
    read_to(&mut b, p);
    read_to(&mut b, p);
    assert_eq!(b.r.head().seq, p - 1, "nothing installed");
    assert_eq!(b.r.stalled, Some((IncidentKind::Integrity, p)));
    assert!(b.r.store.record(&recs(5)[0].id).unwrap().is_none());
}

#[test]
fn a_base_install_needs_a_staging_store_in_a_shipped_build() {
    let (svc, mut a) = fresh();
    let (p, _, _) = write_gen0(&svc, &mut a, vec![], recs(2), 0, &[], false);
    let mut b = node(&svc, 2, MemStore::new().without_staging());
    b.r.enforce_shipped_install_gate();
    read_to(&mut b, p);
    assert_eq!(b.r.head().seq, p - 1);
    assert_eq!(b.r.stalled, Some((IncidentKind::UpgradeRequired, p)));
}

#[test]
fn check_base_accepts_the_appended_base_and_refuses_a_missing_part() {
    let (svc, _a) = fresh();
    let (payload, refs) = build_base(B16([1; 16]), &spec(), &parts).unwrap();
    append_base(&svc, &payload, refs.clone());
    assert_eq!(check_base(&payload, &refs, &parts), Ok(()));
    let dropped = parts(&segment(0, 20 << 20)).unwrap()[1];
    let short: Vec<B32> = refs.iter().copied().filter(|r| *r != dropped).collect();
    assert_eq!(
        check_base(&payload, &short, &parts),
        Err(BaseError::PrehistoryPartNotInRefs { index: 0, part: 1 })
    );
}

#[test]
fn check_base_refuses_sixty_five_segments_and_accepts_sixty_four() {
    let segs: Vec<BlobRef> = (0..65).map(|i| segment(i, 10)).collect();
    let (payload, refs) = build_base(
        B16([1; 16]),
        &spec().prehistory(segs[..64].to_vec()),
        &parts,
    )
    .unwrap();
    assert_eq!(check_base(&payload, &refs, &parts), Ok(()));
    // Forged with every part in refs, so only the bound refuses it.
    let mut forged = payload.clone();
    forged.prehistory = Some(segs.clone());
    let mut all = refs.clone();
    all.extend(parts(&segs[64]).unwrap());
    assert_eq!(
        check_base(&forged, &all, &parts),
        Err(BaseError::TooManyPrehistorySegments { count: 65 })
    );
}

/// Faults during the base install: an unknown outcome at the first staging commit,
/// or the swap committing and then reporting an error. The replica never claims
/// more than the store holds, and a reopen converges from the store alone. (The
/// unknown outcome at exactly the swap commit has its own test below.)
#[test]
fn a_fault_at_or_after_the_base_swap_converges_on_reopen() {
    for unknown in [false, true] {
        let (svc, mut a) = fresh();
        let records = recs(12);
        let (p, digest, _) = write_gen0(&svc, &mut a, vec![], records.clone(), 1, &[], false);
        let store = MemStore::new();
        let data = store.data();
        let mut b = node(&svc, 2, store);
        read_to(&mut b, p - 1);
        if unknown {
            // The next store commit (a staging commit of the base install) reports
            // an unknown outcome and leaves state unchanged.
            b.r.store.fail_unknown_commits(1);
        } else {
            // The swap commits, then reports an I/O error.
            b.r.store.fail_after_head_commit(p);
        }
        read_to(&mut b, p);
        read_to(&mut b, p);
        // The in-memory replica never claims more than the store durably holds.
        let durable = b.r.store.head().unwrap().seq;
        assert!(b.r.head().seq <= durable.max(p - 1), "unknown={unknown}");
        drop(b);
        let mut c = node(&svc, 2, MemStore::shared(data));
        read_to(&mut c, p);
        read_to(&mut c, p);
        assert_eq!(c.r.head().seq, p, "unknown={unknown}");
        assert_eq!(crate::replica::state_digest(&c.r.store).unwrap(), digest);
        assert_eq!(c.r.stalled, None);
        for r in &records {
            assert!(c.r.store.record(&r.id).unwrap().is_some());
        }
    }
}

/// Legacy bytes survive exactly: the installed documents equal the imported ones
/// byte for byte (including non-ASCII and trailing whitespace), and the streamed
/// digest is the digest of those bytes.
#[test]
fn installed_documents_are_byte_identical_to_the_import() {
    let (svc, mut a) = fresh();
    let mut records = recs(4);
    records[0].doc = "---\ntitle: Café ☕\n---\r\n\tbody  \n\n".into();
    records[1].doc = String::new();
    let (p, _, _) = write_gen0(&svc, &mut a, vec![], records.clone(), 0, &[], false);
    let mut b = node(&svc, 2, MemStore::new());
    read_to(&mut b, p);
    read_to(&mut b, p);
    for r in &records {
        let got = b.r.store.record(&r.id).unwrap().unwrap();
        assert_eq!(got.doc.as_bytes(), r.doc.as_bytes());
        assert_eq!(got.revision, mdbn_wire::hash::sha256(r.doc.as_bytes()));
    }
}

/// Refs are bounded before anything is copied: per call (one ref-index object's
/// worth) and retained through `finish` (every index full), duplicates included.
/// One over refuses with the writer unchanged; exactly the limit is accepted and
/// finishes with full ref-index objects.
#[test]
fn gen0_refs_are_bounded_before_they_are_copied() {
    use crate::replica::gen0::{Gen0Error, MAX_CALL_REFS, MAX_RETAINED_REFS};
    let (_svc, mut a) = fresh();
    let r = &mut a.r;
    let mut w = Gen0Writer::new(COL, 5, false, false);
    w.resources(r.sealer.as_mut(), r.host.entropy.as_mut(), vec![])
        .unwrap();
    let refs = |from: u32, n: usize| -> Vec<B32> {
        (from..from + n as u32)
            .map(|i| mdbn_wire::hash::sha256(&i.to_be_bytes()))
            .collect()
    };
    // Per call: one over is refused, unchanged.
    let before = w.retained_refs();
    assert_eq!(
        w.bucket(
            r.sealer.as_mut(),
            r.host.entropy.as_mut(),
            0,
            vec![],
            vec![],
            &refs(0, MAX_CALL_REFS + 1)
        ),
        Err(Gen0Error::TooManyRefs)
    );
    assert_eq!(w.retained_refs(), before);
    // Duplicates count: the same full call repeated fills the retained budget.
    let full = refs(0, MAX_CALL_REFS);
    for b in 0..31 {
        w.bucket(
            r.sealer.as_mut(),
            r.host.entropy.as_mut(),
            b,
            vec![],
            vec![],
            &full,
        )
        .unwrap();
    }
    // The last bucket: exactly what is left (its 3 chunks and finish's 5 included).
    let left = MAX_RETAINED_REFS - w.retained_refs() - 3 - 5;
    let held = w.retained_refs();
    assert_eq!(
        w.bucket(
            r.sealer.as_mut(),
            r.host.entropy.as_mut(),
            31,
            vec![],
            vec![],
            &refs(1 << 20, left + 1)
        ),
        Err(Gen0Error::TooManyRefs),
        "one over"
    );
    assert_eq!(w.retained_refs(), held, "nothing copied on refusal");
    w.bucket(
        r.sealer.as_mut(),
        r.host.entropy.as_mut(),
        31,
        vec![],
        vec![],
        &refs(1 << 20, left),
    )
    .expect("exactly the limit");
    assert_eq!(w.retained_refs() + 5, MAX_RETAINED_REFS);
    let settings = crate::convert::winclusion(&Default::default());
    let digest = StateDigestStream::new(DigestCounts::default(), &settings)
        .finish()
        .unwrap();
    let device = r.cfg.device_id;
    let (_, m) = w
        .finish(
            r.sealer.as_mut(),
            r.host.entropy.as_mut(),
            digest,
            settings,
            device,
        )
        .unwrap();
    assert!(!m.ref_indices.is_empty(), "past the direct cap: indexed");
    assert_eq!(m.base_refs.len(), 1);
}

/// An unknown outcome at exactly the swap commit: the replica fences (reopen
/// required), commits and appends nothing more, and a reopen from the store alone
/// installs the base once; a local pending write made before the base survives
/// and lands after it.
#[test]
fn an_unknown_outcome_at_the_swap_fences_and_reopen_installs_once_keeping_pending() {
    let (svc, mut a) = fresh();
    let records = recs(6);
    let (p, _, _) = write_gen0(&svc, &mut a, vec![], records.clone(), 0, &[], false);
    let store = MemStore::new();
    let data = store.data();
    let mut b = node(&svc, 2, store);
    b.r.store.fail_unknown_head_commit(p);
    let _ = b.create(0x77, "local/pending.md", "kept\n");
    read_to(&mut b, p);
    read_to(&mut b, p);
    assert!(b.r.requires_reopen(), "an unknown swap outcome fences");
    assert!(b.r.head().seq < p);
    let commits = data.borrow().commits;
    let log_head = svc.head(&COL).0;
    read_to(&mut b, p);
    assert_eq!(data.borrow().commits, commits, "no commit after the fault");
    assert_eq!(svc.head(&COL).0, log_head, "no append after the fault");
    assert!(
        b.r.store.pending_count().unwrap() >= 1,
        "the pending write is kept"
    );
    drop(b);
    let mut c = node(&svc, 2, MemStore::shared(data));
    for _ in 0..3 {
        read_to(&mut c, svc.head(&COL).0);
    }
    assert!(!c.r.requires_reopen());
    assert!(c.r.head().seq >= p);
    for r in &records {
        assert!(c.r.store.record(&r.id).unwrap().is_some(), "installed once");
    }
    assert_eq!(
        c.doc(0x77).as_deref(),
        Some("kept\n"),
        "the pending write landed after the base"
    );
    let bases = svc
        .items(&COL)
        .iter()
        .filter(|i| Item::from_bytes(i).is_ok_and(|i| i.kind == ItemKind::Base))
        .count();
    assert_eq!(bases, 1);
}

/// A complete binary hold (the held side's blob descriptor, the confirmed side
/// absent) on an ID the generation 0 also carries survives the base swap, and an
/// unknown-outcome swap and reopen: the hold record, descriptor included, is
/// unchanged. This proves descriptor survival only; raw held bytes on disk are
/// covered by `tests::disk::held_local_bytes_survive_a_generation_zero_base_install`.
#[test]
fn a_binary_hold_survives_the_base_swap_and_an_unknown_swap_reopen() {
    use mdbn_wire::client::{Hold, HoldReason};
    use mdbn_wire::snapshot::TextOrBlob;
    for unknown in [false, true] {
        let (svc, mut a) = fresh();
        let records = recs(4);
        let (p, _, _) = write_gen0(&svc, &mut a, vec![], records.clone(), 0, &[], false);
        let held = Hold {
            id: records[0].id,
            path: records[0].path.clone(),
            reason: HoldReason::SuspectWrite,
            since: 1,
            base: None,
            mine: TextOrBlob::Blob(BlobRef {
                plain_hash: mdbn_wire::hash::sha256(b"local held bytes"),
                size: 16,
                blob_id: B32([0x5a; 32]),
                id_epoch: 1,
                part_size: 8 << 20,
            }),
            theirs: None,
            saves: 2,
        };
        let store = MemStore::new();
        let data = store.data();
        let mut b = node(&svc, 2, store);
        b.r.store
            .commit(crate::store::Tx {
                holds_put: vec![held.clone()],
                ..crate::store::Tx::default()
            })
            .unwrap();
        if unknown {
            b.r.store.fail_unknown_head_commit(p);
        }
        read_to(&mut b, p);
        read_to(&mut b, p);
        if unknown {
            assert!(b.r.requires_reopen());
            assert_eq!(
                b.r.store.hold(&held.id).unwrap(),
                Some(held.clone()),
                "kept at the fault"
            );
            drop(b);
            b = node(&svc, 2, MemStore::shared(data));
            read_to(&mut b, p);
            read_to(&mut b, p);
        }
        assert_eq!(b.r.head().seq, p, "unknown={unknown}");
        assert_eq!(
            b.r.store.hold(&held.id).unwrap(),
            Some(held.clone()),
            "the hold and its descriptor survive the swap (unknown={unknown})"
        );
        // The confirmed side is the imported document; the hold is unchanged.
        let confirmed = b.r.store.record(&held.id).unwrap().unwrap();
        assert_eq!(confirmed.doc, records[0].doc);
    }
}
