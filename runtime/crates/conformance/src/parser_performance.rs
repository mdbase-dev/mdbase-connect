//! Native-only parser timing harness. Uses this crate's existing native clock
//! permissions; portable Core and integration-test lint rules remain unchanged.
use mdbn_core::{value::Value, yaml};
use std::time::Instant;

/// One native timing sample of a generated, semantically checked parser input.
pub struct Sample {
    /// Actual parsed value, retained for independent assertions by the test.
    pub value: Value,
    /// Exact UTF-8 input size.
    pub source_bytes: usize,
    /// Time spent in the actual Core parser, in nanoseconds.
    pub elapsed_ns: u128,
}
/// Parse a bounded test corpus on the patched parser. Input generation is outside
/// the measured interval; no wall-clock API is introduced into Core.
pub fn flow_list(count: usize) -> Sample {
    assert!(count <= 200_000, "bounded native parser regression corpus");
    let mut source = String::with_capacity(count * 2 + 1);
    source.push('[');
    for i in 0..count {
        if i != 0 {
            source.push(',');
        }
        source.push('1');
    }
    source.push(']');
    let start = Instant::now();
    let value = yaml::parse_value(&source).unwrap().unwrap();
    Sample {
        value,
        source_bytes: source.len(),
        elapsed_ns: start.elapsed().as_nanos(),
    }
}
