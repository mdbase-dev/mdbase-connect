//! Named1.12.7 tag domain. A tag has to be spelled in the source, so absence is
//! provable from spelling alone; presence needs Markdown structure this scan
//! does not fully model. Rows therefore carry every possible spelling and say
//! whether that set is exact. Body tags precede frontmatter tags; first exact
//! occurrence wins (case preserved). This is capture data, not permission or
//! membership SQL.
use super::{EvaluationFailure, MAX_CAPTURE_ITEMS, WorkBudget};
use crate::{doc::Document, value::Value};
/// Version to bind into derived raw-projection generations.
pub const BASES_TAG_CAPTURE_VERSION: u8 = 5;
/// A document's tags, or a bound on them. `spellings` always includes every tag
/// the document has, so a name absent from it is a known non-match. When not
/// exact, a spelling may be no tag at all, and matching one decides nothing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceTags {
    spellings: Vec<String>,
    exact: bool,
}
impl SourceTags {
    /// The document's complete tag set.
    pub fn exact(spellings: Vec<String>) -> Self {
        Self {
            spellings,
            exact: true,
        }
    }
    /// A superset of the document's tags.
    pub fn bounded(spellings: Vec<String>) -> Self {
        Self {
            spellings,
            exact: false,
        }
    }
    /// Every possible tag, `#`-prefixed.
    pub fn spellings(&self) -> &[String] {
        &self.spellings
    }
    /// Whether [`Self::spellings`] is the complete tag set.
    pub fn is_exact(&self) -> bool {
        self.exact
    }
    /// The complete tag set, when it is known.
    pub fn known(&self) -> Option<&[String]> {
        self.exact.then_some(self.spellings.as_slice())
    }
}
/// Bound a document's tags, or `None` when its source cannot be read at all.
///
/// A `#` run is a tag when it follows whitespace or the start of the body, has
/// a non-digit, and is not hidden by code, a wiki link, HTML, math or a link
/// destination. Plain text before the `#` rules a tag out in any Markdown. The
/// remaining positions, such as after emphasis delimiters, depend on inline
/// parsing, so their spellings are kept and the result is not exact.
pub fn capture_source_tags(
    document: &Document,
    budget: &mut WorkBudget,
) -> Result<Option<SourceTags>, EvaluationFailure> {
    if let Some(failure) = budget.failure() {
        return Err(failure);
    }
    if document.problem().is_some() {
        return Ok(None);
    }
    let body = document.body();
    if !budget.charge((body.len() as u64).saturating_mul(2), 0) {
        return Err(budget.failure().expect("tag scan"));
    }
    let mut exact = true;
    let mut raw = Vec::new();
    // Native key matching ignores case; only the exact key is qualified here.
    for (key, value) in document.frontmatter().iter() {
        if !key.eq_ignore_ascii_case("tags") {
            continue;
        }
        exact &= key == "tags";
        let values = match value {
            Value::Null => &[][..],
            Value::Text(_) => std::slice::from_ref(value),
            Value::List(values) => values.as_slice(),
            _ => {
                exact = false;
                continue;
            }
        };
        if raw.len() + values.len() > MAX_CAPTURE_ITEMS {
            return Err(EvaluationFailure::BudgetExceeded("file_tag_count"));
        }
        for value in values {
            let Some(tag) = value.as_str() else {
                exact = false;
                continue;
            };
            if !budget.charge((tag.len() as u64).saturating_mul(2).saturating_add(1), 0) {
                return Err(budget.failure().expect("raw tag validation"));
            }
            let plain = tag.strip_prefix('#').unwrap_or(tag);
            exact &= !plain.is_empty()
                && plain.bytes().all(tag_byte)
                && plain.bytes().any(|c| c.is_ascii_alphabetic());
            let tag = tag.trim_start_matches('#');
            if !tag.is_empty() {
                raw.push(tag);
            }
        }
    }
    let mut output = Vec::new();
    let mut copied_bytes = 0;
    let mut occurrences = raw.len();
    let mut add = |tag: &str, output: &mut Vec<String>, budget: &mut WorkBudget| {
        occurrences += 1;
        if occurrences > MAX_CAPTURE_ITEMS {
            return Err(EvaluationFailure::BudgetExceeded("file_tag_count"));
        }
        push(output, &mut copied_bytes, tag, budget)
    };
    // `#` before this offset may be hidden or revealed by unmodelled Markdown.
    let mut unsure_until = 0;
    let mut prose = false;
    // A run directly after a tag starts a tag without a space: `#a#b`.
    let mut last_tag = None;
    let mut cursor = 0;
    while cursor < body.len() {
        let tail = &body[cursor..];
        if cursor == 0 || body.as_bytes()[cursor - 1] == b'\n' {
            if let Some(end) = fence_end(tail, budget)? {
                cursor += end;
                prose = false;
                continue;
            }
            let line = line_shape(tail.split('\n').next().expect("line"), prose);
            prose = line.prose;
            unsure_until = unsure_until.max(match line.unsure {
                Unsure::No => 0,
                Unsure::Line => cursor + tail.find('\n').unwrap_or(tail.len()),
                Unsure::Paragraph => cursor + paragraph_end(tail),
                Unsure::Rest => body.len(),
            });
        }
        let settled = cursor >= unsure_until;
        if tail.starts_with('`') {
            if settled
                && !escaped(body, cursor)
                && let Some(end) = inline_code_end(tail, budget)?
            {
                cursor += end;
                continue;
            }
            // An unmatched run can still close on a later line of this paragraph.
            unsure_until = unsure_until.max(cursor + paragraph_end(tail));
            cursor += tail.bytes().take_while(|c| *c == b'`').count();
            continue;
        }
        if settled && tail.starts_with("[[") {
            if let Some(end) = wiki_end(tail) {
                cursor += end;
            } else {
                unsure_until = cursor + tail.find('\n').unwrap_or(tail.len());
                cursor += 2;
            }
            continue;
        }
        let c = tail.chars().next().expect("nonempty tail");
        if settled {
            unsure_until = unsure_until.max(match c {
                ']' if tail.starts_with("](") => link_tail_end(&tail[1..])
                    .map_or(cursor + paragraph_end(tail), |end| cursor + 1 + end),
                '<' => cursor + html_end(tail),
                '$' if tail.starts_with("$$") => body.len(),
                '$' if !tail[1..].starts_with(char::is_whitespace) => cursor + paragraph_end(tail),
                _ => 0,
            });
        }
        if c != '#' {
            cursor += c.len_utf8();
            continue;
        }
        let start = cursor + 1;
        let tag = tag_run(&body[start..]);
        let end = start + tag.len();
        let after_tag = last_tag.filter(|(tag_end, _)| *tag_end == cursor);
        let before = body[..cursor].chars().next_back();
        if tag.is_empty()
            || tag.bytes().all(|c| c.is_ascii_digit())
            || (after_tag.is_none() && before.is_some_and(plain_text))
        {
            cursor = end;
            continue;
        }
        let mut sure = cursor >= unsure_until
            && after_tag.map_or(before.is_none_or(native_space), |(_, sure)| sure);
        // A `_` that is not intraword may close emphasis and end the tag there.
        for (index, _) in tag.match_indices('_') {
            let intraword = tag[index + 1..].starts_with(char::is_alphanumeric);
            let prefix = &tag[..index];
            if !intraword {
                sure = false;
                if !prefix.bytes().all(|c| c.is_ascii_digit()) {
                    add(prefix, &mut output, budget)?;
                }
            }
        }
        add(tag, &mut output, budget)?;
        exact &= sure;
        last_tag = Some((end, sure));
        cursor = end;
    }
    for tag in raw {
        push(&mut output, &mut copied_bytes, tag, budget)?;
    }
    Ok(Some(SourceTags {
        spellings: output,
        exact,
    }))
}
fn tag_byte(c: u8) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b'/')
}
// ECMAScript `\s`, the separator set of the native tag grammar.
fn native_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}
// A delimiter can open a text node and start a tag; these characters cannot.
fn plain_text(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '/' | '#' | '(')
}
// The native spelling: `#[^\u2000-\u206F\u2E00-\u2E7F'!"#$%&()*+,.:;<=>?@^`{|}~\[\]\\\s]+`.
fn tag_run(tail: &str) -> &str {
    let end = tail
        .find(|c| {
            native_space(c)
                || matches!(c, '\u{2000}'..='\u{206f}' | '\u{2e00}'..='\u{2e7f}'
                    | '\'' | '!' | '"' | '#' | '$' | '%' | '&' | '(' | ')' | '*' | '+' | ','
                    | '.' | ':' | ';' | '<' | '=' | '>' | '?' | '@' | '^' | '`' | '{' | '|'
                    | '}' | '~' | '[' | ']' | '\\')
        })
        .unwrap_or(tail.len());
    &tail[..end]
}
enum Unsure {
    No,
    Line,
    Paragraph,
    Rest,
}
struct LineShape {
    prose: bool,
    unsure: Unsure,
}
// Indented code cannot interrupt a paragraph, so an indented line is only
// settled directly after prose. Containers can also hold code and fences that
// the line-start checks do not see.
fn line_shape(line: &str, after_prose: bool) -> LineShape {
    let line = line.trim_end_matches('\r');
    let mut text = line;
    let mut contained = false;
    let mut quoted = false;
    let mut indented = false;
    loop {
        let rest = text.trim_start_matches(' ');
        let indent = text.len() - rest.len();
        if rest.starts_with('\t') || indent >= 4 + usize::from(contained) {
            if contained {
                return LineShape {
                    prose: false,
                    unsure: Unsure::Line,
                };
            }
            indented = true;
        }
        text = rest.trim_start();
        if let Some(rest) = text.strip_prefix('>') {
            (contained, quoted) = (true, true);
            text = rest;
        } else if let Some(rest) = list_marker(text) {
            contained = true;
            text = rest;
        } else {
            break;
        }
    }
    let code = indented && !after_prose;
    LineShape {
        prose: !code
            && !quoted
            && !text.starts_with(['#', '|', '<'])
            && text.chars().any(char::is_alphanumeric),
        unsure: if contained && (text.starts_with("```") || text.starts_with("~~~")) {
            Unsure::Rest
        } else if text.starts_with('[') && text.contains("]:") {
            Unsure::Paragraph
        } else if code {
            Unsure::Line
        } else {
            Unsure::No
        },
    }
}
fn list_marker(text: &str) -> Option<&str> {
    let digits = text.bytes().take_while(u8::is_ascii_digit).count();
    let rest = if digits == 0 {
        text.strip_prefix(['-', '*', '+'])?
    } else {
        text[digits..].strip_prefix(['.', ')'])?
    };
    (rest.is_empty() || rest.starts_with([' ', '\t'])).then_some(rest)
}
// Offset of the blank line that ends this paragraph, or the end of the text.
fn paragraph_end(tail: &str) -> usize {
    let mut offset = tail.find('\n').map_or(tail.len(), |n| n + 1);
    for line in tail[offset..].split_inclusive('\n') {
        if line.trim().is_empty() {
            break;
        }
        offset += line.len();
    }
    offset
}
// Where raw HTML starting at `<` may stop hiding text, or 0 when it is not HTML.
// Comments and raw blocks survive blank lines; other blocks end at one.
fn html_end(tail: &str) -> usize {
    let name = tail[1..].split(|c: char| !c.is_ascii_alphanumeric()).next();
    let raw = name.is_some_and(|name| {
        ["pre", "script", "style", "textarea"]
            .iter()
            .any(|raw| name.eq_ignore_ascii_case(raw))
    });
    match tail[1..].chars().next() {
        Some('!') if tail.starts_with("<!--") => tail.find("-->").map_or(tail.len(), |end| end + 3),
        Some('!' | '?') => tail.len(),
        Some(_) if raw => tail.len(),
        Some(c) if c.is_ascii_alphabetic() || c == '/' => paragraph_end(tail),
        _ => 0,
    }
}
fn scan_work(length: usize, budget: &mut WorkBudget) -> Result<(), EvaluationFailure> {
    if !budget.charge(length as u64, 0) {
        return Err(budget.failure().expect("code scan"));
    }
    Ok(())
}
// CommonMark fences: up to three leading spaces, backticks or tildes,
// optional info string, closing run at least as long. An unclosed fence
// consumes the remainder; its contents are still code, not unknown tags.
fn fence_end(tail: &str, budget: &mut WorkBudget) -> Result<Option<usize>, EvaluationFailure> {
    let opening = tail
        .split('\n')
        .next()
        .expect("line")
        .trim_end_matches('\r');
    let marker = opening.trim_start_matches(' ');
    if opening.len() - marker.len() > 3 {
        return Ok(None);
    }
    let Some(first @ (b'`' | b'~')) = marker.bytes().next() else {
        return Ok(None);
    };
    let count = marker.bytes().take_while(|c| *c == first).count();
    if count < 3 || (first == b'`' && marker[count..].contains('`')) {
        return Ok(None);
    }
    let mut end = tail.find('\n').map_or(tail.len(), |n| n + 1);
    for line in tail[end..].split_inclusive('\n') {
        scan_work(line.len(), budget)?;
        end += line.len();
        let text = line.trim_end_matches(['\r', '\n']);
        let trimmed = text.trim_start_matches(' ');
        if text.len() - trimmed.len() <= 3 {
            let run = trimmed.bytes().take_while(|c| *c == first).count();
            if run >= count && trimmed[run..].bytes().all(|c| matches!(c, b' ' | b'\t')) {
                return Ok(Some(end));
            }
        }
    }
    Ok(Some(tail.len()))
}
fn escaped(body: &str, cursor: usize) -> bool {
    body.as_bytes()[..cursor]
        .iter()
        .rev()
        .take_while(|c| **c == b'\\')
        .count()
        % 2
        == 1
}
// Inline code closes only on an equally long backtick run. Longer/shorter
// runs are content. Multiline/unmatched delimiters stay conservative: do not
// accidentally span a Markdown block boundary and hide a real tag.
fn inline_code_end(
    tail: &str,
    budget: &mut WorkBudget,
) -> Result<Option<usize>, EvaluationFailure> {
    let tail = tail.split('\n').next().expect("line");
    let count = tail.bytes().take_while(|c| *c == b'`').count();
    if count == 0 {
        return Ok(None);
    }
    let mut cursor = count;
    while cursor < tail.len() {
        let gap = tail[cursor..].find('`').unwrap_or(tail.len() - cursor);
        scan_work(gap + 1, budget)?;
        cursor += gap;
        let run = tail[cursor..].bytes().take_while(|c| *c == b'`').count();
        scan_work(run, budget)?;
        cursor += run;
        if run == count {
            return Ok(Some(cursor));
        }
    }
    Ok(None)
}
fn wiki_end(tail: &str) -> Option<usize> {
    let tail = tail.split('\n').next().expect("line");
    let end = tail[2..].find("]]")? + 2;
    let inside = &tail[2..end];
    if inside.contains(['[', '\r']) {
        return None;
    }
    Some(end + 2)
}
// End of a single-line inline link tail starting at `(`, per CommonMark's
// destination and title grammar. `None` when this is not one, or may continue.
fn link_tail_end(tail: &str) -> Option<usize> {
    let line = tail.split('\n').next().expect("line").as_bytes();
    let spaces = |mut at: usize| {
        while line.get(at).is_some_and(|c| matches!(c, b' ' | b'\t')) {
            at += 1;
        }
        at
    };
    let mut at = spaces(1);
    if line.get(at) == Some(&b'<') {
        at += 1;
        while *line.get(at)? != b'>' {
            at += if line[at] == b'\\' { 2 } else { 1 };
        }
        at += 1;
    } else {
        let mut depth = 0usize;
        while let Some(c) = line.get(at) {
            match c {
                b'\\' => at += 1,
                b'(' => depth += 1,
                b')' if depth == 0 => break,
                b')' => depth -= 1,
                b' ' | b'\t' => break,
                _ => {}
            }
            at += 1;
        }
    }
    let mut next = spaces(at);
    if next > at
        && let Some(close) = match line.get(next) {
            Some(b'"') => Some(b'"'),
            Some(b'\'') => Some(b'\''),
            Some(b'(') => Some(b')'),
            _ => None,
        }
    {
        next += 1;
        while *line.get(next)? != close {
            next += if line[next] == b'\\' { 2 } else { 1 };
        }
        next = spaces(next + 1);
    }
    (*line.get(next)? == b')').then_some(next + 1)
}
fn push(
    output: &mut Vec<String>,
    copied_bytes: &mut usize,
    tag: &str,
    budget: &mut WorkBudget,
) -> Result<(), EvaluationFailure> {
    if tag.len() > 4095 {
        return Err(EvaluationFailure::BudgetExceeded("file_tag_bytes"));
    }
    for present in output.iter() {
        if !budget.charge((1 + present.len() + tag.len()) as u64, 0) {
            return Err(budget.failure().expect("tag dedup"));
        }
        if &present[1..] == tag {
            return Ok(());
        }
    }
    let bytes = *copied_bytes + tag.len() + 1;
    if bytes > 65_536 {
        return Err(EvaluationFailure::BudgetExceeded("file_tag_bytes"));
    }
    if !budget.charge(
        (tag.len() + 1) as u64,
        (std::mem::size_of::<String>() + tag.len() + 1) as u64,
    ) {
        return Err(budget.failure().expect("tag copy"));
    }
    *copied_bytes = bytes;
    output.push(format!("#{tag}"));
    Ok(())
}
#[cfg(test)]
mod tests;
