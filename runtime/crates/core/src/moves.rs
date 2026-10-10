//! Move detection (spec 12A "Move Detection"): pair records that disappeared
//! with records that appeared within one observation window.
//!
//! A disappeared record `D` and an appeared record `A` are a candidate pair
//! under the first rule that holds:
//!
//! | Rank | Rule |
//! |---|---|
//! | 0 | `settings.id_field` is set and both hold the same non-empty string for it |
//! | 1 | identical bytes |
//! | 2 | the same file identity and similarity ≥ 0.5 |
//! | 3 | the same file name and similarity ≥ 0.8 |
//!
//! When both hold different non-empty `id_field` strings they never pair.
//! Candidates are chosen greedily by rank, then higher similarity, then smaller
//! `D` path, then smaller `A` path (code-point order). Similarity is the Jaccard
//! index of the sets of trimmed, non-empty lines, compared as exact fractions.

use std::cmp::Ordering;
use std::collections::BTreeSet;

use crate::doc::Document;
use crate::value::Value;

/// One observed record: its path, its bytes (the last observed for a
/// disappearance, the current for an appearance) and, when the platform has
/// one, a file identity that survives renames (device and inode, file ID).
#[derive(Debug, Clone, Copy)]
pub struct Observed<'a> {
    /// Collection-relative path.
    pub path: &'a str,
    /// Document source.
    pub content: &'a str,
    /// Platform file identity, if known.
    pub file_id: Option<&'a [u8]>,
}

/// A detected move.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Move {
    /// The path the record disappeared from.
    pub from: String,
    /// The path it appeared at.
    pub to: String,
}

/// The pairing result. All lists are sorted (moves by `from`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Moves {
    /// Moves (a record that moved, possibly also changed).
    pub moves: Vec<Move>,
    /// Disappearances left unpaired.
    pub deleted: Vec<String>,
    /// Appearances left unpaired.
    pub created: Vec<String>,
}

/// A Jaccard similarity as an exact fraction `num / den` (`1/1` for two empty
/// line sets).
#[derive(Debug, Clone, Copy)]
struct Similarity {
    num: u64,
    den: u64,
}

impl Similarity {
    fn at_least(self, num: u64, den: u64) -> bool {
        u128::from(self.num) * u128::from(den) >= u128::from(num) * u128::from(self.den)
    }
    fn cmp(self, other: Similarity) -> Ordering {
        (u128::from(self.num) * u128::from(other.den))
            .cmp(&(u128::from(other.num) * u128::from(self.den)))
    }
}

fn line_set(content: &str) -> BTreeSet<&str> {
    content
        .split('\n')
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect()
}

fn similarity(a: &BTreeSet<&str>, b: &BTreeSet<&str>) -> Similarity {
    if a.is_empty() && b.is_empty() {
        return Similarity { num: 1, den: 1 };
    }
    let inter = a.intersection(b).count() as u64;
    let union = (a.len() + b.len()) as u64 - inter;
    Similarity {
        num: inter,
        den: union,
    }
}

fn identity_hint(o: &Observed<'_>, id_field: Option<&str>) -> Option<String> {
    let field = id_field?;
    let doc = Document::parse_at(o.path, o.content);
    match doc.frontmatter().get(field) {
        Some(Value::Text(s)) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// Pair `disappeared` with `appeared` (spec 12A). `id_field` is
/// `settings.id_field`.
pub fn detect_moves(
    disappeared: &[Observed<'_>],
    appeared: &[Observed<'_>],
    id_field: Option<&str>,
) -> Moves {
    let d_info: Vec<_> = disappeared
        .iter()
        .map(|o| (identity_hint(o, id_field), line_set(o.content)))
        .collect();
    let a_info: Vec<_> = appeared
        .iter()
        .map(|o| (identity_hint(o, id_field), line_set(o.content)))
        .collect();
    // (rank, similarity, d index, a index)
    let mut candidates: Vec<(u8, Similarity, usize, usize)> = Vec::new();
    for (di, d) in disappeared.iter().enumerate() {
        for (ai, a) in appeared.iter().enumerate() {
            let sim = similarity(&d_info[di].1, &a_info[ai].1);
            let rank = match (&d_info[di].0, &a_info[ai].0) {
                (Some(x), Some(y)) if x == y => 0,
                (Some(_), Some(_)) => continue,
                _ if d.content == a.content => 1,
                _ if d.file_id.is_some() && d.file_id == a.file_id && sim.at_least(1, 2) => 2,
                _ if file_name(d.path) == file_name(a.path) && sim.at_least(4, 5) => 3,
                _ => continue,
            };
            candidates.push((rank, sim, di, ai));
        }
    }
    candidates.sort_by(|x, y| {
        x.0.cmp(&y.0)
            .then_with(|| y.1.cmp(x.1))
            .then_with(|| disappeared[x.2].path.cmp(disappeared[y.2].path))
            .then_with(|| appeared[x.3].path.cmp(appeared[y.3].path))
            .then_with(|| x.2.cmp(&y.2))
            .then_with(|| x.3.cmp(&y.3))
    });
    let mut used_d = vec![false; disappeared.len()];
    let mut used_a = vec![false; appeared.len()];
    let mut out = Moves::default();
    for (_, _, di, ai) in candidates {
        if used_d[di] || used_a[ai] {
            continue;
        }
        used_d[di] = true;
        used_a[ai] = true;
        out.moves.push(Move {
            from: disappeared[di].path.to_owned(),
            to: appeared[ai].path.to_owned(),
        });
    }
    out.moves.sort();
    out.deleted = disappeared
        .iter()
        .zip(&used_d)
        .filter(|(_, u)| !**u)
        .map(|(o, _)| o.path.to_owned())
        .collect();
    out.deleted.sort();
    out.created = appeared
        .iter()
        .zip(&used_a)
        .filter(|(_, u)| !**u)
        .map(|(o, _)| o.path.to_owned())
        .collect();
    out.created.sort();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn o<'a>(path: &'a str, content: &'a str, id: Option<&'a [u8]>) -> Observed<'a> {
        Observed {
            path,
            content,
            file_id: id,
        }
    }

    #[test]
    fn exact_similarity_thresholds() {
        // 4 of 5 lines shared (union 6): 0.666… < 0.8, ≥ 0.5.
        let a = "1\n2\n3\n4\n5\n";
        let b = "1\n2\n3\n4\nx\n";
        let r = detect_moves(&[o("n/a.md", a, None)], &[o("m/a.md", b, None)], None);
        assert!(r.moves.is_empty());
        let r = detect_moves(
            &[o("n/a.md", a, Some(b"f"))],
            &[o("m/b.md", b, Some(b"f"))],
            None,
        );
        assert_eq!(r.moves.len(), 1);
        // Exactly 0.8: 4 shared, union 5.
        let r = detect_moves(
            &[o("n/a.md", "1\n2\n3\n4\n", None)],
            &[o("m/a.md", "1\n2\n3\n4\n5\n", None)],
            None,
        );
        assert_eq!(r.moves.len(), 1);
    }

    #[test]
    fn empty_files_are_similar() {
        let r = detect_moves(
            &[o("a.md", "", Some(b"1"))],
            &[o("b.md", " \n", Some(b"1"))],
            None,
        );
        assert_eq!(r.moves.len(), 1);
    }
}
