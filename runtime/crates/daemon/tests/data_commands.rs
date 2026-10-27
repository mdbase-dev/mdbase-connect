//! `mdbase read`, `query`, `validate` and `types` against a real folder, in process.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use mdbn_daemon::registry::{Entry, Origin, Registry, SyncMode};
use serde_json::{Value, json};

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
---
"#;

struct Fixture {
    root: PathBuf,
    state: PathBuf,
}

fn fixture(tag: &str) -> Fixture {
    let base = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
        .join(format!("data-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let root = base.join("col");
    std::fs::create_dir_all(root.join("_types")).unwrap();
    std::fs::create_dir_all(root.join("tasks")).unwrap();
    std::fs::write(
        root.join("mdbase.yaml"),
        "spec_version: \"0.3.0\"\nname: Test\n",
    )
    .unwrap();
    std::fs::write(root.join("_types/task.md"), TASK_TYPE).unwrap();
    let record = |name: &str, title: &str, status: &str, body: &str| {
        let text = format!("---\ntype: task\ntitle: \"{title}\"\nstatus: {status}\n---\n{body}");
        std::fs::write(root.join("tasks").join(name), text).unwrap();
    };
    record("a.md", "Write docs", "open", "Body A.\n");
    record("b.md", "Ship", "done", "");
    record("bad.md", "", "maybe", "");
    Fixture {
        root,
        state: base.join("state"),
    }
}

impl Fixture {
    fn run(&self, args: &[&str]) -> Output {
        self.run_with_stdin(args, "")
    }

    fn run_with_stdin(&self, args: &[&str], stdin: &str) -> Output {
        let mut child = Command::new(env!("CARGO_BIN_EXE_mdbase"))
            .arg("--state-dir")
            .arg(&self.state)
            .args(args)
            .arg("-C")
            .arg(&self.root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(stdin.as_bytes())
            .unwrap();
        child.wait_with_output().unwrap()
    }

    fn json(&self, args: &[&str]) -> (i32, Value) {
        let mut all = vec!["--json"];
        all.extend_from_slice(args);
        let out = self.run(&all);
        let v = serde_json::from_slice(&out.stdout)
            .unwrap_or_else(|e| panic!("{e}: {}", String::from_utf8_lossy(&out.stdout)));
        (out.status.code().unwrap(), v)
    }
}

fn stdout(out: &Output) -> String {
    String::from_utf8(out.stdout.clone()).unwrap()
}

fn paths(v: &Value) -> Vec<&str> {
    v["records"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["path"].as_str().unwrap())
        .collect()
}

#[test]
fn read_prints_the_file_or_the_record() {
    let f = fixture("read");
    let out = f.run(&["read", "tasks/a.md"]);
    assert!(out.status.success());
    assert_eq!(
        stdout(&out),
        "---\ntype: task\ntitle: \"Write docs\"\nstatus: open\n---\nBody A.\n"
    );

    let (code, v) = f.json(&["read", "tasks/a.md"]);
    assert_eq!(code, 0);
    assert_eq!(v["path"], "tasks/a.md");
    assert_eq!(v["types"], json!(["task"]));
    assert_eq!(v["frontmatter"]["title"], "Write docs");
    assert_eq!(v["body"], "Body A.\n");
    assert_eq!(v["id"].as_str().unwrap().len(), 36);

    let (code, v) = f.json(&["read", "tasks/missing.md"]);
    assert_eq!(code, 1);
    assert!(v["error"]["code"].is_string(), "{v}");
}

#[test]
fn query_filters_orders_and_pages() {
    let f = fixture("query");
    let out = f.run(&["query", "--types", "task", "--where", "status == \"open\""]);
    assert!(out.status.success());
    assert_eq!(stdout(&out), "tasks/a.md\n");

    let (_, v) = f.json(&["query", "--order-by=-title"]);
    assert_eq!(paths(&v), ["tasks/a.md", "tasks/b.md", "tasks/bad.md"]);

    let out = f.run(&[
        "query",
        "--order-by",
        "title",
        "--limit",
        "1",
        "--offset",
        "1",
    ]);
    assert_eq!(stdout(&out), "tasks/b.md\n");
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("--offset 2"),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );

    let out = f.run_with_stdin(
        &["--json", "query", "--request", "-"],
        r#"{"where": "status == \"done\""}"#,
    );
    let v: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(paths(&v), ["tasks/b.md"]);
}

#[test]
fn validate_reports_issues_and_exits_1_on_errors() {
    let f = fixture("validate");
    let out = f.run(&["validate"]);
    assert_eq!(out.status.code(), Some(1));
    let text = stdout(&out);
    assert!(
        text.contains("tasks/bad.md /status: error schema_enum"),
        "{text}"
    );
    assert!(
        text.contains("2 error(s), 0 warning(s) in 1 record(s)"),
        "{text}"
    );

    let (code, v) = f.json(&["validate"]);
    assert_eq!(code, 1);
    assert_eq!(v.as_array().unwrap().len(), 1);
    assert_eq!(v[0]["path"], "tasks/bad.md");
    assert_eq!(v[0]["issues"][0]["severity"], "error");

    let out = f.run(&["validate", "tasks/a.md"]);
    assert!(out.status.success());
    assert_eq!(stdout(&out), "no issues\n");
}

#[test]
fn types_list_and_show() {
    let f = fixture("types");
    let out = f.run(&["types", "list"]);
    assert_eq!(stdout(&out), "task\t_types/task.md\n");

    let (code, v) = f.json(&["types", "show", "task"]);
    assert_eq!(code, 0);
    assert_eq!(v["name"], "task");
    assert_eq!(v["definition"]["kind"], "mdbase.type");

    let (code, v) = f.json(&["types", "show", "nope"]);
    assert_eq!(code, 1);
    assert_eq!(v["error"]["code"], "not_found");
}

#[test]
fn refuses_folders_it_must_not_open() {
    let f = fixture("refuse");

    // Not a collection.
    let plain = f.root.join("tasks");
    let out = Command::new(env!("CARGO_BIN_EXE_mdbase"))
        .args(["--json", "--state-dir"])
        .arg(&f.state)
        .args(["query", "-C"])
        .arg(&plain)
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    let v: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["error"]["reason"], "not_a_collection");

    // Open in another host.
    let held = mdbn_local_host::open_folder(
        &f.root,
        &mdbn_local_host::FolderOptions {
            state_dir: None,
            desktop: false,
            timezone: None,
            take_over: false,
            client: ("test".into(), "0".into()),
        },
    )
    .unwrap();
    let (code, v) = f.json(&["query"]);
    assert_eq!(code, 1);
    assert_eq!(v["error"]["reason"], "already_hosted", "{v}");
    drop(held);

    // Registered with this profile's daemon: never opened in process.
    register(&f.state, &f.root);
    let (code, v) = f.json(&["query"]);
    assert_eq!(code, 1);
    assert_eq!(v["error"]["reason"], "served_by_daemon", "{v}");
}

fn register(state: &Path, root: &Path) {
    std::fs::create_dir_all(state).unwrap();
    let mut registry = Registry::default();
    registry
        .add(Entry {
            id: "0193a3c4-0000-7000-8000-000000000001".into(),
            name: "Test".into(),
            description: None,
            root: std::fs::canonicalize(root).unwrap(),
            replica_id: "0193a3c4-0000-7000-8000-000000000002".into(),
            mode: SyncMode::Local,
            origin: Origin::Adopted,
            added_at_ms: 0,
            paused: false,
            ever_e2e: false,
            owner_account: None,
            device: None,
        })
        .unwrap();
    registry.save(&state.join("collections.json")).unwrap();
}
