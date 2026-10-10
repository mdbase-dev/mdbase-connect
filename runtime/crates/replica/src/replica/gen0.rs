//! Generation 0 for an adoption `base` (`snapshot.md` §7), written in bounded memory.
//!
//! A hosted import (migration H4) holds the collection only as a metadata spill and
//! a legacy source, never as a store. [`Gen0Writer`] seals a generation-0 snapshot
//! (`seq = 0`, `chain = 0`, `control_chain = ctl(0) = 0`) **one bucket at a time**:
//! the caller hands it every resource once, then each bucket's records and files in
//! bucket order, and uploads the sealed chunk objects each call returns. Only the
//! chunk references and the attachment/blob refs are kept until
//! [`Gen0Writer::finish`]. Rows are encoded exactly as an ordinary snapshot build
//! encodes them (same sections, same row types, same per-bucket chunks), so the
//! replica's existing staged install reads them.
//!
//! [`StateDigestStream`] computes the manifest's state digest (`snapshot.md` §4)
//! from rows streamed in key order with known counts. It produces the same value
//! as the replica's in-memory digest, without a collection-wide map.
//!
//! Formats (migration decision 4A): ordinary files are `AttachmentV1` only;
//! documents over the record cap are `UnindexedOversizedMarkdown` files. No
//! tombstones, aliases, conflicts or receipts exist at generation 0.

use mdbn_wire::attachment::{AttachmentFileRowV1, FileContent};
use mdbn_wire::attachment_runtime_v1::{ChunkPayload, ManifestPayload, Section, SectionKind};
use mdbn_wire::cbor::Cbor;
use mdbn_wire::common::{B16, B32, Hash, Uuid, Version};
use mdbn_wire::envelope::{Item, ItemKind};
use mdbn_wire::intent::{FileInclusion, MediaClass};
use mdbn_wire::schema::Wire;
use mdbn_wire::snapshot::{
    ChunkRef, EntityKind, Horizon, IndexRow, RecordRow as WRecordRow, ResourceRow,
    SectionKind as L, TextOrBlob,
};
use mdbn_wire::unindexed_markdown::{UnindexedMarkdownFileRowV1, UnindexedMarkdownPayloadV1};
use sha2::{Digest, Sha256};

use super::ref_index::index_refs;
use super::snapshot::{TARGET_CHUNK, ceil_log2, enc, object_item, split};
use crate::crypto::CsprngEntropy;
use crate::seal::Sealer;
use crate::store::bucket16;

/// Why generation 0 could not be written. Counts and IDs only, never content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Gen0Error {
    /// Calls out of order (resources first, then every bucket in order, then finish).
    Order(&'static str),
    /// A row is not in the bucket being written.
    WrongBucket,
    /// Two rows share an ID, or rows are not ascending.
    Duplicate,
    /// An ordinary file is not `AttachmentV1` (decision 4A), or a declared section
    /// was not announced.
    Format(&'static str),
    /// The sealer has no current key, or sealing failed.
    Seal,
    /// The refs cannot be indexed within the snapshot limits.
    TooManyRefs,
    /// One call's rows exceed the writer's per-call bound (choose more bucket bits).
    TooLarge,
}

/// The most rows one call takes (one bucket, or all resources).
pub const MAX_CALL_ROWS: usize = 10_000;
/// The most decoded row text one call takes: sixteen times the target chunk, so a
/// bucket chosen by [`bucket_bits`] never reaches it, and a skewed one is refused
/// before it is held.
pub const MAX_CALL_BYTES: u64 = 16 * TARGET_CHUNK;

/// The most storage-object refs one [`Gen0Writer::bucket`] call may hand over: one
/// ref-index object's worth.
pub const MAX_CALL_REFS: usize = mdbn_wire::ref_index::MAX_REF_INDEX_ENTRIES;
/// The most refs a generation 0 may root: every ref-index object a snapshot may
/// name, full. Checked, duplicates included, before anything is copied.
pub const MAX_RETAINED_REFS: usize =
    mdbn_wire::ref_index::MAX_REF_INDICES * mdbn_wire::ref_index::MAX_REF_INDEX_ENTRIES;
/// Chunk refs [`Gen0Writer::finish`] adds (tombstones, aliases, conflicts,
/// receipts, settings).
const FINISH_CHUNKS: usize = 5;

fn check_call(rows: usize, bytes: u64) -> Result<(), Gen0Error> {
    if rows > MAX_CALL_ROWS || bytes > MAX_CALL_BYTES {
        return Err(Gen0Error::TooLarge);
    }
    Ok(())
}

/// A record at generation 0: its legacy ID and exact document (at most the record cap).
#[derive(Debug, Clone, PartialEq)]
pub struct Gen0Record {
    /// Record ID.
    pub id: Uuid,
    /// Collection-relative path.
    pub path: String,
    /// The exact document.
    pub doc: String,
}

/// A file at generation 0: an `AttachmentV1` file, or a document over the record
/// cap as an `UnindexedOversizedMarkdown` file.
#[derive(Debug, Clone, PartialEq)]
pub struct Gen0File {
    /// File ID (for an oversized document: its record ID).
    pub id: Uuid,
    /// Collection-relative path.
    pub path: String,
    /// The sealed content's descriptor.
    pub content: FileContent,
    /// Media class (from the extension).
    pub media: MediaClass,
    /// `true`: unindexed oversized Markdown; `false`: an ordinary attachment.
    pub unindexed: bool,
}

/// One object to upload (`put_object`), with its kind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Gen0Object {
    /// Content address (SHA-256 of `bytes`).
    pub address: B32,
    /// Object kind (`chunk`, `ref-index`, `manifest`).
    pub kind: ItemKind,
    /// Canonical item bytes.
    pub bytes: Vec<u8>,
}

/// The finished generation 0.
#[derive(Debug, Clone)]
pub struct Gen0Manifest {
    /// The manifest object (upload it last).
    pub manifest: Gen0Object,
    /// Ref-index objects to upload before the manifest (when the refs needed them).
    pub ref_indices: Vec<Gen0Object>,
    /// The manifest's state digest, for the `base` payload.
    pub state_digest: Hash,
    /// The `refs` for the `base` item: the manifest, plus every direct ref when the
    /// manifest names them directly. With ref-index objects the base names only the
    /// manifest (an item may not reference an index); the snapshot registered after
    /// the base installs roots the rest within the object grace window.
    pub base_refs: Vec<B32>,
}

/// The number of bucket bits for `total_doc_bytes` of record text, as an ordinary
/// snapshot build chooses it.
pub fn bucket_bits(total_doc_bytes: u64) -> u64 {
    ceil_log2(total_doc_bytes.div_ceil(TARGET_CHUNK).max(1)).min(16)
}

/// The bounded generation-0 writer. See the module docs.
pub struct Gen0Writer {
    collection: Uuid,
    bits: u64,
    with_attachments: bool,
    with_unindexed: bool,
    next_bucket: Option<u64>,
    sections: Vec<(SectionKind, Vec<ChunkRef>)>,
    refs: Vec<B32>,
    records: u64,
    files: u64,
}

impl std::fmt::Debug for Gen0Writer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Gen0Writer")
            .field("bits", &self.bits)
            .field("next_bucket", &self.next_bucket)
            .field("records", &self.records)
            .field("files", &self.files)
            .finish_non_exhaustive()
    }
}

impl Gen0Writer {
    /// A writer for `collection` with `2^bits` buckets ([`bucket_bits`]). The
    /// attachment and unindexed sections exist exactly when such files exist; the
    /// caller declares them up front (from its counts).
    pub fn new(collection: Uuid, bits: u64, with_attachments: bool, with_unindexed: bool) -> Self {
        Self {
            collection,
            bits: bits.min(16),
            with_attachments,
            with_unindexed,
            next_bucket: None,
            sections: Vec::new(),
            refs: Vec::new(),
            records: 0,
            files: 0,
        }
    }

    /// Buckets this writer expects.
    pub fn buckets(&self) -> u64 {
        1u64 << self.bits
    }

    /// Refs held so far (object refs plus chunk refs, duplicates included).
    pub fn retained_refs(&self) -> usize {
        self.refs.len() + self.sections.iter().map(|(_, c)| c.len()).sum::<usize>()
    }

    /// The bucket of an ID at this writer's bits.
    pub fn bucket_of(&self, id: &Uuid) -> u64 {
        u64::from(bucket16(id)) >> (16 - self.bits)
    }

    /// Every resource (path, text), once, first. Returns the chunk objects to upload.
    pub fn resources(
        &mut self,
        sealer: &mut dyn Sealer,
        entropy: &mut dyn CsprngEntropy,
        mut rows: Vec<(String, String)>,
    ) -> Result<Vec<Gen0Object>, Gen0Error> {
        if self.next_bucket.is_some() || !self.sections.is_empty() {
            return Err(Gen0Error::Order("resources come first, once"));
        }
        check_call(
            rows.len(),
            rows.iter().map(|r| (r.0.len() + r.1.len()) as u64).sum(),
        )?;
        rows.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
        if rows.windows(2).any(|w| w[0].0 == w[1].0) {
            return Err(Gen0Error::Duplicate);
        }
        let rows: Vec<Cbor> = rows
            .into_iter()
            .map(|(path, doc)| {
                ResourceRow {
                    path,
                    doc: TextOrBlob::Text(doc),
                }
                .to_cbor()
            })
            .collect();
        let mut out = Vec::new();
        let refs = self.seal_chunks(
            sealer,
            entropy,
            SectionKind::Legacy(L::Resources),
            split(rows),
            &mut out,
        )?;
        self.sections
            .push((SectionKind::Legacy(L::Resources), refs));
        for kind in self.bucketed() {
            self.sections.push((kind, Vec::new()));
        }
        self.next_bucket = Some(0);
        Ok(out)
    }

    /// One bucket's records and files, every bucket in order from 0. `object_refs`
    /// are the storage objects these files hold (attachment manifests and chunks,
    /// blob parts), so the snapshot roots them. Returns the chunk objects to upload.
    pub fn bucket(
        &mut self,
        sealer: &mut dyn Sealer,
        entropy: &mut dyn CsprngEntropy,
        b: u64,
        mut records: Vec<Gen0Record>,
        mut files: Vec<Gen0File>,
        object_refs: &[B32],
    ) -> Result<Vec<Gen0Object>, Gen0Error> {
        if self.next_bucket != Some(b) {
            return Err(Gen0Error::Order("buckets in order, after resources"));
        }
        // Bound the refs before any state changes or copy: this call's, and every
        // ref the writer will hold through `finish` (this bucket's chunks too).
        let after =
            self.retained_refs() + object_refs.len() + self.bucketed().len() + FINISH_CHUNKS;
        if object_refs.len() > MAX_CALL_REFS || after > MAX_RETAINED_REFS {
            return Err(Gen0Error::TooManyRefs);
        }
        check_call(
            records.len() + files.len(),
            records
                .iter()
                .map(|r| (r.path.len() + r.doc.len()) as u64)
                .sum::<u64>()
                + files.iter().map(|f| f.path.len() as u64 + 512).sum::<u64>(),
        )?;
        records.sort_by(|a, c| a.id.cmp(&c.id));
        files.sort_by(|a, c| a.id.cmp(&c.id));
        let mut ids: Vec<Uuid> = records
            .iter()
            .map(|r| r.id)
            .chain(files.iter().map(|f| f.id))
            .collect();
        ids.sort();
        if ids.windows(2).any(|w| w[0] == w[1]) {
            return Err(Gen0Error::Duplicate);
        }
        if ids.iter().any(|id| self.bucket_of(id) != b) {
            return Err(Gen0Error::WrongBucket);
        }
        let mut index: Vec<(Uuid, Cbor)> = Vec::with_capacity(ids.len());
        let mut rrows = Vec::with_capacity(records.len());
        for r in records {
            index.push((
                r.id,
                IndexRow {
                    id: r.id,
                    kind: EntityKind::Record,
                    path: r.path.clone(),
                    revision: mdbn_wire::hash::sha256(r.doc.as_bytes()),
                    size: r.doc.len() as u64,
                    modified_seq: 0,
                }
                .to_cbor(),
            ));
            rrows.push(
                WRecordRow {
                    id: r.id,
                    path: r.path,
                    doc: TextOrBlob::Text(r.doc),
                }
                .to_cbor(),
            );
            self.records += 1;
        }
        let mut arows = Vec::new();
        let mut nrows = Vec::new();
        for f in files {
            index.push((
                f.id,
                IndexRow {
                    id: f.id,
                    kind: EntityKind::File,
                    path: f.path.clone(),
                    revision: f.content.plain_hash(),
                    size: f.content.size(),
                    modified_seq: 0,
                }
                .to_cbor(),
            ));
            if f.unindexed {
                if !self.with_unindexed {
                    return Err(Gen0Error::Format("unindexed section not declared"));
                }
                nrows.push(
                    UnindexedMarkdownFileRowV1 {
                        id: f.id,
                        path: f.path,
                        payload: UnindexedMarkdownPayloadV1 { content: f.content },
                        media: f.media,
                    }
                    .to_cbor(),
                );
            } else {
                let FileContent::AttachmentV1(content) = f.content else {
                    return Err(Gen0Error::Format("an ordinary file must be AttachmentV1"));
                };
                if !self.with_attachments {
                    return Err(Gen0Error::Format("attachment section not declared"));
                }
                arows.push(
                    AttachmentFileRowV1 {
                        id: f.id,
                        path: f.path,
                        content,
                        media: f.media,
                    }
                    .to_cbor(),
                );
            }
            self.files += 1;
        }
        index.sort_by(|a, c| a.0.cmp(&c.0));
        let mut index: Vec<Cbor> = index.into_iter().map(|(_, c)| c).collect();
        let mut out = Vec::new();
        for kind in self.bucketed() {
            let rows = match kind {
                SectionKind::Legacy(L::Index) => std::mem::take(&mut index),
                SectionKind::Legacy(L::Records) => std::mem::take(&mut rrows),
                SectionKind::AttachmentFiles => std::mem::take(&mut arows),
                SectionKind::UnindexedMarkdownFiles => std::mem::take(&mut nrows),
                _ => Vec::new(),
            };
            let refs = self.seal_chunks(sealer, entropy, kind, vec![(b, rows)], &mut out)?;
            if let Some((_, chunks)) = self.sections.iter_mut().find(|(k, _)| *k == kind) {
                chunks.extend(refs);
            }
        }
        self.refs.extend_from_slice(object_refs);
        self.next_bucket = Some(b + 1);
        Ok(out)
    }

    /// Seal the remaining sections and the manifest. `state_digest` comes from a
    /// [`StateDigestStream`] over the same rows; the install recomputes it and
    /// refuses a mismatch. Returns the manifest and any ref-index objects.
    pub fn finish(
        mut self,
        sealer: &mut dyn Sealer,
        entropy: &mut dyn CsprngEntropy,
        state_digest: Hash,
        settings: FileInclusion,
        signer: Uuid,
    ) -> Result<(Vec<Gen0Object>, Gen0Manifest), Gen0Error> {
        if self.next_bucket != Some(self.buckets()) {
            return Err(Gen0Error::Order("every bucket before finish"));
        }
        let mut out = Vec::new();
        for (kind, rows) in [
            (SectionKind::Legacy(L::Tombstones), split(Vec::new())),
            (SectionKind::Legacy(L::Aliases), split(Vec::new())),
            (SectionKind::Legacy(L::Conflicts), split(Vec::new())),
            (SectionKind::Legacy(L::Receipts), split(Vec::new())),
            (
                SectionKind::Legacy(L::Settings),
                vec![(0, vec![settings.to_cbor()])],
            ),
        ] {
            let refs = self.seal_chunks(sealer, entropy, kind, rows, &mut out)?;
            self.sections.push((kind, refs));
        }
        // Section-kind order, as an ordinary build emits them.
        self.sections.sort_by_key(|(k, _)| k.value());
        let Some(epoch) = sealer.current_epoch() else {
            return Err(Gen0Error::Seal);
        };
        let mut refs = std::mem::take(&mut self.refs);
        refs.extend(
            self.sections
                .iter()
                .flat_map(|(_, c)| c.iter().map(|c| c.address)),
        );
        refs.sort();
        refs.dedup();
        let indexed = index_refs(self.collection, refs).map_err(|_| Gen0Error::TooManyRefs)?;
        let sem = mdbn_core::semantics::SEM;
        let payload = ManifestPayload {
            seq: 0,
            chain: B32([0; 32]),
            state_digest,
            bucket_bits: self.bits,
            sections: self
                .sections
                .into_iter()
                .map(|(kind, chunks)| Section { kind, chunks })
                .collect(),
            horizon: Horizon {
                seq_floor: 0,
                time_floor: 0,
            },
            sem: Version {
                major: sem.major,
                minor: sem.minor,
            },
            record_count: self.records,
            file_count: self.files,
            control_chain: B32([0; 32]),
            previous: None,
        };
        let plain = mdbn_wire::ref_index::encode_manifest(&payload, &indexed.ref_indices)
            .map_err(|_| Gen0Error::Format("manifest encode"))?;
        let mut item = object_item(ItemKind::Manifest, self.collection, epoch);
        item.signer = Some(signer);
        item.refs = (!indexed.refs.is_empty()).then(|| indexed.refs.clone());
        sealer
            .seal_object(&mut item, &plain, true, true, entropy)
            .map_err(|_| Gen0Error::Seal)?;
        let bytes = item.to_bytes().map_err(|_| Gen0Error::Seal)?;
        let address = mdbn_wire::hash::sha256(&bytes);
        let mut base_refs = vec![address];
        if indexed.ref_indices.is_empty() {
            base_refs.extend(indexed.refs.iter().copied());
        }
        base_refs.sort();
        base_refs.dedup();
        let manifest = Gen0Manifest {
            manifest: Gen0Object {
                address,
                kind: ItemKind::Manifest,
                bytes,
            },
            ref_indices: indexed
                .uploads
                .into_iter()
                .map(|u| Gen0Object {
                    address: u.address,
                    kind: u.kind,
                    bytes: u.bytes,
                })
                .collect(),
            state_digest,
            base_refs,
        };
        Ok((out, manifest))
    }

    fn bucketed(&self) -> Vec<SectionKind> {
        let mut kinds = vec![
            SectionKind::Legacy(L::Index),
            SectionKind::Legacy(L::Records),
            SectionKind::Legacy(L::Files),
        ];
        if self.with_attachments {
            kinds.push(SectionKind::AttachmentFiles);
        }
        if self.with_unindexed {
            kinds.push(SectionKind::UnindexedMarkdownFiles);
        }
        kinds
    }

    fn seal_chunks(
        &mut self,
        sealer: &mut dyn Sealer,
        entropy: &mut dyn CsprngEntropy,
        kind: SectionKind,
        chunks: Vec<(u64, Vec<Cbor>)>,
        out: &mut Vec<Gen0Object>,
    ) -> Result<Vec<ChunkRef>, Gen0Error> {
        let epoch = sealer.current_epoch().ok_or(Gen0Error::Seal)?;
        let mut refs = Vec::with_capacity(chunks.len());
        for (bucket, rows) in chunks {
            let n = rows.len() as u64;
            let plain = enc(&ChunkPayload {
                section: kind,
                bucket,
                rows,
            }
            .to_cbor());
            let mut item: Item = object_item(ItemKind::Chunk, self.collection, epoch);
            sealer
                .seal_object(&mut item, &plain, true, false, entropy)
                .map_err(|_| Gen0Error::Seal)?;
            let bytes = item.to_bytes().map_err(|_| Gen0Error::Seal)?;
            let address = mdbn_wire::hash::sha256(&bytes);
            refs.push(ChunkRef {
                address,
                plain_hash: mdbn_wire::hash::sha256(&plain),
                rows: n,
                bucket,
                plain_size: plain.len() as u64,
            });
            out.push(Gen0Object {
                address,
                kind: ItemKind::Chunk,
                bytes,
            });
        }
        Ok(refs)
    }
}

/// Row counts of a state, which the streamed digest must know up front (canonical
/// CBOR arrays carry their length before their elements).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DigestCounts {
    /// Resources.
    pub resources: u64,
    /// Records.
    pub records: u64,
    /// Files, of every kind.
    pub files: u64,
    /// Of which unindexed oversized Markdown.
    pub unindexed: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Stage {
    Resources,
    Records,
    Files,
    Native,
    Done,
}

/// The state digest (`snapshot.md` §4) of a generation-0 state, streamed: rows in
/// key order, sections in order, with [`DigestCounts`] known first. Equal to the
/// replica's digest of the same confirmed state. No tombstones, aliases, conflicts
/// or receipts (generation 0 has none).
pub struct StateDigestStream {
    h: Sha256,
    counts: DigestCounts,
    settings: Vec<u8>,
    stage: Stage,
    seen: u64,
    last_path: Option<String>,
    last_id: Option<Uuid>,
}

impl std::fmt::Debug for StateDigestStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StateDigestStream")
            .field("stage", &self.stage)
            .field("seen", &self.seen)
            .finish_non_exhaustive()
    }
}

/// A canonical CBOR array head of `n` elements.
fn array_head(n: u64) -> Vec<u8> {
    match n {
        0..=23 => vec![0x80 | n as u8],
        24..=0xff => vec![0x98, n as u8],
        0x100..=0xffff => {
            let mut v = vec![0x99];
            v.extend_from_slice(&(n as u16).to_be_bytes());
            v
        }
        0x1_0000..=0xffff_ffff => {
            let mut v = vec![0x9a];
            v.extend_from_slice(&(n as u32).to_be_bytes());
            v
        }
        _ => {
            let mut v = vec![0x9b];
            v.extend_from_slice(&n.to_be_bytes());
            v
        }
    }
}

const STATE_DIGEST_TAG: &str = "mdbase/v1/state-digest";

impl StateDigestStream {
    /// Start a digest of a state with these counts and settings (the default
    /// inclusion when none was set).
    pub fn new(counts: DigestCounts, settings: &FileInclusion) -> Self {
        let mut h = Sha256::new();
        h.update([STATE_DIGEST_TAG.len() as u8]);
        h.update(STATE_DIGEST_TAG.as_bytes());
        h.update(array_head(if counts.unindexed > 0 { 8 } else { 7 }));
        h.update(array_head(counts.resources));
        Self {
            h,
            counts,
            settings: enc(&settings.to_cbor()),
            stage: Stage::Resources,
            seen: 0,
            last_path: None,
            last_id: None,
        }
    }

    /// The next resource, ascending by path bytes.
    pub fn resource(&mut self, path: &str, text: &str) -> Result<(), Gen0Error> {
        self.at(Stage::Resources)?;
        if self
            .last_path
            .as_deref()
            .is_some_and(|l| l.as_bytes() >= path.as_bytes())
        {
            return Err(Gen0Error::Duplicate);
        }
        self.last_path = Some(path.to_owned());
        self.element(&Cbor::Array(vec![
            Cbor::Text(path.to_owned()),
            mdbn_wire::hash::sha256(text.as_bytes()).to_cbor(),
        ]));
        Ok(())
    }

    /// The next record, ascending by ID.
    pub fn record(&mut self, id: Uuid, path: &str, revision: Hash) -> Result<(), Gen0Error> {
        self.at(Stage::Records)?;
        self.ascending(id)?;
        self.element(&Cbor::Array(vec![
            id.to_cbor(),
            Cbor::Text(path.to_owned()),
            revision.to_cbor(),
        ]));
        Ok(())
    }

    /// The next file of any kind, ascending by ID.
    pub fn file(&mut self, id: Uuid, path: &str, content: &FileContent) -> Result<(), Gen0Error> {
        self.at(Stage::Files)?;
        self.ascending(id)?;
        self.element(&Cbor::Array(vec![
            id.to_cbor(),
            Cbor::Text(path.to_owned()),
            content.plain_hash().to_cbor(),
        ]));
        Ok(())
    }

    /// Each unindexed oversized Markdown file again, ascending by ID, for the
    /// native section (after every file).
    pub fn unindexed(
        &mut self,
        id: Uuid,
        path: &str,
        content: &FileContent,
        media: MediaClass,
    ) -> Result<(), Gen0Error> {
        self.at(Stage::Native)?;
        self.ascending(id)?;
        self.element(&Cbor::Array(vec![
            id.to_cbor(),
            path.to_owned().to_cbor(),
            UnindexedMarkdownPayloadV1 {
                content: content.clone(),
            }
            .to_cbor(),
            media.to_cbor(),
        ]));
        Ok(())
    }

    /// The digest. Refuses unless every counted row was streamed.
    pub fn finish(mut self) -> Result<Hash, Gen0Error> {
        self.at(Stage::Done)?;
        Ok(B32(self.h.finalize().into()))
    }

    fn element(&mut self, c: &Cbor) {
        self.h.update(enc(c));
        self.seen += 1;
    }

    fn ascending(&mut self, id: Uuid) -> Result<(), Gen0Error> {
        if self.last_id.is_some_and(|l| l >= id) {
            return Err(Gen0Error::Duplicate);
        }
        self.last_id = Some(id);
        Ok(())
    }

    /// Close every section before `stage` (each must be complete), then check a
    /// row still fits `stage`.
    fn at(&mut self, stage: Stage) -> Result<(), Gen0Error> {
        while self.stage < stage {
            if self.seen != self.expected() {
                return Err(Gen0Error::Order("a section's count was not met"));
            }
            self.advance();
        }
        if self.stage > stage {
            return Err(Gen0Error::Order("rows after their section"));
        }
        if stage != Stage::Done && self.seen >= self.expected() {
            return Err(Gen0Error::Order("more rows than counted"));
        }
        Ok(())
    }

    fn expected(&self) -> u64 {
        match self.stage {
            Stage::Resources => self.counts.resources,
            Stage::Records => self.counts.records,
            Stage::Files => self.counts.files,
            Stage::Native => self.counts.unindexed,
            Stage::Done => 0,
        }
    }

    fn advance(&mut self) {
        self.seen = 0;
        self.last_id = None;
        self.stage = match self.stage {
            Stage::Resources => {
                self.h.update(array_head(self.counts.records));
                Stage::Records
            }
            Stage::Records => {
                self.h.update(array_head(self.counts.files));
                Stage::Files
            }
            Stage::Files => {
                // Tombstones (none), settings, aliases (none), conflicts (none).
                self.h.update(array_head(0));
                self.h.update(&self.settings);
                self.h.update(array_head(0));
                self.h.update(array_head(0));
                if self.counts.unindexed > 0 {
                    self.h.update(array_head(3));
                    self.h.update(array_head(self.counts.unindexed));
                    Stage::Native
                } else {
                    Stage::Done
                }
            }
            Stage::Native => {
                // Native tombstones and conflicts (none).
                self.h.update(array_head(0));
                self.h.update(array_head(0));
                Stage::Done
            }
            Stage::Done => Stage::Done,
        };
    }
}

/// An opaque, non-cloneable same-Replica/same-wake writer identity.
#[derive(Debug)]
pub struct HostedGen0Handle(std::sync::Arc<()>);

/// Refusal of the hosted custody seam. No source contents are carried.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostedGen0Error {
    /// Full current admission, pre-base or current health did not match.
    Denied,
    /// A writer already owns this Replica's single slot.
    Busy,
    /// A stale/foreign handle never consumes a newer valid slot.
    Handle,
    /// Owned allocation, retained refs or returned output exceeded a hard cap.
    Budget,
    /// The bounded generator refused the operation.
    Writer(Gen0Error),
}

pub(super) struct HostedGen0State {
    identity: std::sync::Arc<()>,
    admission: super::VerifiedHostedAdmission,
    writer: Gen0Writer,
}

const HOSTED_ROWS: usize = 128;
const HOSTED_INPUT_BYTES: usize = 64 << 10;
const HOSTED_REFS: usize = 1024;
const HOSTED_OUTPUT_BYTES: usize = 1 << 20;
const HOSTED_OUTPUT_OBJECTS: usize = 2 * HOSTED_ROWS + 5;
const HOSTED_RETAINED_BYTES: usize = 512 << 10;
/// One budget, shared by retained writer state and its returned objects.
const HOSTED_SHARED_BYTES: usize = 1 << 20;

fn vec_charge<T>(v: &Vec<T>) -> Result<usize, HostedGen0Error> {
    v.capacity()
        .checked_mul(std::mem::size_of::<T>())
        .ok_or(HostedGen0Error::Budget)
}

fn retained_budget(writer: &Gen0Writer) -> Result<usize, HostedGen0Error> {
    let mut bytes = vec_charge(&writer.refs)?
        .checked_add(vec_charge(&writer.sections)?)
        .and_then(|n| n.checked_add(std::mem::size_of::<HostedGen0State>() + 32))
        .ok_or(HostedGen0Error::Budget)?;
    for (_, chunks) in &writer.sections {
        bytes = bytes
            .checked_add(vec_charge(chunks)?)
            .ok_or(HostedGen0Error::Budget)?;
    }
    if writer.retained_refs() > HOSTED_REFS || bytes > HOSTED_RETAINED_BYTES {
        return Err(HostedGen0Error::Budget);
    }
    Ok(bytes)
}

fn shared_budget(retained: usize, output: usize) -> Result<(), HostedGen0Error> {
    if retained
        .checked_add(output)
        .is_none_or(|n| n > HOSTED_SHARED_BYTES)
    {
        return Err(HostedGen0Error::Budget);
    }
    Ok(())
}

fn output_preflight(
    writer: &Gen0Writer,
    added: usize,
    objects: usize,
    refs: usize,
) -> Result<(), HostedGen0Error> {
    let projected = writer
        .retained_refs()
        .checked_add(added)
        .ok_or(HostedGen0Error::Budget)?;
    if projected > HOSTED_REFS {
        return Err(HostedGen0Error::Budget);
    }
    // Reserve both old/new vector buffers during growth, minimum capacities
    // and fixed slot/section/Arc headers, before any entropy/sealing effects.
    let reservation = projected
        .checked_add(32)
        .and_then(|n| n.checked_mul(4))
        .and_then(|n| n.checked_mul(std::mem::size_of::<ChunkRef>() + std::mem::size_of::<B32>()))
        .and_then(|n| n.checked_add(16 << 10))
        .ok_or(HostedGen0Error::Budget)?;
    let retained = reservation.max(retained_budget(writer)?);
    if retained > HOSTED_RETAINED_BYTES {
        return Err(HostedGen0Error::Budget);
    }
    // Four times the admitted owned row bytes, 2KiB per sealed envelope and
    // 512 bytes per retained manifest member conservatively reserve output
    // before entropy/sealing. Actual returned capacities are checked too.
    let estimate = objects
        .checked_mul(2048)
        .and_then(|n| n.checked_add(refs.checked_mul(512)?))
        .and_then(|n| n.checked_add(4 * HOSTED_INPUT_BYTES))
        .ok_or(HostedGen0Error::Budget)?;
    if objects > HOSTED_OUTPUT_OBJECTS || refs > HOSTED_REFS || estimate > HOSTED_OUTPUT_BYTES {
        return Err(HostedGen0Error::Budget);
    }
    shared_budget(retained, estimate)
}

fn owned_bytes(parts: impl IntoIterator<Item = usize>) -> Result<(), HostedGen0Error> {
    let bytes = parts
        .into_iter()
        .try_fold(0usize, |n, part| n.checked_add(part));
    if bytes.is_none_or(|n| n > HOSTED_INPUT_BYTES) {
        return Err(HostedGen0Error::Budget);
    }
    Ok(())
}

fn output_budget(objects: &Vec<Gen0Object>, limit: usize) -> Result<usize, HostedGen0Error> {
    if objects.len() > limit {
        return Err(HostedGen0Error::Budget);
    }
    let bytes = objects
        .iter()
        .try_fold(vec_charge(objects)?, |n, o| {
            n.checked_add(o.bytes.capacity())
        })
        .ok_or(HostedGen0Error::Budget)?;
    if bytes > HOSTED_OUTPUT_BYTES {
        return Err(HostedGen0Error::Budget);
    }
    Ok(bytes)
}

impl<S: crate::store::Store> super::Replica<S> {
    fn gen0_current(&self, expected: &super::VerifiedHostedAdmission) -> bool {
        !self.policy.content_seen
            && !self.policy.frozen
            && self.install_base.is_none()
            && matches!(self.verified_hosted_admission(), super::HostedAdmission::Verified(current) if current.as_ref() == expected)
    }

    fn gen0_take(
        &mut self,
        expected: &super::VerifiedHostedAdmission,
        handle: &HostedGen0Handle,
    ) -> Result<HostedGen0State, HostedGen0Error> {
        let state = self.hosted_gen0.as_ref().ok_or(HostedGen0Error::Handle)?;
        if !std::sync::Arc::ptr_eq(&state.identity, &handle.0) {
            return Err(HostedGen0Error::Handle);
        }
        let current = state.admission == *expected && self.gen0_current(expected);
        let state = self.hosted_gen0.take().ok_or(HostedGen0Error::Handle)?;
        // Matching-current failures poison/drop; stale identities were rejected
        // before taking the slot, so they cannot destroy its successor.
        if !current {
            return Err(HostedGen0Error::Denied);
        }
        retained_budget(&state.writer)?;
        Ok(state)
    }

    /// Reserve this Replica's one bounded writer under a fresh full native proof.
    /// No source witness, region/effect permit, key or sealer is returned.
    pub fn hosted_gen0_begin(
        &mut self,
        expected: &super::VerifiedHostedAdmission,
        bits: u64,
        with_attachments: bool,
        with_unindexed: bool,
    ) -> Result<HostedGen0Handle, HostedGen0Error> {
        if self.hosted_gen0.is_some() {
            return Err(HostedGen0Error::Busy);
        }
        if !self.gen0_current(expected) {
            return Err(HostedGen0Error::Denied);
        }
        let sections = 3 + usize::from(with_attachments) + usize::from(with_unindexed);
        if bits > 16 || (1usize << bits) * sections + 6 > HOSTED_REFS {
            return Err(HostedGen0Error::Budget);
        }
        let identity = std::sync::Arc::new(());
        let handle = HostedGen0Handle(identity.clone());
        self.hosted_gen0 = Some(HostedGen0State {
            identity,
            admission: *expected,
            writer: Gen0Writer::new(self.cfg.collection, bits, with_attachments, with_unindexed),
        });
        Ok(handle)
    }

    /// Drop only the matching current writer; foreign/stale identities are inert.
    pub fn hosted_gen0_abort(
        &mut self,
        expected: &super::VerifiedHostedAdmission,
        handle: &HostedGen0Handle,
    ) -> Result<(), HostedGen0Error> {
        drop(self.gen0_take(expected, handle)?);
        Ok(())
    }

    /// Seal all resources once using private current Replica custody.
    pub fn hosted_gen0_resources(
        &mut self,
        expected: &super::VerifiedHostedAdmission,
        handle: &HostedGen0Handle,
        rows: Vec<(String, String)>,
    ) -> Result<Vec<Gen0Object>, HostedGen0Error> {
        let mut state = self.gen0_take(expected, handle)?;
        if rows.len() > HOSTED_ROWS
            || state.writer.retained_refs() + rows.len().max(1) + 5 > HOSTED_REFS
        {
            return Err(HostedGen0Error::Budget);
        }
        output_preflight(&state.writer, rows.len().max(1), rows.len().max(1), 0)?;
        owned_bytes(
            std::iter::once(
                rows.capacity()
                    .checked_mul(std::mem::size_of::<(String, String)>())
                    .ok_or(HostedGen0Error::Budget)?,
            )
            .chain(
                rows.iter()
                    .flat_map(|(path, doc)| [path.capacity(), doc.capacity()]),
            ),
        )?;
        let output = state
            .writer
            .resources(self.sealer.as_mut(), self.host.entropy.as_mut(), rows)
            .map_err(HostedGen0Error::Writer)?;
        shared_budget(
            retained_budget(&state.writer)?,
            output_budget(&output, HOSTED_ROWS)?,
        )?;
        if state.writer.retained_refs() + 5 > HOSTED_REFS {
            return Err(HostedGen0Error::Budget);
        }
        self.hosted_gen0 = Some(state);
        Ok(output)
    }

    /// Seal one complete bucket. Descriptor/profile/HasObjects/journal authority
    /// remains the native migration bridge's separate obligation.
    pub fn hosted_gen0_bucket(
        &mut self,
        expected: &super::VerifiedHostedAdmission,
        handle: &HostedGen0Handle,
        bucket: u64,
        records: Vec<Gen0Record>,
        files: Vec<Gen0File>,
        object_refs: &[B32],
    ) -> Result<Vec<Gen0Object>, HostedGen0Error> {
        let mut state = self.gen0_take(expected, handle)?;
        let rows = records
            .len()
            .checked_add(files.len())
            .ok_or(HostedGen0Error::Budget)?;
        if rows > HOSTED_ROWS
            || object_refs.len() > HOSTED_REFS
            || state.writer.retained_refs() + object_refs.len() + 2 * rows + 10 > HOSTED_REFS
        {
            return Err(HostedGen0Error::Budget);
        }
        output_preflight(
            &state.writer,
            object_refs.len() + 2 * rows + 5,
            2 * rows + 5,
            0,
        )?;
        owned_bytes(
            [
                records
                    .capacity()
                    .checked_mul(std::mem::size_of::<Gen0Record>())
                    .ok_or(HostedGen0Error::Budget)?,
                files
                    .capacity()
                    .checked_mul(std::mem::size_of::<Gen0File>())
                    .ok_or(HostedGen0Error::Budget)?,
                std::mem::size_of_val(object_refs),
            ]
            .into_iter()
            .chain(
                records
                    .iter()
                    .flat_map(|r| [r.path.capacity(), r.doc.capacity()]),
            )
            .chain(files.iter().map(|f| f.path.capacity())),
        )?;
        let output = state
            .writer
            .bucket(
                self.sealer.as_mut(),
                self.host.entropy.as_mut(),
                bucket,
                records,
                files,
                object_refs,
            )
            .map_err(HostedGen0Error::Writer)?;
        shared_budget(
            retained_budget(&state.writer)?,
            output_budget(&output, HOSTED_OUTPUT_OBJECTS)?,
        )?;
        if state.writer.retained_refs() + 5 > HOSTED_REFS {
            return Err(HostedGen0Error::Budget);
        }
        self.hosted_gen0 = Some(state);
        Ok(output)
    }

    /// Finish and consume the slot. Outputs are sealed objects only, never keys,
    /// an app session or proof that uploads/base/journal effects completed.
    pub fn hosted_gen0_finish(
        &mut self,
        expected: &super::VerifiedHostedAdmission,
        handle: &HostedGen0Handle,
        digest: Hash,
        settings: FileInclusion,
    ) -> Result<(Vec<Gen0Object>, Gen0Manifest), HostedGen0Error> {
        let state = self.gen0_take(expected, handle)?;
        if state.writer.retained_refs() + 5 > HOSTED_REFS {
            return Err(HostedGen0Error::Budget);
        }
        output_preflight(&state.writer, 5, 6, state.writer.retained_refs() + 5)?;
        let excluded = settings.exclude.as_ref();
        owned_bytes(
            [
                settings
                    .include
                    .capacity()
                    .checked_mul(std::mem::size_of::<MediaClass>())
                    .ok_or(HostedGen0Error::Budget)?,
                excluded
                    .map_or(0, |v| v.capacity())
                    .checked_mul(std::mem::size_of::<String>())
                    .ok_or(HostedGen0Error::Budget)?,
            ]
            .into_iter()
            .chain(excluded.into_iter().flatten().map(|s| s.capacity())),
        )?;
        let (objects, manifest) = state
            .writer
            .finish(
                self.sealer.as_mut(),
                self.host.entropy.as_mut(),
                digest,
                settings,
                self.cfg.device_id,
            )
            .map_err(HostedGen0Error::Writer)?;
        if !manifest.ref_indices.is_empty() {
            return Err(HostedGen0Error::Budget);
        }
        let bytes = output_budget(&objects, 5)?;
        let total = bytes
            .checked_add(manifest.manifest.bytes.capacity())
            .and_then(|n| {
                n.checked_add(
                    manifest
                        .base_refs
                        .capacity()
                        .checked_mul(std::mem::size_of::<B32>())?,
                )
            })
            .and_then(|n| n.checked_add(std::mem::size_of::<Gen0Manifest>()))
            .ok_or(HostedGen0Error::Budget)?;
        if total > HOSTED_OUTPUT_BYTES {
            return Err(HostedGen0Error::Budget);
        }
        Ok((objects, manifest))
    }

    /// Inspect a policy-key revocation only alongside the expected full, fresh
    /// native hosted admission. Drift or denial returns `None`; `Some(false)`
    /// is not key authorization or proof of a migration source/signature.
    pub fn hosted_gen0_cp_key_revoked(
        &self,
        expected: &super::VerifiedHostedAdmission,
        key_id: B16,
    ) -> Option<bool> {
        match self.verified_hosted_admission() {
            super::HostedAdmission::Verified(current) if current.as_ref() == expected => {
                Some(self.policy.revoked_cp_keys.contains_key(&key_id))
            }
            _ => None,
        }
    }
}

#[cfg(test)]
#[path = "gen0_tests.rs"]
mod tests;
