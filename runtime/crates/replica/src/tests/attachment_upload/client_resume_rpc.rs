//! Native RPC restart/reconnect qualification uses real attachment crypto/FakeLog.
use super::client_rpc::{open, request};
use super::*;
use crate::api::{ClientApi, SessionAuth};
use crate::frames::Frames;
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::client::{
    ClientFrame, HelloParams, OpenUploadParams, OpenUploadResult, UploadChunkParams,
};
use mdbn_wire::common::{Bytes, Version};

fn params(size: u64) -> OpenUploadParams {
    OpenUploadParams {
        transfer: B16([0x79; 16]),
        path: "files/native-rpc.bin".into(),
        size,
        digest: None,
        file_id: None,
        if_revision: None,
        mutation_id: Some(B16([0x78; 16])),
    }
}
fn hello(a: &mut Node, frames: &mut Frames) -> crate::api::SessionId {
    let p = HelloParams {
        versions: vec![Version { major: 1, minor: 1 }],
        client_name: "resumer".into(),
        client_version: "1".into(),
        features: None,
        timezone: None,
    };
    frames
        .hello(
            &mut a.r,
            SessionAuth::Host,
            &request(0, "hello", p.to_cbor()),
        )
        .session
        .unwrap()
}
fn fragment(
    a: &mut Node,
    frames: &mut Frames,
    session: crate::api::SessionId,
    index: u64,
    byte: u8,
    size: usize,
) {
    frames.on_frame(
        &mut a.r,
        session,
        &request(
            index + 100,
            "upload_chunk",
            UploadChunkParams {
                transfer: B16([0x79; 16]),
                index,
                bytes: Bytes(vec![byte; size]),
            }
            .to_cbor(),
        ),
    );
    let out = frames.take_outgoing();
    assert!(out.iter().any(|(_, bytes)| matches!(ClientFrame::from_cbor(&cbor::decode(bytes).unwrap()).unwrap(), ClientFrame::Response(r) if r.id == index + 100 && r.result.is_some())));
}
#[test]
fn captured_live_or_recovered_lane_admits_a_new_transfer_without_withdrawing_the_original() {
    for recovered in [false, true] {
        let svc = FakeLogService::new();
        let mut a = attach_node(&svc, 1);
        let mut frames = Frames::new();
        let (session, original) = open(&mut a, &mut frames, 0);
        let mut actual = None;
        for _ in 0..8 {
            match a.r.commit_upload(session, original.transfer) {
                Ok(receipt) => {
                    actual = Some(receipt);
                    break;
                }
                Err(error) => assert_eq!(
                    error.into_problem().reason.as_deref(),
                    Some("file_upload_pending")
                ),
            }
            drive(&mut a, &Rc::default(), &mut |_, _| None);
        }
        let original_mutation = actual.unwrap().mutation;
        drive(&mut a, &Rc::default(), &mut |_, _| None);
        if recovered {
            let store = a.r.into_store();
            a = attach_node_with(&svc, 1, store);
            frames = Frames::new();
        }
        let current = if recovered {
            hello(&mut a, &mut frames)
        } else {
            session
        };
        if recovered {
            assert_eq!(
                a.r.open_upload(current, params(0))
                    .unwrap_err()
                    .into_problem()
                    .reason
                    .as_deref(),
                Some("file_upload_pending")
            );
            drive(&mut a, &Rc::default(), &mut |_, _| None);
            assert_eq!(
                a.r.open_upload(current, params(0)).unwrap().file_id,
                original.file_id
            );
        }
        let receipt = a.r.receipt(current, original_mutation).unwrap().to_cbor();
        let mut next = params(0);
        next.transfer = B16([0x61; 16]);
        next.mutation_id = Some(B16([0x62; 16]));
        next.path = "files/successor.bin".into();
        let foreign = hello(&mut a, &mut frames);
        assert!(a.r.open_upload(foreign, next.clone()).is_err());
        let mut changed = params(0);
        changed.path = next.path.clone();
        assert_eq!(
            a.r.open_upload(current, changed)
                .unwrap_err()
                .into_problem()
                .reason
                .as_deref(),
            Some("attachment_upload_scope_changed")
        );
        assert_eq!(
            a.r.open_upload(current, next.clone())
                .unwrap_err()
                .into_problem()
                .reason
                .as_deref(),
            Some("file_upload_pending")
        );
        drive(&mut a, &Rc::default(), &mut |_, _| None);
        let fresh = a.r.open_upload(current, next).unwrap();
        assert_ne!(fresh.file_id, original.file_id);
        assert!(fresh.received.is_empty());
        assert_eq!(
            a.r.receipt(current, original_mutation).unwrap().to_cbor(),
            receipt
        );
        assert!(
            a.r.store()
                .file(&original.file_id.unwrap())
                .unwrap()
                .is_some()
        );
        a.r.abort_upload(current, fresh.transfer).unwrap();
        assert_eq!(
            a.r.receipt(current, original_mutation).unwrap().to_cbor(),
            receipt
        );
    }
}

#[test]
fn resumed_open_waits_for_rehash_and_only_advertises_committed_prefix_then_completes() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let mut frames = Frames::new();
    let size = 10 << 20;
    let (session, original) = open(&mut a, &mut frames, size);
    for index in 0..8 {
        fragment(&mut a, &mut frames, session, index, 0x41, 1 << 20);
    }
    drive(&mut a, &Rc::default(), &mut |_, _| None);
    fragment(&mut a, &mut frames, session, 8, 0x7f, 1 << 20); // tentative only
    frames.close(&mut a.r, session);
    assert!(a.r.test_attachment_read_region().held_lease().is_none());
    let fresh = hello(&mut a, &mut frames);
    frames.on_frame(
        &mut a.r,
        fresh,
        &request(42, "open_upload", params(size).to_cbor()),
    );
    assert!(frames.take_outgoing().is_empty());
    let mut gets = 0;
    drive(&mut a, &Rc::default(), &mut |request, _| {
        if matches!(request, LogRequest::GetObject { .. }) {
            gets += 1;
        }
        None
    });
    assert_eq!(gets, 2); // journal plus committed sealed chunk
    frames.pump(&mut a.r);
    let resumed = frames
        .take_outgoing()
        .into_iter()
        .find_map(|(_, bytes)| {
            match ClientFrame::from_cbor(&cbor::decode(&bytes).unwrap()).unwrap() {
                ClientFrame::Response(r) if r.id == 42 => {
                    Some(OpenUploadResult::from_cbor(&r.result.unwrap()).unwrap())
                }
                _ => None,
            }
        })
        .unwrap();
    assert_eq!(resumed.file_id, original.file_id);
    assert_eq!(resumed.received, (0..8).collect::<Vec<_>>());
    assert_eq!(resumed.expires_at, original.expires_at);
    // Complete the resumed window out of order; the tentative old byte is gone.
    fragment(&mut a, &mut frames, fresh, 9, 0x43, 1 << 20);
    fragment(&mut a, &mut frames, fresh, 8, 0x42, 1 << 20);
    drive(&mut a, &Rc::default(), &mut |_, _| None);
    frames.on_frame(
        &mut a.r,
        fresh,
        &request(
            43,
            "commit_upload",
            Cbor::Map(vec![(Cbor::Uint(0), original.transfer.to_cbor())]),
        ),
    );
    drive(&mut a, &Rc::default(), &mut |_, _| None);
    frames.pump(&mut a.r);
    let receipt = frames
        .take_outgoing()
        .into_iter()
        .find_map(|(_, bytes)| {
            match ClientFrame::from_cbor(&cbor::decode(&bytes).unwrap()).unwrap() {
                ClientFrame::Response(r) if r.id == 43 => {
                    Some(mdbn_wire::client::Receipt::from_cbor(&r.result.unwrap()).unwrap())
                }
                _ => None,
            }
        })
        .unwrap();
    assert_eq!(receipt.mutation, params(size).mutation_id.unwrap());
    let row =
        a.r.store()
            .file(&original.file_id.unwrap())
            .unwrap()
            .unwrap();
    let mut expected = vec![0x41; 8 << 20];
    expected.extend(vec![0x42; 1 << 20]);
    expected.extend(vec![0x43; 1 << 20]);
    assert_eq!(row.content.plain_hash(), mdbn_wire::hash::sha256(&expected));
    let (entry, _) = last_entry(&a, &svc);
    assert_eq!(row.mtime, Some(entry.mutation.clock.instant));
}
#[test]
fn cold_native_frame_open_authenticates_saved_journal_and_reuses_original_uuid() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let mut frames = Frames::new();
    let (session, original) = open(&mut a, &mut frames, 31);
    fragment(&mut a, &mut frames, session, 0, 0x41, 31);
    drive(&mut a, &Rc::default(), &mut |_, _| None);
    let store = a.r.into_store();
    let mut cold = attach_node_with(&svc, 1, store);
    let mut fresh_frames = Frames::new();
    let fresh = hello(&mut cold, &mut fresh_frames);
    fresh_frames.on_frame(
        &mut cold.r,
        fresh,
        &request(42, "open_upload", params(31).to_cbor()),
    );
    assert!(fresh_frames.take_outgoing().is_empty());
    drive(&mut cold, &Rc::default(), &mut |_, _| None);
    fresh_frames.pump(&mut cold.r);
    let resumed = fresh_frames
        .take_outgoing()
        .into_iter()
        .find_map(|(_, bytes)| {
            match ClientFrame::from_cbor(&cbor::decode(&bytes).unwrap()).unwrap() {
                ClientFrame::Response(r) if r.id == 42 => {
                    Some(OpenUploadResult::from_cbor(&r.result.unwrap()).unwrap())
                }
                _ => None,
            }
        })
        .unwrap();
    assert_eq!(resumed.file_id, original.file_id);
    assert_eq!(resumed.received, vec![0]);
    assert_eq!(resumed.expires_at, original.expires_at);
    fresh_frames.on_frame(
        &mut cold.r,
        fresh,
        &request(
            43,
            "commit_upload",
            Cbor::Map(vec![(Cbor::Uint(0), original.transfer.to_cbor())]),
        ),
    );
    drive(&mut cold, &Rc::default(), &mut |_, _| None);
    fresh_frames.pump(&mut cold.r);
    assert!(fresh_frames.take_outgoing().iter().any(|(_, bytes)| matches!(ClientFrame::from_cbor(&cbor::decode(bytes).unwrap()).unwrap(), ClientFrame::Response(r) if r.id == 43 && r.result.is_some())));
    assert!(
        cold.r
            .store()
            .file(&original.file_id.unwrap())
            .unwrap()
            .is_some()
    );
}

#[test]
fn zero_prefix_cold_open_preserves_identity_before_any_file_bytes_including_empty_file() {
    for size in [0, 31] {
        let svc = FakeLogService::new();
        let mut a = attach_node(&svc, 1);
        let mut frames = Frames::new();
        let (session, original) = open(&mut a, &mut frames, size);
        let mutation = params(size).mutation_id.unwrap();
        assert_eq!(
            a.r.attachment_region_progress(session, &mutation)
                .unwrap()
                .committed_chunks,
            0
        );
        assert_eq!(
            svc.objects(&COL).len(),
            1,
            "only encrypted identity journal, no file bytes"
        );
        let store = a.r.into_store();
        let mut cold = attach_node_with(&svc, 1, store);
        let mut fresh_frames = Frames::new();
        let fresh = hello(&mut cold, &mut fresh_frames);
        fresh_frames.on_frame(
            &mut cold.r,
            fresh,
            &request(42, "open_upload", params(size).to_cbor()),
        );
        assert!(fresh_frames.take_outgoing().is_empty());
        let mut gets = 0;
        drive(&mut cold, &Rc::default(), &mut |request, _| {
            if matches!(request, LogRequest::GetObject { .. }) {
                gets += 1;
            }
            None
        });
        assert_eq!(gets, 1, "no uncommitted chunk is invented or rehashed");
        fresh_frames.pump(&mut cold.r);
        let resumed = fresh_frames
            .take_outgoing()
            .into_iter()
            .find_map(|(_, bytes)| {
                match ClientFrame::from_cbor(&cbor::decode(&bytes).unwrap()).unwrap() {
                    ClientFrame::Response(r) if r.id == 42 => {
                        Some(OpenUploadResult::from_cbor(&r.result.unwrap()).unwrap())
                    }
                    _ => None,
                }
            })
            .unwrap();
        assert_eq!(resumed.file_id, original.file_id);
        assert_eq!(resumed.expires_at, original.expires_at);
        assert!(resumed.received.is_empty());
        if size > 0 {
            fragment(&mut cold, &mut fresh_frames, fresh, 0, 0x41, size as usize);
        }
        fresh_frames.on_frame(
            &mut cold.r,
            fresh,
            &request(
                43,
                "commit_upload",
                Cbor::Map(vec![(Cbor::Uint(0), original.transfer.to_cbor())]),
            ),
        );
        for _ in 0..3 {
            drive(&mut cold, &Rc::default(), &mut |_, _| None);
            fresh_frames.pump(&mut cold.r);
        }
        let receipt = fresh_frames
            .take_outgoing()
            .into_iter()
            .find_map(|(_, bytes)| {
                match ClientFrame::from_cbor(&cbor::decode(&bytes).unwrap()).unwrap() {
                    ClientFrame::Response(r) if r.id == 43 => {
                        Some(mdbn_wire::client::Receipt::from_cbor(&r.result.unwrap()).unwrap())
                    }
                    _ => None,
                }
            })
            .unwrap();
        assert_eq!(receipt.mutation, mutation);
        assert_eq!(
            cold.r
                .store()
                .file(&original.file_id.unwrap())
                .unwrap()
                .unwrap()
                .content
                .plain_hash(),
            mdbn_wire::hash::sha256(&vec![0x41; size as usize])
        );
    }
}

#[test]
fn initial_journal_refusal_or_unknown_put_never_exposes_identity_or_accepts_file_bytes() {
    for unknown in [false, true] {
        let svc = FakeLogService::new();
        let mut a = attach_node(&svc, 1);
        let mut frames = Frames::new();
        let session = hello(&mut a, &mut frames);
        frames.on_frame(
            &mut a.r,
            session,
            &request(42, "open_upload", params(31).to_cbor()),
        );
        assert!(frames.take_outgoing().is_empty());
        let owner =
            a.r.client_resume_owner(session, params(31).mutation_id.unwrap())
                .unwrap();
        assert!(a.r.client_resume_reference(owner).unwrap().is_none());
        assert_eq!(
            a.r.upload_chunk(
                session,
                UploadChunkParams {
                    transfer: params(31).transfer,
                    index: 0,
                    bytes: Bytes(vec![0x41; 31])
                }
            )
            .unwrap_err()
            .into_problem()
            .reason
            .as_deref(),
            Some("file_upload_pending")
        );
        let mut puts = 0;
        drive(&mut a, &Rc::default(), &mut |request, _| {
            if matches!(request, LogRequest::PutObject { .. }) {
                puts += 1;
                return Some(Err(if unknown {
                    crate::log::LogError::NoResponse
                } else {
                    crate::log::LogError::code(crate::log::LogErrorCode::QuotaExceeded)
                }));
            }
            None
        });
        assert_eq!(puts, 1, "only initial encrypted journal attempted");
        frames.pump(&mut a.r);
        let response = frames
            .take_outgoing()
            .into_iter()
            .find_map(|(_, bytes)| {
                match ClientFrame::from_cbor(&cbor::decode(&bytes).unwrap()).unwrap() {
                    ClientFrame::Response(r) if r.id == 42 => Some(r),
                    _ => None,
                }
            })
            .unwrap();
        assert!(response.result.is_none());
        let problem = response.problem.unwrap();
        if unknown {
            assert_eq!(
                problem.reason.as_deref(),
                Some("hosted_upload_commit_unknown")
            );
        } else {
            assert_eq!(problem.code, "quota_exceeded");
        }
        assert!(a.r.client_resume_reference(owner).unwrap().is_none());
        assert_eq!(a.r.store().pending_count().unwrap(), 0);
        frames.close(&mut a.r, session);
        assert!(a.r.test_attachment_read_region().held_lease().is_none());
        assert!(a.r.test_attachment_read_region().is_wiped());
    }
}

#[test]
fn initial_pointer_commit_abort_or_unknown_never_returns_an_open_identity() {
    for unknown in [false, true] {
        let svc = FakeLogService::new();
        let mut a = attach_node(&svc, 1);
        let mut frames = Frames::new();
        let session = hello(&mut a, &mut frames);
        frames.on_frame(
            &mut a.r,
            session,
            &request(42, "open_upload", params(31).to_cbor()),
        );
        assert!(frames.take_outgoing().is_empty());
        let owner =
            a.r.client_resume_owner(session, params(31).mutation_id.unwrap())
                .unwrap();
        let store = a.r.store().clone();
        drive(&mut a, &Rc::default(), &mut |request, _| {
            if matches!(request, LogRequest::PutObject { .. }) {
                if unknown {
                    store.fail_after_commit(1);
                } else {
                    store.fail_commits(1);
                }
            }
            None
        });
        frames.pump(&mut a.r);
        let out = frames.take_outgoing();
        assert!(!out.iter().any(|(_, bytes)| matches!(ClientFrame::from_cbor(&cbor::decode(bytes).unwrap()).unwrap(), ClientFrame::Response(r) if r.id == 42 && r.result.is_some())));
        if unknown {
            assert!(a.r.apply_fault);
            assert!(a.r.client_resume_reference(owner).unwrap().is_some());
            assert!(out.iter().any(|(_, bytes)| matches!(ClientFrame::from_cbor(&cbor::decode(bytes).unwrap()).unwrap(), ClientFrame::Push(p) if p.kind == "closed")));
        } else {
            assert!(!a.r.apply_fault);
            assert!(a.r.client_resume_reference(owner).unwrap().is_none());
            assert!(out.iter().any(|(_, bytes)| matches!(ClientFrame::from_cbor(&cbor::decode(bytes).unwrap()).unwrap(), ClientFrame::Response(r) if r.id == 42 && r.problem.as_ref().is_some_and(|p| p.reason.as_deref() == Some("file_upload_checkpoint_store_failed")))));
            frames.close(&mut a.r, session);
        }
        assert!(a.r.test_attachment_read_region().held_lease().is_none());
        assert!(a.r.test_attachment_read_region().is_wiped());
        assert_eq!(a.r.store().pending_count().unwrap(), 0);
    }
}

#[test]
fn captured_cold_open_returns_original_identity_and_actual_outcome_without_a_second_create() {
    for size in [0, 31] {
        for mode in 0..3 {
            let svc = FakeLogService::new();
            let mut a = attach_node(&svc, 1);
            let mut frames = Frames::new();
            let (session, original) = open(&mut a, &mut frames, size);
            let mutation = params(size).mutation_id.unwrap();
            let owner = a.r.client_resume_owner(session, mutation).unwrap();
            if size > 0 {
                fragment(&mut a, &mut frames, session, 0, 0x41, size as usize);
            }
            frames.on_frame(
                &mut a.r,
                session,
                &request(
                    43,
                    "commit_upload",
                    Cbor::Map(vec![(Cbor::Uint(0), original.transfer.to_cbor())]),
                ),
            );
            for _ in 0..8 {
                drive(&mut a, &Rc::default(), &mut |request, _| {
                    if matches!(request, LogRequest::Append { .. }) && mode > 0 {
                        return Some(Err(if mode == 1 {
                            crate::log::LogError::code(crate::log::LogErrorCode::RefsMissing)
                        } else {
                            crate::log::LogError::NoResponse
                        }));
                    }
                    None
                });
                frames.pump(&mut a.r);
                if mode == 1 && a.r.client_captured_reference(owner).unwrap().is_some() {
                    a.clock.set(a.clock.get() + 60_000);
                    a.r.tick();
                }
            }
            assert!(a.r.client_captured_reference(owner).unwrap().is_some());
            let actual = a.r.receipt(session, mutation).unwrap();
            assert_eq!(
                actual.state,
                match mode {
                    0 => mdbn_wire::client::ReceiptState::Confirmed,
                    1 => mdbn_wire::client::ReceiptState::Rejected,
                    _ => mdbn_wire::client::ReceiptState::Pending,
                }
            );
            let captured_mtime = if mode == 0 {
                let (entry, _) = last_entry(&a, &svc);
                let file =
                    a.r.store()
                        .file(&original.file_id.unwrap())
                        .unwrap()
                        .unwrap();
                assert_eq!(file.mtime, Some(entry.mutation.clock.instant));
                file.mtime
            } else {
                None
            };
            a.clock.set(a.clock.get() + 1_234);
            frames.on_frame(
                &mut a.r,
                session,
                &request(45, "open_upload", params(size).to_cbor()),
            );
            drive(&mut a, &Rc::default(), &mut |request, _| {
                if mode == 2 && matches!(request, LogRequest::Append { .. }) {
                    return Some(Err(crate::log::LogError::NoResponse));
                }
                None
            });
            frames.pump(&mut a.r);
            let same = frames
                .take_outgoing()
                .into_iter()
                .find_map(|(_, bytes)| {
                    match ClientFrame::from_cbor(&cbor::decode(&bytes).unwrap()).unwrap() {
                        ClientFrame::Response(r) if r.id == 45 => {
                            assert!(r.problem.is_none(), "{:?}", r.problem);
                            Some(OpenUploadResult::from_cbor(&r.result.unwrap()).unwrap())
                        }
                        _ => None,
                    }
                })
                .unwrap();
            assert_eq!(same.file_id, original.file_id);
            assert_eq!(same.expires_at, original.expires_at);
            assert_eq!(
                a.r.commit_upload(session, original.transfer)
                    .unwrap()
                    .to_cbor(),
                actual.to_cbor(),
                "same-session retry returns the actual outcome too"
            );
            let store = a.r.into_store();
            let mut cold = attach_node_without_drive(&svc, 1, store);
            drive(&mut cold, &Rc::default(), &mut |request, _| {
                if mode == 2 && matches!(request, LogRequest::Append { .. }) {
                    return Some(Err(crate::log::LogError::NoResponse));
                }
                None
            });
            let mut fresh_frames = Frames::new();
            let fresh = hello(&mut cold, &mut fresh_frames);
            fresh_frames.on_frame(
                &mut cold.r,
                fresh,
                &request(44, "open_upload", params(size).to_cbor()),
            );
            assert!(fresh_frames.take_outgoing().is_empty());
            let mut gets = 0;
            let mut puts = 0;
            drive(&mut cold, &Rc::default(), &mut |request, _| {
                if matches!(request, LogRequest::GetObject { .. }) {
                    gets += 1;
                }
                if matches!(request, LogRequest::PutObject { .. }) {
                    puts += 1;
                }
                if matches!(request, LogRequest::Append { .. }) && mode > 0 {
                    return Some(Err(crate::log::LogError::NoResponse));
                }
                None
            });
            fresh_frames.pump(&mut cold.r);
            let resumed = fresh_frames
                .take_outgoing()
                .into_iter()
                .find_map(|(_, bytes)| {
                    match ClientFrame::from_cbor(&cbor::decode(&bytes).unwrap()).unwrap() {
                        ClientFrame::Response(r) if r.id == 44 => {
                            assert!(r.problem.is_none(), "{:?}", r.problem);
                            Some(OpenUploadResult::from_cbor(&r.result.unwrap()).unwrap())
                        }
                        _ => None,
                    }
                })
                .unwrap();
            assert_eq!(resumed.file_id, original.file_id);
            assert_eq!(resumed.expires_at, original.expires_at);
            if let Some(mtime) = captured_mtime {
                let view = cold
                    .r
                    .get_file(fresh, crate::api::Target::Id(original.file_id.unwrap()))
                    .unwrap();
                assert_eq!(
                    view.mtime,
                    Some(mtime),
                    "cold captured recovery never retimestamps the original file"
                );
            }
            assert_eq!(
                resumed.received,
                (0..size.div_ceil(1 << 20)).collect::<Vec<_>>()
            );
            assert_eq!(
                gets, 1,
                "authenticate journal only; captured payload is not rehashed"
            );
            assert_eq!(puts, 0, "never reopen CREATE, seal or upload a second file");
            assert!(
                cold.r.attachment_upload_status(&mutation).is_none(),
                "captured recovery has no native CREATE writer"
            );
            assert!(cold.r.test_attachment_read_region().held_lease().is_none());
            assert!(cold.r.test_attachment_read_region().is_wiped());
            for _ in 0..2 {
                let receipt = cold.r.commit_upload(fresh, original.transfer).unwrap();
                assert_eq!(
                    receipt.to_cbor(),
                    cold.r.receipt(fresh, mutation).unwrap().to_cbor()
                );
                assert_eq!(receipt.state, actual.state);
            }
            assert_eq!(
                cold.r
                    .upload_chunk(
                        fresh,
                        UploadChunkParams {
                            transfer: original.transfer,
                            index: 0,
                            bytes: Bytes(vec![0; size as usize])
                        }
                    )
                    .unwrap_err()
                    .into_problem()
                    .reason
                    .as_deref(),
                Some("file_upload_already_captured")
            );
            let read = if mode == 0 && size > 0 {
                let (stream, view) = cold
                    .r
                    .read_file(
                        fresh,
                        crate::api::Target::Id(original.file_id.unwrap()),
                        None,
                        None,
                    )
                    .unwrap();
                assert_eq!(view.id, original.file_id.unwrap());
                Some((
                    stream,
                    cold.r.test_attachment_read_region().held_lease().unwrap(),
                ))
            } else {
                None
            };
            cold.r.abort_upload(fresh, original.transfer).unwrap();
            if let Some((stream, lease)) = read {
                assert_eq!(
                    cold.r.test_attachment_read_region().held_lease(),
                    Some(lease),
                    "captured cleanup cannot release a successor read lease"
                );
                cold.r.cancel_stream(fresh, stream).unwrap();
            }
            assert!(
                cold.r.client_resume_reference(owner).unwrap().is_some(),
                "abort cannot withdraw captured work or its recovery reference"
            );
            assert!(cold.r.client_captured_reference(owner).unwrap().is_some());
            if mode == 0 {
                let mut new = params(size);
                new.transfer = B16([0x7a; 16]);
                new.mutation_id = Some(B16([0x7b; 16]));
                assert_eq!(
                    cold.r
                        .open_upload(fresh, new)
                        .unwrap_err()
                        .into_problem()
                        .reason
                        .as_deref(),
                    Some("attachment_destination_exists"),
                    "receipt recovery does not permit another CREATE at an occupied destination"
                );
                assert_eq!(
                    cold.r
                        .open_upload(fresh, params(size))
                        .unwrap_err()
                        .into_problem()
                        .reason
                        .as_deref(),
                    Some("file_upload_pending")
                );
                drive(&mut cold, &Rc::default(), &mut |_, _| None);
                assert_eq!(
                    cold.r.open_upload(fresh, params(size)).unwrap().file_id,
                    original.file_id
                );
                if size == 0 {
                    cold.r.store_generation += 1;
                } else {
                    cold.r.policy.epoch += 1;
                }
                assert_eq!(
                    cold.r
                        .commit_upload(fresh, original.transfer)
                        .unwrap_err()
                        .into_problem()
                        .reason
                        .as_deref(),
                    Some("attachment_upload_scope_changed")
                );
                assert!(cold.r.test_attachment_read_region().held_lease().is_none());
                assert!(cold.r.test_attachment_read_region().is_wiped());
                fresh_frames.close(&mut cold.r, fresh);
            }
        }
    }
}

#[test]
fn captured_binding_is_not_a_receipt_and_corrupt_or_mismatched_bindings_never_fall_back() {
    for mode in 0..3 {
        let svc = FakeLogService::new();
        let mut a = attach_node(&svc, 1);
        let mut frames = Frames::new();
        let (session, original) = open(&mut a, &mut frames, 31);
        let mutation = params(31).mutation_id.unwrap();
        let owner = a.r.client_resume_owner(session, mutation).unwrap();
        let key = crate::replica::attachment_upload::captured_key(owner);
        let initial =
            a.r.store()
                .meta(key.strip_suffix(".captured").unwrap())
                .unwrap()
                .unwrap();
        fragment(&mut a, &mut frames, session, 0, 0x41, 31);
        frames.on_frame(
            &mut a.r,
            session,
            &request(
                43,
                "commit_upload",
                Cbor::Map(vec![(Cbor::Uint(0), original.transfer.to_cbor())]),
            ),
        );
        for _ in 0..3 {
            drive(&mut a, &Rc::default(), &mut |_, _| None);
            frames.pump(&mut a.r);
        }
        assert!(a.r.client_captured_reference(owner).unwrap().is_some());
        assert_eq!(
            a.r.receipt(session, mutation).unwrap().state,
            mdbn_wire::client::ReceiptState::Confirmed
        );
        match mode {
            0 => {
                a.r.store_mut()
                    .commit(crate::store::Tx {
                        prune: Some(crate::store::Prune {
                            seq_floor: u64::MAX,
                            time_floor: i64::MAX,
                        }),
                        local_receipts_prune: Some(i64::MAX),
                        ..Default::default()
                    })
                    .unwrap();
            }
            1 => {
                a.r.store_mut()
                    .commit(crate::store::Tx {
                        meta: vec![(key, Some(vec![0]))],
                        ..Default::default()
                    })
                    .unwrap();
            }
            _ => {
                a.r.store_mut()
                    .commit(crate::store::Tx {
                        meta: vec![(key, Some(initial))],
                        ..Default::default()
                    })
                    .unwrap();
            }
        }
        let store = a.r.into_store();
        let mut cold = attach_node_with(&svc, 1, store);
        let mut fresh_frames = Frames::new();
        let fresh = hello(&mut cold, &mut fresh_frames);
        fresh_frames.on_frame(
            &mut cold.r,
            fresh,
            &request(44, "open_upload", params(31).to_cbor()),
        );
        assert!(fresh_frames.take_outgoing().is_empty());
        let mut puts = 0;
        drive(&mut cold, &Rc::default(), &mut |request, _| {
            if matches!(request, LogRequest::PutObject { .. }) {
                puts += 1;
            }
            None
        });
        fresh_frames.pump(&mut cold.r);
        let response = fresh_frames
            .take_outgoing()
            .into_iter()
            .find_map(|(_, bytes)| {
                match ClientFrame::from_cbor(&cbor::decode(&bytes).unwrap()).unwrap() {
                    ClientFrame::Response(r) if r.id == 44 => Some(r),
                    _ => None,
                }
            })
            .unwrap();
        assert!(
            response.result.is_none(),
            "journal or file row alone never certifies receipt"
        );
        let problem = response.problem.unwrap();
        if mode == 0 {
            assert_eq!(
                problem.reason.as_deref(),
                Some("file_upload_outcome_unknown")
            );
        } else if mode == 2 {
            assert_eq!(
                problem.reason.as_deref(),
                Some("attachment_resume_unavailable")
            );
        } else {
            assert_eq!(problem.code, "unavailable");
        }
        assert_eq!(puts, 0);
        assert!(cold.r.attachment_upload_status(&mutation).is_none());
        assert!(cold.r.test_attachment_read_region().held_lease().is_none());
        assert!(cold.r.test_attachment_read_region().is_wiped());
    }
}

#[test]
fn retired_resume_scope_never_decodes_and_cannot_destroy_a_successor() {
    for close in [true, false] {
        let svc = FakeLogService::new();
        let mut a = attach_node(&svc, 1);
        let mut frames = Frames::new();
        let (session, _) = open(&mut a, &mut frames, 31);
        fragment(&mut a, &mut frames, session, 0, 0x41, 31);
        drive(&mut a, &Rc::default(), &mut |_, _| None);
        frames.close(&mut a.r, session);
        let fresh = hello(&mut a, &mut frames);
        let binding = a.r.bind_authenticated_log(a.r.log_endpoint(), COL).unwrap();
        frames.on_frame(
            &mut a.r,
            fresh,
            &request(42, "open_upload", params(31).to_cbor()),
        );
        let (_, scope) =
            a.r.take_authenticated_log_calls(&binding)
                .unwrap()
                .into_iter()
                .find(|(call, _)| matches!(call.request, LogRequest::GetObject { .. }))
                .unwrap();
        if close {
            frames.close(&mut a.r, fresh);
            let successor = hello(&mut a, &mut frames);
            assert_eq!(
                a.r.client_open_upload(successor, params(31))
                    .unwrap_err()
                    .into_problem()
                    .reason
                    .as_deref(),
                Some("file_upload_pending")
            );
            assert!(
                a.r.on_authenticated_log_reply(scope, |_, _| panic!(
                    "closed scope must never decode"
                ))
                .is_err()
            );
            assert_eq!(
                a.r.client_open_upload(successor, params(31))
                    .unwrap_err()
                    .into_problem()
                    .reason
                    .as_deref(),
                Some("file_upload_pending")
            );
            frames.close(&mut a.r, successor);
        } else {
            a.r.policy.epoch += 1;
            assert!(
                a.r.on_authenticated_log_reply(scope, |_, _| panic!("old epoch must never decode"))
                    .is_err()
            );
            assert!(a.r.test_attachment_read_region().held_lease().is_none());
        }
        assert_eq!(a.r.store().pending_count().unwrap(), 0);
    }
}

#[test]
fn original_journal_or_committed_chunk_tamper_never_returns_open_identity_or_keeps_lease() {
    for corrupt_journal in [true, false] {
        let svc = FakeLogService::new();
        let mut a = attach_node(&svc, 1);
        let mut frames = Frames::new();
        let (session, _) = open(&mut a, &mut frames, 31);
        fragment(&mut a, &mut frames, session, 0, 0x41, 31);
        drive(&mut a, &Rc::default(), &mut |_, _| None);
        let owner =
            a.r.client_resume_owner(session, params(31).mutation_id.unwrap())
                .unwrap();
        let reference = a.r.client_resume_reference(owner).unwrap().unwrap();
        frames.close(&mut a.r, session);
        let fresh = hello(&mut a, &mut frames);
        frames.on_frame(
            &mut a.r,
            fresh,
            &request(42, "open_upload", params(31).to_cbor()),
        );
        assert!(frames.take_outgoing().is_empty());
        drive(&mut a, &Rc::default(), &mut |request, service| {
            if let LogRequest::GetObject { address, .. } = request
                && (*address == reference.cipher_hash) == corrupt_journal
            {
                let (_, mut bytes) = service
                    .objects(&COL)
                    .into_iter()
                    .find(|(hash, _)| hash == address)
                    .unwrap();
                assert!(!bytes.is_empty());
                bytes[0] ^= 1;
                return Some(Ok(crate::log::LogResponse::GetObject {
                    size: bytes.len() as u64,
                    checksum: *address,
                    bytes,
                }));
            }
            None
        });
        frames.pump(&mut a.r);
        let result = frames
            .take_outgoing()
            .into_iter()
            .find_map(|(_, bytes)| {
                match ClientFrame::from_cbor(&cbor::decode(&bytes).unwrap()).unwrap() {
                    ClientFrame::Response(r) if r.id == 42 => Some(r),
                    _ => None,
                }
            })
            .unwrap();
        assert!(result.result.is_none());
        assert_eq!(
            result.problem.unwrap().reason.as_deref(),
            Some("attachment_resume_unavailable")
        );
        assert!(a.r.test_attachment_read_region().held_lease().is_none());
        assert!(a.r.test_attachment_read_region().is_wiped());
        assert_eq!(a.r.store().pending_count().unwrap(), 0);
    }
}

/// Open through pending steps; the final answer.
fn open_settled(
    a: &mut Node,
    session: crate::api::SessionId,
    p: &OpenUploadParams,
) -> crate::api::ApiResult<OpenUploadResult> {
    for _ in 0..6 {
        match a.r.open_upload(session, p.clone()) {
            Err(e) if e.problem().reason.as_deref() == Some("file_upload_pending") => {
                drive(a, &Rc::default(), &mut |_, _| None);
            }
            other => return other,
        }
    }
    a.r.open_upload(session, p.clone())
}

#[test]
fn cold_resume_keeps_the_original_replacement_binding() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let mut frames = Frames::new();
    // The file being replaced.
    let session = hello(&mut a, &mut frames);
    let mut base = params(3);
    base.transfer = B16([0x51; 16]);
    base.mutation_id = Some(B16([0x52; 16]));
    let created = open_settled(&mut a, session, &base).unwrap();
    a.r.upload_chunk(
        session,
        UploadChunkParams {
            transfer: base.transfer,
            index: 0,
            bytes: Bytes(b"old".to_vec()),
        },
    )
    .unwrap();
    for _ in 0..8 {
        if a.r.commit_upload(session, base.transfer).is_ok() {
            break;
        }
        drive(&mut a, &Rc::default(), &mut |_, _| None);
    }
    drive(&mut a, &Rc::default(), &mut |_, _| None);
    a.r.abort_upload(session, base.transfer).unwrap();
    let file = created.file_id.unwrap();
    let revision =
        a.r.get_file(session, crate::api::Target::Id(file))
            .unwrap()
            .digest;

    // A replacement commits its first 8 MiB chunk, then the session goes away.
    let size = 10 << 20;
    let replace = OpenUploadParams {
        file_id: Some(file),
        if_revision: Some(revision),
        ..params(size)
    };
    let opened = open_settled(&mut a, session, &replace).unwrap();
    assert_eq!(opened.file_id, Some(file));
    for index in 0..8 {
        fragment(&mut a, &mut frames, session, index, 0x41, 1 << 20);
    }
    drive(&mut a, &Rc::default(), &mut |_, _| None);
    frames.close(&mut a.r, session);

    // Cold resume must restate the journaled mode, file and revision exactly
    // (each refused attempt holds its session's lane, so use a fresh session).
    let other_revision = OpenUploadParams {
        if_revision: Some(mdbn_wire::hash::sha256(b"other")),
        ..replace.clone()
    };
    for changed in [other_revision, params(size)] {
        let attempt = hello(&mut a, &mut frames);
        let refused = open_settled(&mut a, attempt, &changed)
            .unwrap_err()
            .into_problem();
        assert_eq!(
            (refused.reason.as_deref(), refused.message.as_str()),
            (
                Some("attachment_upload_scope_changed"),
                "the resumed upload context changed"
            )
        );
        frames.close(&mut a.r, attempt);
    }
    let fresh = hello(&mut a, &mut frames);
    let resumed = open_settled(&mut a, fresh, &replace).unwrap();
    assert_eq!(resumed.file_id, Some(file));
    assert_eq!(resumed.received, (0..8).collect::<Vec<_>>());
}
