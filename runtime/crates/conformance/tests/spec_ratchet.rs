//! `cargo test` enforces the spec ratchet too, so a local test run catches what CI
//! would.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

#[test]
fn spec_fixtures_match_the_ratchet() {
    let run = mdbn_conformance::spec::run_repo(&mdbn_conformance::repo_root()).unwrap();
    assert!(
        !run.results.is_empty(),
        "no fixtures found under conformance/spec/tests"
    );
    let v: Vec<String> = run.violations.iter().map(|v| v.to_string()).collect();
    assert!(v.is_empty(), "spec ratchet violations:\n{}", v.join("\n"));
}

#[test]
fn native_replay_matches_the_golden_digest() {
    let dir = mdbn_conformance::repo_root().join("conformance/determinism");
    let mut checked = 0;
    for entry in std::fs::read_dir(&dir).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|e| e == "log") {
            let golden = std::fs::read_to_string(path.with_extension("expected.json")).unwrap();
            let got = mdbn_wasm::replay(&std::fs::read_to_string(&path).unwrap());
            assert_eq!(got, golden.trim_end(), "{}", path.display());
            checked += 1;
        }
    }
    assert!(checked > 0, "no determinism fixtures in {}", dir.display());
}
