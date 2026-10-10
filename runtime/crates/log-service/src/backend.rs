//! The storage/actor seam between the platform-neutral service logic and a D2
//! candidate.
//!
//! A backend provides one thing beyond storage: **per-collection serialization**.
//! [`Backend::begin`] with [`Mode::Write`] returns a transaction that excludes every
//! other writer of *that collection only* until it commits or drops:
//! - Postgres: `SELECT … FROM collections WHERE id = $1 FOR UPDATE` (the row lock is
//!   the actor);
//! - Durable Objects: the object itself is the actor; storage calls are synchronous,
//!   so nothing interleaves within a call;
//! - memory: an async mutex per collection.
//!
//! No operation spans two collections, so no backend needs a global lock.
//!
//! Writes are buffered in the transaction and applied atomically by
//! [`Txn::commit`]; a dropped transaction applies nothing.

use std::future::Future;

use mdbn_wire::common::{B16, B32, Uuid};

use crate::error::Result;
use crate::model::{
    AclEntry, CollectionMeta, CollectionState, CommitNotice, ObjectMeta, RetentionTier,
    SnapshotRow, StoredItem,
};

/// Transaction mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Consistent reads, no exclusion.
    Read,
    /// Exclusive per collection.
    Write,
}

/// One buffered write.
#[derive(Debug, Clone, PartialEq)]
pub enum Write {
    /// Create the collection row and its ACL.
    CreateCollection(CollectionState),
    /// Replace the collection row.
    PutMeta(CollectionMeta),
    /// Insert or replace one ACL entry.
    UpsertAcl(AclEntry),
    /// Insert an item, its token (if any, expiring at `appended_at` + 180 days) and
    /// its object refs.
    InsertItem(StoredItem),
    /// Insert or replace object metadata.
    PutObject(ObjectMeta),
    /// Delete object metadata (GC; the bytes are deleted by the caller after commit).
    DeleteObject(B32),
    /// Insert a snapshot pointer and its refs.
    InsertSnapshot(SnapshotRow),
    /// Mark a snapshot endorsed.
    EndorseSnapshot(u64),
    /// Delete a snapshot pointer and its refs.
    DeleteSnapshot(u64),
    /// Compaction: delete `entry` items (kind 1) with `seq ≤ c` and their refs.
    /// Tokens stay until they expire. The service archives the entries first
    /// ([`Archive::put_segment`]).
    DeleteEntriesThrough(u64),
    /// Tell subscribers (Postgres: `pg_notify` in the same transaction).
    Notify(CommitNotice),
}

/// A per-collection transaction.
#[allow(async_fn_in_trait)]
pub trait Txn {
    /// The collection row and ACL, or `None` if unknown.
    async fn load(&mut self) -> Result<Option<CollectionState>>;
    /// Items with `seq > after`, in order: at most `limit`, and stopping before the
    /// running byte total exceeds `max_bytes` (the first item is always returned).
    async fn items(
        &mut self,
        after: u64,
        limit: u64,
        max_bytes: u64,
        control_only: bool,
    ) -> Result<Vec<StoredItem>>;
    /// For each token, the position of the item holding it, ignoring tokens expired at `now`.
    async fn tokens(&mut self, tokens: &[B16], now: i64) -> Result<Vec<Option<u64>>>;
    /// Metadata of each address (committed or pending).
    async fn objects(&mut self, addresses: &[B32]) -> Result<Vec<Option<ObjectMeta>>>;
    /// Retained snapshots, newest first.
    async fn snapshots(&mut self) -> Result<Vec<SnapshotRow>>;
    /// The largest position appended at or before `t` (0 if none).
    async fn last_seq_at_or_before(&mut self, t: i64) -> Result<u64>;
    /// Total bytes of `entry` items with `seq ≤ c` still stored.
    async fn entry_bytes_through(&mut self, c: u64) -> Result<u64>;
    /// Objects created before `created_before` that no retained item or snapshot
    /// references, up to `limit`.
    async fn gc_candidates(&mut self, created_before: i64, limit: u64) -> Result<Vec<ObjectMeta>>;
    /// The chunk and blob-part refs of the retained snapshot at `seq`.
    async fn snapshot_refs(&mut self, seq: u64) -> Result<Vec<B32>>;
    /// Committed objects with address > `after`, in address order, up to `limit`.
    async fn list_objects(&mut self, after: Option<B32>, limit: u64) -> Result<Vec<ObjectMeta>>;
    /// Buffer a write.
    fn write(&mut self, w: Write);
    /// Apply the buffered writes atomically; durable when this returns `Ok`.
    async fn commit(self) -> Result<()>;
}

/// A store of collections.
pub trait Backend {
    /// Its transaction type.
    type Txn<'a>: Txn
    where
        Self: 'a;
    /// Begin a transaction on one collection.
    fn begin(&self, collection: &Uuid, mode: Mode) -> impl Future<Output = Result<Self::Txn<'_>>>;
    /// Begin with request-wide accounting. Ports decoding serialized projection
    /// state MUST override this; already typed stores may forward unchanged.
    fn begin_with_budget(
        &self,
        collection: &Uuid,
        mode: Mode,
        _budget: &crate::decode::Budget,
    ) -> impl Future<Output = Result<Self::Txn<'_>>> {
        self.begin(collection, mode)
    }
    /// Independently inspect the permanent nil-registry deletion floor for the
    /// actual collection. Only a successful authoritative lookup may return None;
    /// unsupported/unreachable/malformed authority MUST fail unavailable. Neither
    /// absence nor this read grants a positive cross-actor effect-time lease.
    fn collection_deletion_floor(
        &self,
        _collection: &Uuid,
    ) -> impl Future<Output = Result<Option<crate::deletion::CollectionDeletionRecord>>> {
        async { Err(crate::deletion::CollectionDeletionRecord::unavailable()) }
    }
    /// Lookup with enclosing request accounting. Ports decoding serialized
    /// floor responses MUST override this and charge the supplied shared budget.
    /// Already typed reference getters may forward without another decode.
    fn collection_deletion_floor_with_budget(
        &self,
        collection: &Uuid,
        _budget: &crate::decode::Budget,
    ) -> impl Future<Output = Result<Option<crate::deletion::CollectionDeletionRecord>>> {
        self.collection_deletion_floor(collection)
    }
    /// Whether a device's credentials were revoked service-wide (§12). Global
    /// state, read outside any collection's actor; not on the append path.
    fn credentials_revoked(&self, device: &Uuid) -> impl Future<Output = Result<bool>>;
    /// Revoke a device's credentials service-wide (permanent).
    fn revoke_credentials(&self, device: &Uuid, now: i64) -> impl Future<Output = Result<()>>;
}

/// Request-scoped backend view: every nested begin uses the same counters.
pub(crate) struct BudgetBackend<B> {
    pub(crate) inner: std::sync::Arc<B>,
    pub(crate) budget: crate::decode::Budget,
}
impl<B: Backend> Backend for BudgetBackend<B> {
    type Txn<'a>
        = B::Txn<'a>
    where
        Self: 'a;
    fn begin(&self, c: &Uuid, mode: Mode) -> impl Future<Output = Result<Self::Txn<'_>>> {
        self.inner.begin_with_budget(c, mode, &self.budget)
    }
    fn collection_deletion_floor(
        &self,
        c: &Uuid,
    ) -> impl Future<Output = Result<Option<crate::deletion::CollectionDeletionRecord>>> {
        self.inner
            .collection_deletion_floor_with_budget(c, &self.budget)
    }
    fn collection_deletion_floor_with_budget(
        &self,
        c: &Uuid,
        budget: &crate::decode::Budget,
    ) -> impl Future<Output = Result<Option<crate::deletion::CollectionDeletionRecord>>> {
        self.inner.collection_deletion_floor_with_budget(c, budget)
    }
    fn credentials_revoked(&self, d: &Uuid) -> impl Future<Output = Result<bool>> {
        self.inner.credentials_revoked(d)
    }
    fn revoke_credentials(&self, d: &Uuid, now: i64) -> impl Future<Output = Result<()>> {
        self.inner.revoke_credentials(d, now)
    }
}

/// The archive: where compaction and GC move what they remove, kept for the
/// collection's [`RetentionTier`] instead of deleted. Keys are
/// [`crate::model::archive_segment_key`] and [`crate::model::archive_object_key`];
/// the store's expiry rule (R2 lifecycle, a cron) is per `archive/<tier>/` prefix.
/// Nothing reads the archive on the service's request paths, and archived bytes
/// are not counted in `used_bytes`.
#[allow(async_fn_in_trait)]
pub trait Archive {
    /// Store one segment of compacted entries (positions `from..=to`), replacing
    /// any (a retried compaction rewrites the same segment).
    async fn put_segment(
        &self,
        collection: &Uuid,
        tier: RetentionTier,
        from: u64,
        to: u64,
        bytes: Vec<u8>,
    ) -> Result<()>;
    /// Copy the object at [`crate::model::object_key`] to its archive key:
    /// server-side where the store can, else read then put. A missing source is
    /// not an error: there is nothing to keep.
    async fn archive_object(
        &self,
        collection: &Uuid,
        tier: RetentionTier,
        address: &B32,
    ) -> Result<()>;
}

/// Object bytes (R2, S3, local disk, memory). Keys are [`crate::model::object_key`].
/// Every store also carries the [`Archive`].
#[allow(async_fn_in_trait)]
pub trait ObjectStore: Archive {
    /// Store bytes, replacing any (staging uploads only).
    async fn put(&self, key: &str, bytes: Vec<u8>) -> Result<()>;
    /// Store bytes only if the key is absent (`If-None-Match: *`). Returns whether
    /// it wrote. Final object keys are written only through this method.
    async fn put_new(&self, key: &str, bytes: Vec<u8>) -> Result<bool>;
    /// Same write with enclosing decode accounting. Ports that interpret the
    /// envelope MUST override this and use the supplied budget. Byte-only stores
    /// need no CBOR decode and may use the default forwarding implementation.
    async fn put_new_with_budget(
        &self,
        key: &str,
        bytes: Vec<u8>,
        _budget: &crate::decode::Budget,
    ) -> Result<bool> {
        self.put_new(key, bytes).await
    }
    /// Bytes, or a range `(offset, len)` of them.
    async fn get(&self, key: &str, range: Option<(u64, u64)>) -> Result<Option<Vec<u8>>>;
    /// Delete.
    async fn delete(&self, key: &str) -> Result<()>;

    /// Verification recorded with an object when it was written by a host that
    /// verifies uploads as they arrive (the Worker in front of R2 does; it holds the
    /// body anyway). `None`: not recorded, so the caller fetches and verifies the
    /// bytes itself. Only the verifying upload path and [`ObjectStore::copy_new`]
    /// write this metadata; clients cannot set it.
    async fn verified_meta(&self, _key: &str) -> Result<Option<Verified>> {
        Ok(None)
    }

    /// Copy `from` to `to` write-once, carrying its verification metadata. Returns
    /// whether it wrote (false: `to` already existed). Stores that can, stream the
    /// copy without buffering it in the caller.
    async fn copy_new(&self, from: &str, to: &str) -> Result<bool> {
        match self.get(from, None).await? {
            Some(b) => self.put_new(to, b).await,
            None => Err(crate::error::ServiceError::backend(
                "staged object vanished",
            )),
        }
    }
}

/// What an upload-time verification established about an object's bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Verified {
    /// Envelope kind (16, 17 or 18).
    pub kind: u64,
    /// Exact size.
    pub size: u64,
    /// SHA-256 of the bytes.
    pub checksum: B32,
}
