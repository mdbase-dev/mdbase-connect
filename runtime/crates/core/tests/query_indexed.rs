//! Shared SQL-key, exact-order and bounded-heap conformance oracles.

use mdbn_core::ids::Uuid;
use mdbn_core::query::indexed::{
    AtomKind, CapturedClock, CursorStamp, FieldSource, IndexCursor, IndexFieldSpec,
    IndexGeneration, IndexKeyError, KEY_VERSION, SortAtom, TemporalHint,
};
use mdbn_core::query::topk::{self, KeyedRecord, MAX_KEY_BYTES, TopK, TopKError};
use mdbn_core::query::{Direction, FieldRef, compare_values};
use mdbn_core::value::{Map, Number, Value};
use std::cmp::Ordering;

fn atom(value: &Value) -> SortAtom {
    SortAtom::from_value(Some(value), TemporalHint::None, MAX_KEY_BYTES).unwrap()
}

#[test]
fn exact_numeric_binary_order_matches_the_numeric_oracle() {
    let mut values = vec![
        Value::Int(i64::MIN),
        Value::Int(i64::MAX),
        Value::Int(0),
        Value::Int(-1),
        Value::Int(1),
        Value::Int(9_007_199_254_740_993),
    ];
    for f in [
        -f64::MAX,
        f64::MAX,
        -0.0,
        0.0,
        f64::from_bits(1),
        -f64::from_bits(1),
        f64::MIN_POSITIVE,
        -f64::MIN_POSITIVE,
        9_007_199_254_740_992.0,
        9_223_372_036_854_775_808.0,
        -9_223_372_036_854_775_808.0,
        1.0,
        1.5,
        -1.5,
    ] {
        values.push(Value::float(f).unwrap());
    }
    let mut seed = 0x9876_5432_1098_7654u64;
    for _ in 0..180 {
        seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
        values.push(Value::Int(i64::from_ne_bytes(seed.to_ne_bytes())));
        if let Some(v) = Value::float(f64::from_bits(seed)) {
            values.push(v);
        }
    }
    for a in &values {
        let ak = atom(a);
        assert_eq!(SortAtom::from_parts(2, ak.key(), 11).unwrap(), ak);
        for b in &values {
            assert_eq!(
                ak.cmp(&atom(b)),
                a.as_number().unwrap().cmp_numeric(b.as_number().unwrap()),
                "{a:?} vs {b:?}"
            );
        }
    }
    assert_eq!(atom(&Value::Int(1)), atom(&Value::float(1.0).unwrap()));
    assert_eq!(atom(&Value::float(-0.0).unwrap()), atom(&Value::Int(0)));
    assert!(
        atom(&Value::Int(9_007_199_254_740_993))
            > atom(&Value::float(9_007_199_254_740_992.0).unwrap())
    );
    assert!(SortAtom::from_value(Some(&Value::Float(f64::NAN)), TemporalHint::None, 32).is_err());
    assert!(
        SortAtom::from_value(Some(&Value::Float(f64::INFINITY)), TemporalHint::None, 32).is_err()
    );
    assert_eq!(
        Number::Int(1).cmp_numeric(Number::Float(1.0)),
        Ordering::Equal
    );
}

#[test]
fn mixed_kinds_follow_one_total_order_and_do_not_coerce_plain_strings() {
    let values = vec![
        Value::Bool(false),
        Value::Bool(true),
        Value::Int(-1),
        Value::float(1.5).unwrap(),
        Value::string(""),
        Value::string("a\0b"),
        Value::string("é"),
        Value::string("😀"),
        Value::List(vec![]),
        Value::List(vec![Value::Null]),
        Value::Map(Map::new()),
        Value::Map([("x".into(), Value::Null)].into_iter().collect()),
        Value::Null,
    ];
    for a in &values {
        for b in &values {
            assert_eq!(atom(a).cmp(&atom(b)), compare_values(Some(a), Some(b)));
        }
    }
    for triplet in values.windows(3) {
        assert!(atom(&triplet[0]) <= atom(&triplet[1]));
        assert!(atom(&triplet[1]) <= atom(&triplet[2]));
        assert!(atom(&triplet[0]) <= atom(&triplet[2]));
    }
    assert_eq!(
        SortAtom::from_value(None, TemporalHint::None, 0).unwrap(),
        atom(&Value::Null)
    );
    assert_eq!(atom(&Value::string("2026-01-01")).kind(), AtomKind::Text);
    assert_eq!(
        atom(&Value::List(vec![Value::Bool(true)])),
        atom(&Value::List(vec![Value::Int(123)]))
    );
}

#[test]
fn explicit_temporal_atoms_preserve_instants_and_nanoseconds() {
    let make =
        |text: &str, hint| SortAtom::from_value(Some(&Value::string(text)), hint, 64).unwrap();
    let midnight = make("2026-01-01", TemporalHint::Date);
    let offset = make("2026-01-01T01:00:00+01:00", TemporalHint::DateTime);
    assert_eq!(midnight, offset);
    assert_eq!(midnight.kind(), AtomKind::Temporal);
    assert!(midnight > atom(&Value::Int(i64::MAX)));
    assert!(midnight < atom(&Value::string("")));
    assert!(
        make("1969-12-31T23:59:59.999999999Z", TemporalHint::DateTime)
            < make("1970-01-01T00:00:00Z", TemporalHint::DateTime)
    );
    assert!(make("2026-01-01T00:00:00.000000001Z", TemporalHint::DateTime) > midnight);
    assert_eq!(
        make("not-a-date", TemporalHint::DateTime).kind(),
        AtomKind::Text
    );
    assert_eq!(
        make("2026-02-30", TemporalHint::Date).kind(),
        AtomKind::Text
    );
    assert_eq!(
        SortAtom::from_parts(3, midnight.key(), 12).unwrap(),
        midnight
    );
}

#[test]
fn bounded_key_decode_and_unambiguous_paths() {
    assert_eq!(SortAtom::from_parts(0, &[], 8), Err(IndexKeyError::Invalid));
    assert_eq!(
        SortAtom::from_parts(255, &[0], 8),
        Err(IndexKeyError::Invalid)
    );
    assert_eq!(
        SortAtom::from_parts(1, &[2], 8),
        Err(IndexKeyError::Invalid)
    );
    assert_eq!(
        SortAtom::from_parts(2, &[0; 11], 16),
        Err(IndexKeyError::Invalid)
    );
    assert_eq!(
        SortAtom::from_parts(4, &[255], 8),
        Err(IndexKeyError::Invalid)
    );
    assert_eq!(
        SortAtom::from_value(Some(&Value::string("long")), TemporalHint::None, 3),
        Err(IndexKeyError::TooWide)
    );
    let spec = |path: Vec<String>| IndexFieldSpec {
        source: FieldSource::Effective,
        path,
        temporal: TemporalHint::None,
    };
    assert_ne!(
        spec(vec!["a.b".into()]).path_key(64).unwrap(),
        spec(vec!["a".into(), "b".into()]).path_key(64).unwrap()
    );
    assert_eq!(
        spec(vec!["abc".into()]).path_key(10),
        Err(IndexKeyError::TooWide)
    );
    assert!(IndexFieldSpec::effective_top_level(&FieldRef::Persisted(vec!["x".into()])).is_none());
    assert!(
        IndexFieldSpec::effective_top_level(&FieldRef::Effective(vec!["x".into(), "y".into()]))
            .is_none()
    );
    assert!(IndexFieldSpec::effective_top_level(&FieldRef::Effective(vec!["x".into()])).is_some());
}

#[test]
fn bounded_topk_matches_full_sort_with_mixed_kinds_and_id_ties() {
    let values = [
        Value::Null,
        Value::Bool(true),
        Value::Bool(false),
        Value::Int(5),
        Value::float(5.0).unwrap(),
        Value::string("str"),
        Value::List(vec![Value::Null]),
        Value::Map(Map::new()),
    ];
    let rows: Vec<_> = (1..=100u8)
        .rev()
        .map(|i| KeyedRecord {
            id: Uuid([i; 16]),
            keys: vec![
                atom(&values[usize::from(i) % values.len()]),
                atom(&Value::Int(i64::from(i % 3))),
            ],
        })
        .collect();
    for directions in [
        vec![Direction::Asc, Direction::Asc],
        vec![Direction::Desc, Direction::Asc],
        vec![Direction::Asc, Direction::Desc],
        vec![Direction::Desc, Direction::Desc],
    ] {
        let mut expected = rows.clone();
        expected.sort_by(|a, b| topk::compare(a, b, &directions));
        for limit in [0, 1, 7, 100] {
            let mut heap = TopK::new(limit, directions.clone(), MAX_KEY_BYTES).unwrap();
            for row in &rows {
                heap.push(row.clone()).unwrap();
            }
            assert_eq!(heap.finish().unwrap(), expected[..limit]);
        }
    }
    let low = KeyedRecord {
        id: Uuid([1; 16]),
        keys: vec![atom(&Value::Null)],
    };
    let high = KeyedRecord {
        id: Uuid([2; 16]),
        keys: low.keys.clone(),
    };
    assert_eq!(
        topk::compare(&low, &high, &[Direction::Desc]),
        Ordering::Less
    );
}

#[test]
fn exhausted_topk_cannot_publish_partial_results() {
    assert!(matches!(
        TopK::new(1001, vec![], MAX_KEY_BYTES),
        Err(TopKError::TooMany)
    ));
    let mut heap = TopK::new(1, vec![Direction::Asc], 512).unwrap();
    heap.push(KeyedRecord {
        id: Uuid([1; 16]),
        keys: vec![atom(&Value::string("z"))],
    })
    .unwrap();
    assert_eq!(
        heap.push(KeyedRecord {
            id: Uuid([2; 16]),
            keys: vec![atom(&Value::string(format!("a{}", "x".repeat(1000))))]
        }),
        Err(TopKError::TooWide)
    );
    assert_eq!(heap.finish(), Err(TopKError::TooWide));
    let mut heap = TopK::new(1, vec![Direction::Asc], 512).unwrap();
    assert_eq!(
        heap.push(KeyedRecord {
            id: Uuid([1; 16]),
            keys: vec![]
        }),
        Err(TopKError::Arity)
    );
    assert_eq!(heap.finish(), Err(TopKError::Arity));
}

#[test]
fn cursor_binds_generation_catalogue_sem_query_and_captured_clock() {
    let stamp = CursorStamp {
        version: KEY_VERSION,
        index: IndexGeneration {
            generation: 1,
            head_seq: 7,
            catalog_hash: [2; 32],
            sem: [1, 1],
        },
        query_hash: [3; 32],
        clock: CapturedClock {
            now_ms: 1000,
            today: "1970-01-01".into(),
            tz: "UTC".into(),
        },
    };
    let cursor = IndexCursor {
        stamp: stamp.clone(),
        keys: vec![atom(&Value::Int(1))],
        id: Uuid([1; 16]),
    };
    assert_eq!(cursor.validate(&stamp, 1), Ok(()));
    let mut changed = stamp.clone();
    changed.index.generation += 1;
    assert_eq!(
        cursor.validate(&changed, 1),
        Err(IndexKeyError::StaleCursor)
    );
    changed = stamp.clone();
    changed.index.head_seq += 1;
    assert!(cursor.validate(&changed, 1).is_err());
    changed = stamp.clone();
    changed.index.catalog_hash[0] += 1;
    assert!(cursor.validate(&changed, 1).is_err());
    changed = stamp.clone();
    changed.index.sem[1] += 1;
    assert!(cursor.validate(&changed, 1).is_err());
    changed = stamp.clone();
    changed.query_hash[0] += 1;
    assert!(cursor.validate(&changed, 1).is_err());
    changed = stamp.clone();
    changed.clock.now_ms += 1;
    assert!(cursor.validate(&changed, 1).is_err());
    changed = stamp.clone();
    changed.version += 1;
    assert!(cursor.validate(&changed, 1).is_err());
    assert!(cursor.validate(&stamp, 0).is_err());
}
