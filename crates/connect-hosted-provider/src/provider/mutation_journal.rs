use super::mutation_metrics::outcome_unknown;
use super::mutation_receipt::StoredMutationReceipt;
use super::*;

const MUTATION_LEASE_SECONDS: i64 = 30;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredSyncEffect {
    schema_version: u32,
    receipt: SyncMutationReceipt,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    semantic_result: Option<OperationResult>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum CompatibleStoredSyncEffect {
    Current(StoredSyncEffect),
    Legacy(SyncMutationReceipt),
}

#[derive(Debug, Clone, Serialize)]
pub struct HostedMutationJournalDiagnostics {
    pub state_counts: BTreeMap<String, u64>,
    pub oldest_unfinished_seconds: Option<u64>,
    pub tombstones: u64,
    pub database_pool_size: u32,
    pub database_pool_idle: usize,
}

#[derive(Debug, Clone)]
pub(super) struct HostedMutationLease {
    replica_id: Uuid,
    request_id: Uuid,
    input_digest: Vec<u8>,
    process_epoch: Uuid,
    owner: Uuid,
    generation: i64,
}

#[derive(Debug)]
pub(super) enum HostedMutationClaim {
    Owned {
        lease: HostedMutationLease,
        prepared_head: u64,
        takeover: bool,
        applied_result: Option<ApiResult<Value>>,
    },
    Live,
    Terminal(ApiResult<Value>),
}

include!("mutation_journal/provider_impl.rs");
include!("mutation_journal/helpers.rs");
