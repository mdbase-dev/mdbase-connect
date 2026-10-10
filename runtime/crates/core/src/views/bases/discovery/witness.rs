//! Explicit catalogue/document fixtures, not a trusted replica inventory.
use super::*;
use crate::{doc::RecordFormat, value::Value};
fn refusal(e: EvaluationFailure) -> Value {
    Value::Map(Map::from_iter([
        ("refusal".into(), Value::string(e.code())),
        ("detail".into(), Value::string(e.detail())),
    ]))
}
pub(crate) fn run(args: &Map) -> Option<Value> {
    let source = args.get("source")?.as_str()?;
    let path = args.get("path")?.as_str()?;
    let resources = args.get("resources")?.as_list()?;
    if source.len() > 1 << 20 || path.len() > 1024 || resources.len() > 16 {
        return Some(refusal(EvaluationFailure::BudgetExceeded(
            "base_witness_inputs",
        )));
    }
    let mut inputs = Vec::new();
    let mut total = source.len();
    for resource in resources {
        let path = resource.get("path")?.as_str()?;
        let source = resource.get("source")?.as_str()?;
        total = total.checked_add(path.len() + source.len())?;
        if total > 1 << 20 {
            return Some(refusal(EvaluationFailure::BudgetExceeded(
                "base_witness_inputs",
            )));
        }
        inputs.push((path, source));
    }
    let mut budget = WorkBudget::new();
    if !budget.charge(total as u64, total as u64) {
        return Some(refusal(budget.failure()?));
    }
    let format = match args.get("format").and_then(Value::as_str) {
        None => RecordFormat::for_path(path),
        Some("markdown") => RecordFormat::Markdown,
        Some("yaml") => RecordFormat::YamlDocument,
        _ => return None,
    };
    let doc = Document::parse(source, format);
    let catalog = Catalog::load(inputs);
    let clock = OpClock {
        instant_ms: 1781075828070,
        tz: "UTC".into(),
        local_date: "2026-06-10".into(),
    };
    Some(
        match discover_base_record(&catalog, path, &doc, &clock, &mut budget) {
            Err(e) => refusal(e),
            Ok(None) => Value::Map(Map::from_iter([("value".into(), Value::Null)])),
            Ok(Some(base)) => {
                let implementations = Value::List(
                    base.implementations
                        .iter()
                        .map(|i| {
                            Value::Map(Map::from_iter([
                                ("type".into(), Value::string(i.type_name.clone())),
                                ("version".into(), Value::string(i.version.to_string())),
                            ]))
                        })
                        .collect(),
                );
                let views = Value::List(
                    base.views
                        .iter()
                        .map(|v| {
                            Value::Map(Map::from_iter([
                                ("index".into(), Value::Int(i64::from(v.index))),
                                ("type".into(), Value::string(v.view_type)),
                                ("name".into(), v.name.map_or(Value::Null, Value::string)),
                            ]))
                        })
                        .collect(),
                );
                let mut projection = Map::new();
                for (key, value) in [
                    ("filters", base.fields.filters),
                    ("formulas", base.fields.formulas),
                    ("properties", base.fields.properties),
                ] {
                    if let Some(value) = value {
                        if let Err(e) = comparison_value(value, 0, &mut budget) {
                            return Some(refusal(e));
                        }
                        projection.insert(key, value.clone());
                    }
                }
                Value::Map(Map::from_iter([(
                    "value".into(),
                    Value::Map(Map::from_iter([
                        ("implementations".into(), implementations),
                        ("views".into(), views),
                        ("projection".into(), Value::Map(projection)),
                    ])),
                )]))
            }
        },
    )
}
