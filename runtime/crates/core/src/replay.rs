//! A deterministic replay of core operations: the witness that native and WASM
//! builds compute the same semantics (deterministic replay).
//!
//! The input is a log with one operation per line, written as a YAML flow
//! mapping (JSON works too) and read with the core's own YAML parser. Blank
//! lines and lines starting with `#` are skipped. Each operation's result is
//! rendered as canonical JSON ([`Value::to_json`]); the report lists every result
//! and a digest over them, so a golden file shows the actual semantics and any
//! drift points at the operation that changed.
//!
//! Operations (`op` names the operation; the other keys are its arguments):
//!
//! | `op` | arguments | result |
//! |---|---|---|
//! | `path_key` | `path` | the path key |
//! | `equivalence_groups` | `paths` | the groups |
//! | `allocate_path` | `requested`, `existing` | the chosen path |
//! | `check_path` | `path` | `"ok"` or the violation reason |
//! | `derive_path` | `pattern`, `frontmatter` | `{path}` or `{error, field}` |
//! | `parse` | `path`, `source` | `{frontmatter, body, problem}` |
//! | `write` | `path`, `source`, `set`, `remove`, `body` | `{document}` or `{error}` |
//! | `merge` | `types`, `paths` or `path`, `base`, `first`, `second` | `{document, path, conflicts}` |
//! | `merge_body` | `base`, `first`, `second` | the body, or null for a conflict |
//! | `body_edits` | `base` (or null), `current`, `edits: [[start, end, text]]` | `{body}` or `{error, reason}` |
//! | `detect_moves` | `id_field`, `disappeared`, `appeared` | `{moves, deleted, created}` |
//! | `regex_match` | `pattern`, `text` | `true`/`false`, or `{error}` |
//! | `cel` | `expression`, `record` (frontmatter) | `{value}` or `{compile_error}` / `{error}` |
//! | `bases_primitive` | `expression`, `record`, `formulas` | `{value}` or fixed `{refusal, detail}`; partial port witness, not saved-view API |
//! | `bases_temporal` | `action`, `timezone`, `date` / `now_ms` | temporal helper witness; `{value}` or fixed `{refusal, detail}` |
//! | `bases_duration` | `action`, `duration` | duration helper witness; `{value}` or fixed `{refusal, detail}` |
//! | `bases_discovery` | catalog resources, record path/source | resolved contract view descriptors or typed refusal |
//! | `bases_ordering` | typed cells, explicit null/collation/date-group capture | stable multikey order/exact partitions or typed refusal |
//! | `bases_view` | actual contract source/resources, bounded rows | admitted whole-view explicit fixture witness |
//! | `bases_filter` | raw source, shared/local filters, explicit registry/clock | admitted filter witness |
//! | `bases_file_values` | explicit source/file/registry/clock facts | TaskSlice1 captured file bindings witness |
//! | `bases_raw` | `source`, `expression`, optional `property_types`, `timezone`, `now_ms` | exact raw document/captured typing witness |
//! | `bases_slice1` | `expression`, optional `timezone`, `now_ms` | slice-1 bounded weekday/month formatting and JS-style round |
//! | `bases_calendar` | `expression`, optional `timezone`, `now_ms` | captured calendar expression witness; `{value}` or fixed `{refusal, detail}` |
//! | `bases_capture` | `action`, file/link descriptor | captured file/link helper witness; `{value}` or fixed `{refusal, detail}` |
//! | `bases_duration_values` | `expression`, optional `timezone`, `now_ms` | qualified typed duration/date overload expression witness |
//! | `bases_properties` | `action`, selector/sort/metadata/raw record | property-ID/sort metadata component witness |
//!
//! | `collection_configuration` | `declaration`, optional `source` | CollectionSetup configuration component; actions/document/digests or typed error; not an install endpoint |
//!
//! Later phases add operations as they land; the harness and golden files stay.

use crate::doc::Document;
use crate::merge::{self, BodyBase, BodyEdit, ConflictValue, Version};
use crate::moves::{self, Observed};
use crate::paths;
use crate::value::{Map, Value};
use crate::writer::{self, Change};
use crate::yaml;

/// The result of [`replay`].
#[derive(Debug, Clone, PartialEq)]
pub struct ReplayReport {
    /// Operations executed.
    pub entries: u64,
    /// Lines that were not a valid operation.
    pub rejected: u64,
    /// One canonical JSON result per operation line, in order.
    pub results: Vec<String>,
    /// FNV-1a over the results (with their lengths).
    pub digest: u64,
}

impl ReplayReport {
    /// The report as JSON, one result per line, so golden files diff well.
    pub fn to_json(&self) -> String {
        let mut out = format!(
            "{{\"entries\":{},\"rejected\":{},\"digest\":\"{:016x}\",\"results\":[",
            self.entries, self.rejected, self.digest
        );
        for (i, r) in self.results.iter().enumerate() {
            out.push_str(if i == 0 { "\n" } else { ",\n" });
            out.push_str(r);
        }
        out.push_str("\n]}");
        out
    }
}

/// FNV-1a, 64-bit. A determinism witness, not a security digest.
struct Fnv(u64);

impl Fnv {
    fn bytes(&mut self, b: &[u8]) {
        for &x in b {
            self.0 ^= u64::from(x);
            self.0 = self.0.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
}

/// Replay `input` (see the module docs).
pub fn replay(input: &str) -> ReplayReport {
    let mut report = ReplayReport {
        entries: 0,
        rejected: 0,
        results: Vec::new(),
        digest: 0,
    };
    let mut fnv = Fnv(0xcbf2_9ce4_8422_2325);
    for line in input.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let result = match yaml::parse_value(line) {
            Ok(Some(Value::Map(args))) => match run(&args) {
                Some(v) => {
                    report.entries += 1;
                    v
                }
                None => {
                    report.rejected += 1;
                    error_value("unknown operation or bad arguments")
                }
            },
            Ok(_) => {
                report.rejected += 1;
                error_value("an operation is a mapping")
            }
            Err(e) => {
                report.rejected += 1;
                error_value(&e.to_string())
            }
        };
        let json = result.to_json();
        fnv.bytes(&(json.len() as u64).to_le_bytes());
        fnv.bytes(json.as_bytes());
        report.results.push(json);
    }
    report.digest = fnv.0;
    report
}

fn error_value(msg: &str) -> Value {
    let mut m = Map::new();
    m.insert("error", Value::string(msg));
    Value::Map(m)
}

fn obj(pairs: Vec<(&str, Value)>) -> Value {
    Value::Map(pairs.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
}

fn strs(v: Option<&Value>) -> Vec<&str> {
    v.and_then(Value::as_list)
        .unwrap_or(&[])
        .iter()
        .filter_map(Value::as_str)
        .collect()
}

fn run(args: &Map) -> Option<Value> {
    let s = |k: &str| args.get(k).and_then(Value::as_str);
    Some(match s("op")? {
        "collection_configuration" => crate::setup::configuration::witness::replay(args),
        "collection_setup" => crate::setup::witness::replay(args),
        "path_key" => Value::string(paths::path_key(s("path")?)),
        "equivalence_groups" => Value::List(
            paths::equivalence_groups(strs(args.get("paths")))
                .into_iter()
                .map(|g| Value::List(g.into_iter().map(Value::Text).collect()))
                .collect(),
        ),
        "allocate_path" => Value::string(paths::allocate_path(
            s("requested")?,
            strs(args.get("existing")),
        )),
        "check_path" => Value::string(match paths::check_path(s("path")?) {
            Ok(()) => "ok",
            Err(v) => v.reason(),
        }),
        "derive_path" => {
            let fm = args
                .get("frontmatter")
                .and_then(Value::as_map)
                .cloned()
                .unwrap_or_default();
            match paths::derive_path(s("pattern")?, &fm) {
                Ok(p) => obj(vec![("path", Value::Text(p))]),
                Err(e) => obj(vec![
                    ("error", Value::string(e.code())),
                    ("field", e.field().map_or(Value::Null, Value::string)),
                ]),
            }
        }
        "parse" => {
            let d = Document::parse_at(s("path")?, s("source")?);
            obj(vec![
                ("frontmatter", Value::Map(d.frontmatter().clone())),
                ("body", Value::string(d.body())),
                (
                    "problem",
                    d.problem()
                        .map_or(Value::Null, |p| Value::string(p.reason())),
                ),
            ])
        }
        "write" => {
            let d = Document::parse_at(s("path")?, s("source")?);
            let mut changes = Vec::new();
            if let Some(set) = args.get("set").and_then(Value::as_map) {
                for (k, v) in set.iter() {
                    changes.push((k.to_owned(), Change::Set(v.clone())));
                }
            }
            for k in strs(args.get("remove")) {
                changes.push((k.to_owned(), Change::Remove));
            }
            match writer::write(&d, &changes, s("body")) {
                Ok(doc) => obj(vec![("document", Value::Text(doc))]),
                Err(e) => obj(vec![("error", Value::string(e.to_string()))]),
            }
        }
        "merge" => {
            let types: Vec<&str> = strs(args.get("types"));
            // Type sources go in the default types folder.
            let paths: Vec<String> = (0..types.len())
                .map(|i| format!("_types/t{i}.md"))
                .collect();
            let catalog = crate::types::Catalog::load(
                paths.iter().map(String::as_str).zip(types.iter().copied()),
            );
            let paths = args.get("paths").and_then(Value::as_map);
            let path_of = |side: &str| {
                paths
                    .and_then(|p| p.get(side))
                    .and_then(Value::as_str)
                    .or_else(|| s("path"))
                    .unwrap_or("")
            };
            let version = |side: &'static str| -> Option<Version<'_>> {
                Some(Version {
                    path: path_of(side),
                    source: s(side)?,
                })
            };
            let m = merge::merge_records(
                version("base")?,
                version("first")?,
                version("second")?,
                &catalog,
            );
            let conflicts = m
                .conflicts
                .iter()
                .map(|c| {
                    let side = |v: &ConflictValue| match v {
                        ConflictValue::Missing => obj(vec![("missing", Value::Bool(true))]),
                        ConflictValue::Value(v) => obj(vec![("value", v.clone())]),
                        ConflictValue::Text(t) => obj(vec![("text", Value::string(t.clone()))]),
                    };
                    obj(vec![
                        ("kind", Value::string(c.kind.as_str())),
                        ("field", c.field.clone().map_or(Value::Null, Value::Text)),
                        ("base", side(&c.base)),
                        ("first", side(&c.first)),
                        ("second", side(&c.second)),
                    ])
                })
                .collect();
            obj(vec![
                ("document", Value::Text(m.document)),
                ("path", Value::Text(m.path)),
                ("conflicts", Value::List(conflicts)),
            ])
        }
        "merge_body" => merge::merge_body(s("base")?, s("first")?, s("second")?)
            .map_or(Value::Null, Value::Text),
        "body_edits" => {
            let mut edits = Vec::new();
            for e in args.get("edits").and_then(Value::as_list).unwrap_or(&[]) {
                let e = e.as_list()?;
                let num = |v: &Value| match v {
                    Value::Int(i) => u64::try_from(*i).ok(),
                    _ => None,
                };
                edits.push(BodyEdit {
                    start: num(e.first()?)?,
                    end: num(e.get(1)?)?,
                    insert: e.get(2)?.as_str()?.to_owned(),
                });
            }
            let base = match s("base") {
                Some(b) => BodyBase::Text(b),
                None => BodyBase::Unavailable,
            };
            match merge::apply_body_edits(s("current")?, base, &edits) {
                Ok(body) => obj(vec![("body", Value::Text(body))]),
                Err(e) => obj(vec![
                    ("error", Value::string(e.code)),
                    ("reason", Value::string(e.reason)),
                ]),
            }
        }
        "detect_moves" => {
            let side = |k: &str| -> Option<Vec<Observed<'_>>> {
                let mut out = Vec::new();
                for o in args.get(k).and_then(Value::as_list).unwrap_or(&[]) {
                    out.push(Observed {
                        path: o.get("path")?.as_str()?,
                        content: o.get("content")?.as_str()?,
                        file_id: o.get("file_id").and_then(Value::as_str).map(str::as_bytes),
                    });
                }
                Some(out)
            };
            let r = moves::detect_moves(&side("disappeared")?, &side("appeared")?, s("id_field"));
            let texts = |v: Vec<String>| Value::List(v.into_iter().map(Value::Text).collect());
            obj(vec![
                (
                    "moves",
                    Value::List(
                        r.moves
                            .into_iter()
                            .map(|m| {
                                obj(vec![
                                    ("from", Value::Text(m.from)),
                                    ("to", Value::Text(m.to)),
                                ])
                            })
                            .collect(),
                    ),
                ),
                ("deleted", texts(r.deleted)),
                ("created", texts(r.created)),
            ])
        }
        "bases_primitive" => return crate::views::bases::witness::run(args),
        "bases_temporal" => return crate::views::bases::witness::temporal(args),
        "bases_duration" => return crate::views::bases::witness::duration(args),
        "bases_discovery" => return crate::views::bases::witness::contract_discovery(args),
        "bases_ordering" => return crate::views::bases::witness::typed_ordering(args),
        "bases_view" => return crate::views::bases::witness::whole_view(args),
        "bases_filter" => return crate::views::bases::witness::filter_plan(args),
        "bases_file_values" => return crate::views::bases::witness::file_bindings(args),
        "bases_raw" => return crate::views::bases::witness::raw_bindings(args),
        "bases_slice1" => return crate::views::bases::witness::slice1(args),
        "bases_calendar" => return crate::views::bases::witness::calendar(args),
        "bases_duration_values" => return crate::views::bases::witness::duration_values(args),
        "bases_capture" => return crate::views::bases::witness::capture(args),
        "bases_properties" => return crate::views::bases::witness::properties(args),
        "cel" => {
            let record = args
                .get("record")
                .and_then(Value::as_map)
                .cloned()
                .unwrap_or_default();
            let act = crate::cel::record_activation(&record, &record, crate::cel::CelValue::Null);
            match crate::cel::compile(s("expression")?) {
                Err(e) => obj(vec![("compile_error", Value::Text(e.to_string()))]),
                Ok(p) => match p.evaluate(&act) {
                    Ok(v) => obj(vec![(
                        "value",
                        v.to_value().unwrap_or(Value::string(v.display())),
                    )]),
                    Err(e) => obj(vec![("error", Value::Text(e.message))]),
                },
            }
        }
        "regex_match" => match crate::regex::is_match(s("pattern")?, s("text")?) {
            Ok(m) => Value::Bool(m),
            Err(e) => obj(vec![("error", Value::Text(e.message))]),
        },
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replay_reports_results_and_rejections() {
        let r = replay("# c\n{op: path_key, path: \"Straße.md\"}\nnot an op\n{op: nope}\n");
        assert_eq!((r.entries, r.rejected), (1, 2));
        assert_eq!(r.results[0], "\"strasse.md\"");
        assert_eq!(
            r,
            replay("# c\n{op: path_key, path: \"Straße.md\"}\nnot an op\n{op: nope}\n")
        );
    }
}
