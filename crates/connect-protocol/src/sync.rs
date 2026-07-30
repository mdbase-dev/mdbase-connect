use super::*;
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncReplicaMode {
    ReadOnly,
    ReadWrite,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MirrorState {
    NotInitialized,
    UpToDate,
    ChangesWaiting,
    Attention,
    Offline,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MirrorConflictSummary {
    pub record_id: Uuid,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub kind: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MirrorLocalIssue {
    pub path: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MirrorSummary {
    pub collection_id: Uuid,
    pub replica_id: Uuid,
    pub name: String,
    pub mode: SyncReplicaMode,
    pub path: String,
    pub state: MirrorState,
    pub pending: usize,
    #[serde(default)]
    pub conflicts: Vec<MirrorConflictSummary>,
    #[serde(default)]
    pub local_issues: Vec<MirrorLocalIssue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_synced_at: Option<String>,
    #[serde(default)]
    pub syncing: bool,
    #[serde(default)]
    pub promotion_pending: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub promotion: Option<MirrorPromotionSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MirrorPromotionSummary {
    pub phase: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncSession {
    pub protocol_version: u32,
    pub session_id: Uuid,
    pub replica_id: Uuid,
    pub collection_id: Uuid,
    pub mode: SyncReplicaMode,
    pub scope_epoch: u64,
    pub retained_after: u64,
    pub head: u64,
    pub snapshot_id: Uuid,
    pub resources: SyncCollectionResources,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncSnapshotPage {
    pub protocol_version: u32,
    pub snapshot_id: Uuid,
    pub scope_epoch: u64,
    pub cursor: u64,
    pub records: Vec<SyncSnapshotRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_page: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SyncSnapshotRecord {
    #[serde(flatten)]
    pub record: SyncRecord,
    /// Exact document whose SHA-256 revision and parsed metadata match `record`.
    pub document: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SyncChange {
    Put {
        sequence: u64,
        record: SyncRecord,
    },
    Remove {
        sequence: u64,
        record_id: Uuid,
        previous_path: String,
        revision: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncChangesPage {
    pub protocol_version: u32,
    pub scope_epoch: u64,
    pub events: Vec<SyncChange>,
    pub cursor: u64,
    pub head: u64,
    pub has_more: bool,
    pub reset_required: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncMutationOperation {
    Create,
    Update,
    Rename,
    Delete,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SyncMutation {
    pub mutation_id: Uuid,
    pub replica_id: Uuid,
    pub scope_epoch: u64,
    pub operation: SyncMutationOperation,
    pub record_id: Uuid,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_revision: Option<String>,
    pub input: serde_json::Map<String, Value>,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub causal_predecessor: Option<Uuid>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SyncConflict {
    pub record_id: Uuid,
    pub mutation: SyncMutation,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current: Option<SyncRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_revision: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncMutationError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum SyncMutationReceipt {
    Applied {
        mutation_id: Uuid,
        sequence: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        record: Option<SyncRecord>,
    },
    PreviouslyApplied {
        mutation_id: Uuid,
        sequence: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        record: Option<SyncRecord>,
    },
    Conflicted {
        mutation_id: Uuid,
        conflict: SyncConflict,
    },
    Rejected {
        mutation_id: Uuid,
        error: SyncMutationError,
    },
}
