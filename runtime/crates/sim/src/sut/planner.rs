//! `SimPlanner`: model semantics for the replica while core planning is a stub.
//!
//! **Not the product's semantics.** `mdbn_core::plan::plan` is the real planner;
//! as soon as it plans these operations the simulator switches to
//! `mdbn_replica::plan::CorePlanner` and this module goes away. Until then it
//! gives the replica engine enough to run the vertical slice with the S-class
//! rules that matter for the protocol (decided at the head):
//!
//! - `create`: explicit path; a taken path or ID is `conflict` / `invalid_request`;
//! - `update`: `patch` sets top-level text keys (last writer at the head wins),
//!   `add` unions list items (`tags`), on a tiny line-based frontmatter;
//! - `rename`: `from` must equal the path at the head and `to` must be free;
//! - `delete`, and `document` (blind replace) for external edits.
//!
//! Document format (sim only):
//!
//! ```text
//! ---
//! title: Note 3
//! status: open
//! tags: [tk000001x, tk000007x]
//! ---
//! body
//! ```

use mdbn_core::intent::{Mutation, Op};
use mdbn_core::plan::{Alias, Effect, PlanOptions, Planned, RejectCode, Rejection};
use mdbn_core::state::StateView;
use mdbn_core::value::Value;
use mdbn_replica::plan::Planner;

/// The model planner.
#[derive(Debug, Clone, Copy, Default)]
pub struct SimPlanner;

/// A parsed sim document.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SimDoc {
    /// Ordered `key: value` lines (lists as `[a, b]`).
    pub fields: Vec<(String, String)>,
    /// Body after the frontmatter.
    pub body: String,
}

impl SimDoc {
    /// Parse; anything unparseable becomes body.
    pub fn parse(src: &str) -> SimDoc {
        let Some(rest) = src.strip_prefix("---\n") else {
            return SimDoc {
                fields: Vec::new(),
                body: src.to_string(),
            };
        };
        let Some((fm, body)) = rest.split_once("---\n") else {
            return SimDoc {
                fields: Vec::new(),
                body: src.to_string(),
            };
        };
        let fields = fm
            .lines()
            .filter_map(|l| l.split_once(": "))
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        SimDoc {
            fields,
            body: body.to_string(),
        }
    }

    /// Render.
    pub fn render(&self) -> String {
        let mut s = String::from("---\n");
        for (k, v) in &self.fields {
            s.push_str(&format!("{k}: {v}\n"));
        }
        s.push_str("---\n");
        s.push_str(&self.body);
        s
    }

    /// Set a key.
    pub fn set(&mut self, k: &str, v: String) {
        match self.fields.iter_mut().find(|(x, _)| x == k) {
            Some(f) => f.1 = v,
            None => self.fields.push((k.to_string(), v)),
        }
    }

    /// List items of a key.
    pub fn list(&self, k: &str) -> Vec<String> {
        self.fields
            .iter()
            .find(|(x, _)| x == k)
            .map(|(_, v)| {
                v.trim_start_matches('[')
                    .trim_end_matches(']')
                    .split(", ")
                    .filter(|s| !s.is_empty())
                    .map(String::from)
                    .collect()
            })
            .unwrap_or_default()
    }
}

fn text(v: &Value) -> String {
    match v {
        Value::Text(s) => s.clone(),
        Value::Int(i) => i.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".into(),
        other => format!("{other:?}"),
    }
}

fn conflict(reason: &'static str) -> Rejection {
    Rejection::new(RejectCode::Conflict, Some(reason), reason)
}

impl Planner for SimPlanner {
    fn plan(
        &self,
        m: &Mutation,
        state: &dyn StateView,
        _opts: &PlanOptions,
    ) -> Result<Planned, Rejection> {
        let mut out = Planned::noop();
        // Effects of earlier ops in this mutation shadow the state.
        let current = |out: &Planned, id: &mdbn_core::ids::Uuid| -> Option<(String, String)> {
            for e in out.effects.iter().rev() {
                match e {
                    Effect::PutRecord { id: i, path, doc } if i == id => {
                        return Some((path.clone(), doc.clone()));
                    }
                    Effect::RemoveRecord { id: i, .. } if i == id => return None,
                    _ => {}
                }
            }
            state
                .record(id)
                .map(|r| (r.path.clone(), r.source.to_string()))
        };
        let taken = |out: &Planned, path: &str| -> bool {
            let key = mdbn_core::paths::path_key(path);
            let by_effects = out.effects.iter().rev().find_map(|e| match e {
                Effect::PutRecord { path: p, .. } if mdbn_core::paths::path_key(p) == key => {
                    Some(true)
                }
                _ => None,
            });
            by_effects.unwrap_or_else(|| state.at_path_key(&key).is_some())
        };
        for op in &m.ops {
            match op {
                Op::Create(c) => {
                    let path = c
                        .path
                        .clone()
                        .unwrap_or_else(|| format!("notes/{}.md", c.id));
                    if taken(&out, &path) {
                        return Err(conflict("path_taken"));
                    }
                    if current(&out, &c.id).is_some() {
                        return Err(Rejection::new(
                            RejectCode::InvalidRequest,
                            Some("duplicate_id"),
                            "id exists",
                        ));
                    }
                    let doc = c.document.clone().or(c.body.clone()).unwrap_or_default();
                    out.effects.push(Effect::PutRecord {
                        id: c.id,
                        path,
                        doc,
                    });
                }
                Op::Update(u) => {
                    let Some((path, src)) = current(&out, &u.id) else {
                        return Err(Rejection::new(
                            RejectCode::NotFound,
                            Some("no_record"),
                            "no such record",
                        ));
                    };
                    let mut d = SimDoc::parse(&src);
                    if let Some(p) = &u.patch {
                        for (k, v) in p.iter() {
                            d.set(k, text(v));
                        }
                    }
                    for (k, items) in &u.add {
                        let mut l = d.list(k);
                        for it in items {
                            let t = text(it);
                            if !l.contains(&t) {
                                l.push(t);
                            }
                        }
                        d.set(k, format!("[{}]", l.join(", ")));
                    }
                    if let Some(b) = &u.body {
                        d.body = b.clone();
                    }
                    let doc = d.render();
                    if doc != src {
                        out.effects.push(Effect::PutRecord {
                            id: u.id,
                            path,
                            doc,
                        });
                    }
                }
                Op::Rename(r) => {
                    let Some((path, doc)) = current(&out, &r.id) else {
                        return Err(Rejection::new(
                            RejectCode::NotFound,
                            Some("no_record"),
                            "no such record",
                        ));
                    };
                    if path != r.from {
                        return Err(conflict("rename_from_moved"));
                    }
                    if r.to == path {
                        continue;
                    }
                    if taken(&out, &r.to) {
                        return Err(conflict("path_taken"));
                    }
                    out.aliases.push(Alias {
                        path: path.clone(),
                        id: r.id,
                    });
                    out.effects.push(Effect::PutRecord {
                        id: r.id,
                        path: r.to.clone(),
                        doc,
                    });
                }
                Op::Delete(d) => {
                    if let Some((path, _)) = current(&out, &d.id) {
                        out.effects.push(Effect::RemoveRecord { id: d.id, path });
                    }
                }
                Op::Document(d) => match (&d.new, current(&out, &d.id)) {
                    (Some(n), _) => out.effects.push(Effect::PutRecord {
                        id: d.id,
                        path: n.path.clone(),
                        doc: n.doc.clone(),
                    }),
                    (None, Some((path, _))) => {
                        out.effects.push(Effect::RemoveRecord { id: d.id, path })
                    }
                    (None, None) => {}
                },
                _ => {
                    return Err(Rejection::new(
                        RejectCode::InvalidRequest,
                        Some("unsupported"),
                        "not modelled by SimPlanner",
                    ));
                }
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doc_roundtrip_and_lists() {
        let src = "---\ntitle: A\ntags: [x, y]\n---\nbody\n";
        let mut d = SimDoc::parse(src);
        assert_eq!(d.render(), src);
        assert_eq!(d.list("tags"), vec!["x", "y"]);
        d.set("status", "done".into());
        assert!(d.render().contains("status: done\n"));
    }
}
