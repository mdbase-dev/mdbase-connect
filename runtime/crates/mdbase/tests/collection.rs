//! The public API against a real folder.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::path::PathBuf;

use mdbase::{
    ChangeKind, Collection, Create, Delete, Error, InitOptions, Order, Query, Rename, Update,
};
use serde_json::json;

fn dir(tag: &str) -> PathBuf {
    let p =
        PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&p);
    p
}

const TASK_TYPE: &str = r#"---
kind: mdbase.type
name: task
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [title, status]
    properties:
      title: { type: string, minLength: 1 }
      status: { type: string, enum: [open, done] }
      due: { type: string, format: date }
      tags: { type: array, items: { type: string } }
---
"#;

fn init(tag: &str) -> (PathBuf, Collection) {
    let root = dir(tag);
    let col = Collection::init(
        &root,
        InitOptions {
            name: Some("Test".into()),
            timezone: None,
        },
    )
    .unwrap();
    std::fs::create_dir_all(root.join("_types")).unwrap();
    std::fs::write(root.join("_types/task.md"), TASK_TYPE).unwrap();
    col.rescan().unwrap();
    (root, col)
}

#[test]
fn init_open_and_not_a_collection() {
    let root = dir("init");
    let e = Collection::open(&root).unwrap_err();
    assert!(matches!(e, Error::NotACollection { .. }), "{e}");
    assert!(e.to_string().contains("Collection::init"));
    let col = Collection::init(&root, InitOptions::default()).unwrap();
    assert!(root.join("mdbase.yaml").is_file());
    assert!(root.join(".mdbase/host.lock").is_file());
    assert!(root.join(".mdbase/library/index.sqlite").is_file());
    drop(col);
    let col = Collection::open(&root).unwrap();
    assert_eq!(col.types(), Vec::<String>::new());
}

#[test]
fn crud_query_validate() {
    let (root, col) = init("crud");
    assert_eq!(col.types(), vec!["task".to_string()]);

    let a = col
        .create(
            Create::at("tasks/a.md")
                .field("type", "task")
                .field("title", "Write docs")
                .field("status", "open")
                .field("tags", json!(["docs"]))
                .body("Body A.\n"),
        )
        .unwrap();
    assert_eq!(a.path, "tasks/a.md");
    assert_eq!(a.types, vec!["task".to_string()]);
    assert_eq!(a.get("status"), Some(&json!("open")));
    let text = std::fs::read_to_string(root.join("tasks/a.md")).unwrap();
    assert!(
        text.starts_with("---\ntype: task\ntitle: Write docs\n"),
        "field order is kept: {text}"
    );
    assert!(text.ends_with("Body A.\n"));

    let b = col
        .create(
            Create::at("tasks/b.md")
                .frontmatter(json!({"type": "task", "title": "B", "status": "done"})),
        )
        .unwrap();

    // Query with CEL, ordering and body.
    let page = col
        .query(
            Query::of_type("task")
                .filter("status == 'open'")
                .with_body(),
        )
        .unwrap();
    assert_eq!(page.records.len(), 1);
    assert_eq!(page.records[0].id, a.id);
    assert_eq!(page.records[0].body.as_deref(), Some("Body A.\n"));
    let all = col
        .query(Query::of_type("task").order_by("title", Order::Desc))
        .unwrap();
    assert_eq!(
        all.records
            .iter()
            .map(|r| r.path.as_str())
            .collect::<Vec<_>>(),
        ["tasks/a.md", "tasks/b.md"]
    );
    let e = col.query(Query::from_json(json!({"typo": 1}))).unwrap_err();
    assert!(
        matches!(e, Error::Query { .. } | Error::Rejected { .. }),
        "{e}"
    );

    // Update with a revision guard, then a stale guard.
    let a2 = col
        .update(Update::at(&a).set("status", "done").if_revision(a.revision))
        .unwrap();
    assert_eq!(a2.get("status"), Some(&json!("done")));
    assert_ne!(a2.revision, a.revision);
    let e = col
        .update(
            Update::at("tasks/a.md")
                .set("status", "open")
                .if_revision(a.revision),
        )
        .unwrap_err();
    assert!(matches!(e, Error::Conflict { .. }), "{e}");
    assert!(e.help().contains("Read it again"), "{e}");

    // Invalid record is rejected with issues.
    let e = col
        .create(
            Create::at("tasks/c.md")
                .field("type", "task")
                .field("title", ""),
        )
        .unwrap_err();
    match &e {
        Error::Rejected { code, message, .. } => {
            assert_eq!(code, "invalid_record");
            assert!(!message.is_empty());
        }
        other => panic!("{other}"),
    }
    assert!(!root.join("tasks/c.md").exists());

    // Validate reports outside-written bad files.
    std::fs::write(
        root.join("tasks/bad.md"),
        "---\ntype: task\ntitle: 3\n---\n",
    )
    .unwrap();
    col.rescan().unwrap();
    let report = col.validate().unwrap();
    assert_eq!(report.len(), 1, "{report:?}");
    assert_eq!(report[0].0, "tasks/bad.md");
    assert!(col.validate_one("tasks/a.md").unwrap().is_empty());

    // Rename, delete, not found.
    let moved = col.rename("tasks/b.md", "done/b.md").unwrap();
    assert_eq!(moved.id, b.id);
    assert!(root.join("done/b.md").is_file() && !root.join("tasks/b.md").exists());
    col.delete("done/b.md").unwrap();
    assert!(!root.join("done/b.md").exists());
    assert!(col.get("done/b.md").unwrap().is_none());
    let e = col.delete("nope.md").unwrap_err();
    assert!(matches!(e, Error::NotFound { .. }), "{e}");

    // Batch is atomic: the invalid op fails the valid one.
    let e = col
        .batch([
            Create::at("tasks/d.md")
                .field("type", "task")
                .field("title", "D")
                .field("status", "open")
                .into(),
            Create::at("tasks/e.md")
                .field("type", "task")
                .field("title", "")
                .into(),
        ])
        .unwrap_err();
    assert!(matches!(e, Error::Rejected { .. }));
    assert!(!root.join("tasks/d.md").exists());
    let made = col
        .batch([
            Create::at("tasks/d.md")
                .field("type", "task")
                .field("title", "D")
                .field("status", "open")
                .into(),
            Delete::at("tasks/a.md").into(),
            Rename::new("tasks/bad.md", "tasks/bad2.md").into(),
        ])
        .unwrap();
    assert_eq!(made.len(), 2);
    assert!(root.join("tasks/d.md").is_file() && !root.join("tasks/a.md").exists());

    // Changes feed: `None` gives the current cursor; later writes show up after it.
    let start = col.changes(None).unwrap();
    assert!(start.changes.is_empty());
    col.create(
        Create::at("tasks/f.md")
            .field("type", "task")
            .field("title", "F")
            .field("status", "open"),
    )
    .unwrap();
    let ch = col.changes(Some(&start.cursor)).unwrap();
    // One entry per version (the commit and its publish both count).
    assert!(!ch.changes.is_empty());
    assert!(
        ch.changes
            .iter()
            .all(|c| c.path == "tasks/f.md" && c.kind == ChangeKind::Put),
        "{ch:?}"
    );
    assert!(col.changes(Some(&ch.cursor)).unwrap().changes.is_empty());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn outside_edits_and_links() {
    let (root, col) = init("outside");
    col.create(
        Create::at("notes/a.md")
            .field("title", "A")
            .body("See [[b]].\n"),
    )
    .unwrap();
    std::fs::create_dir_all(root.join("notes")).unwrap();
    std::fs::write(
        root.join("notes/b.md"),
        "---\ntitle: B\n---\nBack to [[a]].\n",
    )
    .unwrap();
    col.rescan().unwrap();
    let b = col
        .get("notes/b.md")
        .unwrap()
        .expect("outside file is ingested");
    assert_eq!(b.get("title"), Some(&json!("B")));
    let links = col.links("notes/a.md").unwrap();
    assert_eq!(links.outgoing.len(), 1);
    assert_eq!(links.outgoing[0].target, "b");
    assert_eq!(links.outgoing[0].resolved, Some(b.id));
    assert_eq!(links.backlinks, vec![b.id]);
    // Delete outside: lands after the recheck timer.
    std::fs::remove_file(root.join("notes/b.md")).unwrap();
    col.rescan().unwrap();
    assert!(col.settle(5_000).unwrap());
    assert!(col.get("notes/b.md").unwrap().is_none());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn second_host_is_refused() {
    let (root, col) = init("hosted");
    let e = Collection::open(&root).unwrap_err();
    match &e {
        Error::AlreadyHosted { host, .. } => {
            assert_eq!(*host, Some(mdbn_local_host::HostKind::Library))
        }
        other => panic!("{other}"),
    }
    drop(col);
    // A foreign descriptor without a lock holder is still "hosted" unless taken over.
    std::fs::write(
        root.join(".mdbase/host.json"),
        r#"{"host":"obsidian","since_ms":1,"heartbeat_ms":1}"#,
    )
    .unwrap();
    let e = Collection::open(&root).unwrap_err();
    match &e {
        Error::AlreadyHosted { host, stale, .. } => {
            assert_eq!(*host, Some(mdbn_local_host::HostKind::Obsidian));
            assert!(*stale);
            assert!(e.help().contains("take_over"));
        }
        other => panic!("{other}"),
    }
    let col = Collection::builder(&root).take_over(true).open().unwrap();
    drop(col);
    // A descriptor that exists but cannot be read counts as "hosted" too.
    std::fs::write(root.join(".mdbase/host.json"), "{garbage").unwrap();
    let e = Collection::open(&root).unwrap_err();
    assert!(matches!(e, Error::AlreadyHosted { host: None, .. }), "{e}");
    assert!(e.help().contains("take_over"));
    let col = Collection::builder(&root).take_over(true).open().unwrap();
    drop(col);
    let _ = std::fs::remove_dir_all(&root);
}
