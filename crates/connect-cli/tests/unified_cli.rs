#![cfg(unix)]

use std::path::Path;
use std::process::{Child, Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;

struct Daemon {
    child: Child,
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn binary() -> &'static str {
    env!("CARGO_BIN_EXE_mdbase")
}

fn run(arguments: &[&str]) -> Output {
    Command::new(binary())
        .args(arguments)
        .env("MDBASE_CONNECT_ENV", "test")
        .env("MDBASE_CONNECT_SECRET_BACKEND", "insecure-test-file")
        .output()
        .expect("run unified CLI")
}

fn json(output: &Output) -> Value {
    serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
        panic!(
            "stdout was not JSON: {error}\nstdout={}\nstderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    })
}

fn diagnostic_json(output: &Output) -> Value {
    serde_json::from_slice(&output.stderr).unwrap_or_else(|error| {
        panic!(
            "stderr was not JSON: {error}\nstdout={}\nstderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    })
}

fn wait_for_daemon(endpoint: &Path) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        let output = run(&["--endpoint", endpoint.to_str().unwrap(), "connect", "ping"]);
        if output.status.success() {
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
    panic!("daemon did not become reachable");
}

#[test]
fn credential_bootstrap_failure_is_unhealthy_even_with_a_live_control_endpoint() {
    let scratch = tempfile::tempdir().unwrap();
    let state = scratch.path().join("state");
    let endpoint = scratch.path().join("control.sock");
    std::fs::create_dir_all(&state).unwrap();
    std::fs::write(state.join("test-secrets.json"), "[").unwrap();
    let child = Command::new(binary())
        .args([
            "--state-dir",
            state.to_str().unwrap(),
            "--endpoint",
            endpoint.to_str().unwrap(),
            "connect",
            "daemon",
            "run",
            "--loopback-port",
            "0",
        ])
        .env("MDBASE_CONNECT_ENV", "test")
        .env("MDBASE_CONNECT_SECRET_BACKEND", "insecure-test-file")
        .env_remove("MDBASE_CONNECT_SERVER_URL")
        .env_remove("MDBASE_CONNECT_CONNECTOR_TOKEN")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let _daemon = Daemon { child };
    wait_for_daemon(&endpoint);
    let call = |command: &str| {
        run(&[
            "--state-dir",
            state.to_str().unwrap(),
            "--endpoint",
            endpoint.to_str().unwrap(),
            "--json",
            "connect",
            command,
        ])
    };
    for command in ["ping", "status"] {
        let result = json(&call(command));
        assert_eq!(result["readiness"]["ready"], false);
        assert_eq!(
            result["readiness"]["safe_reason"],
            "credential_store_unavailable"
        );
    }
    assert_eq!(json(&call("doctor"))["healthy"], false);
    let whoami = call("whoami");
    assert!(!whoami.status.success());
    assert_eq!(
        diagnostic_json(&whoami)["error"]["code"],
        "credential_store_unavailable"
    );
}

#[test]
fn running_mirror_retries_after_transient_credential_store_failure_without_restart() {
    let scratch = tempfile::tempdir().unwrap();
    let state = scratch.path().join("state");
    std::fs::create_dir_all(&state).unwrap();
    let endpoint = scratch.path().join("control.sock");
    let logs = scratch.path().join("daemon.log");
    let log = std::fs::File::create(&logs).unwrap();
    std::fs::write(state.join("mirrors.json"), serde_json::to_vec(&serde_json::json!({
        "version": 2, "mirrors": [{
            "collection_id": "00000000-0000-4000-8000-000000000001",
            "replica_id": "00000000-0000-4000-8000-000000000002",
            "enrollment_id": "00000000-0000-4000-8000-000000000003",
            "name": "isolated credential recovery fixture", "mode": "read_only",
            "path": scratch.path().join("mirror"), "lifecycle": "active",
            "sync_url": "http://127.0.0.1:1/v1/authorities/00000000-0000-4000-8000-000000000001/sync", "control_url": "http://127.0.0.1:1",
            "access_token_expires_at": "2099-01-01T00:00:00Z", "created_at": "2026-01-01T00:00:00Z"
        }]
    })).unwrap()).unwrap();
    let child = Command::new(binary())
        .args([
            "--state-dir",
            state.to_str().unwrap(),
            "--endpoint",
            endpoint.to_str().unwrap(),
            "connect",
            "daemon",
            "run",
            "--loopback-port",
            "0",
        ])
        .env("MDBASE_CONNECT_ENV", "test")
        .env("MDBASE_CONNECT_SECRET_BACKEND", "insecure-test-file")
        .env_remove("MDBASE_CONNECT_SERVER_URL")
        .env_remove("MDBASE_CONNECT_CONNECTOR_TOKEN")
        .stdin(Stdio::null())
        .stdout(log.try_clone().unwrap())
        .stderr(log)
        .spawn()
        .unwrap();
    let mut daemon = Daemon { child };
    thread::sleep(Duration::from_millis(100));
    assert!(
        daemon.child.try_wait().unwrap().is_none(),
        "{}",
        std::fs::read_to_string(&logs).unwrap()
    );
    wait_for_daemon(&endpoint);
    let observe = |offset: usize, marker: &str| {
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            let content = std::fs::read_to_string(&logs).unwrap();
            if content
                .get(offset..)
                .is_some_and(|tail| tail.contains(marker))
            {
                return content.len();
            }
            assert!(
                Instant::now() < deadline,
                "mirror worker did not reach {marker}"
            );
            thread::sleep(Duration::from_millis(50));
        }
    };
    observe(0, "mirror_credentials_missing");
    let secrets = state.join("test-secrets.json");
    let original = std::fs::read(&secrets).unwrap();
    // Fault the existing test-only store after successful bootstrap, never the OS keyring.
    std::fs::write(&secrets, "[").unwrap();
    let failed_at = observe(0, "credential_store_unavailable");
    std::fs::write(&secrets, &original).unwrap();
    // A new missing-credential result proves the SAME worker re-read the restored store.
    // This deliberately does not claim a successful authorized mirror synchronization.
    observe(failed_at, "mirror_credentials_missing");
    assert!(daemon.child.try_wait().unwrap().is_none());
    assert_eq!(std::fs::read(&secrets).unwrap(), original);
    let status = run(&[
        "--endpoint",
        endpoint.to_str().unwrap(),
        "--json",
        "connect",
        "status",
    ]);
    assert_eq!(json(&status)["readiness"]["ready"], true);
}

#[test]
fn isolated_restart_preserves_the_bound_loopback_port() {
    let scratch = tempfile::tempdir().unwrap();
    let state = scratch.path().join("state");
    let endpoint = scratch.path().join("control.sock");
    let state_string = state.to_string_lossy().into_owned();
    let endpoint_string = endpoint.to_string_lossy().into_owned();

    let child = Command::new(binary())
        .args([
            "--state-dir",
            &state_string,
            "--endpoint",
            &endpoint_string,
            "connect",
            "daemon",
            "run",
            "--loopback-port",
            "0",
        ])
        .env("MDBASE_CONNECT_ENV", "test")
        .env("MDBASE_CONNECT_SECRET_BACKEND", "insecure-test-file")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("start daemon");
    let _daemon = Daemon { child };
    wait_for_daemon(&endpoint);

    let status_arguments = [
        "--state-dir",
        &state_string,
        "--endpoint",
        &endpoint_string,
        "--json",
        "connect",
        "status",
    ];
    let before = run(&status_arguments);
    assert!(before.status.success(), "{:#}", json(&before));
    let port = json(&before)["loopback_port"].as_u64().unwrap();
    assert_ne!(port, 0);

    let restarted = run(&[
        "--state-dir",
        &state_string,
        "--endpoint",
        &endpoint_string,
        "--json",
        "connect",
        "daemon",
        "restart",
    ]);
    assert!(
        restarted.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&restarted.stdout),
        String::from_utf8_lossy(&restarted.stderr)
    );
    let after = run(&status_arguments);
    assert!(after.status.success(), "{:#}", json(&after));
    assert_eq!(json(&after)["loopback_port"].as_u64(), Some(port));

    let stopped = run(&[
        "--state-dir",
        &state_string,
        "--endpoint",
        &endpoint_string,
        "connect",
        "daemon",
        "stop",
    ]);
    assert!(stopped.status.success());
}

#[test]
fn direct_and_connected_data_commands_share_one_executable_and_result_contract() {
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path().join("notes");
    let state = scratch.path().join("state");
    let endpoint = scratch.path().join("control.sock");
    let root_string = root.to_string_lossy().into_owned();
    let state_string = state.to_string_lossy().into_owned();
    let endpoint_string = endpoint.to_string_lossy().into_owned();

    let initialized = run(&[
        "--root",
        &root_string,
        "init",
        "--config",
        "spec_version: 0.3.0",
    ]);
    assert!(
        initialized.status.success(),
        "{}",
        String::from_utf8_lossy(&initialized.stderr)
    );

    let created = run(&[
        "--root",
        &root_string,
        "create",
        "--path",
        "first.md",
        "--fields",
        r#"{"title":"First","status":"open"}"#,
    ]);
    assert!(created.status.success(), "{:#}", json(&created));

    let child = Command::new(binary())
        .args([
            "--state-dir",
            &state_string,
            "--endpoint",
            &endpoint_string,
            "connect",
            "daemon",
            "run",
            "--loopback-port",
            "0",
        ])
        .env("MDBASE_CONNECT_ENV", "test")
        .env("MDBASE_CONNECT_SECRET_BACKEND", "insecure-test-file")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("start daemon");
    let _daemon = Daemon { child };
    wait_for_daemon(&endpoint);

    let added = run(&[
        "--state-dir",
        &state_string,
        "--endpoint",
        &endpoint_string,
        "--json",
        "connect",
        "collection",
        "add",
        &root_string,
    ]);
    assert!(
        added.status.success(),
        "{}",
        String::from_utf8_lossy(&added.stderr)
    );
    let collection_id = json(&added)["id"].as_str().unwrap().to_string();

    let type_document = scratch.path().join("task-type.md");
    std::fs::write(
        &type_document,
        r#"---
kind: mdbase.type
name: task
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
---
"#,
    )
    .unwrap();
    let type_document = type_document.to_string_lossy().into_owned();
    let created_type = run(&[
        "--state-dir",
        &state_string,
        "--endpoint",
        &endpoint_string,
        "--collection",
        &collection_id,
        "types",
        "create",
        "--document",
        &type_document,
    ]);
    assert!(created_type.status.success(), "{:#}", json(&created_type));
    assert_eq!(json(&created_type)["result"]["name"], "task");
    let direct_types = run(&["--root", &root_string, "types", "list"]);
    let connected_types = run(&[
        "--state-dir",
        &state_string,
        "--endpoint",
        &endpoint_string,
        "--collection",
        &collection_id,
        "types",
        "list",
    ]);
    assert_eq!(json(&direct_types), json(&connected_types));

    let direct_read = run(&["--root", &root_string, "read", "first.md"]);
    let connected_read = run(&[
        "--state-dir",
        &state_string,
        "--endpoint",
        &endpoint_string,
        "--collection",
        &collection_id,
        "read",
        "first.md",
    ]);
    assert!(
        connected_read.status.success(),
        "{:#}",
        json(&connected_read)
    );
    assert_eq!(json(&direct_read), json(&connected_read));

    let direct_missing = run(&["--root", &root_string, "read", "missing.md"]);
    let connected_missing = run(&[
        "--state-dir",
        &state_string,
        "--endpoint",
        &endpoint_string,
        "--collection",
        &collection_id,
        "read",
        "missing.md",
    ]);
    assert_eq!(
        direct_missing.status.code(),
        connected_missing.status.code()
    );
    assert!(direct_missing.stdout.is_empty());
    assert!(connected_missing.stdout.is_empty());
    assert_eq!(
        diagnostic_json(&direct_missing),
        diagnostic_json(&connected_missing)
    );

    let updated = run(&[
        "--state-dir",
        &state_string,
        "--endpoint",
        &endpoint_string,
        "--collection",
        &collection_id,
        "update",
        "first.md",
        "--fields",
        r#"{"status":"done"}"#,
    ]);
    assert!(updated.status.success(), "{:#}", json(&updated));

    let batch_path = scratch.path().join("batch.json");
    std::fs::write(
        &batch_path,
        r#"{
  "operations": [
    {
      "kind": "update",
      "input": {
        "path": "first.md",
        "patch": {"batch": true}
      }
    },
    {
      "kind": "create",
      "input": {
        "path": "second.md",
        "frontmatter": {"title": "Second", "status": "done"}
      }
    }
  ]
}"#,
    )
    .unwrap();
    let batch_path = batch_path.to_string_lossy().into_owned();
    let batch = run(&[
        "--state-dir",
        &state_string,
        "--endpoint",
        &endpoint_string,
        "--collection",
        &collection_id,
        "batch",
        "--request",
        &batch_path,
    ]);
    assert!(batch.status.success(), "{:#}", json(&batch));
    assert_eq!(json(&batch)["result"]["succeeded"], 2);
    assert_eq!(json(&batch)["result"]["failed"], 0);
    let direct_second = run(&["--root", &root_string, "read", "second.md"]);
    assert!(direct_second.status.success(), "{:#}", json(&direct_second));

    let query_arguments = [
        "query",
        "--where",
        r#"status == "done""#,
        "--order-by",
        "file.path",
    ];
    let mut direct_arguments = vec!["--root", root_string.as_str()];
    direct_arguments.extend(query_arguments);
    let direct_query = run(&direct_arguments);
    let mut connected_arguments = vec![
        "--state-dir",
        state_string.as_str(),
        "--endpoint",
        endpoint_string.as_str(),
        "--collection",
        collection_id.as_str(),
    ];
    connected_arguments.extend(query_arguments);
    let connected_query = run(&connected_arguments);
    assert!(
        connected_query.status.success(),
        "{:#}",
        json(&connected_query)
    );
    assert_eq!(json(&direct_query), json(&connected_query));

    let rename_preview = run(&[
        "--state-dir",
        &state_string,
        "--endpoint",
        &endpoint_string,
        "--collection",
        &collection_id,
        "rename",
        "second.md",
        "preview.md",
        "--dry-run",
    ]);
    assert!(
        rename_preview.status.success(),
        "{:#}",
        json(&rename_preview)
    );
    assert!(root.join("second.md").exists());
    assert!(!root.join("preview.md").exists());

    let renamed = run(&[
        "--state-dir",
        &state_string,
        "--endpoint",
        &endpoint_string,
        "--collection",
        &collection_id,
        "rename",
        "second.md",
        "renamed.md",
    ]);
    assert!(renamed.status.success(), "{:#}", json(&renamed));
    assert!(!root.join("second.md").exists());
    assert!(root.join("renamed.md").exists());

    let delete_preview = run(&[
        "--state-dir",
        &state_string,
        "--endpoint",
        &endpoint_string,
        "--collection",
        &collection_id,
        "delete",
        "renamed.md",
        "--dry-run",
    ]);
    assert!(
        delete_preview.status.success(),
        "{:#}",
        json(&delete_preview)
    );
    assert!(root.join("renamed.md").exists());

    let deleted = run(&[
        "--state-dir",
        &state_string,
        "--endpoint",
        &endpoint_string,
        "--collection",
        &collection_id,
        "delete",
        "renamed.md",
    ]);
    assert!(deleted.status.success(), "{:#}", json(&deleted));
    assert!(!root.join("renamed.md").exists());

    let dry_run = run(&[
        "--state-dir",
        &state_string,
        "--endpoint",
        &endpoint_string,
        "--collection",
        &collection_id,
        "update",
        "first.md",
        "--fields",
        r#"{"status":"preview"}"#,
        "--dry-run",
    ]);
    assert!(dry_run.status.success(), "{:#}", json(&dry_run));
    assert_eq!(json(&dry_run)["result"]["dry_run"], true);
    assert!(!std::fs::read_to_string(root.join("first.md"))
        .unwrap()
        .contains("preview"));

    let current = run(&["--root", &root_string, "read", "first.md"]);
    let revision = json(&current)["result"]["revision"]
        .as_str()
        .unwrap()
        .to_string();
    let direct_writer = Command::new(binary())
        .args([
            "--root",
            &root_string,
            "update",
            "first.md",
            "--fields",
            r#"{"winner":"direct"}"#,
            "--if-revision",
            &revision,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn direct conditional writer");
    let connected_writer = Command::new(binary())
        .args([
            "--state-dir",
            &state_string,
            "--endpoint",
            &endpoint_string,
            "--collection",
            &collection_id,
            "update",
            "first.md",
            "--fields",
            r#"{"winner":"connected"}"#,
            "--if-revision",
            &revision,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn connected conditional writer");
    let direct_result = direct_writer.wait_with_output().unwrap();
    let connected_result = connected_writer.wait_with_output().unwrap();
    assert_eq!(
        usize::from(direct_result.status.success())
            + usize::from(connected_result.status.success()),
        1,
        "exactly one conditional writer must win\ndirect={:#}\nconnected={:#}",
        json(&direct_result),
        json(&connected_result)
    );
    let loser = if direct_result.status.success() {
        &connected_result
    } else {
        &direct_result
    };
    assert_eq!(
        diagnostic_json(loser)["diagnostics"][0]["code"],
        "concurrent_modification"
    );
}

#[test]
fn connected_target_rejects_filesystem_only_maintenance_without_contacting_a_daemon() {
    let output = run(&[
        "--collection",
        "01900000-0000-7000-8000-000000000000",
        "cache",
        "status",
    ]);
    assert!(!output.status.success());
    let value: Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(value["diagnostics"][0]["code"], "unsupported_target");
}

#[test]
fn unsafe_portable_paths_are_rejected_before_daemon_contact() {
    for path in ["../secret.md", "/tmp/secret.md", r"C:\secret.md"] {
        let output = run(&[
            "--collection",
            "01900000-0000-7000-8000-000000000000",
            "read",
            path,
        ]);
        assert!(!output.status.success());
        let value: Value = serde_json::from_slice(&output.stderr).unwrap();
        assert_eq!(value["diagnostics"][0]["code"], "invalid_path");
        assert!(!String::from_utf8_lossy(&output.stderr).contains("daemon"));
    }
}

#[test]
fn unavailable_daemon_is_a_stable_machine_readable_failure() {
    let scratch = tempfile::tempdir().unwrap();
    let missing_endpoint = scratch.path().join("missing.sock");
    let output = run(&[
        "--json",
        "--endpoint",
        missing_endpoint.to_str().unwrap(),
        "--collection",
        "01900000-0000-7000-8000-000000000000",
        "read",
        "note.md",
    ]);
    assert_eq!(output.status.code(), Some(3));
    let value: Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(value["error"]["code"], "daemon_unavailable");
    assert!(!String::from_utf8_lossy(&output.stderr).contains("note.md"));
}

#[test]
fn json_mode_covers_argument_parser_failures() {
    let output = run(&["--json", "--collection", "not-a-uuid", "read", "note.md"]);
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
    let value: Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(value["error"]["code"], "invalid_arguments");
}

#[test]
fn command_timings_are_structured_and_payload_free() {
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path().join("private-collection-name");
    let root_string = root.to_string_lossy().into_owned();
    let output = run(&[
        "--timings",
        "--root",
        &root_string,
        "init",
        "--config",
        "spec_version: 0.3.0",
    ]);
    assert!(output.status.success());
    let stderr = String::from_utf8(output.stderr).unwrap();
    let timing: Value = serde_json::from_str(stderr.trim()).unwrap();
    assert_eq!(timing["profile"]["command"], "init");
    assert_eq!(timing["profile"]["target"], "direct");
    assert_eq!(timing["profile"]["success"], true);
    assert!(timing["profile"]["total_us"].as_u64().is_some());
    assert!(!stderr.contains("private-collection-name"));
    assert!(!stderr.contains("spec_version"));
}

#[test]
fn reports_the_versions_of_every_embedded_compatibility_boundary() {
    let output = run(&["--json", "version"]);
    assert!(output.status.success());
    let value = json(&output);
    assert_eq!(value["cli"], env!("CARGO_PKG_VERSION"));
    assert_eq!(value["engine"], mdbase_command::engine_version());
    assert!(value["local_control_protocol"].as_u64().is_some());
    assert!(value["sync_protocol"].as_u64().is_some());
    assert!(value["operation_transport_protocol"].as_u64().is_some());
}

#[test]
fn deterministic_profilers_are_built_into_the_final_executable() {
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path().join("notes");
    let root_string = root.to_string_lossy().into_owned();
    let initialized = run(&[
        "--root",
        &root_string,
        "init",
        "--config",
        "spec_version: 0.3.0",
    ]);
    assert!(initialized.status.success());
    let created = run(&[
        "--root",
        &root_string,
        "create",
        "--path",
        "profile.md",
        "--fields",
        r#"{"title":"Profile"}"#,
    ]);
    assert!(created.status.success());

    let engine = run(&[
        "--json",
        "profile",
        "engine",
        "--files",
        "4",
        "--projects",
        "1",
        "--rename-refs",
        "1",
        "--open-iters",
        "1",
        "--query-iters",
        "1",
        "--editor-iters",
        "1",
    ]);
    assert!(
        engine.status.success(),
        "{}",
        String::from_utf8_lossy(&engine.stderr)
    );
    let engine_report = json(&engine);
    assert_eq!(engine_report["tool"], "mdbase-profile-engine");
    assert!(
        engine_report["fixture"].get("root").is_none(),
        "profile reports must not contain fixture paths"
    );

    let record_before = std::fs::read(root.join("profile.md")).unwrap();
    let connect = run(&[
        "--json",
        "--root",
        &root_string,
        "profile",
        "connect",
        "--scenario",
        "query",
        "--iterations",
        "1",
        "--concurrency",
        "1",
    ]);
    assert!(
        connect.status.success(),
        "{}",
        String::from_utf8_lossy(&connect.stderr)
    );
    assert_eq!(json(&connect)["tool"], "mdbase-profile-connect");
    assert!(
        !String::from_utf8_lossy(&connect.stdout).contains(&root_string),
        "profile reports must not contain collection paths"
    );
    assert_eq!(
        std::fs::read(root.join("profile.md")).unwrap(),
        record_before,
        "the Connect profiler must not mutate record content"
    );
}

#[test]
fn direct_watch_streams_one_portable_event_and_exits_at_the_requested_count() {
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path().join("notes");
    let root_string = root.to_string_lossy().into_owned();
    let initialized = run(&[
        "--root",
        &root_string,
        "init",
        "--config",
        "spec_version: 0.3.0",
    ]);
    assert!(initialized.status.success());

    let mut child = Command::new(binary())
        .args([
            "--root",
            &root_string,
            "watch",
            "--debounce-ms",
            "50",
            "--count",
            "1",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start watcher");
    thread::sleep(Duration::from_millis(300));
    std::fs::write(
        root.join("watched.md"),
        "---\ntitle: Watched\n---\n\n# Watched\n",
    )
    .unwrap();

    let deadline = Instant::now() + Duration::from_secs(10);
    while child.try_wait().unwrap().is_none() {
        if Instant::now() >= deadline {
            let _ = child.kill();
            let output = child.wait_with_output().unwrap();
            panic!(
                "watch did not terminate\nstdout={}\nstderr={}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
        thread::sleep(Duration::from_millis(20));
    }
    let output = child.wait_with_output().expect("watcher exits");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let event = json(&output);
    assert_eq!(event["kind"], "record_created");
    assert_eq!(event["path"], "watched.md");
    assert!(event["id"]
        .as_str()
        .is_some_and(|id| id.starts_with("watch_")));
}
