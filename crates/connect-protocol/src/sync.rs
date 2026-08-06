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
    #[serde(default)]
    pub selective_sync: SelectiveSyncPolicy,
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
    pub error_code: Option<String>,
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
    pub protocol_profile: String,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncFileSnapshotPage {
    pub protocol_version: u32,
    #[serde(rename = "type")]
    pub message_type: SyncFileSnapshotPageKind,
    pub snapshot_id: Uuid,
    pub scope_epoch: u64,
    pub cursor: u64,
    pub files: Vec<CollectionFileDescriptor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_page: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncFileSnapshotPageKind {
    FileSnapshotPage,
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
    FilePut {
        sequence: u64,
        file: CollectionFileDescriptor,
    },
    FileRemove {
        sequence: u64,
        file_id: Uuid,
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
    Put,
    Move,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document: Option<String>,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub causal_predecessor: Option<Uuid>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case")]
pub enum SyncFileMutation {
    FilePut {
        mutation_id: Uuid,
        replica_id: Uuid,
        scope_epoch: u64,
        file_id: Uuid,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        base_revision: Option<String>,
        path: String,
        transfer_id: Uuid,
        content_digest: String,
        size: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        media_type: Option<String>,
        created_at: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        causal_predecessor: Option<Uuid>,
    },
    FileMove {
        mutation_id: Uuid,
        replica_id: Uuid,
        scope_epoch: u64,
        file_id: Uuid,
        base_revision: String,
        path: String,
        update_references: bool,
        created_at: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        causal_predecessor: Option<Uuid>,
    },
    FileDelete {
        mutation_id: Uuid,
        replica_id: Uuid,
        scope_epoch: u64,
        file_id: Uuid,
        base_revision: String,
        created_at: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        causal_predecessor: Option<Uuid>,
    },
}

impl SyncFileMutation {
    pub fn mutation_id(&self) -> Uuid {
        match self {
            Self::FilePut { mutation_id, .. }
            | Self::FileMove { mutation_id, .. }
            | Self::FileDelete { mutation_id, .. } => *mutation_id,
        }
    }

    pub fn file_id(&self) -> Uuid {
        match self {
            Self::FilePut { file_id, .. }
            | Self::FileMove { file_id, .. }
            | Self::FileDelete { file_id, .. } => *file_id,
        }
    }
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
pub struct SyncFileConflict {
    pub file_id: Uuid,
    pub mutation: SyncFileMutation,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current: Option<CollectionFileDescriptor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_revision: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum SyncFileMutationReceipt {
    FileApplied {
        mutation_id: Uuid,
        sequence: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        file: Option<CollectionFileDescriptor>,
    },
    FilePreviouslyApplied {
        mutation_id: Uuid,
        sequence: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        file: Option<CollectionFileDescriptor>,
    },
    FileConflicted {
        mutation_id: Uuid,
        conflict: Box<SyncFileConflict>,
    },
    FileRejected {
        mutation_id: Uuid,
        error: SyncMutationError,
    },
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
        conflict: Box<SyncConflict>,
    },
    Rejected {
        mutation_id: Uuid,
        error: SyncMutationError,
    },
}
