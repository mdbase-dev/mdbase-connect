//! Typed conversion at the reduction seam, not JSON collapse of evaluation data.
use super::*;
use crate::cel::{CelValue, Key, time::Timestamp};
use std::sync::Arc;

fn charge(work: &mut WorkBudget, depth: usize, bytes: usize) -> Result<(), EvaluationFailure> {
    if depth > 32 {
        return Err(EvaluationFailure::BudgetExceeded("view_summary_depth"));
    }
    if !work.charge(1 + bytes as u64, 128 + bytes as u64 * 4) {
        return Err(work.failure().expect("summary value"));
    }
    Ok(())
}
fn unsupported() -> EvaluationFailure {
    EvaluationFailure::UnsupportedConstruct("view_summary_value")
}
pub(super) fn input(
    value: &RuntimeValue,
    depth: usize,
    work: &mut WorkBudget,
) -> Result<(Value, CelValue, TemporalHint), EvaluationFailure> {
    charge(
        work,
        depth,
        match value {
            RuntimeValue::String(s) => s.len(),
            _ => 0,
        },
    )?;
    let mut hint = TemporalHint::None;
    let (value, native) = match value {
        RuntimeValue::Null => (Value::Null, CelValue::Null),
        RuntimeValue::Bool(b) => (Value::Bool(*b), CelValue::Bool(*b)),
        RuntimeValue::Number(n) if n.is_finite() => (Value::Float(*n), CelValue::Double(*n)),
        RuntimeValue::String(s) => (Value::string(s), CelValue::string(s)),
        RuntimeValue::Date(d) if d.is_date_only() => {
            hint = TemporalHint::Date;
            (Value::string(d.display()), CelValue::string(d.display()))
        }
        RuntimeValue::Date(d) => {
            let native =
                CelValue::Timestamp(Timestamp::from_millis(d.millis()).map_err(|_| unsupported())?);
            let value = native.to_value().ok_or_else(unsupported)?;
            hint = TemporalHint::DateTime;
            (value, native)
        }
        RuntimeValue::List(items) => {
            let mut values = Vec::new();
            let mut native = Vec::new();
            for item in items {
                let (v, n, _) = input(item, depth + 1, work)?;
                values.push(v);
                native.push(n);
            }
            (Value::List(values), CelValue::List(Arc::new(native)))
        }
        RuntimeValue::Object(items) => {
            let mut values = Map::new();
            let mut native = crate::cel::CelMap::new();
            for (key, item) in items {
                charge(work, depth + 1, key.len())?;
                let (v, n, _) = input(item, depth + 1, work)?;
                values.insert(key.clone(), v);
                native.insert(Key::String(Arc::from(key.as_str())), n);
            }
            (Value::Map(values), CelValue::Map(Arc::new(native)))
        }
        // Calendar durations cannot be silently flattened to CEL's fixed span;
        // nonfinite/source-error inputs cannot become successful fake nulls.
        _ => return Err(unsupported()),
    };
    Ok((value, native, hint))
}
pub(super) fn output(
    value: &Value,
    depth: usize,
    work: &mut WorkBudget,
) -> Result<RuntimeValue, EvaluationFailure> {
    charge(work, depth, value.as_str().map_or(0, str::len))?;
    Ok(match value {
        Value::Null => RuntimeValue::Null,
        Value::Bool(b) => RuntimeValue::Bool(*b),
        Value::Int(n) if (-9_007_199_254_740_991..=9_007_199_254_740_991).contains(n) => {
            RuntimeValue::Number(*n as f64)
        }
        Value::Float(n) if n.is_finite() => RuntimeValue::Number(*n),
        Value::Text(s) => RuntimeValue::String(s.clone()),
        Value::List(items) => RuntimeValue::List(
            items
                .iter()
                .map(|v| output(v, depth + 1, work))
                .collect::<Result<_, _>>()?,
        ),
        Value::Map(items) => {
            let mut values = BTreeMap::new();
            for (key, value) in items.iter() {
                charge(work, depth + 1, key.len())?;
                values.insert(key.to_owned(), output(value, depth + 1, work)?);
            }
            RuntimeValue::Object(values)
        }
        _ => return Err(unsupported()),
    })
}
