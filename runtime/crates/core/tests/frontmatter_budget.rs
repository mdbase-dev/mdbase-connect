//! Bounded parsing/admission, not aggregate query heap qualification.
use mdbn_core::{
    doc::{self, Document},
    value::Value,
    yaml::{self, budget},
};

#[test]
fn normal_documents_keep_exact_source_style_values_and_problems() {
    for (path, source) in [
        (
            "x.md",
            "\u{feff}---\r\na: 1\r\nb: &items [true, null, é]\r\nc: *items\r\n---\r\nBody\r\n",
        ),
        ("x.md", "---\nscalar: |\n  line one\n  line two\n---\nbody"),
        ("x.md", "---\nnot: [valid\n---\nbody"),
        ("x.md", "---\n- nonmapping\n---\nbody"),
        ("x.base", "filters: 'status == \"open\"'\nviews: []\n"),
        ("x.md", "no frontmatter\n"),
    ] {
        let legacy = Document::parse_at(path, source);
        let (bounded, footprint) = Document::parse_at_bounded(path, source).unwrap();
        assert_eq!(bounded.source(), legacy.source());
        assert_eq!(bounded.body(), legacy.body());
        assert_eq!(bounded.frontmatter(), legacy.frontmatter());
        assert_eq!(bounded.frontmatter_value(), legacy.frontmatter_value());
        assert_eq!(bounded.problem(), legacy.problem());
        assert_eq!(bounded.line_ending(), legacy.line_ending());
        assert_eq!(bounded.has_bom(), legacy.has_bom());
        assert_eq!(doc::check_frontmatter_at(path, source).unwrap(), footprint);
        assert!(footprint.estimated_heap_bytes <= budget::MAX_ESTIMATED_HEAP_BYTES);
    }
}
#[test]
fn decoded_utf8_string_and_key_boundaries_are_exact() {
    for text in [
        "x".repeat(budget::MAX_STRING_BYTES),
        "é".repeat(budget::MAX_STRING_BYTES / 2),
    ] {
        let source = format!("---\nvalue: '{text}'\n---\n");
        let (parsed, _) = Document::parse_at_bounded("x.md", &source).unwrap();
        assert_eq!(
            parsed.frontmatter().get("value"),
            Some(&Value::Text(text.clone()))
        );
        let over = format!("---\nvalue: '{text}x'\n---\n");
        let e = Document::parse_at_bounded("x.md", &over).unwrap_err();
        assert_eq!(e.kind, budget::Kind::StringBytes);
        assert_eq!(e.actual, budget::MAX_STRING_BYTES as u64 + 1);
        assert_eq!(e.reason(), "record_frontmatter_limit_exceeded");
    }
    let key = "k".repeat(budget::MAX_STRING_BYTES + 1);
    assert_eq!(
        doc::check_frontmatter_at("x.md", &format!("---\n'{key}': 1\n---\n"))
            .unwrap_err()
            .kind,
        budget::Kind::StringBytes
    );
}
#[test]
fn semantic_depth_is_not_the_legacy_parser_call_stack_depth() {
    let accepted = format!("{}1{}", "[".repeat(31), "]".repeat(31));
    let (_, footprint) = yaml::parse_value_bounded(&accepted).unwrap();
    assert_eq!(footprint.depth, 32);
    let refused = format!("{}1{}", "[".repeat(32), "]".repeat(32));
    let err = yaml::parse_value_bounded(&refused).unwrap_err();
    assert!(matches!(
        err.kind,
        yaml::ErrorKind::ResourceLimit(budget::LimitExceeded {
            kind: budget::Kind::Depth,
            actual: 33,
            max: 32
        })
    ));
    assert!(
        yaml::parse_value(&refused).is_ok(),
        "legacy replay profile stays unchanged"
    );
}
#[test]
fn malformed_quoted_scalar_cannot_absorb_a_limit_error() {
    let source = format!(
        "---\nx: \"{}\n---\n",
        "x".repeat(budget::MAX_STRING_BYTES + 1)
    );
    let e = Document::parse_at_bounded("x.md", &source).unwrap_err();
    assert_eq!(e.kind, budget::Kind::StringBytes);
    assert!(Document::parse_at("x.md", source).problem().is_some());
}
#[test]
fn parse_heap_estimate_and_document_clone_are_preflighted() {
    let mut source = String::from("---\n");
    for n in 0..12_000 {
        source.push_str(&format!("key{n}: true\n"));
    }
    source.push_str("---\nbody\n");
    assert!(source.len() < 1024 * 1024);
    let e = doc::check_frontmatter_at("x.md", &source).unwrap_err();
    assert_eq!(e.kind, budget::Kind::EstimatedHeapBytes);
    assert_eq!(e.max, 16 * 1024 * 1024);
}
#[test]
fn complete_planned_guard_refuses_without_changing_any_effect() {
    use mdbn_core::{
        ids::Uuid,
        plan::{self, Effect, Planned, Status},
        semantics::SEM,
    };
    let source = format!(
        "---\nvalue: '{}'\n---\n",
        "x".repeat(budget::MAX_STRING_BYTES + 1)
    );
    let planned = Planned {
        sem: SEM,
        status: Status::Applied,
        effects: vec![
            Effect::PutRecord {
                id: Uuid::NIL,
                path: "ok.md".into(),
                doc: "---\na: 1\n---\n".into(),
            },
            Effect::PutRecord {
                id: Uuid::NIL,
                path: "too-complex.md".into(),
                doc: source.clone(),
            },
        ],
        conflicts: vec![],
        aliases: vec![],
        base_text_fills: vec![],
        issues: vec![],
        ends_batch: false,
        touches: vec![],
        link_rewrites: vec![],
        broken_links: vec![],
    };
    let before = planned.clone();
    let e = plan::frontmatter_admission::check_planned(&planned).unwrap_err();
    assert_eq!(e.path, "too-complex.md");
    assert_eq!(e.reason(), "record_frontmatter_limit_exceeded");
    assert_eq!(planned, before);
    assert_eq!(
        plan::frontmatter_admission::check_source("too-complex.md", &source).unwrap_err(),
        e
    );
}

#[test]
fn body_bytes_do_not_become_frontmatter_string_bytes() {
    let source = format!(
        "---\nstatus: open\n---\n{}",
        "x".repeat(budget::MAX_STRING_BYTES + 1)
    );
    let (d, footprint) = Document::parse_at_bounded("x.md", &source).unwrap();
    assert_eq!(d.body().len(), budget::MAX_STRING_BYTES + 1);
    assert_eq!(footprint.values, 3); // root map, string key, string value
}
