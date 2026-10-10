//! Replay policy inputs are explicit test data, not trusted environment capture.
use super::*;
use crate::{
    value::{Map, Value},
    views::bases::{BasesTimezone, DateValue, EvaluatedDate},
};
fn refusal(code: &str, detail: &str) -> Value {
    Value::Map(Map::from_iter([
        ("refusal".into(), Value::string(code)),
        ("detail".into(), Value::string(detail)),
    ]))
}
fn decode(
    value: &Value,
    zone: Option<&str>,
    budget: &mut WorkBudget,
) -> Result<RuntimeValue, EvaluationFailure> {
    work(budget, 1, 128)?;
    match value {
        Value::Null => Ok(RuntimeValue::Null),
        Value::Bool(b) => Ok(RuntimeValue::Bool(*b)),
        Value::Int(_) | Value::Float(_) => Ok(RuntimeValue::Number(
            value.as_number().expect("number variant").as_f64(),
        )),
        Value::Text(s) => {
            if s.len() > MAX_CAPTURE_TEXT_BYTES {
                return fail(
                    budget,
                    EvaluationFailure::BudgetExceeded("ordering_key_bytes"),
                );
            }
            work(budget, s.len() as u64, s.len() as u64)?;
            Ok(RuntimeValue::String(s.clone()))
        }
        Value::Map(m) if m.len() == 1 && m.get("date").and_then(Value::as_str).is_some() => {
            let Some(zone) = zone else {
                return fail(
                    budget,
                    EvaluationFailure::MetadataUnavailable("date_zone_not_captured"),
                );
            };
            let zone = BasesTimezone::capture(zone, budget)?;
            let date = DateValue::parse(
                m.get("date").and_then(Value::as_str).expect("checked date"),
                zone,
                budget,
            )?;
            Ok(RuntimeValue::Date(EvaluatedDate::new(date, budget)?))
        }
        Value::Map(m) if m.len() == 1 && m.get("error").is_some() => {
            Ok(RuntimeValue::Error("synthetic_error".into()))
        }
        Value::Map(_) => Ok(RuntimeValue::Object(BTreeMap::new())),
        Value::List(_) => Ok(RuntimeValue::List(Vec::new())),
    }
}
pub(crate) fn run(args: &Map) -> Option<Value> {
    let nulls = match args.get("nulls").and_then(Value::as_str) {
        Some("first") => NullOrder::First,
        Some("last") => NullOrder::Last,
        None | Some("unavailable") => NullOrder::Unavailable,
        _ => return None,
    };
    let strings = match args.get("strings").and_then(Value::as_str) {
        Some("utf16") => StringOrder::Utf16,
        None | Some("unavailable") => StringOrder::Unavailable,
        _ => return None,
    };
    let dates = match args.get("date_groups").and_then(Value::as_str) {
        Some("instant") => DateGroupMode::ExactMillis,
        None | Some("unavailable") => DateGroupMode::Unavailable,
        _ => return None,
    };
    let capture = OrderingCapture { nulls, strings };
    let zone = args.get("timezone").and_then(Value::as_str);
    let mut budget = WorkBudget::new();
    let result = match args.get("action")?.as_str()? {
        "compare" => {
            let a = decode(args.get("left")?, zone, &mut budget);
            let b = decode(args.get("right")?, zone, &mut budget);
            a.and_then(|a| b.and_then(|b| compare_typed(&a, &b, capture, &mut budget)))
                .map(|o| {
                    Value::string(match o {
                        Ordering::Less => "less",
                        Ordering::Equal => "equal",
                        Ordering::Greater => "greater",
                    })
                })
        }
        "order" => {
            let inputs = args.get("keys")?.as_list()?;
            let dirs = args.get("directions")?.as_list()?;
            if inputs.len() > MAX_ORDERED_ROWS || dirs.len() > MAX_SORT_TERMS {
                return Some(refusal("query_budget_exceeded", "ordering_shape"));
            }
            let directions = dirs
                .iter()
                .map(|v| match v.as_str()? {
                    "ASC" => Some(SortDirection::Asc),
                    "DESC" => Some(SortDirection::Desc),
                    _ => None,
                })
                .collect::<Option<Vec<_>>>()?;
            let decoded = inputs
                .iter()
                .map(|v| {
                    let list = v.as_list()?;
                    if list.len() > MAX_SORT_TERMS {
                        return Some(Err(EvaluationFailure::BudgetExceeded("ordering_shape")));
                    }
                    Some(
                        list.iter()
                            .map(|v| decode(v, zone, &mut budget))
                            .collect::<Result<Vec<_>, _>>(),
                    )
                })
                .collect::<Option<Vec<_>>>()?
                .into_iter()
                .collect::<Result<Vec<_>, _>>();
            decoded
                .and_then(|keys| {
                    let rows: Vec<_> = keys.iter().map(|keys| TypedSortRow { keys }).collect();
                    order_typed_rows(&rows, &directions, capture, &mut budget)
                })
                .map(|rows| {
                    Value::List(
                        rows.into_iter()
                            .map(|n| Value::Int(i64::try_from(n).expect("bounded row index")))
                            .collect(),
                    )
                })
        }
        "groups" => {
            let values = args.get("values")?.as_list()?;
            if values.len() > MAX_ORDERED_ROWS {
                return Some(refusal("query_budget_exceeded", "group_rows"));
            }
            values
                .iter()
                .map(|v| decode(v, zone, &mut budget))
                .collect::<Result<Vec<_>, _>>()
                .and_then(|values| {
                    partition_typed(&values, dates, &mut budget).map(|groups| {
                        Value::List(
                            groups
                                .into_iter()
                                .map(|g| {
                                    Value::List(
                                        g.rows
                                            .into_iter()
                                            .map(|n| {
                                                Value::Int(
                                                    i64::try_from(n)
                                                        .expect("bounded group row index"),
                                                )
                                            })
                                            .collect(),
                                    )
                                })
                                .collect(),
                        )
                    })
                })
        }
        _ => return None,
    };
    Some(match result {
        Ok(value) => Value::Map(Map::from_iter([("value".into(), value)])),
        Err(e) => refusal(e.code(), e.detail()),
    })
}
