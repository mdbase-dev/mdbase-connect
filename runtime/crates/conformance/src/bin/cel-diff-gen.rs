//! `cel-diff-gen [cases] [seed]`: generate random CEL expressions, evaluate
//! them with `mdbn_core::cel`, and print JSON lines `{"expr", "ours"}` for the
//! cel-go comparison in `tools/cel-diff` (see its README). Local tool only.
//!
//! The generator stays inside the semantics both engines share. Documented
//! differences are left out: `string(double)` text (spec note N34), map
//! iteration order (N33; maps are compared as sorted entries), ASCII-only regex
//! classes (texts are ASCII), the profile's own functions, and time zones.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use mdbn_core::cel::{Activation, CelValue, Key, compile};
use serde_json::{Value, json};

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn pick<'a>(&mut self, xs: &[&'a str]) -> &'a str {
        xs[self.below(xs.len() as u64) as usize]
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Ty {
    Int,
    Uint,
    Double,
    Str,
    Bool,
    List,
    Map,
    Ts,
    Dur,
}

const TYPES: [Ty; 9] = [
    Ty::Int,
    Ty::Uint,
    Ty::Double,
    Ty::Str,
    Ty::Bool,
    Ty::List,
    Ty::Map,
    Ty::Ts,
    Ty::Dur,
];

fn expr_of(ty: Ty, depth: u32, r: &mut Rng) -> String {
    let leaf = depth == 0 || r.below(3) == 0;
    match ty {
        Ty::Int => {
            if leaf {
                return r
                    .pick(&[
                        "0",
                        "1",
                        "-1",
                        "2",
                        "7",
                        "-3",
                        "42",
                        "9223372036854775807",
                        "-9223372036854775807",
                        "1000000007",
                    ])
                    .to_owned();
            }
            match r.below(8) {
                0..=2 => format!(
                    "({} {} {})",
                    expr_of(Ty::Int, depth - 1, r),
                    r.pick(&["+", "-", "*", "/", "%"]),
                    expr_of(Ty::Int, depth - 1, r)
                ),
                3 => format!(
                    "size({})",
                    expr_of(
                        *[Ty::Str, Ty::List, Ty::Map]
                            .get(r.below(3) as usize)
                            .unwrap_or(&Ty::Str),
                        depth - 1,
                        r
                    )
                ),
                4 => format!(
                    "int({})",
                    expr_of(
                        *[Ty::Uint, Ty::Double, Ty::Ts]
                            .get(r.below(3) as usize)
                            .unwrap_or(&Ty::Uint),
                        depth - 1,
                        r
                    )
                ),
                5 => format!(
                    "({} ? {} : {})",
                    expr_of(Ty::Bool, depth - 1, r),
                    expr_of(Ty::Int, depth - 1, r),
                    expr_of(Ty::Int, depth - 1, r)
                ),
                6 => format!(
                    "{}[{}]",
                    expr_of(Ty::List, depth - 1, r),
                    r.pick(&["0", "1", "2", "-1"])
                ),
                _ => format!(
                    "{}.{}()",
                    expr_of(Ty::Ts, depth - 1, r),
                    r.pick(&[
                        "getFullYear",
                        "getMonth",
                        "getDate",
                        "getDayOfWeek",
                        "getDayOfYear",
                        "getHours",
                        "getMinutes",
                        "getSeconds",
                        "getMilliseconds"
                    ])
                ),
            }
        }
        Ty::Uint => {
            if leaf {
                return r
                    .pick(&[
                        "0u",
                        "1u",
                        "2u",
                        "7u",
                        "18446744073709551615u",
                        "9223372036854775808u",
                    ])
                    .to_owned();
            }
            match r.below(3) {
                0 | 1 => format!(
                    "({} {} {})",
                    expr_of(Ty::Uint, depth - 1, r),
                    r.pick(&["+", "-", "*", "/", "%"]),
                    expr_of(Ty::Uint, depth - 1, r)
                ),
                _ => format!(
                    "uint({})",
                    expr_of(
                        *[Ty::Int, Ty::Double]
                            .get(r.below(2) as usize)
                            .unwrap_or(&Ty::Int),
                        depth - 1,
                        r
                    )
                ),
            }
        }
        Ty::Double => {
            if leaf {
                return r
                    .pick(&[
                        "0.0", "1.5", "-2.25", "0.1", "1e300", "1e-300", "3.0", "-0.0", "1e18",
                        "9.5e18",
                    ])
                    .to_owned();
            }
            match r.below(3) {
                0 | 1 => format!(
                    "({} {} {})",
                    expr_of(Ty::Double, depth - 1, r),
                    r.pick(&["+", "-", "*", "/"]),
                    expr_of(Ty::Double, depth - 1, r)
                ),
                _ => format!(
                    "double({})",
                    expr_of(
                        *[Ty::Int, Ty::Uint]
                            .get(r.below(2) as usize)
                            .unwrap_or(&Ty::Int),
                        depth - 1,
                        r
                    )
                ),
            }
        }
        Ty::Str => {
            if leaf {
                return r
                    .pick(&[
                        "''",
                        "'a'",
                        "'abc'",
                        "'Hello'",
                        "\"x y\"",
                        "'caf\\u00e9'",
                        "r'\\d'",
                        "'''tri'''",
                        "'42'",
                        "'-7'",
                        "'1.5'",
                        "'true'",
                    ])
                    .to_owned();
            }
            match r.below(3) {
                0 | 1 => format!(
                    "({} + {})",
                    expr_of(Ty::Str, depth - 1, r),
                    expr_of(Ty::Str, depth - 1, r)
                ),
                _ => format!(
                    "string({})",
                    expr_of(
                        *[Ty::Int, Ty::Uint, Ty::Bool, Ty::Ts, Ty::Dur]
                            .get(r.below(5) as usize)
                            .unwrap_or(&Ty::Int),
                        depth - 1,
                        r
                    )
                ),
            }
        }
        Ty::Bool => {
            if leaf {
                return r.pick(&["true", "false"]).to_owned();
            }
            match r.below(10) {
                0 => {
                    let a = *TYPES.get(r.below(5) as usize).unwrap_or(&Ty::Int);
                    let b = if matches!(a, Ty::Int | Ty::Uint | Ty::Double) {
                        *[Ty::Int, Ty::Uint, Ty::Double]
                            .get(r.below(3) as usize)
                            .unwrap_or(&Ty::Int)
                    } else {
                        a
                    };
                    format!(
                        "({} {} {})",
                        expr_of(a, depth - 1, r),
                        r.pick(&["==", "!=", "<", "<=", ">", ">="]),
                        expr_of(b, depth - 1, r)
                    )
                }
                1 => format!(
                    "({} {} {})",
                    expr_of(Ty::Bool, depth - 1, r),
                    r.pick(&["&&", "||"]),
                    expr_of(Ty::Bool, depth - 1, r)
                ),
                2 => format!("!{}", expr_of(Ty::Bool, depth - 1, r)),
                3 => format!(
                    "({} in {})",
                    expr_of(Ty::Int, depth - 1, r),
                    expr_of(Ty::List, depth - 1, r)
                ),
                4 => format!(
                    "{}.{}({})",
                    expr_of(Ty::Str, depth - 1, r),
                    r.pick(&["contains", "startsWith", "endsWith"]),
                    expr_of(Ty::Str, depth - 1, r)
                ),
                5 => format!(
                    "{}.matches('{}')",
                    expr_of(Ty::Str, depth - 1, r),
                    r.pick(&[
                        "^a",
                        "b",
                        "^$",
                        "[a-c]+",
                        "\\\\d",
                        "^[0-9]+$",
                        "(?i)hello",
                        "x|y",
                        "a{2}",
                        "\\\\bHe"
                    ])
                ),
                6 => format!(
                    "{}.{}(v, v {} {})",
                    expr_of(Ty::List, depth - 1, r),
                    r.pick(&["all", "exists", "exists_one"]),
                    r.pick(&[">", "<", "==", "!="]),
                    expr_of(Ty::Int, 0, r)
                ),
                7 => format!(
                    "has({}.{})",
                    expr_of(Ty::Map, depth - 1, r),
                    r.pick(&["a", "b", "z"])
                ),
                8 => format!(
                    "{}.{}",
                    r.pick(&[
                        "optional.of(1)",
                        "optional.none()",
                        "[1, 2][?1]",
                        "[1][?3]",
                        "{'a': 1}.?a",
                        "{'a': 1}.?z"
                    ]),
                    r.pick(&["hasValue()", "orValue(0) == 1"])
                ),
                _ => format!(
                    "({} {} {})",
                    expr_of(Ty::Dur, depth - 1, r),
                    r.pick(&["<", "==", ">="]),
                    expr_of(Ty::Dur, depth - 1, r)
                ),
            }
        }
        Ty::List => {
            if leaf {
                return r
                    .pick(&["[]", "[1, 2, 3]", "[0, -1]", "[7]", "[1, 2.0, 3u]"])
                    .to_owned();
            }
            match r.below(4) {
                0 => format!(
                    "[{}, {}]",
                    expr_of(Ty::Int, depth - 1, r),
                    expr_of(Ty::Int, depth - 1, r)
                ),
                1 => format!(
                    "({} + {})",
                    expr_of(Ty::List, depth - 1, r),
                    expr_of(Ty::List, depth - 1, r)
                ),
                2 => format!(
                    "{}.map(v, v {} {})",
                    expr_of(Ty::List, depth - 1, r),
                    r.pick(&["+", "*", "-"]),
                    expr_of(Ty::Int, 0, r)
                ),
                _ => format!(
                    "{}.filter(v, v {} {})",
                    expr_of(Ty::List, depth - 1, r),
                    r.pick(&[">", "<", "!="]),
                    expr_of(Ty::Int, 0, r)
                ),
            }
        }
        Ty::Map => {
            if leaf {
                return r
                    .pick(&[
                        "{}",
                        "{'a': 1}",
                        "{'a': 1, 'b': 'x'}",
                        "{1: true, 2u: false}",
                    ])
                    .to_owned();
            }
            format!(
                "{{'{}': {}, '{}': {}}}",
                r.pick(&["a", "b"]),
                expr_of(Ty::Int, depth - 1, r),
                r.pick(&["c", "z"]),
                expr_of(Ty::Str, depth - 1, r)
            )
        }
        Ty::Ts => {
            if leaf {
                return format!(
                    "timestamp('{}')",
                    r.pick(&[
                        "2026-06-20T00:00:00Z",
                        "1970-01-01T00:00:00Z",
                        "2024-02-29T23:59:59.5Z",
                        "2026-10-02T09:00:00Z",
                        "1999-12-31T23:59:59.125Z",
                        "2050-01-01T12:00:00Z"
                    ])
                );
            }
            format!(
                "({} {} {})",
                expr_of(Ty::Ts, depth - 1, r),
                r.pick(&["+", "-"]),
                expr_of(Ty::Dur, depth - 1, r)
            )
        }
        Ty::Dur => {
            if leaf {
                return format!(
                    "duration('{}')",
                    r.pick(&["0s", "1h", "-1h30m", "1.5s", "36h", "1ms", "90m", "100000h"])
                );
            }
            match r.below(3) {
                0 => format!(
                    "({} {} {})",
                    expr_of(Ty::Dur, depth - 1, r),
                    r.pick(&["+", "-"]),
                    expr_of(Ty::Dur, depth - 1, r)
                ),
                1 => format!(
                    "({} - {})",
                    expr_of(Ty::Ts, depth - 1, r),
                    expr_of(Ty::Ts, depth - 1, r)
                ),
                _ => format!("-{}", expr_of(Ty::Dur, depth - 1, r)),
            }
        }
    }
}

/// The encoding `tools/cel-diff` uses for cel-go values.
fn encode(v: &CelValue) -> Value {
    match v {
        CelValue::Null => json!({"null": true}),
        CelValue::Bool(b) => json!({"bool": b}),
        CelValue::Int(i) => json!({"int": i.to_string()}),
        CelValue::Uint(u) => json!({"uint": u.to_string()}),
        CelValue::Double(f) => {
            if f.is_nan() {
                json!({"double": "NaN"})
            } else if f.is_infinite() {
                json!({"double": if *f > 0.0 { "+Inf" } else { "-Inf" }})
            } else {
                json!({"double": format!("{:x}", f.to_bits())})
            }
        }
        CelValue::String(s) => json!({"string": &**s}),
        CelValue::Bytes(b) => {
            json!({"bytes": b.iter().map(|x| format!("{x:02x}")).collect::<String>()})
        }
        CelValue::Timestamp(t) => json!({"timestamp": go_rfc3339(t.to_rfc3339())}),
        CelValue::Duration(d) => json!({"duration": d.nanos.to_string()}),
        CelValue::Optional(o) => json!({"optional": o.as_ref().map(|v| encode(v))}),
        CelValue::List(l) => json!({"list": l.iter().map(encode).collect::<Vec<_>>()}),
        CelValue::Map(m) => {
            let mut entries: Vec<(String, Value)> = m
                .iter()
                .map(|(k, v)| {
                    let kv = match k {
                        Key::Bool(b) => CelValue::Bool(*b),
                        Key::Int(i) => CelValue::Int(*i),
                        Key::Uint(u) => CelValue::Uint(*u),
                        Key::String(s) => CelValue::String(s.clone()),
                    };
                    (encode(&kv).to_string(), encode(v))
                })
                .collect();
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            json!({"map": entries.into_iter().map(|(k, v)| json!([serde_json::from_str::<Value>(&k).unwrap_or(Value::Null), v])).collect::<Vec<_>>()})
        }
    }
}

/// Go's `time.RFC3339Nano` trims trailing zeros of the fraction.
fn go_rfc3339(s: String) -> String {
    match s.split_once('.') {
        Some((head, frac)) => {
            let digits = frac.trim_end_matches('Z').trim_end_matches('0');
            if digits.is_empty() {
                format!("{head}Z")
            } else {
                format!("{head}.{digits}Z")
            }
        }
        None => s,
    }
}

fn main() {
    let mut args = std::env::args().skip(1);
    let n: u64 = args.next().and_then(|a| a.parse().ok()).unwrap_or(10_000);
    let seed: u64 = args.next().and_then(|a| a.parse().ok()).unwrap_or(1);
    let mut r = Rng(seed);
    let act = Activation::new();
    for _ in 0..n {
        let ty = TYPES[r.below(TYPES.len() as u64) as usize];
        let expr = expr_of(ty, 3, &mut r);
        let ours = match compile(&expr) {
            Err(_) => json!({"compile": true}),
            Ok(p) => match p.evaluate(&act) {
                Ok(v) => encode(&v),
                Err(_) => json!({"error": true}),
            },
        };
        println!("{}", json!({"expr": expr, "ours": ours}));
    }
}
