//! Object upload, commit, download and presence (§6).

use super::*;

impl<B: Backend, O: ObjectStore> Service<B, O> {
    // ------------------------------------------------------------------ objects (§6)

    /// Validate object bytes (§6 "Validation").
    pub fn validate_object(
        c: &Uuid,
        address: &B32,
        kind: u64,
        size: u64,
        checksum: &B32,
        bytes: &[u8],
    ) -> Result<()> {
        validate_object_bytes(c, address, kind, size, checksum, bytes, &Budget::default())
    }

    async fn active_device(&self, p: &Principal, c: &Uuid) -> Result<CollectionState> {
        let mut tx = self.backend.begin(c, Mode::Read).await?;
        let state = Self::load(&mut tx).await?;
        if matches!(p, Principal::ControlPlane) {
            return Err(ServiceError::reason(Code::Forbidden, "principal"));
        }
        Self::authorize(&state, p)?;
        live(&state.meta)?;
        Ok(state)
    }

    // A dedup response is a publication decision too. Keep the current Gone
    // check and committed lookup under the same exclusive collection boundary.
    // The independent floor is read ONCE, after that boundary is released: a
    // floor is immutable once written, so "absent now" implies it was absent
    // when the committed state was read, and the reply linearizes there. The
    // registry round trip no longer holds the producer lock.
    async fn object_committed_current(&self, c: &Uuid, address: &B32) -> Result<bool> {
        let committed = {
            let mut tx = self.backend.begin(c, Mode::Write).await?;
            let state = Self::load(&mut tx).await?;
            if state.meta.status == Status::Gone {
                return Err(ServiceError::new(Code::Gone));
            }
            tx.objects(&[*address])
                .await?
                .pop()
                .flatten()
                .is_some_and(|m| m.committed)
        };
        self.refuse_deleted_floor(c).await?;
        Ok(committed)
    }

    /// Returns whether this call committed the row through a commit that itself
    /// fenced the floor ([`Backend::fences_deletion_floor_at_commit`]). Only then
    /// may a caller with no later external await reply without another floor read
    /// (as `append` does). Otherwise callers reply only after a later
    /// [`Self::object_committed_current`], which re-reads the floor; the dedup
    /// return below is never a reply by itself.
    async fn record_object(&self, c: &Uuid, meta: ObjectMeta) -> Result<bool> {
        let mut tx = self.backend.begin(c, Mode::Write).await?;
        let mut state = Self::load(&mut tx).await?;
        // Terminal deletion dominates dedup and quota. Importing remains valid
        // for the existing CP-only verified restore path; live() would reject it.
        if state.meta.status == Status::Gone {
            return Err(ServiceError::new(Code::Gone));
        }
        let existing = tx.objects(&[meta.address]).await?.pop().flatten();
        if existing.as_ref().is_some_and(|e| e.committed) {
            return Ok(false); // first committed object wins (I8)
        }
        if meta.committed {
            // The early PUT check is advisory: uploads may race or the quota
            // may change while their bytes are staged. This exclusive WriteTX
            // owns the final quota check, accounting and object insertion.
            let exceeded = || ServiceError::new(Code::QuotaExceeded);
            let file = meta.kind == ItemKind::BlobPart.value();
            let file_bytes = Self::file_bytes(&mut tx, &state.meta).await?;
            let used_bytes = state
                .meta
                .used_bytes
                .checked_add(meta.size)
                .ok_or_else(exceeded)?;
            let new_file_bytes = if file {
                file_bytes.checked_add(meta.size).ok_or_else(exceeded)?
            } else {
                file_bytes
            };
            let importing = state.meta.status == Status::Importing;
            let fits = match state.meta.restore_plan.as_ref().filter(|_| importing) {
                // A strict restore reproduces the source's bytes exactly.
                Some(plan) => used_bytes <= plan.used_bytes,
                // Backups don't carry the file quota, so a restore can't be held
                // to it; the control plane allocates one once the copy is live.
                None if file => importing || new_file_bytes <= state.meta.file_quota,
                None => {
                    log_bytes(&state.meta, file_bytes) + meta.size
                        <= state.meta.quotas.storage_bytes
                }
            };
            if !fits {
                return Err(exceeded());
            }
            state.meta.used_bytes = used_bytes;
            state.meta.file_bytes = Some(new_file_bytes);
            tx.write(Write::PutMeta(state.meta));
        }
        let fenced = meta.committed && self.backend.fences_deletion_floor_at_commit();
        tx.write(Write::PutObject(meta));
        // The publication fence: one floor read after every local decision and
        // immediately before the atomic commit. A backend whose commit performs
        // exactly this refusal itself (under its producer lock) is not asked twice.
        if !self.backend.fences_deletion_floor_at_commit() {
            self.refuse_deleted_floor(c).await?;
        }
        tx.commit().await?;
        Ok(fenced)
    }

    /// `put_object`.
    pub async fn put_object(
        &self,
        p: &Principal,
        q: PutObjectParams,
        now: i64,
    ) -> Result<PutObjectResult> {
        let budget = Budget::default();
        self.scoped(&budget)
            .put_object_with_budget(p, q, now, &budget)
            .await
    }

    /// Put an object within the enclosing request's budget.
    pub async fn put_object_with_budget(
        &self,
        p: &Principal,
        q: PutObjectParams,
        now: i64,
        budget: &Budget,
    ) -> Result<PutObjectResult> {
        let c = q.collection;
        let kind = q.kind.value();
        if !matches!(
            q.kind,
            ItemKind::Manifest | ItemKind::Chunk | ItemKind::BlobPart | ItemKind::RefIndex
        ) {
            return Err(ServiceError::invalid("kind"));
        }
        if q.size > MAX_OBJECT_BYTES {
            return Err(ServiceError::reason(Code::TooLarge, "object"));
        }
        if q.bytes
            .as_ref()
            .is_some_and(|b| b.0.len() as u64 > MAX_INLINE_OBJECT_BYTES)
        {
            return Err(ServiceError::reason(Code::TooLarge, "inline"));
        }
        // Snapshot objects are content-addressed: refuse a mismatch up front.
        if q.kind != ItemKind::BlobPart && q.checksum != q.address {
            return Err(ServiceError::invalid("address"));
        }
        let state = self.active_device(p, &c).await?;
        let Principal::Device { id: device, .. } = *p else {
            return Err(ServiceError::reason(Code::Forbidden, "principal"));
        };
        if self.object_committed_current(&c, &q.address).await? {
            return Ok(PutObjectResult {
                status: PutStatus::Exists,
                direct: None,
            });
        }
        // Advisory: a row without the file counter is checked at commit.
        let file_bytes = state.meta.file_bytes.unwrap_or(0);
        let (used, limit) = if q.kind == ItemKind::BlobPart {
            (file_bytes, state.meta.file_quota)
        } else {
            (
                log_bytes(&state.meta, file_bytes),
                state.meta.quotas.storage_bytes,
            )
        };
        if used.checked_add(q.size).is_none_or(|used| used > limit) {
            return Err(ServiceError::new(Code::QuotaExceeded));
        }
        match q.bytes {
            Some(b) => {
                validate_object_bytes(&c, &q.address, kind, q.size, &q.checksum, &b.0, budget)?;
                // A publication through a commit-time fence is answered at that
                // commit, with no external await after it: a further floor read
                // is one more registry round trip and decides nothing.
                if !self
                    .finalize(&c, &q.address, kind, b.0, now, budget)
                    .await?
                {
                    self.published_reply(&c, &q.address).await?;
                }
                Ok(PutObjectResult {
                    status: PutStatus::Stored,
                    direct: None,
                })
            }
            // No metadata until commit: the upload goes to this device's staging key.
            None => Ok(PutObjectResult {
                status: PutStatus::Upload,
                direct: Some(self.direct(
                    state.meta.region,
                    Some(&device),
                    &c,
                    &q.address,
                    q.size,
                    &q.checksum,
                    now,
                )),
            }),
        }
    }

    /// Write verified bytes to the final key **write-once** and record them. If the
    /// final key already holds bytes (an earlier commit, or a crash after the copy),
    /// those bytes win (I8) and are re-verified before they are recorded.
    /// Returns [`Self::record_object`]'s fenced-publication result.
    pub(super) async fn finalize(
        &self,
        c: &Uuid,
        a: &B32,
        kind: u64,
        bytes: Vec<u8>,
        now: i64,
        budget: &Budget,
    ) -> Result<bool> {
        // Every caller has just read the floor in object_committed_current; the
        // publication itself is fenced in record_object/commit and, unless that
        // commit fenced it, re-read after.
        let key = object_key(c, a);
        let mut size = bytes.len() as u64;
        let mut checksum = sha256(&bytes);
        if !self
            .objects
            .put_new_with_budget(&key, bytes, budget)
            .await?
        {
            let existing = self
                .objects
                .get(&key, None)
                .await?
                .ok_or_else(|| ServiceError::backend("object vanished"))?;
            size = existing.len() as u64;
            checksum = sha256(&existing);
            validate_object_bytes(c, a, kind, size, &checksum, &existing, budget)
                .map_err(|e| e.msg("existing object fails verification: integrity incident"))?;
        }
        self.record_object(
            c,
            ObjectMeta {
                address: *a,
                kind,
                size,
                checksum,
                committed: true,
                created_at: now,
            },
        )
        .await
    }

    /// The reply-time read after a publication: exactly one floor lookup,
    /// after every external await of the request (copy, cleanup).
    pub(super) async fn published_reply(&self, c: &Uuid, a: &B32) -> Result<bool> {
        if !self.object_committed_current(c, a).await? {
            return Err(ServiceError::backend("object publication missing"));
        }
        Ok(true)
    }

    /// `commit_object` after a direct upload.
    pub async fn commit_object(
        &self,
        p: &Principal,
        q: CommitObjectParams,
        now: i64,
    ) -> Result<bool> {
        let budget = Budget::default();
        self.scoped(&budget)
            .commit_object_with_budget(p, q, now, &budget)
            .await
    }

    /// Commit an object within the enclosing request's budget.
    pub async fn commit_object_with_budget(
        &self,
        p: &Principal,
        q: CommitObjectParams,
        now: i64,
        budget: &Budget,
    ) -> Result<bool> {
        let c = q.collection;
        self.active_device(p, &c).await?;
        let Principal::Device { id: device, .. } = *p else {
            return Err(ServiceError::reason(Code::Forbidden, "principal"));
        };
        if self.object_committed_current(&c, &q.address).await? {
            return Ok(true);
        }
        let staged = staging_key(&c, &q.address, &device);
        let final_key = object_key(&c, &q.address);
        // Streamed path: the upload host verified the bytes as they arrived and
        // recorded it; the actor checks the record and copies without buffering.
        // The copy to the write-once final key is not a publication; the
        // metadata commit is, and record_object fences it.
        let copied = self
            .objects
            .copy_verified_new(&staged, &final_key, |v| check_verified(&q.address, v))
            .await?;
        if let VerifiedCopy::Refused(e) = copied {
            self.objects.delete(&staged).await?;
            return Err(e);
        }
        if let VerifiedCopy::Copied { verified, wrote } = copied {
            let v = if wrote {
                verified
            } else {
                // First committed object wins (I8): describe what is there.
                self.objects
                    .verified_meta(&final_key)
                    .await?
                    .ok_or_else(|| {
                        ServiceError::backend("final object without verification record")
                    })?
            };
            self.record_object(
                &c,
                ObjectMeta {
                    address: q.address,
                    kind: v.kind,
                    size: v.size,
                    checksum: v.checksum,
                    committed: true,
                    created_at: now,
                },
            )
            .await?;
            self.objects.delete(&staged).await?;
            // Cleanup is an external await: do not emit a stale success after
            // deletion, even when metadata committed before that await.
            return self.object_committed_current(&c, &q.address).await;
        }
        let Some(bytes) = self.objects.get(&staged, None).await? else {
            return self.object_committed_current(&c, &q.address).await;
        };
        let kind = match verify_upload_with_budget(&c, &q.address, &bytes, budget) {
            Ok(v) => v.kind,
            Err(e) => {
                // Request resource refusal is NOT evidence that staged bytes
                // are corrupt. Preserve them for a minimal fresh-budget retry.
                // Only actual integrity/protocol failure authorizes cleanup.
                if !crate::decode::is_resource_refusal(&e) {
                    self.objects.delete(&staged).await?;
                }
                return Err(e);
            }
        };
        self.finalize(&c, &q.address, kind, bytes, now, budget)
            .await?;
        self.objects.delete(&staged).await?;
        self.published_reply(&c, &q.address).await
    }

    /// `get_object`.
    pub async fn get_object(
        &self,
        p: &Principal,
        q: GetObjectParams,
        now: i64,
    ) -> Result<GetObjectResult> {
        let c = q.collection;
        let mut tx = self.backend.begin(&c, Mode::Read).await?;
        let state = Self::load(&mut tx).await?;
        Self::authorize(&state, p)?;
        not_gone(&state.meta)?;
        let meta = tx
            .objects(&[q.address])
            .await?
            .pop()
            .flatten()
            .filter(|m| m.committed)
            .ok_or_else(|| ServiceError::new(Code::NotFound))?;
        drop(tx);
        let key = object_key(&c, &q.address);
        let fetch = |range| async move {
            self.objects.get(&key, range).await?.ok_or_else(|| {
                ServiceError::new(Code::NotFound).msg("object bytes missing: integrity incident")
            })
        };
        if let Some(r) = q.range {
            if r.offset
                .checked_add(r.len)
                .is_none_or(|end| end > meta.size)
                || r.len > MAX_OBJECT_BYTES
            {
                return Err(ServiceError::invalid("range"));
            }
            let b = fetch(Some((r.offset, r.len))).await?;
            return Ok(GetObjectResult {
                bytes: Some(Bytes(b)),
                direct: None,
                size: meta.size,
                checksum: meta.checksum,
            });
        }
        if meta.size <= MAX_INLINE_OBJECT_BYTES {
            let b = fetch(None).await?;
            return Ok(GetObjectResult {
                bytes: Some(Bytes(b)),
                direct: None,
                size: meta.size,
                checksum: meta.checksum,
            });
        }
        Ok(GetObjectResult {
            bytes: None,
            direct: Some(self.direct(
                state.meta.region,
                None,
                &c,
                &q.address,
                meta.size,
                &meta.checksum,
                now,
            )),
            size: meta.size,
            checksum: meta.checksum,
        })
    }

    /// `has_objects`.
    pub async fn has_objects(
        &self,
        p: &Principal,
        q: HasObjectsParams,
    ) -> Result<HasObjectsResult> {
        if q.addresses.len() > MAX_HAS_OBJECTS {
            return Err(ServiceError::reason(Code::TooLarge, "addresses"));
        }
        let mut tx = self.backend.begin(&q.collection, Mode::Read).await?;
        let state = Self::load(&mut tx).await?;
        Self::authorize(&state, p)?;
        not_gone(&state.meta)?;
        let metas = tx.objects(&q.addresses).await?;
        Ok(HasObjectsResult {
            present: metas
                .iter()
                .map(|m| m.as_ref().is_some_and(|m| m.committed))
                .collect(),
        })
    }
}
