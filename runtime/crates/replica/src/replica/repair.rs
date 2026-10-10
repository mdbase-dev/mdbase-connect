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
        let revoked = self
            .policy
            .devices
            .get(&self.cfg.device_id)
            .is_some_and(|d| !d.active);
        if revoked || row.item.len() as u64 > self.tail_retention.max_bytes {
            // Current validated policy is persisted by the same head transaction
            // (or was durably read ahead). Rollback must preserve revocation
            // evidence before ever resetting that policy or these retention sets.
            tx.tail_drop_above = Some(0);
            tx.own_retained_drop_above = Some(0);
            tx.own_retained_put.clear();
        } else {
            self.prune_retained(&row, &mut tx)?;
            tx.tail_put.push(row);
        }
        self.store.commit(tx)?;
        self.head = head;
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

    fn prune_retained(&self, new: &TailRow, tx: &mut Tx) -> Result<(), StoreError> {
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
        let mut bytes = stats.bytes.saturating_add(new.item.len() as u64);
        let threshold = (retention.min_positions / 20).clamp(1, 1_000);
        let prune_window =
            stats.count.saturating_add(1) > retention.min_positions.saturating_add(threshold);
        if !prune_window && bytes <= retention.max_bytes {
            return Ok(());
        }
        let position_floor = new
            .seq
            .saturating_sub(retention.min_positions)
            .saturating_add(1);
        let time_floor = new.applied_at.saturating_sub(retention.min_age_ms);
        let mut after = 0;
        let mut floor = None;
        loop {
            // One bounded row at a time, not 64 large envelopes to prune counters.
            let rows = self.store.tail(after, 1).map_err(retention_read_error)?;
            let Some(old) = rows.first().filter(|r| r.seq < new.seq) else {
                break;
            };
            let expired = prune_window && old.seq < position_floor && old.applied_at < time_floor;
            if !expired && bytes <= retention.max_bytes {
                break;
            }
            bytes = bytes.saturating_sub(old.item.len() as u64);
            after = old.seq;
            floor = old.seq.checked_add(1);
        }
        if let Some(floor) = floor {
            tx.tail_drop_below = Some(floor);
            tx.own_retained_drop_below = Some(floor);
        }
        Ok(())
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
