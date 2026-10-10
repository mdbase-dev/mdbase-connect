//! Actual Rust execution of Obsidian's frozen parser/compiler/Bases-oracle packet.
//! No frontend parser/evaluator lives here; expected booleans come from the
//! existing Bases package and the emitted CEL is passed unchanged to Core.
use mdbn_conformance::query_differential::{OracleOutcome, Shape, generate, oracle};
use mdbn_core::{query, query::profile, state::StateView};
use serde_json::Value;

#[test]
fn raw_bases_compiler_packet_matches_core_with_effective_read_defaults() {
    let packet: Value = serde_json::from_str(include_str!("query-compiler-probe.json")).unwrap();
    assert_eq!(packet["parser"], "obsidian-bases-expression@0.3.0-rc.4");
    assert_eq!(
        packet["readDefaults"],
        serde_json::json!({"status":"open","priority":"normal"})
    );
    let fixtures = packet["fixtures"].as_array().unwrap();
    assert_eq!(fixtures.len(), 7);
    let mut evaluated = 0;
    for fixture in fixtures {
        let rows = fixture["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 10);
        for (row_index, row) in rows.iter().enumerate() {
            let mut case = generate(0, Shape::OrderWindow, 1);
            case.resources[1].1 = case.resources[1]
                .1
                .replace("priority: 0", "priority: normal");
            case.records[0].source = format!("---\n{}\n---\nCompiler oracle note\n", row["raw"]);
            case.query_yaml = fixture["compiled"]["query"].to_string();
            let expected = row["basesExpected"].as_bool().unwrap();
            let result = oracle(&case).unwrap();
            let OracleOutcome::Success(page) = result else {
                panic!("source={} row={row_index}: {result:?}", fixture["source"]);
            };
            assert_eq!(
                page.total_count,
                u64::from(expected),
                "source={} row={row_index}",
                fixture["source"]
            );
            assert_eq!(
                page.ids,
                if expected {
                    vec![case.records[0].id]
                } else {
                    vec![]
                }
            );
            assert!(page.diagnostics.is_empty(), "{page:?}");
            let state = case.state().unwrap();
            let plan = query::compile(&case.query().unwrap(), &state.catalog()).unwrap();
            assert!(
                profile::lower(&plan, &state.catalog()).is_err(),
                "raw guards are not yet a qualified SQL shape"
            );
            evaluated += 1;
        }
    }
    assert_eq!(evaluated, 70);
    // Prove the defaulted effective context really differs from the raw context.
    let mut control = generate(0, Shape::OrderWindow, 1);
    control.resources[1].1 = control.resources[1]
        .1
        .replace("priority: 0", "priority: normal");
    control.records[0].source = "---\n{}\n---\n".into();
    control.query_yaml =
        "types: [task]\nwhere: 'status == \"open\" && priority == \"normal\"'\n".into();
    let OracleOutcome::Success(page) = oracle(&control).unwrap() else {
        panic!("effective control must execute")
    };
    assert_eq!(page.total_count, 1);
    control.query_yaml = fixtures[0]["compiled"]["query"].to_string();
    let OracleOutcome::Success(page) = oracle(&control).unwrap() else {
        panic!("raw control must execute")
    };
    assert_eq!(page.total_count, 0);
}
