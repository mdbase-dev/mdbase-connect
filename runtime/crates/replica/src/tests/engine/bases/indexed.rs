use super::*;
use crate::replica::{BasesExecutionPolicies, BasesExecutionResult, BasesViewSelection};
use crate::store_query::{QueryProjectionRow, RawField};
use mdbn_core::doc::Document;
use mdbn_core::views::bases::{
    BasesDisplayCell, DateGroupMode, NullOrder, OrderingCapture, StringOrder, WorkBudget,
    capture_source_tags,
};
use std::collections::BTreeMap;
mod publication;
mod rpc;
mod scaling;
mod starter_filter;
mod store;
mod windows;
use store::ProjectionStore;
fn policies() -> BasesExecutionPolicies {
    BasesExecutionPolicies {
        ordering: OrderingCapture {
            nulls: NullOrder::Last,
            strings: StringOrder::Utf16,
        },
        date_groups: DateGroupMode::Unavailable,
        inventory_ties: true,
    }
}
fn selection(source: &str, index: u32) -> BasesViewSelection {
    BasesViewSelection {
        record: B16([11; 16]),
        revision: mdbn_wire::hash::sha256(source.as_bytes()),
        index,
    }
}
fn pump(r: &mut Replica<ProjectionStore>, log: &mut FakeLog) {
    use crate::log::LogClient;
    for _ in 0..20 {
        let session = r.bind_authenticated_log(r.log_endpoint(), COL).unwrap();
        for push in log.poll_pushes() {
            r.on_authenticated_log_push(&session, |_| Ok(push)).unwrap();
        }
        for (call, scope) in r.take_authenticated_log_calls(&session).unwrap() {
            let reply = log.call(call.request);
            r.on_authenticated_log_reply(scope, move |_, _| reply)
                .unwrap();
        }
        r.tick();
    }
}
fn projected(svc: &FakeLogService, a: Node) -> Replica<ProjectionStore> {
    let context =
        a.r.query_context
            .clone()
            .expect("real resource-derived R6 context");
    let cfg = a.r.cfg.clone();
    let clock = a.clock.clone();
    let mut log = svc.client(cfg.device_id);
    let inner = a.r.into_store();
    let head = inner.head().unwrap();
    let mut raw = BTreeMap::new();
    let mut maps = BTreeMap::new();
    let mut after = None;
    loop {
        let page = inner
            .records(crate::store::Page { after, limit: 128 })
            .unwrap();
        if page.is_empty() {
            break;
        }
        for row in page {
            after = Some(row.id);
            let doc = Document::parse_at(&row.path, &row.doc);
            maps.insert(row.id, doc.frontmatter().clone());
            raw.insert(
                row.id,
                QueryProjectionRow {
                    id: row.id,
                    path: row.path,
                    source_sha: row.revision,
                    source_bytes: row.doc.len() as u64,
                    fields: Vec::<RawField>::new(),
                    tags: capture_source_tags(&doc, &mut WorkBudget::new()).unwrap(),
                },
            );
        }
    }
    let store = ProjectionStore {
        inner,
        generation: context.generation(),
        head,
        raw: Rc::new(raw),
        maps: Rc::new(maps),
        selected: B16([11; 16]),
        reads: Rc::new(Cell::new(0)),
        pages: Rc::new(Cell::new(0)),
        fail_page: Rc::new(Cell::new(usize::MAX)),
        ready: Rc::new(Cell::new(true)),
        armed: Rc::new(Cell::new(false)),
    };
    let mut r = Replica::open(
        cfg,
        store,
        Box::new(crate::CorePlanner),
        Box::new(crate::seal::KeyringSealer::new(
            COL,
            B16([101; 16]),
            &[0x31; 32],
            &[0x32; 32],
        )),
        Host {
            clock: Box::new(TestClock(clock)),
            entropy: Box::new(crate::crypto::TestEntropy::new(1)),
            zones: Box::new(UtcOnly),
        },
        DeviceSecrets {
            sign_sk: [1; 32],
            kem_sk: [1; 32],
        },
    )
    .unwrap();
    pump(&mut r, &mut log);
    // The test backend carries exact materialized data from the same confirmed
    // resource-derived generation. Authority/keys/head come from normal reopen
    // and authenticated fake log transport, not a constructed admission token.
    r.query_context = Some(context);
    r.collection_setup_capture_fence(None).unwrap();
    r.store().armed.set(true);
    r
}
fn output(result: &BasesExecutionResult) -> serde_json::Value {
    serde_json::json!({"rows":result.rows.iter().map(|row|serde_json::json!({"id":row.record.0,"path":row.path,"sha":row.revision.0,"cells":row.cells.iter().map(|cell|match cell {BasesDisplayCell::Value(value)=>serde_json::json!({"value":serde_json::from_str::<serde_json::Value>(&value.to_plain().to_json()).unwrap()}),BasesDisplayCell::Unavailable {code,detail}=>serde_json::json!({"code":code,"detail":detail})}).collect::<Vec<_>>()})).collect::<Vec<_>>(),"groups":result.groups.iter().map(|group|serde_json::json!({"key":serde_json::from_str::<serde_json::Value>(&group.key.to_plain().to_json()).unwrap(),"rows":group.rows})).collect::<Vec<_>>()})
}
#[test]
fn actual_signed_actor_streams_all_five_unchanged_views_with_exact_residual_cells_and_groups() {
    let expected: serde_json::Value =
        serde_json::from_str(include_str!("../../data/bases-first-slice.json")).unwrap();
    for view in expected["views"].as_array().unwrap() {
        let (svc, mut a, _) = configured();
        let source = expected["sources"]
            .as_array()
            .unwrap()
            .iter()
            .find(|source| source["command"] == view["command"])
            .unwrap()["source"]
            .as_str()
            .unwrap();
        a.create(11, "Views/actual.base", source);
        for (i, record) in expected["records"].as_array().unwrap().iter().enumerate() {
            a.create(
                (i + 1) as u8,
                record["path"].as_str().unwrap(),
                record["source"].as_str().unwrap(),
            );
        }
        settle(&mut [&mut a]);
        a.clock.set(expected["now_ms"].as_u64().unwrap());
        let hints = BTreeMap::from_iter([
            ("due".into(), "date".into()),
            ("scheduled".into(), "date".into()),
        ]);
        let selected = selection(source, view["index"].as_u64().unwrap() as u32);
        let input =
            a.r.capture_bases_execution_inputs(selected, Some(&hints), Some("UTC"))
                .unwrap();
        let baseline =
            a.r.execute_captured_bases_view(input, policies(), &|| false)
                .unwrap();
        let mut r = projected(&svc, a);
        let result = r
            .execute_indexed_bases_view(selected, Some(&hints), Some("UTC"), policies(), &|| false)
            .unwrap();
        assert_eq!(output(&result), output(&baseline), "{}", view["name"]);
        assert_eq!(r.store().reads.get(), 2);
        assert_eq!(r.store().pages.get(), 1);
    }
}
#[test]
fn frontmatter_task_membership_survives_code_and_unknown_body_in_both_executors() {
    for body in [
        "Private `#cppLive` and PR #123\n```js\n#hidden\n```",
        "**#unknown**",
    ] {
        let (svc, mut a, _) = configured();
        let source = "filters: file.hasTag('task')\nviews: [{type: table, order: [file.name, formula.member]}]\nformulas: {member: \"file.hasTag('task')\"}\n";
        a.create(11, "View.base", source);
        a.create(1, "Task.md", &format!("---\ntags: [task]\n---\n{body}"));
        a.create(
            2,
            "Other.md",
            "---\ntags: [other]\n---\nPrivate `#cppLive` PR #123",
        );
        settle(&mut [&mut a]);
        let selected = selection(source, 0);
        let hints = BTreeMap::new();
        let input =
            a.r.capture_bases_execution_inputs(selected, Some(&hints), Some("UTC"))
                .unwrap();
        let baseline =
            a.r.execute_captured_bases_view(input, policies(), &|| false)
                .unwrap();
        assert_eq!(
            baseline
                .rows
                .iter()
                .map(|r| r.path.as_str())
                .collect::<Vec<_>>(),
            vec!["Task.md"]
        );
        let mut r = projected(&svc, a);
        let result = r
            .execute_indexed_bases_view(selected, Some(&hints), Some("UTC"), policies(), &|| false)
            .unwrap();
        assert_eq!(output(&result), output(&baseline));
        assert!(
            result.unavailable_columns.is_empty(),
            "frontmatter also decides display hasTag"
        );
    }
}
// Note text reported in mdbase-connect#1198: a filter that names one tag must not
// depend on how the rest of a rich note parses.
fn run_both(
    mut a: Node,
    svc: &FakeLogService,
    source: &str,
) -> (Result<Vec<String>, String>, Result<Vec<String>, String>) {
    let paths = |result: &BasesExecutionResult| {
        let mut paths: Vec<_> = result.rows.iter().map(|r| r.path.clone()).collect();
        paths.sort();
        paths
    };
    let selected = selection(source, 0);
    let hints = BTreeMap::new();
    let input =
        a.r.capture_bases_execution_inputs(selected, Some(&hints), Some("UTC"))
            .unwrap();
    let captured =
        a.r.execute_captured_bases_view(input, policies(), &|| false)
            .map(|result| paths(&result))
            .map_err(|e| e.to_string());
    let mut r = projected(svc, a);
    let indexed = r
        .execute_indexed_bases_view(selected, Some(&hints), Some("UTC"), policies(), &|| false)
        .map(|result| paths(&result))
        .map_err(|e| e.to_string());
    (captured, indexed)
}
#[test]
fn reported_references_and_url_fragments_keep_an_unrelated_tag_filter_usable() {
    let (svc, mut a, _) = configured();
    let source =
        "filters: file.hasTag('archived') != true\nviews: [{type: table, order: [file.name]}]\n";
    a.create(11, "View.base", source);
    for (id, path, doc) in [
        (
            1,
            "a.md",
            "Server side was verified healthy in #16/#18; ~see~ `this`",
        ),
        (
            2,
            "b.md",
            "Linked #400, #1115, #914/#926, #1403, and the #226\u{2192}#264 caching rollback. **Done**",
        ),
        (
            3,
            "c.md",
            "[docs](https://x.invalid/#overview) https://x.invalid/a#issuecomment-1 *see*",
        ),
        (4, "d.md", "**Bold** [link](target) #personal"),
        (5, "e.md", "[[unclosed #personal"),
        (6, "f.md", "<b>rich</b> $5 **#personal**"),
        (7, "gone.md", "---\ntags: [archived]\n---\nPlain"),
        (8, "gone-body.md", "Body #archived/2025"),
    ] {
        a.create(id, path, doc);
    }
    settle(&mut [&mut a]);
    let want: Vec<String> = ["View.base", "a.md", "b.md", "c.md", "d.md", "e.md", "f.md"]
        .map(String::from)
        .into();
    let (captured, indexed) = run_both(a, &svc, source);
    assert_eq!(captured, Ok(want.clone()));
    assert_eq!(indexed, Ok(want));
}
#[test]
fn a_spelled_tag_in_an_unqualified_position_refuses_rather_than_guessing() {
    // `**#archived**` is a real tag in Obsidian while `*#archived` is not, so
    // neither answer is safe: `!= true` would show one and hide the other.
    for doc in ["**#archived** done", "*#archived done"] {
        let (svc, mut a, _) = configured();
        let source = "filters: file.hasTag('archived') != true\nviews: [{type: table, order: [file.name]}]\n";
        a.create(11, "View.base", source);
        a.create(1, "a.md", doc);
        settle(&mut [&mut a]);
        let (captured, indexed) = run_both(a, &svc, source);
        for result in [captured, indexed] {
            assert!(
                result.unwrap_err().contains("file_tags_not_captured"),
                "{doc}"
            );
        }
    }
}
#[test]
fn undecidable_body_tag_membership_still_refuses_both_executors() {
    let (svc, mut a, _) = configured();
    let source = "filters: file.hasTag('task')\nviews: [{type: table, order: [file.name]}]\n";
    a.create(11, "View.base", source);
    a.create(1, "Task.md", "---\ntags: [other]\n---\n**#task**");
    settle(&mut [&mut a]);
    let selected = selection(source, 0);
    let hints = BTreeMap::new();
    let input =
        a.r.capture_bases_execution_inputs(selected, Some(&hints), Some("UTC"))
            .unwrap();
    let error =
        a.r.execute_captured_bases_view(input, policies(), &|| false)
            .err()
            .unwrap();
    assert!(error.to_string().contains("file_tags_not_captured"));
    let mut r = projected(&svc, a);
    let error = r
        .execute_indexed_bases_view(selected, Some(&hints), Some("UTC"), policies(), &|| false)
        .err()
        .unwrap();
    assert!(error.to_string().contains("file_tags_not_captured"));
}
#[test]
fn stock_projects_groups_whole_lists_in_both_executors_with_deterministic_order() {
    let (svc, mut a, _) = configured();
    let source = include_str!("../../../../../../conformance/views/tasknotes-projects.base");
    a.create(11, "TaskNotes/Views/projects.base", source);
    for (id, name, projects, status, tags) in [
        (1, "single", "[Alpha]", "open", "[task]"),
        (2, "pairA", "[Alpha, Beta]", "open", "[task]"),
        (3, "reverse", "[Beta, Alpha]", "open", "[task]"),
        (4, "pairB", "[Alpha, Beta]", "open", "[task]"),
        (5, "comma", "['Alpha, Beta']", "open", "[task]"),
        (6, "empty", "[]", "open", "[task]"),
        (7, "done", "[Alpha]", "done", "[task]"),
        (8, "archived", "[Alpha]", "open", "[task, archived]"),
    ] {
        a.create(id, &format!("{name}.md"), &format!("---\ntitle: {name}\nstatus: {status}\ntags: {tags}\nprojects: {projects}\n---\nPrivate `#cppLive` PR #123"));
    }
    settle(&mut [&mut a]);
    let selected = selection(source, 0);
    let hints = BTreeMap::new();
    let input =
        a.r.capture_bases_execution_inputs(selected, Some(&hints), Some("UTC"))
            .unwrap();
    let baseline =
        a.r.execute_captured_bases_view(input, policies(), &|| false)
            .unwrap();
    assert_eq!(baseline.rows.len(), 5);
    assert_eq!(
        baseline
            .groups
            .iter()
            .map(
                |g| serde_json::from_str::<serde_json::Value>(&g.key.to_plain().to_json()).unwrap()
            )
            .collect::<Vec<_>>(),
        vec![
            serde_json::json!(["Alpha"]),
            serde_json::json!(["Alpha", "Beta"]),
            serde_json::json!(["Alpha, Beta"]),
            serde_json::json!(["Beta", "Alpha"])
        ]
    );
    assert_eq!(
        baseline.groups[1]
            .rows
            .iter()
            .map(|i| baseline.rows[*i].path.as_str())
            .collect::<Vec<_>>(),
        vec!["pairA.md", "pairB.md"]
    );
    let mut r = projected(&svc, a);
    let result = r
        .execute_indexed_bases_view(selected, Some(&hints), Some("UTC"), policies(), &|| false)
        .unwrap();
    assert_eq!(output(&result), output(&baseline));
}
#[test]
fn stock_projects_groups_links_by_resolved_file_in_both_executors_and_windows() {
    let (svc, mut a, _) = configured();
    let source = include_str!("../../../../../../conformance/views/tasknotes-projects.base");
    a.create(11, "TaskNotes/Views/projects.base", source);
    a.create(20, "Projects/Alpha.md", "---\ntitle: Alpha\n---\n");
    a.create(21, "Projects/Beta.md", "---\ntitle: Beta\n---\n");
    for (id, name, projects) in [
        (1, "bare", "['[[Alpha]]']"),
        (2, "aliased", "['[[Projects/Alpha|A]]']"),
        (3, "heading", "['[[alpha#Notes]]']"),
        (4, "scalar", "'[[Alpha]]'"),
        (5, "pair", "['[[Alpha]]', '[[Beta]]']"),
        (6, "reverse", "['[[Beta]]', '[[Alpha]]']"),
        (7, "broken", "['[[Missing]]']"),
        (8, "brokenAlias", "['[[Missing|gone]]']"),
        (9, "brokenHeading", "['[[Missing#later]]']"),
        (10, "text", "plain"),
    ] {
        a.create(
            id,
            &format!("{name}.md"),
            &format!("---\ntitle: {name}\nstatus: open\ntags: [task]\nprojects: {projects}\n---\n"),
        );
    }
    settle(&mut [&mut a]);
    let selected = selection(source, 0);
    let hints = BTreeMap::new();
    let input =
        a.r.capture_bases_execution_inputs(selected, Some(&hints), Some("UTC"))
            .unwrap();
    let baseline =
        a.r.execute_captured_bases_view(input, policies(), &|| false)
            .unwrap();
    let mut groups = baseline
        .groups
        .iter()
        .map(|group| {
            let mut paths = group
                .rows
                .iter()
                .map(|i| baseline.rows[*i].path.as_str())
                .collect::<Vec<_>>();
            paths.sort_unstable();
            paths
        })
        .collect::<Vec<_>>();
    groups.sort();
    assert_eq!(
        groups,
        vec![
            vec!["aliased.md", "bare.md", "heading.md", "scalar.md"],
            vec!["broken.md", "brokenAlias.md"],
            vec!["brokenHeading.md"],
            vec!["pair.md"],
            vec!["reverse.md"],
            vec!["text.md"],
        ]
    );
    let mut r = projected(&svc, a);
    let full = r
        .execute_indexed_bases_view(selected, Some(&hints), Some("UTC"), policies(), &|| false)
        .unwrap();
    assert_eq!(output(&full), output(&baseline));
    let window = r
        .execute_indexed_bases_window_view(
            selected,
            Some(&hints),
            Some("UTC"),
            crate::replica::BasesExecutionWindow {
                offset: 1,
                limit: 3,
            },
            &|| false,
        )
        .unwrap();
    assert_eq!(window.rows.len(), 3);
    assert_eq!(window.rows[0].path, full.rows[1].path);
}
#[test]
fn an_unconfirmed_target_already_resolves_links_to_it() {
    let (_, mut a, _) = configured();
    let source = "filters: projects.isEmpty() == false\nviews: [{type: table, order: [projects], groupBy: {property: projects}}]\n";
    a.create(11, "View.base", source);
    a.create(1, "one.md", "---\nprojects: '[[Later]]'\n---\n");
    a.create(2, "two.md", "---\nprojects: '[[sub/Later]]'\n---\n");
    settle(&mut [&mut a]);
    let groups = |a: &mut Node| {
        let input =
            a.r.capture_bases_execution_inputs(
                selection(source, 0),
                Some(&BTreeMap::new()),
                Some("UTC"),
            )
            .unwrap();
        a.r.execute_captured_bases_view(input, policies(), &|| false)
            .unwrap()
            .groups
            .len()
    };
    assert_eq!(groups(&mut a), 2);
    a.create(3, "sub/Later.md", "---\ntitle: Later\n---\n");
    assert_eq!(groups(&mut a), 1);
}
#[test]
fn unsupported_backend_or_dynamic_requirements_refuse_without_source_inventory() {
    let (_, mut a, source) = configured();
    a.create(11, "Views/task.base", &source);
    settle(&mut [&mut a]);
    let error =
        a.r.execute_indexed_bases_view(
            selection(&source, 0),
            Some(&BTreeMap::new()),
            Some("UTC"),
            policies(),
            &|| false,
        )
        .err()
        .unwrap();
    assert_eq!(error.code(), Some(ErrorCode::InvalidRequest));
    assert!(
        error
            .to_string()
            .contains("view_raw_projection_unavailable")
    );
    let (svc, mut a, _) = configured();
    let source = "views:\n  - type: table\n    name: Dynamic\n    filters: 'note[file.name]'\n    order: [file.name]\n";
    a.create(11, "Views/dynamic.base", source);
    settle(&mut [&mut a]);
    let mut r = projected(&svc, a);
    let error = r
        .execute_indexed_bases_view(
            selection(source, 0),
            Some(&BTreeMap::new()),
            Some("UTC"),
            policies(),
            &|| false,
        )
        .err()
        .unwrap();
    assert_eq!(error.code(), Some(ErrorCode::InvalidRequest));
    assert!(
        error
            .to_string()
            .contains("raw_property_projection_unqualified")
    );
    assert_eq!(r.store().pages.get(), 0);
    assert_eq!(r.store().reads.get(), 1);
}
