//! The query IR and candidate/residual compilation (spec 11).
//!
//! A [`Query`] is the spec 11 query object, parsed and checked
//! ([`Query::from_value`]). [`compile`] turns it into a [`QueryPlan`]:
//!
//! - **Candidate** ([`Candidate`]): a closed predicate a store can evaluate
//!   over its own indexes (SQLite, Postgres, an in-memory map) to narrow the
//!   records to examine. It is a *necessary* condition: a store may return
//!   extra candidates, never fewer. When [`QueryPlan::exact`] is true the
//!   candidate is also sufficient and the residual may be skipped.
//! - **Residual** ([`QueryPlan::matches`]): the canonical evaluation of `types`
//!   and the CEL `where` against one record. Always correct; the only thing
//!   that decides membership when the candidate is not exact.
//! - **Order** ([`QueryPlan::order`], [`QueryPlan::compare`]): sort keys with
//!   the spec's null placement and the final ascending `file.path` tiebreak.
//! - **Window**: `offset` and `limit` after filtering and sorting.
//!
//! The plan is a pure function of the query and the catalog, so a store can
//! cache it per catalog. Query time and zone are fixed per execution
//! ([`QueryEnv`]); the replica captures them once (spec 11 "Temporal Execution
//! Context").
//!
//! [`execute`] is the reference executor over a [`StateView`]: it scans, so
//! stores use it only as an oracle for their indexed execution.

use std::cmp::Ordering;
use std::collections::BTreeSet;

pub mod groups;
pub mod indexed;
mod lower;
pub mod profile;
pub mod projection;
pub mod topk;

use crate::ids::RecordId;
use crate::state::StateView;
use crate::types::Catalog;
use crate::validate::Issue;
use crate::value::{Map, Value};

/// Sort direction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub enum Direction {
    /// Ascending; nulls last.
    #[default]
    Asc,
    /// Descending; nulls first.
    Desc,
}

/// A field reference in a query: an effective field path, a `file.*` value, a
/// named projection or a selection output.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum FieldRef {
    /// `file.path`.
    Path,
    /// `file.name`, `file.basename`, `file.folder`, `file.ext`, ... (the name).
    File(String),
    /// The matched type names (`types`).
    Types,
    /// An effective frontmatter value at this key path (`due`, `meta.owner`).
    Effective(Vec<String>),
    /// A persisted (raw) frontmatter value at this key path.
    Persisted(Vec<String>),
    /// `projection.<name>`.
    Projection(String),
}

/// One `order_by` term.
#[derive(Debug, Clone, PartialEq)]
pub struct OrderTerm {
    /// What to sort by.
    pub field: FieldRef,
    /// Direction.
    pub direction: Direction,
}

/// One `select` entry.
#[derive(Debug, Clone, PartialEq)]
pub enum Selection {
    /// A field, file value or projection by reference.
    Field(FieldRef),
    /// A named CEL expression.
    Expr {
        /// Output name.
        name: String,
        /// CEL source.
        expr: String,
        /// Display label.
        label: Option<String>,
    },
}

/// `frontmatter_mode` (spec 11).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FrontmatterMode {
    /// `effective_frontmatter` only (default).
    #[default]
    Effective,
    /// `frontmatter` only.
    Persisted,
    /// Both.
    Both,
}

/// The spec 11 query object, checked.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Query {
    /// OR filter over type names; empty = all records.
    pub types: Vec<String>,
    /// CEL `where`.
    pub where_: Option<String>,
    /// Named projections in declaration order: (name, CEL source).
    pub projections: Vec<(String, String)>,
    /// `select`.
    pub select: Vec<Selection>,
    /// `order_by`.
    pub order_by: Vec<OrderTerm>,
    /// `group_by` (sort semantics as `order_by`).
    pub group_by: Vec<OrderTerm>,
    /// Summary declarations, validated during compilation.
    pub summaries: Vec<Value>,
    /// Custom summary function names and CEL sources.
    pub summary_functions: Vec<(String, String)>,
    /// `limit`.
    pub limit: Option<u64>,
    /// `offset`.
    pub offset: u64,
    /// `include_body`.
    pub include_body: bool,
    /// `frontmatter_mode`.
    pub frontmatter_mode: FrontmatterMode,
    /// `timezone` (invocation zone).
    pub timezone: Option<String>,
    /// `context.this.path`.
    pub context_path: Option<String>,
}

/// Why a query is invalid (spec 11: aborts before candidate evaluation).
#[derive(Debug, Clone, PartialEq)]
pub struct QueryError {
    /// `invalid_query`, `invalid_timezone`, `context_not_found`, `invalid_expression`, ...
    pub code: String,
    /// Message.
    pub message: String,
    /// The offending member (`where`, `order_by[1].field`, ...).
    pub location: Option<String>,
}

impl QueryError {
    fn invalid(message: impl Into<String>, location: &str) -> QueryError {
        QueryError {
            code: "invalid_query".into(),
            message: message.into(),
            location: Some(location.into()),
        }
    }
}

const QUERY_MEMBERS: &[&str] = &[
    "types",
    "where",
    "projections",
    "select",
    "order_by",
    "group_by",
    "summaries",
    "summary_functions",
    "properties",
    "limit",
    "offset",
    "include_body",
    "frontmatter_mode",
    "timezone",
    "context",
];

impl Query {
    /// Parse and check a spec 11 query object. Unknown members are invalid;
    /// `x-*` members are ignored.
    ///
    /// Parses grouping and summary declarations as well as per-record query
    /// semantics. `properties` presentation remains a separate adapter concern.
    pub fn from_value(v: &Value) -> Result<Query, QueryError> {
        let Value::Map(m) = v else {
            return Err(QueryError::invalid("a query is a mapping", ""));
        };
        for (k, _) in m.iter() {
            if !k.starts_with("x-") && !QUERY_MEMBERS.contains(&k) {
                return Err(QueryError::invalid(
                    format!("unknown query member `{k}`"),
                    k,
                ));
            }
        }
        let mut q = Query::default();
        if let Some(t) = m.get("types") {
            q.types = string_list(t)
                .ok_or_else(|| QueryError::invalid("`types` is a list of names", "types"))?;
        }
        if let Some(w) = m.get("where") {
            q.where_ = Some(
                w.as_str()
                    .ok_or_else(|| QueryError::invalid("`where` is a CEL string", "where"))?
                    .to_owned(),
            );
        }
        let (projections, select) = projection::parse(m)?;
        q.projections = projections;
        q.select = select;
        q.group_by = groups::parse_group_by(m.get("group_by"))?;
        q.summary_functions = groups::parse_functions(m.get("summary_functions"))?;
        if let Some(v) = m.get("summaries") {
            let entries = v
                .as_list()
                .ok_or_else(|| QueryError::invalid("summaries is a list", "summaries"))?;
            if entries.len().saturating_add(q.group_by.len()) > groups::MAX_FIELDS {
                return Err(QueryError::invalid("too many metadata fields", "summaries"));
            }
            q.summaries = entries.to_vec();
        }
        if let Some(Value::List(terms)) = m.get("order_by") {
            for (i, t) in terms.iter().enumerate() {
                let loc = format!("order_by[{i}]");
                let field = t
                    .get("field")
                    .and_then(Value::as_str)
                    .and_then(parse_field_ref)
                    .ok_or_else(|| QueryError::invalid("`field` names a field", &loc))?;
                let direction = match t.get("direction").and_then(Value::as_str) {
                    None | Some("asc") => Direction::Asc,
                    Some("desc") => Direction::Desc,
                    Some(_) => return Err(QueryError::invalid("`direction` is asc or desc", &loc)),
                };
                q.order_by.push(OrderTerm { field, direction });
            }
        }
        if let Some(l) = m.get("limit") {
            q.limit = Some(non_negative(l).ok_or_else(|| {
                QueryError::invalid("`limit` is a non-negative integer", "limit")
            })?);
        }
        if let Some(o) = m.get("offset") {
            q.offset = non_negative(o).ok_or_else(|| {
                QueryError::invalid("`offset` is a non-negative integer", "offset")
            })?;
        }
        if let Some(b) = m.get("include_body") {
            q.include_body = b.as_bool().ok_or_else(|| {
                QueryError::invalid("`include_body` is a boolean", "include_body")
            })?;
        }
        if let Some(tz) = m.get("timezone") {
            q.timezone = Some(
                tz.as_str()
                    .ok_or_else(|| QueryError::invalid("`timezone` is a string", "timezone"))?
                    .to_owned(),
            );
        }
        if let Some(p) = m
            .get("context")
            .and_then(|c| c.get("this"))
            .and_then(|t| t.get("path"))
        {
            q.context_path = Some(
                p.as_str()
                    .ok_or_else(|| {
                        QueryError::invalid("`context.this.path` is a string", "context")
                    })?
                    .to_owned(),
            );
        }
        Ok(q)
    }
}

fn string_list(v: &Value) -> Option<Vec<String>> {
    v.as_list()?
        .iter()
        .map(|x| x.as_str().map(str::to_owned))
        .collect()
}

fn non_negative(v: &Value) -> Option<u64> {
    v.as_number()?.as_i64().and_then(|i| u64::try_from(i).ok())
}

/// Parse a field reference string (`due`, `file.path`, `projection.urgency`).
pub fn parse_field_ref(s: &str) -> Option<FieldRef> {
    let mut parts = s.split('.');
    let first = parts.next()?;
    let rest: Vec<String> = parts.map(str::to_owned).collect();
    if first.is_empty() || rest.iter().any(String::is_empty) {
        return None;
    }
    Some(match (first, rest.as_slice()) {
        ("file", [name]) if name == "path" => FieldRef::Path,
        ("file", [name]) => FieldRef::File(name.clone()),
        ("projection", [name]) => FieldRef::Projection(name.clone()),
        ("types", []) => FieldRef::Types,
        ("raw", path) if !path.is_empty() => FieldRef::Persisted(path.to_vec()),
        (first, path) => {
            let mut v = vec![first.to_owned()];
            v.extend(path.iter().cloned());
            FieldRef::Effective(v)
        }
    })
}

/// A comparison operator in a candidate predicate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum CompareOp {
    /// `==`
    Eq,
    /// `!=`
    Ne,
    /// `<`
    Lt,
    /// `<=`
    Le,
    /// `>`
    Gt,
    /// `>=`
    Ge,
    /// `field in [literals]`
    In,
    /// `field.contains(literal)` / `literal in field`
    Contains,
}

/// What a store may conclude from a comparison's false result.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Pruning {
    /// A plain JSON comparison of the stored value gives exactly CEL's verdict:
    /// the store may drop records for which it is false.
    Exact,
    /// The literal is a `YYYY-MM-DD` date: only stored values that are also
    /// exactly `YYYY-MM-DD` strings may be pruned; others stay candidates.
    IsoDate,
    /// Never prune on this term; it is informational.
    Conservative,
}

/// The closed candidate predicate (provider-neutral; no SQL).
#[derive(Debug, Clone, PartialEq)]
pub enum Candidate {
    /// Every record.
    All,
    /// No record.
    None,
    /// All terms.
    And(Vec<Candidate>),
    /// Any term.
    Or(Vec<Candidate>),
    /// Negation (only over exact terms).
    Not(Box<Candidate>),
    /// The record matches this type (lower-case name).
    HasType(String),
    /// The record's folder is `folder` or below it (segment boundaries).
    InFolder(String),
    /// A comparison of a field with a literal.
    Compare {
        /// The field.
        field: FieldRef,
        /// The operator.
        op: CompareOp,
        /// The literal.
        value: Value,
        /// What a store may prune.
        pruning: Pruning,
    },
    /// The record has an outgoing link (frontmatter or body, embeds included)
    /// with one of these index keys ([`crate::links::index_keys`]; the `l:`
    /// key space of the link index). Necessary for `file.hasLink(link("x"))`
    /// and `"x" in file.links`; never sufficient.
    LinksTo(Vec<crate::links::LinkKey>),
    /// The body contains `text` (case-insensitively when set: CEL `lower()`
    /// is full Unicode lower-casing). Necessary for `file.body.contains(..)`;
    /// never sufficient. A store that cannot test it exactly (for example an
    /// approximate full-text index) must keep the record.
    BodyContains {
        /// The literal.
        text: String,
        /// `file.body.lower().contains(..)`.
        case_insensitive: bool,
    },
}

/// What a store needs to hydrate to evaluate the residual and build results.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Requirements {
    /// The body (`file.body` in `where`, or `include_body`).
    pub body: bool,
    /// Link data (`file.links`, backlinks).
    pub links: bool,
    /// Effective values (read defaults).
    pub effective: bool,
    /// The `this` context record.
    pub context: bool,
    /// The query reads `now()`/`today()`: live results change with time.
    pub time_dependent: bool,
}

/// A compiled query.
#[derive(Debug, Clone, PartialEq)]
pub struct QueryPlan {
    /// The checked query (the residual's source of truth).
    pub query: Query,
    /// Necessary candidate condition.
    pub candidate: Candidate,
    /// The candidate is also sufficient (no residual evaluation needed).
    pub exact: bool,
    /// Sort terms; ID-aware executors use ascending record ID as final tie-break.
    pub order: Vec<OrderTerm>,
    /// Hydration requirements.
    pub requirements: Requirements,
    /// Read defaults per type (lower-case name), captured from the catalog at
    /// compile time so the residual sees effective values.
    pub read_defaults: Vec<(String, Map)>,
    /// Matched-type schema documents and entry pointers, captured at compile
    /// time for spec 10 date-time typing: (lower-case type name, document, entry).
    /// Persisted and effective frontmatter remain unchanged.
    pub date_time_schemas: Vec<(String, Value, String)>,
    /// The compiled `where`.
    pub where_program: Option<Program>,
    /// Named projections, in evaluation (dependency) order.
    pub projections: Vec<projection::CompiledProjection>,
    /// Compiled `select`.
    pub select: Vec<projection::CompiledSelection>,
    /// Compiled pre-pagination reductions.
    pub summaries: Vec<groups::CompiledSummary>,
}

/// A compiled CEL program in a plan. Plans compare by their query, so this
/// compares equal.
#[derive(Debug, Clone)]
pub struct Program(pub std::sync::Arc<crate::cel::Program>);

impl PartialEq for Program {
    fn eq(&self, _: &Program) -> bool {
        true
    }
}

/// Fixed per-execution inputs (spec 11 "Temporal Execution Context").
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueryEnv {
    /// The captured instant, ms since the epoch.
    pub now_ms: i64,
    /// The effective IANA zone.
    pub tz: String,
    /// `today()` in `tz`, `YYYY-MM-DD`.
    pub today: String,
}

impl QueryEnv {
    /// The query's captured time as an op clock (for membership).
    pub fn op_clock(&self) -> crate::intent::OpClock {
        crate::intent::OpClock {
            instant_ms: self.now_ms,
            tz: self.tz.clone(),
            local_date: self.today.clone(),
        }
    }
}

/// One record as the residual sees it.
#[derive(Debug, Clone, PartialEq)]
pub struct QueryRecord<'a> {
    /// Path.
    pub path: &'a str,
    /// Matched types.
    pub types: &'a [String],
    /// Persisted frontmatter.
    pub frontmatter: &'a Map,
    /// Body, when hydrated.
    pub body: Option<&'a str>,
}

/// Residual verdict for one record.
#[derive(Debug, Clone, PartialEq)]
pub enum Verdict {
    /// Included.
    Match,
    /// Excluded.
    NoMatch,
    /// Excluded with a per-record diagnostic (`expression_evaluation_error`).
    Error(Issue),
}

/// Compile `query` under `catalog`.
///
/// The `where` expression is compiled up front (an invalid one is
/// `invalid_query`, spec 11). The candidate covers `types`; lowering `where`
/// comparisons uses the CEL AST. Schema-declared date-time locations remain
/// residual-only: stored string comparisons cannot safely prune or be exact.
pub fn compile(query: &Query, catalog: &Catalog) -> Result<QueryPlan, QueryError> {
    let projections = projection::compile_projections(&query.projections)?;
    let select = projection::compile_select(&query.select, &projections)?;
    let summaries = groups::compile(&query.summaries, &query.summary_functions)?;
    if query.group_by.len().saturating_add(summaries.len()) > groups::MAX_FIELDS {
        return Err(QueryError::invalid("too many metadata fields", "group_by"));
    }
    for field in query
        .order_by
        .iter()
        .chain(&query.group_by)
        .map(|t| &t.field)
        .chain(summaries.iter().map(|s| &s.field))
    {
        if let FieldRef::Projection(p) = field
            && !projections.iter().any(|x| x.name == *p)
        {
            return Err(QueryError::invalid(
                format!("unknown projection `{p}`"),
                "order_by/group_by/summaries",
            ));
        }
    }
    for field in query
        .group_by
        .iter()
        .map(|t| &t.field)
        .chain(summaries.iter().map(|s| &s.field))
    {
        if let FieldRef::File(name) = field
            && !["name", "basename", "folder", "ext", "body", "tags"].contains(&name.as_str())
        {
            return Err(QueryError {
                code: "query_profile_unavailable".into(),
                message: format!(
                    "group/summary field file.{name} requires a qualified metadata profile"
                ),
                location: Some("group_by/summaries".into()),
            });
        }
    }
    let mut group_names = BTreeSet::new();
    for t in &query.group_by {
        if !group_names.insert(projection::output_name(&t.field)) {
            return Err(QueryError::invalid(
                "group fields produce duplicate output names",
                "group_by",
            ));
        }
    }
    let where_program = match &query.where_ {
        Some(w) => Some(Program(std::sync::Arc::new(
            crate::cel::compile(w).map_err(|e| QueryError {
                code: "invalid_query".into(),
                message: format!("`where`: {e}"),
                location: Some("where".into()),
            })?,
        ))),
        None => None,
    };
    if let Some(tz) = &query.timezone
        && !crate::types::is_plausible_iana_zone(tz)
    {
        return Err(QueryError {
            code: "invalid_timezone".into(),
            message: format!("`{tz}` is not an IANA time zone"),
            location: Some("timezone".into()),
        });
    }
    let types = match query.types.len() {
        0 => Candidate::All,
        1 => Candidate::HasType(query.types[0].to_lowercase()),
        _ => Candidate::Or(
            query
                .types
                .iter()
                .map(|t| Candidate::HasType(t.to_lowercase()))
                .collect(),
        ),
    };
    let defaulted: BTreeSet<String> = catalog
        .types()
        .iter()
        .flat_map(|t| t.read_defaults.keys().map(str::to_owned))
        .collect();
    let (candidate, exact) = match &where_program {
        None => (types, true),
        Some(p) => {
            let l = lower::Lowerer {
                defaulted: &defaulted,
                catalog,
            }
            .lower(p.0.ast());
            (lower::and(types, l.candidate), l.complete)
        }
    };
    let refs: Vec<_> = where_program
        .iter()
        .map(|p| p.0.references())
        .chain(projections.iter().map(|p| p.program.references()))
        .chain(select.iter().filter_map(|s| match &s.source {
            projection::SelectSource::Expr(p) => Some(p.references()),
            _ => None,
        }))
        .chain(summaries.iter().filter_map(|s| match &s.function {
            groups::SummaryFn::Custom(p) => Some(p.references()),
            _ => None,
        }))
        .collect();
    let calls = |f: &str| refs.iter().any(|r| r.functions.contains(f));
    let member = |m: &str| {
        refs.iter().any(|r| r.file_members.contains(m))
            || query
                .group_by
                .iter()
                .map(|t| &t.field)
                .chain(summaries.iter().map(|s| &s.field))
                .any(|f| matches!(f, FieldRef::File(n) if n == m))
    };
    Ok(QueryPlan {
        exact,
        candidate,
        order: query.order_by.clone(),
        requirements: Requirements {
            body: query.include_body || member("body") || member("tags"),
            links: ["links", "embeds", "backlinks"].iter().any(|m| member(m))
                || ["link", "asFile", "hasLink", "asLink"]
                    .iter()
                    .any(|f| calls(f)),
            effective: true,
            context: query.context_path.is_some(),
            time_dependent: calls("now") || calls("today"),
        },
        read_defaults: catalog
            .types()
            .iter()
            .filter(|t| !t.read_defaults.is_empty())
            .map(|t| (t.name.to_lowercase(), t.read_defaults.clone()))
            .collect(),
        date_time_schemas: catalog
            .types()
            .iter()
            .map(|t| {
                (
                    t.name.to_lowercase(),
                    t.schema_document.clone(),
                    t.schema_entry.clone(),
                )
            })
            .collect(),
        where_program,
        projections,
        select,
        summaries,
        query: query.clone(),
    })
}

/// The `file` binding of a record (spec 10): path, name, basename, folder,
/// ext, and the body when hydrated.
pub fn file_value(path: &str, body: Option<&str>) -> Value {
    let name = path.rsplit_once('/').map_or(path, |(_, n)| n);
    let folder = path.rsplit_once('/').map_or("", |(d, _)| d);
    let (basename, ext) = match name.rsplit_once('.') {
        Some((b, e)) if !b.is_empty() => (b, e),
        _ => (name, ""),
    };
    let mut m = Map::new();
    m.insert("path", Value::string(path));
    m.insert("name", Value::string(name));
    m.insert("basename", Value::string(basename));
    m.insert("folder", Value::string(folder));
    m.insert("ext", Value::string(ext));
    if let Some(b) = body {
        m.insert("body", Value::string(b));
    }
    Value::Map(m)
}

impl QueryPlan {
    /// The query requires complete match-set metadata before pagination.
    /// A backend without a qualified whole-query executor must reject it.
    pub fn requires_whole_metadata(&self) -> bool {
        !self.query.group_by.is_empty() || !self.summaries.is_empty()
    }

    /// Effective frontmatter of a record: persisted values plus the read
    /// defaults of its types (spec 07).
    pub fn effective(&self, record: &QueryRecord<'_>) -> Map {
        let mut out = record.frontmatter.clone();
        for t in record.types {
            let lower = t.to_lowercase();
            if let Some((_, d)) = self.read_defaults.iter().find(|(n, _)| *n == lower) {
                for (k, v) in d.iter() {
                    if !out.contains_key(k) {
                        out.insert(k, v.clone());
                    }
                }
            }
        }
        out
    }

    /// Build the record bindings with spec 10 date-time typing. This also
    /// preserves reserved bindings and the origin path used to resolve links.
    pub fn activation<'a>(
        &self,
        record: &QueryRecord<'_>,
        effective: &Map,
        file: crate::cel::CelValue,
    ) -> crate::cel::Activation<'a> {
        use crate::cel::{CelValue, Key};
        let schemas: Vec<_> = record
            .types
            .iter()
            .filter_map(|name| {
                self.date_time_schemas
                    .iter()
                    .find(|(n, _, _)| *n == name.to_lowercase())
            })
            .collect();
        let typed = |m: &Map| {
            let value = CelValue::from_value_typed(&Value::Map(m.clone()), &|location| {
                !schemas.is_empty()
                    && schemas.len() == record.types.len()
                    && schemas.iter().all(|(_, document, entry)| {
                        crate::types::schema_at(document, entry, location)
                            .and_then(|s| s.get("format"))
                            .and_then(Value::as_str)
                            == Some("date-time")
                    })
            });
            match value {
                CelValue::Map(m) => {
                    CelValue::Map(std::sync::Arc::new((*m).clone().with_origin(record.path)))
                }
                other => other,
            }
        };
        let mut act = crate::cel::record_activation(record.frontmatter, effective, file);
        let effective = typed(effective);
        if let CelValue::Map(m) = &effective {
            for (key, value) in m.iter() {
                if let Key::String(name) = key
                    && !matches!(&**name, "record" | "raw" | "file")
                {
                    act.bind(name.to_string(), value.clone());
                }
            }
        }
        act.bind("record", effective);
        act.bind("raw", typed(record.frontmatter));
        act
    }

    /// The canonical residual: does `record` match `types` and `where`?
    /// Anything but boolean `true` excludes the record; an evaluation error
    /// also reports `expression_evaluation_error` (spec 11).
    pub fn matches(&self, record: &QueryRecord<'_>, env: &QueryEnv) -> Verdict {
        self.matches_with(record, env, None)
    }

    /// [`QueryPlan::matches`] with a link host for `link()`, `asFile()`,
    /// `file.links`, `file.backlinks` and friends (see
    /// [`crate::links::CelLinks`]). Without one those are evaluation errors.
    pub fn matches_with(
        &self,
        record: &QueryRecord<'_>,
        env: &QueryEnv,
        links: Option<&dyn crate::cel::LinkHost>,
    ) -> Verdict {
        self.evaluate(record, env, links).verdict
    }

    /// Evaluate one record completely (spec 11 order): named projections,
    /// then `types` and `where`, then, for a match, `select` values and sort
    /// keys. A projection that fails is null with a diagnostic; a failing
    /// `where` excludes the record with a diagnostic.
    pub fn evaluate(
        &self,
        record: &QueryRecord<'_>,
        env: &QueryEnv,
        links: Option<&dyn crate::cel::LinkHost>,
    ) -> Evaluated {
        use crate::cel::{CelMap, CelValue, Key};
        let mut out = Evaluated {
            verdict: Verdict::NoMatch,
            projections: Map::new(),
            values: Map::new(),
            sort_keys: Vec::new(),
            sort_hints: Vec::new(),
            reduction: groups::Row::default(),
            reduction_error: None,
            diagnostics: Vec::new(),
        };
        let issue = |message: String, expression: &str| {
            Issue::new(
                "expression_evaluation_error",
                crate::validate::Severity::Warning,
                crate::validate::Tier::CrossRecord,
                message,
            )
            .at(record.path)
            .with_details(Value::Map(
                [("expression".to_owned(), Value::string(expression))]
                    .into_iter()
                    .collect(),
            ))
        };
        if !self.query.types.is_empty()
            && !record
                .types
                .iter()
                .any(|t| self.query.types.iter().any(|q| q.eq_ignore_ascii_case(t)))
        {
            return out;
        }
        let effective = self.effective(record);
        let mut file = file_value(record.path, record.body);
        if let (Value::Map(m), Some(body)) = (&mut file, record.body) {
            m.insert(
                "tags",
                Value::List(
                    crate::links::record_tags(record.frontmatter, body)
                        .into_iter()
                        .map(Value::string)
                        .collect(),
                ),
            );
        }
        let file_cel = CelValue::from_value(&file);
        let activation = |projections: &CelMap| {
            let mut act = self.activation(record, &effective, file_cel.clone());
            act.with_clock(crate::lifecycle::cel_clock(env.now_ms, &env.today, &env.tz));
            act.bind(
                "projection",
                CelValue::Map(std::sync::Arc::new(projections.clone())),
            );
            if let Some(host) = links {
                act.with_links(host);
            }
            act
        };
        // Keep native CEL values between projections/where/select. Converting
        // through Value here would turn timestamps back into untyped strings.
        let mut projection_values = CelMap::new();
        for p in &self.projections {
            let v = match p.program.evaluate(&activation(&projection_values)) {
                Ok(v) => v,
                Err(e) => {
                    out.diagnostics
                        .push(issue(e.to_string(), &format!("projections.{}", p.name)));
                    CelValue::Null
                }
            };
            out.projections
                .insert(p.name.clone(), v.to_value().unwrap_or(Value::Null));
            projection_values.insert(Key::String(p.name.clone().into()), v);
        }
        out.verdict = match &self.where_program {
            None => Verdict::Match,
            Some(program) => match program.0.evaluate(&activation(&projection_values)) {
                Ok(CelValue::Bool(true)) => Verdict::Match,
                Ok(_) => Verdict::NoMatch,
                Err(e) => Verdict::Error(issue(e.to_string(), "where")),
            },
        };
        if out.verdict != Verdict::Match {
            return out;
        }
        let field_value = |f: &FieldRef, projections: &Map| match f {
            FieldRef::Projection(n) => projections.get(n).cloned(),
            other => self.sort_value(other, record),
        };
        let mut computed_temporal = std::collections::BTreeSet::new();
        let mut native_selections = CelMap::new();
        for s in &self.select {
            let v = match &s.source {
                projection::SelectSource::Field(f) => field_value(f, &out.projections),
                projection::SelectSource::Expr(p) => {
                    match p.evaluate(&activation(&projection_values)) {
                        Ok(v) => {
                            if matches!(v, CelValue::Timestamp(_)) {
                                computed_temporal.insert(s.name.clone());
                            }
                            native_selections.insert(Key::String(s.name.clone().into()), v.clone());
                            v.to_value()
                        }
                        Err(e) => {
                            out.diagnostics
                                .push(issue(e.to_string(), &format!("select.{}", s.name)));
                            None
                        }
                    }
                }
            };
            out.values.insert(s.name.clone(), v.unwrap_or(Value::Null));
        }
        out.sort_keys = self
            .order
            .iter()
            .map(|t| match &t.field {
                // An order term may name a selection output (spec 11).
                FieldRef::Effective(p)
                    if p.len() == 1
                        && self.select.iter().any(|s| {
                            s.name == p[0] && matches!(s.source, projection::SelectSource::Expr(_))
                        }) =>
                {
                    out.values.get(&p[0]).cloned()
                }
                f => field_value(f, &out.projections),
            })
            .collect();
        out.sort_hints = self
            .order
            .iter()
            .map(|term| match &term.field {
                FieldRef::Projection(name) => {
                    if matches!(
                        projection_values.get_str(name),
                        Some(CelValue::Timestamp(_))
                    ) {
                        indexed::TemporalHint::DateTime
                    } else {
                        indexed::TemporalHint::None
                    }
                }
                FieldRef::Effective(p) if p.len() == 1 && self.computed_alias(&p[0]) => {
                    if computed_temporal.contains(&p[0]) {
                        indexed::TemporalHint::DateTime
                    } else {
                        indexed::TemporalHint::None
                    }
                }
                f => self.sort_hint(f, record.types),
            })
            .collect();
        let capture = || -> Result<groups::Row, QueryError> {
            let mut budget = groups::Budget::default();
            let context = ReductionContext {
                record,
                effective: &effective,
                file: &file,
                projections: &projection_values,
                selections: &native_selections,
                evaluated: &out,
            };
            let input = |f: &FieldRef, budget: &mut groups::Budget| {
                self.reduction_input(f, &context, budget)
            };
            Ok(groups::Row {
                keys: self
                    .query
                    .group_by
                    .iter()
                    .map(|t| input(&t.field, &mut budget))
                    .collect::<Result<_, _>>()?,
                inputs: self
                    .summaries
                    .iter()
                    .map(|s| input(&s.field, &mut budget))
                    .collect::<Result<_, _>>()?,
            })
        };
        match capture() {
            Ok(row) => out.reduction = row,
            Err(e) => out.reduction_error = Some(e),
        }
        out
    }

    fn reduction_input(
        &self,
        field: &FieldRef,
        context: &ReductionContext<'_, '_>,
        budget: &mut groups::Budget,
    ) -> Result<groups::Input, QueryError> {
        use crate::cel::CelValue;
        let ReductionContext {
            record,
            effective,
            file,
            projections,
            selections,
            evaluated,
        } = context;
        let synthetic;
        let value = match field {
            FieldRef::Projection(n) => evaluated.projections.get(n),
            FieldRef::Effective(p) if p.len() == 1 && self.computed_alias(&p[0]) => {
                evaluated.values.get(&p[0])
            }
            FieldRef::Effective(p) => walk_ref(effective, p),
            FieldRef::Persisted(p) => walk_ref(record.frontmatter, p),
            FieldRef::File(n) => file.get(n),
            FieldRef::Path => {
                synthetic = Value::string(record.path);
                Some(&synthetic)
            }
            FieldRef::Types => {
                synthetic = Value::List(record.types.iter().map(Value::string).collect());
                Some(&synthetic)
            }
        }
        .unwrap_or(&Value::Null);
        // Preflight the public shape before copying it or constructing native values.
        groups::Budget::default().value(value)?;
        let native = match field {
            FieldRef::Projection(n) => projections.get_str(n).cloned(),
            FieldRef::Effective(p) if p.len() == 1 && self.computed_alias(&p[0]) => {
                selections.get_str(&p[0]).cloned()
            }
            FieldRef::Effective(p) | FieldRef::Persisted(p) => {
                Some(CelValue::from_value_typed(value, &|tail| {
                    let path: Vec<_> = p
                        .iter()
                        .cloned()
                        .chain(tail.iter().map(|s| (*s).to_owned()))
                        .collect();
                    self.sort_hint(&FieldRef::Persisted(path), record.types)
                        == indexed::TemporalHint::DateTime
                }))
            }
            _ => None,
        }
        .unwrap_or_else(|| CelValue::from_value(value));
        let hint = if matches!(native, CelValue::Timestamp(_)) {
            indexed::TemporalHint::DateTime
        } else {
            self.sort_hint(field, record.types)
        };
        groups::Input::new(value, native, hint, budget)
    }

    /// The result columns of `select`, in order: `(output name, label)`.
    /// Empty when the query has no `select`.
    pub fn columns(&self) -> Vec<(String, Option<String>)> {
        self.select
            .iter()
            .map(|s| (s.name.clone(), s.label.clone()))
            .collect()
    }

    /// Compatibility comparison when the caller has no IDs. Prefer
    /// [`Self::compare_evaluated_by_id`]; this helper retains path ties.
    pub fn compare_evaluated(&self, a: (&str, &Evaluated), b: (&str, &Evaluated)) -> Ordering {
        self.compare_evaluated_terms(a.1, b.1)
            .then_with(|| a.0.cmp(b.0))
    }

    /// Canonical evaluated order: typed keys by direction, then record ID ASC
    /// in both directions. Hints come from schema/native CEL values, not shape.
    pub fn compare_evaluated_by_id(
        &self,
        a: (RecordId, &Evaluated),
        b: (RecordId, &Evaluated),
    ) -> Ordering {
        self.compare_evaluated_terms(a.1, b.1)
            .then_with(|| a.0.cmp(&b.0))
    }

    fn compare_evaluated_terms(&self, a: &Evaluated, b: &Evaluated) -> Ordering {
        for (i, term) in self.order.iter().enumerate() {
            let (x, y) = (
                a.sort_keys.get(i).and_then(Option::as_ref),
                b.sort_keys.get(i).and_then(Option::as_ref),
            );
            let o = indexed::compare_typed(
                x,
                a.sort_hints.get(i).copied().unwrap_or_default(),
                y,
                b.sort_hints.get(i).copied().unwrap_or_default(),
            )
            .unwrap_or_else(|_| compare_values(x, y));
            let o = if term.direction == Direction::Desc {
                o.reverse()
            } else {
                o
            };
            if o != Ordering::Equal {
                return o;
            }
        }
        Ordering::Equal
    }

    fn computed_alias(&self, name: &str) -> bool {
        self.select
            .iter()
            .any(|s| s.name == name && matches!(s.source, projection::SelectSource::Expr(_)))
    }

    fn sort_hint(&self, field: &FieldRef, types: &[String]) -> indexed::TemporalHint {
        let path = match field {
            FieldRef::Effective(p) if p.len() == 1 && self.computed_alias(&p[0]) => {
                return indexed::TemporalHint::None;
            }
            FieldRef::Effective(p) | FieldRef::Persisted(p) => p,
            _ => return indexed::TemporalHint::None,
        };
        indexed::schemas_temporal_hint(
            types.iter().map(|name| {
                self.date_time_schemas
                    .iter()
                    .find(|(n, _, _)| *n == name.to_lowercase())
                    .map(|(_, document, entry)| (document, entry.as_str()))
            }),
            path,
        )
    }

    /// The sort value of `field` for a record.
    fn sort_value(&self, field: &FieldRef, record: &QueryRecord<'_>) -> Option<Value> {
        match field {
            FieldRef::Path => Some(Value::string(record.path)),
            FieldRef::File(name) => file_value(record.path, record.body).get(name).cloned(),
            FieldRef::Types => Some(Value::List(
                record
                    .types
                    .iter()
                    .map(|t| Value::string(t.clone()))
                    .collect(),
            )),
            FieldRef::Effective(p) => walk(&self.effective(record), p),
            FieldRef::Persisted(p) => walk(record.frontmatter, p),
            FieldRef::Projection(_) => None,
        }
    }

    /// Compatibility comparison without IDs; retains path ties. Computed
    /// order terms require `evaluate` and `compare_evaluated_by_id` instead.
    pub fn compare(&self, a: &QueryRecord<'_>, b: &QueryRecord<'_>) -> Ordering {
        self.compare_record_terms(a, b)
            .then_with(|| a.path.cmp(b.path))
    }

    /// Typed field order, then record ID ASC regardless of sort direction.
    /// Computed/projection order terms use `compare_evaluated_by_id` instead.
    pub fn compare_by_id(
        &self,
        a: (RecordId, &QueryRecord<'_>),
        b: (RecordId, &QueryRecord<'_>),
    ) -> Ordering {
        self.compare_record_terms(a.1, b.1)
            .then_with(|| a.0.cmp(&b.0))
    }

    fn compare_record_terms(&self, a: &QueryRecord<'_>, b: &QueryRecord<'_>) -> Ordering {
        for term in &self.order {
            let (x, y) = (
                self.sort_value(&term.field, a),
                self.sort_value(&term.field, b),
            );
            let o = indexed::compare_typed(
                x.as_ref(),
                self.sort_hint(&term.field, a.types),
                y.as_ref(),
                self.sort_hint(&term.field, b.types),
            )
            .unwrap_or_else(|_| compare_values(x.as_ref(), y.as_ref()));
            let o = if term.direction == Direction::Desc {
                o.reverse()
            } else {
                o
            };
            if o != Ordering::Equal {
                return o;
            }
        }
        Ordering::Equal
    }
}

struct ReductionContext<'a, 'r> {
    record: &'a QueryRecord<'r>,
    effective: &'a Map,
    file: &'a Value,
    projections: &'a crate::cel::CelMap,
    selections: &'a crate::cel::CelMap,
    evaluated: &'a Evaluated,
}

fn walk_ref<'a>(root: &'a Map, path: &[String]) -> Option<&'a Value> {
    let mut cur = root.get(path.first()?)?;
    for k in &path[1..] {
        cur = cur.get(k)?;
    }
    Some(cur)
}
fn walk(root: &Map, path: &[String]) -> Option<Value> {
    walk_ref(root, path).cloned()
}

/// The canonical v0.3 sort order of two values (ascending): null or missing
/// last; numbers numerically; strings by code point; `false < true`; lists
/// and maps by length. Across kinds: bool, number, text, list, map, null.
/// Explicit schema-typed temporal atoms sort between number and text (indexed).
pub fn compare_values(a: Option<&Value>, b: Option<&Value>) -> Ordering {
    let a = a.filter(|v| !v.is_null());
    let b = b.filter(|v| !v.is_null());
    match (a, b) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(x), Some(y)) => match (x, y) {
            (Value::Text(p), Value::Text(q)) => p.cmp(q),
            (Value::Bool(p), Value::Bool(q)) => p.cmp(q),
            (Value::List(p), Value::List(q)) => p.len().cmp(&q.len()),
            (Value::Map(p), Value::Map(q)) => p.len().cmp(&q.len()),
            _ => match (x.as_number(), y.as_number()) {
                (Some(p), Some(q)) => p.cmp_numeric(q),
                _ => value_kind(x).cmp(&value_kind(y)),
            },
        },
    }
}

fn value_kind(value: &Value) -> indexed::AtomKind {
    use indexed::AtomKind;
    match value {
        Value::Bool(_) => AtomKind::Bool,
        Value::Int(_) | Value::Float(_) => AtomKind::Number,
        Value::Text(_) => AtomKind::Text,
        Value::List(_) => AtomKind::List,
        Value::Map(_) => AtomKind::Map,
        Value::Null => AtomKind::Null,
    }
}

/// One record evaluated by [`QueryPlan::evaluate`].
#[derive(Debug, Clone, PartialEq)]
pub struct Evaluated {
    /// Match, no match, or excluded with an error.
    pub verdict: Verdict,
    /// Named projection values (null when a projection failed).
    pub projections: Map,
    /// `select` values by output name (spec 11 result `values`). Empty
    /// unless matched.
    pub values: Map,
    /// One value per order term, for [`QueryPlan::compare_evaluated`].
    pub sort_keys: Vec<Option<Value>>,
    /// Trusted schema/native-CEL temporal classification aligned with sort keys.
    /// Missing hints mean plain values; date-looking text is never guessed.
    pub sort_hints: Vec<indexed::TemporalHint>,
    /// Trusted grouping keys and native summary inputs, before pagination.
    pub reduction: groups::Row,
    /// Metadata capture failed; callers must fail the entire request.
    pub reduction_error: Option<QueryError>,
    /// Per-record diagnostics (projection and selection errors).
    pub diagnostics: Vec<Issue>,
}

/// One page of results.
#[derive(Debug, Clone, PartialEq)]
pub struct QueryPage {
    /// Matching record IDs in order, after the window.
    pub ids: Vec<RecordId>,
    /// Matches before the window.
    pub total_count: u64,
    /// More matches after the window.
    pub has_more: bool,
    /// Per-record diagnostics.
    pub diagnostics: Vec<Issue>,
    /// `select` values of each returned record, aligned with `ids` (empty
    /// maps when the query has no `select`).
    pub values: Vec<Map>,
    /// Complete filtered grouping/summary metadata, absent when not requested.
    pub groups: Option<Vec<groups::Group>>,
}

/// The reference oracle: scan, residual, canonical order, whole reductions, window.
/// Production callers must independently preflight hydration/source and authority.
pub fn execute(
    plan: &QueryPlan,
    state: &dyn StateView,
    env: &QueryEnv,
) -> Result<QueryPage, QueryError> {
    let catalog = state.catalog();
    let links = crate::links::CelLinks::new(state);
    let mut rows: Vec<(RecordId, String, Evaluated)> = Vec::new();
    let mut diagnostics = Vec::new();
    let mut metadata_budget = groups::Budget::default();
    let needs_metadata = plan.requires_whole_metadata();
    for id in state.record_ids() {
        let Some(rec) = state.record(&id) else {
            continue;
        };
        let doc = crate::doc::Document::parse_at(&rec.path, &*rec.source);
        let fm = doc.frontmatter().clone();
        let types = catalog
            .membership_at(&rec.path, &fm, Some(&env.op_clock()))
            .types;
        let mut ev = plan.evaluate(
            &QueryRecord {
                path: &rec.path,
                types: &types,
                frontmatter: &fm,
                body: Some(doc.body()),
            },
            env,
            Some(&links),
        );
        diagnostics.append(&mut ev.diagnostics);
        match &ev.verdict {
            Verdict::Match => {
                if let Some(e) = &ev.reduction_error {
                    return Err(e.clone());
                }
                if needs_metadata {
                    metadata_budget.row(&ev.reduction)?;
                }
                rows.push((id, rec.path.clone(), ev));
            }
            Verdict::NoMatch => {}
            Verdict::Error(issue) => diagnostics.push(issue.clone()),
        }
    }
    rows.sort_by(|a, b| plan.compare_evaluated_by_id((a.0, &a.2), (b.0, &b.2)));
    let group_rows: Vec<_> = rows.iter().map(|r| &r.2.reduction).collect();
    let groups = groups::reduce(
        &plan.query.group_by,
        &plan.summaries,
        &group_rows,
        env,
        &mut diagnostics,
    )?;
    let total = rows.len();
    let start = usize::try_from(plan.query.offset)
        .unwrap_or(usize::MAX)
        .min(total);
    let end = match plan.query.limit {
        Some(l) => start
            .saturating_add(usize::try_from(l).unwrap_or(usize::MAX))
            .min(total),
        None => total,
    };
    Ok(QueryPage {
        ids: rows[start..end].iter().map(|r| r.0).collect(),
        values: rows[start..end]
            .iter()
            .map(|r| r.2.values.clone())
            .collect(),
        total_count: u64::try_from(total).unwrap_or(u64::MAX),
        has_more: end < total,
        diagnostics,
        groups,
    })
}
