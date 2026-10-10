//! Actual streamed origin edit, rival result, durable hold and cold reopen.
use super::*;
use mdbn_wire::schema::Wire;

#[test]
fn legacy_blob_holds_prepare_full_descriptors_without_side_effects_and_ignore_successful_siblings()
{
    // Codec fixture metadata only; this is not a crypto/provider source proof.
    let fixture = mdbn_wire::fixtures::all()
        .into_iter()
        .find(|f| f.format == "client" && f.name == "hold-file")
        .unwrap();
    let example = mdbn_wire::client::Hold::from_bytes(&fixture.bytes).unwrap();
    let TextOrBlob::Blob(mine) = example.mine else {
        panic!("genuine legacy arm")
    };
    let Some(TextOrBlob::Blob(kept)) = example.theirs else {
        panic!("legacy kept")
    };
    let svc = FakeLogService::new();
    let (mut n, _) = ingest_node(&svc, 2);
    let id = mdbn_wire::common::B16([73; 16]);
    let sibling = mdbn_wire::common::B16([74; 16]);
    let put = |id| {
        mdbn_wire::intent::Op::FilePut(mdbn_wire::intent::FilePut {
            id,
            path: PATH.into(),
            blob: mine.clone(),
            if_revision: None,
            base: None,
        })
    };
    let legacy = n.r.capture(
        vec![put(id), put(sibling)],
        mdbn_wire::intent::Source::External,
    );
    let mutation = rt::Mutation::from_bytes(&legacy.to_bytes().unwrap()).unwrap();
    let conflict = rt::Conflict {
        id,
        kind: mdbn_wire::entry::ConflictKind::File,
        field: None,
        base: Some(rt::ConflictValue::Legacy(
            mdbn_wire::entry::ConflictValue::Blob(kept.clone()),
        )),
        kept: rt::ConflictValue::Legacy(mdbn_wire::entry::ConflictValue::Blob(kept.clone())),
        lost: rt::ConflictValue::Legacy(mdbn_wire::entry::ConflictValue::Blob(mine.clone())),
    };
    let mut tx = crate::store::Tx::default();
    tx.files_put.push(crate::store::FileRow {
        id,
        path: PATH.into(),
        path_key: mdbn_core::paths::path_key(PATH),
        content: FileContent::Blob(kept.clone()),
        kind: mdbn_wire::unindexed_markdown::FileKindV1::Ordinary,
        local: FileLocal::Remote,
        media: mdbn_wire::intent::MediaClass::Other,
        modified_seq: 1,
        bucket: 0,
    });
    for mode in ["foreign_origin", "api", "no_conflict"] {
        let mut other = mutation.clone();
        match mode {
            "foreign_origin" => other.origin = mdbn_wire::common::B16([99; 16]),
            "api" => other.source = mdbn_wire::intent::Source::Api,
            _ => {}
        }
        let mut refused = crate::store::Tx::default();
        n.r.prepare_conflict_holds(
            &other,
            if mode == "no_conflict" {
                &[]
            } else {
                std::slice::from_ref(&conflict)
            },
            &mut refused,
            &crate::convert::inline_only,
        )
        .unwrap();
        assert!(
            refused.holds_put.is_empty(),
            "{mode} cannot create a local hold"
        );
    }
    n.r.prepare_conflict_holds(
        &mutation,
        &[conflict],
        &mut tx,
        &crate::convert::inline_only,
    )
    .unwrap();
    assert!(
        n.r.store().hold(&id).unwrap().is_none(),
        "preparation never commits"
    );
    assert_eq!(tx.holds_put.len(), 1, "successful siblings are not held");
    assert_eq!(tx.holds_put[0].mine, TextOrBlob::Blob(mine));
    assert_eq!(tx.holds_put[0].base, Some(TextOrBlob::Blob(kept.clone())));
    assert_eq!(tx.holds_put[0].theirs, Some(TextOrBlob::Blob(kept)));
    n.r.store.commit(tx).unwrap();
    assert!(n.r.file_materialization_fenced(id, Some(PATH)).unwrap());
    assert!(
        n.r.file_materialization_fenced(sibling, Some(PATH))
            .unwrap(),
        "same path collision is fenced even with a different holder ID"
    );
    assert!(
        !n.r.file_materialization_fenced(sibling, Some("elsewhere.bin"))
            .unwrap()
    );
}
use mdbn_wire::{
    attachment_runtime_v1 as rt,
    client::{HoldReason, ReceiptState},
    entry::Status,
    snapshot::TextOrBlob,
};

fn capture_offline(n: &mut Node) -> crate::store::PendingRow {
    n.r.observe(None).unwrap();
    for _ in 0..100 {
        let pending = n.r.store().pending(None, 256).unwrap();
        if let Some(row) = pending.first() {
            return row.clone();
        }
        let calls = n.r.take_log_calls();
        assert!(!calls.is_empty(), "streamed upload must make progress");
        for call in calls {
            assert!(
                !matches!(call.request, LogRequest::Append { .. }),
                "do not order origin edit yet"
            );
            let reply = n.log.call(call.request);
            n.r.on_log_reply(call.id, reply);
        }
    }
    panic!("no captured edit")
}

#[test]
fn losing_external_attachment_is_a_full_typed_hold_before_publish_and_after_restart() {
    let svc = FakeLogService::new();
    let (mut winner, _) = ingest_node(&svc, 1);
    let (mut origin, durable) = ingest_node(&svc, 2);
    user(&mut winner, |d| d.user_write(PATH, b"base"));
    sync(&mut origin);
    let id = file_at(&origin, PATH).unwrap().id;
    let lost = b"offline origin binary\0\xff";
    origin.r.store().att_disk().user_write(PATH, lost);
    let pending = capture_offline(&mut origin);
    let rt::Op::FileAttach(edit) = &pending.mutation.ops[0] else {
        panic!("typed captured edit")
    };
    let mine = edit.content.clone();
    assert_eq!(mine.whole_plain_hash, mdbn_wire::hash::sha256(lost));
    user(&mut winner, |d| {
        d.user_write(PATH, b"rival confirmed binary")
    });
    let kept = file_at(&winner, PATH).unwrap().content;
    sync(&mut origin);
    let receipt = origin
        .r
        .store()
        .local_receipt(&pending.mutation.id)
        .unwrap()
        .unwrap();
    assert_eq!(receipt.state, ReceiptState::Confirmed);
    assert_eq!(receipt.status, Some(Status::Conflicted));
    let held = origin
        .r
        .store()
        .hold(&id)
        .unwrap()
        .expect("losing external file MUST be held");
    assert_eq!(held.reason, HoldReason::Conflict);
    assert_eq!(held.path, PATH);
    assert_eq!(held.mine, TextOrBlob::Attachment(mine.clone()));
    let FileContent::AttachmentV1(kept_content) = &kept else {
        panic!("typed rival")
    };
    assert_eq!(
        held.theirs,
        Some(TextOrBlob::Attachment(kept_content.clone()))
    );
    assert_eq!(
        file_at(&origin, PATH).unwrap().content,
        kept,
        "confirmed state keeps rival"
    );
    assert_eq!(
        origin.r.store().att_disk().files[PATH],
        lost,
        "disk keeps user's losing bytes"
    );
    let conflicts = origin.r.store().conflicts(Some(&id)).unwrap();
    assert!(
        conflicts.iter().any(|c| c.mutation == pending.mutation.id
            && c.conflict.lost == rt::ConflictValue::Attachment(mine.clone())),
        "same complete descriptor retained by conflict"
    );
    let confirmed_head = origin.r.head();
    let newer_save = b"newer held external binary\0\xfe";
    user(&mut origin, |d| d.user_write(PATH, newer_save));
    let latest = origin
        .r
        .store()
        .hold(&id)
        .unwrap()
        .expect("held save collected");
    assert_eq!(latest.since, held.since);
    assert_eq!(latest.saves, 2);
    let TextOrBlob::Attachment(latest_content) = &latest.mine else {
        panic!("complete typed held save")
    };
    assert_eq!(
        latest_content.whole_plain_hash,
        mdbn_wire::hash::sha256(newer_save)
    );
    assert_eq!(latest_content.total_plain_bytes, newer_save.len() as u64);
    assert_eq!(latest.theirs, held.theirs);
    assert_eq!(origin.r.head(), confirmed_head, "held saves never append");
    assert_eq!(origin.r.store().pending_count().unwrap(), 0);
    assert_eq!(file_at(&origin, PATH).unwrap().content, kept);
    assert_eq!(origin.r.store().att_disk().files[PATH], newer_save);
    assert!(origin.r.store().att_disk().outstanding.is_empty());
    drop(origin);
    durable.borrow_mut().att_disk.as_mut().unwrap().restart();
    let mut reopened = attach_node_with(&svc, 2, MemStore::shared(durable));
    sync(&mut reopened);
    assert_eq!(reopened.r.store().hold(&id).unwrap(), Some(latest));
    assert_eq!(
        reopened.r.store().att_disk().files[PATH],
        newer_save,
        "reopen cannot reconcile over the latest held save"
    );
    assert_eq!(file_at(&reopened, PATH).unwrap().content, kept);
    assert_eq!(reopened.r.attachment_fetch_status(&id), None);
    assert!(
        winner.r.store().hold(&id).unwrap().is_none(),
        "hold is origin-local"
    );
}

#[test]
fn inflight_attachment_reply_after_a_genuine_conflict_hold_cannot_publish() {
    let svc = FakeLogService::new();
    let (mut winner, _) = ingest_node(&svc, 1);
    let (mut origin, _) = ingest_node(&svc, 2);
    user(&mut winner, |d| d.user_write(PATH, b"base"));
    sync(&mut origin);
    let id = file_at(&origin, PATH).unwrap().id;
    user(&mut winner, |d| d.user_write(PATH, b"rival"));
    let rows = svc.items(&COL);
    origin.r.apply_items(
        rows.iter()
            .enumerate()
            .skip(origin.r.head().seq as usize)
            .map(|(i, raw)| mdbn_wire::log_service::SeqItem {
                seq: i as u64 + 1,
                item: mdbn_wire::common::Bytes(raw.clone()),
            })
            .collect(),
    );
    let mut delayed = Vec::new();
    for call in origin.r.take_log_calls() {
        if matches!(call.request, LogRequest::GetObject { .. }) {
            delayed.push(call);
        } else {
            let reply = origin.log.call(call.request);
            origin.r.on_log_reply(call.id, reply);
        }
    }
    assert_eq!(
        delayed.len(),
        1,
        "actual fetch is in flight before the edit"
    );
    let lost = b"external edit after rival read\0\xff";
    origin.r.store().att_disk().user_write(PATH, lost);
    let pending = capture_offline(&mut origin);
    assert!(matches!(&pending.mutation.ops[0], rt::Op::FileAttach(f)
        if f.base == Some(mdbn_wire::hash::sha256(b"base"))));
    sync(&mut origin);
    let held = origin
        .r
        .store()
        .hold(&id)
        .unwrap()
        .expect("genuine conflict hold");
    let row = file_at(&origin, PATH).unwrap();
    assert_eq!(
        origin
            .r
            .store()
            .local_receipt(&pending.mutation.id)
            .unwrap()
            .unwrap()
            .status,
        Some(Status::Conflicted)
    );
    for call in delayed {
        let reply = origin.log.call(call.request);
        origin.r.on_log_reply(call.id, reply);
    }
    sync(&mut origin);
    assert_eq!(origin.r.store().att_disk().files[PATH], lost);
    assert_eq!(origin.r.store().hold(&id).unwrap(), Some(held));
    assert_eq!(file_at(&origin, PATH).unwrap(), row);
    assert_eq!(origin.r.attachment_fetch_status(&id), None);
}

#[test]
fn conflict_apply_hold_receipt_and_head_share_atomic_abort_or_unknown_recovery() {
    for fault in 0..3 {
        let svc = FakeLogService::new();
        let (mut winner, _) = ingest_node(&svc, 1);
        let (mut source, durable) = ingest_node(&svc, 2);
        user(&mut winner, |d| d.user_write(PATH, b"base"));
        sync(&mut source);
        let id = file_at(&source, PATH).unwrap().id;
        let lost = b"checkpointed origin bytes\0\xff";
        source.r.store().att_disk().user_write(PATH, lost);
        let pending = capture_offline(&mut source);
        let checkpoint = durable.borrow().clone();
        user(&mut winner, |d| d.user_write(PATH, b"rival confirmed"));
        sync(&mut source);
        let confirmed = source
            .r
            .store()
            .local_receipt(&pending.mutation.id)
            .unwrap()
            .unwrap();
        assert_eq!(confirmed.status, Some(Status::Conflicted));
        let seq = confirmed.seq.unwrap();
        let expected_hold = source.r.store().hold(&id).unwrap().unwrap();
        let replay_data = Rc::new(std::cell::RefCell::new(checkpoint));
        let mut replay = super::super::attachment_upload::attach_node_without_drive(
            &svc,
            2,
            MemStore::shared(replay_data.clone()),
        );
        let before = replay.r.head();
        assert!(replay.r.store().hold(&id).unwrap().is_none());
        let items: Vec<_> = svc
            .items(&COL)
            .iter()
            .enumerate()
            .skip(before.seq as usize)
            .map(|(i, raw)| mdbn_wire::log_service::SeqItem {
                seq: i as u64 + 1,
                item: mdbn_wire::common::Bytes(raw.clone()),
            })
            .collect();
        match fault {
            0 => replay.r.store.fail_commits(1),
            1 => replay.r.store.fail_unknown_commits(1),
            _ => replay_data.borrow_mut().fail_after_head_commit = Some(seq),
        }
        // One genuine ordered batch: no intermediate rebase-created hold can
        // substitute for the own conflict apply/head/receipt transaction.
        replay.r.apply_items(items.clone());
        assert_eq!(replay.r.requires_reopen(), fault != 0);
        let landed = fault == 2;
        assert_eq!(
            replay.r.store().head().unwrap().seq,
            if landed { seq } else { before.seq }
        );
        assert_eq!(replay.r.store().hold(&id).unwrap().is_some(), landed);
        assert_eq!(
            replay.r.store().pending_count().unwrap(),
            u64::from(!landed)
        );
        let receipt = replay
            .r
            .store()
            .local_receipt(&pending.mutation.id)
            .unwrap();
        assert_eq!(
            receipt
                .as_ref()
                .is_some_and(|r| r.state == ReceiptState::Confirmed),
            landed
        );
        assert_eq!(replay.r.store().att_disk().files[PATH], lost);
        if fault == 0 {
            replay.r.apply_items(items);
            assert_eq!(
                replay.r.store().hold(&id).unwrap(),
                Some(expected_hold.clone())
            );
            assert_eq!(replay.r.head().seq, seq);
        } else {
            let actor_head = replay.r.head();
            replay.r.tick();
            replay.r.apply_items(items);
            assert_eq!(replay.r.head(), actor_head, "unknown state cannot retry");
            assert!(replay.r.take_log_calls().is_empty());
            assert!(replay.r.build_snapshot_now().is_err());
        }
        drop(replay);
        let mut reopened = attach_node_with(&svc, 2, MemStore::shared(replay_data));
        sync(&mut reopened);
        assert_eq!(reopened.r.store().hold(&id).unwrap(), Some(expected_hold));
        assert_eq!(
            reopened
                .r
                .store()
                .local_receipt(&pending.mutation.id)
                .unwrap(),
            Some(confirmed)
        );
        assert_eq!(reopened.r.store().att_disk().files[PATH], lost);
        assert_eq!(reopened.r.store().pending_count().unwrap(), 0);
    }
}

fn held_pair(svc: &FakeLogService) -> (Node, Node, Rc<std::cell::RefCell<MemData>>) {
    let (mut winner, _) = ingest_node(svc, 1);
    let (mut origin, durable) = ingest_node(svc, 2);
    user(&mut winner, |d| d.user_write(PATH, b"base"));
    sync(&mut origin);
    origin
        .r
        .store()
        .att_disk()
        .user_write(PATH, b"first losing bytes");
    let pending = capture_offline(&mut origin);
    user(&mut winner, |d| d.user_write(PATH, b"rival"));
    sync(&mut origin);
    assert_eq!(
        origin
            .r
            .store()
            .local_receipt(&pending.mutation.id)
            .unwrap()
            .unwrap()
            .status,
        Some(Status::Conflicted)
    );
    assert!(
        origin
            .r
            .store()
            .hold(&file_at(&origin, PATH).unwrap().id)
            .unwrap()
            .is_some()
    );
    (winner, origin, durable)
}

#[test]
fn held_moves_and_deletes_stay_observed_without_propagating() {
    for moved in [true, false] {
        let svc = FakeLogService::new();
        let (winner, mut origin, _) = held_pair(&svc);
        let id = file_at(&origin, PATH).unwrap().id;
        let hold = origin.r.store().hold(&id).unwrap().unwrap();
        let head = origin.r.head();
        if moved {
            origin
                .r
                .store()
                .att_disk()
                .user_move(PATH, "media/held-renamed.bin");
        } else {
            origin.r.store().att_disk().user_remove(PATH);
        }
        origin.r.observe(None).unwrap();
        sync(&mut origin);
        assert_eq!(origin.r.head(), head);
        assert_eq!(origin.r.store().pending_count().unwrap(), 0);
        assert_eq!(origin.r.store().hold(&id).unwrap(), Some(hold));
        assert!(!origin.r.store().att_disk().outstanding.is_empty());
        assert_eq!(
            file_at(&origin, PATH).unwrap().content,
            file_at(&winner, PATH).unwrap().content
        );
        assert!(file_at(&origin, "media/held-renamed.bin").is_none());
        assert!(!origin.r.store().att_disk().files.contains_key(PATH));
        if moved {
            assert_eq!(
                origin.r.store().att_disk().files["media/held-renamed.bin"],
                b"first losing bytes"
            );
        }
    }
}

#[test]
fn held_save_generation_drift_during_upload_cannot_replace_or_ack_the_new_hold() {
    let svc = FakeLogService::new();
    let (_winner, mut origin, _) = held_pair(&svc);
    let id = file_at(&origin, PATH).unwrap().id;
    let head = origin.r.head();
    let raw = b"new raw bytes while generation changes";
    origin.r.store().att_disk().user_write(PATH, raw);
    origin.r.observe(None).unwrap();
    let mut changed = None;
    for _ in 0..100 {
        let calls = origin.r.take_log_calls();
        if calls.is_empty() {
            break;
        }
        for call in calls {
            assert!(!matches!(call.request, LogRequest::Append { .. }));
            if matches!(&call.request, LogRequest::HasObjects { addresses, .. } if addresses.len() == 2)
                && changed.is_none()
            {
                // A concurrent resolver/save changes the durable Hold, not a
                // synthetic authority capsule or upload result.
                let mut hold = origin.r.store().hold(&id).unwrap().unwrap();
                hold.saves += 1;
                origin
                    .r
                    .store
                    .commit(crate::store::Tx {
                        holds_put: vec![hold.clone()],
                        ..crate::store::Tx::default()
                    })
                    .unwrap();
                changed = Some(hold);
            }
            let reply = origin.log.call(call.request);
            origin.r.on_log_reply(call.id, reply);
        }
    }
    assert!(changed.is_some());
    assert_eq!(origin.r.store().hold(&id).unwrap(), changed);
    assert!(!origin.r.store().att_disk().outstanding.is_empty());
    assert_eq!(origin.r.store().att_disk().files[PATH], raw);
    assert_eq!(origin.r.store().pending_count().unwrap(), 0);
    assert_eq!(origin.r.head(), head);
}

#[test]
fn held_save_abort_or_unknown_commit_preserves_evidence_and_requires_authoritative_reopen() {
    for fault in 0..3 {
        let svc = FakeLogService::new();
        let (_winner, mut origin, durable) = held_pair(&svc);
        let id = file_at(&origin, PATH).unwrap().id;
        let before = origin.r.store().hold(&id).unwrap().unwrap();
        let head = origin.r.head();
        let raw = b"latest save despite commit fault\0\xff";
        origin.r.store().att_disk().user_write(PATH, raw);
        origin.r.observe(None).unwrap();
        let mut injected = false;
        for _ in 0..100 {
            let calls = origin.r.take_log_calls();
            if calls.is_empty() {
                break;
            }
            for call in calls {
                assert!(!matches!(call.request, LogRequest::Append { .. }));
                let final_check = matches!(&call.request, LogRequest::HasObjects { addresses, .. }
                    if addresses.len() == 2);
                if final_check && !injected {
                    match fault {
                        0 => origin.r.store.fail_commits(1),
                        1 => origin.r.store.fail_unknown_commits(1),
                        _ => origin.r.store.fail_after_commit(1),
                    }
                    injected = true;
                }
                let reply = origin.log.call(call.request);
                origin.r.on_log_reply(call.id, reply);
            }
            if injected {
                break;
            }
        }
        assert!(
            injected,
            "fault must target the final complete-closure hold+ACK commit"
        );
        assert_eq!(origin.r.requires_reopen(), fault != 0);
        assert_eq!(origin.r.head(), head);
        assert_eq!(origin.r.store.pending_count().unwrap(), 0);
        assert_eq!(origin.r.store().att_disk().files[PATH], raw);
        let saved = origin.r.store().hold(&id).unwrap().unwrap();
        assert_eq!(
            saved.saves,
            if fault == 2 {
                before.saves + 1
            } else {
                before.saves
            }
        );
        assert_eq!(
            origin.r.store().att_disk().outstanding.is_empty(),
            fault == 2,
            "hold metadata and observation acknowledgement are atomic"
        );
        if fault != 0 {
            origin.r.tick();
            assert!(
                origin.r.take_log_calls().is_empty(),
                "unknown commit must not retry or append"
            );
            assert!(origin.r.build_snapshot_now().is_err());
        }
        drop(origin);
        {
            let mut data = durable.borrow_mut();
            let disk = data.att_disk.as_mut().unwrap();
            let unacked = disk.restart();
            assert_eq!(unacked.is_empty(), fault == 2);
            // The toy disk does not scan automatically: model the actual
            // native reopen full scan without synthesizing a source descriptor.
            disk.rescan(PATH);
        }
        let mut reopened = attach_node_with(&svc, 2, MemStore::shared(durable));
        assert_eq!(reopened.r.store().hold(&id).unwrap(), Some(saved));
        reopened.r.observe(None).unwrap();
        sync(&mut reopened);
        assert_eq!(reopened.r.store().att_disk().files[PATH], raw);
        let latest = reopened.r.store().hold(&id).unwrap().unwrap();
        assert!(matches!(latest.mine, TextOrBlob::Attachment(c)
            if c.whole_plain_hash == mdbn_wire::hash::sha256(raw)));
        assert_eq!(
            reopened.r.head(),
            head,
            "recovered held saves are local, never appended"
        );
    }
}
