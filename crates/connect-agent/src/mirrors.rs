use crate::cloud::CloudControlClient;
use mdbase_connect_core::{
    collection_identity, CollectionRegistry, ConnectError, SystemSecretStore,
};
use mdbase_connect_mirror::{
    clear_mirror_marker, mark_mirror, mirror_lock_path, validate_selective_sync_policy,
    DirectoryMirror, HttpSyncTransport, MirrorApplyResult, MirrorError, MirrorSyncPlan,
};
use mdbase_connect_protocol::{
    MirrorAddParams, MirrorApplyParams, MirrorConfigureSelectiveSyncParams, MirrorIdParams,
    MirrorPromotionSummary, MirrorResolveParams, MirrorState, MirrorSummary, SelectiveSyncPolicy,
    SyncReplicaMode,
};
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::future::Future;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, RwLock};
use std::time::Duration;
use tempfile::NamedTempFile;
use tokio::sync::Notify;
use tokio::task::{AbortHandle, JoinSet};
use tokio::time::Instant;
use uuid::Uuid;

const SYNC_INTERVAL: Duration = Duration::from_secs(5);
const MIRROR_SYNC_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const MIRROR_SLOW_OPERATION_WARNING: Duration = Duration::from_secs(60);
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
    #[serde(default, alias = "files")]
    selective_sync: SelectiveSyncPolicy,
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
    credential_store_error: Option<String>,
    entries: RwLock<Vec<MirrorRegistryEntry>>,
    syncing: StdMutex<HashMap<Uuid, MirrorOperationState>>,
    operation_finished: Notify,
    errors: RwLock<HashMap<Uuid, String>>,
}

mod commands;
mod remote;
mod runtime;
mod state;
mod support;
mod synchronization;

use support::*;

#[cfg(test)]
mod tests;
