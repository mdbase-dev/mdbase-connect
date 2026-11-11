//! Who may author a snapshot a replica installs, and what a replica checks
//! before it endorses one (`snapshot.md` §5.2, §5.3, §8).
//!
//! Authorship: the manifest's signer must have had write authority at the
//! manifest's position. Endorsement: every chunk is decoded by the installer's
//! own row decoding and each row equals this replica's row.

use std::collections::BTreeMap;

use mdbn_wire::attachment_runtime_v1 as rt;
use mdbn_wire::client::IncidentKind;
use mdbn_wire::common::{B16, B32, Hash};
use mdbn_wire::envelope::{Item, ItemKind};
use mdbn_wire::log_service::{PutSnapshotParams, SnapshotPointer};
use mdbn_wire::policy::{MemberSet, PolicyOp, Role};
use mdbn_wire::schema::Wire;
use mdbn_wire::snapshot::{
    IndexRow, ReceiptRow as WReceiptRow, RecordRow as WRecordRow, SectionKind as L, TextOrBlob,
};

use super::engine::{COL, Node, node, settle};
use super::unindexed_snapshot::snapshot_uploads;
use crate::Store;
use crate::fake::FakeLogService;
use crate::log::{LogClient, LogRequest, LogResponse};
use crate::mem::MemStore;
use crate::store::{RecordMeta, RecordRow, Tx, bucket16};
use crate::testkit::{TEST_OWNER, TestControlPlane};

/// Test node `n`'s device.
fn device(n: u8) -> B16 {
    B16([n + 100; 16])
}

fn pointers(svc: &FakeLogService) -> Vec<SnapshotPointer> {
    match svc
        .client(B16([9; 16]))
        .call(LogRequest::GetSnapshot { collection: COL })
    {
        Ok(LogResponse::GetSnapshot(v)) => v,
        other => panic!("{other:?}"),
    }
}

fn incident(n: &Node, kind: IncidentKind) -> bool {
    n.r.sync_status().incidents.iter().any(|i| i.kind == kind)
}

/// Every test device belongs to [`TEST_OWNER`]: give that account `role`, under
/// another owner.
fn set_role(svc: &FakeLogService, role: Role) {
    TestControlPlane::new(COL).append(
        svc,
        vec![
            PolicyOp::MemberSet(MemberSet {
                account: B16([0xab; 16]),
                role: Role::Owner,
            }),
            PolicyOp::MemberSet(MemberSet {
                account: TEST_OWNER,
                role,
            }),
        ],
    );
}

fn thirty_notes(a: &mut Node) {
    for i in 0..30u8 {
        a.create(i, &format!("n{i}.md"), &format!("doc {i}"));
    }
}

// ------------------------------------------------------------ authorship

/// A read-only member's device is keyed, so it can seal and sign a manifest. A
/// late joiner must not install it: the signer had no write authority at the
/// manifest's position. (Today the log service has to serve it as the newest
/// pointer to a replica it tells is behind.)
#[test]
fn a_viewer_authored_snapshot_is_not_installed() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    let mut v = node(&svc, 2, MemStore::new());
    thirty_notes(&mut a);
    settle(&mut [&mut a, &mut v]);
    set_role(&svc, Role::Viewer);
    settle(&mut [&mut a, &mut v]);
    assert!(!v.r.policy.device_can_write(&device(2)), "V may not write");
    // V forges a record straight into its own store, then snapshots it. A
    // modified client ignores its own policy: here, V's replica is told it is
    // an editor.
    let id = B16([0xee; 16]);
    v.r.store_mut()
        .commit(Tx {
            records_put: vec![RecordRow {
                id,
                path: "forged.md".into(),
                path_key: "forged.md".into(),
                doc: "forged by a viewer".into(),
                revision: mdbn_wire::hash::sha256(b"forged by a viewer"),
                modified_seq: 1,
                mtime: None,
                bucket: bucket16(&id),
                meta: RecordMeta::default(),
            }],
            ..Tx::default()
        })
        .unwrap();
    v.r.policy.members.insert(TEST_OWNER, Role::Editor);
    v.r.build_snapshot_now().unwrap();
    settle(&mut [&mut v]);
    assert_eq!(pointers(&svc).len(), 1, "the forged snapshot is registered");
    assert_eq!(pointers(&svc)[0].author, device(2));
    svc.compact(&COL, v.r.head().seq);

    let mut c = node(&svc, 3, MemStore::new());
    settle(&mut [&mut c]);
    assert_eq!(c.r.stats.snapshots_installed, 0);
    assert!(
        c.r.confirmed_records().unwrap().is_empty(),
        "nothing from the forged snapshot is confirmed"
    );
    assert!(incident(&c, IncidentKind::Integrity));
}

/// The endorsement path makes the same check of the manifest's signer: a
/// snapshot of exactly this replica's state, signed by a read-only member's
/// device, is not endorsed.
#[test]
fn a_viewer_authored_snapshot_is_not_endorsed() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    let mut v = node(&svc, 2, MemStore::new());
    thirty_notes(&mut a);
    settle(&mut [&mut a, &mut v]);
    set_role(&svc, Role::Viewer);
    settle(&mut [&mut a, &mut v]);
    v.r.policy.members.insert(TEST_OWNER, Role::Editor);
    v.r.build_snapshot_now().unwrap();
    settle(&mut [&mut v]);
    assert_eq!(pointers(&svc)[0].author, device(2));
    a.r.check_snapshots();
    settle(&mut [&mut a]);
    assert!(!pointers(&svc)[0].endorsed);
    assert!(incident(&a, IncidentKind::VerificationMismatch));
}

/// The same collection, with the account an editor: its device's snapshot
/// installs.
#[test]
fn an_editors_snapshot_installs() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    thirty_notes(&mut a);
    settle(&mut [&mut a]);
    set_role(&svc, Role::Editor);
    settle(&mut [&mut a]);
    assert!(a.r.policy.device_can_write(&device(1)));
    a.r.build_snapshot_now().unwrap();
    settle(&mut [&mut a]);
    assert_eq!(a.r.stats.snapshots_built, 1);
    svc.compact(&COL, a.r.head().seq);

    let mut c = node(&svc, 3, MemStore::new());
    settle(&mut [&mut a, &mut c]);
    assert_eq!(c.r.stats.snapshots_installed, 1);
    assert_eq!(
        c.r.confirmed_records().unwrap(),
        a.r.confirmed_records().unwrap()
    );
    assert_eq!(c.r.sync_status().incidents, vec![]);
}

/// A replica without write authority builds nothing: not when the period comes
/// round, and not when asked directly.
#[test]
fn a_replica_without_write_authority_does_not_build() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    let mut v = node(&svc, 2, MemStore::new());
    thirty_notes(&mut a);
    settle(&mut [&mut a, &mut v]);
    set_role(&svc, Role::Viewer);
    v.r.snapshot_every = 10;
    settle(&mut [&mut a, &mut v]);
    assert!(!v.r.policy.device_can_write(&device(2)));
    v.r.build_snapshot_now().unwrap();
    settle(&mut [&mut a, &mut v]);
    assert_eq!(v.r.stats.snapshots_built, 0);
    assert_eq!(pointers(&svc), vec![]);
    assert!(
        svc.objects(&COL).is_empty(),
        "no chunk or manifest was uploaded"
    );
}

// ------------------------------------------------------------ endorsement

/// A snapshot `a` built and has not registered, decoded: its manifest and every
/// section's chunks, for a test to re-encode.
struct Draft {
    /// The manifest's envelope, as `a` sealed it.
    item: Item,
    m: rt::ManifestPayload,
    /// A sealed chunk of `a`'s, for its envelope.
    chunk_item: Item,
    sections: Vec<(rt::SectionKind, Vec<rt::ChunkPayload>)>,
}

fn draft(a: &mut Node, svc: &FakeLogService) -> Draft {
    a.r.build_snapshot_now().unwrap();
    // A build uploads only the chunks the previous snapshot did not have.
    let mut objects: BTreeMap<Hash, Vec<u8>> = svc.objects(&COL).into_iter().collect();
    let mut manifest = None;
    for call in snapshot_uploads(a) {
        if let LogRequest::PutObject {
            address,
            bytes,
            kind,
            ..
        } = call.request
        {
            if kind == ItemKind::Manifest {
                manifest = Some(address);
            }
            objects.insert(address, bytes);
        }
    }
    a.r.build = None;
    let raw = &objects[&manifest.expect("a manifest")];
    let item = Item::from_bytes(raw).unwrap();
    let (m, indices) =
        mdbn_wire::ref_index::decode_manifest(&a.r.sealer.open(&item, raw).unwrap()).unwrap();
    assert!(indices.is_empty());
    let mut chunk_item = None;
    let sections = m
        .sections
        .iter()
        .map(|s| {
            let chunks = s
                .chunks
                .iter()
                .map(|c| {
                    let raw = &objects[&c.address];
                    let item = Item::from_bytes(raw).unwrap();
                    let plain = a.r.sealer.open(&item, raw).unwrap();
                    chunk_item = Some(item);
                    rt::ChunkPayload::from_bytes(&plain).unwrap()
                })
                .collect();
            (s.kind, chunks)
        })
        .collect();
    Draft {
        item,
        m,
        chunk_item: chunk_item.expect("a chunk"),
        sections,
    }
}

impl Draft {
    fn rows<T: Wire>(&self, kind: L) -> Vec<T> {
        self.chunks(kind)
            .iter()
            .flat_map(|c| c.rows_as::<T>().unwrap())
            .collect()
    }

    fn chunks(&self, kind: L) -> &Vec<rt::ChunkPayload> {
        let want = rt::SectionKind::Legacy(kind);
        &self
            .sections
            .iter()
            .find(|s| s.0 == want)
            .expect("section")
            .1
    }

    fn chunks_mut(&mut self, kind: L) -> &mut Vec<rt::ChunkPayload> {
        let want = rt::SectionKind::Legacy(kind);
        &mut self
            .sections
            .iter_mut()
            .find(|s| s.0 == want)
            .expect("section")
            .1
    }

    /// One chunk holding `rows`, in place of the section's chunks.
    fn set_rows<T: Wire>(&mut self, kind: L, rows: &[T]) {
        *self.chunks_mut(kind) = vec![rt::ChunkPayload {
            section: rt::SectionKind::Legacy(kind),
            bucket: 0,
            rows: rows.iter().map(Wire::to_cbor).collect(),
        }];
    }

    /// Seal every chunk and the manifest as `a`, and register the snapshot as
    /// `a`'s device. `reuse` puts an already stored chunk in place of a section's.
    fn publish(
        mut self,
        a: &mut Node,
        svc: &FakeLogService,
        reuse: Option<(L, mdbn_wire::snapshot::ChunkRef)>,
    ) {
        let mut log = svc.client(a.r.cfg.device_id);
        let mut put = |address: Hash, kind: ItemKind, bytes: Vec<u8>| {
            let reply = log.call(LogRequest::PutObject {
                collection: COL,
                address,
                kind,
                bytes,
            });
            assert!(
                matches!(reply, Ok(LogResponse::PutObject { .. })),
                "{reply:?}"
            );
        };
        let mut refs = Vec::new();
        let mut sections = Vec::new();
        for (kind, chunks) in self.sections {
            let mut crefs = Vec::new();
            for chunk in chunks {
                let plain = chunk.to_bytes().unwrap();
                let mut item = self.chunk_item.clone();
                a.r.sealer
                    .seal_object(&mut item, &plain, true, false, &mut *a.r.host.entropy)
                    .unwrap();
                let raw = item.to_bytes().unwrap();
                let address = mdbn_wire::hash::sha256(&raw);
                put(address, ItemKind::Chunk, raw);
                crefs.push(mdbn_wire::snapshot::ChunkRef {
                    address,
                    plain_hash: mdbn_wire::hash::sha256(&plain),
                    rows: chunk.rows.len() as u64,
                    bucket: chunk.bucket,
                    plain_size: plain.len() as u64,
                });
            }
            if let Some((_, old)) = reuse.iter().find(|r| rt::SectionKind::Legacy(r.0) == kind) {
                crefs = vec![old.clone()];
            }
            refs.extend(crefs.iter().map(|c| c.address));
            sections.push(rt::Section {
                kind,
                chunks: crefs,
            });
        }
        refs.sort();
        refs.dedup();
        self.m.sections = sections;
        self.item.refs = Some(refs.clone());
        a.r.sealer
            .seal_object(
                &mut self.item,
                &self.m.to_bytes().unwrap(),
                true,
                true,
                &mut *a.r.host.entropy,
            )
            .unwrap();
        let raw = self.item.to_bytes().unwrap();
        let manifest = mdbn_wire::hash::sha256(&raw);
        put(manifest, ItemKind::Manifest, raw);
        let reply = log.call(LogRequest::PutSnapshot(PutSnapshotParams {
            collection: COL,
            seq: self.m.seq,
            manifest,
            refs,
        }));
        assert_eq!(reply, Ok(LogResponse::PutSnapshot(true)));
    }
}

/// `a` and `b` at the same head with thirty notes; `b` then checks the snapshot
/// `a` publishes from `edit`ed chunks. Returns `b` and whether it endorsed.
fn endorsed_after(edit: impl FnOnce(&mut Node, &mut Draft)) -> (Node, bool) {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    let mut b = node(&svc, 2, MemStore::new());
    thirty_notes(&mut a);
    settle(&mut [&mut a, &mut b]);
    let mut d = draft(&mut a, &svc);
    edit(&mut a, &mut d);
    d.publish(&mut a, &svc, None);
    b.r.check_snapshots();
    settle(&mut [&mut b]);
    let endorsed = pointers(&svc).iter().any(|p| p.endorsed);
    (b, endorsed)
}

/// The harness itself: an untouched draft is `a`'s honest snapshot.
#[test]
fn an_honest_snapshot_is_endorsed() {
    let (b, endorsed) = endorsed_after(|_, _| {});
    assert!(endorsed);
    assert_eq!(b.r.sync_status().incidents, vec![]);
}

/// A builder changes one document's text and keeps its revision. The state
/// digest, the chain and the signature all check out, and the chunk opens and
/// matches its hash; a joiner could never install it. Not endorsed.
#[test]
fn a_snapshot_whose_rows_differ_outside_the_digest_is_not_endorsed() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    let mut b = node(&svc, 2, MemStore::new());
    thirty_notes(&mut a);
    settle(&mut [&mut a, &mut b]);
    // A rewrites one record's document, keeping id, path and revision.
    let mut row = a.r.confirmed_records().unwrap().remove(0);
    row.doc = "tampered text under the honest revision".into();
    a.r.store_mut()
        .commit(Tx {
            records_put: vec![row],
            ..Tx::default()
        })
        .unwrap();
    a.r.build_snapshot_now().unwrap();
    settle(&mut [&mut a, &mut b]);
    assert_eq!(a.r.stats.snapshots_built, 1);
    b.r.check_snapshots();
    settle(&mut [&mut a, &mut b]);
    assert!(!pointers(&svc).iter().any(|p| p.endorsed));
    assert!(incident(&b, IncidentKind::VerificationMismatch));
}

/// Fields the state digest does not cover are compared too: a row's position
/// and capture time, and the receipts.
#[test]
fn a_snapshot_differing_in_a_field_outside_the_digest_is_not_endorsed() {
    type Edit = fn(&mut Node, &mut Draft);
    let edits: [(&str, Edit); 4] = [
        ("modified_seq", |_, d| {
            let mut rows = d.rows::<IndexRow>(L::Index);
            rows[0].modified_seq += 1;
            d.set_rows(L::Index, &rows);
        }),
        ("mtime", |_, d| {
            let mut rows = d.rows::<IndexRow>(L::Index);
            rows[0].mtime = rows[0].mtime.map(|t| t + 1);
            d.set_rows(L::Index, &rows);
        }),
        ("a receipt dropped", |_, d| {
            let mut rows = d.rows::<WReceiptRow>(L::Receipts);
            rows.pop().expect("receipts");
            d.set_rows(L::Receipts, &rows);
        }),
        ("a receipt's position", |_, d| {
            let mut rows = d.rows::<WReceiptRow>(L::Receipts);
            rows[0].seq += 1;
            d.set_rows(L::Receipts, &rows);
        }),
    ];
    for (what, edit) in edits {
        let (b, endorsed) = endorsed_after(edit);
        assert!(!endorsed, "{what}");
        assert!(incident(&b, IncidentKind::VerificationMismatch), "{what}");
    }
}

/// Honest builders may lay the same rows out differently. Here the records are
/// split over two chunks where this replica's own build makes one, so no chunk
/// has the bytes or the hash this replica would produce. The rows are equal:
/// endorsed.
#[test]
fn an_honest_snapshot_in_another_chunk_layout_is_endorsed() {
    let (b, endorsed) = endorsed_after(|_, d| {
        assert_eq!(d.m.bucket_bits, 0, "this replica builds one bucket");
        d.m.bucket_bits = 1;
        for kind in [L::Index, L::Records, L::Files] {
            let section = rt::SectionKind::Legacy(kind);
            let rows = std::mem::take(&mut d.chunks_mut(kind)[0].rows);
            let id_of = |row: &mdbn_wire::cbor::Cbor| match kind {
                L::Index => IndexRow::from_cbor(row).unwrap().id,
                _ => WRecordRow::from_cbor(row).unwrap().id,
            };
            let (low, high): (Vec<_>, Vec<_>) = rows
                .into_iter()
                .partition(|row| bucket16(&id_of(row)) >> 15 == 0);
            assert!(kind == L::Files || (!low.is_empty() && !high.is_empty()));
            *d.chunks_mut(kind) = vec![
                rt::ChunkPayload {
                    section,
                    bucket: 0,
                    rows: low,
                },
                rt::ChunkPayload {
                    section,
                    bucket: 1,
                    rows: high,
                },
            ];
        }
    });
    assert!(endorsed);
    assert_eq!(b.r.sync_status().incidents, vec![]);
}

/// A record's text may be in a blob instead of its row (no builder here writes
/// that form). Comparing it takes fetching and authenticating the blob, as an
/// install does; the endorser does neither, so it does not endorse, and it has
/// found nothing wrong to report.
#[test]
fn a_snapshot_with_a_record_text_in_a_blob_is_not_endorsed() {
    let (b, endorsed) = endorsed_after(|a, d| {
        let mut rows = d.rows::<WRecordRow>(L::Records);
        let TextOrBlob::Text(doc) = rows[0].doc.clone() else {
            panic!("a build writes text");
        };
        // A reference the row validation accepts, naming the same text.
        rows[0].doc = TextOrBlob::Blob(mdbn_wire::intent::BlobRef {
            plain_hash: mdbn_wire::hash::sha256(doc.as_bytes()),
            size: doc.len() as u64,
            blob_id: B32([0x5a; 32]),
            id_epoch: a.r.policy.epoch,
            part_size: 1 << 20,
        });
        d.set_rows(L::Records, &rows);
    });
    assert!(!endorsed);
    assert_eq!(b.r.sync_status().incidents, vec![]);
}

/// A chunk this replica verified for an earlier snapshot says nothing about the
/// rows it holds now. A builder that reuses the earlier records chunk after a
/// record was added produces a snapshot no joiner can install. Not endorsed.
#[test]
fn a_chunk_verified_for_an_earlier_snapshot_is_checked_again() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    let mut b = node(&svc, 2, MemStore::new());
    thirty_notes(&mut a);
    settle(&mut [&mut a, &mut b]);
    a.r.build_snapshot_now().unwrap();
    settle(&mut [&mut a, &mut b]);
    b.r.check_snapshots();
    settle(&mut [&mut a, &mut b]);
    assert!(pointers(&svc)[0].endorsed, "the first snapshot is honest");
    let first = {
        let p = &pointers(&svc)[0];
        let raw = svc
            .objects(&COL)
            .into_iter()
            .find(|(address, _)| *address == p.manifest)
            .expect("manifest")
            .1;
        let item = Item::from_bytes(&raw).unwrap();
        mdbn_wire::ref_index::decode_manifest(&a.r.sealer.open(&item, &raw).unwrap())
            .unwrap()
            .0
    };
    let records = rt::SectionKind::Legacy(L::Records);
    let old = first
        .sections
        .iter()
        .find(|s| s.kind == records)
        .expect("records")
        .chunks[0]
        .clone();

    a.create(30, "n30.md", "doc 30");
    settle(&mut [&mut a, &mut b]);
    let d = draft(&mut a, &svc);
    d.publish(&mut a, &svc, Some((L::Records, old)));
    b.r.check_snapshots();
    settle(&mut [&mut b]);
    let latest = &pointers(&svc)[0];
    assert_eq!(latest.seq, b.r.head().seq);
    assert!(!latest.endorsed);
    assert!(incident(&b, IncidentKind::VerificationMismatch));
}

/// The endorser reads its whole state, as a build does, so the build's record
/// limit applies: over it, no endorsement and no incident.
#[test]
fn a_replica_over_its_record_limit_does_not_endorse() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    let mut b = node(&svc, 2, MemStore::new());
    thirty_notes(&mut a);
    settle(&mut [&mut a, &mut b]);
    a.r.build_snapshot_now().unwrap();
    settle(&mut [&mut a, &mut b]);
    b.r.snapshot_record_bytes = 16;
    b.r.check_snapshots();
    settle(&mut [&mut a, &mut b]);
    assert!(!pointers(&svc).iter().any(|p| p.endorsed));
    assert_eq!(b.r.sync_status().incidents, vec![]);
    b.r.snapshot_record_bytes = u64::MAX;
    b.r.check_snapshots();
    settle(&mut [&mut a, &mut b]);
    assert!(pointers(&svc)[0].endorsed);
}
