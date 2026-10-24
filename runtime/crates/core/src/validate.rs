//! Validation tiers (spec 04 "Validation Principle", `intent.md` §6).
//!
//! | Tier | Examples | Effect on an `api` write |
//! |---|---|---|
//! | [`Tier::Request`] | invalid requests, unsafe paths, explicit `path_conflict`, config/type-file errors, `type_conflict`, `type_membership_changed`, lifecycle failures, `if_revision`, expression compile errors, `unique.enforce: write` | always rejected (S-class ones authoritatively at head) |
//! | [`Tier::SingleRecord`] | JSON Schema failures, `format_invalid`, non-mapping frontmatter, contract view failures | at submit, level `error` rejects; at head never |
//! | [`Tier::CrossRecord`] | `unique.enforce: report`, `link_not_found`, `target_type`, `ambiguous_link`, `path_collision` | reported, never rejected |
//!
//! Single-record checks depend only on the record's path, frontmatter, body and
//! the catalog ([`validate_record`]). Cross-record checks also read other records
//! ([`cross_record_issues`]); the planner never rejects for them.

use crate::state::StateView;
use crate::types::Catalog;
use crate::value::Value;

/// Diagnostic severity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Severity {
    /// Reported, not blocking.
    Warning,
    /// An error at the configured level.
    Error,
}

/// The tier a check belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Tier {
    /// Request and safety: always rejects an `api` write.
    Request,
    /// Single-record: follows the validation level, at submit only.
    SingleRecord,
    /// Cross-record: reported, never rejected.
    CrossRecord,
}

/// One diagnostic (spec 14 diagnostic envelope; `issue` in the client API).
#[derive(Debug, Clone, PartialEq)]
pub struct Issue {
    /// Spec code: `schema_violation`, `type_conflict`, `link_not_found`, ...
    pub code: String,
    /// Severity.
    pub severity: Severity,
    /// Tier of the check that produced it.
    pub tier: Tier,
    /// Human-readable message (not stable).
    pub message: String,
    /// JSON Pointer into the frontmatter, or a resource path for catalog issues.
    pub location: Option<String>,
    /// Structured details.
    pub details: Option<Value>,
    /// The type the issue concerns, when one does.
    pub type_name: Option<String>,
}

impl Issue {
    /// A new issue with no location or details.
    pub fn new(code: &str, severity: Severity, tier: Tier, message: impl Into<String>) -> Issue {
        Issue {
            code: code.to_owned(),
            severity,
            tier,
            message: message.into(),
            location: None,
            details: None,
            type_name: None,
        }
    }

    /// Set the type name.
    pub fn with_type(mut self, name: &str) -> Issue {
        self.type_name = Some(name.to_owned());
        self
    }

    /// Set the location.
    pub fn at(mut self, location: impl Into<String>) -> Issue {
        self.location = Some(location.into());
        self
    }

    /// Set the details.
    pub fn with_details(mut self, details: Value) -> Issue {
        self.details = Some(details);
        self
    }
}

/// Single-record validation of the document `source` at `path` against every
/// type it matches (spec 04/05/06/07): membership diagnostics, non-mapping
/// frontmatter, and each matched type's JSON Schema (`schema_*`,
/// `format_invalid`). Severity is `error`; map it with [`apply_level`].
pub fn validate_record(catalog: &Catalog, path: &str, source: &str) -> Vec<Issue> {
    validate_record_at(catalog, path, source, None)
}

/// [`validate_record`] with membership evaluated at `clock`
/// ([`Catalog::membership_at`]).
pub fn validate_record_at(
    catalog: &Catalog,
    path: &str,
    source: &str,
    clock: Option<&crate::intent::OpClock>,
) -> Vec<Issue> {
    let doc = crate::doc::Document::parse_at(path, source);
    if let Some(p) = doc.problem() {
        return vec![
            Issue::new(
                "invalid_frontmatter",
                Severity::Error,
                Tier::SingleRecord,
                "the frontmatter is not a YAML mapping",
            )
            .with_details(map1("reason", Value::string(p.reason()))),
        ];
    }
    let fm = doc.frontmatter();
    let membership = catalog.membership_at(path, fm, clock);
    let mut out = membership.issues;
    let instance = Value::Map(fm.clone());
    for name in &membership.types {
        let Some(t) = catalog.type_named(name) else {
            continue;
        };
        for i in t.schema.0.validate(&instance) {
            out.push(Issue {
                code: i.code,
                severity: Severity::Error,
                tier: Tier::SingleRecord,
                message: i.message,
                location: Some(i.instance_path),
                details: Some(map1("schema_location", Value::string(i.schema_path))),
                type_name: Some(t.name.clone()),
            });
        }
    }
    out
}

fn map1(k: &str, v: Value) -> Value {
    Value::Map([(k.to_owned(), v)].into_iter().collect())
}

/// Cross-record issues of the record `id` in `state` (spec 04 cross-record
/// tier): `ambiguous_link`, `link_not_found` and `link_target_type_mismatch`
/// for its links, and `duplicate_value` for every uniqueness rule that governs
/// it. Severity is `error`; map it with [`apply_level`]. Never blocks a write.
pub fn cross_record_issues(state: &dyn StateView, id: crate::ids::RecordId) -> Vec<Issue> {
    use crate::links::{self, Resolution};
    let Some(rec) = state.record(&id) else {
        return Vec::new();
    };
    let catalog = state.catalog();
    let doc = crate::doc::Document::parse_at(&rec.path, &*rec.source);
    let fm = doc.frontmatter();
    let types = catalog.membership(&rec.path, fm).types;
    let mut out = Vec::new();
    // Declared link rules, by top-level field.
    let mut rules: Vec<(String, &crate::types::LinkField)> = Vec::new();
    for t in types.iter().filter_map(|n| catalog.type_named(n)) {
        for (sel, rule) in &t.link_fields {
            let field = sel
                .trim_start_matches('/')
                .trim_end_matches("[]")
                .to_owned();
            rules.push((field, rule));
        }
    }
    let mut all = links::frontmatter_links(&catalog, &types, fm);
    all.extend(links::parse_body(doc.body()));
    for l in &all {
        let field = l.field.as_ref().map(|(f, _)| f.clone());
        let at = |i: Issue| match &field {
            Some(f) => i.at(format!("/{f}")),
            None => i,
        };
        let rule = field
            .as_ref()
            .and_then(|f| rules.iter().find(|(rf, _)| rf == f).map(|(_, r)| *r));
        match links::resolve(l, &rec.path, state) {
            Resolution::Ambiguous(c) => out.push(at(Issue::new(
                "ambiguous_link",
                Severity::Error,
                Tier::CrossRecord,
                format!("`{}` matches several records", l.raw),
            )
            .with_details(map1(
                "candidates",
                Value::List(c.into_iter().map(Value::string).collect()),
            )))),
            Resolution::NotFound | Resolution::Invalid => {
                if rule.is_some_and(|r| r.validate_exists) {
                    out.push(at(Issue::new(
                        "link_not_found",
                        Severity::Error,
                        Tier::CrossRecord,
                        format!("`{}` does not resolve", l.raw),
                    )));
                }
            }
            Resolution::Record(target) => {
                if let Some(want) = rule.and_then(|r| r.target_type.as_ref())
                    && let Some(t) = state.record(&target)
                {
                    let tdoc = crate::doc::Document::parse_at(&t.path, &*t.source);
                    let ttypes = catalog.membership(&t.path, tdoc.frontmatter()).types;
                    if !ttypes.iter().any(|x| x.eq_ignore_ascii_case(want)) {
                        out.push(at(Issue::new(
                            "link_target_type_mismatch",
                            Severity::Error,
                            Tier::CrossRecord,
                            format!("`{}` is not a `{want}`", l.raw),
                        )
                        .with_details(map1("target", Value::string(t.path.clone())))));
                    }
                }
            }
            Resolution::File(_) => {}
        }
    }
    out.extend(duplicate_values(state, &catalog, &rec, fm, &types, None));
    out
}

/// `duplicate_value` issues of a record for the uniqueness rules of its types.
/// With `only`, just the rules with that enforcement mode.
pub fn duplicate_values(
    state: &dyn StateView,
    catalog: &Catalog,
    rec: &crate::state::StoredRecord,
    fm: &crate::value::Map,
    types: &[String],
    only: Option<crate::types::Enforce>,
) -> Vec<Issue> {
    use crate::types::{UniqueScope, select};
    let mut out = Vec::new();
    for t in types.iter().filter_map(|n| catalog.type_named(n)) {
        for rule in &t.unique {
            if only.is_some_and(|e| e != rule.enforce) {
                continue;
            }
            if let UniqueScope::PathGlob(g) = &rule.scope
                && !g.matches(&rec.path)
            {
                continue;
            }
            let mine: Vec<&Value> = select(fm, &rule.field)
                .into_iter()
                .filter(|v| !v.is_null())
                .collect();
            if mine.is_empty() {
                continue;
            }
            let mut paths: Vec<String> = Vec::new();
            for other_id in state.record_ids() {
                if other_id == rec.id {
                    continue;
                }
                let Some(other) = state.record(&other_id) else {
                    continue;
                };
                let odoc = crate::doc::Document::parse_at(&other.path, &*other.source);
                let ofm = odoc.frontmatter();
                let in_set = match &rule.scope {
                    UniqueScope::Collection => true,
                    UniqueScope::PathGlob(g) => g.matches(&other.path),
                    UniqueScope::Type => catalog
                        .membership(&other.path, ofm)
                        .types
                        .iter()
                        .any(|n| n.eq_ignore_ascii_case(&t.name)),
                };
                if in_set && select(ofm, &rule.field).iter().any(|v| mine.contains(v)) {
                    paths.push(other.path.clone());
                }
            }
            if !paths.is_empty() {
                paths.sort();
                let tier = match rule.enforce {
                    crate::types::Enforce::Write => Tier::Request,
                    crate::types::Enforce::Report => Tier::CrossRecord,
                };
                out.push(
                    Issue::new(
                        "duplicate_value",
                        Severity::Error,
                        tier,
                        format!("another record holds the same `{}`", rule.field),
                    )
                    .at(field_location(&rule.field))
                    .with_type(&t.name)
                    .with_details(map1(
                        "paths",
                        Value::List(paths.into_iter().map(Value::string).collect()),
                    )),
                );
            }
        }
    }
    out
}

/// A field reference as an issue location (`/a/b`).
pub fn field_location(reference: &str) -> String {
    if reference.starts_with('/') {
        reference.to_owned()
    } else {
        format!("/{}", reference.replace("[]", "").replace('.', "/"))
    }
}

/// Map raw (error) severities through the validation level (spec 04): at
/// `warn` everything is a warning; at `off` reads report nothing and an
/// explicit `validate` reports warnings; at `error` severities stay.
pub fn apply_level(
    issues: Vec<Issue>,
    level: crate::intent::Level,
    explicit_validate: bool,
) -> Vec<Issue> {
    use crate::intent::Level;
    match level {
        Level::Error => issues,
        Level::Off if !explicit_validate => Vec::new(),
        Level::Warn | Level::Off => issues
            .into_iter()
            .map(|mut i| {
                i.severity = Severity::Warning;
                i
            })
            .collect(),
    }
}
