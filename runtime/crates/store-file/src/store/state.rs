//! Accessors, watcher intake and bookkeeping of the in-memory disk and observation state.

use super::*;

impl<P: FilePlatform, M: Store, D: DiskDb> FileStore<P, M, D> {
    /// Drain content-free local retention diagnostics. Never contains note paths.
    pub fn take_reclaimed(&mut self) -> Vec<Reclaimed> {
        std::mem::take(&mut self.reclaimed)
    }

    /// The inner store.
    pub fn inner(&self) -> &M {
        &self.inner
    }

    /// The platform.
    pub fn platform(&self) -> &Rc<P> {
        &self.p
    }

    /// What the store believes is at `path`.
    pub fn disk_state(&self, path: &str) -> Option<&DiskState> {
        self.disk.get(path)
    }

    /// What the store last knew was on disk at `path`: its own publishes and
    /// acknowledged observations, without reading the file. The replica uses it
    /// (with [`FileStore::disk_paths`]) to reconcile the folder at open; these
    /// become the `Store::disk_revision`/`disk_paths` overrides once the corresponding
    /// trait methods are available.
    pub fn disk_revision(&self, path: &str) -> Option<Hash> {
        self.disk.get(path).map(|d| d.rev)
    }

    /// Every path the store last knew to hold bytes, with revisions, by path.
    pub fn disk_paths(&self) -> Vec<(String, Hash)> {
        self.disk.iter().map(|(p, d)| (p.clone(), d.rev)).collect()
    }

    /// Feed watcher events. They only queue paths; [`Store::observe`] reads.
    pub fn on_events(&mut self, events: &[crate::platform::FileEvent]) {
        let now = self.now();
        for e in events {
            if e.kind == crate::platform::FileEventKind::Rescan {
                self.rescan = true;
                continue;
            }
            if self.is_private(&e.path) {
                continue;
            }
            self.dirty
                .insert(e.path.as_str().to_string(), now + self.cfg.quiescence_ms);
        }
    }

    /// Request a full scan on the next observe (lost events, resume).
    pub fn request_rescan(&mut self) {
        self.rescan = true;
    }

    /// When the store next has work (quiescence, re-checks, settling), in host ms.
    pub fn next_wakeup(&self) -> Option<u64> {
        let a = self.dirty.values().copied();
        let pressure = match self.release {
            ReleasePolicy::AfterRetention => false,
            ReleasePolicy::NextLaunch { cap_bytes, .. } => {
                self.retained
                    .values()
                    .map(|r| u128::from(r.size.unwrap_or(u64::MAX)))
                    .sum::<u128>()
                    > u128::from(cap_bytes)
            }
        };
        let b = self.retained.values().filter_map(|r| {
            let parked = Parked {
                since: r.since,
                session: r.session,
                size: r.size,
            };
            if pressure && r.session == self.session {
                Some(r.since.saturating_add(self.cfg.retention_ms))
            } else {
                retention::deadline(self.release, self.cfg.retention_ms, self.session, &parked)
            }
        });
        let c = self.missing.values().map(|m| {
            if m.confirmed {
                m.first_seen + self.cfg.move_window_ms
            } else {
                m.first_seen + self.cfg.missing_recheck_ms
            }
        });
        let d = self
            .appeared
            .values()
            .map(|a| a.since + self.cfg.move_window_ms);
        a.chain(b).chain(c).chain(d).min()
    }

    // ------------------------------------------------------------ helpers

    /// Close a deferred-durability window before an outside effect (a file
    /// written, moved or removed): the effect must never be visible while the
    /// commits it follows could still be lost.
    pub(super) fn end_deferral(&mut self) -> StoreResult<()> {
        if self.deferred {
            // Closed even on error: the inner store fences an uncertain barrier.
            self.deferred = false;
            // Commits first, then the acknowledgements of them.
            self.inner.defer_durability(false)?;
            self.db.defer_sync(false).map_err(db_err)?;
        }
        Ok(())
    }

    pub(super) fn now(&self) -> u64 {
        let n = self.clock.now_ms();
        self.timers.set_now(n);
        self.timers.now()
    }

    pub(super) fn run<F: std::future::Future>(&self, f: F) -> StoreResult<F::Output> {
        run_ready(&self.timers, f).ok_or_else(suspended)
    }

    pub(super) async fn observe_io<F: std::future::Future>(
        &self,
        operation: impl FnOnce() -> F,
    ) -> StoreResult<F::Output> {
        // Check before constructing a queued future: construction itself may
        // issue the original request. Pending resumes cannot bypass closure.
        mdbn_replica::mirror_admission::ensure_open(&self.inner)?;
        Ok(operation().await)
    }

    pub(super) fn is_private(&self, p: &RelPath) -> bool {
        let private = self.p.capabilities().private_dir.as_str();
        p.as_str() == private || p.as_str().starts_with(&format!("{private}/"))
    }

    pub(super) fn strategy(&self) -> ReplaceStrategy {
        self.p.capabilities().replace
    }

    pub(super) fn options(&self) -> Options {
        Options {
            share: self.cfg.lock_share,
            ..Options::default()
        }
    }

    pub(super) fn take_name(&mut self, changes: &mut Vec<Change>) -> u64 {
        let n = self.next_name;
        self.next_name += 1;
        changes.push((
            Kind::Counter,
            b"name".to_vec(),
            Some(counter_bytes(self.next_name)),
        ));
        n
    }

    pub(super) fn take_obs(&mut self, changes: &mut Vec<Change>) -> u64 {
        let n = self.next_obs;
        self.next_obs += 1;
        changes.push((
            Kind::Counter,
            b"obs".to_vec(),
            Some(counter_bytes(self.next_obs)),
        ));
        n
    }

    pub(super) fn state_from(
        &self,
        id: Option<Uuid>,
        rev: Hash,
        m: &FileMeta,
        ours: bool,
    ) -> DiskState {
        DiskState {
            id,
            rev,
            size: m.size,
            mtime_ns: m.mtime_ns,
            ctime_ns: m.ctime_ns,
            file_id: m.id,
            ours,
        }
    }

    /// Drop the hash memo of `path` (gone, or now known through `disk`).
    pub(super) fn forget_seen(&mut self, changes: &mut Vec<Change>, path: &str) {
        if self.seen.remove(path).is_some() {
            changes.push((Kind::Seen, path.as_bytes().to_vec(), None));
        }
    }

    pub(super) fn set_disk(
        &mut self,
        changes: &mut Vec<Change>,
        path: &str,
        st: Option<DiskState>,
    ) {
        self.forget_seen(changes, path);
        match st {
            Some(st) => {
                changes.push((Kind::Disk, path.as_bytes().to_vec(), Some(st.to_bytes())));
                self.put_disk(path.to_string(), st);
            }
            None => {
                changes.push((Kind::Disk, path.as_bytes().to_vec(), None));
                self.remove_disk(path);
            }
        }
    }

    /// `disk` insert, keeping `disk_revs`/`disk_ids` in step.
    pub(super) fn put_disk(&mut self, path: String, st: DiskState) {
        *self.disk_revs.entry(st.rev).or_default() += 1;
        if let Some(id) = st.file_id {
            *self.disk_ids.entry(id).or_default() += 1;
        }
        if let Some(old) = self.disk.insert(path, st) {
            self.unindex_disk(&old);
        }
    }

    /// `disk` remove, keeping `disk_revs`/`disk_ids` in step.
    fn remove_disk(&mut self, path: &str) {
        if let Some(old) = self.disk.remove(path) {
            self.unindex_disk(&old);
        }
    }

    fn unindex_disk(&mut self, old: &DiskState) {
        fn dec<K: Ord>(m: &mut BTreeMap<K, u32>, k: &K) {
            if let Some(n) = m.get_mut(k) {
                *n -= 1;
                if *n == 0 {
                    m.remove(k);
                }
            }
        }
        dec(&mut self.disk_revs, &old.rev);
        if let Some(id) = &old.file_id {
            dec(&mut self.disk_ids, id);
        }
    }

    /// `outstanding` insert, keeping `outstanding_at` in step.
    pub(super) fn put_outstanding(&mut self, token: u64, o: Outstanding) {
        self.take_outstanding(token);
        self.outstanding_at
            .entry(o.path.clone())
            .or_default()
            .insert(token);
        self.outstanding.insert(token, o);
    }

    /// `outstanding` remove, keeping `outstanding_at` in step.
    pub(super) fn take_outstanding(&mut self, token: u64) -> Option<Outstanding> {
        let o = self.outstanding.remove(&token)?;
        self.unindex_outstanding(token, &o.path);
        Some(o)
    }

    fn unindex_outstanding(&mut self, token: u64, path: &str) {
        if let Some(set) = self.outstanding_at.get_mut(path) {
            set.remove(&token);
            if set.is_empty() {
                self.outstanding_at.remove(path);
            }
        }
    }

    pub(super) async fn retain_async(
        &mut self,
        changes: &mut Vec<Change>,
        r: crate::publish::Retained,
        user_path: &str,
        id: Option<Uuid>,
    ) {
        let size = self
            .observe_io(|| self.p.stat(&r.path))
            .await
            .ok()
            .and_then(Result::ok)
            .filter(|meta| meta.kind == FileKind::File)
            .map(|meta| meta.size);
        self.retain_with_size(changes, r, user_path, id, size);
    }

    fn retain_with_size(
        &mut self,
        changes: &mut Vec<Change>,
        r: crate::publish::Retained,
        user_path: &str,
        id: Option<Uuid>,
        size: Option<u64>,
    ) {
        let rec = RetainedRec {
            r,
            user_path: user_path.to_string(),
            since: self.now(),
            session: self.session,
            size,
            id,
        };
        changes.push((
            Kind::Retained,
            rec.r.path.as_str().as_bytes().to_vec(),
            Some(rec.to_bytes()),
        ));
        self.retained.insert(rec.r.path.clone(), rec);
    }

    pub(super) fn add_evidence(
        &mut self,
        changes: &mut Vec<Change>,
        path: &str,
        evidence: RelPath,
        base: Option<Hash>,
        suspect: bool,
    ) {
        let id = self.take_obs(changes);
        let rec = EvidenceRec {
            path: path.to_string(),
            evidence,
            base,
            suspect,
        };
        changes.push((Kind::Observation, counter_bytes(id), Some(rec.to_bytes())));
        self.evidence.insert(id, rec);
    }

    /// Stat the path after our publish and record it as ours. If the stat
    /// fails or disagrees, the state is recorded with an impossible size so
    /// the next observation re-reads the file instead of trusting it.
    pub(super) async fn record_published_async(
        &mut self,
        changes: &mut Vec<Change>,
        path: &RelPath,
        id: Option<Uuid>,
        new: &[u8],
    ) -> StoreResult<()> {
        let rev = revision(new);
        let result = self.observe_io(|| self.p.stat(path)).await?;
        mdbn_replica::mirror_admission::ensure_open(&self.inner)?;
        let st = match result {
            Ok(m) if m.kind == FileKind::File && m.size == new.len() as u64 => {
                self.state_from(id, rev, &m, true)
            }
            _ => {
                self.dirty.insert(path.as_str().to_string(), self.now());
                DiskState {
                    id,
                    rev,
                    size: u64::MAX,
                    mtime_ns: 0,
                    ctime_ns: None,
                    file_id: None,
                    ours: true,
                }
            }
        };
        self.set_disk(changes, path.as_str(), Some(st));
        Ok(())
    }
}
