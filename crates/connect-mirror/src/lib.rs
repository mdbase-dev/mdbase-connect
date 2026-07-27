use async_trait::async_trait;
use chrono::Utc;
use fs2::FileExt;
use mdbase::frontmatter::parser::{
    is_parse_error, json_to_yaml_mapping, parse_document, yaml_mapping_to_json,
};
use mdbase_connect_protocol::{
    authority_manifest_digest, AuthoritySnapshotRecord, MirrorConflictSummary, MirrorLocalIssue,
    MirrorResolution, MirrorState as MirrorStatusState, SyncChange, SyncChangesPage,
    SyncCollectionResources, SyncMutation, SyncMutationOperation, SyncMutationReceipt, SyncRecord,
    SyncReplicaMode, SyncResourceDocument, SyncSession, SyncSnapshotPage, SYNC_PROTOCOL_VERSION,
};
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use tempfile::NamedTempFile;
use url::Url;
use uuid::Uuid;
use walkdir::WalkDir;

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct MirrorError {
    pub code: String,
    pub message: String,
}

impl MirrorError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }

    fn io(action: &str, path: &Path, error: std::io::Error) -> Self {
        Self::new(
            "mirror_io_failed",
            format!("{action} {}: {error}", path.display()),
        )
    }
}

impl From<serde_json::Error> for MirrorError {
    fn from(error: serde_json::Error) -> Self {
        Self::new("invalid_mirror_state", error.to_string())
    }
}

#[async_trait]
pub trait SyncTransport: Send + Sync {
    async fn open_session(&self) -> Result<SyncSession, MirrorError>;
    async fn snapshot(
        &self,
        snapshot_id: Uuid,
        page: Option<&str>,
    ) -> Result<SyncSnapshotPage, MirrorError>;
    async fn changes(&self, after: u64, limit: usize) -> Result<SyncChangesPage, MirrorError>;
    async fn mutate(&self, mutation: &SyncMutation) -> Result<SyncMutationReceipt, MirrorError>;
}

#[derive(Clone)]
pub struct HttpSyncTransport {
    client: Client,
    sync_url: String,
    replica_token: String,
}

impl HttpSyncTransport {
    pub fn new(sync_url: &str, replica_token: impl Into<String>) -> Result<Self, MirrorError> {
        let endpoint = Url::parse(sync_url).map_err(|_| {
            MirrorError::new(
                "invalid_sync_url",
                "Sync URL must be an absolute authority endpoint.",
            )
        })?;
        let loopback = matches!(endpoint.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
        let secure = endpoint.scheme() == "https" || (endpoint.scheme() == "http" && loopback);
        let segments = endpoint
            .path_segments()
            .map(|segments| segments.collect::<Vec<_>>())
            .unwrap_or_default();
        let valid_path = segments.len() == 5
            && segments[0] == "v1"
            && segments[1] == "authorities"
            && Uuid::parse_str(segments[2]).is_ok()
            && segments[3] == "sync"
            && segments[4].is_empty();
        let valid_path_without_slash = segments.len() == 4
            && segments[0] == "v1"
            && segments[1] == "authorities"
            && Uuid::parse_str(segments[2]).is_ok()
            && segments[3] == "sync";
        if endpoint.host_str().is_none()
            || !secure
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
            || !(valid_path || valid_path_without_slash)
        {
            return Err(MirrorError::new(
                "invalid_sync_url",
                "Sync URL must identify one HTTPS authority sync endpoint, except on loopback.",
            ));
        }
        Ok(Self {
            client: Client::new(),
            sync_url: endpoint.as_str().trim_end_matches('/').to_string(),
            replica_token: replica_token.into(),
        })
    }

    async fn request<T: serde::de::DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<T, MirrorError> {
        let mut request = self
            .client
            .request(method, format!("{}/{path}", self.sync_url))
            .bearer_auth(&self.replica_token);
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request.send().await.map_err(|error| {
            MirrorError::new(
                "mirror_offline",
                format!("Hosted authority is unavailable: {error}"),
            )
        })?;
        let status = response.status();
        let value = response.json::<Value>().await.map_err(|error| {
            MirrorError::new(
                "invalid_sync_response",
                format!("Hosted authority returned invalid JSON: {error}"),
            )
        })?;
        if !status.is_success() {
            return Err(MirrorError::new(
                value
                    .pointer("/error/code")
                    .and_then(Value::as_str)
                    .unwrap_or("sync_failed"),
                value
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or("Hosted synchronization failed."),
            ));
        }
        serde_json::from_value(value).map_err(|error| {
            MirrorError::new(
                "invalid_sync_response",
                format!("Hosted authority returned an invalid response: {error}"),
            )
        })
    }
}

#[async_trait]
impl SyncTransport for HttpSyncTransport {
    async fn open_session(&self) -> Result<SyncSession, MirrorError> {
        self.request(Method::POST, "sessions", None).await
    }

    async fn snapshot(
        &self,
        snapshot_id: Uuid,
        page: Option<&str>,
    ) -> Result<SyncSnapshotPage, MirrorError> {
        let path = {
            let mut query = url::form_urlencoded::Serializer::new(String::new());
            query.append_pair("snapshot_id", &snapshot_id.to_string());
            if let Some(page) = page {
                query.append_pair("page", page);
            }
            format!("snapshot?{}", query.finish())
        };
        self.request(Method::GET, &path, None).await
    }

    async fn changes(&self, after: u64, limit: usize) -> Result<SyncChangesPage, MirrorError> {
        self.request(
            Method::GET,
            &format!("changes?after={after}&limit={}", limit.clamp(1, 1_000)),
            None,
        )
        .await
    }

    async fn mutate(&self, mutation: &SyncMutation) -> Result<SyncMutationReceipt, MirrorError> {
        let body = serde_json::to_value(mutation)?;
        self.request(Method::POST, "mutations", Some(&body)).await
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct MirrorEntry {
    path: String,
    revision: String,
    hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    record: Option<SyncRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PendingMirrorMutation {
    mutation: SyncMutation,
    local_path: String,
    local_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredLocalIssue {
    path: String,
    code: String,
    message: String,
    hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DurableMirrorState {
    protocol_version: u32,
    replica_id: Uuid,
    scope_epoch: u64,
    cursor: u64,
    records: BTreeMap<Uuid, MirrorEntry>,
    #[serde(default)]
    resources: BTreeMap<String, MirrorEntry>,
    mode: SyncReplicaMode,
    #[serde(default)]
    pending: Vec<PendingMirrorMutation>,
    #[serde(default)]
    conflicts: BTreeMap<Uuid, SyncMutationReceipt>,
    #[serde(default)]
    local_issues: BTreeMap<String, StoredLocalIssue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_synced_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DurableRebuildPlan {
    protocol_version: u32,
    replica_id: Uuid,
    mode: SyncReplicaMode,
    session: SyncSession,
    records: Vec<SyncRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    prior: Option<DurableMirrorState>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MirrorStatus {
    pub state: MirrorStatusState,
    pub mode: SyncReplicaMode,
    pub pending: usize,
    pub conflicts: Vec<MirrorConflictSummary>,
    pub local_issues: Vec<MirrorLocalIssue>,
    pub cursor: Option<u64>,
    pub last_synced_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthorityPromotionManifest {
    pub cursor: u64,
    pub digest: String,
}

pub struct DirectoryMirror {
    root: PathBuf,
    state_file: PathBuf,
    lock_file: PathBuf,
    replica_id: Uuid,
    mode: SyncReplicaMode,
    transport: Arc<dyn SyncTransport>,
}

impl DirectoryMirror {
    pub fn new(
        root: impl AsRef<Path>,
        state_file: impl AsRef<Path>,
        lock_file: impl AsRef<Path>,
        replica_id: Uuid,
        mode: SyncReplicaMode,
        transport: Arc<dyn SyncTransport>,
    ) -> Result<Self, MirrorError> {
        fs::create_dir_all(root.as_ref())
            .map_err(|error| MirrorError::io("Could not create", root.as_ref(), error))?;
        if fs::symlink_metadata(root.as_ref())
            .is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            return Err(MirrorError::new(
                "mirror_symlink_refused",
                "Mirror root must not be a symbolic link.",
            ));
        }
        let root = fs::canonicalize(root.as_ref())
            .map_err(|error| MirrorError::io("Could not resolve", root.as_ref(), error))?;
        if !root.is_dir() {
            return Err(MirrorError::new(
                "invalid_mirror_path",
                "Mirror path must be a directory.",
            ));
        }
        Ok(Self {
            root,
            state_file: state_file.as_ref().to_path_buf(),
            lock_file: lock_file.as_ref().to_path_buf(),
            replica_id,
            mode,
            transport,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub async fn sync(&self) -> Result<(), MirrorError> {
        let _lease = MirrorLease::acquire(&self.lock_file)?;
        self.sync_unlocked().await
    }

    async fn sync_unlocked(&self) -> Result<(), MirrorError> {
        if let Some(plan) = self.read_rebuild_plan()? {
            self.apply_rebuild(plan)?;
        }
        let Some(mut state) = self.read_state()? else {
            self.rebuild(None).await?;
            if self.mode == SyncReplicaMode::ReadWrite {
                return Box::pin(self.sync_unlocked()).await;
            }
            return Ok(());
        };
        if self.mode == SyncReplicaMode::ReadWrite {
            self.flush_pending(&mut state).await?;
            self.capture_local_changes(&mut state)?;
            self.flush_pending(&mut state).await?;
        } else {
            self.assert_undiverged(&state)?;
        }
        loop {
            let page = self.transport.changes(state.cursor, 200).await?;
            if page.scope_epoch != state.scope_epoch || page.reset_required {
                return self.rebuild(Some(state)).await;
            }
            for event in page.events {
                let record_id = match &event {
                    SyncChange::Put { record, .. } => record.record_id,
                    SyncChange::Remove { record_id, .. } => *record_id,
                };
                let local_entry = state.records.get(&record_id).cloned();
                let already_applied = self.mode == SyncReplicaMode::ReadWrite
                    && matches!(
                        (&event, &local_entry),
                        (
                            SyncChange::Put { record, .. },
                            Some(entry)
                        ) if entry.record.is_some()
                            && entry.path == record.path
                            && entry.revision == record.revision
                    );
                let local_issue = local_entry
                    .as_ref()
                    .is_some_and(|entry| state.local_issues.contains_key(&entry.path));
                if already_applied || local_issue {
                    // Preserve the exact accepted local bytes or an invalid local
                    // document until the user makes an explicit correction.
                } else if state.conflicts.contains_key(&record_id) {
                    refresh_conflict(&mut state, &event);
                } else {
                    match event {
                        SyncChange::Put { record, .. } => {
                            self.put(&mut state, record, None, false)?;
                        }
                        SyncChange::Remove {
                            record_id,
                            previous_path,
                            ..
                        } => self.remove(&mut state, record_id, &previous_path)?,
                    }
                }
            }
            state.cursor = page.cursor;
            if !page.has_more {
                state.last_synced_at = Some(now());
                self.write_state(&state)?;
                return Ok(());
            }
            self.write_state(&state)?;
        }
    }

    pub fn status(&self) -> Result<MirrorStatus, MirrorError> {
        let Some(state) = self.read_state()? else {
            return Ok(MirrorStatus {
                state: MirrorStatusState::NotInitialized,
                mode: self.mode,
                pending: 0,
                conflicts: Vec::new(),
                local_issues: Vec::new(),
                cursor: None,
                last_synced_at: None,
            });
        };
        let conflicts = state
            .conflicts
            .iter()
            .map(|(record_id, receipt)| {
                let pending_path = state
                    .pending
                    .iter()
                    .find(|pending| pending.mutation.record_id == *record_id)
                    .map(|pending| pending.local_path.clone());
                let entry_path = state.records.get(record_id).map(|entry| entry.path.clone());
                match receipt {
                    SyncMutationReceipt::Conflicted { conflict, .. } => MirrorConflictSummary {
                        record_id: *record_id,
                        path: pending_path.or(entry_path).or_else(|| {
                            conflict.current.as_ref().map(|record| record.path.clone())
                        }),
                        kind: "conflicted".to_string(),
                        message: "Local and hosted changes need a decision.".to_string(),
                    },
                    SyncMutationReceipt::Rejected { error, .. } => MirrorConflictSummary {
                        record_id: *record_id,
                        path: pending_path.or(entry_path),
                        kind: "rejected".to_string(),
                        message: error.message.clone(),
                    },
                    _ => MirrorConflictSummary {
                        record_id: *record_id,
                        path: pending_path.or(entry_path),
                        kind: "invalid".to_string(),
                        message: "Mirror conflict metadata is invalid.".to_string(),
                    },
                }
            })
            .collect::<Vec<_>>();
        let local_issues = state
            .local_issues
            .values()
            .map(|issue| MirrorLocalIssue {
                path: issue.path.clone(),
                code: issue.code.clone(),
                message: issue.message.clone(),
            })
            .collect::<Vec<_>>();
        let state_value = if !conflicts.is_empty() || !local_issues.is_empty() {
            MirrorStatusState::Attention
        } else if state.pending.is_empty() {
            MirrorStatusState::UpToDate
        } else {
            MirrorStatusState::ChangesWaiting
        };
        Ok(MirrorStatus {
            state: state_value,
            mode: self.mode,
            pending: state.pending.len(),
            conflicts,
            local_issues,
            cursor: Some(state.cursor),
            last_synced_at: state.last_synced_at,
        })
    }

    /// Prove that the folder exactly matches its last applied authority cursor.
    ///
    /// The returned digest contains neither paths nor document contents and is
    /// comparable with the fenced authority's canonical transfer manifest.
    pub fn authority_promotion_manifest(&self) -> Result<AuthorityPromotionManifest, MirrorError> {
        let _lease = MirrorLease::acquire(&self.lock_file)?;
        if self.mode != SyncReplicaMode::ReadWrite {
            return Err(MirrorError::new(
                "promotion_requires_writable_mirror",
                "Only a two-way full collection mirror can become the local authority.",
            ));
        }
        let state = self.read_state()?.ok_or_else(|| {
            MirrorError::new(
                "promotion_not_initialized",
                "Synchronize this folder before moving authority.",
            )
        })?;
        if !state.pending.is_empty()
            || !state.conflicts.is_empty()
            || !state.local_issues.is_empty()
        {
            return Err(MirrorError::new(
                "promotion_not_converged",
                "Upload or resolve every local change before moving authority.",
            ));
        }
        self.assert_undiverged(&state)?;
        let resources = state.resources.keys().cloned().collect::<HashSet<_>>();
        let managed = state
            .records
            .values()
            .map(|entry| entry.path.clone())
            .collect::<HashSet<_>>();
        let unmanaged = self
            .list_markdown(&resources)?
            .into_iter()
            .filter(|path| !managed.contains(path))
            .collect::<Vec<_>>();
        if !unmanaged.is_empty() {
            return Err(MirrorError::new(
                "promotion_unmanaged_files",
                format!(
                    "Synchronize unmanaged Markdown before moving authority: {}.",
                    unmanaged.join(", ")
                ),
            ));
        }
        let resource_documents = state
            .resources
            .values()
            .map(|entry| {
                Ok(SyncResourceDocument {
                    path: entry.path.clone(),
                    kind: "resource".to_string(),
                    revision: entry.revision.clone(),
                    document: self.read_file(&entry.path)?.ok_or_else(|| {
                        MirrorError::new(
                            "mirror_diverged",
                            format!("Authority resource {} is missing.", entry.path),
                        )
                    })?,
                })
            })
            .collect::<Result<Vec<_>, MirrorError>>()?;
        let records = state
            .records
            .values()
            .filter_map(|entry| entry.record.clone())
            .map(|record| AuthoritySnapshotRecord {
                record,
                document: String::new(),
            })
            .collect::<Vec<_>>();
        Ok(AuthorityPromotionManifest {
            cursor: state.cursor,
            digest: authority_manifest_digest(&resource_documents, &records),
        })
    }

    pub async fn resolve_conflict(
        &self,
        record_id: Uuid,
        resolution: MirrorResolution,
    ) -> Result<(), MirrorError> {
        let _lease = MirrorLease::acquire(&self.lock_file)?;
        if self.mode != SyncReplicaMode::ReadWrite {
            return Err(MirrorError::new(
                "mirror_read_only",
                "Receive-only mirrors do not contain writable conflicts.",
            ));
        }
        let mut state = self.read_state()?.ok_or_else(|| {
            MirrorError::new(
                "mirror_not_initialized",
                "Synchronize this mirror before resolving conflicts.",
            )
        })?;
        let receipt = state.conflicts.get(&record_id).cloned().ok_or_else(|| {
            MirrorError::new(
                "mirror_conflict_not_found",
                "Writable mirror conflict was not found.",
            )
        })?;
        let pending = state
            .pending
            .iter()
            .filter(|pending| pending.mutation.record_id == record_id)
            .cloned()
            .collect::<Vec<_>>();
        match resolution {
            MirrorResolution::Remote => {
                let current = match &receipt {
                    SyncMutationReceipt::Conflicted { conflict, .. } => conflict.current.clone(),
                    _ => state
                        .records
                        .get(&record_id)
                        .and_then(|entry| entry.record.clone()),
                };
                self.install_remote_resolution(&mut state, record_id, current, &pending)?;
                state
                    .pending
                    .retain(|pending| pending.mutation.record_id != record_id);
            }
            MirrorResolution::Local => match receipt {
                SyncMutationReceipt::Rejected { .. } => {
                    state
                        .pending
                        .retain(|pending| pending.mutation.record_id != record_id);
                }
                SyncMutationReceipt::Conflicted { conflict, .. } => {
                    let source = pending.last().ok_or_else(|| {
                        MirrorError::new(
                            "conflict_mutation_missing",
                            "The local change for this sync issue is unavailable.",
                        )
                    })?;
                    let local_document = self.read_file(&source.local_path)?;
                    let replacements = self.local_resolution_mutations(
                        &state,
                        record_id,
                        &source.local_path,
                        local_document.as_deref(),
                        conflict.current.as_ref(),
                    )?;
                    let first = state
                        .pending
                        .iter()
                        .position(|pending| pending.mutation.record_id == record_id)
                        .unwrap_or(state.pending.len());
                    state
                        .pending
                        .retain(|pending| pending.mutation.record_id != record_id);
                    state.pending.splice(first..first, replacements);
                    if let Some(current) = conflict.current {
                        state.records.insert(
                            record_id,
                            MirrorEntry {
                                path: current.path.clone(),
                                revision: current.revision.clone(),
                                hash: digest(&record_markdown_document(&current)?),
                                record: Some(current),
                            },
                        );
                    } else {
                        state.records.remove(&record_id);
                    }
                }
                _ => {
                    return Err(MirrorError::new(
                        "invalid_mirror_state",
                        "Mirror conflict metadata is invalid.",
                    ))
                }
            },
        }
        state.conflicts.remove(&record_id);
        self.write_state(&state)
    }

    async fn rebuild(&self, prior: Option<DurableMirrorState>) -> Result<(), MirrorError> {
        let session = self.transport.open_session().await?;
        if session.protocol_version != SYNC_PROTOCOL_VERSION
            || session.replica_id != self.replica_id
            || session.mode != self.mode
        {
            return Err(MirrorError::new(
                "invalid_mirror_session",
                "Hosted authority returned a session for a different replica or mode.",
            ));
        }
        let mut records = Vec::new();
        let mut page = None::<String>;
        let mut seen_pages = HashSet::<String>::new();
        loop {
            let snapshot = self
                .transport
                .snapshot(session.snapshot_id, page.as_deref())
                .await?;
            if snapshot.protocol_version != SYNC_PROTOCOL_VERSION
                || snapshot.scope_epoch != session.scope_epoch
                || snapshot.cursor != session.head
                || snapshot.snapshot_id != session.snapshot_id
            {
                return Err(MirrorError::new(
                    "invalid_snapshot",
                    "Hosted snapshot boundary changed during download.",
                ));
            }
            records.extend(snapshot.records);
            page = snapshot.next_page;
            if page
                .as_ref()
                .is_some_and(|page| !seen_pages.insert(page.clone()))
            {
                return Err(MirrorError::new(
                    "invalid_snapshot",
                    "Hosted snapshot repeated a page cursor.",
                ));
            }
            if page.is_none() {
                break;
            }
        }
        self.validate_snapshot_shape(&session.resources, &records)?;
        self.preflight_rebuild(&session.resources, &records, prior.as_ref())?;
        let plan = DurableRebuildPlan {
            protocol_version: SYNC_PROTOCOL_VERSION,
            replica_id: self.replica_id,
            mode: self.mode,
            session,
            records,
            prior,
        };
        self.write_rebuild_plan(&plan)?;
        self.apply_rebuild(plan)
    }

    fn apply_rebuild(&self, plan: DurableRebuildPlan) -> Result<(), MirrorError> {
        self.validate_rebuild_plan(&plan)?;
        self.validate_snapshot_shape(&plan.session.resources, &plan.records)?;
        self.preflight_rebuild(&plan.session.resources, &plan.records, plan.prior.as_ref())?;
        let target_paths = plan
            .session
            .resources
            .documents
            .iter()
            .map(|resource| resource.path.clone())
            .chain(plan.records.iter().map(|record| record.path.clone()))
            .collect::<HashSet<_>>();
        let mut state = DurableMirrorState {
            protocol_version: SYNC_PROTOCOL_VERSION,
            replica_id: self.replica_id,
            scope_epoch: plan.session.scope_epoch,
            cursor: plan.session.head,
            records: BTreeMap::new(),
            resources: BTreeMap::new(),
            mode: self.mode,
            pending: Vec::new(),
            conflicts: BTreeMap::new(),
            local_issues: BTreeMap::new(),
            last_synced_at: None,
        };
        for resource in &plan.session.resources.documents {
            self.write_file(&resource.path, resource.document.as_bytes())?;
            state.resources.insert(
                resource.path.clone(),
                MirrorEntry {
                    path: resource.path.clone(),
                    revision: resource.revision.clone(),
                    hash: digest(&resource.document),
                    record: None,
                },
            );
        }
        for record in &plan.records {
            let document = record_markdown_document(record)?;
            self.write_file(&record.path, document.as_bytes())?;
            state.records.insert(
                record.record_id,
                MirrorEntry {
                    path: record.path.clone(),
                    revision: record.revision.clone(),
                    hash: digest(&document),
                    record: (self.mode == SyncReplicaMode::ReadWrite).then_some(record.clone()),
                },
            );
        }
        if let Some(prior) = plan.prior {
            let stale_paths = prior
                .records
                .values()
                .chain(prior.resources.values())
                .filter(|entry| !target_paths.contains(&entry.path))
                .map(|entry| entry.path.clone())
                .collect::<BTreeSet<_>>();
            for path in stale_paths {
                self.remove_file(&path)?;
            }
        }
        state.last_synced_at = Some(now());
        self.write_state(&state)?;
        self.clear_rebuild_plan()
    }

    fn prior_managed_paths<'a>(
        &self,
        prior: Option<&'a DurableMirrorState>,
    ) -> HashMap<&'a str, &'a MirrorEntry> {
        prior
            .into_iter()
            .flat_map(|state| state.records.values().chain(state.resources.values()))
            .map(|entry| (entry.path.as_str(), entry))
            .collect()
    }

    fn target_paths(
        &self,
        resources: &SyncCollectionResources,
        records: &[SyncRecord],
    ) -> HashSet<String> {
        resources
            .documents
            .iter()
            .map(|resource| resource.path.clone())
            .chain(records.iter().map(|record| record.path.clone()))
            .collect()
    }

    fn validate_snapshot_shape(
        &self,
        resources: &SyncCollectionResources,
        records: &[SyncRecord],
    ) -> Result<(), MirrorError> {
        let mut paths = HashSet::<String>::new();
        for resource in &resources.documents {
            safe_path(&self.root, &resource.path)?;
            if !paths.insert(resource.path.clone()) {
                return Err(MirrorError::new(
                    "invalid_snapshot",
                    format!("Hosted snapshot repeats the path {}.", resource.path),
                ));
            }
        }
        let mut record_ids = HashSet::new();
        for record in records {
            safe_path(&self.root, &record.path)?;
            if !record_ids.insert(record.record_id) || !paths.insert(record.path.clone()) {
                return Err(MirrorError::new(
                    "invalid_snapshot",
                    format!(
                        "Hosted snapshot repeats record identity or path {}.",
                        record.path
                    ),
                ));
            }
        }
        Ok(())
    }

    fn preflight_rebuild(
        &self,
        resources: &SyncCollectionResources,
        records: &[SyncRecord],
        prior: Option<&DurableMirrorState>,
    ) -> Result<(), MirrorError> {
        let prior_paths = self.prior_managed_paths(prior);
        let target_paths = self.target_paths(resources, records);
        let mut collisions = BTreeSet::new();
        for resource in &resources.documents {
            let local = self.read_file(&resource.path)?;
            let managed = prior_paths.get(resource.path.as_str());
            if local.as_deref().is_some_and(|local| {
                local != resource.document
                    && managed.is_none_or(|entry| digest(local) != entry.hash)
            }) {
                collisions.insert(resource.path.clone());
            }
        }
        for record in records {
            let document = record_markdown_document(record)?;
            let local = self.read_file(&record.path)?;
            let managed = prior_paths.get(record.path.as_str());
            if local.as_deref().is_some_and(|local| {
                local != document && managed.is_none_or(|entry| digest(local) != entry.hash)
            }) {
                collisions.insert(record.path.clone());
            }
        }
        if let Some(prior) = prior {
            for entry in prior.records.values().chain(prior.resources.values()) {
                if target_paths.contains(&entry.path) {
                    continue;
                }
                if self
                    .read_file(&entry.path)?
                    .is_some_and(|local| digest(&local) != entry.hash)
                {
                    collisions.insert(entry.path.clone());
                }
            }
        }
        if collisions.is_empty() {
            Ok(())
        } else {
            Err(MirrorError::new(
                "mirror_initialization_conflict",
                format!(
                    "Existing files differ from hosted Markdown: {}.",
                    collisions.into_iter().collect::<Vec<_>>().join(", ")
                ),
            ))
        }
    }

    fn validate_state_shape(&self, state: &DurableMirrorState) -> Result<(), MirrorError> {
        let mut paths = HashSet::new();
        for (record_id, entry) in &state.records {
            safe_path(&self.root, &entry.path)?;
            if !paths.insert(entry.path.as_str())
                || entry.record.as_ref().is_some_and(|record| {
                    record.record_id != *record_id || record.path != entry.path
                })
            {
                return Err(MirrorError::new(
                    "invalid_mirror_state",
                    "Mirror state contains inconsistent record paths or identities.",
                ));
            }
        }
        for (path, entry) in &state.resources {
            safe_path(&self.root, &entry.path)?;
            if path != &entry.path || !paths.insert(entry.path.as_str()) {
                return Err(MirrorError::new(
                    "invalid_mirror_state",
                    "Mirror state contains inconsistent or overlapping resource paths.",
                ));
            }
        }
        for pending in &state.pending {
            safe_path(&self.root, &pending.local_path)?;
            if pending.mutation.replica_id != self.replica_id
                || pending.mutation.scope_epoch != state.scope_epoch
            {
                return Err(MirrorError::new(
                    "invalid_mirror_state",
                    "Mirror state contains a mutation for another replica or scope.",
                ));
            }
        }
        for (path, issue) in &state.local_issues {
            safe_path(&self.root, &issue.path)?;
            if path != &issue.path {
                return Err(MirrorError::new(
                    "invalid_mirror_state",
                    "Mirror state contains inconsistent local issue paths.",
                ));
            }
        }
        Ok(())
    }

    fn put(
        &self,
        state: &mut DurableMirrorState,
        record: SyncRecord,
        accepted_hash: Option<&str>,
        preserve_accepted_document: bool,
    ) -> Result<(), MirrorError> {
        let document = record_markdown_document(&record)?;
        let existing = self.read_file(&record.path)?;
        let prior = state.records.get(&record.record_id).cloned();
        if let Some(existing) = &existing {
            if existing != &document {
                let existing_hash = digest(existing);
                let unmanaged = prior
                    .as_ref()
                    .is_none_or(|entry| entry.path != record.path || existing_hash != entry.hash);
                let not_accepted = accepted_hash.is_none_or(|hash| existing_hash != hash);
                if unmanaged && not_accepted {
                    return Err(MirrorError::new(
                        "mirror_diverged",
                        format!(
                            "Local edits at {} must be resolved before the mirror can continue.",
                            record.path
                        ),
                    ));
                }
            }
        }
        if let Some(prior) = &prior {
            if prior.path != record.path {
                self.remove(state, record.record_id, &prior.path)?;
            }
        }
        let accepted_local_hash = if preserve_accepted_document {
            existing.as_ref().and_then(|existing| {
                let existing_hash = digest(existing);
                accepted_hash
                    .filter(|accepted| existing_hash == *accepted)
                    .map(|_| existing_hash)
            })
        } else {
            None
        };
        if accepted_local_hash.is_none() {
            self.write_file(&record.path, document.as_bytes())?;
        }
        state.records.insert(
            record.record_id,
            MirrorEntry {
                path: record.path.clone(),
                revision: record.revision.clone(),
                hash: accepted_local_hash.unwrap_or_else(|| digest(&document)),
                record: (self.mode == SyncReplicaMode::ReadWrite).then_some(record),
            },
        );
        Ok(())
    }

    fn remove(
        &self,
        state: &mut DurableMirrorState,
        record_id: Uuid,
        previous_path: &str,
    ) -> Result<(), MirrorError> {
        let entry = state.records.get(&record_id).cloned();
        let path = entry
            .as_ref()
            .map(|entry| entry.path.as_str())
            .unwrap_or(previous_path);
        if let Some(existing) = self.read_file(path)? {
            if entry
                .as_ref()
                .is_some_and(|entry| digest(&existing) != entry.hash)
            {
                return Err(MirrorError::new(
                    "mirror_diverged",
                    format!("Local edits at {path} must be resolved before deletion."),
                ));
            }
            self.remove_file(path)?;
        }
        state.records.remove(&record_id);
        Ok(())
    }

    fn capture_local_changes(&self, state: &mut DurableMirrorState) -> Result<(), MirrorError> {
        let resource_paths = state.resources.keys().cloned().collect::<HashSet<_>>();
        for (path, entry) in &state.resources {
            let value = self.read_file(path)?;
            if value.is_none_or(|value| digest(&value) != entry.hash) {
                return Err(MirrorError::new(
                    "mirror_diverged",
                    format!("Authority-owned resource {path} was changed locally."),
                ));
            }
        }
        let files = self.list_markdown(&resource_paths)?;
        let managed_paths = state
            .records
            .iter()
            .map(|(record_id, entry)| (entry.path.clone(), *record_id))
            .collect::<HashMap<_, _>>();
        let mut local = BTreeMap::<String, (Option<String>, String)>::new();
        for path in files {
            let Some(document) = self.read_file(&path)? else {
                continue;
            };
            let hash = digest(&document);
            let unchanged = managed_paths
                .get(&path)
                .and_then(|record_id| state.records.get(record_id))
                .is_some_and(|entry| entry.hash == hash);
            local.insert(path, ((!unchanged).then_some(document), hash));
        }
        let mut untracked = local
            .keys()
            .filter(|path| !managed_paths.contains_key(*path))
            .cloned()
            .collect::<BTreeSet<_>>();
        let mut missing = state
            .records
            .iter()
            .filter(|(_, entry)| !local.contains_key(&entry.path))
            .map(|(record_id, _)| *record_id)
            .collect::<BTreeSet<_>>();
        let mut queued = Vec::new();
        let mut predecessors = HashMap::<Uuid, Uuid>::new();

        for record_id in missing.clone() {
            if state.conflicts.contains_key(&record_id) {
                missing.remove(&record_id);
                continue;
            }
            let entry = &state.records[&record_id];
            let candidates = untracked
                .iter()
                .filter(|path| {
                    local
                        .get(*path)
                        .is_some_and(|(_, hash)| hash == &entry.hash)
                })
                .cloned()
                .collect::<Vec<_>>();
            if candidates.len() != 1 {
                continue;
            }
            let target = &candidates[0];
            queue_mutation(
                &mut queued,
                &mut predecessors,
                self.replica_id,
                state.scope_epoch,
                SyncMutationOperation::Rename,
                record_id,
                Some(entry.revision.clone()),
                object([("path", Value::String(target.clone()))]),
                target.clone(),
                Some(local[target].1.clone()),
            );
            missing.remove(&record_id);
            untracked.remove(target);
        }

        let mut local_issues = BTreeMap::new();
        for (record_id, entry) in &state.records {
            if state.conflicts.contains_key(record_id) || missing.contains(record_id) {
                continue;
            }
            let Some((document, hash)) = local.get(&entry.path) else {
                continue;
            };
            if hash == &entry.hash {
                continue;
            }
            let Some(record) = &entry.record else {
                return Err(MirrorError::new(
                    "mirror_state_upgrade_required",
                    "Run a receive sync before editing this older writable mirror.",
                ));
            };
            let document = document.as_deref().unwrap_or_default();
            match parse_markdown(document, &entry.path) {
                Ok((frontmatter, body)) => queue_mutation(
                    &mut queued,
                    &mut predecessors,
                    self.replica_id,
                    state.scope_epoch,
                    SyncMutationOperation::Update,
                    *record_id,
                    Some(entry.revision.clone()),
                    object([
                        (
                            "patch",
                            Value::Object(frontmatter_patch(&record.frontmatter, &frontmatter)),
                        ),
                        ("body", Value::String(body)),
                    ]),
                    entry.path.clone(),
                    Some(hash.clone()),
                ),
                Err(error) if error.code == "invalid_frontmatter" => {
                    local_issues.insert(
                        entry.path.clone(),
                        StoredLocalIssue {
                            path: entry.path.clone(),
                            code: error.code,
                            message: error.message,
                            hash: hash.clone(),
                        },
                    );
                }
                Err(error) => return Err(error),
            }
        }

        for record_id in missing {
            if state.conflicts.contains_key(&record_id) {
                continue;
            }
            let entry = &state.records[&record_id];
            queue_mutation(
                &mut queued,
                &mut predecessors,
                self.replica_id,
                state.scope_epoch,
                SyncMutationOperation::Delete,
                record_id,
                Some(entry.revision.clone()),
                Map::new(),
                entry.path.clone(),
                None,
            );
        }

        for path in untracked {
            let (document, hash) = &local[&path];
            let document = document.as_deref().unwrap_or_default();
            match parse_markdown(document, &path) {
                Ok((frontmatter, body)) => queue_mutation(
                    &mut queued,
                    &mut predecessors,
                    self.replica_id,
                    state.scope_epoch,
                    SyncMutationOperation::Create,
                    Uuid::new_v4(),
                    None,
                    object([
                        ("path", Value::String(path.clone())),
                        ("frontmatter", Value::Object(frontmatter)),
                        ("body", Value::String(body)),
                    ]),
                    path,
                    Some(hash.clone()),
                ),
                Err(error) if error.code == "invalid_frontmatter" => {
                    local_issues.insert(
                        path.clone(),
                        StoredLocalIssue {
                            path,
                            code: error.code,
                            message: error.message,
                            hash: hash.clone(),
                        },
                    );
                }
                Err(error) => return Err(error),
            }
        }
        state.local_issues = local_issues;
        if !queued.is_empty() {
            state.pending.extend(queued);
            self.write_state(state)?;
        }
        Ok(())
    }

    async fn flush_pending(&self, state: &mut DurableMirrorState) -> Result<(), MirrorError> {
        let mut index = 0;
        let mut mutations_since_checkpoint = 0;
        while index < state.pending.len() {
            let pending = state.pending[index].clone();
            if state.conflicts.contains_key(&pending.mutation.record_id) {
                index += 1;
                continue;
            }
            let local = self.read_file(&pending.local_path)?;
            let local_hash = local.as_deref().map(digest);
            if local_hash != pending.local_hash {
                return Err(MirrorError::new(
                    "pending_local_changed",
                    format!(
                        "Local edits at {} changed while an earlier upload was pending.",
                        pending.local_path
                    ),
                ));
            }
            let receipt = self.transport.mutate(&pending.mutation).await?;
            match &receipt {
                SyncMutationReceipt::Applied { record, .. }
                | SyncMutationReceipt::PreviouslyApplied { record, .. } => {
                    if let Some(record) = record.clone() {
                        self.put(state, record.clone(), pending.local_hash.as_deref(), true)?;
                        for later in &mut state.pending {
                            if later.mutation.record_id == pending.mutation.record_id
                                && later.mutation.causal_predecessor
                                    == Some(pending.mutation.mutation_id)
                            {
                                later.mutation.base_revision = Some(record.revision.clone());
                                later.mutation.causal_predecessor = None;
                            }
                        }
                    } else {
                        state.records.remove(&pending.mutation.record_id);
                    }
                    state.pending.remove(index);
                }
                SyncMutationReceipt::Conflicted { .. } | SyncMutationReceipt::Rejected { .. } => {
                    state.conflicts.insert(pending.mutation.record_id, receipt);
                    index += 1;
                }
            }
            mutations_since_checkpoint += 1;
            if mutations_since_checkpoint >= 64 {
                self.write_state(state)?;
                mutations_since_checkpoint = 0;
            }
        }
        if mutations_since_checkpoint > 0 {
            self.write_state(state)?;
        }
        Ok(())
    }

    fn install_remote_resolution(
        &self,
        state: &mut DurableMirrorState,
        record_id: Uuid,
        current: Option<SyncRecord>,
        pending: &[PendingMirrorMutation],
    ) -> Result<(), MirrorError> {
        let mut paths = pending
            .iter()
            .map(|pending| pending.local_path.clone())
            .collect::<BTreeSet<_>>();
        if let Some(current) = current {
            for path in &paths {
                if path != &current.path && self.read_file(path)?.is_some() {
                    self.remove_file(path)?;
                }
            }
            let accepted = self.read_file(&current.path)?.as_deref().map(digest);
            self.put(state, current, accepted.as_deref(), false)
        } else {
            if let Some(entry) = state.records.get(&record_id) {
                paths.insert(entry.path.clone());
            }
            for path in paths {
                if self.read_file(&path)?.is_some() {
                    self.remove_file(&path)?;
                }
            }
            state.records.remove(&record_id);
            Ok(())
        }
    }

    fn local_resolution_mutations(
        &self,
        state: &DurableMirrorState,
        record_id: Uuid,
        local_path: &str,
        local_document: Option<&str>,
        current: Option<&SyncRecord>,
    ) -> Result<Vec<PendingMirrorMutation>, MirrorError> {
        let mut queued = Vec::new();
        let mut predecessors = HashMap::new();
        let Some(document) = local_document else {
            if let Some(current) = current {
                queue_mutation(
                    &mut queued,
                    &mut predecessors,
                    self.replica_id,
                    state.scope_epoch,
                    SyncMutationOperation::Delete,
                    record_id,
                    Some(current.revision.clone()),
                    Map::new(),
                    local_path.to_string(),
                    None,
                );
            }
            return Ok(queued);
        };
        let (frontmatter, body) = parse_markdown(document, local_path)?;
        let local_hash = Some(digest(document));
        let Some(current) = current else {
            queue_mutation(
                &mut queued,
                &mut predecessors,
                self.replica_id,
                state.scope_epoch,
                SyncMutationOperation::Create,
                record_id,
                None,
                object([
                    ("path", Value::String(local_path.to_string())),
                    ("frontmatter", Value::Object(frontmatter)),
                    ("body", Value::String(body)),
                ]),
                local_path.to_string(),
                local_hash,
            );
            return Ok(queued);
        };
        if document != record_markdown_document(current)? {
            queue_mutation(
                &mut queued,
                &mut predecessors,
                self.replica_id,
                state.scope_epoch,
                SyncMutationOperation::Update,
                record_id,
                Some(current.revision.clone()),
                object([
                    (
                        "patch",
                        Value::Object(frontmatter_patch(&current.frontmatter, &frontmatter)),
                    ),
                    ("body", Value::String(body)),
                ]),
                local_path.to_string(),
                local_hash.clone(),
            );
        }
        if local_path != current.path {
            queue_mutation(
                &mut queued,
                &mut predecessors,
                self.replica_id,
                state.scope_epoch,
                SyncMutationOperation::Rename,
                record_id,
                Some(current.revision.clone()),
                object([("path", Value::String(local_path.to_string()))]),
                local_path.to_string(),
                local_hash,
            );
        }
        Ok(queued)
    }

    fn assert_undiverged(&self, state: &DurableMirrorState) -> Result<(), MirrorError> {
        for entry in state.records.values().chain(state.resources.values()) {
            let value = self.read_file(&entry.path)?;
            if value.is_none_or(|value| digest(&value) != entry.hash) {
                return Err(MirrorError::new(
                    "mirror_diverged",
                    format!(
                        "Local edits at {} must be resolved before the mirror can continue.",
                        entry.path
                    ),
                ));
            }
        }
        Ok(())
    }

    fn read_state(&self) -> Result<Option<DurableMirrorState>, MirrorError> {
        let value = match fs::read(&self.state_file) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(MirrorError::io("Could not read", &self.state_file, error)),
        };
        let state = serde_json::from_slice::<DurableMirrorState>(&value).map_err(|error| {
            MirrorError::new(
                "invalid_mirror_state",
                format!("Mirror state is corrupt: {error}"),
            )
        })?;
        if state.protocol_version != SYNC_PROTOCOL_VERSION
            || state.replica_id != self.replica_id
            || state.mode != self.mode
        {
            return Err(MirrorError::new(
                "invalid_mirror_state",
                "Mirror state belongs to another protocol, replica, or mode.",
            ));
        }
        self.validate_state_shape(&state)?;
        Ok(Some(state))
    }

    fn read_rebuild_plan(&self) -> Result<Option<DurableRebuildPlan>, MirrorError> {
        let path = self.rebuild_plan_file();
        let value = match fs::read(&path) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(MirrorError::io("Could not read", &path, error)),
        };
        let plan = serde_json::from_slice::<DurableRebuildPlan>(&value).map_err(|error| {
            MirrorError::new(
                "invalid_mirror_state",
                format!("Mirror rebuild plan is corrupt: {error}"),
            )
        })?;
        self.validate_rebuild_plan(&plan)?;
        Ok(Some(plan))
    }

    fn validate_rebuild_plan(&self, plan: &DurableRebuildPlan) -> Result<(), MirrorError> {
        if plan.protocol_version != SYNC_PROTOCOL_VERSION
            || plan.replica_id != self.replica_id
            || plan.mode != self.mode
            || plan.session.protocol_version != SYNC_PROTOCOL_VERSION
            || plan.session.replica_id != self.replica_id
            || plan.session.mode != self.mode
        {
            return Err(MirrorError::new(
                "invalid_mirror_state",
                "Mirror rebuild plan belongs to another protocol, replica, or mode.",
            ));
        }
        if let Some(prior) = &plan.prior {
            if prior.protocol_version != SYNC_PROTOCOL_VERSION
                || prior.replica_id != self.replica_id
                || prior.mode != self.mode
            {
                return Err(MirrorError::new(
                    "invalid_mirror_state",
                    "Mirror rebuild plan contains state for another replica or mode.",
                ));
            }
            self.validate_state_shape(prior)?;
        }
        Ok(())
    }

    fn write_rebuild_plan(&self, plan: &DurableRebuildPlan) -> Result<(), MirrorError> {
        let path = self.rebuild_plan_file();
        atomic_write(
            &path,
            &serde_json::to_vec_pretty(plan).map_err(MirrorError::from)?,
        )
    }

    fn clear_rebuild_plan(&self) -> Result<(), MirrorError> {
        let path = self.rebuild_plan_file();
        match fs::remove_file(&path) {
            Ok(()) => {
                if let Some(parent) = path.parent() {
                    if let Ok(directory) = File::open(parent) {
                        let _ = directory.sync_all();
                    }
                }
                Ok(())
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(MirrorError::io("Could not clear", &path, error)),
        }
    }

    fn rebuild_plan_file(&self) -> PathBuf {
        self.state_file.with_extension("rebuild.json")
    }

    fn write_state(&self, state: &DurableMirrorState) -> Result<(), MirrorError> {
        let parent = self.state_file.parent().ok_or_else(|| {
            MirrorError::new("invalid_mirror_state_path", "Mirror state path is invalid.")
        })?;
        fs::create_dir_all(parent)
            .map_err(|error| MirrorError::io("Could not create", parent, error))?;
        atomic_write(
            &self.state_file,
            &serde_json::to_vec_pretty(state).map_err(MirrorError::from)?,
        )
    }

    fn read_file(&self, relative: &str) -> Result<Option<String>, MirrorError> {
        let path = safe_path(&self.root, relative)?;
        match fs::read_to_string(&path) {
            Ok(value) => Ok(Some(value)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(MirrorError::io("Could not read", &path, error)),
        }
    }

    fn write_file(&self, relative: &str, value: &[u8]) -> Result<(), MirrorError> {
        let path = safe_path(&self.root, relative)?;
        atomic_write(&path, value)
    }

    fn remove_file(&self, relative: &str) -> Result<(), MirrorError> {
        let path = safe_path(&self.root, relative)?;
        match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(MirrorError::io("Could not remove", &path, error)),
        }
    }

    fn list_markdown(&self, excluded: &HashSet<String>) -> Result<Vec<String>, MirrorError> {
        let mut paths = Vec::new();
        for entry in WalkDir::new(&self.root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| {
                if entry.depth() == 0 {
                    return true;
                }
                if entry.file_type().is_symlink() {
                    return false;
                }
                !matches!(
                    entry.file_name().to_string_lossy().as_ref(),
                    ".git" | ".mdbase" | "node_modules"
                )
            })
        {
            let entry = entry.map_err(|error| {
                MirrorError::new(
                    "mirror_io_failed",
                    format!("Could not scan mirror: {error}"),
                )
            })?;
            if !entry.file_type().is_file()
                || entry.path().extension().and_then(|value| value.to_str()) != Some("md")
            {
                continue;
            }
            let relative = entry
                .path()
                .strip_prefix(&self.root)
                .map_err(|_| {
                    MirrorError::new(
                        "mirror_path_escape",
                        "Mirror scan escaped its configured directory.",
                    )
                })?
                .to_string_lossy()
                .replace('\\', "/");
            if !excluded.contains(&relative) {
                paths.push(relative);
            }
        }
        paths.sort();
        Ok(paths)
    }
}

struct MirrorLease {
    file: File,
}

impl MirrorLease {
    fn acquire(path: &Path) -> Result<Self, MirrorError> {
        let parent = path.parent().ok_or_else(|| {
            MirrorError::new("invalid_mirror_lock_path", "Mirror lock path is invalid.")
        })?;
        fs::create_dir_all(parent)
            .map_err(|error| MirrorError::io("Could not create", parent, error))?;
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(path)
            .map_err(|error| MirrorError::io("Could not open", path, error))?;
        file.try_lock_exclusive().map_err(|_| {
            MirrorError::new(
                "mirror_folder_in_use",
                "Another mdbase mirror process is already using this folder.",
            )
        })?;
        Ok(Self { file })
    }
}

impl Drop for MirrorLease {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

pub fn mirror_lock_path(lock_root: &Path, canonical_root: &Path) -> PathBuf {
    lock_root.join(format!(
        "{}.lock",
        digest(canonical_root.to_string_lossy().as_ref())
    ))
}

pub fn mark_mirror(root: &Path, collection_id: Uuid) -> Result<(), MirrorError> {
    fs::create_dir_all(root).map_err(|error| MirrorError::io("Could not create", root, error))?;
    if fs::symlink_metadata(root).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(MirrorError::new(
            "mirror_symlink_refused",
            "Mirror root must not be a symbolic link.",
        ));
    }
    let root = fs::canonicalize(root)
        .map_err(|error| MirrorError::io("Could not resolve", root, error))?;
    let marker = safe_path(&root, ".mdbase/connect-role.json")?;
    if let Ok(existing) = fs::read(&marker) {
        let value = serde_json::from_slice::<Value>(&existing).map_err(|_| {
            MirrorError::new("invalid_mirror_marker", "Mirror role marker is corrupt.")
        })?;
        if value["version"] == 1
            && value["role"] == "mirror"
            && value["collection_id"] == collection_id.to_string()
        {
            return Ok(());
        }
        return Err(MirrorError::new(
            "mirror_identity_conflict",
            "This folder is already assigned to a different storage role.",
        ));
    }
    let configuration = root.join("mdbase.yaml");
    if let Ok(source) = fs::read_to_string(&configuration) {
        if let Ok(value) = serde_yaml::from_str::<Value>(&source) {
            if value
                .pointer("/x-mdbase-connect/collection_id")
                .and_then(Value::as_str)
                .is_some()
            {
                return Err(MirrorError::new(
                    "local_authority_requires_transfer",
                    "This folder is a computer-owned authority; transfer it explicitly before mirroring.",
                ));
            }
        }
    }
    atomic_write(
        &marker,
        &serde_json::to_vec_pretty(&serde_json::json!({
            "version": 1,
            "role": "mirror",
            "collection_id": collection_id
        }))
        .map_err(MirrorError::from)?,
    )
}

pub fn clear_mirror_marker(root: &Path, collection_id: Uuid) -> Result<(), MirrorError> {
    match fs::symlink_metadata(root) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(MirrorError::new(
                "mirror_symlink_refused",
                "Mirror root was replaced by a symbolic link.",
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(MirrorError::io("Could not inspect", root, error)),
    }
    let root = fs::canonicalize(root)
        .map_err(|error| MirrorError::io("Could not resolve", root, error))?;
    let marker = safe_path(&root, ".mdbase/connect-role.json")?;
    let value = match fs::read(&marker) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(MirrorError::io("Could not read", &marker, error)),
    };
    let value = serde_json::from_slice::<Value>(&value)
        .map_err(|_| MirrorError::new("invalid_mirror_marker", "Mirror role marker is corrupt."))?;
    if value["collection_id"] != collection_id.to_string() {
        return Err(MirrorError::new(
            "mirror_identity_conflict",
            "Mirror role marker belongs to a different collection.",
        ));
    }
    fs::remove_file(&marker).map_err(|error| MirrorError::io("Could not remove", &marker, error))
}

fn safe_path(root: &Path, relative: &str) -> Result<PathBuf, MirrorError> {
    let relative_path = Path::new(relative);
    if relative.is_empty()
        || relative_path.is_absolute()
        || relative_path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(MirrorError::new(
            "mirror_path_escape",
            format!("Hosted path is not a safe relative path: {relative}"),
        ));
    }
    let mut current = root.to_path_buf();
    for component in relative_path.components() {
        let Component::Normal(component) = component else {
            unreachable!()
        };
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(MirrorError::new(
                    "mirror_symlink_refused",
                    format!("Mirror path crosses a symbolic link: {relative}"),
                ))
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(MirrorError::io("Could not inspect", &current, error));
            }
        }
    }
    Ok(current)
}

fn atomic_write(path: &Path, value: &[u8]) -> Result<(), MirrorError> {
    let parent = path
        .parent()
        .ok_or_else(|| MirrorError::new("invalid_mirror_path", "Mirror path is invalid."))?;
    fs::create_dir_all(parent)
        .map_err(|error| MirrorError::io("Could not create", parent, error))?;
    // Re-check after directory creation so a pre-existing symlink cannot be
    // followed by the final replacement.
    if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(MirrorError::new(
            "mirror_symlink_refused",
            format!("Mirror output is a symbolic link: {}", path.display()),
        ));
    }
    let mut temporary = NamedTempFile::new_in(parent)
        .map_err(|error| MirrorError::io("Could not create a temporary file in", parent, error))?;
    temporary
        .write_all(value)
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|error| MirrorError::io("Could not write", temporary.path(), error))?;
    temporary
        .persist(path)
        .map_err(|error| MirrorError::io("Could not replace", path, error.error))?;
    if let Ok(directory) = File::open(parent) {
        let _ = directory.sync_all();
    }
    Ok(())
}

fn record_markdown_document(record: &SyncRecord) -> Result<String, MirrorError> {
    if record.frontmatter.is_empty() {
        return Ok(record.body.clone());
    }
    let mapping = json_to_yaml_mapping(&Value::Object(record.frontmatter.clone()));
    let yaml = serde_yaml::to_string(&mapping)
        .map_err(|error| MirrorError::new("frontmatter_render_failed", error.to_string()))?;
    let yaml = yaml.trim_end();
    let body = if record.body.is_empty() {
        String::new()
    } else {
        format!("\n{}", record.body.trim_start_matches('\n'))
    };
    Ok(format!("---\n{yaml}\n---\n{body}"))
}

fn parse_markdown(document: &str, path: &str) -> Result<(Map<String, Value>, String), MirrorError> {
    let parsed = parse_document(document);
    let frontmatter = match parsed.frontmatter {
        None => Map::new(),
        Some(value) if is_parse_error(&value) => {
            return Err(MirrorError::new(
                "invalid_frontmatter",
                format!("Writable mirror file {path} has invalid YAML frontmatter."),
            ))
        }
        Some(serde_yaml::Value::Mapping(mapping)) => yaml_mapping_to_json(&mapping)
            .as_object()
            .cloned()
            .unwrap_or_default(),
        Some(_) => {
            return Err(MirrorError::new(
                "invalid_frontmatter",
                format!("Writable mirror file {path} requires object frontmatter."),
            ))
        }
    };
    Ok((frontmatter, parsed.body))
}

fn frontmatter_patch(
    before: &Map<String, Value>,
    after: &Map<String, Value>,
) -> Map<String, Value> {
    let mut patch = after.clone();
    for field in before.keys() {
        if !after.contains_key(field) {
            patch.insert(field.clone(), Value::Null);
        }
    }
    patch
}

#[allow(clippy::too_many_arguments)]
fn queue_mutation(
    queue: &mut Vec<PendingMirrorMutation>,
    predecessors: &mut HashMap<Uuid, Uuid>,
    replica_id: Uuid,
    scope_epoch: u64,
    operation: SyncMutationOperation,
    record_id: Uuid,
    base_revision: Option<String>,
    input: Map<String, Value>,
    local_path: String,
    local_hash: Option<String>,
) {
    let mutation_id = Uuid::new_v4();
    let causal_predecessor = predecessors.get(&record_id).copied();
    queue.push(PendingMirrorMutation {
        mutation: SyncMutation {
            mutation_id,
            replica_id,
            scope_epoch,
            operation,
            record_id,
            base_revision,
            input,
            created_at: now(),
            causal_predecessor,
        },
        local_path,
        local_hash,
    });
    predecessors.insert(record_id, mutation_id);
}

fn refresh_conflict(state: &mut DurableMirrorState, event: &SyncChange) {
    let record_id = match event {
        SyncChange::Put { record, .. } => record.record_id,
        SyncChange::Remove { record_id, .. } => *record_id,
    };
    let Some(SyncMutationReceipt::Conflicted { conflict, .. }) =
        state.conflicts.get_mut(&record_id)
    else {
        return;
    };
    match event {
        SyncChange::Put { record, .. } => {
            conflict.current = Some(record.clone());
            conflict.current_revision = Some(record.revision.clone());
        }
        SyncChange::Remove { revision, .. } => {
            conflict.current = None;
            conflict.current_revision = Some(revision.clone());
        }
    }
}

fn object<const N: usize>(entries: [(&str, Value); N]) -> Map<String, Value> {
    entries
        .into_iter()
        .map(|(key, value)| (key.to_string(), value))
        .collect()
}

fn digest(value: &str) -> String {
    Sha256::digest(value.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests;
