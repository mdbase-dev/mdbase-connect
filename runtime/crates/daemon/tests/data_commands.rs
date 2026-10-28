//! `mdbase read`, `query`, `validate` and `types` against a real folder, in process
//! and through a running daemon.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::Duration;

use mdbn_daemon::client::ControlClient;
use mdbn_daemon::control::{CollectionState, CollectionStatus, Method};
use mdbn_daemon::paths::Profile;
use mdbn_daemon::registry::{Entry, Origin, Registry, SyncMode};
use mdbn_daemon::secrets::{self, MemoryStore};
use mdbn_daemon::server;
use serde_json::{Value, json};

#[path = "fixtures/pairing.rs"]
mod pairing;

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
    let base =
        PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("{tag}{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let root = base.join("col");
    collection(&root);
    Fixture {
        root,
        // Short: the daemon's Unix socket lives under it.
        state: base.join("s"),
    }
}

/// A collection with one type and three records, one of them invalid.
fn collection(root: &Path) {
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
    record("b.md", "Ship", "done", "See [[a]].\n");
    record("bad.md", "", "maybe", "");
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

fn stderr(out: &Output) -> String {
    String::from_utf8(out.stderr.clone()).unwrap()
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
    let f = fixture("rd");
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
    let f = fixture("qy");
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
    let f = fixture("vl");
    let out = f.run(&["validate"]);
    assert_eq!(out.status.code(), Some(1));
    let text = stdout(&out);
    assert!(
        text.contains("tasks/bad.md /status: error schema_enum"),
        "{text}"
    );
    assert!(
        text.contains("2 errors, 0 warnings in 1 of 3 records"),
        "{text}"
    );

    let (code, v) = f.json(&["validate"]);
    assert_eq!(code, 1);
    assert_eq!(v.as_array().unwrap().len(), 1);
    assert_eq!(v[0]["path"], "tasks/bad.md");
    assert_eq!(v[0]["issues"][0]["severity"], "error");

    let out = f.run(&["validate", "tasks/a.md"]);
    assert!(out.status.success());
    assert_eq!(stdout(&out), "no issues in 1 record\n");
}

#[test]
fn validate_checks_a_large_collection_in_pages() {
    let f = fixture("vb");
    for n in 0..1500 {
        let text = format!(
            "---\ntype: task\ntitle: \"Task {n}\"\nstatus: open\n---\nSee [[t{}]] and [[a]].\n",
            (n + 1) % 1500
        );
        std::fs::write(f.root.join(format!("tasks/t{n}.md")), text).unwrap();
    }
    let out = f.run(&["validate"]);
    assert_eq!(out.status.code(), Some(1), "{}", stderr(&out));
    let text = stdout(&out);
    assert!(
        text.ends_with("2 errors, 0 warnings in 1 of 1503 records\n"),
        "{text}"
    );
}

#[test]
fn types_list_and_show() {
    let f = fixture("ty");
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
fn writes_apply_and_report() {
    let f = fixture("wr");
    let read = |path: &str| std::fs::read_to_string(f.root.join(path)).unwrap();

    let out = f.run(&[
        "create",
        "--path",
        "tasks/c.md",
        "--type",
        "task",
        "--fields",
        r#"{"title":"C","status":"open","tags":["x"]}"#,
        "--body",
        "C body.\n",
    ]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(stdout(&out), "created tasks/c.md\n");
    assert!(read("tasks/c.md").contains("title: C"));
    assert!(read("tasks/c.md").ends_with("C body.\n"));

    // A null field is removed.
    let (code, v) = f.json(&[
        "update",
        "tasks/c.md",
        "--fields",
        r#"{"status":"done","tags":null}"#,
    ]);
    assert_eq!(code, 0, "{v}");
    assert_eq!(v["published"], "published");
    let (_, rec) = f.json(&["read", "tasks/c.md"]);
    assert_eq!(rec["frontmatter"]["status"], "done");
    assert!(rec["frontmatter"].get("tags").is_none(), "{rec}");

    // A dry run changes nothing.
    let before = read("tasks/c.md");
    let (code, v) = f.json(&[
        "update",
        "tasks/c.md",
        "--fields",
        r#"{"status":"open"}"#,
        "--dry-run",
    ]);
    assert_eq!(code, 0);
    assert_eq!(v["dry_run"], true);
    assert_eq!(v["records"][0]["frontmatter"]["status"], "open");
    assert_eq!(read("tasks/c.md"), before);

    // --if-revision.
    let zero = "0".repeat(64);
    let (code, v) = f.json(&[
        "update",
        "tasks/c.md",
        "--fields",
        "{}",
        "--if-revision",
        &zero,
    ]);
    assert_eq!(code, 1);
    assert_eq!(v["error"]["code"], "conflict", "{v}");
    let revision = rec["revision"].as_str().unwrap();
    let out = f.run(&[
        "update",
        "tasks/c.md",
        "--body",
        "New.\n",
        "--if-revision",
        revision,
    ]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(read("tasks/c.md").ends_with("New.\n"));

    // A write that would make a record invalid is refused.
    let (code, _) = f.json(&[
        "create",
        "--path",
        "tasks/d.md",
        "--type",
        "task",
        "--fields",
        r#"{"title":""}"#,
    ]);
    assert_eq!(code, 1);
    assert!(!f.root.join("tasks/d.md").exists());

    // Rename updates links unless told not to.
    let out = f.run(&["rename", "tasks/a.md", "tasks/a2.md"]);
    assert_eq!(stdout(&out), "renamed tasks/a.md -> tasks/a2.md\n");
    assert!(
        read("tasks/b.md").contains("[[a2]]"),
        "{}",
        read("tasks/b.md")
    );
    f.run(&["rename", "tasks/a2.md", "tasks/a3.md", "--no-update-refs"]);
    assert!(read("tasks/b.md").contains("[[a2]]"));

    let out = f.run(&["delete", "tasks/c.md"]);
    assert_eq!(stdout(&out), "deleted tasks/c.md\n");
    assert!(!f.root.join("tasks/c.md").exists());

    // A batch is all or nothing.
    let out = f.run_with_stdin(
        &["batch", "--request", "-"],
        r#"{"ops": [
            {"op": "create", "path": "tasks/e.md", "type": "task", "fields": {"title": "E", "status": "open"}},
            {"op": "delete", "path": "tasks/missing.md"}
        ]}"#,
    );
    assert_eq!(out.status.code(), Some(1));
    assert!(!f.root.join("tasks/e.md").exists());
    let out = f.run_with_stdin(
        &["batch", "--request", "-"],
        r#"{"ops": [
            {"op": "create", "path": "tasks/e.md", "type": "task", "fields": {"title": "E", "status": "open"}},
            {"op": "update", "path": "tasks/b.md", "fields": {"status": "open"}}
        ]}"#,
    );
    assert_eq!(stdout(&out), "created tasks/e.md\nupdated tasks/b.md\n");
    let out = f.run_with_stdin(
        &["--json", "batch", "--request", "-"],
        r#"{"ops": [{"op": "move"}]}"#,
    );
    assert_eq!(out.status.code(), Some(1));
    let v: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["error"]["reason"], "invalid_request");
}

#[test]
fn refuses_folders_it_must_not_open() {
    let f = fixture("rf");

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

    // Registered with this profile's daemon, which is not running: never opened
    // in process, from the root or from inside it.
    register(&f.state, &f.root);
    let (code, v) = f.json(&["query"]);
    assert_eq!(code, 3, "{v}");
    assert_eq!(v["error"]["reason"], "daemon_not_running", "{v}");
    let out = Command::new(env!("CARGO_BIN_EXE_mdbase"))
        .args(["--json", "--state-dir"])
        .arg(&f.state)
        .args(["query", "-C"])
        .arg(&plain)
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(3));

    // A folder that contains a registered collection.
    let parent = f.root.parent().unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_mdbase"))
        .args(["--json", "--state-dir"])
        .arg(&f.state)
        .args(["query", "-C"])
        .arg(parent)
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    let v: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["error"]["reason"], "contains_collection", "{v}");
}

/// Each command gives the same answer through the daemon as in process, apart from
/// record IDs (each route assigns its own). The daemon holds the folder lock, so a
/// working daemon route also shows the CLI never tried to open the folder itself.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn daemon_route_matches_in_process() {
    // Short: Unix socket paths are limited.
    let base = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("dc{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let (served, local) = (base.join("a"), base.join("b"));
    collection(&served);
    collection(&local);

    let profile = Profile::isolated(&base.join("s")).unwrap();
    let keys = std::sync::Arc::new(MemoryStore::default());
    let (p, k2) = (profile.clone(), keys.clone());
    let daemon = tokio::spawn(async move { server::run(p, Some(Box::new(k2))).await });
    let mut c = loop {
        if let Ok(c) = ControlClient::connect(&profile.control).await {
            break c;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    pairing::pair(&profile, &keys).await;
    let added: CollectionStatus = serde_json::from_value(
        c.call(
            Method::COLLECTION_ADD,
            json!({ "path": served, "name": "served" }),
        )
        .await
        .unwrap(),
    )
    .unwrap();
    for _ in 0..500 {
        let v = c.call(Method::COLLECTION_LIST, json!({})).await.unwrap();
        let list: Vec<CollectionStatus> = serde_json::from_value(v).unwrap();
        if list
            .iter()
            .any(|s| s.id == added.id && s.state == CollectionState::Ready)
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    // The CLI is another process: give it the daemon's host key through the
    // debug-only file store.
    let control_key = secrets::read_control_key(keys.as_ref()).unwrap().unwrap();
    std::fs::write(
        profile.state_dir.join("test-secrets.json"),
        json!({ secrets::CONTROL_KEY: secrets::hex(&control_key[..]) }).to_string(),
    )
    .unwrap();
    let state = profile.state_dir.clone();
    let unregistered = base.join("u");

    let commands: &[&[&str]] = &[
        &["read", "tasks/a.md"],
        &["read", "tasks/missing.md"],
        &["query", "--order-by", "title"],
        &["query", "--where", "status == \"open\"", "--include-body"],
        &["validate"],
        &["validate", "tasks/a.md"],
        &["types", "list"],
        &["types", "show", "task"],
    ];
    let routes = Routes {
        state: state.clone(),
        unregistered: unregistered.clone(),
        served: served.clone(),
        local: local.clone(),
    };
    for args in commands {
        for json_flag in [false, true] {
            routes.same(args, json_flag).await;
        }
    }

    // Writes, once each, then the folders must match.
    let zero = "0".repeat(64);
    let writes: &[(&[&str], bool)] = &[
        (
            &[
                "create",
                "--path",
                "tasks/c.md",
                "--type",
                "task",
                "--fields",
                r#"{"title":"C","status":"open"}"#,
                "--body",
                "C.\n",
            ],
            false,
        ),
        (
            &["update", "tasks/c.md", "--fields", r#"{"status":"done"}"#],
            true,
        ),
        (
            &[
                "update",
                "tasks/c.md",
                "--fields",
                r#"{"status":"open"}"#,
                "--dry-run",
            ],
            true,
        ),
        (
            &[
                "update",
                "tasks/c.md",
                "--fields",
                "{}",
                "--if-revision",
                &zero,
            ],
            true,
        ),
        (
            &[
                "create",
                "--path",
                "tasks/d.md",
                "--type",
                "task",
                "--fields",
                r#"{"title":""}"#,
            ],
            true,
        ),
        (&["rename", "tasks/a.md", "tasks/a2.md"], false),
        (&["delete", "tasks/c.md"], true),
    ];
    for (args, json_flag) in writes {
        routes.same(args, *json_flag).await;
    }
    assert_eq!(files(&served.join("tasks")), files(&local.join("tasks")));
    assert!(files(&served.join("tasks"))[1].1.contains("[[a2]]"));

    // By name, from anywhere.
    let out = tokio::task::spawn_blocking(move || {
        mdbase(
            &state,
            false,
            &["query", "--order-by", "title"],
            &["-c", "served"],
        )
    })
    .await
    .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(stdout(&out), "tasks/bad.md\ntasks/b.md\ntasks/a2.md\n");

    c.call(Method::SHUTDOWN, json!({})).await.unwrap();
    tokio::time::timeout(Duration::from_secs(15), daemon)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}

/// `mdbase` with the debug-only file secret store, which the daemon test fills.
fn mdbase(state: &Path, json_flag: bool, args: &[&str], target: &[&str]) -> Output {
    let mut c = Command::new(env!("CARGO_BIN_EXE_mdbase"));
    c.env("MDBASE_ENV", "test")
        .env("MDBASE_SECRET_BACKEND", "insecure-test-file")
        .arg("--state-dir")
        .arg(state);
    if json_flag {
        c.arg("--json");
    }
    c.args(args).args(target).output().unwrap()
}

struct Routes {
    state: PathBuf,
    unregistered: PathBuf,
    served: PathBuf,
    local: PathBuf,
}

impl Routes {
    /// Run `args` through the daemon and in process; both must answer alike.
    async fn same(&self, args: &[&str], json_flag: bool) {
        let (state, unregistered) = (self.state.clone(), self.unregistered.clone());
        let (served, local) = (self.served.clone(), self.local.clone());
        let owned: Vec<String> = args.iter().map(|a| a.to_string()).collect();
        let (daemon_out, local_out) = tokio::task::spawn_blocking(move || {
            let args: Vec<&str> = owned.iter().map(String::as_str).collect();
            (
                mdbase(&state, json_flag, &args, &["-C", served.to_str().unwrap()]),
                mdbase(
                    &unregistered,
                    json_flag,
                    &args,
                    &["-C", local.to_str().unwrap()],
                ),
            )
        })
        .await
        .unwrap();
        assert_eq!(
            daemon_out.status.code(),
            local_out.status.code(),
            "{args:?}: {}",
            String::from_utf8_lossy(&daemon_out.stderr)
        );
        if json_flag {
            let parse = |o: &Output| {
                let mut v: Value = serde_json::from_slice(&o.stdout).unwrap();
                strip_ids(&mut v);
                v
            };
            assert_eq!(parse(&daemon_out), parse(&local_out), "{args:?}");
        } else {
            assert_eq!(stdout(&daemon_out), stdout(&local_out), "{args:?}");
        }
    }
}

/// A folder's files and their text, by name.
fn files(dir: &Path) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .map(|p| {
            let text = std::fs::read_to_string(&p).unwrap();
            (p.file_name().unwrap().to_string_lossy().into_owned(), text)
        })
        .collect();
    out.sort();
    out
}

/// Remove what each route assigns itself: record and mutation IDs.
fn strip_ids(v: &mut Value) {
    match v {
        Value::Object(m) => {
            m.remove("id");
            m.remove("mutation");
            m.values_mut().for_each(strip_ids);
        }
        Value::Array(a) => a.iter_mut().for_each(strip_ids),
        _ => {}
    }
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
