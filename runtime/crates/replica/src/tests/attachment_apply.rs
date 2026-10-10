//! Attachment apply, fetch and materialization (T5) over the in-memory store
//! with a toy attachment disk and the fake log: device A uploads, device B
//! applies the `put_attachment_file`, streams the objects with one in flight,
//! authenticates them and places the file; resume after a crash; delete and
//! rename without refetching; attachment conflict sides; terminal failures for
//! objects the log collected.

use std::cell::RefCell;
use std::rc::Rc;

use mdbn_wire::attachment::{AttachmentContentV1, FileContent};
use mdbn_wire::attachment_runtime_v1 as rt;
use mdbn_wire::client::{HelloParams, IncidentKind, ReceiptState, SubmitParams};
use mdbn_wire::common::{B16, B32, Hash, Value, Version};
use mdbn_wire::entry::{ConflictKind, Status};
use mdbn_wire::envelope::Item;
use mdbn_wire::intent::{FileDelete, FileMove, Op};
use mdbn_wire::schema::Wire;

use super::attachment_upload::{
    Calls, Reads, Source, attach_node, attach_node_with, data, drive, last_entry, params, status,
};
use super::engine::{COL, Node, settle};
use crate::Store;
use crate::api::{ClientApi, SessionAuth};
use crate::attachments::MAX_SEALED_CHUNK;
use crate::crypto::chunked_blob::CHUNK_BYTES;
use crate::fake::FakeLogService;
use crate::log::{LogClient, LogPort, LogRequest};
use crate::mem::MemStore;
use crate::replica::{AttachmentFetchStatus, AttachmentUploadStatus};
use crate::store::{FileLocal, TombstoneLast};

const CHUNK: u64 = CHUNK_BYTES as u64;
const FILE: B16 = B16([0x5a; 16]);
const PATH: &str = "files/big.bin";

/// Upload `bytes` at `path` from A and drive it to the log.
pub(super) fn upload(
    a: &mut Node,
    path: &str,
    bytes: &Rc<Vec<u8>>,
) -> (rt::EntryPayload, Vec<Hash>) {
    let m =
        a.r.start_attachment_upload(
            params(path),
            Box::new(Source {
                bytes: bytes.clone(),
                reads: Rc::new(Reads::default()),
            }),
        )
        .unwrap();
    let calls: Calls = Rc::default();
    drive(a, &calls, &mut |_, _| None);
    assert!(
        matches!(status(a, &m), AttachmentUploadStatus::Captured(_)),
        "{:?}",
        status(a, &m)
    );
    let a: &Node = a;
    last_entry(a, a.log.service())
}

pub(super) fn b_node(svc: &FakeLogService) -> Node {
    attach_node_with(svc, 2, MemStore::new().with_attachment_disk())
}

/// Drive B's calls one batch at a time, recording each batch's methods and
/// stopping early when `stop` says so.
pub(super) fn drive_b(
    b: &mut Node,
    batches: &RefCell<Vec<Vec<&'static str>>>,
    stop: &dyn Fn(&Node) -> bool,
) {
    b.r.request_read();
    for _ in 0..500 {
        if stop(b) {
            return;
        }
        let mut batch = b.r.take_log_calls();
        if batch.is_empty() {
            b.r.tick();
            batch = b.r.take_log_calls();
            if batch.is_empty() {
                return;
            }
        }
        batches
            .borrow_mut()
            .push(batch.iter().map(|c| c.request.method()).collect());
        for call in batch {
            let reply = b.log.call(call.request);
            if let Ok(crate::log::LogResponse::GetObject { bytes, .. }) = &reply {
                assert!(bytes.len() as u64 <= MAX_SEALED_CHUNK, "one object at most");
            }
            b.r.on_log_reply(call.id, reply);
        }
    }
}

pub(super) fn content_of(e: &rt::EntryPayload) -> AttachmentContentV1 {
    match &e.mutation.ops[0] {
        rt::Op::FileAttach(f) => f.content.clone(),
        _ => panic!("not a file_attach"),
    }
}

pub(super) fn submit(n: &mut Node, op: Op) -> mdbn_wire::client::Receipt {
    n.r.submit(
        n.s,
        SubmitParams {
            ops: vec![op],
            mutation_id: None,
            conflict_mode: None,
            timezone: None,
            allow_partial: None,
            mutation_ids: None,
            dry_run: None,
            include: None,
            wait: None,
        },
    )
    .expect("submit")
    .remove(0)
}

fn gets(svc: &FakeLogService) -> usize {
    svc.object_gets(&COL).len()
}

#[test]
fn another_device_applies_fetches_and_materializes_a_multi_chunk_file() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let mut b = b_node(&svc);
    let bytes = Rc::new(data(2 * CHUNK + 1000));
    let (entry, refs) = upload(&mut a, PATH, &bytes);
    let content = content_of(&entry);

    let batches = RefCell::default();
    drive_b(&mut b, &batches, &|_| false);

    // Apply: the row holds the signed descriptor, never bytes, and nobody stalls.
    for n in [&a, &b] {
        assert_eq!(n.r.stalled, None);
        let row = n.r.store().file(&FILE).unwrap().expect("applied");
        assert_eq!(row.path, PATH);
        assert_eq!(row.content, FileContent::AttachmentV1(content.clone()));
    }
    assert_eq!(
        a.r.store().file(&FILE).unwrap().unwrap().local,
        FileLocal::Remote
    );
    // Materialize: the exact bytes, verified, at the path.
    let row = b.r.store().file(&FILE).unwrap().unwrap();
    assert_eq!(row.local, FileLocal::Materialized);
    {
        let disk = b.r.store().att_disk();
        assert_eq!(
            disk.files.get(PATH).map(Vec::as_slice),
            Some(bytes.as_slice())
        );
        assert_eq!(
            mdbn_wire::hash::sha256(&disk.files[PATH]),
            content.whole_plain_hash
        );
        assert!(disk.staging.is_empty(), "staging consumed");
        // Bounded memory: plaintext reached the disk one chunk at a time.
        assert!(disk.max_stage_write as u64 <= CHUNK);
    }
    // The manifest and three chunks, each fetched once; one object in flight.
    assert_eq!(b.r.attachment_chunks_fetched(), 3);
    let fetched: Vec<B32> = svc.object_gets(&COL);
    assert_eq!(fetched.len(), 4);
    assert!(fetched.iter().all(|h| refs.contains(h)));
    for batch in batches.borrow().iter() {
        assert!(
            batch.iter().filter(|m| **m == "get_object").count() <= 1,
            "one object in flight: {batch:?}"
        );
    }
    assert_eq!(b.r.attachment_fetch_status(&FILE), None);
}

#[test]
fn an_empty_attachment_materializes_as_an_empty_file() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let mut b = b_node(&svc);
    upload(&mut a, PATH, &Rc::new(Vec::new()));
    let batches = RefCell::default();
    drive_b(&mut b, &batches, &|_| false);
    assert_eq!(
        b.r.store().att_disk().files.get(PATH).map(Vec::len),
        Some(0)
    );
    assert_eq!(
        b.r.store().file(&FILE).unwrap().unwrap().local,
        FileLocal::Materialized
    );
}

#[test]
fn an_interrupted_fetch_resumes_after_a_restart() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let store = MemStore::new().with_attachment_disk();
    let data_rc = store.data();
    let mut b = attach_node_with(&svc, 2, store);
    let bytes = Rc::new(data(3 * CHUNK + 77));
    upload(&mut a, PATH, &bytes);

    // B stages two chunks, then "crashes".
    let batches = RefCell::default();
    drive_b(&mut b, &batches, &|n| n.r.attachment_chunks_fetched() == 2);
    assert_eq!(
        b.r.store().att_disk().staging.values().next().map(Vec::len),
        Some(2 * CHUNK as usize)
    );
    assert!(
        b.r.store().att_disk().files.is_empty(),
        "nothing published yet"
    );
    drop(b);
    let before = gets(&svc);

    // Reopened: the staged prefix is kept; only the manifest and the two
    // remaining chunks are fetched, and the staging is re-hashed before publish.
    let mut b = attach_node_with(&svc, 2, MemStore::shared(data_rc));
    let batches = RefCell::default();
    drive_b(&mut b, &batches, &|_| false);
    assert_eq!(b.r.attachment_chunks_fetched(), 2);
    assert_eq!(gets(&svc) - before, 3);
    assert_eq!(
        b.r.store().att_disk().files.get(PATH).map(Vec::as_slice),
        Some(bytes.as_slice())
    );
    assert_eq!(
        b.r.store().file(&FILE).unwrap().unwrap().local,
        FileLocal::Materialized
    );
}

#[test]
fn a_tampered_staging_is_caught_by_the_whole_hash_and_fetched_again() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let store = MemStore::new().with_attachment_disk();
    let data_rc = store.data();
    let mut b = attach_node_with(&svc, 2, store);
    let bytes = Rc::new(data(2 * CHUNK + 5));
    upload(&mut a, PATH, &bytes);
    let batches = RefCell::default();
    drive_b(&mut b, &batches, &|n| n.r.attachment_chunks_fetched() == 1);
    drop(b);
    // Something rewrote the staged prefix behind the replica's back.
    {
        let mut d = data_rc.borrow_mut();
        let disk = d.att_disk.as_mut().unwrap();
        let staged = disk.staging.values_mut().next().unwrap();
        staged[10] ^= 0xff;
    }
    let mut b = attach_node_with(&svc, 2, MemStore::shared(data_rc));
    drive_b(&mut b, &batches, &|_| false);
    assert_eq!(
        b.r.store().att_disk().files.get(PATH).map(Vec::as_slice),
        Some(bytes.as_slice()),
        "only verified bytes are published"
    );
}

#[test]
fn rename_moves_the_file_without_refetching_and_delete_unlinks_it() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let mut b = b_node(&svc);
    let bytes = Rc::new(data(CHUNK + 3));
    let (entry, _) = upload(&mut a, PATH, &bytes);
    let content = content_of(&entry);
    let batches = RefCell::default();
    drive_b(&mut b, &batches, &|_| false);
    let fetched = gets(&svc);

    // A renames: a metadata-only entry in the runtime family, same descriptor.
    let r = submit(
        &mut a,
        Op::FileMove(FileMove {
            id: FILE,
            from: PATH.into(),
            to: "moved/big.bin".into(),
            update_refs: false,
            if_revision: None,
        }),
    );
    assert_eq!(r.state, ReceiptState::Pending);
    settle(&mut [&mut a]);
    assert_eq!(a.r.stalled, None);
    drive_b(&mut b, &batches, &|_| false);
    let row = b.r.store().file(&FILE).unwrap().unwrap();
    assert_eq!(row.path, "moved/big.bin");
    assert_eq!(row.content, FileContent::AttachmentV1(content.clone()));
    assert_eq!(row.local, FileLocal::Materialized);
    assert_eq!(gets(&svc), fetched, "a rename fetches nothing");
    {
        let disk = b.r.store().att_disk();
        assert!(!disk.files.contains_key(PATH));
        assert_eq!(
            disk.files.get("moved/big.bin").map(Vec::as_slice),
            Some(bytes.as_slice())
        );
        assert_eq!(
            disk.ops.last().map(String::as_str),
            Some("move files/big.bin moved/big.bin")
        );
    }

    // A deletes: B unlinks, and the tombstone keeps the complete descriptor.
    submit(
        &mut a,
        Op::FileDelete(FileDelete {
            id: FILE,
            if_revision: None,
            base: None,
        }),
    );
    settle(&mut [&mut a]);
    drive_b(&mut b, &batches, &|_| false);
    assert!(b.r.store().file(&FILE).unwrap().is_none());
    assert_eq!(
        b.r.store().tombstone(&FILE).unwrap().unwrap().last,
        TombstoneLast::Attachment(content)
    );
    assert!(b.r.store().att_disk().files.is_empty());
    assert_eq!(gets(&svc), fetched);
}

#[test]
fn a_user_file_at_the_path_is_never_overwritten() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let mut b = b_node(&svc);
    b.r.store()
        .att_disk()
        .files
        .insert(PATH.into(), b"mine".to_vec());
    let bytes = Rc::new(data(100));
    upload(&mut a, PATH, &bytes);
    let batches = RefCell::default();
    drive_b(&mut b, &batches, &|_| false);
    assert_eq!(
        b.r.store().att_disk().files.get(PATH).map(Vec::as_slice),
        Some(&b"mine"[..])
    );
    assert!(matches!(
        b.r.attachment_fetch_status(&FILE),
        Some(AttachmentFetchStatus::Failed(p)) if p.reason.as_deref() == Some("path_occupied")
    ));
    assert_eq!(
        b.r.store().file(&FILE).unwrap().unwrap().local,
        FileLocal::Remote
    );
}

#[test]
fn objects_collected_before_the_fetch_fail_terminally() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let mut b = b_node(&svc);
    let bytes = Rc::new(data(2 * CHUNK));
    let (entry, _) = upload(&mut a, PATH, &bytes);
    // The log's GC collected a chunk (no transfer lease in v1).
    let manifest = content_of(&entry).reference.manifest_cipher_hash;
    let chunk = svc
        .objects(&COL)
        .into_iter()
        .map(|(h, _)| h)
        .find(|h| *h != manifest)
        .unwrap();
    svc.forget_object(&COL, &chunk);
    let batches = RefCell::default();
    drive_b(&mut b, &batches, &|_| false);
    // Applied, not materialized, typed failure, and the driver went idle.
    assert_eq!(b.r.stalled, None);
    assert!(matches!(
        b.r.attachment_fetch_status(&FILE),
        Some(AttachmentFetchStatus::Failed(p))
            if p.reason.as_deref() == Some("attachment_objects_missing")
    ));
    assert!(b.r.take_log_calls().is_empty(), "no retry loop");
    assert!(b.r.sync_status().incidents.iter().any(|i| matches!(
        &i.details,
        Some(Value::Text(t)) if t.contains("attachment_unavailable")
    )));
    assert!(b.r.store().att_disk().files.is_empty());
    assert!(b.r.store().att_disk().staging.is_empty());
}

#[test]
fn a_captured_attachment_whose_objects_vanished_fails_terminally() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let bytes = Rc::new(data(CHUNK + 1));
    let m =
        a.r.start_attachment_upload(
            params(PATH),
            Box::new(Source {
                bytes: bytes.clone(),
                reads: Rc::new(Reads::default()),
            }),
        )
        .unwrap();
    let calls: Calls = Rc::default();
    let appends = std::cell::Cell::new(0);
    // Between capture and append, the log collects one of the objects.
    drive(&mut a, &calls, &mut |req, svc| {
        if let LogRequest::Append(_) = req {
            appends.set(appends.get() + 1);
            if let Some((h, _)) = svc.objects(&COL).into_iter().next() {
                svc.forget_object(&COL, &h);
            }
        }
        None
    });
    // The append loop pauses after a refusal: let it come back once.
    a.clock.set(a.clock.get() + 60_000);
    drive(&mut a, &calls, &mut |req, svc| {
        if let LogRequest::Append(_) = req {
            appends.set(appends.get() + 1);
            if let Some((h, _)) = svc.objects(&COL).into_iter().next() {
                svc.forget_object(&COL, &h);
            }
        }
        None
    });
    a.clock.set(a.clock.get() + 60_000);
    drive(&mut a, &calls, &mut |req, _| {
        if let LogRequest::Append(_) = req {
            appends.set(appends.get() + 1);
        }
        None
    });
    // Refused twice, then a typed terminal failure: no endless retry.
    assert_eq!(appends.get(), 2);
    let AttachmentUploadStatus::Failed(p) = status(&a, &m) else {
        panic!("{:?}", status(&a, &m));
    };
    assert_eq!(p.reason.as_deref(), Some("attachment_objects_missing"));
    assert_eq!(a.r.store().pending_count().unwrap(), 0);
    let lr = a.r.store().local_receipt(&m).unwrap().unwrap();
    assert_eq!(lr.state, ReceiptState::Rejected);
    assert!(
        a.r.sync_status()
            .incidents
            .iter()
            .any(|i| i.kind == IncidentKind::Integrity)
    );
    assert!(a.r.take_log_calls().is_empty());
}

/// An entry recording a file conflict whose sides are attachments: the store
/// keeps ConflictValue5 sides (never a blob), `list_conflicts` serves them,
/// and a descriptor naming another collection voids the entry.
#[test]
fn attachment_conflict_sides_are_kept_whole() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let mut b = b_node(&svc);
    let bytes = Rc::new(data(10));
    let (entry, _) = upload(&mut a, PATH, &bytes);
    let kept = content_of(&entry);
    let mut lost = kept.clone();
    lost.whole_plain_hash = B32([7; 32]);
    lost.reference.manifest_cipher_hash = B32([8; 32]);

    // Rewrite a later entry of A into a conflicted one (verification on B
    // reports the mismatch; the recorded result is what applies).
    let conflicted = |a: &mut Node, lost: AttachmentContentV1, from: &str, to: &str| {
        let r = submit(
            a,
            Op::FileMove(FileMove {
                id: FILE,
                from: from.into(),
                to: to.into(),
                update_refs: false,
                if_revision: None,
            }),
        );
        assert_eq!(r.state, ReceiptState::Pending);
        for _ in 0..20 {
            a.r.tick();
            let calls = a.r.take_log_calls();
            for mut call in calls {
                if let LogRequest::Append(ref mut p) = call.request {
                    let mut item = Item::from_bytes(&p.items[0].0).unwrap();
                    let mut payload = rt::EntryPayload::from_bytes(&item.body.0).unwrap();
                    payload.status = Status::Conflicted;
                    payload.conflicts = Some(vec![rt::Conflict {
                        kind: ConflictKind::File,
                        id: FILE,
                        field: None,
                        base: None,
                        kept: rt::ConflictValue::Attachment(kept.clone()),
                        lost: rt::ConflictValue::Attachment(lost.clone()),
                    }]);
                    item.body.0 = payload.to_bytes().unwrap();
                    p.items[0].0 = item.to_bytes().unwrap();
                }
                let reply = a.log.call(call.request);
                a.r.on_log_reply(call.id, reply);
            }
        }
    };
    let pump_once = |n: &mut Node| {
        n.r.tick();
        for call in n.r.take_log_calls() {
            let reply = n.log.call(call.request);
            n.r.on_log_reply(call.id, reply);
        }
    };
    pump_once(&mut a);
    conflicted(&mut a, lost.clone(), PATH, "x/one.bin");
    let batches = RefCell::default();
    drive_b(&mut b, &batches, &|_| false);
    assert_eq!(b.r.stalled, None);
    let rows = b.r.store().conflicts(Some(&FILE)).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(
        rows[0].conflict.lost,
        rt::ConflictValue::Attachment(lost.clone())
    );
    assert_eq!(
        rows[0].conflict.kept,
        rt::ConflictValue::Attachment(kept.clone())
    );
    let listed = b.r.list_conflicts(b.s, Some(FILE)).unwrap();
    assert_eq!(listed[0].conflict, rows[0].conflict);

    // A side naming another collection is out of range: V7 void, never stored.
    let voided = b.r.stats.voided;
    let mut foreign = lost;
    foreign.reference.collection = B16([0xcc; 16]);
    // The writer's own copy diverged from the rewritten log: write from a
    // fresh device that read it.
    let mut c = attach_node(&svc, 3);
    settle(&mut [&mut c]);
    conflicted(&mut c, foreign, "x/one.bin", "x/two.bin");
    drive_b(&mut b, &batches, &|_| false);
    assert_eq!(b.r.stats.voided, voided + 1);
    assert_eq!(b.r.store().conflicts(Some(&FILE)).unwrap().len(), 1);
}

#[test]
fn hello_grants_read_and_materialize_where_qualified() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let mut b = b_node(&svc);
    let ask = || HelloParams {
        versions: vec![Version { major: 1, minor: 0 }],
        client_name: "app".into(),
        client_version: "0".into(),
        features: Some(
            [
                "attachment-v1",
                "attachment-v1.read",
                "attachment-v1.write",
                "attachment-v1.materialize",
            ]
            .map(String::from)
            .to_vec(),
        ),
        timezone: None,
    };
    let (_, ga) = a.r.hello(SessionAuth::Host, ask()).unwrap();
    assert_eq!(ga.features, vec!["attachment-v1", "attachment-v1.read"]);
    let (_, gb) = b.r.hello(SessionAuth::Host, ask()).unwrap();
    assert_eq!(
        gb.features,
        vec![
            "attachment-v1",
            "attachment-v1.read",
            "attachment-v1.materialize"
        ]
    );
}
