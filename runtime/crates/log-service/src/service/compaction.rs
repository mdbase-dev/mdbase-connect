//! Compaction, archive segments and object GC.

use super::*;

/// Archive segment format 1: canonical CBOR `{0: 1, 1: collection, 2: from, 3: to,
/// 4: chain(to), 5: [[seq, item bytes], …]}` over the `entry` items `seg`, in
/// order. `chain(to)` is the chain hash of the item at `to`, so a segment can be
/// checked against the log's chain (and against the next segment's first item).
pub fn encode_segment(c: &Uuid, seg: &[StoredItem]) -> Vec<u8> {
    let u = Cbor::Uint;
    let last = seg.last().expect("non-empty segment");
    let m = vec![
        (u(0), u(1)),
        (u(1), Cbor::Bytes(c.0.to_vec())),
        (u(2), u(seg[0].seq)),
        (u(3), u(last.seq)),
        (u(4), Cbor::Bytes(chain_hash(&last.bytes).0.to_vec())),
        (
            u(5),
            Cbor::Array(
                seg.iter()
                    .map(|i| Cbor::Array(vec![u(i.seq), Cbor::Bytes(i.bytes.clone())]))
                    .collect(),
            ),
        ),
    ];
    cbor::encode(&Cbor::Map(m)).expect("segment encodes")
}

impl<B: Backend, O: ObjectStore> Service<B, O> {
    /// Compaction (`snapshot.md` §5.1): deletes `entry` items at or below
    /// `C = min(S_o, S_e − 10,000, last position appended more than 7 days ago)`,
    /// where `S_o` is the older of the two retained snapshots.
    /// Returns the new `retained_from`.
    ///
    /// The archive uploads hold no write lock, so they never stall appends.
    /// Entries at or below C cannot change until a compaction deletes them,
    /// and that deletion moves `retained_from` in the same commit; so the write
    /// lock is taken only at the end, to delete, and only if `retained_from`
    /// has not moved and C has not fallen meanwhile.
    pub async fn compact(&self, c: &Uuid, now: i64) -> Result<u64> {
        let (from, cp, tier) = {
            let mut tx = self.backend.begin(c, Mode::Read).await?;
            let state = Self::load(&mut tx).await?;
            let cp = Self::compaction_point(&mut tx, &state, now).await?;
            if cp < state.meta.retained_from {
                return Ok(state.meta.retained_from);
            }
            (state.meta.retained_from, cp, state.meta.retention_tier)
        };
        // Archive first; the deletion commits only once every segment is stored.
        // On any error nothing is deleted and the next run retries (the segment
        // keys are deterministic, so a partial archive is simply rewritten).
        self.archive_entries(c, tier, from, cp).await?;
        let mut tx = self.backend.begin(c, Mode::Write).await?;
        let mut state = Self::load(&mut tx).await?;
        if state.meta.retained_from != from
            || Self::compaction_point(&mut tx, &state, now).await? < cp
        {
            return Ok(state.meta.retained_from);
        }
        let bytes = tx.entry_bytes_through(cp).await?;
        tx.write(Write::DeleteEntriesThrough(cp));
        tx.write(Write::PruneTokens(now));
        state.meta.retained_from = cp + 1;
        state.meta.used_bytes = state.meta.used_bytes.saturating_sub(bytes);
        tx.write(Write::PutMeta(state.meta.clone()));
        tx.commit().await?;
        Ok(cp + 1)
    }

    /// C for [`Self::compact`].
    async fn compaction_point<T: Txn>(
        tx: &mut T,
        state: &CollectionState,
        now: i64,
    ) -> Result<u64> {
        let snaps = tx.snapshots().await?;
        let personal = state
            .acl
            .values()
            .filter(|e| e.active && e.kind != device_kind::HOSTED && e.kind != device_kind::ESCROW)
            .count();
        let s_e = snaps
            .iter()
            .filter(|s| s.endorsed || personal <= 1 && now - s.created_at > SELF_ENDORSE_AGE_MS)
            .map(|s| s.seq)
            .max()
            .unwrap_or(0);
        // A replica that refuses the newest snapshot installs the older one and
        // replays from it (§8): the log stays readable from there. With fewer
        // than two snapshots there is none to fall back to, and nothing goes.
        let s_o = snaps.get(RETAINED_SNAPSHOTS - 1).map_or(0, |s| s.seq);
        let c1 = s_e.saturating_sub(COMPACTION_GRACE_ENTRIES);
        let c2 = tx
            .last_seq_at_or_before(now - COMPACTION_MIN_AGE_MS)
            .await?;
        Ok(s_o.min(c1).min(c2))
    }

    /// Write the `entry` items in `(retained_from − 1, cp]` to the archive, in
    /// order, as segments of at most [`ARCHIVE_SEGMENT_BYTES`] item bytes (a
    /// single larger item is a segment on its own). Each page is read in its
    /// own short read transaction, and no transaction is open during an upload.
    /// A concurrent compaction may delete entries meanwhile; the pages then
    /// skip them, and the caller's commit check sees `retained_from` move. The
    /// loser's segments stay: archive segments may overlap, never conflict.
    async fn archive_entries(
        &self,
        c: &Uuid,
        tier: RetentionTier,
        retained_from: u64,
        cp: u64,
    ) -> Result<()> {
        let mut after = retained_from.saturating_sub(1);
        let mut seg: Vec<StoredItem> = Vec::new();
        let mut seg_bytes = 0u64;
        'pages: loop {
            let page = self
                .backend
                .begin(c, Mode::Read)
                .await?
                .items(after, MAX_READ_ITEMS, ARCHIVE_SEGMENT_BYTES, false)
                .await?;
            if page.is_empty() {
                break;
            }
            for it in page {
                if it.seq > cp {
                    break 'pages;
                }
                after = it.seq;
                if it.kind != 1 {
                    continue;
                }
                let n = it.bytes.len() as u64;
                if !seg.is_empty() && seg_bytes + n > ARCHIVE_SEGMENT_BYTES {
                    self.put_segment(c, tier, &seg).await?;
                    seg.clear();
                    seg_bytes = 0;
                }
                seg_bytes += n;
                seg.push(it);
            }
        }
        if !seg.is_empty() {
            self.put_segment(c, tier, &seg).await?;
        }
        Ok(())
    }

    async fn put_segment(&self, c: &Uuid, tier: RetentionTier, seg: &[StoredItem]) -> Result<()> {
        let (from, to) = (seg[0].seq, seg[seg.len() - 1].seq);
        let bytes = encode_segment(c, seg);
        self.objects.put_segment(c, tier, from, to, bytes).await
    }

    /// Garbage collection (§6.2, I10). Each dead object is archived first; one
    /// whose archive copy fails is kept this round. Uncommitted uploads have no
    /// bytes at their final key and are not archived. Returns the number of
    /// objects deleted. As in [`Self::compact`], the archive copies hold no
    /// write lock: the deletion re-reads the candidates under it and removes
    /// only those still dead (and, if committed, archived above). An address
    /// archived as "missing source" (a concurrent GC deleted it) is safe in
    /// `archived`: re-creating an object's metadata stamps `created_at: now`,
    /// so it cannot be a candidate again within the grace period.
    pub async fn gc(&self, c: &Uuid, now: i64) -> Result<u64> {
        let before = now - OBJECT_GRACE_MS;
        let (candidates, tier) = {
            let mut tx = self.backend.begin(c, Mode::Read).await?;
            let state = Self::load(&mut tx).await?;
            // A restore imports objects before the items that reference them.
            live(&state.meta)?;
            (
                tx.gc_candidates(before, GC_BATCH_OBJECTS).await?,
                state.meta.retention_tier,
            )
        };
        let mut archived = BTreeSet::new();
        for o in candidates.iter().filter(|o| o.committed) {
            if self
                .objects
                .archive_object(c, tier, &o.address)
                .await
                .is_ok()
            {
                archived.insert(o.address);
            }
        }
        let mut tx = self.backend.begin(c, Mode::Write).await?;
        let mut state = Self::load(&mut tx).await?;
        live(&state.meta)?;
        let dead: Vec<ObjectMeta> = tx
            .gc_candidates(before, GC_BATCH_OBJECTS)
            .await?
            .into_iter()
            .filter(|o| !o.committed || archived.contains(&o.address))
            .collect();

        if dead.is_empty() {
            return Ok(0);
        }
        let dead_file_bytes: u64 = dead
            .iter()
            .filter(|o| o.committed && o.kind == ItemKind::BlobPart.value())
            .map(|o| o.size)
            .sum();
        if dead_file_bytes > 0 {
            let file_bytes = Self::file_bytes(&mut tx, &state.meta).await?;
            state.meta.file_bytes = Some(file_bytes.saturating_sub(dead_file_bytes));
        }
        for o in &dead {
            tx.write(Write::DeleteObject(o.address));
            if o.committed {
                state.meta.used_bytes = state.meta.used_bytes.saturating_sub(o.size);
            }
        }
        tx.write(Write::PutMeta(state.meta));
        tx.commit().await?;
        for o in &dead {
            self.objects.delete(&object_key(c, &o.address)).await?;
        }
        Ok(dead.len() as u64)
    }
}
