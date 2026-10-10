//! A release-loss oracle must not pass an empty/unchecked ledger or silently
//! turn malformed acknowledged-write evidence into a refused write.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, missing_docs)]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use mdbn_migrate::rehearsal::ledger::{self, Outcome, Row};
use mdbn_migrate::rehearsal::oracle::{self, FinalState, Verdict};
use serde_json::{Value, json};

fn scratch(name: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR"))
        .join("mdbn-migrate-rehearsal-evidence")
        .join(name);
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn row(order: u64, outcome: Outcome) -> Row {
    Row {
        order,
        writer: "sdk-1".into(),
        path: "n/a.md".into(),
        field: "rh_sdk1_0".into(),
        value: "private ledger marker".into(),
        outcome,
        phase: "R5/H6".into(),
    }
}

fn value() -> Value {
    json!({
        "order": 0,
        "writer": "sdk-1",
        "path": "n/a.md",
        "field": "rh_sdk1_0",
        "value": "private ledger marker",
        "outcome": "acked",
        "phase": "R5/H6",
    })
}

struct Present;
impl FinalState for Present {
    fn field(&mut self, _: &str, _: &str) -> Option<String> {
        Some("private ledger marker".into())
    }
    fn kept(&mut self, _: &str, _: &str) -> bool {
        panic!("present fields need no hold lookup")
    }
}

#[test]
fn empty_or_unchecked_evidence_is_not_green_but_partial_scenarios_can_pass() {
    assert!(!Verdict::default().green());
    for rows in [vec![], vec![row(1, Outcome::NotAcked)]] {
        let v = oracle::check(&rows, &mut Present);
        assert!(v.violations.is_empty());
        assert!(!v.has_required_evidence());
        assert!(!v.green());
    }
    // R11, for example, checks acknowledged renames only. Its per-scenario loss
    // check can pass, but the aggregate CLI must still reject one-sided evidence.
    for rows in [
        vec![row(1, Outcome::Acked)],
        vec![row(1, Outcome::MustSurvive)],
        vec![row(1, Outcome::NotAcked), row(2, Outcome::Acked)],
    ] {
        let v = oracle::check(&rows, &mut Present);
        assert!(v.green());
        assert!(!v.has_required_evidence());
        assert!(!(v.green() && v.has_required_evidence()));
    }
    let v = oracle::check(
        &[row(1, Outcome::Acked), row(2, Outcome::MustSurvive)],
        &mut Present,
    );
    assert!(v.has_required_evidence());
    assert!(v.green());
}

#[test]
fn complete_rows_require_explicit_typed_fields_and_known_outcomes() {
    let base = scratch("schema");
    let path = base.join("ledger.jsonl");
    for field in [
        "order", "writer", "path", "field", "value", "outcome", "phase",
    ] {
        let mut v = value();
        v.as_object_mut().unwrap().remove(field);
        fs::write(&path, format!("{v}\n")).unwrap();
        let e = ledger::read(&path).unwrap_err();
        assert!(e.to_string().contains(field));
        assert!(!format!("{e:?}").contains("private ledger marker"));

        let mut v = value();
        v[field] = Value::Null;
        fs::write(&path, format!("{v}\n")).unwrap();
        assert!(ledger::read(&path).is_err(), "null {field}");
    }
    for (field, invalid) in [
        ("order", json!(-1)),
        ("order", json!(1.5)),
        ("order", json!("1")),
        ("writer", json!(" ")),
        ("path", json!("")),
        ("field", json!("\n")),
        ("phase", json!("")),
        ("outcome", json!("ackde")),
        ("outcome", json!("unknown")),
        ("outcome", json!(false)),
        ("value", json!(["private ledger marker"])),
    ] {
        let mut v = value();
        v[field] = invalid;
        fs::write(&path, format!("{v}\n")).unwrap();
        assert!(ledger::read(&path).is_err(), "{field}: {v}");
    }
    // Even a final JSON row without a newline must not bypass schema checks.
    fs::write(&path, "{}").unwrap();
    assert!(ledger::read(&path).is_err());
}

#[test]
fn zero_order_empty_values_and_forward_compatible_fields_are_allowed() {
    let base = scratch("compatible");
    let path = base.join("ledger.jsonl");
    let mut v = value();
    v["value"] = json!(""); // Clearing a field is a real write.
    v["future_metadata"] = json!({"ignored": true});
    // A syntactically complete final JSON row need not have a trailing newline.
    fs::write(&path, v.to_string()).unwrap();
    let rows = ledger::read(&path).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].order, 0);
    assert_eq!(rows[0].value, "");
    assert_eq!(rows[0].outcome, Outcome::Acked);
}

#[test]
fn duplicate_global_orders_are_errors_but_unsorted_appends_are_allowed() {
    let base = scratch("orders");
    let path = base.join("ledger.jsonl");
    ledger::append(&path, &row(2, Outcome::Acked)).unwrap();
    ledger::append(&path, &row(1, Outcome::MustSurvive)).unwrap();
    assert_eq!(ledger::read(&path).unwrap().len(), 2);
    // Even different outcome/path/field rows must not reuse one global order.
    let mut duplicate = row(2, Outcome::NotAcked);
    duplicate.path = "n/b.md".into();
    duplicate.field = "other".into();
    ledger::append(&path, &duplicate).unwrap();
    assert!(
        ledger::read(&path)
            .unwrap_err()
            .to_string()
            .contains("duplicate order")
    );
}

#[test]
fn only_an_unterminated_syntactically_torn_final_line_is_ignored() {
    let base = scratch("torn");
    let path = base.join("ledger.jsonl");
    let complete = format!("{}\n", value());
    fs::write(&path, format!("{complete}{{\"order\":1,\"wri")).unwrap();
    assert_eq!(ledger::read(&path).unwrap().len(), 1);
    for corrupt in [
        format!("{complete}{{\"order\":1,\"wri\n"),
        format!("{{broken\n{complete}"),
        format!("{complete}{{broken\n\n"),
    ] {
        fs::write(&path, corrupt).unwrap();
        assert!(ledger::read(&path).is_err());
    }
    // Diagnostics refer to physical lines, even when there are blank lines.
    fs::write(&path, format!("\n{complete}\n{{}}\n")).unwrap();
    assert!(
        ledger::read(&path)
            .unwrap_err()
            .to_string()
            .contains("line 4")
    );
}

#[test]
fn cli_rejects_empty_torn_only_unchecked_and_one_sided_evidence() {
    let base = scratch("cli-coverage");
    let root = base.join("final");
    fs::create_dir_all(root.join("n")).unwrap();
    fs::write(
        root.join("n/a.md"),
        "---\nrh_sdk1_0: \"private ledger marker\"\n---\n",
    )
    .unwrap();
    let path = base.join("ledger.jsonl");
    for rows in [
        vec![],
        vec![row(1, Outcome::NotAcked)],
        vec![row(1, Outcome::Acked)],
        vec![row(1, Outcome::MustSurvive)],
    ] {
        fs::write(&path, "").unwrap();
        for r in &rows {
            ledger::append(&path, r).unwrap();
        }
        let output = Command::new(env!("CARGO_BIN_EXE_mdbn-rehearse"))
            .args(["check"])
            .arg(&path)
            .arg(&root)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(1));
        let summary: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(summary["green"], false);
        assert_eq!(summary["evidence_complete"], false);
    }
    fs::write(&path, "{\"order\":1,\"wri").unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_mdbn-rehearse"))
        .arg("check")
        .arg(&path)
        .arg(&root)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn cli_malformed_ledger_exits_two_without_echoing_values() {
    let base = scratch("cli-malformed");
    let path = base.join("ledger.jsonl");
    let mut v = value();
    v["outcome"] = json!("private ledger marker");
    fs::write(&path, format!("{v}\n")).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_mdbn-rehearse"))
        .arg("check")
        .arg(&path)
        .arg(&base)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
    assert!(
        !String::from_utf8(output.stderr)
            .unwrap()
            .contains("private ledger marker")
    );
}

#[test]
fn cli_green_requires_both_evidence_kinds_and_json_escapes_diagnostics() {
    let base = scratch("cli-json");
    let root = base.join("final");
    fs::create_dir_all(root.join("n")).unwrap();
    let doc = "---\nrh_sdk1_0: \"private ledger marker\"\n---\n";
    fs::write(root.join("n/a.md"), doc).unwrap();
    let path = base.join("ledger.jsonl");
    for r in [row(1, Outcome::Acked), row(2, Outcome::MustSurvive)] {
        ledger::append(&path, &r).unwrap();
    }
    let run = || {
        Command::new(env!("CARGO_BIN_EXE_mdbn-rehearse"))
            .arg("check")
            .arg(&path)
            .arg(&root)
            .output()
            .unwrap()
    };
    let output = run();
    assert!(output.status.success());
    let summary: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(summary["green"], true);
    assert_eq!(summary["evidence_complete"], true);

    // Identity strings are untrusted JSON strings, not raw JSON fragments.
    let mut missing = row(3, Outcome::Acked);
    missing.writer = "writer\"\nidentity".into();
    missing.path = "n/quote\".md".into();
    missing.field = "field\"name".into();
    missing.phase = "phase\nnext".into();
    ledger::append(&path, &missing).unwrap();
    let output = run();
    assert_eq!(output.status.code(), Some(1));
    let text = String::from_utf8(output.stdout).unwrap();
    assert!(!text.contains("private ledger marker"));
    let lines: Vec<Value> = text
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[1]["writer"], missing.writer);
    assert_eq!(lines[1]["path"], missing.path);
    assert_eq!(lines[1]["phase"], missing.phase);
}
