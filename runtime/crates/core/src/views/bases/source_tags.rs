//! Named1.12.7 plain-tag domain. Rich unqualified Markdown remains unavailable,
//! never known-empty. Body tags precede frontmatter tags; first exact occurrence
//! wins (case preserved). This is capture data, not permission or membership SQL.
use super::{EvaluationFailure, MAX_CAPTURE_ITEMS, WorkBudget};
use crate::{doc::Document, value::Value};
/// Version to bind into derived raw-projection generations.
pub const BASES_TAG_CAPTURE_VERSION: u8 = 4;
/// Extract a qualified complete tag observation or explicit unavailable(None).
/// Supports simple ASCII inline/nested tags and well-formed single-line wiki
/// links (including heading fragments/aliases), single-line code spans, fenced
/// code and literal `[ ] `, `[x] ` and `[X] ` markers. Numeric-only body references
/// are not tags. Other tag-bearing Markdown and
/// Unicode-tag spellings remain unavailable pending native qualification.
pub fn capture_source_tags(
    document: &Document,
    budget: &mut WorkBudget,
) -> Result<Option<Vec<String>>, EvaluationFailure> {
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
    let value = document.frontmatter().get("tags");
    let values = match value {
        None | Some(Value::Null) => &[][..],
        Some(Value::Text(_)) => std::slice::from_ref(value.expect("tag value")),
        Some(Value::List(values)) => values.as_slice(),
        _ => return Ok(None),
    };
    if values.len() > MAX_CAPTURE_ITEMS {
        return Err(EvaluationFailure::BudgetExceeded("file_tag_count"));
    }
    for value in values {
        let Some(tag) = value.as_str() else {
            return Ok(None);
        };
        let tag = tag.strip_prefix('#').unwrap_or(tag);
        if !budget.charge((tag.len() as u64).saturating_mul(2).saturating_add(1), 0) {
            return Err(budget.failure().expect("raw tag validation"));
        }
        if tag.is_empty()
            || !tag.bytes().all(tag_byte)
            || !tag.bytes().any(|c| c.is_ascii_alphabetic())
        {
            return Ok(None);
        }
    }
    let mut complex = false;
    let mut possible = false;
    let mut cursor = 0;
    while cursor < body.len() {
        let tail = &body[cursor..];
        if (cursor == 0 || body.as_bytes()[cursor - 1] == b'\n')
            && let Some(end) = fence_end(tail, budget)?
        {
            cursor += end;
            continue;
        }
        if tail.starts_with('`')
            && !escaped(body, cursor)
            && let Some(end) = inline_code_end(tail, budget)?
        {
            cursor += end;
            continue;
        }
        if tail.starts_with("[[") {
            let Some(end) = wiki_end(tail) else {
                return Ok(None);
            };
            cursor += end;
            continue;
        }
        // These exact markers contain no tag spelling and do not hide following
        // text. Native12 repeated cases qualify body/FM tags, including real
        // perf-corpus checklists. Do NOT relax links/references/nested brackets.
        if tail.starts_with("[ ] ") || tail.starts_with("[x] ") || tail.starts_with("[X] ") {
            cursor += 3;
            continue;
        }
        let c = tail.chars().next().expect("nonempty tail");
        complex |= matches!(c, '`' | '\\' | '<' | '[' | ']' | '*' | '~' | '>' | '$');
        possible |= c == '#' && possible_tag(&tail[1..]);
        cursor += if c == '`' {
            tail.bytes().take_while(|c| *c == b'`').count()
        } else {
            c.len_utf8()
        };
    }
    if complex && possible {
        return Ok(None);
    }
    let mut output = Vec::new();
    let mut copied_bytes = 0;
    let mut occurrences = values.len();
    cursor = 0;
    while cursor < body.len() {
        let tail = &body[cursor..];
        if (cursor == 0 || body.as_bytes()[cursor - 1] == b'\n')
            && let Some(end) = fence_end(tail, budget)?
        {
            cursor += end;
            continue;
        }
        if tail.starts_with('`')
            && !escaped(body, cursor)
            && let Some(end) = inline_code_end(tail, budget)?
        {
            cursor += end;
            continue;
        }
        if tail.starts_with("[[") {
            cursor += wiki_end(tail).expect("preflight wiki");
            continue;
        }
        let c = tail.chars().next().expect("nonempty tail");
        if c != '#' {
            cursor += if c == '`' {
                tail.bytes().take_while(|c| *c == b'`').count()
            } else {
                c.len_utf8()
            };
            continue;
        }
        let start = cursor + 1;
        let length = body[start..].bytes().take_while(|c| tag_byte(*c)).count();
        let end = start + length;
        if body[end..]
            .chars()
            .next()
            .is_some_and(|c| !c.is_ascii() && c.is_alphanumeric())
        {
            return Ok(None);
        }
        let boundary = cursor == 0
            || body[..cursor]
                .chars()
                .next_back()
                .is_some_and(char::is_whitespace);
        if boundary && length > 0 {
            let tag = &body[start..end];
            if tag.bytes().any(|c| c.is_ascii_alphabetic()) {
                occurrences += 1;
                if occurrences > MAX_CAPTURE_ITEMS {
                    return Err(EvaluationFailure::BudgetExceeded("file_tag_count"));
                }
                push(&mut output, &mut copied_bytes, tag, budget)?;
            } else if !tag.bytes().all(|c| c.is_ascii_digit()) {
                return Ok(None);
            }
        }
        cursor = end;
    }
    for value in values {
        let tag = value.as_str().expect("qualified tag");
        push(
            &mut output,
            &mut copied_bytes,
            tag.strip_prefix('#').unwrap_or(tag),
            budget,
        )?;
    }
    Ok(Some(output))
}
fn tag_byte(c: u8) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b'/')
}
// Numeric references cannot be tags, even beside otherwise rich Markdown.
fn possible_tag(tail: &str) -> bool {
    let length = tail.bytes().take_while(|c| tag_byte(*c)).count();
    tail[..length].bytes().any(|c| !c.is_ascii_digit())
        || tail[length..]
            .chars()
            .next()
            .is_some_and(|c| !c.is_ascii() && c.is_alphanumeric())
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
    let end = tail[2..].find("]]")? + 2;
    let inside = &tail[2..end];
    if inside.contains(['[', '\n', '\r']) {
        return None;
    }
    Some(end + 2)
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
