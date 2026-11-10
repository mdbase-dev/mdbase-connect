//! Settling moves, retained files and preserved-version evidence.

use super::*;

impl<P: FilePlatform, M: Store, D: DiskDb> FileStore<P, M, D> {
    /// Advance missing paths and appeared paths: re-check, pair moves, and emit
    /// deletes and creates whose windows have passed.
    pub(super) async fn settle_moves(
        &mut self,
        changes: &mut Vec<Change>,
        out: &mut Vec<Observation>,
    ) -> StoreResult<()> {
        let now_ms = self.now();
        let paths: Vec<String> = self.missing.keys().cloned().collect();
        for path in paths {
            let Some(m) = self.missing.get(&path).cloned() else {
                continue;
            };
            if !m.confirmed {
                if now_ms < m.first_seen + self.cfg.missing_recheck_ms {
                    continue;
                }
                let rp = Self::rel(&path)?;
                match self.observe_io(|| self.p.stat(&rp)).await? {
                    Ok(meta) if meta.kind == FileKind::File => {
                        self.missing.remove(&path);
                        self.dirty.insert(path.clone(), now_ms);
                        continue;
                    }
                    _ => {
                        if let Some(mm) = self.missing.get_mut(&path) {
                            mm.confirmed = true;
                        }
                    }
                }
            }
            // Pair with an appeared path: same bytes, or same file ID with
            // similar content (a move with an edit).
            let pair = self
                .appeared
                .iter()
                .find(|(_, a)| a.seen.rev == m.known.rev)
                .or_else(|| {
                    self.appeared.iter().find(|(_, a)| {
                        m.known.file_id.is_some() && a.seen.meta.id == m.known.file_id
                    })
                })
                .map(|(p, _)| p.clone());
            if let Some(to) = pair {
                let Some(a) = self.appeared.remove(&to) else {
                    continue;
                };
                self.missing.remove(&path);
                self.emit(
                    changes,
                    out,
                    &to,
                    Some(m.known.rev),
                    Some(a.seen),
                    Some(path.clone()),
                    m.known.id,
                )?;
                continue;
            }
            if now_ms >= m.first_seen + self.cfg.move_window_ms {
                self.missing.remove(&path);
                if !self.already_reported(&path, None) {
                    self.emit(
                        changes,
                        out,
                        &path,
                        Some(m.known.rev),
                        None,
                        None,
                        m.known.id,
                    )?;
                }
            }
        }
        // Appeared paths whose window passed unpaired are creates (or copies).
        let due: Vec<String> = self
            .appeared
            .iter()
            .filter(|(_, a)| now_ms >= a.since + self.cfg.move_window_ms)
            .map(|(p, _)| p.clone())
            .collect();
        for p in due {
            if let Some(a) = self.appeared.remove(&p) {
                self.emit(changes, out, &p, None, Some(a.seen), None, None)?;
            }
        }
        Ok(())
    }

    pub(super) async fn settle_retained(&mut self, changes: &mut Vec<Change>) -> StoreResult<()> {
        let now_ms = self.now();
        let retained: Vec<_> = self.retained.values().cloned().collect();
        let parked: Vec<_> = retained
            .iter()
            .map(|r| Parked {
                since: r.since,
                session: r.session,
                size: r.size,
            })
            .collect();
        let due = retention::due(
            self.release,
            self.cfg.retention_ms,
            now_ms,
            self.session,
            &parked,
        );
        for selected in due {
            let r = &retained[selected.index];
            match self.observe_io(|| settle(&*self.p, &r.r)).await? {
                Settled::Released | Settled::Gone => {}
                Settled::LateWrite => {
                    self.stats.late_writes += 1;
                    self.add_evidence(
                        changes,
                        &r.user_path,
                        r.r.path.clone(),
                        Some(r.r.expect),
                        false,
                    );
                }
                Settled::Busy | Settled::Error => continue,
            }
            if selected.reclaimed {
                self.stats.reclaimed += 1;
                self.reclaimed.push(Reclaimed {
                    size: r.size,
                    since: r.since,
                });
            }
            changes.push((Kind::Retained, r.r.path.as_str().as_bytes().to_vec(), None));
            self.retained.remove(&r.r.path);
        }
        Ok(())
    }

    pub(super) async fn deliver_evidence(&mut self, out: &mut Vec<Observation>) -> StoreResult<()> {
        let ids: Vec<u64> = self
            .evidence
            .keys()
            .copied()
            .filter(|id| !self.outstanding.contains_key(id))
            .collect();
        for id in ids {
            let Some(e) = self.evidence.get(&id).cloned() else {
                continue;
            };
            // Evidence of an attachment-class file (binary, or Markdown over the
            // record cap) stays preserved in the private directory: it is never
            // read whole, and an upload reads the user path, not the evidence.
            match self.observe_io(|| self.p.stat(&e.evidence)).await? {
                Ok(m) if self.attachment_class(&e.path, m.size).is_none() => {}
                Ok(_) => continue,
                Err(err) if err.is_not_found() => continue,
                Err(err) => return Err(fs_err(err)),
            }
            let read = match self.observe_io(|| self.p.read(&e.evidence)).await? {
                Ok(r) => r,
                // Gone: nothing to deliver (an earlier ack removed it).
                Err(err) if err.is_not_found() => continue,
                Err(err) => return Err(fs_err(err)),
            };
            let seen = Seen {
                rev: revision(&read.bytes),
                body: Body::Bytes(read.bytes),
                meta: read.meta,
            };
            let now = self.observed(&e.path, &seen);
            if !matches!(now, Observed::Text(_)) {
                // Not UTF-8 text: kept, as above.
                continue;
            }
            self.put_outstanding(
                id,
                Outstanding {
                    path: e.path.clone(),
                    base: e.base,
                    resource_requested: false,
                    deferred: false,
                    attachment: None,
                    known_after: None,
                    moved_from: None,
                    evidence: Some(e.evidence.clone()),
                },
            );
            out.push(Observation {
                token: ObservationId(id),
                path: e.path.clone(),
                base: e.base,
                now: Some(now),
                moved_from: None,
                provenance: if e.suspect {
                    Provenance::Suspect
                } else {
                    Provenance::Normal
                },
            });
        }
        Ok(())
    }
}
