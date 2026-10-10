use super::*;
use crate::{doc::RecordFormat, value::Value};
pub(super) const CONTRACT: &str = "---\nkind: mdbase.contract\ncontract_type: record\nid: obsidian.base\nversion: 1.0.0\nrecord_schema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\n    required: [views]\n    properties:\n      filters: {}\n      formulas: {type: object}\n      properties: {type: object}\n      views: {type: array, minItems: 1, items: {type: object, required: [type], properties: {type: {type: string}, name: {type: string}}}}\n---\n";
fn type_source(name: &str, field: &str) -> String {
    format!(
        "---\nkind: mdbase.type\nname: {name}\nmatch:\n  path_glob: '**/*.base'\nschema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\n    properties:\n      {field}: {{}}\n      filters: {{}}\n      formulas: {{type: object}}\n      properties: {{type: object}}\nimplements:\n  - contract: obsidian.base\n    version: 1.0.0\n    fields:\n      views: {field}\n      filters: filters\n      formulas: formulas\n      properties: properties\n---\n"
    )
}
fn clock() -> OpClock {
    OpClock {
        instant_ms: 1781075828070,
        tz: "UTC".into(),
        local_date: "2026-06-10".into(),
    }
}
fn catalog(ty: &str) -> Catalog {
    Catalog::load([("_contracts/base.md", CONTRACT), ("_types/alias.md", ty)])
}
#[test]
fn resolved_type_not_extension_discovers_a_real_base_with_preserved_ordinals() {
    let ty = type_source("alternative", "views");
    let c = catalog(&ty);
    assert_eq!(c.implementations().len(), 1, "{:?}", c.issues());
    let d = Document::parse(
        "views:\n  - {type: table, name: Tasks}\n  - {type: table, name: Tasks}\n",
        RecordFormat::YamlDocument,
    );
    let mut b = WorkBudget::new();
    let discovered = discover_base_record(&c, "Views/Tasks.base", &d, &clock(), &mut b)
        .unwrap()
        .unwrap();
    assert_eq!(discovered.implementations[0].type_name, "alternative");
    assert_eq!(
        discovered.views.iter().map(|v| v.index).collect::<Vec<_>>(),
        vec![0, 1]
    );
    assert_eq!(discovered.views[0].name, Some("Tasks"));
    assert_eq!(
        discovered.views[0].raw.get("type"),
        Some(&Value::string("table"))
    );
    let c = Catalog::load([("_contracts/base.md", CONTRACT)]);
    let mut b = WorkBudget::new();
    assert!(
        discover_base_record(&c, "Views/Tasks.base", &d, &clock(), &mut b)
            .unwrap()
            .is_none()
    );
}
#[test]
fn explicit_implementation_at_md_path_and_pointer_projection_use_raw_fields() {
    let ty = type_source("alternative", "saved");
    let c = catalog(&ty);
    let d = Document::parse(
        "---\ntype: alternative\nsaved: [{type: table, name: Today}]\nviews: [{type: cards, name: Wrong}]\n---\n",
        RecordFormat::Markdown,
    );
    let mut b = WorkBudget::new();
    let result = discover_base_record(&c, "User/view.md", &d, &clock(), &mut b)
        .unwrap()
        .unwrap();
    assert_eq!(result.views[0].name, Some("Today"));
    let ty = ty.replace("views: saved", "/views: /saved");
    let c = catalog(&ty);
    let mut b = WorkBudget::new();
    assert_eq!(
        discover_base_record(&c, "User/view.md", &d, &clock(), &mut b)
            .unwrap()
            .unwrap()
            .views[0]
            .name,
        Some("Today")
    );
}
#[test]
fn absent_contract_and_unresolved_record_type_are_not_empty_inventory() {
    let d = Document::parse("views: [{type: table}]", RecordFormat::YamlDocument);
    let c = Catalog::load([]);
    let mut b = WorkBudget::new();
    assert!(matches!(
        discover_base_record(&c, "x.base", &d, &clock(), &mut b),
        Err(EvaluationFailure::MetadataUnavailable(
            "bases_contract_not_installed"
        ))
    ));
    let ty = type_source("alternative", "views");
    let c = catalog(&ty);
    let d = Document::parse(
        "type: unknown\nviews: [{type: table}]",
        RecordFormat::YamlDocument,
    );
    let mut b = WorkBudget::new();
    assert!(matches!(
        discover_base_record(&c, "x.base", &d, &clock(), &mut b),
        Err(EvaluationFailure::MetadataUnavailable(
            "record_types_unresolved"
        ))
    ));
}
#[test]
fn source_shapes_and_invalid_yaml_refuse_instead_of_missing_views_success() {
    let ty = type_source("alternative", "views");
    let c = catalog(&ty);
    for (source, detail) in [
        ("views: []", "base_views_empty"),
        ("views: {}", "base_views_shape"),
        ("other: true", "base_views_missing"),
        ("views: [false]", "base_view_shape"),
        ("views: [{name: Tasks}]", "base_view_type"),
        ("views: [{type: table, name: false}]", "base_view_name"),
    ] {
        let d = Document::parse(source, RecordFormat::YamlDocument);
        let mut b = WorkBudget::new();
        assert!(
            matches!(discover_base_record(&c,"x.base",&d,&clock(),&mut b),Err(EvaluationFailure::UnsupportedConstruct(found)) if found==detail)
        );
    }
    let d = Document::parse("views: [", RecordFormat::YamlDocument);
    let mut b = WorkBudget::new();
    assert!(matches!(
        discover_base_record(&c, "x.base", &d, &clock(), &mut b),
        Err(EvaluationFailure::MetadataUnavailable(
            "base_raw_frontmatter_unavailable"
        ))
    ));
}
#[test]
fn unknown_renderer_and_user_metadata_are_preserved_not_admitted() {
    let ty = type_source("alternative", "views");
    let c = catalog(&ty);
    let d = Document::parse(
        "views: [{type: plugin-renderer, vendorOption: original}]\nfilters: false\n",
        RecordFormat::YamlDocument,
    );
    let mut b = WorkBudget::new();
    let result = discover_base_record(&c, "x.base", &d, &clock(), &mut b)
        .unwrap()
        .unwrap();
    assert_eq!(result.views[0].view_type, "plugin-renderer");
    assert_eq!(
        result.views[0].raw.get("vendorOption"),
        Some(&Value::string("original"))
    );
    assert_eq!(result.fields.filters, Some(&Value::Bool(false)));
}
#[test]
fn multiple_resolved_implementations_coalesce_only_identical_projections() {
    let a = type_source("A", "views");
    let z = type_source("Z", "saved");
    let c = Catalog::load([
        ("_contracts/base.md", CONTRACT),
        ("_types/a.md", &a),
        ("_types/z.md", &z),
    ]);
    for (source, ok) in [
        ("views: [{type: table}]\nsaved: [{type: table}]", true),
        ("views: [{type: table}]\nsaved: [{type: cards}]", false),
    ] {
        let d = Document::parse(source, RecordFormat::YamlDocument);
        let mut b = WorkBudget::new();
        let result = discover_base_record(&c, "x.base", &d, &clock(), &mut b);
        if ok {
            assert_eq!(result.unwrap().unwrap().implementations.len(), 2);
        } else {
            assert!(matches!(
                result,
                Err(EvaluationFailure::UnsupportedConstruct(
                    "ambiguous_base_implementations"
                ))
            ));
        }
    }
}
#[test]
fn bounds_and_prior_cancellation_poison_discovery_without_partial_descriptors() {
    let ty = type_source("alternative", "views");
    let c = catalog(&ty);
    let d = Document::parse(
        format!(
            "views: [{}]",
            vec!["{type: table}"; MAX_DISCOVERED_VIEWS + 1].join(",")
        ),
        RecordFormat::YamlDocument,
    );
    let mut b = WorkBudget::new();
    assert!(matches!(
        discover_base_record(&c, "x.base", &d, &clock(), &mut b),
        Err(EvaluationFailure::BudgetExceeded("base_views_count"))
    ));
    let d = Document::parse("views: [{type: table}]", RecordFormat::YamlDocument);
    let mut b = WorkBudget::new();
    b.fail(EvaluationFailure::Cancelled);
    assert!(matches!(
        discover_base_record(&c, "x.base", &d, &clock(), &mut b),
        Err(EvaluationFailure::Cancelled)
    ));
}
#[test]
fn read_default_views_and_unresolved_implementation_do_not_create_discovery() {
    let ty = type_source("alternative", "views").replace(
        "views: {}",
        "views: {default: [{type: table, name: Guessed}], apply_default: read}",
    );
    let c = catalog(&ty);
    let d = Document::parse("unrelated: true", RecordFormat::YamlDocument);
    let mut b = WorkBudget::new();
    assert!(matches!(
        discover_base_record(&c, "x.base", &d, &clock(), &mut b),
        Err(EvaluationFailure::UnsupportedConstruct(
            "base_views_missing"
        ))
    ));
    let bad = type_source("alternative", "views").replace("version: 1.0.0", "version: 2.0.0");
    let c = catalog(&bad);
    assert!(c.implementations().is_empty());
    let d = Document::parse("views: [{type: table}]", RecordFormat::YamlDocument);
    let mut b = WorkBudget::new();
    assert!(
        discover_base_record(&c, "x.base", &d, &clock(), &mut b)
            .unwrap()
            .is_none()
    );
}
