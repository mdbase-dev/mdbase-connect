use super::*;
use crate::yaml;

fn parse(source: &str) -> Expr {
    Expression::parse(source)
        .expect("synthetic expression parses")
        .ast
}

fn identifier(name: &str) -> Expr {
    Expr::Identifier(name.to_owned())
}

fn binary(op: &str, left: Expr, right: Expr) -> Expr {
    Expr::Binary(op.to_owned(), Box::new(left), Box::new(right))
}

fn error_kind(source: &str) -> ErrorKind {
    Expression::parse(source).unwrap_err().kind
}

#[test]
fn legacy_precedence_and_left_associativity_are_preserved() {
    assert_eq!(
        parse("a - b - c"),
        binary(
            "-",
            binary("-", identifier("a"), identifier("b")),
            identifier("c")
        )
    );
    let product = binary("*", identifier("e"), identifier("f"));
    let sum = binary("+", identifier("d"), product);
    let comparison = binary("==", identifier("c"), sum);
    let conjunction = binary("&&", identifier("b"), comparison);
    assert_eq!(
        parse("a || b && c == d + e * f"),
        binary("||", identifier("a"), conjunction)
    );
    assert_eq!(
        parse("-(a + b) / c"),
        binary(
            "/",
            Expr::Unary(
                "-".into(),
                Box::new(binary("+", identifier("a"), identifier("b")))
            ),
            identifier("c")
        )
    );
}

#[test]
fn named_computed_and_dynamic_members_are_not_conflated() {
    assert_eq!(
        parse("note.status"),
        Expr::Member(Box::new(identifier("note")), Member::Named("status".into()))
    );
    assert_eq!(
        parse(r#"note["a.b"]"#),
        Expr::Member(
            Box::new(identifier("note")),
            Member::Computed(Box::new(Expr::Literal(Value::Text("a.b".into()))))
        )
    );
    assert_eq!(
        parse("note[property]"),
        Expr::Member(
            Box::new(identifier("note")),
            Member::Computed(Box::new(identifier("property")))
        )
    );
    assert_ne!(parse("note.a.b"), parse(r#"note["a.b"]"#));
}

#[test]
fn calls_keep_callee_and_lazy_argument_syntax() {
    let Expr::Call(callee, arguments) =
        parse("list(tags).filter(value != null).map(value.lower())")
    else {
        panic!("expected call")
    };
    assert!(matches!(*callee, Expr::Member(_, Member::Named(ref name)) if name == "map"));
    assert_eq!(arguments.len(), 1);
    assert!(matches!(arguments[0], Expr::Call(_, _)));
    // Parsing is NOT function admission; runtime-error oracle cases still parse.
    assert!(Expression::parse("doesNotExist()").is_ok());
}

#[test]
fn regex_and_division_use_the_original_lexical_context() {
    let Expr::Call(_, arguments) = parse(r#"title.replace(/[\/]/gi, "") / 2"#).binary_left() else {
        panic!("expected replace call")
    };
    assert_eq!(arguments[0], Expr::Regex(r"[\/]".into(), "gi".into()));
    assert_eq!(
        parse("(a) / b"),
        binary("/", identifier("a"), identifier("b"))
    );
    assert_eq!(
        parse("a / /x/"),
        binary("/", identifier("a"), Expr::Regex("x".into(), String::new()))
    );
    assert_eq!(parse("/[/]/g"), Expr::Regex("[/]".into(), "g".into()));
}

impl Expr {
    fn binary_left(self) -> Self {
        let Self::Binary(op, left, _) = self else {
            panic!("expected binary")
        };
        assert_eq!(op, "/");
        *left
    }
}

#[test]
fn literals_and_port_source_escape_rules_are_preserved() {
    assert_eq!(
        parse("[.5, 1e2, true, false, null, 'a']"),
        Expr::Array(vec![
            Expr::Literal(Value::Float(0.5)),
            Expr::Literal(Value::Float(100.0)),
            Expr::Literal(Value::Bool(true)),
            Expr::Literal(Value::Bool(false)),
            Expr::Literal(Value::Null),
            Expr::Literal(Value::Text("a".into())),
        ])
    );
    assert_eq!(
        parse(r#""\n\r\t\b\f\\\"\q\u0041""#),
        Expr::Literal(Value::Text("\n\r\t\u{8}\u{c}\\\"qu0041".into()))
    );
    assert!(Expression::parse("(1).round(2)").is_ok());
    assert_eq!(
        error_kind("1e999"),
        ErrorKind::UnsupportedConstruct("non_finite_number_literal")
    );
    assert_eq!(
        error_kind("1e"),
        ErrorKind::InvalidSource("unexpected_token")
    );
}

#[test]
fn legacy_oracle_parser_divergences_are_visible_not_silently_blessed() {
    // The existing Rust parser accepts these five syntax forms; the fixture
    // labels real-Obsidian disagreements. Later semantic admission must gate
    // them, not infer parity from successful parsing.
    for source in [
        "+price",
        "1.isTruthy()",
        "0.isTruthy()",
        "123.toString()",
        "5.isEmpty()",
    ] {
        assert!(Expression::parse(source).is_ok());
    }
}

#[test]
fn malformed_and_unsupported_shapes_have_fixed_refusals() {
    for source in [
        "",
        "x +",
        "(",
        "[",
        "f(",
        "note[",
        "note.",
        "[x,]",
        "f(x,)",
        "x y",
        "x ? y : z",
        "x === y",
        "'unterminated",
        "'trailing\\",
        "/unterminated",
        "note[0",
        "(x))",
    ] {
        assert!(
            matches!(error_kind(source), ErrorKind::InvalidSource(_)),
            "malformed synthetic input must fail"
        );
    }
    assert_eq!(
        error_kind("{a: 1}"),
        ErrorKind::UnsupportedConstruct("object_literal")
    );
}

#[test]
fn diagnostic_offsets_are_utf8_bytes_and_do_not_echo_source() {
    let source = "秘密 +";
    let error = Expression::parse(source).unwrap_err();
    assert_eq!(error.offset, u32::try_from(source.len()).unwrap());
    assert_eq!(error.kind, ErrorKind::InvalidSource("expected_expression"));
    let error = Expression::parse("note.秘密 #").unwrap_err();
    assert_eq!(error.offset, u32::try_from("note.秘密 ".len()).unwrap());
    assert!(!error.to_string().contains("秘密"));
    assert!(!format!("{error:?}").contains("秘密"));
}

#[test]
fn source_limit_is_checked_on_bytes_before_lexing() {
    let exact = format!("'{}'", "a".repeat(MAX_SOURCE_BYTES - 2));
    assert!(Expression::parse(&exact).is_ok());
    assert_eq!(
        error_kind(&(exact + " ")),
        ErrorKind::BudgetExceeded("source_bytes")
    );
    assert_eq!(
        error_kind(&"é".repeat(MAX_SOURCE_BYTES / 2 + 1)),
        ErrorKind::BudgetExceeded("source_bytes")
    );
}

#[test]
fn token_limit_includes_all_tokens_but_not_eof() {
    let tokens = Lexer::tokenize(&"(".repeat(MAX_TOKENS)).unwrap();
    assert_eq!(tokens.len(), MAX_TOKENS + 1);
    assert!(matches!(tokens.last().unwrap().kind, TokenKind::Eof));
    assert_eq!(
        Lexer::tokenize(&"(".repeat(MAX_TOKENS + 1))
            .unwrap_err()
            .kind,
        ErrorKind::BudgetExceeded("tokens")
    );
}

#[test]
fn parser_recursion_is_bounded_even_when_parentheses_add_no_nodes() {
    let source = format!(
        "{}x{}",
        "(".repeat(MAX_PARSE_DEPTH - 1),
        ")".repeat(MAX_PARSE_DEPTH - 1)
    );
    let expression = Expression::parse(&source).unwrap();
    assert_eq!(expression.node_count(), 1);
    assert_eq!(expression.depth(), 1);
    assert_eq!(
        error_kind(&format!("({source})")),
        ErrorKind::BudgetExceeded("parse_depth")
    );
}

#[test]
fn resulting_tree_depth_bounds_postfix_and_left_associative_chains() {
    let postfix = format!("x{}", ".x".repeat(MAX_AST_DEPTH - 1));
    assert_eq!(Expression::parse(&postfix).unwrap().depth(), MAX_AST_DEPTH);
    assert_eq!(
        error_kind(&(postfix + ".x")),
        ErrorKind::BudgetExceeded("ast_depth")
    );
    let chain = vec!["x"; MAX_AST_DEPTH].join("+");
    assert_eq!(Expression::parse(&chain).unwrap().depth(), MAX_AST_DEPTH);
    assert_eq!(
        error_kind(&(chain + "+x")),
        ErrorKind::BudgetExceeded("ast_depth")
    );
    let source = format!("{}x", "!".repeat(MAX_AST_DEPTH - 1));
    assert_eq!(Expression::parse(&source).unwrap().depth(), MAX_AST_DEPTH);
}

#[test]
fn total_node_limit_is_request_wide_for_wide_lists() {
    let items = vec!["!x"; (MAX_AST_NODES - 2) / 2].join(",");
    let source = format!("[{items},x]");
    assert_eq!(
        Expression::parse(&source).unwrap().node_count(),
        MAX_AST_NODES
    );
    assert_eq!(
        error_kind(&format!("[{items},!x]")),
        ErrorKind::BudgetExceeded("ast_nodes")
    );
}

#[test]
fn all_297_legacy_oracle_cases_are_classified_without_dropping_cases() {
    use sha2::{Digest, Sha256};
    const TEXT: &str = include_str!("../../../../tests/data/obsidian-bases-oracle.json");
    assert_eq!(
        format!("{:x}", Sha256::digest(TEXT.as_bytes())),
        "606603a98c9ff05effb3fb2e9147f629c62f6ca5657473bcfcb378e2e4cd4d90"
    );
    let fixture = yaml::parse_value(TEXT).unwrap().unwrap();
    let cases = fixture.get("cases").unwrap().as_list().unwrap();
    assert_eq!(cases.len(), 297);
    assert_eq!(
        cases
            .iter()
            .filter(|c| c.get("knownDivergence").is_some())
            .count(),
        5
    );
    let mut parsed = 0;
    let mut refused = 0;
    for case in cases {
        let source = case.get("expression").unwrap().as_str().unwrap();
        let name = case.get("name").unwrap().as_str().unwrap();
        if matches!(name, "object keys" | "object values" | "object isEmpty") {
            // The legacy public evaluator returned Null after this parser
            // refusal. Preserve the original capture, but never turn a syntax
            // refusal into a successful plausible value in this port slice.
            assert_eq!(
                error_kind(source),
                ErrorKind::UnsupportedConstruct("object_literal")
            );
            assert!(case.get("expected").unwrap().is_null());
            refused += 1;
        } else {
            assert!(
                Expression::parse(source).is_ok(),
                "syntax case {name} failed"
            );
            parsed += 1;
        }
        // Expected values are deliberately preserved in the full fixture for
        // the evaluator port. This test makes NO semantic-value comparison.
        assert!(case.get("expected").is_some());
    }
    assert_eq!((parsed, refused), (294, 3));
}

#[test]
fn all_205_tasknotes_and_public_inventory_expressions_fit_admission() {
    let fixture = yaml::parse_value(include_str!(
        "../../../../tests/data/bases-tasknotes-expressions.yaml"
    ))
    .unwrap()
    .unwrap();
    let cases = fixture.get("expressions").unwrap().as_list().unwrap();
    assert_eq!(cases.len(), 205);
    let mut max_nodes = 0;
    let mut max_depth = 0;
    let mut max_bytes = 0;
    for source in cases {
        let source = source.as_str().unwrap();
        let expression = Expression::parse(source).expect("inventory syntax parses");
        max_nodes = max_nodes.max(expression.node_count());
        max_depth = max_depth.max(expression.depth());
        max_bytes = max_bytes.max(source.len());
    }
    assert_eq!(max_bytes, 898);
    println!(
        "205 inventory expressions: max {max_bytes} bytes / {max_nodes} nodes / {max_depth} depth"
    );
}
