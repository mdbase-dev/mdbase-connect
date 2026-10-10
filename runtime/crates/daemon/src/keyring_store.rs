//! A synced collection's epoch keyring in the OS credential store, never in its
//! index: epoch keys are keychain-only.
//!
//! The replica persists its keyring as the store meta key `replica.keyring` in the
//! same commit as its head and policy. [`KeychainKeyring`] wraps the file store and
//! keeps that commit atomic with write-once credential entries:
//!
//! 1. A new keyring is written to a **fresh** credential entry
//!    `keyring:<collection>:g<generation>`, where the generation is 128 random bits:
//!    never derived from a counter, so no orphan or removed entry is ever reused.
//!    The write is refused when that entry already exists, and read back before use.
//! 2. The index commit carries `daemon.keyring.generation` with the head and policy,
//!    and appends the previous generation to `daemon.keyring.retained`, so the
//!    reference and the state it belongs to commit together or not at all.
//! 3. Nothing is deleted. Earlier generations stay in the credential store (recorded
//!    in `retained`), and an entry from a failed or uncertain commit stays
//!    unreferenced; collecting either needs a reference/retention proof first.
//!
//! A failed credential write commits nothing. A failed, aborted or uncertain index
//! commit leaves at most an unreferenced fresh entry, so reopen reads the generation
//! the index committed: the old pair, or (if an uncertain commit did land) the new
//! one. Removing the keyring commits the reference's absence. A referenced entry that
//! is missing fails closed. An index already holding a plaintext keyring row is
//! refused at open. Local-only collections pass through.

use std::ops::Range;
use std::sync::Arc;

use mdbn_replica::store::*;
use mdbn_wire::client::Hold;
use mdbn_wire::common::{Hash, Uuid};
use mdbn_wire::intent::FileInclusion;
use zeroize::Zeroize;

use crate::secrets::SecretStore;

/// The index meta key holding the committed keyring generation (16 bytes).
pub const GENERATION_META: &str = "daemon.keyring.generation";
/// The index meta key listing earlier generations still in the credential store
/// (concatenated 16-byte generations, oldest first).
pub const RETAINED_META: &str = "daemon.keyring.retained";

/// A keyring generation: 128 random bits, never reused.
pub type Generation = [u8; 16];

/// The credential-store name of generation `g` of a collection's keyring.
pub fn keyring_name(collection: &Uuid, g: &Generation) -> String {
    let hex: String = g.iter().map(|b| format!("{b:02x}")).collect();
    format!("keyring:{}:g{hex}", collection.to_uuid_string())
}

fn internal(key: &str) -> bool {
    key == GENERATION_META || key == RETAINED_META
}

/// A store whose `replica.keyring` lives in the credential store.
pub struct KeychainKeyring<S> {
    inner: S,
    /// `None`: a local-only collection (no epoch keys); everything passes through.
    secrets: Option<Arc<dyn SecretStore>>,
    collection: Uuid,
}

impl<S: Store> KeychainKeyring<S> {
    /// Wrap `inner` for `collection`. With a credential store, refuses an index
    /// that already holds a plaintext keyring row; without one (local-only), passes
    /// everything through.
    pub fn new(
        inner: S,
        secrets: Option<Arc<dyn SecretStore>>,
        collection: &Uuid,
    ) -> StoreResult<Self> {
        if secrets.is_some() && inner.meta(meta_keys::KEYRING)?.is_some() {
            return Err(StoreError::Corrupt(
                "a plaintext keyring is stored in the index".into(),
            ));
        }
        Ok(KeychainKeyring {
            inner,
            secrets,
            collection: *collection,
        })
    }

    /// The committed keyring generation, if any.
    fn generation(&self) -> StoreResult<Option<Generation>> {
        match self.inner.meta(GENERATION_META)? {
            None => Ok(None),
            Some(b) => {
                Ok(Some(b.try_into().map_err(|_| {
                    StoreError::Corrupt("keyring generation".into())
                })?))
            }
        }
    }

    /// Earlier generations kept in the credential store, oldest first.
    pub fn retained(&self) -> StoreResult<Vec<Generation>> {
        let b = self.inner.meta(RETAINED_META)?.unwrap_or_default();
        if b.len() % 16 != 0 {
            return Err(StoreError::Corrupt("retained keyring generations".into()));
        }
        Ok(b.chunks_exact(16)
            .map(|c| c.try_into().unwrap_or([0; 16]))
            .collect())
    }

    /// Write `bytes` to a fresh generation: refused if the entry exists, and read
    /// back before the index may reference it.
    fn write_fresh(&self, secrets: &dyn SecretStore, bytes: &[u8]) -> StoreResult<Generation> {
        let mut g: Generation = [0; 16];
        getrandom::fill(&mut g).map_err(|e| StoreError::Io(format!("entropy: {e}")))?;
        let name = keyring_name(&self.collection, &g);
        if secrets.get(&name).map_err(io)?.is_some() {
            return Err(StoreError::Corrupt(
                "credential store: a fresh keyring generation already exists".into(),
            ));
        }
        secrets.set(&name, bytes).map_err(io)?;
        match secrets.get(&name).map_err(io)? {
            Some(back) if back.as_slice() == bytes => Ok(g),
            _ => Err(StoreError::Io(
                "credential store: the keyring did not read back".into(),
            )),
        }
    }

    /// The wrapped store.
    pub fn inner(&self) -> &S {
        &self.inner
    }

    /// The wrapped store, mutably (rescan requests and the like; never commits).
    pub fn inner_mut(&mut self) -> &mut S {
        &mut self.inner
    }
}

fn io(e: crate::secrets::SecretError) -> StoreError {
    StoreError::Io(format!("credential store: {e}"))
}

impl<S: Store> Store for KeychainKeyring<S> {
    fn head(&self) -> StoreResult<Head> {
        self.inner.head()
    }
    fn record(&self, id: &Uuid) -> StoreResult<Option<RecordRow>> {
        self.inner.record(id)
    }
    fn record_at(&self, path_key: &str) -> StoreResult<Option<Uuid>> {
        self.inner.record_at(path_key)
    }
    fn records(&self, page: Page) -> StoreResult<Vec<RecordRow>> {
        self.inner.records(page)
    }
    fn records_in_buckets(&self, range: Range<u32>, page: Page) -> StoreResult<Vec<RecordRow>> {
        self.inner.records_in_buckets(range, page)
    }
    fn record_count(&self) -> StoreResult<u64> {
        self.inner.record_count()
    }
    fn file(&self, id: &Uuid) -> StoreResult<Option<FileRow>> {
        self.inner.file(id)
    }
    fn file_at(&self, path_key: &str) -> StoreResult<Option<Uuid>> {
        self.inner.file_at(path_key)
    }
    fn files(&self, page: Page) -> StoreResult<Vec<FileRow>> {
        self.inner.files(page)
    }
    fn files_in_buckets(&self, range: Range<u32>, page: Page) -> StoreResult<Vec<FileRow>> {
        self.inner.files_in_buckets(range, page)
    }
    fn resource(&self, path: &str) -> StoreResult<Option<String>> {
        self.inner.resource(path)
    }
    fn resources(&self) -> StoreResult<Vec<(String, String)>> {
        self.inner.resources()
    }
    fn resource_paths_page(
        &self,
        page: mdbn_replica::store::ResourcePathPage<'_>,
    ) -> StoreResult<Vec<String>> {
        self.inner.resource_paths_page(page)
    }
    fn resource_bounded(
        &self,
        path: &str,
        copy_limit: usize,
    ) -> StoreResult<Option<mdbn_replica::store::BoundedResource>> {
        self.inner.resource_bounded(path, copy_limit)
    }
    fn settings(&self) -> StoreResult<Option<FileInclusion>> {
        self.inner.settings()
    }
    fn tombstone(&self, id: &Uuid) -> StoreResult<Option<TombstoneRow>> {
        self.inner.tombstone(id)
    }
    fn tombstones_at(&self, path_key: &str) -> StoreResult<Vec<TombstoneRow>> {
        self.inner.tombstones_at(path_key)
    }
    fn tombstones(&self, page: Page) -> StoreResult<Vec<TombstoneRow>> {
        self.inner.tombstones(page)
    }
    fn alias(&self, path_key: &str) -> StoreResult<Option<Uuid>> {
        self.inner.alias(path_key)
    }
    fn aliases(&self) -> StoreResult<Vec<AliasRow>> {
        self.inner.aliases()
    }
    fn conflicts(&self, of: Option<&Uuid>) -> StoreResult<Vec<ConflictRow>> {
        self.inner.conflicts(of)
    }
    fn conflict_count(&self) -> StoreResult<u64> {
        self.inner.conflict_count()
    }
    fn receipt(&self, mutation: &Uuid) -> StoreResult<Option<ReceiptRow>> {
        self.inner.receipt(mutation)
    }
    fn receipts(&self, after: Option<Uuid>, limit: u32) -> StoreResult<Vec<ReceiptRow>> {
        self.inner.receipts(after, limit)
    }
    fn referrers(&self, target_keys: &[String]) -> StoreResult<Vec<Uuid>> {
        self.inner.referrers(target_keys)
    }
    fn unique_holders(&self, field: &str, value_key: &str) -> StoreResult<Vec<Uuid>> {
        self.inner.unique_holders(field, value_key)
    }
    fn candidates(&self, q: &Candidate, page: Page) -> StoreResult<Vec<RecordRow>> {
        self.inner.candidates(q, page)
    }
    fn pending(&self, after_order: Option<u64>, limit: u32) -> StoreResult<Vec<PendingRow>> {
        self.inner.pending(after_order, limit)
    }
    fn pending_get(&self, mutation: &Uuid) -> StoreResult<Option<PendingRow>> {
        self.inner.pending_get(mutation)
    }
    fn pending_count(&self) -> StoreResult<u64> {
        self.inner.pending_count()
    }
    fn local_receipt(&self, mutation: &Uuid) -> StoreResult<Option<LocalReceipt>> {
        self.inner.local_receipt(mutation)
    }
    fn holds(&self) -> StoreResult<Vec<Hold>> {
        self.inner.holds()
    }
    fn hold(&self, id: &Uuid) -> StoreResult<Option<Hold>> {
        self.inner.hold(id)
    }
    fn transfer(&self, id: &Uuid) -> StoreResult<Option<TransferRow>> {
        self.inner.transfer(id)
    }
    fn transfer_chunk(&self, id: &Uuid, index: u64) -> StoreResult<Option<Vec<u8>>> {
        self.inner.transfer_chunk(id, index)
    }
    fn blob_size(&self, digest: &Hash) -> StoreResult<Option<u64>> {
        self.inner.blob_size(digest)
    }
    fn blob_read(&self, digest: &Hash, offset: u64, len: u64) -> StoreResult<Vec<u8>> {
        self.inner.blob_read(digest, offset, len)
    }
    fn tail(&self, after: Seq, limit: u32) -> StoreResult<Vec<TailRow>> {
        self.inner.tail(after, limit)
    }
    fn tail_stats(&self) -> StoreResult<TailStats> {
        self.inner.tail_stats()
    }
    fn own_retained(&self, after: Seq, limit: u32) -> StoreResult<Vec<(Seq, PendingRow)>> {
        self.inner.own_retained(after, limit)
    }
    fn has_files(&self) -> bool {
        self.inner.has_files()
    }
    fn stages(&self) -> bool {
        self.inner.stages()
    }
    fn disk_revision(&self, path: &str) -> StoreResult<Option<Hash>> {
        self.inner.disk_revision(path)
    }
    fn disk_paths(&self) -> StoreResult<Vec<(String, Hash)>> {
        self.inner.disk_paths()
    }
    fn observe(&mut self, paths: Option<&[String]>) -> StoreResult<Vec<Observation>> {
        self.inner.observe(paths)
    }
    fn take_publish_results(&mut self) -> Vec<PublishResult> {
        self.inner.take_publish_results()
    }
    fn meta(&self, key: &str) -> StoreResult<Option<Vec<u8>>> {
        let Some(secrets) = &self.secrets else {
            return self.inner.meta(key);
        };
        if internal(key) {
            return Ok(None);
        }
        if key != meta_keys::KEYRING {
            return self.inner.meta(key);
        }
        let Some(g) = self.generation()? else {
            return Ok(None);
        };
        match secrets
            .get(&keyring_name(&self.collection, &g))
            .map_err(io)?
        {
            Some(k) => Ok(Some(k.to_vec())),
            // The index committed a generation the credential store no longer has.
            None => Err(StoreError::Io(
                "credential store: the committed keyring generation is missing".into(),
            )),
        }
    }
    fn commit(&mut self, mut tx: Tx) -> StoreResult<CommitReport> {
        let Some(secrets) = self.secrets.clone() else {
            return self.inner.commit(tx);
        };
        let mut keyring = None;
        tx.meta.retain_mut(|(k, v)| {
            if internal(k) {
                return false; // never from a caller
            }
            if k == meta_keys::KEYRING {
                keyring = Some(v.take());
                false
            } else {
                true
            }
        });
        let Some(keyring) = keyring else {
            return self.inner.commit(tx);
        };
        let committed = self.generation()?;
        let next = match keyring {
            Some(mut bytes) => {
                let r = self.write_fresh(secrets.as_ref(), &bytes);
                bytes.zeroize();
                Some(r?)
            }
            None => None,
        };
        tx.meta
            .push((GENERATION_META.into(), next.map(|g| g.to_vec())));
        if let Some(old) = committed
            && Some(old) != next
        {
            let mut retained = self.inner.meta(RETAINED_META)?.unwrap_or_default();
            retained.extend_from_slice(&old);
            tx.meta.push((RETAINED_META.into(), Some(retained)));
        }
        self.inner.commit(tx)
    }
    // Query index and attachment-v1 disk operations pass straight through; the
    // wrapper only intercepts the keyring.
    fn query_index_supported(&self) -> bool {
        self.inner.query_index_supported()
    }
    fn query_index_state(&self) -> StoreResult<Option<mdbn_replica::store_query::QueryIndexState>> {
        self.inner.query_index_state()
    }
    fn query_index_page(
        &self,
        request: &mdbn_replica::store_query::QueryIndexRequest,
    ) -> StoreResult<Option<mdbn_replica::store_query::QueryIndexPage>> {
        self.inner.query_index_page(request)
    }
    fn hydrate_query_at(
        &self,
        ids: &[mdbn_wire::common::Uuid],
        head: Head,
        budget: &mut mdbn_replica::store_query::QueryBudget,
    ) -> StoreResult<Vec<RecordRow>> {
        self.inner.hydrate_query_at(ids, head, budget)
    }
    fn query_record_sizes_at(
        &self,
        page: Page,
        head: Head,
    ) -> StoreResult<Vec<mdbn_replica::store_query::QueryRecordSize>> {
        self.inner.query_record_sizes_at(page, head)
    }
    fn attachment_source(
        &mut self,
        path: &str,
        size: u64,
    ) -> StoreResult<Option<Box<dyn mdbn_replica::replica::AttachmentSource>>> {
        self.inner.attachment_source(path, size)
    }
    fn materializes_attachments(&self) -> bool {
        self.inner.materializes_attachments()
    }
    fn attachment_staged(&mut self, key: &StageKey) -> StoreResult<u64> {
        self.inner.attachment_staged(key)
    }
    fn attachment_stage(&mut self, key: &StageKey, offset: u64, plain: &[u8]) -> StoreResult<()> {
        self.inner.attachment_stage(key, offset, plain)
    }
    fn attachment_stage_read(
        &mut self,
        key: &StageKey,
        offset: u64,
        len: u32,
    ) -> StoreResult<Vec<u8>> {
        self.inner.attachment_stage_read(key, offset, len)
    }
    fn attachment_unstage(&mut self, key: &StageKey) -> StoreResult<()> {
        self.inner.attachment_unstage(key)
    }
    fn attachment_publish(
        &mut self,
        key: &StageKey,
        rev: mdbn_wire::common::Hash,
        path: &str,
        expect: Expect,
    ) -> DiskResult {
        self.inner.attachment_publish(key, rev, path, expect)
    }
    fn attachment_remove(
        &mut self,
        id: mdbn_wire::common::Uuid,
        path: &str,
        expect: mdbn_wire::common::Hash,
    ) -> DiskResult {
        self.inner.attachment_remove(id, path, expect)
    }
    fn attachment_move(
        &mut self,
        id: mdbn_wire::common::Uuid,
        from: &str,
        to: &str,
        expect: mdbn_wire::common::Hash,
    ) -> DiskResult {
        self.inner.attachment_move(id, from, to, expect)
    }
}

#[cfg(test)]
#[path = "keyring_store_tests.rs"]
mod tests;
