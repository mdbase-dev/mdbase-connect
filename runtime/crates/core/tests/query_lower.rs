//! Candidate lowering: the candidate is necessary for the residual, and
//! sufficient when the plan says it is exact.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::field_reassign_with_default
)]

use mdbn_core::query::{
    self, Candidate, CompareOp, FieldRef, Pruning, Query, QueryEnv, QueryRecord, Verdict,
};
use mdbn_core::types::Catalog;
use mdbn_core::value::{Map, Value};

const TYPES: &[(&str, &str)] = &[
    (
        "_types/task.md",
        "---\nkind: mdbase.type\nname: task\nmatch:\n  path_glob: \"tasks/**/*.md\"\nschema:\n  dialect: json-schema-2020-12\n  value: {type: object}\ncollection:\n  read_defaults:\n    priority: low\n---\n",
    ),
    (
        "_types/note.md",
        "---\nkind: mdbase.type\nname: note\nmatch:\n  path_glob: \"notes/**/*.md\"\nschema:\n  dialect: json-schema-2020-12\n  value: {type: object}\n---\n",
    ),
];

/// A store's view of a candidate: exact where it can be, `true` otherwise.
fn holds(c: &Candidate, path: &str, types: &[String], fm: &Map) -> bool {
    match c {
        Candidate::All => true,
        Candidate::None => false,
        Candidate::And(cs) => cs.iter().all(|c| holds(c, path, types, fm)),
        Candidate::Or(cs) => cs.iter().any(|c| holds(c, path, types, fm)),
        Candidate::Not(inner) => !holds(inner, path, types, fm),
        Candidate::HasType(t) => types.iter().any(|x| x.eq_ignore_ascii_case(t)),
        Candidate::InFolder(f) => path
            .strip_prefix(f.as_str())
            .is_some_and(|r| r.starts_with('/')),
        Candidate::Compare {
            field: FieldRef::Persisted(p),
            op,
            value,
            pruning: Pruning::Exact,
        } if p.len() == 1 => {
            let eq = fm.get(&p[0]) == Some(value);
            match op {
                CompareOp::Eq => eq,
                CompareOp::Ne => !eq,
                _ => true,
            }
        }
        Candidate::Compare {
            field: FieldRef::Persisted(p),
            op,
            value: Value::Text(lit),
            pruning: Pruning::IsoDate,
        } if p.len() == 1 => match fm.get(&p[0]) {
            Some(Value::Text(s)) if s.len() == 10 => match op {
                CompareOp::Lt => s < lit,
                CompareOp::Le => s <= lit,
                CompareOp::Gt => s > lit,
                CompareOp::Ge => s >= lit,
                _ => true,
            },
            _ => true,
        },
        Candidate::Compare { .. } => true,
        Candidate::LinksTo(_) | Candidate::BodyContains { .. } => true,
    }
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
    fn pick<'a>(&mut self, xs: &[&'a str]) -> &'a str {
        xs[usize::try_from(self.next() % xs.len() as u64).unwrap()]
    }
}

fn atom(r: &mut Rng) -> String {
    let field = r.pick(&[
        "status",
        "raw.status",
        "priority",
        "record.priority",
        "due",
        "n",
    ]);
    let lit = r.pick(&[
        "\"open\"",
        "\"done\"",
        "\"low\"",
        "\"2026-01-02\"",
        "true",
        "1",
        "null",
    ]);
    let op = r.pick(&["==", "!=", "<", ">=", "in"]);
    match r.next() % 6 {
        0 => format!(
            "file.inFolder(\"{}\")",
            r.pick(&["tasks", "notes", "tasks/a"])
        ),
        1 => format!(
            "has({})",
            r.pick(&["raw.status", "raw.due", "record.status"])
        ),
        2 if op == "in" => format!("{field} in [{lit}, \"open\"]"),
        3 => format!("{lit} {} {field}", r.pick(&["==", "!=", "<", ">"])),
        _ if op == "in" => format!("{field} == {lit}"),
        _ => format!("{field} {op} {lit}"),
    }
}

fn expr(r: &mut Rng, depth: u32) -> String {
    if depth == 0 || r.next().is_multiple_of(3) {
        return atom(r);
    }
    match r.next() % 4 {
        0 => format!("({} && {})", expr(r, depth - 1), expr(r, depth - 1)),
        1 => format!("({} || {})", expr(r, depth - 1), expr(r, depth - 1)),
        2 => format!("!({})", expr(r, depth - 1)),
        _ => format!("({} ? {} : {})", atom(r), atom(r), atom(r)),
    }
}

fn record(r: &mut Rng) -> (String, Map) {
    let path = r
        .pick(&["tasks/a/x.md", "tasks/y.md", "notes/z.md", "other.md"])
        .to_owned();
    let mut m = Map::new();
    for key in ["status", "priority", "due", "n"] {
        match r.next() % 5 {
            0 => {}
            1 => {
                m.insert(key, Value::Null);
            }
            2 => {
                m.insert(key, Value::Int(1));
            }
            3 => {
                m.insert(key, Value::Bool(true));
            }
            _ => {
                let v = r.pick(&["open", "done", "low", "2026-01-01", "2026-01-03"]);
                m.insert(key, Value::string(v));
            }
        }
    }
    (path, m)
}

#[test]
fn candidates_are_necessary_and_exact_plans_are_sufficient() {
    let catalog = Catalog::load(TYPES.iter().copied());
    let env = QueryEnv {
        now_ms: 0,
        tz: "UTC".into(),
        today: "2026-01-01".into(),
    };
    let mut exact_plans = 0;
    for seed in 0..2_000u64 {
        let mut r = Rng(seed);
        let src = expr(&mut r, 3);
        let mut q = Query::default();
        q.where_ = Some(src.clone());
        if r.next().is_multiple_of(3) {
            q.types = vec!["task".into()];
        }
        let plan = query::compile(&q, &catalog).expect(&src);
        exact_plans += u32::from(plan.exact);
        for _ in 0..20 {
            let (path, fm) = record(&mut r);
            let types = catalog.membership(&path, &fm).types;
            let rec = QueryRecord {
                path: &path,
                types: &types,
                frontmatter: &fm,
                body: Some(""),
            };
            let matched = matches!(plan.matches(&rec, &env), Verdict::Match);
            let cand = holds(&plan.candidate, &path, &types, &fm);
            assert!(
                !matched || cand,
                "candidate pruned a match: where `{src}` on {path} {fm:?}: {:?}",
                plan.candidate
            );
            if plan.exact {
                assert_eq!(
                    matched, cand,
                    "exact plan disagrees: `{src}` on {path} {fm:?}"
                );
            }
        }
    }
    assert!(
        exact_plans > 50,
        "only {exact_plans} exact plans; the generator is too weak"
    );
}

#[test]
fn simple_filters_lower_to_indexable_terms() {
    let catalog = Catalog::load(TYPES.iter().copied());
    let mut q = Query::default();
    q.types = vec!["task".into()];
    q.where_ =
        Some("status == \"open\" && file.inFolder(\"tasks/\") && due < \"2026-02-01\"".into());
    let plan = query::compile(&q, &catalog).unwrap();
    let Candidate::And(terms) = &plan.candidate else {
        panic!("{:?}", plan.candidate)
    };
    assert_eq!(terms[0], Candidate::HasType("task".into()));
    assert!(terms.contains(&Candidate::InFolder("tasks".into())));
    assert!(terms.iter().any(|t| matches!(
        t,
        Candidate::Compare {
            pruning: Pruning::IsoDate,
            ..
        }
    )));
    assert!(!plan.exact);
    // A defaulted field stays effective, so it is never pruned on.
    q.where_ = Some("priority == \"low\"".into());
    let plan = query::compile(&q, &catalog).unwrap();
    assert_eq!(plan.candidate, Candidate::HasType("task".into()));
    // An exact filter.
    q.where_ = Some("status == \"open\" || !(status != \"done\")".into());
    assert!(query::compile(&q, &catalog).unwrap().exact);
}

/// Link and body candidates against the real link index and bodies.
fn holds_full(c: &Candidate, catalog: &Catalog, path: &str, source: &str, body: &str) -> bool {
    match c {
        Candidate::And(cs) => cs
            .iter()
            .all(|c| holds_full(c, catalog, path, source, body)),
        Candidate::Or(cs) => cs
            .iter()
            .any(|c| holds_full(c, catalog, path, source, body)),
        Candidate::LinksTo(keys) => {
            let own = mdbn_core::links::index_keys(catalog, path, source);
            keys.iter().any(|k| own.contains(k))
        }
        Candidate::BodyContains {
            text,
            case_insensitive,
        } => {
            if *case_insensitive {
                body.to_lowercase().contains(text.as_str())
            } else {
                body.contains(text.as_str())
            }
        }
        _ => true,
    }
}

#[test]
fn normalized_source_links_and_legacy_indexes_keep_residual_matches() {
    use mdbn_core::state::{MemState, StateView};
    let env = QueryEnv {
        now_ms: 0,
        tz: "UTC".into(),
        today: "2026-01-01".into(),
    };
    for (path, body) in [
        ("s.md", "[[dir/a/..]]"),
        ("s.md", "[[dir/.]]"),
        ("s.md", "[[dir/]]"),
        ("s.md", "[dir](./dir/a/..)"),
        ("base/s.md", "[dir](../dir/)"),
        ("dir/sub/s.md", "[dir](..)"),
        ("dir/s.md", "[dir](.)"),
    ] {
        let mut state = MemState::new();
        let target = mdbn_core::ids::Uuid([1; 16]);
        let source = mdbn_core::ids::Uuid([2; 16]);
        state.insert_record(target, "dir.md", "---\nt: 1\n---\n");
        let source_text = format!("---\nt: 1\n---\n{body}\n");
        state.insert_record(source, path, &source_text);
        let catalog = state.catalog();
        for expression in [
            "file.hasLink(\"[[dir]]\")",
            "file.hasLink(link(\"[[dir]]\"))",
        ] {
            let q = Query {
                where_: Some(expression.into()),
                ..Query::default()
            };
            let plan = query::compile(&q, &catalog).unwrap();
            assert!(
                query::execute(&plan, &state, &env)
                    .unwrap()
                    .ids
                    .contains(&source),
                "{path}: {body}"
            );
            let doc = mdbn_core::doc::Document::parse_at(path, &source_text);
            assert!(holds_full(
                &plan.candidate,
                &catalog,
                path,
                &source_text,
                doc.body()
            ));
            let Candidate::LinksTo(keys) = &plan.candidate else {
                panic!("{:?}", plan.candidate);
            };
            // Simulate metadata materialized by the previous raw-basename codec.
            let old: Vec<_> = mdbn_core::links::record_links(&catalog, path, &source_text)
                .iter()
                .map(|link| mdbn_core::links::name_index_key(&catalog, &link.target))
                .collect();
            assert!(
                keys.iter().any(|key| old.contains(key)),
                "legacy index pruned {path}: {body}"
            );
            assert!(
                mdbn_core::links::links_to(&state, target)
                    .iter()
                    .any(|link| link.id == source),
                "canonical backlink lookup lost {path}: {body}"
            );
        }
    }
}

#[test]
fn source_dependent_relative_query_literals_stay_residual() {
    use mdbn_core::state::{MemState, StateView};
    let env = QueryEnv {
        now_ms: 0,
        tz: "UTC".into(),
        today: "2026-01-01".into(),
    };
    let mut state = MemState::new();
    let source = mdbn_core::ids::Uuid([2; 16]);
    state.insert_record(mdbn_core::ids::Uuid([1; 16]), "dir.md", "---\nt: 1\n---\n");
    state.insert_record(source, "dir/sub/s.md", "---\nt: 1\n---\n[[dir]]\n");
    let q = Query {
        where_: Some("file.hasLink(\"[dir](..)\")".into()),
        ..Query::default()
    };
    let plan = query::compile(&q, &state.catalog()).unwrap();
    assert_eq!(plan.candidate, Candidate::All);
    assert!(!plan.exact);
    assert!(
        query::execute(&plan, &state, &env)
            .unwrap()
            .ids
            .contains(&source)
    );
}

#[test]
fn link_and_body_candidates_are_necessary() {
    use mdbn_core::state::{MemState, StateView};
    let env = QueryEnv {
        now_ms: 0,
        tz: "UTC".into(),
        today: "2026-01-01".into(),
    };
    let wheres = [
        "file.hasLink(link(\"[[a]]\"))",
        "\"[[b]]\" in file.links",
        "file.links.contains(\"[[dir/a]]\")",
        "file.body.contains(\"foo\")",
        "file.body.lower().contains(\"foo\")",
        "file.hasLink(\"[[a]]\") || file.body.contains(\"Foo\")",
    ];
    let pieces = [
        "[[a]] ",
        "[[b]] ",
        "[b](b.md) ",
        "![[a]] ",
        "[[dir/a]] ",
        "foo ",
        "FOO ",
        "x ",
    ];
    let mut checked = 0;
    for seed in 0..200u64 {
        let mut r = Rng(seed);
        let mut s = MemState::new();
        for (i, p) in ["a.md", "b.md", "dir/a.md"].iter().enumerate() {
            s.insert_record(
                mdbn_core::ids::Uuid([u8::try_from(i).unwrap() + 1; 16]),
                p,
                "---\nt: 1\n---\n",
            );
        }
        for i in 0..10u8 {
            let mut body = String::new();
            for _ in 0..3 {
                body.push_str(r.pick(&pieces));
            }
            let path = format!("{}n{i}.md", if i % 2 == 0 { "dir/" } else { "" });
            s.insert_record(
                mdbn_core::ids::Uuid([100 + i; 16]),
                &path,
                &format!("---\nt: 1\n---\n{body}\n"),
            );
        }
        let catalog = s.catalog();
        for w in wheres {
            let mut q = Query::default();
            q.where_ = Some(w.to_owned());
            let plan = query::compile(&q, &catalog).expect(w);
            assert!(
                !matches!(plan.candidate, Candidate::All),
                "`{w}` was not lowered"
            );
            for id in query::execute(&plan, &s, &env).unwrap().ids {
                let rec = s.record(&id).unwrap();
                let doc = mdbn_core::doc::Document::parse_at(&rec.path, &*rec.source);
                assert!(
                    holds_full(
                        &plan.candidate,
                        &catalog,
                        &rec.path,
                        &rec.source,
                        doc.body()
                    ),
                    "`{w}` pruned {}: {:?}",
                    rec.path,
                    plan.candidate
                );
                checked += 1;
            }
        }
    }
    assert!(checked > 500, "only {checked} matches checked");
}

#[test]
fn sec2_normalized_path_link_candidates_must_remain_necessary() {
    use mdbn_core::state::{MemState, StateView};
    let env = QueryEnv {
        now_ms: 0,
        tz: "UTC".into(),
        today: "2026-01-01".into(),
    };
    let mut s = MemState::new();
    s.insert_record(mdbn_core::ids::Uuid([1; 16]), "dir.md", "---\nt: 1\n---\n");
    s.insert_record(
        mdbn_core::ids::Uuid([2; 16]),
        "s.md",
        "---\nt: 1\n---\n[[dir]]\n",
    );
    let catalog = s.catalog();
    for literal in ["[[dir/a/..]]", "[[dir/.]]"] {
        let mut q = Query::default();
        q.where_ = Some(format!("file.hasLink(\"{literal}\")"));
        let plan = query::compile(&q, &catalog).unwrap();
        let matched = query::execute(&plan, &s, &env).unwrap().ids;
        assert!(
            matched.contains(&mdbn_core::ids::Uuid([2; 16])),
            "residual really matches {literal}"
        );
        let rec = s.record(&mdbn_core::ids::Uuid([2; 16])).unwrap();
        let doc = mdbn_core::doc::Document::parse_at(&rec.path, &*rec.source);
        eprintln!(
            "S2 normalized literal {literal}: {:?}, residual matched",
            plan.candidate
        );
        assert!(
            holds_full(
                &plan.candidate,
                &catalog,
                &rec.path,
                &rec.source,
                doc.body()
            ),
            "necessary candidate must not prune a normalized-path residual match"
        );
    }
}
