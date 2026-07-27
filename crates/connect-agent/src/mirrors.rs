use crate::cloud::CloudControlClient;
use mdbase_connect_core::{
    collection_identity, CollectionRegistry, ConnectError, SystemSecretStore,
};
use mdbase_connect_mirror::{
    clear_mirror_marker, mark_mirror, mirror_lock_path, DirectoryMirror, HttpSyncTransport,
    MirrorError,
};
use mdbase_connect_protocol::{
    MirrorAddParams, MirrorIdParams, MirrorPromotionSummary, MirrorResolveParams, MirrorState,
    MirrorSummary, SyncReplicaMode,
};
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, RwLock};
use std::time::Duration;
use tempfile::NamedTempFile;
use tokio::task::JoinSet;
use tokio::time::Instant;
use uuid::Uuid;

const SYNC_INTERVAL: Duration = Duration::from_secs(5);
const MAX_BACKGROUND_BACKOFF: Duration = Duration::from_secs(5 * 60);
const TOKEN_RENEWAL_WINDOW_SECONDS: i64 = 24 * 60 * 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum MirrorLifecycle {
    Provisioning,
    Active,
    Revoking,
    Removing,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct MirrorRegistryEntry {
    collection_id: Uuid,
    replica_id: Uuid,
    name: String,
    mode: SyncReplicaMode,
    path: PathBuf,
    sync_url: String,
    control_url: String,
    enrollment_id: Uuid,
    access_token_expires_at: String,
    created_at: String,
    lifecycle: MirrorLifecycle,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    promotion: Option<MirrorPromotionCheckpoint>,
}

#[derive(Debug, Serialize, Deserialize)]
struct MirrorRegistryFile {
    version: u32,
    mirrors: Vec<MirrorRegistryEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct MirrorCredentials {
    access_token: String,
    refresh_token: String,
}

#[derive(Debug, Deserialize)]
struct PairingBegin {
    pairing_id: Uuid,
    pairing_secret: String,
}

#[derive(Debug, Deserialize)]
struct PairingExchange {
    status: String,
    replica: PairingReplica,
    token: String,
    token_expires_at: String,
    sync_url: String,
}

#[derive(Debug, Deserialize)]
struct PairingReplica {
    id: Uuid,
    collection_id: Uuid,
    name: String,
    mode: SyncReplicaMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum MirrorPromotionPhase {
    Requested,
    Prepared,
    Registered,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct MirrorPromotionCheckpoint {
    transfer_id: Uuid,
    expires_at: String,
    verification_uri: String,
    phase: MirrorPromotionPhase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    final_head: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    authority_epoch: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    manifest_digest: Option<String>,
    identity_was_present: bool,
    registration_was_present: bool,
}

#[derive(Debug, Deserialize)]
struct AuthorityTransferResponse {
    transfer: AuthorityTransfer,
    #[serde(default)]
    verification_uri: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AuthorityTransfer {
    id: Uuid,
    collection_id: Uuid,
    replica_id: Uuid,
    state: String,
    final_head: Option<u64>,
    authority_epoch: Option<u64>,
    manifest_digest: Option<String>,
    expires_at: String,
    verification_uri: String,
}

#[derive(Debug, Deserialize)]
struct AuthorityTransferCompletion {
    status: String,
    collection_id: Option<Uuid>,
    authority_epoch: Option<u64>,
}

pub struct MirrorManager {
    state_dir: PathBuf,
    lock_root: PathBuf,
    registry: CollectionRegistry,
    cloud: Option<CloudControlClient>,
    client: Client,
    secrets: SystemSecretStore,
    entries: RwLock<Vec<MirrorRegistryEntry>>,
    syncing: StdMutex<HashSet<Uuid>>,
    errors: RwLock<HashMap<Uuid, String>>,
}

impl MirrorManager {
    pub fn open(
        state_dir: &Path,
        registry: CollectionRegistry,
        cloud: Option<CloudControlClient>,
    ) -> Result<Arc<Self>, ConnectError> {
        let entries = read_registry(&state_dir.join("mirrors.json"))?;
        let lock_root = default_lock_root(state_dir);
        fs::create_dir_all(&lock_root)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&lock_root, fs::Permissions::from_mode(0o700))?;
        }
        Ok(Arc::new(Self {
            state_dir: state_dir.to_path_buf(),
            lock_root,
            registry,
            cloud,
            client: Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .map_err(|error| ConnectError::Cloud(error.to_string()))?,
            secrets: SystemSecretStore::new(state_dir),
            entries: RwLock::new(entries),
            syncing: StdMutex::new(HashSet::new()),
            errors: RwLock::new(HashMap::new()),
        }))
    }

    pub fn start(self: &Arc<Self>) -> tokio::task::JoinHandle<()> {
        let manager = self.clone();
        tokio::spawn(async move {
            manager.recover_provisioning().await;
            manager.recover_removals().await;
            let mut interval = tokio::time::interval(SYNC_INTERVAL);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut workers = JoinSet::new();
            let mut retries = HashMap::<Uuid, BackgroundRetry>::new();
            loop {
                tokio::select! {
                    _ = interval.tick() => {
                        let entries = manager.entries();
                        let actionable = entries
                            .iter()
                            .filter(|entry| {
                                (entry.lifecycle == MirrorLifecycle::Active
                                    && entry.promotion.is_none())
                                    || matches!(
                                        entry.lifecycle,
                                        MirrorLifecycle::Revoking | MirrorLifecycle::Removing
                                    )
                            })
                            .map(|entry| entry.replica_id)
                            .collect::<HashSet<_>>();
                        retries.retain(|replica_id, _| actionable.contains(replica_id));
                        let now = Instant::now();
                        for entry in entries.into_iter().filter(|entry| {
                            actionable.contains(&entry.replica_id)
                                && retries
                                    .get(&entry.replica_id)
                                    .is_none_or(|retry| retry.at <= now)
                        }) {
                            let manager = manager.clone();
                            workers.spawn(async move {
                                let replica_id = entry.replica_id;
                                let result = if entry.lifecycle == MirrorLifecycle::Active {
                                    manager.sync_entry(entry, true).await
                                } else {
                                    let mut entry = entry;
                                    manager.revoke_and_remove(&mut entry, true).await
                                };
                                (replica_id, result)
                            });
                        }
                    }
                    completed = workers.join_next(), if !workers.is_empty() => {
                        match completed {
                            Some(Ok((replica_id, Ok(())))) => {
                                retries.remove(&replica_id);
                            }
                            Some(Ok((_, Err(error)))) if error.code() == "mirror_sync_skipped" => {}
                            Some(Ok((replica_id, Err(error)))) => {
                                let retry = retries.entry(replica_id).or_default();
                                retry.failures = retry.failures.saturating_add(1);
                                let delay = background_retry_delay(replica_id, retry.failures);
                                retry.at = Instant::now() + delay;
                                tracing::warn!(
                                    replica_id = %replica_id,
                                    code = error.code(),
                                    retry_in_seconds = delay.as_secs_f64(),
                                    error = %error,
                                    "hosted mirror background sync failed"
                                );
                            }
                            Some(Err(error)) => {
                                tracing::error!(
                                    error = %error,
                                    "hosted mirror background worker failed"
                                );
                            }
                            None => {}
                        }
                    }
                }
            }
        })
    }

    pub async fn list(&self) -> Result<Vec<MirrorSummary>, ConnectError> {
        let entries = self.entries();
        let mut summaries = Vec::with_capacity(entries.len());
        for entry in entries {
            summaries.push(self.summary(&entry)?);
        }
        summaries.sort_by(|left, right| {
            left.name
                .to_lowercase()
                .cmp(&right.name.to_lowercase())
                .then_with(|| left.replica_id.cmp(&right.replica_id))
        });
        Ok(summaries)
    }

    pub async fn add(&self, params: MirrorAddParams) -> Result<MirrorSummary, ConnectError> {
        let cloud = self.cloud()?;
        let selected = PathBuf::from(&params.path);
        fs::create_dir_all(&selected)?;
        let path = fs::canonicalize(&selected)?;
        if !path.is_dir() {
            return Err(mirror_error(
                "invalid_mirror_path",
                "Mirror path must be a directory.",
            ));
        }
        self.ensure_path_available(&path, params.collection_id)?;
        let name = params
            .name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("{} mirror", computer_name()));
        if name.chars().count() > 200 {
            return Err(mirror_error(
                "invalid_mirror_name",
                "Mirror name must contain between 1 and 200 characters.",
            ));
        }
        let begin = self
            .public_json::<PairingBegin>(
                Method::POST,
                &format!("{}/v1/mirror-pairing-requests", cloud.server_url()),
                Some(serde_json::json!({
                    "mirror_name": name,
                    "mode": params.mode,
                    "collection_id": params.collection_id
                })),
                None,
            )
            .await?;
        if !valid_pairing_secret(&begin.pairing_secret) {
            return Err(mirror_error(
                "invalid_mirror_enrollment",
                "Connect returned an invalid mirror enrollment credential.",
            ));
        }
        cloud
            .connector_request::<Value>(
                Method::POST,
                &format!(
                    "/v1/connectors/mirror-pairing-requests/{}/approve",
                    begin.pairing_id
                ),
                Some(serde_json::json!({"collection_id": params.collection_id})),
            )
            .await?;
        let exchange = self
            .public_json::<PairingExchange>(
                Method::POST,
                &format!(
                    "{}/v1/mirror-pairing-requests/{}/exchange",
                    cloud.server_url(),
                    begin.pairing_id
                ),
                None,
                Some(&begin.pairing_secret),
            )
            .await?;
        if exchange.status != "paired"
            || exchange.replica.collection_id != params.collection_id
            || exchange.replica.mode != params.mode
            || exchange.replica.name != name
        {
            return Err(mirror_error(
                "invalid_mirror_enrollment",
                "Connect returned mirror details that do not match the request.",
            ));
        }
        let mut entry = MirrorRegistryEntry {
            collection_id: exchange.replica.collection_id,
            replica_id: exchange.replica.id,
            name: exchange.replica.name,
            mode: exchange.replica.mode,
            path,
            sync_url: exchange.sync_url,
            control_url: cloud.server_url().to_string(),
            enrollment_id: begin.pairing_id,
            access_token_expires_at: exchange.token_expires_at,
            created_at: chrono::Utc::now().to_rfc3339(),
            lifecycle: MirrorLifecycle::Provisioning,
            promotion: None,
        };
        let credentials = MirrorCredentials {
            access_token: exchange.token,
            refresh_token: begin.pairing_secret,
        };
        self.insert_entry(entry.clone())?;
        let provisioned = self
            .finish_provisioning(&mut entry, &credentials)
            .await
            .and_then(|_| self.summary(&entry));
        if let Err(error) = &provisioned {
            tracing::warn!(
                replica_id = %entry.replica_id,
                code = error.code(),
                "rolling back incomplete mirror enrollment"
            );
            if let Err(cleanup_error) = self.revoke_and_remove(&mut entry, false).await {
                tracing::warn!(
                    replica_id = %entry.replica_id,
                    code = cleanup_error.code(),
                    error = %cleanup_error,
                    "incomplete mirror enrollment cleanup will resume"
                );
            }
        }
        provisioned
    }

    pub async fn sync(&self, params: MirrorIdParams) -> Result<MirrorSummary, ConnectError> {
        let entry = self.entry(params.replica_id)?;
        self.require_active(&entry)?;
        if entry.promotion.is_some() {
            return Err(mirror_error(
                "mirror_promotion_in_progress",
                "This mirror is fenced for an authority transfer.",
            ));
        }
        self.sync_entry(entry.clone(), false).await?;
        self.summary(&entry)
    }

    pub async fn resolve(
        &self,
        params: MirrorResolveParams,
    ) -> Result<MirrorSummary, ConnectError> {
        let entry = self.entry(params.replica_id)?;
        self.require_active(&entry)?;
        if entry.promotion.is_some() {
            return Err(mirror_error(
                "mirror_promotion_in_progress",
                "Resolve mirror conflicts before beginning an authority transfer.",
            ));
        }
        let _guard = self.begin_operation(entry.replica_id, false)?;
        let mirror = self.mirror(&entry).await?;
        mirror
            .resolve_conflict(params.record_id, params.resolution)
            .await
            .map_err(from_mirror)?;
        drop(_guard);
        self.sync_entry(entry.clone(), false).await?;
        self.summary(&entry)
    }

    pub async fn remove(&self, params: MirrorIdParams) -> Result<Value, ConnectError> {
        let mut entry = self.entry(params.replica_id)?;
        self.revoke_and_remove(&mut entry, false).await?;
        Ok(serde_json::json!({
            "removed": true,
            "path": entry.path
        }))
    }

    pub async fn begin_promotion(&self, params: MirrorIdParams) -> Result<Value, ConnectError> {
        let mut entry = self.entry(params.replica_id)?;
        self.require_active(&entry)?;
        if entry.mode != SyncReplicaMode::ReadWrite {
            return Err(mirror_error(
                "promotion_requires_writable_mirror",
                "Only a two-way full collection mirror can become the local authority.",
            ));
        }
        if let Some(checkpoint) = &entry.promotion {
            return Ok(serde_json::json!({
                "verification_uri": checkpoint.verification_uri,
                "expires_at": checkpoint.expires_at,
                "resumed": true
            }));
        }
        self.sync_entry(entry.clone(), false).await?;
        self.build_mirror(&entry, "promotion-manifest-does-not-use-a-credential")?
            .authority_promotion_manifest()
            .map_err(from_mirror)?;
        let credentials = self.current_credentials(&entry).await?;
        let response = self
            .public_json::<AuthorityTransferResponse>(
                Method::POST,
                &format!(
                    "{}/v1/mirror-pairing-requests/{}/authority-transfers",
                    entry.control_url, entry.enrollment_id
                ),
                Some(serde_json::json!({})),
                Some(&credentials.refresh_token),
            )
            .await?;
        validate_transfer(&response.transfer, &entry, None)?;
        let verification_uri = trusted_control_url(
            &entry.control_url,
            response
                .verification_uri
                .as_deref()
                .unwrap_or(&response.transfer.verification_uri),
        )?;
        let expires_at = response.transfer.expires_at.clone();
        entry.promotion = Some(MirrorPromotionCheckpoint {
            transfer_id: response.transfer.id,
            expires_at: expires_at.clone(),
            verification_uri: verification_uri.clone(),
            phase: MirrorPromotionPhase::Requested,
            final_head: None,
            authority_epoch: None,
            manifest_digest: None,
            identity_was_present: collection_identity(&entry.path)?.is_some(),
            registration_was_present: self
                .registry
                .list()?
                .iter()
                .any(|collection| collection.id == entry.collection_id),
        });
        self.replace_entry(entry.clone())?;
        Ok(serde_json::json!({
            "verification_uri": verification_uri,
            "expires_at": expires_at,
            "resumed": false
        }))
    }

    pub async fn complete_promotion(&self, params: MirrorIdParams) -> Result<Value, ConnectError> {
        let mut entry = self.entry(params.replica_id)?;
        let _guard = self.begin_operation(entry.replica_id, false)?;
        let mut checkpoint = entry.promotion.clone().ok_or_else(|| {
            mirror_error(
                "promotion_not_started",
                "Begin and approve this authority transfer first.",
            )
        })?;
        if entry.lifecycle == MirrorLifecycle::Removing {
            let authority_epoch = checkpoint.authority_epoch.ok_or_else(|| {
                mirror_error(
                    "invalid_authority_transfer",
                    "Completed authority transfer has no epoch.",
                )
            })?;
            self.finish_removal(&entry)?;
            return Ok(serde_json::json!({
                "collection_id": entry.collection_id,
                "authority_epoch": authority_epoch,
                "path": entry.path
            }));
        }
        self.require_active(&entry)?;
        let credentials = if checkpoint.phase == MirrorPromotionPhase::Registered {
            self.credentials(entry.replica_id)?
        } else {
            self.current_credentials(&entry).await?
        };

        if checkpoint.phase == MirrorPromotionPhase::Requested {
            let prepared = match self
                .wait_for_prepared_transfer(&entry, &checkpoint, &credentials.refresh_token)
                .await
            {
                Ok(prepared) => prepared,
                Err(error) if error.code() == "authority_transfer_expired" => {
                    entry.promotion = None;
                    self.replace_entry(entry)?;
                    return Err(error);
                }
                Err(error) => return Err(error),
            };
            checkpoint.phase = MirrorPromotionPhase::Prepared;
            checkpoint.final_head = prepared.final_head;
            checkpoint.authority_epoch = prepared.authority_epoch;
            checkpoint.manifest_digest = prepared.manifest_digest;
            entry.promotion = Some(checkpoint.clone());
            self.replace_entry(entry.clone())?;
        }

        if checkpoint.phase == MirrorPromotionPhase::Prepared {
            let mirror = self.build_mirror(&entry, &credentials.access_token)?;
            mirror.sync().await.map_err(from_mirror)?;
            let manifest = mirror.authority_promotion_manifest().map_err(from_mirror)?;
            if Some(manifest.cursor) != checkpoint.final_head
                || Some(manifest.digest.as_str()) != checkpoint.manifest_digest.as_deref()
            {
                return Err(mirror_error(
                    "promotion_manifest_mismatch",
                    "The local folder does not exactly match the fenced hosted authority.",
                ));
            }
            let activated = self
                .registry
                .activate_mirror_authority(&entry.path, entry.collection_id);
            if let Err(error) = activated {
                if let Err(rollback_error) = self.registry.rollback_mirror_authority(
                    &entry.path,
                    entry.collection_id,
                    checkpoint.identity_was_present,
                    checkpoint.registration_was_present,
                ) {
                    return Err(mirror_error(
                        "promotion_rollback_failed",
                        &format!(
                            "Authority activation failed ({error}) and local rollback needs repair: {rollback_error}"
                        ),
                    ));
                }
                let _ = self
                    .cancel_promotion(&entry, checkpoint.transfer_id, &credentials.refresh_token)
                    .await;
                entry.promotion = None;
                let _ = self.replace_entry(entry.clone());
                return Err(error);
            }
            if let Err(error) = self.registry.validate(entry.collection_id) {
                if let Err(rollback_error) = self.registry.rollback_mirror_authority(
                    &entry.path,
                    entry.collection_id,
                    checkpoint.identity_was_present,
                    checkpoint.registration_was_present,
                ) {
                    return Err(mirror_error(
                        "promotion_rollback_failed",
                        &format!(
                            "Promoted collection validation failed ({error}) and local rollback needs repair: {rollback_error}"
                        ),
                    ));
                }
                let _ = self
                    .cancel_promotion(&entry, checkpoint.transfer_id, &credentials.refresh_token)
                    .await;
                entry.promotion = None;
                let _ = self.replace_entry(entry.clone());
                return Err(error);
            }
            checkpoint.phase = MirrorPromotionPhase::Registered;
            entry.promotion = Some(checkpoint.clone());
            self.replace_entry(entry.clone())?;
        }

        let completed = self
            .wait_for_completed_transfer(&entry, &checkpoint, &credentials.refresh_token)
            .await;
        let completed = match completed {
            Ok(completed) => completed,
            Err(error) if error.code() == "authority_transfer_expired" => {
                self.registry.rollback_mirror_authority(
                    &entry.path,
                    entry.collection_id,
                    checkpoint.identity_was_present,
                    checkpoint.registration_was_present,
                )?;
                entry.promotion = None;
                self.replace_entry(entry)?;
                return Err(error);
            }
            Err(error) => return Err(error),
        };
        let authority_epoch = checkpoint.authority_epoch.ok_or_else(|| {
            mirror_error(
                "invalid_authority_transfer",
                "Prepared authority transfer has no epoch.",
            )
        })?;
        if completed.status != "completed"
            || completed.collection_id != Some(entry.collection_id)
            || completed.authority_epoch != Some(authority_epoch)
        {
            return Err(mirror_error(
                "invalid_authority_transfer",
                "Completed authority transfer does not match this mirror.",
            ));
        }
        entry.lifecycle = MirrorLifecycle::Removing;
        self.replace_entry(entry.clone())?;
        self.finish_removal(&entry)?;
        Ok(serde_json::json!({
            "collection_id": entry.collection_id,
            "authority_epoch": authority_epoch,
            "path": entry.path
        }))
    }

    fn summary(&self, entry: &MirrorRegistryEntry) -> Result<MirrorSummary, ConnectError> {
        let status = self
            .build_mirror(entry, "status-does-not-use-a-credential")?
            .status()
            .map_err(from_mirror)?;
        let mut error = self
            .errors
            .read()
            .expect("mirror error lock poisoned")
            .get(&entry.replica_id)
            .cloned();
        match entry.lifecycle {
            MirrorLifecycle::Provisioning => {
                error = Some("Mirror setup is waiting to resume.".to_string());
            }
            MirrorLifecycle::Revoking => {
                error = Some("Mirror revocation is waiting to resume.".to_string());
            }
            MirrorLifecycle::Removing => {
                error = Some("Mirror removal is waiting for local cleanup.".to_string());
            }
            MirrorLifecycle::Active => {}
        }
        let syncing = self
            .syncing
            .lock()
            .expect("mirror sync lock poisoned")
            .contains(&entry.replica_id);
        Ok(MirrorSummary {
            collection_id: entry.collection_id,
            replica_id: entry.replica_id,
            name: entry.name.clone(),
            mode: entry.mode,
            path: entry.path.to_string_lossy().to_string(),
            state: if error.is_some() {
                MirrorState::Offline
            } else {
                status.state
            },
            pending: status.pending,
            conflicts: status.conflicts,
            local_issues: status.local_issues,
            cursor: status.cursor,
            last_synced_at: status.last_synced_at,
            syncing,
            promotion_pending: entry.promotion.is_some(),
            promotion: entry
                .promotion
                .as_ref()
                .map(|checkpoint| MirrorPromotionSummary {
                    phase: match checkpoint.phase {
                        MirrorPromotionPhase::Requested => "awaiting_approval",
                        MirrorPromotionPhase::Prepared => "verifying",
                        MirrorPromotionPhase::Registered => "activating",
                    }
                    .to_string(),
                }),
            error,
        })
    }

    async fn sync_entry(
        &self,
        entry: MirrorRegistryEntry,
        skip_if_busy: bool,
    ) -> Result<(), ConnectError> {
        let _guard = self.begin_operation(entry.replica_id, skip_if_busy)?;
        let result = async {
            let mirror = self.mirror(&entry).await?;
            mirror.sync().await.map_err(from_mirror)
        }
        .await;
        match &result {
            Ok(()) => {
                self.errors
                    .write()
                    .expect("mirror error lock poisoned")
                    .remove(&entry.replica_id);
            }
            Err(error) => {
                self.errors
                    .write()
                    .expect("mirror error lock poisoned")
                    .insert(entry.replica_id, error.to_string());
            }
        }
        result
    }

    fn begin_operation(
        &self,
        replica_id: Uuid,
        skip_if_busy: bool,
    ) -> Result<MirrorOperationGuard<'_>, ConnectError> {
        let mut syncing = self.syncing.lock().expect("mirror sync lock poisoned");
        if !syncing.insert(replica_id) {
            return Err(mirror_error(
                if skip_if_busy {
                    "mirror_sync_skipped"
                } else {
                    "mirror_busy"
                },
                "This mirror is already synchronizing.",
            ));
        }
        Ok(MirrorOperationGuard {
            replica_id,
            syncing: &self.syncing,
        })
    }

    async fn mirror(&self, entry: &MirrorRegistryEntry) -> Result<DirectoryMirror, ConnectError> {
        let credentials = self.current_credentials(entry).await?;
        self.build_mirror(entry, &credentials.access_token)
    }

    fn build_mirror(
        &self,
        entry: &MirrorRegistryEntry,
        access_token: &str,
    ) -> Result<DirectoryMirror, ConnectError> {
        self.validate_mirror_root(entry)?;
        let transport =
            HttpSyncTransport::new(&entry.sync_url, access_token).map_err(from_mirror)?;
        DirectoryMirror::new(
            &entry.path,
            self.replica_state_dir(entry.replica_id).join("state.json"),
            mirror_lock_path(&self.lock_root, &entry.path),
            entry.replica_id,
            entry.mode,
            Arc::new(transport),
        )
        .map_err(from_mirror)
    }

    async fn current_credentials(
        &self,
        entry: &MirrorRegistryEntry,
    ) -> Result<MirrorCredentials, ConnectError> {
        let credentials = self.credentials(entry.replica_id)?;
        let expiry =
            chrono::DateTime::parse_from_rfc3339(&entry.access_token_expires_at).map_err(|_| {
                mirror_error(
                    "invalid_mirror_credentials",
                    "Mirror credential expiry is invalid.",
                )
            })?;
        if expiry.timestamp() - chrono::Utc::now().timestamp() >= TOKEN_RENEWAL_WINDOW_SECONDS {
            return Ok(credentials);
        }
        let renewed = self
            .public_json::<PairingExchange>(
                Method::POST,
                &format!(
                    "{}/v1/mirror-pairing-requests/{}/renew",
                    entry.control_url, entry.enrollment_id
                ),
                None,
                Some(&credentials.refresh_token),
            )
            .await?;
        if renewed.replica.id != entry.replica_id
            || renewed.replica.collection_id != entry.collection_id
            || renewed.replica.mode != entry.mode
        {
            return Err(mirror_error(
                "invalid_mirror_renewal",
                "Connect renewed credentials for a different mirror.",
            ));
        }
        let updated = MirrorCredentials {
            access_token: renewed.token,
            refresh_token: credentials.refresh_token,
        };
        self.secrets
            .set_mirror_credentials(entry.replica_id, &serde_json::to_string(&updated)?)?;
        self.update_expiry(entry.replica_id, renewed.token_expires_at)?;
        Ok(updated)
    }

    fn credentials(&self, replica_id: Uuid) -> Result<MirrorCredentials, ConnectError> {
        let value = self
            .secrets
            .mirror_credentials(replica_id)?
            .ok_or_else(|| {
                mirror_error(
                    "mirror_credentials_missing",
                    "Mirror credentials are missing from the operating-system credential store.",
                )
            })?;
        serde_json::from_str(&value).map_err(|_| {
            mirror_error(
                "invalid_mirror_credentials",
                "Mirror credentials are corrupt.",
            )
        })
    }

    async fn finish_provisioning(
        &self,
        entry: &mut MirrorRegistryEntry,
        credentials: &MirrorCredentials,
    ) -> Result<(), ConnectError> {
        self.validate_mirror_root(entry)?;
        mark_mirror(&entry.path, entry.collection_id).map_err(from_mirror)?;
        self.secrets
            .set_mirror_credentials(entry.replica_id, &serde_json::to_string(credentials)?)?;
        self.sync_entry(entry.clone(), false).await?;
        entry.lifecycle = MirrorLifecycle::Active;
        self.replace_entry(entry.clone())
    }

    async fn recover_provisioning(&self) {
        let entries = self.entries();
        for mut entry in entries
            .into_iter()
            .filter(|entry| entry.lifecycle == MirrorLifecycle::Provisioning)
        {
            let recovered = self.credentials(entry.replica_id).and_then(|credentials| {
                mark_mirror(&entry.path, entry.collection_id).map_err(from_mirror)?;
                Ok(credentials)
            });
            match recovered {
                Ok(credentials) => {
                    if self
                        .finish_provisioning(&mut entry, &credentials)
                        .await
                        .is_ok()
                    {
                        continue;
                    }
                }
                Err(error) => tracing::warn!(
                    replica_id = %entry.replica_id,
                    code = error.code(),
                    "incomplete mirror enrollment cannot resume"
                ),
            }
            if let Err(error) = self.revoke_and_remove(&mut entry, false).await {
                tracing::warn!(
                    replica_id = %entry.replica_id,
                    code = error.code(),
                    %error,
                    "incomplete mirror enrollment cleanup will be retried"
                );
            }
        }
    }

    async fn recover_removals(&self) {
        for mut entry in self.entries().into_iter().filter(|entry| {
            matches!(
                entry.lifecycle,
                MirrorLifecycle::Revoking | MirrorLifecycle::Removing
            )
        }) {
            if let Err(error) = self.revoke_and_remove(&mut entry, true).await {
                tracing::warn!(
                    replica_id = %entry.replica_id,
                    code = error.code(),
                    %error,
                    "incomplete mirror removal will be retried"
                );
            }
        }
    }

    async fn revoke_and_remove(
        &self,
        entry: &mut MirrorRegistryEntry,
        skip_if_busy: bool,
    ) -> Result<(), ConnectError> {
        let _guard = self.begin_operation(entry.replica_id, skip_if_busy)?;
        if !matches!(
            entry.lifecycle,
            MirrorLifecycle::Revoking | MirrorLifecycle::Removing
        ) {
            entry.lifecycle = MirrorLifecycle::Revoking;
            self.replace_entry(entry.clone())?;
        }
        if entry.lifecycle == MirrorLifecycle::Revoking {
            self.revoke_remote(entry.replica_id).await?;
            entry.lifecycle = MirrorLifecycle::Removing;
            self.replace_entry(entry.clone())?;
        }
        self.finish_removal(entry)
    }

    fn finish_removal(&self, entry: &MirrorRegistryEntry) -> Result<(), ConnectError> {
        self.validate_mirror_root_if_present(entry)?;
        clear_mirror_marker(&entry.path, entry.collection_id).map_err(from_mirror)?;
        match fs::remove_dir_all(self.replica_state_dir(entry.replica_id)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(ConnectError::Io(error)),
        }
        self.secrets.clear_mirror_credentials(entry.replica_id)?;
        self.remove_entry(entry.replica_id)?;
        self.errors
            .write()
            .expect("mirror error lock poisoned")
            .remove(&entry.replica_id);
        Ok(())
    }

    async fn revoke_remote(&self, replica_id: Uuid) -> Result<(), ConnectError> {
        self.cloud()?.revoke_hosted_replica(replica_id).await
    }

    async fn public_json<T: serde::de::DeserializeOwned>(
        &self,
        method: Method,
        url: &str,
        body: Option<Value>,
        bearer: Option<&str>,
    ) -> Result<T, ConnectError> {
        let mut request = self.client.request(method, url);
        if let Some(body) = body {
            request = request.json(&body);
        }
        if let Some(bearer) = bearer {
            request = request.bearer_auth(bearer);
        }
        let response = request
            .send()
            .await
            .map_err(|error| ConnectError::Cloud(error.to_string()))?;
        let status = response.status();
        let bytes = response
            .bytes()
            .await
            .map_err(|error| ConnectError::Cloud(error.to_string()))?;
        if !status.is_success() {
            let message = serde_json::from_slice::<Value>(&bytes)
                .ok()
                .and_then(|value| {
                    value
                        .pointer("/error/message")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .unwrap_or_else(|| format!("Connect request failed with HTTP {status}."));
            return Err(ConnectError::Cloud(message));
        }
        serde_json::from_slice(&bytes).map_err(ConnectError::from)
    }

    async fn wait_for_prepared_transfer(
        &self,
        entry: &MirrorRegistryEntry,
        checkpoint: &MirrorPromotionCheckpoint,
        refresh_token: &str,
    ) -> Result<AuthorityTransfer, ConnectError> {
        let deadline = parse_deadline(&checkpoint.expires_at)?;
        loop {
            if chrono::Utc::now() >= deadline {
                return Err(mirror_error(
                    "authority_transfer_expired",
                    "Authority transfer approval expired.",
                ));
            }
            let response = self
                .client
                .post(format!(
                    "{}/v1/authority-transfers/{}/prepare",
                    entry.control_url, checkpoint.transfer_id
                ))
                .bearer_auth(refresh_token)
                .json(&serde_json::json!({}))
                .send()
                .await
                .map_err(|error| ConnectError::Cloud(error.to_string()))?;
            if response.status().as_u16() == 202 {
                tokio::time::sleep(Duration::from_millis(1_500)).await;
                continue;
            }
            let value = checked_json::<AuthorityTransferResponse>(response).await?;
            validate_transfer(&value.transfer, entry, Some(checkpoint.transfer_id))?;
            if value.transfer.state != "prepared"
                || value.transfer.final_head.is_none()
                || value.transfer.authority_epoch.is_none()
                || value.transfer.manifest_digest.is_none()
            {
                return Err(mirror_error(
                    "invalid_authority_transfer",
                    "Authority returned an incomplete prepared transfer.",
                ));
            }
            return Ok(value.transfer);
        }
    }

    async fn wait_for_completed_transfer(
        &self,
        entry: &MirrorRegistryEntry,
        checkpoint: &MirrorPromotionCheckpoint,
        refresh_token: &str,
    ) -> Result<AuthorityTransferCompletion, ConnectError> {
        let deadline = parse_deadline(&checkpoint.expires_at)?;
        loop {
            let response = self
                .client
                .post(format!(
                    "{}/v1/authority-transfers/{}/complete",
                    entry.control_url, checkpoint.transfer_id
                ))
                .bearer_auth(refresh_token)
                .json(&serde_json::json!({
                    "manifest_digest": checkpoint.manifest_digest
                }))
                .send()
                .await
                .map_err(|error| ConnectError::Cloud(error.to_string()))?;
            if response.status().as_u16() == 202 {
                if chrono::Utc::now() >= deadline {
                    return Err(mirror_error(
                        "authority_transfer_expired",
                        "Authority transfer expired before activation completed.",
                    ));
                }
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            }
            return checked_json(response).await;
        }
    }

    async fn cancel_promotion(
        &self,
        entry: &MirrorRegistryEntry,
        transfer_id: Uuid,
        refresh_token: &str,
    ) -> Result<(), ConnectError> {
        let response = self
            .client
            .delete(format!(
                "{}/v1/authority-transfers/{transfer_id}",
                entry.control_url
            ))
            .bearer_auth(refresh_token)
            .send()
            .await
            .map_err(|error| ConnectError::Cloud(error.to_string()))?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(mirror_error(
                "authority_transfer_cancel_failed",
                "Authority transfer could not be cancelled.",
            ))
        }
    }

    fn ensure_path_available(&self, path: &Path, collection_id: Uuid) -> Result<(), ConnectError> {
        for collection in self.registry.list()? {
            let registered = fs::canonicalize(&collection.path)
                .unwrap_or_else(|_| PathBuf::from(&collection.path));
            let retired_authority_becoming_its_mirror = collection.id == collection_id
                && !collection.enabled
                && registered == path
                && mdbase_connect_core::mirror_collection_id(path)?
                    .is_some_and(|marker_id| marker_id == collection_id);
            if retired_authority_becoming_its_mirror {
                continue;
            }
            if paths_overlap(path, &registered) {
                return Err(mirror_error(
                    "mirror_path_overlaps_authority",
                    "Mirror folder overlaps a computer-owned collection.",
                ));
            }
        }
        if self
            .entries()
            .iter()
            .any(|entry| paths_overlap(path, &entry.path))
        {
            return Err(mirror_error(
                "mirror_path_overlap",
                "Mirror folder overlaps another hosted mirror.",
            ));
        }
        Ok(())
    }

    fn cloud(&self) -> Result<&CloudControlClient, ConnectError> {
        self.cloud.as_ref().ok_or_else(|| {
            ConnectError::Cloud("Connect this computer to an account first.".to_string())
        })
    }

    fn require_active(&self, entry: &MirrorRegistryEntry) -> Result<(), ConnectError> {
        if entry.lifecycle == MirrorLifecycle::Active {
            Ok(())
        } else {
            Err(mirror_error(
                "mirror_lifecycle_in_progress",
                "This mirror is still being provisioned or removed; retry after recovery.",
            ))
        }
    }

    fn validate_mirror_root(&self, entry: &MirrorRegistryEntry) -> Result<(), ConnectError> {
        let resolved = fs::canonicalize(&entry.path)?;
        if resolved != entry.path {
            return Err(mirror_error(
                "mirror_root_replaced",
                "The mirror root or one of its parent directories was replaced.",
            ));
        }
        self.validate_mirror_root_if_present(entry)
    }

    fn validate_mirror_root_if_present(
        &self,
        entry: &MirrorRegistryEntry,
    ) -> Result<(), ConnectError> {
        match fs::symlink_metadata(&entry.path) {
            Ok(metadata) if metadata.file_type().is_symlink() => Err(mirror_error(
                "mirror_symlink_refused",
                "The mirror root was replaced by a symbolic link.",
            )),
            Ok(metadata) if !metadata.is_dir() => Err(mirror_error(
                "invalid_mirror_path",
                "The mirror root is no longer a directory.",
            )),
            Ok(_) => {
                let resolved = fs::canonicalize(&entry.path)?;
                if resolved == entry.path {
                    Ok(())
                } else {
                    Err(mirror_error(
                        "mirror_root_replaced",
                        "The mirror root or one of its parent directories was replaced.",
                    ))
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(ConnectError::Io(error)),
        }
    }

    fn entries(&self) -> Vec<MirrorRegistryEntry> {
        self.entries
            .read()
            .expect("mirror registry lock poisoned")
            .clone()
    }

    fn entry(&self, replica_id: Uuid) -> Result<MirrorRegistryEntry, ConnectError> {
        self.entries()
            .into_iter()
            .find(|entry| entry.replica_id == replica_id)
            .ok_or_else(|| {
                mirror_error(
                    "mirror_not_found",
                    "That mirror is not controlled by this computer.",
                )
            })
    }

    fn insert_entry(&self, entry: MirrorRegistryEntry) -> Result<(), ConnectError> {
        let mut entries = self.entries.write().expect("mirror registry lock poisoned");
        if entries.iter().any(|candidate| {
            candidate.replica_id == entry.replica_id || paths_overlap(&candidate.path, &entry.path)
        }) {
            return Err(mirror_error(
                "mirror_already_exists",
                "That mirror or folder is already registered.",
            ));
        }
        let mut updated = entries.clone();
        updated.push(entry);
        write_registry(&self.state_dir.join("mirrors.json"), &updated)?;
        *entries = updated;
        Ok(())
    }

    fn replace_entry(&self, entry: MirrorRegistryEntry) -> Result<(), ConnectError> {
        let mut entries = self.entries.write().expect("mirror registry lock poisoned");
        let mut updated = entries.clone();
        let target = updated
            .iter_mut()
            .find(|candidate| candidate.replica_id == entry.replica_id)
            .ok_or_else(|| mirror_error("mirror_not_found", "Mirror registration disappeared."))?;
        *target = entry;
        write_registry(&self.state_dir.join("mirrors.json"), &updated)?;
        *entries = updated;
        Ok(())
    }

    fn update_expiry(&self, replica_id: Uuid, expiry: String) -> Result<(), ConnectError> {
        let mut entries = self.entries.write().expect("mirror registry lock poisoned");
        let mut updated = entries.clone();
        let target = updated
            .iter_mut()
            .find(|candidate| candidate.replica_id == replica_id)
            .ok_or_else(|| mirror_error("mirror_not_found", "Mirror registration disappeared."))?;
        target.access_token_expires_at = expiry;
        write_registry(&self.state_dir.join("mirrors.json"), &updated)?;
        *entries = updated;
        Ok(())
    }

    fn remove_entry(&self, replica_id: Uuid) -> Result<(), ConnectError> {
        let mut entries = self.entries.write().expect("mirror registry lock poisoned");
        let mut updated = entries.clone();
        updated.retain(|entry| entry.replica_id != replica_id);
        write_registry(&self.state_dir.join("mirrors.json"), &updated)?;
        *entries = updated;
        Ok(())
    }

    fn replica_state_dir(&self, replica_id: Uuid) -> PathBuf {
        self.state_dir.join("mirrors").join(replica_id.to_string())
    }
}

struct MirrorOperationGuard<'a> {
    replica_id: Uuid,
    syncing: &'a StdMutex<HashSet<Uuid>>,
}

struct BackgroundRetry {
    failures: u32,
    at: Instant,
}

impl Default for BackgroundRetry {
    fn default() -> Self {
        Self {
            failures: 0,
            at: Instant::now(),
        }
    }
}

impl Drop for MirrorOperationGuard<'_> {
    fn drop(&mut self) {
        self.syncing
            .lock()
            .expect("mirror sync lock poisoned")
            .remove(&self.replica_id);
    }
}

fn read_registry(path: &Path) -> Result<Vec<MirrorRegistryEntry>, ConnectError> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(ConnectError::Io(error)),
    };
    let registry = serde_json::from_slice::<MirrorRegistryFile>(&bytes)?;
    if registry.version != 2 {
        return Err(mirror_error(
            "invalid_mirror_registry",
            "Mirror registry version is not supported.",
        ));
    }
    let mut paths = Vec::<PathBuf>::new();
    let mut replica_ids = HashSet::new();
    let mut enrollment_ids = HashSet::new();
    for entry in &registry.mirrors {
        if !entry.path.is_absolute()
            || paths
                .iter()
                .any(|existing| paths_overlap(existing, &entry.path))
            || !replica_ids.insert(entry.replica_id)
            || !enrollment_ids.insert(entry.enrollment_id)
        {
            return Err(mirror_error(
                "invalid_mirror_registry",
                "Mirror registry contains a duplicate identity or invalid path.",
            ));
        }
        HttpSyncTransport::new(&entry.sync_url, "registry-validation").map_err(from_mirror)?;
        validate_control_origin(&entry.control_url)?;
        if entry.name.trim().is_empty()
            || entry.name.chars().count() > 200
            || chrono::DateTime::parse_from_rfc3339(&entry.access_token_expires_at).is_err()
            || chrono::DateTime::parse_from_rfc3339(&entry.created_at).is_err()
        {
            return Err(mirror_error(
                "invalid_mirror_registry",
                "Mirror registry contains invalid metadata.",
            ));
        }
        paths.push(entry.path.clone());
    }
    Ok(registry.mirrors)
}

fn write_registry(path: &Path, entries: &[MirrorRegistryEntry]) -> Result<(), ConnectError> {
    let parent = path.parent().ok_or_else(|| {
        mirror_error(
            "invalid_mirror_registry",
            "Mirror registry path is invalid.",
        )
    })?;
    fs::create_dir_all(parent)?;
    let mut temporary = NamedTempFile::new_in(parent)?;
    temporary.write_all(&serde_json::to_vec_pretty(&MirrorRegistryFile {
        version: 2,
        mirrors: entries.to_vec(),
    })?)?;
    temporary.as_file().sync_all()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    temporary.persist(path).map_err(|error| error.error)?;
    #[cfg(unix)]
    File::open(parent)?.sync_all()?;
    Ok(())
}

fn default_lock_root(state_dir: &Path) -> PathBuf {
    directories::ProjectDirs::from("dev", "mdbase", "connect")
        .map(|directories| directories.data_local_dir().join("mirror-locks"))
        .unwrap_or_else(|| state_dir.join("mirror-locks"))
}

fn paths_overlap(left: &Path, right: &Path) -> bool {
    left == right || left.starts_with(right) || right.starts_with(left)
}

fn background_retry_delay(replica_id: Uuid, failures: u32) -> Duration {
    let exponent = failures.saturating_sub(1).min(6);
    let base_millis = SYNC_INTERVAL
        .as_millis()
        .saturating_mul(1_u128 << exponent)
        .min(MAX_BACKGROUND_BACKOFF.as_millis());
    let seed = replica_id
        .as_bytes()
        .iter()
        .fold(failures as u64, |value, byte| {
            value
                .wrapping_mul(1_099_511_628_211)
                .wrapping_add(*byte as u64)
        });
    let jitter_percent = 80 + seed % 41;
    let millis = base_millis
        .saturating_mul(jitter_percent as u128)
        .saturating_div(100)
        .min(MAX_BACKGROUND_BACKOFF.as_millis());
    Duration::from_millis(millis as u64)
}

fn computer_name() -> String {
    std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "This computer".to_string())
}

fn valid_pairing_secret(value: &str) -> bool {
    value.starts_with("mir_") && value.len() >= 24 && !value.chars().any(char::is_whitespace)
}

fn validate_transfer(
    transfer: &AuthorityTransfer,
    entry: &MirrorRegistryEntry,
    expected_transfer_id: Option<Uuid>,
) -> Result<(), ConnectError> {
    if transfer.collection_id != entry.collection_id
        || transfer.replica_id != entry.replica_id
        || expected_transfer_id.is_some_and(|expected| transfer.id != expected)
    {
        return Err(mirror_error(
            "invalid_authority_transfer",
            "Authority transfer does not match this mirror.",
        ));
    }
    Ok(())
}

fn trusted_control_url(control_url: &str, candidate: &str) -> Result<String, ConnectError> {
    validate_control_origin(control_url)?;
    let control = url::Url::parse(control_url)
        .map_err(|_| mirror_error("invalid_control_url", "Mirror control origin is invalid."))?;
    let candidate = url::Url::parse(candidate).map_err(|_| {
        mirror_error(
            "invalid_verification_url",
            "Authority verification address is invalid.",
        )
    })?;
    if control.origin() != candidate.origin()
        || !candidate.username().is_empty()
        || candidate.password().is_some()
    {
        return Err(mirror_error(
            "untrusted_verification_url",
            "Authority returned a verification address on another origin.",
        ));
    }
    Ok(candidate.to_string())
}

fn validate_control_origin(control_url: &str) -> Result<(), ConnectError> {
    let control = url::Url::parse(control_url)
        .map_err(|_| mirror_error("invalid_control_url", "Mirror control origin is invalid."))?;
    let loopback = matches!(control.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
    let secure = control.scheme() == "https" || (control.scheme() == "http" && loopback);
    if control.host_str().is_none()
        || !secure
        || !control.username().is_empty()
        || control.password().is_some()
        || !matches!(control.path(), "" | "/")
        || control.query().is_some()
        || control.fragment().is_some()
    {
        return Err(mirror_error(
            "invalid_control_url",
            "Mirror control origin must use HTTPS without credentials, a path, or a query.",
        ));
    }
    Ok(())
}

fn parse_deadline(value: &str) -> Result<chrono::DateTime<chrono::Utc>, ConnectError> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|value| value.with_timezone(&chrono::Utc))
        .map_err(|_| {
            mirror_error(
                "invalid_authority_transfer",
                "Authority transfer expiry is invalid.",
            )
        })
}

async fn checked_json<T: serde::de::DeserializeOwned>(
    response: reqwest::Response,
) -> Result<T, ConnectError> {
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| ConnectError::Cloud(error.to_string()))?;
    if !status.is_success() {
        let value = serde_json::from_slice::<Value>(&bytes).ok();
        let code = value
            .as_ref()
            .and_then(|value| value.pointer("/error/code"))
            .and_then(Value::as_str)
            .unwrap_or("authority_transfer_failed");
        let message = value
            .as_ref()
            .and_then(|value| value.pointer("/error/message"))
            .and_then(Value::as_str)
            .unwrap_or("Authority transfer request failed.");
        return Err(mirror_error(code, message));
    }
    serde_json::from_slice(&bytes).map_err(|error| {
        mirror_error(
            "invalid_authority_transfer",
            &format!("Authority transfer response is invalid: {error}"),
        )
    })
}

fn mirror_error(code: &str, message: &str) -> ConnectError {
    ConnectError::Mirror {
        code: code.to_string(),
        message: message.to_string(),
    }
}

fn from_mirror(error: MirrorError) -> ConnectError {
    ConnectError::Mirror {
        code: error.code,
        message: error.message,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlap_is_component_aware() {
        assert!(paths_overlap(
            Path::new("/notes"),
            Path::new("/notes/tasks")
        ));
        assert!(!paths_overlap(
            Path::new("/notes"),
            Path::new("/notes-archive")
        ));
    }

    #[test]
    fn registry_contains_no_credentials() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("mirrors.json");
        let entry = MirrorRegistryEntry {
            collection_id: Uuid::new_v4(),
            replica_id: Uuid::new_v4(),
            name: "Notes".to_string(),
            mode: SyncReplicaMode::ReadWrite,
            path: temporary.path().join("notes"),
            sync_url:
                "https://connect.example/v1/authorities/01900000-0000-7000-8000-000000000000/sync"
                    .to_string(),
            control_url: "https://connect.example".to_string(),
            enrollment_id: Uuid::new_v4(),
            access_token_expires_at: "2026-07-28T00:00:00Z".to_string(),
            created_at: "2026-07-27T00:00:00Z".to_string(),
            lifecycle: MirrorLifecycle::Active,
            promotion: None,
        };
        write_registry(&path, &[entry]).unwrap();
        let raw = fs::read_to_string(path).unwrap();
        assert!(!raw.contains("\"access_token\":"));
        assert!(!raw.contains("\"refresh_token\":"));
        assert!(!raw.contains("Bearer"));
    }

    #[test]
    fn background_retry_is_bounded_and_jittered() {
        let replica_id = Uuid::parse_str("01900000-0000-7000-8000-000000000123").unwrap();
        let first = background_retry_delay(replica_id, 1);
        let second = background_retry_delay(replica_id, 2);
        let saturated = background_retry_delay(replica_id, u32::MAX);

        assert!((Duration::from_secs(4)..=Duration::from_secs(6)).contains(&first));
        assert!((Duration::from_secs(8)..=Duration::from_secs(12)).contains(&second));
        assert!((Duration::from_secs(4 * 60)..=MAX_BACKGROUND_BACKOFF).contains(&saturated));
        assert_ne!(first, SYNC_INTERVAL);
    }
}
