//! Bounded explicit whole-view fixtures, not a Replica authority endpoint.
use super::*;
use crate::{
    doc::{Document, RecordFormat},
    intent::OpClock,
    types::Catalog,
    value::Map,
};
fn refused(code: &'static str, detail: &'static str) -> Value {
    Value::Map(Map::from_iter([
        ("refusal".into(), Value::string(code)),
        ("detail".into(), Value::string(detail)),
    ]))
}
fn failure(e: EvaluationFailure) -> Value {
    refused(e.code(), e.detail())
}
pub(crate) fn run(args: &Map) -> Option<Value> {
    let source = args.get("source")?.as_str()?;
    let path = args.get("path")?.as_str()?;
    let index = args.get("index")?.as_number()?.as_i64()?;
    let records = args.get("records")?.as_list()?;
    let resources = args.get("resources")?.as_list()?;
    let hints = args.get("property_types")?.as_map()?;
    if records.len() > 1000 || resources.len() > 16 || hints.len() > 4096 || index < 0 {
        return Some(failure(EvaluationFailure::BudgetExceeded(
            "view_witness_inputs",
        )));
    }
    let mut bytes = source.len() + path.len();
    let mut inputs = Vec::new();
    for resource in resources {
        let path = resource.get("path")?.as_str()?;
        let source = resource.get("source")?.as_str()?;
        bytes = bytes.checked_add(path.len() + source.len())?;
        inputs.push((path, source));
    }
    for record in records {
        bytes = bytes.checked_add(
            record.get("source")?.as_str()?.len() + record.get("path")?.as_str()?.len(),
        )?;
    }
    if bytes > 1 << 20 {
        return Some(failure(EvaluationFailure::BudgetExceeded(
            "view_witness_inputs",
        )));
    }
    let mut budget = WorkBudget::new();
    if !budget.charge(bytes as u64, (bytes * 2) as u64) {
        return Some(failure(budget.failure()?));
    }
    let hintbytes = hints.iter().try_fold(0usize, |n, (k, v)| {
        n.checked_add(k.len() + v.as_str()?.len())
    })?;
    if hintbytes > 65_536 {
        return Some(failure(EvaluationFailure::BudgetExceeded(
            "property_type_bytes",
        )));
    }
    if !budget.charge(hints.len() as u64, (hintbytes + hints.len() * 128) as u64) {
        return Some(failure(budget.failure()?));
    }
    let mut types = BTreeMap::new();
    for (k, v) in hints.iter() {
        types.insert(k.into(), v.as_str()?.into());
    }
    let document = Document::parse(source, RecordFormat::for_path(path));
    let catalog = Catalog::load(inputs);
    let opclock = OpClock {
        instant_ms: 1781075828070,
        tz: "UTC".into(),
        local_date: "2026-06-10".into(),
    };
    let base = match discover_base_record(&catalog, path, &document, &opclock, &mut budget) {
        Ok(Some(base)) => base,
        Ok(None) => {
            return Some(failure(EvaluationFailure::UnsupportedConstruct(
                "base_view_not_found",
            )));
        }
        Err(e) => return Some(failure(e)),
    };
    let view = base.views.get(index as usize)?;
    let plan = match AdmittedBasesView::compile(
        &base.fields,
        view,
        FileTimeAvailability {
            created: false,
            modified: false,
            tags: true,
        },
        &mut budget,
    ) {
        Ok(plan) => plan,
        Err(e) => return Some(refused(e.code(), e.detail())),
    };
    let types = match CapturedPropertyTypes::capture(&types, &mut budget) {
        Ok(t) => t,
        Err(e) => return Some(failure(e)),
    };
    let zone = match BasesTimezone::capture("UTC", &mut budget) {
        Ok(z) => z,
        Err(e) => return Some(failure(e)),
    };
    let clock = match CapturedClock::new(opclock.instant_ms, zone, &mut budget) {
        Ok(c) => c,
        Err(e) => return Some(failure(e)),
    };
    let mut rows = Vec::new();
    for record in records {
        let source = record.get("source")?.as_str()?;
        let path = record.get("path")?.as_str()?;
        let tags = record.get("captured_tags")?.as_list()?;
        if tags.len() > MAX_CAPTURE_ITEMS {
            return Some(failure(EvaluationFailure::BudgetExceeded("file_tag_count")));
        }
        let mut tagbytes = 0usize;
        for tag in tags {
            let tag = tag.as_str()?;
            tagbytes = tagbytes.checked_add(tag.len())?;
            if tag.len() > 4096 || tagbytes > 65536 {
                return Some(failure(EvaluationFailure::BudgetExceeded("file_tag_bytes")));
            }
        }
        if !budget.charge(tags.len() as u64, (tagbytes + tags.len() * 24) as u64) {
            return Some(failure(budget.failure()?));
        }
        let tags = tags
            .iter()
            .map(|v| v.as_str().expect("checked tag").into())
            .collect::<Vec<String>>();
        let doc = Document::parse(source, RecordFormat::for_path(path));
        let file = match CapturedFile::new(path, Some(source.len() as u64), None, None, &mut budget)
        {
            Ok(f) => f,
            Err(e) => return Some(failure(e)),
        };
        let facts = match CapturedFileBindings::capture(&file, Some(&tags), &mut budget) {
            Ok(f) => f,
            Err(e) => return Some(failure(e)),
        };
        let raw = match RawFrontmatter::capture(&doc, Some(types), &mut budget) {
            Ok(r) => r,
            Err(e) => return Some(failure(e)),
        };
        match plan.project(
            raw.bindings().with_clock(clock).with_file(facts),
            &mut budget,
            &|| false,
        ) {
            Ok(Some(row)) => rows.push((record.get("id")?.as_str()?, row)),
            Ok(None) => {}
            Err(e) => return Some(failure(e)),
        }
    }
    let capture = OrderingCapture {
        nulls: NullOrder::Last,
        strings: StringOrder::Utf16,
    };
    let keys = rows
        .iter()
        .map(|(_, r)| TypedSortRow { keys: &r.sort })
        .collect::<Vec<_>>();
    let directions = plan.sort_directions();
    let order = match order_typed_rows(&keys, &directions, capture, &mut budget) {
        Ok(o) => o,
        Err(e) => return Some(failure(e)),
    };
    let mut groups = Vec::new();
    if let Some(direction) = plan.group_direction() {
        let values = order
            .iter()
            .map(|i| rows[*i].1.group.as_ref().expect("group root").clone())
            .collect::<Vec<_>>();
        let partitions = match partition_typed(&values, DateGroupMode::Unavailable, &mut budget) {
            Ok(g) => g,
            Err(e) => return Some(failure(e)),
        };
        let keys = partitions
            .iter()
            .map(|p| TypedSortRow {
                keys: std::slice::from_ref(p.key),
            })
            .collect::<Vec<_>>();
        let grouporder = match order_typed_rows(&keys, &[direction], capture, &mut budget) {
            Ok(g) => g,
            Err(e) => return Some(failure(e)),
        };
        for i in grouporder {
            let group = &partitions[i];
            groups.push(Value::Map(Map::from_iter([
                ("key".into(), group.key.to_plain()),
                (
                    "rows".into(),
                    Value::List(group.rows.iter().map(|i| Value::Int(*i as i64)).collect()),
                ),
            ])));
        }
    }
    let output = order
        .into_iter()
        .map(|i| {
            let (id, row) = &rows[i];
            Value::Map(Map::from_iter([
                ("id".into(), Value::string(*id)),
                (
                    "cells".into(),
                    Value::List(
                        row.cells
                            .iter()
                            .map(|cell| match cell {
                                BasesDisplayCell::Value(value) => {
                                    Value::Map(Map::from_iter([("value".into(), value.to_plain())]))
                                }
                                BasesDisplayCell::Unavailable { detail, .. } => {
                                    Value::Map(Map::from_iter([(
                                        "unavailable".into(),
                                        Value::string(*detail),
                                    )]))
                                }
                            })
                            .collect(),
                    ),
                ),
                (
                    "sort".into(),
                    Value::List(row.sort.iter().map(RuntimeValue::to_plain).collect()),
                ),
            ]))
        })
        .collect();
    Some(Value::Map(Map::from_iter([(
        "value".into(),
        Value::Map(Map::from_iter([
            ("rows".into(), Value::List(output)),
            ("groups".into(), Value::List(groups)),
        ])),
    )])))
}
