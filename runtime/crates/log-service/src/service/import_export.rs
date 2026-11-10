//! Collection export and restore import (§12).

use super::*;

impl<B: Backend, O: ObjectStore> Service<B, O> {
    /// `export {0: collection, 1: after}` (§12): one page of every retained item, plus
    /// the head and retention, and the snapshots with their refs.
    ///
    /// Result: `{0: [[seq, item]], 1: [snapshot-pointer], 2: more, 3: head,
    /// 4: chain(head), 5: retained_from, 6: [[seq, [ref]]], 7: restore-settings}`.
    /// Objects are listed by `export_objects` and fetched with `get_object`
    /// (the control plane may read). Settings are operational metadata only;
    /// they never replace the signed policy projection.
    pub(super) async fn export(&self, p: &Principal, params: &Cbor) -> Result<Outcome> {
        self.require_cp(p)?;
        let c = uuid_field(params, 0)?;
        let after = match field(params, 1) {
            Some(Cbor::Uint(n)) => *n,
            _ => 0,
        };
        let mut tx = self.backend.begin(&c, Mode::Read).await?;
        let st = Self::load(&mut tx).await?;
        let items = tx
            .items(after, MAX_READ_ITEMS, MAX_READ_BYTES, false)
            .await?;
        let more = items.last().is_some_and(|i| i.seq < st.meta.head);
        let snaps = tx.snapshots().await?;
        let mut snap_refs = Vec::new();
        for sn in &snaps {
            let refs = tx.snapshot_refs(sn.seq).await?;
            snap_refs.push(Cbor::Array(vec![
                Cbor::Uint(sn.seq),
                Cbor::Array(refs.iter().map(|r| r.to_cbor()).collect()),
            ]));
        }
        Ok(Outcome::plain(map(vec![
            (
                0,
                Cbor::Array(
                    items
                        .into_iter()
                        .map(|i| {
                            SeqItem {
                                seq: i.seq,
                                item: Bytes(i.bytes),
                            }
                            .to_cbor()
                        })
                        .collect(),
                ),
            ),
            (
                1,
                Cbor::Array(snaps.iter().map(|s| Self::pointer(s).to_cbor()).collect()),
            ),
            (2, Cbor::Bool(more)),
            (3, Cbor::Uint(st.meta.head)),
            (4, st.meta.head_chain.to_cbor()),
            (5, Cbor::Uint(st.meta.retained_from)),
            (6, Cbor::Array(snap_refs)),
            (7, RestoreSettings::export(&st.meta)),
        ])))
    }

    /// `export_objects {0: collection, ? 1: after address}`: committed objects in
    /// address order, 1,000 per page. Result `{0: [[address, kind, size, checksum]], 1: more}`.
    pub(super) async fn export_objects(&self, p: &Principal, params: &Cbor) -> Result<Outcome> {
        self.require_cp(p)?;
        let c = uuid_field(params, 0)?;
        let after = field(params, 1).and_then(|v| B32::from_cbor(v).ok());
        let mut tx = self.backend.begin(&c, Mode::Read).await?;
        Self::load(&mut tx).await?;
        let objs = tx.list_objects(after, 1000).await?;
        let more = objs.len() == 1000;
        Ok(Outcome::plain(map(vec![
            (
                0,
                Cbor::Array(
                    objs.iter()
                        .map(|o| {
                            Cbor::Array(vec![
                                o.address.to_cbor(),
                                Cbor::Uint(o.kind),
                                Cbor::Uint(o.size),
                                o.checksum.to_cbor(),
                            ])
                        })
                        .collect(),
                ),
            ),
            (1, Cbor::Bool(more)),
        ])))
    }

    /// `import_object {0: collection, 1: address, 2: kind, 3: bytes}`: restore one
    /// object (verified like an upload; written write-once). Objects are imported
    /// before the items and snapshots that reference them.
    pub(super) async fn import_object(
        &self,
        p: &Principal,
        params: &Cbor,
        now: i64,
        budget: &Budget,
    ) -> Result<Outcome> {
        self.require_cp(p)?;
        let c = uuid_field(params, 0)?;
        self.refuse_deleted_floor(&c).await?;
        let a = field(params, 1)
            .and_then(|v| B32::from_cbor(v).ok())
            .ok_or_else(|| bad_params("address"))?;
        let kind = match field(params, 2) {
            Some(Cbor::Uint(k)) if matches!(k, 16..=19) => *k,
            _ => return Err(bad_params("kind")),
        };
        let bytes = match field(params, 3) {
            Some(Cbor::Bytes(b)) if b.len() as u64 <= MAX_OBJECT_BYTES => b.clone(),
            _ => return Err(bad_params("bytes")),
        };
        {
            // The genesis `import` page creates the collection (and fixes its region,
            // which picks the object bucket) before any object is imported.
            let mut tx = self.backend.begin(&c, Mode::Read).await?;
            match tx.load().await? {
                Some(st) if st.meta.status == Status::Importing => {}
                Some(_) => {
                    return Err(
                        ServiceError::invalid("state").msg("collection is not being imported")
                    );
                }
                None => {
                    return Err(ServiceError::invalid("state")
                        .msg("import the genesis page before objects"));
                }
            }
        }
        let ck = sha256(&bytes);
        validate_object_bytes(&c, &a, kind, bytes.len() as u64, &ck, &bytes, budget)?;
        self.finalize(&c, &a, kind, bytes, now, budget).await?;
        self.published_reply(&c, &a).await?;
        Ok(Outcome::plain(map(vec![(0, Cbor::Bool(true))])))
    }

    /// `import {0: collection, 1: [[seq, item]], ? 2: {0: retained_from,
    /// ? 1: expected_head, ? 2: expected_chain}, ? 3: restore-settings}`: restore
    /// exported items, in order, page by page (§12, gate 4). Settings are accepted
    /// only on the empty target's first genesis page, before object imports.
    ///
    /// The first page must start with the genesis item at position 1; the collection
    /// is then `unavailable` to everyone else until the final page (key 2) sets the
    /// retention and makes it live. Every item is re-verified exactly as an append
    /// would be (envelope, chain across consecutive positions, signatures, policy and
    /// epoch state, refs): a backup cannot smuggle in what the service would have
    /// refused. Compacted entry slots may be absent; strict plans bind every
    /// retained signed item, including every control item.
    pub(super) async fn import(
        &self,
        p: &Principal,
        params: &Cbor,
        now: i64,
        budget: &Budget,
    ) -> Result<Outcome> {
        self.require_cp(p)?;
        let c = uuid_field(params, 0)?;
        self.refuse_deleted_floor(&c).await?;
        let page: Vec<SeqItem> = match field(params, 1) {
            Some(Cbor::Array(a)) => a
                .iter()
                .map(SeqItem::from_cbor)
                .collect::<std::result::Result<_, _>>()
                .map_err(bad_params)?,
            _ => return Err(bad_params("items")),
        };
        let settings = field(params, 3).map(RestoreSettings::parse).transpose()?;
        let plan = field(params, 4).map(RestorePlan::parse).transpose()?;
        // Read on every page so a malformed one is refused; recorded only on creation.
        let region = Placement::from_field(field(params, 5))?.resolve_in(&self.regions)?;
        if plan.is_some() && settings.is_none() {
            return Err(ServiceError::invalid("restore_settings")
                .msg("strict restore requires source settings"));
        }
        let done = field(params, 2)
            .map(|d| match field(d, 0) {
                Some(Cbor::Uint(n)) => Ok(*n),
                _ => Err(bad_params("retained_from")),
            })
            .transpose()?;
        let expected = field(params, 2)
            .map(|d| match (field(d, 1), field(d, 2)) {
                (None, None) => Ok(None),
                (Some(Cbor::Uint(head)), Some(chain)) => B32::from_cbor(chain)
                    .map(|chain| Some((*head, chain)))
                    .map_err(|_| bad_params("restore_head")),
                _ => Err(bad_params("restore_head")),
            })
            .transpose()?
            .flatten();
        let mut tx = self.backend.begin(&c, Mode::Write).await?;
        let (mut ws, created) = match tx.load().await? {
            Some(st) if st.meta.status == Status::Importing => (st, false),
            Some(_) => return Err(ServiceError::invalid("state").msg("collection exists")),
            None => {
                let mut m = CollectionMeta::new(c, now);
                m.status = Status::Importing;
                m.region = region;
                (
                    CollectionState {
                        meta: m,
                        acl: BTreeMap::new(),
                    },
                    true,
                )
            }
        };
        if let Some(plan) = plan {
            if !created {
                return Err(
                    ServiceError::invalid("restore_plan").msg("plan requires an empty target")
                );
            }
            ws.meta.restore_plan = Some(plan);
        }
        if let Some(settings) = settings {
            if !created {
                return Err(ServiceError::invalid("restore_settings")
                    .msg("settings require an empty target"));
            }
            settings.apply(&mut ws.meta);
        }
        let strict = ws.meta.restore_plan.is_some();
        let before = ws.clone();
        let mut total = 0u64;
        for si in &page {
            let bytes = &si.item.0;
            let it = budget.wire::<Item>(bytes)?;
            it.check_shape()
                .map_err(|e| ServiceError::invalid("shape").msg(format!("seq {}: {e}", si.seq)))?;
            if it.collection != c
                || !it.kind.is_log_item()
                || it.seq != Some(si.seq)
                || si.seq <= ws.meta.head
            {
                return Err(ServiceError::invalid("shape").msg(format!("seq {}", si.seq)));
            }
            if si.seq == ws.meta.head + 1 {
                if it.prev != Some(ws.meta.head_chain) {
                    return Err(ServiceError::invalid("chain").msg(format!("seq {}", si.seq)));
                }
            } else if let Some(plan) = &ws.meta.restore_plan {
                // Strict archives bind EVERY retained item. A gap can only be
                // below their declared compaction boundary, including a gap
                // before a retained control item. Final item-root equality
                // ensures no omitted control/retained-entry slot is accepted.
                if ws.meta.head == 0 || si.seq > plan.retained_from {
                    return Err(ServiceError::invalid("chain").msg("gap outside compacted prefix"));
                }
            } else if it.kind.is_control() || ws.meta.head == 0 {
                // Legacy callers retain their existing gap validation.
                return Err(ServiceError::invalid("chain")
                    .msg(format!("gap before control item {}", si.seq)));
            }
            check_item(&mut ws, &it, si.seq, 0, &self.config.roots, budget)?;
            if let Some(refs) = &it.refs {
                let metas = tx.objects(refs).await?;
                if metas.iter().flatten().any(is_ref_index) {
                    return Err(ServiceError::invalid("kind").msg("ref-index outside a snapshot"));
                }
                if metas
                    .iter()
                    .any(|m| !m.as_ref().is_some_and(|m| m.committed))
                {
                    return Err(ServiceError::new(Code::RefsMissing).msg(format!("seq {}", si.seq)));
                }
            }
            if let Some(plan) = &mut ws.meta.restore_plan {
                plan.record(si.seq, bytes)?;
            }
            tx.write(Write::InsertItem(StoredItem {
                seq: si.seq,
                kind: it.kind.value(),
                bytes: bytes.clone(),
                appended_at: now,
                token: it.idem,
                refs: it.refs.clone().unwrap_or_default(),
            }));
            total += bytes.len() as u64;
            ws.meta.head = si.seq;
            ws.meta.head_chain = chain_hash(bytes);
        }
        ws.meta.used_bytes = ws
            .meta
            .used_bytes
            .checked_add(total)
            .ok_or_else(|| ServiceError::invalid("restore_accounting"))?;
        if ws
            .meta
            .restore_plan
            .as_ref()
            .is_some_and(|plan| ws.meta.used_bytes > plan.used_bytes || ws.meta.head > plan.head)
        {
            return Err(ServiceError::invalid("restore_accounting"));
        }
        if let Some(rf) = done {
            if expected
                .is_some_and(|(head, chain)| head != ws.meta.head || chain != ws.meta.head_chain)
            {
                return Err(ServiceError::invalid("restore_head"));
            }
            if rf > ws.meta.head + 1 || rf == 0 {
                return Err(bad_params("retained_from"));
            }
            ws.meta.retained_from = rf;
            if let Some(plan) = &ws.meta.restore_plan {
                plan.verify(&mut tx, &ws.meta).await?;
            }
            ws.meta.restore_plan = None;
            ws.meta.status = Status::Live;
        }
        if created {
            if ws.meta.head == 0 {
                return Err(ServiceError::invalid("shape").msg("first page must start at genesis"));
            }
            tx.write(Write::CreateCollection(CollectionState {
                meta: ws.meta.clone(),
                acl: ws.acl.clone(),
            }));
        } else {
            for (d, e) in &ws.acl {
                if before.acl.get(d) != Some(e) {
                    tx.write(Write::UpsertAcl(e.clone()));
                }
            }
            tx.write(Write::PutMeta(ws.meta.clone()));
        }
        // The publication fence, unless the backend's commit performs it.
        if !self.backend.fences_deletion_floor_at_commit() {
            self.refuse_deleted_floor(&c).await?;
        }
        tx.commit().await?;
        Ok(Outcome::plain(map(vec![
            (0, Cbor::Uint(ws.meta.head)),
            (1, ws.meta.head_chain.to_cbor()),
            (2, Cbor::Bool(ws.meta.status == Status::Live)),
            (3, Cbor::Bool(strict)),
        ])))
    }

    /// `import_snapshot {0: collection, 1: snapshot-pointer, 2: [refs]}`: restore a
    /// snapshot pointer (its objects must already be imported).
    pub(super) async fn import_snapshot(&self, p: &Principal, params: &Cbor) -> Result<Outcome> {
        self.require_cp(p)?;
        let c = uuid_field(params, 0)?;
        self.refuse_deleted_floor(&c).await?;
        let ptr = field(params, 1)
            .and_then(|v| SnapshotPointer::from_cbor(v).ok())
            .ok_or_else(|| bad_params("pointer"))?;
        let mut refs: Vec<B32> = match field(params, 2) {
            Some(Cbor::Array(a)) => a.iter().filter_map(|v| B32::from_cbor(v).ok()).collect(),
            _ => return Err(bad_params("refs")),
        };
        let mut tx = self.backend.begin(&c, Mode::Write).await?;
        let st = Self::load(&mut tx).await?;
        if st.meta.status != Status::Importing || ptr.seq > st.meta.head {
            return Err(ServiceError::invalid("state"));
        }
        if st.meta.restore_plan.is_some() {
            if !matches!(field(params, 2), Some(Cbor::Array(a)) if a.len() == refs.len()) {
                return Err(bad_params("refs"));
            }
            // Expanded refs are a set: persist the same unique canonical edges
            // that the authenticated inventory binds, not duplicate refcounts.
            refs.sort();
            refs.dedup();
            if !refs.contains(&ptr.manifest) {
                return Err(ServiceError::new(Code::RefsMissing));
            }
        }
        let metas = tx.objects(&refs).await?;
        if metas
            .iter()
            .any(|m| !m.as_ref().is_some_and(|m| m.committed))
        {
            return Err(ServiceError::new(Code::RefsMissing));
        }
        tx.write(Write::InsertSnapshot(SnapshotRow {
            seq: ptr.seq,
            manifest: ptr.manifest,
            author: ptr.author,
            created_at: ptr.created_at,
            endorsed: ptr.endorsed,
            refs,
        }));
        if !self.backend.fences_deletion_floor_at_commit() {
            self.refuse_deleted_floor(&c).await?;
        }
        tx.commit().await?;
        Ok(Outcome::plain(map(vec![(0, Cbor::Bool(true))])))
    }
}
