//! The local takeover (local migration) against a connector state
//! directory built from the exact old DDL, a real folder with an old engine
//! transaction caught mid-commit, and a fake daemon.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, missing_docs)]

use std::fs;
use std::path::{Path, PathBuf};

use mdbn_legacy::connector::ReceiptImport;
use mdbn_legacy::marker::{self, Marker};
use mdbn_legacy::revision_of;
use mdbn_takeover::takeover::{
    self, Claim, Daemon, Import, OldService, Options, Outcome, Published, Settled,
};
use rusqlite::Connection;

const FIX: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../legacy/fixtures/connect-sql"
);
const CID: &str = "4c18af2e-b04a-4b77-b83e-493c3695962e";
const STORE: &str = "0b9f3e7a-3c51-4a8e-9d2f-6e1b2c3d4e5f";
const RID: &str = "0192f0c1-7e1a-7b3c-8d4e-5f6a7b8c9d0e";

fn scratch(name: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR"))
        .join("mdbn-takeover-takeover")
        .join(name);
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn sql(rel: &str) -> String {
    fs::read_to_string(Path::new(FIX).join(rel)).unwrap()
}

fn conn(p: &Path) -> Connection {
    let c = Connection::open(p).unwrap();
    c.execute_batch("PRAGMA synchronous = OFF; PRAGMA journal_mode = MEMORY;")
        .unwrap();
    c
}

/// A beta.104+ state directory (connector schema 3, authority v5) for one collection
/// at `root`, with a record ID, a grant, one completed mutation with a stored receipt,
/// and one prepared (never acknowledged) mutation.
fn state_dir(dir: &Path, root: &Path) {
    let c = conn(&dir.join("connector.sqlite"));
    for f in [
        "0001_beta28_baseline.sql",
        "0002_durable_mutation_journal.sql",
        "0003_isolated_authority_cleanup.sql",
    ] {
        c.execute_batch(&sql(f)).unwrap();
    }
    c.pragma_update(None, "user_version", 3).unwrap();
    c.execute(
        "INSERT INTO collections (id, path, display_name, spec_version) VALUES (?1, ?2, 'Notes', '0.2.0')",
        [CID, root.to_str().unwrap()],
    )
    .unwrap();
    c.execute(
        "INSERT INTO local_sync_collections (collection_id, resource_revision) VALUES (?1, 'r')",
        [CID],
    )
    .unwrap();
    c.execute(
        "INSERT INTO local_sync_records (collection_id, record_id, path, revision, record) VALUES (?1, ?2, 'a.md', ?3, '{}')",
        [CID, RID, &revision_of(b"A1")],
    )
    .unwrap();
    drop(c);

    let a = conn(&dir.join("authority.sqlite"));
    for (i, f) in [
        "authority/0001_initial.sql",
        "authority/0002_legacy_read_receipts.sql",
        "authority/0003_policy_freshness_lease.sql",
        "authority/0004_application_declaration.sql",
        "authority/0005_local_runtime_claims.sql",
    ]
    .iter()
    .enumerate()
    {
        a.execute_batch(&sql(f)).unwrap();
        a.execute(
            "INSERT INTO authority_schema_migrations (version, name, checksum, applied_at_ms) VALUES (?1, ?2, 'x', 0)",
            rusqlite::params![i as i64 + 1, f],
        )
        .unwrap();
    }
    a.execute(
        "INSERT INTO grants (id, application_id, collection_id, operations, scope, application_name,
           application_distribution, application_homepage, application_origin, collection_name,
           notification_criteria, application_authorization, created_at)
         VALUES ('g1', 'app', ?1, '[]', '{}', 'App', 'web', '', '', 'Notes', '[]', '{}', 'now')",
        [CID],
    )
    .unwrap();
    let body = b"{\"protocol_version\":3,\"ciphertext\":\"opaque\"}";
    let digest = &revision_of(body)["sha256:".len()..];
    let rdir = dir.join("authority-receipts").join(&digest[..2]);
    fs::create_dir_all(&rdir).unwrap();
    fs::write(rdir.join(format!("{}.receipt", &digest[2..])), body).unwrap();
    for (req, state, receipt) in [
        (
            "done",
            "completed",
            Some(format!("receipt-v1:sha256:{digest}:{}", body.len())),
        ),
        ("inflight", "prepared", None),
    ] {
        let terminal = state == "completed";
        a.execute(
            "INSERT INTO mutation_journal (application_installation_id, grant_id, request_id,
               operation_kind, input_schema_version, input_digest, state, process_epoch,
               lease_owner, lease_expires_at_ms, fencing_generation, final_receipt,
               receipt_digest, grant_snapshot_digest, accepted_at_ms, updated_at_ms,
               completed_at_ms)
             VALUES ('inst', 'g1', ?1, 'records.update', 1, 'd', ?2, 'e', 'o', 0, 1, ?3, ?4, 'g',
               1, 1, ?5)",
            rusqlite::params![
                req,
                state,
                receipt,
                terminal.then_some("x"),
                terminal.then_some(2i64)
            ],
        )
        .unwrap();
    }
}

/// The folder: a.md mid-commit in an old runtime transaction (still at A1, intended A2).
fn folder(root: &Path) {
    fs::create_dir_all(root.join(".mdbase/transactions")).unwrap();
    fs::write(root.join("a.md"), b"A1").unwrap();
    fs::write(root.join("b.md"), b"B").unwrap();
    let id = "11111111111111111111111111111111";
    let t = root.join(".mdbase/transactions").join(id);
    fs::create_dir_all(t.join("stage")).unwrap();
    fs::write(t.join("stage/0"), b"A2").unwrap();
    fs::write(
        t.join("journal.json"),
        serde_json::json!({
            "version": 4, "id": id, "scope": "records", "phase": "committing", "applied": 0,
            "entries": [{"path": "a.md", "before_revision": revision_of(b"A1"),
                "after_revision": revision_of(b"A2"), "stage_file": "stage/0",
                "backup_file": "backup/0"}],
            "host_claim": "ab".repeat(32), "mutation_digest": "sha256:00",
            "change_descriptor": {"schema_version": 1, "count": 0, "digest": "x"},
            "changes": [], "event_id": "e", "generation": null, "watermark": null,
            "resolution_acked": false, "event_acked": false})
        .to_string(),
    )
    .unwrap();
}

#[derive(Default)]
struct Old(u32);
impl OldService for Old {
    fn stop_and_disable(&mut self) -> Result<(), String> {
        self.0 += 1;
        Ok(())
    }
}

#[derive(Default)]
struct FakeDaemon {
    imports: Vec<Import>,
    registered: Vec<String>,
    published: Vec<String>,
    race: bool,
    fail_register_once: bool,
    fail_publish: bool,
}
impl Daemon for FakeDaemon {
    fn store_id(&mut self, _: &str) -> String {
        STORE.into()
    }
    fn publish_guarded(
        &mut self,
        root: &Path,
        path: &str,
        if_revision: Option<&str>,
        bytes: Option<&[u8]>,
    ) -> Result<Published, String> {
        if self.fail_publish {
            return Err("test publisher I/O failure".into());
        }
        // A guarded publish: refuse unless the file still has `if_revision`.
        if self.race {
            // The user saves between the takeover's check and this publish.
            fs::write(root.join(path), b"user saved during takeover").unwrap();
        }
        let current = fs::read(root.join(path)).ok().map(|b| revision_of(&b));
        if current.as_deref() != if_revision {
            return Ok(Published::Changed);
        }
        match bytes {
            Some(b) => fs::write(root.join(path), b).map_err(|e| e.to_string())?,
            None => fs::remove_file(root.join(path)).map_err(|e| e.to_string())?,
        }
        self.published.push(path.into());
        Ok(Published::Done)
    }
    fn hold(&mut self, _: &Path, path: &str, _: Option<&[u8]>, _: &str) -> Result<(), String> {
        self.published.push(format!("held:{path}"));
        Ok(())
    }
    fn import(&mut self, import: &Import) -> Result<(), String> {
        self.imports.push(import.clone());
        Ok(())
    }
    fn register(&mut self, _: &Path, c: &str) -> Result<(), String> {
        if std::mem::take(&mut self.fail_register_once) {
            return Err("interrupted after marker publication".into());
        }
        self.registered.push(c.into());
        Ok(())
    }
}

fn sha(p: &Path) -> String {
    revision_of(&fs::read(p).unwrap())
}

#[test]
fn publisher_io_error_is_not_downgraded_to_hold_or_success() {
    let base = scratch("publisher-error");
    let state = base.join("state");
    let root = base.join("notes");
    fs::create_dir_all(&state).unwrap();
    folder(&root);
    state_dir(&state, &root);
    let mut daemon = FakeDaemon {
        fail_publish: true,
        ..Default::default()
    };
    let result = takeover::take_over(
        &state,
        CID,
        &base.join("evidence"),
        Claim {
            claimed_at: "2026-10-08T13:00:00Z",
            notice: "notice",
        },
        Options::PRODUCTION,
        &mut Old::default(),
        &mut daemon,
    );
    assert!(
        result
            .unwrap_err()
            .to_string()
            .contains("test publisher I/O failure")
    );
    assert_eq!(fs::read(root.join("a.md")).unwrap(), b"A1");
    assert_eq!(marker::read(&root).unwrap(), Marker::Absent);
    assert!(daemon.published.is_empty());
    assert!(daemon.imports.is_empty());
    assert!(daemon.registered.is_empty());
}

#[test]
fn takes_over_settles_imports_and_claims_last() {
    let base = scratch("ok");
    let (state, root, evidence) = (
        base.join("state"),
        base.join("notes"),
        base.join("evidence"),
    );
    fs::create_dir_all(&state).unwrap();
    folder(&root);
    state_dir(&state, &root);
    let db_before = (
        sha(&state.join("connector.sqlite")),
        sha(&state.join("authority.sqlite")),
    );

    let (mut old, mut d) = (Old::default(), FakeDaemon::default());
    let out = takeover::take_over(
        &state,
        CID,
        &evidence,
        Claim {
            claimed_at: "2026-10-04T01:30:00Z",
            notice: "notice",
        },
        Options::PRODUCTION,
        &mut old,
        &mut d,
    )
    .unwrap();
    let Outcome::TakenOver(report) = out else {
        panic!("{out:?}")
    };

    // T4: the committing transaction was rolled forward through the guarded publish.
    assert_eq!(
        report.settled,
        vec![Settled::RolledForward {
            path: "a.md".into(),
            transaction: "11111111111111111111111111111111".into()
        }]
    );
    assert_eq!(fs::read(root.join("a.md")).unwrap(), b"A2");
    assert_eq!(fs::read(root.join("b.md")).unwrap(), b"B", "untouched");

    // T5: the import.
    let imp = &d.imports[0];
    assert_eq!(imp.record_ids[0].record_id, RID);
    assert_eq!(imp.grants.grants.len(), 1);
    let by = |r: &str| {
        &imp.receipts
            .iter()
            .find(|(row, _)| row.request_id == r)
            .unwrap()
            .1
    };
    assert!(
        matches!(by("done"), ReceiptImport::Receipt(b) if b.starts_with(b"{\"protocol_version\":3"))
    );
    assert_eq!(by("inflight"), &ReceiptImport::OutcomeUnknown);
    assert_eq!(report.receipts_unreadable, 0);

    // T6: the marker is ours and old readers can't use it.
    assert_eq!(
        marker::read(&root).unwrap(),
        Marker::Claimed {
            collection: CID.into(),
            replica_id: STORE.into()
        }
    );
    let text = fs::read_to_string(root.join(".mdbase/connect-role.json")).unwrap();
    assert!(!text.contains("collection_id"));
    assert_eq!(d.registered, vec![CID.to_owned()]);

    // Evidence was copied, and the old state files are unchanged.
    assert!(evidence.join("state/connector.sqlite").is_file());
    assert!(evidence.join("folder/.mdbase/transactions").is_dir());
    assert_eq!(
        db_before,
        (
            sha(&state.join("connector.sqlite")),
            sha(&state.join("authority.sqlite"))
        )
    );

    // Re-running is an idempotent registration/durability retry, with no re-import.
    let again = takeover::take_over(
        &state,
        CID,
        &evidence,
        Claim {
            claimed_at: "t",
            notice: "n",
        },
        Options::default(),
        &mut old,
        &mut d,
    )
    .unwrap();
    assert_eq!(again, Outcome::AlreadyTakenOver);
}

#[test]
fn resumes_after_marker_publication_before_registration() {
    let base = scratch("registration-resume");
    let (state, root, evidence) = (
        base.join("state"),
        base.join("notes"),
        base.join("evidence"),
    );
    fs::create_dir_all(&state).unwrap();
    folder(&root);
    state_dir(&state, &root);
    let (mut old, mut daemon) = (
        Old::default(),
        FakeDaemon {
            fail_register_once: true,
            ..FakeDaemon::default()
        },
    );
    let mut run = || {
        takeover::take_over(
            &state,
            CID,
            &evidence,
            Claim {
                claimed_at: "t",
                notice: "n",
            },
            Options::default(),
            &mut old,
            &mut daemon,
        )
    };
    assert!(run().is_err());
    assert!(matches!(
        marker::read(&root).unwrap(),
        Marker::Claimed { .. }
    ));
    assert_eq!(run().unwrap(), Outcome::AlreadyTakenOver);
    assert_eq!(daemon.imports.len(), 1);
    assert_eq!(daemon.registered, [CID]);
    assert_eq!(old.0, 1);
}

#[test]
fn postpones_while_the_old_daemon_holds_its_lock() {
    let base = scratch("postponed");
    let (state, root, evidence) = (
        base.join("state"),
        base.join("notes"),
        base.join("evidence"),
    );
    fs::create_dir_all(&state).unwrap();
    folder(&root);
    state_dir(&state, &root);
    // "The old daemon" is still running: it holds daemon.lock.
    let _alive = mdbn_legacy::lock::try_exclusive(&mdbn_legacy::lock::daemon_lock_path(&state))
        .unwrap()
        .unwrap();
    let (mut old, mut d) = (Old::default(), FakeDaemon::default());
    let out = takeover::take_over(
        &state,
        CID,
        &evidence,
        Claim {
            claimed_at: "t",
            notice: "n",
        },
        Options::default(),
        &mut old,
        &mut d,
    )
    .unwrap();
    assert!(matches!(out, Outcome::Postponed(_)), "{out:?}");
    assert_eq!(
        marker::read(&root).unwrap(),
        Marker::Absent,
        "no fence over a live daemon"
    );
    assert_eq!(
        fs::read(root.join("a.md")).unwrap(),
        b"A1",
        "nothing settled"
    );
    assert!(d.imports.is_empty());
}

#[test]
fn diverged_entries_are_held_not_overwritten() {
    let base = scratch("diverged");
    let (state, root, evidence) = (
        base.join("state"),
        base.join("notes"),
        base.join("evidence"),
    );
    fs::create_dir_all(&state).unwrap();
    folder(&root);
    state_dir(&state, &root);
    fs::write(root.join("a.md"), b"user edited meanwhile").unwrap();
    let (mut old, mut d) = (Old::default(), FakeDaemon::default());
    let Outcome::TakenOver(r) = takeover::take_over(
        &state,
        CID,
        &evidence,
        Claim {
            claimed_at: "t",
            notice: "n",
        },
        Options::default(),
        &mut old,
        &mut d,
    )
    .unwrap() else {
        panic!()
    };
    assert!(matches!(&r.settled[..], [Settled::Held { path, .. }] if path == "a.md"));
    assert_eq!(
        fs::read(root.join("a.md")).unwrap(),
        b"user edited meanwhile"
    );
}

#[test]
fn refuses_mirror_folders() {
    let base = scratch("mirror");
    let (state, root, evidence) = (
        base.join("state"),
        base.join("notes"),
        base.join("evidence"),
    );
    fs::create_dir_all(&state).unwrap();
    folder(&root);
    state_dir(&state, &root);
    fs::write(
        root.join(".mdbase/connect-role.json"),
        format!(r#"{{"version":1,"role":"mirror","collection_id":"{CID}"}}"#),
    )
    .unwrap();
    let (mut old, mut d) = (Old::default(), FakeDaemon::default());
    assert!(
        takeover::take_over(
            &state,
            CID,
            &evidence,
            Claim {
                claimed_at: "t",
                notice: "n"
            },
            Options::default(),
            &mut old,
            &mut d
        )
        .is_err()
    );
    assert_eq!(old.0, 0, "refused before stopping anything");
}

#[test]
fn roll_forward_is_off_by_default_and_holds_instead() {
    let base = scratch("default-off");
    let (state, root, evidence) = (
        base.join("state"),
        base.join("notes"),
        base.join("evidence"),
    );
    fs::create_dir_all(&state).unwrap();
    folder(&root);
    state_dir(&state, &root);
    let (mut old, mut d) = (Old::default(), FakeDaemon::default());
    let Outcome::TakenOver(r) = takeover::take_over(
        &state,
        CID,
        &evidence,
        Claim {
            claimed_at: "t",
            notice: "n",
        },
        Options::default(),
        &mut old,
        &mut d,
    )
    .unwrap() else {
        panic!()
    };
    assert_eq!(
        r.settled,
        vec![Settled::Held {
            path: "a.md".into(),
            reason: takeover::ROLL_FORWARD_DISABLED.into()
        }]
    );
    assert_eq!(
        fs::read(root.join("a.md")).unwrap(),
        b"A1",
        "no Markdown written"
    );
    assert_eq!(d.published, vec!["held:a.md".to_owned()]);
}

#[test]
fn production_roll_forward_keeps_the_guard() {
    let base = scratch("race");
    let (state, root, evidence) = (
        base.join("state"),
        base.join("notes"),
        base.join("evidence"),
    );
    fs::create_dir_all(&state).unwrap();
    folder(&root);
    state_dir(&state, &root);
    let (mut old, mut d) = (
        Old::default(),
        FakeDaemon {
            race: true,
            ..FakeDaemon::default()
        },
    );
    let Outcome::TakenOver(r) = takeover::take_over(
        &state,
        CID,
        &evidence,
        Claim {
            claimed_at: "t",
            notice: "n",
        },
        Options::PRODUCTION,
        &mut old,
        &mut d,
    )
    .unwrap() else {
        panic!()
    };
    assert_eq!(
        r.settled,
        vec![Settled::Held {
            path: "a.md".into(),
            reason: takeover::CHANGED_DURING_ROLL_FORWARD.into()
        }]
    );
    assert_eq!(
        fs::read(root.join("a.md")).unwrap(),
        b"user saved during takeover"
    );
}
