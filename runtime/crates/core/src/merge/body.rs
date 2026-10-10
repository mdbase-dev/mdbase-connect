//! The line-based body merge (spec 12A "Body") and `body_edits` (spec 12,
//! 12A "Body edits").

use std::collections::BTreeMap;

use super::diff::lcs_pairs;

/// Split `s` into lines, each ending with `\n` (a `\r\n` line keeps both), the
/// last possibly without a terminator. Lines compare exactly, terminators
/// included.
pub(crate) fn lines(s: &str) -> Vec<&str> {
    s.split_inclusive('\n').collect()
}

/// Three-way merge of bodies. `None` means the body is in conflict (the caller
/// keeps `first`).
///
/// 1. If `first == second` or `second == base` the result is `first`; if
///    `first == base` it is `second`.
/// 2. **Append-append:** when both begin with all of `base`, the result is
///    `base`, then `first`'s appended text, then `second`'s. When `base` is
///    not empty and lacks a final line terminator and both appended texts
///    begin with one, `second`'s leading terminator is dropped. A `\n` then
///    separates the two when `first`'s text does not end with a line
///    terminator and `second`'s does not begin with one, in the body's
///    line-ending style (`base`'s first terminator, else the appends'), so no
///    empty line appears and line endings never mix (rc.5 errata).
/// 3. Otherwise a three-way line merge (diff3) over the LCS alignment of `base`
///    with each side: chunks changed on one side take that side; chunks changed
///    identically on both take those lines; anything else is a conflict.
pub fn merge_body(base: &str, first: &str, second: &str) -> Option<String> {
    if first == second || second == base {
        return Some(first.to_owned());
    }
    if first == base {
        return Some(second.to_owned());
    }
    if let (Some(ft), Some(mut st)) = (first.strip_prefix(base), second.strip_prefix(base)) {
        let starts_line = |t: &str| t.starts_with('\n') || t.starts_with("\r\n");
        // A base without a final line terminator: when both appends start by
        // ending its last line, `first` already did, so drop `second`'s.
        if !base.is_empty() && !base.ends_with('\n') && starts_line(ft) {
            st = st
                .strip_prefix("\r\n")
                .or_else(|| st.strip_prefix('\n'))
                .unwrap_or(st);
        }
        let mut out = String::with_capacity(first.len() + st.len() + 1);
        out.push_str(first);
        if !ft.is_empty() && !ft.ends_with('\n') && !starts_line(st) {
            out.push_str(line_ending_style(&[base, ft, st]));
        }
        out.push_str(st);
        return Some(out);
    }
    diff3(&lines(base), &lines(first), &lines(second))
}

/// The style of the first line terminator in `texts`, in order (`\n` when
/// there is none), so an inserted separator never mixes line endings.
fn line_ending_style(texts: &[&str]) -> &'static str {
    for t in texts {
        if let Some(i) = t.find('\n') {
            return if i > 0 && t.as_bytes()[i - 1] == b'\r' {
                "\r\n"
            } else {
                "\n"
            };
        }
    }
    "\n"
}

/// Intern lines as integers so the diff compares `u32`s.
fn intern<'a>(table: &mut BTreeMap<&'a str, u32>, ls: &[&'a str]) -> Vec<u32> {
    ls.iter()
        .map(|l| {
            let next = u32::try_from(table.len()).unwrap_or(u32::MAX);
            *table.entry(l).or_insert(next)
        })
        .collect()
}

fn diff3(base: &[&str], first: &[&str], second: &[&str]) -> Option<String> {
    let mut table = BTreeMap::new();
    let (b, f, s) = (
        intern(&mut table, base),
        intern(&mut table, first),
        intern(&mut table, second),
    );
    // For each base line, its aligned line in each side (if any).
    let mut in_first = vec![None; b.len()];
    for (i, j) in lcs_pairs(&b, &f) {
        in_first[i] = Some(j);
    }
    let mut in_second = vec![None; b.len()];
    for (i, j) in lcs_pairs(&b, &s) {
        in_second[i] = Some(j);
    }
    let mut out = String::new();
    let (mut bi, mut fi, mut si) = (0usize, 0usize, 0usize);
    loop {
        // The next base line aligned with unchanged lines on both sides.
        let stable = (bi..b.len()).find(|&i| in_first[i].is_some() && in_second[i].is_some());
        let (bend, fend, send) = match stable {
            Some(i) => (i, in_first[i].unwrap_or(fi), in_second[i].unwrap_or(si)),
            None => (b.len(), f.len(), s.len()),
        };
        let (bc, fc, sc) = (&b[bi..bend], &f[fi..fend], &s[si..send]);
        let take = if fc == sc || sc == bc {
            &first[fi..fend]
        } else if fc == bc {
            &second[si..send]
        } else {
            return None;
        };
        for l in take {
            out.push_str(l);
        }
        match stable {
            None => return Some(out),
            Some(i) => {
                out.push_str(base[i]);
                bi = i + 1;
                fi = fend + 1;
                si = send + 1;
            }
        }
    }
}

/// One body edit: replace the Unicode scalar values `start..end` of the base
/// body with `insert` (intent.md `body-edit`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BodyEdit {
    /// Start offset, in Unicode scalar values of the base body.
    pub start: u64,
    /// End offset (exclusive).
    pub end: u64,
    /// The replacement text.
    pub insert: String,
}

/// What the engine knows about the base body of `body_edits`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyBase<'a> {
    /// The base body's text (from `body_base_text`, the current body when its
    /// digest matches `body_base`, or a retained copy).
    Text(&'a str),
    /// The engine has no copy of the base body.
    Unavailable,
}

/// Why `body_edits` could not be applied (spec 12).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BodyEditError {
    /// `invalid_request` or `concurrent_modification`.
    pub code: &'static str,
    /// `details.reason`: `offset_out_of_range`, `edits_overlap_or_unordered`,
    /// `body_conflict` or `body_base_unavailable`.
    pub reason: &'static str,
}

/// Apply `edits` to `base` (offsets in Unicode scalar values of `base`). Edits
/// must be in order and must not overlap; two insertions at one offset are
/// ambiguous and rejected.
pub fn apply_edits(base: &str, edits: &[BodyEdit]) -> Result<String, BodyEditError> {
    // Byte offset of every scalar boundary, so offsets map in O(1).
    let mut bounds: Vec<usize> = base.char_indices().map(|(i, _)| i).collect();
    bounds.push(base.len());
    let len = (bounds.len() - 1) as u64;
    let byte = |off: u64| {
        bounds[usize::try_from(off)
            .unwrap_or(usize::MAX)
            .min(bounds.len() - 1)]
    };
    let mut out = String::with_capacity(base.len());
    let mut prev_end = 0u64;
    let mut prev_insert_at: Option<u64> = None;
    for e in edits {
        if e.start > e.end || e.end > len {
            return Err(BodyEditError {
                code: "invalid_request",
                reason: "offset_out_of_range",
            });
        }
        if e.start < prev_end || (e.start == e.end && prev_insert_at == Some(e.start)) {
            return Err(BodyEditError {
                code: "invalid_request",
                reason: "edits_overlap_or_unordered",
            });
        }
        out.push_str(&base[byte(prev_end)..byte(e.start)]);
        out.push_str(&e.insert);
        prev_end = e.end;
        prev_insert_at = (e.start == e.end).then_some(e.start);
    }
    out.push_str(&base[byte(prev_end)..]);
    Ok(out)
}

/// Apply `body_edits` to a record whose body is `current` (spec 12, 12A).
///
/// When `current` is the base, the edits apply directly. Otherwise the edits
/// are applied to the base and the result merges with `current` by
/// [`merge_body`] (the current body first, so an append to the base lands after
/// a concurrent append); a conflict is `concurrent_modification` /
/// `body_conflict`, and a missing base is `body_base_unavailable`.
pub fn apply_body_edits(
    current: &str,
    base: BodyBase<'_>,
    edits: &[BodyEdit],
) -> Result<String, BodyEditError> {
    match base {
        BodyBase::Text(b) if b == current => apply_edits(current, edits),
        BodyBase::Text(b) => {
            let edited = apply_edits(b, edits)?;
            merge_body(b, current, &edited).ok_or(BodyEditError {
                code: "concurrent_modification",
                reason: "body_conflict",
            })
        }
        BodyBase::Unavailable => Err(BodyEditError {
            code: "concurrent_modification",
            reason: "body_base_unavailable",
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_rules() {
        assert_eq!(merge_body("a\n", "a\n", "b\n").as_deref(), Some("b\n"));
        assert_eq!(merge_body("a\n", "b\n", "a\n").as_deref(), Some("b\n"));
        assert_eq!(merge_body("a\n", "b\n", "b\n").as_deref(), Some("b\n"));
    }

    #[test]
    fn append_append() {
        assert_eq!(
            merge_body("a\n", "a\nb", "a\nc\n").as_deref(),
            Some("a\nb\nc\n")
        );
        assert_eq!(merge_body("", "x\n", "y\n").as_deref(), Some("x\ny\n"));
        // A base without a final line break (rc.5 errata).
        assert_eq!(
            merge_body("a", "a\nb\n", "a\nc\n").as_deref(),
            Some("a\nb\nc\n")
        );
        assert_eq!(merge_body("a", "a\nb", "a\nc").as_deref(), Some("a\nb\nc"));
        assert_eq!(merge_body("a", "ab", "a\nc").as_deref(), Some("ab\nc"));
        assert_eq!(merge_body("a", "ab", "ac").as_deref(), Some("ab\nc"));
        assert_eq!(
            merge_body("a", "a\r\nb\r\n", "a\r\nc\r\n").as_deref(),
            Some("a\r\nb\r\nc\r\n")
        );
        // The separator uses the body's line-ending style (rc.5 errata).
        assert_eq!(
            merge_body("a\r\n", "a\r\nb", "a\r\nc\r\n").as_deref(),
            Some("a\r\nb\r\nc\r\n")
        );
        assert_eq!(
            merge_body("a", "a\r\nb", "a\r\nc").as_deref(),
            Some("a\r\nb\r\nc")
        );
        assert_eq!(merge_body("", "x", "y\r\n").as_deref(), Some("x\r\ny\r\n"));
        assert_eq!(merge_body("", "x", "y").as_deref(), Some("x\ny"));
    }

    #[test]
    fn diff3_chunks() {
        let base = "1\n2\n3\n4\n5\n";
        assert_eq!(
            merge_body(base, "1x\n2\n3\n4\n5\n", "1\n2\n3\n4\n5x\n").as_deref(),
            Some("1x\n2\n3\n4\n5x\n")
        );
        assert_eq!(
            merge_body(base, "1\n2x\n3\n4\n5\n", "1\n2y\n3\n4\n5\n"),
            None
        );
        assert_eq!(
            merge_body(base, "1\n2x\n3\n4\n5\n", "1\n2x\n3\n4\n5\n").as_deref(),
            Some("1\n2x\n3\n4\n5\n")
        );
        // Deletion on one side, edit elsewhere on the other.
        assert_eq!(
            merge_body(base, "1\n3\n4\n5\n", "1\n2\n3\n4\n5\n6\n").as_deref(),
            Some("1\n3\n4\n5\n6\n")
        );
        // Adjacent changes with no stable line between them conflict (diff3).
        assert_eq!(merge_body("a\r\nb\r\n", "A\r\nb\r\n", "a\r\nB\r\n"), None);
        // CRLF lines compare with their terminators.
        assert_eq!(
            merge_body("a\r\n-\r\nb\r\n", "A\r\n-\r\nb\r\n", "a\r\n-\r\nB\r\n").as_deref(),
            Some("A\r\n-\r\nB\r\n")
        );
    }

    #[test]
    fn edits() {
        let e = |s, en, t: &str| BodyEdit {
            start: s,
            end: en,
            insert: t.into(),
        };
        assert_eq!(
            apply_edits("café 😀\nbar\n", &[e(7, 10, "baz")]).unwrap(),
            "café 😀\nbaz\n"
        );
        assert_eq!(
            apply_edits("abc", &[e(0, 0, "x"), e(3, 3, "y")]).unwrap(),
            "xabcy"
        );
        assert_eq!(
            apply_edits("abc", &[e(1, 2, ""), e(2, 2, "Z")]).unwrap(),
            "aZc"
        );
        assert_eq!(
            apply_edits("abc", &[e(2, 4, "")]).unwrap_err().reason,
            "offset_out_of_range"
        );
        assert_eq!(
            apply_edits("abc", &[e(2, 1, "")]).unwrap_err().reason,
            "offset_out_of_range"
        );
        assert_eq!(
            apply_edits("abc", &[e(1, 1, "a"), e(1, 1, "b")])
                .unwrap_err()
                .reason,
            "edits_overlap_or_unordered"
        );
    }
}
