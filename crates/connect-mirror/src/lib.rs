use async_trait::async_trait;
use chrono::Utc;
use fs2::FileExt;
#[cfg(test)]
use mdbase::frontmatter::parser::{is_parse_error, parse_document, yaml_mapping_to_json};
use mdbase_connect_protocol::{
    authority_manifest_digest, CollectionFileDescriptor, CommitFileUploadReceipt,
    CommitFileUploadReceiptKind, CommitFileUploadRequest, CommitFileUploadRequestKind,
    DeleteFileReceipt, DeleteFileReceiptKind, DeleteFileRequest, DeleteFileRequestKind,
    FileMediaClass, FileTransferDirection, FileTransferProtection, FileTransferSession,
    FileTransferSessionKind, FileTransferState, FileTransferStatus, FileTransferStatusKind,
    FileTransferStrategy, MirrorConflictSummary, MirrorLocalIssue, MirrorResolution,
    MirrorState as MirrorStatusState, MoveFileReceipt, MoveFileReceiptKind, MoveFileRequest,
    MoveFileRequestKind, OpenFileDownloadRequest, OpenFileDownloadRequestKind,
    OpenFileUploadRequest, OpenFileUploadRequestKind, PrepareFileUploadPartRequest,
    PrepareFileUploadPartRequestKind, PreparedFilePart, PreparedFilePartKind, SelectiveSyncPolicy,
    SyncChange, SyncChangesPage, SyncCollectionResources, SyncFileSnapshotPage, SyncMutation,
    SyncMutationOperation, SyncMutationReceipt, SyncRecord, SyncReplicaMode, SyncResourceDocument,
    SyncSession, SyncSnapshotPage, UploadedFilePart, FILE_PROTOCOL_VERSION,
    FILE_TRANSFER_PROTOCOL_VERSION, SYNC_PROTOCOL_VERSION,
};
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
#[cfg(test)]
use serde_json::Map;
use serde_json::Value;
use sha2::{Digest, Sha256};
#[cfg(test)]
use std::collections::HashMap;
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use tempfile::NamedTempFile;
use url::Url;
use uuid::Uuid;
use walkdir::WalkDir;

mod directory_files;
mod directory_plan;
mod directory_storage;
mod directory_sync;
mod filesystem;
mod sync_checkpoint;
mod sync_codec;
mod sync_effects;
mod sync_executor;
mod sync_inspector;
mod sync_journal;
mod sync_model;
mod sync_path_planner;
mod sync_planner;
mod sync_revalidator;
mod transport;

const MIRROR_ENGINE_VERSION: u32 = 3;

pub use sync_model::{
    ConflictKind, ExpectedObjectState, MirrorPlanIssue, MirrorPlanSummary, MirrorSyncPlan,
    SyncAction, SyncCheckpoint, SyncObjectKind, SyncObjectRef, SyncPlanReason,
};

pub use directory_files::validate_selective_sync_policy;
use directory_files::{classify_file_media, validate_visible_file_path};

pub use filesystem::{clear_mirror_marker, mark_mirror, mirror_lock_path};
pub use transport::{HttpSyncTransport, SyncTransport};

#[cfg(test)]
use filesystem::parse_markdown;
use filesystem::{
    atomic_write, digest, is_remote_mirror_record_path, now, portable_mirror_path_key,
    record_markdown_document, safe_path, validate_portable_mirror_path, MirrorLease,
};

#[cfg(test)]
use mdbase_connect_protocol::SyncFileSnapshotPageKind;

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

#[derive(Debug, Clone, Serialize, Deserialize)]
struct MirrorEntry {
    path: String,
    revision: String,
    hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    record: Option<SyncRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct MirrorFileEntry {
    file: CollectionFileDescriptor,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DurableConflict {
    entity: SyncObjectKind,
    local: ExpectedObjectState,
    remote: ExpectedObjectState,
    conflict_kind: ConflictKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LocalBinding {
    entity: SyncObjectKind,
    path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DurablePayloads {
    #[serde(default)]
    documents: BTreeMap<String, String>,
    #[serde(default)]
    records: BTreeMap<String, SyncRecord>,
    #[serde(default)]
    resources: BTreeMap<String, SyncResourceDocument>,
    #[serde(default)]
    files: BTreeMap<String, CollectionFileDescriptor>,
    #[serde(default)]
    local_files: BTreeMap<String, DurableLocalFile>,
    #[serde(default)]
    mutations: BTreeMap<String, SyncMutation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DurableLocalFile {
    path: String,
    content_digest: String,
    size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    media_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DurableReceipt {
    action_id: String,
    status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    record: Option<SyncRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    file: Option<CollectionFileDescriptor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case")]
enum EntryDelta<T> {
    Unchanged,
    Put { value: T },
    Remove,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DurableStateDelta {
    identity: String,
    state_identity: String,
    record: EntryDelta<MirrorEntry>,
    resource: EntryDelta<MirrorEntry>,
    file: EntryDelta<MirrorFileEntry>,
    conflict: EntryDelta<DurableConflict>,
    binding: EntryDelta<LocalBinding>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
enum DurableJournalEvent {
    Phase {
        plan_fingerprint: String,
        phase: BatchPhase,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        failure: Option<MirrorFailure>,
    },
    Receipt {
        plan_fingerprint: String,
        receipt: Box<DurableReceipt>,
        delta: Box<DurableStateDelta>,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum BatchPhase {
    Prepared,
    Applying,
    EffectsComplete,
    Cancelled,
    Blocked,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DurableBatch {
    phase: BatchPhase,
    plan: MirrorSyncPlan,
    next_action: usize,
    receipts: Vec<DurableReceipt>,
    payloads: DurablePayloads,
    checkpoint_before: SyncCheckpoint,
    checkpoint_after: SyncCheckpoint,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    failure: Option<MirrorFailure>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MirrorFailure {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DurableMirrorStateEnvelope {
    #[serde(default)]
    engine_version: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DurableMirrorState {
    protocol_version: u32,
    #[serde(default)]
    engine_version: u32,
    #[serde(default)]
    generation: u64,
    replica_id: Uuid,
    scope_epoch: u64,
    cursor: u64,
    records: BTreeMap<Uuid, MirrorEntry>,
    #[serde(default)]
    resources: BTreeMap<String, MirrorEntry>,
    #[serde(default)]
    files: BTreeMap<Uuid, MirrorFileEntry>,
    #[serde(default, alias = "file_policy")]
    sync_policy: SelectiveSyncPolicy,
    mode: SyncReplicaMode,
    #[serde(default)]
    planned_conflicts: BTreeMap<String, DurableConflict>,
    #[serde(default)]
    local_bindings: BTreeMap<String, LocalBinding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    batch: Option<DurableBatch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_completed_plan: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_synced_at: Option<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MirrorApplyResult {
    pub status: String,
    pub plan_fingerprint: String,
    pub applied: usize,
    pub pending: usize,
    pub checkpoint_cursor: Option<u64>,
    pub conflicts: usize,
    pub issues: Vec<MirrorPlanIssue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<MirrorFailure>,
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
    sync_policy: SelectiveSyncPolicy,
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
        Self::new_with_selective_sync(
            root,
            state_file,
            lock_file,
            replica_id,
            mode,
            SelectiveSyncPolicy::default(),
            transport,
        )
    }

    pub fn new_with_selective_sync(
        root: impl AsRef<Path>,
        state_file: impl AsRef<Path>,
        lock_file: impl AsRef<Path>,
        replica_id: Uuid,
        mode: SyncReplicaMode,
        sync_policy: SelectiveSyncPolicy,
        transport: Arc<dyn SyncTransport>,
    ) -> Result<Self, MirrorError> {
        validate_selective_sync_policy(&sync_policy)?;
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
            sync_policy,
            transport,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
}

#[cfg(test)]
mod tests;
