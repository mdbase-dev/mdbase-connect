//! Candidate lowering: the candidate is necessary for the residual, and
//! sufficient when the plan says it is exact.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::field_reassign_with_default
)]

use mdbn_core::query::{
    self, Candidate, CompareOp, FieldRef, Haystack, Pruning, Query, QueryEnv, QueryRecord, Verdict,
    folded_contains,
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
        Candidate::FoldedContains { text, needle } => match text {
            Haystack::Path => folded_contains(path, needle),
            Haystack::Field(field) => {
                matches!(fm.get(field), Some(Value::Text(s)) if folded_contains(s, needle))
            }
        },
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

type Atom = fn(&mut Rng) -> String;

fn expr(r: &mut Rng, depth: u32, atom: Atom) -> String {
    if depth == 0 || r.next().is_multiple_of(3) {
        return atom(r);
    }
    match r.next() % 4 {
        0 => format!(
            "({} && {})",
            expr(r, depth - 1, atom),
            expr(r, depth - 1, atom)
        ),
        1 => format!(
            "({} || {})",
            expr(r, depth - 1, atom),
            expr(r, depth - 1, atom)
        ),
        2 => format!("!({})", expr(r, depth - 1, atom)),
        _ => format!("({} ? {} : {})", atom(r), atom(r), atom(r)),
    }
}

/// A substring search in every form the lowering reads or must leave alone:
/// exact and lower-cased, over the path, its parts and fields that are
/// persisted, read-defaulted (`priority`), nested or not text, bare and under
/// the guards real queries write. One time in four, a comparison instead.
fn search_atom(r: &mut Rng) -> String {
    let receiver = r.pick(&[
        "file.path",
        "file.name",
        "file.basename",
        "file.folder",
        "file.ext",
        "title",
        "raw.title",
        "record.title",
        "url",
        "priority",
        "record.priority",
        "meta.title",
        "n",
    ]);
    let needle = r.pick(&[
        "caf",
        "CAF",
        "é",
        "É",
        "ς",
        "σ",
        "Σ",
        "οσ",
        "ος",
        "ΟΣ",
        "i\u{307}s",
        "İ",
        "ist",
        "ss",
        "ß",
        "k",
        "\u{212a}",
        "passport",
        "lo",
        "",
        ".md",
        "TASKS",
        "tasks/",
    ]);
    let field = r.pick(&["title", "url", "priority", "n"]);
    match r.next() % 8 {
        0 | 1 => atom(r),
        2 => format!("{receiver}.contains(\"{needle}\")"),
        3 => format!("{receiver}.upper().contains(\"{needle}\")"),
        4 => format!("(\"{field}\" in record && record.{field}.lower().contains(\"{needle}\"))"),
        5 => format!("({field} != null && {field}.lower().contains(\"{needle}\"))"),
        _ => format!("{receiver}.lower().contains(\"{needle}\")"),
    }
}

/// Records for the search atoms: mixed-case and non-ASCII paths, and fields
/// that are missing, null, not text, nested, or text in mixed case.
fn search_record(r: &mut Rng) -> (String, Map) {
    let path = r
        .pick(&[
            "tasks/Café Été.md",
            "tasks/a/İstanbul.md",
            "tasks/passport.MD",
            "notes/ΟΔΟΣ.md",
            "notes/straße \u{212a}.md",
            "Other/ΟΔΟΣ ΟΣ.txt",
        ])
        .to_owned();
    let mut m = Map::new();
    for key in ["title", "url", "priority", "n", "status", "due"] {
        let text = r.pick(&[
            "Café",
            "CAFÉ ÉTÉ",
            "ΟΔΟΣ",
            "οδος",
            "οδοσ α",
            "İstanbul",
            "istanbul",
            "STRASSE",
            "straße",
            "Passport Renewal",
            "\u{212a}elvin",
            "low",
            "open",
            "",
        ]);
        match r.next() % 8 {
            0 => {}
            1 => {
                m.insert(key, Value::Null);
            }
            2 => {
                m.insert(key, Value::Int(1));
            }
            3 => {
                m.insert(key, Value::List(vec![Value::string(text)]));
            }
            _ => {
                m.insert(key, Value::string(text));
            }
        }
    }
    if r.next().is_multiple_of(2) {
        let mut meta = Map::new();
        meta.insert(
            "title",
            Value::string(r.pick(&["Café", "ΟΔΟΣ", "passport"])),
        );
        m.insert("meta", Value::Map(meta));
    }
    (path, m)
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

/// What a run of generated plans and records showed.
#[derive(Default)]
struct Seen {
    exact_plans: u32,
    /// Records the residual matched.
    matched: u32,
    /// Records the candidate rejected.
    pruned: u32,
}

/// For generated `where` clauses and records: a record the residual matches
/// always satisfies the candidate, and an exact plan's candidate is the
/// residual.
fn check(seeds: u64, atom: Atom, record: fn(&mut Rng) -> (String, Map)) -> Seen {
    let catalog = Catalog::load(TYPES.iter().copied());
    let env = QueryEnv {
        now_ms: 0,
        tz: "UTC".into(),
        today: "2026-01-01".into(),
    };
    let mut seen = Seen::default();
    for seed in 0..seeds {
        let mut r = Rng(seed);
        let src = expr(&mut r, 3, atom);
        let mut q = Query::default();
        q.where_ = Some(src.clone());
        if r.next().is_multiple_of(3) {
            q.types = vec!["task".into()];
        }
        let plan = query::compile(&q, &catalog).expect(&src);
        seen.exact_plans += u32::from(plan.exact);
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
            seen.matched += u32::from(matched);
            seen.pruned += u32::from(!cand);
        }
    }
    seen
}

#[test]
fn candidates_are_necessary_and_exact_plans_are_sufficient() {
    let seen = check(2_000, atom, record);
    assert!(
        seen.exact_plans > 50,
        "only {} exact plans; the generator is too weak",
        seen.exact_plans
    );
}

/// The same property where the atoms are substring searches: the folded
/// candidate never rejects a record the evaluator accepts, whatever the case,
/// script, guard, combination or stored value.
#[test]
fn substring_search_candidates_are_necessary() {
    let seen = check(4_000, search_atom, search_record);
    assert!(
        seen.matched > 2_000 && seen.pruned > 10_000,
        "{} matches and {} pruned records; the generator is too weak",
        seen.matched,
        seen.pruned
    );
}

fn candidate_of(where_: &str) -> Candidate {
    let catalog = Catalog::load(TYPES.iter().copied());
    let q = Query {
        where_: Some(where_.into()),
        ..Query::default()
    };
    query::compile(&q, &catalog).expect(where_).candidate
}

fn folded(text: Haystack, needle: &str) -> Candidate {
    Candidate::FoldedContains {
        text,
        needle: needle.into(),
    }
}

/// The searches the apps send, and the forms that must stay unlowered.
#[test]
fn substring_searches_lower_to_folded_contains() {
    let title = || Haystack::Field("title".into());
    // TaskNotes record completion.
    assert_eq!(
        candidate_of(
            "file.path.lower().contains(\"café\") || (\"title\" in record && record.title.lower().contains(\"café\"))"
        ),
        Candidate::Or(vec![
            folded(Haystack::Path, "café"),
            folded(title(), "café")
        ])
    );
    // Reader find-by-URL.
    assert_eq!(
        candidate_of(
            "(url != null && url.lower().contains(\"example.com/a\")) || (original_url != null && original_url.lower().contains(\"example.com/a\"))"
        ),
        Candidate::Or(vec![
            folded(Haystack::Field("url".into()), "example.com/a"),
            folded(Haystack::Field("original_url".into()), "example.com/a"),
        ])
    );
    // The MCP skill's title search.
    assert_eq!(
        candidate_of("title.lower().contains(\"passport\")"),
        folded(title(), "passport")
    );
    // The exact form: every part of the path is searched in the path, and the
    // literal is folded, final sigma included.
    for part in ["path", "name", "basename", "folder", "ext"] {
        assert_eq!(
            candidate_of(&format!("file.{part}.contains(\"Willow ΟΣ\")")),
            folded(Haystack::Path, "willow οσ")
        );
    }
    assert_eq!(
        candidate_of("raw.title.contains(\"A\")"),
        folded(title(), "a")
    );
    // Not lowered: a read-defaulted field (its stored value is not what the
    // evaluator reads), a nested field, a non-literal needle, another
    // transform, a negation, and a disjunction with an unlowered side.
    for unlowered in [
        "priority.lower().contains(\"lo\")",
        "record.priority.contains(\"lo\")",
        "meta.title.lower().contains(\"a\")",
        "title.contains(status)",
        "title.contains(1)",
        "title.upper().contains(\"A\")",
        "title.lower().lower().contains(\"a\")",
        "!title.contains(\"a\")",
        "title.contains(\"a\") || n > 1",
        "this.title.contains(\"a\")",
        "projection.title.contains(\"a\")",
    ] {
        assert_eq!(candidate_of(unlowered), Candidate::All, "{unlowered}");
    }
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
