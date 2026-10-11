//! Adopt: turn sync on for a folder that already holds files
//! (`snapshot.md` §7, `base {source: folder}`).
//!
//! The host opens a synced replica over the folder with a fresh store and calls
//! [`Replica::begin_adopt`] before the first scan. Until the base is applied:
//! - nothing is ingested (an observation is left unacknowledged, so the store
//!   re-delivers it after the base) and app writes are refused, because no entry may
//!   precede the base;
//! - once this device holds the current epoch key and may write (its own initial
//!   rekey in a private collection, or the cloud-copy keying), the replica seals a
//!   generation 0 from the [`AdoptSource`] **one bucket at a time** with the record
//!   IDs the source names, uploads every object, then appends a `base` signed by
//!   this device. Only the inventory (ID, path, digest) is held across buckets.
//!
//! The base then installs through the ordinary staged install. Bytes already in the
//! folder equal the installed view, so nothing is rewritten and nothing is held
//! (`disk.rs`: identical bytes settle without a provenance check).
//!
//! Generation 0 holds the records and resources the source names. Every other
//! file (attachments, oversized Markdown, files the source does not know) is
//! ingested after the base as an ordinary external create. A document that changed
//! between the inventory and its bucket restarts the build; a crash anywhere before
//! the base is acknowledged leaves only unreferenced objects (collected by the log
//! service) and the next open builds again. A base that reached the log installs on
//! reopen like any other.

use std::collections::BTreeMap;

use mdbn_wire::common::{Hash, Uuid};
use mdbn_wire::envelope::{Item, ItemKind};
use mdbn_wire::intent::FileInclusion;
use mdbn_wire::schema::Wire;
use mdbn_wire::snapshot::BaseSource;

use super::Replica;
use super::append::Inflight;
use super::gen0::{
    DigestCounts, Gen0Manifest, Gen0Object, Gen0Record, Gen0Writer, StateDigestStream, bucket_bits,
};
use crate::log::{LogReply, LogRequest, LogResponse};
use crate::store::Store;

/// Builds that may fail (a source changing under the build, a lost upload or
/// append) before adopt reports [`AdoptStatus::Failed`].
const MAX_ATTEMPTS: u32 = 8;

/// What generation 0 adopts: records with their IDs, resource paths and the
/// file-inclusion settings (`None`: the default inclusion).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AdoptRecords {
    /// Record ID and collection-relative path.
    pub records: Vec<(Uuid, String)>,
    /// Resource paths (configuration, types).
    pub resources: Vec<String>,
    /// File-inclusion settings.
    pub settings: Option<FileInclusion>,
}

/// The folder as it is now, as the host reads it. Errors are messages without
/// file contents.
pub trait AdoptSource {
    /// The inventory. Called at the start of every build.
    fn records(&mut self) -> Result<AdoptRecords, String>;
    /// The exact current text at `path`; `None` when it is gone or is not text
    /// (it is then left to ordinary ingest after the base).
    fn read(&mut self, path: &str) -> Result<Option<String>, String>;
}

/// Where an adopt stands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdoptStatus {
    /// Waiting for keys, sealing, uploading or appending the base.
    Pending,
    /// The base is applied; ordinary ingest runs.
    Done,
    /// Adopt cannot complete (another device's content is in the log, or builds
    /// kept failing). Nothing was ingested.
    Failed(String),
}

pub(crate) struct Adopt {
    source: Option<Box<dyn AdoptSource>>,
    phase: Phase,
    attempts: u32,
}

enum Phase {
    Ready,
    Sealing(Box<Sealing>),
    Appending,
    Done,
    Failed(String),
}

struct Sealing {
    writer: Option<Gen0Writer>,
    /// Per bucket: (ID, path, revision), ascending by ID.
    plan: Vec<Vec<(Uuid, String, Hash)>>,
    next_bucket: usize,
    outstanding: usize,
    failed: bool,
    digest: Hash,
    settings: FileInclusion,
    manifest: Option<Gen0Manifest>,
    manifest_sent: bool,
}

enum Step {
    /// Waiting for uploads (or nothing to do this pump).
    Wait,
    /// Start over (the source changed or an upload failed).
    Restart(String),
    /// The base append is sent.
    Appended,
    /// Give up.
    Fail(String),
}

impl Adopt {
    pub(crate) fn status(&self) -> AdoptStatus {
        match &self.phase {
            Phase::Done => AdoptStatus::Done,
            Phase::Failed(m) => AdoptStatus::Failed(m.clone()),
            _ => AdoptStatus::Pending,
        }
    }

    /// Ingest and app writes wait while this holds.
    pub(crate) fn gates(&self) -> bool {
        !matches!(self.phase, Phase::Done)
    }
}

impl<S: Store> Replica<S> {
    /// Adopt the folder `source` describes as this collection's generation 0 (see
    /// the module docs). Call once, right after opening a synced replica whose
    /// collection has no content yet, and again after every reopen until
    /// [`Self::adopt_status`] is [`AdoptStatus::Done`].
    pub fn begin_adopt(&mut self, source: Box<dyn AdoptSource>) {
        if self.local_only() {
            return;
        }
        self.adopt = Some(Adopt {
            source: Some(source),
            phase: Phase::Ready,
            attempts: 0,
        });
        self.status_dirty = true;
    }

    /// The adopt's state, or `None` when none was begun.
    pub fn adopt_status(&self) -> Option<AdoptStatus> {
        self.adopt.as_ref().map(Adopt::status)
    }

    /// Record IDs to give files at their first ingest, by path (the takeover's
    /// imported ID map). A hint applies to the first
    /// new record ingested at its path, and never when its ID is already a record
    /// or a tombstone here.
    pub fn set_id_hints(&mut self, hints: Vec<(Uuid, String)>) {
        self.id_hints = hints
            .into_iter()
            .map(|(id, path)| (mdbn_core::paths::path_key(&path), id))
            .collect::<BTreeMap<_, _>>();
    }

    pub(crate) fn adopt_gates(&self) -> bool {
        self.adopt.as_ref().is_some_and(Adopt::gates)
    }

    /// Drive the adopt from the append loop, once this device may write under the
    /// current `epoch`. Returns true while adopt owns the loop (nothing else is
    /// appended).
    pub(crate) fn adopt_step(&mut self) -> bool {
        let Some(mut adopt) = self.adopt.take() else {
            return false;
        };
        let owns = self.adopt_drive(&mut adopt);
        if !adopt.gates() {
            adopt.source = None;
        }
        self.adopt = Some(adopt);
        owns
    }

    fn adopt_drive(&mut self, adopt: &mut Adopt) -> bool {
        if self.policy.content_seen {
            if !adopt.gates() {
                return false;
            }
            // Our base (now or before a restart), or someone else's content.
            adopt.phase = match self.adopted_ids_present(adopt) {
                Ok(true) => Phase::Done,
                Ok(false) => Phase::Failed(
                    "the collection already has content from another device; join it instead"
                        .into(),
                ),
                Err(e) => Phase::Failed(e),
            };
            self.status_dirty = true;
            return false;
        }
        loop {
            let step = match &mut adopt.phase {
                Phase::Done => return false,
                Phase::Failed(_) => return true,
                Phase::Ready => match self.adopt_begin_build(adopt) {
                    Ok(s) => {
                        adopt.phase = Phase::Sealing(Box::new(s));
                        continue;
                    }
                    Err(e) => Step::Restart(e),
                },
                Phase::Sealing(s) => self.adopt_seal_step(adopt.source.as_deref_mut(), s),
                // The append resolved without our base reaching the log (a
                // conflict or a refusal): build again.
                Phase::Appending => Step::Restart("the base append did not land".into()),
            };
            match step {
                Step::Wait => return true,
                Step::Appended => {
                    adopt.phase = Phase::Appending;
                    return true;
                }
                Step::Restart(why) => {
                    adopt.attempts += 1;
                    adopt.phase = if adopt.attempts >= MAX_ATTEMPTS {
                        Phase::Failed(format!("generation 0 could not be built: {why}"))
                    } else {
                        Phase::Ready
                    };
                    self.status_dirty = true;
                    // One build attempt per pump.
                    return true;
                }
                Step::Fail(why) => {
                    adopt.phase = Phase::Failed(why);
                    self.status_dirty = true;
                    return true;
                }
            }
        }
    }

    fn adopted_ids_present(&self, adopt: &mut Adopt) -> Result<bool, String> {
        let Some(source) = adopt.source.as_deref_mut() else {
            return Ok(true);
        };
        let inv = source.records()?;
        if inv.records.is_empty() {
            return Ok(true);
        }
        for (id, _) in &inv.records {
            if self.store.record(id).map_err(|e| e.to_string())?.is_some() {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Inventory, digest and the resources' chunks. Documents the source cannot
    /// read as admissible record text are left out (ingested after the base).
    fn adopt_begin_build(&mut self, adopt: &mut Adopt) -> Result<Sealing, String> {
        let source = adopt
            .source
            .as_deref_mut()
            .ok_or_else(|| "no adopt source".to_string())?;
        let inv = source.records()?;
        let admission = self.record_write_admission();
        let mut seen_ids = std::collections::BTreeSet::new();
        let mut seen_paths = std::collections::BTreeSet::new();
        let mut records: Vec<(Uuid, String, Hash, u64)> = Vec::new();
        for (id, path) in inv.records {
            if mdbn_core::paths::check_path(&path).is_err()
                || !seen_ids.insert(id)
                || !seen_paths.insert(mdbn_core::paths::path_key(&path))
            {
                continue;
            }
            let Some(doc) = source.read(&path)? else {
                continue;
            };
            if admission.check_source(&doc).is_err() {
                continue;
            }
            let rev = mdbn_wire::hash::sha256(doc.as_bytes());
            records.push((id, path, rev, doc.len() as u64));
        }
        let mut resources: Vec<(String, String)> = Vec::new();
        for path in inv.resources {
            if mdbn_core::paths::check_path(&path).is_err()
                || !seen_paths.insert(mdbn_core::paths::path_key(&path))
            {
                continue;
            }
            if let Some(doc) = source.read(&path)? {
                resources.push((path, doc));
            }
        }
        resources.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
        records.sort_by(|a, b| a.0.cmp(&b.0));
        let settings = inv
            .settings
            .unwrap_or_else(|| crate::convert::winclusion(&Default::default()));
        let mut digest = StateDigestStream::new(
            DigestCounts {
                resources: resources.len() as u64,
                records: records.len() as u64,
                ..DigestCounts::default()
            },
            &settings,
        );
        for (path, doc) in &resources {
            digest
                .resource(path, doc)
                .map_err(|e| format!("digest: {e:?}"))?;
        }
        for (id, path, rev, _) in &records {
            digest
                .record(*id, path, *rev)
                .map_err(|e| format!("digest: {e:?}"))?;
        }
        let digest = digest.finish().map_err(|e| format!("digest: {e:?}"))?;
        let bits = bucket_bits(records.iter().map(|r| r.3).sum());
        let mut writer = Gen0Writer::new(self.cfg.collection, bits, false, false);
        let mut plan: Vec<Vec<(Uuid, String, Hash)>> =
            (0..writer.buckets()).map(|_| Vec::new()).collect();
        for (id, path, rev, _) in records {
            let b = writer.bucket_of(&id) as usize;
            plan[b].push((id, path, rev));
        }
        let objects = writer
            .resources(self.sealer.as_mut(), self.host.entropy.as_mut(), resources)
            .map_err(|e| format!("seal resources: {e:?}"))?;
        let mut s = Sealing {
            writer: Some(writer),
            plan,
            next_bucket: 0,
            outstanding: 0,
            failed: false,
            digest,
            settings,
            manifest: None,
            manifest_sent: false,
        };
        self.adopt_put(&mut s, objects);
        Ok(s)
    }

    fn adopt_put(&mut self, s: &mut Sealing, objects: Vec<Gen0Object>) {
        for o in objects {
            let id = self.queue(LogRequest::PutObject {
                collection: self.cfg.collection,
                address: o.address,
                kind: o.kind,
                bytes: o.bytes,
            });
            self.inflight.insert(id, Inflight::AdoptPut);
            s.outstanding += 1;
        }
    }

    /// A gen-0 object upload's reply.
    pub(crate) fn on_adopt_put(&mut self, reply: &LogReply) {
        let ok = matches!(reply, Ok(LogResponse::PutObject { .. }));
        if let Some(Adopt {
            phase: Phase::Sealing(s),
            ..
        }) = self.adopt.as_mut()
        {
            s.outstanding = s.outstanding.saturating_sub(1);
            s.failed |= !ok;
        }
    }

    fn adopt_seal_step(
        &mut self,
        source: Option<&mut (dyn AdoptSource + 'static)>,
        s: &mut Sealing,
    ) -> Step {
        let Some(source) = source else {
            return Step::Fail("no adopt source".into());
        };
        loop {
            if s.outstanding > 0 {
                return Step::Wait;
            }
            if s.failed {
                return Step::Restart("an object upload failed".into());
            }
            if s.manifest_sent {
                return match self.adopt_append_base(s) {
                    Ok(()) => Step::Appended,
                    Err(e) => Step::Restart(e),
                };
            }
            if let Some(m) = &s.manifest {
                let manifest = m.manifest.clone();
                self.adopt_put(s, vec![manifest]);
                s.manifest_sent = true;
                continue;
            }
            if s.next_bucket < s.plan.len() {
                let rows = std::mem::take(&mut s.plan[s.next_bucket]);
                let b = s.next_bucket as u64;
                s.next_bucket += 1;
                let mut records = Vec::with_capacity(rows.len());
                for (id, path, rev) in rows {
                    match source.read(&path) {
                        Ok(Some(doc)) if mdbn_wire::hash::sha256(doc.as_bytes()) == rev => {
                            records.push(Gen0Record { id, path, doc })
                        }
                        Ok(_) => {
                            return Step::Restart("a document changed during the build".into());
                        }
                        Err(e) => return Step::Restart(e),
                    }
                }
                let Some(w) = s.writer.as_mut() else {
                    return Step::Fail("generation-0 writer missing".into());
                };
                match w.bucket(
                    self.sealer.as_mut(),
                    self.host.entropy.as_mut(),
                    b,
                    records,
                    vec![],
                    &[],
                ) {
                    Ok(objects) => self.adopt_put(s, objects),
                    Err(e) => return Step::Fail(format!("seal bucket: {e:?}")),
                }
                continue;
            }
            let Some(w) = s.writer.take() else {
                return Step::Fail("generation-0 writer missing".into());
            };
            match w.finish(
                self.sealer.as_mut(),
                self.host.entropy.as_mut(),
                s.digest,
                s.settings.clone(),
                self.cfg.device_id,
            ) {
                Ok((objects, manifest)) => {
                    if !manifest.ref_indices.is_empty() {
                        return Step::Fail(
                            "the folder is too large for one generation-0 base".into(),
                        );
                    }
                    self.adopt_put(s, objects);
                    s.manifest = Some(manifest);
                }
                Err(e) => return Step::Fail(format!("seal manifest: {e:?}")),
            }
        }
    }

    /// Seal, sign and append the `base` for the uploaded manifest.
    fn adopt_append_base(&mut self, s: &Sealing) -> Result<(), String> {
        let m = s.manifest.as_ref().ok_or("no manifest")?;
        let me = self.cfg.device_id;
        let spec =
            super::base::Gen0Base::new(m.manifest.address, m.state_digest, BaseSource::Folder);
        let (payload, _) =
            super::base::build_base(me, &spec, &|b| self.sealer.blob_part_addresses(b))
                .map_err(|e| e.to_string())?;
        let plain = payload.to_bytes().map_err(|_| "base payload encoding")?;
        let mut item = Item {
            kind: ItemKind::Base,
            collection: self.cfg.collection,
            seq: Some(self.head.seq + 1),
            prev: Some(self.head.chain),
            epoch: None,
            signer: Some(me),
            salt: None,
            idem: None,
            refs: Some(m.base_refs.clone()),
            stream: None,
            body: mdbn_wire::common::Bytes(Vec::new()),
            sig: None,
        };
        self.sealer
            .seal(&mut item, &plain, false, self.host.entropy.as_mut())
            .map_err(|e| format!("seal base: {e:?}"))?;
        if !self.append_base_item(item) {
            return Err("base item encoding".into());
        }
        Ok(())
    }
}
