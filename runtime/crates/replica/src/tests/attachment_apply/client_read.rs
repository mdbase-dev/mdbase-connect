//! Actual ClientApi plus trusted native host callbacks, not production admission.
use super::*;
use crate::api::{ErrorCode, SessionId, Target};
use crate::file_io::MAX_OUT_FRAME;
use mdbn_wire::cbor;
use mdbn_wire::client::{ClientFrame, FileChunk};
use mdbn_wire::schema::Wire;

fn fixture() -> (FakeLogService, Node) {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    upload(&mut a, PATH, &Rc::new(data(31)));
    (svc, a)
}

#[test]
fn client_api_owns_native_stream_and_serves_pinned_bytes_through_same_driver() {
    let (svc, mut a) = fixture();
    assert!(a.r.client_files.is_none());
    let (stream, view) = a.r.read_file(a.s, Target::Id(FILE), None, None).unwrap();
    assert_eq!(view.id, FILE);
    assert_eq!(a.r.attachment_read_session(), Some(a.s));
    let objects: std::collections::BTreeMap<_, _> = svc.objects(&COL).into_iter().collect();
    let mut plain = Vec::new();
    while a.r.attachment_read_session().is_some() {
        let object = a.r.attachment_read_object().unwrap().unwrap();
        let bytes = &objects[&object.address];
        assert!(a.r.attachment_read_reserve(object.ticket, bytes.len() as u64));
        for part in bytes.chunks(MAX_OUT_FRAME) {
            assert!(a.r.attachment_read_write(object.ticket, part));
        }
        assert!(
            a.r.attachment_read_poll().unwrap().is_none(),
            "input is not plaintext output"
        );
        assert!(
            a.r.attachment_read_complete(object.ticket, mdbn_wire::hash::sha256(bytes))
                .unwrap()
        );
        while let Some((session, frame)) = a.r.attachment_read_poll().unwrap() {
            assert_eq!(session, a.s);
            assert!(frame.len() <= MAX_OUT_FRAME);
            let ClientFrame::Push(push) =
                ClientFrame::from_cbor(&cbor::decode(&frame).unwrap()).unwrap()
            else {
                panic!("file push")
            };
            let chunk = FileChunk::from_cbor(&push.payload).unwrap();
            assert_eq!(chunk.stream, stream.0);
            assert_eq!(chunk.offset, plain.len() as u64);
            plain.extend_from_slice(&chunk.bytes.0);
            if !chunk.last {
                a.r.ack_chunks(a.s, stream, plain.len() as u64).unwrap();
            }
        }
    }
    assert_eq!(plain, data(31));
    assert!(a.r.test_attachment_read_region().held_lease().is_none());
}

#[test]
fn rejected_read_does_not_allocate_region_and_unauthenticated_controls_are_refused() {
    let (_, mut a) = fixture();
    let bad = SessionId(a.s.0 + 100);
    assert_eq!(
        a.r.read_file(bad, Target::Id(FILE), None, None)
            .unwrap_err()
            .code(),
        Some(ErrorCode::Unauthenticated)
    );
    assert!(a.r.client_files.is_none());
    assert_eq!(
        a.r.ack_chunks(bad, crate::api::StreamId(1), 0)
            .unwrap_err()
            .code(),
        Some(ErrorCode::Unauthenticated)
    );
    assert_eq!(
        a.r.cancel_stream(bad, crate::api::StreamId(1))
            .unwrap_err()
            .code(),
        Some(ErrorCode::Unauthenticated)
    );
    assert!(a.r.client_files.is_none());
}

#[test]
fn client_close_and_cancel_retire_ticket_and_cannot_touch_successor() {
    let (_, mut a) = fixture();
    let (stream, _) = a.r.read_file(a.s, Target::Id(FILE), None, None).unwrap();
    let object = a.r.attachment_read_object().unwrap().unwrap();
    a.r.cancel_stream(a.s, stream).unwrap();
    assert!(!a.r.attachment_read_allowed(object.ticket));
    let (next, _) = a.r.read_file(a.s, Target::Id(FILE), None, None).unwrap();
    let lease = a.r.test_attachment_read_region().held_lease().unwrap();
    a.r.cancel_stream(a.s, stream).unwrap();
    assert_eq!(a.r.attachment_read_session(), Some(a.s));
    assert_eq!(a.r.test_attachment_read_region().held_lease(), Some(lease));
    assert!(next.0 > stream.0);
    assert!(!a.r.attachment_read_reserve(object.ticket, 1));
    a.r.close(a.s);
    assert!(a.r.attachment_read_session().is_none());
    assert!(a.r.test_attachment_read_region().held_lease().is_none());
}

#[test]
fn authenticated_device_revocation_blocks_every_callback_and_output() {
    let (_, mut a) = fixture();
    a.r.read_file(a.s, Target::Id(FILE), None, None).unwrap();
    let object = a.r.attachment_read_object().unwrap().unwrap();
    a.r.policy
        .devices
        .get_mut(&a.r.cfg.device_id)
        .unwrap()
        .active = false;
    assert!(!a.r.attachment_read_allowed(object.ticket));
    assert!(!a.r.attachment_read_reserve(object.ticket, 1));
    assert!(!a.r.attachment_read_write(object.ticket, b"cipher"));
    assert_eq!(a.r.attachment_read_poll().unwrap_err(), a.s);
    assert!(
        a.r.test_attachment_read_region().held_lease().is_none(),
        "failed output wipes its lease before the host closes"
    );
    a.r.close(a.s);
}

#[test]
fn device_tick_closes_idle_read_and_releases_native_region() {
    let (_, mut a) = fixture();
    a.r.read_file(a.s, Target::Id(FILE), None, None).unwrap();
    let deadline = a.r.attachment_read_deadline().unwrap();
    assert!(a.r.next_wakeup().unwrap() <= deadline);
    a.clock.set(deadline as u64);
    a.r.tick();
    assert!(a.r.attachment_read_session().is_none());
    assert!(a.r.test_attachment_read_region().held_lease().is_none());
    assert!(
        a.r.take_pushes()
            .iter()
            .any(|(s, p)| *s == a.s && matches!(p, crate::api::Push::Closed(_)))
    );
}

#[test]
fn device_log_retirement_scrubs_original_ticket_and_mints_a_new_one() {
    let (_, mut a) = fixture();
    a.r.read_file(a.s, Target::Id(FILE), None, None).unwrap();
    let old = a.r.attachment_read_object().unwrap().unwrap();
    a.r.on_log_push(crate::log::LogPush::Disconnected);
    assert!(!a.r.attachment_read_allowed(old.ticket));
    assert!(!a.r.attachment_read_reserve(old.ticket, 1));
    let next = a.r.attachment_read_object().unwrap().unwrap();
    assert_ne!(next.ticket, old.ticket);
    assert!(a.r.attachment_read_allowed(next.ticket));
}
