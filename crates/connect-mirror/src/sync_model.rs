use mdbase_connect_protocol::{SelectiveSyncPolicy, SyncReplicaMode};
use serde::{Deserialize, Serialize};

pub const ENGINE_PROFILE: &str = "exact_document_plan_only_v1";
pub const PROTOCOL_PROFILE: &str = "exact_document_v1";
pub const PLANNER_POLICY: &str = "three_way_exact_document_v1";
pub const PROJECTION_POLICY: &str = "portable_mirror_projection_v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum SyncObjectKind {
    Record,
    Resource,
    File,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SyncObjectRef {
    pub entity: SyncObjectKind,
    pub identity: String,
    pub path: String,
    pub revision: String,
    pub payload_revision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ExpectedObjectState {
    Absent,
    Exact { object: SyncObjectRef },
}

impl ExpectedObjectState {
    pub fn exact(&self) -> Option<&SyncObjectRef> {
        match self {
            Self::Absent => None,
            Self::Exact { object } => Some(object),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SyncPlanReason {
    Initial,
    Rebuild,
    LocalChange,
    RemoteChange,
    Pending,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SyncCheckpoint {
    pub generation: u64,
    pub cursor: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "command", rename_all = "snake_case")]
pub enum SyncAction {
    WriteLocal {
        action_id: String,
        depends_on: Vec<String>,
        reason: SyncPlanReason,
        target: SyncObjectRef,
        payload_revision: String,
        expected_local: ExpectedObjectState,
        expected_path_owner: ExpectedObjectState,
    },
    DeleteLocal {
        action_id: String,
        depends_on: Vec<String>,
        reason: SyncPlanReason,
        target: SyncObjectRef,
        expected_local: ExpectedObjectState,
        expected_path_owner: ExpectedObjectState,
    },
    MoveLocal {
        action_id: String,
        depends_on: Vec<String>,
        reason: SyncPlanReason,
        source: SyncObjectRef,
        target_path: String,
        expected_source_owner: ExpectedObjectState,
        expected_target_owner: ExpectedObjectState,
    },
    PutRemote {
        action_id: String,
        depends_on: Vec<String>,
        reason: SyncPlanReason,
        target: SyncObjectRef,
        payload_revision: String,
        expected_remote: ExpectedObjectState,
        expected_local: ExpectedObjectState,
        idempotency_key: String,
    },
    DeleteRemote {
        action_id: String,
        depends_on: Vec<String>,
        reason: SyncPlanReason,
        target: SyncObjectRef,
        expected_remote: ExpectedObjectState,
        expected_local: ExpectedObjectState,
        idempotency_key: String,
    },
    MoveRemote {
        action_id: String,
        depends_on: Vec<String>,
        reason: SyncPlanReason,
        source: SyncObjectRef,
        target_path: String,
        expected_source_owner: ExpectedObjectState,
        expected_target_owner: ExpectedObjectState,
        expected_local: ExpectedObjectState,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        revision_from_dependency: Option<String>,
        idempotency_key: String,
    },
    RecordConflict {
        action_id: String,
        depends_on: Vec<String>,
        reason: SyncPlanReason,
        identity: String,
        entity: SyncObjectKind,
        local: ExpectedObjectState,
        remote: ExpectedObjectState,
        conflict_kind: ConflictKind,
    },
    ClearConflict {
        action_id: String,
        depends_on: Vec<String>,
        reason: SyncPlanReason,
        identity: String,
        entity: SyncObjectKind,
        expected_local: ExpectedObjectState,
        expected_remote: ExpectedObjectState,
    },
    AdvanceCheckpoint {
        action_id: String,
        depends_on: Vec<String>,
        reason: SyncPlanReason,
        expected: SyncCheckpoint,
        next: SyncCheckpoint,
    },
}

impl SyncAction {
    pub fn action_id(&self) -> &str {
        match self {
            Self::WriteLocal { action_id, .. }
            | Self::DeleteLocal { action_id, .. }
            | Self::MoveLocal { action_id, .. }
            | Self::PutRemote { action_id, .. }
            | Self::DeleteRemote { action_id, .. }
            | Self::MoveRemote { action_id, .. }
            | Self::RecordConflict { action_id, .. }
            | Self::ClearConflict { action_id, .. }
            | Self::AdvanceCheckpoint { action_id, .. } => action_id,
        }
    }

    pub fn depends_on(&self) -> &[String] {
        match self {
            Self::WriteLocal { depends_on, .. }
            | Self::DeleteLocal { depends_on, .. }
            | Self::MoveLocal { depends_on, .. }
            | Self::PutRemote { depends_on, .. }
            | Self::DeleteRemote { depends_on, .. }
            | Self::MoveRemote { depends_on, .. }
            | Self::RecordConflict { depends_on, .. }
            | Self::ClearConflict { depends_on, .. }
            | Self::AdvanceCheckpoint { depends_on, .. } => depends_on,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConflictKind {
    BothChanged,
    DeleteVsChange,
    PathOccupied,
    Rejected,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MirrorPlanIssue {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub blocking: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MirrorPlanSummary {
    pub uploads: usize,
    pub downloads: usize,
    pub conflicts: usize,
    pub blocking_issues: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MirrorSyncPlan {
    pub plan_version: u32,
    pub engine_profile: String,
    pub protocol_profile: String,
    pub planner_policy: String,
    pub projection_policy: String,
    pub fingerprint: String,
    pub replica_id: String,
    pub mode: SyncReplicaMode,
    pub kind: String,
    pub base_cursor: Option<u64>,
    pub authority_cursor: u64,
    pub scope_epoch: u64,
    pub checkpoint_generation: u64,
    pub selective_sync: SelectiveSyncPolicy,
    pub actions: Vec<SyncAction>,
    pub issues: Vec<MirrorPlanIssue>,
    pub summary: MirrorPlanSummary,
}
