//! Synthetic explicit source/fact replay only; not a trusted Replica capture.
use super::super::*;
use crate::{
    doc::{Document, RecordFormat},
    value::{Map, Value},
};
use std::collections::BTreeMap;
fn refusal(code: &str, detail: &str) -> Value {
    Value::Map(Map::from_iter([
        ("refusal".into(), Value::string(code)),
        ("detail".into(), Value::string(detail)),
    ]))
}
pub(crate) fn run(args: &Map) -> Option<Value> {
    let source = args.get("source")?.as_str()?;
    if source.len() > MAX_RAW_RECORD_BYTES {
        return Some(refusal("query_budget_exceeded", "raw_record_bytes"));
    }
    let document = Document::parse(source, RecordFormat::Markdown);
    let file = args.get("file")?.as_map()?;
    let integer = |key| match file.get(key) {
        Some(Value::Int(n)) => Some(*n),
        _ => None,
    };
    let created = match (
        file.get("created_origin").and_then(Value::as_str),
        integer("created_ms"),
    ) {
        (Some("create_log"), Some(ms)) => Some(CreationObservation::FirstCreateLog(ms)),
        (Some("import_birth"), Some(ms)) => Some(CreationObservation::ImportedBirth(ms)),
        (None, None) => None,
        _ => return None,
    };
    let mut budget = WorkBudget::new();
    let tags = match file.get("tags") {
        None => None,
        Some(value) => {
            let values = value.as_list()?;
            if values.len() > MAX_CAPTURE_ITEMS {
                return Some(refusal("query_budget_exceeded", "file_tag_count"));
            }
            let mut bytes = 0;
            for v in values {
                let text = v.as_str()?;
                bytes += text.len();
                if bytes > 65_536 || text.len() > MAX_CAPTURE_TEXT_BYTES {
                    return Some(refusal("query_budget_exceeded", "file_tag_bytes"));
                }
            }
            if !budget.charge(
                (bytes + values.len()) as u64,
                (bytes + values.len() * std::mem::size_of::<String>()) as u64,
            ) {
                let e = budget.failure()?;
                return Some(refusal(e.code(), e.detail()));
            }
            Some(
                values
                    .iter()
                    .map(|v| v.as_str().map(str::to_owned))
                    .collect::<Option<Vec<_>>>()?,
            )
        }
    };
    let hints = args.get("property_types")?.as_map()?;
    if hints.len() > MAX_PROPERTY_TYPE_HINTS {
        return Some(refusal("query_budget_exceeded", "property_type_count"));
    }
    let mut bytes = 0;
    for (k, v) in hints.iter() {
        bytes += k.len() + v.as_str()?.len();
        if bytes > MAX_PROPERTY_TYPE_HINT_BYTES {
            return Some(refusal("query_budget_exceeded", "property_type_bytes"));
        }
    }
    if !budget.charge(
        (bytes + hints.len()) as u64,
        (bytes + hints.len() * 128) as u64,
    ) {
        let e = budget.failure()?;
        return Some(refusal(e.code(), e.detail()));
    }
    let hints = hints
        .iter()
        .map(|(k, v)| Some((k.to_owned(), v.as_str()?.to_owned())))
        .collect::<Option<BTreeMap<_, _>>>()?;
    let program = match Program::compile_with_profile(
        args.get("expression")?.as_str()?,
        &BTreeMap::new(),
        Profile::TaskSlice1,
    ) {
        Ok(p) => p,
        Err(e) => return Some(refusal(e.kind.code(), e.kind.detail())),
    };
    let path = file.get("path")?.as_str()?;
    let timezone = args.get("timezone")?.as_str()?;
    let Value::Int(now_ms) = args.get("now_ms")? else {
        return None;
    };
    let result = (|| {
        let zone = BasesTimezone::capture(timezone, &mut budget)?;
        let clock = CapturedClock::new(*now_ms, zone, &mut budget)?;
        let file = CapturedFile::new(
            path,
            integer("size").and_then(|n| u64::try_from(n).ok()),
            created,
            integer("modified_ms"),
            &mut budget,
        )?;
        let facts = CapturedFileBindings::capture(&file, tags.as_deref(), &mut budget)?;
        let types = CapturedPropertyTypes::capture(&hints, &mut budget)?;
        let raw = RawFrontmatter::capture(&document, Some(types), &mut budget)?;
        program.evaluate(
            raw.bindings().with_clock(clock).with_file(facts),
            &mut budget,
        )
    })();
    Some(match result {
        Ok(value) => Value::Map(Map::from_iter([("value".into(), value.to_plain())])),
        Err(e) => refusal(e.code(), e.detail()),
    })
}
