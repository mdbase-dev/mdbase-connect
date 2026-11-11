//! Decoding and validating one snapshot chunk's rows, and staging them.
//!
//! [`ChunkRows`] is the only reader of chunk rows: an install stages what it
//! decodes, and an endorsement compares what it decodes with this replica's own
//! rows (`endorse.rs`).

use super::*;

/// What decoding a snapshot's chunks carries from one chunk to the next, in the
/// order of [`chunk_queue`]: the index rows' positions and capture times, the
/// resources (records are indexed under their catalog), and the row index the
/// state digest is computed from, which refuses duplicate IDs and path keys.
#[derive(Debug, Clone)]
pub(crate) struct ChunkRows {
    /// The collection the snapshot is of.
    collection: mdbn_wire::common::Uuid,
    /// The key epoch in force at the snapshot's position: it bounds the content
    /// descriptors its rows may carry (V7).
    pub(in crate::replica) epoch: u64,
    /// Positions of the last change, from the index section.
    pub(super) mseq: BTreeMap<mdbn_wire::common::Uuid, u64>,
    /// Record capture times from the index section, keyed like `mseq`.
    pub(super) mtime: BTreeMap<mdbn_wire::common::Uuid, i64>,
    pub(super) resources: Vec<(String, String)>,
    pub(super) index: DigestIndex,
}

/// One chunk's rows as an install writes them, and what an install must fetch
/// and authenticate before it may swap them in.
pub(super) struct Decoded {
    pub(super) rows: Tx,
    /// Records whose text is in a blob: the row exists once that text is read.
    pub(super) text_sources: Vec<snapshot_text::Row>,
    /// Native contents, whose sources are authenticated.
    pub(super) native: Vec<FileContent>,
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

/// Largest text in one snapshot row (a record or resource document, a tombstone's
/// last document): the decompressed payload limit of an entry (`log-entry.md` §10).
const MAX_ROW_TEXT: usize = 16 << 20;

/// Aliases resolve historical names; they never authorize a filesystem write.
/// Keep the relative lookup-key grammar, allowing nonportable legacy names.
pub(super) fn alias_path_ok(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 4096
        && !path.starts_with('/')
        && !path.chars().any(|c| c.is_control() || c == '\\')
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

fn record_row(
    catalog: &mdbn_core::types::Catalog,
    id: mdbn_wire::common::Uuid,
    path: String,
    modified_seq: u64,
    mtime: Option<i64>,
    doc: String,
) -> RecordRow {
    RecordRow {
        id,
        path_key: mdbn_core::paths::path_key(&path),
        revision: mdbn_wire::hash::sha256(doc.as_bytes()),
        modified_seq,
        mtime,
        bucket: bucket16(&id),
        meta: record_meta(catalog, &path, &doc),
        path,
        doc,
    }
}

impl ChunkRows {
    pub(crate) fn new(collection: mdbn_wire::common::Uuid, epoch: u64) -> ChunkRows {
        ChunkRows {
            collection,
            epoch,
            mseq: BTreeMap::new(),
            mtime: BTreeMap::new(),
            resources: Vec::new(),
            index: DigestIndex::default(),
        }
    }

    /// Forget every chunk decoded so far.
    pub(super) fn clear(&mut self) {
        *self = ChunkRows::new(self.collection, self.epoch);
    }

    fn catalog(&self) -> mdbn_core::types::Catalog {
        mdbn_core::types::Catalog::load(
            self.resources.iter().map(|(p, d)| (p.as_str(), d.as_str())),
        )
    }

    fn native_content_ok(&self, c: &FileContent) -> Result<(), String> {
        if !matches!(c, FileContent::Blob(_) | FileContent::AttachmentV1(_)) {
            return Err("unknown native source".into());
        }
        if crate::replica::apply::unindexed_content_in_bounds(c, &self.collection, self.epoch) {
            Ok(())
        } else {
            Err("native snapshot descriptor bounds".into())
        }
    }

    /// The row of a record whose text arrived apart from its chunk (a blob-backed
    /// document, once read), indexed like any other.
    pub(super) fn text_row(
        &mut self,
        id: mdbn_wire::common::Uuid,
        path: String,
        modified_seq: u64,
        mtime: Option<i64>,
        doc: &str,
    ) -> Result<RecordRow, String> {
        let r = record_row(
            &self.catalog(),
            id,
            path,
            modified_seq,
            mtime,
            doc.to_owned(),
        );
        self.index.record(&r)?;
        Ok(r)
    }

    /// Validate one chunk's rows and turn them into the rows an install writes.
    pub(super) fn decode(&mut self, chunk: &ChunkPayload) -> Result<Decoded, String> {
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
        let epoch_at = self.epoch;
        let collection = self.collection;
        let att_ok = |a: &AttachmentContentV1| -> Result<(), String> {
            if crate::replica::apply::attachment_in_bounds(a, &collection, epoch_at) {
                Ok(())
            } else {
                Err("row attachment descriptor out of bounds".into())
            }
        };
        let mut tx = Tx::default();
        let mut text_sources = Vec::new();
        let mut native = Vec::new();
        let bad = |e: mdbn_wire::schema::SchemaError| format!("row: {e}");
        match chunk.section {
            SectionKind::Legacy(L::Resources) => {
                for r in chunk.rows_as::<ResourceRow>().map_err(bad)? {
                    let TextOrBlob::Text(d) = r.doc else {
                        return Err("blob-backed resources are not supported".into());
                    };
                    path_ok(&r.path)?;
                    text_ok(&d)?;
                    self.index.resource(&r.path, &d);
                    self.resources.push((r.path.clone(), d.clone()));
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
                    self.index.settings = Some(s.clone());
                    tx.settings = Some(s);
                }
            }
            SectionKind::Legacy(L::Records) => {
                // Resources are staged first; records are indexed under that catalog.
                let catalog = self.catalog();
                for r in chunk.rows_as::<WRecordRow>().map_err(bad)? {
                    path_ok(&r.path)?;
                    let doc = match r.doc {
                        TextOrBlob::Text(doc) => doc,
                        TextOrBlob::Blob(blob) => {
                            blob_ok(&blob)?;
                            if blob.size > 1048576 || blob.id_epoch < 1 || blob.id_epoch > epoch_at
                            {
                                return Err("record snapshot source bounds".into());
                            }
                            text_sources.push(snapshot_text::Row {
                                id: r.id,
                                path: r.path,
                                blob,
                                modified_seq: self.mseq.get(&r.id).copied().unwrap_or(0),
                                mtime: self.mtime.get(&r.id).copied(),
                            });
                            continue;
                        }
                        TextOrBlob::Attachment(_) => {
                            return Err(
                                "attachment hold is not a record snapshot text source".into()
                            );
                        }
                    };
                    text_ok(&doc)?;
                    tx.records_put.push(record_row(
                        &catalog,
                        r.id,
                        r.path,
                        self.mseq.get(&r.id).copied().unwrap_or(0),
                        self.mtime.get(&r.id).copied(),
                        doc,
                    ));
                }
            }
            SectionKind::Legacy(L::Files) => {
                for f in chunk.rows_as::<WFileRow>().map_err(bad)? {
                    path_ok(&f.path)?;
                    blob_ok(&f.blob)?;
                    tx.files_put.push(FileRow {
                        id: f.id,
                        path_key: mdbn_core::paths::path_key(&f.path),
                        media: mdbn_wire::intent::MediaClass::of(&f.path),
                        modified_seq: self.mseq.get(&f.id).copied().unwrap_or(0),
                        bucket: bucket16(&f.id),
                        local: FileLocal::Remote,
                        kind: mdbn_wire::unindexed_markdown::FileKindV1::Ordinary,
                        content: FileContent::Blob(f.blob),
                        path: f.path,
                        mtime: None,
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
                                self.native_content_ok(&p.content)?;
                                native.push(p.content.clone());
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
                        media: mdbn_wire::intent::MediaClass::of(&f.path),
                        modified_seq: self.mseq.get(&f.id).copied().unwrap_or(0),
                        bucket: bucket16(&f.id),
                        // Nothing is on this device yet: the installed row is
                        // fetched and placed by the attachment reconcile.
                        local: FileLocal::Remote,
                        kind: mdbn_wire::unindexed_markdown::FileKindV1::Ordinary,
                        content: FileContent::AttachmentV1(f.content),
                        path: f.path,
                        mtime: f.mtime,
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
                    self.native_content_ok(&f.payload.content)?;
                    native.push(f.payload.content.clone());
                    tx.files_put.push(FileRow {
                        id: f.id,
                        path_key: mdbn_core::paths::path_key(&f.path),
                        path: f.path,
                        media: f.media,
                        modified_seq: self.mseq.get(&f.id).copied().unwrap_or(0),
                        bucket: bucket16(&f.id),
                        local: FileLocal::Remote,
                        kind: mdbn_wire::unindexed_markdown::FileKindV1::UnindexedOversizedMarkdown,
                        content: f.payload.content,
                        mtime: None,
                    });
                }
            }
            SectionKind::UnindexedMarkdownTombstones => {
                for t in chunk
                    .rows_as::<mdbn_wire::unindexed_markdown::UnindexedMarkdownTombstoneRowV1>()
                    .map_err(bad)?
                {
                    path_ok(&t.path)?;
                    self.native_content_ok(&t.payload.content)?;
                    native.push(t.payload.content.clone());
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
                    self.mseq.insert(r.id, r.modified_seq);
                    if let Some(mtime) = r.mtime {
                        self.mtime.insert(r.id, mtime);
                    }
                }
            }
        }
        // Index the rows: the state digest, duplicate IDs and path keys.
        for r in &tx.records_put {
            self.index.record(r)?;
        }
        for f in &tx.files_put {
            self.index.file(f)?;
        }
        for t in &tx.tombstones_put {
            self.index.tombstone(t)?;
        }
        for a in &tx.aliases_put {
            self.index.alias(a);
        }
        for c in &tx.conflicts_put {
            self.index.conflict(c);
        }
        Ok(Decoded {
            rows: tx,
            text_sources,
            native,
        })
    }
}

impl<S: Store> Replica<S> {
    /// Stage rows: in the store's staging area when it has one, so memory holds
    /// one chunk plus the index.
    fn stage_rows(&mut self, mut tx: Tx, what: &str) -> Result<(), String> {
        if self.store.stages() {
            tx.stage = crate::store::Stage::Put;
            if let Err(e) = self.store.commit(tx) {
                if !matches!(e, StoreError::CommitAborted(_)) {
                    self.committed_read_fault();
                }
                return Err(format!("{what}: {e}"));
            }
        } else {
            extend_rows(&mut self.install_staged, tx);
        }
        Ok(())
    }

    pub(in crate::replica) fn stage_snapshot_text(
        &mut self,
        id: mdbn_wire::common::Uuid,
        path: String,
        modified_seq: u64,
        mtime: Option<i64>,
        doc: &str,
    ) -> Result<(), String> {
        let r = self
            .install_rows
            .text_row(id, path, modified_seq, mtime, doc)?;
        self.stage_rows(
            Tx {
                records_put: vec![r],
                ..Tx::default()
            },
            "record source staging",
        )
    }

    pub(super) fn install_chunk(&mut self, chunk: &ChunkPayload) -> Result<(), String> {
        let d = self.install_rows.decode(chunk)?;
        for row in d.text_sources {
            self.install_text_sources.add(row);
        }
        for c in &d.native {
            self.install_native_roots
                .add(c)
                .map_err(|e| e.to_string())?;
        }
        self.stage_rows(d.rows, "staging")
    }
}
