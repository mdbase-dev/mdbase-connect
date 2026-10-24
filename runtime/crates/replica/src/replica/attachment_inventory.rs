//! Attachment object inventories for snapshot refs (`snapshot.md` §3, T7).
//!
//! A snapshot's `refs` must name every sealed object the state it describes
//! still needs: for each attachment held by a live file, a retained file
//! tombstone or a conflict side, its manifest and **every** chunk. The signed
//! descriptor names only the manifest; the chunk addresses are inside the
//! encrypted manifest. This module keeps, per manifest address, the complete
//! object inventory read from that manifest after it authenticated, in
//! device-local meta:
//!
//! - the uploader records it at capture, from its own re-opened manifest;
//! - a fetch records it when the manifest authenticates;
//! - otherwise (a store that does not materialize, or a replica that installed
//!   a snapshot) the snapshot build asks for it here: one `get_object` of the
//!   manifest at a time, opened under the descriptor's key and checked against
//!   its signed whole-file metadata.
//!
//! A manifest address fixes its bytes and so its chunk list, which makes the
//! record content-addressed: it never goes stale, whoever wrote it.
//!
//! Until every inventory is known the build does not run
//! ([`SnapshotBlocked::InventoryPending`](super::SnapshotBlocked)); a manifest
//! the log no longer has, or that does not authenticate, blocks it
//! ([`SnapshotBlocked::InventoryUnavailable`](super::SnapshotBlocked)). Either
//! way the previous snapshot and every object it retains stay: the inventory
//! is never truncated or guessed.

use std::collections::{BTreeSet, VecDeque};

use mdbn_wire::attachment::AttachmentContentV1;
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::common::{B32, Hash};
use mdbn_wire::schema::Wire;

use super::Replica;
use super::attachment_fetch::descriptor;
use crate::attachments::MAX_SEALED_MANIFEST;
use crate::crypto::chunked_blob::{AttachmentLimits, ChunkRefV1};
use crate::log::{CallId, LogError, LogErrorCode, LogReply, LogRequest, LogResponse};
use crate::seal::OpenError;
use crate::store::{MetaPut, Store, StoreError, Tx};

const PREFIX: &str = "replica.attachment_inventory.";

fn key(manifest: &Hash) -> String {
    let mut k = String::with_capacity(PREFIX.len() + 64);
    k.push_str(PREFIX);
    for b in manifest.0 {
        k.push_str(&format!("{b:02x}"));
    }
    k
}

/// The meta row recording `manifest`'s complete object inventory: the manifest
/// and every chunk of an authenticated manifest, sorted and distinct.
pub(crate) fn inventory_meta(manifest: Hash, chunks: &[ChunkRefV1]) -> MetaPut {
    let set: BTreeSet<Hash> = chunks
        .iter()
        .map(|c| c.cipher_hash)
        .chain(std::iter::once(manifest))
        .collect();
    let v = Cbor::Array(set.iter().map(Wire::to_cbor).collect());
    (key(&manifest), cbor::encode(&v).ok())
}

/// The meta row for an object set already reconciled against its manifest
/// (the uploader's refs: the manifest and every chunk).
pub(crate) fn inventory_meta_of_refs(manifest: Hash, refs: &[Hash]) -> MetaPut {
    let set: BTreeSet<Hash> = refs.iter().copied().chain([manifest]).collect();
    let v = Cbor::Array(set.iter().map(Wire::to_cbor).collect());
    (key(&manifest), cbor::encode(&v).ok())
}

/// Inventory reads in flight, one manifest at a time.
#[derive(Debug, Default)]
pub(crate) struct Inventories {
    queue: VecDeque<AttachmentContentV1>,
    current: Option<(CallId, AttachmentContentV1)>,
    /// Manifests that are gone or do not authenticate: terminal for this run.
    unavailable: BTreeSet<Hash>,
    /// Manifest reads (statistics and tests).
    pub(crate) reads: u64,
}

impl<S: Store> Replica<S> {
    /// The complete object inventory recorded for `manifest`, if known.
    pub(crate) fn attachment_inventory(
        &self,
        manifest: &Hash,
    ) -> Result<Option<Vec<B32>>, StoreError> {
        let Some(bytes) = self.store.meta(&key(manifest))? else {
            return Ok(None);
        };
        let v = cbor::decode(&bytes)
            .ok()
            .and_then(|c| Vec::<B32>::from_cbor(&c).ok())
            .filter(|v| v.contains(manifest))
            .ok_or_else(|| StoreError::Corrupt("attachment inventory row".into()))?;
        Ok(Some(v))
    }

    pub(crate) fn inventory_unavailable(&self, manifest: &Hash) -> bool {
        self.attachment_inventories.unavailable.contains(manifest)
    }

    /// Manifest reads issued for snapshot inventories.
    pub fn attachment_inventory_reads(&self) -> u64 {
        self.attachment_inventories.reads
    }

    /// Why the last due snapshot build did not run, if it did not.
    pub fn snapshot_blocked(&self) -> Option<super::SnapshotBlocked> {
        self.snapshot_blocked
    }

    /// Queue inventory reads for these attachments (skipping those already
    /// queued, in flight or unavailable) and start the next one.
    pub(crate) fn resolve_inventories(&mut self, missing: Vec<AttachmentContentV1>) {
        let inv = &mut self.attachment_inventories;
        for a in missing {
            let m = a.reference.manifest_cipher_hash;
            let known = inv.unavailable.contains(&m)
                || inv
                    .current
                    .as_ref()
                    .is_some_and(|(_, c)| c.reference.manifest_cipher_hash == m)
                || inv
                    .queue
                    .iter()
                    .any(|c| c.reference.manifest_cipher_hash == m);
            if !known {
                inv.queue.push_back(a);
            }
        }
        self.inventory_step();
    }

    fn inventory_step(&mut self) {
        if self.attachment_inventories.current.is_some() {
            return;
        }
        let Some(a) = self.attachment_inventories.queue.pop_front() else {
            return;
        };
        let id = self.queue(LogRequest::GetObject {
            collection: self.cfg.collection,
            address: a.reference.manifest_cipher_hash,
            range: None,
        });
        self.inflight.insert(
            id,
            super::append::Inflight::AttachmentInventory(a.reference.manifest_cipher_hash),
        );
        self.attachment_inventories.reads += 1;
        self.attachment_inventories.current = Some((id, a));
    }

    pub(crate) fn on_attachment_inventory_reply(
        &mut self,
        manifest: Hash,
        id: CallId,
        reply: LogReply,
    ) {
        let inv = &mut self.attachment_inventories;
        let a = match inv.current.take() {
            Some((c, a)) if c == id && a.reference.manifest_cipher_hash == manifest => a,
            other => {
                inv.current = other;
                return; // stale
            }
        };
        match reply {
            Ok(LogResponse::GetObject { bytes, .. }) => {
                if bytes.len() as u64 > MAX_SEALED_MANIFEST
                    || mdbn_wire::hash::sha256(&bytes) != manifest
                {
                    self.attachment_inventories.unavailable.insert(manifest);
                } else {
                    let (d, e) = descriptor(&a);
                    match self.sealer.open_attachment_manifest(
                        &d,
                        e,
                        &bytes,
                        AttachmentLimits::default(),
                    ) {
                        Ok(v) => {
                            let meta = inventory_meta(manifest, &v.manifest().chunks);
                            if let Err(e) = self.store.commit(Tx {
                                meta: vec![meta],
                                ..Tx::default()
                            }) {
                                self.incident(
                                    mdbn_wire::client::IncidentKind::Integrity,
                                    Some(mdbn_wire::common::Value::Text(format!(
                                        "attachment inventory: {e}"
                                    ))),
                                );
                            }
                        }
                        // A key for that epoch may still arrive: asked again at
                        // the next build.
                        Err(OpenError::NoKey) => {}
                        Err(OpenError::Aead) => {
                            self.attachment_inventories.unavailable.insert(manifest);
                        }
                    }
                }
            }
            Err(LogError::Service {
                code: LogErrorCode::NotFound | LogErrorCode::Gone,
                ..
            }) => {
                self.attachment_inventories.unavailable.insert(manifest);
            }
            // Transient or unexpected: asked again at the next build.
            Ok(_) | Err(_) => {}
        }
        self.inventory_step();
        let inv = &self.attachment_inventories;
        if inv.current.is_none()
            && inv.queue.is_empty()
            && matches!(
                self.snapshot_blocked,
                Some(super::SnapshotBlocked::InventoryPending { .. })
            )
        {
            // Every read answered: the due build runs again now.
            let _ = self.build_snapshot_now();
        }
    }
}
