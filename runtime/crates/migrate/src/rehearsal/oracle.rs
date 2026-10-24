//! The gate-2 oracle (migration verification).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use super::ledger::{Outcome, Row};
use crate::{Error, Result};

/// Where the oracle looks for the final state.
pub trait FinalState {
    /// The field's current value in the record at `path`, if the record and the field
    /// exist.
    fn field(&mut self, path: &str, field: &str) -> Option<String>;
    /// Whether `needle` occurs in any held or conflict-kept version of `path` (or, for
    /// un-uploaded edits, any file). Holds keep the user's bytes, so a superseded value
    /// can live there.
    fn kept(&mut self, path: &str, needle: &str) -> bool;
}

/// A violation of the gate.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Violation {
    /// An acknowledged write is neither visible, superseded nor kept.
    LostAck {
        /// The ledger row.
        row: Row,
        /// What the field holds now.
        found: Option<String>,
    },
    /// A must-survive edit is nowhere.
    LostUserBytes {
        /// The ledger row.
        row: Row,
    },
}

/// The verdict.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Verdict {
    /// Acknowledged writes checked.
    pub acked: u64,
    /// Must-survive edits checked.
    pub must_survive: u64,
    /// Rows not checked (refused or unknown outcome).
    pub not_acked: u64,
    /// Violations. Gate 2 needs this empty, plus non-vacuous write evidence.
    pub violations: Vec<Violation>,
}

impl Verdict {
    /// Whether both acknowledged writes and must-survive user edits were exercised.
    /// Refused/unknown-outcome writes alone do not provide either kind of evidence.
    pub fn has_required_evidence(&self) -> bool {
        self.acked > 0 && self.must_survive > 0
    }

    /// A non-vacuous per-scenario loss check: some checked writes and no losses.
    /// Individual scenarios may exercise only one outcome. The aggregate CLI also
    /// requires `has_required_evidence`; neither certifies scenario/backend coverage
    /// or proves that an actual migration ran.
    pub fn green(&self) -> bool {
        (self.acked > 0 || self.must_survive > 0) && self.violations.is_empty()
    }
}

/// Check a ledger against the final state.
///
/// For each `(path, field)`, the **latest** acknowledged value (by `order`) must be the
/// field's value, or kept in a hold or conflict. An earlier acknowledged value counts as
/// superseded only if a later acknowledged write to the same field exists. Writers use
/// their own fields, so concurrent writers never supersede each other. Must-survive rows
/// must be found as the value or kept.
pub fn check(rows: &[Row], state: &mut dyn FinalState) -> Verdict {
    let mut v = Verdict::default();
    let mut latest: BTreeMap<(&str, &str), &Row> = BTreeMap::new();
    for r in rows {
        match r.outcome {
            Outcome::Acked => {
                v.acked += 1;
                let e = latest.entry((&r.path, &r.field)).or_insert(r);
                if r.order > e.order {
                    *e = r;
                }
            }
            Outcome::MustSurvive => {
                v.must_survive += 1;
                let now = state.field(&r.path, &r.field);
                if now.as_deref() != Some(r.value.as_str()) && !state.kept(&r.path, &r.value) {
                    v.violations
                        .push(Violation::LostUserBytes { row: r.clone() });
                }
            }
            Outcome::NotAcked => v.not_acked += 1,
        }
    }
    for r in latest.values() {
        let now = state.field(&r.path, &r.field);
        if now.as_deref() != Some(r.value.as_str()) && !state.kept(&r.path, &r.value) {
            v.violations.push(Violation::LostAck {
                row: (*r).clone(),
                found: now,
            });
        }
    }
    v
}

/// The final state as plain files: the collection folder, plus directories of
/// held/kept versions (the daemon's hold stash, conflict exports).
pub struct FolderState {
    root: PathBuf,
    kept_dirs: Vec<PathBuf>,
    renames: BTreeMap<String, String>,
    cache: BTreeMap<String, Option<String>>,
}

impl FolderState {
    /// The folder at `root`, with kept versions under `kept_dirs` (searched by
    /// content).
    pub fn new(root: &Path, kept_dirs: &[PathBuf]) -> Self {
        Self {
            root: root.to_path_buf(),
            kept_dirs: kept_dirs.to_vec(),
            renames: BTreeMap::new(),
            cache: BTreeMap::new(),
        }
    }

    /// Follow the migration's reported renames (old path → new path, from
    /// `preflight::Resolved::renames`): a ledger row for an old path is checked at its
    /// new path. A renamed record that isn't there counts as a lost write.
    pub fn with_renames(mut self, renames: BTreeMap<String, String>) -> Self {
        self.renames = renames;
        self
    }

    fn doc(&mut self, path: &str) -> Option<String> {
        let path = self
            .renames
            .get(path)
            .map_or(path, String::as_str)
            .to_owned();
        let path = path.as_str();
        let root = self.root.clone();
        self.cache
            .entry(path.to_owned())
            .or_insert_with(|| std::fs::read_to_string(root.join(path)).ok())
            .clone()
    }
}

/// The value of a top-level `key: value` frontmatter line (`"…"` unquoted). The
/// synthetic writers only write such lines.
pub fn frontmatter_field(doc: &str, key: &str) -> Option<String> {
    let rest = doc.strip_prefix("---\n")?;
    let end = rest.find("\n---")?;
    rest[..end].lines().find_map(|l| {
        let v = l.strip_prefix(key)?.strip_prefix(':')?.trim();
        Some(v.trim_matches('"').to_owned())
    })
}

impl FinalState for FolderState {
    fn field(&mut self, path: &str, field: &str) -> Option<String> {
        frontmatter_field(&self.doc(path)?, field)
    }

    fn kept(&mut self, _path: &str, needle: &str) -> bool {
        fn walk(dir: &Path, needle: &str) -> bool {
            let Ok(entries) = std::fs::read_dir(dir) else {
                return false;
            };
            entries.flatten().any(|e| {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, needle)
                } else {
                    std::fs::read(&p)
                        .is_ok_and(|b| b.windows(needle.len()).any(|w| w == needle.as_bytes()))
                }
            })
        }
        !needle.is_empty() && self.kept_dirs.iter().any(|d| walk(d, needle))
    }
}

/// Check a ledger file against a folder. Convenience for the `rehearse check` command.
pub fn check_folder(ledger: &Path, root: &Path, kept_dirs: &[PathBuf]) -> Result<Verdict> {
    check_folder_renamed(ledger, root, kept_dirs, BTreeMap::new())
}

/// [`check_folder`], following reported renames.
pub fn check_folder_renamed(
    ledger: &Path,
    root: &Path,
    kept_dirs: &[PathBuf],
    renames: BTreeMap<String, String>,
) -> Result<Verdict> {
    if !root.is_dir() {
        return Err(Error::Invalid("final folder is missing".into()));
    }
    let rows = super::ledger::read(ledger)?;
    Ok(check(
        &rows,
        &mut FolderState::new(root, kept_dirs).with_renames(renames),
    ))
}

/// Read a renames file: one JSON object per line, `{"from": …, "to": …}`, as the
/// migration report writes it.
pub fn read_renames(path: &Path) -> Result<BTreeMap<String, String>> {
    let text =
        std::fs::read_to_string(path).map_err(|e| Error::Invalid(format!("renames: {e}")))?;
    let mut out = BTreeMap::new();
    for (i, line) in text.lines().filter(|l| !l.trim().is_empty()).enumerate() {
        let v: serde_json::Value = serde_json::from_str(line)
            .map_err(|_| Error::Invalid(format!("renames line {}", i + 1)))?;
        let (Some(from), Some(to)) = (v["from"].as_str(), v["to"].as_str()) else {
            return Err(Error::Invalid(format!("renames line {}", i + 1)));
        };
        out.insert(from.to_owned(), to.to_owned());
    }
    Ok(out)
}
