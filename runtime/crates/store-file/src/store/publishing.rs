//! Publishing one change: content, expectations, the publish itself and case-only moves.

use super::*;

impl<P: FilePlatform, M: Store, D: DiskDb> FileStore<P, M, D> {
    // ------------------------------------------------------------ publish

    pub(super) fn content_bytes(&self, c: &Content) -> StoreResult<Vec<u8>> {
        match c {
            Content::Text(t) => Ok(t.as_bytes().to_vec()),
            Content::Blob(h) => {
                if let Some(original) = self.queued.active_blobs.get(h) {
                    return Ok(original.clone());
                }
                let size = self
                    .inner
                    .blob_size(h)?
                    .ok_or_else(|| StoreError::Io(format!("blob {h:?} not in the local cache")))?;
                self.inner.blob_read(h, 0, size)
            }
        }
    }

    pub(super) fn rel(path: &str) -> StoreResult<RelPath> {
        RelPath::new(path).map_err(|e| StoreError::Io(format!("bad publish path: {e}")))
    }

    /// Turn the replica's expectation into the protocol's. In-place strategies
    /// need the expected bytes for the journal (torn-write recovery), so they
    /// read them now; a mismatch is an immediate drift.
    async fn expect_for(
        &self,
        path: &RelPath,
        e: RExpect,
    ) -> StoreResult<Result<Expect, &'static str>> {
        match e {
            RExpect::Absent => Ok(Ok(Expect::Absent)),
            RExpect::Revision(h) if self.strategy() == ReplaceStrategy::Exchange => {
                Ok(Ok(Expect::Rev(h)))
            }
            RExpect::Revision(h) => match self.observe_io(|| self.p.read(path)).await? {
                Ok(r) if revision(&r.bytes) == h => Ok(Ok(Expect::Bytes(r.bytes))),
                Ok(_) => Ok(Err("changed")),
                Err(e) if e.is_not_found() => Ok(Err("missing")),
                Err(e) => Err(fs_err(e)),
            },
        }
    }

    /// One publish step: journal, perform, record. Returns a drift reason.
    async fn publish_one(
        &mut self,
        op: PublishOp,
        id: Option<Uuid>,
    ) -> StoreResult<Option<&'static str>> {
        mdbn_replica::mirror_admission::ensure_open(&self.inner)?;
        let private = self.p.capabilities().private_dir.clone();
        let mut changes = Vec::new();
        let n = self.take_name(&mut changes);
        let rec = IntentRec {
            strategy: self.strategy(),
            op: op.clone(),
            n,
            id,
            retained_nosync: self.p.retained_nosync(),
        };
        let key = counter_bytes(n);
        changes.push((Kind::Intent, key.clone(), Some(rec.to_bytes())));
        self.db
            .apply(std::mem::take(&mut changes))
            .map_err(db_err)?;
        let names = rec.names(&private);
        let opts = self.options();
        let admitted = admitted::Admitted {
            p: &*self.p,
            inner: &self.inner,
        };
        let outcome = publish(&admitted, &op, &names, &opts).await;
        let reason = match self.settle_publish(&mut changes, &op, id, outcome).await? {
            Ok(reason) => reason,
            Err(e) => {
                // Original intent/names/bytes stay journaled for recovery.
                self.db.apply(changes).map_err(db_err)?;
                return Err(fs_err(e));
            }
        };
        mdbn_replica::mirror_admission::ensure_open(&self.inner)?;
        changes.push((Kind::Intent, key, None));
        self.db.apply(changes).map_err(db_err)?;
        Ok(reason)
    }

    /// Record one publish outcome in `changes`: the drift reason (`None` when
    /// published), or the platform failure, after which the intent must stay.
    pub(super) async fn settle_publish(
        &mut self,
        changes: &mut Vec<Change>,
        op: &PublishOp,
        id: Option<Uuid>,
        outcome: Outcome,
    ) -> StoreResult<Result<Option<&'static str>, FsError>> {
        let path = op.path.as_str().to_string();
        Ok(Ok(match outcome {
            Outcome::Published { retained } => {
                self.stats.published += 1;
                match &op.new {
                    Some(new) => {
                        self.record_published_async(changes, &op.path, id, new)
                            .await?
                    }
                    None => self.set_disk(changes, &path, None),
                }
                if let Some(r) = retained {
                    self.retain_async(changes, r, &path, id).await;
                }
                None
            }
            Outcome::Drifted {
                retained,
                preserved,
            } => {
                self.stats.drifted += 1;
                if let Some(r) = retained {
                    self.retain_async(changes, r, &path, id).await;
                }
                if let Some(h) = preserved {
                    self.add_evidence(changes, &path, h, op.expect.rev(), false);
                }
                self.dirty.insert(path.clone(), self.now());
                let gone = matches!(self.observe_io(|| self.p.stat(&op.path)).await?, Err(e) if e.is_not_found());
                Some(if gone { "missing" } else { "changed" })
            }
            Outcome::Busy => {
                // Retry remains Replica-owned; never restart an in-flight task.
                self.stats.drifted += 1;
                self.dirty
                    .insert(path.clone(), self.now() + self.cfg.quiescence_ms);
                Some("locked")
            }
            Outcome::Failed(e) => return Ok(Err(e)),
        }))
    }

    /// Whether an existing ancestor folder of `path` is not a real directory
    /// (a symlink, or a file). Missing ancestors are created by the publish.
    pub(super) async fn link_in_path(&self, path: &str) -> StoreResult<bool> {
        let rp = Self::rel(path)?;
        let mut dir = rp.parent();
        let mut ancestors = Vec::new();
        while !dir.is_root() {
            ancestors.push(dir.clone());
            dir = dir.parent();
        }
        for a in ancestors.iter().rev() {
            match self.observe_io(|| self.p.stat(a)).await? {
                Ok(m) if m.kind == FileKind::Dir => {}
                Ok(_) => return Ok(true),
                Err(e) if e.is_not_found() => return Ok(false),
                Err(e) => return Err(fs_err(e)),
            }
        }
        Ok(false)
    }

    pub(super) fn drift(p: &Publish, reason: &str) -> Drift {
        Drift {
            publish: p.clone(),
            reason: reason.to_string(),
        }
    }

    fn same_name_on_volume(&self, a: &str, b: &str) -> bool {
        a == b
            || (self.p.capabilities().case == CaseSensitivity::Insensitive
                && a.to_lowercase() == b.to_lowercase())
    }

    pub(super) async fn perform(&mut self, publ: &Publish) -> StoreResult<Option<Drift>> {
        if self.strategy() == ReplaceStrategy::ReadOnly {
            return Ok(Some(Self::drift(publ, "read_only")));
        }
        let paths: Vec<&str> = match publ {
            Publish::Write { path, .. } | Publish::Delete { path, .. } => vec![path],
            Publish::Move { from, to, .. } => vec![from, to],
        };
        if paths
            .iter()
            .any(|p| crate::platform::portable_violation(p).is_some())
        {
            return Ok(Some(Self::drift(publ, "invalid_path")));
        }
        for p in &paths {
            if self.link_in_path(p).await? {
                return Ok(Some(Self::drift(publ, "symlink_in_path")));
            }
        }
        match publ {
            Publish::Write {
                id,
                path,
                expect,
                content,
            } => {
                let rp = Self::rel(path)?;
                let expect = match self.expect_for(&rp, *expect).await? {
                    Ok(e) => e,
                    Err(why) => return Ok(Some(Self::drift(publ, why))),
                };
                let new = self.content_bytes(content)?;
                let r = self
                    .publish_one(
                        PublishOp {
                            path: rp,
                            expect,
                            new: Some(new),
                        },
                        *id,
                    )
                    .await?;
                Ok(r.map(|why| Self::drift(publ, why)))
            }
            Publish::Delete { id, path, expect } => {
                let rp = Self::rel(path)?;
                let expect = match self.expect_for(&rp, *expect).await? {
                    Ok(e) => e,
                    Err(why) => return Ok(Some(Self::drift(publ, why))),
                };
                let r = self
                    .publish_one(
                        PublishOp {
                            path: rp,
                            expect,
                            new: None,
                        },
                        *id,
                    )
                    .await?;
                Ok(r.map(|why| Self::drift(publ, why)))
            }
            Publish::Move {
                id,
                from,
                to,
                expect,
                content,
            } => {
                let rf = Self::rel(from)?;
                let rt = Self::rel(to)?;
                let RExpect::Revision(h) = *expect else {
                    return Ok(Some(Self::drift(publ, "missing")));
                };
                let cur = match self.observe_io(|| self.p.read(&rf)).await? {
                    Ok(r) if revision(&r.bytes) == h => r.bytes,
                    Ok(_) => return Ok(Some(Self::drift(publ, "changed"))),
                    Err(e) if e.is_not_found() => return Ok(Some(Self::drift(publ, "missing"))),
                    Err(e) => return Err(fs_err(e)),
                };
                let new = match content {
                    Some(c) => self.content_bytes(c)?,
                    None => cur.clone(),
                };
                if self.same_name_on_volume(from, to) {
                    return self
                        .case_only_move(publ, &rf, &rt, h, cur, new, Some(*id))
                        .await;
                }
                // Create the destination before conditionally removing source.
                if let Some(why) = self
                    .publish_one(
                        PublishOp {
                            path: rt,
                            expect: Expect::Absent,
                            new: Some(new),
                        },
                        Some(*id),
                    )
                    .await?
                {
                    return Ok(Some(Self::drift(publ, why)));
                }
                let expect = match self.expect_for(&rf, RExpect::Revision(h)).await? {
                    Ok(e) => e,
                    Err(why) => return Ok(Some(Self::drift(publ, why))),
                };
                let r = self
                    .publish_one(
                        PublishOp {
                            path: rf,
                            expect,
                            new: None,
                        },
                        Some(*id),
                    )
                    .await?;
                Ok(r.map(|why| Self::drift(publ, why)))
            }
        }
    }

    /// A rename that only changes case (or normalization) on a volume that
    /// treats both names as one file: a direct create would collide with the
    /// file itself, so go through a private name (Android deletes the file
    /// on a direct case-only rename).
    #[allow(clippy::too_many_arguments)]
    async fn case_only_move(
        &mut self,
        publ: &Publish,
        from: &RelPath,
        to: &RelPath,
        h: Hash,
        cur: Vec<u8>,
        new: Vec<u8>,
        id: Option<Uuid>,
    ) -> StoreResult<Option<Drift>> {
        // Both phases keep their own original journaled intent and retained bytes.
        let expect = if self.strategy() == ReplaceStrategy::Exchange {
            Expect::Rev(h)
        } else {
            Expect::Bytes(cur)
        };
        if let Some(why) = self
            .publish_one(
                PublishOp {
                    path: from.clone(),
                    expect,
                    new: None,
                },
                id,
            )
            .await?
        {
            return Ok(Some(Self::drift(publ, why)));
        }
        let r = self
            .publish_one(
                PublishOp {
                    path: to.clone(),
                    expect: Expect::Absent,
                    new: Some(new),
                },
                id,
            )
            .await?;
        Ok(r.map(|why| Self::drift(publ, why)))
    }
}
