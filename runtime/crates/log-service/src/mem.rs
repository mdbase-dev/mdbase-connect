//! In-memory backend and object store: unit tests, the simulator, and the
//! reference implementation the conformance suite is first run against.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use async_lock::{Mutex as AsyncMutex, MutexGuardArc};
use mdbn_wire::common::{B16, B32, Uuid};
use mdbn_wire::hash::{CHAIN_ZERO, chain_hash};

use crate::backend::{Archive, Backend, Mode, ObjectStore, Txn, Write};
use crate::error::{Result, ServiceError};
use crate::limits::TOKEN_RETENTION_MS;
use crate::model::{
    CollectionState, ObjectMeta, RetentionTier, SnapshotRow, StoredItem, archive_object_key,
    archive_segment_key, object_key,
};

/// One collection's data.
#[derive(Debug, Default)]
pub struct MemCollection {
    state: Option<CollectionState>,
    items: BTreeMap<u64, StoredItem>,
    tokens: BTreeMap<B16, (u64, i64)>,
    objects: BTreeMap<B32, ObjectMeta>,
    snapshots: BTreeMap<u64, SnapshotRow>,
}

/// In-memory backend: an async mutex per collection, no global lock.
#[derive(Debug, Default)]
pub struct MemBackend {
    cols: Mutex<BTreeMap<Uuid, Arc<AsyncMutex<MemCollection>>>>,
    revoked: Mutex<BTreeSet<Uuid>>,
    deletions: Mutex<BTreeMap<Uuid, crate::deletion::CollectionDeletionRecord>>,
}

impl MemBackend {
    /// Reference/test registry: preserve one first tuple for this backend's
    /// lifetime. This in-memory hook is NOT production durable authority.
    pub fn record_collection_deletion(
        &self,
        record: crate::deletion::CollectionDeletionRecord,
    ) -> Result<crate::deletion::CollectionDeletionRecord> {
        let record = record.validate()?;
        let mut floors = self.deletions.lock().unwrap();
        let actual = *floors.entry(record.collection).or_insert(record);
        if actual != record {
            return Err(actual.conflict());
        }
        Ok(actual)
    }
    fn col(&self, c: &Uuid) -> Arc<AsyncMutex<MemCollection>> {
        self.cols.lock().unwrap().entry(*c).or_default().clone()
    }

    /// Test hook: lose the last `n` items, as a failover to a lagging replica would.
    pub async fn lose_tail(&self, c: &Uuid, n: u64, roots: &[B32]) {
        let col = self.col(c);
        let mut g = col.lock_arc().await;
        for _ in 0..n {
            if let Some((&seq, _)) = g.items.iter().next_back() {
                g.items.remove(&seq);
            }
        }
        let remaining: BTreeSet<u64> = g.items.keys().copied().collect();
        g.tokens.retain(|_, (s, _)| remaining.contains(s));
        let (head, chain) = g
            .items
            .iter()
            .next_back()
            .map_or((0, CHAIN_ZERO), |(s, i)| (*s, chain_hash(&i.bytes)));
        let control: Vec<(u64, Vec<u8>)> = g
            .items
            .values()
            .filter(|i| i.kind != 1)
            .map(|i| (i.seq, i.bytes.clone()))
            .collect();
        if let Some(st) = g.state.as_mut() {
            if let Ok(mut rebuilt) = crate::service::rebuild_state(&st.meta, &control, roots) {
                rebuilt.meta.head = head;
                rebuilt.meta.head_chain = chain;
                *st = rebuilt;
            } else {
                st.meta.head = head;
                st.meta.head_chain = chain;
            }
        }
    }
}

impl MemBackend {
    /// Test hook: compaction through `upto` with the grace and age bypassed, as
    /// `Service::compact` would do once C is known, through the same transaction
    /// API: delete `entry` items (kind 1) at or below `upto`, charge exactly their
    /// bytes off `used_bytes`, and raise `retained_from` to `upto + 1`. Control
    /// items, snapshots, ACL, tokens, objects, head and chain are untouched.
    /// `retained_from` is monotone, so a repeat or a lower `upto` changes nothing.
    /// Refused without mutation (`Ok(None)`) when the collection is unknown,
    /// `upto` is beyond the head, or `upto + 1` overflows. Returns the new
    /// `retained_from`.
    pub async fn compact_through(&self, c: &Uuid, upto: u64) -> Result<Option<u64>> {
        let Some(next) = upto.checked_add(1) else {
            return Ok(None);
        };
        let mut tx = self.begin(c, Mode::Write).await?;
        let Some(mut state) = tx.load().await? else {
            return Ok(None);
        };
        if upto > state.meta.head {
            return Ok(None);
        }
        if next <= state.meta.retained_from {
            return Ok(Some(state.meta.retained_from));
        }
        let bytes = tx.entry_bytes_through(upto).await?;
        tx.write(Write::DeleteEntriesThrough(upto));
        state.meta.retained_from = next;
        state.meta.used_bytes = state.meta.used_bytes.saturating_sub(bytes);
        tx.write(Write::PutMeta(state.meta.clone()));
        tx.commit().await?;
        Ok(Some(next))
    }
}

/// A transaction holding the collection's mutex.
pub struct MemTxn {
    g: MutexGuardArc<MemCollection>,
    writes: Vec<Write>,
}

impl Backend for MemBackend {
    type Txn<'a> = MemTxn;
    async fn begin(&self, c: &Uuid, _mode: Mode) -> Result<MemTxn> {
        Ok(MemTxn {
            g: self.col(c).lock_arc().await,
            writes: Vec::new(),
        })
    }
    async fn collection_deletion_floor(
        &self,
        collection: &Uuid,
    ) -> Result<Option<crate::deletion::CollectionDeletionRecord>> {
        Ok(self.deletions.lock().unwrap().get(collection).copied())
    }
    async fn credentials_revoked(&self, device: &Uuid) -> Result<bool> {
        Ok(self.revoked.lock().unwrap().contains(device))
    }
    async fn revoke_credentials(&self, device: &Uuid, _now: i64) -> Result<()> {
        self.revoked.lock().unwrap().insert(*device);
        Ok(())
    }
}

impl Txn for MemTxn {
    async fn load(&mut self) -> Result<Option<CollectionState>> {
        Ok(self.g.state.clone())
    }
    async fn items(
        &mut self,
        after: u64,
        limit: u64,
        max_bytes: u64,
        control_only: bool,
    ) -> Result<Vec<StoredItem>> {
        let mut out = Vec::new();
        let mut total = 0u64;
        for (_, it) in self.g.items.range(after + 1..) {
            if out.len() as u64 >= limit {
                break;
            }
            if control_only && it.kind == 1 {
                continue;
            }
            total += it.bytes.len() as u64;
            if total > max_bytes && !out.is_empty() {
                break;
            }
            out.push(it.clone());
        }
        Ok(out)
    }
    async fn tokens(&mut self, tokens: &[B16], now: i64) -> Result<Vec<Option<u64>>> {
        Ok(tokens
            .iter()
            .map(|t| {
                self.g
                    .tokens
                    .get(t)
                    .filter(|(_, exp)| *exp > now)
                    .map(|(s, _)| *s)
            })
            .collect())
    }
    async fn objects(&mut self, addresses: &[B32]) -> Result<Vec<Option<ObjectMeta>>> {
        Ok(addresses
            .iter()
            .map(|a| self.g.objects.get(a).cloned())
            .collect())
    }
    async fn snapshots(&mut self) -> Result<Vec<SnapshotRow>> {
        Ok(self.g.snapshots.values().rev().cloned().collect())
    }
    async fn last_seq_at_or_before(&mut self, t: i64) -> Result<u64> {
        Ok(self
            .g
            .items
            .values()
            .filter(|i| i.appended_at <= t)
            .map(|i| i.seq)
            .max()
            .unwrap_or(0))
    }
    async fn entry_bytes_through(&mut self, c: u64) -> Result<u64> {
        Ok(self
            .g
            .items
            .range(..=c)
            .filter(|(_, i)| i.kind == 1)
            .map(|(_, i)| i.bytes.len() as u64)
            .sum())
    }
    async fn gc_candidates(&mut self, before: i64, limit: u64) -> Result<Vec<ObjectMeta>> {
        let live: BTreeSet<B32> = self
            .g
            .items
            .values()
            .flat_map(|i| i.refs.iter().copied())
            .chain(
                self.g
                    .snapshots
                    .values()
                    .flat_map(|s| s.refs.iter().copied()),
            )
            .collect();
        Ok(self
            .g
            .objects
            .values()
            .filter(|o| o.created_at < before && !live.contains(&o.address))
            .take(limit as usize)
            .cloned()
            .collect())
    }
    async fn snapshot_refs(&mut self, seq: u64) -> Result<Vec<B32>> {
        Ok(self
            .g
            .snapshots
            .get(&seq)
            .map(|s| s.refs.clone())
            .unwrap_or_default())
    }
    async fn list_objects(&mut self, after: Option<B32>, limit: u64) -> Result<Vec<ObjectMeta>> {
        Ok(self
            .g
            .objects
            .values()
            .filter(|o| o.committed && after.is_none_or(|a| o.address > a))
            .take(limit as usize)
            .cloned()
            .collect())
    }
    fn write(&mut self, w: Write) {
        self.writes.push(w);
    }
    async fn commit(mut self) -> Result<()> {
        let g = &mut *self.g;
        for w in self.writes.drain(..) {
            match w {
                Write::CreateCollection(s) => g.state = Some(s),
                Write::PutMeta(m) => {
                    if let Some(s) = g.state.as_mut() {
                        s.meta = m;
                    }
                }
                Write::UpsertAcl(e) => {
                    if let Some(s) = g.state.as_mut() {
                        s.acl.insert(e.device, e);
                    }
                }
                Write::InsertItem(i) => {
                    if let Some(t) = i.token {
                        g.tokens
                            .insert(t, (i.seq, i.appended_at + TOKEN_RETENTION_MS));
                    }
                    g.items.insert(i.seq, i);
                }
                Write::PutObject(o) => {
                    g.objects.insert(o.address, o);
                }
                Write::DeleteObject(a) => {
                    g.objects.remove(&a);
                }
                Write::InsertSnapshot(s) => {
                    g.snapshots.insert(s.seq, s);
                }
                Write::EndorseSnapshot(seq) => {
                    if let Some(s) = g.snapshots.get_mut(&seq) {
                        s.endorsed = true;
                    }
                }
                Write::DeleteSnapshot(seq) => {
                    g.snapshots.remove(&seq);
                }
                Write::DeleteEntriesThrough(c) => {
                    g.items.retain(|s, i| *s > c || i.kind != 1);
                }
                Write::Notify(_) => {}
            }
        }
        Ok(())
    }
}

/// In-memory object store.
#[derive(Debug, Default)]
pub struct MemObjects {
    map: Mutex<BTreeMap<String, Vec<u8>>>,
    /// The archive, by key; separate from `map` so reads never see it.
    archive: Mutex<BTreeMap<String, Vec<u8>>>,
    fail_archive: AtomicBool,
}

impl MemObjects {
    /// Test hook: a copy of the archive (key → bytes).
    pub fn archived(&self) -> BTreeMap<String, Vec<u8>> {
        self.archive.lock().unwrap().clone()
    }
    /// Test hook: make every archive write fail (`unavailable`) while `on`.
    pub fn fail_archive(&self, on: bool) {
        self.fail_archive.store(on, Ordering::SeqCst);
    }
    fn archive_check(&self) -> Result<()> {
        if self.fail_archive.load(Ordering::SeqCst) {
            return Err(ServiceError::backend("archive unavailable (test)"));
        }
        Ok(())
    }
}

impl Archive for MemObjects {
    async fn put_segment(
        &self,
        collection: &Uuid,
        tier: RetentionTier,
        from: u64,
        to: u64,
        bytes: Vec<u8>,
    ) -> Result<()> {
        self.archive_check()?;
        self.archive
            .lock()
            .unwrap()
            .insert(archive_segment_key(collection, tier, from, to), bytes);
        Ok(())
    }
    async fn archive_object(
        &self,
        collection: &Uuid,
        tier: RetentionTier,
        address: &B32,
    ) -> Result<()> {
        self.archive_check()?;
        let Some(bytes) = self
            .map
            .lock()
            .unwrap()
            .get(&object_key(collection, address))
            .cloned()
        else {
            return Ok(());
        };
        self.archive
            .lock()
            .unwrap()
            .insert(archive_object_key(collection, tier, address), bytes);
        Ok(())
    }
}

impl ObjectStore for MemObjects {
    async fn put(&self, key: &str, bytes: Vec<u8>) -> Result<()> {
        self.map.lock().unwrap().insert(key.to_string(), bytes);
        Ok(())
    }
    async fn put_new(&self, key: &str, bytes: Vec<u8>) -> Result<bool> {
        let mut m = self.map.lock().unwrap();
        if m.contains_key(key) {
            return Ok(false);
        }
        m.insert(key.to_string(), bytes);
        Ok(true)
    }
    async fn get(&self, key: &str, range: Option<(u64, u64)>) -> Result<Option<Vec<u8>>> {
        let m = self.map.lock().unwrap();
        let Some(b) = m.get(key) else { return Ok(None) };
        Ok(Some(match range {
            Some((o, l)) => {
                let end = o
                    .checked_add(l)
                    .filter(|e| *e <= b.len() as u64)
                    .ok_or_else(|| crate::error::ServiceError::invalid("range"))?;
                b[o as usize..end as usize].to_vec()
            }
            None => b.clone(),
        }))
    }
    async fn delete(&self, key: &str) -> Result<()> {
        self.map.lock().unwrap().remove(key);
        Ok(())
    }
}

impl<T: Archive> Archive for Arc<T> {
    async fn put_segment(
        &self,
        collection: &Uuid,
        tier: RetentionTier,
        from: u64,
        to: u64,
        bytes: Vec<u8>,
    ) -> Result<()> {
        (**self)
            .put_segment(collection, tier, from, to, bytes)
            .await
    }
    async fn archive_object(
        &self,
        collection: &Uuid,
        tier: RetentionTier,
        address: &B32,
    ) -> Result<()> {
        (**self).archive_object(collection, tier, address).await
    }
}

impl<T: ObjectStore> ObjectStore for Arc<T> {
    async fn put(&self, key: &str, bytes: Vec<u8>) -> Result<()> {
        (**self).put(key, bytes).await
    }
    async fn put_new(&self, key: &str, bytes: Vec<u8>) -> Result<bool> {
        (**self).put_new(key, bytes).await
    }
    async fn get(&self, key: &str, range: Option<(u64, u64)>) -> Result<Option<Vec<u8>>> {
        (**self).get(key, range).await
    }
    async fn delete(&self, key: &str) -> Result<()> {
        (**self).delete(key).await
    }
}

#[cfg(test)]
mod compact_through_tests {
    use super::*;
    use crate::model::{CollectionMeta, SnapshotRow, StoredItem};
    use std::future::Future;
    use std::task::{Context, Poll, Waker};

    /// Uncontended memory operations complete on their first poll.
    fn ready<T>(f: impl Future<Output = T>) -> T {
        let mut f = std::pin::pin!(f);
        match f.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
            Poll::Ready(v) => v,
            Poll::Pending => panic!("memory backend operation unexpectedly pending"),
        }
    }

    const C: Uuid = B16([0x1c; 16]);

    fn item(seq: u64, kind: u64, len: usize) -> StoredItem {
        StoredItem {
            seq,
            kind,
            bytes: vec![seq as u8; len],
            appended_at: 1_000 + seq as i64,
            token: Some(B16([seq as u8; 16])),
            refs: Vec::new(),
        }
    }

    /// Genesis (kind 2) at 1, entries at 2..=5, a policy item (kind 2) at 6,
    /// entries at 7..=8, a snapshot pointer at 5; `used_bytes` counts the items.
    async fn backend() -> MemBackend {
        let b = MemBackend::default();
        let mut tx = b.begin(&C, Mode::Write).await.unwrap();
        let mut meta = CollectionMeta::new(C, 1_000);
        let kinds = [
            (1, 2),
            (2, 1),
            (3, 1),
            (4, 1),
            (5, 1),
            (6, 2),
            (7, 1),
            (8, 1),
        ];
        let used: u64 = kinds.iter().map(|(seq, _)| 10 * seq).sum();
        meta.head = 8;
        meta.head_chain = B32([8; 32]);
        meta.used_bytes = used;
        tx.write(Write::CreateCollection(CollectionState {
            meta,
            acl: BTreeMap::new(),
        }));
        for (seq, kind) in kinds {
            tx.write(Write::InsertItem(item(seq, kind, 10 * seq as usize)));
        }
        tx.write(Write::InsertSnapshot(SnapshotRow {
            seq: 5,
            manifest: B32([5; 32]),
            author: B16([0xaa; 16]),
            created_at: 1_005,
            endorsed: false,
            refs: Vec::new(),
        }));
        tx.commit().await.unwrap();
        b
    }

    async fn snapshot(b: &MemBackend) -> (Vec<(u64, u64)>, CollectionMeta, usize, usize) {
        let col = b.col(&C);
        let g = col.lock_arc().await;
        (
            g.items.values().map(|i| (i.seq, i.kind)).collect(),
            g.state.as_ref().unwrap().meta.clone(),
            g.snapshots.len(),
            g.tokens.len(),
        )
    }

    #[test]
    fn removes_only_entries_and_charges_exactly_their_bytes() {
        ready(async {
            let b = backend().await;
            let (_, before, snaps, tokens) = snapshot(&b).await;
            assert_eq!(b.compact_through(&C, 5).await.unwrap(), Some(6));
            let (items, meta, snaps2, tokens2) = snapshot(&b).await;
            // Entries 2..=5 are gone; genesis at 1 and the policy item at 6 stay.
            assert_eq!(items, vec![(1, 2), (6, 2), (7, 1), (8, 1)]);
            assert_eq!(meta.retained_from, 6);
            assert_eq!(meta.used_bytes, before.used_bytes - 10 * (2 + 3 + 4 + 5));
            assert_eq!(
                (meta.head, meta.head_chain),
                (before.head, before.head_chain)
            );
            assert_eq!((snaps2, tokens2), (snaps, tokens));
        });
    }

    #[test]
    fn repeat_and_lower_positions_are_no_ops() {
        ready(async {
            let b = backend().await;
            assert_eq!(b.compact_through(&C, 5).await.unwrap(), Some(6));
            let after = snapshot(&b).await;
            assert_eq!(b.compact_through(&C, 5).await.unwrap(), Some(6));
            assert_eq!(b.compact_through(&C, 3).await.unwrap(), Some(6));
            assert_eq!(snapshot(&b).await, after);
            // Further compaction continues from the retained position.
            assert_eq!(b.compact_through(&C, 7).await.unwrap(), Some(8));
            let (items, meta, ..) = snapshot(&b).await;
            assert_eq!(items, vec![(1, 2), (6, 2), (8, 1)]);
            assert_eq!(meta.retained_from, 8);
        });
    }

    #[test]
    fn invalid_ranges_and_unknown_collections_change_nothing() {
        ready(async {
            let b = backend().await;
            let before = snapshot(&b).await;
            assert_eq!(b.compact_through(&C, 9).await.unwrap(), None);
            assert_eq!(b.compact_through(&C, u64::MAX).await.unwrap(), None);
            assert_eq!(b.compact_through(&B16([0x2d; 16]), 1).await.unwrap(), None);
            assert_eq!(snapshot(&b).await, before);
        });
    }
}
