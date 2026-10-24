//! The replica supplies actual document/membership, not cached metadata claims.
use mdbn_core::query::FieldRef;
use mdbn_core::query::indexed::{IndexKeyError, SortAtom, TemporalHint};
use mdbn_core::types::Catalog;
use mdbn_core::value::Value;
use mdbn_replica::plan::{
    MAX_DECLARED_QUERY_FIELDS, QueryProjectionContext, declared_query_index_fields,
    project_record_index_fields, project_record_query_index_row, query_index_fields,
    query_index_generation,
};
use mdbn_replica::store::{RecordMeta, RecordRow};
use mdbn_wire::common::B16;

const TASK: &str = r#"---
kind: mdbase.type
name: task
match: {path_glob: 'tasks/*.md'}
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    properties:
      at: {type: string, format: date-time}
collection:
  read_defaults:
    priority: 4
---
"#;
const OTHER: &str = "---\nkind: mdbase.type\nname: other\nmatch: {path_glob: 'other/*.md'}\nschema:\n  dialect: json-schema-2020-12\n  value: {type: object}\n---\n";
fn catalog(task: &str) -> Catalog {
    let c = Catalog::load([
        ("mdbase.yaml", "spec_version: \"0.3.0\"\n"),
        ("_types/task.md", task),
        ("_types/other.md", OTHER),
    ]);
    assert!(c.is_valid(), "{:?}", c.issues());
    c
}
fn row(path: &str, doc: &str) -> RecordRow {
    RecordRow {
        id: B16([1; 16]),
        path: path.into(),
        path_key: mdbn_core::paths::path_key(path),
        doc: doc.into(),
        revision: mdbn_wire::hash::sha256(doc.as_bytes()),
        modified_seq: 1,
        bucket: 0,
        // Deliberately stale/wrong claims must not control projection.
        meta: RecordMeta {
            types: vec!["other".into()],
            effective: mdbn_wire::common::DataMap(vec![(
                "priority".into(),
                mdbn_wire::common::Value::Int(999),
            )]),
            ..RecordMeta::default()
        },
    }
}
fn field(name: &str) -> FieldRef {
    FieldRef::Effective(vec![name.into()])
}
fn atom(value: &Value, hint: TemporalHint) -> SortAtom {
    SortAtom::from_value(Some(value), hint, 256).unwrap()
}

#[test]
fn index_projection_uses_actual_document_current_membership_and_read_defaults() {
    let c = catalog(TASK);
    let r = row("tasks/a.md", "---\nat: '2026-01-01T00:00:00Z'\n---\nbody\n");
    let projected =
        project_record_index_fields(&c, &r, &[field("priority"), field("at")], 256).unwrap();
    assert_eq!(projected[0].1, atom(&Value::Int(4), TemporalHint::None));
    assert_eq!(projected[1].0.temporal, TemporalHint::DateTime);
    assert_eq!(
        projected[1].1,
        atom(
            &Value::string("2026-01-01T00:00:00Z"),
            TemporalHint::DateTime
        )
    );
    // A resource/default change takes effect even if row metadata did not change.
    let changed = catalog(&TASK.replace("priority: 4", "priority: 8"));
    assert_eq!(
        project_record_index_fields(&changed, &r, &[field("priority")], 256).unwrap()[0].1,
        atom(&Value::Int(8), TemporalHint::None)
    );
}

#[test]
fn index_projection_preserves_nulls_and_does_not_infer_temporal_strings() {
    let c = catalog(TASK);
    let r = row("tasks/a.md", "---\npriority: null\n---\n");
    let projected =
        project_record_index_fields(&c, &r, &[field("priority"), field("missing")], 256).unwrap();
    assert_eq!(projected[0].1, atom(&Value::Null, TemporalHint::None));
    assert_eq!(projected[1].1, atom(&Value::Null, TemporalHint::None));
    let r = row("other/a.md", "---\nat: '2026-01-01T00:00:00Z'\n---\n");
    let projected = project_record_index_fields(&c, &r, &[field("at")], 256).unwrap();
    assert_eq!(projected[0].0.temporal, TemporalHint::None);
    assert_eq!(
        projected[0].1,
        atom(&Value::string("2026-01-01T00:00:00Z"), TemporalHint::None)
    );
}

#[test]
fn index_projection_resolves_hints_across_all_actual_matched_types() {
    let conflicting = TASK
        .replace("name: task", "name: another")
        .replace("format: date-time", "format: date");
    let c = Catalog::load([
        ("mdbase.yaml", "spec_version: \"0.3.0\"\n"),
        ("_types/task.md", TASK),
        ("_types/another.md", conflicting.as_str()),
    ]);
    assert!(c.is_valid(), "{:?}", c.issues());
    let r = row("tasks/a.md", "---\nat: '2026-01-01T00:00:00Z'\n---\n");
    let projected = project_record_index_fields(&c, &r, &[field("at")], 256).unwrap();
    assert_eq!(projected[0].0.temporal, TemporalHint::None);
    assert_eq!(
        projected[0].1,
        atom(&Value::string("2026-01-01T00:00:00Z"), TemporalHint::None)
    );
}

#[test]
fn neutral_index_row_contains_actual_path_types_and_all_declared_fields() {
    let c = catalog(TASK);
    let r = row("tasks/a.md", "---\nat: '2026-01-01T00:00:00Z'\n---\n");
    let fields = [field("priority"), field("at"), field("missing")];
    let projected = project_record_query_index_row(&c, &r, &fields, 256).unwrap();
    assert_eq!(projected.id, r.id);
    assert_eq!(projected.path, r.path);
    assert_eq!(projected.types, ["task"]);
    assert_eq!(projected.fields.len(), fields.len());
    assert_eq!(
        projected
            .fields
            .iter()
            .map(|v| v.field.clone())
            .collect::<Vec<_>>(),
        query_index_fields(&fields, 256).unwrap()
    );
    assert_eq!(projected.fields[0].atom.kind, 2);
    assert_eq!(
        projected.fields[1].temporal_hint,
        TemporalHint::DateTime as u8
    );
    assert_eq!(projected.fields[2].atom.kind, 255);
    assert!(project_record_query_index_row(&c, &r, &[field("at"), field("at")], 256).is_err());
}

#[test]
fn index_generation_binds_catalog_sem_and_declared_specs_not_resource_iteration() {
    let resources = vec![
        ("mdbase.yaml".into(), "spec_version: \"0.3.0\"\n".into()),
        ("_types/task.md".into(), TASK.into()),
    ];
    let sem = mdbn_wire::common::Version { major: 1, minor: 1 };
    let fields = [field("priority"), field("at")];
    let generation = query_index_generation(&resources, sem, &fields, 256).unwrap();
    let mut changed = resources.clone();
    changed.reverse();
    assert_eq!(
        query_index_generation(&changed, sem, &fields, 256),
        Ok(generation)
    );
    changed[0].1 = TASK.replace("priority: 4", "priority: 8");
    assert_ne!(
        query_index_generation(&changed, sem, &fields, 256).unwrap(),
        generation
    );
    assert_ne!(
        query_index_generation(
            &resources,
            mdbn_wire::common::Version { major: 1, minor: 2 },
            &fields,
            256
        )
        .unwrap(),
        generation
    );
    assert_ne!(
        query_index_generation(&resources, sem, &[field("at")], 256).unwrap(),
        generation
    );
    assert_ne!(
        query_index_generation(&resources, sem, &[field("at"), field("priority")], 256).unwrap(),
        generation
    );
    changed = resources.clone();
    changed.push(resources[0].clone());
    assert_eq!(
        query_index_generation(&changed, sem, &fields, 256),
        Err(IndexKeyError::Invalid)
    );
    assert_eq!(
        query_index_generation(&resources, sem, &[field("at"), field("at")], 256),
        Err(IndexKeyError::Invalid)
    );
}

#[test]
fn captured_projection_binds_compiled_catalog_fields_and_generation_once() {
    let mut resources = vec![
        ("mdbase.yaml".into(), "spec_version: \"0.3.0\"\n".into()),
        ("_types/task.md".into(), TASK.into()),
        ("_types/other.md".into(), OTHER.into()),
    ];
    let sem = mdbn_wire::common::Version { major: 1, minor: 1 };
    let mut fields = vec![field("priority"), field("at")];
    let captured = QueryProjectionContext::capture(&resources, sem, &fields, 256).unwrap();
    let r = row("tasks/a.md", "---\nat: '2026-01-01T00:00:00Z'\n---\n");
    assert_eq!(
        captured.generation(),
        query_index_generation(&resources, sem, &fields, 256).unwrap()
    );
    assert_eq!(captured.fields(), query_index_fields(&fields, 256).unwrap());
    assert_eq!(
        captured.project_row(&r).unwrap(),
        project_record_query_index_row(captured.catalog(), &r, &fields, 256).unwrap()
    );
    resources.reverse();
    assert_eq!(
        QueryProjectionContext::capture(&resources, sem, &fields, 256)
            .unwrap()
            .project_row(&r),
        captured.project_row(&r)
    );
    // Mutating caller-owned resources/specs cannot rewrite captured semantics.
    resources[1].1 = TASK.replace("priority: 4", "priority: 8");
    let changed = QueryProjectionContext::capture(&resources, sem, &fields, 256).unwrap();
    assert_ne!(changed.generation(), captured.generation());
    assert_ne!(
        changed.project_row(&r).unwrap().fields[0].atom,
        captured.project_row(&r).unwrap().fields[0].atom
    );
    fields.clear();
    assert_eq!(captured.fields().len(), 2);
    assert_eq!(captured.project_row(&r).unwrap().fields.len(), 2);
    // An ordinary changed record uses the SAME generation, not a new catalog.
    let generation = captured.generation();
    let mut edited = row("tasks/a.md", "---\npriority: 9\n---\n");
    edited.modified_seq = 999;
    assert_ne!(
        captured.project_row(&edited).unwrap().fields[0].atom,
        captured.project_row(&r).unwrap().fields[0].atom
    );
    assert_eq!(captured.generation(), generation);
}

#[test]
fn captured_projection_rejects_invalid_catalog_specs_and_oversized_atoms() {
    let sem = mdbn_wire::common::Version { major: 1, minor: 1 };
    let resources = vec![("mdbase.yaml".into(), "spec_version: \"0.3.0\"\n".into())];
    let invalid = vec![("mdbase.yaml".into(), "[".into())];
    assert!(matches!(
        QueryProjectionContext::capture(&invalid, sem, &[], 256),
        Err(IndexKeyError::Invalid)
    ));
    let duplicate = vec![resources[0].clone(), resources[0].clone()];
    assert!(matches!(
        QueryProjectionContext::capture(&duplicate, sem, &[], 256),
        Err(IndexKeyError::Invalid)
    ));
    for fields in [
        vec![field("at"), field("at")],
        vec![FieldRef::Persisted(vec!["at".into()])],
        vec![FieldRef::Effective(vec!["nested".into(), "at".into()])],
    ] {
        assert!(matches!(
            QueryProjectionContext::capture(&resources, sem, &fields, 256),
            Err(IndexKeyError::Invalid)
        ));
    }
    assert!(matches!(
        QueryProjectionContext::capture(&resources, sem, &[field("title")], 8),
        Err(IndexKeyError::TooWide)
    ));
    let captured = QueryProjectionContext::capture(&resources, sem, &[field("title")], 16).unwrap();
    let r = row(
        "tasks/a.md",
        "---\ntitle: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n---\n",
    );
    assert_eq!(captured.project_row(&r), Err(IndexKeyError::TooWide));
}

#[test]
fn declared_profile_is_bounded_explicit_subset_in_neutral_field_order() {
    let sem = mdbn_wire::common::Version { major: 1, minor: 1 };
    let mut ty = "---\nkind: mdbase.type\nname: many\nschema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\n    properties:\n".to_string();
    for n in 0..20 {
        ty.push_str(&format!("      a{n:02}: {{type: number}}\n"));
    }
    ty.push_str("---\n");
    let resources = vec![("_types/many.md".into(), ty)];
    let preferred = vec![field("priority"), field("points")];
    let ctx =
        QueryProjectionContext::capture_declared(&resources, sem, &preferred, usize::MAX, 256)
            .unwrap();
    assert_eq!(ctx.fields().len(), MAX_DECLARED_QUERY_FIELDS);
    assert!(ctx.fields().windows(2).all(|pair| pair[0] < pair[1]));
    for expected in &preferred {
        assert!(ctx.field_refs().contains(expected));
    }
    assert!(
        !ctx.field_refs().contains(&field("a19")),
        "omitted field is explicitly unsupported"
    );
    assert_eq!(
        ctx.fields(),
        query_index_fields(ctx.field_refs(), 256).unwrap()
    );
    let projection = ctx
        .project_row(&row("untyped/a.md", "---\npriority: 9\n---\n"))
        .unwrap();
    assert!(
        projection
            .fields
            .iter()
            .zip(ctx.fields())
            .all(|(value, declaration)| &value.field == declaration)
    );
    let same = QueryProjectionContext::capture_declared(
        &resources,
        sem,
        &[field("points"), field("priority")],
        16,
        256,
    )
    .unwrap();
    assert_eq!(ctx.generation(), same.generation());
    assert_eq!(ctx.field_refs(), same.field_refs());
    assert_eq!(
        declared_query_index_fields(ctx.catalog(), &[], 0, 256).unwrap(),
        vec![]
    );
    assert!(matches!(
        declared_query_index_fields(ctx.catalog(), &preferred, 1, 256),
        Err(IndexKeyError::TooWide)
    ));
    assert!(matches!(
        declared_query_index_fields(
            ctx.catalog(),
            &[field("priority"), field("priority")],
            16,
            256
        ),
        Err(IndexKeyError::Invalid)
    ));
}

#[test]
fn declared_profile_uses_compiled_ref_allof_properties_and_exact_top_level_names() {
    let resources = vec![("_types/ref.md".into(), "---\nkind: mdbase.type\nname: ref\nschema:\n  dialect: json-schema-2020-12\n  value:\n    $defs:\n      common:\n        type: object\n        properties:\n          inherited: {type: number}\n    allOf:\n      - {$ref: '#/$defs/common'}\n      - type: object\n        properties:\n          'a.b': {type: string}\n---\n".into())];
    let ctx = QueryProjectionContext::capture_declared(
        &resources,
        mdbn_wire::common::Version { major: 1, minor: 1 },
        &[],
        16,
        256,
    )
    .unwrap();
    assert_eq!(ctx.fields().len(), 2);
    assert!(ctx.field_refs().contains(&field("inherited")));
    assert!(ctx.field_refs().contains(&field("a.b")));
    assert!(
        !ctx.field_refs()
            .contains(&FieldRef::Effective(vec!["a".into(), "b".into()]))
    );
}

#[test]
fn empty_generation_frame_binds_key_codec_and_projection_algorithm_versions() {
    // Independent frame oracle: version 1 of both codecs, SEM 1.1, no resources
    // or declared fields. This is a SHA frame test, not an authorization witness.
    let mut frame = b"mdbase/v1/query-index-generation\0".to_vec();
    frame.push(1);
    for word in [1u64, 1, 1, 0, 0] {
        frame.extend_from_slice(&word.to_be_bytes());
    }
    assert_eq!(
        query_index_generation(
            &[],
            mdbn_wire::common::Version { major: 1, minor: 1 },
            &[],
            256
        )
        .unwrap(),
        mdbn_wire::hash::sha256(&frame).0
    );
}

#[test]
fn index_projection_rejects_unsupported_fields_and_oversized_atoms() {
    let c = catalog(TASK);
    let r = row(
        "tasks/a.md",
        "---\ntitle: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'\n---\n",
    );
    for field in [
        FieldRef::Persisted(vec!["title".into()]),
        FieldRef::Effective(vec!["nested".into(), "title".into()]),
    ] {
        assert_eq!(
            project_record_index_fields(&c, &r, &[field], 256),
            Err(IndexKeyError::Invalid)
        );
    }
    assert!(project_record_index_fields(&c, &r, &[field("title")], 8).is_err());
}
