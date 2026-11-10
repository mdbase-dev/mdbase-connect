//! Snapshot upload, reads and endorsement (§7).

use super::*;

impl<B: Backend, O: ObjectStore> Service<B, O> {
    // ------------------------------------------------------------------ snapshots (§7)

    /// `put_snapshot`.
    pub async fn put_snapshot(
        &self,
        p: &Principal,
        q: PutSnapshotParams,
        now: i64,
    ) -> Result<bool> {
        let budget = Budget::default();
        self.scoped(&budget)
            .put_snapshot_with_budget(p, q, now, &budget)
            .await
    }

    /// Register a snapshot within the enclosing request's budget. Ref-index
    /// objects among `refs` are expanded (`log-service-api.md` §7): the stored
    /// refs are the direct refs plus every address the indices list, so garbage
    /// collection and quota accounting see the complete set.
    pub async fn put_snapshot_with_budget(
        &self,
        p: &Principal,
        q: PutSnapshotParams,
        now: i64,
        budget: &Budget,
    ) -> Result<bool> {
        let c = q.collection;
        let mut tx = self.backend.begin(&c, Mode::Write).await?;
        let state = Self::load(&mut tx).await?;
        let Some(me) = Self::authorize(&state, p)?.cloned() else {
            return Err(ServiceError::reason(Code::Forbidden, "principal"));
        };
        if q.seq > state.meta.head || q.seq == 0 {
            return Err(ServiceError::invalid("seq"));
        }
        let snaps = tx.snapshots().await?;
        if snaps.first().is_some_and(|s| s.seq >= q.seq) {
            return Ok(false);
        }
        let mut refs: Vec<B32> = q.refs.clone();
        refs.push(q.manifest);
        refs.sort();
        refs.dedup();
        let metas = tx.objects(&refs).await?;
        let missing: Vec<Cbor> = refs
            .iter()
            .zip(&metas)
            .filter(|(_, m)| !m.as_ref().is_some_and(|m| m.committed))
            .map(|(a, _)| Cbor::Bytes(a.0.to_vec()))
            .collect();
        if !missing.is_empty() {
            let mut e = ServiceError::new(Code::RefsMissing);
            e.details = Some(Cbor::Array(missing));
            return Err(e);
        }
        // Kinds: the pointer names a manifest; refs are chunks, blob
        // parts and ref-index objects.
        let mut indices = Vec::new();
        for (a, m) in refs.iter().zip(&metas) {
            let k = m.as_ref().map_or(0, |m| m.kind);
            let ok = if *a == q.manifest {
                k == ItemKind::Manifest.value()
            } else if k == ItemKind::RefIndex.value() {
                indices.push(*a);
                true
            } else {
                k == ItemKind::Chunk.value() || k == ItemKind::BlobPart.value()
            };
            if !ok {
                return Err(ServiceError::invalid("kind").msg("snapshot object kind"));
            }
        }
        if !indices.is_empty() {
            refs = self
                .expand_ref_indices(&mut tx, &c, refs, &indices, budget)
                .await?;
        }
        tx.write(Write::InsertSnapshot(SnapshotRow {
            seq: q.seq,
            manifest: q.manifest,
            author: me.device,
            created_at: now,
            endorsed: false,
            refs,
        }));
        for old in snaps.iter().skip(RETAINED_SNAPSHOTS - 1) {
            tx.write(Write::DeleteSnapshot(old.seq));
        }
        tx.commit().await?;
        Ok(true)
    }

    /// Add every address the ref-index objects `indices` list to `refs`. Fails
    /// closed: an index beyond [`MAX_REF_INDICES`], an index whose bytes are gone
    /// or malformed, a member that is missing, or a member that is not a chunk or
    /// blob part (depth exactly one: an index never lists an index) refuses the
    /// snapshot, so nothing is registered without all of its roots.
    async fn expand_ref_indices<T: Txn>(
        &self,
        tx: &mut T,
        c: &Uuid,
        refs: Vec<B32>,
        indices: &[B32],
        budget: &Budget,
    ) -> Result<Vec<B32>> {
        if indices.len() > MAX_REF_INDICES {
            return Err(ServiceError::reason(Code::TooLarge, "ref_indices"));
        }
        let mut members = BTreeSet::new();
        for a in indices {
            let bytes = self
                .objects
                .get(&object_key(c, a), None)
                .await?
                .ok_or_else(|| {
                    ServiceError::backend("ref-index bytes missing: integrity incident")
                })?;
            members.extend(stored_ref_index(c, a, &bytes, budget)?);
        }
        let members: Vec<B32> = members.into_iter().collect();
        let metas = tx.objects(&members).await?;
        let mut missing = Vec::new();
        for (a, m) in members.iter().zip(&metas) {
            match m {
                Some(m) if m.committed => {
                    if m.kind != ItemKind::Chunk.value() && m.kind != ItemKind::BlobPart.value() {
                        return Err(ServiceError::invalid("kind").msg(if is_ref_index(m) {
                            "ref-index depth"
                        } else {
                            "ref-index member kind"
                        }));
                    }
                }
                _ if missing.len() < MAX_HAS_OBJECTS => {
                    missing.push(Cbor::Bytes(a.0.to_vec()));
                }
                _ => {}
            }
        }
        if !missing.is_empty() {
            let mut e = ServiceError::new(Code::RefsMissing);
            e.details = Some(Cbor::Array(missing));
            return Err(e);
        }
        let mut out = refs;
        out.extend(members);
        out.sort();
        out.dedup();
        Ok(out)
    }

    /// `get_snapshot`.
    pub async fn get_snapshot(&self, p: &Principal, c: &Uuid) -> Result<GetSnapshotResult> {
        let mut tx = self.backend.begin(c, Mode::Read).await?;
        let state = Self::load(&mut tx).await?;
        Self::authorize(&state, p)?;
        not_gone(&state.meta)?;
        Ok(GetSnapshotResult {
            snapshots: tx.snapshots().await?.iter().map(Self::pointer).collect(),
        })
    }

    /// `endorse_snapshot`: from an active device other than the author; compaction
    /// may then advance.
    pub async fn endorse_snapshot(
        &self,
        p: &Principal,
        q: EndorseSnapshotParams,
        now: i64,
    ) -> Result<bool> {
        let c = q.collection;
        {
            let mut tx = self.backend.begin(&c, Mode::Write).await?;
            let state = Self::load(&mut tx).await?;
            let Some(me) = Self::authorize(&state, p)?.cloned() else {
                return Err(ServiceError::reason(Code::Forbidden, "principal"));
            };
            let snaps = tx.snapshots().await?;
            let Some(s) = snaps
                .iter()
                .find(|s| s.seq == q.seq && s.manifest == q.manifest)
            else {
                return Ok(false);
            };
            if s.author == me.device {
                return Err(ServiceError::reason(Code::Forbidden, "author"));
            }
            // Endorsers can verify state and write: editors and owners, or the
            // hosted replica. Not viewers, not escrow.
            let writer = state.meta.members.get(&me.account).is_some_and(|r| *r >= 1)
                && me.kind != device_kind::ESCROW;
            if !(writer || me.kind == device_kind::HOSTED) {
                return Err(ServiceError::reason(Code::Forbidden, "role"));
            }
            if !s.endorsed {
                tx.write(Write::EndorseSnapshot(s.seq));
                tx.commit().await?;
            }
        }
        self.compact(&c, now).await?;
        Ok(true)
    }
}
