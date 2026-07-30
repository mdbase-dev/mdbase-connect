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
    SyncReplicaMode, SyncResourceDocument, SyncSession, SyncSnapshotPage, SyncSnapshotRecord,
    SYNC_PROTOCOL_VERSION,
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

mod directory_mutations;
mod directory_rebuild;
mod directory_storage;
mod directory_sync;
mod filesystem;
mod transport;

pub use filesystem::{clear_mirror_marker, mark_mirror, mirror_lock_path};
pub use transport::{HttpSyncTransport, SyncTransport};

use filesystem::{
    atomic_write, digest, frontmatter_patch, is_remote_mirror_record_path, now, object,
    parse_markdown, portable_mirror_path_key, queue_mutation, record_markdown_document,
    refresh_conflict, safe_path, validate_portable_mirror_path, MirrorLease,
};

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

#[derive(Default)]
struct PutOptions<'a> {
    accepted_hash: Option<&'a str>,
    preserve_accepted_document: bool,
    physical_path_preflighted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DurableRebuildPlan {
    protocol_version: u32,
    replica_id: Uuid,
    mode: SyncReplicaMode,
    session: SyncSession,
    records: Vec<SyncSnapshotRecord>,
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
}

#[cfg(test)]
mod tests;
