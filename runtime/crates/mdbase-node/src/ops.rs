//! JSON dispatch onto [`mdbase::Collection`].

use mdbase::{
    Collection, Create, Delete, Error, InitOptions, Op, Query, Record, RecordId, Rename, Replace,
    Resolution, Revision, Target, Update,
};
use serde_json::{Value, json};

/// `{error: {code, message, help}}`.
pub fn error_value(code: &str, message: &str, help: &str) -> Value {
    json!({ "error": { "code": code, "message": message, "help": help } })
}

/// An [`Error`] as `{error: …}`.
pub fn error_json(e: &Error) -> Value {
    let mut err = json!({ "code": e.code(), "message": e.to_string(), "help": e.help() });
    match e {
        Error::Rejected { reason, issues, .. } => {
            err["reason"] = json!(reason);
            err["issues"] = Value::Array(issues.iter().map(issue).collect());
        }
        Error::Conflict { reason, .. } => err["reason"] = json!(reason),
        Error::Query { location, .. } => err["location"] = json!(location),
        Error::AlreadyHosted { host, stale, .. } => {
            err["host"] = json!(host.as_ref().map(|h| format!("{h:?}").to_lowercase()));
            err["stale"] = json!(stale);
        }
        Error::NotFound { target } => err["target"] = json!(target),
        _ => {}
    }
    json!({ "error": err })
}

fn issue(i: &mdbase::Issue) -> Value {
    json!({
        "code": i.code,
        "severity": match i.severity { mdbase::Severity::Error => "error", mdbase::Severity::Warning => "warning" },
        "message": i.message,
        "location": i.location,
        "type": i.type_name,
        "details": i.details,
    })
}

fn record(r: &Record) -> Value {
    json!({
        "id": r.id.to_string(),
        "path": r.path,
        "revision": r.revision.to_string(),
        "frontmatter": r.frontmatter,
        "effective": r.effective,
        "body": r.body,
        "document": r.document,
        "types": r.types,
        "issues": r.issues.iter().map(issue).collect::<Vec<_>>(),
    })
}

fn ok<T: Into<Value>>(v: T) -> Value {
    json!({ "ok": v.into() })
}

fn res(r: mdbase::Result<Value>) -> Value {
    match r {
        Ok(v) => ok(v),
        Err(e) => error_json(&e),
    }
}

fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

fn options(v: &Value, root: &str) -> mdbase::OpenOptions {
    let mut o = Collection::builder(root);
    if let Some(d) = str_of(v, "stateDir") {
        o = o.state_dir(d);
    }
    if v.get("constrained").and_then(Value::as_bool) == Some(true) {
        o = o.constrained();
    }
    if let Some(tz) = str_of(v, "timezone") {
        o = o.timezone(tz);
    }
    if v.get("takeOver").and_then(Value::as_bool) == Some(true) {
        o = o.take_over(true);
    }
    if let Some(c) = v.get("client").and_then(Value::as_array)
        && let (Some(n), Some(ver)) = (
            c.first().and_then(Value::as_str),
            c.get(1).and_then(Value::as_str),
        )
    {
        o = o.client(n, ver);
    }
    o
}

/// Open.
pub fn open(root: &str, opts: &Value) -> mdbase::Result<Collection> {
    options(opts, root).open()
}

/// Init then open.
pub fn init(root: &str, init: &Value, opts: &Value) -> mdbase::Result<Collection> {
    Collection::init(
        root,
        InitOptions {
            name: str_of(init, "name").map(str::to_owned),
            timezone: str_of(init, "timezone").map(str::to_owned),
        },
    )?;
    options(opts, root).open()
}

fn target(v: &Value) -> Result<Target, Value> {
    match v {
        Value::String(s) => Ok(Target::Path(s.clone())),
        Value::Object(m) => {
            if let Some(Value::String(id)) = m.get("id") {
                RecordId::parse(id).map(Target::Id).ok_or_else(|| {
                    error_value(
                        "invalid_input",
                        "`id` is not a UUID",
                        "Pass a record ID from a previous read.",
                    )
                })
            } else if let Some(Value::String(p)) = m.get("path") {
                Ok(Target::Path(p.clone()))
            } else {
                Err(error_value(
                    "invalid_input",
                    "a target is a path string or {id} / {path}",
                    "",
                ))
            }
        }
        _ => Err(error_value(
            "invalid_input",
            "a target is a path string or {id} / {path}",
            "",
        )),
    }
}

fn revision(v: Option<&Value>) -> Result<Option<Revision>, Value> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Revision::parse(s).map(Some).ok_or_else(|| {
            error_value(
                "invalid_input",
                "`ifRevision` is not a `sha256:` revision",
                "Pass `record.revision` from a previous read.",
            )
        }),
        Some(_) => Err(error_value(
            "invalid_input",
            "`ifRevision` must be a string",
            "",
        )),
    }
}

fn op_of(v: &Value) -> Result<Op, Value> {
    let kind = str_of(v, "op")
        .ok_or_else(|| error_value("invalid_input", "an operation needs `op`", ""))?;
    Ok(match kind {
        "create" => {
            let mut c = match str_of(v, "path") {
                Some(p) => Create::at(p),
                None => Create::derived(),
            };
            if let Some(t) = str_of(v, "type") {
                c = c.type_name(t);
            }
            if let Some(Value::Object(fm)) = v.get("frontmatter") {
                for (k, val) in fm {
                    c = c.field(k, val.clone());
                }
            }
            if let Some(b) = str_of(v, "body") {
                c = c.body(b);
            }
            if let Some(d) = str_of(v, "document") {
                c = c.document(d);
            }
            Op::Create(c)
        }
        "update" => {
            let mut u = Update::at(target(v.get("target").unwrap_or(&Value::Null))?);
            if let Some(Value::Object(m)) = v.get("set") {
                for (k, val) in m {
                    u = u.set(k, val.clone());
                }
            }
            if let Some(Value::Array(a)) = v.get("unset") {
                for k in a.iter().filter_map(Value::as_str) {
                    u = u.unset(k);
                }
            }
            if let Some(Value::Object(m)) = v.get("add") {
                for (k, vals) in m {
                    u = u.add(k, vals.as_array().cloned().unwrap_or_default());
                }
            }
            if let Some(Value::Object(m)) = v.get("remove") {
                for (k, vals) in m {
                    u = u.remove(k, vals.as_array().cloned().unwrap_or_default());
                }
            }
            if let Some(b) = str_of(v, "body") {
                u = u.body(b);
            }
            if let Some(r) = revision(v.get("ifRevision"))? {
                u = u.if_revision(r);
            }
            Op::Update(u)
        }
        "replace" => {
            let mut r = Replace::at(
                target(v.get("target").unwrap_or(&Value::Null))?,
                str_of(v, "document").unwrap_or_default(),
            );
            if let Some(rev) = revision(v.get("ifRevision"))? {
                r = r.if_revision(rev);
            }
            Op::Replace(r)
        }
        "delete" => {
            let mut d = Delete::at(target(v.get("target").unwrap_or(&Value::Null))?);
            if let Some(r) = revision(v.get("ifRevision"))? {
                d = d.if_revision(r);
            }
            Op::Delete(d)
        }
        "rename" => {
            let mut r = Rename::new(
                target(v.get("target").unwrap_or(&Value::Null))?,
                str_of(v, "to").unwrap_or_default(),
            );
            if v.get("updateRefs").and_then(Value::as_bool) == Some(false) {
                r = r.keep_refs();
            }
            if let Some(rev) = revision(v.get("ifRevision"))? {
                r = r.if_revision(rev);
            }
            Op::Rename(r)
        }
        other => {
            return Err(error_value(
                "invalid_input",
                &format!("unknown operation `{other}`"),
                "Operations are create, update, replace, delete and rename.",
            ));
        }
    })
}

/// Run one op by name.
pub fn dispatch(col: &Collection, op: &str, args: &Value) -> Value {
    match op {
        "root" => ok(col.root().display().to_string()),
        "get" => match target(args.get("target").unwrap_or(&Value::Null)) {
            Ok(t) => res(col.get(t).map(|r| r.as_ref().map(record).unwrap_or(Value::Null))),
            Err(e) => e,
        },
        "document" => match target(args.get("target").unwrap_or(&Value::Null)) {
            Ok(t) => res(col.document(t).map(|d| json!(d))),
            Err(e) => e,
        },
        "query" => {
            let q = Query::from_json(args.get("query").cloned().unwrap_or(json!({})));
            res(col.query(q).map(|p| {
                json!({
                    "records": p.records.iter().map(record).collect::<Vec<_>>(),
                    "complete": p.complete,
                    "issues": p.issues.iter().map(issue).collect::<Vec<_>>(),
                })
            }))
        }
        "apply" | "batch" => {
            let list: Vec<&Value> = match args.get("ops") {
                Some(Value::Array(a)) => a.iter().collect(),
                _ => return error_value("invalid_input", "`ops` must be an array", ""),
            };
            let mut ops = Vec::with_capacity(list.len());
            for v in list {
                match op_of(v) {
                    Ok(o) => ops.push(o),
                    Err(e) => return e,
                }
            }
            res(col.batch(ops).map(|rs| Value::Array(rs.iter().map(record).collect())))
        }
        "validate" => res(col.validate().map(|v| {
            Value::Array(
                v.iter()
                    .map(|(p, is)| json!({ "path": p, "issues": is.iter().map(issue).collect::<Vec<_>>() }))
                    .collect(),
            )
        })),
        "validate_one" => match target(args.get("target").unwrap_or(&Value::Null)) {
            Ok(t) => res(col.validate_one(t).map(|is| Value::Array(is.iter().map(issue).collect()))),
            Err(e) => e,
        },
        "types" => ok(json!(col.types())),
        "catalog" => {
            let cat = col.catalog();
            ok(json!({
                "valid": cat.is_valid(),
                "spec_version": cat.spec_version(),
                "types": cat.types().iter().map(|t| json!({
                    "name": t.name, "path": t.source_path, "version": t.version,
                })).collect::<Vec<_>>(),
                "contracts": cat.contracts().iter().map(|c| json!({
                    "id": c.id, "version": c.version.to_string(), "contract_type": c.contract_type,
                    "digest": c.digest.to_string(), "path": c.source_path,
                })).collect::<Vec<_>>(),
                "issues": cat.issues().iter().map(|i| json!({
                    "code": i.code, "message": i.message, "location": i.location, "type": i.type_name,
                })).collect::<Vec<_>>(),
            }))
        }
        "links" => match target(args.get("target").unwrap_or(&Value::Null)) {
            Ok(t) => res(col.links(t).map(|l| {
                json!({
                    "outgoing": l.outgoing.iter().map(|o| json!({
                        "target": o.target, "resolved": o.resolved.map(|id| id.to_string())
                    })).collect::<Vec<_>>(),
                    "backlinks": l.backlinks.iter().map(|id| id.to_string()).collect::<Vec<_>>(),
                })
            })),
            Err(e) => e,
        },
        "changes" => res(col.changes(str_of(args, "cursor")).map(|c| {
            json!({
                "changes": c.changes.iter().map(|ch| json!({
                    "id": ch.id.to_string(), "path": ch.path,
                    "kind": match ch.kind { mdbase::ChangeKind::Put => "put", mdbase::ChangeKind::Remove => "remove" },
                })).collect::<Vec<_>>(),
                "cursor": c.cursor,
                "reset": c.reset,
            })
        })),
        "holds" => res(col.holds().map(|hs| {
            Value::Array(
                hs.iter()
                    .map(|h| json!({ "id": h.id.to_string(), "path": h.path, "reason": h.reason, "since": h.since }))
                    .collect(),
            )
        })),
        "resolve_hold" => {
            let Some(id) = str_of(args, "id").and_then(RecordId::parse) else {
                return error_value("invalid_input", "`id` is not a hold ID", "");
            };
            let how = match (str_of(args, "how"), str_of(args, "text")) {
                (Some("keep_mine"), _) => Resolution::KeepMine,
                (Some("take_theirs"), _) => Resolution::TakeTheirs,
                (Some("use"), Some(t)) => Resolution::Use(t.to_owned()),
                (Some("delete"), _) => Resolution::Delete,
                (Some("keep_both"), _) => Resolution::KeepBoth,
                _ => {
                    return error_value(
                        "invalid_input",
                        "`how` is keep_mine, take_theirs, use (with `text`), delete or keep_both",
                        "",
                    );
                }
            };
            res(col.resolve_hold(id, how).map(|()| Value::Null))
        }
        "status" => res(col.status().map(|s| json!({ "pending": s.pending, "holds": s.holds, "unresolved": s.unresolved }))),
        "rescan" => res(col.rescan().map(|()| Value::Null)),
        "settle" => res(col.settle(args.get("maxWaitMs").and_then(Value::as_u64).unwrap_or(5_000)).map(|b| json!(b))),
        other => error_value(
            "unknown_op",
            &format!("unknown operation `{other}`"),
            "Update the mdbase package; the native addon and the TypeScript wrapper disagree.",
        ),
    }
}
