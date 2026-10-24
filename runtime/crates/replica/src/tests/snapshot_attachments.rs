//! Snapshot sections 10/11 (T7): a snapshot of a collection holding attachment
//! content carries the critical attachment sections and the complete object
//! inventory in its refs; a fresh replica installs it and materializes the
//! file; a replica without the inventory reads it from the authenticated
//! manifests first; an inventory that cannot fit one log-service request is
//! refused, typed, and never truncated.

use std::collections::BTreeSet;
use std::rc::Rc;

use mdbn_wire::attachment::FileContent;
use mdbn_wire::attachment_runtime_v1 as rt;
use mdbn_wire::common::{B16, B32, Hash};
use mdbn_wire::envelope::{Item, ItemKind};
use mdbn_wire::intent::{FileDelete, Op};
use mdbn_wire::schema::Wire;

use super::attachment_apply::{b_node, content_of, drive_b, submit};
use super::attachment_upload::{
    Calls, Reads, Source, attach_node, attach_node_with, data, drive, last_entry, params, status,
};
use super::engine::{COL, Node, settle};
use crate::Store;
use crate::crypto::chunked_blob::CHUNK_BYTES;
use crate::fake::FakeLogService;
use crate::log::{LogClient, LogPort, LogRequest, LogResponse};
use crate::mem::MemStore;
use crate::replica::attachment_inventory::inventory_meta_of_refs;
use crate::replica::{AttachmentUploadStatus, SnapshotBlocked};
use crate::store::{FileLocal, TombstoneLast, Tx};

const CHUNK: u64 = CHUNK_BYTES as u64;
const FILE: B16 = B16([0x5a; 16]);
const GONE: B16 = B16([0x6b; 16]);
const PATH: &str = "files/big.bin";

/// Upload `bytes` as file `id` at `path` from `a`.
fn upload_as(a: &mut Node, id: B16, path: &str, bytes: Vec<u8>) -> (rt::EntryPayload, Vec<Hash>) {
    let mut p = params(path);
    p.file = id;
    let m =
        a.r.start_attachment_upload(
            p,
            Box::new(Source {
                bytes: Rc::new(bytes),
                reads: Rc::new(Reads::default()),
            }),
        )
        .unwrap();
    let calls: Calls = Rc::default();
    drive(a, &calls, &mut |_, _| None);
    assert!(matches!(status(a, &m), AttachmentUploadStatus::Captured(_)));
    let a: &Node = a;
    last_entry(a, a.log.service())
}

/// The newest registered snapshot: its manifest payload and Item refs.
fn latest_snapshot(svc: &FakeLogService, n: &Node) -> (rt::ManifestPayload, Vec<B32>) {
    let mut c = svc.client(B16([9; 16]));
    let Ok(LogResponse::GetSnapshot(ptrs)) = c.call(LogRequest::GetSnapshot { collection: COL })
    else {
        panic!("get_snapshot");
    };
    let p = ptrs.first().expect("a snapshot");
    let bytes = svc
        .objects(&COL)
        .into_iter()
        .find(|(a, _)| *a == p.manifest)
        .map(|(_, b)| b)
        .expect("manifest stored");
    let item = Item::from_bytes(&bytes).unwrap();
    assert_eq!(item.kind, ItemKind::Manifest);
    let plain = n.r.sealer.open(&item, &bytes).unwrap();
    (
        mdbn_wire::ref_index::decode_manifest(&plain).unwrap().0,
        item.refs.unwrap_or_default(),
    )
}

fn kinds(m: &rt::ManifestPayload) -> Vec<u64> {
    m.sections.iter().map(|s| s.kind.value()).collect()
}

/// A holds a live two-and-a-bit-chunk attachment and a deleted one; returns
/// both entries' refs.
fn collection_with_attachments(svc: &FakeLogService) -> (Node, Vec<Hash>, Vec<Hash>, Vec<u8>) {
    let mut a = attach_node(svc, 1);
    let bytes = data(2 * CHUNK + 1000);
    let (_, live_refs) = upload_as(&mut a, FILE, PATH, bytes.clone());
    let (gone_entry, gone_refs) = upload_as(&mut a, GONE, "files/gone.bin", data(4096));
    submit(
        &mut a,
        Op::FileDelete(FileDelete {
            id: GONE,
            if_revision: None,
            base: None,
        }),
    );
    settle(&mut [&mut a]);
    assert_eq!(
        a.r.store().tombstone(&GONE).unwrap().unwrap().last,
        TombstoneLast::Attachment(content_of(&gone_entry))
    );
    (a, live_refs, gone_refs, bytes)
}

#[test]
fn snapshot_with_attachments_installs_on_a_fresh_replica_which_materializes() {
    let svc = FakeLogService::new();
    let (mut a, live_refs, gone_refs, bytes) = collection_with_attachments(&svc);
    a.r.build_snapshot_now().unwrap();
    settle(&mut [&mut a]);
    assert_eq!(a.r.snapshot_blocked(), None);
    assert_eq!(a.r.stats.snapshots_built, 1);
    // The uploader knew its inventories: nothing was read back.
    assert_eq!(a.r.attachment_inventory_reads(), 0);

    let (m, refs) = latest_snapshot(&svc, &a);
    assert_eq!(kinds(&m), vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    assert_eq!(m.file_count, 1, "file_count covers both content profiles");
    // Complete inventory: every object of the live file and of the retained
    // tombstone (manifest and every chunk), plus every snapshot chunk.
    let refs: BTreeSet<B32> = refs.into_iter().collect();
    for r in live_refs.iter().chain(&gone_refs) {
        assert!(refs.contains(r), "missing attachment root {r:?}");
    }
    assert_eq!(live_refs.len(), 4, "three chunks and the manifest");
    for s in &m.sections {
        for c in &s.chunks {
            assert!(refs.contains(&c.address));
        }
    }

    // Compact past everything; a fresh materializing replica installs.
    svc.compact(&COL, a.r.head().seq);
    let mut b = b_node(&svc);
    let batches = std::cell::RefCell::default();
    drive_b(&mut b, &batches, &|_| false);
    assert_eq!(b.r.stats.snapshots_installed, 1);
    assert_eq!(b.r.head(), a.r.head());
    assert_eq!(b.r.sync_status().incidents, vec![]);
    assert_eq!(
        crate::replica::state_digest(b.r.store()).unwrap(),
        crate::replica::state_digest(a.r.store()).unwrap()
    );
    assert_eq!(
        b.r.store().tombstone(&GONE).unwrap().unwrap().last,
        a.r.store().tombstone(&GONE).unwrap().unwrap().last
    );
    // ...and materializes the installed attachment from its objects.
    let row = b.r.store().file(&FILE).unwrap().unwrap();
    assert!(matches!(row.content, FileContent::AttachmentV1(_)));
    assert_eq!(row.local, FileLocal::Materialized);
    assert_eq!(
        b.r.store().att_disk().files.get(PATH).map(Vec::as_slice),
        Some(bytes.as_slice())
    );
    assert!(!b.r.store().att_disk().files.contains_key("files/gone.bin"));
}

#[test]
fn a_replica_without_inventories_reads_them_from_the_manifests_before_building() {
    let svc = FakeLogService::new();
    let (mut a, live_refs, gone_refs, _) = collection_with_attachments(&svc);
    a.r.build_snapshot_now().unwrap();
    settle(&mut [&mut a]);
    svc.compact(&COL, a.r.head().seq);
    // C does not materialize: it installs the rows and has no inventories.
    let mut c = attach_node_with(&svc, 3, MemStore::new());
    settle(&mut [&mut c]);
    assert_eq!(c.r.stats.snapshots_installed, 1);
    a.create(40, "later.md", "more");
    settle(&mut [&mut a, &mut c]);

    c.r.build_snapshot_now().unwrap();
    assert_eq!(
        c.r.snapshot_blocked(),
        Some(SnapshotBlocked::InventoryPending { attachments: 2 })
    );
    settle(&mut [&mut c]);
    assert_eq!(c.r.attachment_inventory_reads(), 2, "one read per manifest");
    assert_eq!(c.r.snapshot_blocked(), None);
    assert_eq!(c.r.stats.snapshots_built, 1);
    let (m, refs) = latest_snapshot(&svc, &c);
    assert_eq!(m.seq, c.r.head().seq);
    for r in live_refs.iter().chain(&gone_refs) {
        assert!(refs.contains(r));
    }
}

#[test]
fn a_collected_manifest_blocks_the_build_and_never_truncates_the_refs() {
    let svc = FakeLogService::new();
    let (mut a, live_refs, _, _) = collection_with_attachments(&svc);
    a.r.build_snapshot_now().unwrap();
    settle(&mut [&mut a]);
    svc.compact(&COL, a.r.head().seq);
    let mut c = attach_node_with(&svc, 3, MemStore::new());
    settle(&mut [&mut c]);
    a.create(40, "later.md", "more");
    settle(&mut [&mut a, &mut c]);
    // Every object of the live attachment is collected: its manifest is gone.
    for r in &live_refs {
        svc.forget_object(&COL, r);
    }
    let built = c.r.stats.snapshots_built;
    c.r.build_snapshot_now().unwrap();
    settle(&mut [&mut c]);
    c.r.build_snapshot_now().unwrap();
    settle(&mut [&mut c]);
    assert_eq!(
        c.r.snapshot_blocked(),
        Some(SnapshotBlocked::InventoryUnavailable { attachments: 1 })
    );
    assert_eq!(c.r.stats.snapshots_built, built);
}

/// Inject `n` attachment rows whose inventories hold `per` objects each.
fn inject(a: &mut Node, n: u8, per: usize) {
    let template = a.r.store().file(&FILE).unwrap().unwrap();
    let FileContent::AttachmentV1(c) = template.content.clone() else {
        panic!()
    };
    let mut tx = Tx::default();
    for i in 0..n {
        let id = B16([0x70 + i; 16]);
        let mut content = c.clone();
        content.reference.manifest_cipher_hash = B32([0x80 + i; 32]);
        let mut row = template.clone();
        row.id = id;
        row.path = format!("files/x{i}.bin");
        row.path_key = row.path.clone();
        row.bucket = crate::store::bucket16(&id);
        row.content = FileContent::AttachmentV1(content.clone());
        tx.files_put.push(row);
        let objects: Vec<Hash> = (0..per - 1)
            .map(|j| {
                let mut h = [0u8; 32];
                h[0] = i;
                h[1..9].copy_from_slice(&(j as u64).to_be_bytes());
                h[31] = 1;
                B32(h)
            })
            .collect();
        tx.meta.push(inventory_meta_of_refs(
            content.reference.manifest_cipher_hash,
            &objects,
        ));
    }
    a.r.store_mut().commit(tx).unwrap();
}

fn put_objects(a: &mut Node) -> usize {
    a.r.take_log_calls()
        .iter()
        .filter(|c| matches!(c.request, LogRequest::PutObject { .. }))
        .count()
}

#[test]
fn a_large_inventory_goes_through_ref_indices_and_an_oversized_one_is_refused_typed() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    upload_as(&mut a, FILE, PATH, data(1000));
    settle(&mut [&mut a]);

    // Four full attachments (1,024 objects each) exceed one request's direct
    // refs budget: the build lists them in ref-index objects instead.
    inject(&mut a, 4, 1024);
    a.r.build_snapshot_now().unwrap();
    assert_eq!(a.r.snapshot_blocked(), None);
    let calls = a.r.take_log_calls();
    let index_puts = calls
        .iter()
        .filter(|c| {
            matches!(
                c.request,
                LogRequest::PutObject {
                    kind: ItemKind::RefIndex,
                    ..
                }
            )
        })
        .count();
    assert_eq!(index_puts, (4 * 1024usize).div_ceil(8192).max(1));
    a.r.build = None;

    // Past 262,144 refs: refused, typed, before anything is sealed or sent.
    inject(&mut a, 3, 90_000);
    a.r.build_snapshot_now().unwrap();
    match a.r.snapshot_blocked() {
        Some(SnapshotBlocked::TooManyRefs { refs }) => assert!(refs > 262_144),
        other => panic!("{other:?}"),
    }
    assert_eq!(put_objects(&mut a), 0, "nothing uploaded");
    assert!(a.r.build.is_none());
    assert_eq!(a.r.stats.snapshot_builds_refused, 1);
}

/// T7b: a vault of 10,000 small attachments (20,000 objects, five times one
/// request's direct refs budget) compacts, and another replica installs it with
/// the complete resolved refs set.
#[test]
fn ten_thousand_small_attachments_compact_and_install_on_another_replica() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let mut roots: BTreeSet<Hash> = BTreeSet::new();
    for i in 0..10_000u32 {
        let mut id = [0xa1u8; 16];
        id[..4].copy_from_slice(&i.to_be_bytes());
        let (_, refs) = upload_as(
            &mut a,
            B16(id),
            &format!("img/{i}.png"),
            data(32 + u64::from(i)),
        );
        roots.extend(refs);
    }
    assert!(roots.len() >= 20_000);
    settle(&mut [&mut a]);
    a.r.build_snapshot_now().unwrap();
    settle(&mut [&mut a]);
    assert_eq!(a.r.snapshot_blocked(), None);
    // 10,000 entries also reach the periodic build (`SNAPSHOT_EVERY`).
    assert!(a.r.stats.snapshots_built >= 1);

    // The manifest names only ref-index objects, which resolve to every root.
    let (m, refs) = latest_snapshot(&svc, &a);
    assert!(refs.len() <= mdbn_wire::ref_index::MAX_REF_INDICES);
    let stored: std::collections::BTreeMap<Hash, Vec<u8>> = svc.objects(&COL).into_iter().collect();
    let all =
        crate::replica::ref_index::resolve_snapshot_refs(&COL, &refs, &refs, &stored).unwrap();
    assert!(roots.is_subset(&all), "every attachment object retained");
    for c in m.sections.iter().flat_map(|s| &s.chunks) {
        assert!(all.contains(&c.address));
    }

    svc.compact(&COL, a.r.head().seq);
    let mut c = attach_node_with(&svc, 3, MemStore::new());
    settle(&mut [&mut c]);
    assert_eq!(c.r.stats.snapshots_installed, 1);
    assert_eq!(c.r.sync_status().incidents, vec![]);
    assert_eq!(c.r.head(), a.r.head());
    assert_eq!(
        crate::replica::state_digest(c.r.store()).unwrap(),
        crate::replica::state_digest(a.r.store()).unwrap()
    );
    // The install verified the complete refs set (direct refs plus every
    // ref-index member) and released it once the install completed.
    assert_eq!(c.r.installed_refs.as_ref(), Some(&all));
    assert!(c.r.install_refs.is_none());
}
