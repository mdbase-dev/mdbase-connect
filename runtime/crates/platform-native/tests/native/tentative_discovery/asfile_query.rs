//! Actual native SQLite/TentativeStore ordinary-query projection regression.
//! Fake CP/log/signing identity is the existing isolated test fixture, not LAB,
//! browser/OPFS/custody or a claim that changed source is immutable.
use super::*;
use w::client::Include;
use w::common::Value;

#[path = "asfile_query/ambiguity.rs"]
mod ambiguity;
#[path = "asfile_query/boundaries.rs"]
mod boundaries;
#[path = "asfile_query/retention.rs"]
mod retention;
#[path = "asfile_query/sdk_links.rs"]
mod sdk_links;

fn selection(name: &str, expr: &str) -> Value {
    Value::Map(vec![
        ("name".into(), Value::Text(name.into())),
        ("expr".into(), Value::Text(expr.into())),
    ])
}

#[test]
fn original_native_query_keeps_raw_mapped_links_aligned_with_asfile_targets() {
    let path = scratch("native-query-asfile-raw-target-alignment").join("state.db");
    let (mut app, session, _index) = open(&path, Rc::new(Probe::default()));
    let service = log();
    settle(&mut app, &service);
    let raw = [
        "[[People/Alex|Visible alias]]",
        "[[Missing]]",
        "[[../People/Sam]]",
        "[[Alex]]",
        "https://example.invalid/external",
    ];
    submit(
        &mut app,
        session,
        vec![
            create(B16([21; 16]), "People/Alex.md", "---\nname: Alex\n---\n"),
            create(
                B16([22; 16]),
                "Other/Alex.md",
                "---\nname: Other Alex\n---\n",
            ),
            create(B16([23; 16]), "People/Sam.md", "---\nname: Sam\n---\n"),
            create(
                B16([24; 16]),
                "Tasks/Sprint.md",
                "---\nCrew Links:\n  - '[[People/Alex|Visible alias]]'\n  - '[[Missing]]'\n  - '[[../People/Sam]]'\n  - '[[Alex]]'\n  - 'https://example.invalid/external'\n---\nOriginal task\n",
            ),
        ],
        31,
    );
    settle(&mut app, &service);
    let query = Value::Map(vec![
        (
            "where".into(),
            Value::Text("file.path == 'Tasks/Sprint.md'".into()),
        ),
        ("limit".into(), Value::Int(1)),
        (
            "select".into(),
            Value::List(vec![
                selection("raw", "raw['Crew Links']"),
                selection(
                    "resolved",
                    "raw['Crew Links'].map(l, l.asFile() == null ? null : l.asFile().file.path)",
                ),
            ]),
        ),
    ]);
    let result = app
        .query(
            session,
            query,
            Include {
                effective: None,
                body: None,
                document: None,
                diagnostics: None,
            },
        )
        .unwrap();
    assert!(result.complete);
    assert_eq!(result.records.len(), 1);
    assert_eq!(result.records[0].path, "Tasks/Sprint.md");
    assert_eq!(result.columns, Some(vec!["raw".into(), "resolved".into()]));
    let values = result.records[0]
        .values
        .as_ref()
        .expect("native selection values");
    assert_eq!(
        values.get("raw"),
        Some(&Value::List(
            raw.iter()
                .map(|value| Value::Text((*value).into()))
                .collect()
        ))
    );
    assert_eq!(
        values.get("resolved"),
        Some(&Value::List(vec![
            Value::Text("People/Alex.md".into()),
            Value::Null,
            Value::Text("People/Sam.md".into()),
            // Canonical simple-name resolution uses folder/depth/lexical order,
            // not an invented ambiguity when two different paths share a stem.
            Value::Text("Other/Alex.md".into()),
            Value::Null,
        ]))
    );
    assert_eq!(app.store().pending_count().unwrap(), 0);
}

fn include() -> Include {
    Include {
        effective: None,
        body: None,
        document: None,
        diagnostics: None,
    }
}

#[test]
fn native_asfile_targets_share_one_budget_and_never_publish_null_prefix() {
    let path = scratch("native-query-asfile-target-reread-budget").join("state.db");
    let (mut app, session, _index) = open(&path, Rc::new(Probe::default()));
    let service = log();
    settle(&mut app, &service);
    let source = format!(
        "---\nCrew Links:\n{}---\nTask\n",
        "  - '[[People/Alex]]'\n".repeat(600)
    );
    let large = format!("---\nname: Large\n---\n{}", "x".repeat(400_000));
    submit(
        &mut app,
        session,
        vec![
            create(B16([21; 16]), "Tasks/First.md", &source),
            create(B16([22; 16]), "People/Alex.md", "---\nname: Alex\n---\n"),
            create(
                B16([23; 16]),
                "Other/Second.md",
                "---\nCrew Links: ['[[People/A]]', '[[People/B]]', '[[People/C]]']\n---\nTask\n",
            ),
        ],
        41,
    );
    // One large target per mutation, within the per-entry bound.
    for (n, name) in [(24, "A"), (25, "B"), (26, "C")] {
        let id = B16([n; 16]);
        submit(
            &mut app,
            session,
            vec![create(id, &format!("People/{name}.md"), &large)],
            n,
        );
    }
    settle(&mut app, &service);
    let query = |folder: &str| {
        Value::Map(vec![
            (
                "where".into(),
                Value::Text(format!("file.inFolder('{folder}')")),
            ),
            (
                "select".into(),
                Value::List(vec![selection(
                    "resolved",
                    "raw['Crew Links'].map(l, l.asFile().file.path)",
                )]),
            ),
            ("limit".into(), Value::Int(1)),
        ])
    };
    // 600 rereads of ONE target are admitted once per invocation.
    let result = app.query(session, query("Tasks"), include()).unwrap();
    assert_eq!(
        result.records[0].values.as_ref().unwrap().get("resolved"),
        Some(&Value::List(vec![
            Value::Text("People/Alex.md".into());
            600
        ]))
    );
    // Distinct targets still cost the same invocation. Native Core's
    // infallible lookup must not disguise exhaustion as null.
    let error = app.query(session, query("Other"), include()).unwrap_err();
    assert_eq!(error.code(), Some(ErrorCode::TooLarge));
    assert_eq!(
        error.problem().reason.as_deref(),
        Some("query_budget_exceeded")
    );
    assert_eq!(app.store().pending_count().unwrap(), 0);
}

#[test]
fn native_select_scalar_null_diagnostics_and_selection_sort_use_canonical_evaluator() {
    let path = scratch("native-query-select-scalar-sort").join("state.db");
    let (mut app, session, _index) = open(&path, Rc::new(Probe::default()));
    let service = log();
    settle(&mut app, &service);
    submit(
        &mut app,
        session,
        vec![
            create(
                B16([21; 16]),
                "Tasks/Z.md",
                "---\nAssignee: '[[People/Alex|Display alias]]'\nrank: 2\n---\n",
            ),
            create(
                B16([22; 16]),
                "Tasks/A.md",
                "---\nAssignee: '[[Missing]]'\nrank: 1\n---\n",
            ),
            create(B16([23; 16]), "People/Alex.md", "---\nname: Alex\n---\n"),
        ],
        42,
    );
    settle(&mut app, &service);
    let query = Value::Map(vec![
        ("where".into(), Value::Text("file.folder == 'Tasks'".into())),
        (
            "select".into(),
            Value::List(vec![
                selection("raw", "raw.Assignee"),
                selection(
                    "target",
                    "raw.Assignee.asFile() == null ? null : raw.Assignee.asFile().file.path",
                ),
                selection("ranked", "-raw.rank"),
                selection("bad", "1 / 0"),
            ]),
        ),
        (
            "order_by".into(),
            Value::List(vec![Value::Map(vec![(
                "field".into(),
                Value::Text("ranked".into()),
            )])]),
        ),
    ]);
    let result = app.query(session, query, include()).unwrap();
    assert_eq!(
        result.columns,
        Some(vec![
            "raw".into(),
            "target".into(),
            "ranked".into(),
            "bad".into()
        ])
    );
    assert_eq!(
        result
            .records
            .iter()
            .map(|r| r.path.as_str())
            .collect::<Vec<_>>(),
        vec!["Tasks/Z.md", "Tasks/A.md"]
    );
    let first = result.records[0].values.as_ref().unwrap();
    assert_eq!(
        first.get("raw"),
        Some(&Value::Text("[[People/Alex|Display alias]]".into()))
    );
    assert_eq!(
        first.get("target"),
        Some(&Value::Text("People/Alex.md".into()))
    );
    assert_eq!(first.get("bad"), Some(&Value::Null));
    assert_eq!(
        result.records[1].values.as_ref().unwrap().get("target"),
        Some(&Value::Null)
    );
    assert!(
        result
            .diagnostics
            .as_ref()
            .unwrap()
            .iter()
            .any(|issue| issue.code == "expression_evaluation_error")
    );
}
