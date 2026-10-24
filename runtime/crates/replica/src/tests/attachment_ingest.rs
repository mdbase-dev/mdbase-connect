//! Attachment ingest (T6) over the toy attachment disk and the fake log: files
//! observed on disk upload as attachments, the uploader adopts its own file
//! instead of fetching it back, a rename reuses the descriptor, an edit
//! re-uploads, a delete removes, an interrupted upload resumes after a
//! restart, and unavailable native source evidence remains held.

#[path = "attachment_ingest/binary_holds.rs"]
mod binary_holds;

use std::rc::Rc;

use mdbn_wire::attachment::FileContent;
use mdbn_wire::common::{B32, Hash};

use super::attachment_upload::{attach_node_with, data};
use super::engine::{COL, Node};
use crate::Store;
use crate::crypto::chunked_blob::CHUNK_BYTES;
use crate::fake::FakeLogService;
use crate::log::{LogClient, LogPort, LogRequest};
use crate::mem::{MemData, MemStore};
use crate::store::{
    AttachmentClass, FileLocal, Observation, ObservationId, Observed, Provenance, meta_keys,
};

const CHUNK: u64 = CHUNK_BYTES as u64;
const PATH: &str = "media/photo.bin";

fn ingest_node(svc: &FakeLogService, n: u8) -> (Node, Rc<std::cell::RefCell<MemData>>) {
    let store = MemStore::new().with_attachment_disk();
    let data = store.data();
    (attach_node_with(svc, n, store), data)
}

/// Exchange calls until quiet; returns the `put_object` calls delivered.
/// `stop_after_puts` stops (leaving later calls unanswered) once that many
/// objects were stored.
fn sync_until(n: &mut Node, stop_after_puts: Option<usize>) -> usize {
    n.r.request_read();
    let mut puts = 0;
    for _ in 0..1000 {
        let mut batch = n.r.take_log_calls();
        if batch.is_empty() {
            n.r.tick();
            batch = n.r.take_log_calls();
            if batch.is_empty() {
                return puts;
            }
        }
        for call in batch {
            let put = matches!(call.request, LogRequest::PutObject { .. });
            let reply = n.log.call(call.request);
            n.r.on_log_reply(call.id, reply);
            if put {
                puts += 1;
                if stop_after_puts == Some(puts) {
                    return puts;
                }
            }
        }
    }
    puts
}

fn sync(n: &mut Node) -> usize {
    sync_until(n, None)
}

/// The user acts on `n`'s disk, then the replica observes and syncs.
fn user(n: &mut Node, act: impl FnOnce(&mut crate::mem::AttDisk)) -> usize {
    act(&mut n.r.store().att_disk());
    n.r.observe(None).unwrap();
    sync(n)
}

fn file_at(n: &Node, path: &str) -> Option<crate::store::FileRow> {
    let id =
        n.r.store()
            .file_at(&mdbn_core::paths::path_key(path))
            .unwrap()?;
    n.r.store().file(&id).unwrap()
}

fn whole(n: &Node, path: &str) -> Hash {
    match file_at(n, path).expect("file").content {
        FileContent::AttachmentV1(c) => c.whole_plain_hash,
        other => panic!("not an attachment: {other:?}"),
    }
}

/// A dropped file, an upload, and device B's copy.
fn dropped(svc: &FakeLogService) -> (Node, Node, Vec<u8>) {
    let (mut a, _) = ingest_node(svc, 1);
    let (mut b, _) = ingest_node(svc, 2);
    let bytes = data(2 * CHUNK + 10);
    let puts = user(&mut a, |d| d.user_write(PATH, &bytes));
    assert_eq!(puts, 4, "three chunks and the manifest");
    sync(&mut b);
    (a, b, bytes)
}

#[test]
fn a_dropped_file_uploads_and_the_uploader_never_fetches_it_back() {
    let svc = FakeLogService::new();
    let (a, b, bytes) = dropped(&svc);

    // A: confirmed as an external file_attach, and the file on disk is adopted
    // as this content: nothing fetched, nothing published over it.
    assert_eq!(a.r.stalled, None);
    let row = file_at(&a, PATH).expect("confirmed");
    assert_eq!(whole(&a, PATH), mdbn_wire::hash::sha256(&bytes));
    assert_eq!(row.local, FileLocal::Materialized);
    assert_eq!(a.r.attachment_chunks_fetched(), 0);
    {
        let d = a.r.store().att_disk();
        assert!(d.outstanding.is_empty(), "the observation was acknowledged");
        assert_eq!(d.known.get(PATH), Some(&mdbn_wire::hash::sha256(&bytes)));
        assert!(d.ops.is_empty(), "A never wrote its own file: {:?}", d.ops);
        assert!(d.max_source_read as u64 <= CHUNK, "bounded reads");
        assert_eq!(d.sources_opened, 1);
    }
    assert!(
        a.r.store()
            .meta(&format!(
                "{}{}",
                meta_keys::ATTACHMENT_INGEST,
                mdbn_wire::hash::sha256(mdbn_core::paths::path_key(PATH).as_bytes()).to_hex()
            ))
            .unwrap()
            .is_none(),
        "the checkpoint is retired with the capture"
    );

    // B: the same bytes, verified, at the same path.
    assert_eq!(file_at(&b, PATH).unwrap().id, row.id);
    assert_eq!(
        b.r.store().att_disk().files.get(PATH).map(Vec::as_slice),
        Some(bytes.as_slice())
    );
    assert_eq!(b.r.attachment_chunks_fetched(), 3);
    assert!(svc.object_gets(&COL).len() == 4, "only B fetched");
}

#[test]
fn a_rename_reuses_the_attachment_without_uploading_or_fetching() {
    let svc = FakeLogService::new();
    let (mut a, mut b, bytes) = dropped(&svc);
    let id = file_at(&a, PATH).unwrap().id;
    let gets = svc.object_gets(&COL).len();
    let before = whole(&a, PATH);

    let puts = user(&mut a, |d| d.user_move(PATH, "media/renamed.bin"));
    assert_eq!(puts, 0, "a rename uploads nothing");
    assert_eq!(a.r.attachment_ingest.moves, 1);
    sync(&mut b);
    for n in [&a, &b] {
        let row = file_at(n, "media/renamed.bin").expect("moved");
        assert_eq!(row.id, id);
        assert_eq!(whole(n, "media/renamed.bin"), before, "same descriptor");
        assert!(file_at(n, PATH).is_none());
    }
    assert_eq!(
        svc.object_gets(&COL).len(),
        gets,
        "a rename fetches nothing"
    );
    let d = b.r.store().att_disk();
    assert!(!d.files.contains_key(PATH));
    assert_eq!(
        d.files.get("media/renamed.bin").map(Vec::as_slice),
        Some(bytes.as_slice())
    );
    assert_eq!(a.r.attachment_chunks_fetched(), 0);
}

#[test]
fn an_edit_re_uploads_the_whole_file_under_the_same_id() {
    let svc = FakeLogService::new();
    let (mut a, mut b, _) = dropped(&svc);
    let id = file_at(&a, PATH).unwrap().id;
    let mut edited = data(CHUNK + 5);
    edited[0] ^= 0xff;

    let puts = user(&mut a, |d| d.user_write(PATH, &edited));
    assert_eq!(puts, 3, "v1 re-uploads every chunk and a new manifest");
    sync(&mut b);
    for n in [&a, &b] {
        assert_eq!(file_at(n, PATH).unwrap().id, id, "same file");
        assert_eq!(whole(n, PATH), mdbn_wire::hash::sha256(&edited));
    }
    assert_eq!(
        b.r.store().att_disk().files.get(PATH).map(Vec::as_slice),
        Some(edited.as_slice())
    );
    assert_eq!(a.r.attachment_chunks_fetched(), 0, "A adopts its edit too");
    assert_eq!(a.r.attachment_ingest.uploads_started, 2);
}

#[test]
fn a_delete_removes_the_file_everywhere() {
    let svc = FakeLogService::new();
    let (mut a, mut b, _) = dropped(&svc);
    let id = file_at(&a, PATH).unwrap().id;
    let puts = user(&mut a, |d| d.user_remove(PATH));
    assert_eq!(puts, 0);
    sync(&mut b);
    for n in [&a, &b] {
        assert!(n.r.store().file(&id).unwrap().is_none(), "removed");
        assert!(n.r.store().tombstone(&id).unwrap().is_some());
    }
    assert!(b.r.store().att_disk().files.is_empty());
    assert!(a.r.store().att_disk().outstanding.is_empty());
}

#[test]
fn an_interrupted_upload_resumes_from_its_checkpoint_after_a_restart() {
    let svc = FakeLogService::new();
    let (mut a, data_rc) = ingest_node(&svc, 1);
    let bytes = data(3 * CHUNK + 77);
    a.r.store().att_disk().user_write(PATH, &bytes);
    a.r.observe(None).unwrap();
    // Two chunks stored, then the daemon stops.
    assert_eq!(sync_until(&mut a, Some(2)), 2);
    drop(a);
    {
        let mut d = data_rc.borrow_mut();
        let disk = d.att_disk.as_mut().unwrap();
        assert_eq!(disk.restart(), vec![PATH.to_string()], "never acknowledged");
        // The next start's full scan reports the file again.
        disk.rescan(PATH);
    }
    let mut a = attach_node_with(&svc, 1, MemStore::shared(data_rc));
    a.r.observe(None).unwrap();
    let puts = sync(&mut a);
    assert_eq!(a.r.attachment_ingest.uploads_resumed, 1);
    assert_eq!(a.r.attachment_ingest.uploads_started, 0);
    assert_eq!(
        puts, 3,
        "the two stored chunks are re-read and adopted, not sent again"
    );
    assert_eq!(whole(&a, PATH), mdbn_wire::hash::sha256(&bytes));
    assert_eq!(
        file_at(&a, PATH).unwrap().local,
        FileLocal::Materialized,
        "adopted, not fetched"
    );
    assert_eq!(a.r.attachment_chunks_fetched(), 0);
}

#[test]
fn unavailable_native_source_and_undecodable_text_are_held_not_uploaded() {
    let svc = FakeLogService::new();
    let (mut a, _) = ingest_node(&svc, 1);
    let obs = |token, path: &str, class| Observation {
        token: ObservationId(token),
        path: path.into(),
        base: None,
        now: Some(Observed::Attachment {
            digest: B32([7; 32]),
            size: 2 << 20,
            class,
        }),
        moved_from: None,
        provenance: Provenance::Normal,
    };
    a.r.ingest(vec![
        obs(900, "notes/huge.md", AttachmentClass::OversizedMarkdown),
        obs(901, "notes/bad.md", AttachmentClass::Ordinary),
    ]);
    assert_eq!(sync(&mut a), 0, "nothing uploaded");
    assert_eq!(a.r.attachment_ingest.oversized_markdown_held, 1);
    assert_eq!(a.r.attachment_ingest.uploads_started, 0);
    assert!(a.r.store().att_disk().acked.is_empty(), "kept by the store");
    assert!(a.r.store().pending(None, 10).unwrap().is_empty());
}
