//! The write ledger: one JSON line per write a driver made. It is append-only, and a
//! torn, unterminated final line is ignored. Complete malformed rows are errors,
//! never silently downgraded to an unacknowledged write.

use std::collections::BTreeSet;
use std::io::Write;
use std::path::Path;

use serde_json::{Value, json};

use crate::{Error, Result};

/// What the old (or new) system told the driver.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Acknowledged: it must survive, unless superseded by a later acknowledged write or
    /// kept in a hold or conflict.
    Acked,
    /// Never acknowledged, but it is the user's bytes (an un-uploaded mirror edit, a
    /// local file edit). It must be present in a file, a hold or a conflict.
    MustSurvive,
    /// Refused, or with an unknown outcome. Not checked; recorded for the report.
    NotAcked,
}

/// One write.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Row {
    /// Global acknowledgement order. Drivers take it from one shared counter at ack
    /// time.
    pub order: u64,
    /// Which writer (`sdk-1`, `mirror-a`, `cli`, …).
    pub writer: String,
    /// The record's path.
    pub path: String,
    /// The frontmatter field (`rh_<writer>_<n>`).
    pub field: String,
    /// The value written.
    pub value: String,
    /// What the system said.
    pub outcome: Outcome,
    /// Scenario and phase, for the report (`R5/H6`).
    pub phase: String,
}

/// Append `row` to the ledger at `path`, with `fsync`. A driver calls this **after**
/// the system acknowledged the write, and before it acts on the acknowledgement.
pub fn append(path: &Path, row: &Row) -> Result<()> {
    let line = json!({
        "order": row.order, "writer": row.writer, "path": row.path, "field": row.field,
        "value": row.value, "phase": row.phase,
        "outcome": match row.outcome {
            Outcome::Acked => "acked",
            Outcome::MustSurvive => "must_survive",
            Outcome::NotAcked => "not_acked",
        },
    });
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| Error::Invalid(format!("ledger: {e}")))?;
    f.write_all(format!("{line}\n").as_bytes())
        .and_then(|()| f.sync_data())
        .map_err(|e| Error::Invalid(format!("ledger: {e}")))
}

/// Read a ledger, rejecting missing/ill-typed fields, unknown outcomes and duplicate
/// global orders. Row order need not be sorted: concurrent appenders can finish in
/// a different order. Only a syntactically torn, unterminated final line is ignored.
/// Diagnostic errors contain line/field identities, never ledger values.
pub fn read(path: &Path) -> Result<Vec<Row>> {
    let text = std::fs::read_to_string(path).map_err(|e| Error::Invalid(format!("ledger: {e}")))?;
    let mut out = Vec::new();
    let mut orders = BTreeSet::new();
    let mut lines = text.split_inclusive('\n').enumerate().peekable();
    while let Some((i, line)) = lines.next() {
        if line.trim().is_empty() {
            continue;
        }
        let invalid = |field: &str| Error::Invalid(format!("ledger line {}: {field}", i + 1));
        let v: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) if lines.peek().is_none() && !line.ends_with('\n') => continue,
            Err(_) => return Err(invalid("invalid JSON")),
        };
        let s = |k: &str, nonempty: bool| -> Result<String> {
            let value = v.get(k).and_then(Value::as_str).ok_or_else(|| invalid(k))?;
            if nonempty && value.trim().is_empty() {
                return Err(invalid(k));
            }
            Ok(value.to_owned())
        };
        let order = v
            .get("order")
            .and_then(Value::as_u64)
            .ok_or_else(|| invalid("order"))?;
        if !orders.insert(order) {
            return Err(invalid("duplicate order"));
        }
        let outcome = match s("outcome", true)?.as_str() {
            "acked" => Outcome::Acked,
            "must_survive" => Outcome::MustSurvive,
            "not_acked" => Outcome::NotAcked,
            _ => return Err(invalid("outcome")),
        };
        out.push(Row {
            order,
            writer: s("writer", true)?,
            path: s("path", true)?,
            field: s("field", true)?,
            value: s("value", false)?,
            phase: s("phase", true)?,
            outcome,
        });
    }
    Ok(out)
}
