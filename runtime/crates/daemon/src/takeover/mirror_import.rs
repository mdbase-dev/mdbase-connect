//! Edits an old hosted mirror never uploaded: captured at the takeover, then
//! imported into the joined collection as this device's own changes.
//!
//! An old mdbase Connect hosted mirror computes its upload queue from the folder:
//! every Markdown or `.base` file whose bytes differ from the mirror's base
//! (`mdbn_legacy::mirror::queued_writes`). Once the account has moved, that queue
//! can never upload. The takeover used to wait for it to drain, which never
//! happened, and that also held back every local collection on the device.
//!
//! **Capture** ([`capture`], before T1). For each registered mirror, the queue is
//! written to `<legacy>/<collection>/mirror/`:
//! - `bytes/<hex>`: the content of every created or changed file, by SHA-256;
//! - `capture.json`: the queue itself (creates, changes and renames with their
//!   base, deletes), the mirror's base trust, its root and unreceipted mutations.
//!
//! `capture.json` is written last and atomically, so a crash leaves either no
//! capture (the next run captures again) or a complete one. A complete capture is
//! never replaced. The old mirror state and folder are only read: they stay as the
//! original copy, whatever happens to the import.
//!
//! **Import** ([`import`]). Once the collection is registered on this device and
//! serving, each captured edit is planned against the replica's current view
//! ([`plan`]) and applied through the replica as an ordinary write:
//! - an edit whose base is the current version is a `document` operation carrying
//!   that base, so a concurrent change elsewhere goes through the replica's own
//!   merge and conflict recording (intent.md §3.3, `conflict_mode` record);
//! - a delete carries the revision it saw, so a record changed elsewhere keeps the
//!   edit (intent.md §3.4, D8);
//! - an edit to a record deleted elsewhere is recreated (D8: losing an edit is
//!   worse than keeping a deleted record);
//! - a create is a create at its path.
//!
//! Where the base is no longer the current version, the old engine's base text is
//! unknown (the mirror kept only hashes), so no merge is possible: the edit is
//! **held** like a takeover hold (`collection.holds`, reason `unsent_edit`), with
//! the current version in the folder and the unsent one kept for keep both / take
//! it. An edit the replica cannot take (not text, or refused) is **recovered**: a
//! hash-verified file in the durable capture is retained and its path is reported.
//! Recovery never creates a second copy beside a user folder.
//!
//! Progress is `progress.json`. A write's mutation ID is saved there before it is
//! submitted; a retry after a crash reads its receipt back or resubmits under the
//! same ID, and the replica never applies it twice. Every plan also compares bytes
//! first, so an edit already present is recorded as such and not written again.

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};

use mdbn_legacy::mirror::{self, Queued, RegistryEntry};
use mdbn_wire::common::{B16, Text};
use mdbn_wire::intent::{Create, Delete, DocVersion, Document, Op};
use serde::{Deserialize, Serialize};

use super::adapter::Adapter;
use super::held::{self, Outcome};
use crate::fsutil;

/// Schema of `capture.json` and `progress.json`.
pub const SCHEMA_VERSION: u32 = 1;

/// The `HoldSummary.reason` of an unsent edit kept for review.
pub const HOLD_REASON: &str = "unsent_edit";

/// The capture directory of a hosted collection.
pub fn dir(legacy: &Path, collection: &str) -> io::Result<PathBuf> {
    if !held::is_collection_id(collection) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "not a canonical collection ID",
        ));
    }
    Ok(Adapter::collection_dir(legacy, collection).join("mirror"))
}

/// One edit the old mirror had not uploaded.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Edit {
    /// A file with no base entry.
    Create {
        /// Collection-relative path.
        path: String,
        /// SHA-256 hex of the captured bytes (`bytes/<hex>`).
        content: String,
    },
    /// A known record changed, moved, or both.
    Update {
        /// Legacy record ID (kept by the migration).
        record_id: String,
        /// Its path in the mirror's base.
        from: String,
        /// Its path in the folder.
        path: String,
        /// SHA-256 hex of the base bytes.
        base: String,
        /// SHA-256 hex of the captured bytes.
        content: String,
    },
    /// A known record whose file is gone (read-write mirrors only).
    Delete {
        /// Legacy record ID.
        record_id: String,
        /// Its path in the base.
        path: String,
        /// SHA-256 hex of the base bytes.
        base: String,
    },
}

impl Edit {
    /// Stable progress key.
    pub fn key(&self) -> String {
        match self {
            Edit::Create { path, .. } => format!("create:{path}"),
            Edit::Update { record_id, .. } => format!("update:{record_id}"),
            Edit::Delete { record_id, .. } => format!("delete:{record_id}"),
        }
    }

    /// The path the user sees for this edit.
    pub fn path(&self) -> &str {
        match self {
            Edit::Create { path, .. } | Edit::Update { path, .. } | Edit::Delete { path, .. } => {
                path
            }
        }
    }

    /// Changes and renames first, then deletes, then creates: a create may reuse
    /// a path a rename or delete frees.
    fn order(&self) -> u8 {
        match self {
            Edit::Update { .. } => 0,
            Edit::Delete { .. } => 1,
            Edit::Create { .. } => 2,
        }
    }
}

/// A mutation the mirror had sent without a receipt (evidence only; never resent).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Unreceipted {
    /// Original mutation ID.
    pub mutation_id: String,
    /// Record.
    pub record_id: String,
    /// `put` / `move` / `delete`.
    pub operation: String,
    /// Path, when the mutation carried one.
    pub path: Option<String>,
}

/// `capture.json`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Capture {
    /// [`SCHEMA_VERSION`].
    pub schema_version: u32,
    /// Hosted collection ID.
    pub collection_id: String,
    /// The old mirror replica.
    pub replica_id: String,
    /// The old mirror folder (left as it was).
    pub mirror_root: PathBuf,
    /// `read_only` or `read_write`.
    pub mode: String,
    /// The mirror's checkpointed legacy sequence.
    pub cursor: u64,
    /// Whether the mirror's base was complete (`last_completed_plan`, or legacy).
    pub base_trusted: bool,
    /// The folder was missing at capture: nothing local to capture.
    #[serde(default)]
    pub folder_missing: bool,
    /// RFC 3339 capture time.
    pub captured_at: String,
    /// The queue, in import order.
    pub edits: Vec<Edit>,
    /// Unreceipted mutations, kept as evidence.
    pub unreceipted: Vec<Unreceipted>,
}

impl Capture {
    /// Load a complete capture, or `None` when there is none yet.
    pub fn load(legacy: &Path, collection: &str) -> io::Result<Option<Capture>> {
        let Some(b) = fsutil::read_optional(&dir(legacy, collection)?.join("capture.json"))? else {
            return Ok(None);
        };
        let c: Capture = serde_json::from_slice(&b)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "malformed mirror capture"))?;
        if c.schema_version != SCHEMA_VERSION || c.collection_id != collection {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "unsupported mirror capture",
            ));
        }
        Ok(Some(c))
    }

    /// The captured bytes named `hex`, checked against their name.
    pub fn bytes(&self, legacy: &Path, hex: &str) -> io::Result<Vec<u8>> {
        read_bytes(&dir(legacy, &self.collection_id)?, hex)
    }
}

fn bad(what: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, what.to_owned())
}

fn hex_of(bytes: &[u8]) -> String {
    mdbn_legacy::revision_of(bytes)["sha256:".len()..].to_owned()
}

fn valid_hex(hex: &str) -> bool {
    hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit())
}

fn read_bytes(dir: &Path, hex: &str) -> io::Result<Vec<u8>> {
    if !valid_hex(hex) {
        return Err(bad("captured bytes name is not a digest"));
    }
    let bytes = std::fs::read(dir.join("bytes").join(hex))?;
    if hex_of(&bytes) != hex {
        return Err(bad("captured bytes do not match their digest"));
    }
    Ok(bytes)
}

/// Keep `bytes` durably under their digest; an existing copy is checked.
fn keep_bytes(dir: &Path, bytes: &[u8]) -> io::Result<String> {
    let hex = hex_of(bytes);
    let path = dir.join("bytes").join(&hex);
    match read_bytes(dir, &hex) {
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => fsutil::write_atomic(&path, bytes)?,
        // A torn or foreign file under the digest: replace it with the real bytes.
        Err(_) => fsutil::write_atomic(&path, bytes)?,
    }
    Ok(hex)
}

/// What [`capture`] found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Captured {
    /// Edits captured (now or by an earlier run).
    pub edits: usize,
    /// The capture was already complete.
    pub existing: bool,
}

/// Capture `m`'s unsent edits, once. `Err` leaves no complete capture behind,
/// and the takeover must not stop the mirror.
pub fn capture(
    legacy: &Path,
    old_state_dir: &Path,
    m: &RegistryEntry,
    now: &str,
) -> io::Result<Captured> {
    let collection = m.collection_id.as_str();
    let dir = dir(legacy, collection)?;
    if let Some(c) = Capture::load(legacy, collection)? {
        return Ok(Captured {
            edits: c.edits.len(),
            existing: true,
        });
    }
    let state = mirror::read_rust_state(old_state_dir, &m.replica_id)
        .map_err(|e| io::Error::other(e.to_string()))?
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "mirror state missing"))?;
    fsutil::ensure_private_dir(legacy)?;
    fsutil::ensure_private_dir(&Adapter::collection_dir(legacy, collection))?;
    fsutil::ensure_private_dir(&dir)?;
    fsutil::ensure_private_dir(&dir.join("bytes"))?;
    let folder_missing = !m.path.is_dir();
    let queued = if folder_missing {
        Vec::new()
    } else {
        mirror::queued_writes(&state, &m.path).map_err(|e| io::Error::other(e.to_string()))?
    };
    let mut edits = Vec::new();
    for q in queued {
        match q {
            Queued::Create { path, .. } => {
                // The bytes read now are what is kept, whatever the scan hashed.
                let bytes = std::fs::read(m.path.join(&path))?;
                let content = keep_bytes(&dir, &bytes)?;
                edits.push(Edit::Create { path, content });
            }
            Queued::Update {
                record_id, path, ..
            } => {
                let base = state
                    .records
                    .get(&record_id)
                    .ok_or_else(|| bad("queued change without a base"))?;
                let bytes = std::fs::read(m.path.join(&path))?;
                let content = keep_bytes(&dir, &bytes)?;
                edits.push(Edit::Update {
                    record_id,
                    from: base.path.clone(),
                    path,
                    base: base.hash.clone(),
                    content,
                });
            }
            Queued::Delete { record_id, path } => {
                let base = state
                    .records
                    .get(&record_id)
                    .ok_or_else(|| bad("queued delete without a base"))?;
                edits.push(Edit::Delete {
                    record_id,
                    path,
                    base: base.hash.clone(),
                });
            }
        }
    }
    edits.sort_by(|a, b| a.order().cmp(&b.order()).then(a.key().cmp(&b.key())));
    let c = Capture {
        schema_version: SCHEMA_VERSION,
        collection_id: collection.to_owned(),
        replica_id: m.replica_id.clone(),
        mirror_root: m.path.clone(),
        mode: state.mode.clone(),
        cursor: state.cursor,
        base_trusted: state.base_trusted,
        folder_missing,
        captured_at: now.to_owned(),
        edits,
        unreceipted: state
            .unreceipted
            .iter()
            .map(|u| Unreceipted {
                mutation_id: u.mutation_id.clone(),
                record_id: u.record_id.clone(),
                operation: u.operation.clone(),
                path: u.path.clone(),
            })
            .collect(),
    };
    let bytes = serde_json::to_vec_pretty(&c).map_err(io::Error::other)?;
    super::adapter::failpoint("mirror_capture");
    fsutil::write_atomic(&dir.join("capture.json"), &bytes)?;
    Ok(Captured {
        edits: c.edits.len(),
        existing: false,
    })
}

/// How one edit ended.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "snake_case", deny_unknown_fields)]
pub enum Done {
    /// Written through the replica and confirmed.
    Applied,
    /// The collection already had it.
    AlreadyPresent,
    /// A delete of a record changed elsewhere: the record was kept (D8).
    Superseded,
    /// Kept for review as a hold (`collection.holds`).
    Held {
        /// Why it could not be applied.
        cause: String,
        /// The path the hold is listed at.
        path: String,
        /// SHA-256 hex of the unsent version.
        content: String,
    },
    /// Not importable: a copy was written to `file`.
    Recovered {
        /// Why.
        cause: String,
        /// Where the copy is (absolute).
        file: PathBuf,
    },
}

/// A write in flight: the identity every submission of it uses.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InFlight {
    /// Mutation ID (hex).
    pub mutation: String,
    /// The record ID a create uses (hex).
    pub record: String,
}

/// One edit's progress.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
pub enum Item {
    /// Submitted (or about to be) under this identity.
    InFlight(InFlight),
    /// Settled.
    Done(Done),
}

/// `progress.json`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Progress {
    /// [`SCHEMA_VERSION`].
    pub schema_version: u32,
    /// By [`Edit::key`].
    pub items: BTreeMap<String, Item>,
}

impl Progress {
    /// Load (empty when there is none yet).
    pub fn load(legacy: &Path, collection: &str) -> io::Result<Progress> {
        match fsutil::read_optional(&dir(legacy, collection)?.join("progress.json"))? {
            None => Ok(Progress {
                schema_version: SCHEMA_VERSION,
                items: BTreeMap::new(),
            }),
            Some(b) => {
                let p: Progress = serde_json::from_slice(&b)
                    .map_err(|_| bad("malformed mirror import progress"))?;
                if p.schema_version != SCHEMA_VERSION {
                    return Err(bad("unsupported mirror import progress"));
                }
                Ok(p)
            }
        }
    }

    fn save(&self, legacy: &Path, collection: &str) -> io::Result<()> {
        let bytes = serde_json::to_vec_pretty(self).map_err(io::Error::other)?;
        fsutil::write_atomic(&dir(legacy, collection)?.join("progress.json"), &bytes)
    }

    /// Whether every captured edit is settled.
    pub fn complete(&self, c: &Capture) -> bool {
        c.edits
            .iter()
            .all(|e| matches!(self.items.get(&e.key()), Some(Item::Done(_))))
    }
}

/// The current version of a record, as the replica reads it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Current {
    /// Record ID.
    pub id: [u8; 16],
    /// Path.
    pub path: String,
    /// Revision (for a delete's `base_revision`).
    pub revision: [u8; 32],
    /// Exact source.
    pub document: String,
}

impl Current {
    fn hex(&self) -> String {
        hex_of(self.document.as_bytes())
    }
}

/// What to do with one edit, given the replica's view.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Plan {
    /// The collection already has it.
    AlreadyPresent,
    /// Write `text` at `path` over `current`, whose version is the edit's base.
    Edit {
        /// The record, at its base version.
        current: Current,
        /// Target path (a move when it differs).
        path: String,
        /// New source.
        text: String,
    },
    /// Create a record at `path` (a fresh record ID).
    Create {
        /// Path.
        path: String,
        /// Source.
        text: String,
    },
    /// Delete the record, which is still at the edit's base.
    Delete {
        /// Record ID.
        id: [u8; 16],
        /// The revision seen.
        revision: [u8; 32],
    },
    /// A delete of a record changed elsewhere: keep the record.
    Superseded,
    /// Keep the unsent version for review.
    Hold(&'static str),
    /// Not importable: keep a copy outside the collection.
    Recover(&'static str),
}

/// Plan one edit. `bytes` are the captured bytes (creates and changes);
/// `by_id` is the record with the edit's ID; `at_path` the record at its path.
pub fn plan(
    edit: &Edit,
    bytes: Option<&[u8]>,
    base_trusted: bool,
    by_id: Option<&Current>,
    at_path: Option<&Current>,
) -> Plan {
    let text = match (edit, bytes) {
        (Edit::Delete { .. }, _) => None,
        (_, Some(b)) => match std::str::from_utf8(b) {
            Ok(t) => Some(t.to_owned()),
            Err(_) => return Plan::Recover("not_text"),
        },
        (_, None) => return Plan::Recover("bytes_missing"),
    };
    match edit {
        Edit::Create { path, content } => match at_path {
            None => Plan::Create {
                path: path.clone(),
                text: text.unwrap_or_default(),
            },
            Some(c) if c.hex() == *content => Plan::AlreadyPresent,
            Some(_) => Plan::Hold("created_elsewhere"),
        },
        Edit::Update {
            path,
            base,
            content,
            ..
        } => {
            let text = text.unwrap_or_default();
            match by_id {
                Some(c) if c.hex() == *content && c.path == *path => Plan::AlreadyPresent,
                Some(_) if !base_trusted => Plan::Hold("unknown_base"),
                Some(c) if c.hex() == *base => {
                    if at_path.is_some_and(|o| o.id != c.id) {
                        Plan::Hold("path_taken")
                    } else {
                        Plan::Edit {
                            current: c.clone(),
                            path: path.clone(),
                            text,
                        }
                    }
                }
                Some(_) => Plan::Hold("changed_elsewhere"),
                // Deleted elsewhere: keep the edit (D8).
                None => match at_path {
                    None => Plan::Create {
                        path: path.clone(),
                        text,
                    },
                    Some(o) if o.hex() == *content => Plan::AlreadyPresent,
                    Some(_) => Plan::Hold("deleted_elsewhere"),
                },
            }
        }
        Edit::Delete { base, .. } => match by_id {
            None => Plan::AlreadyPresent,
            Some(c) if base_trusted && c.hex() == *base => Plan::Delete {
                id: c.id,
                revision: c.revision,
            },
            Some(_) => Plan::Superseded,
        },
    }
}

/// The replica an import writes to.
#[allow(async_fn_in_trait)]
pub trait Target {
    /// The record with this ID, or at this path (`key` is a UUID or a path).
    async fn get(&mut self, key: &str) -> io::Result<Option<Current>>;
    /// Submit `ops` under `mutation` and wait for the outcome. A known mutation
    /// answers with its original receipt.
    async fn submit(&mut self, ops: Vec<Op>, mutation: [u8; 16]) -> io::Result<Outcome>;
    /// The outcome of `mutation`, or `None` when the replica has no receipt.
    async fn receipt(&mut self, mutation: [u8; 16]) -> io::Result<Option<Outcome>>;
}

/// Keep recovery in the already-owned, content-addressed capture. The original
/// path remains in capture/status; no user-adjacent directory is created or used.
fn recover(legacy: &Path, c: &Capture, bytes: &[u8]) -> io::Result<PathBuf> {
    let root = dir(legacy, &c.collection_id)?;
    let digest = keep_bytes(&root, bytes)?;
    Ok(root.join("bytes").join(digest))
}

fn uuid_of(s: &str) -> Option<[u8; 16]> {
    if !mdbn_legacy::is_uuid(s) {
        return None;
    }
    crate::secrets::hex_decode(&s.replace('-', ""))
        .ok()
        .and_then(|v| v.try_into().ok())
}

fn hex16(b: &[u8; 16]) -> String {
    crate::secrets::hex(b)
}

fn from_hex16(s: &str) -> io::Result<[u8; 16]> {
    crate::secrets::hex_decode(s)
        .ok()
        .and_then(|v| v.try_into().ok())
        .ok_or_else(|| bad("malformed in-flight identity"))
}

fn ops_for(plan: &Plan, record: [u8; 16]) -> Vec<Op> {
    match plan {
        Plan::Edit {
            current,
            path,
            text,
        } => vec![Op::Document(Document {
            id: B16(current.id),
            base: Some(DocVersion {
                path: current.path.clone(),
                doc: Text::Inline(current.document.clone()),
            }),
            new: Some(DocVersion {
                path: path.clone(),
                doc: Text::Inline(text.clone()),
            }),
            if_revision: None,
        })],
        Plan::Create { path, text } => vec![Op::Create(Create {
            id: B16(record),
            path: Some(path.clone()),
            type_name: None,
            frontmatter: None,
            body: None,
            document: Some(Text::Inline(text.clone())),
        })],
        Plan::Delete { id, revision } => vec![Op::Delete(Delete {
            id: B16(*id),
            base_revision: Some(mdbn_wire::common::B32(*revision)),
            if_revision: None,
        })],
        _ => Vec::new(),
    }
}

/// What one [`import`] pass did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Pass {
    /// Edits settled by this pass.
    pub settled: usize,
    /// Edits still in flight (pending or unknown outcome).
    pub waiting: usize,
    /// Every edit is settled.
    pub complete: bool,
}

/// One pass over `collection`'s captured edits. Safe to repeat and to interrupt
/// anywhere: settled edits are skipped, in-flight ones are read back or
/// resubmitted under their saved identity.
pub async fn import<T: Target>(
    legacy: &Path,
    collection: &str,
    target: &mut T,
    fresh: &mut (dyn FnMut() -> [u8; 16] + Send),
) -> io::Result<Pass> {
    let Some(c) = Capture::load(legacy, collection)? else {
        return Ok(Pass::default());
    };
    let mut progress = Progress::load(legacy, collection)?;
    let mut pass = Pass::default();
    for edit in &c.edits {
        let key = edit.key();
        let identity = match progress.items.get(&key) {
            Some(Item::Done(_)) => continue,
            Some(Item::InFlight(f)) => {
                let mutation = from_hex16(&f.mutation)?;
                match target.receipt(mutation).await? {
                    Some(Outcome::Confirmed) => {
                        settle(&mut progress, legacy, collection, &key, Done::Applied)?;
                        pass.settled += 1;
                        continue;
                    }
                    Some(Outcome::Pending | Outcome::Unknown) => {
                        pass.waiting += 1;
                        continue;
                    }
                    // Refused, or never received: plan again on the current view.
                    // A refused identity is not reused.
                    Some(Outcome::Rejected) => None,
                    None => Some(f.clone()),
                }
            }
            None => None,
        };
        let bytes = match edit {
            Edit::Create { content, .. } | Edit::Update { content, .. } => {
                Some(c.bytes(legacy, content)?)
            }
            Edit::Delete { .. } => None,
        };
        let by_id = match edit {
            Edit::Update { record_id, .. } | Edit::Delete { record_id, .. } => {
                match uuid_of(record_id) {
                    Some(_) => target.get(record_id).await?,
                    None => None,
                }
            }
            Edit::Create { .. } => None,
        };
        // A moved record answers at its old path too (an alias): only a record
        // actually at the path occupies it.
        let at_path = target
            .get(edit.path())
            .await?
            .filter(|c| c.path == edit.path());
        let p = plan(
            edit,
            bytes.as_deref(),
            c.base_trusted,
            by_id.as_ref(),
            at_path.as_ref(),
        );
        let done = match &p {
            Plan::AlreadyPresent => Some(Done::AlreadyPresent),
            Plan::Superseded => Some(Done::Superseded),
            Plan::Hold(cause) => Some(held_done(edit, cause)),
            Plan::Recover(cause) => Some(Done::Recovered {
                cause: (*cause).into(),
                file: recover(legacy, &c, bytes.as_deref().unwrap_or_default())?,
            }),
            Plan::Edit { .. } | Plan::Create { .. } | Plan::Delete { .. } => None,
        };
        if let Some(done) = done {
            settle(&mut progress, legacy, collection, &key, done)?;
            pass.settled += 1;
            continue;
        }
        // The identity is durable before anything is submitted.
        let f = identity.unwrap_or_else(|| InFlight {
            mutation: hex16(&fresh()),
            record: hex16(&fresh()),
        });
        progress
            .items
            .insert(key.clone(), Item::InFlight(f.clone()));
        progress.save(legacy, collection)?;
        let ops = ops_for(&p, from_hex16(&f.record)?);
        match target.submit(ops, from_hex16(&f.mutation)?).await? {
            Outcome::Confirmed => {
                settle(&mut progress, legacy, collection, &key, Done::Applied)?;
                pass.settled += 1;
            }
            Outcome::Pending | Outcome::Unknown => pass.waiting += 1,
            // Refused at the current view (a path the collection does not take,
            // a type check...): keep the unsent version reachable.
            Outcome::Rejected => {
                let done = match (edit, bytes.as_deref()) {
                    (Edit::Delete { .. }, _) => Done::Superseded,
                    (_, Some(b)) if matches!(p, Plan::Create { .. }) && at_path.is_none() => {
                        Done::Recovered {
                            cause: "refused".into(),
                            file: recover(legacy, &c, b)?,
                        }
                    }
                    _ => held_done(edit, "refused"),
                };
                settle(&mut progress, legacy, collection, &key, done)?;
                pass.settled += 1;
            }
        }
    }
    pass.complete = progress.complete(&c);
    Ok(pass)
}

fn held_done(edit: &Edit, cause: &str) -> Done {
    let content = match edit {
        Edit::Create { content, .. } | Edit::Update { content, .. } => content.clone(),
        Edit::Delete { base, .. } => base.clone(),
    };
    Done::Held {
        cause: cause.into(),
        path: edit.path().to_owned(),
        content,
    }
}

fn settle(
    progress: &mut Progress,
    legacy: &Path,
    collection: &str,
    key: &str,
    done: Done,
) -> io::Result<()> {
    progress.items.insert(key.to_owned(), Item::Done(done));
    progress.save(legacy, collection)
}

/// Unsent edits held for review, as takeover holds (`held::open` merges them).
pub fn holds(legacy: &Path, collection: &str) -> io::Result<Vec<(String, String, Vec<u8>)>> {
    let Some(c) = Capture::load(legacy, collection)? else {
        return Ok(Vec::new());
    };
    let progress = Progress::load(legacy, collection)?;
    let mut out = Vec::new();
    for e in &c.edits {
        if let Some(Item::Done(Done::Held {
            cause,
            path,
            content,
        })) = progress.items.get(&e.key())
        {
            out.push((path.clone(), cause.clone(), c.bytes(legacy, content)?));
        }
    }
    Ok(out)
}

/// The hosted collections with a capture under `legacy`.
pub fn captured(legacy: &Path) -> io::Result<Vec<String>> {
    let entries = match std::fs::read_dir(legacy) {
        Ok(e) => e,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut out = Vec::new();
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if held::is_collection_id(&name) && e.path().join("mirror/capture.json").is_file() {
            out.push(name);
        }
    }
    out.sort();
    Ok(out)
}

/// Content-free status of one capture, for `migrate.status`.
pub fn status(legacy: &Path, collection: &str) -> io::Result<Option<serde_json::Value>> {
    let Some(c) = Capture::load(legacy, collection)? else {
        return Ok(None);
    };
    let progress = Progress::load(legacy, collection)?;
    let open: std::collections::BTreeSet<String> = held::open(legacy, collection)?
        .into_iter()
        .map(|h| h.path)
        .collect();
    let (mut applied, mut present, mut superseded, mut held_n, mut waiting) = (0, 0, 0, 0, 0);
    let mut recovered = Vec::new();
    for e in &c.edits {
        match progress.items.get(&e.key()) {
            Some(Item::Done(Done::Applied)) => applied += 1,
            Some(Item::Done(Done::AlreadyPresent)) => present += 1,
            Some(Item::Done(Done::Superseded)) => superseded += 1,
            Some(Item::Done(Done::Held { path, .. })) => {
                if open.contains(path) {
                    held_n += 1
                }
            }
            Some(Item::Done(Done::Recovered { cause, file })) => {
                recovered.push(serde_json::json!({"path": e.path(), "reason": cause, "file": file}))
            }
            Some(Item::InFlight(_)) | None => waiting += 1,
        }
    }
    Ok(Some(serde_json::json!({
        "mirror_root": c.mirror_root,
        "captured_at": c.captured_at,
        "edits": c.edits.len(),
        "applied": applied,
        "already_present": present,
        "superseded": superseded,
        "held": held_n,
        "recovered": recovered,
        "waiting": waiting,
        "complete": progress.complete(&c),
    })))
}

#[cfg(test)]
#[path = "mirror_import_tests.rs"]
pub(crate) mod tests;
