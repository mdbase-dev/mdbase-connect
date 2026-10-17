//! Closed native generation-0 import and finish for the fence-first Driver.
//!
//! Each `ImportGen0` selects a row/byte-bounded prefix after its retained cursor.
//! Resources and buckets may span several windows. The host streams the
//! current bytes of the selected S0 placements from the legacy read; native binds them
//! to that read (collection, head and session of the settled open), checks each
//! against the placement's SHA-256 and size before staging a row through the
//! Replica's private `hosted_gen0_*` custody. Paths and classes come from the
//! spill, never from the input.
//!
//! | Call | Retained action | Input | Output |
//! |---|---|---|---|
//! | placements | `ImportGen0` | — | exact selected metadata + done |
//! | file | `ImportGen0 { bucket: Some(b) }` | `[collection, head, session, file id, bytes]` (run-one convenience) | sealed file objects |
//! | file chunk | same | `[collection, head, session, file id, offset, bytes]` | sealed chunk; manifest only at exact completion |
//! | window | `ImportGen0` | `[collection, head, session, [[key, text]…]]` | sealed chunks + every address to verify |
//! | finish | `FinishGen0` | — | finish chunks + manifest + every base ref to verify |
//! | result | either | `[collection, [present…]]` (HasObjects, in that order) | settlement digest |
//!
//! A window or finish only stages its outcome. It settles when the host shows
//! every address it must verify is present in the collection's object store, so
//! sealing alone never advances the Driver, and a missing upload (a lost
//! PutObject reply) can be re-sent and re-checked. Staged work lives in RAM
//! with the custody: eviction or a lost commit acknowledgement loses it, and
//! the Driver restarts the read.
//!
//! Current state only. A legacy file's earlier versions are never `Gen0File`
//! rows or current bytes: they belong to the pre-history archive, sealed in
//! this SAME custody slot and composed into the same base before it is
//! appended (not part of this adapter).
//!
//! Failing closed: ordinary windows hold at most 128 placements and 64 KiB
//! charged text/path/descriptor input; larger records use isolated windows
//! through the native 1 MiB cap (+8 KiB framing/owned metadata). A streamed file is at
//! most 1 GiB in sequential 8 MiB chunks. Oversized Markdown remains refused.
//! Partial/wrong-hash streams never become window rows; uploaded partial objects
//! remain unrooted. Every complete file ref participates in window verification.
use super::{JournalDriver, LedgerError, OPEN_SOURCE, Result, target_fingerprint};
use mdbn_migrate_portable::hosted_import::{Action, Class, Generation, Key, Outcome, Spill};
use mdbn_migrate_portable::preflight::EntityKind;
use mdbn_replica::replica::gen0::{
    DigestCounts, Gen0File, Gen0Object, Gen0Record, HOSTED_FILE_BYTES, HOSTED_FILE_CHUNK_BYTES,
    HOSTED_FILE_TOTAL_BYTES, HostedGen0Handle, StateDigestStream,
};
use mdbn_store_file::index::IndexStorage;
use mdbn_wire::attachment::FileContent;
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::common::{B16, B32, Uuid};
use mdbn_wire::schema::Wire;
use std::collections::BTreeMap;
use zeroize::Zeroizing;

/// Most placements one window takes (the custody's per-call row bound).
const WINDOW_ROWS: usize = mdbn_migrate_portable::hosted_import::GEN0_WINDOW_ROWS;
type Placements = Vec<(Key, mdbn_migrate_portable::hosted_import::Meta)>;
/// A whole file plus its fixed header.
pub(super) const MAX_FILE_INPUT: usize = HOSTED_FILE_BYTES + 256;
pub(super) const MAX_FILE_CHUNK_INPUT: usize = HOSTED_FILE_CHUNK_BYTES + 256;
/// Ordinary windows or one isolated record through the native 1 MiB cap.
pub(super) const MAX_WINDOW_INPUT: usize =
    mdbn_migrate_portable::hosted_import::GEN0_RECORD_WINDOW_BYTES as usize;
/// One flag per address the host verifies (at most 1024 refs and a manifest).
pub(super) const MAX_RESULT_INPUT: usize = 4 << 10;
const MAX_TEXT: usize = 4096;
const MAX_SAFE: u64 = 9_007_199_254_740_991;

/// The custody slot of the current read's generation 0, and the files sealed
/// for the retained window not yet staged.
pub(super) struct Custody {
    handle: HostedGen0Handle,
    bits: u64,
    action: Uuid,
    files: BTreeMap<Uuid, (Gen0File, Vec<B32>)>,
}

/// A sealed window or finish, awaiting the host's upload verification.
pub(super) struct Staged {
    action: Uuid,
    outcome: Outcome,
    verify: Vec<B32>,
    provenance: B32,
}

/// Objects to upload (`put_object`), and the addresses whose presence settles.
pub(crate) struct Gen0Output {
    pub(crate) objects: Vec<Gen0Object>,
    pub(crate) verify: Vec<B32>,
}

impl Gen0Output {
    /// `[[[address, kind, bytes]…], [address…]]`.
    pub(crate) fn encode(&self) -> Vec<u8> {
        cbor::encode(&Cbor::Array(vec![
            Cbor::Array(
                self.objects
                    .iter()
                    .map(|o| {
                        Cbor::Array(vec![
                            Cbor::Bytes(o.address.0.to_vec()),
                            o.kind.to_cbor(),
                            Cbor::Bytes(o.bytes.clone()),
                        ])
                    })
                    .collect(),
            ),
            Cbor::Array(
                self.verify
                    .iter()
                    .map(|a| Cbor::Bytes(a.0.to_vec()))
                    .collect(),
            ),
        ]))
        .unwrap_or_default()
    }
}

/// The legacy read a byte input claims to come from.
#[derive(Clone, Copy)]
struct Source {
    collection: Uuid,
    head: u64,
    session: Uuid,
}

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
enum RowKey {
    Resource(String),
    Record(Uuid),
}

fn uuid(v: &Cbor) -> Result<Uuid> {
    let Cbor::Bytes(b) = v else {
        return Err(LedgerError::Invalid);
    };
    let b: [u8; 16] = b.as_slice().try_into().map_err(|_| LedgerError::Invalid)?;
    if b == [0; 16] {
        return Err(LedgerError::Invalid);
    }
    Ok(B16(b))
}
fn source(collection: &Cbor, head: &Cbor, session: &Cbor) -> Result<Source> {
    let Cbor::Uint(head) = head else {
        return Err(LedgerError::Invalid);
    };
    if *head > MAX_SAFE {
        return Err(LedgerError::Invalid);
    }
    Ok(Source {
        collection: uuid(collection)?,
        head: *head,
        session: uuid(session)?,
    })
}
fn array(input: &[u8], max: usize) -> Result<Vec<Cbor>> {
    if input.is_empty() || input.len() > max {
        return Err(LedgerError::Invalid);
    }
    match cbor::decode(input) {
        Ok(Cbor::Array(fields)) => Ok(fields),
        _ => Err(LedgerError::Invalid),
    }
}
type FileBytes = Zeroizing<Vec<u8>>;
fn decode_file(input: &[u8]) -> Result<(Source, Uuid, FileBytes)> {
    let [c, h, s, id, bytes]: [Cbor; 5] = array(input, MAX_FILE_INPUT)?
        .try_into()
        .map_err(|_| LedgerError::Invalid)?;
    let Cbor::Bytes(bytes) = bytes else {
        return Err(LedgerError::Invalid);
    };
    let bytes = Zeroizing::new(bytes);
    if bytes.len() > HOSTED_FILE_BYTES {
        return Err(LedgerError::Unsupported);
    }
    Ok((source(&c, &h, &s)?, uuid(&id)?, bytes))
}
fn decode_file_chunk(input: &[u8]) -> Result<(Source, Uuid, u64, FileBytes)> {
    let [c, h, s, id, offset, bytes]: [Cbor; 6] = array(input, MAX_FILE_CHUNK_INPUT)?
        .try_into()
        .map_err(|_| LedgerError::Invalid)?;
    let Cbor::Bytes(bytes) = bytes else {
        return Err(LedgerError::Invalid);
    };
    let bytes = Zeroizing::new(bytes);
    let Cbor::Uint(offset) = offset else {
        return Err(LedgerError::Invalid);
    };
    if offset > HOSTED_FILE_TOTAL_BYTES || bytes.len() > HOSTED_FILE_CHUNK_BYTES {
        return Err(LedgerError::Invalid);
    }
    Ok((source(&c, &h, &s)?, uuid(&id)?, offset, bytes))
}
fn decode_window(input: &[u8]) -> Result<(Source, BTreeMap<RowKey, String>)> {
    let fields = array(input, MAX_WINDOW_INPUT)?;
    let [c, h, s, Cbor::Array(items)] = fields.as_slice() else {
        return Err(LedgerError::Invalid);
    };
    if items.len() > WINDOW_ROWS {
        return Err(LedgerError::Unsupported);
    }
    let mut rows = BTreeMap::new();
    for item in items {
        let Cbor::Array(pair) = item else {
            return Err(LedgerError::Invalid);
        };
        let [key, Cbor::Text(text)] = pair.as_slice() else {
            return Err(LedgerError::Invalid);
        };
        let key = match key {
            Cbor::Text(path) if !path.is_empty() && path.len() <= MAX_TEXT => {
                RowKey::Resource(path.clone())
            }
            id @ Cbor::Bytes(_) => RowKey::Record(uuid(id)?),
            _ => return Err(LedgerError::Invalid),
        };
        // One row per placement: a duplicate is malformed, not a choice.
        if rows.insert(key, text.clone()).is_some() {
            return Err(LedgerError::Invalid);
        }
    }
    Ok((source(c, h, s)?, rows))
}
fn decode_result(input: &[u8]) -> Result<(Uuid, Vec<bool>)> {
    let fields = array(input, MAX_RESULT_INPUT)?;
    let [c, Cbor::Array(flags)] = fields.as_slice() else {
        return Err(LedgerError::Invalid);
    };
    let present = flags
        .iter()
        .map(|f| match f {
            Cbor::Bool(b) => Ok(*b),
            _ => Err(LedgerError::Invalid),
        })
        .collect::<Result<Vec<_>>>()?;
    Ok((uuid(c)?, present))
}

/// Bytes match the placement's SHA-256 and size exactly.
fn matches(meta_content: &B32, size: u64, bytes: &[u8]) -> bool {
    bytes.len() as u64 == size && mdbn_wire::hash::sha256(bytes) == *meta_content
}

fn record_id(key: &Key) -> Result<Uuid> {
    let id = mdbn_migrate_portable::ids::uuid(&key.id).map_err(|_| LedgerError::Corrupt)?;
    Ok(B16(id.0))
}

impl<I: IndexStorage> JournalDriver<I> {
    /// Same live ticket, same actual native target as the run binding.
    fn gen0_bound<S: mdbn_replica::Store>(
        &mut self,
        ticket: &super::PreparedAction,
        engine: &mut crate::runtime::Engine<S>,
        target: &crate::runtime::ObservedNativeTarget,
    ) -> Result<()> {
        self.assert_prepared(ticket)?;
        engine
            .recheck_native_target(target)
            .map_err(|_| LedgerError::Refused)?;
        if target.admission().collection() != self.binding.collection
            || target_fingerprint(target) != self.binding.target
        {
            return Err(LedgerError::Conflict);
        }
        Ok(())
    }

    /// The bytes come from the CURRENT S0 read: its settled open's head and session.
    fn gen0_source(&mut self, s: &Source) -> Result<()> {
        let open = self.latest_settled(OPEN_SOURCE)?;
        let opened = super::codec::source_outcome(
            &Action::OpenSource {
                generation: Generation::S0,
                expect_head: None,
            },
            &Outcome::Opened { head: s.head },
            vec![Cbor::Bytes(s.session.0.to_vec())],
        )?;
        if s.collection != self.binding.collection || open != Some(opened) {
            return Err(LedgerError::Conflict);
        }
        Ok(())
    }

    /// Exact retained action cursor; host input never chooses a window.
    fn gen0_window_action(
        &mut self,
        ticket: &super::PreparedAction,
    ) -> Result<(u64, Option<u64>, Option<Key>)> {
        match self.prepared_action(ticket)? {
            Action::ImportGen0 {
                bits,
                bucket,
                after,
            } => Ok((*bits, *bucket, after.clone())),
            _ => Err(LedgerError::Conflict),
        }
    }

    /// A row/byte-bounded prefix, and whether it exhausts this bucket.
    fn gen0_placements(&mut self, ticket: &super::PreparedAction) -> Result<(Placements, bool)> {
        let (bits, bucket, after) = self.gen0_window_action(ticket)?;
        let window = mdbn_migrate_portable::hosted_import::gen0_window(
            &mut self.spill,
            bits,
            bucket,
            after.as_ref(),
        )
        .map_err(|e| match e {
            mdbn_migrate_portable::Error::Invalid(s) if s.starts_with("spill:") => {
                LedgerError::StorageUnknown
            }
            _ => LedgerError::Unsupported,
        })?;
        if window
            .0
            .iter()
            .any(|(_, meta)| meta.class == Class::UnindexedMarkdown)
        {
            return Err(LedgerError::Unsupported);
        }
        Ok(window)
    }

    /// Metadata for exactly the native-selected window: `[rows, done]`, each row
    /// `[kind (0 resource, 1 record, 2 file), legacy id/path, new path, size, hash]`.
    pub(crate) fn gen0_placement_input<S: mdbn_replica::Store>(
        &mut self,
        ticket: &super::PreparedAction,
        engine: &mut crate::runtime::Engine<S>,
        target: &crate::runtime::ObservedNativeTarget,
    ) -> Result<Vec<u8>> {
        self.gen0_bound(ticket, engine, target)?;
        let (rows, done) = self.gen0_placements(ticket)?;
        cbor::encode(&Cbor::Array(vec![
            Cbor::Array(
                rows.into_iter()
                    .map(|(key, meta)| {
                        Cbor::Array(vec![
                            Cbor::Uint(match key.kind {
                                EntityKind::Resource => 0,
                                EntityKind::Record => 1,
                                EntityKind::File => 2,
                            }),
                            Cbor::Text(key.id),
                            Cbor::Text(meta.path),
                            Cbor::Uint(meta.size),
                            Cbor::Bytes(meta.content.0.to_vec()),
                        ])
                    })
                    .collect(),
            ),
            Cbor::Bool(done),
        ]))
        .map_err(|_| LedgerError::Invalid)
    }

    /// The custody for the retained window's numbered bucket. Files staged for
    /// an earlier action are dropped: they were never part of a settled window.
    fn custody_for(&mut self, action: Uuid, bits: u64) -> Result<&mut Custody> {
        if self.gen0_staged.is_some() {
            return Err(LedgerError::Conflict);
        }
        let custody = self.gen0_custody.as_mut().ok_or(LedgerError::Conflict)?;
        if custody.bits != bits {
            return Err(LedgerError::Conflict);
        }
        if custody.action != action {
            custody.files.clear();
            custody.action = action;
        }
        Ok(custody)
    }

    /// Seal ONE whole current file of the retained bucket window. Verified
    /// against its S0 placement before any sealing; nothing settles here.
    pub(crate) fn gen0_file<S: mdbn_replica::Store>(
        &mut self,
        ticket: &super::PreparedAction,
        engine: &mut crate::runtime::Engine<S>,
        target: &crate::runtime::ObservedNativeTarget,
        input: &[u8],
    ) -> Result<Gen0Output> {
        self.gen0_file_input(ticket, engine, target, input, false)
    }

    /// Sequential current-file AttachmentV1 chunk; a partial stream cannot stage
    /// a row, and a completed stream must match the S0 whole-file digest.
    pub(crate) fn gen0_file_chunk<S: mdbn_replica::Store>(
        &mut self,
        ticket: &super::PreparedAction,
        engine: &mut crate::runtime::Engine<S>,
        target: &crate::runtime::ObservedNativeTarget,
        input: &[u8],
    ) -> Result<Gen0Output> {
        self.gen0_file_input(ticket, engine, target, input, true)
    }

    fn gen0_file_input<S: mdbn_replica::Store>(
        &mut self,
        ticket: &super::PreparedAction,
        engine: &mut crate::runtime::Engine<S>,
        target: &crate::runtime::ObservedNativeTarget,
        input: &[u8],
        streamed: bool,
    ) -> Result<Gen0Output> {
        self.gen0_bound(ticket, engine, target)?;
        let (source, id, offset, bytes) = if streamed {
            decode_file_chunk(input)?
        } else {
            let (source, id, bytes) = decode_file(input)?;
            (source, id, 0, bytes)
        };
        let (bits, bucket, _) = self.gen0_window_action(ticket)?;
        if bucket.is_none() {
            return Err(LedgerError::Conflict);
        }
        self.gen0_source(&source)?;
        let action = ticket.data.action;
        if self.custody_for(action, bits)?.files.contains_key(&id) {
            return Err(LedgerError::Conflict);
        }
        let key = Key {
            kind: EntityKind::File,
            id: id.to_uuid_string(),
        };
        let meta = self
            .gen0_placements(ticket)?
            .0
            .into_iter()
            .find(|(k, _)| *k == key)
            .map(|(_, m)| m)
            .ok_or(LedgerError::Conflict)?;
        if meta.class != Class::Attachment {
            return Err(LedgerError::Conflict);
        }
        if meta.size > HOSTED_FILE_TOTAL_BYTES
            || (!streamed && meta.size > HOSTED_FILE_BYTES as u64)
        {
            return Err(LedgerError::Unsupported);
        }
        if !streamed && !matches(&meta.content, meta.size, &bytes) {
            return Err(LedgerError::Conflict);
        }
        let custody = self.gen0_custody.as_mut().ok_or(LedgerError::Conflict)?;
        let replica = engine
            .migration_gen0_replica(target)
            .map_err(|_| LedgerError::Refused)?;
        let progress = replica
            .hosted_gen0_file_chunk(
                target.admission(),
                &custody.handle,
                id,
                meta.path,
                meta.size,
                offset,
                &bytes,
            )
            .map_err(|_| LedgerError::Refused)?;
        if let Some(file) = progress.file {
            if file.content.plain_hash() != meta.content || file.content.size() != meta.size {
                let custody = self.gen0_custody.take().ok_or(LedgerError::Conflict)?;
                let _ = replica.hosted_gen0_abort(target.admission(), &custody.handle);
                return Err(LedgerError::Conflict);
            }
            custody.files.insert(id, (file, progress.refs));
        }
        Ok(Gen0Output {
            objects: progress.objects,
            verify: Vec::new(),
        })
    }

    /// Seal the retained window: every placement exactly once, text rows from
    /// `input` and files already sealed by [`Self::gen0_file`]. Stages
    /// `Gen0Progress` until the uploads are verified. Native alone chooses `done`.
    pub(crate) fn gen0_window<S: mdbn_replica::Store>(
        &mut self,
        ticket: &super::PreparedAction,
        engine: &mut crate::runtime::Engine<S>,
        target: &crate::runtime::ObservedNativeTarget,
        input: &[u8],
    ) -> Result<Gen0Output> {
        self.gen0_bound(ticket, engine, target)?;
        let (source, mut rows) = decode_window(input)?;
        let (bits, bucket, after) = self.gen0_window_action(ticket)?;
        self.gen0_source(&source)?;
        let stats = self.driver.import_stats().ok_or(LedgerError::Conflict)?;
        let action = ticket.data.action;
        if bucket.is_none() && after.is_none() {
            // The first resource window opens this read's custody, once per action.
            if self.gen0_staged.is_some()
                || self
                    .gen0_custody
                    .as_ref()
                    .is_some_and(|c| c.action == action)
            {
                return Err(LedgerError::Conflict);
            }
            if stats.unindexed > 0 {
                return Err(LedgerError::Unsupported);
            }
        } else {
            self.custody_for(action, bits)?;
        }
        let (placements, done) = self.gen0_placements(ticket)?;
        let mut resources = Vec::new();
        let mut records = Vec::new();
        let mut files = Vec::new();
        let mut refs = Vec::new();
        for (key, meta) in &placements {
            match (meta.class, key.kind) {
                (Class::Resource, EntityKind::Resource) => {
                    let text = rows
                        .remove(&RowKey::Resource(key.id.clone()))
                        .ok_or(LedgerError::Conflict)?;
                    if !matches(&meta.content, meta.size, text.as_bytes()) {
                        return Err(LedgerError::Conflict);
                    }
                    resources.push((meta.path.clone(), text));
                }
                (Class::Record, EntityKind::Record) => {
                    let id = record_id(key)?;
                    let doc = rows
                        .remove(&RowKey::Record(id))
                        .ok_or(LedgerError::Conflict)?;
                    if !matches(&meta.content, meta.size, doc.as_bytes()) {
                        return Err(LedgerError::Conflict);
                    }
                    records.push(Gen0Record {
                        id,
                        path: meta.path.clone(),
                        doc,
                    });
                }
                (Class::Attachment, EntityKind::File) => {
                    let id = record_id(key)?;
                    let custody = self.gen0_custody.as_ref().ok_or(LedgerError::Conflict)?;
                    let (file, addresses) = custody.files.get(&id).ok_or(LedgerError::Conflict)?;
                    let FileContent::AttachmentV1(content) = &file.content else {
                        return Err(LedgerError::Corrupt);
                    };
                    if file.path != meta.path
                        || content.whole_plain_hash != meta.content
                        || content.total_plain_bytes != meta.size
                    {
                        return Err(LedgerError::Conflict);
                    }
                    files.push(file.clone());
                    refs.extend_from_slice(addresses);
                }
                (Class::UnindexedMarkdown, _) => return Err(LedgerError::Unsupported),
                _ => return Err(LedgerError::Corrupt),
            }
        }
        // Every row answers a placement and every sealed file is placed.
        let sealed_files = self.gen0_custody.as_ref().map_or(0, |c| c.files.len());
        if !rows.is_empty() || sealed_files != files.len() {
            return Err(LedgerError::Conflict);
        }
        let replica = engine
            .migration_gen0_replica(target)
            .map_err(|_| LedgerError::Refused)?;
        let sealed = match bucket {
            None => {
                if after.is_none() {
                    if let Some(old) = self.gen0_custody.take() {
                        // A restarted read: the earlier slot never finishes.
                        let _ = replica.hosted_gen0_abort(target.admission(), &old.handle);
                    }
                    let handle = replica
                        .hosted_gen0_begin(target.admission(), bits, stats.attachments > 0, false)
                        .map_err(|_| LedgerError::Refused)?;
                    self.gen0_custody = Some(Custody {
                        handle,
                        bits,
                        action,
                        files: BTreeMap::new(),
                    });
                }
                let custody = self.gen0_custody.as_ref().ok_or(LedgerError::Conflict)?;
                replica
                    .hosted_gen0_resources_window(
                        target.admission(),
                        &custody.handle,
                        resources,
                        done,
                    )
                    .ok()
            }
            Some(b) => {
                let custody = self.gen0_custody.as_ref().ok_or(LedgerError::Conflict)?;
                replica
                    .hosted_gen0_bucket_window(
                        target.admission(),
                        &custody.handle,
                        b,
                        records,
                        files,
                        &refs,
                        done,
                    )
                    .ok()
            }
        };
        let Some(objects) = sealed else {
            self.gen0_custody = None;
            return Err(LedgerError::Refused);
        };
        if let Some(c) = self.gen0_custody.as_mut() {
            c.files.clear();
        }
        refs.extend(objects.iter().map(|o| o.address));
        let provenance = digest_window(bucket, placements.len(), &refs)?;
        self.gen0_staged = Some(Staged {
            action,
            outcome: Outcome::Gen0Progress {
                last: placements.last().map(|(k, _)| k.clone()),
                done,
            },
            verify: refs.clone(),
            provenance,
        });
        Ok(Gen0Output {
            objects,
            verify: refs,
        })
    }

    /// Seal the retained `FinishGen0`: the state digest streamed from the S0
    /// placements, the remaining sections and the manifest. Consumes the custody
    /// slot; stages `Gen0Built` until every base ref is verified present.
    pub(crate) fn gen0_finish<S: mdbn_replica::Store>(
        &mut self,
        ticket: &super::PreparedAction,
        engine: &mut crate::runtime::Engine<S>,
        target: &crate::runtime::ObservedNativeTarget,
    ) -> Result<Gen0Output> {
        self.gen0_bound(ticket, engine, target)?;
        if !matches!(self.prepared_action(ticket)?, Action::FinishGen0)
            || self.gen0_staged.is_some()
        {
            return Err(LedgerError::Conflict);
        }
        let stats = self.driver.import_stats().ok_or(LedgerError::Conflict)?;
        if self.gen0_custody.is_none() || stats.unindexed > 0 {
            return Err(LedgerError::Conflict);
        }
        let settings = mdbn_replica::convert::winclusion(&Default::default());
        let state_digest = self.gen0_state_digest(
            DigestCounts {
                resources: stats.resources,
                records: stats.records,
                files: stats.attachments,
                unindexed: 0,
            },
            &settings,
        )?;
        let custody = self.gen0_custody.take().ok_or(LedgerError::Conflict)?;
        let (mut objects, manifest) = engine
            .migration_gen0_replica(target)
            .map_err(|_| LedgerError::Refused)?
            .hosted_gen0_finish(target.admission(), &custody.handle, state_digest, settings)
            .map_err(|_| LedgerError::Refused)?;
        objects.extend(manifest.ref_indices);
        objects.push(manifest.manifest.clone());
        let verify = manifest.base_refs;
        let provenance = digest_window(None, 0, &verify)?;
        self.gen0_staged = Some(Staged {
            action: ticket.data.action,
            outcome: Outcome::Gen0Built {
                manifest: manifest.manifest.address,
                state_digest,
            },
            verify: verify.clone(),
            provenance,
        });
        Ok(Gen0Output { objects, verify })
    }

    /// `snapshot.md` §4 state digest of the S0 placements in key order
    /// (resources first, then records, then files): resources sorted by their
    /// new path, every row from metadata the windows verified the bytes against.
    fn gen0_state_digest(
        &mut self,
        counts: DigestCounts,
        settings: &mdbn_wire::intent::FileInclusion,
    ) -> Result<B32> {
        let mut stream = StateDigestStream::new(counts, settings);
        let mut resources: Option<Vec<(String, B32)>> = Some(Vec::new());
        let flush = |stream: &mut StateDigestStream, r: &mut Option<Vec<(String, B32)>>| {
            if let Some(mut rows) = r.take() {
                rows.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
                for (path, revision) in rows {
                    stream
                        .resource_revision(&path, revision)
                        .map_err(|_| LedgerError::Conflict)?;
                }
            }
            Ok::<(), LedgerError>(())
        };
        let mut after: Option<Key> = None;
        loop {
            let page = self
                .spill
                .placements_page(Generation::S0, after.as_ref(), 256)
                .map_err(|_| LedgerError::StorageUnknown)?;
            let full = page.len() == 256;
            for (key, meta) in page {
                match (meta.class, key.kind) {
                    (Class::Resource, EntityKind::Resource) => resources
                        .as_mut()
                        .ok_or(LedgerError::Corrupt)?
                        .push((meta.path, meta.content)),
                    (Class::Record, EntityKind::Record) => {
                        flush(&mut stream, &mut resources)?;
                        stream
                            .record(record_id(&key)?, &meta.path, meta.content)
                            .map_err(|_| LedgerError::Conflict)?;
                    }
                    (Class::Attachment, EntityKind::File) => {
                        flush(&mut stream, &mut resources)?;
                        stream
                            .file_revision(record_id(&key)?, &meta.path, meta.content)
                            .map_err(|_| LedgerError::Conflict)?;
                    }
                    (Class::UnindexedMarkdown, _) => return Err(LedgerError::Unsupported),
                    _ => return Err(LedgerError::Corrupt),
                }
                after = Some(key);
            }
            if !full {
                break;
            }
        }
        flush(&mut stream, &mut resources)?;
        stream.finish().map_err(|_| LedgerError::Conflict)
    }

    /// Settle the staged window or finish of the retained action from the
    /// host's HasObjects flags over exactly the staged addresses, in order. A
    /// missing object refuses and keeps the staged work, so the host can upload
    /// it again; nothing is written on refusal.
    pub(crate) fn settle_gen0<S: mdbn_replica::Store>(
        &mut self,
        ticket: &super::PreparedAction,
        engine: &mut crate::runtime::Engine<S>,
        target: &crate::runtime::ObservedNativeTarget,
        input: &[u8],
    ) -> Result<B32> {
        self.gen0_bound(ticket, engine, target)?;
        let (collection, present) = decode_result(input)?;
        let staged = self.gen0_staged.as_ref().ok_or(LedgerError::Conflict)?;
        if staged.action != ticket.data.action
            || collection != self.binding.collection
            || present.len() != staged.verify.len()
            || present.iter().any(|p| !p)
        {
            return Err(LedgerError::Conflict);
        }
        let outcome = staged.outcome.clone();
        let provenance = staged.provenance;
        let refs = match &outcome {
            Outcome::Gen0Built { manifest, .. } => Some((*manifest, staged.verify.clone())),
            _ => None,
        };
        let action = &self.pending.as_ref().ok_or(LedgerError::Refused)?.1;
        let result = super::codec::gen0_outcome(action, &outcome, provenance)?;
        let settled = self.settle_checked(ticket, outcome, result);
        self.gen0_staged = None;
        if let (Ok(_), Some((manifest, refs))) = (&settled, refs) {
            // The base appended next names exactly these refs.
            self.retain_base_refs(manifest, refs);
        }
        settled
    }
}

/// Provenance of one staged window or finish: its bucket, placement count and
/// every address it verified, in order.
fn digest_window(bucket: Option<u64>, rows: usize, verify: &[B32]) -> Result<B32> {
    let b = cbor::encode(&Cbor::Array(vec![
        bucket.map_or(Cbor::Null, Cbor::Uint),
        Cbor::Uint(rows as u64),
        Cbor::Array(verify.iter().map(|a| Cbor::Bytes(a.0.to_vec())).collect()),
    ]))
    .map_err(|_| LedgerError::Invalid)?;
    Ok(mdbn_wire::hash::h("mdbase/v1/native-gen0-window", &b))
}
