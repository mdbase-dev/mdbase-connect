//! An old hosted mirror with unsent edits, registered in an old connector state
//! directory (Rust daemon, engine v3). Shared by the daemon's unit and
//! integration tests.
//!
//! The mirror's base has a, b, c, d, e and u. In the folder: a is changed, b moved
//! to sub/b2.md, c deleted, d holds non-UTF-8 bytes, e is changed, n.md is new and
//! u is untouched. On the server, e was changed too ([`server_records`]).
#![allow(dead_code)]

use std::fs;
use std::path::Path;

use mdbn_legacy::mirror::RegistryEntry;
use serde_json::json;

pub const HOSTED: &str = "4c18af2e-b04a-4b77-b83e-493c3695962f";
pub const MIRROR: &str = "9d1e0c55-0000-4000-8000-00000000000a";
pub const RA: &str = "0192f0c1-7e1a-7b3c-8d4e-00000000000a";
pub const RB: &str = "0192f0c1-7e1a-7b3c-8d4e-00000000000b";
pub const RC: &str = "0192f0c1-7e1a-7b3c-8d4e-00000000000c";
pub const RD: &str = "0192f0c1-7e1a-7b3c-8d4e-00000000000d";
pub const RE: &str = "0192f0c1-7e1a-7b3c-8d4e-00000000000e";
pub const RU: &str = "0192f0c1-7e1a-7b3c-8d4e-0000000000ff";
/// The non-UTF-8 bytes of d.md in the folder.
pub const BINARY: [u8; 4] = [0xff, 0xfe, 0x00, 0x01];

fn hx(b: &[u8]) -> String {
    mdbn_legacy::revision_of(b)["sha256:".len()..].to_owned()
}

/// Register the mirror in `old` (created if needed) with its folder at `folder`.
pub fn build(old: &Path, folder: &Path) -> RegistryEntry {
    fs::create_dir_all(folder.join("sub")).unwrap();
    fs::create_dir_all(old.join("mirrors").join(MIRROR)).unwrap();
    fs::write(folder.join("a.md"), "A edited").unwrap();
    fs::write(folder.join("sub/b2.md"), "B").unwrap();
    fs::write(folder.join("d.md"), BINARY).unwrap();
    fs::write(folder.join("e.md"), "E mine").unwrap();
    fs::write(folder.join("n.md"), "New").unwrap();
    fs::write(folder.join("u.md"), "U").unwrap();
    let rec = |path: &str, bytes: &[u8]| json!({"path": path, "hash": hx(bytes)});
    fs::write(
        old.join("mirrors.json"),
        json!({"version": 2, "mirrors": [{
            "collection_id": HOSTED, "replica_id": MIRROR, "mode": "read_write",
            "path": folder, "lifecycle": "active"}]})
        .to_string(),
    )
    .unwrap();
    fs::write(
        old.join("mirrors").join(MIRROR).join("state.json"),
        json!({
            "engine_version": 3, "replica_id": MIRROR, "cursor": 9, "mode": "read_write",
            "records": {
                RA: rec("a.md", b"A"), RB: rec("b.md", b"B"), RC: rec("c.md", b"C"),
                RD: rec("d.md", b"D"), RE: rec("e.md", b"E"), RU: rec("u.md", b"U")},
            "last_completed_plan": "sha256:p0", "batch": null})
        .to_string(),
    )
    .unwrap();
    mdbn_legacy::mirror::read_registry(old)
        .unwrap()
        .pop()
        .unwrap()
}

/// The server's view of the hosted collection at cutover: e was changed there.
pub fn server_records() -> Vec<(&'static str, &'static str, &'static str)> {
    vec![
        (RA, "a.md", "A"),
        (RB, "b.md", "B"),
        (RC, "c.md", "C"),
        (RD, "d.md", "D"),
        (RE, "e.md", "E theirs"),
        (RU, "u.md", "U"),
    ]
}
