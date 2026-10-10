//! Native timing guard. Deterministic Core tests independently bound line-search
//! work; clock use lives in the existing native conformance library.
use mdbn_conformance::parser_performance;
use mdbn_core::value::Value;

#[test]
fn large_flow_list_parses_within_native_regression_budget() {
    let count = 200_000;
    let sample = parser_performance::flow_list(count);
    eprintln!(
        "patched flow parser: {count} values, {} source bytes, {}ns",
        sample.source_bytes, sample.elapsed_ns
    );
    let Value::List(values) = sample.value else {
        panic!("expected list")
    };
    assert_eq!(values.len(), count);
    assert_eq!(values.first(), Some(&Value::Int(1)));
    assert_eq!(values.last(), Some(&Value::Int(1)));
    // Generous under shared debug CI; Core work tests independently establish
    // the algorithmic bound without depending on host timing noise.
    assert!(
        sample.elapsed_ns < 10_000_000_000,
        "{count} values: {}ns",
        sample.elapsed_ns
    );
}
