//! Snapshots (`snapshot.md`): the state digest, building and uploading a snapshot,
//! and installing one when this replica is behind retention or bootstrapping.
//!
//! **Build.** At the head `H`, every section is turned into chunk payloads (bucketed
//! by `bucket16` for index/records/files), each sealed as an unsigned `chunk` object
//! addressed by `SHA-256` of its bytes. A chunk whose plaintext is unchanged from the
//! previous manifest reuses its address and is not uploaded again. The manifest is
//! sealed and signed; `refs` lists every chunk, every blob part and every
//! attachment object (manifest and all chunks, `attachment_inventory.rs`) the state
//! references, or the build is refused typed ([`SnapshotBlocked`]); never
//! truncated. Attachment rows go to the critical sections 10/11 of the
//! `attachment_runtime_v1` family. When every object is stored, `put_snapshot`
//! registers the pointer.
//!
//! **Install** (§8). `get_snapshot` → fetch and open the manifest → check its chain
//! against the item after it (or the head) → clear confirmed state → fetch, verify
//! (`address`, `plain_hash`) and commit chunks one at a time, resources first → check
//! the state digest → set the head and read the tail. Queries answer over what is
//! installed with `complete: false` meanwhile. Pending mutations stay; those already
//! in the installed receipts resolve as confirmed in the append loop.
//!
//! Open items: manifest signature verification and the control-chain commitment
//! need policy wiring; the semantics ratchet at `seq` is not in the manifest; the
//! build holds one snapshot's chunks in memory.

use std::collections::BTreeMap;

use mdbn_wire::attachment::{
    AttachmentContentV1, AttachmentFileRowV1, AttachmentTombstoneRowV1, FileContent,
};
use mdbn_wire::attachment_runtime_v1::{
    self as rt, ChunkPayload, ConflictRow as WConflictRow, ManifestPayload, Section, SectionKind,
};
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::client::IncidentKind;
use mdbn_wire::common::{B32, Bytes, Hash, Text, Value, Version};
use mdbn_wire::entry::Alias;
use mdbn_wire::envelope::{Item, ItemKind};
use mdbn_wire::intent::FileInclusion;
use mdbn_wire::log_service::{
    EndorseSnapshotParams, PutSnapshotParams, ReadParams, SnapshotPointer,
};
use mdbn_wire::schema::Wire;
use mdbn_wire::snapshot::{
    ChunkRef, EntityKind, FileRow as WFileRow, Horizon, IndexRow, ReceiptRow as WReceiptRow,
    RecordRow as WRecordRow, ResourceRow, SectionKind as L, TextOrBlob,
    TombstoneRow as WTombstoneRow,
};

use super::Replica;
use super::append::Inflight;
use super::apply::{HORIZON_ENTRIES, HORIZON_MS, log_state, media_class};
use crate::log::{LogRequest, LogResponse};
use crate::plan::record_meta;
use crate::store::{
    AliasRow, ConflictRow, FileLocal, FileRow, Head, Page, ReceiptRow, RecordRow, Store,
    StoreError, TombstoneLast, TombstoneRow, Tx, bucket16, meta_keys,
};

/// Target plaintext per records chunk.
pub(super) const TARGET_CHUNK: u64 = 512 << 10;
/// Unbucketed sections split at this plaintext size.
const MAX_CHUNK: usize = 4 << 20;
/// Entries between snapshots.
pub const SNAPSHOT_EVERY: u64 = 10_000;

pub(super) fn enc(c: &Cbor) -> Vec<u8> {
    cbor::encode(c).unwrap_or_default()
}

/// Every record in ID order, paged through the store.
fn all_records(s: &dyn Store) -> Result<Vec<RecordRow>, StoreError> {
    let mut out = Vec::new();
    let mut after = None;
    loop {
        let p = s.records(Page { after, limit: 1024 })?;
        let Some(l) = p.last() else {
            break;
        };
        after = Some(l.id);
        out.extend(p);
    }
    Ok(out)
}

fn all_files(s: &dyn Store) -> Result<Vec<FileRow>, StoreError> {
    let mut out = Vec::new();
    let mut after = None;
    loop {
        let p = s.files(Page { after, limit: 1024 })?;
        let Some(l) = p.last() else {
            break;
        };
        after = Some(l.id);
        out.extend(p);
    }
    Ok(out)
}

fn all_tombstones(s: &dyn Store) -> Result<Vec<TombstoneRow>, StoreError> {
    let mut out = Vec::new();
    let mut after = None;
    loop {
        let p = s.tombstones(Page { after, limit: 1024 })?;
        let Some(l) = p.last() else {
            break;
        };
        after = Some(l.id);
        out.extend(p);
    }
    Ok(out)
}

fn all_receipts(s: &dyn Store) -> Result<Vec<ReceiptRow>, StoreError> {
    let mut out = Vec::new();
    let mut after = None;
    loop {
        let p = s.receipts(after, 1024)?;
        let Some(l) = p.last() else {
            break;
        };
        after = Some(l.mutation);
        out.extend(p);
    }
    Ok(out)
}

fn tomb_revision(t: &TombstoneRow) -> Hash {
    match &t.last {
        TombstoneLast::Doc(d) => mdbn_wire::hash::sha256(d.as_bytes()),
        TombstoneLast::Blob(b) => b.plain_hash,
        TombstoneLast::Attachment(a) => a.whole_plain_hash,
        TombstoneLast::UnindexedMarkdown(p) => p.content.plain_hash(),
    }
}

/// What a file row holds, for the section it belongs to: a legacy blob goes to
/// `Files` (4), attachment content to the critical `AttachmentFiles` (10). A
/// content form this replica does not know is never written as either.
enum RowContent<'a> {
    Blob(&'a mdbn_wire::intent::BlobRef),
    Attachment(&'a AttachmentContentV1),
}

fn row_content(content: &FileContent) -> Result<RowContent<'_>, StoreError> {
    match content {
        FileContent::Blob(b) => Ok(RowContent::Blob(b)),
        FileContent::AttachmentV1(a) => Ok(RowContent::Attachment(a)),
        _ => Err(StoreError::Corrupt(
            "file row content form unknown to this replica".into(),
        )),
    }
}

/// Every attachment the state holds (live files, retained file tombstones and
/// conflict sides), by manifest address.
#[derive(Default)]
struct Held(BTreeMap<Hash, AttachmentContentV1>);

impl Held {
    fn add(&mut self, a: &AttachmentContentV1) {
        self.0
            .entry(a.reference.manifest_cipher_hash)
            .or_insert_with(|| a.clone());
    }
}

/// Why the replica did not build a snapshot it was due to build. Typed and
/// never silent: the previous snapshot, and every object it retains, stay.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnapshotBlocked {
    /// Some attachments' object inventories are still being read from their
    /// authenticated manifests. The build runs again once they are known.
    InventoryPending {
        /// Attachments without a known inventory.
        attachments: u64,
    },
    /// Some attachments' manifests could not be read or authenticated (the log
    /// no longer has them, or they do not open). Compaction stays blocked.
    InventoryUnavailable {
        /// Attachments whose inventory cannot be established.
        attachments: u64,
    },
    /// The complete refs inventory does not fit in one log-service request
    /// (`put_snapshot`, or the manifest object), whose CBOR node budget is
    /// [`MAX_REQUEST_NODES`]. Never truncated.
    FrameCap {
        /// Distinct objects the snapshot must retain.
        refs: u64,
        /// CBOR nodes the larger of the two requests needs.
        nodes: u64,
    },
    /// The refs inventory exceeds what ref-index objects can carry
    /// (`snapshot.md` §2.1: 262,144 addresses). Never truncated.
    TooManyRefs {
        /// Distinct objects the snapshot must retain.
        refs: u64,
    },
}

/// The log service's whole-request CBOR value budget (`MAX_NODES` in its
/// decode boundary; `log-service-api.md`): every value in one request frame and
/// the objects it carries, map keys included.
pub const MAX_REQUEST_NODES: usize = 4096;

/// Nodes kept free in each snapshot request for what a transport adds to the
/// same budget (a bearer token's claims, for one).
const REQUEST_NODE_RESERVE: usize = 64;

/// CBOR values in `c`, counted as the log service's preflight counts them.
fn cbor_nodes(c: &Cbor) -> usize {
    match c {
        Cbor::Array(v) => 1 + v.iter().map(cbor_nodes).sum::<usize>(),
        Cbor::Map(m) => {
            1 + m
                .iter()
                .map(|(k, v)| cbor_nodes(k) + cbor_nodes(v))
                .sum::<usize>()
        }
        _ => 1,
    }
}

fn request_nodes(method: &str, params: Cbor) -> usize {
    cbor_nodes(
        &mdbn_wire::log_service::LsFrame::Request(mdbn_wire::log_service::LsRequest {
            id: u64::MAX,
            method: method.into(),
            params,
        })
        .to_cbor(),
    )
}

/// The nodes the two snapshot requests need: `put_snapshot` with `refs`, and
/// `put_object` of the manifest Item (whose envelope repeats `refs`).
fn snapshot_request_nodes(collection: mdbn_wire::common::Uuid, seq: u64, manifest: &Item) -> usize {
    let refs = manifest.refs.clone().unwrap_or_default();
    let put_snapshot = request_nodes(
        "put_snapshot",
        PutSnapshotParams {
            collection,
            seq,
            manifest: B32([0; 32]),
            refs,
        }
        .to_cbor(),
    );
    let put_object = request_nodes(
        "put_object",
        mdbn_wire::log_service::PutObjectParams {
            collection,
            address: B32([0; 32]),
            kind: ItemKind::Manifest,
            size: u64::MAX,
            checksum: B32([0; 32]),
            bytes: Some(Bytes(Vec::new())),
        }
        .to_cbor(),
    ) + cbor_nodes(&manifest.to_cbor());
    put_snapshot.max(put_object)
}

/// Refuse, typed, a manifest whose requests would exceed the service's budget.
pub fn snapshot_refs_fit(
    collection: mdbn_wire::common::Uuid,
    seq: u64,
    manifest: &Item,
) -> Result<(), SnapshotBlocked> {
    let nodes = snapshot_request_nodes(collection, seq, manifest);
    if nodes + REQUEST_NODE_RESERVE > MAX_REQUEST_NODES {
        return Err(SnapshotBlocked::FrameCap {
            refs: manifest.refs.as_ref().map_or(0, Vec::len) as u64,
            nodes: nodes as u64,
        });
    }
    Ok(())
}

/// The state digest of confirmed state (`snapshot.md` §4).
///
/// Encoding: the canonical CBOR of a 7-element array, one element per section in
/// the order of §4: lists of row arrays, and the inclusion map for `settings` (the
/// default inclusion when none was set).
pub fn state_digest(s: &dyn Store) -> Result<Hash, StoreError> {
    Ok(DigestIndex::of(s)?.digest())
}

/// What the state digest covers, row by row, without documents. A snapshot install
/// builds it chunk by chunk, so it holds one chunk plus this index in memory, and
/// refuses duplicate IDs and path keys as rows arrive.
#[derive(Debug, Default, Clone)]
pub(crate) struct DigestIndex {
    resources: BTreeMap<String, Hash>,
    records: BTreeMap<mdbn_wire::common::Uuid, (String, Hash)>,
    files: BTreeMap<mdbn_wire::common::Uuid, (String, Hash)>,
    tombs: BTreeMap<mdbn_wire::common::Uuid, (EntityKind, String, Hash, u64)>,
    settings: Option<FileInclusion>,
    /// By path key, as stores keep them.
    aliases: BTreeMap<String, (String, mdbn_wire::common::Uuid)>,
    conflicts: std::collections::BTreeSet<(mdbn_wire::common::Uuid, mdbn_wire::common::Uuid, u64)>,
    /// Native-only canonical rows. Absent rows preserve the legacy seven-element
    /// digest exactly; native state binds kind and complete descriptor identity.
    native_files: BTreeMap<mdbn_wire::common::Uuid, Cbor>,
    native_tombs: BTreeMap<mdbn_wire::common::Uuid, Cbor>,
    native_conflicts: BTreeMap<(mdbn_wire::common::Uuid, mdbn_wire::common::Uuid, u64), Cbor>,
    /// Path keys of live records and files.
    live: std::collections::BTreeSet<String>,
}

impl DigestIndex {
    /// The index of a store's confirmed state.
    fn of(s: &dyn Store) -> Result<DigestIndex, StoreError> {
        let mut x = DigestIndex::default();
        for (p, d) in s.resources()? {
            x.resource(&p, &d);
        }
        for r in all_records(s)? {
            x.record(&r).map_err(StoreError::Corrupt)?;
        }
        for f in all_files(s)? {
            x.file(&f).map_err(StoreError::Corrupt)?;
        }
        for t in all_tombstones(s)? {
            x.tombstone(&t).map_err(StoreError::Corrupt)?;
        }
        x.settings = s.settings()?;
        for a in s.aliases()? {
            x.alias(&a);
        }
        for c in s.conflicts(None)? {
            x.conflict(&c);
        }
        Ok(x)
    }

    fn resource(&mut self, path: &str, doc: &str) {
        self.resources
            .insert(path.to_string(), mdbn_wire::hash::sha256(doc.as_bytes()));
    }

    fn entity_id_available(&self, id: &mdbn_wire::common::Uuid) -> Result<(), String> {
        // Live records, ordinary/native files and retained tombstones share one
        // entity namespace. Index rows, aliases and conflict sides are references.
        if self.records.contains_key(id)
            || self.files.contains_key(id)
            || self.tombs.contains_key(id)
        {
            return Err("two entries share an ID".into());
        }
        Ok(())
    }

    fn live_entry(&mut self, id: &mdbn_wire::common::Uuid, path_key: &str) -> Result<(), String> {
        self.entity_id_available(id)?;
        if !self.live.insert(path_key.to_string()) {
            return Err("two entries share a path".into());
        }
        Ok(())
    }

    fn record(&mut self, r: &RecordRow) -> Result<(), String> {
        self.live_entry(&r.id, &r.path_key)?;
        self.records.insert(r.id, (r.path.clone(), r.revision));
        Ok(())
    }

    fn file(&mut self, f: &FileRow) -> Result<(), String> {
        self.live_entry(&f.id, &f.path_key)?;
        self.files
            .insert(f.id, (f.path.clone(), f.content.plain_hash()));
        if f.kind == mdbn_wire::unindexed_markdown::FileKindV1::UnindexedOversizedMarkdown {
            self.native_files.insert(
                f.id,
                Cbor::Array(vec![
                    f.id.to_cbor(),
                    f.path.to_cbor(),
                    mdbn_wire::unindexed_markdown::UnindexedMarkdownPayloadV1 {
                        content: f.content.clone(),
                    }
                    .to_cbor(),
                    f.media.to_cbor(),
                ]),
            );
        }
        Ok(())
    }

    fn tombstone(&mut self, t: &TombstoneRow) -> Result<(), String> {
        self.entity_id_available(&t.id)?;
        let v = (t.kind, t.path.clone(), tomb_revision(t), t.seq);
        self.tombs.insert(t.id, v);
        if let TombstoneLast::UnindexedMarkdown(p) = &t.last {
            self.native_tombs.insert(
                t.id,
                Cbor::Array(vec![
                    t.id.to_cbor(),
                    t.kind.to_cbor(),
                    t.path.to_cbor(),
                    p.to_cbor(),
                    Cbor::Uint(t.seq),
                    t.time.to_cbor(),
                ]),
            );
        }
        Ok(())
    }

    fn alias(&mut self, a: &AliasRow) {
        self.aliases
            .insert(a.path_key.clone(), (a.path.clone(), a.record));
    }

    fn conflict(&mut self, c: &ConflictRow) {
        let key = (c.mutation, c.conflict.id, c.conflict.kind.value());
        self.conflicts.insert(key);
        if [
            Some(&c.conflict.kept),
            Some(&c.conflict.lost),
            c.conflict.base.as_ref(),
        ]
        .into_iter()
        .flatten()
        .any(|v| matches!(v, rt::ConflictValue::UnindexedMarkdown(_)))
        {
            self.native_conflicts.insert(
                key,
                WConflictRow {
                    mutation: c.mutation,
                    seq: c.seq,
                    conflict: c.conflict.clone(),
                }
                .to_cbor(),
            );
        }
    }

    fn digest(&self) -> Hash {
        let resources: Vec<Cbor> = self
            .resources
            .iter()
            .map(|(p, h)| Cbor::Array(vec![Cbor::Text(p.clone()), h.to_cbor()]))
            .collect();
        let records: Vec<Cbor> = self
            .records
            .iter()
            .map(|(id, (p, r))| Cbor::Array(vec![id.to_cbor(), Cbor::Text(p.clone()), r.to_cbor()]))
            .collect();
        let files: Vec<Cbor> = self
            .files
            .iter()
            .map(|(id, (p, h))| Cbor::Array(vec![id.to_cbor(), Cbor::Text(p.clone()), h.to_cbor()]))
            .collect();
        let tombs: Vec<Cbor> = self
            .tombs
            .iter()
            .map(|(id, (k, p, r, seq))| {
                Cbor::Array(vec![
                    id.to_cbor(),
                    k.to_cbor(),
                    Cbor::Text(p.clone()),
                    r.to_cbor(),
                    Cbor::Uint(*seq),
                ])
            })
            .collect();
        let settings = self
            .settings
            .clone()
            .unwrap_or_else(|| crate::convert::winclusion(&Default::default()))
            .to_cbor();
        let mut aliases: Vec<&(String, mdbn_wire::common::Uuid)> = self.aliases.values().collect();
        aliases.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
        let aliases: Vec<Cbor> = aliases
            .into_iter()
            .map(|(p, r)| Cbor::Array(vec![Cbor::Text(p.clone()), r.to_cbor()]))
            .collect();
        let conflicts: Vec<Cbor> = self
            .conflicts
            .iter()
            .map(|(m, r, k)| Cbor::Array(vec![m.to_cbor(), r.to_cbor(), Cbor::Uint(*k)]))
            .collect();
        let mut parts = vec![
            Cbor::Array(resources),
            Cbor::Array(records),
            Cbor::Array(files),
            Cbor::Array(tombs),
            settings,
            Cbor::Array(aliases),
            Cbor::Array(conflicts),
        ];
        if !self.native_files.is_empty()
            || !self.native_tombs.is_empty()
            || !self.native_conflicts.is_empty()
        {
            parts.push(Cbor::Array(vec![
                Cbor::Array(self.native_files.values().cloned().collect()),
                Cbor::Array(self.native_tombs.values().cloned().collect()),
                Cbor::Array(self.native_conflicts.values().cloned().collect()),
            ]));
        }
        mdbn_wire::hash::h("mdbase/v1/state-digest", &enc(&Cbor::Array(parts)))
    }
}

/// Append one chunk's confirmed-state rows to the rows staged in memory (stores
/// without a staging area).
fn extend_rows(into: &mut Tx, from: Tx) {
    into.records_put.extend(from.records_put);
    into.files_put.extend(from.files_put);
    into.resources_put.extend(from.resources_put);
    if from.settings.is_some() {
        into.settings = from.settings;
    }
    into.tombstones_put.extend(from.tombstones_put);
    into.aliases_put.extend(from.aliases_put);
    into.conflicts_put.extend(from.conflicts_put);
    into.receipts_put.extend(from.receipts_put);
}

/// `ceil(log2(x))` for x ≥ 1, without floats.
pub(super) fn ceil_log2(x: u64) -> u64 {
    if x <= 1 {
        0
    } else {
        u64::from(64 - (x - 1).leading_zeros())
    }
}

/// Chunk rows per bucket or ordinal.
type Chunks = Vec<(u64, Vec<Cbor>)>;

/// An object to upload.
#[derive(Debug, Clone)]
pub(crate) struct Upload {
    pub(crate) address: B32,
    pub(crate) kind: ItemKind,
    pub(crate) bytes: Vec<u8>,
}

/// A snapshot build in flight.
#[derive(Debug, Clone)]
pub(crate) struct Build {
    pub(crate) seq: u64,
    pub(crate) manifest: B32,
    pub(crate) refs: Vec<B32>,
    pub(crate) outstanding: usize,
    pub(crate) failed: bool,
    pub(crate) payload: ManifestPayload,
}

/// An install in flight.
#[derive(Debug, Clone)]
pub(crate) enum Install {
    /// Reading control items (policy and keys) from the policy's position
    /// (`snapshot.md` §8 step 1).
    Control,
    /// Asked for the pointers.
    Pointer,
    /// Fetching the manifest of this pointer.
    Manifest(SnapshotPointer),
    /// Fetching the manifest's ref-index objects (`ref_index.rs`).
    RefIndices {
        p: SnapshotPointer,
        m: Box<ManifestPayload>,
        item_refs: Vec<Hash>,
        ref_indices: Vec<Hash>,
        fetched: BTreeMap<Hash, super::ref_index::VerifiedRefIndex>,
    },
    /// Checking the manifest's chain against the log.
    Chain(SnapshotPointer, Box<ManifestPayload>),
    /// Verified manifest, waiting for a successful discard of previous staging.
    Reset(Box<ManifestPayload>),
    /// Streaming authentication of every native source before the atomic swap.
    Sources(Box<ManifestPayload>),
    /// Fetching chunks: the queue and the next index.
    Chunks {
        manifest: Box<ManifestPayload>,
        queue: Vec<(SectionKind, ChunkRef)>,
        next: usize,
    },
}

/// An endorsement in progress: the manifest, then every chunk not
/// verified before.
#[derive(Debug, Clone)]
pub(crate) enum Endorse {
    Manifest(SnapshotPointer),
    Chunks {
        p: SnapshotPointer,
        queue: Vec<ChunkRef>,
        next: usize,
    },
}

/// Whether an install may stage rows in memory, for a store without a staging
/// area. Tests and the simulator only: in a shipped build, install is reachable
/// only over a store with persistent staging ([`Store::stages`]), so memory holds
/// one chunk plus the row index, never the whole snapshot under the bounded
/// staging condition; signature and authorization, the control chain, chunk
/// checks and row validation are in.
pub(crate) const IN_MEMORY_INSTALL: bool = cfg!(any(test, feature = "testing"));

/// Whether the lost-tail rollback may run through install. It remains
/// test/simulator-only; the install gate lift does not change that.
pub(crate) const ROLLBACK_ENABLED: bool = cfg!(any(test, feature = "testing"));

#[cfg(test)]
mod native_digest_tests;
#[cfg(test)]
mod upgrade_tests;
#[cfg(test)]
mod validation_tests;

/// A `base` item at `seq` whose generation-0 manifest is being installed
/// (`snapshot.md` §7). The state after the base is the manifest's state.
#[derive(Debug, Clone)]
pub(crate) struct BaseInstall {
    pub(crate) seq: u64,
    pub(crate) chain: Hash,
    pub(crate) state_digest: Hash,
    /// The base item's epoch: the manifest must be sealed under the same one.
    pub(crate) epoch: u64,
    /// The base item's exact bytes, retained with the head like any applied item.
    pub(crate) item: Vec<u8>,
}

/// Policy state recorded after each control item read during an install: the
/// manifest is checked against the state at its own position.
#[derive(Debug, Clone)]
pub(crate) struct ControlPoint {
    pub(crate) seq: u64,
    pub(crate) policy: crate::policy::PolicyState,
}

/// Largest text in one snapshot row (a record or resource document, a tombstone's
/// last document): the decompressed payload limit of an entry (`log-entry.md` §10).
const MAX_ROW_TEXT: usize = 16 << 20;

/// The last manifest this replica built or installed, for incremental builds.
const LAST_MANIFEST: &str = "replica.snapshot.last";

/// Aliases resolve historical names; they never authorize a filesystem write.
/// Keep the relative lookup-key grammar, allowing nonportable legacy names.
fn alias_path_ok(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 4096
        && !path.starts_with('/')
        && !path.chars().any(|c| c.is_control() || c == '\\')
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

impl<S: Store> Replica<S> {
    /// Build and upload a snapshot of the confirmed state at the head now.
    pub fn build_snapshot_now(&mut self) -> Result<(), StoreError> {
        self.build_snapshot_body(true)
    }
    #[cfg(test)]
    pub(crate) fn test_build_native_snapshot(&mut self) -> Result<(), StoreError> {
        self.build_snapshot_body(true)
    }
    fn build_snapshot_body(&mut self, native: bool) -> Result<(), StoreError> {
        crate::mirror_admission::ensure_open(&self.store)?;
        if self.apply_fault || self.is_apply_recovering() {
            return Err(StoreError::Io("apply state is unavailable".into()));
        }
        if self.store.durability_deferred() {
            return Err(StoreError::Io(
                "deferred-durability window open: no snapshot before its barrier".into(),
            ));
        }
        if self.build.is_some() || self.install.is_some() || self.head.seq == 0 {
            return Ok(());
        }
        let Some(epoch) = self.sealer.current_epoch() else {
            return Ok(());
        };
        let previous: Option<ManifestPayload> = self
            .store
            .meta(LAST_MANIFEST)?
            .and_then(|b| ManifestPayload::from_bytes(&b).ok());
        let prev_refs: BTreeMap<(u64, u64, Hash), B32> = previous
            .iter()
            .flat_map(|m| m.sections.iter())
            .flat_map(|s| {
                s.chunks
                    .iter()
                    .map(move |c| ((s.kind.value(), c.bucket, c.plain_hash), c.address))
            })
            .collect();
        let native_roots = super::unindexed_inventory::Roots::collect(&self.store)?;
        let mut native_refs = Vec::new();
        if native_roots.descriptors().next().is_some() {
            match self.native_snapshot_inventory(&native_roots)? {
                super::unindexed_inventory::Inventory::Complete(refs) => native_refs = refs,
                super::unindexed_inventory::Inventory::Pending(missing) => {
                    self.resolve_inventories(missing);
                    if native {
                        return Ok(());
                    }
                }
            }
            if !native {
                return Err(StoreError::Io("unindexed_snapshot_not_yet".into()));
            }
        }
        let records = all_records(&self.store)?;
        let files = all_files(&self.store)?;
        let total: u64 = records.iter().map(|r| r.doc.len() as u64).sum();
        let bits = ceil_log2(total.div_ceil(TARGET_CHUNK).max(1)).min(16);
        let buckets = 1u64 << bits;
        let shift = 16 - bits;
        let in_bucket = |b16: u16, b: u64| (u64::from(b16) >> shift) == b;

        let mut sections: Vec<(SectionKind, Chunks)> = Vec::new();
        // Resources.
        let mut res = self.store.resources()?;
        res.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
        let rows: Vec<Cbor> = res
            .into_iter()
            .map(|(path, doc)| {
                ResourceRow {
                    path,
                    doc: TextOrBlob::Text(doc),
                }
                .to_cbor()
            })
            .collect();
        sections.push((SectionKind::Legacy(L::Resources), split(rows)));
        // Index, records, files: one chunk per bucket. Attachment file rows go to
        // the critical AttachmentFiles section (10), bucketed by file ID exactly as
        // the legacy Files section; it is present only when such rows exist, so a
        // collection without attachments keeps producing legacy manifests.
        let mut index = Vec::new();
        let mut recs = Vec::new();
        let mut fls = Vec::new();
        let mut afls = Vec::new();
        let mut nfls = Vec::new();
        let mut blob_refs: Vec<mdbn_wire::intent::BlobRef> = Vec::new();
        let mut held = Held::default();
        for b in 0..buckets {
            let mut irows: Vec<(mdbn_wire::common::Uuid, Cbor)> = Vec::new();
            let mut rrows = Vec::new();
            for r in records.iter().filter(|r| in_bucket(r.bucket, b)) {
                irows.push((
                    r.id,
                    IndexRow {
                        id: r.id,
                        kind: EntityKind::Record,
                        path: r.path.clone(),
                        revision: r.revision,
                        size: r.doc.len() as u64,
                        modified_seq: r.modified_seq,
                    }
                    .to_cbor(),
                ));
                rrows.push(
                    WRecordRow {
                        id: r.id,
                        path: r.path.clone(),
                        doc: TextOrBlob::Text(r.doc.clone()),
                    }
                    .to_cbor(),
                );
            }
            let mut frows = Vec::new();
            let mut arows = Vec::new();
            let mut nrows = Vec::new();
            for f in files.iter().filter(|f| in_bucket(f.bucket, b)) {
                irows.push((
                    f.id,
                    IndexRow {
                        id: f.id,
                        kind: EntityKind::File,
                        path: f.path.clone(),
                        revision: f.content.plain_hash(),
                        size: f.content.size(),
                        modified_seq: f.modified_seq,
                    }
                    .to_cbor(),
                ));
                if f.kind == mdbn_wire::unindexed_markdown::FileKindV1::UnindexedOversizedMarkdown {
                    nrows.push(
                        mdbn_wire::unindexed_markdown::UnindexedMarkdownFileRowV1 {
                            id: f.id,
                            path: f.path.clone(),
                            payload: mdbn_wire::unindexed_markdown::UnindexedMarkdownPayloadV1 {
                                content: f.content.clone(),
                            },
                            media: f.media,
                        }
                        .to_cbor(),
                    );
                    continue;
                }
                match row_content(&f.content)? {
                    RowContent::Blob(blob) => {
                        blob_refs.push(blob.clone());
                        frows.push(
                            WFileRow {
                                id: f.id,
                                path: f.path.clone(),
                                blob: blob.clone(),
                                media: f.media,
                            }
                            .to_cbor(),
                        );
                    }
                    RowContent::Attachment(a) => {
                        held.add(a);
                        arows.push(
                            AttachmentFileRowV1 {
                                id: f.id,
                                path: f.path.clone(),
                                content: a.clone(),
                                media: f.media,
                            }
                            .to_cbor(),
                        );
                    }
                }
            }
            irows.sort_by(|a, b| a.0.cmp(&b.0));
            index.push((b, irows.into_iter().map(|(_, c)| c).collect()));
            recs.push((b, rrows));
            fls.push((b, frows));
            afls.push((b, arows));
            nfls.push((b, nrows));
        }
        sections.push((SectionKind::Legacy(L::Index), index));
        sections.push((SectionKind::Legacy(L::Records), recs));
        sections.push((SectionKind::Legacy(L::Files), fls));
        let mut attachment_sections: Vec<(SectionKind, Chunks)> = Vec::new();
        if afls.iter().any(|(_, rows)| !rows.is_empty()) {
            attachment_sections.push((SectionKind::AttachmentFiles, afls));
        }
        if nfls.iter().any(|(_, rows)| !rows.is_empty()) {
            attachment_sections.push((SectionKind::UnindexedMarkdownFiles, nfls));
        }
        // Unbucketed side tables. Retained attachment tombstones go to the
        // critical AttachmentTombstones section (11), never a fabricated blob.
        let tombs = all_tombstones(&self.store)?;
        let mut trows: Vec<Cbor> = Vec::new();
        let mut atrows: Vec<Cbor> = Vec::new();
        let mut ntrows: Vec<Cbor> = Vec::new();
        for t in &tombs {
            let last = match &t.last {
                TombstoneLast::UnindexedMarkdown(p) => {
                    if t.kind != EntityKind::File {
                        return Err(StoreError::Corrupt("native tombstone is not a file".into()));
                    }
                    ntrows.push(
                        mdbn_wire::unindexed_markdown::UnindexedMarkdownTombstoneRowV1 {
                            id: t.id,
                            path: t.path.clone(),
                            payload: p.clone(),
                            seq: t.seq,
                            time: t.time,
                        }
                        .to_cbor(),
                    );
                    continue;
                }
                TombstoneLast::Doc(d) => TextOrBlob::Text(d.clone()),
                TombstoneLast::Blob(b) => {
                    blob_refs.push(b.clone());
                    TextOrBlob::Blob(b.clone())
                }
                TombstoneLast::Attachment(a) => {
                    if t.kind != EntityKind::File {
                        return Err(StoreError::Corrupt(
                            "an attachment tombstone that is not a file".into(),
                        ));
                    }
                    held.add(a);
                    atrows.push(
                        AttachmentTombstoneRowV1 {
                            id: t.id,
                            path: t.path.clone(),
                            content: a.clone(),
                            seq: t.seq,
                            time: t.time,
                        }
                        .to_cbor(),
                    );
                    continue;
                }
            };
            trows.push(
                WTombstoneRow {
                    id: t.id,
                    kind: t.kind,
                    path: t.path.clone(),
                    last,
                    seq: t.seq,
                    time: t.time,
                }
                .to_cbor(),
            );
        }
        sections.push((SectionKind::Legacy(L::Tombstones), split(trows)));
        if !atrows.is_empty() {
            attachment_sections.push((SectionKind::AttachmentTombstones, split(atrows)));
        }
        if !ntrows.is_empty() {
            attachment_sections.push((SectionKind::UnindexedMarkdownTombstones, split(ntrows)));
        }
        let mut aliases = self.store.aliases()?;
        aliases.sort_by(|a, b| a.path.as_bytes().cmp(b.path.as_bytes()));
        let arows: Vec<Cbor> = aliases
            .iter()
            .map(|a| {
                Alias {
                    path: a.path.clone(),
                    record: a.record,
                }
                .to_cbor()
            })
            .collect();
        sections.push((SectionKind::Legacy(L::Aliases), split(arows)));
        // Conflict rows in the runtime family: a legacy conflict encodes exactly
        // as before, and an attachment side keeps its whole descriptor (and roots).
        let conflicts = self.store.conflicts(None)?;
        for c in &conflicts {
            let sides = [
                Some(&c.conflict.kept),
                Some(&c.conflict.lost),
                c.conflict.base.as_ref(),
            ];
            for v in sides.into_iter().flatten() {
                match v {
                    rt::ConflictValue::Legacy(mdbn_wire::entry::ConflictValue::Blob(b)) => {
                        blob_refs.push(b.clone());
                    }
                    rt::ConflictValue::Attachment(a) => held.add(a),
                    rt::ConflictValue::UnindexedMarkdown(_) => {}
                    rt::ConflictValue::Legacy(_) => {}
                }
            }
        }
        let crows: Vec<Cbor> = conflicts
            .into_iter()
            .map(|c| {
                WConflictRow {
                    mutation: c.mutation,
                    seq: c.seq,
                    conflict: c.conflict,
                }
                .to_cbor()
            })
            .collect();
        sections.push((SectionKind::Legacy(L::Conflicts), split(crows)));
        let rrows: Vec<Cbor> = all_receipts(&self.store)?
            .iter()
            .map(|r| {
                WReceiptRow {
                    mutation: r.mutation,
                    seq: r.seq,
                    time: r.time,
                }
                .to_cbor()
            })
            .collect();
        sections.push((SectionKind::Legacy(L::Receipts), split(rrows)));
        let settings = self
            .store
            .settings()?
            .unwrap_or_else(|| crate::convert::winclusion(&Default::default()));
        sections.push((
            SectionKind::Legacy(L::Settings),
            vec![(0, vec![settings.to_cbor()])],
        ));
        sections.extend(attachment_sections);

        // Every attachment the state holds contributes its complete, authenticated
        // object inventory (manifest and every chunk) to the refs. A missing
        // inventory blocks the build: the previous snapshot and its roots stay.
        let mut attachment_refs: Vec<B32> = Vec::new();
        let mut missing: Vec<AttachmentContentV1> = Vec::new();
        for a in held.0.values() {
            match self.attachment_inventory(&a.reference.manifest_cipher_hash)? {
                Some(objects) => attachment_refs.extend(objects),
                None => missing.push(a.clone()),
            }
        }
        if !missing.is_empty() {
            let unavailable = missing
                .iter()
                .filter(|a| self.inventory_unavailable(&a.reference.manifest_cipher_hash))
                .count() as u64;
            self.snapshot_blocked = Some(if unavailable > 0 {
                SnapshotBlocked::InventoryUnavailable {
                    attachments: unavailable,
                }
            } else {
                SnapshotBlocked::InventoryPending {
                    attachments: missing.len() as u64,
                }
            });
            self.resolve_inventories(missing);
            return Ok(());
        }

        // Seal chunks.
        let mut uploads = Vec::new();
        let mut out_sections = Vec::new();
        let mut refs = attachment_refs;
        refs.extend(native_refs);
        for (kind, chunks) in sections {
            let mut crefs = Vec::new();
            for (bucket, rows) in chunks {
                let n = rows.len() as u64;
                let payload = ChunkPayload {
                    section: kind,
                    bucket,
                    rows,
                };
                let plain = enc(&payload.to_cbor());
                let plain_hash = mdbn_wire::hash::sha256(&plain);
                let address = match prev_refs.get(&(kind.value(), bucket, plain_hash)) {
                    Some(a) => *a,
                    None => {
                        let mut item = object_item(ItemKind::Chunk, self.cfg.collection, epoch);
                        if self
                            .sealer
                            .seal_object(&mut item, &plain, true, false, self.host.entropy.as_mut())
                            .is_err()
                        {
                            return Ok(());
                        }
                        let bytes = item.to_bytes().unwrap_or_default();
                        let address = mdbn_wire::hash::sha256(&bytes);
                        uploads.push(Upload {
                            address,
                            kind: ItemKind::Chunk,
                            bytes,
                        });
                        address
                    }
                };
                refs.push(address);
                crefs.push(ChunkRef {
                    address,
                    plain_hash,
                    rows: n,
                    bucket,
                    plain_size: plain.len() as u64,
                });
            }
            out_sections.push(Section {
                kind,
                chunks: crefs,
            });
        }
        for b in &blob_refs {
            if let Some(a) = self.sealer.blob_part_addresses(b) {
                refs.extend(a);
            }
        }
        refs.sort();
        refs.dedup();
        // Past the direct threshold the refs travel in ref-index objects.
        let indexed = match super::ref_index::index_refs(self.cfg.collection, refs) {
            Ok(x) => x,
            Err(blocked) => {
                self.snapshot_blocked = Some(blocked);
                self.stats.snapshot_builds_refused += 1;
                return Ok(());
            }
        };
        let refs = indexed.refs;
        uploads.extend(indexed.uploads);
        let sem = mdbn_core::semantics::SEM;
        let payload = ManifestPayload {
            seq: self.head.seq,
            chain: self.head.chain,
            state_digest: state_digest(&self.store)?,
            bucket_bits: bits,
            sections: out_sections,
            horizon: Horizon {
                seq_floor: self.head.seq.saturating_sub(HORIZON_ENTRIES),
                time_floor: self.log_time.saturating_sub(HORIZON_MS),
            },
            sem: Version {
                major: sem.major,
                minor: sem.minor,
            },
            record_count: records.len() as u64,
            file_count: files.len() as u64,
            control_chain: self.policy.ctl_chain,
            previous: self
                .store
                .meta(&format!("{LAST_MANIFEST}.address"))?
                .and_then(|b| <[u8; 32]>::try_from(b.as_slice()).ok())
                .map(B32),
        };
        let mut item = object_item(ItemKind::Manifest, self.cfg.collection, epoch);
        item.signer = Some(self.cfg.device_id);
        item.refs = (!refs.is_empty()).then(|| refs.clone());
        let Ok(plain) = mdbn_wire::ref_index::encode_manifest(&payload, &indexed.ref_indices)
        else {
            return Ok(());
        };
        if self
            .sealer
            .seal_object(&mut item, &plain, true, true, self.host.entropy.as_mut())
            .is_err()
        {
            return Ok(());
        }
        // The log service decodes `put_snapshot` and the manifest object within one
        // whole-request CBOR budget. A refs inventory that cannot fit is refused,
        // typed: never truncated, never registered without some of its roots.
        if let Err(blocked) = snapshot_refs_fit(self.cfg.collection, self.head.seq, &item) {
            self.snapshot_blocked = Some(blocked);
            self.stats.snapshot_builds_refused += 1;
            return Ok(());
        }
        self.snapshot_blocked = None;
        let bytes = item.to_bytes().unwrap_or_default();
        let manifest = mdbn_wire::hash::sha256(&bytes);
        uploads.push(Upload {
            address: manifest,
            kind: ItemKind::Manifest,
            bytes,
        });
        let outstanding = uploads.len();
        self.build = Some(Build {
            seq: self.head.seq,
            manifest,
            refs,
            outstanding,
            failed: false,
            payload,
        });
        for u in uploads {
            let id = self.queue(LogRequest::PutObject {
                collection: self.cfg.collection,
                address: u.address,
                kind: u.kind,
                bytes: u.bytes,
            });
            self.inflight.insert(id, Inflight::SnapPut);
        }
        Ok(())
    }

    pub(crate) fn on_snap_put(&mut self, ok: bool) {
        let Some(b) = self.build.as_mut() else {
            return;
        };
        b.outstanding = b.outstanding.saturating_sub(1);
        b.failed |= !ok;
        if b.outstanding > 0 {
            return;
        }
        if b.failed {
            self.build = None;
            return;
        }
        let params = PutSnapshotParams {
            collection: self.cfg.collection,
            seq: b.seq,
            manifest: b.manifest,
            refs: if b.refs.is_empty() {
                vec![b.manifest]
            } else {
                b.refs.clone()
            },
        };
        let id = self.queue(LogRequest::PutSnapshot(params));
        self.inflight.insert(id, Inflight::SnapRegister);
    }

    pub(crate) fn on_snap_registered(&mut self, accepted: bool) {
        let Some(b) = self.build.take() else {
            return;
        };
        if accepted {
            let _ = self.store.commit(Tx {
                meta: vec![
                    (LAST_MANIFEST.into(), b.payload.to_bytes().ok()),
                    (
                        format!("{LAST_MANIFEST}.address"),
                        Some(b.manifest.0.to_vec()),
                    ),
                ],
                ..Tx::default()
            });
            self.stats.snapshots_built += 1;
        }
    }

    // ------------------------------------------------------------ install

    /// Start installing the latest snapshot (behind retention, or bootstrapping).
    ///
    /// **Bounded.** Reachable when the store stages persistently
    /// ([`Replica::snapshot_install_available`]). A replica over a store without
    /// a staging area that is behind reports an incident instead.
    pub(crate) fn begin_install(&mut self) {
        if crate::mirror_admission::ensure_open(&self.store).is_err() {
            return;
        }
        // A snapshot-installed policy is not a replay this instance verified.
        self.hosted_origin_unproven();
        if !self.snapshot_install_available() {
            self.incident(
                IncidentKind::UpgradeRequired,
                Some(Value::Text(
                    "behind retention: this store cannot stage a snapshot install".into(),
                )),
            );
            return;
        }
        if self.install.is_some() {
            return;
        }
        self.install_refs = None;
        self.install = Some(Install::Control);
        self.install_refs = None;
        self.install_points = vec![ControlPoint {
            seq: self.policy.seq,
            policy: self.policy.clone(),
        }];
        self.caught_up = false;
        self.request_control_read();
        self.status_dirty = true;
    }

    /// Start installing the generation-0 manifest named by a valid `base` at
    /// `base.seq` (`snapshot.md` §7). The staged install machinery is the same as a
    /// snapshot's, with the base checks of [`Self::verify_base_manifest`]; apply
    /// waits before the base until the install swaps in its state at the base's
    /// position. Bounded staging is required exactly as for a snapshot install.
    pub(crate) fn begin_base_install(
        &mut self,
        base: BaseInstall,
        manifest: B32,
        signer: mdbn_wire::common::Uuid,
    ) {
        if crate::mirror_admission::ensure_open(&self.store).is_err() {
            return;
        }
        if self.install.is_some() {
            return;
        }
        self.install_refs = None;
        // The policy in force at the base: the manifest is verified against it.
        self.install_points = vec![ControlPoint {
            seq: 0,
            policy: self.policy.clone(),
        }];
        self.install_base = Some(base);
        self.caught_up = false;
        let p = SnapshotPointer {
            seq: 0,
            manifest,
            author: signer,
            created_at: 0,
            endorsed: false,
        };
        let id = self.queue(LogRequest::GetObject {
            collection: self.cfg.collection,
            address: p.manifest,
            range: None,
        });
        self.inflight.insert(id, Inflight::Install);
        self.install = Some(Install::Manifest(p));
        self.status_dirty = true;
    }

    /// A generation-0 manifest for the `base` being installed: `seq = 0`, zero
    /// chain and control chain, the base's state digest, signed by a device that is
    /// active and keyed in the policy at the base.
    fn verify_base_manifest(
        &self,
        raw: &[u8],
        item: &Item,
        m: &ManifestPayload,
        base: &BaseInstall,
    ) -> Result<(), &'static str> {
        super::mirror_install::check_gen0_manifest(
            raw,
            item,
            m,
            base.epoch,
            base.state_digest,
            &self.policy,
            self.sealer.verifier(),
        )
        .map(|_| ())
        .map_err(super::mirror_install::Error::message)
    }

    fn request_control_read(&mut self) {
        let id = self.queue(LogRequest::Read(ReadParams {
            collection: self.cfg.collection,
            after: self.policy.seq,
            limit: 1000,
            kinds: Some(mdbn_wire::log_service::ReadKinds::Control),
            max_bytes: self.read_bytes(),
        }));
        self.inflight.insert(id, Inflight::Install);
    }

    /// The policy state in force at `seq` (the last control item at or before it).
    fn policy_at(&self, seq: u64) -> Option<&crate::policy::PolicyState> {
        self.install_points
            .iter()
            .rev()
            .find(|c| c.seq <= seq)
            .map(|c| &c.policy)
    }

    /// The manifest's signer was an active, keyed device at its position, the
    /// signature verifies over the received bytes, and its control chain is the one
    /// this replica computed from the control items.
    pub(crate) fn verify_manifest(
        &self,
        raw: &[u8],
        item: &Item,
        m: &ManifestPayload,
        at: &crate::policy::PolicyState,
    ) -> Result<(), &'static str> {
        let signer = item.signer.ok_or("manifest has no signer")?;
        let d = at
            .devices
            .get(&signer)
            .filter(|d| d.active && d.keyed)
            .ok_or("manifest signer was not an active, keyed device at its position")?;
        let digest =
            crate::crypto::raw::signed_digest_from_bytes(raw).map_err(|_| "manifest digest")?;
        let sig = item.sig.ok_or("manifest is not signed")?;
        if !self.sealer.verifier().verify(&d.sign_pk.0, &digest, &sig.0) {
            return Err("manifest signature does not verify");
        }
        if m.control_chain != at.ctl_chain {
            return Err("manifest control chain differs from the control items read");
        }
        Ok(())
    }

    /// Whether this replica can install (and endorse) a snapshot: its store
    /// stages persistently, so an install never holds the whole snapshot.
    pub fn snapshot_install_available(&self) -> bool {
        self.store.stages() || (IN_MEMORY_INSTALL && !self.shipped_install_gate)
    }

    /// Apply the shipped build's install gate even in a test or simulator build
    /// (where the `testing` feature allows in-memory staging): install then
    /// needs a staging store. Only ever tightens the gate.
    pub fn enforce_shipped_install_gate(&mut self) {
        self.shipped_install_gate = true;
    }

    /// Whether an install is in progress (queries answer `complete: false`).
    pub fn installing(&self) -> bool {
        self.install.is_some()
    }

    /// Abandon the install. Nothing was written: the staged rows are dropped and the
    /// previous confirmed state and head stay as they were.
    pub(super) fn install_fail(&mut self, why: &str) {
        self.install_fail_as(IncidentKind::Integrity, why);
    }

    fn install_fail_as(&mut self, mut kind: IncidentKind, why: &str) {
        self.install = None;
        if let Some(b) = self.install_base.take() {
            self.base_install_failed = Some(b.seq);
        }
        self.install_refs = None;
        let cleanup = self.install_reset();
        let detail = match cleanup {
            Ok(()) => format!("snapshot install: {why}"),
            Err(e) => {
                // A cleanup/store failure is never downgraded to codec availability.
                kind = IncidentKind::Integrity;
                format!("snapshot install: {why}; staging cleanup failed: {e}")
            }
        };
        self.incident(kind, Some(Value::Text(detail)));
    }

    /// Drop everything staged: in memory, and in the store's staging area.
    fn install_reset(&mut self) -> Result<(), StoreError> {
        // A control-read failure may have an unknown committed outcome. Do not
        // issue a staging cleanup transaction after the terminal fail-stop.
        // Known-abort recovery can still discard/refetch and finish an install.
        if self.apply_fault {
            return Err(StoreError::Io("apply_reopen_required".into()));
        }
        self.install_points.clear();
        self.install_staged = Tx::default();
        self.install_native_roots = Default::default();
        self.install_native_auth = Default::default();
        self.install_text_sources = Default::default();
        self.install_mseq.clear();
        self.install_index = DigestIndex::default();
        self.install_resources.clear();
        if self.store.stages() {
            // Put/Swap must never consume leftovers from another install.
            // Commit is atomic and durable under the Store contract. If it fails,
            // initialization remains blocked and retries before fetching any chunk.
            if let Err(e) = self.store.commit(Tx {
                stage: crate::store::Stage::Discard,
                ..Tx::default()
            }) {
                if !matches!(e, StoreError::CommitAborted(_)) {
                    self.committed_read_fault();
                }
                return Err(e);
            }
        }
        Ok(())
    }

    fn install_start_chunks(&mut self, manifest: Box<ManifestPayload>) {
        if let Err(e) = self.install_reset() {
            self.install = Some(Install::Reset(manifest));
            self.install_retry = true;
            self.incident(
                IncidentKind::Integrity,
                Some(Value::Text(format!("snapshot staging initialization: {e}"))),
            );
            return;
        }
        let mut queue = Vec::new();
        for want in [
            SectionKind::Legacy(L::Resources),
            SectionKind::Legacy(L::Settings),
            SectionKind::Legacy(L::Index),
            SectionKind::Legacy(L::Records),
            SectionKind::Legacy(L::Files),
            SectionKind::AttachmentFiles,
            SectionKind::UnindexedMarkdownFiles,
            SectionKind::Legacy(L::Tombstones),
            SectionKind::AttachmentTombstones,
            SectionKind::UnindexedMarkdownTombstones,
            SectionKind::Legacy(L::Aliases),
            SectionKind::Legacy(L::Conflicts),
            SectionKind::Legacy(L::Receipts),
        ] {
            for s in manifest.sections.iter().filter(|s| s.kind == want) {
                queue.extend(s.chunks.iter().map(|c| (want, c.clone())));
            }
        }
        self.install_progress = (0, queue.len() as u64);
        self.install = Some(Install::Chunks {
            manifest,
            queue,
            next: 0,
        });
        self.install_next();
    }

    pub(crate) fn on_install_reply(&mut self, reply: crate::log::LogReply) {
        self.on_install_reply_body(reply, true);
    }
    #[cfg(test)]
    pub(crate) fn test_on_native_snapshot_reply(&mut self, reply: crate::log::LogReply) {
        self.on_install_reply_body(reply, true);
    }
    fn on_install_reply_body(&mut self, reply: crate::log::LogReply, native: bool) {
        let Some(state) = self.install.take() else {
            return;
        };
        let resp = match reply {
            Ok(r) => r,
            Err(_) => {
                // Transient: keep everything staged and retry this step on the next
                // tick. An install is never left half-applied.
                self.install = Some(state);
                self.install_retry = true;
                return;
            }
        };
        match (state, resp) {
            (Install::Control, LogResponse::Read(r)) => {
                for it in r.items {
                    if it.seq <= self.policy.seq {
                        continue;
                    }
                    match self.evaluate_control_bytes(it.seq, &it.item.0) {
                        Ok(()) => {}
                        Err(why) => return self.install_fail(&why),
                    }
                    self.install_points.push(ControlPoint {
                        seq: it.seq,
                        policy: self.policy.clone(),
                    });
                }
                self.install = Some(Install::Control);
                if r.more {
                    return self.request_control_read();
                }
                self.install = Some(Install::Pointer);
                let id = self.queue(LogRequest::GetSnapshot {
                    collection: self.cfg.collection,
                });
                self.inflight.insert(id, Inflight::Install);
            }
            (Install::Pointer, LogResponse::GetSnapshot(ptrs)) => {
                let Some(p) = ptrs.into_iter().next() else {
                    return self.install_fail("no snapshot to install");
                };
                let id = self.queue(LogRequest::GetObject {
                    collection: self.cfg.collection,
                    address: p.manifest,
                    range: None,
                });
                self.inflight.insert(id, Inflight::Install);
                self.install = Some(Install::Manifest(p));
            }
            (Install::Manifest(p), LogResponse::GetObject { bytes, .. }) => {
                if mdbn_wire::hash::sha256(&bytes) != p.manifest {
                    return self.install_fail("manifest address mismatch");
                }
                let Ok(item) = Item::from_bytes(&bytes) else {
                    return self.install_fail("manifest does not decode");
                };
                if item.kind != ItemKind::Manifest || item.collection != self.cfg.collection {
                    return self.install_fail("not a manifest of this collection");
                }
                let Ok(plain) = self.sealer.open(&item, &bytes) else {
                    return self.install_fail("manifest does not open");
                };
                // The closed runtime family decodes legacy1–9, attachment10/11
                // and unindexed12/13. Unsupported decoded sections below stall
                // before any row; genuinely future sections fail decoding.
                let (m, ref_indices) = match mdbn_wire::ref_index::decode_manifest(&plain) {
                    Ok(m) => m,
                    Err(e) if e.is_unknown() => {
                        return self.install_fail_as(
                            IncidentKind::UpgradeRequired,
                            "manifest payload requires a newer codec",
                        );
                    }
                    Err(_) => return self.install_fail("manifest payload does not decode"),
                };
                if !native
                    && m.sections.iter().any(|s| {
                        matches!(
                            s.kind,
                            SectionKind::UnindexedMarkdownFiles
                                | SectionKind::UnindexedMarkdownTombstones
                        )
                    })
                {
                    return self.install_fail_as(
                        IncidentKind::UpgradeRequired,
                        "unindexed_markdown_snapshot_not_yet",
                    );
                }
                if m.seq != p.seq {
                    return self.install_fail("manifest position differs from its pointer");
                }
                let verdict = match (&self.install_base, self.policy_at(m.seq)) {
                    (Some(base), _) => self.verify_base_manifest(&bytes, &item, &m, base),
                    (None, Some(at)) => self.verify_manifest(&bytes, &item, &m, at),
                    (None, None) => Err("no policy state at the manifest's position"),
                };
                if let Err(why) = verdict {
                    return self.install_fail(why);
                }
                // Direct refs retain their source closure as before. Fmt-2
                // keeps header refs in the charged compact vector, not an extra
                // preview tree alongside verified members/final conversion.
                self.install_refs = ref_indices
                    .is_empty()
                    .then(|| item.refs.clone().unwrap_or_default().into_iter().collect());
                // The key epoch in force at the snapshot's position bounds the
                // attachment descriptors its rows may carry (V7).
                self.install_epoch = self.policy_at(m.seq).map_or(0, |p| p.epoch);
                if self.install_base.is_none() && self.head.seq > 0 && m.seq <= self.head.seq {
                    return self.install_fail("snapshot is not ahead of this replica's head");
                }
                let item_refs = item.refs.unwrap_or_default();
                self.install_after_manifest(p, Box::new(m), item_refs, ref_indices);
            }
            (state @ Install::RefIndices { .. }, LogResponse::GetObject { bytes, .. }) => {
                self.on_ref_index_object(state, bytes);
            }
            (Install::Chain(_p, m), LogResponse::Read(r)) => {
                let ok = match r.items.first() {
                    Some(it) if it.seq == m.seq + 1 => {
                        Item::from_bytes(&it.item.0).ok().and_then(|i| i.prev) == Some(m.chain)
                    }
                    _ => r.head == m.seq && r.head_chain == m.chain,
                };
                if !ok {
                    return self.install_fail("manifest chain does not match the log");
                }
                // Stage only after old staging was successfully discarded.
                // Confirmed state stays untouched until the verified swap.
                self.install_start_chunks(m);
            }
            (
                Install::Chunks {
                    manifest,
                    queue,
                    next,
                },
                LogResponse::GetObject { bytes, .. },
            ) => {
                let Some((kind, cref)) = queue.get(next).cloned() else {
                    return self.install_fail("chunk out of order");
                };
                if mdbn_wire::hash::sha256(&bytes) != cref.address {
                    return self.install_fail("chunk address mismatch");
                }
                let plain = Item::from_bytes(&bytes)
                    .ok()
                    .and_then(|i| self.sealer.open(&i, &bytes).ok());
                let Some(plain) = plain else {
                    return self.install_fail("chunk does not open");
                };
                if mdbn_wire::hash::sha256(&plain) != cref.plain_hash
                    || plain.len() as u64 != cref.plain_size
                {
                    return self.install_fail("chunk plaintext differs from its reference");
                }
                let chunk = match ChunkPayload::from_bytes(&plain) {
                    Ok(chunk) => chunk,
                    Err(e) if e.is_unknown() => {
                        return self.install_fail_as(
                            IncidentKind::UpgradeRequired,
                            "chunk payload requires a newer codec",
                        );
                    }
                    Err(_) => return self.install_fail("chunk does not decode"),
                };
                if chunk.section != kind {
                    return self.install_fail("chunk section differs");
                }
                let extended = matches!(
                    chunk.section,
                    SectionKind::UnindexedMarkdownFiles | SectionKind::UnindexedMarkdownTombstones
                ) || (chunk.section == SectionKind::Legacy(L::Conflicts)
                    && chunk.rows_as::<WConflictRow>().is_ok_and(|rows| {
                        rows.iter().any(|r| {
                            super::attachment_runtime::extended_conflict_not_yet(&r.conflict)
                        })
                    }));
                if extended && !native {
                    return self.install_fail_as(
                        IncidentKind::UpgradeRequired,
                        "unindexed_markdown_snapshot_not_yet",
                    );
                }
                if let Err(e) = self.install_chunk(&manifest, &chunk, native) {
                    return self.install_fail(&e);
                }
                self.install_progress.0 += 1;
                self.status_dirty = true;
                self.install = Some(Install::Chunks {
                    manifest,
                    queue,
                    next: next + 1,
                });
                self.install_next();
            }
            _ => self.install_fail("unexpected reply"),
        }
    }

    /// Re-issue the current install step after a transient failure.
    pub(crate) fn retry_install(&mut self) {
        if !std::mem::take(&mut self.install_retry) {
            return;
        }
        if matches!(self.install, Some(Install::Reset(_))) {
            if let Some(Install::Reset(manifest)) = self.install.take() {
                self.install_start_chunks(manifest);
            }
            return;
        }
        let request = match &self.install {
            Some(Install::Control) => return self.request_control_read(),
            Some(Install::Pointer) => LogRequest::GetSnapshot {
                collection: self.cfg.collection,
            },
            Some(Install::Manifest(p)) => LogRequest::GetObject {
                collection: self.cfg.collection,
                address: p.manifest,
                range: None,
            },
            Some(Install::RefIndices { .. }) => return self.request_next_ref_index(),
            Some(Install::Chain(_, m)) => LogRequest::Read(ReadParams {
                collection: self.cfg.collection,
                after: m.seq,
                limit: 1,
                kinds: None,
                max_bytes: None,
            }),
            Some(Install::Sources(_)) => {
                if let Some(Install::Sources(m)) = self.install.take() {
                    self.install_finish(m);
                }
                return;
            }
            Some(Install::Chunks { .. }) => return self.install_next(),
            Some(Install::Reset(_)) | None => return,
        };
        let id = self.queue(request);
        self.inflight.insert(id, Inflight::Install);
    }

    fn install_next(&mut self) {
        let Some(Install::Chunks {
            manifest,
            queue,
            next,
        }) = self.install.take()
        else {
            return;
        };
        if let Some((_, c)) = queue.get(next) {
            let id = self.queue(LogRequest::GetObject {
                collection: self.cfg.collection,
                address: c.address,
                range: None,
            });
            self.inflight.insert(id, Inflight::Install);
            self.install = Some(Install::Chunks {
                manifest,
                queue,
                next,
            });
            return;
        }
        self.install_finish(manifest);
    }
    fn install_finish(&mut self, manifest: Box<ManifestPayload>) {
        self.install = Some(Install::Sources(manifest.clone()));
        match self.snapshot_text_check(&manifest) {
            super::snapshot_text::Check::Pending => {
                self.install_retry = true;
                return;
            }
            super::snapshot_text::Check::Ready => {}
            super::snapshot_text::Check::Failed(crate::attachments::StreamError::NoKey) => {
                self.snapshot_text_wait_key();
                self.incident(
                    IncidentKind::WaitingForKey,
                    Some(Value::Text("snapshot record source key unavailable".into())),
                );
                return;
            }
            super::snapshot_text::Check::Failed(e) => {
                return self.install_fail(&format!("record source: {e:?}"));
            }
        }
        let source_meta = match self.native_install_check(&manifest) {
            super::unindexed_snapshot::Check::Pending => {
                self.install_retry = true;
                return;
            }
            super::unindexed_snapshot::Check::Ready(meta) => meta,
            super::unindexed_snapshot::Check::StoreFailed(e) => {
                return self.install_fail(&format!("source store: {e}"));
            }
            super::unindexed_snapshot::Check::Failed(crate::attachments::StreamError::NoKey) => {
                self.native_install_wait_key();
                self.incident(
                    IncidentKind::WaitingForKey,
                    Some(Value::Text("snapshot native source key unavailable".into())),
                );
                return;
            }
            super::unindexed_snapshot::Check::Failed(e) => {
                return self.install_fail(&format!("native source: {e:?}"));
            }
        };
        // Finish only after complete source authentication and the exact digest.
        self.install_mseq.clear();
        self.install_resources.clear();
        let index = std::mem::take(&mut self.install_index);
        if index.digest() != manifest.state_digest {
            return self.install_fail("state digest mismatch");
        }
        drop(index);
        let mut staged = std::mem::take(&mut self.install_staged);
        let base = self.install_base.clone();
        let head = match &base {
            Some(b) => Head {
                seq: b.seq,
                chain: b.chain,
            },
            None => Head {
                seq: manifest.seq,
                chain: manifest.chain,
            },
        };
        let log_time = match &base {
            Some(_) => self.log_time,
            None => manifest.horizon.time_floor.saturating_add(HORIZON_MS),
        };
        // A base: its policy effect (content seen, control chain) and its retained
        // item commit in the same transaction as the swap.
        let policy_before = self.policy.clone();
        if let Some(b) = &base {
            self.policy.note_base(b.seq, &b.chain);
            staged.meta.push(self.policy_meta());
            staged.tail_put.push(crate::store::TailRow {
                seq: b.seq,
                item: b.item.clone(),
                applied_at: self.now(),
            });
        }
        if self.store.stages() {
            staged.stage = crate::store::Stage::Swap;
        } else {
            staged.clear_confirmed = true;
        }
        staged.head = Some(head);
        staged.meta.extend(source_meta);
        staged.meta.push((
            meta_keys::LOG_STATE.into(),
            log_state(log_time, self.sem_ratchet),
        ));
        staged
            .meta
            .push((LAST_MANIFEST.into(), manifest.to_bytes().ok()));
        if let Err(e) = self.store.commit(staged) {
            self.policy = policy_before;
            if !matches!(e, StoreError::CommitAborted(_)) {
                self.committed_read_fault();
            }
            return self.install_fail(&format!("store: {e}"));
        }
        if base.is_some() {
            self.stats.applied += 1;
            self.tail_stats_dirty = true;
        }
        self.install_base = None;
        self.install = None;
        self.install_native_auth = Default::default();
        self.install_text_sources = Default::default();
        self.install_native_roots = Default::default();
        #[cfg(test)]
        {
            self.installed_refs = self.install_refs.clone();
        }
        self.install_refs = None;
        self.head = head;
        self.store_generation += 1;
        self.log_time = log_time;
        // The accumulator must be recomputed from the control items read
        // from position 1 and compared with the manifest's; that check lands with
        // policy wiring (the control-item read happens there). Until then the
        // manifest's value is adopted.
        // The policy state is the one read from the control items; control items
        // after `seq` are applied already and only advance the head on the tail read.
        self.install_points.clear();
        self.stats.snapshots_installed += 1;
        match crate::plan::load_catalog(&self.store) {
            Ok(c) => {
                self.catalog = std::sync::Arc::new(c);
                // Invalidate the cached query context after snapshot install.
                self.query_context = None;
            }
            Err(e) => return self.install_fail(&format!("store: {e}")),
        }
        // The install replaced confirmed state; the derived query index follows.
        // A failure leaves it unready (queries use the per-record path) and is
        // reported, never swallowed.
        let backfill = self.backfill_query_index();
        self.clear_incident(IncidentKind::Integrity);
        self.clear_incident(IncidentKind::WaitingForKey);
        if let Err(e) = backfill {
            self.query_context = None;
            self.incident(
                IncidentKind::Integrity,
                Some(Value::Text(format!("store: query index backfill: {e}"))),
            );
        }
        let all: std::collections::BTreeSet<String> =
            self.pending_keys.values().flatten().cloned().collect();
        let mut ids = super::live::ids_from_keys(&all);
        match self.rebuild_local_view(&all) {
            Ok(more) => ids.extend(more),
            Err(e) => return self.install_fail(&format!("store: {e}")),
        }
        // The folder is made to match the installed view from what the store knows
        // is on disk, never by assuming what was there.
        self.before.clear();
        let _ = self.reconcile_disk();
        self.status_dirty = true;
        self.notify(&ids);
        // Resubscribe at the new head and read the tail.
        self.queue_head_fetch();
        self.request_read();
    }

    fn native_snapshot_content_ok(&self, c: &FileContent) -> Result<(), String> {
        let epoch = match c {
            FileContent::Blob(b) => b.id_epoch,
            FileContent::AttachmentV1(a) => a.reference.key_epoch,
            _ => return Err("unknown native source".into()),
        };
        if epoch >= 1 && epoch <= self.install_epoch && self.unindexed_content_in_bounds(c) {
            Ok(())
        } else {
            Err("native snapshot descriptor bounds".into())
        }
    }
    pub(super) fn stage_snapshot_text(
        &mut self,
        id: mdbn_wire::common::Uuid,
        path: String,
        modified_seq: u64,
        doc: &str,
    ) -> Result<(), String> {
        let catalog = mdbn_core::types::Catalog::load(
            self.install_resources
                .iter()
                .map(|(p, d)| (p.as_str(), d.as_str())),
        );
        let r = RecordRow {
            id,
            path_key: mdbn_core::paths::path_key(&path),
            revision: mdbn_wire::hash::sha256(doc.as_bytes()),
            modified_seq,
            bucket: bucket16(&id),
            meta: record_meta(&catalog, &path, doc),
            path,
            doc: doc.to_owned(),
        };
        self.install_index.record(&r)?;
        let mut tx = Tx {
            records_put: vec![r],
            ..Tx::default()
        };
        if self.store.stages() {
            tx.stage = crate::store::Stage::Put;
            if let Err(e) = self.store.commit(tx) {
                if !matches!(e, StoreError::CommitAborted(_)) {
                    self.committed_read_fault();
                }
                return Err(format!("record source staging: {e}"));
            }
        } else {
            extend_rows(&mut self.install_staged, tx);
        }
        Ok(())
    }
    fn install_chunk(
        &mut self,
        _m: &ManifestPayload,
        chunk: &ChunkPayload,
        native: bool,
    ) -> Result<(), String> {
        // Rows are validated exactly as a log entry's effects would be (V7): a
        // snapshot can never carry what an entry could not.
        let path_ok = |p: &str| -> Result<(), String> {
            mdbn_core::paths::check_path(p).map_err(|v| format!("row path {p:?}: {}", v.reason()))
        };
        let blob_ok = |b: &mdbn_wire::intent::BlobRef| -> Result<(), String> {
            crate::crypto::blob::validate_blob_ref(b)
                .map_err(|_| "row blob ref out of range".to_string())
        };
        let text_ok = |t: &str| -> Result<(), String> {
            if t.len() > MAX_ROW_TEXT {
                return Err("row text over the size limit".into());
            }
            Ok(())
        };
        // V7 for a signed attachment descriptor, as apply checks it: this
        // collection, an epoch the policy had reached at the snapshot's position,
        // and a size within the cap. The manifest itself is authenticated when
        // the content is fetched or its inventory is read.
        let epoch_at = self.install_epoch;
        let collection = self.cfg.collection;
        let att_ok = |a: &AttachmentContentV1| -> Result<(), String> {
            let ok = a.reference.collection == collection
                && a.reference.key_epoch >= 1
                && a.reference.key_epoch <= epoch_at
                && a.total_plain_bytes
                    <= crate::crypto::chunked_blob::AttachmentLimits::default().max_file_bytes;
            if ok {
                Ok(())
            } else {
                Err("row attachment descriptor out of bounds".into())
            }
        };
        let mut tx = Tx::default();
        let bad = |e: mdbn_wire::schema::SchemaError| format!("row: {e}");
        match chunk.section {
            SectionKind::Legacy(L::Resources) => {
                for r in chunk.rows_as::<ResourceRow>().map_err(bad)? {
                    let TextOrBlob::Text(d) = r.doc else {
                        return Err("blob-backed resources are not supported".into());
                    };
                    path_ok(&r.path)?;
                    text_ok(&d)?;
                    self.install_index.resource(&r.path, &d);
                    self.install_resources.push((r.path.clone(), d.clone()));
                    tx.resources_put.push((r.path, d));
                }
            }
            SectionKind::Legacy(L::Settings) => {
                if let Some(s) = chunk
                    .rows_as::<FileInclusion>()
                    .map_err(bad)?
                    .into_iter()
                    .next()
                {
                    self.install_index.settings = Some(s.clone());
                    tx.settings = Some(s);
                }
            }
            SectionKind::Legacy(L::Records) => {
                // Resources are staged first; records are indexed under that catalog.
                let catalog = mdbn_core::types::Catalog::load(
                    self.install_resources
                        .iter()
                        .map(|(p, d)| (p.as_str(), d.as_str())),
                );
                for r in chunk.rows_as::<WRecordRow>().map_err(bad)? {
                    path_ok(&r.path)?;
                    let doc = match r.doc {
                        TextOrBlob::Text(doc) => doc,
                        TextOrBlob::Blob(blob) if native => {
                            blob_ok(&blob)?;
                            if blob.size > 1048576 || blob.id_epoch < 1 || blob.id_epoch > epoch_at
                            {
                                return Err("record snapshot source bounds".into());
                            }
                            self.install_text_sources.add(super::snapshot_text::Row {
                                id: r.id,
                                path: r.path,
                                blob,
                                modified_seq: self.install_mseq.get(&r.id).copied().unwrap_or(0),
                            });
                            continue;
                        }
                        TextOrBlob::Blob(_) => {
                            return Err("blob-backed records are not supported yet".into());
                        }
                        TextOrBlob::Attachment(_) => {
                            return Err(
                                "attachment hold is not a record snapshot text source".into()
                            );
                        }
                    };
                    text_ok(&doc)?;
                    tx.records_put.push(RecordRow {
                        id: r.id,
                        path_key: mdbn_core::paths::path_key(&r.path),
                        revision: mdbn_wire::hash::sha256(doc.as_bytes()),
                        modified_seq: self.install_mseq.get(&r.id).copied().unwrap_or(0),
                        bucket: bucket16(&r.id),
                        meta: record_meta(&catalog, &r.path, &doc),
                        path: r.path,
                        doc,
                    });
                }
            }
            SectionKind::Legacy(L::Files) => {
                for f in chunk.rows_as::<WFileRow>().map_err(bad)? {
                    path_ok(&f.path)?;
                    blob_ok(&f.blob)?;
                    tx.files_put.push(FileRow {
                        id: f.id,
                        path_key: mdbn_core::paths::path_key(&f.path),
                        media: media_class(&f.path),
                        modified_seq: self.install_mseq.get(&f.id).copied().unwrap_or(0),
                        bucket: bucket16(&f.id),
                        local: FileLocal::Remote,
                        kind: mdbn_wire::unindexed_markdown::FileKindV1::Ordinary,
                        content: FileContent::Blob(f.blob),
                        path: f.path,
                    });
                }
            }
            SectionKind::Legacy(L::Tombstones) => {
                for t in chunk.rows_as::<WTombstoneRow>().map_err(bad)? {
                    path_ok(&t.path)?;
                    match &t.last {
                        TextOrBlob::Text(d) => text_ok(d)?,
                        TextOrBlob::Blob(b) => blob_ok(b)?,
                        TextOrBlob::Attachment(_) => {
                            return Err("attachment hold is not a legacy tombstone source".into());
                        }
                    }
                    tx.tombstones_put.push(TombstoneRow {
                        id: t.id,
                        kind: t.kind,
                        path_key: mdbn_core::paths::path_key(&t.path),
                        last: match t.last {
                            TextOrBlob::Text(d) => TombstoneLast::Doc(d),
                            TextOrBlob::Blob(b) => TombstoneLast::Blob(b),
                            TextOrBlob::Attachment(_) => {
                                return Err(
                                    "attachment hold is not a legacy tombstone source".into()
                                );
                            }
                        },
                        path: t.path,
                        seq: t.seq,
                        time: t.time,
                    });
                }
            }
            SectionKind::Legacy(L::Aliases) => {
                for a in chunk.rows_as::<Alias>().map_err(bad)? {
                    if !alias_path_ok(&a.path) {
                        return Err("row alias is not a relative lookup key".into());
                    }
                    tx.aliases_put.push(AliasRow {
                        path_key: mdbn_core::paths::path_key(&a.path),
                        path: a.path,
                        record: a.record,
                    });
                }
            }
            SectionKind::Legacy(L::Conflicts) => {
                for c in chunk.rows_as::<WConflictRow>().map_err(bad)? {
                    for v in [
                        Some(&c.conflict.kept),
                        Some(&c.conflict.lost),
                        c.conflict.base.as_ref(),
                    ]
                    .into_iter()
                    .flatten()
                    {
                        match v {
                            rt::ConflictValue::Legacy(mdbn_wire::entry::ConflictValue::Blob(b)) => {
                                blob_ok(b)?
                            }
                            rt::ConflictValue::Attachment(a) => att_ok(a)?,
                            rt::ConflictValue::UnindexedMarkdown(p) => {
                                self.native_snapshot_content_ok(&p.content)?;
                                self.install_native_roots
                                    .add(&p.content)
                                    .map_err(|e| e.to_string())?;
                            }
                            rt::ConflictValue::Legacy(_) => {}
                        }
                    }
                    tx.conflicts_put.push(ConflictRow {
                        mutation: c.mutation,
                        seq: c.seq,
                        conflict: c.conflict,
                    });
                }
            }
            SectionKind::AttachmentFiles => {
                for f in chunk.rows_as::<AttachmentFileRowV1>().map_err(bad)? {
                    path_ok(&f.path)?;
                    att_ok(&f.content)?;
                    tx.files_put.push(FileRow {
                        id: f.id,
                        path_key: mdbn_core::paths::path_key(&f.path),
                        media: media_class(&f.path),
                        modified_seq: self.install_mseq.get(&f.id).copied().unwrap_or(0),
                        bucket: bucket16(&f.id),
                        // Nothing is on this device yet: the installed row is
                        // fetched and placed by the attachment reconcile.
                        local: FileLocal::Remote,
                        kind: mdbn_wire::unindexed_markdown::FileKindV1::Ordinary,
                        content: FileContent::AttachmentV1(f.content),
                        path: f.path,
                    });
                }
            }
            SectionKind::AttachmentTombstones => {
                for t in chunk.rows_as::<AttachmentTombstoneRowV1>().map_err(bad)? {
                    path_ok(&t.path)?;
                    att_ok(&t.content)?;
                    tx.tombstones_put.push(TombstoneRow {
                        id: t.id,
                        kind: EntityKind::File,
                        path_key: mdbn_core::paths::path_key(&t.path),
                        last: TombstoneLast::Attachment(t.content),
                        path: t.path,
                        seq: t.seq,
                        time: t.time,
                    });
                }
            }
            SectionKind::UnindexedMarkdownFiles => {
                for f in chunk
                    .rows_as::<mdbn_wire::unindexed_markdown::UnindexedMarkdownFileRowV1>()
                    .map_err(bad)?
                {
                    path_ok(&f.path)?;
                    self.native_snapshot_content_ok(&f.payload.content)?;
                    self.install_native_roots
                        .add(&f.payload.content)
                        .map_err(|e| e.to_string())?;
                    tx.files_put.push(FileRow {
                        id: f.id,
                        path_key: mdbn_core::paths::path_key(&f.path),
                        path: f.path,
                        media: f.media,
                        modified_seq: self.install_mseq.get(&f.id).copied().unwrap_or(0),
                        bucket: bucket16(&f.id),
                        local: FileLocal::Remote,
                        kind: mdbn_wire::unindexed_markdown::FileKindV1::UnindexedOversizedMarkdown,
                        content: f.payload.content,
                    });
                }
            }
            SectionKind::UnindexedMarkdownTombstones => {
                for t in chunk
                    .rows_as::<mdbn_wire::unindexed_markdown::UnindexedMarkdownTombstoneRowV1>()
                    .map_err(bad)?
                {
                    path_ok(&t.path)?;
                    self.native_snapshot_content_ok(&t.payload.content)?;
                    self.install_native_roots
                        .add(&t.payload.content)
                        .map_err(|e| e.to_string())?;
                    tx.tombstones_put.push(TombstoneRow {
                        id: t.id,
                        kind: EntityKind::File,
                        path_key: mdbn_core::paths::path_key(&t.path),
                        path: t.path,
                        last: TombstoneLast::UnindexedMarkdown(t.payload),
                        seq: t.seq,
                        time: t.time,
                    });
                }
            }
            SectionKind::Legacy(L::Receipts) => {
                for r in chunk.rows_as::<WReceiptRow>().map_err(bad)? {
                    tx.receipts_put.push(ReceiptRow {
                        mutation: r.mutation,
                        seq: r.seq,
                        time: r.time,
                    });
                }
            }
            SectionKind::Legacy(L::Index) => {
                for r in chunk.rows_as::<IndexRow>().map_err(bad)? {
                    self.install_mseq.insert(r.id, r.modified_seq);
                }
            }
        }
        // Index the rows (state digest, duplicate IDs and path keys), then stage
        // them: in the store's staging area when it has one, so memory holds one
        // chunk plus the index.
        for r in &tx.records_put {
            self.install_index.record(r)?;
        }
        for f in &tx.files_put {
            self.install_index.file(f)?;
        }
        for t in &tx.tombstones_put {
            self.install_index.tombstone(t)?;
        }
        for a in &tx.aliases_put {
            self.install_index.alias(a);
        }
        for c in &tx.conflicts_put {
            self.install_index.conflict(c);
        }
        if self.store.stages() {
            tx.stage = crate::store::Stage::Put;
            if let Err(e) = self.store.commit(tx) {
                if !matches!(e, StoreError::CommitAborted(_)) {
                    self.committed_read_fault();
                }
                return Err(format!("staging: {e}"));
            }
        } else {
            extend_rows(&mut self.install_staged, tx);
        }
        Ok(())
    }

    // ------------------------------------------------------------ endorsement

    /// Ask the service for its snapshot pointers; an unendorsed one from another
    /// device at exactly this replica's head is checked and endorsed.
    ///
    /// The manifest's signature (signer's rights at the head) and every chunk it
    /// references are verified before endorsing.
    pub fn check_snapshots(&mut self) {
        if self.apply_fault
            || self.is_apply_recovering()
            || !self.snapshot_install_available()
            || self.endorse.is_some()
        {
            return;
        }
        let id = self.queue(LogRequest::GetSnapshot {
            collection: self.cfg.collection,
        });
        self.inflight.insert(id, Inflight::Endorse);
    }

    pub(crate) fn on_endorse_pointers(&mut self, reply: crate::log::LogReply) {
        let Ok(LogResponse::GetSnapshot(ptrs)) = reply else {
            return;
        };
        for p in ptrs {
            if p.endorsed || p.author == self.cfg.device_id || p.seq != self.head.seq {
                continue;
            }
            self.endorse = Some(Endorse::Manifest(p.clone()));
            let id = self.queue(LogRequest::GetObject {
                collection: self.cfg.collection,
                address: p.manifest,
                range: None,
            });
            self.inflight.insert(id, Inflight::EndorseManifest);
            return;
        }
    }

    pub(crate) fn on_endorse_manifest(&mut self, reply: crate::log::LogReply) {
        if self.apply_fault || self.is_apply_recovering() {
            self.endorse = None;
            return;
        }
        let Some(state) = self.endorse.take() else {
            return;
        };
        let Ok(LogResponse::GetObject { bytes, .. }) = reply else {
            return;
        };
        match state {
            Endorse::Manifest(p) => {
                if mdbn_wire::hash::sha256(&bytes) != p.manifest || p.seq != self.head.seq {
                    return;
                }
                let Ok(item) = Item::from_bytes(&bytes) else {
                    return;
                };
                let Some(m) = self
                    .sealer
                    .open(&item, &bytes)
                    .ok()
                    .and_then(|b| mdbn_wire::ref_index::decode_manifest(&b).ok())
                    .map(|(m, _)| m)
                else {
                    return;
                };
                let at = self.policy.clone();
                let ours = state_digest(&self.store).ok();
                let ok = item.kind == ItemKind::Manifest
                    && item.collection == self.cfg.collection
                    && m.seq == self.head.seq
                    && m.chain == self.head.chain
                    && ours == Some(m.state_digest)
                    && self.verify_manifest(&bytes, &item, &m, &at).is_ok();
                if !ok {
                    self.incident(
                        IncidentKind::VerificationMismatch,
                        Some(Value::Text(format!(
                            "snapshot at {} differs from this replica",
                            p.seq
                        ))),
                    );
                    return;
                }
                let queue: Vec<ChunkRef> = m
                    .sections
                    .iter()
                    .flat_map(|s| s.chunks.iter().cloned())
                    .filter(|c| !self.verified_chunks.contains(&c.address))
                    .collect();
                self.endorse = Some(Endorse::Chunks { p, queue, next: 0 });
                self.endorse_next();
            }
            Endorse::Chunks { p, queue, next } => {
                let Some(c) = queue.get(next) else {
                    return;
                };
                let good = mdbn_wire::hash::sha256(&bytes) == c.address
                    && Item::from_bytes(&bytes)
                        .ok()
                        .and_then(|i| self.sealer.open(&i, &bytes).ok())
                        .is_some_and(|plain| mdbn_wire::hash::sha256(&plain) == c.plain_hash);
                if !good {
                    self.incident(
                        IncidentKind::VerificationMismatch,
                        Some(Value::Text(format!(
                            "snapshot at {}: a chunk does not verify",
                            p.seq
                        ))),
                    );
                    return;
                }
                self.verified_chunks.insert(c.address);
                self.endorse = Some(Endorse::Chunks {
                    p,
                    queue,
                    next: next + 1,
                });
                self.endorse_next();
            }
        }
    }

    fn endorse_next(&mut self) {
        let Some(Endorse::Chunks { p, queue, next }) = self.endorse.take() else {
            return;
        };
        if let Some(c) = queue.get(next) {
            let id = self.queue(LogRequest::GetObject {
                collection: self.cfg.collection,
                address: c.address,
                range: None,
            });
            self.inflight.insert(id, Inflight::EndorseManifest);
            self.endorse = Some(Endorse::Chunks { p, queue, next });
            return;
        }
        if p.seq != self.head.seq {
            return;
        }
        let id = self.queue(LogRequest::EndorseSnapshot(EndorseSnapshotParams {
            collection: self.cfg.collection,
            seq: p.seq,
            manifest: p.manifest,
        }));
        self.inflight.insert(id, Inflight::Other);
    }

    /// Build a snapshot when enough has been appended since the last one.
    pub(crate) fn maybe_build(&mut self) {
        if self.build.is_some() || self.install.is_some() || !self.caught_up {
            return;
        }
        let last = self
            .store
            .meta(LAST_MANIFEST)
            .ok()
            .flatten()
            .and_then(|b| ManifestPayload::from_bytes(&b).ok())
            .map(|m| m.seq)
            .unwrap_or(0);
        if self.head.seq >= last + self.snapshot_every {
            let _ = self.build_snapshot_now();
        }
    }
}

pub(super) fn object_item(kind: ItemKind, collection: mdbn_wire::common::Uuid, epoch: u64) -> Item {
    Item {
        kind,
        collection,
        seq: None,
        prev: None,
        epoch: Some(epoch),
        signer: None,
        salt: None,
        idem: None,
        refs: None,
        stream: None,
        body: Bytes(Vec::new()),
        sig: None,
    }
}

/// Split rows into chunks of at most [`MAX_CHUNK`] encoded bytes (ordinals from 0).
pub(super) fn split(rows: Vec<Cbor>) -> Vec<(u64, Vec<Cbor>)> {
    let mut out: Vec<(u64, Vec<Cbor>)> = vec![(0, Vec::new())];
    let mut size = 0usize;
    for r in rows {
        let n = enc(&r).len();
        if size + n > MAX_CHUNK && !out.last().is_some_and(|c| c.1.is_empty()) {
            let ord = out.len() as u64;
            out.push((ord, Vec::new()));
            size = 0;
        }
        size += n;
        if let Some(last) = out.last_mut() {
            last.1.push(r);
        }
    }
    out
}

#[allow(dead_code)]
fn _text(_: Text) {}
