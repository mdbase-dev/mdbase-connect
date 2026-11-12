//! `select` and the CEL link helpers on the Worker's own store composition.
//!
//! They run on the replica's bounded projected-query path, which reads source
//! through `Store::query_record_sizes_at` and `Store::hydrate_query_at`. The Worker
//! serves from `LogCache` over DO SQLite; here the same `LogCache` runs over
//! in-memory SQLite, with `MemStore` as the control.
use std::cell::RefCell;
use std::rc::Rc;

use mdbn_store_file::{LogCache, SqlStoreLimits};
use mdbn_wire::client::QueryResult;

use super::*;
use crate::migration_action_ledger::tests::Sqlite;

const DOCS: [(u64, &str, &str); 3] = [
    (1, "projects/Alpha.md", "---\ntitle: Alpha\n---\n"),
    (
        2,
        "tasks/website.md",
        "---\ntitle: Website\nproject: \"[[projects/Alpha]]\"\n---\n",
    ),
    (3, "notes/plain.md", "---\ntitle: Plain\n---\n"),
];

/// A query's members and the paths it must return.
type Case = (Vec<(Cbor, Cbor)>, Vec<&'static str>);

fn cases() -> Vec<Case> {
    let t = |s: &str| Cbor::Text(s.into());
    vec![
        (
            vec![(t("select"), Cbor::Array(vec![t("title")]))],
            vec!["projects/Alpha.md", "tasks/website.md", "notes/plain.md"],
        ),
        (
            vec![(t("where"), t("file.hasLink(link(\"[[projects/Alpha]]\"))"))],
            vec!["tasks/website.md"],
        ),
        (
            vec![(
                t("where"),
                t("project != null && project.asFile() != null \
                   && project.asFile().title == \"Alpha\""),
            )],
            vec!["tasks/website.md"],
        ),
    ]
}

fn run_cases<S: Store>(mut h: Hosted<S>) {
    h.pump(false);
    let (s, _) = h.e.hello(Some((GRANT, CLIENT_PK)), &hello());
    for (i, path, doc) in DOCS {
        h.e.frame(s, &submit_doc(i, path, doc));
        h.pump(false);
        assert!(responses(&h.e.poll(), s, i)[0].is_ok(), "{path}");
    }
    let mut problems = Vec::new();
    for (n, (query, want)) in cases().into_iter().enumerate() {
        let id = 100 + n as u64;
        let params = Cbor::Map(vec![(Cbor::Uint(0), Cbor::Map(query))]);
        h.e.frame(s, &request(id, "query", params));
        let out = h.e.poll();
        let answer = out
            .iter()
            .find_map(|o| match o {
                Out::Frame(f, b) if *f == s => {
                    match ClientFrame::from_cbor(&cbor::decode(b).unwrap()).unwrap() {
                        ClientFrame::Response(r) if r.id == id => Some(r),
                        _ => None,
                    }
                }
                _ => None,
            })
            .unwrap_or_else(|| panic!("case {n}: no response in {out:?}"));
        if let Some(p) = answer.problem {
            problems.push(format!(
                "case {n}: {} ({:?}): {}",
                p.code, p.reason, p.message
            ));
            continue;
        }
        let result = QueryResult::from_cbor(&answer.result.unwrap()).unwrap();
        let mut paths: Vec<_> = result.records.iter().map(|r| r.path.as_str()).collect();
        let mut want = want;
        paths.sort_unstable();
        want.sort_unstable();
        assert_eq!(paths, want, "case {n}");
        if n == 0 {
            assert_eq!(result.columns.as_deref(), Some(&["title".to_string()][..]));
            assert!(result.records.iter().all(|r| r.values.is_some()));
        }
    }
    assert!(problems.is_empty(), "{problems:#?}");
}

#[test]
fn select_and_link_helpers_answer_over_the_in_memory_store() {
    run_cases(open(&world()));
}

#[test]
fn select_and_link_helpers_answer_over_the_workers_log_cache() {
    let svc = world();
    let index = Rc::new(RefCell::new(Sqlite::new()));
    let store = LogCache::open(index, SqlStoreLimits::default()).unwrap();
    run_cases(open_store(&svc, store, 2));
}
