//! Capture is bounded and cannot authorize a foreign method or collection.
use super::http::HttpSigner;
use mdbn_replica::log::{CallId, EndpointId};
use mdbn_wire::{
    cbor::{self, Cbor},
    common::B16,
    schema::Wire,
};
fn frame(id: u64, method: &str, collection: u8) -> Vec<u8> {
    cbor::encode(&Cbor::Map(vec![
        (Cbor::Uint(0), Cbor::Uint(0)),
        (Cbor::Uint(1), Cbor::Uint(id)),
        (Cbor::Uint(2), Cbor::Text(method.into())),
        (
            Cbor::Uint(3),
            Cbor::Map(vec![(Cbor::Uint(0), B16([collection; 16]).to_cbor())]),
        ),
    ]))
    .unwrap()
}
#[test]
fn capture_requires_bound_collection_methods_ids_and_outstanding_budget() {
    let mut s = HttpSigner::new(
        &[0x33; 32],
        B16([0x22; 16]),
        EndpointId(37),
        B16([0x44; 16]),
    );
    assert!(!s.capture(CallId(1), &frame(1, "head", 0x22)));
    assert!(s.bind());
    for (id, f) in [
        (1, frame(1, "device-auth", 0x22)),
        (1, frame(1, "head", 0x23)),
        (1, frame(2, "head", 0x22)),
    ] {
        assert!(!s.capture(CallId(id), &f));
    }
    for id in 1..=64 {
        assert!(s.capture(CallId(id), &frame(id, "head", 0x22)));
    }
    assert!(!s.capture(CallId(1), &frame(1, "head", 0x22)));
    assert!(!s.capture(CallId(65), &frame(65, "head", 0x22)));
    s.forget(CallId(1));
    assert!(s.capture(CallId(65), &frame(65, "head", 0x22)));
}
