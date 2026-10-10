//! Lexer and precedence parser ported from mdbase-rs (see `LICENSE.port`).
//! Grammar, escape rules, regex/division disambiguation and AST shapes retain
//! the port source. Admission and redacted positional errors replace unbounded
//! parsing/raw-source diagnostics. Regex literals are represented, not compiled.

use crate::value::Value;

use super::{
    Error, ErrorKind, MAX_AST_DEPTH, MAX_AST_NODES, MAX_PARSE_DEPTH, MAX_SOURCE_BYTES, MAX_TOKENS,
};

/// Legacy Bases expression tree. Exposed read-only through [`Expression::ast`]
/// for the later exact evaluator and sound candidate derivation, not CEL.
/// Hosts must not treat a manually constructed tree as an admitted expression.
#[derive(Clone, Debug, PartialEq)]
#[non_exhaustive]
pub enum Expr {
    /// A finite binary64 number, string, boolean or null.
    Literal(Value),
    /// A regex's raw pattern and flags; no host/regex-lite execution yet.
    Regex(String, String),
    /// A property/system/scope identifier, resolved only during later admission.
    Identifier(String),
    /// A list literal, in source order.
    Array(Vec<Expr>),
    /// Prefix `!`, `-` or legacy unary `+`.
    Unary(String, Box<Expr>),
    /// A left-associative binary expression, with the original operator spelling.
    Binary(String, Box<Expr>, Box<Expr>),
    /// Dot or computed selection.
    Member(Box<Expr>, Member),
    /// Function/method invocation with lazy arguments preserved as syntax.
    Call(Box<Expr>, Vec<Expr>),
}

/// A member selection; bracket keys are not split into dotted paths.
#[derive(Clone, Debug, PartialEq)]
#[non_exhaustive]
pub enum Member {
    /// `operand.field`.
    Named(String),
    /// `operand[key]`, including dynamic keys and exact keys containing dots.
    Computed(Box<Expr>),
}

impl Expr {
    fn depth(&self) -> usize {
        let child_depth = match self {
            Self::Literal(_) | Self::Regex(_, _) | Self::Identifier(_) => 0,
            Self::Array(values) => values.iter().map(Self::depth).max().unwrap_or(0),
            Self::Unary(_, operand) => operand.depth(),
            Self::Binary(_, left, right) => left.depth().max(right.depth()),
            Self::Member(operand, Member::Named(_)) => operand.depth(),
            Self::Member(operand, Member::Computed(key)) => operand.depth().max(key.depth()),
            Self::Call(callee, arguments) => callee
                .depth()
                .max(arguments.iter().map(Self::depth).max().unwrap_or(0)),
        };
        child_depth + 1
    }
}

/// An opaque, bounded parse result. No public unchecked constructor is provided.
/// Parsing is syntax-only, not function/capability admission or evaluation.
#[derive(Clone, Debug, PartialEq)]
pub struct Expression {
    ast: Expr,
    nodes: usize,
}

impl Expression {
    /// Parse one expression using the ported grammar and fixed admission limits.
    /// Diagnostics are fixed IDs and byte offsets, not raw source snippets.
    pub fn parse(source: &str) -> Result<Self, Error> {
        if source.len() > MAX_SOURCE_BYTES {
            return Err(Error::new(ErrorKind::BudgetExceeded("source_bytes"), 0));
        }
        let mut parser = Parser {
            tokens: Lexer::tokenize(source)?,
            index: 0,
            recursion: 0,
            nodes: 0,
        };
        let ast = parser.expression(0)?;
        if !matches!(parser.current().kind, TokenKind::Eof) {
            return Err(parser.invalid("unexpected_token"));
        }
        Ok(Self {
            ast,
            nodes: parser.nodes,
        })
    }

    /// Read-only syntax for the later exact evaluator/candidate derivation.
    pub fn ast(&self) -> &Expr {
        &self.ast
    }

    /// Number of AST nodes allocated for this parse (parentheses don't add nodes).
    /// An in-memory counter only; never hash or serialize this platform-sized type.
    pub fn node_count(&self) -> usize {
        self.nodes
    }

    /// Depth of the admitted syntax tree, at most [`MAX_AST_DEPTH`].
    pub fn depth(&self) -> usize {
        self.ast.depth()
    }
}

#[derive(Clone, Debug, PartialEq)]
enum TokenKind {
    Number(f64),
    String(String),
    Identifier(String),
    Regex(String, String),
    Operator(String),
    Punct(char),
    Eof,
}

#[derive(Clone, Debug, PartialEq)]
struct Token {
    kind: TokenKind,
    offset: usize,
}

struct Lexer {
    chars: Vec<(usize, char)>,
    source_bytes: usize,
    index: usize,
    tokens: Vec<Token>,
    previous_ends_expression: bool,
}

impl Lexer {
    fn tokenize(source: &str) -> Result<Vec<Token>, Error> {
        let mut lexer = Self {
            chars: source.char_indices().collect(),
            source_bytes: source.len(),
            index: 0,
            tokens: Vec::new(),
            previous_ends_expression: false,
        };
        while let Some(character) = lexer.peek(0) {
            if character.is_whitespace() {
                lexer.index += 1;
            } else if character.is_ascii_digit()
                || (character == '.' && lexer.peek(1).is_some_and(|value| value.is_ascii_digit()))
            {
                lexer.number()?;
            } else if matches!(character, '\'' | '"') {
                lexer.string(character)?;
            } else if character == '/' && !lexer.previous_ends_expression {
                lexer.regexp()?;
            } else if is_identifier_start(character) {
                lexer.identifier()?;
            } else {
                lexer.symbol()?;
            }
        }
        lexer.tokens.push(Token {
            kind: TokenKind::Eof,
            offset: source.len(),
        });
        Ok(lexer.tokens)
    }

    fn peek(&self, offset: usize) -> Option<char> {
        self.chars
            .get(self.index + offset)
            .map(|(_, character)| *character)
    }

    fn offset(&self, index: usize) -> usize {
        self.chars
            .get(index)
            .map_or(self.source_bytes, |(offset, _)| *offset)
    }

    fn slice(&self, start: usize, end: usize) -> String {
        self.chars[start..end]
            .iter()
            .map(|(_, character)| character)
            .collect()
    }

    fn push(&mut self, kind: TokenKind, start: usize, ends_expression: bool) -> Result<(), Error> {
        if self.tokens.len() == MAX_TOKENS {
            return Err(Error::new(
                ErrorKind::BudgetExceeded("tokens"),
                self.offset(start),
            ));
        }
        self.tokens.push(Token {
            kind,
            offset: self.offset(start),
        });
        self.previous_ends_expression = ends_expression;
        Ok(())
    }

    fn number(&mut self) -> Result<(), Error> {
        let start = self.index;
        if self.peek(0) != Some('.') {
            while self.peek(0).is_some_and(|value| value.is_ascii_digit()) {
                self.index += 1;
            }
        }
        if self.peek(0) == Some('.') && self.peek(1).is_some_and(|value| value.is_ascii_digit()) {
            self.index += 1;
            while self.peek(0).is_some_and(|value| value.is_ascii_digit()) {
                self.index += 1;
            }
        }
        if self.peek(0).is_some_and(|value| matches!(value, 'e' | 'E')) {
            let exponent = self.index;
            self.index += 1;
            if self.peek(0).is_some_and(|value| matches!(value, '+' | '-')) {
                self.index += 1;
            }
            if self.peek(0).is_some_and(|value| value.is_ascii_digit()) {
                while self.peek(0).is_some_and(|value| value.is_ascii_digit()) {
                    self.index += 1;
                }
            } else {
                self.index = exponent;
            }
        }
        let value = self.slice(start, self.index).parse::<f64>().map_err(|_| {
            Error::new(
                ErrorKind::InvalidSource("invalid_number"),
                self.offset(start),
            )
        })?;
        if !value.is_finite() {
            // The old JSON boundary turned infinities into strings. Don't claim
            // that conversion is Bases semantics; keep an explicit refusal.
            return Err(Error::new(
                ErrorKind::UnsupportedConstruct("non_finite_number_literal"),
                self.offset(start),
            ));
        }
        self.push(TokenKind::Number(value), start, true)
    }

    fn string(&mut self, quote: char) -> Result<(), Error> {
        let start = self.index;
        self.index += 1;
        let mut value = String::new();
        while let Some(character) = self.peek(0) {
            self.index += 1;
            if character == quote {
                return self.push(TokenKind::String(value), start, true);
            }
            if character == '\\' {
                let escaped = self.peek(0).ok_or_else(|| {
                    Error::new(
                        ErrorKind::InvalidSource("unterminated_string"),
                        self.offset(start),
                    )
                })?;
                self.index += 1;
                value.push(match escaped {
                    'n' => '\n',
                    'r' => '\r',
                    't' => '\t',
                    'b' => '\u{0008}',
                    'f' => '\u{000c}',
                    other => other,
                });
            } else {
                value.push(character);
            }
        }
        Err(Error::new(
            ErrorKind::InvalidSource("unterminated_string"),
            self.offset(start),
        ))
    }

    fn regexp(&mut self) -> Result<(), Error> {
        let start = self.index;
        self.index += 1;
        let mut pattern = String::new();
        let mut escaped = false;
        let mut in_class = false;
        while let Some(character) = self.peek(0) {
            self.index += 1;
            if escaped {
                pattern.push('\\');
                pattern.push(character);
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '[' {
                in_class = true;
                pattern.push(character);
            } else if character == ']' {
                in_class = false;
                pattern.push(character);
            } else if character == '/' && !in_class {
                let mut flags = String::new();
                while self
                    .peek(0)
                    .is_some_and(|value| value.is_ascii_alphabetic())
                {
                    flags.push(self.peek(0).expect("checked"));
                    self.index += 1;
                }
                return self.push(TokenKind::Regex(pattern, flags), start, true);
            } else {
                pattern.push(character);
            }
        }
        Err(Error::new(
            ErrorKind::InvalidSource("unterminated_regex"),
            self.offset(start),
        ))
    }

    fn identifier(&mut self) -> Result<(), Error> {
        let start = self.index;
        self.index += 1;
        while self.peek(0).is_some_and(is_identifier_part) {
            self.index += 1;
        }
        self.push(
            TokenKind::Identifier(self.slice(start, self.index)),
            start,
            true,
        )
    }

    fn symbol(&mut self) -> Result<(), Error> {
        let start = self.index;
        let character = self.peek(0).expect("symbol exists");
        let pair = self
            .peek(1)
            .map(|next| format!("{character}{next}"))
            .unwrap_or_default();
        if matches!(pair.as_str(), "==" | "!=" | ">=" | "<=" | "&&" | "||") {
            self.index += 2;
            return self.push(TokenKind::Operator(pair), start, false);
        }
        if matches!(character, '+' | '-' | '*' | '/' | '%' | '!' | '>' | '<') {
            self.index += 1;
            return self.push(TokenKind::Operator(character.to_string()), start, false);
        }
        if matches!(
            character,
            '(' | '[' | '{' | '.' | ',' | ':' | ')' | ']' | '}'
        ) {
            self.index += 1;
            return self.push(
                TokenKind::Punct(character),
                start,
                matches!(character, ')' | ']' | '}'),
            );
        }
        Err(Error::new(
            ErrorKind::InvalidSource("unexpected_character"),
            self.offset(start),
        ))
    }
}

fn is_identifier_start(character: char) -> bool {
    character.is_alphabetic() || character == '_' || character == '$'
}

fn is_identifier_part(character: char) -> bool {
    character.is_alphanumeric() || matches!(character, '_' | '$')
}

struct Parser {
    tokens: Vec<Token>,
    index: usize,
    recursion: usize,
    nodes: usize,
}

impl Parser {
    fn current(&self) -> &Token {
        &self.tokens[self.index]
    }

    fn advance(&mut self) -> Token {
        let token = self.current().clone();
        // Keep the EOF sentinel addressable even after an incomplete operand.
        if !matches!(token.kind, TokenKind::Eof) {
            self.index += 1;
        }
        token
    }

    fn invalid(&self, detail: &'static str) -> Error {
        Error::new(ErrorKind::InvalidSource(detail), self.current().offset)
    }

    fn node(&mut self, expression: Expr) -> Result<Expr, Error> {
        if self.nodes == MAX_AST_NODES {
            return Err(Error::new(
                ErrorKind::BudgetExceeded("ast_nodes"),
                self.current().offset,
            ));
        }
        self.nodes += 1;
        // Children were already bounded. This traversal is at most 33 deep;
        // over the entire parse each node is visited at most 33 times. It also
        // bounds recursive drop/clone/debug, not just recursive parser calls.
        if expression.depth() > MAX_AST_DEPTH {
            return Err(Error::new(
                ErrorKind::BudgetExceeded("ast_depth"),
                self.current().offset,
            ));
        }
        Ok(expression)
    }

    fn match_punct(&mut self, expected: char) -> bool {
        if matches!(&self.current().kind, TokenKind::Punct(value) if *value == expected) {
            self.index += 1;
            true
        } else {
            false
        }
    }

    fn expect_punct(&mut self, expected: char) -> Result<(), Error> {
        if self.match_punct(expected) {
            Ok(())
        } else {
            Err(self.invalid("expected_punctuation"))
        }
    }

    fn expression(&mut self, minimum: u8) -> Result<Expr, Error> {
        if self.recursion == MAX_PARSE_DEPTH {
            return Err(Error::new(
                ErrorKind::BudgetExceeded("parse_depth"),
                self.current().offset,
            ));
        }
        self.recursion += 1;
        let result = self.expression_inner(minimum);
        self.recursion -= 1;
        result
    }

    fn expression_inner(&mut self, minimum: u8) -> Result<Expr, Error> {
        let mut left = self.prefix()?;
        left = self.postfix(left)?;
        while let TokenKind::Operator(operator) = &self.current().kind {
            let precedence = match operator.as_str() {
                "||" => 1,
                "&&" => 2,
                "==" | "!=" | ">" | "<" | ">=" | "<=" => 3,
                "+" | "-" => 4,
                "*" | "/" | "%" => 5,
                _ => 0,
            };
            if precedence == 0 || precedence < minimum {
                break;
            }
            let operator = operator.clone();
            self.advance();
            let right = self.expression(precedence + 1)?;
            left = self.node(Expr::Binary(operator, Box::new(left), Box::new(right)))?;
        }
        Ok(left)
    }

    fn prefix(&mut self) -> Result<Expr, Error> {
        let token = self.advance();
        let expression = match token.kind {
            TokenKind::Number(value) => Expr::Literal(Value::Float(value)),
            TokenKind::String(value) => Expr::Literal(Value::Text(value)),
            TokenKind::Regex(pattern, flags) => Expr::Regex(pattern, flags),
            TokenKind::Identifier(value) if value == "true" => Expr::Literal(Value::Bool(true)),
            TokenKind::Identifier(value) if value == "false" => Expr::Literal(Value::Bool(false)),
            TokenKind::Identifier(value) if value == "null" => Expr::Literal(Value::Null),
            TokenKind::Identifier(value) => Expr::Identifier(value),
            TokenKind::Operator(operator) if matches!(operator.as_str(), "!" | "-" | "+") => {
                Expr::Unary(operator, Box::new(self.expression(6)?))
            }
            TokenKind::Punct('(') => {
                let value = self.expression(0)?;
                self.expect_punct(')')?;
                return Ok(value);
            }
            TokenKind::Punct('[') => {
                let mut values = Vec::new();
                if !self.match_punct(']') {
                    loop {
                        values.push(self.expression(0)?);
                        if !self.match_punct(',') {
                            self.expect_punct(']')?;
                            break;
                        }
                    }
                }
                Expr::Array(values)
            }
            TokenKind::Punct('{') => {
                return Err(Error::new(
                    ErrorKind::UnsupportedConstruct("object_literal"),
                    token.offset,
                ));
            }
            _ => {
                return Err(Error::new(
                    ErrorKind::InvalidSource("expected_expression"),
                    token.offset,
                ));
            }
        };
        self.node(expression)
    }

    fn postfix(&mut self, mut expression: Expr) -> Result<Expr, Error> {
        loop {
            if self.match_punct('.') {
                let token = self.advance();
                let TokenKind::Identifier(property) = token.kind else {
                    return Err(Error::new(
                        ErrorKind::InvalidSource("expected_property"),
                        token.offset,
                    ));
                };
                expression =
                    self.node(Expr::Member(Box::new(expression), Member::Named(property)))?;
            } else if self.match_punct('[') {
                let property = self.expression(0)?;
                self.expect_punct(']')?;
                expression = self.node(Expr::Member(
                    Box::new(expression),
                    Member::Computed(Box::new(property)),
                ))?;
            } else if self.match_punct('(') {
                let mut arguments = Vec::new();
                if !self.match_punct(')') {
                    loop {
                        arguments.push(self.expression(0)?);
                        if !self.match_punct(',') {
                            self.expect_punct(')')?;
                            break;
                        }
                    }
                }
                expression = self.node(Expr::Call(Box::new(expression), arguments))?;
            } else {
                break;
            }
        }
        Ok(expression)
    }
}

// The oracle's four documented numeric-literal member divergences, refused
// pending named-version re-capture. Parenthesized numbers remain supported.
// Keep Expression::parse as the original grammar; semantic programs qualify it.
pub(super) fn qualify_syntax(source: &str) -> Result<(), Error> {
    if source.len() > MAX_SOURCE_BYTES {
        return Err(Error::new(ErrorKind::BudgetExceeded("source_bytes"), 0));
    }
    let tokens = Lexer::tokenize(source)?;
    for window in tokens.windows(3) {
        if matches!(window[0].kind, TokenKind::Number(_))
            && matches!(window[1].kind, TokenKind::Punct('.'))
            && matches!(window[2].kind, TokenKind::Identifier(_))
        {
            return Err(Error::new(
                ErrorKind::UnsupportedConstruct("direct_numeric_member"),
                window[0].offset,
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
