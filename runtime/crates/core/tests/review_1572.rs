//! Match provenance and context namespace regression probes.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use mdbn_core::ids::Uuid;
use mdbn_core::query::{self, Query, QueryEnv};
use mdbn_core::state::{MemState, StateView};
use mdbn_core::types::Catalog;

fn catalog(expression: &str) -> Catalog {
    let source = format!(
        "---\nkind: mdbase.type\nname: selected\nmatch:\n  expr: {expression:?}\nschema:\n  dialect: json-schema-2020-12\n  value: {{type: object}}\n---\n"
    );
    Catalog::load([("_types/selected.md", source.as_str())])
}

#[test]
fn aliased_file_time_must_invalidate_type() {
    let loaded = catalog("![file].exists(meta, has(meta.mtime))");
    assert!(
        loaded
            .membership("record.md", &Default::default())
            .types
            .is_empty(),
        "forbidden file.mtime alias participates in matching"
    );
    assert!(
        loaded.type_named("selected").is_none(),
        "accepted aliased file.mtime: {:?}",
        loaded.issues()
    );
}

#[test]
fn wrapped_file_time_must_invalidate_type() {
    let loaded = catalog("!has({'meta': file}.meta.ctime)");
    assert!(
        loaded
            .membership("record.md", &Default::default())
            .types
            .is_empty(),
        "forbidden file.ctime alias participates in matching"
    );
    assert!(
        loaded.type_named("selected").is_none(),
        "accepted wrapped file.ctime: {:?}",
        loaded.issues()
    );
}

#[test]
fn unrelated_timestamp_in_a_map_does_not_taint_date_string() {
    let expression = "[{'stamp': timestamp('2026-01-01T01:00:00Z'), 'day': '2026-01-01'}].exists(row, date(row.day) == '2026-01-01')";
    let activation = mdbn_core::cel::record_activation(
        &Default::default(),
        &Default::default(),
        mdbn_core::cel::CelValue::Null,
    );
    assert!(matches!(
        mdbn_core::cel::compile(expression)
            .unwrap()
            .evaluate(&activation)
            .unwrap(),
        mdbn_core::cel::CelValue::Bool(true)
    ));
    let loaded = catalog(expression);
    assert!(
        loaded.type_named("selected").is_some(),
        "rejected deterministic date string: {:?}",
        loaded.issues()
    );
}

#[test]
fn map_iteration_keys_are_not_timestamp_values() {
    let expression =
        "{'2026-01-01': timestamp('2026-01-01T01:00:00Z')}.exists(day, date(day) == '2026-01-01')";
    let activation = mdbn_core::cel::record_activation(
        &Default::default(),
        &Default::default(),
        mdbn_core::cel::CelValue::Null,
    );
    assert!(matches!(
        mdbn_core::cel::compile(expression)
            .unwrap()
            .evaluate(&activation)
            .unwrap(),
        mdbn_core::cel::CelValue::Bool(true)
    ));
    let loaded = catalog(expression);
    assert!(
        loaded.type_named("selected").is_some(),
        "rejected deterministic map key: {:?}",
        loaded.issues()
    );
}

fn context_query(expression: &str, extra: &str) -> query::QueryPage {
    let mut state = MemState::new();
    state.insert_record(
        Uuid([1; 16]),
        "projects/alpha.md",
        &format!("---\nlead: '[Bob](people/bob.md)'\n{extra}---\n"),
    );
    state.insert_record(
        Uuid([2; 16]),
        "projects/people/bob.md",
        "---\nname: Bob\n---\n",
    );
    state.insert_record(Uuid([3; 16]), "tasks/task.md", "---\ntitle: Task\n---\n");
    let source =
        format!("context: {{this: {{path: 'projects/alpha.md'}}}}\nwhere: {expression:?}\n");
    let query =
        Query::from_value(&mdbn_core::yaml::parse_value(&source).unwrap().unwrap()).unwrap();
    let plan = query::compile(&query, &state.catalog()).unwrap();
    query::execute(
        &plan,
        &state,
        &QueryEnv {
            now_ms: 0,
            today: "1970-01-01".into(),
            tz: "UTC".into(),
        },
    )
    .unwrap()
}

#[test]
fn context_raw_alias_preserves_link_origin() {
    let result = context_query(
        "file.inFolder('tasks') && this.raw.lead.asFile() != null && this.raw.lead.asFile().name == 'Bob'",
        "",
    );
    assert_eq!(result.ids, [Uuid([3; 16])], "{:?}", result.diagnostics);
}

#[test]
fn context_record_alias_preserves_link_origin() {
    let result = context_query(
        "file.inFolder('tasks') && this.record.lead.asFile() != null && this.record.lead.asFile().name == 'Bob'",
        "",
    );
    assert_eq!(result.ids, [Uuid([3; 16])], "{:?}", result.diagnostics);
}

#[test]
fn context_file_binding_is_reserved() {
    let result = context_query(
        "file.inFolder('tasks') && this.file.path == 'projects/alpha.md'",
        "file: not-metadata\n",
    );
    assert_eq!(result.ids, [Uuid([3; 16])], "{:?}", result.diagnostics);
}

#[test]
fn computed_path_key_is_deterministic() {
    let loaded = catalog("file['pa' + 'th'] == 'record.md'");
    assert!(
        loaded.type_named("selected").is_some(),
        "deterministic path-only match rejected: {:?}",
        loaded.issues()
    );
}

#[test]
fn file_provenance_survives_containers_comprehensions_and_conditionals() {
    for expression in [
        "![file].exists(meta, has(meta.mtime))",
        "!has({'meta': file}.meta.ctime)",
        "[file].map(meta, meta).exists(meta, has(meta.backlinks))",
        "[file, file].map(meta, meta)[1].ctime == null",
        "[file, file].filter(meta, true)[1].mtime == null",
        "[{'meta': file}].exists(row, has(row.meta.ctime))",
        "{'meta': file}.exists(key, has({'meta': file}[key].mtime))",
        "has((raw.choice ? file : {}).backlinks)",
        "has((raw.choice ? {'meta': file} : {}).meta.mtime)",
        "[[file]].exists(rows, rows.exists(meta, has(meta.ctime)))",
        "has(([{}] + [file])[1].mtime)",
        "has((([{}].filter(row, true)) + [file])[1].mtime)",
        "[file].exists(meta, [meta].exists(file, has(file.ctime)))",
        "has({'me' + 'ta': file}['meta'].ctime)",
        "has([file][raw.index].mtime)",
        "has({'meta': file}[raw.key].backlinks)",
        "file['m' + 'time'] == null",
    ] {
        let loaded = catalog(expression);
        assert!(loaded.type_named("selected").is_none(), "{expression}");
        assert!(
            loaded
                .issues()
                .iter()
                .any(|issue| issue.code == "nondeterministic_match"),
            "{expression}: {:?}",
            loaded.issues()
        );
        assert!(
            loaded
                .membership("record.md", &Default::default())
                .types
                .is_empty()
        );
    }
}

#[test]
fn timestamp_provenance_survives_unknown_sequence_positions() {
    for expression in [
        "date([1, 2].map(row, timestamp('2026-01-01T01:00:00Z'))[1]) == '2026-01-01'",
        "date([timestamp('2026-01-01T01:00:00Z'), timestamp('2026-01-01T01:00:00Z')].filter(row, true)[1]) == '2026-01-01'",
        "[{'stamp': timestamp('2026-01-01T01:00:00Z')}].exists(row, date(row.stamp) == '2026-01-01')",
        "date({'stamp': timestamp('2026-01-01T01:00:00Z')}[raw.key]) == '2026-01-01'",
    ] {
        let loaded = catalog(expression);
        assert!(loaded.type_named("selected").is_none(), "{expression}");
        assert!(
            loaded
                .issues()
                .iter()
                .any(|issue| issue.code == "nondeterministic_match"),
            "{expression}: {:?}",
            loaded.issues()
        );
    }
}

#[test]
fn repeated_aliases_share_structural_provenance() {
    let mut expression = "[file]".to_owned();
    for _ in 0..24 {
        expression.push_str(".map(meta, [meta, meta])");
    }
    let loaded = catalog(&format!("has({expression}{}.mtime)", "[0]".repeat(25)));
    assert!(loaded.type_named("selected").is_none());
    assert!(
        loaded
            .issues()
            .iter()
            .any(|issue| issue.code == "nondeterministic_match"),
        "{:?}",
        loaded.issues()
    );
}

#[test]
fn structural_selection_and_key_iteration_do_not_taint_plain_values() {
    for expression in [
        "[{'stamp': timestamp('2026-01-01T01:00:00Z'), 'day': '2026-01-01'}].map(row, row.day).exists(day, date(day) == '2026-01-01')",
        "{'2026-01-01': file}.filter(day, true).exists(day, date(day) == '2026-01-01')",
        "[{'meta': file, 'day': '2026-01-01'}].exists(row, date(row.day) == '2026-01-01')",
        "[{'mtime': true}].exists(file, has(file.mtime))",
        "[file].exists(meta, [{'mtime': true}].exists(meta, has(meta.mtime)))",
        "file['pa' + ('t' + 'h')] == 'record.md'",
    ] {
        let loaded = catalog(expression);
        assert!(loaded.is_valid(), "{expression}: {:?}", loaded.issues());
        assert_eq!(
            loaded.membership("record.md", &Default::default()).types,
            ["selected"],
            "{expression}"
        );
    }
}

#[test]
fn dynamic_file_index_diagnostic_names_the_actual_uncertainty() {
    let loaded = catalog("[file].exists(meta, meta[raw.key] != null)");
    let issue = loaded
        .issues()
        .iter()
        .find(|issue| issue.code == "nondeterministic_match")
        .unwrap();
    assert!(issue.message.contains("dynamic file access"), "{issue:?}");
    for member in ["file.mtime", "file.ctime", "file.backlinks"] {
        assert!(!issue.message.contains(member), "{issue:?}");
    }
}

#[test]
fn every_context_namespace_preserves_origin_and_reserved_names_win() {
    for namespace in ["this", "this.record", "this.raw"] {
        let expression =
            format!("file.inFolder('tasks') && {namespace}.lead.asFile().name == 'Bob'");
        let result = context_query(
            &expression,
            "record: field-record\nraw: field-raw\nfile: field-file\n",
        );
        assert_eq!(
            result.ids,
            [Uuid([3; 16])],
            "{namespace}: {:?}",
            result.diagnostics
        );
        assert!(result.diagnostics.is_empty());
    }
    for namespace in ["this.record", "this.raw"] {
        let expression = format!(
            "file.inFolder('tasks') && this.file.path == 'projects/alpha.md' && {namespace}.record == 'field-record' && {namespace}.raw == 'field-raw' && {namespace}.file == 'field-file'"
        );
        let result = context_query(
            &expression,
            "record: field-record\nraw: field-raw\nfile: field-file\n",
        );
        assert_eq!(
            result.ids,
            [Uuid([3; 16])],
            "{namespace}: {:?}",
            result.diagnostics
        );
        assert!(result.diagnostics.is_empty());
    }
}

#[test]
fn candidate_namespaces_preserve_origin_and_reserved_names_win() {
    for namespace in ["", "record.", "raw."] {
        let result = context_query(
            &format!(
                "file.path == 'projects/alpha.md' && {namespace}lead.asFile().name == 'Bob' && record.file == 'field-file' && raw.file == 'field-file' && record.raw == 'field-raw' && raw.record == 'field-record'"
            ),
            "record: field-record\nraw: field-raw\nfile: field-file\n",
        );
        assert_eq!(
            result.ids,
            [Uuid([1; 16])],
            "{namespace}: {:?}",
            result.diagnostics
        );
        assert!(result.diagnostics.is_empty());
    }
}
