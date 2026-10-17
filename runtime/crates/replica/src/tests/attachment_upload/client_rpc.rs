//! Native Frames upload receipts: real attachment crypto, synthetic policy/LS.
use super::*;
use crate::api::SessionAuth;
use crate::frames::Frames;
use crate::log::LogError;
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::client::{
    ClientFrame, ClientRequest, HelloParams, OpenUploadParams, OpenUploadResult, UploadChunkParams,
};
use mdbn_wire::common::{Bytes, Version};

pub(super) fn request(id: u64, method: &str, params: Cbor) -> Vec<u8> {
    ClientFrame::Request(ClientRequest {
        id,
        method: method.into(),
        params,
    })
    .to_bytes()
    .unwrap()
}
pub(super) fn open(
    a: &mut Node,
    frames: &mut Frames,
    size: u64,
) -> (crate::api::SessionId, OpenUploadResult) {
    let hello = HelloParams {
        versions: vec![Version { major: 1, minor: 1 }],
        client_name: "upload-rpc".into(),
        client_version: "1".into(),
        features: None,
        timezone: None,
    };
    let session = frames
        .hello(
            &mut a.r,
            SessionAuth::Host,
            &request(0, "hello", hello.to_cbor()),
        )
        .session
        .unwrap();
    let params = OpenUploadParams {
        transfer: B16([0x79; 16]),
        path: "files/native-rpc.bin".into(),
        size,
        digest: None,
        file_id: None,
        if_revision: None,
        mutation_id: Some(B16([0x78; 16])),
    };
    frames.on_frame(
        &mut a.r,
        session,
        &request(1, "open_upload", params.to_cbor()),
    );
    assert!(frames.take_outgoing().is_empty());
    drive(a, &Rc::default(), &mut |_, _| None);
    frames.pump(&mut a.r);
    let opened = frames
        .take_outgoing()
        .into_iter()
        .find_map(
            |(_, b)| match ClientFrame::from_cbor(&cbor::decode(&b).unwrap()).unwrap() {
                ClientFrame::Response(r) if r.id == 1 => {
                    Some(OpenUploadResult::from_cbor(&r.result.unwrap()).unwrap())
                }
                _ => None,
            },
        )
        .unwrap();
    (session, opened)
}
#[test]
fn native_rpc_resume_pointer_is_known_journal_only_close_retains_abort_retires() {
    for abort in [false, true] {
        let svc = FakeLogService::new();
        let mut a = attach_node(&svc, 1);
        let mut frames = Frames::new();
        let (session, opened) = open(&mut a, &mut frames, 31);
        let mutation = B16([0x78; 16]);
        let owner = a.r.client_resume_owner(session, mutation).unwrap();
        let initial = a.r.client_resume_reference(owner).unwrap().unwrap();
        let capture_key = crate::replica::attachment_upload::captured_key(owner);
        assert!(a.r.store().meta(&capture_key).unwrap().is_none());
        assert_eq!(
            a.r.attachment_region_progress(session, &mutation)
                .unwrap()
                .committed_chunks,
            0
        );
        frames.on_frame(
            &mut a.r,
            session,
            &request(
                2,
                "upload_chunk",
                UploadChunkParams {
                    transfer: opened.transfer,
                    index: 0,
                    bytes: Bytes(vec![0x41; 31]),
                }
                .to_cbor(),
            ),
        );
        assert_eq!(a.r.client_resume_reference(owner).unwrap(), Some(initial));
        drive(&mut a, &Rc::default(), &mut |_, _| None);
        let reference = a.r.client_resume_reference(owner).unwrap().unwrap();
        assert_eq!(
            Some(reference),
            a.r.attachment_region_progress(session, &mutation)
                .unwrap()
                .checkpoint
        );
        assert_eq!(a.r.store().pending_count().unwrap(), 0);
        assert!(
            a.r.store().meta(&capture_key).unwrap().is_none(),
            "known chunk/journal progress is not a capture"
        );
        if abort {
            a.r.client_abort_upload(session, opened.transfer).unwrap();
            assert!(a.r.client_resume_reference(owner).unwrap().is_none());
        } else {
            frames.close(&mut a.r, session);
            assert_eq!(a.r.client_resume_reference(owner).unwrap(), Some(reference));
            let hello = HelloParams {
                versions: vec![Version { major: 1, minor: 1 }],
                client_name: "reopen".into(),
                client_version: "1".into(),
                features: None,
                timezone: None,
            };
            let fresh = frames
                .hello(
                    &mut a.r,
                    SessionAuth::Host,
                    &request(0, "hello", hello.to_cbor()),
                )
                .session
                .unwrap();
            let error =
                a.r.client_open_upload(
                    fresh,
                    OpenUploadParams {
                        transfer: opened.transfer,
                        path: "files/native-rpc.bin".into(),
                        size: 31,
                        digest: None,
                        file_id: None,
                        if_revision: None,
                        mutation_id: Some(mutation),
                    },
                )
                .unwrap_err()
                .into_problem();
            assert_eq!(error.reason.as_deref(), Some("file_upload_pending"));
            assert!(
                a.r.store()
                    .file(&opened.file_id.unwrap())
                    .unwrap()
                    .is_none()
            );
            drive(&mut a, &Rc::default(), &mut |_, _| None);
            let resumed =
                a.r.client_open_upload(
                    fresh,
                    OpenUploadParams {
                        transfer: opened.transfer,
                        path: "files/native-rpc.bin".into(),
                        size: 31,
                        digest: None,
                        file_id: None,
                        if_revision: None,
                        mutation_id: Some(mutation),
                    },
                )
                .unwrap();
            assert_eq!(resumed.file_id, opened.file_id);
            assert_eq!(resumed.received, vec![0]);
            assert_eq!(resumed.expires_at, opened.expires_at);
            frames.on_frame(
                &mut a.r,
                fresh,
                &request(
                    9,
                    "commit_upload",
                    Cbor::Map(vec![(Cbor::Uint(0), opened.transfer.to_cbor())]),
                ),
            );
            drive(&mut a, &Rc::default(), &mut |_, _| None);
            frames.pump(&mut a.r);
            let result = frames
                .take_outgoing()
                .into_iter()
                .find_map(|(_, b)| {
                    match ClientFrame::from_cbor(&cbor::decode(&b).unwrap()).unwrap() {
                        ClientFrame::Response(r) if r.id == 9 => r.result,
                        _ => None,
                    }
                })
                .unwrap();
            assert_eq!(
                mdbn_wire::client::Receipt::from_cbor(&result)
                    .unwrap()
                    .mutation,
                mutation
            );
            assert!(
                a.r.store()
                    .file(&opened.file_id.unwrap())
                    .unwrap()
                    .is_some()
            );
            let captured = a.r.store().meta(&capture_key).unwrap().unwrap();
            assert!(captured.len() < 256, "opaque reference only");
            assert_eq!(
                Some(captured),
                a.r.store()
                    .meta(capture_key.strip_suffix(".captured").unwrap())
                    .unwrap()
            );
        }
    }
}

#[test]
fn upload_mutation_collision_never_returns_another_native_submissions_receipt() {
    use crate::api::ClientApi;
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let mut frames = Frames::new();
    let (session, opened) = open(&mut a, &mut frames, 31);
    let mutation = B16([0x78; 16]);
    let owner = a.r.client_resume_owner(session, mutation).unwrap();
    let key = crate::replica::attachment_upload::captured_key(owner);
    let unrelated =
        a.r.submit(
            session,
            mdbn_wire::client::SubmitParams {
                ops: vec![mdbn_wire::intent::Op::Create(mdbn_wire::intent::Create {
                    id: B16([0x66; 16]),
                    path: Some("other.md".into()),
                    type_name: None,
                    frontmatter: None,
                    body: None,
                    document: Some(mdbn_wire::common::Text::Inline("other".into())),
                })],
                mutation_id: Some(mutation),
                conflict_mode: None,
                timezone: None,
                allow_partial: None,
                mutation_ids: None,
                dry_run: None,
                include: None,
                wait: None,
            },
        )
        .unwrap();
    assert_eq!(unrelated[0].mutation, mutation);
    frames.on_frame(
        &mut a.r,
        session,
        &request(
            2,
            "upload_chunk",
            UploadChunkParams {
                transfer: opened.transfer,
                index: 0,
                bytes: Bytes(vec![0x41; 31]),
            }
            .to_cbor(),
        ),
    );
    frames.take_outgoing();
    frames.on_frame(
        &mut a.r,
        session,
        &request(
            3,
            "commit_upload",
            Cbor::Map(vec![(Cbor::Uint(0), opened.transfer.to_cbor())]),
        ),
    );
    for _ in 0..8 {
        drive(&mut a, &Rc::default(), &mut |_, _| None);
        frames.pump(&mut a.r);
    }
    let response = frames
        .take_outgoing()
        .into_iter()
        .find_map(|(_, bytes)| {
            match ClientFrame::from_cbor(&cbor::decode(&bytes).unwrap()).unwrap() {
                ClientFrame::Response(r) if r.id == 3 => Some(r),
                _ => None,
            }
        })
        .unwrap();
    assert!(response.result.is_none());
    assert_eq!(
        response.problem.unwrap().reason.as_deref(),
        Some("attachment_upload_scope_changed")
    );
    assert!(a.r.store().meta(&key).unwrap().is_none());
    assert!(
        a.r.store()
            .file(&opened.file_id.unwrap())
            .unwrap()
            .is_none()
    );
    assert!(a.r.store().record(&B16([0x66; 16])).unwrap().is_some());
}

#[test]
fn captured_reference_and_native_pending_row_share_the_actual_capture_transaction() {
    for unknown in [false, true] {
        let svc = FakeLogService::new();
        let mut a = attach_node(&svc, 1);
        let mut frames = Frames::new();
        let (session, opened) = open(&mut a, &mut frames, 31);
        let mutation = B16([0x78; 16]);
        let owner = a.r.client_resume_owner(session, mutation).unwrap();
        let key = crate::replica::attachment_upload::captured_key(owner);
        let store = a.r.store().clone();
        frames.on_frame(
            &mut a.r,
            session,
            &request(
                2,
                "upload_chunk",
                UploadChunkParams {
                    transfer: opened.transfer,
                    index: 0,
                    bytes: Bytes(vec![0x41; 31]),
                }
                .to_cbor(),
            ),
        );
        frames.take_outgoing();
        drive(&mut a, &Rc::default(), &mut |_, _| None);
        assert!(store.meta(&key).unwrap().is_none());
        frames.on_frame(
            &mut a.r,
            session,
            &request(
                3,
                "commit_upload",
                Cbor::Map(vec![(Cbor::Uint(0), opened.transfer.to_cbor())]),
            ),
        );
        let mut injected = false;
        drive(&mut a, &Rc::default(), &mut |request, _| {
            if matches!(request, LogRequest::HasObjects { addresses, .. } if addresses.len() == 2) {
                assert!(!injected);
                injected = true;
                if unknown {
                    store.fail_after_commit(1);
                } else {
                    store.fail_commits(1);
                }
            }
            None
        });
        assert!(
            injected,
            "native manifest+chunk probe immediately precedes capture"
        );
        frames.pump(&mut a.r);
        assert!(!frames.take_outgoing().iter().any(|(_, bytes)| matches!(ClientFrame::from_cbor(&cbor::decode(bytes).unwrap()).unwrap(), ClientFrame::Response(r) if r.id == 3 && r.result.is_some())));
        if unknown {
            assert!(a.r.apply_fault);
            assert!(store.meta(&key).unwrap().is_some());
            let row = store.pending_get(&mutation).unwrap().unwrap();
            let rt::Op::FileAttach(op) = &row.mutation.ops[0] else {
                panic!("actual native capture only")
            };
            assert_eq!(Some(op.id), opened.file_id);
            assert_eq!(op.content.total_plain_bytes, 31);
        } else {
            assert!(!a.r.apply_fault);
            assert!(store.meta(&key).unwrap().is_none());
            assert!(store.pending_get(&mutation).unwrap().is_none());
            assert!(store.file(&opened.file_id.unwrap()).unwrap().is_none());
        }
    }
}

#[test]
fn native_rpc_pointer_commit_abort_or_unknown_never_advertises_progress() {
    for unknown in [false, true] {
        let svc = FakeLogService::new();
        let mut a = attach_node(&svc, 1);
        let mut frames = Frames::new();
        let (session, opened) = open(&mut a, &mut frames, 31);
        let mutation = B16([0x78; 16]);
        let owner = a.r.client_resume_owner(session, mutation).unwrap();
        let initial = a.r.client_resume_reference(owner).unwrap().unwrap();
        let store = a.r.store().clone();
        frames.on_frame(
            &mut a.r,
            session,
            &request(
                2,
                "upload_chunk",
                UploadChunkParams {
                    transfer: opened.transfer,
                    index: 0,
                    bytes: Bytes(vec![0x41; 31]),
                }
                .to_cbor(),
            ),
        );
        let mut puts = 0;
        drive(&mut a, &Rc::default(), &mut |request, _| {
            if matches!(request, LogRequest::PutObject { .. }) {
                puts += 1;
                if puts == 2 {
                    if unknown {
                        store.fail_after_commit(1);
                    } else {
                        store.fail_commits(1);
                    }
                }
            }
            None
        });
        assert_eq!(puts, 2);
        let crate::AttachmentUploadStatus::Failed(problem) =
            a.r.attachment_upload_status(&mutation).unwrap()
        else {
            panic!("pointer failure must be terminal");
        };
        assert_eq!(
            problem.reason.as_deref(),
            Some("file_upload_checkpoint_store_failed")
        );
        assert!(a.r.attachment_region_progress(session, &mutation).is_err());
        assert_eq!(a.r.store().pending_count().unwrap(), 0);
        assert!(
            a.r.store()
                .file(&opened.file_id.unwrap())
                .unwrap()
                .is_none()
        );
        if unknown {
            // The bytes happened to commit, but unchanged cached state is no proof.
            assert!(a.r.client_resume_reference(owner).unwrap().is_some());
            assert!(a.r.apply_fault);
        } else {
            assert_eq!(a.r.client_resume_reference(owner).unwrap(), Some(initial));
            assert!(!a.r.apply_fault);
        }
    }
}

#[test]
fn native_rpc_commit_waits_for_actual_capture_and_empty_file_has_real_objects() {
    for size in [0, 31] {
        let svc = FakeLogService::new();
        let mut a = attach_node(&svc, 1);
        let mut frames = Frames::new();
        let (session, opened) = open(&mut a, &mut frames, size);
        assert!(a.r.take_log_calls().is_empty());
        if size != 0 {
            frames.on_frame(
                &mut a.r,
                session,
                &request(
                    2,
                    "upload_chunk",
                    UploadChunkParams {
                        transfer: opened.transfer,
                        index: 0,
                        bytes: Bytes(vec![0x41; size as usize]),
                    }
                    .to_cbor(),
                ),
            );
            frames.take_outgoing();
        }
        frames.on_frame(
            &mut a.r,
            session,
            &request(
                3,
                "commit_upload",
                Cbor::Map(vec![(Cbor::Uint(0), opened.transfer.to_cbor())]),
            ),
        );
        assert!(
            frames.take_outgoing().is_empty(),
            "no synthetic receipt while LS objects are pending"
        );
        assert_eq!(a.r.store().pending_count().unwrap(), 0);
        let mut receipt = None;
        for _ in 0..8 {
            drive(&mut a, &Rc::default(), &mut |_, _| None);
            frames.pump(&mut a.r);
            for (_, b) in frames.take_outgoing() {
                if let ClientFrame::Response(r) =
                    ClientFrame::from_cbor(&cbor::decode(&b).unwrap()).unwrap()
                    && r.id == 3
                {
                    assert!(r.problem.is_none(), "{:?}", r.problem);
                    assert!(receipt.is_none(), "original RPC answers once");
                    receipt =
                        Some(mdbn_wire::client::Receipt::from_cbor(&r.result.unwrap()).unwrap());
                }
            }
        }
        assert_eq!(receipt.unwrap().mutation, B16([0x78; 16]));
        let owner = a.r.client_resume_owner(session, B16([0x78; 16])).unwrap();
        let key = crate::replica::attachment_upload::captured_key(owner);
        let captured = a.r.store().meta(&key).unwrap().unwrap();
        assert_eq!(
            Some(captured),
            a.r.store()
                .meta(key.strip_suffix(".captured").unwrap())
                .unwrap()
        );
        let (entry, _) = last_entry(&a, &svc);
        let rt::Op::FileAttach(op) = &entry.mutation.ops[0] else {
            panic!("attachment")
        };
        assert_eq!(Some(op.id), opened.file_id);
        assert_eq!(
            crate::api::ClientApi::get_file(&mut a.r, session, crate::api::Target::Id(op.id))
                .unwrap()
                .size,
            size
        );
        assert!(a.r.test_attachment_read_region().held_lease().is_none());
    }
}

#[test]
fn native_rpc_refusal_and_lost_put_reply_never_return_capture_or_durable_progress() {
    for unknown in [false, true] {
        let svc = FakeLogService::new();
        let mut a = attach_node(&svc, 1);
        let mut frames = Frames::new();
        let (session, opened) = open(&mut a, &mut frames, 31);
        frames.on_frame(
            &mut a.r,
            session,
            &request(
                2,
                "upload_chunk",
                UploadChunkParams {
                    transfer: opened.transfer,
                    index: 0,
                    bytes: Bytes(vec![0x41; 31]),
                }
                .to_cbor(),
            ),
        );
        frames.take_outgoing();
        frames.on_frame(
            &mut a.r,
            session,
            &request(
                3,
                "commit_upload",
                Cbor::Map(vec![(Cbor::Uint(0), opened.transfer.to_cbor())]),
            ),
        );
        drive(&mut a, &Rc::default(), &mut |request, _| {
            if matches!(request, LogRequest::PutObject { .. }) {
                Some(Err(if unknown {
                    LogError::NoResponse
                } else {
                    LogError::code(crate::log::LogErrorCode::QuotaExceeded)
                }))
            } else {
                None
            }
        });
        frames.pump(&mut a.r);
        let response = frames
            .take_outgoing()
            .into_iter()
            .find_map(
                |(_, b)| match ClientFrame::from_cbor(&cbor::decode(&b).unwrap()).unwrap() {
                    ClientFrame::Response(r) if r.id == 3 => Some(r),
                    _ => None,
                },
            )
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
        assert_eq!(a.r.store().pending_count().unwrap(), 0);
        assert!(
            a.r.store()
                .file(&opened.file_id.unwrap())
                .unwrap()
                .is_none()
        );
        assert!(a.r.test_attachment_read_region().held_lease().is_none());
    }
}

#[test]
fn native_rpc_next_window_fragment_is_held_then_answers_original_request() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let mut frames = Frames::new();
    let (session, opened) = open(&mut a, &mut frames, (8 << 20) + 31);
    for index in 0..8 {
        frames.on_frame(
            &mut a.r,
            session,
            &request(
                index + 2,
                "upload_chunk",
                UploadChunkParams {
                    transfer: opened.transfer,
                    index,
                    bytes: Bytes(vec![0x41; 1 << 20]),
                }
                .to_cbor(),
            ),
        );
    }
    frames.take_outgoing();
    frames.on_frame(
        &mut a.r,
        session,
        &request(
            10,
            "upload_chunk",
            UploadChunkParams {
                transfer: opened.transfer,
                index: 8,
                bytes: Bytes(vec![0x42; 31]),
            }
            .to_cbor(),
        ),
    );
    assert!(frames.take_outgoing().is_empty());
    drive(&mut a, &Rc::default(), &mut |_, _| None);
    frames.pump(&mut a.r);
    let out = frames.take_outgoing();
    assert_eq!(out.len(), 1);
    let ClientFrame::Response(response) =
        ClientFrame::from_cbor(&cbor::decode(&out[0].1).unwrap()).unwrap()
    else {
        panic!("response")
    };
    assert_eq!(response.id, 10);
    assert!(response.problem.is_none());
    assert_eq!(response.result, Some(Cbor::Uint((8 << 20) + 31)));
}

fn responses(frames: &mut Frames, id: u64) -> Vec<mdbn_wire::client::ClientResponse> {
    frames
        .take_outgoing()
        .into_iter()
        .filter_map(
            |(_, b)| match ClientFrame::from_cbor(&cbor::decode(&b).unwrap()).unwrap() {
                ClientFrame::Response(r) if r.id == id => Some(r),
                _ => None,
            },
        )
        .collect()
}

/// UX-023: a finished import must not hold the session's single upload slot,
/// or the next import is refused as "the live upload request changed".
#[test]
fn native_rpc_second_upload_after_committed_first_opens_fresh_slot() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let mut frames = Frames::new();
    let (session, opened) = open(&mut a, &mut frames, 31);
    frames.on_frame(
        &mut a.r,
        session,
        &request(
            2,
            "upload_chunk",
            UploadChunkParams {
                transfer: opened.transfer,
                index: 0,
                bytes: Bytes(vec![0x41; 31]),
            }
            .to_cbor(),
        ),
    );
    frames.take_outgoing();
    frames.on_frame(
        &mut a.r,
        session,
        &request(
            3,
            "commit_upload",
            Cbor::Map(vec![(Cbor::Uint(0), opened.transfer.to_cbor())]),
        ),
    );
    let mut committed = false;
    for _ in 0..8 {
        drive(&mut a, &Rc::default(), &mut |_, _| None);
        frames.pump(&mut a.r);
        committed |= responses(&mut frames, 3)
            .iter()
            .any(|r| r.problem.is_none());
    }
    assert!(committed, "first import committed");
    // The finished create ages out of the native upload table (idle cleanup).
    a.clock.set(a.clock.get() + 120_000);
    a.r.tick();
    drive(&mut a, &Rc::default(), &mut |_, _| None);
    let second = OpenUploadParams {
        transfer: B16([0x69; 16]),
        path: "files/native-rpc-2.bin".into(),
        size: 31,
        digest: None,
        file_id: None,
        if_revision: None,
        mutation_id: Some(B16([0x68; 16])),
    };
    let mut opened2 = None;
    for attempt in 0..4u64 {
        let id = 10 + attempt;
        frames.on_frame(
            &mut a.r,
            session,
            &request(id, "open_upload", second.to_cbor()),
        );
        drive(&mut a, &Rc::default(), &mut |_, _| None);
        frames.pump(&mut a.r);
        for r in responses(&mut frames, id) {
            if let Some(problem) = &r.problem {
                assert_ne!(
                    problem.reason.as_deref(),
                    Some("attachment_upload_scope_changed"),
                    "{problem:?}"
                );
            } else {
                opened2 = Some(OpenUploadResult::from_cbor(&r.result.unwrap()).unwrap());
            }
        }
        if opened2.is_some() {
            break;
        }
    }
    assert_eq!(opened2.unwrap().transfer, second.transfer);
}
