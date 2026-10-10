//! Local rollback (local migration rollback) against fakes of the external
//! parties and a real folder.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, missing_docs)]

use std::fs;
use std::path::{Path, PathBuf};

use mdbn_takeover::rollback::{self, LocalControl, NewDaemon, OldDaemon};

const CID: &str = "4c18af2e-b04a-4b77-b83e-493c3695962e";
const REP: &str = "0b9f3e7a-3c51-4a8e-9d2f-6e1b2c3d4e5f";
const OTHER: &str = "11111111-2222-4333-8444-555555555555";

fn scratch(name: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR"))
        .join("mdbn-takeover-rollback")
        .join(name);
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join(".mdbase")).unwrap();
    dir
}

fn v2_marker(root: &Path, replica: &str) {
    fs::write(
        root.join(".mdbase/connect-role.json"),
        format!(
            r#"{{"version":2,"role":"replica","collection":"{CID}","replica_id":"{replica}","runtime":"mdbase-next","claimed_at":"2026-10-04T00:00:00Z","notice":"…"}}"#
        ),
    )
    .unwrap();
}

#[derive(Default)]
struct Calls(Vec<String>);

impl NewDaemon for Calls {
    fn stop_serving(&mut self, _: &Path) -> Result<(), String> {
        self.0.push("stop".into());
        Ok(())
    }
    fn held_paths(&mut self, _: &str) -> Vec<String> {
        vec!["notes/held.md".into()]
    }
    fn archive_store(&mut self, c: &str, _: &str) -> Result<PathBuf, String> {
        self.0.push("archive".into());
        Ok(PathBuf::from(format!("/archive/{c}")))
    }
}
impl OldDaemon for Calls {
    fn prepare_refreshed_bindings(&mut self, _: &str, _: &str) -> Result<(), String> {
        self.0.push("refresh".into());
        Ok(())
    }
    fn enable_and_start(&mut self) -> Result<(), String> {
        self.0.push("old-start".into());
        Ok(())
    }
}
impl LocalControl for Calls {
    fn rotate_grant_bindings(&mut self, _: &str, _: &str) -> Result<(), String> {
        self.0.push("rotate".into());
        Ok(())
    }
}

#[test]
fn local_rollback_moves_only_our_marker_and_is_resumable() {
    let root = scratch("local");
    fs::write(root.join("note.md"), b"# user bytes\n").unwrap();
    v2_marker(&root, REP);
    let (mut d, mut o, mut c) = (Calls::default(), Calls::default(), Calls::default());

    let r = rollback::rollback_local(&root, CID, REP, "20261004T0100Z", &mut d, &mut o, &mut c)
        .unwrap();
    assert!(r.marker_moved_to.is_some());
    assert!(!root.join(".mdbase/connect-role.json").exists());
    assert_eq!(r.held, vec!["notes/held.md".to_owned()]);
    assert_eq!(d.0, ["stop", "archive"]);
    assert_eq!(o.0, ["refresh", "old-start"]);
    assert_eq!(c.0, ["rotate"]);
    assert_eq!(fs::read(root.join("note.md")).unwrap(), b"# user bytes\n");

    // Re-running after a crash finishes the remaining steps without touching the marker.
    let r = rollback::rollback_local(&root, CID, REP, "20261004T0100Z", &mut d, &mut o, &mut c)
        .unwrap();
    assert_eq!(r.marker_moved_to, None);
}

#[test]
fn local_rollback_refuses_what_is_not_ours() {
    let (mut d, mut o, mut c) = (Calls::default(), Calls::default(), Calls::default());
    // Another replica's claim.
    let root = scratch("other");
    v2_marker(&root, OTHER);
    assert!(rollback::rollback_local(&root, CID, REP, "t", &mut d, &mut o, &mut c).is_err());
    assert!(root.join(".mdbase/connect-role.json").exists());
    // A v1 mirror marker.
    let root = scratch("mirror");
    fs::write(
        root.join(".mdbase/connect-role.json"),
        format!(r#"{{"version":1,"role":"mirror","collection_id":"{CID}"}}"#),
    )
    .unwrap();
    assert!(rollback::rollback_local(&root, CID, REP, "t", &mut d, &mut o, &mut c).is_err());
    // A folder nobody took over.
    let root = scratch("plain");
    assert!(rollback::rollback_local(&root, CID, REP, "t", &mut d, &mut o, &mut c).is_err());
    // Someone else holds write.lock.
    let root = scratch("locked");
    v2_marker(&root, REP);
    let _held = mdbn_legacy::lock::try_exclusive(&mdbn_legacy::lock::write_lock_path(&root))
        .unwrap()
        .unwrap();
    assert!(rollback::rollback_local(&root, CID, REP, "t", &mut d, &mut o, &mut c).is_err());
    assert!(root.join(".mdbase/connect-role.json").exists());
    // Nothing was started by any refused run.
    assert!(o.0.is_empty());
}
