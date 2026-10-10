use super::*;
use crate::{
    doc::RecordFormat,
    value::Value,
    views::bases::{BasesTimezone, CapturedClock, Profile, Program, RuntimeValue},
};
fn evaluate(
    source: &str,
    doc: &Document,
    hints: &BTreeMap<String, String>,
    clock: bool,
) -> Result<RuntimeValue, EvaluationFailure> {
    let p = Program::compile_with_profile(source, &BTreeMap::new(), Profile::Duration).unwrap();
    let mut budget = WorkBudget::new();
    let types = CapturedPropertyTypes::capture(hints, &mut budget)?;
    let row = RawFrontmatter::capture(doc, Some(types), &mut budget)?;
    let mut bindings = row.bindings();
    if clock {
        let zone = BasesTimezone::capture("UTC", &mut budget)?;
        bindings = bindings.with_clock(CapturedClock::new(1700000000000, zone, &mut budget)?);
    }
    p.evaluate(bindings, &mut budget)
}
#[test]
fn raw_document_ignores_effective_defaults_and_preserves_exact_bytes() {
    let source =
        "---\r\npriority: 0\r\narchived: false\r\nempty: ''\r\nexplicit: null\r\n---\r\nbody\r\n";
    let doc = Document::parse(source, RecordFormat::Markdown);
    let hints = BTreeMap::new();
    assert_eq!(
        evaluate("status.isEmpty()", &doc, &hints, false).unwrap(),
        RuntimeValue::Bool(true)
    );
    assert_eq!(
        evaluate("priority", &doc, &hints, false).unwrap(),
        RuntimeValue::Number(0.0)
    );
    assert_eq!(
        evaluate("archived", &doc, &hints, false).unwrap(),
        RuntimeValue::Bool(false)
    );
    assert_eq!(
        evaluate("empty", &doc, &hints, false).unwrap(),
        RuntimeValue::String(String::new())
    );
    assert_eq!(
        evaluate("explicit", &doc, &hints, false).unwrap(),
        RuntimeValue::Null
    );
    let catalog = crate::types::Catalog::load([(
        "_types/task.md",
        "---\nkind: mdbase.type\nname: task\nschema:\n  dialect: json-schema-2020-12\n  value: {type: object}\ncollection:\n  read_defaults: {status: done, priority: 99}\n---\n",
    )]);
    let effective = catalog.effective_frontmatter(&["task".into()], doc.frontmatter());
    assert_eq!(effective.get("status"), Some(&Value::string("done")));
    assert_eq!(effective.get("priority"), Some(&Value::Int(0)));
    assert!(doc.frontmatter().get("status").is_none());
    assert_eq!(doc.source(), source);
}
#[test]
fn known_empty_registry_is_distinct_from_unavailable_and_failures_stick() {
    let doc = Document::parse("no frontmatter", RecordFormat::Markdown);
    let mut budget = WorkBudget::new();
    assert_eq!(
        RawFrontmatter::capture(&doc, None, &mut budget)
            .err()
            .unwrap(),
        EvaluationFailure::MetadataUnavailable("property_types_not_captured")
    );
    assert_eq!(
        CapturedPropertyTypes::capture(&BTreeMap::new(), &mut budget)
            .err()
            .unwrap(),
        EvaluationFailure::MetadataUnavailable("property_types_not_captured")
    );
    assert_eq!(
        evaluate("absent", &doc, &BTreeMap::new(), false).unwrap(),
        RuntimeValue::Null
    );
}
#[test]
fn invalid_mapping_or_yaml_never_becomes_an_empty_row() {
    for source in ["---\n[not: mapping\n---\n", "---\n- scalar\n---\n"] {
        let doc = Document::parse(source, RecordFormat::Markdown);
        assert!(doc.problem().is_some());
        assert_eq!(
            evaluate("status.isEmpty()", &doc, &BTreeMap::new(), false).unwrap_err(),
            EvaluationFailure::MetadataUnavailable("raw_frontmatter_unavailable")
        );
    }
    let base = Document::parse("views: []\n", RecordFormat::YamlDocument);
    assert_eq!(
        evaluate("views.length", &base, &BTreeMap::new(), false).unwrap(),
        RuntimeValue::Number(0.0)
    );
}
#[test]
fn captured_date_typing_requires_a_clock_and_does_not_guess_string_types() {
    let doc = Document::parse("---\ndue: '2026-06-10'\n---\n", RecordFormat::Markdown);
    let hints = BTreeMap::from([("due".into(), "date".into())]);
    assert_eq!(
        evaluate("due.isType('Date')", &doc, &hints, true).unwrap(),
        RuntimeValue::Bool(true)
    );
    assert_eq!(
        evaluate("due.isType('Date')", &doc, &hints, false).unwrap_err(),
        EvaluationFailure::UnsupportedConstruct("clock_not_captured")
    );
    assert_eq!(
        evaluate("due.isType('String')", &doc, &BTreeMap::new(), false).unwrap(),
        RuntimeValue::Bool(true)
    );
    assert_eq!(
        evaluate("unrelated", &doc, &hints, false).unwrap(),
        RuntimeValue::Null
    );
}
#[test]
fn registry_hints_do_not_coerce_raw_scalar_values_or_invent_missing_fields() {
    let doc = Document::parse(
        "---\namount: '17'\nflag: false\n---\n",
        RecordFormat::Markdown,
    );
    let hints = BTreeMap::from([
        ("amount".into(), "number".into()),
        ("flag".into(), "checkbox".into()),
        ("absent".into(), "date".into()),
    ]);
    assert_eq!(
        evaluate("amount.isType('String')", &doc, &hints, false).unwrap(),
        RuntimeValue::Bool(true)
    );
    assert_eq!(
        evaluate("flag", &doc, &hints, false).unwrap(),
        RuntimeValue::Bool(false)
    );
    assert_eq!(
        evaluate("absent", &doc, &hints, false).unwrap(),
        RuntimeValue::Null
    );
    let explicit_null = Document::parse("---\nabsent: null\n---\n", RecordFormat::Markdown);
    assert_eq!(
        evaluate("absent", &explicit_null, &hints, false).unwrap_err(),
        EvaluationFailure::UnsupportedConstruct("typed_empty_property_unqualified")
    );
}
#[test]
fn unqualified_link_and_list_date_shapes_refuse_without_fallback_values() {
    let doc = Document::parse(
        "---\nproject: '[[Project]]'\ndates: ['2026-06-10']\n---\n",
        RecordFormat::Markdown,
    );
    let hints = BTreeMap::from([
        ("project".into(), "link".into()),
        ("dates".into(), "date".into()),
    ]);
    assert!(matches!(
        evaluate("project", &doc, &hints, false),
        Err(EvaluationFailure::UnsupportedConstruct(_))
    ));
    assert_eq!(
        evaluate("dates", &doc, &hints, true).unwrap_err(),
        EvaluationFailure::UnsupportedConstruct("date_property_type")
    );
}
#[test]
fn capture_bounds_and_request_meter_are_checked_without_row_or_registry_cloning() {
    let mut budget = WorkBudget::new();
    let hints = BTreeMap::from([("key".into(), "x".repeat(MAX_PROPERTY_TYPE_HINT_BYTES + 1))]);
    assert_eq!(
        CapturedPropertyTypes::capture(&hints, &mut budget)
            .err()
            .unwrap(),
        EvaluationFailure::BudgetExceeded("property_type_bytes")
    );
    let source = "x".repeat(MAX_RAW_RECORD_BYTES + 1);
    let doc = Document::parse(source, RecordFormat::Markdown);
    let hints = BTreeMap::new();
    let mut budget = WorkBudget::new();
    let types = CapturedPropertyTypes::capture(&hints, &mut budget).unwrap();
    assert_eq!(
        RawFrontmatter::capture(&doc, Some(types), &mut budget)
            .err()
            .unwrap(),
        EvaluationFailure::BudgetExceeded("raw_record_bytes")
    );
    let doc = Document::parse("", RecordFormat::Markdown);
    let mut budget = WorkBudget::constrained(0, 1024);
    let types = CapturedPropertyTypes::capture(&hints, &mut budget).unwrap();
    assert!(matches!(
        RawFrontmatter::capture(&doc, Some(types), &mut budget),
        Err(EvaluationFailure::BudgetExceeded(_))
    ));
    assert!(doc.frontmatter().get("absent").is_none());
    assert_ne!(Value::Null, Value::Bool(false));
}
