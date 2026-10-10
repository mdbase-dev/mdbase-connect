//! Fail-closed rollback at every durable side-effect boundary.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, missing_docs)]

use std::cell::RefCell;
use std::fs;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use mdbn_takeover::rollback::{self, LocalControl, NewDaemon, OldDaemon};

const CID: &str = "4c18af2e-b04a-4b77-b83e-493c3695962e";
const REP: &str = "0b9f3e7a-3c51-4a8e-9d2f-6e1b2c3d4e5f";
const TAG: &str = "rollback-stable-id";

struct State {
    root: PathBuf,
    fail: Option<&'static str>,
    rotated: bool,
    rotations: usize,
    archived: bool,
    prepared: bool,
    started: bool,
}

impl State {
    fn boundary(&mut self, name: &'static str) -> Result<(), String> {
        if self.fail == Some(name) {
            self.fail = None;
            Err(format!("interrupted at {name}"))
        } else {
            Ok(())
        }
    }
    fn marker(&self) -> PathBuf {
        self.root.join(".mdbase/connect-role.json")
    }
    fn assert_restart_safe(&self) {
        // An unchanged old daemon can be manually started at any crash boundary.
        // It must either be fenced, or consume bindings that invalidate old replays.
        assert!(self.marker().exists() || (self.rotated && self.prepared));
    }
}

#[derive(Clone)]
struct Adapter(Rc<RefCell<State>>);

impl NewDaemon for Adapter {
    fn stop_serving(&mut self, _: &Path) -> Result<(), String> {
        self.0.borrow_mut().boundary("stop")
    }
    fn held_paths(&mut self, _: &str) -> Vec<String> {
        vec!["held.md".into()]
    }
    fn archive_store(&mut self, collection: &str, tag: &str) -> Result<PathBuf, String> {
        assert_eq!((collection, tag), (CID, TAG));
        let mut s = self.0.borrow_mut();
        s.assert_restart_safe();
        assert!(s.rotated);
        s.boundary("archive-before")?;
        let archive = s.root.join("archive");
        if !s.archived {
            fs::rename(s.root.join("new-store"), &archive).unwrap();
            s.archived = true;
        }
        // A retry must preserve the only copy of the holds and restoration inputs.
        assert_eq!(fs::read(archive.join("hold")).unwrap(), b"user held bytes");
        s.boundary("archive-after")?;
        Ok(archive)
    }
}

impl LocalControl for Adapter {
    fn rotate_grant_bindings(&mut self, collection: &str, tag: &str) -> Result<(), String> {
        assert_eq!((collection, tag), (CID, TAG));
        let mut s = self.0.borrow_mut();
        s.assert_restart_safe();
        s.boundary("rotate-before")?;
        if !s.rotated {
            s.rotated = true;
            s.rotations += 1;
        }
        // Includes a lost response after the server durably commits rotation.
        s.boundary("rotate-after")
    }
}

impl OldDaemon for Adapter {
    fn prepare_refreshed_bindings(&mut self, collection: &str, tag: &str) -> Result<(), String> {
        assert_eq!((collection, tag), (CID, TAG));
        let mut s = self.0.borrow_mut();
        s.assert_restart_safe();
        assert!(s.rotated && s.archived);
        s.boundary("refresh-before")?;
        s.prepared = true;
        s.boundary("refresh-after")
    }
    fn enable_and_start(&mut self) -> Result<(), String> {
        let mut s = self.0.borrow_mut();
        s.assert_restart_safe();
        assert!(!s.marker().exists());
        assert!(s.rotated && s.archived && s.prepared);
        s.boundary("start")?;
        s.started = true;
        Ok(())
    }
}

fn setup(name: &str, fail: &'static str) -> Adapter {
    let root = Path::new(env!("CARGO_TARGET_TMPDIR"))
        .join("rollback-fence")
        .join(name);
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join(".mdbase")).unwrap();
    fs::create_dir_all(root.join("new-store")).unwrap();
    fs::write(root.join("new-store/hold"), b"user held bytes").unwrap();
    fs::write(root.join("note.md"), b"current user bytes").unwrap();
    fs::write(
        root.join(".mdbase/connect-role.json"),
        format!(r#"{{"version":2,"role":"replica","collection":"{CID}","replica_id":"{REP}"}}"#),
    )
    .unwrap();
    Adapter(Rc::new(RefCell::new(State {
        root,
        fail: Some(fail),
        rotated: false,
        rotations: 0,
        archived: false,
        prepared: false,
        started: false,
    })))
}

fn run(adapter: &Adapter) -> mdbn_takeover::Result<rollback::LocalReport> {
    let root = adapter.0.borrow().root.clone();
    rollback::rollback_local(
        &root,
        CID,
        REP,
        TAG,
        &mut adapter.clone(),
        &mut adapter.clone(),
        &mut adapter.clone(),
    )
}

#[test]
fn every_failure_boundary_preserves_fence_or_invalidates_old_replays_and_resumes() {
    for failure in [
        "stop",
        "rotate-before",
        "rotate-after",
        "archive-before",
        "archive-after",
        "refresh-before",
        "refresh-after",
        "start",
    ] {
        let adapter = setup(failure, failure);
        assert!(run(&adapter).is_err(), "{failure}");
        {
            let s = adapter.0.borrow();
            s.assert_restart_safe();
            assert!(!s.started);
            if failure != "start" {
                assert!(s.marker().exists(), "fence removed at {failure}");
            } else {
                assert!(!s.marker().exists());
            }
            assert_eq!(
                fs::read(s.root.join("note.md")).unwrap(),
                b"current user bytes"
            );
        }
        let report = run(&adapter).unwrap();
        let s = adapter.0.borrow();
        assert_eq!(s.rotations, 1, "rotation must deduplicate unknown outcomes");
        assert!(s.started);
        assert_eq!(report.held, ["held.md"]);
        assert_eq!(
            fs::read(report.store_archived_to.join("hold")).unwrap(),
            b"user held bytes"
        );
        assert_eq!(report.marker_moved_to.is_none(), failure == "start");
    }
}

#[test]
fn existing_moved_aside_evidence_is_never_overwritten() {
    let adapter = setup("existing-evidence", "unused");
    let aside = adapter
        .0
        .borrow()
        .root
        .join(format!(".mdbase/connect-role.json.rolled-back-{TAG}"));
    fs::write(&aside, b"pre-existing evidence").unwrap();
    assert!(run(&adapter).is_err());
    let s = adapter.0.borrow();
    assert!(s.marker().exists());
    assert!(!s.rotated && !s.archived && !s.started);
    assert_eq!(fs::read(aside).unwrap(), b"pre-existing evidence");
}
