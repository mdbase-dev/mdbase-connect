use mdbase_connect_collaboration::MarkdownBodyDocument;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

const LIMIT: usize = 1024 * 1024;

#[derive(Deserialize)]
struct Manifest {
    contract_version: u32,
    profile: String,
    yjs_version: String,
    yrs_version: String,
    files: BTreeMap<String, FixtureDigest>,
}

#[derive(Deserialize)]
struct FixtureDigest {
    bytes: usize,
    sha256: String,
}

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures/collaboration-v1")
}

fn read(directory: &Path, name: &str) -> Vec<u8> {
    fs::read(directory.join(name)).unwrap()
}

fn read_text(directory: &Path, name: &str) -> String {
    fs::read_to_string(directory.join(name)).unwrap()
}

#[test]
fn binary_fixtures_are_pinned_to_the_selected_runtimes() {
    let directory = fixtures();
    let manifest: Manifest = serde_json::from_slice(&read(&directory, "manifest.json")).unwrap();
    assert_eq!(manifest.contract_version, 1);
    assert_eq!(manifest.profile, "markdown-body-yjs-v13");
    assert_eq!(manifest.yjs_version, "13.6.32");
    assert_eq!(manifest.yrs_version, "0.26.0");
    for (name, expected) in manifest.files {
        let content = read(&directory, &name);
        assert_eq!(content.len(), expected.bytes, "{name}");
        assert_eq!(
            format!("{:x}", Sha256::digest(&content)),
            expected.sha256,
            "{name}"
        );
    }
}

#[test]
fn yjs_and_yrs_updates_converge_under_reordering_and_duplication() {
    let directory = fixtures();
    let initial = read(&directory, "yjs-initial-update-v1.bin");
    let offline = read(&directory, "yjs-offline-update-v1.bin");
    let provider = read(&directory, "yrs-provider-update-v1.bin");
    let expected = read_text(&directory, "expected-converged-body.txt");

    let mut first = MarkdownBodyDocument::from_snapshot(&initial, LIMIT, LIMIT).unwrap();
    first.apply_update_v1(&provider, LIMIT, LIMIT).unwrap();
    first.apply_update_v1(&offline, LIMIT, LIMIT).unwrap();
    first.apply_update_v1(&offline, LIMIT, LIMIT).unwrap();

    let mut second = MarkdownBodyDocument::from_snapshot(&initial, LIMIT, LIMIT).unwrap();
    second.apply_update_v1(&offline, LIMIT, LIMIT).unwrap();
    second.apply_update_v1(&provider, LIMIT, LIMIT).unwrap();
    second.apply_update_v1(&provider, LIMIT, LIMIT).unwrap();

    assert_eq!(first.body(), expected);
    assert_eq!(second.body(), expected);
    assert_eq!(first.state_vector_v1(), second.state_vector_v1());
}

#[test]
fn compacted_yrs_state_synchronizes_an_old_yjs_vector() {
    let directory = fixtures();
    let initial = read(&directory, "yjs-initial-update-v1.bin");
    let mut stale = MarkdownBodyDocument::from_snapshot(&initial, LIMIT, LIMIT).unwrap();
    stale
        .apply_update_v1(
            &read(&directory, "yrs-diff-from-old-vector-v1.bin"),
            LIMIT,
            LIMIT,
        )
        .unwrap();

    let compacted = MarkdownBodyDocument::from_snapshot(
        &read(&directory, "yrs-compacted-snapshot-v1.bin"),
        LIMIT,
        LIMIT,
    )
    .unwrap();
    let expected = read_text(&directory, "expected-converged-body.txt");
    assert_eq!(stale.body(), expected);
    assert_eq!(compacted.body(), expected);
    assert_eq!(stale.state_vector_v1(), compacted.state_vector_v1());
}
