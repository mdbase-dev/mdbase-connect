use super::operation_reads::{compile_point_catalog, load_direct_record, DirectRecordIdentity};
use super::*;
use crate::HostedExecutionBudgetManifest;
use std::cmp::Ordering;

const QUERY_CURSOR_IDLE_SECONDS: i64 = 60;
const QUERY_CURSOR_HARD_SECONDS: i64 = 300;
const MAX_LIVE_QUERY_CURSORS_PER_REPLICA: i64 = 64;
const MAX_HOSTED_BASE_RELATIONSHIP_PAIRS: u64 = 65_536;

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
    generation_id: Option<Uuid>,
    catalog_revision: String,
    projection_format_version: u32,
    semantic_engine_version: String,
    plan: mdbase::runtime::HostedQueryPlan,
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
    total_count: u64,
    last_boundary: Option<QueryPageBoundary>,
    candidate_rows: u64,
    exact_documents: u64,
}

struct QueryPageBoundary {
    order_values: Vec<Value>,
    path: String,
    record_id: Uuid,
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
include!("operation_queries/bindings.rs");
include!("operation_queries/query_top_k.rs");
include!("operation_queries/base_sources.rs");
include!("operation_queries/projection_loading.rs");
include!("operation_queries/residual_execution.rs");
include!("operation_queries/sql_plan.rs");
include!("operation_queries/tests.rs");
