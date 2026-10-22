//! Typed shared-driver results map to the existing ClientApi wire contract.
use super::*;
use crate::api::{ErrorCode, SessionId, StreamId, Target};
use crate::file_io::{AttachmentRegion, FileReads};
use mdbn_wire::cbor::Cbor;
use mdbn_wire::schema::Wire;

#[test]
fn typed_read_result_preserves_wire_shape_and_ack_cancel_ownership() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let bytes = Rc::new(data(31));
    upload(&mut a, PATH, &bytes);
    let mut reads = FileReads::new(0);
    let mut region = AttachmentRegion::new();
    let (stream, view) = reads
        .start(&mut a.r, a.s, Target::Id(FILE), None, None, &mut region)
        .unwrap();
    assert_eq!(view.id, FILE);
    assert_eq!(
        crate::frames::file_read_result((stream, view.clone())),
        Cbor::Map(vec![
            (Cbor::Uint(0), Cbor::Uint(stream.0)),
            (Cbor::Uint(1), view.to_cbor()),
        ])
    );
    let _: () = reads.ack(&a.r, a.s, stream, 0, &region).unwrap();
    assert_eq!(
        reads.ack(&a.r, a.s, stream, 1, &region).unwrap_err().code(),
        Some(ErrorCode::InvalidRequest)
    );
    let foreign = SessionId(a.s.0 + 100);
    assert_eq!(
        reads
            .ack(&a.r, foreign, stream, 0, &region)
            .unwrap_err()
            .code(),
        Some(ErrorCode::NotFound)
    );
    let lease = region.held_lease().unwrap();
    let _: () = reads.cancel(foreign, stream, &mut region).unwrap();
    assert_eq!(region.held_lease(), Some(lease));
    reads
        .cancel(a.s, StreamId(stream.0 + 1), &mut region)
        .unwrap();
    assert_eq!(region.held_lease(), Some(lease));
    reads.cancel(a.s, stream, &mut region).unwrap();
    assert!(region.held_lease().is_none());
    let (next, _) = reads
        .start(&mut a.r, a.s, Target::Id(FILE), None, None, &mut region)
        .unwrap();
    assert!(next.0 > stream.0);
    let successor = region.held_lease().unwrap();
    reads.cancel(a.s, stream, &mut region).unwrap();
    assert_eq!(region.held_lease(), Some(successor));
}
