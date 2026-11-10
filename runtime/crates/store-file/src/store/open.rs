//! Opening a store and crash recovery of leftover publish intents.

use super::*;

impl<P: FilePlatform, M: Store, D: DiskDb> FileStore<P, M, D> {
    /// Open a store: load the file store's state, create the private
    /// directories, and recover leftover publish intents. The first
    /// [`Store::observe`] then scans the whole tree. This convenience requires
    /// an immediate platform; suspending hosts retain [`FileStore::start_open`].
    pub fn open(
        p: Rc<P>,
        inner: M,
        db: D,
        clock: Box<dyn Clock>,
        cfg: Config,
    ) -> StoreResult<Self> {
        Self::start_open(p, inner, db, clock, cfg).finish_immediate()
    }

    /// Start opening without dropping a future when its host IO suspends.
    /// The host retains this owner and polls it after completing original ops.
    pub fn start_open<'a>(
        p: Rc<P>,
        inner: M,
        db: D,
        clock: Box<dyn Clock>,
        cfg: Config,
    ) -> crate::opening::Opening<'a, P, M, D>
    where
        P: 'a,
        M: 'a,
        D: 'a,
    {
        let timers = Timers::default();
        timers.set_now(clock.now_ms());
        crate::opening::Opening::new(
            timers.clone(),
            Self::open_task(p, inner, db, clock, cfg, timers),
        )
    }

    async fn open_task(
        p: Rc<P>,
        inner: M,
        db: D,
        clock: Box<dyn Clock>,
        cfg: Config,
        timers: Timers,
    ) -> StoreResult<Self> {
        if mdbn_replica::mirror_admission::Fence::load(&inner)?.is_some() {
            return Err(StoreError::Io(
                "mirror admission closed: skip filesystem recovery".into(),
            ));
        }
        let release = cfg.release.unwrap_or_else(|| p.release_policy());
        let mut s = FileStore {
            p,
            inner,
            db,
            clock,
            cfg,
            release,
            timers,
            disk: BTreeMap::new(),
            disk_revs: BTreeMap::new(),
            disk_ids: BTreeMap::new(),
            seen: BTreeMap::new(),
            retained: BTreeMap::new(),
            session: 0,
            reclaimed: Vec::new(),
            evidence: BTreeMap::new(),
            outstanding: BTreeMap::new(),
            refused_resource_sets: Vec::new(),
            outstanding_at: BTreeMap::new(),
            next_name: 1,
            next_obs: 1,
            dirty: BTreeMap::new(),
            missing: BTreeMap::new(),
            appeared: BTreeMap::new(),
            rescan: true,
            deferred: false,
            commit_active: Rc::new(Cell::new(false)),
            queued: deferred::Deferred::default(),
            immediate: false,
            stats: Stats::default(),
        };
        s.timers.set_now(s.clock.now_ms());
        let mut intents = Vec::new();
        for (kind, key, v) in s.db.load().map_err(db_err)? {
            let bad = || StoreError::Corrupt(format!("file store row {kind:?}"));
            match kind {
                Kind::Disk => {
                    let path = String::from_utf8(key).map_err(|_| bad())?;
                    s.put_disk(path, DiskState::from_bytes(&v).ok_or_else(bad)?);
                }
                Kind::Seen => {
                    let path = String::from_utf8(key).map_err(|_| bad())?;
                    s.seen
                        .insert(path, DiskState::from_bytes(&v).ok_or_else(bad)?);
                }
                Kind::Intent => intents.push((key, IntentRec::from_bytes(&v).ok_or_else(bad)?)),
                Kind::Retained => {
                    let r = RetainedRec::from_bytes(&v).ok_or_else(bad)?;
                    s.retained.insert(r.r.path.clone(), r);
                }
                Kind::Observation => {
                    let id = counter_of(&key).ok_or_else(bad)?;
                    s.evidence
                        .insert(id, EvidenceRec::from_bytes(&v).ok_or_else(bad)?);
                }
                Kind::Counter => match key.as_slice() {
                    b"name" => s.next_name = counter_of(&v).ok_or_else(bad)?,
                    b"obs" => s.next_obs = counter_of(&v).ok_or_else(bad)?,
                    b"retention-session" => s.session = counter_of(&v).ok_or_else(bad)?,
                    _ => {}
                },
            }
        }
        if matches!(s.release, ReleasePolicy::NextLaunch { .. }) {
            if s.retained.values().any(|r| r.session > s.session) {
                return Err(StoreError::Corrupt(
                    "retention session exceeds persisted counter".into(),
                ));
            }
            s.session = s
                .session
                .checked_add(1)
                .ok_or_else(|| StoreError::Corrupt("retention session exhausted".into()))?;
            // Any closed-admission front-door guard must precede this write,
            // exactly as it must precede directory creation/recovery below.
            s.db.apply(vec![(
                Kind::Counter,
                b"retention-session".to_vec(),
                Some(counter_bytes(s.session)),
            )])
            .map_err(db_err)?;
        }
        let private = s.p.capabilities().private_dir.clone();
        // Also create legacy stash for recovery: an old journal keeps its
        // original name even when this platform now selects retained.nosync.
        let mut dirs = Names::dirs(&private).to_vec();
        if s.p.retained_nosync() {
            dirs.push(private.join("retained.nosync").map_err(fs_err)?);
        }
        for d in dirs {
            s.p.create_dir_all(&d).await.map_err(fs_err)?;
        }
        s.recover_intents(intents).await?;
        Ok(s)
    }

    // ------------------------------------------------------------ recovery

    async fn recover_intents(&mut self, intents: Vec<(Vec<u8>, IntentRec)>) -> StoreResult<()> {
        let private = self.p.capabilities().private_dir.clone();
        let mut changes = Vec::new();
        let mut flushed_any = false;
        for (key, rec) in intents {
            let it = Intent {
                strategy: rec.strategy,
                op: rec.op.clone(),
                names: rec.names(&private),
            };
            let r = recover(&*self.p, &it).await.map_err(fs_err)?;
            self.stats.recovered += 1;
            let path = rec.op.path.as_str().to_string();
            // A recovered publish may not be durable: the process crashed
            // before its flush. Make it durable before recording these bytes as
            // known, or a later power loss brings the old bytes back under a
            // disk state that says they are ours, and they get ingested as a
            // user edit rather than treated as a recovered publish.
            // - exchange/rename (Linux, macOS; creates and deletes everywhere):
            //   the directory entry;
            // - in-place (Windows D, vault): the file's data.
            // If the flush fails (e.g. a sharing violation on Windows), the
            // bytes are not recorded as known: the path is re-observed instead,
            // which is safe, and the store still opens.
            let mut state = r.state;
            if state == State::Published {
                let in_place = rec.op.new.is_some()
                    && rec.op.expect != Expect::Absent
                    && matches!(
                        rec.strategy,
                        ReplaceStrategy::LockedInPlace | ReplaceStrategy::GuardedInPlace
                    );
                let scope = if in_place {
                    FlushScope::File(rec.op.path.clone())
                } else {
                    FlushScope::Dir(rec.op.path.parent())
                };
                if self.p.flush(scope).await.is_err() {
                    state = State::Drifted;
                } else {
                    flushed_any = true;
                }
            }
            match (state, &rec.op.new) {
                (State::Published, Some(new)) => {
                    self.record_published_async(&mut changes, &rec.op.path, rec.id, new)
                        .await?
                }
                (State::Published, None) => self.set_disk(&mut changes, &path, None),
                // Not published: the disk state stays as it was.
                (State::NotPublished, _) => {}
                (State::Drifted, _) => {
                    self.dirty.insert(path.clone(), self.now());
                }
            }
            for ret in r.retained {
                self.retain_async(&mut changes, ret, &path, rec.id).await;
            }
            for pres in r.preserved {
                self.add_evidence(&mut changes, &path, pres, rec.op.expect.rev(), true);
            }
            changes.push((Kind::Intent, key, None));
        }
        // One device-level commit point for everything recovered: a plain
        // directory fsync doesn't flush the drive cache on macOS (use
        // F_FULLFSYNC at the commit point). Rare (recovery only), so cheap.
        if flushed_any {
            // Required commit point: do not persist trusted bytes or retire
            // intents if the drive cache was not flushed. Opening fails with
            // the original durable intents intact, so a later open can retry.
            self.p.flush(FlushScope::Full).await.map_err(fs_err)?;
        }
        self.db.apply(changes).map_err(db_err)
    }
}
