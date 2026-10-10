use super::*;
use crate::views::bases::{Bindings, RuntimeValue, WorkBudget};
fn object(entries: &[(&str, Value)]) -> Value {
    Value::Map(Map::from_iter(
        entries.iter().map(|(k, v)| (k.to_string(), v.clone())),
    ))
}
fn sort(field: &str, id: &str) -> Value {
    object(&[(field, Value::string(id))])
}
#[test]
fn note_aliases_are_one_raw_key_without_labels_casefold_or_defaults() {
    for id in ["due", "note.due", "note[\"due\"]", "note['due']"] {
        assert_eq!(
            PropertySelector::parse(id).unwrap(),
            PropertySelector::Note("due".into())
        );
    }
    let note = Map::from_iter([
        ("due".into(), Value::Int(2)),
        ("note.due".into(), Value::Int(3)),
        ("Due".into(), Value::Int(4)),
    ]);
    for id in ["due", "note.due", "note[\"due\"]"] {
        let p = PropertySelector::parse(id)
            .unwrap()
            .compile(&BTreeMap::new(), Profile::Primitive)
            .unwrap();
        assert_eq!(
            p.evaluate(Bindings::raw(&note), &mut WorkBudget::new())
                .unwrap(),
            RuntimeValue::Number(2.0)
        );
    }
    assert_ne!(
        PropertySelector::parse("Due"),
        PropertySelector::parse("due")
    );
    let missing = PropertySelector::parse("absent")
        .unwrap()
        .compile(&BTreeMap::new(), Profile::Primitive)
        .unwrap();
    assert_eq!(
        missing
            .evaluate(Bindings::raw(&note), &mut WorkBudget::new())
            .unwrap(),
        RuntimeValue::Null
    );
}
#[test]
fn literal_reserved_punctuation_and_escaped_names_cannot_inject_expressions() {
    for name in [
        "note",
        "file",
        "formula",
        "due date",
        "priority-level",
        "x.y",
        "a\"\\b",
        "x\"] || true || note[\"z",
    ] {
        let note = Map::from_iter([(name.into(), Value::string("exact"))]);
        let selector = PropertySelector::Note(name.into());
        let program = selector
            .compile(&BTreeMap::new(), Profile::Primitive)
            .unwrap();
        assert_eq!(
            program
                .evaluate(Bindings::raw(&note), &mut WorkBudget::new())
                .unwrap(),
            RuntimeValue::String("exact".into())
        );
    }
    assert_eq!(
        PropertySelector::parse("note[\"x.y\"]").unwrap(),
        PropertySelector::Note("x.y".into())
    );
}
#[test]
fn namespace_formula_identity_and_file_capabilities_stay_distinct() {
    let formulas = BTreeMap::from([("score with space".into(), "7".into())]);
    let selector = PropertySelector::parse("formula[\"score with space\"]").unwrap();
    let p = selector.compile(&formulas, Profile::Primitive).unwrap();
    assert_eq!(
        p.evaluate(Bindings::raw(&Map::new()), &mut WorkBudget::new())
            .unwrap(),
        RuntimeValue::Number(7.0)
    );
    assert_ne!(
        PropertySelector::parse("score"),
        PropertySelector::parse("formula.score")
    );
    assert_eq!(
        PropertySelector::parse("file.name")
            .unwrap()
            .compile(&BTreeMap::new(), Profile::Primitive)
            .unwrap_err()
            .kind
            .code(),
        "view_unsupported_construct"
    );
}
#[test]
fn unsupported_dynamic_nested_unicode_escape_and_control_ids_visibly_refuse() {
    for id in [
        "note[due]",
        "note[\"a\"].b",
        "note.foo.bar",
        "formula.a.b",
        "note[\"\\u0061\"]",
        "a\n",
    ] {
        assert!(PropertySelector::parse(id).is_err(), "{id:?}");
    }
    assert_eq!(
        PropertySelector::parse("").unwrap_err().kind.detail(),
        "empty_property_selector"
    );
    assert_eq!(
        PropertySelector::parse(&"x".repeat(MAX_PROPERTY_SELECTOR_BYTES + 1))
            .unwrap_err()
            .kind
            .detail(),
        "property_selector_bytes"
    );
}
#[test]
fn sort_column_legacy_property_and_equivalent_dual_keys_preserve_order() {
    assert_eq!(
        SortTerm::from_value(&sort("column", "note.due")),
        SortTerm::from_value(&sort("property", "due"))
    );
    let both = object(&[
        ("column", Value::string("note.due")),
        ("property", Value::string("due")),
        ("direction", Value::string("dEsC")),
    ]);
    assert_eq!(
        SortTerm::from_value(&both).unwrap().direction,
        SortDirection::Desc
    );
    let decoded = decode_sort(&Value::List(vec![
        sort("column", "due"),
        sort("property", "priority"),
        sort("column", "due"),
    ]))
    .unwrap();
    assert_eq!(
        decoded.iter().map(|t| t.property.key()).collect::<Vec<_>>(),
        vec!["due", "priority", "due"]
    );
}
#[test]
fn malformed_ambiguous_or_unqualified_sort_terms_never_become_ascending_defaults() {
    for value in [
        Value::Null,
        object(&[]),
        object(&[("column", Value::Bool(true))]),
        object(&[
            ("column", Value::string("due")),
            ("property", Value::string("priority")),
        ]),
        object(&[
            ("column", Value::string("due")),
            ("direction", Value::string("sideways")),
        ]),
        object(&[("column", Value::string("due")), ("direction", Value::Null)]),
        object(&[
            ("column", Value::string("due")),
            ("unknown", Value::Bool(true)),
        ]),
    ] {
        assert!(SortTerm::from_value(&value).is_err());
    }
    assert!(
        decode_sort(&Value::List(vec![
            sort("column", "due");
            MAX_SORT_TERMS + 1
        ]))
        .is_err()
    );
}
#[test]
fn metadata_aliases_coalesce_only_when_equal_and_never_bind_row_values() {
    let metadata = object(&[("displayName", Value::string("Deadline"))]);
    let props = Map::from_iter([
        ("due".into(), metadata.clone()),
        ("note.due".into(), metadata),
    ]);
    let normalized = normalize_property_metadata(&props).unwrap();
    assert_eq!(normalized.len(), 1);
    assert!(normalized.contains_key(&PropertySelector::Note("due".into())));
    let p = PropertySelector::parse("due")
        .unwrap()
        .compile(&BTreeMap::new(), Profile::Primitive)
        .unwrap();
    assert_eq!(
        p.evaluate(Bindings::raw(&Map::new()), &mut WorkBudget::new())
            .unwrap(),
        RuntimeValue::Null
    );
    let conflicting = Map::from_iter([
        ("due".into(), Value::string("A")),
        ("note.due".into(), Value::string("B")),
    ]);
    assert_eq!(
        normalize_property_metadata(&conflicting)
            .unwrap_err()
            .kind
            .detail(),
        "ambiguous_property_metadata"
    );
}
#[test]
fn metadata_value_and_depth_bounds_are_checked_before_cloning() {
    let props = Map::from_iter([(
        "due".into(),
        Value::Text("x".repeat(MAX_PROPERTY_METADATA_VALUE_BYTES + 1)),
    )]);
    assert_eq!(
        normalize_property_metadata(&props)
            .unwrap_err()
            .kind
            .detail(),
        "property_metadata_value_bytes"
    );
    let mut value = Value::Null;
    for _ in 0..=super::super::MAX_VALUE_DEPTH {
        value = Value::List(vec![value]);
    }
    let props = Map::from_iter([("due".into(), value)]);
    assert_eq!(
        normalize_property_metadata(&props)
            .unwrap_err()
            .kind
            .detail(),
        "property_metadata_depth"
    );
}
