//! Collection lifecycle: add, join, remove, delete, update and pause, and collection name validation.

use super::*;

impl Daemon {
    pub(super) async fn add(&self, p: AddCollection) -> Result<Value, ControlError> {
        self.add_with_pause(p, false).await
    }

    pub(super) async fn add_with_pause(
        &self,
        p: AddCollection,
        paused: bool,
    ) -> Result<Value, ControlError> {
        if !p.path.is_absolute() {
            return Err(ControlError::invalid(
                "relative_path",
                "the path must be absolute",
            ));
        }
        let root = canonical_dir(&p.path)?;
        if registry::overlaps(&root, &self.profile.state_dir) {
            return Err(ControlError::invalid(
                "overlapping_state_dir",
                "a collection cannot contain or sit inside the daemon's state directory",
            ));
        }
        let old_state = crate::takeover::old_state_dir(&self.profile);
        let claim = classify_folder(&root, &self.profile, old_state.as_deref())?;
        match claim {
            FolderClaim::Connect(reason) => {
                // Local migration: the takeover (drain, import, v2 marker) runs first.
                return Err(ControlError::unavailable(
                    "migration_pending",
                    format!(
                        "this folder is managed by today's mdbase Connect ({reason}); \
                         it is taken over by the migration first"
                    ),
                ));
            }
            FolderClaim::OrphanedIdentity if !p.remove_legacy_identity => {
                return Err(ControlError::new(
                    "conflict",
                    "orphaned_legacy_identity",
                    format!(
                        "mdbase.yaml has an mdbase Connect identity (`{LEGACY_IDENTITY_KEY}`) \
                         that no Connect on this computer manages, for example because the \
                         folder was copied or removed from Connect; confirm removing that \
                         key to add the folder"
                    ),
                ));
            }
            _ => {}
        }
        let orphaned = claim == FolderClaim::OrphanedIdentity;
        let name = p
            .name
            .as_deref()
            .map(display_name)
            .transpose()?
            .unwrap_or_else(|| {
                root.file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| root.display().to_string())
            });
        let (id, replica_id, origin) = match claim {
            FolderClaim::Ours {
                collection,
                replica_id,
            } => (collection, replica_id, Origin::MigratedLocal),
            _ => (
                secrets::new_uuid().map_err(|e| ControlError::internal(e.to_string()))?,
                secrets::new_uuid().map_err(|e| ControlError::internal(e.to_string()))?,
                Origin::Adopted,
            ),
        };
        let _gate = self.account_gate.lock().await;
        let owner = self.authority.active_account().ok_or_else(|| {
            ControlError::new(
                "unauthenticated",
                "account_identity_missing",
                "pair with an authenticated account before registering a local collection",
            )
        })?;
        let device = self
            .identity
            .get()
            .ok_or_else(|| {
                ControlError::unavailable("device_identity_missing", "keychain device unavailable")
            })?
            .device_id;
        let entry = Entry {
            id,
            name,
            root,
            replica_id,
            mode: SyncMode::Local,
            origin,
            description: None,
            added_at_ms: fsutil::now_ms() as u64,
            paused,
            ever_e2e: false,
            owner_account: Some(secrets::uuid_string(&owner.0)),
            device: Some(secrets::uuid_string(&device)),
        };
        let mut inner = self.inner.lock().await;
        let mut next = inner.registry.clone();
        next.add(entry.clone()).map_err(registry_error)?;
        if orphaned {
            remove_legacy_identity(&entry.root)?;
        }
        self.save_registry(&next)?;
        inner.registry = next;
        self.authority.publish_registry(&inner.registry);
        let host = CollectionHost::open(entry, self.host_ctx());
        host.publish_grants(&inner.access);
        let status = host.status();
        inner.hosts.push(host);
        drop(inner);
        self.bump();
        tracing::info!(collection = %status.id, root = %status.root.display(), "collection registered");
        to_value(&status)
    }

    /// The signed-in Connect, connector and authenticated trust, or why not.
    pub(super) fn sync_parts(
        &self,
    ) -> Result<(crate::collections::SyncCtx, Arc<crate::trust::Trust>), ControlError> {
        let ctx = self.sync_ctx().ok_or_else(|| {
            ControlError::new(
                "unauthenticated",
                "not_signed_in",
                "sign this computer in first (`mdbase account sign-in`)",
            )
        })?;
        let trust = ctx.trust.clone().ok_or_else(|| {
            ControlError::unavailable(
                "trust_missing",
                "this build has no authenticated trust for synced collections",
            )
        })?;
        if crate::trust::origin(ctx.cloud.server()).ok().as_deref()
            != Some(trust.cp_origin.as_str())
        {
            return Err(ControlError::unavailable(
                "sync_config_invalid",
                "the signed-in server is not this build's control plane",
            ));
        }
        Ok((ctx, trust))
    }

    /// Verify the control plane's candidate genesis under the pins and write the
    /// collection's `sync.json`. Nothing is persisted unless the genesis verifies.
    pub(super) fn write_link(
        &self,
        id: &str,
        collection: &[u8; 16],
        trust: &crate::trust::Trust,
        state: mdbn_wire::policy::CState,
        binding: (&str, &[u8]),
        creating: bool,
    ) -> Result<(), ControlError> {
        let (log_url, genesis) = binding;
        let refused = |m: String| ControlError::unavailable("sync_integrity", m);
        if crate::trust::origin(log_url).map_err(|e| refused(e.0))? != trust.log_origin {
            return Err(refused("the control plane named another log".into()));
        }
        let pinned = if creating {
            crate::sync::verify_genesis(genesis, collection, trust, state)
        } else {
            crate::sync::verify_join_genesis(genesis, collection, trust)
        }
        .map_err(|e| refused(e.0))?;
        let device = self
            .identity
            .get()
            .ok_or_else(|| {
                ControlError::unavailable("device_identity_missing", "keychain device unavailable")
            })?
            .device_id;
        let cloud_copy = state == mdbn_wire::policy::CState::CloudCopy;
        let cfg = crate::sync::SyncConfig {
            schema_version: 2,
            environment: trust.environment.clone(),
            collection_id: id.to_string(),
            log_url: trust.log_origin.clone(),
            genesis_hash: secrets::hex(&pinned),
            chosen_state: if cloud_copy { "cloud_copy" } else { "private" }.into(),
            trusted_signers: vec![secrets::uuid_string(&device)],
            user_enabled_cloud_copy: cloud_copy,
        };
        let dir = self.profile.state_dir.join("collections").join(id);
        fsutil::ensure_private_dir(&dir).map_err(|e| ControlError::internal(e.to_string()))?;
        cfg.save(
            &crate::sync::SyncConfig::path(&self.profile.state_dir.join("collections"), id),
            collection,
            trust,
        )
        .map_err(|e| refused(e.0))
    }

    /// Join an account's cloud copy into an empty folder. Connect enrols this
    /// device (control-signed); hosted (or escrow) then wraps the epoch key to it.
    pub(super) async fn join(&self, p: JoinCollection) -> Result<Value, ControlError> {
        // Serialize registration with account/collection lifecycle. The captured
        // source below additionally rechecks the actual durable incarnation.
        let _gate = self.account_gate.lock().await;
        let (ctx, trust) = self.sync_parts()?;
        let collection =
            crate::attest::uuid_bytes(&p.collection.to_ascii_lowercase()).ok_or_else(|| {
                ControlError::invalid("invalid_collection", "the collection is a UUID")
            })?;
        let id = secrets::uuid_string(&collection);
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
        if !p.path.is_absolute() {
            return Err(ControlError::invalid(
                "relative_path",
                "the path must be absolute",
            ));
        }
        let root = canonical_dir(&p.path)?;
        p.name.as_deref().map(display_name).transpose()?;
        if registry::overlaps(&root, &self.profile.state_dir) {
            return Err(ControlError::invalid(
                "overlapping_state_dir",
                "a collection cannot contain or sit inside the daemon's state directory",
            ));
        }
        if !folder_is_empty(&root)? {
            return Err(ControlError::invalid(
                "folder_not_empty",
                "join into an empty folder; the collection's files arrive from the log",
            ));
        }
        if self.inner.lock().await.registry.get(&id).is_some() {
            return Err(ControlError::invalid(
                "already_registered",
                "this collection is already here",
            ));
        }
        let identity = self
            .identity
            .get()
            .ok_or_else(|| {
                ControlError::unavailable("device_identity_missing", "keychain device unavailable")
            })?
            .clone();
        let joined = if p.private {
            // Private: enrol with a real SAS commitment whose requester state is in
            // the keychain journal BEFORE any I/O, so an approver can key this device
            // later (strict mode) and a restart keeps the reveal-once state. The
            // account key (`private.unlock`) keys it without the commitment.
            let commit = self.private_join_commitment(&collection, owner, &identity)?;
            current().map_err(|_| {
                ControlError::new(
                    "unauthenticated",
                    "account_changed",
                    "current paired account required",
                )
            })?;
            ctx.cloud
                .enrol_private(&ctx.connector_id, &collection, &commit, &identity, &current)
                .await
        } else {
            ctx.cloud
                .join_cloud_copy(&ctx.connector_id, &collection, &identity, &current)
                .await
        }
        .map_err(join_refusal)?;
        let state = if p.private {
            mdbn_wire::policy::CState::E2e
        } else {
            mdbn_wire::policy::CState::CloudCopy
        };
        let (Some(log_url), Some(genesis)) =
            (joined.log_url.as_deref(), joined.genesis_item.as_deref())
        else {
            return Err(ControlError::unavailable(
                "control_plane_outdated",
                "the control plane did not return the collection's genesis",
            ));
        };
        current().map_err(|_| {
            ControlError::new(
                "unauthenticated",
                "account_changed",
                "account changed during join",
            )
        })?;
        if !folder_is_empty(&root)? {
            return Err(ControlError::invalid(
                "folder_not_empty",
                "the folder changed during enrolment; no local files were adopted",
            ));
        }
        self.write_link(&id, &collection, &trust, state, (log_url, genesis), false)?;
        let name = join_name(p.name.as_deref(), joined.display_name.as_deref(), &root)?;
        let entry = Entry {
            id: id.clone(),
            name,
            root,
            replica_id: secrets::new_uuid().map_err(|e| ControlError::internal(e.to_string()))?,
            mode: if p.private {
                SyncMode::SyncedE2e
            } else {
                SyncMode::Synced
            },
            origin: Origin::Joined,
            description: None,
            added_at_ms: fsutil::now_ms() as u64,
            paused: false,
            ever_e2e: p.private,
            owner_account: Some(secrets::uuid_string(&owner.0)),
            device: Some(secrets::uuid_string(&identity.device_id)),
        };
        let mut inner = self.inner.lock().await;
        current().map_err(|_| {
            ControlError::new(
                "unauthenticated",
                "account_changed",
                "account changed before registration",
            )
        })?;
        let mut next = inner.registry.clone();
        next.add(entry.clone()).map_err(registry_error)?;
        self.save_registry(&next)?;
        inner.registry = next;
        self.authority.publish_registry(&inner.registry);
        let host = CollectionHost::open(entry, self.host_ctx());
        host.publish_grants(&inner.access);
        let status = host.status();
        inner.hosts.push(host);
        drop(inner);
        self.bump();
        tracing::info!(collection = %status.id, "collection joined");
        to_value(&status)
    }

    /// A persisted SAS enrolment commitment, bound to this account incarnation.
    /// Retry the SAME enrolment after an unknown outcome; never overwrite its
    /// requester state with a different commitment. Renewal after a reveal is a
    /// separate logged approval-request, not a new enrolment.
    fn private_join_commitment(
        &self,
        collection: &[u8; 16],
        owner: mdbn_wire::common::B16,
        identity: &crate::secrets::DeviceIdentity,
    ) -> Result<[u8; 32], ControlError> {
        use crate::approval_journal::{JournalError, RequesterJournal};
        let changed = || {
            ControlError::new(
                "unauthenticated",
                "account_changed",
                "current paired account required",
            )
        };
        let inc = self.authority.incarnation().ok_or_else(changed)?;
        if inc.account != owner || inc.device.0 != identity.device_id {
            return Err(changed());
        }
        let public = identity.public();
        let key = |h: &str| -> Result<[u8; 32], ControlError> {
            secrets::hex_decode(h)
                .ok()
                .and_then(|b| <[u8; 32]>::try_from(b.as_slice()).ok())
                .ok_or_else(|| ControlError::internal("device public key"))
        };
        let me = mdbn_replica::crypto::keys::EnrolledKeys {
            device: mdbn_wire::common::B16(identity.device_id),
            sign_pk: key(&public.sign_pk)?,
            kem_pk: key(&public.kem_pk)?,
            noise_pk: key(&public.noise_pk)?,
        };
        let mut journal = RequesterJournal::new(
            self.secrets.clone(),
            *collection,
            inc.account.0,
            identity.device_id,
            inc.epoch,
        )
        .map_err(|e| match e {
            JournalError::BackendDenied => ControlError::unavailable(
                "credential_store_unsupported",
                "private collections need the OS keychain",
            ),
            _ => ControlError::internal("requester journal"),
        })?;
        let commit = journal
            .join_commitment(
                mdbn_wire::common::B16(*collection),
                me,
                &mut mdbn_local_host::OsEntropy,
            )
            .map_err(|_| {
                ControlError::unavailable(
                    "requester_state_uncertain",
                    "the enrolment state could not be restored or saved; restart the daemon and retry",
                )
            })?;
        if self.authority.incarnation() != Some(inc) {
            return Err(changed());
        }
        Ok(commit)
    }

    /// Turn sync on for a registered local collection. Connect creates the cloud
    /// copy (or private collection) from this device, the verified genesis is
    /// pinned, the local-only store is moved aside (never deleted), and the
    /// collection reopens synced.
    ///
    /// A folder with files is adopted: the inventory (record IDs,
    /// paths) is journaled before anything remote happens, and the synced runtime
    /// seals the folder as generation 0 with those IDs. Every step is resumable: a
    /// re-run after a crash continues from the journal, and a re-run once linked
    /// returns the status.
    /// A failed/unknown frozen capture is NOT a proven holds-only refusal.
    /// Close and retain the original entry paused before returning, without any
    /// journal/enrolment/Base. Even a registry write failure stays stopped in
    /// memory; save_registry also invalidates authority on uncertain durability.
    pub(super) async fn retain_failed_capture(
        &self,
        id: &str,
        failure: Option<crate::sync_failure::Failure>,
    ) -> Result<(), ControlError> {
        let mut inner = self.inner.lock().await;
        let host = inner
            .hosts
            .iter_mut()
            .find(|h| h.entry().id == id)
            .ok_or_else(|| ControlError::internal("registry and hosts disagree"))?;
        if let Some(failure) = failure {
            host.close_with_failure(
                &self.profile.state_dir.join("collections").join(id),
                failure,
            )
            .await;
        } else {
            host.close().await;
        }
        let mut stopped = inner.registry.clone();
        let paused = stopped
            .get_mut(id)
            .ok_or_else(|| ControlError::internal("registry changed"))?;
        paused.paused = true;
        let paused = paused.clone();
        inner.registry = stopped;
        self.authority.publish_registry(&inner.registry);
        inner
            .hosts
            .iter_mut()
            .find(|h| h.entry().id == id)
            .ok_or_else(|| ControlError::internal("registry and hosts disagree"))?
            .set_entry(paused);
        self.save_registry(&inner.registry)
    }

    pub(super) async fn remove(&self, id: &str) -> Result<Value, ControlError> {
        let _gate = self.account_gate.lock().await;
        let mut inner = self.inner.lock().await;
        let mut next = inner.registry.clone();
        next.remove(id).map_err(registry_error)?;
        self.save_registry(&next)?;
        if let Err(e) = crate::adopt::Journal::remove(&crate::adopt::Journal::path(
            &self.profile.state_dir.join("collections"),
            id,
        )) {
            tracing::warn!(collection = %id, error = %e, "adopt journal not removed");
        }
        inner.registry = next;
        self.authority.publish_registry(&inner.registry);
        if !inner.access.list(Some(id)).is_empty() {
            let mut access = inner.access.clone();
            access.forget_collection(id);
            self.save_access(&mut inner, &access)?;
            inner.access = access;
            self.authority.publish_access(&inner.access);
            for h in &inner.hosts {
                h.publish_grants(&inner.access);
            }
        }
        if let Some(i) = inner.hosts.iter().position(|h| h.entry().id == id) {
            let mut host = inner.hosts.remove(i);
            host.close().await;
        }
        drop(inner);
        self.bump();
        tracing::info!(collection = %id, "collection unregistered (files untouched)");
        Ok(json!({}))
    }

    /// Account deletion is separate from local unregister: no local state changes.
    pub(super) async fn delete_collection(
        &self,
        p: DeleteCollection,
    ) -> Result<Value, ControlError> {
        let collection =
            crate::attest::uuid_bytes(&p.collection.to_ascii_lowercase()).ok_or_else(|| {
                ControlError::invalid("invalid_collection", "the collection is a UUID")
            })?;
        let id = secrets::uuid_string(&collection);
        let _gate = self.account_gate.lock().await;
        let source = self
            .authority
            .source(mdbn_wire::common::B16(collection))
            .map_err(|_| {
                ControlError::new(
                    "unauthenticated",
                    "not_signed_in",
                    "sign this computer in first",
                )
            })?;
        let (ctx, _) = self.sync_parts()?;
        let current = || {
            source
                .active_account()
                .map(|_| ())
                .ok_or_else(|| "account_changed".to_string())
        };
        ctx.cloud
            .delete_collection(&id, &p.confirm_name, &current)
            .await
            .map_err(|e| {
                if matches!(&e, crate::cloud::CloudError::Network(_))
                    || matches!(&e, crate::cloud::CloudError::Server(_, code) if matches!(code.as_str(), "malformed" | "response_too_large"))
                {
                    return ControlError::unavailable(
                        "outcome_unknown",
                        "The deletion outcome is unknown. Check this collection in your account before taking further action; do not automatically retry.",
                    );
                }
                match e {
                    crate::cloud::CloudError::Server(409, code) if code == "device_not_enrolled" => {
                        ControlError::new(
                            "not_authorized",
                            &code,
                            "Join this collection on this computer first, then try again.",
                        )
                    }
                    crate::cloud::CloudError::Server(409, code)
                        if code == "collection_name_mismatch" =>
                    {
                        ControlError::invalid(
                            &code,
                            "The name you typed does not match this collection's name.",
                        )
                    }
                    crate::cloud::CloudError::Server(404, _) => {
                        ControlError::not_found("Collection not found.")
                    }
                    e => cloud_refusal(e),
                }
            })?;
        Ok(json!({ "collection_id": id, "deleted": true }))
    }

    pub(super) async fn update_collection(
        &self,
        p: UpdateCollection,
    ) -> Result<Value, ControlError> {
        let name = p.name.as_deref().map(display_name).transpose()?;
        let description = p.description.as_deref().map(description_text).transpose()?;
        let _gate = self.account_gate.lock().await;
        let mut inner = self.inner.lock().await;
        let mut next = inner.registry.clone();
        let entry = next.get_mut(&p.collection).ok_or_else(|| {
            ControlError::not_found(format!("no registered collection {}", p.collection))
        })?;
        if let Some(name) = name {
            entry.name = name;
        }
        if let Some(description) = description {
            entry.description = description;
        }
        let entry = entry.clone();
        self.save_registry(&next)?;
        inner.registry = next;
        self.authority.publish_registry(&inner.registry);
        let host = inner
            .hosts
            .iter_mut()
            .find(|h| h.entry().id == p.collection)
            .ok_or_else(|| ControlError::internal("registry and hosts disagree"))?;
        host.set_entry(entry);
        let status = host.status();
        drop(inner);
        drop(_gate);
        self.bump();
        to_value(&status)
    }

    pub(super) async fn set_paused(&self, id: &str, paused: bool) -> Result<Value, ControlError> {
        let _gate = self.account_gate.lock().await;
        let mut inner = self.inner.lock().await;
        let mut next = inner.registry.clone();
        let entry = next
            .get_mut(id)
            .ok_or_else(|| ControlError::not_found(format!("no registered collection {id}")))?;
        // An adopt stopped before Connect created anything is abandoned by resuming
        // locally; one whose log exists must be finished, not reopened local-only.
        if !paused && entry.mode == SyncMode::Local {
            let journal =
                crate::adopt::Journal::path(&self.profile.state_dir.join("collections"), &entry.id);
            match crate::adopt::Journal::load(&journal) {
                Ok(None) => {}
                Ok(Some(j)) if j.created.is_none() => crate::adopt::Journal::remove(&journal)
                    .map_err(|e| ControlError::internal(format!("adopt journal: {e}")))?,
                Ok(Some(_)) => {
                    return Err(ControlError::invalid(
                        "adopt_in_progress",
                        format!("sync is being turned on; run `mdbase sync enable {id}` to finish"),
                    ));
                }
                Err(e) => return Err(ControlError::internal(format!("adopt journal: {e}"))),
            }
        }
        entry.paused = paused;
        let entry = entry.clone();
        self.save_registry(&next)?;
        inner.registry = next;
        self.authority.publish_registry(&inner.registry);
        let host = inner
            .hosts
            .iter_mut()
            .find(|h| h.entry().id == id)
            .ok_or_else(|| ControlError::internal("registry and hosts disagree"))?;
        if paused {
            host.close().await;
        }
        host.set_entry(entry);
        let status = host.status();
        let barrier = (!paused).then(|| host.barrier()).flatten();
        drop(inner);
        drop(_gate);
        self.bump();
        if paused {
            return to_value(&status);
        }
        // Resume returns once the collection serves again (or settles in another
        // state), so an immediate `holds` or session never sees not_serving.
        if let Some(b) = barrier {
            let _ = tokio::time::timeout(RESUME_WAIT, b.wait()).await;
        }
        to_value(&self.settled_status(id, RESUME_WAIT).await?)
    }
}

/// How long `collection.resume` waits for the collection to serve again.
const RESUME_WAIT: Duration = Duration::from_secs(30);

/// A Connect refusal as a control error (no secrets in messages).
pub(super) fn join_refusal(error: crate::cloud::CloudError) -> ControlError {
    match error {
        crate::cloud::CloudError::Server(404, code) if code == "not_found" => {
            ControlError::not_found("No collection with this ID is available to this account")
        }
        other => cloud_refusal(other),
    }
}

/// A collection display name: trimmed, 1 to 100 characters, no control characters
/// (it is shown on approval screens and in the account).
fn display_name(value: &str) -> Result<String, ControlError> {
    checked_name(value, "a collection name")
}

/// The control plane's name for a collection created without one.
pub(super) const SERVER_PLACEHOLDER_NAME: &str = "New collection";

/// A joined collection's local name: the one given, else the account's (unless
/// it is the control plane's placeholder), else the folder's.
pub(super) fn join_name(
    given: Option<&str>,
    account: Option<&str>,
    root: &std::path::Path,
) -> Result<String, ControlError> {
    if let Some(n) = given {
        return display_name(n);
    }
    Ok(account
        .and_then(|n| display_name(n).ok())
        .filter(|n| n != SERVER_PLACEHOLDER_NAME)
        .unwrap_or_else(|| {
            root.file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| root.display().to_string())
        }))
}

/// A name shown to people (collection or computer): trimmed, 1 to 100 characters,
/// no control or direction-changing characters.
pub(super) fn checked_name(value: &str, what: &str) -> Result<String, ControlError> {
    let v = value.trim();
    if v.is_empty()
        || v.chars().count() > 100
        || v.chars()
            .any(|c| c.is_control() || matches!(c, '\u{2028}' | '\u{2029}') || is_bidi_control(c))
    {
        return Err(ControlError::invalid(
            "name",
            format!(
                "{what} is 1 to 100 characters, without control or direction-changing characters"
            ),
        ));
    }
    Ok(v.to_string())
}

/// Bidirectional formatting characters, which can make a name read differently
/// from what it is.
fn is_bidi_control(c: char) -> bool {
    matches!(c, '\u{061C}' | '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

/// A description: trimmed, at most 500 characters; empty clears it. Line breaks
/// and tabs are allowed, other control characters are not.
fn description_text(value: &str) -> Result<Option<String>, ControlError> {
    let v = value.trim();
    if v.chars().count() > 500
        || v.chars()
            .any(|c| (c.is_control() && !matches!(c, '\n' | '\t')) || is_bidi_control(c))
    {
        return Err(ControlError::invalid(
            "description",
            "a description is at most 500 characters",
        ));
    }
    Ok((!v.is_empty()).then(|| v.to_string()))
}

/// The collection's `spec_version` from `mdbase.yaml`, for the inventory.
pub(super) fn spec_version(root: &std::path::Path) -> String {
    std::fs::read_to_string(root.join("mdbase.yaml"))
        .ok()
        .and_then(|y| {
            y.lines().find_map(|l| {
                l.strip_prefix("spec_version:")
                    .map(|v| v.trim().trim_matches(['"', '\'']).to_string())
            })
        })
        .filter(|v| !v.is_empty() && v.len() <= 30)
        .unwrap_or_else(|| "0.3.0".into())
}
