use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap};
use std::fs::File;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use clap::{Parser, Subcommand, ValueEnum};
use futures_util::TryStreamExt;
use hmac::{Hmac, Mac};
use mdbase::frontmatter::parser::{parse_document, FrontmatterState};
use mdbase::runtime::{
    BenchmarkDiagnostic, BenchmarkFileFacts, BenchmarkProjection, CandidateExpression,
    CanonicalRecordInput, CatalogInput, CompiledCatalog, ProjectionRelationship,
    ResolvedTypeResource,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::postgres::PgPoolOptions;
use sqlx::{AssertSqlSafe, PgPool, Postgres, QueryBuilder, Row};
use thiserror::Error;
use uuid::Uuid;

#[derive(Parser)]
#[command(name = "hosted-storage-benchmark")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Recompute canonical fixture results through mdbase-rs and compare the
    /// independent JavaScript seed before publishing the oracle artifact.
    Oracle {
        #[arg(long)]
        fixture_dir: PathBuf,
        #[arg(long)]
        workload_contract: PathBuf,
        #[arg(long)]
        output: PathBuf,
        #[arg(long)]
        mdbase_revision: String,
        #[arg(long)]
        mdbase_dirty: bool,
    },
    /// Generate the tracked canonical oracle for the v2 rebuild catalogue.
    OracleV2 {
        #[arg(long)]
        fixture_dir: PathBuf,
        #[arg(long)]
        workload_contract: PathBuf,
        #[arg(long)]
        output: PathBuf,
        #[arg(long)]
        mdbase_revision: String,
    },
    /// Print one mdbase-rs projection for differential fixture diagnosis.
    Project {
        #[arg(long)]
        fixture_dir: PathBuf,
        #[arg(long)]
        record_index: usize,
    },
    /// Stream every mdbase-rs projection as NDJSON for differential diagnosis.
    ProjectAll {
        #[arg(long)]
        fixture_dir: PathBuf,
    },
    /// Apply one disposable physical schema to an empty PostgreSQL database.
    Schema {
        #[arg(long)]
        database_url: String,
        #[arg(long)]
        candidate: Candidate,
        #[arg(long)]
        schema_dir: PathBuf,
    },
    /// Import one deterministic fixture into one disposable candidate database.
    Import {
        #[arg(long)]
        database_url: String,
        #[arg(long)]
        candidate: Candidate,
        #[arg(long)]
        fixture_dir: PathBuf,
    },
    /// Emit exact per-relation and aggregate storage bytes as JSON.
    Storage {
        #[arg(long)]
        database_url: String,
        #[arg(long)]
        candidate: Candidate,
    },
    /// Execute and validate one frozen semantic workload once.
    Query {
        #[arg(long)]
        database_url: String,
        #[arg(long)]
        candidate: Candidate,
        #[arg(long)]
        fixture_dir: PathBuf,
        #[arg(long)]
        workload_contract: PathBuf,
        #[arg(long)]
        workload_id: String,
        #[arg(long, default_value = "config/hosted-execution-budgets.json")]
        budget_manifest: PathBuf,
        #[arg(long)]
        large_fixture_entitlement: bool,
    },
    /// Rebuild provider-readable projections through durable CAS batches.
    Rebuild {
        #[arg(long)]
        database_url: String,
        #[arg(long)]
        candidate: Candidate,
        #[arg(long)]
        fixture_dir: PathBuf,
        /// Inject a process failure after this many committed batches.
        #[arg(long)]
        fail_after_batches: Option<usize>,
        /// Benchmark-only delay used to make process-cancellation recovery reproducible.
        #[arg(long, default_value_t = 0)]
        batch_delay_ms: u64,
    },
    /// Execute benchmark-only point reads or canonical record writes.
    Exercise {
        #[arg(long)]
        database_url: String,
        #[arg(long)]
        candidate: Candidate,
        #[arg(long)]
        fixture_dir: PathBuf,
        #[arg(long)]
        operation: ExerciseOperation,
        #[arg(long, default_value_t = 1)]
        samples: usize,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
enum Candidate {
    A,
    BNoGin,
    BGin,
    CNoGin,
    CGin,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
enum ExerciseOperation {
    PointRead,
    BodyWrite,
    FrontmatterWrite,
    PathWrite,
    Recovery,
    Authorization,
    CasLoss,
    Supersession,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum WriteRace {
    RecordRevision,
    CatalogSupersession,
}

impl Candidate {
    fn schema(self) -> &'static str {
        match self {
            Self::A => "candidate_a",
            Self::BNoGin => "candidate_b_no_gin",
            Self::BGin => "candidate_b_gin",
            Self::CNoGin => "candidate_c_no_gin",
            Self::CGin => "candidate_c_gin",
        }
    }

    fn file(self) -> &'static str {
        match self {
            Self::A => "candidate-a.sql",
            Self::BNoGin => "candidate-b-no-gin.sql",
            Self::BGin => "candidate-b-gin.sql",
            Self::CNoGin => "candidate-c-no-gin.sql",
            Self::CGin => "candidate-c-gin.sql",
        }
    }

    fn projected(self) -> bool {
        !matches!(self, Self::A)
    }

    fn encrypted(self) -> bool {
        matches!(self, Self::A | Self::BNoGin | Self::BGin)
    }
}

#[derive(Debug, Error)]
enum Error {
    #[error("I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON failed: {0}")]
    Json(#[from] serde_json::Error),
    #[error("catalog failed: {0}")]
    Catalog(#[from] mdbase::runtime::CatalogError),
    #[error("PostgreSQL failed: {0}")]
    Sql(#[from] sqlx::Error),
    #[error("invalid benchmark input: {0}")]
    Invalid(String),
    #[error("independent seed disagrees with mdbase-rs: {0}")]
    SeedMismatch(String),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkloadContract {
    query_workloads: Vec<Workload>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BudgetManifest {
    defaults: BudgetLimits,
    entitlements: BudgetEntitlements,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BudgetEntitlements {
    #[serde(rename = "large_fixture_v1")]
    large_fixture_v1: DiagnosticBudget,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticBudget {
    scanned_records: usize,
    scanned_ciphertext_bytes: u64,
    snapshot_lifetime_ms: u64,
    operation_deadline_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BudgetLimits {
    scanned_records: usize,
    scanned_ciphertext_bytes: u64,
    simultaneously_decrypted_bytes: u64,
    result_items: u64,
    result_bytes: u64,
    top_k_entries: usize,
    maximum_offset: usize,
    groups: usize,
    aggregation_state_bytes: u64,
    snapshot_lifetime_ms: u64,
    operation_deadline_ms: u64,
    accounted_execution_bytes_per_operation: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Workload {
    id: String,
    candidate_ir: CandidateExpression,
    #[serde(default)]
    canonical_residual: Option<CandidateExpression>,
    #[serde(default)]
    client_residual: Option<CandidateExpression>,
    #[serde(default)]
    consumer_transform: Option<ConsumerTransform>,
    response_fields: Vec<String>,
    #[serde(default)]
    order: Vec<Order>,
    #[serde(default)]
    group: Vec<Group>,
    page: Page,
    acceptable_run_outcomes: Vec<String>,
    acceptable_budget_kinds: Vec<String>,
    acceptable_error_codes: Vec<String>,
    #[serde(default)]
    provider_scans: Vec<ProviderScan>,
    #[serde(default)]
    cancel_after_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct ConsumerTransform {
    kind: String,
}

#[derive(Debug, Deserialize)]
struct Order {
    field: String,
    direction: String,
    #[serde(default = "default_nulls")]
    nulls: String,
}

fn default_nulls() -> String {
    "last".to_string()
}

#[derive(Debug, Deserialize)]
struct Group {
    field: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Page {
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    first_limit: Option<usize>,
    #[serde(default)]
    subsequent_limit: Option<usize>,
    #[serde(default)]
    offset: usize,
    #[serde(default)]
    repeat_to_completion: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderScan {
    id: String,
    candidate_ir: CandidateExpression,
    include_body: bool,
    #[serde(default)]
    order: Vec<Order>,
    page: Page,
}

#[derive(Debug, Deserialize)]
struct ResourceLine {
    path: String,
    kind: String,
    document: String,
}

#[derive(Debug, Deserialize)]
struct RecordLine {
    record_id: String,
    path: String,
    document: String,
    file_mtime: String,
}

#[derive(Debug, Clone, Serialize)]
struct Fact {
    record_id: String,
    path: String,
    sort: Vec<Value>,
    response_digest: String,
    response_digest_without_body: String,
    client_residual: bool,
    residual_match: bool,
    group: Vec<Value>,
    types: Vec<String>,
    status: Option<Value>,
    relationships: Vec<ProjectionRelationship>,
    source_identity: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExpectedArtifact {
    schema_version: u32,
    oracle: String,
    workloads: BTreeMap<String, Value>,
    mutations: Value,
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Error> {
    match Cli::parse().command {
        Command::Oracle {
            fixture_dir,
            workload_contract,
            output,
            mdbase_revision,
            mdbase_dirty,
        } => run_oracle(
            &fixture_dir,
            &workload_contract,
            &output,
            &mdbase_revision,
            mdbase_dirty,
        ),
        Command::OracleV2 {
            fixture_dir,
            workload_contract,
            output,
            mdbase_revision,
        } => run_oracle_v2(&fixture_dir, &workload_contract, &output, &mdbase_revision),
        Command::Project {
            fixture_dir,
            record_index,
        } => project_record(&fixture_dir, record_index),
        Command::ProjectAll { fixture_dir } => project_all(&fixture_dir),
        Command::Schema {
            database_url,
            candidate,
            schema_dir,
        } => apply_schema(&database_url, candidate, &schema_dir).await,
        Command::Import {
            database_url,
            candidate,
            fixture_dir,
        } => import_fixture(&database_url, candidate, &fixture_dir).await,
        Command::Storage {
            database_url,
            candidate,
        } => storage_metrics(&database_url, candidate).await,
        Command::Query {
            database_url,
            candidate,
            fixture_dir,
            workload_contract,
            workload_id,
            budget_manifest,
            large_fixture_entitlement,
        } => {
            query_workload(
                &database_url,
                candidate,
                &fixture_dir,
                &workload_contract,
                &workload_id,
                &budget_manifest,
                large_fixture_entitlement,
            )
            .await
        }
        Command::Rebuild {
            database_url,
            candidate,
            fixture_dir,
            fail_after_batches,
            batch_delay_ms,
        } => {
            rebuild_projections(
                &database_url,
                candidate,
                &fixture_dir,
                fail_after_batches,
                batch_delay_ms,
            )
            .await
        }
        Command::Exercise {
            database_url,
            candidate,
            fixture_dir,
            operation,
            samples,
        } => exercise_candidate(&database_url, candidate, &fixture_dir, operation, samples).await,
    }
}

include!("main/oracle.rs");
include!("main/import.rs");
include!("main/exercise.rs");
include!("main/query.rs");
include!("main/legacy_query.rs");
