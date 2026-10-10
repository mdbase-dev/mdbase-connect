use super::*;
use mdbn_wire::{
    Wire,
    cbor::Cbor,
    common::{B16, B32, DataMap},
};
fn row(id: u8) -> RecordRow {
    RecordRow {
        id: B16([id; 16]),
        path: format!("{id}.md"),
        path_key: format!("{id}.md"),
        doc: "---\ntitle: task\n---\nbody\n".into(),
        revision: B32([1; 32]),
        modified_seq: 24,
        bucket: 256,
        meta: crate::store::RecordMeta::default(),
    }
}
fn encoded(row: &RecordRow) -> Vec<u8> {
    let meta = &row.meta;
    mdbn_wire::cbor::encode(&Cbor::Array(vec![
        row.id.to_cbor(),
        row.path.to_cbor(),
        row.path_key.to_cbor(),
        row.doc.to_cbor(),
        row.revision.to_cbor(),
        row.modified_seq.to_cbor(),
        u64::from(row.bucket).to_cbor(),
        Cbor::Array(vec![
            meta.types.to_cbor(),
            meta.effective.to_cbor(),
            meta.links.to_cbor(),
            meta.tags.to_cbor(),
            Cbor::Array(
                meta.unique
                    .iter()
                    .map(|(a, b)| Cbor::Array(vec![a.to_cbor(), b.to_cbor()]))
                    .collect(),
            ),
        ]),
    ]))
    .unwrap()
}
#[test]
fn zero_copy_row_size_matches_existing_store_file_cbor_shape() {
    let mut r = row(1);
    r.meta.types = vec!["task".into()];
    r.meta.links = vec!["l:project".into()];
    r.meta.tags = vec!["task".into()];
    r.meta.unique = vec![("id".into(), "uid".into())];
    r.meta.effective = DataMap(vec![(
        "map".into(),
        Value::Map(vec![(
            "nested".into(),
            Value::List(vec![
                Value::Int(i64::MIN),
                Value::Float(1.5),
                Value::Null,
                Value::Bool(false),
                Value::Text("😀".into()),
            ]),
        )]),
    )]);
    for length in [0, 23, 24, 255, 256, 65535, 65536] {
        r.doc = "x".repeat(length);
        assert_eq!(record_size(&r).unwrap(), encoded(&r).len() as u64);
    }
}
#[test]
fn sizing_is_head_fenced_and_bounded_with_strict_after_id_order() {
    let mut s = MemStore::new();
    s.commit(Tx {
        records_put: vec![row(3), row(1), row(2)],
        ..Tx::default()
    })
    .unwrap();
    let p = s
        .query_record_sizes_at(
            Page {
                after: Some(B16([1; 16])),
                limit: 1,
            },
            Head::GENESIS,
        )
        .unwrap();
    assert_eq!(p.len(), 1);
    assert_eq!(p[0].id, B16([2; 16]));
    assert_eq!(p[0].encoded_bytes, record_size(&row(2)).unwrap());
    assert_eq!(
        s.query_record_sizes_at(
            Page {
                after: None,
                limit: 1001
            },
            Head::GENESIS
        ),
        Err(StoreError::Full)
    );
    let stale = Head {
        seq: 1,
        chain: B32([1; 32]),
    };
    assert!(
        s.query_record_sizes_at(
            Page {
                after: None,
                limit: 0
            },
            stale
        )
        .is_err()
    );
}
#[test]
fn hydration_charges_whole_selection_before_cloning_in_request_order() {
    let mut s = MemStore::new();
    s.commit(Tx {
        records_put: vec![row(1), row(2)],
        ..Tx::default()
    })
    .unwrap();
    let bytes = record_size(&row(1)).unwrap() + record_size(&row(2)).unwrap();
    let mut b = crate::store_query::QueryBudget::new(2, bytes - 1);
    assert_eq!(
        s.hydrate_query_at(&[B16([2; 16]), B16([1; 16])], Head::GENESIS, &mut b),
        Err(StoreError::Full)
    );
    assert_eq!(b.records_left(), 2);
    assert_eq!(b.bytes_left(), bytes - 1);
    let mut b = crate::store_query::QueryBudget::new(2, bytes);
    let rows = s
        .hydrate_query_at(&[B16([2; 16]), B16([1; 16])], Head::GENESIS, &mut b)
        .unwrap();
    assert_eq!(
        rows.iter().map(|r| r.id).collect::<Vec<_>>(),
        vec![B16([2; 16]), B16([1; 16])]
    );
    assert_eq!((b.records_left(), b.bytes_left()), (0, 0));
    assert_eq!(
        s.hydrate_query_at(&[B16([1; 16])], Head::GENESIS, &mut b),
        Err(StoreError::Full)
    );
}
#[test]
fn duplicate_missing_and_stale_selections_never_return_partial_rows() {
    let mut s = MemStore::new();
    s.commit(Tx {
        records_put: vec![row(1)],
        ..Tx::default()
    })
    .unwrap();
    for ids in [
        vec![B16([1; 16]), B16([1; 16])],
        vec![B16([1; 16]), B16([2; 16])],
    ] {
        let mut b = crate::store_query::QueryBudget::HOSTED;
        assert!(s.hydrate_query_at(&ids, Head::GENESIS, &mut b).is_err());
        assert_eq!(b.records_left(), 1000);
    }
    let mut b = crate::store_query::QueryBudget::HOSTED;
    assert!(
        s.hydrate_query_at(
            &[],
            Head {
                seq: 1,
                chain: B32([2; 32])
            },
            &mut b
        )
        .is_err()
    );
}
