//! Property tests for the three-way merge (spec 12A), over generated records.
//!
//! Laws the spec states or implies, each checked with fixed seeds:
//! - **identity**: an unchanged side yields the other side byte for byte, and
//!   two identical sides yield that side;
//! - **determinism**: the same inputs give the same bytes and conflicts;
//! - **field rules**: every merged frontmatter value agrees with an independent
//!   implementation of the 12A rules and strategies; values a side did not
//!   change keep that side's bytes;
//! - **commutativity where declared**: swapping the sides gives the same
//!   values for `max`/`min` (up to equality), the same set for `union`, the same
//!   conflicting fields, and the same body when the body merges by diff3;
//! - **no silent loss**: a conflict records the second side's value, and the
//!   merged document always parses.

mod support;

use std::cmp::Ordering;
use std::collections::BTreeSet;

use mdbn_core::doc::{Document, RecordFormat};
use mdbn_core::merge::order::compare;
use mdbn_core::merge::{ConflictKind, ConflictValue, Merged, Version, merge_body, merge_records};
use mdbn_core::merge::{MergeFacts, MergeStrategy, MergeTypes};
use mdbn_core::value::{Map, Value};
use mdbn_core::writer::{Change, entry_copy, render_new, write};
use support::Rng;

const CASES: u64 = 3000;

const TYPE: &str = "---\nkind: mdbase.type\nname: item\nversion: 1\nmatch:\n  path_glob: \"items/**/*.md\"\nschema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\n    properties:\n      reviewers: { type: array, uniqueItems: true }\ncollection:\n  merge:\n    due: max\n    rank: min\nlifecycle:\n  on_update:\n    set:\n      dateModified: { now: true }\n---\n";

fn catalog() -> mdbn_core::types::Catalog {
    mdbn_core::types::Catalog::load([("_types/item.md", TYPE)])
}

fn facts() -> MergeFacts {
    catalog().merge_facts("items/a.md", &Map::new())
}

fn gen_value(r: &mut Rng, key: &str) -> Value {
    let s = |x: &&str| Value::string(*x);
    match key {
        "status" => s(r.pick(&["open", "doing", "done"])),
        "due" => s(r.pick(&["2026-10-01", "2026-10-05", "2026-11-01", "2026-09-30"])),
        "dateModified" => s(r.pick(&[
            "2026-10-01T00:00:00Z",
            "2026-10-02T09:00:00+10:00",
            "2026-10-01T23:30:00Z",
            "2026-10-03T00:00:00.5Z",
        ])),
        "rank" => match r.below(4) {
            0 => s(&"high"),
            1 => Value::Null,
            _ => Value::int(r.below(5) as i64),
        },
        "tags" | "reviewers" | "labels" => {
            if key == "tags" && r.chance(1, 6) {
                return s(r.pick(&["a", "b", "c"]));
            }
            let pool = ["a", "b", "c", "d", "e"];
            let mut items = Vec::new();
            for p in pool {
                if r.chance(1, 2) {
                    items.push(s(&p));
                }
            }
            Value::List(items)
        }
        _ => s(r.pick(&["x", "y", "z"])),
    }
}

const KEYS: &[&str] = &[
    "title",
    "status",
    "due",
    "dateModified",
    "rank",
    "tags",
    "reviewers",
    "labels",
];

fn gen_body(r: &mut Rng) -> Vec<String> {
    (0..r.usize(6)).map(|i| format!("line {i}\n")).collect()
}

fn edit_body(r: &mut Rng, base: &[String], tag: &str) -> String {
    let mut lines = base.to_vec();
    match r.below(5) {
        0 => {}
        1 => lines.push(format!("{tag} appended\n")),
        2 if !lines.is_empty() => {
            let i = r.usize(lines.len());
            lines[i] = format!("{tag} changed {i}\n");
        }
        3 if !lines.is_empty() => {
            lines.remove(r.usize(lines.len()));
        }
        _ => {
            let i = r.usize(lines.len() + 1);
            lines.insert(i, format!("{tag} inserted\n"));
        }
    }
    lines.concat()
}

/// A base document and two edited versions.
fn gen_case(r: &mut Rng) -> (String, String, String) {
    let mut fm = Map::new();
    for k in KEYS {
        if r.chance(1, 2) {
            fm.insert(*k, gen_value(r, k));
        }
    }
    let body = gen_body(r);
    let base = render_new(
        &fm,
        &body.concat(),
        RecordFormat::Markdown,
        mdbn_core::doc::LineEnding::Lf,
    )
    .unwrap();
    let base = if base.starts_with("---") {
        base
    } else {
        format!("---\n---\n{base}")
    };
    let side = |r: &mut Rng, tag: &str| {
        let d = Document::parse(base.clone(), RecordFormat::Markdown);
        let mut changes = Vec::new();
        for _ in 0..r.usize(3) {
            let k = *r.pick(KEYS);
            if r.chance(1, 4) {
                changes.push((k.to_owned(), Change::Remove));
            } else {
                changes.push((k.to_owned(), Change::Set(gen_value(r, k))));
            }
        }
        write(&d, &changes, Some(&edit_body(r, &body, tag))).unwrap()
    };
    let first = side(r, "F");
    let second = side(r, "S");
    (base, first, second)
}

fn run(b: &str, f: &str, s: &str) -> Merged {
    let v = |src| Version {
        path: "items/a.md",
        source: src,
    };
    merge_records(v(b), v(f), v(s), &catalog())
}

fn fm(src: &str) -> Map {
    Document::parse(src, RecordFormat::Markdown)
        .frontmatter()
        .clone()
}

/// The 12A field rules, written independently of `mdbn_core::merge`:
/// `Ok(Some(v))` / `Ok(None)` for the merged state, `Err(())` for a conflict.
fn expected_field(
    key: &str,
    b: Option<&Value>,
    f: Option<&Value>,
    s: Option<&Value>,
) -> Result<Option<Value>, ()> {
    if f == s || s == b {
        return Ok(f.cloned());
    }
    if f == b {
        return Ok(s.cloned());
    }
    match facts().strategy(key).unwrap() {
        MergeStrategy::Conflict => Err(()),
        st @ (MergeStrategy::Max | MergeStrategy::Min) => match (f, s) {
            (None, x) | (x, None) => Ok(x.cloned()),
            (Some(x), Some(y)) => match compare(x, y) {
                None => Err(()),
                Some(o) => {
                    let second = (st == MergeStrategy::Max && o == Ordering::Less)
                        || (st == MergeStrategy::Min && o == Ordering::Greater);
                    Ok(Some(if second { y.clone() } else { x.clone() }))
                }
            },
        },
        MergeStrategy::Union => {
            let as_list = |v: Option<&Value>| match v {
                None | Some(Value::Null) => Some(Vec::new()),
                Some(Value::List(l)) => Some(l.clone()),
                Some(Value::Text(t)) if key == "tags" => Some(vec![Value::Text(t.clone())]),
                _ => None,
            };
            let (Some(bl), Some(fl), Some(sl)) = (as_list(b), as_list(f), as_list(s)) else {
                return Err(());
            };
            let mut out: Vec<Value> = fl
                .iter()
                .filter(|x| !bl.contains(x) || sl.contains(x))
                .cloned()
                .collect();
            for x in &sl {
                if !bl.contains(x) && !out.contains(x) {
                    out.push(x.clone());
                }
            }
            if out.is_empty() && (f.is_none() || s.is_none()) {
                Ok(None)
            } else if matches!(f, Some(Value::List(l)) if *l == out) {
                Ok(f.cloned())
            } else {
                Ok(Some(Value::List(out)))
            }
        }
    }
}

#[test]
fn the_test_type_loads() {
    // Guards against a vacuous oracle: the strategies must come from the type.
    let f = facts();
    assert_eq!(f.strategy("due"), Ok(MergeStrategy::Max));
    assert_eq!(f.strategy("rank"), Ok(MergeStrategy::Min));
    assert_eq!(f.strategy("dateModified"), Ok(MergeStrategy::Max));
    assert_eq!(f.strategy("reviewers"), Ok(MergeStrategy::Union));
}

#[test]
fn identity_laws() {
    for seed in 0..CASES {
        let mut r = Rng::new(seed);
        let (b, f, s) = gen_case(&mut r);
        assert_eq!(run(&b, &b, &s).document, s, "seed {seed}");
        assert_eq!(run(&b, &f, &b).document, f, "seed {seed}");
        assert_eq!(run(&b, &f, &f).document, f, "seed {seed}");
        assert!(run(&b, &b, &s).conflicts.is_empty());
    }
}

#[test]
fn deterministic() {
    for seed in 0..CASES {
        let mut r = Rng::new(seed);
        let (b, f, s) = gen_case(&mut r);
        assert_eq!(run(&b, &f, &s), run(&b, &f, &s), "seed {seed}");
    }
}

#[test]
fn field_rules_hold_and_nothing_is_lost() {
    for seed in 0..CASES {
        let mut r = Rng::new(seed);
        let (b, f, s) = gen_case(&mut r);
        let m = run(&b, &f, &s);
        let md = Document::parse(m.document.clone(), RecordFormat::Markdown);
        assert!(md.problem().is_none(), "seed {seed}\n{}", m.document);
        let (bm, fmm, sm, mm) = (fm(&b), fm(&f), fm(&s), md.frontmatter().clone());
        let conflicted: BTreeSet<&str> = m
            .conflicts
            .iter()
            .filter(|c| c.kind == ConflictKind::Field)
            .filter_map(|c| c.field.as_deref())
            .collect();
        let fdoc = Document::parse(f.clone(), RecordFormat::Markdown);
        let sdoc = Document::parse(s.clone(), RecordFormat::Markdown);
        for key in KEYS {
            let (bv, fv, sv) = (bm.get(key), fmm.get(key), sm.get(key));
            match expected_field(key, bv, fv, sv) {
                Err(()) => {
                    assert!(
                        conflicted.contains(key),
                        "seed {seed}: {key} should conflict"
                    );
                    assert_eq!(
                        mm.get(key),
                        fv,
                        "seed {seed}: conflict keeps the first value"
                    );
                    let c = m
                        .conflicts
                        .iter()
                        .find(|c| c.field.as_deref() == Some(key))
                        .unwrap();
                    let want =
                        sv.map_or(ConflictValue::Missing, |v| ConflictValue::Value(v.clone()));
                    assert_eq!(c.second, want, "seed {seed}: the second value is recorded");
                }
                Ok(v) => {
                    assert!(
                        !conflicted.contains(key),
                        "seed {seed}: {key} should not conflict"
                    );
                    assert_eq!(
                        mm.get(key),
                        v.as_ref(),
                        "seed {seed}: {key}\nB:\n{b}\nF:\n{f}\nS:\n{s}\nM:\n{}",
                        m.document
                    );
                }
            }
            // A value equal to the first side's keeps its bytes; one equal to
            // the second side's (and not the first's) is copied from it.
            if let Some(mv) = mm.get(key) {
                let me = entry_copy(&md, key).unwrap();
                if fv == Some(mv) {
                    assert_eq!(
                        me.text(),
                        entry_copy(&fdoc, key).unwrap().text(),
                        "seed {seed}: {key}"
                    );
                } else if sv == Some(mv) {
                    assert_eq!(
                        me.text(),
                        entry_copy(&sdoc, key).unwrap().text(),
                        "seed {seed}: {key}"
                    );
                }
            }
        }
        // Body: a conflict keeps the first body; otherwise merge_body decides.
        let body_conflict = m.conflicts.iter().any(|c| c.kind == ConflictKind::Body);
        let bb = Document::parse(b.clone(), RecordFormat::Markdown)
            .body()
            .to_owned();
        match merge_body(&bb, fdoc.body(), sdoc.body()) {
            Some(x) => assert!(!body_conflict && md.body() == x, "seed {seed}"),
            None => assert!(body_conflict && md.body() == fdoc.body(), "seed {seed}"),
        }
    }
}

#[test]
fn commutative_where_declared() {
    let mut checked_bodies = 0;
    for seed in 0..CASES {
        let mut r = Rng::new(seed);
        let (b, f, s) = gen_case(&mut r);
        let (fs, sf) = (run(&b, &f, &s), run(&b, &s, &f));
        let (x, y) = (fm(&fs.document), fm(&sf.document));
        let fields = |m: &Merged| -> BTreeSet<String> {
            m.conflicts.iter().filter_map(|c| c.field.clone()).collect()
        };
        assert_eq!(fields(&fs), fields(&sf), "seed {seed}: conflicting fields");
        let facts = facts();
        for key in KEYS {
            if fields(&fs).contains(*key) {
                continue;
            }
            match facts.strategy(key).unwrap() {
                MergeStrategy::Union => {
                    let set = |v: Option<&Value>| -> Vec<String> {
                        let mut out: Vec<String> = match v {
                            Some(Value::List(l)) => l.iter().map(Value::to_json).collect(),
                            Some(other) => vec![other.to_json()],
                            None => vec![],
                        };
                        out.sort();
                        out
                    };
                    assert_eq!(set(x.get(key)), set(y.get(key)), "seed {seed}: {key}");
                }
                _ => {
                    let same = match (x.get(key), y.get(key)) {
                        (Some(p), Some(q)) => p == q || compare(p, q) == Some(Ordering::Equal),
                        (p, q) => p == q,
                    };
                    assert!(same, "seed {seed}: {key}");
                }
            }
        }
        // Bodies merged by diff3 (not append-append) commute.
        let bb = Document::parse(b.clone(), RecordFormat::Markdown)
            .body()
            .to_owned();
        let (fb, sb) = (
            Document::parse(f.clone(), RecordFormat::Markdown)
                .body()
                .to_owned(),
            Document::parse(s.clone(), RecordFormat::Markdown)
                .body()
                .to_owned(),
        );
        let append_append =
            fb.starts_with(&bb) && sb.starts_with(&bb) && fb != bb && sb != bb && fb != sb;
        if !append_append {
            assert_eq!(
                merge_body(&bb, &fb, &sb),
                merge_body(&bb, &sb, &fb),
                "seed {seed}"
            );
            checked_bodies += 1;
        }
    }
    assert!(checked_bodies > CASES / 2);
}

/// Dump generated cases with the core's results for the spec's executable model
/// (`scripts/diff-merge-model.py`). Local only:
/// `cargo test -p mdbn-core --test merge_properties dump_cases -- --ignored`.
#[test]
#[ignore]
#[allow(clippy::disallowed_methods)]
fn dump_cases() {
    let mut out = String::new();
    for seed in 0..20_000u64 {
        let mut r = Rng::new(seed);
        let (b, f, s) = gen_case(&mut r);
        let m = run(&b, &f, &s);
        let mut o = Map::new();
        o.insert("seed", Value::int(seed as i64));
        o.insert("base", Value::string(b));
        o.insert("first", Value::string(f));
        o.insert("second", Value::string(s));
        o.insert("document", Value::string(m.document));
        o.insert(
            "conflicts",
            Value::List(
                m.conflicts
                    .iter()
                    .map(|c| {
                        let mut x = Map::new();
                        x.insert("kind", Value::string(c.kind.as_str()));
                        if let Some(f) = &c.field {
                            x.insert("field", Value::string(f.clone()));
                        }
                        Value::Map(x)
                    })
                    .collect(),
            ),
        );
        out.push_str(&Value::Map(o).to_json());
        out.push('\n');
    }
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../target/merge-cases.jsonl"
    );
    std::fs::write(path, out).unwrap();
    println!("wrote {path}");
}
