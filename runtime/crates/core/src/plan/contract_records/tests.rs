use super::*;

const CONTRACT: &str = "---\nkind: mdbase.contract\ncontract_type: record\nid: acme.card\nversion: 1.0.0\nrecord_schema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\n    required: [name]\n    properties:\n      name: {type: string}\n      done: {type: boolean}\n---\n";

fn type_source(name: &str) -> String {
    format!(
        "---\nkind: mdbase.type\nname: {name}\nschema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\n    properties:\n      card: {{type: object}}\n      completed: {{type: boolean}}\nimplements:\n  - contract: acme.card\n    version: '^1.0.0'\n    fields: {{'/name': '/card/label', '/done': '/completed'}}\n---\n"
    )
}

fn catalog(types: &[&str]) -> Catalog {
    let sources: Vec<(String, String)> = types
        .iter()
        .map(|t| (format!("_types/{t}.md"), type_source(t)))
        .collect();
    let mut resources = vec![
        ("mdbase.yaml", "spec_version: '0.3.0'\n"),
        ("_contracts/card.md", CONTRACT),
    ];
    resources.extend(sources.iter().map(|(p, s)| (p.as_str(), s.as_str())));
    let c = Catalog::load(resources);
    assert!(c.is_valid(), "{:?}", c.issues());
    c
}

fn selector(type_name: Option<&str>) -> ContractSelector {
    ContractSelector {
        id: "acme.card".into(),
        version: "1.0.0".into(),
        type_name: type_name.map(str::to_string),
    }
}

fn fields(yaml: &str) -> Map {
    match crate::yaml::parse_value(yaml).unwrap().unwrap() {
        Value::Map(m) => m,
        _ => unreachable!(),
    }
}

const DOC: &str =
    "---\ntype: card\ncard: {label: Old, colour: red}\ncompleted: false\nkeep: 1\n---\nbody\n";

fn record() -> RecordSource<'static> {
    RecordSource {
        path: "a.md",
        source: DOC,
    }
}

#[test]
fn reads_and_writes_through_the_mapping_merging_nested_fields() {
    let c = catalog(&["card"]);
    let view = contract_record(&c, &selector(None), record()).unwrap();
    assert_eq!(view.type_name, "card");
    assert_eq!(view.fields, fields("{name: Old, done: false}"));

    let w = contract_write(
        &c,
        &selector(None),
        Some(record()),
        &fields("{name: New}"),
        &["/done".into()],
    )
    .unwrap();
    // The sibling `colour` survives; the merged key declares what it was read as.
    assert_eq!(w.patch, fields("{card: {label: New, colour: red}}"));
    assert_eq!(w.unset, vec!["completed".to_string()]);
    assert_eq!(
        w.base,
        vec![(
            "card".to_string(),
            Some(Value::Map(fields("{label: Old, colour: red}")))
        )]
    );

    let create = contract_write(
        &c,
        &selector(None),
        None,
        &fields("{name: A, done: true}"),
        &[],
    )
    .unwrap();
    assert_eq!((create.type_name.as_str(), create.base.len()), ("card", 0));
    assert_eq!(create.patch, fields("{card: {label: A}, completed: true}"));
}

#[test]
fn refuses_unmapped_fields_ambiguity_and_invalid_views() {
    let c = catalog(&["card"]);
    let err = contract_write(
        &c,
        &selector(None),
        None,
        &fields("{name: A, secret: x}"),
        &[],
    )
    .unwrap_err();
    assert_eq!(
        (err.reason.as_deref(), err.details),
        (
            Some("data_contract_field_unmapped"),
            Some(Value::string("/secret"))
        )
    );
    // `name` is required by the contract's record schema.
    let err = contract_write(&c, &selector(None), None, &fields("{done: true}"), &[]).unwrap_err();
    assert_eq!(
        (err.code, err.reason.as_deref()),
        (
            RejectCode::InvalidRecord,
            Some("data_contract_record_invalid")
        )
    );
    assert!(!err.issues.is_empty());
    let err = contract_write(
        &c,
        &selector(None),
        Some(record()),
        &Map::new(),
        &["/name".into()],
    )
    .unwrap_err();
    assert_eq!(err.code, RejectCode::InvalidRecord);
    let other = RecordSource {
        path: "b.md",
        source: "---\nkeep: 1\n---\n",
    };
    let err = contract_record(&c, &selector(None), other).unwrap_err();
    assert_eq!(
        (err.code, err.reason.as_deref()),
        (RejectCode::NotFound, Some("data_contract_not_implemented"))
    );

    let two = catalog(&["card", "other"]);
    let err = contract_write(&two, &selector(None), None, &fields("{name: A}"), &[]).unwrap_err();
    assert_eq!(err.reason.as_deref(), Some("data_contract_ambiguous"));
    let picked = contract_write(
        &two,
        &selector(Some("Other")),
        None,
        &fields("{name: A}"),
        &[],
    )
    .unwrap();
    assert_eq!(picked.type_name, "other");
    // A record selects among the types it has.
    assert_eq!(
        contract_record(&two, &selector(None), record())
            .unwrap()
            .type_name,
        "card"
    );
}

#[test]
fn promote_types_an_untyped_record_in_the_same_write() {
    let c = catalog(&["card"]);
    let untyped = RecordSource {
        path: "draft.md",
        source: "---\nkeep: 1\n---\nbody\n",
    };
    let err = contract_write(
        &c,
        &selector(None),
        Some(untyped),
        &fields("{name: A}"),
        &[],
    )
    .unwrap_err();
    assert_eq!(err.reason.as_deref(), Some("data_contract_not_implemented"));
    let w = contract_write_promoting(
        &c,
        &selector(None),
        Some(untyped),
        &fields("{name: A}"),
        &[],
        true,
    )
    .unwrap();
    assert_eq!(w.patch, fields("{type: card, card: {label: A}}"));
    assert!(w.unset.is_empty());
    assert_eq!(
        w.base,
        vec![("card".to_string(), None), ("type".to_string(), None)]
    );
    // An already-implementing record is written as usual; another type is refused.
    let same = contract_write_promoting(
        &c,
        &selector(None),
        Some(record()),
        &fields("{name: B}"),
        &[],
        true,
    )
    .unwrap();
    assert!(!same.patch.contains_key("type"));
    let two = catalog(&["card", "note"]);
    let other = RecordSource {
        path: "n.md",
        source: "---\ntype: note\n---\n",
    };
    let err = contract_write_promoting(
        &two,
        &selector(Some("card")),
        Some(other),
        &fields("{name: A}"),
        &[],
        true,
    )
    .unwrap_err();
    assert_eq!(err.reason.as_deref(), Some("data_contract_promote_typed"));
}
