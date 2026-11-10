//! Conditional append (§4).

use super::*;

impl<B: Backend, O: ObjectStore> Service<B, O> {
    // ------------------------------------------------------------------ append (§4)

    /// Conditional append (§4.1).
    pub async fn append(&self, p: &Principal, params: AppendParams, now: i64) -> Result<Outcome> {
        let budget = Budget::default();
        self.scoped(&budget)
            .append_with_budget(p, params, now, &budget)
            .await
    }

    /// Append with one budget shared across every item and nested payload.
    pub async fn append_with_budget(
        &self,
        p: &Principal,
        params: AppendParams,
        now: i64,
        budget: &Budget,
    ) -> Result<Outcome> {
        let c = params.collection;
        let n = params.items.len();
        // Step 3 (cheap part, before taking the actor): counts and sizes.
        if n == 0 {
            return Err(ServiceError::invalid("shape").msg("empty batch"));
        }
        if n > MAX_BATCH_ITEMS {
            return Err(ServiceError::reason(Code::TooLarge, "batch_items"));
        }
        // Positions are ≥ 1 and the batch's last position must not overflow.
        if params.expect_seq == 0 || params.expect_seq.checked_add(n as u64).is_none() {
            return Err(ServiceError::invalid("shape").msg("expect_seq"));
        }
        let total: u64 = params.items.iter().map(|b| b.0.len() as u64).sum();
        if total > MAX_BATCH_BYTES {
            return Err(ServiceError::reason(Code::TooLarge, "batch_bytes"));
        }
        let mut repair_items = 0u64;
        let mut items = Vec::with_capacity(n);
        for (i, b) in params.items.iter().enumerate() {
            if b.0.len() as u64 > MAX_ITEM_BYTES {
                return Err(ServiceError::reason(Code::TooLarge, "item_bytes"));
            }
            let it = budget.wire::<Item>(&b.0)?;
            it.check_shape()
                .map_err(|e| ServiceError::invalid("shape").msg(format!("item {i}: {e}")))?;
            if it.collection != c || !it.kind.is_log_item() {
                return Err(
                    ServiceError::invalid("shape").msg(format!("item {i}: collection or kind"))
                );
            }
            if it.seq != Some(params.expect_seq + i as u64) {
                return Err(ServiceError::invalid("shape").msg(format!("item {i}: seq")));
            }
            if it
                .refs
                .as_ref()
                .is_some_and(|r| r.len() > MAX_REFS_PER_ITEM)
            {
                return Err(ServiceError::reason(Code::TooLarge, "refs"));
            }
            // Kinds per principal (§3). A device may also upload items signed by
            // another principal (a repair append): it can only restore a lost
            // item, because seq and prev are signed and the head must match.
            // Authorization is then the signer's, checked at the item's position
            // (check_item); the uploader only needs to be an active device.
            match p {
                Principal::ControlPlane => {
                    if it.kind != ItemKind::Policy {
                        return Err(ServiceError::reason(Code::Forbidden, "kind"));
                    }
                }
                Principal::Device { id, .. } => {
                    if it.signer != Some(*id) {
                        repair_items += 1;
                    }
                }
            }
            items.push(it);
        }
        let content = items
            .iter()
            .any(|i| matches!(i.kind, ItemKind::Entry | ItemKind::Base));

        let mut tx = self.backend.begin(&c, Mode::Write).await?;
        // Steps 1–2.
        let state = Self::load(&mut tx).await?;
        Self::authorize(&state, p)?;
        live(&state.meta)?;

        // Step 4: idempotent replay (I4), before the quota so that a retry of an
        // append that already landed gets its receipt.
        let head = state.meta.head;
        if params.expect_seq <= head {
            let stored = tx
                .items(params.expect_seq - 1, n as u64, u64::MAX, false)
                .await?;
            let same = stored.len() == n
                && stored
                    .iter()
                    .zip(&params.items)
                    .all(|(s, b)| s.seq >= params.expect_seq && s.bytes == b.0);
            if same {
                let last = stored.last().unwrap();
                return Ok(Outcome::plain(
                    AppendResult::Appended(Appended {
                        first: params.expect_seq,
                        last: last.seq,
                        head_chain: chain_hash(&last.bytes),
                        appended_at: last.appended_at,
                    })
                    .to_cbor(),
                ));
            }
        }
        // Files have their own quota, so a collection full of files can still
        // append entries, including the deletes that free space.
        let file_bytes = if content {
            let file_bytes = Self::file_bytes(&mut tx, &state.meta).await?;
            if log_bytes(&state.meta, file_bytes) + total > state.meta.quotas.storage_bytes {
                return Err(ServiceError::new(Code::QuotaExceeded));
            }
            Some(file_bytes)
        } else {
            state.meta.file_bytes
        };
        // Step 5: head check (I2).
        if params.expect_seq != head + 1 || params.expect_prev != state.meta.head_chain {
            return Ok(Outcome::plain(
                AppendResult::HeadMoved(HeadMoved {
                    head,
                    head_chain: state.meta.head_chain,
                })
                .to_cbor(),
            ));
        }
        // Rate limit (§11), after replay so that a retry is never throttled.
        if let Principal::Device { id, .. } = p {
            self.rate_check(&c, &state.meta.quotas, n as u64, total, now)?;
            if repair_items > 0 {
                self.repair_rate_check(id, repair_items, now)?;
            }
        }
        // Step 6: chain within the batch.
        let mut prev = params.expect_prev;
        for (i, (it, b)) in items.iter().zip(&params.items).enumerate() {
            if it.prev != Some(prev) {
                return Err(ServiceError::invalid("chain").msg(format!("item {i}")));
            }
            prev = chain_hash(&b.0);
        }
        // Steps 7–8: signatures and the policy gate, item by item on a working copy,
        // so that each item is judged by policy at the position before it.
        let mut ws = state.clone();
        let mut revoked = Vec::new();
        for (i, it) in items.iter().enumerate() {
            let seq = params.expect_seq + i as u64;
            revoked.extend(check_item(&mut ws, it, seq, i, &self.config.roots, budget)?);
        }
        // Step 9: idempotency tokens (I5).
        let mut tokens = Vec::new();
        let mut token_idx = Vec::new();
        let mut seen = BTreeSet::new();
        for (i, it) in items.iter().enumerate() {
            if let Some(t) = it.idem {
                if !seen.insert(t) {
                    return Err(
                        ServiceError::invalid("shape").msg("token repeated within the batch")
                    );
                }
                tokens.push(t);
                token_idx.push(i);
            }
        }
        if !tokens.is_empty() {
            let found = tx.tokens(&tokens, now).await?;
            if let Some((k, seq)) = found
                .iter()
                .enumerate()
                .find_map(|(k, s)| s.map(|s| (k, s)))
            {
                return Ok(Outcome::plain(
                    AppendResult::Duplicate(Duplicate {
                        index: token_idx[k] as u64,
                        seq,
                    })
                    .to_cbor(),
                ));
            }
        }
        // Step 10: refs.
        let refs: Vec<B32> = items
            .iter()
            .flat_map(|i| i.refs.iter().flatten().copied())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        if !refs.is_empty() {
            let metas = tx.objects(&refs).await?;
            if metas.iter().flatten().any(is_ref_index) {
                return Err(ServiceError::invalid("kind").msg("ref-index outside a snapshot"));
            }
            let missing: Vec<Cbor> = refs
                .iter()
                .zip(metas)
                .filter(|(_, m)| !m.as_ref().is_some_and(|m| m.committed))
                .map(|(a, _)| Cbor::Bytes(a.0.to_vec()))
                .collect();
            if !missing.is_empty() {
                let mut e = ServiceError::new(Code::RefsMissing);
                e.details = Some(Cbor::Array(missing));
                return Err(e);
            }
        }
        // Step 11: commit atomically.
        let mut pushed = Vec::with_capacity(n);
        for (i, (it, b)) in items.iter().zip(&params.items).enumerate() {
            let seq = params.expect_seq + i as u64;
            tx.write(Write::InsertItem(StoredItem {
                seq,
                kind: it.kind.value(),
                bytes: b.0.clone(),
                appended_at: now,
                token: it.idem,
                refs: it.refs.clone().unwrap_or_default(),
            }));
            pushed.push((seq, b.0.clone()));
        }
        ws.meta.head = params.expect_seq + n as u64 - 1;
        ws.meta.head_chain = prev;
        ws.meta.used_bytes += total;
        ws.meta.file_bytes = file_bytes;
        for (d, e) in &ws.acl {
            if state.acl.get(d) != Some(e) {
                tx.write(Write::UpsertAcl(e.clone()));
            }
        }
        tx.write(Write::PutMeta(ws.meta.clone()));
        let notice = CommitNotice {
            collection: c,
            first: params.expect_seq,
            head: ws.meta.head,
            head_chain: prev,
            revoked,
            gone: false,
        };
        tx.write(Write::Notify(notice.clone()));
        tx.commit().await?;
        Ok(Outcome {
            result: AppendResult::Appended(Appended {
                first: params.expect_seq,
                last: ws.meta.head,
                head_chain: prev,
                appended_at: now,
            })
            .to_cbor(),
            notice: Some(notice),
            items: pushed,
            credentials_revoked: None,
            repair: match p {
                Principal::Device { id, .. } if repair_items > 0 => Some(RepairAppend {
                    collection: c,
                    uploader: *id,
                    first: params.expect_seq,
                    last: ws.meta.head,
                    foreign_items: repair_items,
                }),
                _ => None,
            },
        })
    }
}
