//! Rollback (migration rollback, release gate 3).
//!
//! **Local** ([`rollback_local`], §6.1, implemented in `mdbn-takeover`): the folder goes back to the old connector.
//! - While the v2 marker still fences the old connector, the control plane durably
//!   rotates grant bindings, the new store is archived, and the old daemon prepares
//!   its refreshed bindings. Every step is idempotent for the rollback identity.
//! - Only then is the marker moved aside and the directory synced, before the old
//!   daemon is re-enabled. A crash cannot reopen the old binding's replay window.
//! - No Markdown and no old state file is written.
//!
//! **Hosted** ([`rollback_hosted`], §6.2):
//! - **Before the cutover policy:** set the legacy collection active again, un-revoke
//!   exactly the replica credentials migration revoked, and delete the new log.
//! - **After it:** freeze the new log, then replay every difference between the
//!   replica's confirmed state and the legacy rows into the legacy collection, through
//!   the provider's own write path, keeping IDs. Then **reverse-verify** (zero
//!   differences required), un-revoke, and set the collection active. The new log is
//!   kept frozen, never deleted, for the retention window.
//!
//! The side effects go through small traits. The control plane, provider, log
//! service, daemon and service manager implement them, and the tests use in-memory
//! fakes. Every step is safe to repeat: a crashed rollback is resumed by running it
//! again.

use mdbn_replica::store::Store;
use mdbn_wire::common::Uuid;
use mdbn_wire::intent::BlobRef;

use crate::shadow::{self, Difference, Expected};
use crate::{Error, Result};

// Local rollback lives in `mdbn-takeover`, which the daemon implements against; it is
// re-exported here so the migrator's public paths keep working.
pub use mdbn_takeover::rollback::{
    LocalControl, LocalReport, NewDaemon, OldDaemon, rollback_local,
};

// ---------------------------------------------------------------------------
// Hosted
// ---------------------------------------------------------------------------

/// The old provider and control plane, as rollback needs them.
pub trait LegacyControl {
    /// Set the legacy collection's provider state (`active`, `migrating`, `migrated`).
    fn set_state(&mut self, collection: &str, state: &str) -> std::result::Result<(), String>;
    /// Un-revoke exactly these replica credentials (`revoked_at = NULL`).
    fn unrevoke(&mut self, replicas: &[String]) -> std::result::Result<(), String>;
}

/// The new log, as rollback needs it.
pub trait NewLog {
    /// Append `policy[freeze true]` and wait until the hosted replica has confirmed
    /// through the head.
    fn freeze_and_settle(&mut self, collection: &Uuid) -> std::result::Result<(), String>;
    /// Delete the log (only before the cutover policy).
    fn delete(&mut self, collection: &Uuid) -> std::result::Result<(), String>;
}

/// One write the reverse export makes to the legacy collection, keeping the ID.
#[derive(Clone, Debug, PartialEq)]
pub enum ReverseOp {
    /// Create or replace a record.
    PutRecord {
        /// Record ID.
        id: Uuid,
        /// Path.
        path: String,
        /// Exact document.
        doc: String,
    },
    /// Delete a record.
    DeleteRecord(Uuid),
    /// Create or replace a file. The writer fetches and opens the blob.
    PutFile {
        /// File ID.
        id: Uuid,
        /// Path.
        path: String,
        /// The sealed blob in the new log.
        blob: BlobRef,
    },
    /// Delete a file.
    DeleteFile(Uuid),
    /// Create or replace a resource.
    PutResource {
        /// Path.
        path: String,
        /// Text.
        text: String,
    },
    /// Delete a resource.
    DeleteResource(String),
}

/// Writes into the legacy collection through the provider's own write path, as
/// maintenance writes on the still non-`active` collection, so the provider seals
/// them under its DEK as usual.
pub trait LegacyWriter {
    /// Apply one op.
    fn apply(&mut self, collection: &str, op: &ReverseOp) -> std::result::Result<(), String>;
    /// Re-read the legacy collection as [`Expected`] (a consistent read).
    fn read(&mut self, collection: &str) -> std::result::Result<Expected, String>;
}

/// Where the migration had got to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostedPhase {
    /// No `migration-cutover` policy appended yet (H0–H8).
    BeforeCutover,
    /// H9 or later: writes may exist only in the new log.
    AfterCutover,
}

/// What a hosted rollback did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostedReport {
    /// Reverse ops applied (after cutover only).
    pub applied: usize,
    /// Credentials un-revoked.
    pub unrevoked: usize,
}

/// Roll a hosted collection back to the old system (§6.2).
///
/// `revoked` is exactly the list from the `migration-cutover` op, or from the H8
/// record before it. `store` is the hosted replica's store for the collection.
pub fn rollback_hosted(
    collection: &str,
    phase: HostedPhase,
    revoked: &[String],
    store: &dyn Store,
    legacy: &mut dyn LegacyControl,
    writer: &mut dyn LegacyWriter,
    log: &mut dyn NewLog,
) -> Result<HostedReport> {
    let cid = crate::ids::uuid(collection)?;
    let mut applied = 0;
    match phase {
        HostedPhase::BeforeCutover => {
            legacy
                .set_state(collection, "active")
                .map_err(step("set the legacy collection active"))?;
            legacy.unrevoke(revoked).map_err(step("un-revoke"))?;
            log.delete(&cid).map_err(step("delete the new log"))?;
        }
        HostedPhase::AfterCutover => {
            log.freeze_and_settle(&cid)
                .map_err(step("freeze the new log"))?;
            let legacy_now = writer.read(collection).map_err(step("read legacy"))?;
            for op in reverse_ops(&legacy_now, store)? {
                writer
                    .apply(collection, &op)
                    .map_err(step("apply a reverse op"))?;
                applied += 1;
            }
            let after = writer.read(collection).map_err(step("re-read legacy"))?;
            let diffs = shadow::verify(&after, store)?;
            if !diffs.is_empty() {
                return Err(Error::Invalid(format!(
                    "reverse verify found {} differences; the legacy collection stays closed",
                    diffs.len()
                )));
            }
            legacy.unrevoke(revoked).map_err(step("un-revoke"))?;
            legacy
                .set_state(collection, "active")
                .map_err(step("set the legacy collection active"))?;
        }
    }
    Ok(HostedReport {
        applied,
        unrevoked: revoked.len(),
    })
}

fn step(what: &'static str) -> impl Fn(String) -> Error {
    move |e| Error::Invalid(format!("{what}: {e}"))
}

/// The writes that make `legacy` equal to `store`'s confirmed state.
pub fn reverse_ops(legacy: &Expected, store: &dyn Store) -> Result<Vec<ReverseOp>> {
    let err = |e| Error::Log(format!("store: {e}"));
    let mut ops = Vec::new();
    for d in shadow::verify(legacy, store)? {
        match d {
            Difference::ExtraRecord(id)
            | Difference::RecordPath(id)
            | Difference::RecordContent(id) => {
                let r = store
                    .record(&id)
                    .map_err(err)?
                    .ok_or_else(|| Error::Log("record vanished".into()))?;
                let op = ReverseOp::PutRecord {
                    id,
                    path: r.path,
                    doc: r.doc,
                };
                if !ops.contains(&op) {
                    ops.push(op);
                }
            }
            Difference::MissingRecord(id) => ops.push(ReverseOp::DeleteRecord(id)),
            Difference::ExtraFile(id) | Difference::FilePath(id) | Difference::FileContent(id) => {
                let f = store
                    .file(&id)
                    .map_err(err)?
                    .ok_or_else(|| Error::Log("file vanished".into()))?;
                let mdbn_wire::attachment::FileContent::Blob(blob) = f.content else {
                    return Err(Error::Invalid(format!(
                        "file {}: attachment content cannot be rolled back yet",
                        mdbn_wire::render::hex(&id.0)
                    )));
                };
                let op = ReverseOp::PutFile {
                    id,
                    path: f.path,
                    blob,
                };
                if !ops.contains(&op) {
                    ops.push(op);
                }
            }
            Difference::MissingFile(id) => ops.push(ReverseOp::DeleteFile(id)),
            Difference::ExtraResource(path) | Difference::ResourceContent(path) => {
                let text = store
                    .resource(&path)
                    .map_err(err)?
                    .ok_or_else(|| Error::Log("resource vanished".into()))?;
                ops.push(ReverseOp::PutResource { path, text });
            }
            Difference::MissingResource(path) => ops.push(ReverseOp::DeleteResource(path)),
        }
    }
    // Deletes first: a record moved onto a path another record vacated must not
    // collide on the legacy side's unique path index.
    ops.sort_by_key(|op| match op {
        ReverseOp::DeleteRecord(_) | ReverseOp::DeleteFile(_) | ReverseOp::DeleteResource(_) => 0,
        _ => 1,
    });
    Ok(ops)
}
