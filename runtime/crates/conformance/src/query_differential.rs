//! Reusable seeded inputs and the ACTUAL Rust query oracle; no SQL semantics.
//! Adapter comparisons and resource refusals remain explicit;
//! a declined case is not evidence that a newly supported shape works.
use mdbn_core::ids::Uuid;
use mdbn_core::query::{self, Query, QueryEnv, QueryError, QueryPage};
use mdbn_core::state::{MemState, StateView};
use serde_json::{Value as Json, json};

/// Exact source input, including stable identity and path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Record {
    /// Stable ID, not allocated during execution.
    pub id: Uuid,
    /// Exact candidate path.
    pub path: String,
    /// Exact UTF-8 source, not generated expected metadata.
    pub source: String,
}
/// Losslessly reproducible test input. `query_yaml` is an official Core query
/// input, parsed by Core, rather than a second expression/query parser.
#[derive(Debug, Clone)]
pub struct Case {
    /// Replay seed; exact source below also survives shrinking.
    pub seed: u64,
    /// Catalogue inputs in deterministic order.
    pub resources: Vec<(String, String)>,
    /// Candidate sources.
    pub records: Vec<Record>,
    /// Exact query source.
    pub query_yaml: String,
    /// Captured time/zone/day.
    pub env: QueryEnv,
}
/// Input/schema plumbing failure, distinct from canonical engine QueryError.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FixtureError(pub String);
impl std::fmt::Display for FixtureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}
impl std::error::Error for FixtureError {}
/// Canonical engine outcome; includes complete errors, never a fake empty page.
#[derive(Debug, Clone, PartialEq)]
pub enum OracleOutcome {
    /// Complete reference execution result.
    Success(QueryPage),
    /// Actual Core parse/compile/execute refusal.
    QueryError(QueryError),
}
/// Adapter classifications distinguish unsupported/resource errors
/// from successful results and only claim a shape when it actually executes SQL.
#[derive(Debug, Clone, PartialEq)]
pub enum AdapterOutcome {
    /// Actual SQL-backed result to compare with Core, including diagnostics.
    Success(QueryPage),
    /// Actual canonical query error.
    QueryError(QueryError),
    /// Closed lowerer refused this shape (not a success).
    LowerDeclined(String),
    /// Whole resource refusal (not an empty/partial success).
    ResourceExhausted(String),
}
impl Case {
    /// Build the actual Core state; invalid/dropped type fixtures cannot silently
    /// turn a differential assertion into an empty-catalog comparison.
    pub fn state(&self) -> Result<MemState, FixtureError> {
        let mut s = MemState::new();
        for (p, source) in &self.resources {
            s.insert_resource(p, source);
        }
        if !s.catalog().is_valid() {
            return Err(FixtureError("invalid fixture catalogue".into()));
        }
        let mut ids = std::collections::BTreeSet::new();
        let mut paths = std::collections::BTreeSet::new();
        for r in &self.records {
            if !ids.insert(r.id) || !paths.insert(&r.path) {
                return Err(FixtureError(
                    "duplicate fixture record identity/path".into(),
                ));
            }
            s.insert_record(r.id, &r.path, &r.source);
        }
        Ok(s)
    }
    /// Official Core query parser; no app/SQL-generated expected values.
    pub fn query(&self) -> Result<Query, QueryError> {
        let value = mdbn_core::yaml::parse_value(&self.query_yaml)
            .map_err(|e| QueryError {
                code: "invalid_query".into(),
                message: e.to_string(),
                location: None,
            })?
            .ok_or_else(|| QueryError {
                code: "invalid_query".into(),
                message: "empty fixture query".into(),
                location: None,
            })?;
        Query::from_value(&value)
    }
    /// Lossless raw case JSON, including exact query and sources, for seed/shrink
    /// regression artifacts. Seed/time are strings to avoid JS number rounding.
    pub fn to_json(&self) -> Json {
        json!({"version":1,"seed":self.seed.to_string(),"resources":self.resources,
            "records":self.records.iter().map(|r|json!({"id":r.id.to_string(),"path":r.path,"source":r.source})).collect::<Vec<_>>(),
            "query_yaml":self.query_yaml,"env":{"now_ms":self.env.now_ms.to_string(),"tz":self.env.tz,"today":self.env.today}})
    }
    /// Restore exact serialized inputs; reject incomplete/malformed artifacts.
    pub fn from_json(v: &Json) -> Result<Self, FixtureError> {
        let bad = || FixtureError("invalid differential case v1".into());
        let text = |v: &Json| v.as_str().map(str::to_owned).ok_or_else(bad);
        if v.get("version").and_then(Json::as_u64) != Some(1) {
            return Err(bad());
        }
        let seed = text(v.get("seed").ok_or_else(bad)?)?
            .parse()
            .map_err(|_| bad())?;
        let resources = v
            .get("resources")
            .and_then(Json::as_array)
            .ok_or_else(bad)?
            .iter()
            .map(|r| {
                let a = r.as_array().ok_or_else(bad)?;
                if a.len() != 2 {
                    return Err(bad());
                }
                Ok((text(&a[0])?, text(&a[1])?))
            })
            .collect::<Result<_, FixtureError>>()?;
        let records = v
            .get("records")
            .and_then(Json::as_array)
            .ok_or_else(bad)?
            .iter()
            .map(|r| {
                Ok(Record {
                    id: Uuid::parse(&text(r.get("id").ok_or_else(bad)?)?).ok_or_else(bad)?,
                    path: text(r.get("path").ok_or_else(bad)?)?,
                    source: text(r.get("source").ok_or_else(bad)?)?,
                })
            })
            .collect::<Result<_, FixtureError>>()?;
        let e = v.get("env").ok_or_else(bad)?;
        Ok(Self {
            seed,
            resources,
            records,
            query_yaml: text(v.get("query_yaml").ok_or_else(bad)?)?,
            env: QueryEnv {
                now_ms: text(e.get("now_ms").ok_or_else(bad)?)?
                    .parse()
                    .map_err(|_| bad())?,
                tz: text(e.get("tz").ok_or_else(bad)?)?,
                today: text(e.get("today").ok_or_else(bad)?)?,
            },
        })
    }
}
/// Run ONLY canonical Core compile/execute. No SQL, frontend evaluation or expected
/// result synthesis lives here.
pub fn oracle(case: &Case) -> Result<OracleOutcome, FixtureError> {
    let state = case.state()?;
    let q = match case.query() {
        Ok(q) => q,
        Err(e) => return Ok(OracleOutcome::QueryError(e)),
    };
    let plan = match query::compile(&q, &state.catalog()) {
        Ok(p) => p,
        Err(e) => return Ok(OracleOutcome::QueryError(e)),
    };
    Ok(match query::execute(&plan, &state, &case.env) {
        Ok(p) => OracleOutcome::Success(p),
        Err(e) => OracleOutcome::QueryError(e),
    })
}
/// Exact successful/error equivalence; declines/refusals are intentionally not
/// counted as a supported shape. Includes ordering/count/values/groups/diagnostics.
pub fn equivalent(expected: &OracleOutcome, actual: &AdapterOutcome) -> bool {
    match (expected, actual) {
        (OracleOutcome::Success(a), AdapterOutcome::Success(b)) => a == b,
        (OracleOutcome::QueryError(a), AdapterOutcome::QueryError(b)) => a == b,
        _ => false,
    }
}
/// Query families: existing subset plus an explicit upcoming literal-set target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shape {
    /// Bare effective string equality (including Unicode).
    ScalarEquality,
    /// Exact numeric range (mixed kinds must not coerce).
    NumericRange,
    /// Typed AND/OR composition.
    AndOr,
    /// Sorting/window/limit0 with final stable identity ties.
    OrderWindow,
    /// Explicit-map missing-key diagnostics/presence control.
    ExplicitPresence,
    /// Canonical CEL IN list; SQL support must be added in its own PR.
    LiteralSet,
}
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn index(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}
fn mixed(rng: &mut Rng) -> Option<Json> {
    match rng.index(17) {
        0 => None,
        1 => Some(Json::Null),
        2 => Some(json!(false)),
        3 => Some(json!(true)),
        4 => Some(json!(0)),
        5 => Some(json!(3)),
        6 => Some(json!(-4)),
        7 => Some(json!(3.0)),
        8 => Some(json!(9_007_199_254_740_993i64)),
        9 => Some(json!("open")),
        10 => Some(json!("done")),
        11 => Some(json!("é")),
        12 => Some(json!("e\u{301}")),
        13 => Some(json!("İ東京")),
        14 => Some(json!("")),
        15 => Some(json!(["open"])),
        _ => Some(json!({"value":"open"})),
    }
}
/// Deterministic randomized input; never use this noncryptographic RNG for keys.
/// At most 1000 records; generation is bounded test tooling, not a query budget.
pub fn generate(seed: u64, shape: Shape, record_count: usize) -> Case {
    assert!(record_count <= 1000, "bounded differential corpus");
    let mut rng = Rng(if seed == 0 { 0x9e3779b97f4a7c15 } else { seed });
    let resources=vec![("mdbase.yaml".into(),"spec_version: '0.3.0'\n".into()),("_types/task.md".into(),
        "---\nkind: mdbase.type\nname: Task\nmatch:\n  path_glob: 'tasks/*.md'\nschema:\n  dialect: json-schema-2020-12\n  value: {type: object}\ncollection:\n  read_defaults: {status: open, priority: 0}\n---\n".into())];
    let records = (0..record_count)
        .map(|i| {
            let mut fields = serde_json::Map::new();
            for name in ["status", "priority", "project", "context"] {
                if let Some(v) = mixed(&mut rng) {
                    fields.insert(name.into(), v);
                }
            }
            let mut id = [0u8; 16];
            id[0] = 1;
            id[6] = 0x70;
            id[8] = 0x80;
            id[12..].copy_from_slice(&(i as u32).to_be_bytes());
            Record {
                id: Uuid(id),
                path: format!("tasks/{i:04}-é.md"),
                source: format!("---\n{}\n---\nSeeded note {i}\n", Json::Object(fields)),
            }
        })
        .collect();
    let expr = match shape {
        Shape::ScalarEquality => [
            "status == \"open\"",
            "status == \"é\"",
            "status == null",
            "status == \"é\"",
        ][rng.index(4)],
        Shape::NumericRange => [
            "priority >= 3",
            "priority < 0",
            "priority == 9007199254740993",
        ][rng.index(3)],
        Shape::AndOr => "(status == \"open\" && priority >= 0) || status == \"done\"",
        Shape::OrderWindow => "true",
        Shape::ExplicitPresence => "record.status == \"open\"",
        Shape::LiteralSet => "status in [\"open\", \"done\", \"é\"]",
    };
    let limit = rng.index(9);
    let offset = rng.index(5);
    let direction = if rng.index(2) == 0 { "asc" } else { "desc" };
    Case {
        seed,
        resources,
        records,
        query_yaml: format!(
            "types: [Task]\nwhere: '{expr}'\nselect: [status, priority]\norder_by: [{{field: priority, direction: {direction}}}]\nlimit: {limit}\noffset: {offset}\n"
        ),
        env: QueryEnv {
            now_ms: 1_767_225_600_000,
            tz: "UTC".into(),
            today: "2026-01-01".into(),
        },
    }
}
/// Explicit exact-limit source case. Adapters must still preflight their OWN
/// encoded row/capacity overhead, without changing the logical source limit.
pub fn source_boundary(seed: u64, source_bytes: usize) -> Case {
    let mut c = generate(seed, Shape::OrderWindow, 1);
    let header = "---\nstatus: open\npriority: 3\n---\n";
    assert!(source_bytes >= header.len());
    c.records[0].source = format!("{header}{}", "x".repeat(source_bytes - header.len()));
    c.query_yaml = "types: [Task]\nwhere: 'true'\nselect: [status]\n".into();
    c
}
/// Deterministic shrinking of exact inputs: binary record subsets, then individual
/// removal and body stripping. The failing predicate (engine/adapter comparison)
/// decides which candidate retains the failure; no expected values are rewritten.
pub fn shrink(case: &Case) -> impl Iterator<Item = Case> + '_ {
    let n = case.records.len();
    let halves = [0..n / 2, n / 2..n]
        .into_iter()
        .filter(move |_| n > 1)
        .map(|range| {
            let mut c = case.clone();
            c.records = c.records[range].to_vec();
            c
        });
    let removed = (0..n).map(|i| {
        let mut c = case.clone();
        c.records.remove(i);
        c
    });
    let bodies = (0..n).filter_map(|i| {
        let end = case.records[i].source.find("\n---\n")? + 5;
        if end >= case.records[i].source.len() {
            return None;
        }
        let mut c = case.clone();
        c.records[i].source.truncate(end);
        Some(c)
    });
    halves.chain(removed).chain(bodies)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn seeded_inputs_roundtrip_and_actual_engine_is_deterministic() {
        for seed in 0..32 {
            for shape in [
                Shape::ScalarEquality,
                Shape::NumericRange,
                Shape::AndOr,
                Shape::OrderWindow,
                Shape::ExplicitPresence,
                Shape::LiteralSet,
            ] {
                let case = generate(seed, shape, 24);
                let restored = Case::from_json(&case.to_json()).unwrap();
                assert_eq!(case.to_json(), restored.to_json());
                let expected = oracle(&case).unwrap();
                let OracleOutcome::Success(ref page) = expected else {
                    panic!("seed {seed} shape {shape:?}: {expected:?}");
                };
                if shape == Shape::OrderWindow {
                    assert_eq!(
                        page.total_count, 24,
                        "fixture membership must not be vacuous"
                    );
                }
                assert_eq!(expected, oracle(&restored).unwrap());
            }
        }
    }
    #[test]
    fn unsupported_adapter_never_counts_as_success() {
        let c = generate(1, Shape::LiteralSet, 12);
        let expected = oracle(&c).unwrap();
        assert!(!equivalent(
            &expected,
            &AdapterOutcome::LowerDeclined("unsupported IN".into())
        ));
        assert!(!equivalent(
            &expected,
            &AdapterOutcome::ResourceExhausted("budget".into())
        ));
        if let OracleOutcome::Success(page) = expected {
            assert!(equivalent(
                &OracleOutcome::Success(page.clone()),
                &AdapterOutcome::Success(page)
            ));
        }
    }
    #[test]
    fn exact_source_boundary_and_shrunk_cases_remain_reproducible() {
        let c = source_boundary(42, 1024 * 1024);
        assert_eq!(c.records[0].source.len(), 1024 * 1024);
        let OracleOutcome::Success(page) = oracle(&c).unwrap() else {
            panic!("boundary query must execute")
        };
        assert_eq!(page.total_count, 1);
        assert_eq!(page.ids, vec![c.records[0].id]);
        for s in shrink(&generate(7, Shape::AndOr, 8)) {
            assert_eq!(
                s.to_json(),
                Case::from_json(&s.to_json()).unwrap().to_json()
            );
        }
    }
}
