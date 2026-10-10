//! Raw frontmatter replay adapter; not a trusted Replica capture API.
use super::*;
use crate::{
    doc::RecordFormat,
    value::{Map, Value},
    views::bases::{BasesTimezone, CapturedClock, Profile, Program},
};
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
    let format = match args
        .get("format")
        .and_then(Value::as_str)
        .unwrap_or("markdown")
    {
        "markdown" => RecordFormat::Markdown,
        "yaml" => RecordFormat::YamlDocument,
        _ => return None,
    };
    let document = Document::parse(source, format);
    let hints = match args.get("property_types") {
        None => None,
        Some(h) => {
            let h = h.as_map()?;
            if h.len() > MAX_PROPERTY_TYPE_HINTS {
                return Some(refusal("query_budget_exceeded", "property_type_count"));
            }
            let mut bytes = 0usize;
            for (k, v) in h.iter() {
                bytes = bytes.checked_add(k.len())?.checked_add(v.as_str()?.len())?;
                if bytes > MAX_PROPERTY_TYPE_HINT_BYTES {
                    return Some(refusal("query_budget_exceeded", "property_type_bytes"));
                }
            }
            Some(
                h.iter()
                    .map(|(k, v)| Some((k.to_owned(), v.as_str()?.to_owned())))
                    .collect::<Option<BTreeMap<_, _>>>()?,
            )
        }
    };
    let program = match Program::compile_with_profile(
        args.get("expression")?.as_str()?,
        &BTreeMap::new(),
        Profile::Duration,
    ) {
        Ok(p) => p,
        Err(e) => return Some(refusal(e.kind.code(), e.kind.detail())),
    };
    let mut budget = WorkBudget::new();
    let result = (|| {
        let types = hints
            .as_ref()
            .map(|h| CapturedPropertyTypes::capture(h, &mut budget))
            .transpose()?;
        let row = RawFrontmatter::capture(&document, types, &mut budget)?;
        let mut bindings = row.bindings();
        if let (Some(zone), Some(Value::Int(ms))) = (
            args.get("timezone").and_then(Value::as_str),
            args.get("now_ms"),
        ) {
            let zone = BasesTimezone::capture(zone, &mut budget)?;
            bindings = bindings.with_clock(CapturedClock::new(*ms, zone, &mut budget)?);
        }
        program.evaluate(bindings, &mut budget)
    })();
    Some(match result {
        Ok(value) => Value::Map(Map::from_iter([("value".into(), value.to_plain())])),
        Err(e) => refusal(e.code(), e.detail()),
    })
}
