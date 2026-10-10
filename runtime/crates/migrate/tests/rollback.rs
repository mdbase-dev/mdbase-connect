//! Hosted rollback (hosted rollback; local rollback is tested in
//! `mdbn-takeover`) against fakes of the external parties, a
//! real folder, and the replica's reference `MemStore`.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, missing_docs)]

use mdbn_migrate::ids;
use mdbn_migrate::rollback::{self, HostedPhase, LegacyControl, LegacyWriter, NewLog, ReverseOp};
use mdbn_migrate::shadow::Expected;
use mdbn_replica::mem::MemStore;
use mdbn_replica::store::{Head, RecordMeta, RecordRow, Store, Tx, bucket16};
use mdbn_wire::common::Uuid;

const CID: &str = "4c18af2e-b04a-4b77-b83e-493c3695962e";
const REP: &str = "0b9f3e7a-3c51-4a8e-9d2f-6e1b2c3d4e5f";
const OTHER: &str = "11111111-2222-4333-8444-555555555555";

// ---- hosted ----

fn id(n: u8) -> Uuid {
    ids::uuid(&format!("0192f0c1-7e1a-7b3c-8d4e-0000000000{n:02x}")).unwrap()
}

fn row(n: u8, path: &str, doc: &str) -> RecordRow {
    RecordRow {
        id: id(n),
        path: path.into(),
        path_key: path.into(),
        doc: doc.into(),
        revision: mdbn_wire::hash::sha256(doc.as_bytes()),
        modified_seq: 0,
        bucket: bucket16(&id(n)),
        meta: RecordMeta::default(),
    }
}

/// The legacy collection, as rows the provider would hold.
#[derive(Default)]
struct Legacy {
    state: Expected,
    collection_state: String,
    unrevoked: Vec<String>,
    applied: Vec<ReverseOp>,
    drop_writes: bool,
}

impl LegacyControl for Legacy {
    fn set_state(&mut self, _: &str, s: &str) -> Result<(), String> {
        self.collection_state = s.into();
        Ok(())
    }
    fn unrevoke(&mut self, r: &[String]) -> Result<(), String> {
        self.unrevoked.extend_from_slice(r);
        Ok(())
    }
}

impl LegacyWriter for Legacy {
    fn apply(&mut self, _: &str, op: &ReverseOp) -> Result<(), String> {
        self.applied.push(op.clone());
        if self.drop_writes {
            return Ok(());
        }
        match op {
            ReverseOp::PutRecord { id, path, doc } => {
                self.state
                    .records
                    .insert(*id, (path.clone(), mdbn_wire::hash::sha256(doc.as_bytes())));
            }
            ReverseOp::DeleteRecord(id) => {
                self.state.records.remove(id);
            }
            ReverseOp::PutResource { path, text } => {
                self.state
                    .resources
                    .insert(path.clone(), mdbn_wire::hash::sha256(text.as_bytes()));
            }
            ReverseOp::DeleteResource(p) => {
                self.state.resources.remove(p);
            }
            ReverseOp::PutFile { .. } | ReverseOp::DeleteFile(_) => {}
        }
        Ok(())
    }
    fn read(&mut self, _: &str) -> Result<Expected, String> {
        Ok(self.state.clone())
    }
}

#[derive(Default)]
struct Log {
    frozen: bool,
    deleted: bool,
}
impl NewLog for Log {
    fn freeze_and_settle(&mut self, _: &Uuid) -> Result<(), String> {
        self.frozen = true;
        Ok(())
    }
    fn delete(&mut self, _: &Uuid) -> Result<(), String> {
        self.deleted = true;
        Ok(())
    }
}

/// Legacy at cutover: records 1 and 2. The new log since then: 1 edited, 2 deleted,
/// 3 created, a resource changed.
fn after_cutover() -> (Legacy, MemStore) {
    let mut legacy = Legacy::default();
    for r in [row(1, "a.md", "A"), row(2, "b.md", "B")] {
        legacy.state.records.insert(r.id, (r.path, r.revision));
    }
    legacy.state.resources.insert(
        "mdbase.yaml".into(),
        mdbn_wire::hash::sha256(b"spec_version: 0.2.0\n"),
    );
    legacy.collection_state = "migrated".into();
    let mut store = MemStore::new();
    store
        .commit(Tx {
            clear_confirmed: true,
            head: Some(Head::GENESIS),
            records_put: vec![row(1, "a.md", "A edited"), row(3, "c.md", "C")],
            resources_put: vec![("mdbase.yaml".into(), "spec_version: 0.3.0\n".into())],
            ..Tx::default()
        })
        .unwrap();
    (legacy, store)
}

#[test]
fn hosted_rollback_after_cutover_replays_and_reverse_verifies() {
    let (mut legacy, store) = after_cutover();
    let mut writer = std::mem::take(&mut legacy);
    let mut log = Log::default();
    let revoked = vec![REP.to_owned()];
    // One value plays both roles, as the provider does.
    let report = rollback::rollback_hosted(
        CID,
        HostedPhase::AfterCutover,
        &revoked,
        &store,
        &mut Legacy::default(),
        &mut writer,
        &mut log,
    )
    .unwrap();
    assert_eq!(report.applied, 4);
    assert!(log.frozen && !log.deleted, "the new log is kept, frozen");
    // Deletes are applied first.
    assert_eq!(writer.applied[0], ReverseOp::DeleteRecord(id(2)));
    assert!(writer.applied.contains(&ReverseOp::PutRecord {
        id: id(3),
        path: "c.md".into(),
        doc: "C".into()
    }));
}

#[test]
fn hosted_rollback_keeps_legacy_closed_when_reverse_verify_fails() {
    let (mut legacy, store) = after_cutover();
    legacy.drop_writes = true;
    let mut control = Legacy::default();
    let mut log = Log::default();
    let err = rollback::rollback_hosted(
        CID,
        HostedPhase::AfterCutover,
        &[REP.to_owned()],
        &store,
        &mut control,
        &mut legacy,
        &mut log,
    );
    assert!(err.is_err());
    assert!(control.unrevoked.is_empty());
    assert_ne!(control.collection_state, "active");
}

#[test]
fn hosted_rollback_before_cutover_discards_the_new_log() {
    let mut control = Legacy::default();
    let mut writer = Legacy::default();
    let mut log = Log::default();
    let store = MemStore::new();
    let revoked = vec![REP.to_owned(), OTHER.to_owned()];
    let r = rollback::rollback_hosted(
        CID,
        HostedPhase::BeforeCutover,
        &revoked,
        &store,
        &mut control,
        &mut writer,
        &mut log,
    )
    .unwrap();
    assert_eq!(r.unrevoked, 2);
    assert_eq!(control.unrevoked, revoked);
    assert_eq!(control.collection_state, "active");
    assert!(log.deleted);
    assert!(writer.applied.is_empty());
}
