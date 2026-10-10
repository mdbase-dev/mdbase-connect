//! Intent planning: `plan(mutation, state) -> result or rejection`.
//!
//! [`plan`] is the single implementation of "execute this write against this
//! state" (`intent.md`, `log-entry.md` §2–§5). The same function runs:
//! - **optimistically** at the origin's local view ([`Stage::Submit`]);
//! - **authoritatively** by the writer at the exact log head ([`Stage::Head`]);
//! - to **re-plan** pending work after a rebase or a lost append race (the
//!   mutation is unchanged: same clock and seed);
//! - to **verify** a foreign entry at its position ([`Stage::Head`]; compare the
//!   [`Planned`] with the recorded result as resolved values).
//!
//! Every input is the mutation or the [`StateView`] at the planning position.
//! Nothing reads a clock, entropy, the environment or a hash-map iteration
//! order, so equal inputs give equal outputs natively and in WASM.
//!
//! **Validation tiers** (`intent.md` §6):
//! - request/safety checks reject at every stage ([`RejectCode::InvalidRequest`],
//!   [`RejectCode::Conflict`], [`RejectCode::CollectionInvalid`]);
//! - single-record issues reject only at [`Stage::Submit`] with level `error`
//!   ([`RejectCode::InvalidRecord`]); at head they are reported in
//!   [`Planned::issues`];
//! - cross-record issues are never planned here; read them with
//!   [`crate::validate::cross_record_issues`].
//!
//! **Batches.** A writer plans several mutations against one head: plan the
//! first against the state, apply its [`Planned`] to a
//! [`crate::state::Overlay`], plan the next against the overlay, and so on.
//! A mutation with [`Planned::ends_batch`] (a resource write) must be the last
//! in its batch (`log-entry.md` §3.1).

// A rejection is the cold path and carries diagnostics; boxing it would only
// complicate every caller.
#![allow(clippy::result_large_err)]

use crate::ids::{FileId, Hash, RecordId, Uuid};
use crate::intent::{AttachmentContentV1, BlobRef, FileContent, FileInclusion, Level, Mutation};
use crate::semantics::{SEM, Sem};
use crate::state::StateView;

pub mod admission;
pub mod frontmatter_admission;
mod planner;
mod records;
mod request;
mod resources;
use crate::validate::Issue;
use crate::value::Value;

/// Where the plan runs; decides which checks reject (`intent.md` §6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    /// The origin's optimistic plan at its local view. Single-record issues
    /// reject when `level` is `error`. S-class checks reject when visible
    /// locally.
    Submit {
        /// The validation level in force for this submit.
        level: Level,
    },
    /// The writer's plan at the exact log head, or a verifier's re-execution.
    /// Single-record issues never reject.
    Head,
    /// Re-planning a write that was **acknowledged** and then lost from the
    /// log (lost-tail fallback). Never rejects. S-class
    /// checks resolve deterministically instead:
    /// - a taken path (explicit create path, rename target, file path) gets
    ///   the collision rule's suffixed path, reported as `record_renamed`;
    /// - a stale `if_revision` / `base_revision` / `must_not_exist` is ignored:
    ///   field changes still merge against their `base` (status `merged`), a
    ///   delete becomes superseded (`conflicted`, delete conflict), a file put
    ///   records a file conflict;
    /// - a rename whose `from` is stale moves the record from where it is;
    /// - an update of a deleted record recreates it from the tombstone and
    ///   records the delete as a conflict (`conflicted`);
    /// - a body conflict keeps the current body and records it;
    /// - `unique.enforce: write`, lifecycle and membership failures and an
    ///   invalid catalog or resource are applied and reported in
    ///   [`Planned::issues`];
    /// - `conflict_mode: reject` behaves as `record`;
    /// - Ordinary-file promotion is not replayed: it leaves the current holder
    ///   intact and reports `ordinary_file_promotion_requires_setup`. A fresh
    ///   explicit setup/capture must re-assess the current file.
    ///
    /// Only the replica uses it, for its own restored pending rows; verifiers
    /// re-execute entries carrying `resurrect` with it. Clients never set it.
    Resurrect,
}

/// Options for [`plan`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlanOptions {
    /// Submit or head.
    pub stage: Stage,
}

/// Outcome status of an accepted mutation (`log-entry.md` §2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Status {
    /// Applied as asked.
    Applied,
    /// Applied with an automatic merge against a concurrent change.
    Merged,
    /// Partly applied; a concurrent change kept some values (see conflicts).
    Conflicted,
}

/// One effect: the complete result, applicable with no semantics
/// (`log-entry.md` §2.1). Texts are resolved strings.
#[derive(Debug, Clone, PartialEq)]
pub enum Effect {
    /// Create, change, move (path differs) or resurrect a record.
    PutRecord {
        /// Record ID.
        id: RecordId,
        /// Its path after this effect.
        path: String,
        /// The exact new document bytes.
        doc: String,
    },
    /// Remove a record, leaving a tombstone with its last document.
    RemoveRecord {
        /// Record ID.
        id: RecordId,
        /// The path it had.
        path: String,
    },
    /// Create, replace or move a file.
    PutFile {
        /// File ID.
        id: FileId,
        /// Path after this effect.
        path: String,
        /// Content.
        blob: BlobRef,
    },
    /// Create, replace or move a critical attachment file.
    PutAttachmentFile {
        /// Stable File ID (the same namespace as legacy files).
        id: FileId,
        /// Exact path after this effect.
        path: String,
        /// Signed whole-file content, verified by the replica before runtime use.
        content: AttachmentContentV1,
    },
    /// Install a complete unindexed oversized Markdown file (`intent.md` §3.10).
    /// Atomically removes a live record with the same ID (an Op15 transition)
    /// without a record tombstone; replaces a file of the same kind in place.
    PutUnindexedMarkdown {
        /// Stable ID (a record's ID on a transition).
        id: FileId,
        /// Exact record-extension path after this effect.
        path: String,
        /// Signed content, verified by the replica before runtime use.
        content: FileContent,
    },
    /// Install the resolved record source and atomically remove the unindexed
    /// oversized Markdown file with the same ID, without a file tombstone.
    ReindexUnindexedMarkdown {
        /// Stable ID (the file's ID).
        id: RecordId,
        /// Exact path, unchanged.
        path: String,
        /// The exact new document bytes.
        doc: String,
    },
    /// Install the exact record source and atomically remove the Ordinary file
    /// holder of the same ID, without changing any tombstone.
    ReindexOrdinaryFile {
        /// Existing file ID, retained as the record ID.
        id: RecordId,
        /// Exact path, unchanged.
        path: String,
        /// Exact source bound to the prior plaintext hash and length.
        doc: String,
    },
    /// Remove a file, leaving a tombstone with its complete typed content.
    RemoveFile {
        /// File ID.
        id: FileId,
        /// The path it had.
        path: String,
    },
    /// Write a resource.
    PutResource {
        /// Resource path.
        path: String,
        /// The exact new source.
        doc: String,
    },
    /// Remove a resource.
    RemoveResource {
        /// Resource path.
        path: String,
    },
    /// Set the file inclusion policy.
    PutSettings(FileInclusion),
}

/// An alias: the old path now refers to the record (`log-entry.md` §2.3).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Alias {
    /// The old path, as written.
    pub path: String,
    /// The record it refers to.
    pub id: RecordId,
}

/// Conflict kinds (`log-entry.md` §2.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ConflictKind {
    /// One top-level frontmatter field.
    Field,
    /// The whole frontmatter block.
    Frontmatter,
    /// The body (external edits only; api body conflicts reject).
    Body,
    /// The path.
    Path,
    /// A superseded delete.
    Delete,
    /// Concurrent binary content.
    File,
}

/// One side of a recorded conflict (`log-entry.md` §2.4).
#[derive(Debug, Clone, PartialEq)]
pub enum ConflictValue {
    /// The key was missing.
    Missing,
    /// A frontmatter value.
    Value(Value),
    /// A text: frontmatter source, body or path.
    Text(String),
    /// Legacy file content.
    Blob(BlobRef),
    /// Retained critical attachment content, never a fabricated BlobRef.
    Attachment(AttachmentContentV1),
    /// Retained unindexed oversized Markdown content (kind and content together).
    UnindexedMarkdown(FileContent),
    /// Deleted.
    Deleted,
}

/// A recorded conflict. The record holds `kept`; `lost` is what this
/// mutation wanted and did not get.
#[derive(Debug, Clone, PartialEq)]
pub struct RecordedConflict {
    /// Kind.
    pub kind: ConflictKind,
    /// Record or file ID.
    pub id: Uuid,
    /// The top-level key, for [`ConflictKind::Field`].
    pub field: Option<String>,
    /// The base value, when known.
    pub base: Option<ConflictValue>,
    /// What the record now holds.
    pub kept: ConflictValue,
    /// What this mutation lost.
    pub lost: ConflictValue,
}

/// A base body the planner obtained from retained state (not from the
/// mutation). The writer MUST copy it into the op's `body_base_text` before
/// sealing, so verifiers can re-execute (`intent.md` §3.2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BaseTextFill {
    /// Index of the `update` op in `mutation.ops`.
    pub op_index: u32,
    /// The base body.
    pub text: String,
}

/// A reported (non-blocking) issue on one record touched by the mutation.
#[derive(Debug, Clone, PartialEq)]
pub struct RecordIssue {
    /// The record.
    pub id: RecordId,
    /// The issue.
    pub issue: Issue,
}

/// The result of planning an accepted mutation: what the entry records.
#[derive(Debug, Clone, PartialEq)]
pub struct Planned {
    /// The semantics version planned under (always [`SEM`]).
    pub sem: Sem,
    /// Applied, merged or conflicted.
    pub status: Status,
    /// Effects, in application order.
    pub effects: Vec<Effect>,
    /// Recorded conflicts (non-empty iff `status` is `Conflicted`).
    pub conflicts: Vec<RecordedConflict>,
    /// Aliases created (renames and moves).
    pub aliases: Vec<Alias>,
    /// Base bodies the writer must copy into the mutation.
    pub base_text_fills: Vec<BaseTextFill>,
    /// Reported single-record issues of written records (never blocking here).
    pub issues: Vec<RecordIssue>,
    /// The mutation writes a resource: it ends the writer's planning batch.
    pub ends_batch: bool,
    /// Keys the plan read or wrote, for the pending queue's rebase index:
    /// `i:<id>` for records and files, `p:<path key>` for paths, `r:<path>`
    /// for resources. Sorted, deduplicated.
    pub touches: Vec<String>,
    /// Links this mutation rewrites (`rename`/`file_move` with `update_refs`),
    /// for preflight dialogs. Derived from the effects; not part of the entry.
    pub link_rewrites: Vec<LinkRewrite>,
    /// Links in other records that resolve to a renamed, moved or deleted
    /// record or file before this mutation and no longer do after it (spec
    /// 08 "broken backlinks"). Computed at [`Stage::Submit`] only (dry runs and
    /// optimistic plans); empty at head. Not part of the entry.
    pub broken_links: Vec<BrokenLink>,
}

/// One rewritten link (spec 12 `references_updated`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkRewrite {
    /// The op that caused it.
    pub op_index: u32,
    /// The referring record.
    pub id: RecordId,
    /// Its path (after the mutation).
    pub path: String,
    /// The frontmatter field holding the link, or `None` for the body.
    pub field: Option<String>,
    /// The link as it was.
    pub old_value: String,
    /// The link as rewritten.
    pub new_value: String,
}

/// A link left unresolved by a mutation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrokenLink {
    /// The op that caused it.
    pub op_index: u32,
    /// The record or file the link used to resolve to.
    pub target: Uuid,
    /// The referring record.
    pub id: RecordId,
    /// Its path.
    pub path: String,
    /// The frontmatter field holding the link, or `None` for the body.
    pub field: Option<String>,
    /// The link as written.
    pub value: String,
}

impl Planned {
    /// An accepted mutation with no effects (for example a no-op delete).
    pub fn noop() -> Planned {
        Planned {
            sem: SEM,
            status: Status::Applied,
            effects: Vec::new(),
            conflicts: Vec::new(),
            aliases: Vec::new(),
            base_text_fills: Vec::new(),
            issues: Vec::new(),
            ends_batch: false,
            touches: Vec::new(),
            link_rewrites: Vec::new(),
            broken_links: Vec::new(),
        }
    }
}

/// Why a mutation was rejected. Maps onto the client API's `problem`
/// (`replica-client-api.md` §9): `code` is the error code, `reason` the
/// finer cause (the spec code).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum RejectCode {
    /// Malformed or unsafe request; request-tier spec codes in `reason`.
    InvalidRequest,
    /// Single-record validation at level `error` (submit), or a resource write
    /// that leaves the config or a type invalid.
    InvalidRecord,
    /// Update of an unknown record (no record, no tombstone).
    NotFound,
    /// The current state does not allow this write: `revision`, `path_taken`,
    /// `duplicate_value`, `body`, `body_base_unavailable`, `renamed`, `field`
    /// (conflict mode `reject`).
    Conflict,
    /// Too many ops, a path or nesting over its limit.
    TooLarge,
    /// The catalog cannot be loaded, so writes cannot be planned.
    CollectionInvalid,
}

impl RejectCode {
    /// The client API error code.
    pub fn as_str(self) -> &'static str {
        match self {
            RejectCode::InvalidRequest => "invalid_request",
            RejectCode::InvalidRecord => "invalid_record",
            RejectCode::NotFound => "not_found",
            RejectCode::Conflict => "conflict",
            RejectCode::TooLarge => "too_large",
            RejectCode::CollectionInvalid => "collection_invalid",
        }
    }
}

/// A rejection. Rejected mutations never enter the log.
#[derive(Debug, Clone, PartialEq)]
pub struct Rejection {
    /// Error code.
    pub code: RejectCode,
    /// Finer cause: a spec code (`path_conflict`, `type_membership_changed`,
    /// `duplicate_batch_path`, ...) or a conflict reason.
    pub reason: Option<String>,
    /// Developer message (not stable).
    pub message: String,
    /// Index of the op that failed, when one did.
    pub op_index: Option<u32>,
    /// Issues (for `invalid_record`).
    pub issues: Vec<Issue>,
    /// Details: the current revision or path for conflicts, limits, ...
    pub details: Option<Value>,
}

impl Rejection {
    /// A rejection with a code, reason and message.
    pub fn new(code: RejectCode, reason: Option<&str>, message: impl Into<String>) -> Rejection {
        Rejection {
            code,
            reason: reason.map(str::to_owned),
            message: message.into(),
            op_index: None,
            issues: Vec::new(),
            details: None,
        }
    }

    /// Attribute the rejection to op `i`.
    pub fn at_op(mut self, i: u32) -> Rejection {
        self.op_index = Some(i);
        self
    }
}

/// Maximum operations per mutation (`log-entry.md` §10).
pub const MAX_OPS: u32 = 1_000;
/// Maximum path length in UTF-8 bytes (`log-entry.md` §10).
pub const MAX_PATH_BYTES: u32 = 1_024;

/// Plan `mutation` against `state`.
///
/// Returns the entry's result, or the rejection. Ops are planned in order
/// against the state left by the previous ones; any rejection rejects the
/// whole mutation (`intent.md` §8).
pub fn plan(
    mutation: &Mutation,
    state: &dyn StateView,
    opts: &PlanOptions,
) -> Result<Planned, Rejection> {
    check_request(mutation)?;
    planner::run(mutation, state, opts)
}

pub use request::check_request;

/// The digest of a body, as `body_base` carries it.
pub fn body_digest(body: &str) -> Hash {
    Hash::of(body.as_bytes())
}
