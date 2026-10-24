//! Any expression: compiling and evaluating never panics and is deterministic.
#![no_main]

use libfuzzer_sys::fuzz_target;
use mdbn_core::cel::{CelValue, compile, record_activation};
use mdbn_core::value::{Map, Value};

fuzz_target!(|data: &[u8]| {
    let Ok(src) = std::str::from_utf8(data) else { return };
    let Ok(p) = compile(src) else { return };
    let mut m = Map::new();
    m.insert("s", Value::string("abc"));
    m.insert("n", Value::int(3));
    m.insert("l", Value::List(vec![Value::int(1), Value::string("x")]));
    let act = record_activation(&m, &m, CelValue::Null);
    let a = p.evaluate(&act).map(|v| format!("{v:?}")).map_err(|e| e.message);
    let b = p.evaluate(&act).map(|v| format!("{v:?}")).map_err(|e| e.message);
    assert_eq!(a, b);
});
