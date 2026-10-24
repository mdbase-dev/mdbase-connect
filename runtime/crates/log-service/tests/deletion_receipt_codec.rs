//! Strict terminal receipt codec and durable meta invariants; no effect proof.
use mdbn_log_service::deletion::CollectionDeletionRecord;
use mdbn_log_service::model::{CollectionMeta, Status};
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::common::B16;

fn record() -> CollectionDeletionRecord {
    CollectionDeletionRecord {
        collection: B16([1; 16]),
        deletion_id: B16([2; 16]),
        lifecycle_epoch: u64::MAX,
    }
}
#[test]
fn receipt_preserves_full_u64_and_refuses_untyped_nil_zero_extra() {
    let r = record();
    assert_eq!(CollectionDeletionRecord::parse(&r.to_cbor()).unwrap(), r);
    let mut extra = match r.to_cbor() {
        Cbor::Array(v) => v,
        _ => unreachable!(),
    };
    extra.push(Cbor::Uint(1));
    for bad in [
        Cbor::Bool(true),
        Cbor::Array(extra),
        CollectionDeletionRecord {
            collection: B16([0; 16]),
            ..r
        }
        .to_cbor(),
        CollectionDeletionRecord {
            deletion_id: B16([0; 16]),
            ..r
        }
        .to_cbor(),
        CollectionDeletionRecord {
            lifecycle_epoch: 0,
            ..r
        }
        .to_cbor(),
    ] {
        assert!(CollectionDeletionRecord::parse(&bad).is_err());
    }
}
#[test]
fn meta_terminal_identity_requires_actual_gone_and_same_collection() {
    let r = record();
    let mut meta = CollectionMeta::new(r.collection, 1);
    meta.status = Status::Gone;
    assert_eq!(
        CollectionMeta::decode(&meta.encode()).unwrap().deletion,
        None,
        "legacy Gone has no invented receipt"
    );
    meta.deletion = Some(r);
    assert_eq!(
        CollectionMeta::decode(&meta.encode()).unwrap().deletion,
        Some(r)
    );
    meta.status = Status::Live;
    assert!(CollectionMeta::decode(&meta.encode()).is_err());
    meta.status = Status::Gone;
    meta.deletion = Some(CollectionDeletionRecord {
        collection: B16([3; 16]),
        ..r
    });
    assert!(CollectionMeta::decode(&meta.encode()).is_err());
}
#[test]
fn malformed_persisted_terminal_tuple_fails_not_legacy_none() {
    let mut meta = CollectionMeta::new(B16([1; 16]), 1);
    meta.status = Status::Gone;
    let Cbor::Map(mut fields) = cbor::decode(&meta.encode()).unwrap() else {
        unreachable!()
    };
    fields.push((Cbor::Uint(21), Cbor::Bool(true)));
    assert!(CollectionMeta::decode(&cbor::encode(&Cbor::Map(fields)).unwrap()).is_err());
}
