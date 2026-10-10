//! The mdbase regex profile (spec 10 "Regular Expressions").
//!
//! RE2 syntax with ASCII-only `\d`, `\w`, `\s`, `\b` and case folding, matched
//! over Unicode scalar values, with the semantics of the `regex-lite` crate.
//! One engine everywhere keeps replay verification deterministic (one cross-platform profile).
//!
//! `regex-lite` accepts more syntax than the profile, so every pattern first
//! goes through a validator that accepts exactly the profile's syntax:
//!
//! - literals; `\` before any ASCII punctuation (a literal); `\n`, `\t`, `\r`,
//!   `\f`, `\v`, `\xHH`, `\x{H...}`;
//! - `.`; bracket classes with ranges, negation, escapes and `[:name:]` ASCII
//!   classes; `\d \w \s \D \W \S`;
//! - `^ $ \A \z \b \B`;
//! - `(...)`, `(?:...)`, `(?P<name>...)`; `|`; `* + ? {n} {n,} {n,m}`, each
//!   optionally lazy;
//! - the flags `i m s x` as `(?flags)` or `(?flags:...)`, with `-` to clear.
//!
//! Everything else is invalid: Unicode classes (`\p`), backreferences,
//! look-around, `(?<name>...)`, other escapes (`\a`, `\u`, `\e`, ...), the
//! `regex-lite` extras `\<`, `\>`, `\b{...}`, the `U` and `R` flags, nested
//! bracket classes and class set operations (`&&`, `--`, `~~`).
//!
//! **Limits** (deterministic, so native and WASM accept the same patterns;
//! `regex-lite`'s own size limit counts `usize`-sized states and would differ):
//! at most [`MAX_PATTERN_LEN`] bytes, nesting depth [`MAX_DEPTH`], repetition
//! counts at most [`MAX_REPEAT`] (as in RE2), and an estimated program size of
//! at most [`MAX_PROGRAM`] after expanding counted repetitions.

/// Maximum pattern length in bytes.
pub const MAX_PATTERN_LEN: usize = 8192;
/// Maximum group nesting.
pub const MAX_DEPTH: u32 = 64;
/// Maximum count in `{n}`, `{n,}`, `{n,m}`.
pub const MAX_REPEAT: u64 = 1000;
/// Maximum estimated program size (instructions after expanding counted
/// repetitions).
pub const MAX_PROGRAM: u64 = 100_000;

/// Why a pattern is invalid (`invalid_pattern`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PatternError {
    /// What is wrong.
    pub message: String,
}

impl std::fmt::Display for PatternError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "invalid pattern: {}", self.message)
    }
}

impl std::error::Error for PatternError {}

/// A compiled pattern.
#[derive(Debug, Clone)]
pub struct Pattern {
    re: regex_lite::Regex,
}

impl Pattern {
    /// Validate and compile `pattern`.
    pub fn new(pattern: &str) -> Result<Pattern, PatternError> {
        let translated = validate(pattern)?;
        let re = regex_lite::RegexBuilder::new(&translated)
            // Our own limits keep every accepted pattern far below this on
            // both 32- and 64-bit targets.
            .size_limit(64 << 20)
            .nest_limit(2 * MAX_DEPTH)
            .build()
            .map_err(|e| PatternError {
                message: e.to_string(),
            })?;
        Ok(Pattern { re })
    }

    /// Whether the pattern matches anywhere in `text` (unanchored).
    pub fn is_match(&self, text: &str) -> bool {
        self.re.is_match(text)
    }
}

/// Validate and match in one step.
pub fn is_match(pattern: &str, text: &str) -> Result<bool, PatternError> {
    Ok(Pattern::new(pattern)?.is_match(text))
}

fn err<T>(message: impl Into<String>) -> Result<T, PatternError> {
    Err(PatternError {
        message: message.into(),
    })
}

/// One open group while validating.
struct Frame {
    /// Verbose mode (`x`) in this group.
    verbose: bool,
    /// Estimated size of the current alternative so far.
    size: u64,
    /// Total size of the completed alternatives (alternation adds sizes).
    alts: u64,
    /// Size of the most recent atom (what a repetition applies to).
    last: Option<u64>,
}

/// Check `pattern` against the profile and return the text to hand to
/// `regex-lite` (punctuation escapes rewritten where the two differ).
fn validate(pattern: &str) -> Result<String, PatternError> {
    if pattern.len() > MAX_PATTERN_LEN {
        return err("pattern is too long");
    }
    let chars: Vec<char> = pattern.chars().collect();
    let mut out = String::with_capacity(pattern.len());
    let mut stack = vec![Frame {
        verbose: false,
        size: 0,
        alts: 0,
        last: None,
    }];
    let mut names = std::collections::BTreeSet::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let verbose = stack.last().is_some_and(|f| f.verbose);
        if verbose && c.is_ascii_whitespace() {
            out.push(c);
            i += 1;
            continue;
        }
        if verbose && c == '#' {
            while i < chars.len() && chars[i] != '\n' {
                out.push(chars[i]);
                i += 1;
            }
            continue;
        }
        match c {
            '\\' => {
                let (text, next, atom) = escape(&chars, i, false)?;
                out.push_str(&text);
                i = next;
                push_atom(&mut stack, if atom { 1 } else { 0 })?;
            }
            '[' => {
                let (text, next) = if verbose {
                    // Verbose mode ignores whitespace and `#` comments inside
                    // classes too: validate the class without them.
                    let mut view = Vec::new();
                    let mut index = Vec::new();
                    let mut j = i;
                    while j < chars.len() {
                        let ch = chars[j];
                        if ch == '#' {
                            while j < chars.len() && chars[j] != '\n' {
                                j += 1;
                            }
                            continue;
                        }
                        if ch == '\\' && j + 1 < chars.len() {
                            view.extend([ch, chars[j + 1]]);
                            index.extend([j, j + 1]);
                            j += 2;
                            continue;
                        }
                        if !ch.is_ascii_whitespace() {
                            view.push(ch);
                            index.push(j);
                        }
                        j += 1;
                    }
                    index.push(chars.len());
                    let (text, next) = class(&view, 0)?;
                    (text, index[next - 1] + 1)
                } else {
                    class(&chars, i)?
                };
                out.push_str(&text);
                i = next;
                push_atom(&mut stack, 1)?;
            }
            '(' => {
                let (text, next, frame) = group_open(&chars, i, verbose)?;
                if let Some(name) = text.strip_prefix("(?P<").and_then(|t| t.strip_suffix('>'))
                    && !names.insert(name.to_owned())
                {
                    return err(format!("duplicate group name `{name}`"));
                }
                out.push_str(&text);
                i = next;
                match frame {
                    Some(v) => {
                        if stack.len() as u32 > MAX_DEPTH {
                            return err("groups are nested too deeply");
                        }
                        stack.push(Frame {
                            verbose: v,
                            size: 0,
                            alts: 0,
                            last: None,
                        });
                    }
                    None => {
                        // `(?flags)`: sets flags for the rest of the group.
                        if let Some(f) = stack.last_mut() {
                            f.verbose = flags_verbose(&text, f.verbose);
                            f.last = None;
                        }
                    }
                }
            }
            ')' => {
                if stack.len() < 2 {
                    return err("unopened group");
                }
                let f = stack.pop().unwrap_or(Frame {
                    verbose: false,
                    size: 0,
                    alts: 0,
                    last: None,
                });
                out.push(')');
                i += 1;
                let size = f.alts + f.size + 1;
                push_atom(&mut stack, size)?;
            }
            '|' => {
                if let Some(f) = stack.last_mut() {
                    f.alts += f.size + 1;
                    f.size = 0;
                    f.last = None;
                }
                out.push('|');
                i += 1;
            }
            '*' | '+' | '?' => {
                repeat(&mut stack, 2)?;
                out.push(c);
                i += 1;
                if chars.get(i) == Some(&'?') {
                    out.push('?');
                    i += 1;
                }
            }
            '{' => match counted(&chars, i)? {
                Some((max, next)) => {
                    repeat(&mut stack, max.max(1) + 1)?;
                    out.extend(&chars[i..next]);
                    i = next;
                    if chars.get(i) == Some(&'?') {
                        out.push('?');
                        i += 1;
                    }
                }
                None => return err("`{` must start a counted repetition (escape it as `\\{`)"),
            },
            '}' | ']' => return err(format!("unbalanced `{c}` (escape it)")),
            _ => {
                out.push(c);
                i += 1;
                push_atom(&mut stack, if matches!(c, '^' | '$') { 0 } else { 1 })?;
            }
        }
    }
    if stack.len() != 1 {
        return err("unclosed group");
    }
    Ok(out)
}

fn push_atom(stack: &mut [Frame], size: u64) -> Result<(), PatternError> {
    let f = stack.last_mut().ok_or(PatternError {
        message: "internal".into(),
    })?;
    f.size = f.size.saturating_add(size);
    f.last = Some(size);
    total(stack)
}

/// Apply a repetition that copies the last atom up to `times` times.
fn repeat(stack: &mut [Frame], times: u64) -> Result<(), PatternError> {
    let f = stack.last_mut().ok_or(PatternError {
        message: "internal".into(),
    })?;
    let Some(last) = f.last else {
        return err("repetition without an operand");
    };
    f.size = f
        .size
        .saturating_add(last.saturating_mul(times.saturating_sub(1)));
    // A repeated atom can be repeated again (`(a{9}){9}` is a group, but
    // `a{9}{9}` is not allowed in RE2).
    f.last = None;
    total(stack)
}

fn total(stack: &[Frame]) -> Result<(), PatternError> {
    let t = stack.iter().fold(0u64, |acc, f| {
        acc.saturating_add(f.alts).saturating_add(f.size)
    });
    if t > MAX_PROGRAM {
        return err("pattern is too large");
    }
    Ok(())
}

/// Whether `(?flags)` text leaves verbose mode on, given the previous state.
fn flags_verbose(text: &str, before: bool) -> bool {
    let inner = text.trim_start_matches("(?").trim_end_matches([')', ':']);
    let mut on = true;
    let mut v = before;
    for c in inner.chars() {
        match c {
            '-' => on = false,
            'x' => v = on,
            _ => {}
        }
    }
    v
}

/// `(` at `i`: returns the text, the next index, and `Some(verbose)` for a
/// group that opens a frame, `None` for a bare `(?flags)`.
fn group_open(
    chars: &[char],
    i: usize,
    verbose: bool,
) -> Result<(String, usize, Option<bool>), PatternError> {
    if chars.get(i + 1) != Some(&'?') {
        return Ok(("(".into(), i + 1, Some(verbose)));
    }
    match chars.get(i + 2) {
        Some(':') => Ok(("(?:".into(), i + 3, Some(verbose))),
        Some('P') => {
            if chars.get(i + 3) != Some(&'<') {
                return err("only `(?P<name>...)` named groups are supported");
            }
            let mut j = i + 4;
            while j < chars.len() && chars[j] != '>' {
                let ch = chars[j];
                if !(ch.is_ascii_alphanumeric() || ch == '_') {
                    return err("group names use ASCII letters, digits and `_`");
                }
                j += 1;
            }
            if j >= chars.len() || j == i + 4 {
                return err("unterminated or empty group name");
            }
            if chars[i + 4].is_ascii_digit() {
                return err("a group name cannot start with a digit");
            }
            Ok((chars[i..=j].iter().collect(), j + 1, Some(verbose)))
        }
        Some('=' | '!') => err("look-around is not supported"),
        Some('<') => err("look-behind and `(?<name>...)` are not supported; use `(?P<name>...)`"),
        _ => {
            // Flags.
            let mut j = i + 2;
            let mut seen_dash = false;
            let mut any = false;
            let mut v = verbose;
            let mut on = true;
            while let Some(&ch) = chars.get(j) {
                match ch {
                    'i' | 'm' | 's' | 'x' => {
                        any = true;
                        if ch == 'x' {
                            v = on;
                        }
                    }
                    '-' if !seen_dash => {
                        seen_dash = true;
                        on = false;
                    }
                    ')' | ':' => break,
                    _ => {
                        return err(format!(
                            "unsupported flag `{ch}` (the profile has i, m, s, x)"
                        ));
                    }
                }
                j += 1;
            }
            if !any {
                return err("empty flag group");
            }
            match chars.get(j) {
                Some(')') => Ok((chars[i..=j].iter().collect(), j + 1, None)),
                Some(':') => Ok((chars[i..=j].iter().collect(), j + 1, Some(v))),
                _ => err("unterminated flag group"),
            }
        }
    }
}

/// A counted repetition at `i` (`{n}`, `{n,}`, `{n,m}`): its maximum count
/// (or the minimum for `{n,}`) and the index after it.
fn counted(chars: &[char], i: usize) -> Result<Option<(u64, usize)>, PatternError> {
    let mut j = i + 1;
    let num = |j: &mut usize| -> Option<u64> {
        let start = *j;
        while *j < chars.len() && chars[*j].is_ascii_digit() {
            *j += 1;
        }
        if *j == start || *j - start > 6 {
            return None;
        }
        chars[start..*j].iter().collect::<String>().parse().ok()
    };
    let Some(lo) = num(&mut j) else {
        return Ok(None);
    };
    let mut hi = lo;
    if chars.get(j) == Some(&',') {
        j += 1;
        if chars.get(j) == Some(&'}') {
            hi = lo;
        } else {
            match num(&mut j) {
                Some(h) => hi = h,
                None => return Ok(None),
            }
            if hi < lo {
                return err("invalid repetition range (max < min)");
            }
        }
    }
    if chars.get(j) != Some(&'}') {
        return Ok(None);
    }
    if lo > MAX_REPEAT || hi > MAX_REPEAT {
        return err(format!("repetition count above {MAX_REPEAT}"));
    }
    Ok(Some((hi.max(lo), j + 1)))
}

/// An escape at `i` (pointing at `\`). Returns the text for `regex-lite`, the
/// next index, and whether it consumes a character (vs an assertion).
fn escape(chars: &[char], i: usize, in_class: bool) -> Result<(String, usize, bool), PatternError> {
    let Some(&c) = chars.get(i + 1) else {
        return err("trailing `\\`");
    };
    match c {
        // regex-lite reads `\<`/`\>` as word boundaries; in RE2 and the profile
        // they are literals.
        '<' | '>' => Ok((c.to_string(), i + 2, true)),
        c if c.is_ascii_punctuation() => Ok((format!("\\{c}"), i + 2, true)),
        'n' | 't' | 'r' | 'f' | 'v' | 'd' | 'w' | 's' | 'D' | 'W' | 'S' => {
            Ok((format!("\\{c}"), i + 2, true))
        }
        'A' | 'z' | 'b' | 'B' if !in_class => {
            if matches!(c, 'b' | 'B') && chars.get(i + 2) == Some(&'{') {
                return err("`\\b{...}` boundaries are not supported");
            }
            Ok((format!("\\{c}"), i + 2, false))
        }
        'x' => {
            if chars.get(i + 2) == Some(&'{') {
                let close = chars[i + 3..]
                    .iter()
                    .position(|&ch| ch == '}')
                    .map(|p| i + 3 + p)
                    .ok_or(PatternError {
                        message: "unterminated `\\x{...}`".into(),
                    })?;
                let hex: String = chars[i + 3..close].iter().collect();
                let ok = !hex.is_empty()
                    && hex.len() <= 8
                    && hex.chars().all(|h| h.is_ascii_hexdigit())
                    && u32::from_str_radix(&hex, 16)
                        .ok()
                        .and_then(char::from_u32)
                        .is_some();
                if !ok {
                    return err("`\\x{...}` must name a Unicode scalar value");
                }
                Ok((format!("\\x{{{hex}}}"), close + 1, true))
            } else {
                let hex: String = chars.get(i + 2..i + 4).unwrap_or(&[]).iter().collect();
                if hex.len() != 2 || !hex.chars().all(|h| h.is_ascii_hexdigit()) {
                    return err("`\\x` needs two hex digits or `\\x{...}`");
                }
                Ok((format!("\\x{hex}"), i + 4, true))
            }
        }
        'p' | 'P' => err("Unicode classes (`\\p`, `\\P`) are not supported"),
        '0'..='9' => err("backreferences and octal escapes are not supported"),
        _ => err(format!("unsupported escape `\\{c}`")),
    }
}

/// One item of a bracket class.
enum ClassItem {
    /// A single character (literal or escape), usable as a range endpoint.
    Char(char),
    /// A set (`\d`, `[:alpha:]`, ...), not usable as a range endpoint.
    Set,
}

/// The character an escape inside a class stands for, or `None` for a set.
fn class_escape_char(text: &str) -> Option<char> {
    let rest = text.strip_prefix('\\').unwrap_or(text);
    let mut cs = rest.chars();
    match (cs.next(), cs.next()) {
        (Some('n'), None) => Some('\n'),
        (Some('t'), None) => Some('\t'),
        (Some('r'), None) => Some('\r'),
        (Some('f'), None) => Some('\u{c}'),
        (Some('v'), None) => Some('\u{b}'),
        (Some('d' | 'w' | 's' | 'D' | 'W' | 'S'), None) => None,
        (Some('x'), Some(_)) => {
            let hex = rest[1..].trim_start_matches('{').trim_end_matches('}');
            u32::from_str_radix(hex, 16).ok().and_then(char::from_u32)
        }
        (Some(c), None) => Some(c),
        _ => None,
    }
}

/// A bracket class at `i` (pointing at `[`): the text and the next index.
///
/// A `-` is a range between two single characters (low ≤ high), and a literal
/// at the start, at the end, or right after a range. A set cannot be a range
/// endpoint.
fn class(chars: &[char], i: usize) -> Result<(String, usize), PatternError> {
    let mut out = String::from("[");
    let mut j = i + 1;
    if chars.get(j) == Some(&'^') {
        out.push('^');
        j += 1;
    }
    // The previous item, if it can start a range.
    let mut prev: Option<ClassItem> = None;
    let mut first = true;
    loop {
        let Some(&c) = chars.get(j) else {
            return err("unclosed bracket class");
        };
        if c == ']' && !first {
            out.push(']');
            return Ok((out, j + 1));
        }
        // A range `x-y`.
        if c == '-' && !first && chars.get(j + 1).is_some_and(|&n| n != ']') {
            if chars.get(j + 1) == Some(&'-') {
                return err("class set operations (`&&`, `--`, `~~`) are not supported");
            }
            let lo = match prev.take() {
                Some(ClassItem::Char(lo)) => lo,
                Some(ClassItem::Set) => {
                    return err("a class like `\\w` cannot be a range endpoint");
                }
                // After a completed range, `-` is a literal.
                None => {
                    out.push('-');
                    j += 1;
                    prev = Some(ClassItem::Char('-'));
                    first = false;
                    continue;
                }
            };
            let (hi, text, next) = class_item(chars, j + 1)?;
            let ClassItem::Char(hi) = hi else {
                return err("a class like `\\w` cannot be a range endpoint");
            };
            if hi < lo {
                return err("a bracket range is out of order");
            }
            out.push('-');
            out.push_str(&text);
            j = next;
            prev = None;
            first = false;
            continue;
        }
        let (item, text, next) = class_item(chars, j)?;
        out.push_str(&text);
        j = next;
        prev = Some(item);
        first = false;
    }
}

/// One class item at `j`: a `[:name:]` set, an escape, or a literal.
fn class_item(chars: &[char], j: usize) -> Result<(ClassItem, String, usize), PatternError> {
    let c = chars[j];
    match c {
        '[' if chars.get(j + 1) == Some(&':') => {
            let close = chars[j + 2..]
                .windows(2)
                .position(|w| w == [':', ']'])
                .map(|p| j + 2 + p)
                .ok_or(PatternError {
                    message: "unterminated `[:class:]`".into(),
                })?;
            let name: String = chars[j + 2..close].iter().collect();
            let bare = name.strip_prefix('^').unwrap_or(&name);
            const NAMES: &[&str] = &[
                "alnum", "alpha", "ascii", "blank", "cntrl", "digit", "graph", "lower", "print",
                "punct", "space", "upper", "word", "xdigit",
            ];
            if !NAMES.contains(&bare) {
                return err(format!("unknown ASCII class `[:{name}:]`"));
            }
            Ok((ClassItem::Set, format!("[:{name}:]"), close + 2))
        }
        '[' => err("nested bracket classes are not supported (escape `[` as `\\[`)"),
        '\\' => {
            let (text, next, _) = escape(chars, j, true)?;
            let item = match class_escape_char(&text) {
                Some(ch) => ClassItem::Char(ch),
                None => ClassItem::Set,
            };
            Ok((item, text, next))
        }
        '&' | '~' if chars.get(j + 1) == Some(&c) => {
            err("class set operations (`&&`, `--`, `~~`) are not supported")
        }
        _ => Ok((ClassItem::Char(c), c.to_string(), j + 1)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(p: &str, t: &str) -> bool {
        is_match(p, t).unwrap_or_else(|e| panic!("{p}: {e}"))
    }

    fn invalid(p: &str) {
        assert!(Pattern::new(p).is_err(), "{p:?} should be invalid");
    }

    #[test]
    fn ascii_semantics() {
        assert!(!m(r"^\w$", "é"));
        assert!(m(r"^\W$", "é"));
        assert!(!m(r"^\d$", "١"));
        assert!(!m(r"^\s$", "\u{a0}"));
        assert!(m(r"caf\b", "café"));
        assert!(!m(r"(?i)^é$", "É"));
        assert!(m(r"(?i)^abc$", "ABC"));
        assert!(m(r"^.$", "😀"));
        assert!(m(r"^[a-zà-ÿ]+$", "café"));
        assert!(m(r"^caf\x{E9}$", "café"));
        assert!(m(r"^caf\xE9$", "café"));
        assert!(m("b", "abc"));
        assert!(m(r"^[[:alpha:]]+$", "abc"));
        assert!(m(r"(?P<y>\d{4})-\d{2}", "2026-10"));
        assert!(m(r"(?x) a b # comment", "ab"));
        assert!(m(r"(?i:A)b", "ab"));
        assert!(!m(r"(?i:A)b", "aB"));
        assert!(m(r"a{2,3}?", "aaa"));
    }

    #[test]
    fn punctuation_escapes_are_literals() {
        for p in r##"!"#$%&'()*+,-./:;<=>?@[\]^_`{|}~"##.chars() {
            let pat = format!("^\\{p}$");
            assert!(m(&pat, &p.to_string()), "{pat}");
            let class = format!("^[\\{p}]$");
            assert!(m(&class, &p.to_string()), "{class}");
        }
    }

    /// Every pattern the validator accepts must also compile in `regex-lite`
    /// (otherwise the profile and the engine disagree), over random patterns.
    #[test]
    fn validator_accepts_only_what_regex_lite_compiles() {
        const PARTS: &[&str] = &[
            "a",
            "é",
            "😀",
            ".",
            "^",
            "$",
            "|",
            "(",
            ")",
            "(?:",
            "(?i)",
            "(?x)",
            "(?-i:",
            "(?P<g>",
            "[",
            "]",
            "[^",
            "a-z",
            "[:alpha:]",
            "*",
            "+",
            "?",
            "??",
            "{2}",
            "{1,3}",
            "{2,}",
            "\\",
            "\\d",
            "\\w",
            "\\s",
            "\\b",
            "\\B",
            "\\A",
            "\\z",
            "\\.",
            "\\<",
            "\\>",
            "\\x41",
            "\\x{E9}",
            "\\n",
            " ",
            "#",
            "-",
            "&",
            "~",
            ",",
        ];
        let mut state = 0x2545_f491_4f6c_dd1du64;
        let mut accepted = 0;
        for _ in 0..20_000 {
            let mut p = String::new();
            for _ in 0..1 + (state >> 60) {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                p.push_str(PARTS[(state % PARTS.len() as u64) as usize]);
            }
            if let Ok(t) = validate(&p) {
                accepted += 1;
                assert!(
                    regex_lite::Regex::new(&t).is_ok(),
                    "{p:?} -> {t:?} validated but does not compile"
                );
            }
        }
        assert!(accepted > 1000, "{accepted}");
    }

    #[test]
    fn outside_the_profile() {
        for p in [
            r"\p{L}",
            r"\pN",
            r"(a)\1",
            r"a(?=b)",
            r"a(?!b)",
            r"(?<=a)b",
            r"(?<n>a)",
            r"\b{start}",
            r"(?U)a+",
            r"(?R)a",
            r"\u0041",
            r"\a",
            r"\e",
            r"\Z",
            r"[a[bc]]",
            r"[a&&b]",
            r"[a--b]",
            r"a{1001}",
            r"(a",
            r"a)",
            r"[a",
            r"*a",
            r"\x{110000}",
            r"\x{D800}",
            r"\xZZ",
            r"a{",
            r"[[:alpah:]]",
        ] {
            invalid(p);
        }
        invalid(&"(".repeat(70));
        invalid(r"(a{1000}){1000}");
        invalid(&"a".repeat(MAX_PATTERN_LEN + 1));
    }
}
