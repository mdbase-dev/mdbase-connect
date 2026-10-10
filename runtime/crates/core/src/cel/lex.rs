//! The CEL lexer.

use std::sync::Arc;

/// A token.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Tok {
    Int(i64),
    /// An int literal equal to 2^63, valid only directly after unary minus.
    IntMinMagnitude,
    Uint(u64),
    Double(f64),
    String(Arc<str>),
    Bytes(Arc<[u8]>),
    Ident(String),
    True,
    False,
    Null,
    In,
    /// Punctuation: `( ) [ ] { } . , : ? ! - + * / % < <= > >= == != && || .? [?`.
    P(&'static str),
    Eof,
}

/// A token with its byte offset.
#[derive(Debug, Clone)]
pub(crate) struct Token {
    pub tok: Tok,
    pub pos: usize,
}

const RESERVED: &[&str] = &[
    "as",
    "break",
    "const",
    "continue",
    "else",
    "for",
    "function",
    "if",
    "import",
    "let",
    "loop",
    "package",
    "namespace",
    "return",
    "var",
    "void",
    "while",
];

/// Tokenize `src`; errors carry a byte offset.
pub(crate) fn lex(src: &str) -> Result<Vec<Token>, (usize, String)> {
    let b = src.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c.is_ascii_whitespace() {
            i += 1;
            continue;
        }
        if c == b'/' && b.get(i + 1) == Some(&b'/') {
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        let start = i;
        // String and bytes literals with prefixes.
        if let Some((raw, bytes, q)) = string_prefix(b, i) {
            let (tok, next) = string_lit(src, q, raw, bytes)?;
            out.push(Token { tok, pos: start });
            i = next;
            continue;
        }
        if c.is_ascii_alphabetic() || c == b'_' {
            while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
                i += 1;
            }
            let word = &src[start..i];
            let tok = match word {
                "true" => Tok::True,
                "false" => Tok::False,
                "null" => Tok::Null,
                "in" => Tok::In,
                w if RESERVED.contains(&w) => return Err((start, format!("reserved word `{w}`"))),
                w => Tok::Ident(w.to_owned()),
            };
            out.push(Token { tok, pos: start });
            continue;
        }
        if c.is_ascii_digit() || (c == b'.' && b.get(i + 1).is_some_and(u8::is_ascii_digit)) {
            let (tok, next) = number(src, i)?;
            out.push(Token { tok, pos: start });
            i = next;
            continue;
        }
        let two = src.get(i..i + 2).unwrap_or("");
        let p: &'static str = match two {
            "<=" => "<=",
            ">=" => ">=",
            "==" => "==",
            "!=" => "!=",
            "&&" => "&&",
            "||" => "||",
            ".?" => ".?",
            "[?" => "[?",
            _ => "",
        };
        if !p.is_empty() {
            out.push(Token {
                tok: Tok::P(p),
                pos: start,
            });
            i += 2;
            continue;
        }
        let p: &'static str = match c {
            b'(' => "(",
            b')' => ")",
            b'[' => "[",
            b']' => "]",
            b'{' => "{",
            b'}' => "}",
            b'.' => ".",
            b',' => ",",
            b':' => ":",
            b'?' => "?",
            b'!' => "!",
            b'-' => "-",
            b'+' => "+",
            b'*' => "*",
            b'/' => "/",
            b'%' => "%",
            b'<' => "<",
            b'>' => ">",
            _ => {
                let ch = src[i..].chars().next().unwrap_or('?');
                return Err((start, format!("unexpected character {ch:?}")));
            }
        };
        out.push(Token {
            tok: Tok::P(p),
            pos: start,
        });
        i += 1;
    }
    out.push(Token {
        tok: Tok::Eof,
        pos: src.len(),
    });
    Ok(out)
}

/// A string or bytes literal start at `i`: (raw, bytes, index of the quote).
fn string_prefix(b: &[u8], i: usize) -> Option<(bool, bool, usize)> {
    let is_q = |j: usize| matches!(b.get(j), Some(b'"' | b'\''));
    let lower = |j: usize| b.get(j).map(u8::to_ascii_lowercase);
    match (lower(i), lower(i + 1)) {
        _ if is_q(i) => Some((false, false, i)),
        (Some(b'r'), Some(b'b')) | (Some(b'b'), Some(b'r')) if is_q(i + 2) => {
            Some((true, true, i + 2))
        }
        (Some(b'r'), _) if is_q(i + 1) => Some((true, false, i + 1)),
        (Some(b'b'), _) if is_q(i + 1) => Some((false, true, i + 1)),
        _ => None,
    }
}

fn string_lit(
    src: &str,
    q: usize,
    raw: bool,
    bytes: bool,
) -> Result<(Tok, usize), (usize, String)> {
    let b = src.as_bytes();
    let quote = b[q];
    let triple = b.get(q + 1) == Some(&quote) && b.get(q + 2) == Some(&quote);
    let mut i = if triple { q + 3 } else { q + 1 };
    let mut out: Vec<u8> = Vec::new();
    loop {
        let Some(&c) = b.get(i) else {
            return Err((q, "unterminated string literal".into()));
        };
        if c == quote && (!triple || (b.get(i + 1) == Some(&quote) && b.get(i + 2) == Some(&quote)))
        {
            i += if triple { 3 } else { 1 };
            break;
        }
        if !triple && (c == b'\n' || c == b'\r') {
            return Err((q, "line break in a single-line string literal".into()));
        }
        if c == b'\\' && !raw {
            let (bytes_out, next) = escape(src, i, bytes)?;
            out.extend(bytes_out);
            i = next;
            continue;
        }
        out.push(c);
        i += 1;
    }
    if bytes {
        Ok((Tok::Bytes(Arc::from(out)), i))
    } else {
        match String::from_utf8(out) {
            Ok(s) => Ok((Tok::String(Arc::from(s)), i)),
            Err(_) => Err((q, "string literal is not valid UTF-8".into())),
        }
    }
}

fn escape(src: &str, i: usize, bytes: bool) -> Result<(Vec<u8>, usize), (usize, String)> {
    let b = src.as_bytes();
    let Some(&c) = b.get(i + 1) else {
        return Err((i, "trailing backslash".into()));
    };
    let simple = |ch: u8| Ok((vec![ch], i + 2));
    match c {
        b'a' => simple(7),
        b'b' => simple(8),
        b'f' => simple(12),
        b'n' => simple(b'\n'),
        b'r' => simple(b'\r'),
        b't' => simple(b'\t'),
        b'v' => simple(11),
        b'\\' | b'\'' | b'"' | b'`' | b'?' => simple(c),
        b'x' | b'X' => {
            let hex = src
                .get(i + 2..i + 4)
                .filter(|h| h.bytes().all(|x| x.is_ascii_hexdigit()));
            let Some(hex) = hex else {
                return Err((i, "invalid \\x escape".into()));
            };
            let v = u8::from_str_radix(hex, 16).unwrap_or(0);
            if bytes {
                Ok((vec![v], i + 4))
            } else {
                Ok((
                    char_bytes(u32::from(v)).ok_or((i, "invalid \\x escape".to_owned()))?,
                    i + 4,
                ))
            }
        }
        b'u' | b'U' => {
            if bytes {
                return Err((i, "\\u escapes are not allowed in bytes".into()));
            }
            let n = if c == b'u' { 4 } else { 8 };
            let hex = src
                .get(i + 2..i + 2 + n)
                .filter(|h| h.bytes().all(|x| x.is_ascii_hexdigit()));
            let code = hex.and_then(|h| u32::from_str_radix(h, 16).ok());
            match code.and_then(char_bytes) {
                Some(v) => Ok((v, i + 2 + n)),
                None => Err((i, "invalid unicode escape".into())),
            }
        }
        b'0'..=b'3' => {
            let oct = src
                .get(i + 1..i + 4)
                .filter(|o| o.bytes().all(|x| (b'0'..=b'7').contains(&x)));
            let Some(oct) = oct else {
                return Err((i, "invalid octal escape".into()));
            };
            let v = u32::from_str_radix(oct, 8).unwrap_or(0);
            if bytes {
                Ok((vec![u8::try_from(v).unwrap_or(0)], i + 4))
            } else {
                Ok((
                    char_bytes(v).ok_or((i, "invalid octal escape".to_owned()))?,
                    i + 4,
                ))
            }
        }
        _ => Err((i, format!("invalid escape \\{}", c as char))),
    }
}

fn char_bytes(code: u32) -> Option<Vec<u8>> {
    let ch = char::from_u32(code)?;
    let mut buf = [0u8; 4];
    Some(ch.encode_utf8(&mut buf).as_bytes().to_vec())
}

fn number(src: &str, i: usize) -> Result<(Tok, usize), (usize, String)> {
    let b = src.as_bytes();
    let start = i;
    // Hex integers.
    if b[i] == b'0' && matches!(b.get(i + 1), Some(b'x' | b'X')) {
        let mut j = i + 2;
        while j < b.len() && b[j].is_ascii_hexdigit() {
            j += 1;
        }
        if j == i + 2 {
            return Err((start, "invalid hex literal".into()));
        }
        let digits = &src[i + 2..j];
        if matches!(b.get(j), Some(b'u' | b'U')) {
            let v = u64::from_str_radix(digits, 16)
                .map_err(|_| (start, "uint literal out of range".to_owned()))?;
            return Ok((Tok::Uint(v), j + 1));
        }
        let v = i64::from_str_radix(digits, 16)
            .map_err(|_| (start, "int literal out of range".to_owned()))?;
        return Ok((Tok::Int(v), j));
    }
    let mut j = i;
    while j < b.len() && b[j].is_ascii_digit() {
        j += 1;
    }
    let mut float = false;
    if b.get(j) == Some(&b'.') && b.get(j + 1).is_some_and(u8::is_ascii_digit) {
        float = true;
        j += 1;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
    }
    if matches!(b.get(j), Some(b'e' | b'E')) {
        let mut k = j + 1;
        if matches!(b.get(k), Some(b'+' | b'-')) {
            k += 1;
        }
        if b.get(k).is_some_and(u8::is_ascii_digit) {
            float = true;
            j = k;
            while j < b.len() && b[j].is_ascii_digit() {
                j += 1;
            }
        }
    }
    let text = &src[start..j];
    if float {
        let v: f64 = text
            .parse()
            .map_err(|_| (start, "invalid double literal".to_owned()))?;
        return Ok((Tok::Double(v), j));
    }
    if matches!(b.get(j), Some(b'u' | b'U')) {
        let v: u64 = text
            .parse()
            .map_err(|_| (start, "uint literal out of range".to_owned()))?;
        return Ok((Tok::Uint(v), j + 1));
    }
    match text.parse::<i64>() {
        Ok(v) => Ok((Tok::Int(v), j)),
        Err(_) if text == "9223372036854775808" => Ok((Tok::IntMinMagnitude, j)),
        Err(_) => Err((start, "int literal out of range".into())),
    }
}
