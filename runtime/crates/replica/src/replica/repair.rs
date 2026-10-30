//! Device-local lost-tail recovery. Retention is atomic with the applied head;
//! it never affects deterministic authorization/void verdicts.

use super::Replica;
use crate::store::{Head, Store, StoreError, TailRetention, TailRow, Tx};

impl<S: Store> Replica<S> {
    /// Configure the retained repair window. The byte cap is hard; position and
    /// age bounds cover whichever reaches further back. Prune with apply only.
    pub fn set_tail_retention(&mut self, retention: TailRetention) {
        self.tail_retention = TailRetention {
            min_age_ms: retention.min_age_ms.max(0),
            ..retention
        };
    }

    /// The candidate is scoped to ONE synchronous apply attempt. It is consumed
    /// here, or discarded by apply_items on every stop/error; never retry cached
    /// bytes at a changed position. Own handover fields share this transaction.
    pub(crate) fn commit_retained(&mut self, head: Head, mut tx: Tx) -> Result<(), StoreError> {
        let row = self.retaining.take().ok_or_else(|| {
            StoreError::Corrupt("synced head commit lacks exact apply bytes".into())
        })?;
        if row.seq != head.seq || mdbn_wire::hash::chain_hash(&row.item) != head.chain {
            return Err(StoreError::Corrupt(
                "retained bytes differ from applied head".into(),
            ));
        }
        self.expire_private_switch(head);
        tx.meta.push(self.private_switch_meta());
        let revoked = self
            .policy
            .devices
            .get(&self.cfg.device_id)
            .is_some_and(|d| !d.active);
        let own_bytes = tx.own_retained_put.iter().fold(0u64, |bytes, (_, own)| {
            bytes.saturating_add(own.to_bytes().len() as u64)
        });
        if revoked
            || (row.item.len() as u64).saturating_add(own_bytes) > self.tail_retention.max_bytes
        {
            // Current validated policy is persisted by the same head transaction
            // (or was durably read ahead). Rollback must preserve revocation
            // evidence before ever resetting that policy or these retention sets.
            tx.tail_drop_above = Some(0);
            tx.own_retained_drop_above = Some(0);
            tx.own_retained_put.clear();
        } else if self.prune_retained(&row, &mut tx)? {
            tx.tail_put.push(row);
        }
        self.commit_with_read_health(Some(head), tx)?;
        if !self.apply_fault && !self.is_apply_recovering() {
            self.restore_private_choice();
            self.check_key_trust();
        }
        Ok(())
    }

    /// Same settled commit/read-health boundary, also for DATA-only warm replay
    /// hints. `None` NEVER moves a head or claims new applied-original bytes.
    pub(crate) fn commit_with_read_health(
        &mut self,
        head: Option<Head>,
        tx: Tx,
    ) -> Result<(), StoreError> {
        self.store.commit(tx)?;
        if let Some(head) = head {
            self.head = head;
        }
        // Successful commit remains confirmation even when this AFTER-commit
        // read fails. Fence immediately: do not restore the committed checkpoint
        // or issue further actions/outputs through an unhealthy Store instance.
        self.tail_stats_dirty = true;
        if self.refresh_retained_stats().is_err() {
            self.committed_read_fault();
        }
        Ok(())
    }

    pub(crate) fn refresh_retained_stats(&mut self) -> Result<(), StoreError> {
        if self.tail_stats_dirty {
            self.tail_stats = self.store.tail_stats().map_err(retention_read_error)?;
            self.tail_stats_dirty = false;
        }
        Ok(())
    }

    fn prune_retained(&self, new: &TailRow, tx: &mut Tx) -> Result<bool, StoreError> {
        let retention = self.tail_retention;
        let mut stats = self.tail_stats;
        if stats.last >= new.seq
            && let Some(old) = self
                .store
                .tail(new.seq.saturating_sub(1), 1)
                .map_err(retention_read_error)?
                .first()
            && old.seq == new.seq
        {
            stats.bytes = stats.bytes.saturating_sub(old.item.len() as u64);
            stats.count = stats.count.saturating_sub(1);
        }
        let own_stats = self
            .store
            .own_retained_stats()
            .map_err(retention_read_error)?;
        let mut own_bytes = own_stats.bytes;
        for (seq, row) in &tx.own_retained_put {
            // Apply currently hands over only the new position. Check rather
            // than silently misaccount if a future caller changes that contract.
            if *seq != new.seq {
                return Err(StoreError::Corrupt("own handover position".into()));
            }
            if own_stats.last >= *seq
                && let Some((old_seq, old)) = self
                    .store
                    .own_retained(seq.saturating_sub(1), 1)
                    .map_err(retention_read_error)?
                    .first()
                && old_seq == seq
            {
                own_bytes = own_bytes.saturating_sub(old.to_bytes().len() as u64);
            }
            own_bytes = own_bytes.saturating_add(row.to_bytes().len() as u64);
        }
        let mut bytes = stats
            .bytes
            .saturating_add(new.item.len() as u64)
            .saturating_add(own_bytes);
        let threshold = (retention.min_positions / 20).clamp(1, 1_000);
        let prune_window =
            stats.count.saturating_add(1) > retention.min_positions.saturating_add(threshold);
        if !prune_window && bytes <= retention.max_bytes {
            return Ok(true);
        }
        let position_floor = new
            .seq
            .saturating_sub(retention.min_positions)
            .saturating_add(1);
        let time_floor = new.applied_at.saturating_sub(retention.min_age_ms);
        let mut after = 0;
        let mut floor = None;
        loop {
            // Merge both ordered sets: raw-tail loss/erasure need not erase
            // own history. A missing raw row is NOT permission to drop an intent
            // on age alone, but its bytes still count against the hard budget.
            // Read one row per set, not a page of potentially large originals.
            let rows = self.store.tail(after, 1).map_err(retention_read_error)?;
            let own = self
                .store
                .own_retained(after, 1)
                .map_err(retention_read_error)?;
            let tail = rows.first().filter(|r| r.seq < new.seq);
            let own = own.first().filter(|(seq, _)| *seq < new.seq);
            let Some(seq) = tail
                .map(|r| r.seq)
                .into_iter()
                .chain(own.map(|(s, _)| *s))
                .min()
            else {
                break;
            };
            let tail = tail.filter(|r| r.seq == seq);
            let own = own.filter(|(s, _)| *s == seq);
            let expired = prune_window
                && seq < position_floor
                && tail.is_some_and(|r| r.applied_at < time_floor);
            if !expired && bytes <= retention.max_bytes {
                break;
            }
            bytes = bytes.saturating_sub(tail.map_or(0, |r| r.item.len() as u64));
            bytes = bytes.saturating_sub(own.map_or(0, |(_, r)| r.to_bytes().len() as u64));
            after = seq;
            floor = seq.checked_add(1);
        }
        if bytes > retention.max_bytes {
            // A replayed position can already have an oversized retained own
            // row even without a new handover. Match oversized-new-item policy.
            tx.tail_drop_above = Some(0);
            tx.own_retained_drop_above = Some(0);
            tx.own_retained_put.clear();
            return Ok(false);
        }
        if let Some(floor) = floor {
            tx.tail_drop_below = Some(floor);
            tx.own_retained_drop_below = Some(floor);
        }
        Ok(true)
    }
}

// Strong abort is ONLY a commit result. A read-wrapper must not manufacture a
// safe retry outcome from its failure; unknown read durability is terminal.
fn retention_read_error(e: StoreError) -> StoreError {
    match e {
        StoreError::CommitAborted(s) => StoreError::Io(s),
        other => other,
    }
}
