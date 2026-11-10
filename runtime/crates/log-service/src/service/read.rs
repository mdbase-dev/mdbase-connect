//! Log reads and heads (§5).

use super::*;

impl<B: Backend, O: ObjectStore> Service<B, O> {
    // ------------------------------------------------------------------ read (§5)

    pub(super) fn pointer(s: &SnapshotRow) -> SnapshotPointer {
        SnapshotPointer {
            seq: s.seq,
            manifest: s.manifest,
            author: s.author,
            created_at: s.created_at,
            endorsed: s.endorsed,
        }
    }

    /// Read a range.
    pub async fn read(&self, p: &Principal, params: ReadParams, _now: i64) -> Result<ReadResult> {
        let max_bytes = params
            .max_bytes
            .unwrap_or(MAX_READ_BYTES)
            .min(MAX_READ_BYTES);
        if max_bytes == 0 {
            return Err(ServiceError::invalid("max_bytes"));
        }
        let mut tx = self.backend.begin(&params.collection, Mode::Read).await?;
        let state = Self::load(&mut tx).await?;
        Self::authorize(&state, p)?;
        live(&state.meta)?;
        let m = &state.meta;
        let control = params.kinds == Some(ReadKinds::Control);
        let behind = !control && params.after.saturating_add(1) < m.retained_from;
        let limit = params.limit.min(MAX_READ_ITEMS);
        let items = if behind || limit == 0 || params.after >= m.head {
            Vec::new()
        } else {
            tx.items(params.after, limit, max_bytes, control).await?
        };
        let last = items.last().map_or(params.after, |i| i.seq);
        let more = if control {
            // Pages end at the item limit or near the byte cap; an exact answer
            // would need another query, and a spurious `more` costs one empty read.
            let total: u64 = items.iter().map(|i| i.bytes.len() as u64).sum();
            last < m.head
                && (items.len() as u64 == limit || total > max_bytes.saturating_sub(MAX_ITEM_BYTES))
        } else {
            last < m.head
        };
        let snapshot = if behind || control || params.after == 0 {
            tx.snapshots().await?.first().map(Self::pointer)
        } else {
            None
        };
        Ok(ReadResult {
            items: items
                .into_iter()
                .map(|i| SeqItem {
                    seq: i.seq,
                    item: Bytes(i.bytes),
                })
                .collect(),
            head: m.head,
            head_chain: m.head_chain,
            retained_from: m.retained_from,
            behind,
            snapshot,
            more,
        })
    }

    /// The head.
    pub async fn head(&self, p: &Principal, c: &Uuid) -> Result<HeadResult> {
        let mut tx = self.backend.begin(c, Mode::Read).await?;
        let state = Self::load(&mut tx).await?;
        Self::authorize(&state, p)?;
        live(&state.meta)?;
        let snapshot = tx.snapshots().await?.first().map(Self::pointer);
        Ok(HeadResult {
            head: state.meta.head,
            head_chain: state.meta.head_chain,
            retained_from: state.meta.retained_from,
            snapshot,
        })
    }
}
