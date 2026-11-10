//! Batched publication of create runs and already-held files.

use super::*;

impl<P: FilePlatform, M: Store, D: DiskDb> FileStore<P, M, D> {
    /// The leading run of `publishes` that [`Self::publish_batch`] may take:
    /// creates of distinct paths on an immediate commit of at least
    /// [`BATCH_MIN`] publishes. Those already on disk are recorded in `held`
    /// as they are met. Returns how many publishes the run spans (0: none)
    /// and the creates still to write, in order.
    pub(super) async fn create_run<'p>(
        &mut self,
        publishes: &'p [Publish],
        held: &mut AlreadyHeld,
    ) -> StoreResult<(usize, Vec<&'p Publish>)> {
        if !self.immediate
            || !matches!(
                self.strategy(),
                ReplaceStrategy::Exchange | ReplaceStrategy::LockedInPlace
            )
            || publishes.len() < BATCH_MIN
        {
            return Ok((0, Vec::new()));
        }
        let mut paths = BTreeSet::new();
        let mut run = Vec::new();
        let mut taken = 0;
        for p in publishes {
            let Publish::Write {
                path,
                expect: RExpect::Absent,
                ..
            } = p
            else {
                break;
            };
            if crate::platform::portable_violation(path).is_some() || !paths.insert(path.as_str()) {
                break;
            }
            if !self.already_held(p, held).await? {
                run.push(p);
            }
            taken += 1;
        }
        Ok((taken, run))
    }

    /// Publish plain creates together: journal every intent in one write,
    /// write every temp unsynced, one barrier, then each no-replace rename
    /// without a directory sync, one full flush, and every outcome in one
    /// write. A crash anywhere leaves journaled intents that recovery settles
    /// exactly as for single publishes (a temp never renamed is not
    /// published; a renamed one is flushed before it is recorded).
    pub(super) async fn publish_batch(&mut self, run: Vec<&Publish>) -> StoreResult<Vec<Drift>> {
        mdbn_replica::mirror_admission::ensure_open(&self.inner)?;
        let private = self.p.capabilities().private_dir.clone();
        let mut drifts = Vec::new();
        let mut changes = Vec::new();
        let mut items = Vec::new();
        for publ in run {
            let Publish::Write {
                id, path, content, ..
            } = publ
            else {
                unreachable!("create_run takes creates only");
            };
            if self.link_in_path(path).await? {
                drifts.push(Self::drift(publ, "symlink_in_path"));
                continue;
            }
            let op = PublishOp {
                path: Self::rel(path)?,
                expect: Expect::Absent,
                new: Some(self.content_bytes(content)?),
            };
            let n = self.take_name(&mut changes);
            let rec = IntentRec {
                strategy: self.strategy(),
                op,
                n,
                id: *id,
                retained_nosync: self.p.retained_nosync(),
            };
            changes.push((Kind::Intent, counter_bytes(n), Some(rec.to_bytes())));
            items.push((publ, rec));
        }
        self.db
            .apply(std::mem::take(&mut changes))
            .map_err(db_err)?;
        let opts = Options {
            sync_temp: false,
            sync_dir: false,
            ..self.options()
        };
        let mut ours = Vec::with_capacity(items.len());
        {
            let admitted = admitted::Admitted {
                p: &*self.p,
                inner: &self.inner,
            };
            for (_, rec) in &items {
                let names = rec.names(&private);
                let dir = rec.op.path.parent();
                if !dir.is_root() {
                    admitted.create_dir_all(&dir).await.map_err(fs_err)?;
                }
                let new = rec.op.new.as_deref().unwrap_or_default();
                let m = admitted
                    .write_new(&names.tmp, new, false)
                    .await
                    .map_err(fs_err)?;
                ours.push(m.id);
            }
            admitted.flush(FlushScope::Barrier).await.map_err(fs_err)?;
        }
        let mut published_any = false;
        let mut retire = Vec::with_capacity(items.len());
        for ((publ, rec), our) in items.into_iter().zip(ours) {
            let names = rec.names(&private);
            let outcome = {
                let admitted = admitted::Admitted {
                    p: &*self.p,
                    inner: &self.inner,
                };
                crate::publish::publish_prewritten(&admitted, &rec.op, &names, &opts, our).await
            };
            published_any |= matches!(outcome, Outcome::Published { .. });
            // A failure leaves every intent of the batch journaled (nothing of
            // it is recorded before the flush): the next open recovers them.
            match self
                .settle_publish(&mut changes, &rec.op, rec.id, outcome)
                .await?
            {
                Ok(None) => {}
                Ok(Some(why)) => drifts.push(Self::drift(publ, why)),
                Err(e) => return Err(fs_err(e)),
            }
            retire.push(counter_bytes(rec.n));
        }
        if published_any {
            // Required commit point before any of these bytes count as ours.
            self.p.flush(FlushScope::Full).await.map_err(fs_err)?;
        }
        mdbn_replica::mirror_admission::ensure_open(&self.inner)?;
        changes.extend(retire.into_iter().map(|k| (Kind::Intent, k, None)));
        self.db.apply(changes).map_err(db_err)?;
        Ok(drifts)
    }

    /// A create whose path already holds exactly the new bytes (a folder
    /// adopted with its files in place, an install resumed after a crash,
    /// including a publish recovered and recorded at reopen):
    /// record the file as on disk without writing a temp, renaming or
    /// flushing. Anything less than an exact match (other bytes, a symlink,
    /// a name that only matches by case or normalization) takes the normal
    /// publish, which leaves the user's file alone and reports a drift.
    /// Immediate commits only: a host that queues and polls IO keeps the
    /// original IO sequence it accounts for.
    pub(super) async fn already_held(
        &mut self,
        publ: &Publish,
        held: &mut AlreadyHeld,
    ) -> StoreResult<bool> {
        let Publish::Write {
            id,
            path,
            expect: RExpect::Absent,
            content,
        } = publ
        else {
            return Ok(false);
        };
        if !self.immediate
            || self.strategy() == ReplaceStrategy::ReadOnly
            || crate::platform::portable_violation(path).is_some()
        {
            return Ok(false);
        }
        let rp = Self::rel(path)?;
        let new = self.content_bytes(content)?;
        // Already recorded here (a publish recovered after a crash): only as
        // these very bytes for this ID, and the file must still hold them.
        if self
            .disk
            .get(path.as_str())
            .is_some_and(|row| row.rev != revision(&new) || row.id != *id)
        {
            return Ok(false);
        }
        let meta = match self.observe_io(|| self.p.stat(&rp)).await? {
            Ok(m) if m.kind == FileKind::File && m.size == new.len() as u64 => m,
            _ => return Ok(false),
        };
        if self.link_in_path(path).await? || !self.exact_name(&rp, held).await? {
            return Ok(false);
        }
        let read = match self.observe_io(|| self.p.read(&rp)).await? {
            Ok(r) => r,
            Err(_) => return Ok(false),
        };
        if read.bytes != new || read.meta.size != meta.size || read.meta.mtime_ns != meta.mtime_ns {
            return Ok(false);
        }
        mdbn_replica::mirror_admission::ensure_open(&self.inner)?;
        let st = self.state_from(*id, revision(&new), &read.meta, false);
        self.set_disk(&mut held.changes, path, Some(st));
        self.stats.already_held += 1;
        Ok(true)
    }

    /// Whether `path`'s last segment is spelled exactly as on disk. Only a
    /// case- or normalization-insensitive volume can resolve a different
    /// spelling to the same file; there the parent is listed once per commit.
    async fn exact_name(&mut self, path: &RelPath, held: &mut AlreadyHeld) -> StoreResult<bool> {
        if self.p.capabilities().case != CaseSensitivity::Insensitive {
            return Ok(true);
        }
        let dir = path.parent();
        if !held.names.contains_key(&dir) {
            let names = match self.observe_io(|| self.p.list(&dir)).await? {
                Ok(entries) => entries.into_iter().map(|e| e.name).collect(),
                Err(_) => BTreeSet::new(),
            };
            held.names.insert(dir.clone(), names);
        }
        Ok(held.names[&dir].contains(path.file_name()))
    }

    pub(super) fn flush_held(&mut self, held: &mut AlreadyHeld) -> StoreResult<()> {
        if held.changes.is_empty() {
            return Ok(());
        }
        self.db
            .apply(std::mem::take(&mut held.changes))
            .map_err(db_err)
    }
}
