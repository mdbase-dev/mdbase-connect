#![cfg(all(not(target_arch = "wasm32"), target_os = "linux"))]
//! Real native executable integration tests with disposable local inputs.
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "Disposable test files and native executable invocation"
)]
#[path = "support/cut.rs"]
mod cut;
#[path = "support/stage.rs"]
mod stage;
use stage::Stage;
use std::{fs, process::Command};
fn run(stage: &Stage) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_mdbn-backup-verify"))
        .args(stage.arguments())
        .output()
        .unwrap()
}
fn refusal(output: &std::process::Output, exit: i32, code: &str) {
    assert_eq!(output.status.code(), Some(exit));
    assert!(output.stderr.is_empty());
    assert_eq!(
        output.stdout,
        format!("{{\"verified\":false,\"code\":\"{code}\"}}\n").as_bytes()
    );
}
#[test]
fn real_cli_accepts_ordinary_compacted_indexed_near9_and_different_publisher_extra_roots() {
    for (compacted, indexed, large, different, extra) in [
        (false, false, false, false, false),
        (true, false, false, false, false),
        (false, true, false, false, false),
        (false, false, true, false, false),
        (false, true, false, true, true),
    ] {
        let stage = Stage::new(&cut::source(compacted, indexed, large, different, extra));
        let output = run(&stage);
        assert_eq!(
            output.status.code(),
            Some(0),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        assert!(output.stderr.is_empty());
        assert!(output.stdout.len() <= 256);
        let text = std::str::from_utf8(&output.stdout).unwrap();
        assert!(text.starts_with("{\"verified\":true,"));
        assert!(text.ends_with("\"current_authority_verified\":false}\n"));
        assert_eq!(text.lines().count(), 1);
    }
}
#[test]
fn real_cli_malformed_options_refuse_before_any_io() {
    let output = Command::new(env!("CARGO_BIN_EXE_mdbn-backup-verify"))
        .args([
            "--cut-dir",
            "missing-sensitive-path",
            "--trust",
            "missing-trust",
            "--completion",
            "missing-completion",
            "--trust",
            "duplicate-sensitive-trust",
        ])
        .output()
        .unwrap();
    refusal(&output, 2, "invocation");
}
#[test]
fn real_cli_missing_extra_corrupt_and_wrong_signed_completion_are_content_free() {
    let fixture = cut::fixture(false, false, false);
    let stage = Stage::new(&fixture);
    fs::remove_file(stage.root.join("pages/0000000001.cbor")).unwrap();
    refusal(&run(&stage), 1, "layout");
    let stage = Stage::new(&fixture);
    fs::write(stage.root.join("unadvertised-sensitive-name"), b"content").unwrap();
    refusal(&run(&stage), 1, "layout");
    let stage = Stage::new(&fixture);
    let (address, raw) = &fixture.objects[0];
    let mut bad = raw.clone();
    *bad.last_mut().unwrap() ^= 1;
    fs::write(
        stage
            .root
            .join("objects")
            .join(format!("{}.cbor", address.to_hex())),
        bad,
    )
    .unwrap();
    refusal(&run(&stage), 1, "objects");
    let stage = Stage::new(&fixture);
    let mut bad = fixture.completion.clone();
    *bad.last_mut().unwrap() ^= 1;
    fs::write(stage.parent.join("completion.cbor"), bad).unwrap();
    refusal(&run(&stage), 1, "signature");
}
