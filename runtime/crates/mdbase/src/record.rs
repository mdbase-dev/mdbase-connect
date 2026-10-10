//! What reads return.

use serde_json::{Map, Value};

use crate::value::{RecordId, Revision, map_to_json};

/// A diagnostic about a record (spec 14).
#[derive(Debug, Clone, PartialEq)]
pub struct Issue {
    /// `schema_required`, `type_conflict`, `link_not_found`, ...
    pub code: String,
    /// `error` or `warning`.
    pub severity: Severity,
    /// Human-readable (not stable).
    pub message: String,
    /// JSON Pointer into the frontmatter, or a resource path.
    pub location: Option<String>,
    /// The type concerned.
    pub type_name: Option<String>,
    /// Structured details.
    pub details: Option<Value>,
}

/// Issue severity.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    /// Reported, never blocking.
    Warning,
    /// An error at the configured validation level.
    Error,
}

impl Issue {
    pub(crate) fn from_wire(i: &mdbn_wire::client::Issue) -> Issue {
        Issue {
            code: i.code.clone(),
            severity: match i.severity {
                mdbn_wire::client::Severity::Warning => Severity::Warning,
                mdbn_wire::client::Severity::Error => Severity::Error,
            },
            message: i.message.clone(),
            location: None,
            type_name: None,
            details: i.details.as_ref().map(crate::value::to_json),
        }
    }

    pub(crate) fn from_core(i: &mdbn_core::validate::Issue) -> Issue {
        Issue {
            code: i.code.clone(),
            severity: match i.severity {
                mdbn_core::validate::Severity::Warning => Severity::Warning,
                mdbn_core::validate::Severity::Error => Severity::Error,
            },
            message: i.message.clone(),
            location: i.location.clone(),
            type_name: i.type_name.clone(),
            details: i.details.as_ref().map(core_to_json),
        }
    }
}

fn core_to_json(v: &mdbn_core::value::Value) -> Value {
    use mdbn_core::value::Value as C;
    match v {
        C::Null => Value::Null,
        C::Bool(b) => Value::Bool(*b),
        C::Int(i) => Value::from(*i),
        C::Float(f) => serde_json::Number::from_f64(*f).map_or(Value::Null, Value::Number),
        C::Text(s) => Value::String(s.clone()),
        C::List(l) => Value::Array(l.iter().map(core_to_json).collect()),
        C::Map(m) => Value::Object(
            m.iter()
                .map(|(k, v)| (k.to_owned(), core_to_json(v)))
                .collect(),
        ),
    }
}

/// A record.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub struct Record {
    /// Stable ID (survives renames).
    pub id: RecordId,
    /// Collection path.
    pub path: String,
    /// Revision of the file bytes; use as an `if_revision` guard.
    pub revision: Revision,
    /// Frontmatter as written (object keys sorted).
    pub frontmatter: Map<String, Value>,
    /// Frontmatter with type defaults applied, when requested.
    pub effective: Option<Map<String, Value>>,
    /// The body, when requested.
    pub body: Option<String>,
    /// The whole file text, when requested.
    pub document: Option<String>,
    /// The types this record belongs to.
    pub types: Vec<String>,
    /// Validation issues, when requested.
    pub issues: Vec<Issue>,
}

impl Record {
    pub(crate) fn from_view(v: &mdbn_wire::client::RecordView) -> Record {
        Record {
            id: RecordId::from_wire(v.id),
            path: v.path.clone(),
            revision: Revision::from_wire(v.revision),
            frontmatter: map_to_json(&v.frontmatter),
            effective: v.effective.as_ref().map(map_to_json),
            body: v.body.clone(),
            document: v.document.clone(),
            types: v.types.clone(),
            issues: v
                .diagnostics
                .iter()
                .flatten()
                .map(Issue::from_wire)
                .collect(),
        }
    }

    /// A top-level frontmatter field.
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.frontmatter.get(key)
    }
}

/// A page of query results.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub struct Page {
    /// The records, in query order.
    pub records: Vec<Record>,
    /// False while the index is still being built.
    pub complete: bool,
    /// Query diagnostics (unknown fields, ...).
    pub issues: Vec<Issue>,
}

/// One entry of the change feed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Change {
    /// The record.
    pub id: RecordId,
    /// Its path at the time.
    pub path: String,
    /// What happened.
    pub kind: ChangeKind,
}

/// What a change did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeKind {
    /// Created or updated.
    Put,
    /// Deleted.
    Remove,
}

/// The change feed since a cursor.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct Changes {
    /// Changes, oldest first.
    pub changes: Vec<Change>,
    /// Pass this to the next call.
    pub cursor: String,
    /// The history before `cursor` is gone: re-read everything.
    pub reset: bool,
}

/// A file the engine refused to overwrite and set aside (never-clobber publication).
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub struct Hold {
    /// Hold ID.
    pub id: RecordId,
    /// The path.
    pub path: String,
    /// Why: `conflict`, `unknown_provenance`, `deleted_elsewhere`,
    /// `read_only`, `editor_busy`, `suspect_write`.
    pub reason: String,
    /// Unix milliseconds.
    pub since: i64,
}

/// How to resolve a hold.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolution {
    /// Keep the engine's version.
    KeepMine,
    /// Take the bytes on disk.
    TakeTheirs,
    /// Use this text.
    Use(String),
    /// Delete the record.
    Delete,
    /// Keep both (the other as a copy).
    KeepBoth,
}

/// Collection status.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct Status {
    /// Writes not yet published to files.
    pub pending: u64,
    /// Files set aside.
    pub holds: u64,
    /// Records with unresolved conflicts.
    pub unresolved: u64,
}

/// Links of one record.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct Links {
    /// Outgoing links: target as written, and the record it resolves to.
    pub outgoing: Vec<OutgoingLink>,
    /// Records linking here.
    pub backlinks: Vec<RecordId>,
}

/// One outgoing link.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct OutgoingLink {
    /// The link target as written.
    pub target: String,
    /// The record it resolves to, if any.
    pub resolved: Option<RecordId>,
}
