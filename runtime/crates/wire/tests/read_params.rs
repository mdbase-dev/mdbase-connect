//! Optional read byte budgets preserve the canonical omitted-field encoding.

use mdbn_wire::cbor::Cbor;
use mdbn_wire::common::B16;
use mdbn_wire::log_service::ReadParams;
use mdbn_wire::schema::Wire;

#[test]
fn omitted_read_budget_preserves_legacy_shape() {
    let old = Cbor::Map(vec![
        (Cbor::Uint(0), Cbor::Bytes(vec![0x22; 16])),
        (Cbor::Uint(1), Cbor::Uint(42)),
        (Cbor::Uint(2), Cbor::Uint(1000)),
    ]);
    let params = ReadParams::from_cbor(&old).unwrap();
    assert_eq!(params.max_bytes, None);
    assert_eq!(params.to_cbor(), old);
}

#[test]
fn read_budget_is_optional_unsigned_key_four() {
    for cap in [0, 1, 512 * 1024, u64::MAX] {
        let params = ReadParams {
            collection: B16([0x22; 16]),
            after: 42,
            limit: 1000,
            kinds: None,
            max_bytes: Some(cap),
        };
        assert_eq!(
            ReadParams::from_bytes(&params.to_bytes().unwrap()).unwrap(),
            params
        );
        let Cbor::Map(mut fields) = params.to_cbor() else {
            panic!("not a map")
        };
        assert_eq!(fields.pop(), Some((Cbor::Uint(4), Cbor::Uint(cap))));
        // Removing the extension reproduces the legacy request exactly.
        assert_eq!(
            ReadParams::from_cbor(&Cbor::Map(fields)).unwrap().max_bytes,
            None
        );
    }
    let bad = Cbor::Map(vec![
        (Cbor::Uint(0), Cbor::Bytes(vec![0x22; 16])),
        (Cbor::Uint(1), Cbor::Uint(42)),
        (Cbor::Uint(2), Cbor::Uint(1000)),
        (Cbor::Uint(4), Cbor::Text("524288".into())),
    ]);
    assert!(ReadParams::from_cbor(&bad).is_err());
}
