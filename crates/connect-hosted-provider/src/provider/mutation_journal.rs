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

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct CanonicalMutationIdentity {
    operation_kind: String,
    input_schema_version: u32,
    input_digest: Vec<u8>,
}

fn canonical_mutation_identity(
    operation: &str,
    input: &Value,
) -> ApiResult<CanonicalMutationIdentity> {
    let operation_kind = mdbase_connect_protocol::mutation_operation_identifier(operation, input)
        .ok_or_else(|| {
            ApiError::bad_request("invalid_request", "Operation is not a canonical mutation.")
        })?;
    let input_schema_version =
        mdbase_connect_protocol::operation_input_schema_version(operation, input).ok_or_else(
            || {
                ApiError::bad_request(
                    "invalid_request",
                    "Mutation input schema version is unavailable.",
                )
            },
        )?;
    let input_digest = mdbase_connect_protocol::mutation_fingerprint_bytes(operation, input)
        .map_err(|error| ApiError::bad_request("invalid_request", error.to_string()))?
        .to_vec();
    Ok(CanonicalMutationIdentity {
        operation_kind: operation_kind.to_string(),
        input_schema_version,
        input_digest,
    })
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
include!("mutation_journal/terminal_replay.rs");
include!("mutation_journal/helpers.rs");
