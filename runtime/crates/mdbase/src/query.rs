//! Queries (spec 11): a builder for the common case, raw JSON for the rest.

use serde_json::{Value, json};

/// Sort direction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Order {
    /// Ascending.
    Asc,
    /// Descending.
    Desc,
}

/// A query. Build one with the methods here, or wrap a spec 11 query object
/// with [`Query::from_json`].
///
/// ```
/// use mdbase::{Order, Query};
/// let q = Query::of_type("task")
///     .filter("status == 'open' && due <= today()")
///     .order_by("due", Order::Asc)
///     .limit(50);
/// assert_eq!(q.to_json()["types"], serde_json::json!(["task"]));
/// ```
#[derive(Debug, Clone, Default)]
pub struct Query {
    types: Vec<String>,
    filter: Option<String>,
    order: Vec<(String, Order)>,
    limit: Option<u64>,
    offset: Option<u64>,
    body: bool,
    timezone: Option<String>,
    raw: Option<Value>,
}

impl Query {
    /// Every record.
    pub fn all() -> Query {
        Query::default()
    }

    /// Records of one type.
    pub fn of_type(name: impl Into<String>) -> Query {
        Query::default().types([name.into()])
    }

    /// Restrict to these types (any of them).
    pub fn types<I, S>(mut self, names: I) -> Query
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.types = names.into_iter().map(Into::into).collect();
        self
    }

    /// A CEL filter (`where`). Fields are the record's frontmatter; `file.path`,
    /// `now()` and `today()` are available.
    pub fn filter(mut self, cel: impl Into<String>) -> Query {
        self.filter = Some(cel.into());
        self
    }

    /// Add a sort key. Call again for secondary keys.
    pub fn order_by(mut self, field: impl Into<String>, order: Order) -> Query {
        self.order.push((field.into(), order));
        self
    }

    /// At most `n` records.
    pub fn limit(mut self, n: u64) -> Query {
        self.limit = Some(n);
        self
    }

    /// Skip the first `n` records.
    pub fn offset(mut self, n: u64) -> Query {
        self.offset = Some(n);
        self
    }

    /// Include each record's body in the result.
    pub fn with_body(mut self) -> Query {
        self.body = true;
        self
    }

    /// The IANA zone for `today()` and date comparisons.
    pub fn timezone(mut self, tz: impl Into<String>) -> Query {
        self.timezone = Some(tz.into());
        self
    }

    /// A raw spec 11 query object (`types`, `where`, `order_by`, `limit`,
    /// `offset`, `projections`, `select`, `include_body`, `timezone`, ...).
    pub fn from_json(query: Value) -> Query {
        Query {
            raw: Some(query),
            ..Query::default()
        }
    }

    /// The spec 11 query object this builds.
    pub fn to_json(&self) -> Value {
        if let Some(raw) = &self.raw {
            return raw.clone();
        }
        let mut q = serde_json::Map::new();
        if !self.types.is_empty() {
            q.insert("types".into(), json!(self.types));
        }
        if let Some(w) = &self.filter {
            q.insert("where".into(), json!(w));
        }
        if !self.order.is_empty() {
            q.insert(
                "order_by".into(),
                Value::Array(
                    self.order
                        .iter()
                        .map(|(f, o)| {
                            json!({"field": f, "direction": match o { Order::Asc => "asc", Order::Desc => "desc" }})
                        })
                        .collect(),
                ),
            );
        }
        if let Some(n) = self.limit {
            q.insert("limit".into(), json!(n));
        }
        if let Some(n) = self.offset {
            q.insert("offset".into(), json!(n));
        }
        if self.body {
            q.insert("include_body".into(), json!(true));
        }
        if let Some(tz) = &self.timezone {
            q.insert("timezone".into(), json!(tz));
        }
        Value::Object(q)
    }

    pub(crate) fn wants_body(&self) -> bool {
        self.body
            || self
                .raw
                .as_ref()
                .and_then(|r| r.get("include_body"))
                .and_then(Value::as_bool)
                .unwrap_or(false)
    }
}

impl From<Value> for Query {
    fn from(v: Value) -> Query {
        Query::from_json(v)
    }
}
