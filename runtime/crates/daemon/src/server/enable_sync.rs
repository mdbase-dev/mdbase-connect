//! `collection.enable_sync`: turning sync on for a local collection (adopt).

use super::*;

impl Daemon {
    pub(super) async fn enable_sync(&self, p: EnableSync) -> Result<Value, ControlError> {
        // A local collection added a moment ago may still be opening; turning sync
        // on needs it serving, so wait for the open first (bounded).
        let local = self
            .inner
            .lock()
            .await
            .registry
            .get(&p.collection)
            .is_some_and(|e| e.mode == SyncMode::Local);
        if local {
            self.settled_status(&p.collection, ENABLE_OPEN_WAIT).await?;
        }
        // Accepting takeover holds clears them: the takeover gate comes first, as
        // in a takeover run.
        let _takeover = if p.accept_takeover_holds {
            Some(self.takeover.run.lock().await)
        } else {
            None
        };
        let _gate = self.account_gate.lock().await;
        // Before anything else: a running old daemon could write the folder meanwhile.
        let taken_over = self
            .inner
            .lock()
            .await
            .registry
            .get(&p.collection)
            .is_some_and(|e| e.origin == crate::registry::Origin::MigratedLocal);
        if taken_over
            && self
                .takeover
                .old_running
                .load(std::sync::atomic::Ordering::SeqCst)
        {
            return Err(ControlError::unavailable(
                crate::collections::OLD_CONNECTOR_RUNNING,
                "the old mdbase Connect is running on this computer and could still change \
                 this folder; quit it (including its menu-bar or tray icon) or update it, \
                 then turn on sync",
            ));
        }
        let (ctx, trust) = self.sync_parts()?;
        let entry = self
            .inner
            .lock()
            .await
            .registry
            .get(&p.collection)
            .cloned()
            .ok_or_else(|| {
                ControlError::not_found(format!("no registered collection {}", p.collection))
            })?;
        let collections = self.profile.state_dir.join("collections");
        let journal_path = crate::adopt::Journal::path(&collections, &entry.id);
        let mut journal = crate::adopt::Journal::load(&journal_path)
            .map_err(|e| ControlError::internal(format!("adopt journal: {e}")))?;
        if entry.mode != SyncMode::Local {
            if journal.is_some() {
                // Linked; the synced runtime is adopting the folder.
                let inner = self.inner.lock().await;
                let host = inner
                    .hosts
                    .iter()
                    .find(|h| h.entry().id == entry.id)
                    .ok_or_else(|| ControlError::internal("registry and hosts disagree"))?;
                return to_value(&host.status());
            }
            return Err(ControlError::invalid(
                "already_synced",
                "this collection already syncs; sync enable cannot change an existing sync mode",
            ));
        }
        let collection = crate::attest::uuid_bytes(&entry.id)
            .ok_or_else(|| ControlError::internal("collection ID"))?;
        let source = self
            .authority
            .source(mdbn_wire::common::B16(collection))
            .map_err(|_| {
                ControlError::new(
                    "unauthenticated",
                    "account_changed",
                    "current paired account required",
                )
            })?;
        let owner = source.active_account().ok_or_else(|| {
            ControlError::new(
                "unauthenticated",
                "account_changed",
                "current paired account required",
            )
        })?;
        let current = || {
            source
                .active_account()
                .filter(|a| a == &owner)
                .map(|_| ())
                .ok_or_else(|| "account_changed".to_string())
        };
        // A paused collection with an adopt journal was stopped by an
        // interrupted sync enable (which pauses durably before asking Connect
        // to create it); this run finishes it. Any other paused collection
        // must be resumed first (mdbase-connect#1522).
        let owner_identity = if entry.paused {
            if journal.is_none() {
                return Err(ControlError::invalid(
                    "collection_paused",
                    format!(
                        "this collection is paused; resume it with `mdbase collection resume {}`, \
                         then turn on sync",
                        entry.name
                    ),
                ));
            }
            source.paused_owner_identity()
        } else {
            source.owner_identity()
        };
        if owner_identity.is_none() {
            return Err(ControlError::new(
                "unauthenticated",
                "registration_mismatch",
                "this account does not own the local registration",
            ));
        }
        let adopting = journal.is_some() || !local_bootstrap_folder_is_empty(&entry.root)?;
        let migrated = entry.origin == crate::registry::Origin::MigratedLocal;
        let e2e = sync_e2e(
            journal
                .as_ref()
                .map(|j| j.mode == crate::adopt::Mode::Private),
            p.mode,
            migrated,
        )?;
        let mode = if e2e {
            SyncMode::SyncedE2e
        } else {
            SyncMode::Synced
        };
        let state = if e2e {
            mdbn_wire::policy::CState::E2e
        } else {
            mdbn_wire::policy::CState::CloudCopy
        };
        // Adopt: takeover holds first; then the serving local runtime is frozen
        // (writers fenced, inventory and hold counts taken at that one point,
        // stopped), so no acknowledged write or new hold can fall outside the plan.
        let inventory = if adopting && journal.is_none() {
            adopt_holds_refusal(
                &self.profile.state_dir,
                &entry.id,
                p.accept_takeover_holds,
                None,
            )?;
            let rt = {
                let inner = self.inner.lock().await;
                inner
                    .hosts
                    .iter()
                    .find(|h| h.entry().id == entry.id && h.is_serving())
                    .and_then(|h| h.runtime())
            }
            .ok_or_else(|| {
                ControlError::invalid(
                    "not_serving",
                    "the collection must be serving to turn sync on; resume it and run again",
                )
            })?;
            let frozen = match rt.freeze().await {
                Ok(frozen) => frozen,
                Err(failure) => {
                    self.retain_failed_capture(&entry.id, failure).await?;
                    return Err(ControlError::invalid(
                        "source_capture_incomplete",
                        "Source capture did not complete; the original collection remains paused. Resolve the incident or original pending outcome before resuming.",
                    ));
                }
            };
            let refused = adopt_holds_refusal(
                &self.profile.state_dir,
                &entry.id,
                true,
                Some((frozen.holds, frozen.unresolved)),
            )
            .err();
            if let Some(e) = refused {
                // A complete, known frozen capture was refused only for holds:
                // unlike failed/unknown capture, serving may safely resume.
                let mut inner = self.inner.lock().await;
                if let Some(host) = inner.hosts.iter_mut().find(|h| h.entry().id == entry.id) {
                    host.close().await;
                    host.set_entry(entry.clone());
                }
                return Err(e);
            }
            if p.accept_takeover_holds {
                // Explicitly accepted: this computer's versions stay, as with
                // keep_mine, and the holds are cleared.
                let paths = self.takeover_paths();
                let accepted: Vec<String> = crate::takeover::held::open(&paths.legacy, &entry.id)
                    .map_err(|e| ControlError::internal(format!("takeover holds: {e}")))?
                    .into_iter()
                    .map(|h| h.path)
                    .collect();
                if !accepted.is_empty() {
                    tracing::info!(collection = %entry.id, files = accepted.len(), "takeover holds accepted as this computer's versions");
                    crate::takeover::held::resolve(
                        &paths.record,
                        &paths.legacy,
                        &entry.id,
                        &accepted,
                    )
                    .map_err(|e| ControlError::internal(format!("takeover holds: {e}")))?;
                }
            }
            let (records, resources) = frozen.inventory;
            let records = if migrated {
                crate::adopt::prefer_legacy_ids(
                    records,
                    &crate::adopt::legacy_hints(&self.profile.state_dir, &entry.id),
                )
            } else {
                records
            };
            Some((records, resources))
        } else {
            None
        };
        // Join/retain-stop the old actor before enrolment; no local writer may
        // keep serving while bootstrap outcome is uncertain. Do not auto-resume.
        {
            let mut inner = self.inner.lock().await;
            let host = inner
                .hosts
                .iter_mut()
                .find(|h| h.entry().id == entry.id)
                .ok_or_else(|| ControlError::internal("registry and hosts disagree"))?;
            host.close().await;
            current().map_err(|_| {
                ControlError::new(
                    "unauthenticated",
                    "account_changed",
                    "account changed while stopping",
                )
            })?;
            // Durable retained stop BEFORE any uncertain remote/local change.
            // Restart must not auto-open a possibly moved local-only store.
            let mut stopped = inner.registry.clone();
            let paused = stopped
                .get_mut(&entry.id)
                .ok_or_else(|| ControlError::internal("registry changed"))?;
            paused.paused = true;
            let paused = paused.clone();
            self.save_registry(&stopped)?;
            inner.registry = stopped;
            self.authority.publish_registry(&inner.registry);
            inner
                .hosts
                .iter_mut()
                .find(|h| h.entry().id == entry.id)
                .ok_or_else(|| ControlError::internal("registry and hosts disagree"))?
                .set_entry(paused);
        }
        if let Some((records, resources)) = inventory {
            let j = crate::adopt::Journal {
                schema_version: crate::adopt::SCHEMA_VERSION,
                mode: if e2e {
                    crate::adopt::Mode::Private
                } else {
                    crate::adopt::Mode::CloudCopy
                },
                records: records
                    .iter()
                    .map(|(id, path)| (secrets::uuid_string(id), path.clone()))
                    .collect(),
                resources,
                created: None,
            };
            j.save(&journal_path)
                .map_err(|e| ControlError::internal(format!("adopt journal: {e}")))?;
            journal = Some(j);
        }
        if !adopting && !local_bootstrap_folder_is_empty(&entry.root)? {
            return Err(ControlError::invalid(
                "folder_not_empty",
                "the folder changed while stopping; run sync enable again to adopt it",
            ));
        }
        let created = match journal
            .as_ref()
            .and_then(|j| Some((j.created.clone()?, j.genesis()?)))
        {
            Some((c, genesis)) => (c.log_url, genesis),
            None => {
                let identity = self
                    .identity
                    .get()
                    .ok_or_else(|| {
                        ControlError::unavailable(
                            "device_identity_missing",
                            "keychain device unavailable",
                        )
                    })?
                    .clone();
                let created = if e2e {
                    ctx.cloud
                        .create_private(
                            &ctx.connector_id,
                            &collection,
                            &entry.name,
                            &identity,
                            &current,
                        )
                        .await
                } else {
                    ctx.cloud
                        .create_cloud_copy(
                            &ctx.connector_id,
                            &collection,
                            &entry.name,
                            &identity,
                            &current,
                        )
                        .await
                };
                let created = match created {
                    Ok(created) => created,
                    Err(refusal) => {
                        if refused_before_create(&refusal) {
                            self.restore_after_refused_create(&entry.id, &journal_path)
                                .await?;
                        }
                        return Err(cloud_refusal(refusal));
                    }
                };
                current().map_err(|_| {
                    ControlError::new(
                        "unauthenticated",
                        "account_changed",
                        "account changed during bootstrap",
                    )
                })?;
                if created.collection_id != entry.id
                    || crate::trust::origin(&created.log_url).ok().as_deref()
                        != Some(trust.log_origin.as_str())
                {
                    return Err(ControlError::unavailable(
                        "sync_integrity",
                        "bootstrap response binding mismatch",
                    ));
                }
                // Authenticate the candidate BEFORE moving aside any local state.
                crate::sync::verify_genesis(&created.genesis_item, &collection, &trust, state)
                    .map_err(|e| ControlError::unavailable("sync_integrity", e.0))?;
                if let Some(j) = journal.as_mut() {
                    j.created = Some(crate::adopt::Created {
                        log_url: created.log_url.clone(),
                        genesis: crate::adopt::hex(&created.genesis_item),
                    });
                    j.save(&journal_path)
                        .map_err(|e| ControlError::internal(format!("adopt journal: {e}")))?;
                }
                (created.log_url, created.genesis_item)
            }
        };
        let (log_url, genesis) = created;
        if !adopting && !local_bootstrap_folder_is_empty(&entry.root)? {
            return Err(ControlError::invalid(
                "folder_not_empty",
                "the folder changed during bootstrap; run sync enable again to adopt it",
            ));
        }
        let mut inner = self.inner.lock().await;
        current().map_err(|_| {
            ControlError::new(
                "unauthenticated",
                "account_changed",
                "account changed before publication",
            )
        })?;
        // The local-only store is set aside, never deleted: a mistake must stay
        // recoverable (an adopted folder's inventory is already journaled).
        let dir = collections.join(&entry.id);
        if dir.exists() {
            let aside = collections.join(format!("{}.local-{}", entry.id, fsutil::now_ms()));
            std::fs::rename(&dir, &aside).map_err(|e| ControlError::internal(e.to_string()))?;
        }
        self.write_link(
            &entry.id,
            &collection,
            &trust,
            state,
            (&log_url, &genesis),
            true,
        )?;
        let mut next = inner.registry.clone();
        let updated = next
            .get_mut(&entry.id)
            .ok_or_else(|| ControlError::internal("registry changed"))?;
        updated.mode = mode;
        updated.ever_e2e |= e2e;
        updated.owner_account = Some(secrets::uuid_string(&owner.0));
        updated.paused = false;
        let updated = updated.clone();
        self.save_registry(&next)?;
        inner.registry = next;
        self.authority.publish_registry(&inner.registry);
        let host = inner
            .hosts
            .iter_mut()
            .find(|h| h.entry().id == entry.id)
            .ok_or_else(|| ControlError::internal("registry and hosts disagree"))?;
        host.set_entry(updated);
        let status = host.status();
        drop(inner);
        self.bump();
        tracing::info!(collection = %status.id, e2e, adopting, "sync enabled");
        to_value(&status)
    }

    /// Connect refused to create the collection, so nothing exists remotely:
    /// put it back as `collection resume` would. The adopt journal (nothing
    /// was created) is dropped and the folder serves locally again, instead of
    /// staying paused until someone resumes it (mdbase-connect#1522).
    async fn restore_after_refused_create(
        &self,
        id: &str,
        journal: &std::path::Path,
    ) -> Result<(), ControlError> {
        crate::adopt::Journal::remove(journal)
            .map_err(|e| ControlError::internal(format!("adopt journal: {e}")))?;
        let mut inner = self.inner.lock().await;
        let mut next = inner.registry.clone();
        let entry = next
            .get_mut(id)
            .ok_or_else(|| ControlError::internal("registry changed"))?;
        entry.paused = false;
        let entry = entry.clone();
        self.save_registry(&next)?;
        inner.registry = next;
        self.authority.publish_registry(&inner.registry);
        inner
            .hosts
            .iter_mut()
            .find(|h| h.entry().id == id)
            .ok_or_else(|| ControlError::internal("registry and hosts disagree"))?
            .set_entry(entry);
        drop(inner);
        self.bump();
        tracing::info!(collection = %id, "sync not turned on: Connect refused to create the collection; serving locally again");
        Ok(())
    }
}

/// Whether Connect refused to create a collection without creating it: the
/// synced-collection quota, a rate limit or a rejected credential. Anything
/// else (a network failure, a 5xx, a conflict) leaves the outcome uncertain,
/// and the collection stays paused with its journal for a retry to finish.
fn refused_before_create(refusal: &crate::cloud::CloudError) -> bool {
    use crate::cloud::CloudError;
    match refusal {
        CloudError::Server(429, code) => code == "account_collection_quota_exceeded",
        CloudError::RateLimited(_) | CloudError::Unauthenticated => true,
        _ => false,
    }
}

/// How long `sync.enable` waits for a local collection that is still opening
/// (within the CLI's call timeout, leaving time for the bootstrap itself).
const ENABLE_OPEN_WAIT: Duration = Duration::from_secs(15);

/// Whether turning sync on makes the collection Private. `started` is the
/// mode an interrupted adopt journal began with, which a retry must keep.
pub(super) fn sync_e2e(
    started: Option<bool>,
    asked: Option<SyncMode>,
    migrated: bool,
) -> Result<bool, ControlError> {
    Ok(match (started, asked) {
        (Some(started), asked) => {
            if asked.is_some_and(|m| (m == SyncMode::SyncedE2e) != started) {
                return Err(ControlError::invalid(
                    "adopt_in_progress",
                    format!(
                        "turning sync on was started as {}; run it again with that mode",
                        if started { "private" } else { "cloud-copy" }
                    ),
                ));
            }
            started
        }
        (None, Some(m)) => m == SyncMode::SyncedE2e,
        // A cloud copy unless the user asks for private. Migrated
        // local-authority collections never had a cloud copy, and the
        // automatic takeover enables them without asking, so they stay private.
        (None, None) => migrated,
    })
}

/// Only for an authenticated owner's EXISTING local registration: FileStore
/// creates the reserved private directory even for an empty folder. Permit its
/// empty directories and, directly inside it, the folder host lock's own regular
/// files (`host.lock`, `host.json`: a PID and a diagnostic descriptor, never user
/// data). Never other files, symlinks or arbitrary hidden user entries.
/// No file contents are read; inspection is bounded and failures deny.
/// Adopt is blocked while files the takeover held are unreviewed (the daemon
/// cannot resolve those; `accept` is the user's explicit review) and while the
/// local replica has holds or unresolved conflicts (`replica`: holds, conflicts).
pub(super) fn adopt_holds_refusal(
    state_dir: &std::path::Path,
    id: &str,
    accept: bool,
    replica: Option<(u64, u64)>,
) -> Result<(), ControlError> {
    let held = crate::adopt::takeover_holds(state_dir, id)
        .map_err(|e| ControlError::internal(format!("takeover record: {e}")))?;
    if held > 0 && !accept {
        return Err(ControlError::invalid(
            "takeover_holds",
            format!(
                "{held} file(s) were held when this collection was taken over: the folder has \
                 this computer's version and mdbase kept the other. Review them with `mdbase \
                 holds {id}` and `mdbase resolve`, or accept this computer's versions with \
                 `mdbase sync enable {id} --accept-takeover-holds`"
            ),
        ));
    }
    if let Some((holds, conflicts)) = replica
        && (holds > 0 || conflicts > 0)
    {
        return Err(ControlError::invalid(
            "holds_pending",
            format!(
                "{holds} hold(s) and {conflicts} conflict(s) must be resolved first \
                 (`mdbase holds {id}`)"
            ),
        ));
    }
    Ok(())
}
