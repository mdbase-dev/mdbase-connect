//! Log administration (§12): creation, quotas, storage status and deletion.

use super::*;

impl<B: Backend, O: ObjectStore> Service<B, O> {
    // ------------------------------------------------------------------ admin (§12)

    /// `create_log {0: collection, 1: genesis item, ? 2: placement}` returns
    /// `{0: 1, 1: chain, ? 2: region}`. Key 2 is the region recorded for the
    /// collection (absent when it has none), also on an idempotent retry, so the
    /// caller can place the collection's other actors with it.
    pub(super) async fn create_log(
        &self,
        p: &Principal,
        params: &Cbor,
        now: i64,
        budget: &Budget,
    ) -> Result<Outcome> {
        self.require_cp(p)?;
        let c = uuid_field(params, 0)?;
        self.refuse_deleted_floor(&c).await?;
        let bytes = match field(params, 1) {
            Some(Cbor::Bytes(b)) => b.clone(),
            _ => return Err(bad_params("genesis")),
        };
        let it = budget.wire::<Item>(&bytes)?;
        it.check_shape()
            .map_err(|e| ServiceError::invalid("shape").msg(e.to_string()))?;
        let region = Placement::from_field(field(params, 2))?.resolve_in(&self.regions)?;
        if it.kind != ItemKind::Policy
            || it.collection != c
            || it.seq != Some(1)
            || it.prev != Some(CHAIN_ZERO)
        {
            return Err(ServiceError::invalid("shape").msg("genesis item"));
        }
        let mut tx = self.backend.begin(&c, Mode::Write).await?;
        let chain = chain_hash(&bytes);
        let ok = |region: Option<Region>| {
            let mut m = vec![(0, Cbor::Uint(1)), (1, Cbor::Bytes(chain.0.to_vec()))];
            m.extend(region.map(|r| (2, Cbor::Text(r.as_str().into()))));
            map(m)
        };
        if let Some(existing) = tx.load().await? {
            if existing.meta.status == Status::Gone {
                return Err(ServiceError::new(Code::Gone));
            }
            let first = tx.items(0, 1, u64::MAX, false).await?;
            self.refuse_deleted_floor(&c).await?;
            if first.first().is_some_and(|i| i.bytes == bytes) {
                // The stored region, not this retry's placement.
                return Ok(Outcome::plain(ok(existing.meta.region)));
            }
            return Err(ServiceError::invalid("exists"));
        }
        let mut st = CollectionState {
            meta: CollectionMeta::new(c, now),
            acl: BTreeMap::new(),
        };
        st.meta.region = region;
        apply_policy_with_budget(&mut st, &it, 1, &self.config.roots, budget)?;
        st.meta.head = 1;
        st.meta.head_chain = chain;
        st.meta.used_bytes = bytes.len() as u64;
        tx.write(Write::CreateCollection(st));
        tx.write(Write::InsertItem(StoredItem {
            seq: 1,
            kind: ItemKind::Policy.value(),
            bytes: bytes.clone(),
            appended_at: now,
            token: None,
            refs: vec![],
        }));
        tx.commit().await?;
        Ok(Outcome::plain(ok(region)))
    }

    /// `set_quota {0: collection, 1: [log storage, items/s, bytes/s, burst]}`:
    /// the operator's abuse limits. Plan storage is `set_file_headroom`.
    pub(super) async fn set_quota(&self, p: &Principal, params: &Cbor) -> Result<Outcome> {
        self.require_cp(p)?;
        let c = uuid_field(params, 0)?;
        let q = match field(params, 1) {
            Some(Cbor::Array(a)) if a.len() == 4 => a
                .iter()
                .map(|x| match x {
                    Cbor::Uint(n) => Ok(*n),
                    _ => Err(bad_params("quota")),
                })
                .collect::<Result<Vec<u64>>>()?,
            _ => return Err(bad_params("quota")),
        };
        let mut tx = self.backend.begin(&c, Mode::Write).await?;
        let mut st = Self::load(&mut tx).await?;
        if st.meta.status == Status::Importing && st.meta.restore_plan.is_some() {
            return Err(ServiceError::invalid("restore_settings")
                .msg("strict restore preserves the source quota"));
        }
        st.meta.quotas = Quotas {
            storage_bytes: q[0],
            items_per_s: q[1].max(1),
            bytes_per_s: q[2].max(1),
            burst_items: q[3].max(1),
        };
        tx.write(Write::PutMeta(st.meta));
        tx.commit().await?;
        self.buckets.lock().unwrap().remove(&c);
        Ok(Outcome::plain(map(vec![(0, Cbor::Bool(true))])))
    }

    /// `set_file_headroom {0: collection, 1: headroom}` sets the file quota to
    /// the current file bytes plus `headroom` in one transaction and returns
    /// `{0: file bytes, 1: file quota}`. Setting it from usage read in the same
    /// transaction means a concurrent upload can't push the quota past what the
    /// control plane allocated. A headroom of 0 blocks new files and keeps the
    /// existing ones.
    pub(super) async fn set_file_headroom(&self, p: &Principal, params: &Cbor) -> Result<Outcome> {
        self.require_cp(p)?;
        let c = uuid_field(params, 0)?;
        let Some(Cbor::Uint(headroom)) = field(params, 1) else {
            return Err(bad_params("headroom"));
        };
        let mut tx = self.backend.begin(&c, Mode::Write).await?;
        let mut st = Self::load(&mut tx).await?;
        live(&st.meta)?;
        let file_bytes = Self::file_bytes(&mut tx, &st.meta).await?;
        st.meta.file_bytes = Some(file_bytes);
        st.meta.file_quota = file_bytes.saturating_add(*headroom);
        let file_quota = st.meta.file_quota;
        tx.write(Write::PutMeta(st.meta));
        tx.commit().await?;
        Ok(Outcome::plain(map(vec![
            (0, Cbor::Uint(file_bytes)),
            (1, Cbor::Uint(file_quota)),
        ])))
    }

    /// `storage_status {0: collection}` returns `{0: used bytes, 1: storage quota,
    /// 2: file bytes, 3: file quota}`.
    pub(super) async fn storage_status(&self, p: &Principal, params: &Cbor) -> Result<Outcome> {
        self.require_cp(p)?;
        let c = uuid_field(params, 0)?;
        let mut tx = self.backend.begin(&c, Mode::Read).await?;
        let state = Self::load(&mut tx).await?;
        live(&state.meta)?;
        let file_bytes = Self::file_bytes(&mut tx, &state.meta).await?;
        Ok(Outcome::plain(map(vec![
            (0, Cbor::Uint(state.meta.used_bytes)),
            (1, Cbor::Uint(state.meta.quotas.storage_bytes)),
            (2, Cbor::Uint(file_bytes)),
            (3, Cbor::Uint(state.meta.file_quota)),
        ])))
    }

    /// The collection's file bytes, derived once for a row without the counter.
    pub(super) async fn file_bytes<T: Txn>(tx: &mut T, meta: &CollectionMeta) -> Result<u64> {
        match meta.file_bytes {
            Some(bytes) => Ok(bytes),
            None => tx.committed_blob_bytes().await,
        }
    }

    /// Independently read the backend-owned immutable floor; a foreign or
    /// malformed record never becomes authoritative absence.
    async fn deletion_floor(
        &self,
        c: &Uuid,
    ) -> Result<Option<crate::deletion::CollectionDeletionRecord>> {
        let floor = self.backend.collection_deletion_floor(c).await?;
        if let Some(record) = floor {
            record.validate()?;
            if record.collection != *c {
                return Err(crate::deletion::CollectionDeletionRecord::unavailable());
            }
        }
        Ok(floor)
    }

    pub(crate) async fn refuse_deleted_floor(&self, c: &Uuid) -> Result<()> {
        if let Some(record) = self.deletion_floor(c).await? {
            let mut error = ServiceError::reason(Code::Gone, "collection_deletion_floor");
            error.details = Some(record.to_cbor());
            return Err(error);
        }
        Ok(())
    }

    fn terminal_params(params: &Cbor, count: usize) -> Result<Uuid> {
        let bad = || ServiceError::invalid("collection_deletion_request");
        let Cbor::Map(fields) = params else {
            return Err(bad());
        };
        if fields.len() != count
            || fields
                .iter()
                .enumerate()
                .any(|(i, (k, _))| *k != Cbor::Uint(i as u64))
        {
            return Err(bad());
        }
        let c = uuid_field(params, 0).map_err(|_| bad())?;
        if c == B16([0; 16]) {
            return Err(bad());
        }
        Ok(c)
    }

    /// Strict floor-bound durable Gone; no legacy/bare-bool request or receipt.
    pub(super) async fn delete_log(&self, p: &Principal, params: &Cbor) -> Result<Outcome> {
        self.require_cp(p)?;
        let c = Self::terminal_params(params, 3)?;
        let deletion_id = uuid_field(params, 1)
            .map_err(|_| ServiceError::invalid("collection_deletion_request"))?;
        let lifecycle_epoch = match field(params, 2) {
            Some(Cbor::Uint(n)) if *n > 0 => *n,
            _ => return Err(ServiceError::invalid("collection_deletion_request")),
        };
        if deletion_id == B16([0; 16]) {
            return Err(ServiceError::invalid("collection_deletion_request"));
        }
        let requested = crate::deletion::CollectionDeletionRecord {
            collection: c,
            deletion_id,
            lifecycle_epoch,
        };
        let floor = self
            .deletion_floor(&c)
            .await?
            .ok_or_else(crate::deletion::CollectionDeletionRecord::unavailable)?;
        if floor != requested {
            return Err(floor.conflict());
        }
        // The first floor is immutable: no successor can replace it between
        // this independent read and the collection's serialized terminal commit.
        let mut tx = self.backend.begin(&c, Mode::Write).await?;
        let mut st = Self::load(&mut tx).await?;
        if st.meta.id != c {
            return Err(crate::deletion::CollectionDeletionRecord::unavailable());
        }
        let result = map(vec![(0, Cbor::Bool(true)), (1, requested.to_cbor())]);
        if st.meta.status == Status::Gone {
            return match st.meta.deletion {
                Some(actual) if actual == requested => Ok(Outcome::plain(result)),
                Some(actual) => Err(actual.conflict()),
                None => Err(ServiceError::reason(
                    Code::Gone,
                    "collection_deletion_receipt_missing",
                )),
            };
        }
        if st.meta.deletion.is_some() {
            return Err(crate::deletion::CollectionDeletionRecord::unavailable());
        }
        st.meta.status = Status::Gone;
        st.meta.deletion = Some(requested);
        let notice = CommitNotice {
            collection: c,
            first: 0,
            head: st.meta.head,
            head_chain: st.meta.head_chain,
            revoked: vec![],
            gone: true,
        };
        tx.write(Write::PutMeta(st.meta));
        tx.write(Write::Notify(notice.clone()));
        tx.commit().await?;
        Ok(Outcome {
            result,
            notice: Some(notice),
            items: vec![],
            credentials_revoked: None,
            repair: None,
        })
    }

    /// CP-only serialized observation; absent/tupleless states never authorize.
    pub(super) async fn log_terminal_status(
        &self,
        p: &Principal,
        params: &Cbor,
    ) -> Result<Outcome> {
        self.require_cp(p)?;
        let c = Self::terminal_params(params, 1)?;
        let mut tx = self.backend.begin(&c, Mode::Write).await?;
        let (status, receipt) = match tx.load().await? {
            None => (0, Cbor::Null),
            Some(st) => {
                if st.meta.id != c {
                    return Err(crate::deletion::CollectionDeletionRecord::unavailable());
                }
                let status = match st.meta.status {
                    Status::Live => 1,
                    Status::Importing => 2,
                    Status::Gone => 3,
                };
                let receipt = match st.meta.deletion {
                    Some(record) => {
                        record.validate()?;
                        if record.collection != c || status != 3 {
                            return Err(crate::deletion::CollectionDeletionRecord::unavailable());
                        }
                        record.to_cbor()
                    }
                    None => Cbor::Null,
                };
                (status, receipt)
            }
        };
        Ok(Outcome::plain(map(vec![
            (0, Cbor::Uint(1)),
            (1, c.to_cbor()),
            (2, Cbor::Uint(status)),
            (3, receipt),
        ])))
    }
}
