//! ClientApi/native reads of a canonical signed/received Blob source. Fault
//! injection is deliberately AFTER receiving, so serving must reauthenticate;
//! no mocked crypto/sealer or Store plaintext cache stands in for source proof.
use super::engine::{COL, Node};
use super::unindexed_blob_interop::{fixture, fixture_with_source, source_bytes};
use crate::{
    api::{ClientApi, ErrorCode, Push, SessionAuth, StreamId, Target},
    crypto::{Secret32, blob},
    fake::FakeLogService,
    file_io::{MAX_OUT_FRAME, ObjectRead, RegionOwner},
    log::{LogClient, LogError, LogErrorCode, LogReply, LogRequest, LogResponse},
    store::{FileRow, Store, Tx},
};
use mdbn_wire::{
    attachment::{AttachmentContentV1, AttachmentRefV1, FileContent},
    cbor,
    client::{ClientFrame, FileChunk, FileContentProfile, HelloParams, Problem},
    common::{B16, B32, Hash, Value, Version},
    schema::Wire,
    unindexed_markdown::FileKindV1,
};
use std::collections::BTreeMap;

const FILE: B16 = B16([52; 16]);
const PART: usize = 8 << 20;
type Objects = BTreeMap<Hash, Vec<u8>>;

fn objects(svc: &FakeLogService) -> Objects {
    svc.objects(&COL).into_iter().collect()
}
fn hello() -> HelloParams {
    HelloParams {
        versions: vec![Version { major: 1, minor: 0 }],
        client_name: "blob-reader".into(),
        client_version: "1".into(),
        features: None,
        timezone: None,
    }
}
fn start(a: &mut Node) -> StreamId {
    a.r.read_file(a.s, Target::Id(FILE), None, None).unwrap().0
}
fn released(a: &mut Node) {
    assert!(a.r.attachment_read_session().is_none());
    let region = a.r.test_attachment_read_region();
    assert!(region.held_lease().is_none());
    assert!(region.is_wiped());
}
fn reply(bytes: Vec<u8>) -> LogReply {
    Ok(LogResponse::GetObject {
        size: bytes.len() as u64,
        checksum: mdbn_wire::hash::sha256(&bytes),
        bytes,
    })
}
// Real authenticated native call capture/reply path, also asserting #933's
// whole-object ABI: a bounded envelope length is NOT an exact LS byte range.
fn native_step(
    a: &mut Node,
    binding: &crate::replica::AuthenticatedLogSession,
    objects: &Objects,
    mut respond: impl FnMut(Hash, Vec<u8>) -> LogReply,
) -> usize {
    let mut gets = 0;
    for (call, scope) in a.r.take_authenticated_log_calls(binding).unwrap() {
        let response = match call.request {
            LogRequest::GetObject {
                collection,
                address,
                range,
            } => {
                assert_eq!(collection, COL);
                assert_eq!(
                    range, None,
                    "whole Blob object must not use its upper bound as a range"
                );
                gets += 1;
                respond(address, objects[&address].clone())
            }
            request => a.log.call(request),
        };
        a.r.on_authenticated_log_reply(scope, move |_, _| response)
            .unwrap();
    }
    gets
}
fn supply(a: &mut Node, object: &ObjectRead, raw: &[u8]) {
    assert_eq!(object.expected_bytes, None);
    assert!(raw.len() <= 9 << 20);
    assert!(a.r.attachment_read_reserve(object.ticket, raw.len() as u64));
    for chunk in raw.chunks(MAX_OUT_FRAME) {
        assert!(a.r.attachment_read_write(object.ticket, chunk));
    }
    assert!(
        a.r.attachment_read_complete(object.ticket, mdbn_wire::hash::sha256(raw))
            .unwrap()
    );
}
fn poll(a: &mut Node) -> Option<FileChunk> {
    let (session, frame) = a.r.attachment_read_poll().unwrap()?;
    assert_eq!(session, a.s);
    assert!(frame.len() <= MAX_OUT_FRAME);
    let ClientFrame::Push(push) = ClientFrame::from_cbor(&cbor::decode(&frame).unwrap()).unwrap()
    else {
        panic!("file push")
    };
    Some(FileChunk::from_cbor(&push.payload).unwrap())
}
fn put_row(a: &mut Node, row: FileRow) {
    a.r.store
        .commit(Tx {
            files_put: vec![row],
            ..Tx::default()
        })
        .unwrap();
}
fn seal_at(a: &mut Node, address: Hash, plain: &[u8]) -> Vec<u8> {
    let epoch = a.r.policy.epoch;
    let keys = a.r.testing_epoch_keys();
    let key = &keys.iter().find(|(e, _)| *e == epoch).unwrap().1;
    let key = Secret32(**key);
    blob::seal_part(
        &key,
        epoch,
        &COL,
        address,
        plain,
        false,
        a.r.host.entropy.as_mut(),
    )
    .unwrap()
    .bytes
}
// Same native path as success, but earlier chunks can only be provisional. No
// corrupt/missing/final-proof failure is allowed to produce a successful last.
fn drive_failure(
    a: &mut Node,
    objects: &Objects,
    mut respond: impl FnMut(Hash, Vec<u8>) -> LogReply,
) -> Problem {
    let binding = a.r.bind_authenticated_log(a.r.log_endpoint(), COL).unwrap();
    let stream = start(a);
    let mut sent = 0;
    for _ in 0..64 {
        native_step(a, &binding, objects, &mut respond);
        for (session, push) in a.r.take_pushes() {
            match push {
                Push::FileChunk(chunk) => {
                    assert_eq!(session, a.s);
                    assert!(!chunk.last, "failed full source returned success");
                    assert_eq!(chunk.offset, sent);
                    sent += chunk.bytes.0.len() as u64;
                    a.r.ack_chunks(a.s, stream, sent).unwrap();
                }
                Push::Closed(problem) => {
                    assert_eq!(session, a.s);
                    assert!(
                        sent > 0,
                        "exercise provisional prefix before final-part failure"
                    );
                    assert_eq!(problem.reason.as_deref(), Some("file_read_failed"));
                    released(a);
                    return problem;
                }
                _ => {}
            }
        }
    }
    panic!("source failure did not terminate the lane")
}

#[test]
fn canonical_eight_mib_blob_reads_exact_full_source_through_authenticated_native_client() {
    let (svc, mut a, _, descriptor, expected) =
        fixture_with_source(source_bytes(PART), PART as u64);
    assert_eq!(descriptor.part_size, PART as u64);
    let objects = objects(&svc);
    let binding = a.r.bind_authenticated_log(a.r.log_endpoint(), COL).unwrap();
    let stream = start(&mut a);
    let mut sent = 0usize;
    let mut gets = 0;
    let mut done = false;
    for _ in 0..32 {
        gets += native_step(&mut a, &binding, &objects, |_, raw| reply(raw));
        for (session, push) in a.r.take_pushes() {
            if let Push::FileChunk(chunk) = push {
                assert_eq!(session, a.s);
                assert_eq!(chunk.stream, stream.0);
                assert_eq!(chunk.offset, sent as u64);
                assert!(chunk.bytes.0.len() < MAX_OUT_FRAME);
                let end = sent + chunk.bytes.0.len();
                assert_eq!(chunk.bytes.0, expected[sent..end]);
                sent = end;
                done = chunk.last;
                if !done {
                    a.r.ack_chunks(a.s, stream, sent as u64).unwrap();
                }
            } else {
                assert!(!matches!(push, Push::Closed(_)));
            }
        }
        if done {
            break;
        }
    }
    assert!(done);
    assert_eq!(sent, expected.len());
    assert_eq!(gets, 1);
    released(&mut a);
}

#[test]
fn two_parts_never_accumulate_and_ack_window_and_utf8_boundary_are_exact() {
    let mut expected = source_bytes(PART + 137);
    expected[PART - 1..PART + 3].copy_from_slice("🪴".as_bytes());
    let (svc, mut a, _, _, expected) = fixture_with_source(expected, PART as u64);
    let objects = objects(&svc);
    let stream = start(&mut a);
    let object = a.r.attachment_read_object().unwrap().unwrap();
    assert!(!a.r.attachment_read_reserve(object.ticket, (9 << 20) + 1));
    let raw = &objects[&object.address];
    supply(&mut a, &object, raw);
    let mut sent = 0usize;
    while let Some(chunk) = poll(&mut a) {
        assert!(!chunk.last);
        assert_eq!(chunk.offset, sent as u64);
        let end = sent + chunk.bytes.0.len();
        assert_eq!(chunk.bytes.0, expected[sent..end]);
        sent = end;
        assert!(
            a.r.attachment_read_object().unwrap().is_none(),
            "no second held part or exhausted-window fetch"
        );
    }
    assert_eq!(sent, PART);
    assert!(a.r.test_attachment_read_region().is_wiped());
    assert!(a.r.ack_chunks(a.s, stream, PART as u64 + 1).is_err());
    assert!(a.r.attachment_read_object().unwrap().is_none());
    a.r.ack_chunks(a.s, stream, PART as u64).unwrap();
    let object = a.r.attachment_read_object().unwrap().unwrap();
    supply(&mut a, &object, &objects[&object.address]);
    let last = poll(&mut a).unwrap();
    assert!(last.last);
    assert_eq!(last.offset, PART as u64);
    assert_eq!(last.bytes.0, expected[PART..]);
    released(&mut a);
}

#[test]
fn partial_ranges_refuse_but_explicit_full_range_and_revision_are_supported() {
    let (svc, mut a, _, descriptor, expected) = fixture();
    let error =
        a.r.attachment_read(a.s, Target::Id(FILE), None, None)
            .unwrap_err();
    assert_eq!(
        error.problem().reason.as_deref(),
        Some("attachment_required")
    );
    for range in [(0, 1), (1, descriptor.size - 1), (0, 0), (u64::MAX, 1)] {
        let error =
            a.r.read_file(a.s, Target::Id(FILE), Some(range), None)
                .unwrap_err();
        assert_eq!(error.code(), Some(ErrorCode::InvalidRequest));
        assert_eq!(
            error.problem().reason.as_deref(),
            Some("unindexed_full_read_required")
        );
        released(&mut a);
    }
    let error =
        a.r.read_file(a.s, Target::Id(FILE), None, Some(B32([0; 32])))
            .unwrap_err();
    assert_eq!(error.problem().reason.as_deref(), Some("revision_mismatch"));
    let (stream, view) =
        a.r.read_file(
            a.s,
            Target::Id(FILE),
            Some((0, descriptor.size)),
            Some(descriptor.plain_hash),
        )
        .unwrap();
    assert_eq!(
        view.content_profile,
        Some(FileContentProfile::UnindexedMarkdownBlob)
    );
    let objects = objects(&svc);
    let object = a.r.attachment_read_object().unwrap().unwrap();
    supply(&mut a, &object, &objects[&object.address]);
    let mut sent = 0;
    let mut done = false;
    while let Some(chunk) = poll(&mut a) {
        assert_eq!(chunk.offset, sent as u64);
        let end = sent + chunk.bytes.0.len();
        assert_eq!(chunk.bytes.0, expected[sent..end]);
        sent = end;
        done = chunk.last;
        if !done {
            a.r.ack_chunks(a.s, stream, sent as u64).unwrap();
        }
    }
    assert!(done);
    assert_eq!(sent, expected.len());
    released(&mut a);
}

#[test]
fn content_profile_and_blob_eligibility_use_confirmed_kind_not_extension_or_size() {
    let (_, mut a, _, descriptor, _) = fixture();
    let mut row = a.r.store.file(&FILE).unwrap().unwrap();
    let attachment = FileContent::AttachmentV1(AttachmentContentV1 {
        reference: AttachmentRefV1 {
            collection: COL,
            key_epoch: descriptor.id_epoch,
            attachment_id: B32([45; 32]),
            manifest_cipher_hash: B32([46; 32]),
        },
        whole_plain_hash: descriptor.plain_hash,
        total_plain_bytes: descriptor.size,
    });
    // Metadata-only fault injection: neither a .md suffix nor the same large
    // byte count may turn ordinary Blob content into an unindexed read profile.
    for (kind, content, profile) in [
        (
            FileKindV1::Ordinary,
            FileContent::Blob(descriptor.clone()),
            FileContentProfile::OrdinaryBlob,
        ),
        (
            FileKindV1::UnindexedOversizedMarkdown,
            FileContent::Blob(descriptor.clone()),
            FileContentProfile::UnindexedMarkdownBlob,
        ),
        (
            FileKindV1::Ordinary,
            attachment.clone(),
            FileContentProfile::OrdinaryAttachmentV1,
        ),
        (
            FileKindV1::UnindexedOversizedMarkdown,
            attachment,
            FileContentProfile::UnindexedMarkdownAttachmentV1,
        ),
    ] {
        row.kind = kind;
        row.content = content;
        row.path = if kind == FileKindV1::Ordinary {
            "looks-unindexed.md"
        } else {
            "source.bin"
        }
        .into();
        row.path_key = row.path.clone();
        put_row(&mut a, row.clone());
        let view = a.r.get_file(a.s, Target::Id(FILE)).unwrap();
        assert_eq!(view.content_profile, Some(profile));
        if profile == FileContentProfile::OrdinaryBlob {
            let error =
                a.r.read_file(a.s, Target::Id(FILE), None, None)
                    .unwrap_err();
            assert_eq!(
                error.problem().reason.as_deref(),
                Some("attachment_required")
            );
        } else {
            let stream = start(&mut a);
            a.r.cancel_stream(a.s, stream).unwrap();
        }
    }
}

#[test]
fn legacy_sixteen_mib_declared_parts_fail_closed_before_transport_or_region_allocation() {
    let (_, mut a, _, _, _) = fixture();
    let mut row = a.r.store.file(&FILE).unwrap().unwrap();
    let FileContent::Blob(ref mut descriptor) = row.content else {
        panic!("Blob")
    };
    descriptor.part_size = 16 << 20;
    put_row(&mut a, row);
    let error =
        a.r.read_file(a.s, Target::Id(FILE), None, None)
            .unwrap_err();
    assert_eq!(error.code(), Some(ErrorCode::TooLarge));
    assert_eq!(
        error.problem().reason.as_deref(),
        Some("hosted_read_budget")
    );
    assert!(a.r.attachment_read_object().unwrap().is_none());
    released(&mut a);
}

#[test]
fn held_part_cancel_idle_and_transport_retirement_release_and_allow_reacquire() {
    let (svc, mut a, _, _, _) = fixture();
    let objects = objects(&svc);
    for cleanup in 0..3 {
        let old = start(&mut a);
        let object = a.r.attachment_read_object().unwrap().unwrap();
        let ticket = object.ticket;
        supply(&mut a, &object, &objects[&object.address]);
        assert!(a.r.attachment_read_object().unwrap().is_none());
        match cleanup {
            0 => a.r.cancel_stream(a.s, old).unwrap(),
            1 => {
                assert_eq!(
                    a.r.attachment_read_tick(a.r.attachment_read_deadline().unwrap()),
                    Some(a.s)
                );
            }
            _ => a.r.attachment_read_retire_transport(),
        }
        released(&mut a);
        if cleanup == 2 {
            let pushes = a.r.take_pushes();
            assert!(
                pushes
                    .iter()
                    .any(|(session, push)| *session == a.s && matches!(push, Push::Closed(_)))
            );
            assert!(
                !pushes
                    .iter()
                    .any(|(_, push)| matches!(push, Push::FileChunk(_)))
            );
            a.s = a.r.hello(SessionAuth::Host, hello()).unwrap().0;
        }
        let next = start(&mut a);
        assert!(next.0 > old.0);
        let region = a.r.test_attachment_read_region();
        let lease = region.held_lease().unwrap();
        region.borrow(lease).unwrap().fill(0xce);
        assert!(!a.r.attachment_read_complete(ticket, B32([0; 32])).unwrap());
        assert!(a.r.attachment_read_failed(ticket).is_none());
        a.r.cancel_stream(a.s, old).unwrap();
        let region = a.r.test_attachment_read_region();
        assert!(region.owns(lease));
        assert!(region.borrow(lease).unwrap().iter().all(|b| *b == 0xce));
        a.r.cancel_stream(a.s, next).unwrap();
    }
}

#[test]
fn cancelled_authenticated_call_cannot_decode_or_scrub_successor_blob_lane() {
    let (_, mut a, _, _, _) = fixture();
    let binding = a.r.bind_authenticated_log(a.r.log_endpoint(), COL).unwrap();
    let old = start(&mut a);
    let (_, scope) =
        a.r.take_authenticated_log_calls(&binding)
            .unwrap()
            .into_iter()
            .find(|(call, _)| matches!(call.request, LogRequest::GetObject { .. }))
            .unwrap();
    a.r.cancel_stream(a.s, old).unwrap();
    let next = start(&mut a);
    let lease = a.r.test_attachment_read_region().held_lease().unwrap();
    assert!(
        a.r.on_authenticated_log_reply(scope, |_, _| panic!("stale call must not decode"))
            .is_err()
    );
    assert_eq!(a.r.test_attachment_read_region().held_lease(), Some(lease));
    a.r.cancel_stream(a.s, next).unwrap();
}

#[test]
fn held_output_rechecks_grant_revocation_folder_and_native_lifetime() {
    let (svc, mut a, _, _, _) = fixture();
    let objects = objects(&svc);
    let grant = B16([71; 16]);
    let pk = B32([72; 32]);
    let caps = ["collection.read".to_string()].into_iter().collect();
    // Only authority invalidation is injected here; the source itself was signed
    // and received normally. Exercise actual granted ClientApi session checks.
    a.r.policy.grants.insert(
        grant,
        crate::policy::GrantState {
            installation: B16([73; 16]),
            app_id: "reader".into(),
            account: crate::testkit::TEST_OWNER,
            capabilities: caps,
            client_pk: pk,
            file_folders: None,
            folder_scoped: true,
            active: true,
            approved: Some(["collection.read".to_string()].into_iter().collect()),
            approved_folders: None,
            approved_seq: Some(a.r.head().seq),
            approved_by: Some(a.r.cfg.device_id),
        },
    );
    for invalidation in 0..3 {
        let state = a.r.policy.grants.get_mut(&grant).unwrap();
        state.active = true;
        state.approved_folders = None;
        a.s =
            a.r.hello(
                SessionAuth::Grant {
                    grant,
                    client_pk: pk.0,
                },
                hello(),
            )
            .unwrap()
            .0;
        start(&mut a);
        let object = a.r.attachment_read_object().unwrap().unwrap();
        supply(&mut a, &object, &objects[&object.address]);
        match invalidation {
            0 => a.r.policy.grants.get_mut(&grant).unwrap().active = false,
            1 => {
                a.r.policy.grants.get_mut(&grant).unwrap().approved_folders =
                    Some(vec!["private".into()])
            }
            _ => a.r.store_generation += 1,
        }
        assert_eq!(a.r.attachment_read_poll().unwrap_err(), a.s);
        released(&mut a);
    }
}

#[test]
fn stale_read_lease_drops_owned_plaintext_without_wiping_successor_upload() {
    let (svc, mut a, _, _, _) = fixture();
    let objects = objects(&svc);
    let stream = start(&mut a);
    let object = a.r.attachment_read_object().unwrap().unwrap();
    supply(&mut a, &object, &objects[&object.address]);
    let region = a.r.test_attachment_read_region();
    let old = region.held_lease().unwrap();
    region.release(old);
    let next = region
        .acquire(RegionOwner::Upload {
            session: a.s,
            mutation: FILE,
        })
        .unwrap();
    region.borrow(next).unwrap().fill(0xbd);
    assert_eq!(a.r.attachment_read_poll().unwrap_err(), a.s);
    a.r.cancel_stream(a.s, stream).unwrap();
    let region = a.r.test_attachment_read_region();
    assert!(region.owns(next));
    assert!(region.borrow(next).unwrap().iter().all(|b| *b == 0xbd));
    region.release(next);
}

#[test]
fn corrupt_truncated_excess_missing_wrong_hash_and_wrong_part_lengths_never_succeed_last() {
    let (svc, mut a, _, _, expected) = fixture_with_source(source_bytes(PART + 137), PART as u64);
    let objects = objects(&svc);
    for fault in 0..8 {
        a.s = a.r.hello(SessionAuth::Host, hello()).unwrap().0;
        let mut count = 0;
        // Pre-seal altered final plaintext under the original descriptor/address:
        // AEAD succeeds; exact part length or the final full hash MUST fail.
        let addresses =
            a.r.sealer
                .blob_part_addresses(&match a.r.store.file(&FILE).unwrap().unwrap().content {
                    FileContent::Blob(b) => b,
                    _ => panic!("Blob"),
                })
                .unwrap();
        let mut tail = expected[PART..].to_vec();
        match fault {
            5 => tail[0] ^= 1,
            6 => {
                tail.pop();
            }
            7 => tail.push(b'!'),
            _ => {}
        }
        let altered = seal_at(&mut a, addresses[1], &tail);
        let problem = drive_failure(&mut a, &objects, |_, mut raw| {
            count += 1;
            if count == 2 {
                match fault {
                    0 => {
                        let at = raw.len() / 2;
                        raw[at] ^= 1;
                    }
                    1 => {
                        raw.pop();
                    }
                    2 => raw.push(0),
                    3 => return Err(LogError::code(LogErrorCode::NotFound)),
                    4 => {
                        return Ok(LogResponse::GetObject {
                            size: raw.len() as u64,
                            bytes: raw,
                            checksum: B32([0; 32]),
                        });
                    }
                    _ => raw = altered.clone(),
                }
            }
            reply(raw)
        });
        assert_eq!(count, 2);
        if fault != 3 {
            assert!(
                problem.details.is_some(),
                "typed failure cause for fault {fault}"
            );
        }
    }
}

#[test]
fn authenticated_but_malformed_boundary_or_incomplete_utf8_never_returns_successful_last() {
    let (_, mut a, _, _, source) = fixture_with_source(source_bytes(PART + 137), PART as u64);
    for incomplete in [false, true] {
        let mut bytes = source.clone();
        if incomplete {
            *bytes.last_mut().unwrap() = 0xe2;
        } else {
            bytes[PART - 1] = 0xe2;
            bytes[PART] = b'('; // malformed continuation in the next part
        }
        let epoch = a.r.policy.epoch;
        let keys = a.r.testing_epoch_keys();
        let key = &keys.iter().find(|(e, _)| *e == epoch).unwrap().1;
        let key = Secret32(**key);
        let (descriptor, parts) = blob::seal_blob(
            &key,
            epoch,
            &COL,
            &bytes,
            PART as u64,
            false,
            a.r.host.entropy.as_mut(),
        )
        .unwrap();
        // Fault a previously signed/received row to reach serving's defense in
        // depth UTF8 gate. Normal receiving correctly rejects this source.
        let mut row = a.r.store.file(&FILE).unwrap().unwrap();
        row.content = FileContent::Blob(descriptor);
        put_row(&mut a, row);
        let objects = parts.into_iter().map(|p| (p.address, p.bytes)).collect();
        a.s = a.r.hello(SessionAuth::Host, hello()).unwrap().0;
        let problem = drive_failure(&mut a, &objects, |_, raw| reply(raw));
        assert_eq!(
            problem.details,
            Some(Value::Map(vec![
                ("cause_code".into(), Value::Text("unavailable".into())),
                (
                    "cause_reason".into(),
                    Value::Text("unindexed_invalid_utf8".into())
                ),
            ]))
        );
    }
}

#[test]
fn failed_complete_retires_lane_itself_and_never_scrubs_successor() {
    let (_, mut a, _, _, _) = fixture();
    let mut reads = crate::file_io::FileReads::new(0);
    let mut region = crate::file_io::AttachmentRegion::new();
    for failure in 0..4 {
        reads
            .start(&mut a.r, a.s, Target::Id(FILE), None, None, &mut region)
            .unwrap();
        let object = reads.object(&a.r, &region).unwrap().unwrap();
        if failure != 0 {
            assert!(reads.reserve(&a.r, object.ticket, 100, &mut region));
            assert!(reads.append(&a.r, object.ticket, b"incomplete", &mut region));
        }
        let successor = if failure == 3 {
            let old = region.held_lease().unwrap();
            region.release(old);
            let next = region
                .acquire(RegionOwner::Upload {
                    session: a.s,
                    mutation: FILE,
                })
                .unwrap();
            region.borrow(next).unwrap().fill(0xbd);
            Some(next)
        } else {
            None
        };
        if failure == 2 {
            a.r.store_generation += 1;
        }
        assert_eq!(
            reads
                .complete(&a.r, object.ticket, B32([0; 32]), &mut region)
                .unwrap_err(),
            a.s
        );
        assert!(reads.active_session().is_none());
        assert!(reads.take_failure(a.s).is_some());
        if let Some(next) = successor {
            assert!(region.owns(next));
            assert!(region.borrow(next).unwrap().iter().all(|b| *b == 0xbd));
            region.release(next);
        }
        assert!(region.held_lease().is_none());
        assert!(region.is_wiped());
        reads
            .start(&mut a.r, a.s, Target::Id(FILE), None, None, &mut region)
            .unwrap();
        let next = region.held_lease().unwrap();
        region.borrow(next).unwrap().fill(0xaa);
        assert!(
            !reads
                .complete(&a.r, object.ticket, B32([0; 32]), &mut region)
                .unwrap()
        );
        assert!(region.owns(next));
        assert!(region.borrow(next).unwrap().iter().all(|b| *b == 0xaa));
        reads.close(a.s, &mut region);
    }
}
