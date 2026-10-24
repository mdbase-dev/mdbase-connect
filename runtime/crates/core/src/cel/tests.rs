//! CEL engine tests (semantics from the CEL specification and spec 10).

use super::*;
use crate::value::Value;

fn run(src: &str) -> Result<CelValue, EvalError> {
    let p = compile(src).unwrap_or_else(|e| panic!("{src}: {e}"));
    let mut act = Activation::new();
    let mut m = Map::new();
    m.insert("title", Value::string("Café"));
    m.insert(
        "tags",
        Value::List(vec![Value::string("a"), Value::string("b")]),
    );
    m.insert("n", Value::int(3));
    m.insert("x", Value::Float(2.5));
    m.insert("nil", Value::Null);
    act.bind("r", CelValue::from_value(&Value::Map(m)));
    act.bind("i", CelValue::Int(7));
    p.evaluate(&act)
}

fn t(src: &str) {
    match run(src) {
        Ok(CelValue::Bool(true)) => {}
        other => panic!("{src} => {other:?}"),
    }
}

fn e(src: &str) {
    assert!(
        run(src).is_err(),
        "{src} should be an evaluation error: {:?}",
        run(src)
    );
}

fn c(src: &str) {
    assert!(compile(src).is_err(), "{src} should not compile");
}

#[test]
fn literals_and_arithmetic() {
    t("1 + 2 * 3 == 7");
    t("(1 + 2) * 3 == 9");
    t("7 / 2 == 3 && -7 / 2 == -3 && 7 % 3 == 1 && -7 % 3 == -1");
    t("1u + 2u == 3u");
    t("1.5 + 1.5 == 3.0");
    t("0x10 == 16 && 0x10u == 16u");
    t("1e3 == 1000.0 && .5 == 0.5");
    t("-9223372036854775808 < 0");
    t("'a' + \"b\" == 'ab' && '''x''' == 'x' && r'\\d' == '\\\\d'");
    t("b'ab' + b'c' == b'abc'");
    t("'\\u00e9' == 'é' && '\\x41' == 'A' && '\\101' == 'A'");
    t("[1, 2] + [3] == [1, 2, 3]");
    t("{'a': 1, 'b': 2}['b'] == 2");
    t("true ? 1 == 1 : false");
    e("9223372036854775807 + 1");
    e("1 / 0");
    e("1 % 0");
    e("1 + 1.0");
    e("-(-9223372036854775808)");
    c("9223372036854775808");
}

#[test]
fn heterogeneous_numbers() {
    t("1 == 1.0 && 1u == 1 && 1 < 1.5 && 2u > 1 && -1 < 0u");
    t("[1, 2] == [1.0, 2u]");
    t("1 in [1.0]");
    t("!(1 == '1')");
    t("double('nan') != double('nan')");
    t("!(double('nan') < 1.0)");
}

/// Fixed by the cel-go differential (`tools/cel-diff`).
#[test]
fn agrees_with_cel_go() {
    t("string(18446744073709551615u) == '18446744073709551615'");
    t("--1 == 1 && !!true && ---1 == -1 && !!!false");
    t("--'a' == 'a'");
    e("uint(-0.1)");
    t("uint(-0.0) == 0u && uint(0.9) == 0u");
    e("int(-9223372036854775808.0)");
    t("int(-9223372036854774784.0) == -9223372036854774784");
    // On the number line 2^64 is not 2^64 - 1 (cel-go converts lossily here).
    t("double(18446744073709551615u) != 18446744073709551615u");
    c("!-1");
}

#[test]
fn strings() {
    t("size('café') == 4");
    t("'Éclair Body'.lower() == 'éclair body'");
    t("'Straße'.upper() == 'STRASSE'");
    t("'hello'.contains('ell') && 'hello'.startsWith('he') && 'hello'.endsWith('lo')");
    t("'é'.matches('^.$') && !'é'.matches('^\\\\w$') && matches('ab', 'b')");
    t("'caf'.matches('caf\\\\b')");
    t("string(1) == '1' && string(1.5) == '1.5' && string(true) == 'true'");
    t(
        "int('42') == 42 && double('2.5') == 2.5 && uint(3) == 3u && int(2.9) == 2 && int(-2.9) == -2",
    );
    e("int(1e100)");
    e("uint(-1)");
}

#[test]
fn maps_lists_and_presence() {
    t("r.title == 'Café'");
    t("has(r.title) && !has(r.missing) && has(r.nil)");
    t("r.nil == null");
    e("r.missing");
    e("r.nil.x");
    t("'title' in r && !('missing' in r)");
    t("size(r.tags) == 2 && r.tags[1] == 'b' && r.tags[1u] == 'b'");
    e("r.tags[5]");
    t("r.?missing.orValue('d') == 'd' && r.?title.orValue('d') == 'Café'");
    t("!r.?missing.hasValue() && r.?title.hasValue()");
    t("r.?nil.hasValue()");
    t("r.?missing.?deeper.orValue(1) == 1");
    t("r.tags[?5].orValue('z') == 'z' && r.tags[?0].value() == 'a'");
    t("optional.of(1).value() == 1 && !optional.none().hasValue()");
    t("optional.none().or(optional.of(2)).value() == 2");
    e("optional.none().value()");
    e("{'a': 1, 'a': 2}");
}

#[test]
fn macros() {
    t("[1, 2, 3].all(v, v > 0)");
    t("[1, 2, 3].exists(v, v == 2)");
    t("[1, 2, 3].exists_one(v, v > 2)");
    t("[1, 2, 3].map(v, v * 2) == [2, 4, 6]");
    t("[1, 2, 3].map(v, v > 1, v * 10) == [20, 30]");
    t("[1, 2, 3].filter(v, v % 2 == 1) == [1, 3]");
    t("{'a': 1, 'b': 2}.all(k, k in ['a', 'b'])");
    t("r.tags.exists(t, t == 'a')");
    t("[[1], [2, 3]].map(l, l.map(v, v + i)) == [[8], [9, 10]]");
    // Errors are absorbed by a decisive result.
    t("[1, 0].exists(v, 1 / v == 1)");
    t("![0, 1].all(v, 1 / v == 1 && v == 5)");
    e("[0].all(v, 1 / v == 1)");
}

#[test]
fn logic_absorbs_errors_commutatively() {
    t("(false && 1 / 0 == 1) == false");
    t("(1 / 0 == 1 && false) == false");
    t("true || 1 / 0 == 1");
    t("1 / 0 == 1 || true");
    e("true && 1 / 0 == 1");
    e("1 / 0 == 1 || false");
    e("1 && true");
}

#[test]
fn compile_errors() {
    c("1 +");
    c("a.(b)");
    c("'unterminated");
    c("'a' .matches('\\\\p{L}')");
    c("matches('a', '(a)\\\\1')");
    c("unknownFunction(1)");
    c("noSuchFunction() < timestamp('2026-01-01T00:00:00Z')");
    c("has(a)");
    c("x.all(1, true)");
    c("if");
    c(&"(".repeat(200));
    c(&format!("{}1{}", "[".repeat(150), "]".repeat(150)));
    c(&"a".repeat(MAX_SOURCE + 1));
    // A dynamic pattern is checked when it is evaluated.
    let p = compile("'a'.matches(i == 7 ? '\\\\p{L}' : 'a')").unwrap();
    let mut act = Activation::new();
    act.bind("i", CelValue::Int(7));
    assert!(p.evaluate(&act).is_err());
}

#[test]
fn deep_but_valid_chains_compile() {
    let chain = vec!["true"; 90].join(" && ");
    assert!(compile(&chain).is_ok());
}

#[test]
fn evaluation_is_bounded() {
    // 1000^3 iterations would run for a long time; the step limit stops it.
    let src = "[0,1,2,3,4,5,6,7,8,9].map(a, [0,1,2,3,4,5,6,7,8,9].map(b, [0,1,2,3,4,5,6,7,8,9].map(c, [0,1,2,3,4,5,6,7,8,9].map(d, [0,1,2,3,4,5,6,7,8,9].map(f, [0,1,2,3,4,5,6,7,8,9].map(g, a + b + c + d + f + g))))))";
    let r = compile(src).unwrap().evaluate(&Activation::new());
    assert!(r.is_err());
}

#[test]
fn record_context() {
    let mut raw = Map::new();
    raw.insert("status", Value::string("open"));
    raw.insert("record", Value::string("shadowed"));
    let act = record_activation(&raw, &raw, CelValue::Null);
    let p = compile(
        "status == 'open' && missing == null && record.record == 'shadowed' && !has(raw.missing)",
    )
    .unwrap();
    assert!(matches!(p.evaluate(&act), Ok(CelValue::Bool(true))));
}
