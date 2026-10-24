//! Fixed retained-input ownership profile, separate from legacy row scratch.
use super::*;
use crate::store_query::QueryProjectionPage;
use mdbn_core::value::Value;
const MAX_FRAME_BYTES: u64 = 16 << 20;
fn work(budget: &mut WorkBudget, steps: u64, bytes: u64) -> Result<(), EvaluationFailure> {
    if budget.charge(steps, bytes) {
        Ok(())
    } else {
        Err(budget.failure().expect("sticky admission"))
    }
}
fn value_bytes(
    value: &Value,
    depth: u32,
    budget: &mut WorkBudget,
) -> Result<u64, EvaluationFailure> {
    if depth > 32 {
        return Err(EvaluationFailure::BudgetExceeded("value_depth"));
    }
    work(budget, 1, 0)?;
    let mut bytes = 128u64;
    match value {
        Value::Text(text) => {
            work(budget, text.len() as u64, 0)?;
            bytes += text.len() as u64;
        }
        Value::List(values) => {
            for value in values {
                bytes += value_bytes(value, depth + 1, budget)?;
                if bytes > MAX_FRAME_BYTES {
                    break;
                }
            }
        }
        Value::Map(map) => {
            for (name, value) in map.iter() {
                work(budget, name.len() as u64, 0)?;
                bytes += 48 + name.len() as u64 + value_bytes(value, depth + 1, budget)?;
                if bytes > MAX_FRAME_BYTES {
                    break;
                }
            }
        }
        _ => {}
    }
    if bytes > MAX_FRAME_BYTES {
        return Err(EvaluationFailure::BudgetExceeded("incremental_frame"));
    }
    Ok(bytes)
}
/// Inspect only the bounded raw projection, not documents. Heap estimates are
/// conservative ownership admission, not measured peak heap or encoded lengths.
pub(super) fn frame(
    page: &QueryProjectionPage,
    budget: &mut WorkBudget,
) -> Result<(), EvaluationFailure> {
    let mut bytes = 128u64;
    for row in &page.rows {
        work(budget, 1 + row.path.len() as u64, 0)?;
        bytes += 256 + row.path.len() as u64 + row.fields.len() as u64 * 128;
        for field in &row.fields {
            if let RawField::Present(value) = field {
                bytes += value_bytes(value, 1, budget)?;
            }
        }
        if let Some(tags) = &row.tags {
            for tag in tags {
                work(budget, 1 + tag.len() as u64, 0)?;
                bytes += 32 + tag.len() as u64;
            }
        }
        if bytes > MAX_FRAME_BYTES {
            return Err(EvaluationFailure::BudgetExceeded("incremental_frame"));
        }
    }
    Ok(())
}
pub(super) fn fields(
    names: &[String],
    values: Vec<RawField>,
    budget: &mut WorkBudget,
) -> Result<mdbn_core::value::Map, EvaluationFailure> {
    if names.len() != values.len() {
        return Err(EvaluationFailure::MetadataUnavailable(
            "raw_property_projection_incomplete",
        ));
    }
    let mut map = mdbn_core::value::Map::new();
    for (name, value) in names.iter().zip(values) {
        if let RawField::Present(value) = value {
            work(budget, 1 + name.len() as u64, 64 + name.len() as u64)?;
            map.insert(name.clone(), value);
        }
    }
    Ok(map)
}
pub(super) fn scalar_bytes(value: &RuntimeValue) -> Result<u64, EvaluationFailure> {
    match value {
        RuntimeValue::String(text) if text.len() <= 4096 => Ok(128 + text.len() as u64),
        RuntimeValue::Number(value) if value.is_finite() => Ok(128),
        RuntimeValue::String(_) => Err(EvaluationFailure::BudgetExceeded("ordering_key_bytes")),
        RuntimeValue::Null | RuntimeValue::Bool(_) | RuntimeValue::Date(_) => Ok(128),
        _ => Err(EvaluationFailure::UnsupportedConstruct(
            "typed_ordering_value",
        )),
    }
}
pub(super) fn scalar_copy(
    value: &RuntimeValue,
    ledger: &mut IncrementalBasesBudget,
) -> ApiResult<RuntimeValue> {
    let bytes = scalar_bytes(value).map_err(failure)?;
    ledger.retain(bytes).map_err(failure)?;
    ledger
        .admit(|budget| {
            work(budget, bytes, bytes)?;
            Ok(value.clone())
        })
        .map_err(failure)
}
