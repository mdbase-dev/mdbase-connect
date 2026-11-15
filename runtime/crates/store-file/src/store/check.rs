//! Checking changed paths and emitting their observations.

use super::*;

/// What a path named by the store or the watcher turned out to be.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum Found {
    /// Nothing is there.
    Gone,
    /// A folder.
    Folder,
    /// A file, or anything else the check handled itself.
    Other,
}

impl<P: FilePlatform, M: Store, D: DiskDb> FileStore<P, M, D> {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn emit(
        &mut self,
        changes: &mut Vec<Change>,
        out: &mut Vec<Observation>,
        path: &str,
        base: Option<Hash>,
        now: Option<Seen>,
        moved_from: Option<String>,
        id: Option<Uuid>,
    ) -> StoreResult<()> {
        let token = self.take_obs(changes);
        let (now_obs, known_after) = match now {
            Some(seen) => {
                let st = self.state_from(id, seen.rev, &seen.meta, false);
                (Some(self.observed(path, &seen)), Some(st))
            }
            None => (None, None),
        };
        // Transfer only the dependency-read hint to a genuine newer observation;
        // retain old tokens/evidence, without acknowledging or confirming them.
        let mut resource_requested = false;
        let mut deferred = false;
        if let Some(tokens) = self.outstanding_at.get(path) {
            for token in tokens {
                if let Some(old) = self.outstanding.get_mut(token) {
                    resource_requested |= old.resource_requested;
                    deferred |= old.deferred;
                    old.resource_requested = false;
                    old.deferred = false;
                }
            }
        }
        let attachment = match &now_obs {
            Some(Observed::Attachment {
                digest,
                size,
                class,
            }) => Some((*digest, *size, *class)),
            _ => None,
        };
        self.put_outstanding(
            token,
            Outstanding {
                path: path.to_string(),
                base,
                resource_requested,
                deferred,
                attachment,
                known_after,
                moved_from: moved_from.clone(),
                evidence: None,
            },
        );
        out.push(Observation {
            token: ObservationId(token),
            path: path.to_string(),
            base,
            now: now_obs,
            moved_from,
            provenance: Provenance::Normal,
        });
        Ok(())
    }

    /// Redeliver stable ordinary text evidence with its ORIGINAL token/base.
    /// Missing dependency deferral must not consume it or mint a fresh attempt.
    pub(super) async fn reoffer_outstanding(&self, out: &mut Vec<Observation>) -> StoreResult<()> {
        const MAX: usize = 64;
        const BYTES: usize = 8 * 1024 * 1024;
        let mut bytes = 0usize;
        let mut count = 0usize;
        for (id, o) in self.outstanding.iter().take(4096) {
            if o.evidence.is_some()
                || (!o.resource_requested && !o.deferred)
                || out.iter().any(|v| v.token == ObservationId(*id))
                || self.dirty.get(&o.path).is_some_and(|due| *due > self.now())
            {
                continue;
            }
            if count == MAX {
                break;
            }
            if let Some(from) = &o.moved_from {
                let from = Self::rel(from)?;
                match self.observe_io(|| self.p.stat(&from)).await? {
                    Err(e) if e.is_not_found() => {}
                    _ => continue,
                }
            }
            let now = match &o.known_after {
                Some(expected) => {
                    let path = Self::rel(&o.path)?;
                    let meta = match self.observe_io(|| self.p.stat(&path)).await? {
                        Ok(meta) if meta.kind == FileKind::File => meta,
                        _ => continue,
                    };
                    if !o.resource_requested
                        && let Some((digest, size, class)) = o.attachment
                    {
                        if !Self::meta_unchanged(expected, &meta) {
                            continue;
                        }
                        out.push(Observation {
                            token: ObservationId(*id),
                            path: o.path.clone(),
                            base: o.base,
                            now: Some(Observed::Attachment {
                                digest,
                                size,
                                class,
                            }),
                            moved_from: o.moved_from.clone(),
                            provenance: Provenance::Normal,
                        });
                        count += 1;
                        continue;
                    }
                    if meta.size > 1024 * 1024 {
                        continue;
                    }
                    let read = match self.observe_io(|| self.p.read(&path)).await? {
                        Ok(read) if read.meta == meta && read.bytes.len() <= 1024 * 1024 => read,
                        _ => continue,
                    };
                    let hash = revision(&read.bytes);
                    if hash != expected.rev {
                        continue;
                    }
                    let seen = Seen {
                        rev: hash,
                        meta: read.meta,
                        body: Body::Bytes(read.bytes),
                    };
                    let observed = self.observed(&o.path, &seen);
                    let size = usize::try_from(meta.size).map_err(|_| StoreError::Full)?;
                    if bytes.saturating_add(size) > BYTES {
                        break;
                    }
                    bytes += size;
                    Some(observed)
                }
                None => {
                    let path = Self::rel(&o.path)?;
                    match self.observe_io(|| self.p.stat(&path)).await? {
                        Err(e) if e.is_not_found() => None,
                        _ => continue,
                    }
                }
            };
            out.push(Observation {
                token: ObservationId(*id),
                path: o.path.clone(),
                base: o.base,
                now,
                moved_from: o.moved_from.clone(),
                provenance: Provenance::Normal,
            });
            count += 1;
        }
        Ok(())
    }

    /// Is an outstanding observation already reporting exactly this?
    pub(super) fn already_reported(&self, path: &str, rev: Option<Hash>) -> bool {
        self.outstanding_at
            .get(path)
            .into_iter()
            .flatten()
            .filter_map(|t| self.outstanding.get(t))
            .any(|o| o.known_after.as_ref().map(|k| k.rev) == rev && o.evidence.is_none())
    }

    /// Compare what `path` holds with what the store knows and report a
    /// difference. `listed`: what this pass's walk already has for it, in
    /// place of a `stat` (the walk lists only supported names). Returns what
    /// the path turned out to be, so a folder named by an event can be
    /// expanded to its files.
    pub(super) async fn check_path(
        &mut self,
        path: &str,
        settings: &Option<FileInclusion>,
        changes: &mut Vec<Change>,
        out: &mut Vec<Observation>,
        quiet_recheck: bool,
        listed: Option<FileMeta>,
    ) -> StoreResult<Found> {
        let rp = Self::rel(path)?;
        let stat = match listed {
            Some(meta) => Ok(meta),
            None => {
                let stat = self.observe_io(|| self.p.stat(&rp)).await?;
                if stat.is_ok()
                    && let Some(reason) = Self::unsupported_name(path)
                {
                    self.stats.unsupported_paths.insert(path.into(), reason);
                    return Ok(Found::Other);
                }
                stat
            }
        };
        let found = match &stat {
            Ok(m) if m.kind == FileKind::Dir => Found::Folder,
            Ok(_) => Found::Other,
            Err(e) if e.is_not_found() => Found::Gone,
            Err(_) => Found::Other,
        };
        let meta = match stat {
            Ok(m) if m.kind == FileKind::File => Some(m),
            Ok(m) => {
                self.stats.unsupported_paths.remove(path);
                if let Some(reason) = Self::unsupported_kind(m.kind) {
                    self.stats
                        .unsupported_paths
                        .insert(path.into(), reason.into());
                }
                None
            }
            Err(e) if e.is_not_found() => {
                self.stats.unsupported_paths.remove(path);
                None
            }
            Err(e) => return Err(fs_err(e)),
        };
        // Start the evidence window at original stat completion: suspended
        // host IO can itself take longer than the missing/move window.
        let now_ms = self.now();
        let known = self.disk.get(path).cloned();
        let Some(meta) = meta else {
            self.appeared.remove(path);
            let was_seen = self.seen.contains_key(path);
            self.forget_seen(changes, path);
            if known.is_none() && was_seen && !self.already_reported(path, None) {
                self.emit(changes, out, path, None, None, None, None)?;
            }
            if let Some(k) = known
                && !self.missing.contains_key(path)
            {
                // A single "missing" is never a delete:
                // re-check after a delay, then wait out the move window.
                self.missing.insert(
                    path.to_string(),
                    Missing {
                        known: k,
                        first_seen: now_ms,
                        confirmed: false,
                    },
                );
            }
            return Ok(found);
        };
        // Left out like an excluded folder: never ingested, never deleted.
        if self.oversized(path, meta.size, settings) {
            return Ok(found);
        }
        if !known
            .as_ref()
            .is_some_and(|k| Self::meta_unchanged(k, &meta))
        {
            self.stats.unsupported_paths.remove(path);
        }
        if Self::has_ext(path, &self.cfg.markdown_extensions) && meta.size > RECORD_CAP_BYTES {
            self.stats.unsupported_paths.insert(
                path.into(),
                format!(
                    "Too large to index as a note: {} bytes; limit is {RECORD_CAP_BYTES} bytes.",
                    meta.size
                ),
            );
        }
        // It exists: not missing (any more).
        if self.missing.remove(path).is_some() {
            // Came back (vim-style save, swap window): compare as usual.
        }
        let revalidate_resource = known.as_ref().is_some_and(|known| {
            self.outstanding_at
                .get(path)
                .into_iter()
                .flatten()
                .filter_map(|token| self.outstanding.get(token))
                .any(|original| {
                    original.resource_requested
                        && original.evidence.is_none()
                        && original.known_after.as_ref().map(|after| after.rev) != Some(known.rev)
                })
        });
        if let Some(k) = &known
            && Self::meta_unchanged(k, &meta)
            && !revalidate_resource
        {
            return Ok(found);
        }
        let Some(seen) = self.read_seen(changes, path, &rp, &meta).await? else {
            return Ok(found);
        };
        let rev = seen.rev;
        match known {
            Some(k) if k.rev == rev => {
                // Same bytes, new metadata (touch, our swap): just remember it.
                let st = self.state_from(k.id, rev, &seen.meta, k.ours);
                self.set_disk(changes, path, Some(st));
                if revalidate_resource && !self.already_reported(path, Some(rev)) {
                    self.emit(changes, out, path, Some(k.rev), Some(seen), None, k.id)?;
                }
            }
            Some(k) => {
                if seen.meta.size == 0 && k.size != 0 && !quiet_recheck {
                    // An O_TRUNC writer between truncate and write:
                    // look once more after a quiet window before believing it.
                    self.dirty
                        .insert(path.to_string(), self.now() + self.cfg.quiescence_ms.max(1));
                    return Ok(found);
                }
                if !self.already_reported(path, Some(rev)) {
                    self.emit(changes, out, path, Some(k.rev), Some(seen), None, k.id)?;
                }
            }
            None => {
                if self.already_reported(path, Some(rev)) {
                    return Ok(found);
                }
                // Might be the far end of a move: if a known path has these
                // bytes or this file ID, wait for the move window.
                // (`path` itself is not in `disk` here.)
                let could_pair = self.disk_revs.contains_key(&rev)
                    || seen
                        .meta
                        .id
                        .is_some_and(|id| self.disk_ids.contains_key(&id));
                if could_pair {
                    self.appeared.entry(path.to_string()).or_insert(Appeared {
                        seen,
                        since: now_ms,
                    });
                } else {
                    self.emit(changes, out, path, None, Some(seen), None, None)?;
                }
            }
        }
        Ok(found)
    }

    /// Read what `path` holds now: text read whole, anything else (or Markdown
    /// over the record cap) hashed through a range handle in bounded pieces.
    /// Explicit whole-file snapshot providers document their own allocation
    /// policy; the store does not add a silent whole-read fallback. `None`: it changed while being read (look again after
    /// a quiet window), vanished, or cannot be streamed here.
    async fn read_seen(
        &mut self,
        changes: &mut Vec<Change>,
        path: &str,
        rp: &RelPath,
        meta: &FileMeta,
    ) -> StoreResult<Option<Seen>> {
        if let Some(class) = self.attachment_class(path, meta.size) {
            // Hashed before with the same size, times and file ID: the same
            // policy that lets a known file skip its read (`meta_unchanged`).
            if let Some(k) = self.seen.get(path)
                && Self::meta_unchanged(k, meta)
            {
                self.stats.hashes_reused += 1;
                return Ok(Some(Seen {
                    body: Body::Streamed(class),
                    rev: k.rev,
                    meta: meta.clone(),
                }));
            }
            let Some((rev, m)) = self.hash_streamed(rp).await? else {
                self.dirty
                    .insert(path.to_string(), self.now() + self.cfg.quiescence_ms);
                return Ok(None);
            };
            self.stats.files_read += 1;
            if m.size != meta.size || m.mtime_ns != meta.mtime_ns {
                self.dirty
                    .insert(path.to_string(), self.now() + self.cfg.quiescence_ms);
                return Ok(None);
            }
            // Grew past the record cap while being looked at: classify by what
            // was actually hashed.
            let class = self.attachment_class(path, m.size).unwrap_or(class);
            let st = self.state_from(None, rev, &m, false);
            changes.push((Kind::Seen, path.as_bytes().to_vec(), Some(st.to_bytes())));
            self.seen.insert(path.to_string(), st);
            return Ok(Some(Seen {
                body: Body::Streamed(class),
                rev,
                meta: m,
            }));
        }
        let read = match self.observe_io(|| self.p.read(rp)).await? {
            Ok(r) => r,
            Err(e) if e.is_not_found() => {
                self.dirty
                    .insert(path.to_string(), self.now() + self.cfg.missing_recheck_ms);
                return Ok(None);
            }
            Err(e) => return Err(fs_err(e)),
        };
        self.stats.files_read += 1;
        // Changed while we read: wait for quiet again.
        if read.meta.size != read.bytes.len() as u64 || read.meta.mtime_ns != meta.mtime_ns {
            self.dirty
                .insert(path.to_string(), self.now() + self.cfg.quiescence_ms);
            return Ok(None);
        }
        if self.is_text(path) && std::str::from_utf8(&read.bytes).is_err() {
            self.stats.unsupported_paths.insert(
                path.into(),
                "Not valid UTF-8; cannot be read as text.".into(),
            );
        }
        let rev = revision(&read.bytes);
        Ok(Some(Seen {
            body: Body::Bytes(read.bytes),
            rev,
            meta: read.meta,
        }))
    }
}
