//! Side-effect-free custody/origin probes in separate child processes. Run this
//! suite both normally and with --release: integration tests link the NON-test
//! library, so the release run proves cfg(test) does not enable shipped hooks.
//! Never reads a keychain, writes a secret file, or contacts a control plane.
// Native process/OS environment test, not a portable crate (AGENTS.md exemption).
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::path::Path;
use std::process::Command;

#[test]
fn backend_and_origin_probe() {
    let Ok(expected) = std::env::var("MDBN_RELEASE_HOOK_PROBE") else {
        return; // Only the parent supplies an explicit probe; no global env edits.
    };
    let store = mdbn_daemon::secrets::store_for(
        "release-hook-probe",
        Path::new("release-hook-probe-never-written"),
    );
    assert_eq!(store.backend(), expected);
    // Construction/backend reporting is pure: do NOT call get/set/delete.
    assert!(mdbn_daemon::trust::sign_in_server(Some("http://127.0.0.1:1")).is_err());
    assert!(mdbn_daemon::trust::sign_in_server(Some("https://foreign.example.test")).is_err());
    assert_eq!(
        mdbn_daemon::trust::sign_in_server(None).unwrap(),
        mdbn_daemon::trust::Environment::embedded().control_plane()
    );
    #[cfg(debug_assertions)]
    {
        mdbn_daemon::trust::allow_loopback_control_plane_for_tests();
        assert!(mdbn_daemon::trust::sign_in_server(Some("http://127.0.0.1:1")).is_ok());
    }
}

#[test]
fn environment_cannot_enable_release_custody_or_origin_hooks() {
    for (test_env, file_backend) in [(false, false), (true, false), (false, true), (true, true)] {
        let expected = if cfg!(debug_assertions) && test_env && file_backend {
            "insecure-test-file"
        } else {
            "keychain"
        };
        let mut child = Command::new(std::env::current_exe().unwrap());
        child
            .args(["--exact", "backend_and_origin_probe", "--nocapture"])
            .env_remove("MDBASE_ENV")
            .env_remove("MDBASE_SECRET_BACKEND")
            .env("MDBN_RELEASE_HOOK_PROBE", expected);
        if test_env {
            child.env("MDBASE_ENV", "test");
        }
        if file_backend {
            child.env("MDBASE_SECRET_BACKEND", "insecure-test-file");
        }
        let output = child.output().unwrap();
        assert!(
            output.status.success(),
            "test_env={test_env}, file_backend={file_backend}: {} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
    }
}
