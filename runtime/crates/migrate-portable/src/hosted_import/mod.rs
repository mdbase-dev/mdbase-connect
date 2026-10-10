//! # The hosted import driver (H0–H10), sans-IO
//!
//! One [`Driver`] migrates one hosted Connect collection into its new log, R2
//! snapshot and Durable Object, under the H0–H10 contract
//! (hosted migration design) and the hosted
//! budgets ([`crate::budget`]). It decides **what happens next and when it is safe**.
//! It performs no I/O itself:
//!
//! - **Asynchronous effects** (legacy Postgres/R2 reads, the log service, Connect's
//!   control routes, the DO rebuild) are [`Action`]s. The host performs one, then
//!   hands its [`Outcome`] to [`Driver::complete`].
//! - **Synchronous durable state** goes through the host's [`Spill`]: the
//!   checkpoint plus metadata-only scratch tables. In the Worker this is the DO's
//!   SQLite, which is synchronous and transactional. It never holds keys, document
//!   text or attachment bytes. It holds paths, IDs, hashes and sizes.
//!
//! ## The shape of a migration
//!
//! | Step | What | Restart rule |
//! |---|---|---|
//! | H0 | backup hold + 90-day retention ([`Action::EnsureBackup`]) | idempotent |
//! | H1 | service-create the cloud-copy collection with the legacy ID | idempotent |
//! | H2/H2b | consistent read at `S0`: whole-namespace resolve ([`crate::namespace`]) into the S0 placement table + expected live digest | redo from H2 |
//! | H3/H4 | stream, seal and stage generation 0 from the placements; finish the manifest | redo from H2 |
//! | H4 | append `base` (intent saved first; ambiguity resolved by log evidence) | find, then re-append |
//! | H5 | fresh DO rebuild from the base, then compare its live digest with S0's | redo the compare |
//! | gate | cohort pause gate (an account that has fenced anything keeps going) | re-ask |
//! | H6 | fence legacy (`migrating`), drain accepted pending writes to `S_final` | idempotent |
//! | H7 | consistent read at `S_final`: resolve again into the final placement table + expected digest | redo the read |
//! | H8 | revoke old mirrors/apps, recording their IDs | idempotent |
//! | H9 | append `migration-cutover` (intent first), then replay the S0→S_final diff in budgeted batches with stable mutation IDs | find, then re-append |
//! | F/H10 | barrier F = log head; fresh DO rebuild; live digest must equal S_final's; then route | redo the compare |
//!
//! Before the base append nothing is visible in the new log, so a crash restarts
//! the read with a new `S0` (content-addressed uploads are reused). From the base
//! on, every step is resumable from the checkpoint, and every log append has its
//! intent saved first so a lost reply is settled by log evidence, never by a second
//! effect. The H9 replay is a **state diff**, not an operation replay: each changed
//! entity is brought to its exact `S_final` state, idempotently, under a mutation
//! ID derived from `(collection, S_final, batch)`.
//!
//! **Zero lost acknowledged writes.** Every write Connect acknowledged is in legacy
//! state at `S_final` (H6 drains accepted pending work before `S_final` is fixed),
//! and the cutover is not appended until the `S_final` read is complete. The replay
//! then makes new state equal legacy state at `S_final`, and H10 checks that
//! equality on a cache rebuilt from the log before routing.
//!
//! **Rollback** ([`Driver::rollback`]) is possible until the cutover intent is
//! saved: un-revoke, un-fence, keep the frozen new log as evidence (decision 6A).
//! A failure after that point stops, fail closed, read-only, for an operator.

mod account;
mod checkpoint;
pub mod codec;
mod driver;
mod gen0;
mod read;
mod replay;
mod spill;
#[cfg(any(test, feature = "sql-spill"))]
mod sql_spill;

#[cfg(test)]
mod tests;

pub use account::{
    AccountAction, AccountView, CollectionStatus, CutoverRecord, flip_evidence, may_fence,
    next_account_action,
};
pub use checkpoint::{Checkpoint, Step};
pub use driver::{Action, Driver, Outcome, Wait};
pub use gen0::{ImportStats, bucket_range, bucket16};
pub use replay::{Batch, Effect, park_path};
pub use spill::{MemSpill, Spill};
#[cfg(any(test, feature = "sql-spill"))]
pub use sql_spill::SqlSpill;

/// One row of the S0→`S_final` diff: the key and its S0 and final placements.
pub type DiffRow = (Key, Option<Meta>, Option<Meta>);

use mdbn_wire::common::Hash;

use crate::preflight::EntityKind;

/// Which consistent legacy read a table or page belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Generation {
    /// The import read, at `S0` (collection `active`).
    S0,
    /// The cutover read, at `S_final` (collection `migrating`, drained).
    Final,
}

/// A legacy table.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Table {
    /// Resources (configuration, types), keyed by path.
    Resources,
    /// Records, keyed by ID.
    Records,
    /// Live files, keyed by ID.
    Files,
}

/// The stable identity of a live entity across both reads and the new system: the
/// legacy ID, or the original path of a resource.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Key {
    /// Which namespace.
    pub kind: EntityKind,
    /// Legacy record/file ID, or a resource's original path.
    pub id: String,
}

impl std::fmt::Debug for Key {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.kind {
            EntityKind::Resource => f.write_str("Key(resource, [redacted])"),
            k => write!(f, "Key({}, {})", k.as_str(), self.id),
        }
    }
}

impl Key {
    /// A canonical byte encoding, for mutation IDs and checkpoints.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(1 + self.id.len());
        out.push(self.kind as u8);
        out.extend_from_slice(self.id.as_bytes());
        out
    }

    /// Decode [`Self::to_bytes`].
    pub fn from_bytes(b: &[u8]) -> Option<Key> {
        let (k, id) = b.split_first()?;
        let kind = match k {
            0 => EntityKind::Resource,
            1 => EntityKind::Record,
            2 => EntityKind::File,
            _ => return None,
        };
        Some(Key {
            kind,
            id: String::from_utf8(id.to_vec()).ok()?,
        })
    }
}

/// What a live entity becomes in the new system (decision 4A: new formats only).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Class {
    /// A resource (text).
    Resource,
    /// A synced Markdown record (document at most 1 MiB).
    Record,
    /// An `AttachmentV1` file.
    Attachment,
    /// A document over 1 MiB: an `UnindexedOversizedMarkdown` file at the same path.
    UnindexedMarkdown,
}

/// A placed entity: where it lives and what it holds. Metadata only.
#[derive(Clone, PartialEq, Eq)]
pub struct Meta {
    /// Its class in the new system.
    pub class: Class,
    /// The path in the new system (after renames), or the original path while a
    /// deferred entity waits for pass 2.
    pub path: String,
    /// SHA-256 of the document, resource text or whole file.
    pub content: Hash,
    /// Size in bytes.
    pub size: u64,
}

impl std::fmt::Debug for Meta {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Meta")
            .field("class", &self.class)
            .field("path", &"[redacted]")
            .field("size", &self.size)
            .finish_non_exhaustive()
    }
}

/// One row of a legacy metadata page, as the source reads it: identity, original
/// path, content hash (the legacy revision or `content_digest`) and size. No bytes.
#[derive(Clone, PartialEq, Eq)]
pub struct SourceRow {
    /// Legacy record/file ID; `None` for a resource.
    pub id: Option<String>,
    /// The original path.
    pub path: String,
    /// SHA-256 of the content.
    pub content: Hash,
    /// Size in bytes (UTF-8 document bytes for a record).
    pub size: u64,
}

impl std::fmt::Debug for SourceRow {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SourceRow")
            .field("id", &self.id)
            .field("size", &self.size)
            .finish_non_exhaustive()
    }
}

/// The new-system class of a legacy row from `table`.
pub fn class_of(table: Table, size: u64) -> Class {
    match table {
        Table::Resources => Class::Resource,
        Table::Records if crate::oversize::is_oversize(size) => Class::UnindexedMarkdown,
        Table::Records => Class::Record,
        Table::Files => Class::Attachment,
    }
}

/// The live-digest entity of a placement.
pub(crate) fn live_of<'a>(
    key: &Key,
    meta: &'a Meta,
) -> crate::Result<crate::live_digest::Live<'a>> {
    use crate::live_digest::{FileKind, Live};
    Ok(match meta.class {
        Class::Resource => Live::Resource {
            path: &meta.path,
            content: meta.content,
        },
        Class::Record => Live::Record {
            id: crate::ids::uuid(&key.id)?,
            path: &meta.path,
            revision: meta.content,
            size: meta.size,
        },
        Class::Attachment | Class::UnindexedMarkdown => Live::File {
            id: crate::ids::uuid(&key.id)?,
            path: &meta.path,
            content: meta.content,
            size: meta.size,
            kind: if meta.class == Class::Attachment {
                FileKind::Attachment
            } else {
                FileKind::UnindexedMarkdown
            },
        },
    })
}
