//! Parser and emitter tests.

use super::*;
use crate::value::Value;

fn v(src: &str) -> Value {
    match parse_value(src) {
        Ok(Some(v)) => v,
        Ok(None) => Value::Null,
        Err(e) => panic!("{src:?}: {e}"),
    }
}

fn json(src: &str) -> String {
    v(src).to_json()
}

fn err(src: &str) -> ErrorKind {
    match parse_value(src) {
        Err(e) => e.kind,
        Ok(v) => panic!("{src:?} parsed as {v:?}"),
    }
}

#[test]
fn block_mappings_and_sequences() {
    assert_eq!(json("a: 1\nb: x\n"), r#"{"a":1,"b":"x"}"#);
    assert_eq!(json("a:\n  - 1\n  - two\n"), r#"{"a":[1,"two"]}"#);
    assert_eq!(json("a:\n- 1\n- 2\nb: 3\n"), r#"{"a":[1,2],"b":3}"#);
    assert_eq!(
        json("a:\n  b:\n    c: d\n  e: f\n"),
        r#"{"a":{"b":{"c":"d"},"e":"f"}}"#
    );
    assert_eq!(json("- a: 1\n  b: 2\n- c\n"), r#"[{"a":1,"b":2},"c"]"#);
    assert_eq!(json("- - a\n  - b\n- c\n"), r#"[["a","b"],"c"]"#);
    assert_eq!(json("a:\nb: \n"), r#"{"a":null,"b":null}"#);
    assert_eq!(json("-\n- x\n"), r#"[null,"x"]"#);
    assert_eq!(json("  a: 1\n  b: 2\n"), r#"{"a":1,"b":2}"#);
    assert_eq!(
        json("\"quoted key\": 1\n'k''s': 2\n"),
        r#"{"quoted key":1,"k's":2}"#
    );
    assert_eq!(
        json("1: a\ntrue: b\nnull: c\n"),
        r#"{"1":"a","true":"b","null":"c"}"#
    );
    assert_eq!(
        json("url: http://x.y/z?a=b#frag\n"),
        r#"{"url":"http://x.y/z?a=b#frag"}"#
    );
    assert_eq!(json("a:b: c\n"), r#"{"a:b":"c"}"#);
}

#[test]
fn comments() {
    assert_eq!(
        json("# top\na: 1 # one\n# mid\nb: [x, y] # two\n"),
        r#"{"a":1,"b":["x","y"]}"#
    );
    assert_eq!(json("a: x#y\n"), r#"{"a":"x#y"}"#);
    assert_eq!(json("a:\n  # inside\n  - 1\n"), r#"{"a":[1]}"#);
    assert_eq!(json("a: 'q' # c\n"), r#"{"a":"q"}"#);
}

#[test]
fn plain_multiline() {
    assert_eq!(
        json("a: one\n  two\n\n  three\nb: x\n"),
        r#"{"a":"one two\nthree","b":"x"}"#
    );
    assert_eq!(json("- a\n  b\n"), r#"["a b"]"#);
    assert_eq!(err("a: one\n  b: two\n"), ErrorKind::MapInInlineValue);
}

#[test]
fn quoted() {
    assert_eq!(
        json(r#"a: "x\ty\u00e9\x41\U0001F600\n""#),
        "{\"a\":\"x\\ty\u{e9}A\u{1F600}\\n\"}"
    );
    assert_eq!(json("a: 'it''s'\n"), r#"{"a":"it's"}"#);
    assert_eq!(
        json("a: \"one\n  two\n\n  three\"\n"),
        r#"{"a":"one two\nthree"}"#
    );
    assert_eq!(json("a: \"one \\\n  two\"\n"), r#"{"a":"one two"}"#);
    assert_eq!(json("a: \"x  \n  y\"\n"), r#"{"a":"x y"}"#);
    assert_eq!(err("a: \"open\n"), ErrorKind::UnterminatedQuoted);
    assert_eq!(err("a: \"\\q\"\n"), ErrorKind::InvalidEscape);
    assert_eq!(err("a: \"\\uD800\"\n"), ErrorKind::InvalidEscape);
    assert_eq!(err("a: 'x' y\n"), ErrorKind::UnexpectedContent);
}

#[test]
fn block_scalars() {
    assert_eq!(
        json("a: |\n  l1\n  l2\nb: x\n"),
        r#"{"a":"l1\nl2\n","b":"x"}"#
    );
    assert_eq!(json("a: |-\n  l1\n  l2\n"), r#"{"a":"l1\nl2"}"#);
    assert_eq!(json("a: |+\n  l1\n\n\nb: 1\n"), r#"{"a":"l1\n\n\n","b":1}"#);
    assert_eq!(json("a: |\n  l1\n\n\nb: 1\n"), r#"{"a":"l1\n","b":1}"#);
    assert_eq!(
        json("a: >\n  one\n  two\n\n  three\n    more\n  four\n"),
        r#"{"a":"one two\nthree\n  more\nfour\n"}"#
    );
    assert_eq!(
        json("a: |2\n    indented\n  x\n"),
        r#"{"a":"  indented\nx\n"}"#
    );
    assert_eq!(json("a: | # c\n  x\n"), r#"{"a":"x\n"}"#);
    assert_eq!(json("a: |\nb: 1\n"), r#"{"a":"","b":1}"#);
    assert_eq!(json("- |\n  x\n- y\n"), r#"["x\n","y"]"#);
    assert_eq!(
        json("a: |\n  # not a comment\n"),
        r##"{"a":"# not a comment\n"}"##
    );
    assert_eq!(json("a: |\n  x"), r#"{"a":"x"}"#);
    assert_eq!(err("a: |\n     \n  x\n"), ErrorKind::BadIndentation);
}

#[test]
fn flow_collections() {
    assert_eq!(
        json("a: [1, 'b', \"c\", [d], {e: f}]\n"),
        r#"{"a":[1,"b","c",["d"],{"e":"f"}]}"#
    );
    assert_eq!(
        json("a: {x: 1, y, \"z\":2}\n"),
        r#"{"a":{"x":1,"y":null,"z":2}}"#
    );
    assert_eq!(json("a: [x,\n  y,\n  ]\n"), r#"{"a":["x","y"]}"#);
    assert_eq!(json("a: [k: v]\n"), r#"{"a":[{"k":"v"}]}"#);
    assert_eq!(json("{a: 1}"), r#"{"a":1}"#);
    assert_eq!(json("a: [http://x, a:b]\n"), r#"{"a":["http://x","a:b"]}"#);
    assert_eq!(json("a: []\nb: {}\n"), r#"{"a":[],"b":{}}"#);
    assert_eq!(err("a: [1, 2\n"), ErrorKind::UnterminatedFlow);
    assert_eq!(json("a: [1 2]\n"), r#"{"a":["1 2"]}"#);
    assert_eq!(err("a: [[x] y]\n"), ErrorKind::ExpectedFlowSeparator);
}

#[test]
fn anchors_tags_and_limits() {
    assert_eq!(json("a: &x [1, 2]\nb: *x\n"), r#"{"a":[1,2],"b":[1,2]}"#);
    assert_eq!(
        json("a: &x\n  k: v\nb: *x\n"),
        r#"{"a":{"k":"v"},"b":{"k":"v"}}"#
    );
    assert_eq!(
        json("a: !!str 12\nb: ! 12\nc: !!float 1\nd: !!int \"7\"\n"),
        r#"{"a":"12","b":"12","c":1,"d":7}"#
    );
    assert!(matches!(
        err("a: !!binary aGk=\n"),
        ErrorKind::UnsupportedTag(_)
    ));
    assert!(matches!(
        err("a: !custom x\n"),
        ErrorKind::UnsupportedTag(_)
    ));
    assert!(matches!(err("a: !!int x\n"), ErrorKind::TagMismatch(_)));
    assert!(matches!(err("a: *nope\n"), ErrorKind::UndefinedAlias(_)));
    assert!(matches!(err("a: 1\na: 2\n"), ErrorKind::DuplicateKey(_)));
    // Billion laughs.
    let mut bomb = String::from("a0: &a0 [x, x, x, x, x, x, x, x, x, x]\n");
    for i in 1..10 {
        let prev = format!("*a{}", i - 1);
        bomb.push_str(&format!(
            "a{i}: &a{i} [{}]\n",
            [prev.as_str(); 10].join(", ")
        ));
    }
    assert_eq!(err(&bomb), ErrorKind::AliasLimit);
    let deep = format!("a: {}{}\n", "[".repeat(200), "]".repeat(200));
    assert_eq!(err(&deep), ErrorKind::TooDeep);
    let mut nested = String::new();
    for i in 0..150 {
        nested.push_str(&" ".repeat(i));
        nested.push_str("k:\n");
    }
    assert_eq!(err(&nested), ErrorKind::TooDeep);
}

#[test]
fn unsupported_and_invalid() {
    assert_eq!(
        err("? a\n: b\n"),
        ErrorKind::Unsupported("explicit keys (`? `)")
    );
    assert_eq!(
        err("[a]: b\n"),
        ErrorKind::Unsupported("collection or alias mapping keys")
    );
    assert_eq!(err("a: 1\n---\nb: 2\n"), ErrorKind::MultipleDocuments);
    assert_eq!(
        err("%YAML 1.2\n---\na: 1\n"),
        ErrorKind::Unsupported("directives")
    );
    assert_eq!(err("a:\n\t- x\n"), ErrorKind::TabIndentation);
    assert_eq!(err("a: x\rb: y\n"), ErrorKind::BareCarriageReturn);
    assert_eq!(err("a: - b\n"), ErrorKind::SeqInInlineValue);
    assert_eq!(err("a: b: c\n"), ErrorKind::MapInInlineValue);
    assert_eq!(err("a: 1\n  b: 2\n"), ErrorKind::MapInInlineValue);
    assert_eq!(err("a:\n  b: 1\n c: 2\n"), ErrorKind::BadIndentation);
    assert_eq!(err("a: 1\nplain\n"), ErrorKind::ExpectedKey);
}

#[test]
fn documents_and_line_endings() {
    assert_eq!(parse_value("").unwrap(), None);
    assert_eq!(parse_value("# only a comment\n\n").unwrap(), None);
    assert_eq!(json("---\na: 1\n...\n"), r#"{"a":1}"#);
    assert_eq!(json("--- x\n"), r#""x""#);
    assert_eq!(
        json("a: 1\r\nb:\r\n  - x\r\nc: |\r\n  l1\r\n  l2\r\n"),
        r#"{"a":1,"b":["x"],"c":"l1\nl2\n"}"#
    );
    assert_eq!(json("scalar"), r#""scalar""#);
    assert_eq!(json("a: 1"), r#"{"a":1}"#);
}

#[test]
fn errors_have_positions() {
    let e = parse_value("a: 1\nb: [x\n").unwrap_err();
    assert_eq!((e.line, e.kind.clone()), (2, ErrorKind::UnterminatedFlow));
    let e = parse_value("é: \"\\q\"\n").unwrap_err();
    assert_eq!((e.line, e.column), (1, 5));
}

#[test]
fn block_scalar_lines_of_only_indentation_are_empty() {
    assert_eq!(json("a: >-\n \n x\n  y\n"), r#"{"a":"\nx\n y"}"#);
    assert_eq!(json("a: |\n  x\n  \n  y\n"), r#"{"a":"x\n\ny\n"}"#);
    assert_eq!(json("a: |\n  x\n    \n"), r#"{"a":"x\n  \n"}"#);
}

#[test]
fn block_scalar_without_content_lines_is_empty() {
    assert_eq!(json("a: >-\n  \nb: 1\n"), r#"{"a":"","b":1}"#);
    assert_eq!(json("a: |+\n   \n\nb: 1\n"), r#"{"a":"\n\n","b":1}"#);
}
