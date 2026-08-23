use mdbase_connect_collaboration::MarkdownBodyDocument;
use std::fs;
use std::path::PathBuf;

const LIMIT: usize = 1024 * 1024;

fn main() {
    let fixture_dir =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures/collaboration-v1");
    let initial = fs::read(fixture_dir.join("yjs-initial-update-v1.bin")).unwrap();
    let offline = fs::read(fixture_dir.join("yjs-offline-update-v1.bin")).unwrap();
    let old_vector = fs::read(fixture_dir.join("yjs-old-state-vector-v1.bin")).unwrap();

    let mut authority = MarkdownBodyDocument::from_snapshot(&initial, LIMIT, LIMIT).unwrap();
    let provider_body =
        authority.body().replace("Alpha", "Alpha from authority") + "Authority ✨\n";
    let provider_update = authority
        .apply_provider_body(&provider_body, LIMIT)
        .unwrap();
    fs::write(
        fixture_dir.join("yrs-provider-update-v1.bin"),
        &provider_update,
    )
    .unwrap();

    authority.apply_update_v1(&offline, LIMIT, LIMIT).unwrap();
    let expected = authority.body();
    let compacted = authority.snapshot_v1();
    let old_vector_diff = authority.diff_v1(&old_vector).unwrap();
    fs::write(fixture_dir.join("expected-converged-body.txt"), expected).unwrap();
    fs::write(fixture_dir.join("yrs-compacted-snapshot-v1.bin"), compacted).unwrap();
    fs::write(
        fixture_dir.join("yrs-diff-from-old-vector-v1.bin"),
        old_vector_diff,
    )
    .unwrap();
}
