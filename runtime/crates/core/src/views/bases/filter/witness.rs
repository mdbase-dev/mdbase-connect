//! Explicit source/registry/clock fixture only, not a Replica query endpoint.
use super::*;
use crate::{
    doc::{Document, RecordFormat},
    value::{Map, Value},
    views::bases::{
        BasesTimezone, CapturedClock, CapturedPropertyTypes, MAX_PROPERTY_TYPE_HINT_BYTES,
        MAX_PROPERTY_TYPE_HINTS, MAX_RAW_RECORD_BYTES, RawFrontmatter,
    },
};
fn refusal(code: &str, detail: &str) -> Value {
    Value::Map(Map::from_iter([
        ("refusal".into(), Value::string(code)),
        ("detail".into(), Value::string(detail)),
    ]))
}
fn definitions(
    value: Option<&Value>,
    max: usize,
    cap: usize,
    budget: &mut WorkBudget,
) -> Result<BTreeMap<String, String>, EvaluationFailure> {
    let Some(value) = value else {
        return Ok(BTreeMap::new());
    };
    let Some(map) = value.as_map() else {
        budget.fail(EvaluationFailure::UnsupportedConstruct(
            "filter_fixture_map",
        ));
        return Err(budget.failure().expect("fixture shape"));
    };
    let mut bytes = 0usize;
    if map.len() > max {
        budget.fail(EvaluationFailure::BudgetExceeded("filter_fixture_map"));
        return Err(budget.failure().expect("fixture count"));
    }
    for (name, value) in map.iter() {
        let Some(value) = value.as_str() else {
            budget.fail(EvaluationFailure::UnsupportedConstruct(
                "filter_fixture_map",
            ));
            return Err(budget.failure().expect("fixture type"));
        };
        bytes = bytes.saturating_add(name.len()).saturating_add(value.len());
        if bytes > cap {
            budget.fail(EvaluationFailure::BudgetExceeded("filter_fixture_map"));
            return Err(budget.failure().expect("fixture bytes"));
        }
    }
    if !budget.charge((map.len() + bytes) as u64, (bytes + map.len() * 128) as u64) {
        return Err(budget.failure().expect("fixture copy budget"));
    }
    Ok(map
        .iter()
        .map(|(k, v)| {
            (
                k.to_owned(),
                v.as_str().expect("checked fixture string").to_owned(),
            )
        })
        .collect())
}
pub(crate) fn run(args: &Map) -> Option<Value> {
    let source = args.get("source")?.as_str()?;
    if source.len() > MAX_RAW_RECORD_BYTES {
        return Some(refusal("query_budget_exceeded", "raw_record_bytes"));
    }
    let mut budget = WorkBudget::new();
    let formulas = match definitions(
        args.get("formulas"),
        super::super::MAX_FORMULAS,
        super::super::MAX_PROGRAM_SOURCE_BYTES,
        &mut budget,
    ) {
        Ok(v) => v,
        Err(e) => return Some(refusal(e.code(), e.detail())),
    };
    let filter = match AdmittedBasesFilter::compile(
        args.get("shared"),
        args.get("local"),
        &formulas,
        Profile::Slice1,
        &mut budget,
    ) {
        Ok(p) => p,
        Err(e) => return Some(refusal(e.code(), e.detail())),
    };
    let document = Document::parse(source, RecordFormat::Markdown);
    let result = (|| {
        let hints = if args.contains_key("property_types") {
            Some(definitions(
                args.get("property_types"),
                MAX_PROPERTY_TYPE_HINTS,
                MAX_PROPERTY_TYPE_HINT_BYTES,
                &mut budget,
            )?)
        } else {
            None
        };
        let types = hints
            .as_ref()
            .map(|h| CapturedPropertyTypes::capture(h, &mut budget))
            .transpose()?;
        let raw = RawFrontmatter::capture(&document, types, &mut budget)?;
        let mut bindings = raw.bindings();
        if let (Some(zone), Some(Value::Int(ms))) = (
            args.get("timezone").and_then(Value::as_str),
            args.get("now_ms"),
        ) {
            let zone = BasesTimezone::capture(zone, &mut budget)?;
            bindings = bindings.with_clock(CapturedClock::new(*ms, zone, &mut budget)?);
        }
        let cancelled = matches!(args.get("cancelled"), Some(Value::Bool(true)));
        filter.matches(bindings, &mut budget, &|| cancelled)
    })();
    Some(match result {
        Ok(value) => Value::Map(Map::from_iter([("value".into(), Value::Bool(value))])),
        Err(e) => refusal(e.code(), e.detail()),
    })
}
