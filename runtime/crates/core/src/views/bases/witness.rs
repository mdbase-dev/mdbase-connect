//! Determinism harness adapter, not a saved-view/client API or replica driver.

use super::{Bindings, MAX_FORMULAS, MAX_PROGRAM_SOURCE_BYTES, Profile, Program, WorkBudget};
use crate::value::{Map, Value};
use std::collections::BTreeMap;

pub(crate) fn contract_discovery(args: &Map) -> Option<Value> {
    super::discovery::witness::run(args)
}

pub(crate) fn whole_view(args: &Map) -> Option<Value> {
    super::execution::witness::run(args)
}
pub(crate) fn filter_plan(args: &Map) -> Option<Value> {
    super::filter::witness::run(args)
}

pub(crate) fn typed_ordering(args: &Map) -> Option<Value> {
    super::ordering::witness::run(args)
}

pub(crate) fn file_bindings(args: &Map) -> Option<Value> {
    super::file_bindings::witness::run(args)
}

pub(crate) fn raw_bindings(args: &Map) -> Option<Value> {
    super::raw::witness::run(args)
}

pub(crate) fn run(args: &Map) -> Option<Value> {
    run_profile(args, Profile::Primitive)
}

/// Captured calendar expression profile; the same evaluator as the primitive
/// witness, with explicit capability admission and no host clock/zone imports.
pub(crate) fn calendar(args: &Map) -> Option<Value> {
    run_profile(args, Profile::Calendar)
}

/// Same evaluator with qualified typed duration/date overload admission.
pub(crate) fn duration_values(args: &Map) -> Option<Value> {
    run_profile(args, Profile::Duration)
}

pub(crate) fn slice1(args: &Map) -> Option<Value> {
    run_profile(args, Profile::Slice1)
}

fn run_profile(args: &Map, profile: Profile) -> Option<Value> {
    let source = args.get("expression")?.as_str()?;
    let definitions = match args.get("formulas") {
        Some(value) => Some(value.as_map()?),
        None => None,
    };
    let mut bytes = source.len();
    if let Some(definitions) = definitions {
        if definitions.len() > MAX_FORMULAS {
            return Some(refusal("query_budget_exceeded", "formula_count"));
        }
        for (name, value) in definitions.iter() {
            bytes = bytes
                .checked_add(name.len())?
                .checked_add(value.as_str()?.len())?;
            if bytes > MAX_PROGRAM_SOURCE_BYTES {
                return Some(refusal("query_budget_exceeded", "program_source_bytes"));
            }
        }
    }
    let definitions: BTreeMap<String, String> = definitions
        .into_iter()
        .flat_map(Map::iter)
        .map(|(name, value)| Some((name.to_owned(), value.as_str()?.to_owned())))
        .collect::<Option<_>>()?;
    let empty = Map::new();
    let record = match args.get("record") {
        Some(value) => value.as_map()?,
        None => &empty,
    };
    match Program::compile_with_profile(source, &definitions, profile) {
        Err(error) => Some(refusal(error.kind.code(), error.kind.detail())),
        Ok(program) => {
            let integer = |key| match args.get(key) {
                Some(Value::Int(n)) => Some(*n),
                _ => None,
            };
            let mut budget = WorkBudget::constrained(
                integer("max_steps")
                    .and_then(|n| u64::try_from(n).ok())
                    .unwrap_or(super::MAX_WORK_STEPS),
                integer("max_allocation")
                    .and_then(|n| u64::try_from(n).ok())
                    .unwrap_or(super::MAX_ALLOCATION_BYTES),
            );
            let mut bindings = Bindings::raw(record);
            if profile != Profile::Primitive
                && let (Some(timezone), Some(now)) = (
                    args.get("timezone").and_then(Value::as_str),
                    integer("now_ms"),
                )
            {
                let clock = super::BasesTimezone::capture(timezone, &mut budget)
                    .and_then(|zone| super::CapturedClock::new(now, zone, &mut budget));
                match clock {
                    Ok(clock) => bindings = bindings.with_clock(clock),
                    Err(error) => return Some(refusal(error.code(), error.detail())),
                }
            }
            let cancelled = args.get("cancelled") == Some(&Value::Bool(true));
            Some(
                match program.evaluate_with_cancel(bindings, &mut budget, &|| cancelled) {
                    Err(error) => refusal(error.code(), error.detail()),
                    Ok(value) => Value::Map(Map::from_iter([("value".into(), value.to_plain())])),
                },
            )
        }
    }
}

/// Pure property-ID/sort metadata witness, not a saved-view activation.
pub(crate) fn properties(args: &Map) -> Option<Value> {
    use super::{
        PropertySelector, SortDirection, SortTerm, decode_sort, normalize_property_metadata,
    };
    let identity = |selector: &PropertySelector| {
        Value::Map(Map::from_iter([
            (
                "namespace".into(),
                Value::string(match selector {
                    PropertySelector::Note(_) => "note",
                    PropertySelector::Formula(_) => "formula",
                    PropertySelector::File(_) => "file",
                }),
            ),
            ("key".into(), Value::string(selector.key())),
        ]))
    };
    let term = |t: &SortTerm| {
        Value::Map(Map::from_iter([
            ("property".into(), identity(&t.property)),
            (
                "direction".into(),
                Value::string(match t.direction {
                    SortDirection::Asc => "ASC",
                    SortDirection::Desc => "DESC",
                }),
            ),
        ]))
    };
    let result = match args.get("action")?.as_str()? {
        "selector" => {
            PropertySelector::parse(args.get("selector")?.as_str()?).map(|s| identity(&s))
        }
        "sort" => {
            decode_sort(args.get("sort")?).map(|ts| Value::List(ts.iter().map(term).collect()))
        }
        "metadata" => normalize_property_metadata(args.get("metadata")?.as_map()?).map(|m| {
            Value::List(
                m.iter()
                    .map(|(s, v)| {
                        Value::Map(Map::from_iter([
                            ("property".into(), identity(s)),
                            ("metadata".into(), v.clone()),
                        ]))
                    })
                    .collect(),
            )
        }),
        "evaluate" => {
            let selector = match PropertySelector::parse(args.get("selector")?.as_str()?) {
                Ok(s) => s,
                Err(e) => return Some(refusal(e.kind.code(), e.kind.detail())),
            };
            let source = match selector.compile(&BTreeMap::new(), Profile::Primitive) {
                Ok(p) => p,
                Err(e) => return Some(refusal(e.kind.code(), e.kind.detail())),
            };
            let record = args.get("record")?.as_map()?;
            return Some(
                match source.evaluate(Bindings::raw(record), &mut WorkBudget::new()) {
                    Ok(v) => Value::Map(Map::from_iter([("value".into(), v.to_plain())])),
                    Err(e) => refusal(e.code(), e.detail()),
                },
            );
        }
        _ => return None,
    };
    Some(match result {
        Ok(v) => Value::Map(Map::from_iter([("value".into(), v)])),
        Err(e) => refusal(e.kind.code(), e.kind.detail()),
    })
}

/// Pure date-helper determinism witness, not expression capability activation.
pub(crate) fn temporal(args: &Map) -> Option<Value> {
    use super::{BasesTimezone, CapturedClock, DateValue};
    let text = |key| args.get(key).and_then(Value::as_str);
    let integer = |key| match args.get(key) {
        Some(Value::Int(value)) => Some(*value),
        _ => None,
    };
    let mut budget = WorkBudget::new();
    let result = (|| {
        let zone = BasesTimezone::capture(text("timezone")?, &mut budget);
        let zone = match zone {
            Ok(zone) => zone,
            Err(failure) => return Some(Err(failure)),
        };
        let action = text("action")?;
        let date = if matches!(action, "now" | "today") {
            let clock = CapturedClock::new(integer("now_ms")?, zone, &mut budget);
            match clock {
                Ok(clock) => {
                    if action == "now" {
                        clock.now(&mut budget)
                    } else {
                        clock.today(&mut budget)
                    }
                }
                Err(failure) => Err(failure),
            }
        } else {
            DateValue::parse(text("date")?, zone, &mut budget)
        };
        let date = match date {
            Ok(date) => date,
            Err(failure) => return Some(Err(failure)),
        };
        Some(match action {
            "parse" | "now" | "today" => date.plain(&mut budget).map(Value::Text),
            "number" => Ok(Value::Int(date.millis())),
            "format" => date.format(text("pattern")?, &mut budget).map(Value::Text),
            "property" => date
                .property(text("property")?, &mut budget)
                .map(Value::Int),
            "date" => date
                .date(&mut budget)
                .and_then(|date| date.plain(&mut budget))
                .map(Value::Text),
            "months" => date
                .add_months(integer("amount")?, &mut budget)
                .and_then(|date| date.plain(&mut budget))
                .map(Value::Text),
            "millis" => date
                .add_millis(integer("amount")?, &mut budget)
                .and_then(|date| date.plain(&mut budget))
                .map(Value::Text),
            _ => return None,
        })
    })()?;
    Some(match result {
        Ok(value) => Value::Map(Map::from_iter([("value".into(), value)])),
        Err(failure) => refusal(failure.code(), failure.detail()),
    })
}

/// Typed duration helper determinism, without expression activation.
pub(crate) fn duration(args: &Map) -> Option<Value> {
    use super::DurationValue;
    let mut budget = WorkBudget::new();
    let text = |key| args.get(key).and_then(Value::as_str);
    let number = |key| {
        args.get(key)
            .and_then(Value::as_number)
            .map(|value| value.as_f64())
    };
    let duration = DurationValue::parse(text("duration")?, &mut budget);
    let result = (|| {
        let duration = match duration {
            Ok(value) => value,
            Err(error) => return Some(Err(error)),
        };
        Some(match text("action")? {
            "humanize" => duration.humanize(&mut budget).map(Value::Text),
            "fixed" => duration.fixed_millis(&mut budget).map(Value::Float),
            "parts" => Ok(Value::List(
                duration
                    .components()
                    .into_iter()
                    .map(Value::Float)
                    .collect(),
            )),
            "scale" => duration
                .scale(number("factor")?, &mut budget)
                .and_then(|value| value.humanize(&mut budget))
                .map(Value::Text),
            "add" => match DurationValue::parse(text("rhs")?, &mut budget)
                .and_then(|rhs| duration.add(rhs, &mut budget))
            {
                Ok(value) => Ok(Value::List(
                    value.components().into_iter().map(Value::Float).collect(),
                )),
                Err(error) => Err(error),
            },
            _ => return None,
        })
    })()?;
    Some(match result {
        Ok(value) => Value::Map(Map::from_iter([("value".into(), value)])),
        Err(error) => refusal(error.code(), error.detail()),
    })
}

/// Captured file/link helper witness, without expression or saved-view activation.
pub(crate) fn capture(args: &Map) -> Option<Value> {
    use super::{CapturedFile, CapturedLink, CreationObservation, LinkResolution};
    fn link(
        args: &Map,
        budget: &mut WorkBudget,
    ) -> Option<Result<CapturedLink, super::EvaluationFailure>> {
        let resolution = match args.get("resolved") {
            None => LinkResolution::Unavailable,
            Some(Value::Null) => LinkResolution::Unresolved,
            Some(Value::Text(path)) => LinkResolution::Resolved(path),
            _ => return None,
        };
        let target = args.get("target")?.as_str()?;
        let display = args.get("display").and_then(Value::as_str);
        Some(if args.get("raw") == Some(&Value::Bool(true)) {
            CapturedLink::from_parts(target, display, resolution, budget)
        } else {
            CapturedLink::parse(target, display, resolution, budget)
        })
    }
    let text = |key| args.get(key).and_then(Value::as_str);
    let integer = |key| match args.get(key) {
        Some(Value::Int(n)) => Some(*n),
        _ => None,
    };
    let mut budget = WorkBudget::new();
    let action = text("action")?;
    let result = (|| {
        if action.starts_with("link_") {
            let value = match link(args, &mut budget)? {
                Ok(value) => value,
                Err(error) => return Some(Err(error)),
            };
            return Some(match action {
                "link_render" => value.render(&mut budget).map(Value::Text),
                "link_raw" => Ok(Value::string(value.path())),
                "link_external" => Ok(Value::Bool(value.is_external())),
                "link_resolve" => value
                    .resolved_path(&mut budget)
                    .map(|path| path.map(Value::string).unwrap_or(Value::Null)),
                "link_equals" | "link_matches" => {
                    let rhs = match link(args.get("rhs")?.as_map()?, &mut budget)? {
                        Ok(value) => value,
                        Err(error) => return Some(Err(error)),
                    };
                    if action == "link_equals" {
                        value.equals(&rhs, &mut budget).map(Value::Bool)
                    } else {
                        value.matches(&rhs, &mut budget).map(Value::Bool)
                    }
                }
                _ => return None,
            });
        }
        if action == "file_has_tag" {
            let mut tags = Vec::new();
            let mut needles = Vec::new();
            for (key, output) in [("tags", &mut tags), ("needles", &mut needles)] {
                let values = args.get(key)?.as_list()?;
                if !budget.vector(values.len()) {
                    return Some(Err(budget.failure()?));
                }
                for value in values {
                    let value = value.as_str()?;
                    if !budget.text(value.len(), 1) {
                        return Some(Err(budget.failure()?));
                    }
                    output.push(value.to_owned());
                }
            }
            return Some(CapturedFile::has_tag(&tags, &needles, &mut budget).map(Value::Bool));
        }
        let created = match (text("created_origin"), integer("created_ms")) {
            (Some("create_log"), Some(ms)) => Some(CreationObservation::FirstCreateLog(ms)),
            (Some("import_birth"), Some(ms)) => Some(CreationObservation::ImportedBirth(ms)),
            (None, None) => None,
            _ => return None,
        };
        let file = CapturedFile::new(
            text("path")?,
            integer("size").and_then(|n| u64::try_from(n).ok()),
            created,
            integer("modified_ms"),
            &mut budget,
        );
        let file = match file {
            Ok(file) => file,
            Err(error) => return Some(Err(error)),
        };
        Some(match action {
            "file_property" => match text("property")? {
                "name" | "basename" => Ok(Value::string(file.basename())),
                "filename" => Ok(Value::string(file.filename())),
                "path" => Ok(Value::string(file.path())),
                "folder" => Ok(Value::string(file.folder())),
                "ext" => Ok(Value::string(file.extension())),
                "size" => file.size(&mut budget).map(|n| Value::Float(n as f64)),
                _ => return None,
            },
            "file_as_link" => file
                .as_link(text("display"), &mut budget)
                .and_then(|link| link.render(&mut budget))
                .map(Value::Text),
            "file_in_folder" => file
                .in_folder(text("folder")?, &mut budget)
                .map(Value::Bool),
            "file_created" | "file_modified" => {
                super::BasesTimezone::capture(text("timezone")?, &mut budget)
                    .and_then(|zone| {
                        if action == "file_created" {
                            file.created(zone, &mut budget)
                        } else {
                            file.modified(zone, &mut budget)
                        }
                    })
                    .and_then(|date| date.plain(&mut budget))
                    .map(Value::Text)
            }
            _ => return None,
        })
    })()?;
    Some(match result {
        Ok(value) => Value::Map(Map::from_iter([("value".into(), value)])),
        Err(error) => refusal(error.code(), error.detail()),
    })
}

fn refusal(code: &str, detail: &str) -> Value {
    Value::Map(Map::from_iter([
        ("refusal".into(), Value::string(code)),
        ("detail".into(), Value::string(detail)),
    ]))
}
