//! The spec conformance runner and its ratchet.
//!
//! Fixtures are the vendored rc.5 files under `conformance/spec/tests/` (see
//! `conformance/spec/SOURCE` and `scripts/sync-spec-fixtures.sh`). Every test has a
//! stable `id`; `conformance/spec-expectations.txt` records one status per id:
//!
//! - `pass`: must pass. A failure is a **regression** and fails CI.
//! - `pending`: expected to fail. An unexpected pass fails CI too, so the passing
//!   status gets committed (`--bless`) and can never silently slip back.
//! - `skip`: not run (for example, needs a case-sensitive file system).
//!
//! Ids in the fixtures without a status, and statuses for ids that no longer
//! exist, are errors; `--bless` resolves both.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::ops::{self, Group, Unsupported};

/// Directory holding the vendored fixtures, relative to the repo root.
pub const FIXTURE_DIR: &str = "conformance/spec/tests";
/// The ratchet file, relative to the repo root.
pub const EXPECTATIONS: &str = "conformance/spec-expectations.txt";

/// One fixture test.
#[derive(Debug, Clone)]
pub struct Case {
    /// Stable test id.
    pub id: String,
    /// Fixture file, relative to [`FIXTURE_DIR`].
    pub file: String,
    /// Operation name.
    pub operation: String,
    /// The group's setup.
    pub setup: Value,
    /// The test input.
    pub input: Value,
    /// The expected outcome.
    pub expect: Value,
}

/// Recorded status of a test id.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Status {
    /// Must pass.
    Pass,
    /// Expected to fail for now.
    Pending,
    /// Not run.
    Skip,
}

impl Status {
    fn parse(s: &str) -> Option<Self> {
        match s {
            "pass" => Some(Status::Pass),
            "pending" => Some(Status::Pending),
            "skip" => Some(Status::Skip),
            _ => None,
        }
    }
    fn as_str(self) -> &'static str {
        match self {
            Status::Pass => "pass",
            Status::Pending => "pending",
            Status::Skip => "skip",
        }
    }
}

/// What running a case produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Matched `expect`.
    Passed,
    /// Ran, but the result did not match.
    Mismatch(String),
    /// The operation is not implemented in the core yet.
    NotImplemented(&'static str),
    /// The runner does not know the operation.
    UnknownOperation(String),
    /// Not run (status `skip`).
    Skipped,
}

impl Outcome {
    fn passed(&self) -> bool {
        matches!(self, Outcome::Passed)
    }
}

/// A ratchet violation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Violation {
    /// A `pass` test failed.
    Regression {
        /// Test id.
        id: String,
        /// The failing outcome.
        outcome: Outcome,
    },
    /// A `pending` test passed.
    UnexpectedPass {
        /// Test id.
        id: String,
    },
    /// A fixture id has no recorded status.
    Unlisted {
        /// Test id.
        id: String,
    },
    /// A recorded id is not in the fixtures.
    Stale {
        /// Test id.
        id: String,
    },
    /// Two fixtures share an id.
    DuplicateId {
        /// Test id.
        id: String,
    },
}

impl std::fmt::Display for Violation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Violation::Regression { id, outcome } => write!(f, "REGRESSION {id}: {outcome:?}"),
            Violation::UnexpectedPass { id } => write!(
                f,
                "UNEXPECTED PASS {id}: promote it with `cargo run -p mdbn-conformance --bin spec-conformance -- --bless`"
            ),
            Violation::Unlisted { id } => {
                write!(f, "UNLISTED {id}: no status recorded (run --bless)")
            }
            Violation::Stale { id } => write!(
                f,
                "STALE {id}: status recorded for a missing fixture (run --bless)"
            ),
            Violation::DuplicateId { id } => write!(f, "DUPLICATE id {id}"),
        }
    }
}

/// The result of a full run.
#[derive(Debug, Clone)]
pub struct Run {
    /// Every case with its recorded status (if any) and outcome, in fixture order.
    pub results: Vec<(Case, Option<Status>, Outcome)>,
    /// Ratchet violations.
    pub violations: Vec<Violation>,
    /// Recorded statuses whose ids are not in the fixtures.
    pub stale: Vec<String>,
}

/// Load every `*.yaml` fixture under `dir`, in path order.
pub fn load_cases(dir: &Path) -> Result<Vec<Case>, String> {
    let mut files = Vec::new();
    collect_yaml(dir, &mut files).map_err(|e| format!("{}: {e}", dir.display()))?;
    files.sort();
    let mut cases = Vec::new();
    for path in files {
        let rel = path
            .strip_prefix(dir)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        let src = fs::read_to_string(&path).map_err(|e| format!("{rel}: {e}"))?;
        let doc = crate::yaml::parse(&src).map_err(|e| format!("{rel}: {e}"))?;
        let Some(groups) = doc.get("groups").and_then(Value::as_array) else {
            continue; // not a suite file (manifest, fixture data)
        };
        for (gi, group) in groups.iter().enumerate() {
            let group_setup = group.get("setup").cloned().unwrap_or(Value::Null);
            for (ti, test) in group
                .get("tests")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .enumerate()
            {
                let field = |k: &str| test.get(k).cloned().unwrap_or(Value::Null);
                // Tests without a spec id get a positional one, so they still
                // take part in the ratchet. A reordered fixture file shows up
                // as stale ids at the next --bless.
                let id = match test.get("id").and_then(Value::as_str) {
                    Some(id) => id.to_owned(),
                    None => format!("{rel}@g{gi}.t{ti}"),
                };
                // A test-level `setup` overrides the group's members.
                let mut setup = group_setup.clone();
                if let (Some(Value::Object(over)), Value::Object(base)) =
                    (test.get("setup"), &mut setup)
                {
                    for (k, v) in over {
                        base.insert(k.clone(), v.clone());
                    }
                } else if let Some(over) = test.get("setup")
                    && setup.is_null()
                {
                    setup = over.clone();
                }
                cases.push(Case {
                    id,
                    file: rel.clone(),
                    operation: field("operation").as_str().unwrap_or("").to_owned(),
                    setup,
                    input: field("input"),
                    expect: field("expect"),
                });
            }
        }
    }
    Ok(cases)
}

fn collect_yaml(dir: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_dir() {
            collect_yaml(&path, out)?;
        } else if path.extension().is_some_and(|e| e == "yaml" || e == "yml") {
            out.push(path);
        }
    }
    Ok(())
}

/// Parse the expectations file: `<id> <status>` per line, `#` comments.
pub fn parse_expectations(src: &str) -> Result<BTreeMap<String, Status>, String> {
    let mut map = BTreeMap::new();
    for (n, line) in src.lines().enumerate() {
        let line = line.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split_whitespace();
        let (Some(id), Some(status), None) = (parts.next(), parts.next(), parts.next()) else {
            return Err(format!(
                "{EXPECTATIONS}:{}: expected `<id> <status>`",
                n + 1
            ));
        };
        let status = Status::parse(status)
            .ok_or_else(|| format!("{EXPECTATIONS}:{}: unknown status {status:?}", n + 1))?;
        if map.insert(id.to_owned(), status).is_some() {
            return Err(format!("{EXPECTATIONS}:{}: duplicate id {id}", n + 1));
        }
    }
    Ok(map)
}

/// Run one case.
pub fn run_case(case: &Case) -> Outcome {
    match ops::run(
        &case.operation,
        Group {
            setup: &case.setup,
            expect: &case.expect,
        },
        &case.input,
    ) {
        Ok(actual) if ops::matches(&case.expect, &actual) => Outcome::Passed,
        Ok(actual) => Outcome::Mismatch(format!("expected {} got {}", case.expect, actual)),
        Err(Unsupported::NotImplemented(what)) => Outcome::NotImplemented(what),
        Err(Unsupported::UnknownOperation(op)) => Outcome::UnknownOperation(op),
    }
}

/// Run `cases` against recorded `statuses` with `exec`, and compute the ratchet.
pub fn evaluate(
    cases: Vec<Case>,
    statuses: &BTreeMap<String, Status>,
    exec: impl Fn(&Case) -> Outcome,
) -> Run {
    let mut violations = Vec::new();
    let mut seen = BTreeMap::new();
    let mut results = Vec::new();
    for case in cases {
        if seen.insert(case.id.clone(), ()).is_some() {
            violations.push(Violation::DuplicateId {
                id: case.id.clone(),
            });
        }
        let status = statuses.get(&case.id).copied();
        let outcome = if status == Some(Status::Skip) {
            Outcome::Skipped
        } else {
            exec(&case)
        };
        match (status, outcome.passed()) {
            (Some(Status::Pass), false) => violations.push(Violation::Regression {
                id: case.id.clone(),
                outcome: outcome.clone(),
            }),
            (Some(Status::Pending), true) => violations.push(Violation::UnexpectedPass {
                id: case.id.clone(),
            }),
            (None, _) => violations.push(Violation::Unlisted {
                id: case.id.clone(),
            }),
            _ => {}
        }
        results.push((case, status, outcome));
    }
    let stale: Vec<String> = statuses
        .keys()
        .filter(|id| !seen.contains_key(*id))
        .cloned()
        .collect();
    violations.extend(stale.iter().map(|id| Violation::Stale { id: id.clone() }));
    Run {
        results,
        violations,
        stale,
    }
}

/// Run the vendored fixtures against the recorded expectations.
pub fn run_repo(root: &Path) -> Result<Run, String> {
    let cases = load_cases(&root.join(FIXTURE_DIR))?;
    let src = fs::read_to_string(root.join(EXPECTATIONS)).unwrap_or_default();
    let statuses = parse_expectations(&src)?;
    Ok(evaluate(cases, &statuses, run_case))
}

/// Render the expectations file a run implies.
///
/// Passing tests become `pass`, failing ones `pending`, skips stay. A regression
/// keeps `pass` unless `accept_regressions` (so blessing never hides one).
pub fn blessed(run: &Run, accept_regressions: bool) -> Result<String, String> {
    let mut out = String::from(
        "# Spec conformance ratchet. Generated by\n\
         #   cargo run -p mdbn-conformance --bin spec-conformance -- --bless\n\
         # pass: must pass (failure = regression). pending: expected to fail (a pass\n\
         # fails CI until blessed). skip: not run. See crates/conformance/src/spec.rs.\n",
    );
    let mut file = "";
    for (case, status, outcome) in &run.results {
        if case.file != file {
            file = &case.file;
            let _ = write!(out, "\n# {file}\n");
        }
        let new = match (status, outcome) {
            (Some(Status::Skip), _) => Status::Skip,
            (_, o) if o.passed() => Status::Pass,
            (Some(Status::Pass), _) if !accept_regressions => {
                return Err(format!(
                    "{} regressed; fix it or bless with --accept-regressions",
                    case.id
                ));
            }
            _ => Status::Pending,
        };
        let _ = writeln!(out, "{} {}", case.id, new.as_str());
    }
    Ok(out)
}

/// A Markdown summary of a run (for the CI job summary).
pub fn summary(run: &Run) -> String {
    let mut per_file: BTreeMap<&str, [u32; 3]> = BTreeMap::new();
    let mut not_impl: BTreeMap<&str, u32> = BTreeMap::new();
    for (case, _, outcome) in &run.results {
        let row = per_file.entry(&case.file).or_default();
        match outcome {
            Outcome::Passed => row[0] += 1,
            Outcome::Skipped => row[2] += 1,
            _ => row[1] += 1,
        }
        if let Outcome::NotImplemented(what) = outcome {
            *not_impl.entry(what).or_default() += 1;
        }
    }
    let total: [u32; 3] = per_file
        .values()
        .fold([0; 3], |a, r| [a[0] + r[0], a[1] + r[1], a[2] + r[2]]);
    let all = total.iter().sum::<u32>();
    let mut s = String::new();
    let _ = writeln!(s, "## Spec conformance (rc.5 fixtures)\n");
    let _ = writeln!(
        s,
        "**{} / {} passing**, {} pending, {} skipped. Ratchet violations: {}.\n",
        total[0],
        all,
        total[1],
        total[2],
        run.violations.len()
    );
    let _ = writeln!(
        s,
        "| Fixture file | pass | pending | skip |\n|---|---:|---:|---:|"
    );
    for (file, r) in &per_file {
        let _ = writeln!(s, "| `{file}` | {} | {} | {} |", r[0], r[1], r[2]);
    }
    if !not_impl.is_empty() {
        let _ = writeln!(s, "\n| Not yet implemented in core | tests |\n|---|---:|");
        for (what, n) in &not_impl {
            let _ = writeln!(s, "| {what} | {n} |");
        }
    }
    if !run.violations.is_empty() {
        let _ = writeln!(s, "\n### Violations\n");
        for v in &run.violations {
            let _ = writeln!(s, "- {v}");
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn case(id: &str) -> Case {
        Case {
            id: id.into(),
            file: "f.yaml".into(),
            operation: "op".into(),
            setup: Value::Null,
            input: Value::Null,
            expect: Value::Null,
        }
    }

    fn statuses(pairs: &[(&str, Status)]) -> BTreeMap<String, Status> {
        pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
    }

    fn exec(c: &Case) -> Outcome {
        if c.id.starts_with("ok") {
            Outcome::Passed
        } else {
            Outcome::NotImplemented("x")
        }
    }

    #[test]
    fn ratchet_flags_regressions_and_unexpected_passes() {
        let st = statuses(&[
            ("ok.pending", Status::Pending),
            ("bad.pass", Status::Pass),
            ("ok.pass", Status::Pass),
            ("bad.pending", Status::Pending),
            ("bad.skip", Status::Skip),
            ("gone", Status::Pending),
        ]);
        let cases = [
            "ok.pending",
            "bad.pass",
            "ok.pass",
            "bad.pending",
            "bad.skip",
            "new",
        ]
        .map(case)
        .to_vec();
        let run = evaluate(cases, &st, exec);
        let v: Vec<String> = run.violations.iter().map(|v| v.to_string()).collect();
        assert_eq!(v.len(), 4, "{v:#?}");
        assert!(v[0].starts_with("UNEXPECTED PASS ok.pending"));
        assert!(v[1].starts_with("REGRESSION bad.pass"));
        assert!(v[2].starts_with("UNLISTED new"));
        assert!(v[3].starts_with("STALE gone"));
    }

    #[test]
    fn bless_promotes_and_refuses_to_hide_regressions() {
        let st = statuses(&[("ok.a", Status::Pending), ("bad.b", Status::Pending)]);
        let run = evaluate(vec![case("ok.a"), case("bad.b"), case("ok.new")], &st, exec);
        let text = blessed(&run, false).unwrap();
        let back = parse_expectations(&text).unwrap();
        assert_eq!(back["ok.a"], Status::Pass);
        assert_eq!(back["bad.b"], Status::Pending);
        assert_eq!(back["ok.new"], Status::Pass);

        let st = statuses(&[("bad.b", Status::Pass)]);
        let run = evaluate(vec![case("bad.b")], &st, exec);
        assert!(blessed(&run, false).is_err());
        assert!(blessed(&run, true).unwrap().contains("bad.b pending"));
    }
}
