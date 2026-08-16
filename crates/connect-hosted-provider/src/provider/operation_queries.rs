use super::operation_reads::{compile_point_catalog, load_direct_record, DirectRecordIdentity};
use super::*;
use crate::execution_budget::hosted_execution_budgets;
use crate::HostedExecutionBudgetManifest;
use futures_util::TryStreamExt;
use std::cmp::Ordering;

const MAX_LIVE_QUERY_CURSORS_PER_REPLICA: i64 = 64;
const MAX_HOSTED_BASE_RELATIONSHIP_PAIRS: u64 = 65_536;
const HOSTED_QUERY_EXECUTION_PROOF_VERSION: u32 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HostedQueryRequestKind {
    Query,
    CanonicalView,
    ObsidianBase,
}

impl HostedQueryRequestKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Query => "query",
            Self::CanonicalView => "canonical_view",
            Self::ObsidianBase => "obsidian_base",
        }
    }
}

struct HostedQueryState {
    snapshot_head: u64,
    snapshot_record_count: u64,
    scan_budget_records: u64,
    scan_budget_ciphertext_bytes: u64,
    generation_id: Option<Uuid>,
    projection_integrity_epoch: Option<u64>,
    projection_integrity_verified: bool,
    catalog_revision: String,
    projection_format_version: u32,
    semantic_engine_version: String,
    plan: mdbase::runtime::HostedQueryPlan,
    allowed_types: Vec<String>,
    last_order_values: Vec<Value>,
    last_path: Option<String>,
    last_record_id: Option<Uuid>,
    emitted_rows: u64,
    hard_expires_at: DateTime<Utc>,
    consumed_cursor_id: Option<Uuid>,
    request_kind: HostedQueryRequestKind,
    request_digest: String,
    result_meta: serde_json::Map<String, Value>,
    exact_context: Option<mdbase::runtime::CanonicalRecordInput>,
    base_plan: Option<mdbase::runtime::HostedBasePlan>,
    base_invocation_id: Option<Uuid>,
    base_context: Option<mdbase::runtime::SemanticProjection>,
    base_operation_clock: Option<String>,
    execution_proof: Option<HostedQueryExecutionProofV1>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct HostedQueryExecutionProofV1 {
    version: u32,
    plan_digest: String,
    request_digest: String,
    request_kind: String,
    scope_epoch: u64,
    snapshot_head: u64,
    snapshot_record_count: u64,
    scan_budget_records: u64,
    scan_budget_ciphertext_bytes: u64,
    generation_id: Option<Uuid>,
    catalog_revision: String,
    projection_format_version: u32,
    semantic_engine_version: String,
    projection_integrity_epoch: Option<u64>,
    execution: HostedQueryExecutionModeV1,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
enum HostedQueryExecutionModeV1 {
    ProjectedExact {
        total_count: Option<u64>,
        groups: Option<Vec<Value>>,
    },
    BoundedResidual {
        force_exact_residual: bool,
        #[serde(default)]
        bounded_ordering: bool,
    },
    Base {
        projection_fallback: bool,
        path_keyset: bool,
        total_count: Option<u64>,
    },
}

struct ProjectedQueryRow {
    record_id: Uuid,
    canonical_path: String,
    projection: mdbase::runtime::SemanticProjection,
}

struct ProjectedQueryMetadata {
    record_id: Uuid,
    canonical_path: String,
    projection_bytes: u64,
}

struct ExecutedQueryPage {
    results: Vec<Value>,
    diagnostics: Vec<Diagnostic>,
    groups: Option<Vec<Value>>,
    total_count: Option<u64>,
    has_more: bool,
    last_boundary: Option<QueryPageBoundary>,
    candidate_rows: u64,
    exact_documents: u64,
    exact_ciphertext_bytes: u64,
    base_path_keyset: bool,
}

struct LoadedExactQueryRecords {
    records: HashMap<Uuid, mdbase::runtime::CanonicalRecordInput>,
    ciphertext_bytes: u64,
    plaintext_bytes: u64,
}

struct QueryPageBoundary {
    order_values: Vec<Value>,
    path: String,
    record_id: Uuid,
}

fn query_cursor_hard_expires_at() -> ApiResult<DateTime<Utc>> {
    let hard_ttl_ms = to_i64(
        hosted_execution_budgets().cursor_hard_ttl_ms,
        "query cursor hard TTL",
    )?;
    Ok(Utc::now() + chrono::Duration::milliseconds(hard_ttl_ms))
}

struct BaseEvaluationCancellationGuard {
    cancellation: mdbase::OperationCancellation,
    armed: bool,
}

impl BaseEvaluationCancellationGuard {
    fn new(cancellation: mdbase::OperationCancellation) -> Self {
        Self {
            cancellation,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for BaseEvaluationCancellationGuard {
    fn drop(&mut self) {
        if self.armed {
            self.cancellation.cancel();
        }
    }
}

include!("operation_queries/provider_impl.rs");
include!("operation_queries/query_state.rs");
include!("operation_queries/entrypoints.rs");
include!("operation_queries/maintenance.rs");
include!("operation_queries/bindings.rs");
include!("operation_queries/projected_page.rs");
include!("operation_queries/query_top_k.rs");
include!("operation_queries/base_sources.rs");
include!("operation_queries/projection_loading.rs");
include!("operation_queries/residual_execution.rs");
include!("operation_queries/exact_loading.rs");
include!("operation_queries/sql_plan.rs");
include!("operation_queries/tests.rs");
