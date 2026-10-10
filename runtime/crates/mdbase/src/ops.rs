//! Write operations. Each is plain data: build it, then apply it with
//! [`crate::Collection::apply`] (one op, one mutation) or
//! [`crate::Collection::batch`] (several ops, one atomic mutation). The
//! collection's `create`/`update`/`delete`/`rename` methods are shorthands
//! that build and apply in one go.

use serde_json::Value;

use crate::value::{RecordId, Revision};

/// A record to operate on: by path or by ID. `&str`, `String`, [`RecordId`]
/// and `&Record` convert into it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    /// A collection path (`tasks/a.md`).
    Path(String),
    /// A record ID.
    Id(RecordId),
}

impl From<&str> for Target {
    fn from(s: &str) -> Target {
        Target::Path(s.to_owned())
    }
}
impl From<String> for Target {
    fn from(s: String) -> Target {
        Target::Path(s)
    }
}
impl From<&String> for Target {
    fn from(s: &String) -> Target {
        Target::Path(s.clone())
    }
}
impl From<RecordId> for Target {
    fn from(id: RecordId) -> Target {
        Target::Id(id)
    }
}
impl From<&crate::Record> for Target {
    fn from(r: &crate::Record) -> Target {
        Target::Id(r.id)
    }
}

impl std::fmt::Display for Target {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Target::Path(p) => f.write_str(p),
            Target::Id(id) => write!(f, "{id}"),
        }
    }
}

/// Create a record.
#[derive(Debug, Clone, Default)]
pub struct Create {
    pub(crate) path: Option<String>,
    pub(crate) type_name: Option<String>,
    pub(crate) frontmatter: Vec<(String, Value)>,
    pub(crate) body: Option<String>,
    pub(crate) document: Option<String>,
}

impl Create {
    /// A record at `path`.
    pub fn at(path: impl Into<String>) -> Create {
        Create {
            path: Some(path.into()),
            ..Create::default()
        }
    }

    /// A record whose path the type's path policy derives. Set the type with
    /// [`Create::type_name`] or a `type` field.
    pub fn derived() -> Create {
        Create::default()
    }

    /// The type to create as (sets the explicit type key).
    pub fn type_name(mut self, name: impl Into<String>) -> Create {
        self.type_name = Some(name.into());
        self
    }

    /// One frontmatter field. Fields are written in call order.
    pub fn field(mut self, key: impl Into<String>, value: impl Into<Value>) -> Create {
        let key = key.into();
        self.frontmatter.retain(|(k, _)| *k != key);
        self.frontmatter.push((key, value.into()));
        self
    }

    /// Several frontmatter fields from a JSON object (keys in the object's
    /// order, which `serde_json` sorts; use [`Create::field`] to control order).
    pub fn frontmatter(mut self, object: Value) -> Create {
        if let Value::Object(m) = object {
            for (k, v) in m {
                self = self.field(k, v);
            }
        }
        self
    }

    /// The Markdown body.
    pub fn body(mut self, body: impl Into<String>) -> Create {
        self.body = Some(body.into());
        self
    }

    /// The whole file text instead of frontmatter + body.
    pub fn document(mut self, text: impl Into<String>) -> Create {
        self.document = Some(text.into());
        self
    }
}

/// Update a record's fields and body.
#[derive(Debug, Clone)]
pub struct Update {
    pub(crate) target: Target,
    pub(crate) set: Vec<(String, Value)>,
    pub(crate) unset: Vec<String>,
    pub(crate) add: Vec<(String, Vec<Value>)>,
    pub(crate) remove: Vec<(String, Vec<Value>)>,
    pub(crate) body: Option<String>,
    pub(crate) if_revision: Option<Revision>,
}

impl Update {
    /// Update the record at `target`.
    pub fn at(target: impl Into<Target>) -> Update {
        Update {
            target: target.into(),
            set: Vec::new(),
            unset: Vec::new(),
            add: Vec::new(),
            remove: Vec::new(),
            body: None,
            if_revision: None,
        }
    }

    /// Set a field (nested paths with `.` are not interpreted; keys are top-level).
    pub fn set(mut self, key: impl Into<String>, value: impl Into<Value>) -> Update {
        self.set.push((key.into(), value.into()));
        self
    }

    /// Remove a field.
    pub fn unset(mut self, key: impl Into<String>) -> Update {
        self.unset.push(key.into());
        self
    }

    /// Add values to a list field (set semantics: no duplicates).
    pub fn add(
        mut self,
        key: impl Into<String>,
        values: impl IntoIterator<Item = Value>,
    ) -> Update {
        self.add.push((key.into(), values.into_iter().collect()));
        self
    }

    /// Remove values from a list field.
    pub fn remove(
        mut self,
        key: impl Into<String>,
        values: impl IntoIterator<Item = Value>,
    ) -> Update {
        self.remove.push((key.into(), values.into_iter().collect()));
        self
    }

    /// Replace the body.
    pub fn body(mut self, body: impl Into<String>) -> Update {
        self.body = Some(body.into());
        self
    }

    /// Only if the record's revision is still `rev` (optimistic concurrency).
    pub fn if_revision(mut self, rev: Revision) -> Update {
        self.if_revision = Some(rev);
        self
    }
}

/// Replace a record's whole document (frontmatter and body).
#[derive(Debug, Clone)]
pub struct Replace {
    pub(crate) target: Target,
    pub(crate) document: String,
    pub(crate) if_revision: Option<Revision>,
}

impl Replace {
    /// Replace the file at `target` with `document`.
    pub fn at(target: impl Into<Target>, document: impl Into<String>) -> Replace {
        Replace {
            target: target.into(),
            document: document.into(),
            if_revision: None,
        }
    }

    /// Only if the record's revision is still `rev`.
    pub fn if_revision(mut self, rev: Revision) -> Replace {
        self.if_revision = Some(rev);
        self
    }
}

/// Delete a record.
#[derive(Debug, Clone)]
pub struct Delete {
    pub(crate) target: Target,
    pub(crate) if_revision: Option<Revision>,
}

impl Delete {
    /// Delete the record at `target`.
    pub fn at(target: impl Into<Target>) -> Delete {
        Delete {
            target: target.into(),
            if_revision: None,
        }
    }

    /// Only if the record's revision is still `rev`.
    pub fn if_revision(mut self, rev: Revision) -> Delete {
        self.if_revision = Some(rev);
        self
    }
}

/// Move a record to another path, rewriting links to it.
#[derive(Debug, Clone)]
pub struct Rename {
    pub(crate) target: Target,
    pub(crate) to: String,
    pub(crate) update_refs: bool,
    pub(crate) if_revision: Option<Revision>,
}

impl Rename {
    /// Move the record at `from` to `to`.
    pub fn new(from: impl Into<Target>, to: impl Into<String>) -> Rename {
        Rename {
            target: from.into(),
            to: to.into(),
            update_refs: true,
            if_revision: None,
        }
    }

    /// Leave links in other records untouched (default: rewrite them).
    pub fn keep_refs(mut self) -> Rename {
        self.update_refs = false;
        self
    }

    /// Only if the record's revision is still `rev`.
    pub fn if_revision(mut self, rev: Revision) -> Rename {
        self.if_revision = Some(rev);
        self
    }
}

/// Any write operation.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub enum Op {
    /// Create.
    Create(Create),
    /// Update.
    Update(Update),
    /// Replace the document.
    Replace(Replace),
    /// Delete.
    Delete(Delete),
    /// Rename.
    Rename(Rename),
}

impl From<Create> for Op {
    fn from(o: Create) -> Op {
        Op::Create(o)
    }
}
impl From<Update> for Op {
    fn from(o: Update) -> Op {
        Op::Update(o)
    }
}
impl From<Replace> for Op {
    fn from(o: Replace) -> Op {
        Op::Replace(o)
    }
}
impl From<Delete> for Op {
    fn from(o: Delete) -> Op {
        Op::Delete(o)
    }
}
impl From<Rename> for Op {
    fn from(o: Rename) -> Op {
        Op::Rename(o)
    }
}
