//! Native query metadata; codec support is not executor qualification.
use mdbn_wire::cbor::Cbor;
use mdbn_wire::client::{QueryGroup, QueryMetadata, QueryResult, QueryUpdate};
use mdbn_wire::schema::Wire;

fn map(entries: Vec<(u64, Cbor)>) -> Cbor {
    Cbor::Map(
        entries
            .into_iter()
            .map(|(k, v)| (Cbor::Uint(k), v))
            .collect(),
    )
}
fn old_result() -> Cbor {
    map(vec![
        (0, Cbor::Array(vec![])),
        (2, Cbor::Bool(true)),
        (3, Cbor::Uint(17)),
    ])
}
#[test]
fn legacy_four_field_results_remain_byte_identical() {
    let old = old_result();
    let result = QueryResult::from_cbor(&old).unwrap();
    assert_eq!(result.to_cbor(), old);
    assert!(result.columns.is_none() && result.total_count.is_none());
    assert!(result.groups.is_none() && result.has_more.is_none());
}
#[test]
fn empty_record_window_can_carry_whole_match_groups() {
    let group = map(vec![
        (0, Cbor::Map(vec![])),
        (1, Cbor::Uint(12)),
        (2, Cbor::Map(vec![])),
    ]);
    let Cbor::Map(mut entries) = old_result() else {
        unreachable!()
    };
    entries.extend([
        (Cbor::Uint(5), Cbor::Uint(12)),
        (Cbor::Uint(8), Cbor::Array(vec![group.clone()])),
        (Cbor::Uint(9), Cbor::Bool(true)),
    ]);
    let encoded = Cbor::Map(entries);
    let result = QueryResult::from_cbor(&encoded).unwrap();
    assert!(result.records.is_empty());
    assert_eq!(result.total_count, Some(12));
    assert_eq!(result.groups.as_ref().unwrap()[0].count, 12);
    assert_eq!(result.has_more, Some(true));
    assert_eq!(result.to_cbor(), encoded);
    assert_eq!(QueryGroup::from_cbor(&group).unwrap().to_cbor(), group);
}
#[test]
fn metadata_is_a_full_typed_same_version_replacement() {
    let replacement = map(vec![
        (1, Cbor::Uint(0)),
        (4, Cbor::Array(vec![])),
        (5, Cbor::Bool(false)),
    ]);
    let update = map(vec![
        (0, Cbor::Uint(3)),
        (1, Cbor::Uint(1)),
        (6, Cbor::Bool(true)),
        (7, Cbor::Uint(18)),
        (8, replacement.clone()),
    ]);
    let decoded = QueryUpdate::from_cbor(&update).unwrap();
    assert_eq!(decoded.as_of, 18);
    assert_eq!(decoded.metadata.as_ref().unwrap().total_count, Some(0));
    assert_eq!(decoded.to_cbor(), update);
    assert_eq!(
        QueryMetadata::from_cbor(&replacement).unwrap().to_cbor(),
        replacement
    );
}
#[test]
fn metadata_types_do_not_accept_negative_counts_or_array_group_values() {
    assert!(QueryGroup::from_cbor(&map(vec![(0, Cbor::Map(vec![])), (1, Cbor::int(-1))])).is_err());
    assert!(
        QueryGroup::from_cbor(&map(vec![(0, Cbor::Array(vec![])), (1, Cbor::Uint(0))])).is_err()
    );
    assert!(QueryMetadata::from_cbor(&map(vec![(5, Cbor::Uint(0))])).is_err());
}
