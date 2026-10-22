//! Device ClientApi -> authenticated LS -> ordinary frame-output path.
//! Attachment crypto is real; policy/log fixtures are synthetic, not runtime admission.
use super::*;
use crate::api::Target;
use crate::frames::Frames;
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::client::{ClientFrame, ClientRequest, FileChunk};

#[test]
fn device_rpc_cancel_purges_queued_unsent_plaintext_without_dropping_response() {
    let (_, mut a) = fixture(31);
    let mut frames = Frames::new();
    let hello = HelloParams {
        versions: vec![Version { major: 1, minor: 0 }],
        client_name: "native-reader".into(),
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
    frames.on_frame(
        &mut a.r,
        session,
        &request(
            1,
            "read_file",
            Cbor::Map(vec![(Cbor::Uint(0), FILE.to_cbor())]),
        ),
    );
    let read = frames
        .take_outgoing()
        .into_iter()
        .find_map(
            |(_, b)| match ClientFrame::from_cbor(&cbor::decode(&b).unwrap()).unwrap() {
                ClientFrame::Response(r) if r.id == 1 => r.result,
                _ => None,
            },
        )
        .unwrap();
    let Cbor::Map(fields) = read else {
        panic!("read result")
    };
    let stream = fields
        .into_iter()
        .find(|(k, _)| *k == Cbor::Uint(0))
        .unwrap()
        .1;
    a.pump();
    frames.pump(&mut a.r); // Plaintext is serialized but hasn't reached transport.
    frames.on_frame(
        &mut a.r,
        session,
        &request(2, "cancel_stream", Cbor::Map(vec![(Cbor::Uint(0), stream)])),
    );
    let out: Vec<_> = frames
        .take_outgoing()
        .into_iter()
        .map(|(_, b)| ClientFrame::from_cbor(&cbor::decode(&b).unwrap()).unwrap())
        .collect();
    assert!(out.iter().any(
        |frame| matches!(frame, ClientFrame::Response(r) if r.id == 2 && r.problem.is_none())
    ));
    assert!(
        !out.iter()
            .any(|frame| matches!(frame, ClientFrame::Push(p) if p.kind == "file_chunk"))
    );
}

fn request(id: u64, method: &str, params: Cbor) -> Vec<u8> {
    cbor::encode(
        &ClientFrame::Request(ClientRequest {
            id,
            method: method.into(),
            params,
        })
        .to_cbor(),
    )
    .unwrap()
}
fn fixture(size: u64) -> (FakeLogService, Node) {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    upload(&mut a, PATH, &Rc::new(data(size)));
    (svc, a)
}

#[test]
fn device_rpc_reads_full_range_and_empty_via_authenticated_ls_and_frame_pump() {
    for (size, range) in [(31, None), (0, None), (CHUNK + 71, Some((CHUNK - 17, 43)))] {
        let (_, mut a) = fixture(size);
        let mut frames = Frames::new();
        let hello = HelloParams {
            versions: vec![Version { major: 1, minor: 0 }],
            client_name: "native-reader".into(),
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
        let mut fields = vec![(Cbor::Uint(0), FILE.to_cbor())];
        if let Some((offset, length)) = range {
            fields.push((
                Cbor::Uint(1),
                Cbor::Array(vec![Cbor::Uint(offset), Cbor::Uint(length)]),
            ));
        }
        frames.on_frame(
            &mut a.r,
            session,
            &request(1, "read_file", Cbor::Map(fields)),
        );
        let mut plain = Vec::new();
        let mut done = false;
        let mut saw_response = false;
        for turn in 0..60 {
            a.pump(); // Same authenticated session/capture/decode boundary as adapters.
            frames.pump(&mut a.r);
            for (target, bytes) in frames.take_outgoing() {
                assert_eq!(target, session);
                match ClientFrame::from_cbor(&cbor::decode(&bytes).unwrap()).unwrap() {
                    ClientFrame::Response(r) if r.id == 1 => {
                        assert!(r.problem.is_none());
                        saw_response = true;
                    }
                    ClientFrame::Push(p) if p.kind == "file_chunk" => {
                        assert!(bytes.len() <= crate::file_io::MAX_OUT_FRAME);
                        let chunk = FileChunk::from_cbor(&p.payload).unwrap();
                        assert_eq!(
                            chunk.offset,
                            range.map_or(0, |(o, _)| o) + plain.len() as u64
                        );
                        plain.extend_from_slice(&chunk.bytes.0);
                        done = chunk.last;
                        if !done {
                            frames.on_frame(
                                &mut a.r,
                                session,
                                &request(
                                    10 + turn,
                                    "ack_chunks",
                                    Cbor::Map(vec![
                                        (Cbor::Uint(0), Cbor::Uint(chunk.stream)),
                                        (
                                            Cbor::Uint(1),
                                            Cbor::Uint(chunk.offset + chunk.bytes.0.len() as u64),
                                        ),
                                    ]),
                                ),
                            );
                        }
                    }
                    _ => {}
                }
            }
            if done {
                break;
            }
        }
        assert!(saw_response && done);
        let expected = data(size);
        let (offset, len) = range.unwrap_or((0, size));
        assert_eq!(plain, expected[offset as usize..(offset + len) as usize]);
        assert!(a.r.test_attachment_read_region().held_lease().is_none());
    }
}

#[test]
fn device_read_failure_keeps_bounded_native_cause_without_plaintext() {
    let (_, mut a) = fixture(31);
    // Same synthetic log/policy fixture, but no attachment-capable sealer.
    // The manifest must fail closed and keep its native authentication cause.
    a.r.sealer = Box::new(crate::seal::PlainSealer::for_device(a.r.cfg.device_id));
    a.r.read_file(a.s, Target::Id(FILE), None, None).unwrap();
    let mut closed = None;
    for _ in 0..10 {
        a.pump();
        for (session, push) in a.r.take_pushes() {
            assert_eq!(session, a.s);
            match push {
                crate::api::Push::Closed(problem) => closed = Some(problem),
                crate::api::Push::FileChunk(_) => panic!("failed authentication exposed plaintext"),
                _ => {}
            }
        }
        if closed.is_some() {
            break;
        }
    }
    let problem = closed.expect("native read must close");
    assert_eq!(problem.reason.as_deref(), Some("file_read_failed"));
    assert_eq!(
        problem.details,
        Some(mdbn_wire::common::Value::Map(vec![
            (
                "cause_code".into(),
                mdbn_wire::common::Value::Text("unavailable".into())
            ),
            (
                "cause_reason".into(),
                mdbn_wire::common::Value::Text("attachment_unavailable".into())
            ),
        ])),
    );
    assert!(a.r.test_attachment_read_region().held_lease().is_none());
}

#[test]
fn device_ack_credit_stops_next_object_and_output_at_eight_mib() {
    let (svc, mut a) = fixture(CHUNK + 71);
    let (stream, _) = a.r.read_file(a.s, Target::Id(FILE), None, None).unwrap();
    let initial = svc.object_gets(&COL).len();
    let mut sent = 0u64;
    for _ in 0..30 {
        a.pump();
        for (_, push) in a.r.take_pushes() {
            if let crate::api::Push::FileChunk(chunk) = push {
                sent += chunk.bytes.0.len() as u64;
                assert!(!chunk.last);
            }
        }
    }
    assert_eq!(sent, CHUNK);
    assert_eq!(
        svc.object_gets(&COL).len() - initial,
        2,
        "only manifest and first chunk"
    );
    a.r.ack_chunks(a.s, stream, sent).unwrap();
    a.pump();
    let chunks: Vec<_> =
        a.r.take_pushes()
            .into_iter()
            .filter_map(|(_, p)| {
                if let crate::api::Push::FileChunk(c) = p {
                    Some(c)
                } else {
                    None
                }
            })
            .collect();
    assert_eq!(chunks.len(), 1);
    assert!(chunks[0].last);
    assert_eq!(chunks[0].bytes.0, data(CHUNK + 71)[CHUNK as usize..]);
}

#[test]
fn cancelled_original_ls_scope_is_refused_before_decoder_and_successor_survives() {
    let (_, mut a) = fixture(31);
    let binding = a.r.bind_authenticated_log(a.r.log_endpoint(), COL).unwrap();
    let (stream, _) = a.r.read_file(a.s, Target::Id(FILE), None, None).unwrap();
    let calls = a.r.take_authenticated_log_calls(&binding).unwrap();
    let (_, old_scope) = calls
        .into_iter()
        .find(|(c, _)| matches!(c.request, LogRequest::GetObject { .. }))
        .unwrap();
    a.r.cancel_stream(a.s, stream).unwrap();
    let (next, _) = a.r.read_file(a.s, Target::Id(FILE), None, None).unwrap();
    assert!(next.0 > stream.0);
    assert!(
        a.r.on_authenticated_log_reply(old_scope, |_, _| panic!("cancelled call must not decode"))
            .is_err()
    );
    assert_eq!(a.r.attachment_read_session(), Some(a.s));
    a.r.close(a.s);
}

#[test]
fn corrupt_device_ls_object_closes_without_plaintext_and_wipes_lane() {
    let (_, mut a) = fixture(31);
    a.r.read_file(a.s, Target::Id(FILE), None, None).unwrap();
    let call =
        a.r.take_log_calls()
            .into_iter()
            .find(|c| matches!(c.request, LogRequest::GetObject { .. }))
            .unwrap();
    a.r.on_log_reply(
        call.id,
        Ok(crate::log::LogResponse::GetObject {
            bytes: vec![1; 32],
            size: 32,
            checksum: B32([0; 32]),
        }),
    );
    let pushes = a.r.take_pushes();
    assert!(
        pushes
            .iter()
            .any(|(_, p)| matches!(p, crate::api::Push::Closed(_)))
    );
    assert!(
        !pushes
            .iter()
            .any(|(_, p)| matches!(p, crate::api::Push::FileChunk(_)))
    );
    assert!(a.r.test_attachment_read_region().held_lease().is_none());
}
