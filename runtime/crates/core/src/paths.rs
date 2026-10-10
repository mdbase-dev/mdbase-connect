//! Collection paths: path keys and equivalence, the collision suffix rule,
//! path-pattern values (spec 02, 07), and path globs.
//!
//! Paths are collection-relative and `/`-separated, and are always reported as
//! written. Comparisons that decide collisions use the **path key**: NFC, then
//! full default case folding, then NFC again. Orderings use Unicode code-point
//! order, which is the byte order of UTF-8 (Rust's `str` ordering).

use std::collections::BTreeMap;

use crate::unicode::{case_fold, nfc};
use crate::value::{Value, format_float_es};

/// The path key of `path` (spec 02): NFC, full case folding, NFC.
///
/// `Notes/Café.md` (precomposed or combining) and `NOTES/CAFÉ.md` share a key,
/// and so do `Straße.md` and `STRASSE.md`.
pub fn path_key(path: &str) -> String {
    nfc(&case_fold(&nfc(path)))
}

/// Every group of two or more paths with the same path key; each group sorted
/// and the groups sorted (code-point order).
pub fn equivalence_groups<'a>(paths: impl IntoIterator<Item = &'a str>) -> Vec<Vec<String>> {
    let mut by_key: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for p in paths {
        by_key.entry(path_key(p)).or_default().push(p.to_owned());
    }
    let mut groups: Vec<Vec<String>> = by_key
        .into_values()
        .filter(|g| g.len() > 1)
        .map(|mut g| {
            g.sort();
            g
        })
        .collect();
    groups.sort();
    groups
}

/// `path` with ` (n)` inserted before the final extension of its last
/// component: `tasks/Call Bob.md` → `tasks/Call Bob (2).md`,
/// `views/tasks.view.base` → `views/tasks.view (2).base`. A name without a dot
/// gets the suffix at its end. Existing suffixes are not parsed.
pub fn suffixed(path: &str, n: u64) -> String {
    let (folder, name) = match path.rfind('/') {
        Some(i) => (&path[..=i], &path[i + 1..]),
        None => ("", path),
    };
    match name.rfind('.') {
        Some(dot) => format!("{folder}{} ({n}){}", &name[..dot], &name[dot..]),
        None => format!("{folder}{name} ({n})"),
    }
}

/// The path a new record receives under the collision rule (spec 02): the
/// requested path if its key is free, otherwise the first suffixed path
/// (`n = 2, 3, ...`) whose key is not used by `existing`.
pub fn allocate_path<'a>(requested: &str, existing: impl IntoIterator<Item = &'a str>) -> String {
    let used: std::collections::BTreeSet<String> = existing.into_iter().map(path_key).collect();
    if !used.contains(&path_key(requested)) {
        return requested.to_owned();
    }
    let mut n = 2u64;
    loop {
        let candidate = suffixed(requested, n);
        if !used.contains(&path_key(&candidate)) {
            return candidate;
        }
        n += 1;
    }
}

/// Why a path pattern could not produce a path (spec 07).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathPatternError {
    /// A placeholder's field is missing or null (`path_value_missing`).
    Missing {
        /// The field.
        field: String,
    },
    /// A placeholder's value cannot be one path component (`path_value_invalid`).
    Invalid {
        /// The field.
        field: String,
    },
    /// The pattern itself is malformed (an unclosed `{` or an empty `{}`).
    MalformedPattern,
}

impl PathPatternError {
    /// The spec error code.
    pub fn code(&self) -> &'static str {
        match self {
            PathPatternError::Missing { .. } => "path_value_missing",
            PathPatternError::Invalid { .. } => "path_value_invalid",
            PathPatternError::MalformedPattern => "invalid_type",
        }
    }

    /// The field the error names, if any.
    pub fn field(&self) -> Option<&str> {
        match self {
            PathPatternError::Missing { field } | PathPatternError::Invalid { field } => {
                Some(field)
            }
            PathPatternError::MalformedPattern => None,
        }
    }
}

/// Fill a `collection.path.pattern` from top-level frontmatter fields (spec 07).
///
/// A string is used as written; a number or boolean uses its JSON
/// representation (floats per RFC 8785, so `42.0` gives `42`). A missing or null
/// value is [`PathPatternError::Missing`]. A list, an object, an empty value, a
/// value containing `/`, `\` or NUL, or one beginning with `.` is
/// [`PathPatternError::Invalid`].
pub fn derive_path(
    pattern: &str,
    frontmatter: &crate::value::Map,
) -> Result<String, PathPatternError> {
    let mut out = String::with_capacity(pattern.len());
    let mut rest = pattern;
    while let Some(open) = rest.find('{') {
        let close = rest[open..]
            .find('}')
            .map(|i| open + i)
            .ok_or(PathPatternError::MalformedPattern)?;
        out.push_str(&rest[..open]);
        let field = &rest[open + 1..close];
        if field.is_empty() {
            return Err(PathPatternError::MalformedPattern);
        }
        let text = match frontmatter.get(field) {
            None | Some(Value::Null) => {
                return Err(PathPatternError::Missing {
                    field: field.to_owned(),
                });
            }
            Some(Value::List(_) | Value::Map(_)) => {
                return Err(PathPatternError::Invalid {
                    field: field.to_owned(),
                });
            }
            Some(Value::Bool(b)) => b.to_string(),
            Some(Value::Int(i)) => i.to_string(),
            Some(Value::Float(f)) => format_float_es(*f),
            Some(Value::Text(s)) => s.clone(),
        };
        if text.is_empty() || text.starts_with('.') || text.contains(['/', '\\', '\0']) {
            return Err(PathPatternError::Invalid {
                field: field.to_owned(),
            });
        }
        out.push_str(&text);
        rest = &rest[close + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

/// A compiled mdbase path glob (spec 02 "Path Globs").
///
/// `*` matches zero or more characters other than `/`, `?` exactly one, a
/// bracket class `[abc]`, `[a-z]` or `[!abc]` one character other than `/` in
/// (or not in) the set, and `**` as a whole component zero or more whole
/// components. Matching is case-sensitive over code points. A `**` that is not
/// a whole component, braces, backslashes, an unclosed bracket and a leading
/// `/` are invalid.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Glob {
    components: Vec<Component>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Component {
    /// `**`.
    Any,
    Segment(Vec<Token>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Token {
    Char(char),
    Star,
    One,
    Class {
        negated: bool,
        ranges: Vec<(char, char)>,
    },
}

/// Why a glob is invalid.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GlobError(pub &'static str);

impl Glob {
    /// Compile a glob.
    pub fn new(glob: &str) -> Result<Glob, GlobError> {
        if glob.starts_with('/') {
            return Err(GlobError("a glob has no leading `/`"));
        }
        let mut components = Vec::new();
        for part in glob.split('/') {
            if part == "**" {
                components.push(Component::Any);
                continue;
            }
            if part.contains("**") {
                return Err(GlobError("`**` must be a whole path component"));
            }
            let mut tokens = Vec::new();
            let mut chars = part.chars().peekable();
            while let Some(c) = chars.next() {
                match c {
                    '*' => tokens.push(Token::Star),
                    '?' => tokens.push(Token::One),
                    '{' | '}' => return Err(GlobError("brace expansion is not supported")),
                    '\\' => return Err(GlobError("backslash escapes are not supported")),
                    '[' => {
                        let negated = chars.peek() == Some(&'!');
                        if negated {
                            chars.next();
                        }
                        let mut ranges = Vec::new();
                        let mut closed = false;
                        let mut first = true;
                        while let Some(c) = chars.next() {
                            if c == ']' && !first {
                                closed = true;
                                break;
                            }
                            first = false;
                            if chars.peek() == Some(&'-') {
                                let mut look = chars.clone();
                                look.next();
                                match look.peek() {
                                    Some(&hi) if hi != ']' => {
                                        chars.next();
                                        chars.next();
                                        if hi < c {
                                            return Err(GlobError(
                                                "an inverted range in a bracket class",
                                            ));
                                        }
                                        ranges.push((c, hi));
                                        continue;
                                    }
                                    _ => {}
                                }
                            }
                            ranges.push((c, c));
                        }
                        if !closed {
                            return Err(GlobError("an unclosed bracket class"));
                        }
                        tokens.push(Token::Class { negated, ranges });
                    }
                    c => tokens.push(Token::Char(c)),
                }
            }
            components.push(Component::Segment(tokens));
        }
        Ok(Glob { components })
    }

    /// Whether the glob matches the whole of `path`.
    pub fn matches(&self, path: &str) -> bool {
        let parts: Vec<&str> = path.split('/').collect();
        match_components(&self.components, &parts)
    }
}

fn match_components(glob: &[Component], parts: &[&str]) -> bool {
    // Iterative backtracking over `**` (at most one active resume point per
    // `**`, like the classic wildcard algorithm), so long paths cannot recurse
    // deeply.
    let (mut g, mut p) = (0usize, 0usize);
    let mut resume: Option<(usize, usize)> = None;
    while p < parts.len() || g < glob.len() {
        match glob.get(g) {
            Some(Component::Any) => {
                resume = Some((g, p));
                g += 1;
                continue;
            }
            Some(Component::Segment(tokens))
                if p < parts.len() && match_segment(tokens, parts[p]) =>
            {
                g += 1;
                p += 1;
                continue;
            }
            _ => {}
        }
        match resume {
            Some((rg, rp)) if rp < parts.len() => {
                resume = Some((rg, rp + 1));
                g = rg + 1;
                p = rp + 1;
            }
            _ => return false,
        }
    }
    true
}

fn match_segment(tokens: &[Token], name: &str) -> bool {
    let chars: Vec<char> = name.chars().collect();
    let (mut t, mut c) = (0usize, 0usize);
    let mut star: Option<(usize, usize)> = None;
    while c < chars.len() {
        match tokens.get(t) {
            Some(Token::Star) => {
                star = Some((t, c));
                t += 1;
                continue;
            }
            Some(tok) if token_matches(tok, chars[c]) => {
                t += 1;
                c += 1;
                continue;
            }
            _ => {}
        }
        match star {
            Some((st, sc)) => {
                star = Some((st, sc + 1));
                t = st + 1;
                c = sc + 1;
            }
            None => return false,
        }
    }
    tokens[t..].iter().all(|tok| *tok == Token::Star)
}

fn token_matches(tok: &Token, c: char) -> bool {
    match tok {
        Token::Char(x) => *x == c,
        Token::One => c != '/',
        Token::Star => true,
        Token::Class { negated, ranges } => {
            c != '/' && ranges.iter().any(|&(lo, hi)| lo <= c && c <= hi) != *negated
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::value::Map;

    #[test]
    fn keys_and_groups() {
        assert_eq!(path_key("Notes/Cafe\u{301}.md"), path_key("notes/CAFÉ.md"));
        assert_eq!(
            equivalence_groups(["Straße.md", "STRASSE.md", "strasse-2.md"]),
            vec![vec!["STRASSE.md".to_owned(), "Straße.md".to_owned()]]
        );
        assert!(equivalence_groups(["a.md", "b.md"]).is_empty());
    }

    #[test]
    fn suffixes() {
        assert_eq!(suffixed("tasks/Call Bob.md", 2), "tasks/Call Bob (2).md");
        assert_eq!(suffixed("README", 3), "README (3)");
        assert_eq!(suffixed("a.b/c", 2), "a.b/c (2)");
        assert_eq!(
            allocate_path("t/x.md", ["t/X.md", "t/x (2).md", "t/X (3).MD"]),
            "t/x (4).md"
        );
    }

    #[test]
    fn derive() {
        let mut fm = Map::new();
        fm.insert("t", Value::Float(42.0));
        fm.insert("b", Value::Bool(true));
        assert_eq!(derive_path("x/{t}-{b}.md", &fm).unwrap(), "x/42-true.md");
        assert_eq!(
            derive_path("x/{t.md", &fm),
            Err(PathPatternError::MalformedPattern)
        );
        assert_eq!(
            derive_path("x/{}.md", &fm),
            Err(PathPatternError::MalformedPattern)
        );
    }

    #[test]
    fn path_policy_rejects_the_sec_033_exploits() {
        use PathViolation as V;
        let bad: &[(&str, PathViolation)] = &[
            (".obsidian/plugins/x/main.js", V::Hidden),
            (".obsidian/community-plugins.json", V::Hidden),
            (".vscode/tasks.json", V::Hidden),
            (".git/hooks/pre-commit", V::Hidden),
            (".envrc", V::Hidden),
            ("notes/.hidden.md", V::Hidden),
            ("C:evil.md", V::ForbiddenCharacter(':')),
            ("notes/a.md:stream", V::ForbiddenCharacter(':')),
            ("/etc/passwd", V::Absolute),
            ("//server/share/x.md", V::Absolute),
            ("a\\..\\b.md", V::Backslash),
            ("../x.md", V::DotSegment),
            ("a/../../x.md", V::DotSegment),
            ("a/./b.md", V::DotSegment),
            ("a//b.md", V::EmptySegment),
            ("a/", V::EmptySegment),
            (".mdbase/state.db", V::Private),
            (".MDBASE/state.db", V::Private),
            (".mdbase.", V::TrailingDotOrSpace),
            (".mdbase /x", V::TrailingDotOrSpace),
            ("\u{200c}.git/config", V::IgnorableCharacter),
            ("a\u{feff}.md", V::IgnorableCharacter),
            ("GIT~1/config", V::ShortNameAlias),
            ("MDBASE~1/x", V::ShortNameAlias),
            ("obsidi~1/plugins", V::ShortNameAlias),
            ("CON", V::ReservedName),
            ("con.md", V::ReservedName),
            ("Nul.txt", V::ReservedName),
            ("COM1.md", V::ReservedName),
            ("lpt9", V::ReservedName),
            ("COM\u{b9}.md", V::ReservedName),
            ("conin$", V::ReservedName),
            ("CONOUT$   .md", V::ReservedName),
            ("AUX .md", V::ReservedName),
            ("notes/x.", V::TrailingDotOrSpace),
            ("notes/x ", V::TrailingDotOrSpace),
            ("a\u{0}b", V::ControlCharacter),
            ("a\nb", V::ControlCharacter),
            ("a\u{7f}b", V::ControlCharacter),
            ("a\u{85}b", V::ControlCharacter),
            ("a<b", V::ForbiddenCharacter('<')),
            ("a|b", V::ForbiddenCharacter('|')),
            ("what?.md", V::ForbiddenCharacter('?')),
            ("a*.md", V::ForbiddenCharacter('*')),
            ("x/node_modules/y.js", V::Dependency),
            ("Node_Modules/y.js", V::Dependency),
            ("node_moduleſ/y.js", V::Dependency),
            (".mdbaſe/x", V::Private),
            ("", V::Empty),
        ];
        for (p, want) in bad {
            assert_eq!(check_path(p).as_ref(), Err(want), "{p:?}");
        }
        assert_eq!(check_path(&"a".repeat(256)), Err(V::SegmentTooLong));
        assert_eq!(check_path(&"a/".repeat(600)), Err(V::TooLong));
    }

    /// `reserved_name_eq` must agree with path-key comparison for the reserved
    /// names: no non-ASCII character folds to text that occurs in them, other
    /// than the two it maps.
    #[test]
    fn reserved_name_rule_covers_every_folding() {
        for name in ["node_modules", ".mdbase"] {
            for &(code, folded) in crate::unicode::fold_table() {
                if code < 0x80 || !folded.is_ascii() {
                    continue;
                }
                if matches!(code, 0x17f | 0x212a) {
                    continue;
                }
                assert!(
                    !name.contains(folded),
                    "U+{code:04X} folds to {folded:?}, inside {name}"
                );
            }
        }
        // Every single-character substitution that path keys equate is caught.
        for name in ["node_modules", ".mdbase"] {
            for (i, _) in name.char_indices() {
                for &(code, folded) in crate::unicode::fold_table() {
                    let Some(c) = char::from_u32(code) else {
                        continue;
                    };
                    if folded.chars().count() != 1 || !name[i..].starts_with(folded) {
                        continue;
                    }
                    let variant = format!("{}{c}{}", &name[..i], &name[i + folded.len()..]);
                    assert_eq!(path_key(&variant), name, "{variant}");
                    assert!(reserved_name_eq(&variant, name), "{variant}");
                }
            }
        }
    }

    #[test]
    fn path_policy_accepts_ordinary_paths() {
        for p in [
            "tasks/Call Bob.md",
            "mdbase.yaml",
            "_types/task.md",
            "_contracts/mdbase.view/1.0.0.md",
            "views/tasks.view.base",
            "Notes/Café.md",
            "日本/メモ.md",
            "a/b/c/d.md",
            "Call Bob (2).md",
            "CONTRACT.md",
            "com10.md",
            "console.md",
            "notes~/x.md",
            "~1.md",
            "draft~01.md",
            "x.mdbase",
            "😀 emoji.md",
            "a b/c d.md",
            "file.with.dots.md",
        ] {
            assert_eq!(check_path(p), Ok(()), "{p:?}");
        }
    }

    #[test]
    fn globs() {
        let g = |s: &str| Glob::new(s).unwrap();
        assert!(g("tasks/**/*.md").matches("tasks/a.md"));
        assert!(g("tasks/**/*.md").matches("tasks/x/y/a.md"));
        assert!(!g("tasks/**/*.md").matches("other/a.md"));
        assert!(!g("tasks/*.md").matches("tasks/x/a.md"));
        assert!(g("tasks/**").matches("tasks/x/a.md"));
        assert!(g("**").matches("a/b"));
        assert!(g("**/a.md").matches("a.md"));
        assert!(g("a/**/b/**/c").matches("a/x/b/y/z/c"));
        assert!(!g("a/**/b/**/c").matches("a/x/c"));
        assert!(g("t/?.md").matches("t/é.md"));
        assert!(g("t/[a-c].md").matches("t/b.md"));
        assert!(!g("t/[!a-c].md").matches("t/b.md"));
        assert!(g("t/[]a].md").matches("t/].md"));
        assert!(g("t/[a-].md").matches("t/-.md"));
        assert!(!g("Tasks/*.md").matches("tasks/a.md"));
        assert!(g("*a*b*").matches("xaybz"));
        assert!(!g("*a*b").matches("xaybz"));
        for bad in ["a**/b", "{a,b}", "a\\b", "t/[ab", "/a", "[z-a]"] {
            assert!(Glob::new(bad).is_err(), "{bad}");
        }
    }
}

// ------------------------------------------------------------- path policy

/// The longest collection path the policy accepts, in bytes.
pub const MAX_PATH_BYTES: usize = 1024;
/// The longest path segment the policy accepts, in bytes (common file system
/// limit).
pub const MAX_SEGMENT_BYTES: usize = 255;

/// Why a collection-relative path is not allowed (`intent.md` §3.7
/// namespace safety).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathViolation {
    /// The path is empty.
    Empty,
    /// Longer than [`MAX_PATH_BYTES`].
    TooLong,
    /// Starts with `/` (absolute, or a UNC prefix `//`).
    Absolute,
    /// Contains `\`, a separator on Windows.
    Backslash,
    /// An empty segment (`a//b`, trailing `/`).
    EmptySegment,
    /// A `.` or `..` segment.
    DotSegment,
    /// A segment longer than [`MAX_SEGMENT_BYTES`].
    SegmentTooLong,
    /// One of `<>:"|?*`. `:` also covers drive prefixes (`C:x`) and NTFS
    /// alternate data streams.
    ForbiddenCharacter(char),
    /// A control character (C0, DEL or C1).
    ControlCharacter,
    /// A code point that HFS+ ignores in names or that is invisible
    /// (`\u{200c}.git` names `.git` on HFS+).
    IgnorableCharacter,
    /// A segment ending in `.` or space, which Windows strips (`.mdbase.`).
    TrailingDotOrSpace,
    /// A Windows device name (`CON`, `NUL`, `COM1`, `LPT¹`, `CONIN$`, ...),
    /// with or without an extension.
    ReservedName,
    /// A segment shaped like an NTFS 8.3 short name (`GIT~1`), which can
    /// alias another entry such as `.git` or `.mdbase`.
    ShortNameAlias,
    /// In the replica's private namespace (`.mdbase`, compared by path key).
    Private,
    /// A dot-prefixed segment: hidden and tool state (`.obsidian`, `.git`,
    /// `.vscode`, ...), never collection content (spec 02, `intent.md` §3.7).
    Hidden,
    /// Dependency state (`node_modules`, spec 02 built-in exclusion).
    Dependency,
}

impl PathViolation {
    /// A stable reason string for diagnostics (`details.reason`).
    pub fn reason(&self) -> &'static str {
        match self {
            PathViolation::Empty => "empty_path",
            PathViolation::TooLong => "path_too_long",
            PathViolation::Absolute => "absolute_path",
            PathViolation::Backslash => "backslash",
            PathViolation::EmptySegment => "empty_segment",
            PathViolation::DotSegment => "dot_segment",
            PathViolation::SegmentTooLong => "segment_too_long",
            PathViolation::ForbiddenCharacter(_) => "forbidden_character",
            PathViolation::ControlCharacter => "control_character",
            PathViolation::IgnorableCharacter => "ignorable_character",
            PathViolation::TrailingDotOrSpace => "trailing_dot_or_space",
            PathViolation::ReservedName => "reserved_name",
            PathViolation::ShortNameAlias => "short_name_alias",
            PathViolation::Private => "private_namespace",
            PathViolation::Hidden => "hidden_path",
            PathViolation::Dependency => "dependency_path",
        }
    }
}

impl std::fmt::Display for PathViolation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PathViolation::ForbiddenCharacter(c) => write!(f, "path contains {c:?}"),
            other => f.write_str(other.reason()),
        }
    }
}

/// Whether `c` is invisible or ignored by HFS+ name comparison: zero-width
/// characters, bidirectional controls, deprecated format characters, word
/// joiners and the byte-order mark.
fn is_ignorable(c: char) -> bool {
    matches!(c as u32,
        0x00AD | 0x034F | 0x115F | 0x1160 | 0x17B4 | 0x17B5 | 0x180B..=0x180F
        | 0x200B..=0x200F | 0x202A..=0x202E | 0x2060..=0x206F | 0x3164 | 0xFE00..=0xFE0F
        | 0xFEFF | 0xFFA0 | 0xFFF0..=0xFFF8 | 0x1BCA0..=0x1BCA3 | 0x1D173..=0x1D17A
        | 0xE0000..=0xE0FFF)
}

/// A Windows device name, checked on the part of the segment before its first
/// `.` with trailing spaces removed, case-insensitively.
fn is_reserved_device(segment: &str) -> bool {
    let stem = segment
        .split('.')
        .next()
        .unwrap_or(segment)
        .trim_end_matches(' ');
    // The longest device stem is `CONOUT$` (7 bytes; `COM¹` is 5): most
    // segments are longer, so skip the allocations below.
    if stem.len() > 7 {
        return false;
    }
    let upper = stem.to_ascii_uppercase();
    if matches!(
        upper.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$" | "CLOCK$"
    ) {
        return true;
    }
    let mut chars = stem.chars();
    let prefix: String = chars
        .by_ref()
        .take(3)
        .collect::<String>()
        .to_ascii_uppercase();
    let rest: Vec<char> = chars.collect();
    (prefix == "COM" || prefix == "LPT")
        && rest.len() == 1
        && matches!(rest[0], '0'..='9' | '\u{b9}' | '\u{b2}' | '\u{b3}')
}

/// A segment shaped like an NTFS 8.3 short name: up to six characters, `~`,
/// a decimal number, and an optional extension of up to three characters
/// (`GIT~1`, `MDBASE~2.TXT`).
fn is_short_name(segment: &str) -> bool {
    let (name, ext) = match segment.rsplit_once('.') {
        Some((n, e)) if !n.is_empty() => (n, Some(e)),
        _ => (segment, None),
    };
    if ext.is_some_and(|e| e.chars().count() > 3) {
        return false;
    }
    let Some((base, num)) = name.rsplit_once('~') else {
        return false;
    };
    let base_len = base.chars().count();
    (1..=6).contains(&base_len)
        && !num.is_empty()
        && num.len() <= 6
        && num.bytes().all(|b| b.is_ascii_digit())
        && !num.starts_with('0')
}

/// Compare a segment with a reserved ASCII name, case-insensitively, by a
/// fixed rule that does not depend on Unicode tables (`check_path` is a
/// format-level void rule and must never change with the semantics version).
///
/// ASCII letters compare without case, and the only non-ASCII characters
/// whose full case folding is a single ASCII letter, U+017F LONG S (`s`) and
/// U+212A KELVIN SIGN (`k`), count as those letters. Other foldings to ASCII
/// are several letters (`ß` to `ss`, `ﬁ` to `fi`, `ﬅ` to `st`) that occur in
/// no reserved name, and NFC cannot apply because the names have no
/// decomposable characters. A test checks this against the case-folding table.
fn reserved_name_eq(segment: &str, ascii_lower: &str) -> bool {
    let mut want = ascii_lower.chars();
    for c in segment.chars() {
        let folded = match c {
            '\u{17f}' => 's',
            '\u{212a}' => 'k',
            c => c.to_ascii_lowercase(),
        };
        if want.next() != Some(folded) {
            return false;
        }
    }
    want.next().is_none()
}

/// Check a collection-relative path against the portable path policy and the
/// namespace rules (`intent.md` §3.7). Every replica applies it, at
/// submit, ingest and apply, to every record, resource and file path, so a
/// path either means the same safe thing on Linux, macOS (APFS, HFS+),
/// Windows (NTFS, Win32) and in an Obsidian vault, or it is rejected
/// everywhere.
///
/// The first violation, in segment order, is returned. Collisions under
/// case folding and NFC ([`path_key`]), configured exclusions and nested
/// collection roots depend on collection state and are checked by the caller.
pub fn check_path(path: &str) -> Result<(), PathViolation> {
    if path.is_empty() {
        return Err(PathViolation::Empty);
    }
    if path.len() > MAX_PATH_BYTES {
        return Err(PathViolation::TooLong);
    }
    if path.starts_with('/') {
        return Err(PathViolation::Absolute);
    }
    for (i, segment) in path.split('/').enumerate() {
        if segment.is_empty() {
            return Err(PathViolation::EmptySegment);
        }
        if segment == "." || segment == ".." {
            return Err(PathViolation::DotSegment);
        }
        if segment.len() > MAX_SEGMENT_BYTES {
            return Err(PathViolation::SegmentTooLong);
        }
        for c in segment.chars() {
            match c {
                '\\' => return Err(PathViolation::Backslash),
                '<' | '>' | ':' | '"' | '|' | '?' | '*' => {
                    return Err(PathViolation::ForbiddenCharacter(c));
                }
                c if c.is_control() => return Err(PathViolation::ControlCharacter),
                c if is_ignorable(c) => return Err(PathViolation::IgnorableCharacter),
                _ => {}
            }
        }
        if segment.ends_with('.') || segment.ends_with(' ') {
            return Err(PathViolation::TrailingDotOrSpace);
        }
        if is_reserved_device(segment) {
            return Err(PathViolation::ReservedName);
        }
        if is_short_name(segment) {
            return Err(PathViolation::ShortNameAlias);
        }
        if i == 0 && reserved_name_eq(segment, ".mdbase") {
            return Err(PathViolation::Private);
        }
        if segment.starts_with('.') {
            return Err(PathViolation::Hidden);
        }
        if reserved_name_eq(segment, "node_modules") {
            return Err(PathViolation::Dependency);
        }
    }
    Ok(())
}
