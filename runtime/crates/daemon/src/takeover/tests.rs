//! The takeover driver against an old-agent-shaped device: a connector state
//! directory built from the old connector's exact DDL (beta.104+ layout: connector
//! schema 3, authority v5; `crates/legacy/fixtures`), a folder with an old engine
//! transaction caught mid-commit, a diverged one, and crashes injected at every
//! step.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use mdbn_legacy::marker::{self, Marker};
use mdbn_legacy::revision_of;
use serde_json::json;

use super::adapter::{CRASH_AT, Evidence};
use super::record::{CollectionState, Record, State};
use super::*;

#[path = "../../tests/fixtures/old_agent.rs"]
pub(super) mod old_agent;
use old_agent::{CID, RID};
const MIRROR: &str = "9d1e0c55-0000-4000-8000-00000000000a";

struct Device {
    _dir: crate::testutil::TestDir,
    old: PathBuf,
    root: PathBuf,
    state: PathBuf,
    paths: Paths,
}

/// The old agent's device: one local collection with a record ID, a grant, a
/// completed (acknowledged) mutation with a stored receipt and an in-flight one; its
/// folder has a.md mid-commit (A1 → A2), c.md mid-commit but changed by the user
/// (diverged: held), and b.md untouched.
fn device(tag: &str) -> Device {
    let dir = crate::testutil::TestDir::new(tag);
    let old = dir.path().join("connect");
    let root = dir.path().join("notes");
    let state = dir.path().join("state");
    old_agent::build(&old, &root);
    crate::fsutil::ensure_private_dir(&state).unwrap();
    let paths = Paths::new(&state, state.join("store-ids.json"));
    Device {
        _dir: dir,
        old,
        root,
        state,
        paths,
    }
}

#[derive(Default)]
struct Old(u32);
impl OldService for Old {
    fn stop_and_disable(&mut self) -> Result<(), String> {
        failpoint_t1();
        self.0 += 1;
        Ok(())
    }
}
fn failpoint_t1() {
    super::adapter::failpoint("t1");
}

fn opts() -> Options {
    Options {
        stop_mirrors: false,
        drain: Duration::ZERO,
        now: "2026-10-08T12:00:00Z".into(),
    }
}

fn sha(p: &Path) -> String {
    revision_of(&fs::read(p).unwrap())
}

fn old_files(d: &Device) -> Vec<String> {
    let mut v = vec![
        sha(&d.old.join("connector.sqlite")),
        sha(&d.old.join("authority.sqlite")),
    ];
    for id in [
        "11111111111111111111111111111111",
        "22222222222222222222222222222222",
    ] {
        v.push(sha(&d
            .root
            .join(".mdbase/transactions")
            .join(id)
            .join("journal.json")));
    }
    v
}

/// Everything a finished takeover must show, whatever happened on the way.
fn assert_taken_over(d: &Device, old_before: &[String]) {
    let r = Record::load(&d.paths.record).unwrap().unwrap();
    assert_eq!(r.state, State::Complete, "{r:?}");
    assert_eq!(r.held_interrupted_writes(), 2);
    let c = &r.collections[CID];
    assert_eq!(c.state, CollectionState::Held, "the diverged c.md is held");
    // Without a never-clobber publisher, both mid-commit writes are retained as
    // holds. No collection bytes are changed, including the still-unpublished A1.
    assert_eq!(fs::read(d.root.join("a.md")).unwrap(), b"A1");
    assert_eq!(fs::read(d.root.join("c.md")).unwrap(), b"C user edit");
    assert_eq!(fs::read(d.root.join("b.md")).unwrap(), b"B");
    // Both intended versions are retained; their existing versions remain on disk.
    let bytes = super::Adapter::collection_dir(&d.paths.legacy, CID).join("bytes");
    for b in [&b"A2"[..], b"C2"] {
        let hex = revision_of(b)["sha256:".len()..].to_owned();
        assert_eq!(fs::read(bytes.join(hex)).unwrap(), b);
    }
    // Fenced last, with this daemon's store ID.
    let ids = crate::registry::StoreIds::load(&d.paths.store_ids).unwrap();
    assert_eq!(
        marker::read(&d.root).unwrap(),
        Marker::Claimed {
            collection: CID.into(),
            replica_id: ids.get(CID).unwrap().into()
        }
    );
    // The import: record IDs, grants, the acknowledged write's receipt bytes, the
    // in-flight one as never-acknowledged evidence, and the hold.
    let ev = Evidence::load(&d.paths.legacy, CID).unwrap().unwrap();
    assert_eq!(ev.record_ids[0].record_id, RID);
    assert_eq!(ev.grants["grants"].as_array().unwrap().len(), 1);
    let row = |r: &str| {
        ev.journal
            .iter()
            .find(|j| j["request_id"] == r)
            .unwrap()
            .clone()
    };
    assert_eq!(row("done")["receipt"], "receipt");
    assert!(row("done")["receipt_bytes"].as_str().is_some());
    assert_eq!(row("inflight")["state"], "prepared");
    assert_ne!(row("inflight")["receipt"], "receipt");
    assert_eq!(ev.holds.len(), 2);
    assert_eq!(ev.holds[0].path, "a.md");
    assert_eq!(
        ev.holds[0].reason,
        mdbn_takeover::takeover::GUARDED_PUBLISH_UNAVAILABLE
    );
    assert!(ev.holds[0].intended.is_some());
    assert_eq!(ev.holds[1].path, "c.md");
    assert!(ev.rolled_forward.is_empty());
    // Evidence copy and untouched old files (rollback, 6A).
    assert!(
        super::Adapter::collection_dir(&d.paths.legacy, CID)
            .join("evidence/state/connector.sqlite")
            .is_file()
    );
    assert_eq!(old_files(d), old_before);
}

#[test]
fn unavailable_publisher_retains_create_write_and_delete_without_collection_effects() {
    let d = device("tko-publisher-unavailable");
    let dir = d
        .root
        .join(".mdbase/transactions/11111111111111111111111111111111");
    let mut journal: serde_json::Value =
        serde_json::from_slice(&fs::read(dir.join("journal.json")).unwrap()).unwrap();
    journal["entries"].as_array_mut().unwrap().extend([
        json!({"path":"b.md","before_revision":revision_of(b"B"),
            "after_revision":null,"stage_file":null,"backup_file":"backup/1"}),
        json!({"path":"new.md","before_revision":null,"after_revision":revision_of(b"NEW"),
            "stage_file":"stage/2","backup_file":null}),
    ]);
    fs::write(dir.join("stage/2"), b"NEW").unwrap();
    fs::write(
        dir.join("journal.json"),
        serde_json::to_vec(&journal).unwrap(),
    )
    .unwrap();
    let sibling = d.root.join(".a.md.mdbase-takeover.tmp");
    fs::write(&sibling, b"unrelated retained evidence").unwrap();
    let before = old_files(&d);
    run(&d.paths, &d.old, &mut Old::default(), &opts()).unwrap();
    assert_eq!(fs::read(d.root.join("a.md")).unwrap(), b"A1");
    assert_eq!(fs::read(d.root.join("b.md")).unwrap(), b"B");
    assert_eq!(fs::read(d.root.join("c.md")).unwrap(), b"C user edit");
    assert!(!d.root.join("new.md").exists());
    assert_eq!(fs::read(&sibling).unwrap(), b"unrelated retained evidence");
    let evidence = Evidence::load(&d.paths.legacy, CID).unwrap().unwrap();
    assert!(evidence.rolled_forward.is_empty());
    assert_eq!(evidence.holds.len(), 4);
    for (path, intended) in [
        ("a.md", Some(&b"A2"[..])),
        ("b.md", None),
        ("new.md", Some(&b"NEW"[..])),
    ] {
        let hold = evidence.holds.iter().find(|h| h.path == path).unwrap();
        assert_eq!(
            hold.reason,
            mdbn_takeover::takeover::GUARDED_PUBLISH_UNAVAILABLE
        );
        match intended {
            Some(bytes) => assert_eq!(
                fs::read(
                    super::Adapter::collection_dir(&d.paths.legacy, CID)
                        .join("bytes")
                        .join(hold.intended.as_ref().unwrap())
                )
                .unwrap(),
                bytes
            ),
            None => assert!(hold.intended.is_none(), "deletion intent retained"),
        }
    }
    let imported =
        fs::read(super::Adapter::collection_dir(&d.paths.legacy, CID).join("import.json")).unwrap();
    run(&d.paths, &d.old, &mut Old::default(), &opts()).unwrap();
    assert_eq!(
        fs::read(super::Adapter::collection_dir(&d.paths.legacy, CID).join("import.json")).unwrap(),
        imported
    );
    assert_eq!(fs::read(&sibling).unwrap(), b"unrelated retained evidence");
    assert_eq!(old_files(&d), before);
}

#[test]
fn takes_over_an_old_agent_device_end_to_end() {
    let d = device("tko-ok");
    let before = old_files(&d);
    let mut old = Old::default();
    let ran = run(&d.paths, &d.old, &mut old, &opts()).unwrap();
    assert_taken_over(&d, &before);
    assert_eq!(old.0, 1, "T1 ran once");
    assert_eq!(ran.undrained, 1, "the prepared request never finished");
    assert_eq!(
        ran.register,
        vec![ToRegister {
            collection: CID.into(),
            root: d.root.clone(),
            name: "Notes".into()
        }]
    );
    let c = &ran.record.unwrap().collections[CID];
    assert_eq!((c.rolled_forward, c.holds, c.registered), (0, 2, false));

    // Every later start fences the old service again and offers registration again
    // until the server marks it registered; nothing is re-imported or re-written.
    let ran = run(&d.paths, &d.old, &mut old, &opts()).unwrap();
    assert_eq!(old.0, 2);
    assert!(!ran.revived);
    assert_eq!(ran.register.len(), 1);
    mark_registered(&d.paths, CID, "t").unwrap();
    let ran = run(&d.paths, &d.old, &mut old, &opts()).unwrap();
    assert!(ran.register.is_empty());
    assert_taken_over(&d, &before);
}

#[test]
fn a_crash_at_any_step_resumes_to_the_same_result() {
    for step in [
        "t1",
        "publish:unavailable",
        "hold",
        "hold:after_keep",
        "import:before",
        "import:after",
        "register",
    ] {
        let d = device("tko-crash");
        let sibling = d.root.join(".a.md.mdbase-takeover.tmp");
        fs::write(&sibling, b"user crash evidence").unwrap();
        let before = old_files(&d);
        CRASH_AT.with(|c| c.set(Some(step)));
        let crashed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run(&d.paths, &d.old, &mut Old::default(), &opts())
        }));
        CRASH_AT.with(|c| c.set(None));
        assert!(crashed.is_err(), "{step}: the failpoint fired");
        // The record was durably `started` before T1, so the bridge never restarts
        // the old daemon, and nothing was claimed before the import.
        let r = Record::load(&d.paths.record).unwrap().unwrap();
        assert_eq!(r.state, State::Started, "{step}");
        if step != "register" {
            assert_eq!(marker::read(&d.root).unwrap(), Marker::Absent, "{step}");
        }
        // Neither user files nor unrelated crash evidence were touched.
        assert_eq!(
            fs::read(&sibling).unwrap(),
            b"user crash evidence",
            "{step}"
        );
        assert_eq!(fs::read(d.root.join("a.md")).unwrap(), b"A1");

        // The next start resumes and finishes.
        let ran = run(&d.paths, &d.old, &mut Old::default(), &opts()).unwrap();
        eprintln!("resumed after a crash at {step}");
        assert_taken_over(&d, &before);
        assert_eq!(ran.register.len(), 1, "{step}");
        // Retry retains unrelated sibling evidence just as it retains user bytes.
        assert_eq!(
            fs::read(&sibling).unwrap(),
            b"user crash evidence",
            "{step}"
        );
        let _ = &d.state;
    }
}

#[test]
fn a_file_saved_during_the_roll_forward_is_held_not_overwritten() {
    let d = device("tko-race");
    // The user saves a.md after the old engine decided to commit: it matches neither
    // revision, so the guarded publish refuses and the intended bytes are held.
    fs::write(d.root.join("a.md"), b"A user").unwrap();
    run(&d.paths, &d.old, &mut Old::default(), &opts()).unwrap();
    assert_eq!(fs::read(d.root.join("a.md")).unwrap(), b"A user");
    let ev = Evidence::load(&d.paths.legacy, CID).unwrap().unwrap();
    let held: Vec<_> = ev.holds.iter().map(|h| h.path.as_str()).collect();
    assert_eq!(held, ["a.md", "c.md"]);
    assert!(ev.rolled_forward.is_empty());
}

#[test]
fn a_running_old_daemon_postpones_without_claiming() {
    let d = device("tko-live");
    let lock = mdbn_legacy::lock::try_exclusive(&mdbn_legacy::lock::daemon_lock_path(&d.old))
        .unwrap()
        .unwrap();
    let ran = run(&d.paths, &d.old, &mut IsolatedOldService, &opts()).unwrap();
    let r = ran.record.unwrap();
    assert_eq!(r.state, State::Postponed);
    assert_eq!(
        r.collections[CID].reason.as_deref(),
        Some("old_daemon_running")
    );
    assert_eq!(marker::read(&d.root).unwrap(), Marker::Absent);
    assert_eq!(fs::read(d.root.join("a.md")).unwrap(), b"A1");
    drop(lock);
    run(&d.paths, &d.old, &mut IsolatedOldService, &opts()).unwrap();
    assert_taken_over(&d, &old_files(&d));
}

fn mirror(d: &Device, folder_bytes: &[u8]) {
    let mroot = d.state.parent().unwrap().join("mirror");
    fs::create_dir_all(mroot.join(".mdbase")).unwrap();
    fs::write(mroot.join("m.md"), folder_bytes).unwrap();
    fs::write(
        d.old.join("mirrors.json"),
        json!({"version": 2, "mirrors": [{
            "collection_id": "4c18af2e-b04a-4b77-b83e-493c3695962f", "replica_id": MIRROR,
            "name": "laptop", "mode": "read_write",
            "selective_sync": {"file_classes": [], "excluded_folders": []},
            "path": mroot, "sync_url": "https://x", "control_url": "https://x",
            "enrollment_id": "e", "access_token_expires_at": "2026-10-30T00:00:00Z",
            "created_at": "2026-09-01T00:00:00Z", "lifecycle": "active"}]})
        .to_string(),
    )
    .unwrap();
    let mdir = d.old.join("mirrors").join(MIRROR);
    fs::create_dir_all(&mdir).unwrap();
    let h = revision_of(b"M")["sha256:".len()..].to_owned();
    fs::write(
        mdir.join("state.json"),
        json!({
            "protocol_version": 1, "engine_version": 3, "generation": 1, "replica_id": MIRROR,
            "scope_epoch": 1, "cursor": 5, "mode": "read_write",
            "records": {"r1": {"path": "m.md", "revision": format!("sha256:{h}"), "hash": h}},
            "last_completed_plan": "sha256:p0", "batch": null})
        .to_string(),
    )
    .unwrap();
}

#[test]
fn old_mirrors_postpone_the_device_until_their_queues_are_empty() {
    // A queued (un-uploaded) mirror edit: T1 would stop its upload, so wait.
    let d = device("tko-mirror");
    mirror(&d, b"M edited, not uploaded");
    let mut old = Old::default();
    let ran = run(&d.paths, &d.old, &mut old, &opts()).unwrap();
    let r = ran.record.unwrap();
    assert_eq!(r.state, State::Postponed);
    assert_eq!(
        r.collections[CID].reason.as_deref(),
        Some("mirrors_present")
    );
    assert_eq!(old.0, 0, "the old daemon keeps running");
    let ran = run(
        &d.paths,
        &d.old,
        &mut old,
        &Options {
            stop_mirrors: true,
            ..opts()
        },
    )
    .unwrap();
    assert_eq!(
        ran.record.unwrap().collections[CID].reason.as_deref(),
        Some("mirror_queue_not_empty")
    );
    assert_eq!(old.0, 0);
    assert_eq!(marker::read(&d.root).unwrap(), Marker::Absent);

    // Drained: with --stop-mirrors it proceeds.
    let d = device("tko-mirror-empty");
    mirror(&d, b"M");
    let before = old_files(&d);
    run(
        &d.paths,
        &d.old,
        &mut Old::default(),
        &Options {
            stop_mirrors: true,
            ..opts()
        },
    )
    .unwrap();
    assert_taken_over(&d, &before);
}

#[test]
fn a_revived_old_daemon_is_fenced_and_reported() {
    let d = device("tko-revived");
    let mut old = Old::default();
    run(&d.paths, &d.old, &mut old, &opts()).unwrap();
    // The user starts the old daemon again (it holds daemon.lock).
    let lock = mdbn_legacy::lock::try_exclusive(&mdbn_legacy::lock::daemon_lock_path(&d.old))
        .unwrap()
        .unwrap();
    let ran = run(&d.paths, &d.old, &mut old, &opts()).unwrap();
    assert!(ran.revived);
    assert_eq!(old.0, 2, "stopped and disabled again");
    drop(lock);
    assert!(!run(&d.paths, &d.old, &mut old, &opts()).unwrap().revived);
}

#[test]
fn rolled_back_or_unreadable_records_stop_the_driver() {
    let d = device("tko-stop");
    let mut r = Record {
        schema_version: record::SCHEMA_VERSION,
        state: State::RolledBack,
        updated_at: "t".into(),
        old_state_dir: d.old.clone(),
        collections: Default::default(),
    };
    r.save(&d.paths.record).unwrap();
    let mut old = Old::default();
    run(&d.paths, &d.old, &mut old, &opts()).unwrap();
    assert_eq!(old.0, 0);
    assert_eq!(marker::read(&d.root).unwrap(), Marker::Absent);
    // A torn record fails closed: nothing is stopped or claimed.
    crate::fsutil::write_atomic(&d.paths.record, b"torn").unwrap();
    assert!(run(&d.paths, &d.old, &mut old, &opts()).is_err());
    assert_eq!(old.0, 0);
    // A record for another connector state directory is refused.
    r.state = State::Started;
    r.old_state_dir = d.state.clone();
    r.save(&d.paths.record).unwrap();
    assert!(run(&d.paths, &d.old, &mut old, &opts()).is_err());
    assert_eq!(marker::read(&d.root).unwrap(), Marker::Absent);
}

#[test]
fn no_old_state_is_a_no_op() {
    let d = device("tko-none");
    let ran = run(
        &d.paths,
        &d.state.join("nothing"),
        &mut Old::default(),
        &opts(),
    )
    .unwrap();
    assert!(ran.record.is_none());
    assert!(!d.paths.record.exists());
}

#[test]
fn unsafe_journal_paths_are_refused() {
    let dir = crate::testutil::TestDir::new("tko-paths");
    for bad in [
        "../x.md",
        "/etc/x",
        "",
        ".mdbase/connect-role.json",
        "a/../../b",
    ] {
        assert!(
            super::adapter::checked_for_tests(dir.path(), bad).is_err(),
            "{bad}"
        );
    }
    assert!(super::adapter::checked_for_tests(dir.path(), "notes/a.md").is_ok());
}

#[test]
fn a_missing_or_altered_marker_is_a_sticky_incident_never_rewritten() {
    let d = device("tko-marker");
    let mut old = Old::default();
    run(&d.paths, &d.old, &mut old, &opts()).unwrap();
    let marker_path = d.root.join(".mdbase/connect-role.json");
    let ours = fs::read(&marker_path).unwrap();
    assert!(!Record::load(&d.paths.record).unwrap().unwrap().collections[CID].marker_incident);

    // Removed (e.g. an old `mirror remove`, or by hand): latched, not recreated.
    fs::remove_file(&marker_path).unwrap();
    run(&d.paths, &d.old, &mut old, &opts()).unwrap();
    assert!(!marker_path.exists(), "never silently rewritten");
    let r = Record::load(&d.paths.record).unwrap().unwrap();
    assert!(r.collections[CID].marker_incident);
    assert_eq!(
        r.state,
        State::Complete,
        "the takeover itself stays complete"
    );

    // Restored by hand: still latched (sticky).
    fs::write(&marker_path, &ours).unwrap();
    run(&d.paths, &d.old, &mut old, &opts()).unwrap();
    assert!(Record::load(&d.paths.record).unwrap().unwrap().collections[CID].marker_incident);

    // Altered to another replica's claim: an incident too.
    let d = device("tko-marker-alt");
    run(&d.paths, &d.old, &mut Old::default(), &opts()).unwrap();
    let text = fs::read_to_string(d.root.join(".mdbase/connect-role.json")).unwrap();
    let ids = crate::registry::StoreIds::load(&d.paths.store_ids).unwrap();
    let altered = text.replace(
        ids.get(CID).unwrap(),
        "11111111-2222-4333-8444-555555555555",
    );
    fs::remove_file(d.root.join(".mdbase/connect-role.json")).unwrap();
    fs::write(d.root.join(".mdbase/connect-role.json"), altered).unwrap();
    assert!(!marker_is_ours(&d.root, CID, &d.paths.store_ids).unwrap());
    run(&d.paths, &d.old, &mut Old::default(), &opts()).unwrap();
    assert!(Record::load(&d.paths.record).unwrap().unwrap().collections[CID].marker_incident);
}
