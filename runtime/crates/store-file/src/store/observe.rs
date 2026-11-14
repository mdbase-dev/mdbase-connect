//! Observation entry points and the resource-source observation tasks.

use super::check::Found;
use super::*;

/// How a path came to be checked in one pass.
enum Source {
    /// The store's own state or the watcher named it: inclusion is tested first.
    Known,
    /// This pass's walk listed it, having tested inclusion and the name, with
    /// the metadata the listing carried.
    Walked(Option<FileMeta>),
}

impl<P: FilePlatform, M: Store, D: DiskDb> FileStore<P, M, D> {
    /// Start a retained observation scan with captured paths. Pending exclusively
    /// borrows this store; poll the same owner after original host IO completes.
    pub fn start_observe(&mut self, paths: Option<&[String]>) -> crate::observing::Observing<'_> {
        let paths = paths.map(<[String]>::to_vec);
        let timers = self.timers.clone();
        crate::observing::Observing::new(timers, self.observe_task(paths))
    }

    pub(super) async fn observe_task(
        &mut self,
        paths: Option<Vec<String>>,
    ) -> StoreResult<Vec<Observation>> {
        self.ensure_commit_available()?;
        self.ensure_queue_drained()?;
        mdbn_replica::mirror_admission::ensure_open(&self.inner)?;
        // Retention and move settlement may have outside effects.
        self.end_deferral()?;
        let mut out = Vec::new();
        let mut changes = Vec::new();
        let scanned = self
            .observe_batch(paths.as_deref(), &mut changes, &mut out)
            .await
            .and_then(|()| mdbn_replica::mirror_admission::ensure_open(&self.inner));
        let persisted = self.db.apply(changes).map_err(db_err);
        if scanned.is_err() || persisted.is_err() {
            self.rescan = true;
            // These observations have never been delivered. Keep ORIGINAL
            // tokens/base and explicitly arm revalidation/redelivery, rather
            // than losing a partial capture or reminting after terminal error.
            for observation in &out {
                if let Some(original) = self.outstanding.get_mut(&observation.token.0) {
                    original.deferred = true;
                }
            }
        }
        persisted?;
        scanned?;
        Ok(out)
    }

    async fn observe_batch(
        &mut self,
        paths: Option<&[String]>,
        changes: &mut Vec<Change>,
        out: &mut Vec<Observation>,
    ) -> StoreResult<()> {
        let now_ms = self.now();
        self.settle_retained(changes).await?;
        self.deliver_evidence(out).await?;
        let settings = self.inner.settings()?;
        let mut todo: BTreeMap<String, Source> = BTreeMap::new();
        // A full walk lists every file and checks every known one: nothing to
        // expand.
        let full_walk = paths.is_none() && self.rescan;
        match paths {
            Some(ps) => todo.extend(ps.iter().map(|p| (p.clone(), Source::Known))),
            None => {
                if self.rescan {
                    let mut found = BTreeMap::new();
                    let mut unsupported = BTreeMap::new();
                    self.walk(&RelPath::ROOT, &settings, &mut found, &mut unsupported)
                        .await?;
                    self.rescan = false;
                    self.stats.unsupported_entries = unsupported.len() as u64;
                    unsupported.extend(
                        self.stats
                            .unsupported_paths
                            .iter()
                            .filter(|(path, _)| found.contains_key(*path))
                            .map(|(path, reason)| (path.clone(), reason.clone())),
                    );
                    self.stats.unsupported_paths = unsupported;
                    for p in self.disk.keys().chain(self.seen.keys()) {
                        if !found.contains_key(p) {
                            todo.insert(p.clone(), Source::Known);
                        }
                    }
                    todo.extend(found.into_iter().map(|(p, meta)| (p, Source::Walked(meta))));
                }
                let due: Vec<String> = self
                    .dirty
                    .iter()
                    .filter(|(_, d)| **d <= now_ms)
                    .map(|(p, _)| p.clone())
                    .collect();
                for p in due {
                    todo.entry(p).or_insert(Source::Known);
                }
            }
        }
        let mut checked = BTreeSet::new();
        let mut folders = Vec::new();
        for (p, source) in todo {
            let named = matches!(source, Source::Known);
            let found = self
                .check_source(&p, source, &settings, now_ms, changes, out)
                .await?;
            if named
                && !full_walk
                && let Some(found) = found.filter(|f| *f != Found::Other)
            {
                folders.push((p.clone(), found));
            }
            checked.insert(p);
        }
        // A path the watcher named that is a folder now, or is gone: its files
        // were not named (Linux reports a folder renamed, moved out of the
        // collection or moved in once, for the folder's path).
        for (dir, found) in folders {
            self.check_folder(&dir, found, &settings, now_ms, &mut checked, changes, out)
                .await?;
        }
        self.settle_moves(changes, out).await?;
        self.reoffer_outstanding(out).await?;
        Ok(())
    }

    /// Check one path of a pass. `None`: left out without a look.
    async fn check_source(
        &mut self,
        p: &str,
        source: Source,
        settings: &Option<FileInclusion>,
        now_ms: u64,
        changes: &mut Vec<Change>,
        out: &mut Vec<Observation>,
    ) -> StoreResult<Option<Found>> {
        // Preserve the completed quiet window before retiring its marker.
        let quiet_recheck = self.dirty.get(p).is_some_and(|due| *due <= now_ms);
        if quiet_recheck {
            self.dirty.remove(p);
        }
        let listed = match source {
            Source::Walked(meta) => meta,
            Source::Known => {
                let Ok(rp) = RelPath::new(p.to_string()) else {
                    return Ok(None);
                };
                if self.excluded(&rp, settings) {
                    return Ok(None);
                }
                None
            }
        };
        self.check_path(p, settings, changes, out, quiet_recheck, listed)
            .await
            .map(Some)
    }

    /// Expand a named path that turned out to be a folder, or gone, to the
    /// files beneath it. Gone: every file the store knows beneath it is
    /// checked, so each goes missing (a delete, or one end of a move). A
    /// folder the store knows nothing beneath (renamed or moved in) is walked,
    /// so each file appears (a create, or the far end of a move). A folder
    /// with known files is left alone: an event for the folder itself (a
    /// Windows parent modification, a permission change) is not a reason to
    /// walk it, and its files carry their own events.
    #[allow(clippy::too_many_arguments)]
    async fn check_folder(
        &mut self,
        dir: &str,
        found: Found,
        settings: &Option<FileInclusion>,
        now_ms: u64,
        checked: &mut BTreeSet<String>,
        changes: &mut Vec<Change>,
        out: &mut Vec<Observation>,
    ) -> StoreResult<()> {
        let prefix = format!("{dir}/");
        let beneath = |m: &BTreeMap<String, DiskState>| {
            m.range(prefix.clone()..)
                .take_while(|(p, _)| p.starts_with(&prefix))
                .map(|(p, _)| p.clone())
                .collect::<Vec<_>>()
        };
        let known: BTreeSet<String> = beneath(&self.disk)
            .into_iter()
            .chain(beneath(&self.seen))
            .collect();
        let mut todo: BTreeMap<String, Source> = BTreeMap::new();
        match found {
            Found::Gone => todo.extend(known.into_iter().map(|p| (p, Source::Known))),
            Found::Folder if known.is_empty() => {
                let Ok(rp) = RelPath::new(dir.to_string()) else {
                    return Ok(());
                };
                let mut listed = BTreeMap::new();
                let mut unsupported = BTreeMap::new();
                self.walk(&rp, settings, &mut listed, &mut unsupported)
                    .await?;
                self.stats.unsupported_paths.extend(unsupported);
                todo.extend(listed.into_iter().map(|(p, m)| (p, Source::Walked(m))));
            }
            Found::Folder | Found::Other => {}
        }
        for (p, source) in todo {
            if checked.insert(p.clone()) {
                self.check_source(&p, source, settings, now_ms, changes, out)
                    .await?;
            }
        }
        Ok(())
    }

    pub(super) async fn resource_batch_complete_task(
        &self,
        observations: &[Observation],
    ) -> StoreResult<bool> {
        mdbn_replica::mirror_admission::ensure_open(&self.inner)?;
        if observations.len() > 64 || self.refused_resource_sets.len() >= 64 {
            return Ok(false);
        }
        let mut tokens = observations.iter().map(|o| o.token.0).collect::<Vec<_>>();
        tokens.sort_unstable();
        if self
            .refused_resource_sets
            .iter()
            .any(|(set, _)| set == &tokens)
        {
            return Ok(false);
        }
        let paths = observations
            .iter()
            .map(|o| o.path.as_str())
            .collect::<BTreeSet<_>>();
        let mut requested = 0usize;
        for (work, original) in self.outstanding.values().enumerate() {
            if work >= 65536 {
                return Ok(false);
            }
            if !original.resource_requested {
                continue;
            }
            requested += 1;
            if requested > 1024 {
                return Ok(false);
            }
            if paths.contains(original.path.as_str()) {
                continue;
            }
            let path = Self::rel(&original.path)?;
            match self.observe_io(|| self.p.stat(&path)).await? {
                Err(e) if e.is_not_found() => continue,
                _ => return Ok(false),
            }
        }
        mdbn_replica::mirror_admission::ensure_open(&self.inner)?;
        Ok(true)
    }

    pub(super) async fn resource_current_task(&mut self, o: &Observation) -> StoreResult<bool> {
        mdbn_replica::mirror_admission::ensure_open(&self.inner)?;
        let Some(original) = self.outstanding.get(&o.token.0) else {
            return Ok(false);
        };
        if original.path != o.path
            || original.base != o.base
            || original.moved_from != o.moved_from
            || o.provenance != Provenance::Normal
            || original.evidence.is_some()
            || self.dirty.get(&o.path).is_some_and(|due| *due > self.now())
        {
            return Ok(false);
        }
        if let Some(from) = &o.moved_from {
            let from = Self::rel(from)?;
            match self.observe_io(|| self.p.stat(&from)).await? {
                Err(e) if e.is_not_found() => {}
                _ => return Ok(false),
            }
        }
        let current = match &o.now {
            Some(Observed::Text(text)) => {
                self.resource_text_task(o, 1024 * 1024).await?.as_ref() == Some(text)
            }
            None if original.known_after.is_none() => {
                let path = Self::rel(&o.path)?;
                matches!(self.observe_io(|| self.p.stat(&path)).await?, Err(e) if e.is_not_found())
            }
            _ => false,
        };
        mdbn_replica::mirror_admission::ensure_open(&self.inner)?;
        Ok(current)
    }

    pub(super) async fn resource_text_task(
        &mut self,
        observation: &Observation,
        limit: usize,
    ) -> StoreResult<Option<String>> {
        mdbn_replica::mirror_admission::ensure_open(&self.inner)?;
        if limit == 0 || limit > mdbn_replica::store::RESOURCE_SOURCE_BYTES {
            return Err(StoreError::Full);
        }
        let Some(original) = self.outstanding.get(&observation.token.0) else {
            return Ok(None);
        };
        if original.path != observation.path
            || original.base != observation.base
            || original.moved_from != observation.moved_from
            || observation.provenance != Provenance::Normal
            || original.evidence.is_some()
        {
            return Ok(None);
        }
        let Some(expected) = &original.known_after else {
            return Ok(None);
        };
        let expected_revision = expected.rev;
        let path = Self::rel(&original.path)?;
        if let Some(original) = self.outstanding.get_mut(&observation.token.0) {
            original.resource_requested = true;
        }
        if self
            .dirty
            .get(&observation.path)
            .is_some_and(|due| *due > self.now())
        {
            return Ok(None);
        }
        let meta = match self.observe_io(|| self.p.stat(&path)).await? {
            Ok(meta) if meta.kind == FileKind::File && meta.size <= limit as u64 => meta,
            _ => return Ok(None),
        };
        let read = match self.observe_io(|| self.p.read(&path)).await? {
            Ok(read) if read.meta == meta && read.bytes.len() <= limit => read,
            _ => return Ok(None),
        };
        if revision(&read.bytes) != expected_revision {
            return Ok(None);
        }
        mdbn_replica::mirror_admission::ensure_open(&self.inner)?;
        Ok(String::from_utf8(read.bytes).ok())
    }
}
