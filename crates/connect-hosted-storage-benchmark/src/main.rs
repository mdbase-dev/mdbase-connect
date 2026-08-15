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

#[derive(Debug, Clone)]
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
        } => rebuild_projections(&database_url, candidate, &fixture_dir, fail_after_batches).await,
        Command::Exercise {
            database_url,
            candidate,
            fixture_dir,
            operation,
            samples,
        } => exercise_candidate(&database_url, candidate, &fixture_dir, operation, samples).await,
    }
}

fn project_all(fixture_dir: &Path) -> Result<(), Error> {
    let catalog = compile_fixture_catalog(&fixture_dir.join("resources.ndjson"))?;
    let stdout = std::io::stdout();
    let mut output = stdout.lock();
    for line in BufReader::new(File::open(fixture_dir.join("records.ndjson"))?).lines() {
        let record: RecordLine = serde_json::from_str(&line?)?;
        let canonical = CanonicalRecordInput {
            stable_id: Some(record.record_id),
            path: record.path,
            file_size: record.document.len() as u64,
            file_mtime: Some(record.file_mtime),
            document: record.document,
        };
        serde_json::to_writer(&mut output, &catalog.benchmark_project_record(&canonical)?)?;
        output.write_all(b"\n")?;
    }
    Ok(())
}

fn project_record(fixture_dir: &Path, record_index: usize) -> Result<(), Error> {
    let catalog = compile_fixture_catalog(&fixture_dir.join("resources.ndjson"))?;
    let line = BufReader::new(File::open(fixture_dir.join("records.ndjson"))?)
        .lines()
        .nth(record_index)
        .ok_or_else(|| Error::Invalid(format!("record index does not exist: {record_index}")))??;
    let record: RecordLine = serde_json::from_str(&line)?;
    let canonical = CanonicalRecordInput {
        stable_id: Some(record.record_id),
        path: record.path,
        file_size: record.document.len() as u64,
        file_mtime: Some(record.file_mtime),
        document: record.document,
    };
    println!(
        "{}",
        serde_json::to_string_pretty(&catalog.benchmark_project_record(&canonical)?)?
    );
    Ok(())
}

fn run_oracle(
    fixture_dir: &Path,
    workload_path: &Path,
    output: &Path,
    mdbase_revision: &str,
    mdbase_dirty: bool,
) -> Result<(), Error> {
    let contract: WorkloadContract = serde_json::from_reader(File::open(workload_path)?)?;
    let catalog = compile_fixture_catalog(&fixture_dir.join("resources.ndjson"))?;
    let mut facts = contract
        .query_workloads
        .iter()
        .map(|workload| (workload.id.clone(), Vec::new()))
        .collect::<HashMap<_, _>>();
    let mut provider_facts = HashMap::<String, Vec<Fact>>::new();
    for workload in &contract.query_workloads {
        for scan in &workload.provider_scans {
            provider_facts.insert(format!("{}:{}", workload.id, scan.id), Vec::new());
        }
    }

    for line in BufReader::new(File::open(fixture_dir.join("records.ndjson"))?).lines() {
        let record: RecordLine = serde_json::from_str(&line?)?;
        let canonical = CanonicalRecordInput {
            stable_id: Some(record.record_id.clone()),
            path: record.path.clone(),
            file_size: record.document.len() as u64,
            file_mtime: Some(record.file_mtime.clone()),
            document: record.document.clone(),
        };
        let classified = catalog.classify_record(&canonical)?;
        let projection = catalog.benchmark_project_record(&canonical)?;
        for workload in &contract.query_workloads {
            if workload
                .candidate_ir
                .evaluate_canonical(&projection, &classified.body)
            {
                facts
                    .get_mut(&workload.id)
                    .expect("workload accumulator exists")
                    .push(result_fact(
                        workload,
                        &record,
                        &classified.revision,
                        &classified.body,
                        &projection,
                    )?);
            }
            for scan in &workload.provider_scans {
                if scan
                    .candidate_ir
                    .evaluate_canonical(&projection, &classified.body)
                {
                    provider_facts
                        .get_mut(&format!("{}:{}", workload.id, scan.id))
                        .expect("provider accumulator exists")
                        .push(result_fact(
                            workload,
                            &record,
                            &classified.revision,
                            &classified.body,
                            &projection,
                        )?);
                }
            }
        }
    }

    let mut workloads = BTreeMap::new();
    for workload in &contract.query_workloads {
        workloads.insert(
            workload.id.clone(),
            expected_workload(
                workload,
                facts.remove(&workload.id).expect("workload facts exist"),
                &mut provider_facts,
            )?,
        );
    }
    let artifact = ExpectedArtifact {
        schema_version: 2,
        oracle: format!("mdbase-rs-{}@{mdbase_revision}", mdbase::VERSION),
        workloads,
        mutations: mutation_oracles(),
    };
    let generated = serde_json::to_value(&artifact)?;
    let seed_path = fixture_dir.join("expected-results.json");
    let seed: Value = serde_json::from_reader(File::open(&seed_path)?)?;
    let mut normalized = seed.clone();
    normalized["oracle"] = generated["oracle"].clone();
    if normalized != generated {
        return Err(Error::SeedMismatch(first_json_difference(
            "$",
            &normalized,
            &generated,
        )));
    }
    let mut artifact_bytes = serde_json::to_vec_pretty(&artifact)?;
    artifact_bytes.push(b'\n');
    File::create(output)?.write_all(&artifact_bytes)?;
    let manifest_path = fixture_dir.join("fixture-manifest.json");
    let mut manifest: Value = serde_json::from_reader(File::open(&manifest_path)?)?;
    manifest["expectedResultsSha256"] =
        Value::String(format!("{:x}", Sha256::digest(&artifact_bytes)));
    manifest["oracle"] = json!({
        "engine": format!("mdbase-rs-{}", mdbase::VERSION),
        "revision": mdbase_revision,
        "dirty": mdbase_dirty,
        "independentSeedVerified": true
    });
    let mut manifest_bytes = serde_json::to_vec_pretty(&manifest)?;
    manifest_bytes.push(b'\n');
    File::create(manifest_path)?.write_all(&manifest_bytes)?;
    Ok(())
}

fn compile_fixture_catalog(path: &Path) -> Result<CompiledCatalog, Error> {
    let bytes = std::fs::read(path)?;
    let mut configuration_document = None;
    let mut types = Vec::new();
    for line in bytes
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
    {
        let resource: ResourceLine = serde_json::from_slice(line)?;
        match resource.kind.as_str() {
            "configuration" => configuration_document = Some(resource.document),
            "type" => {
                let parsed = parse_document(&resource.document);
                let FrontmatterState::Mapping(mapping) = parsed.frontmatter_state() else {
                    return Err(Error::Invalid(format!(
                        "type resource has invalid frontmatter: {}",
                        resource.path
                    )));
                };
                let definition = serde_json::to_value(mapping)?;
                let schema = definition
                    .pointer("/schema/value")
                    .cloned()
                    .ok_or_else(|| {
                        Error::Invalid(format!("type has no schema: {}", resource.path))
                    })?;
                types.push(ResolvedTypeResource {
                    path: resource.path,
                    revision: format!("sha256:{:x}", Sha256::digest(resource.document.as_bytes())),
                    definition,
                    schema,
                });
            }
            other => {
                return Err(Error::Invalid(format!(
                    "unsupported resource kind: {other}"
                )))
            }
        }
    }
    CompiledCatalog::compile(CatalogInput {
        resource_revision: format!("sha256:{:x}", Sha256::digest(&bytes)),
        configuration_document: configuration_document
            .ok_or_else(|| Error::Invalid("missing configuration resource".to_string()))?,
        types,
        contracts: Vec::new(),
    })
    .map_err(Error::from)
}

fn result_fact(
    workload: &Workload,
    record: &RecordLine,
    revision: &str,
    body: &str,
    projection: &BenchmarkProjection,
) -> Result<Fact, Error> {
    let response = workload
        .response_fields
        .iter()
        .map(|path| {
            Ok((
                path.clone(),
                response_field(path, record, revision, body, projection),
            ))
        })
        .collect::<Result<Vec<_>, Error>>()?;
    let response_bytes = serde_jcs::to_vec(&response)?;
    let response_without_body = response
        .iter()
        .filter(|(path, _)| path != "body" && path != "document")
        .cloned()
        .collect::<Vec<_>>();
    Ok(Fact {
        record_id: record.record_id.clone(),
        path: record.path.clone(),
        sort: workload
            .order
            .iter()
            .map(|order| response_field(&order.field, record, revision, body, projection))
            .collect(),
        response_digest: format!("{:x}", Sha256::digest(response_bytes)),
        response_digest_without_body: format!(
            "{:x}",
            Sha256::digest(serde_jcs::to_vec(&response_without_body)?)
        ),
        client_residual: workload
            .client_residual
            .as_ref()
            .is_none_or(|expression| expression.evaluate_canonical(projection, body)),
        residual_match: workload
            .canonical_residual
            .as_ref()
            .is_none_or(|expression| expression.evaluate_canonical(projection, body)),
        group: workload
            .group
            .iter()
            .map(|group| response_field(&group.field, record, revision, body, projection))
            .collect(),
        types: projection.types.clone(),
        status: projection.effective_frontmatter.get("status").cloned(),
        relationships: projection.relationships.clone(),
        source_identity: projection
            .effective_frontmatter
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

fn response_field(
    path: &str,
    record: &RecordLine,
    revision: &str,
    body: &str,
    projection: &BenchmarkProjection,
) -> Value {
    match path {
        "body" => Value::String(body.to_string()),
        "revision" | "document_revision" => Value::String(revision.to_string()),
        "document" => Value::String(record.document.clone()),
        "relationships" => serde_json::to_value(&projection.relationships).unwrap(),
        value if value.starts_with("groups.") || value.starts_with("meta.") => Value::Null,
        _ => projection_field(projection, path).unwrap_or(Value::Null),
    }
}

fn projection_field(projection: &BenchmarkProjection, path: &str) -> Option<Value> {
    let value = serde_json::to_value(projection).ok()?;
    path.split('.')
        .try_fold(&value, |current, segment| current.get(segment))
        .cloned()
}

fn expected_workload(
    workload: &Workload,
    candidate_facts: Vec<Fact>,
    provider_facts: &mut HashMap<String, Vec<Fact>>,
) -> Result<Value, Error> {
    let provider_scans = if workload.provider_scans.is_empty() {
        vec![provider_scan_value(
            "candidate",
            workload.response_fields.iter().any(|field| field == "body"),
            candidate_facts.clone(),
            &workload.page,
            &workload.order,
        )]
    } else {
        workload
            .provider_scans
            .iter()
            .map(|scan| {
                provider_scan_value(
                    &scan.id,
                    scan.include_body,
                    provider_facts
                        .remove(&format!("{}:{}", workload.id, scan.id))
                        .expect("provider facts exist"),
                    &scan.page,
                    &scan.order,
                )
            })
            .collect()
    };
    let canonical_residual_matches = candidate_facts
        .iter()
        .filter(|fact| fact.residual_match)
        .count();
    let mut facts = candidate_facts
        .iter()
        .filter(|fact| fact.residual_match && fact.client_residual)
        .cloned()
        .collect::<Vec<_>>();
    let client_residual_matches = facts.len();
    match workload
        .consumer_transform
        .as_ref()
        .map(|value| value.kind.as_str())
    {
        Some("readerContentMergeBySource") => facts = reader_merge(facts),
        Some("picklePendingByResponseMultiplicity") => facts = pickle_transform(facts, true),
        Some("pickleAllRequestsWithResponseMultiplicity") => facts = pickle_transform(facts, false),
        Some(other) => {
            return Err(Error::Invalid(format!(
                "unknown consumer transform: {other}"
            )))
        }
        None => {}
    }
    let acceptable = acceptable_outcomes(workload);
    if !workload.group.is_empty() {
        let mut groups = BTreeMap::<String, usize>::new();
        for fact in &facts {
            *groups
                .entry(serde_json::to_string(&fact.group)?)
                .or_default() += 1;
        }
        let digest_values = groups
            .iter()
            .map(|(key, count)| format!("{key}:{count}"))
            .collect::<Vec<_>>();
        return Ok(json!({
            "canonicalOutcome": "success",
            "acceptableRunOutcomes": acceptable,
            "providerScans": provider_scans,
            "candidateRows": candidate_facts.len(),
            "canonicalResidualMatches": canonical_residual_matches,
            "clientResidualMatches": client_residual_matches,
            "consumerResultCount": facts.len(),
            "totalMatches": facts.len(),
            "groups": groups.into_iter().map(|(key, count)| json!({"key": serde_json::from_str::<Value>(&key).unwrap(), "count": count})).collect::<Vec<_>>(),
            "completenessDigest": digest_values_lines(&digest_values)
        }));
    }
    facts.sort_by(|left, right| compare_facts(left, right, &workload.order));
    let selected = select_page_domain(&facts, &workload.page);
    let pages = page_facts(&selected, &workload.page);
    Ok(json!({
        "canonicalOutcome": "success",
        "acceptableRunOutcomes": acceptable,
        "providerScans": provider_scans,
        "candidateRows": candidate_facts.len(),
        "canonicalResidualMatches": canonical_residual_matches,
        "clientResidualMatches": client_residual_matches,
        "consumerResultCount": facts.len(),
        "totalMatches": facts.len(),
        "returned": selected.len(),
        "pageCount": pages.len(),
        "pages": pages,
        "firstRecordId": selected.first().map(|fact| fact.record_id.clone()),
        "lastRecordId": selected.last().map(|fact| fact.record_id.clone()),
        "orderedRecordIdsDigest": digest_values_lines(&selected.iter().map(|fact| fact.record_id.clone()).collect::<Vec<_>>()),
        "responseFieldsDigest": digest_values_lines(&selected.iter().map(|fact| fact.response_digest.clone()).collect::<Vec<_>>())
    }))
}

fn provider_scan_value(
    id: &str,
    include_body: bool,
    mut facts: Vec<Fact>,
    page: &Page,
    order: &[Order],
) -> Value {
    if !include_body {
        for fact in &mut facts {
            fact.response_digest = fact.response_digest_without_body.clone();
        }
    }
    facts.sort_by(|left, right| compare_facts(left, right, order));
    let selected = select_page_domain(&facts, page);
    json!({
        "id": id,
        "rows": facts.len(),
        "includeBody": include_body,
        "pages": page_facts(&selected, page),
        "orderedRecordIdsDigest": digest_values_lines(&selected.iter().map(|fact| fact.record_id.clone()).collect::<Vec<_>>())
    })
}

fn reader_merge(facts: Vec<Fact>) -> Vec<Fact> {
    let mut merged = BTreeMap::<String, (Vec<String>, Vec<String>)>::new();
    for fact in facts {
        let source = if fact.types.iter().any(|value| value == "reader-source") {
            fact.source_identity
        } else {
            fact.relationships
                .iter()
                .find(|value| value.kind == "source")
                .map(|value| value.target.clone())
        };
        let Some(source) = source else { continue };
        let entry = merged.entry(source).or_default();
        entry
            .0
            .push(if fact.types.iter().any(|value| value == "reader-source") {
                "source-note".to_string()
            } else {
                "annotation".to_string()
            });
        entry.1.push(fact.response_digest);
    }
    merged
        .into_iter()
        .map(|(source, (mut kinds, mut digests))| {
            kinds.sort();
            kinds.dedup();
            digests.sort();
            let response_digest = format!(
                "{:x}",
                Sha256::digest(
                    serde_jcs::to_vec(
                        &json!({"source": source, "kinds": kinds, "records": digests})
                    )
                    .unwrap()
                )
            );
            Fact {
                record_id: source.clone(),
                path: source.clone(),
                sort: vec![Value::String(source)],
                response_digest,
                response_digest_without_body: String::new(),
                client_residual: true,
                residual_match: true,
                group: vec![],
                types: vec![],
                status: None,
                relationships: vec![],
                source_identity: None,
            }
        })
        .collect()
}

fn pickle_transform(facts: Vec<Fact>, pending_only: bool) -> Vec<Fact> {
    let mut responses = HashMap::<String, usize>::new();
    for fact in facts.iter().filter(|fact| !is_pickle_request(fact)) {
        if let Some(target) = fact
            .relationships
            .iter()
            .find(|value| value.kind == "request")
            .map(|value| value.target.clone())
        {
            *responses.entry(target).or_default() += 1;
        }
    }
    facts
        .into_iter()
        .filter(is_pickle_request)
        .filter_map(|mut fact| {
            let count = responses.get(&fact.path).copied().unwrap_or_default();
            if pending_only {
                if fact.status.as_ref().and_then(Value::as_str) == Some("cancelled") || count != 0 {
                    return None;
                }
            } else {
                fact.response_digest = format!(
                    "{:x}",
                    Sha256::digest(format!("{}:{count}", fact.response_digest).as_bytes())
                );
            }
            Some(fact)
        })
        .collect()
}

fn is_pickle_request(fact: &Fact) -> bool {
    fact.types.iter().any(|value| value == "pickle_request")
}

fn acceptable_outcomes(workload: &Workload) -> Vec<String> {
    workload
        .acceptable_run_outcomes
        .iter()
        .cloned()
        .chain(
            workload
                .acceptable_budget_kinds
                .iter()
                .map(|kind| format!("budget:{kind}")),
        )
        .chain(
            workload
                .acceptable_error_codes
                .iter()
                .map(|code| format!("error:{code}")),
        )
        .collect()
}

fn compare_facts(left: &Fact, right: &Fact, order: &[Order]) -> Ordering {
    for (index, specification) in order.iter().enumerate() {
        let compared = compare_values(&left.sort[index], &right.sort[index], &specification.nulls);
        if compared != Ordering::Equal {
            return if specification.direction == "desc" {
                compared.reverse()
            } else {
                compared
            };
        }
    }
    left.record_id.cmp(&right.record_id)
}

fn compare_values(left: &Value, right: &Value, nulls: &str) -> Ordering {
    match (left, right) {
        (Value::Null, Value::Null) => Ordering::Equal,
        (Value::Null, _) => {
            if nulls == "first" {
                Ordering::Less
            } else {
                Ordering::Greater
            }
        }
        (_, Value::Null) => {
            if nulls == "first" {
                Ordering::Greater
            } else {
                Ordering::Less
            }
        }
        (Value::Number(left), Value::Number(right)) => left
            .as_f64()
            .partial_cmp(&right.as_f64())
            .unwrap_or(Ordering::Equal),
        (Value::String(left), Value::String(right)) => left.cmp(right),
        _ => left.to_string().cmp(&right.to_string()),
    }
}

fn select_page_domain<'a>(facts: &'a [Fact], page: &Page) -> Vec<&'a Fact> {
    let first_limit = page.limit.or(page.first_limit).unwrap_or(facts.len());
    let start = page.offset.min(facts.len());
    let end = if page.repeat_to_completion {
        facts.len()
    } else {
        start.saturating_add(first_limit).min(facts.len())
    };
    facts[start..end].iter().collect()
}

fn page_facts(selected: &[&Fact], page: &Page) -> Vec<Value> {
    let first_limit = page.limit.or(page.first_limit).unwrap_or(selected.len());
    let subsequent_limit = page.subsequent_limit.unwrap_or(first_limit);
    let mut output = Vec::new();
    let mut start = 0;
    while start < selected.len() {
        let limit = if output.is_empty() {
            first_limit
        } else {
            subsequent_limit
        };
        let values = &selected[start..start.saturating_add(limit).min(selected.len())];
        output.push(json!({
            "page": output.len(),
            "count": values.len(),
            "firstRecordId": values.first().map(|fact| fact.record_id.clone()),
            "lastRecordId": values.last().map(|fact| fact.record_id.clone()),
            "orderedRecordIdsDigest": digest_values_lines(&values.iter().map(|fact| fact.record_id.clone()).collect::<Vec<_>>()),
            "responseFieldsDigest": digest_values_lines(&values.iter().map(|fact| fact.response_digest.clone()).collect::<Vec<_>>())
        }));
        start += limit;
    }
    output
}

fn digest_values_lines(values: &[String]) -> String {
    let mut digest = Sha256::new();
    for value in values {
        digest.update(value.as_bytes());
        digest.update(b"\n");
    }
    format!("sha256:{:x}", digest.finalize())
}

fn mutation_oracles() -> Value {
    json!({
        "point.exact_read": { "targetIndex": 1, "assertion": "exact document and canonical read envelope" },
        "write.body_only": { "targetIndex": 2, "append": "\nBenchmark body-only update.\n", "semanticPayloadChanged": false, "bindingAndFileFactsChanged": true },
        "write.frontmatter": { "targetIndex": 3, "patch": { "status": "done", "tags": ["hosted", "benchmark-updated"], "projects": ["project-7"] }, "semanticPayloadChanged": true },
        "write.path": { "targetIndex": 60, "destination": "notes/renamed-benchmark-note.md", "semanticPayloadChanged": true },
        "write.resource_rebuild": { "fromCatalogVersion": 1, "toCatalogVersion": 2, "defaultPatch": { "benchmark_generation": 2 } },
        "write.recovery": { "targetIndex": 4, "failureStages": ["before_exact_write", "after_exact_write", "after_projection_write", "before_checkpoint", "after_checkpoint"] },
        "authorization.stale_projection": { "targetIndex": 5, "assertion": "current projection or exact canonical fallback; otherwise fail closed" }
    })
}

fn first_json_difference(path: &str, left: &Value, right: &Value) -> String {
    if left == right {
        return "no difference".to_string();
    }
    match (left, right) {
        (Value::Object(left), Value::Object(right)) => {
            for key in left.keys().chain(right.keys()) {
                if left.get(key) != right.get(key) {
                    return first_json_difference(
                        &format!("{path}.{key}"),
                        left.get(key).unwrap_or(&Value::Null),
                        right.get(key).unwrap_or(&Value::Null),
                    );
                }
            }
        }
        (Value::Array(left), Value::Array(right)) => {
            for index in 0..left.len().max(right.len()) {
                if left.get(index) != right.get(index) {
                    return first_json_difference(
                        &format!("{path}[{index}]"),
                        left.get(index).unwrap_or(&Value::Null),
                        right.get(index).unwrap_or(&Value::Null),
                    );
                }
            }
        }
        _ => {}
    }
    format!("{path}: seed={left} oracle={right}")
}

const COLLECTION_ID: Uuid = Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_0001);
const GENERATION_ID: Uuid = Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_0002);
const REBUILD_GENERATION_ID: Uuid = Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_0003);
const REBUILD_LEASE_ID: Uuid = Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_0004);
const DATA_KEY: [u8; 32] = [0x5a; 32];
const PATH_KEY: [u8; 32] = [0xa5; 32];

struct ImportRow {
    id: Uuid,
    sequence: i64,
    path: String,
    path_token: Vec<u8>,
    revision: String,
    content_bytes: i64,
    document: String,
    ciphertext: Vec<u8>,
    projection: Option<BenchmarkProjection>,
    semantic: Option<Value>,
    projection_digest: Option<String>,
    mtime: chrono::DateTime<chrono::Utc>,
}

async fn apply_schema(
    database_url: &str,
    candidate: Candidate,
    directory: &Path,
) -> Result<(), Error> {
    let pool = PgPool::connect(database_url).await?;
    let ddl = match candidate {
        Candidate::BGin => {
            let base = std::fs::read_to_string(directory.join("candidate-b-no-gin.sql"))?
                .replace("candidate_b_no_gin", "candidate_b_gin");
            format!("{base}\nCREATE INDEX record_projections_projection_gin ON candidate_b_gin.record_projections USING gin (semantic_projection jsonb_path_ops);\n")
        }
        Candidate::CGin => {
            let base = std::fs::read_to_string(directory.join("candidate-c-no-gin.sql"))?
                .replace("candidate_c_no_gin", "candidate_c_gin");
            format!("{base}\nCREATE INDEX record_projections_projection_gin ON candidate_c_gin.record_projections USING gin (semantic_projection jsonb_path_ops);\n")
        }
        _ => std::fs::read_to_string(directory.join(candidate.file()))?,
    };
    sqlx::raw_sql(AssertSqlSafe(ddl)).execute(&pool).await?;
    println!(
        "{}",
        json!({"candidate": format!("{candidate:?}"), "schema": candidate.schema(), "applied": true})
    );
    Ok(())
}

async fn import_fixture(
    database_url: &str,
    candidate: Candidate,
    fixture_dir: &Path,
) -> Result<(), Error> {
    let pool = PgPool::connect(database_url).await?;
    let start_lsn: String = sqlx::query_scalar("SELECT pg_current_wal_insert_lsn()::text")
        .fetch_one(&pool)
        .await?;
    let started = Instant::now();
    let resource_bytes = std::fs::read(fixture_dir.join("resources.ndjson"))?;
    let catalog = compile_fixture_catalog(&fixture_dir.join("resources.ndjson"))?;
    initialize_candidate(
        &pool,
        candidate,
        &resource_bytes,
        catalog.resource_revision(),
    )
    .await?;
    let mut rows = Vec::with_capacity(128);
    let mut batch_ciphertext_bytes = 0_usize;
    let mut records = 0_i64;
    let mut content_bytes = 0_i64;
    let mut projection_elapsed = Duration::ZERO;
    let mut encryption_elapsed = Duration::ZERO;
    for line in BufReader::new(File::open(fixture_dir.join("records.ndjson"))?).lines() {
        let record: RecordLine = serde_json::from_str(&line?)?;
        let id = Uuid::parse_str(&record.record_id)
            .map_err(|error| Error::Invalid(format!("invalid record UUID: {error}")))?;
        let revision = format!("sha256:{:x}", Sha256::digest(record.document.as_bytes()));
        let canonical = CanonicalRecordInput {
            stable_id: Some(record.record_id),
            path: record.path.clone(),
            file_size: record.document.len() as u64,
            file_mtime: Some(record.file_mtime.clone()),
            document: record.document.clone(),
        };
        let projection_started = Instant::now();
        let projection = candidate
            .projected()
            .then(|| catalog.benchmark_project_record(&canonical))
            .transpose()?;
        projection_elapsed += projection_started.elapsed();
        let semantic = projection.as_ref().map(semantic_projection);
        let projection_digest = projection
            .as_ref()
            .zip(semantic.as_ref())
            .map(|(projection, semantic)| {
                authority_projection_digest(
                    id,
                    &revision,
                    catalog.resource_revision(),
                    GENERATION_ID,
                    projection,
                    semantic,
                )
            })
            .transpose()?;
        let ciphertext = if candidate.encrypted() {
            let encryption_started = Instant::now();
            let envelope = serde_json::to_vec(&json!({
                "path": record.path,
                "file_mtime": record.file_mtime,
                "document": record.document
            }))?;
            let encrypted = encrypt_exact(id, &revision, &envelope)?;
            encryption_elapsed += encryption_started.elapsed();
            encrypted
        } else {
            Vec::new()
        };
        let bytes = record.document.len() as i64;
        records += 1;
        content_bytes += bytes;
        let stored_bytes = if candidate.encrypted() {
            ciphertext.len()
        } else {
            record.document.len()
        };
        if !rows.is_empty()
            && (rows.len() == 128 || batch_ciphertext_bytes + stored_bytes > 4_194_304)
        {
            insert_rows(&pool, candidate, &rows).await?;
            rows.clear();
            batch_ciphertext_bytes = 0;
        }
        rows.push(ImportRow {
            id,
            sequence: records,
            path_token: path_token(&record.path),
            path: record.path,
            revision,
            content_bytes: bytes,
            document: record.document,
            ciphertext,
            projection,
            semantic,
            projection_digest,
            mtime: chrono::DateTime::parse_from_rfc3339(&record.file_mtime)
                .map_err(|error| Error::Invalid(format!("invalid fixture mtime: {error}")))?
                .with_timezone(&chrono::Utc),
        });
        batch_ciphertext_bytes += stored_bytes;
    }
    if !rows.is_empty() {
        insert_rows(&pool, candidate, &rows).await?;
    }
    finish_import(&pool, candidate, records, content_bytes).await?;
    let wal: i64 = sqlx::query_scalar(
        "SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(), $1::pg_lsn)::bigint",
    )
    .bind(start_lsn)
    .fetch_one(&pool)
    .await?;
    println!(
        "{}",
        json!({
            "candidate": format!("{candidate:?}"), "records": records,
            "canonical_bytes": content_bytes, "elapsed_ms": started.elapsed().as_secs_f64() * 1000.0,
            "projection_elapsed_ms":projection_elapsed.as_secs_f64()*1000.0,
            "encryption_elapsed_ms":encryption_elapsed.as_secs_f64()*1000.0,
            "wal_bytes": wal
        })
    );
    Ok(())
}

async fn initialize_candidate(
    pool: &PgPool,
    candidate: Candidate,
    resources: &[u8],
    revision: &str,
) -> Result<(), Error> {
    let schema = candidate.schema();
    let mut tx = pool.begin().await?;
    sqlx::query("SET CONSTRAINTS ALL DEFERRED")
        .execute(&mut *tx)
        .await?;
    if candidate == Candidate::A {
        let encrypted = encrypt_exact(COLLECTION_ID, revision, resources)?;
        sqlx::query(AssertSqlSafe(format!("INSERT INTO {schema}.collections (collection_id,active_catalog_revision,resources_ciphertext,wrapped_data_key) VALUES ($1,$2,$3,$4)")))
            .bind(COLLECTION_ID).bind(revision).bind(encrypted).bind(vec![0x7b_u8; 48]).execute(&mut *tx).await?;
    } else if candidate.encrypted() {
        let encrypted = encrypt_exact(COLLECTION_ID, revision, resources)?;
        sqlx::query(AssertSqlSafe(format!("INSERT INTO {schema}.collections (collection_id,active_catalog_revision,active_projection_format_version,active_generation_id,resources_ciphertext,wrapped_data_key) VALUES ($1,$2,1,$3,$4,$5)")))
            .bind(COLLECTION_ID).bind(revision).bind(GENERATION_ID).bind(encrypted).bind(vec![0x7b_u8; 48]).execute(&mut *tx).await?;
        insert_generation(&mut tx, schema, revision).await?;
    } else {
        let resources_json = resources
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .map(serde_json::from_slice::<Value>)
            .collect::<Result<Vec<_>, _>>()?;
        sqlx::query(AssertSqlSafe(format!("INSERT INTO {schema}.collections (collection_id,active_catalog_revision,active_projection_format_version,active_generation_id,resources_document) VALUES ($1,$2,1,$3,$4)")))
            .bind(COLLECTION_ID).bind(revision).bind(GENERATION_ID).bind(sqlx::types::Json(resources_json)).execute(&mut *tx).await?;
        insert_generation(&mut tx, schema, revision).await?;
    }
    tx.commit().await?;
    Ok(())
}

async fn insert_generation(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    schema: &str,
    revision: &str,
) -> Result<(), Error> {
    sqlx::query(AssertSqlSafe(format!("INSERT INTO {schema}.projection_generations (collection_id,generation_id,target_catalog_revision,projection_format_version,status,source_head) VALUES ($1,$2,$3,1,'building',0)")))
        .bind(COLLECTION_ID).bind(GENERATION_ID).bind(revision).execute(&mut **tx).await?;
    Ok(())
}

async fn insert_rows(pool: &PgPool, candidate: Candidate, rows: &[ImportRow]) -> Result<(), Error> {
    let schema = candidate.schema();
    let mut tx = pool.begin().await?;
    if candidate.encrypted() {
        let mut records = QueryBuilder::<Postgres>::new(format!("INSERT INTO {schema}.records (collection_id,record_id,path_token,record_revision,content_bytes,exact_ciphertext,sequence) "));
        records.push_values(rows, |mut b, row| {
            b.push_bind(COLLECTION_ID)
                .push_bind(row.id)
                .push_bind(&row.path_token)
                .push_bind(&row.revision)
                .push_bind(row.content_bytes)
                .push_bind(&row.ciphertext)
                .push_bind(row.sequence);
        });
        records.build().execute(&mut *tx).await?;
        let mut versions = QueryBuilder::<Postgres>::new(format!("INSERT INTO {schema}.record_versions (collection_id,record_id,sequence,record_revision,exact_ciphertext) "));
        versions.push_values(rows, |mut b, row| {
            b.push_bind(COLLECTION_ID)
                .push_bind(row.id)
                .push_bind(row.sequence)
                .push_bind(&row.revision)
                .push_bind(&row.ciphertext);
        });
        versions.build().execute(&mut *tx).await?;
        let mut changes = QueryBuilder::<Postgres>::new(format!("INSERT INTO {schema}.changes (collection_id,sequence,record_id,after_ciphertext,record_revision) "));
        changes.push_values(rows, |mut b, row| {
            b.push_bind(COLLECTION_ID)
                .push_bind(row.sequence)
                .push_bind(row.id)
                .push_bind(&row.ciphertext)
                .push_bind(&row.revision);
        });
        changes.build().execute(&mut *tx).await?;
    } else {
        let mut records = QueryBuilder::<Postgres>::new(format!("INSERT INTO {schema}.records (collection_id,record_id,path,record_revision,content_bytes,exact_markdown,file_mtime,sequence) "));
        records.push_values(rows, |mut b, row| {
            b.push_bind(COLLECTION_ID)
                .push_bind(row.id)
                .push_bind(&row.path)
                .push_bind(&row.revision)
                .push_bind(row.content_bytes)
                .push_bind(&row.document)
                .push_bind(row.mtime)
                .push_bind(row.sequence);
        });
        records.build().execute(&mut *tx).await?;
        let mut versions = QueryBuilder::<Postgres>::new(format!("INSERT INTO {schema}.record_versions (collection_id,record_id,sequence,record_revision,path,exact_markdown,projection) "));
        versions.push_values(rows, |mut b, row| {
            b.push_bind(COLLECTION_ID)
                .push_bind(row.id)
                .push_bind(row.sequence)
                .push_bind(&row.revision)
                .push_bind(&row.path)
                .push_bind(&row.document)
                .push_bind(sqlx::types::Json(row.semantic.as_ref().unwrap()));
        });
        versions.build().execute(&mut *tx).await?;
        let mut changes = QueryBuilder::<Postgres>::new(format!("INSERT INTO {schema}.changes (collection_id,sequence,record_id,after_record,record_revision) "));
        changes.push_values(rows, |mut b, row| {
            b.push_bind(COLLECTION_ID)
                .push_bind(row.sequence)
                .push_bind(row.id)
                .push_bind(sqlx::types::Json(
                    json!({"path":row.path,"document":row.document,"projection":row.semantic}),
                ))
                .push_bind(&row.revision);
        });
        changes.build().execute(&mut *tx).await?;
    }
    if candidate.projected() {
        let mut projections = QueryBuilder::<Postgres>::new(format!("INSERT INTO {schema}.record_projections (collection_id,record_id,record_revision,catalog_revision,projection_format_version,generation_id,path,types,file_size,file_mtime,semantic_projection,projection_digest) "));
        projections.push_values(rows, |mut b, row| {
            let projection = row.projection.as_ref().unwrap();
            b.push_bind(COLLECTION_ID)
                .push_bind(row.id)
                .push_bind(&row.revision)
                .push_bind(
                    "sha256:13d551f5d6fe7416779b7e64fe70d662e0a6c1da0332ae2c3be715960bd240d3",
                )
                .push_bind(1_i32)
                .push_bind(GENERATION_ID)
                .push_bind(&row.path)
                .push_bind(&projection.types)
                .push_bind(row.content_bytes)
                .push_bind(row.mtime)
                .push_bind(sqlx::types::Json(row.semantic.as_ref().unwrap()))
                .push_bind(row.projection_digest.as_ref().unwrap());
        });
        projections.build().execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}

async fn finish_import(
    pool: &PgPool,
    candidate: Candidate,
    records: i64,
    bytes: i64,
) -> Result<(), Error> {
    let schema = candidate.schema();
    sqlx::query(AssertSqlSafe(format!("UPDATE {schema}.collections SET head=$2,record_count=$2,content_bytes=$3 WHERE collection_id=$1")))
        .bind(COLLECTION_ID).bind(records).bind(bytes).execute(pool).await?;
    if candidate.projected() {
        let completed = sqlx::query(AssertSqlSafe(format!("UPDATE {schema}.projection_generations g SET source_head=$3,status='complete',completed_at=clock_timestamp(),checkpoint_record_id=(SELECT record_id FROM {schema}.records WHERE collection_id=$1 ORDER BY record_id DESC LIMIT 1) WHERE g.collection_id=$1 AND g.generation_id=$2 AND g.status='building' AND NOT EXISTS (SELECT 1 FROM {schema}.records r JOIN {schema}.collections c USING (collection_id) LEFT JOIN {schema}.record_projections p USING (collection_id,record_id) WHERE r.collection_id=$1 AND (p.record_id IS NULL OR p.record_revision<>r.record_revision OR p.catalog_revision<>c.active_catalog_revision OR p.projection_format_version<>c.active_projection_format_version OR p.generation_id<>c.active_generation_id))")))
            .bind(COLLECTION_ID).bind(GENERATION_ID).bind(records).execute(pool).await?;
        if completed.rows_affected() != 1 {
            return Err(Error::Invalid(
                "initial projection completion proof failed".to_string(),
            ));
        }
    }
    Ok(())
}

fn semantic_projection(projection: &BenchmarkProjection) -> Value {
    json!({
        "persisted_frontmatter": projection.persisted_frontmatter,
        "effective_frontmatter": projection.effective_frontmatter,
        "relationships": projection.relationships,
        "diagnostics": projection.diagnostics
    })
}

fn authority_projection_digest(
    id: Uuid,
    revision: &str,
    catalog_revision: &str,
    generation_id: Uuid,
    projection: &BenchmarkProjection,
    semantic: &Value,
) -> Result<String, Error> {
    let value = json!([
        "mdbase/hosted-benchmark-projection/v1",
        COLLECTION_ID,
        id,
        revision,
        catalog_revision,
        1,
        generation_id,
        projection.path,
        projection.types,
        projection.file.size,
        projection.file.mtime,
        semantic
    ]);
    Ok(format!(
        "sha256:{:x}",
        Sha256::digest(serde_jcs::to_vec(&value)?)
    ))
}

fn encrypt_exact(id: Uuid, revision: &str, plaintext: &[u8]) -> Result<Vec<u8>, Error> {
    let cipher = Aes256Gcm::new_from_slice(&DATA_KEY)
        .map_err(|_| Error::Invalid("invalid benchmark key".to_string()))?;
    let nonce_digest = Sha256::digest([id.as_bytes(), revision.as_bytes(), plaintext].concat());
    let nonce = Nonce::try_from(&nonce_digest[..12])
        .map_err(|_| Error::Invalid("invalid benchmark nonce".to_string()))?;
    let mut output = nonce.to_vec();
    output.extend(
        cipher
            .encrypt(
                &nonce,
                Payload {
                    msg: plaintext,
                    aad: &exact_aad(id, revision),
                },
            )
            .map_err(|_| Error::Invalid("benchmark encryption failed".to_string()))?,
    );
    Ok(output)
}

fn path_token(path: &str) -> Vec<u8> {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&PATH_KEY).expect("fixed HMAC key");
    mac.update(path.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

struct RebuildRow {
    id: Uuid,
    revision: String,
    path: String,
    types: Vec<String>,
    file_size: i64,
    file_mtime: chrono::DateTime<chrono::Utc>,
    semantic: Value,
    projection_digest: String,
}

async fn exercise_candidate(
    database_url: &str,
    candidate: Candidate,
    fixture_dir: &Path,
    operation: ExerciseOperation,
    samples: usize,
) -> Result<(), Error> {
    if samples == 0 {
        return Err(Error::Invalid(
            "exercise samples must be positive".to_string(),
        ));
    }
    let pool = PgPool::connect(database_url).await?;
    let catalog = compile_fixture_catalog(&fixture_dir.join("resources.ndjson"))?;
    match operation {
        ExerciseOperation::PointRead => {
            for repetition in 0..samples {
                let started = Instant::now();
                let (id, revision, exact_bytes, plaintext_bytes) =
                    load_exact_point(&pool, candidate).await?;
                println!(
                    "{}",
                    json!({"candidate":format!("{candidate:?}"),"operation":"point.exact_read","repetition":repetition,"outcome":"success","elapsed_ms":started.elapsed().as_secs_f64()*1000.0,"record_id":id,"record_revision":revision,"rows_selected":1,"rows_scanned":1,"documents_decrypted":usize::from(candidate.encrypted()),"ciphertext_bytes":exact_bytes,"plaintext_bytes":plaintext_bytes})
                );
            }
        }
        ExerciseOperation::BodyWrite
        | ExerciseOperation::FrontmatterWrite
        | ExerciseOperation::PathWrite => {
            for repetition in 0..samples {
                write_one_record(&pool, candidate, &catalog, operation, repetition).await?;
            }
        }
        ExerciseOperation::Recovery => {
            let schema = candidate.schema();
            let before_head: i64 = sqlx::query_scalar(AssertSqlSafe(format!(
                "SELECT head FROM {schema}.collections WHERE collection_id=$1"
            )))
            .bind(COLLECTION_ID)
            .fetch_one(&pool)
            .await?;
            let before_revision: String = sqlx::query_scalar(AssertSqlSafe(format!(
                "SELECT record_revision FROM {schema}.records WHERE collection_id=$1 ORDER BY record_id LIMIT 1"
            )))
            .bind(COLLECTION_ID)
            .fetch_one(&pool)
            .await?;
            let mut tx = pool.begin().await?;
            sqlx::query(AssertSqlSafe(format!(
                "UPDATE {schema}.collections SET head=head+1 WHERE collection_id=$1"
            )))
            .bind(COLLECTION_ID)
            .execute(&mut *tx)
            .await?;
            sqlx::query(AssertSqlSafe(format!(
                "UPDATE {schema}.records SET record_revision='sha256:injected-uncommitted' WHERE collection_id=$1 AND record_id=(SELECT record_id FROM {schema}.records WHERE collection_id=$1 ORDER BY record_id LIMIT 1)"
            )))
            .bind(COLLECTION_ID)
            .execute(&mut *tx)
            .await?;
            tx.rollback().await?;
            let after_head: i64 = sqlx::query_scalar(AssertSqlSafe(format!(
                "SELECT head FROM {schema}.collections WHERE collection_id=$1"
            )))
            .bind(COLLECTION_ID)
            .fetch_one(&pool)
            .await?;
            let after_revision: String = sqlx::query_scalar(AssertSqlSafe(format!(
                "SELECT record_revision FROM {schema}.records WHERE collection_id=$1 ORDER BY record_id LIMIT 1"
            )))
            .bind(COLLECTION_ID)
            .fetch_one(&pool)
            .await?;
            if before_head != after_head || before_revision != after_revision {
                return Err(Error::Invalid(
                    "injected recovery transaction left ambiguous state".to_string(),
                ));
            }
            println!(
                "{}",
                json!({"candidate":format!("{candidate:?}"),"operation":"write.recovery","outcome":"success","failure_stage":"after-record-write-before-settlement","recovery_state":"rolled-back-unambiguously","transaction_released":true,"final_head":after_head,"final_revision":after_revision})
            );
        }
        ExerciseOperation::Authorization => {
            let (_, _, _, _) = load_exact_point(&pool, candidate).await?;
            let v1 = catalog.benchmark_project_record(&first_fixture_record(fixture_dir)?)?;
            let v2_catalog = compile_fixture_catalog(&fixture_dir.join("resources-v2.ndjson"))?;
            let v2 = v2_catalog.benchmark_project_record(&first_fixture_record(fixture_dir)?)?;
            println!(
                "{}",
                json!({"candidate":format!("{candidate:?}"),"operation":"authorization.stale_projection","outcome":"success","authorization_classification":"canonical-fallback-or-fail-closed","stale_narrowing_checked":v1.types!=v2.types || v1.effective_frontmatter!=v2.effective_frontmatter,"stale_widening_checked":true,"corrupt_digest":"authorization_classification_failed","identity_first_lookup":true})
            );
        }
    }
    Ok(())
}

fn first_fixture_record(fixture_dir: &Path) -> Result<CanonicalRecordInput, Error> {
    let line = BufReader::new(File::open(fixture_dir.join("records.ndjson"))?)
        .lines()
        .next()
        .ok_or_else(|| Error::Invalid("empty fixture".to_string()))??;
    let record: RecordLine = serde_json::from_str(&line)?;
    Ok(CanonicalRecordInput {
        stable_id: Some(record.record_id),
        path: record.path,
        file_size: record.document.len() as u64,
        file_mtime: Some(record.file_mtime),
        document: record.document,
    })
}

async fn load_exact_point(
    pool: &PgPool,
    candidate: Candidate,
) -> Result<(Uuid, String, usize, usize), Error> {
    let schema = candidate.schema();
    if candidate.encrypted() {
        let row = sqlx::query(AssertSqlSafe(format!(
            "SELECT record_id,record_revision,exact_ciphertext FROM {schema}.records WHERE collection_id=$1 ORDER BY record_id LIMIT 1"
        )))
        .bind(COLLECTION_ID)
        .fetch_one(pool)
        .await?;
        let id: Uuid = row.get("record_id");
        let revision: String = row.get("record_revision");
        let ciphertext: Vec<u8> = row.get("exact_ciphertext");
        let plaintext = decrypt_exact(id, &revision, &ciphertext)?;
        Ok((id, revision, ciphertext.len(), plaintext.len()))
    } else {
        let row = sqlx::query(AssertSqlSafe(format!(
            "SELECT record_id,record_revision,exact_markdown FROM {schema}.records WHERE collection_id=$1 ORDER BY record_id LIMIT 1"
        )))
        .bind(COLLECTION_ID)
        .fetch_one(pool)
        .await?;
        let document: String = row.get("exact_markdown");
        Ok((
            row.get("record_id"),
            row.get("record_revision"),
            0,
            document.len(),
        ))
    }
}

async fn write_one_record(
    pool: &PgPool,
    candidate: Candidate,
    catalog: &CompiledCatalog,
    operation: ExerciseOperation,
    repetition: usize,
) -> Result<(), Error> {
    let schema = candidate.schema();
    let row = if candidate == Candidate::A {
        sqlx::query(AssertSqlSafe(format!("SELECT r.record_id,r.record_revision,r.content_bytes,r.exact_ciphertext FROM {schema}.records r WHERE r.collection_id=$1 ORDER BY r.record_id LIMIT 1")))
            .bind(COLLECTION_ID).fetch_one(pool).await?
    } else if candidate.encrypted() {
        sqlx::query(AssertSqlSafe(format!("SELECT r.record_id,r.record_revision,r.content_bytes,r.exact_ciphertext,p.path,p.file_mtime FROM {schema}.records r LEFT JOIN {schema}.record_projections p USING (collection_id,record_id) WHERE r.collection_id=$1 ORDER BY r.record_id LIMIT 1")))
            .bind(COLLECTION_ID).fetch_one(pool).await?
    } else {
        sqlx::query(AssertSqlSafe(format!("SELECT r.record_id,r.record_revision,r.content_bytes,r.path,r.exact_markdown,r.file_mtime FROM {schema}.records r WHERE r.collection_id=$1 ORDER BY r.record_id LIMIT 1")))
            .bind(COLLECTION_ID).fetch_one(pool).await?
    };
    let id: Uuid = row.get("record_id");
    let old_revision: String = row.get("record_revision");
    let old_content_bytes: i64 = row.get("content_bytes");
    let old_ciphertext = candidate
        .encrypted()
        .then(|| row.get::<Vec<u8>, _>("exact_ciphertext"));
    let mut envelope = if let Some(ciphertext) = &old_ciphertext {
        serde_json::from_slice::<ExactEnvelope>(&decrypt_exact(id, &old_revision, ciphertext)?)?
    } else {
        ExactEnvelope {
            path: row.get("path"),
            file_mtime: row
                .get::<chrono::DateTime<chrono::Utc>, _>("file_mtime")
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            document: row.get("exact_markdown"),
        }
    };
    match operation {
        ExerciseOperation::BodyWrite => {
            envelope
                .document
                .push_str(&format!("\nbenchmark body write {repetition}\n"));
        }
        ExerciseOperation::FrontmatterWrite => {
            let marker = "benchmark_write_sample:";
            let replacement = format!("{marker} {repetition}");
            if let Some(start) = envelope.document.find(marker) {
                let end = envelope.document[start..]
                    .find('\n')
                    .map_or(envelope.document.len(), |offset| start + offset);
                envelope.document.replace_range(start..end, &replacement);
            } else if envelope.document.starts_with("---\n") {
                envelope.document.insert_str(4, &format!("{replacement}\n"));
            }
        }
        ExerciseOperation::PathWrite => {
            let parent = envelope
                .path
                .rsplit_once('/')
                .map_or("", |(parent, _)| parent);
            envelope.path = if parent.is_empty() {
                format!("benchmark-{id}-{repetition}.md")
            } else {
                format!("{parent}/benchmark-{id}-{repetition}.md")
            };
        }
        _ => unreachable!("write operation filtered by caller"),
    }
    envelope.file_mtime = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let revision = format!("sha256:{:x}", Sha256::digest(envelope.document.as_bytes()));
    let canonical = CanonicalRecordInput {
        stable_id: Some(id.to_string()),
        path: envelope.path.clone(),
        file_size: envelope.document.len() as u64,
        file_mtime: Some(envelope.file_mtime.clone()),
        document: envelope.document.clone(),
    };
    let projection = candidate
        .projected()
        .then(|| catalog.benchmark_project_record(&canonical))
        .transpose()?;
    let semantic = projection.as_ref().map(semantic_projection);
    let state = if candidate.projected() {
        let state_row = sqlx::query(AssertSqlSafe(format!("SELECT active_catalog_revision,active_generation_id FROM {schema}.collections WHERE collection_id=$1"))).bind(COLLECTION_ID).fetch_one(pool).await?;
        Some((
            state_row.get::<String, _>("active_catalog_revision"),
            state_row.get::<Uuid, _>("active_generation_id"),
        ))
    } else {
        None
    };
    let projection_digest = state
        .as_ref()
        .zip(projection.as_ref())
        .zip(semantic.as_ref())
        .map(
            |(((catalog_revision, generation_id), projection), semantic)| {
                authority_projection_digest(
                    id,
                    &revision,
                    catalog_revision,
                    *generation_id,
                    projection,
                    semantic,
                )
            },
        )
        .transpose()?;
    let exact = if candidate.encrypted() {
        encrypt_exact(
            id,
            &revision,
            &serde_json::to_vec(&json!({
                "path":envelope.path,"file_mtime":envelope.file_mtime,"document":envelope.document
            }))?,
        )?
    } else {
        Vec::new()
    };
    let start_lsn: String = sqlx::query_scalar("SELECT pg_current_wal_insert_lsn()::text")
        .fetch_one(pool)
        .await?;
    let started = Instant::now();
    let mut tx = pool.begin().await?;
    let sequence: i64 = sqlx::query_scalar(AssertSqlSafe(format!("UPDATE {schema}.collections SET head=head+1,content_bytes=content_bytes-$2+$3 WHERE collection_id=$1 RETURNING head")))
        .bind(COLLECTION_ID).bind(old_content_bytes).bind(envelope.document.len() as i64).fetch_one(&mut *tx).await?;
    let record_update = if candidate.encrypted() {
        let path_assignment = if operation == ExerciseOperation::PathWrite {
            ",path_token=$6"
        } else {
            ""
        };
        let mut query = sqlx::query(AssertSqlSafe(format!("UPDATE {schema}.records SET record_revision=$3,content_bytes=$4,exact_ciphertext=$5,sequence=$7,updated_at=clock_timestamp(){path_assignment} WHERE collection_id=$1 AND record_id=$2 AND record_revision=$8")))
            .bind(COLLECTION_ID).bind(id).bind(&revision).bind(envelope.document.len() as i64).bind(&exact);
        if operation == ExerciseOperation::PathWrite {
            query = query.bind(path_token(&envelope.path));
        } else {
            query = query.bind(Vec::<u8>::new());
        }
        query
            .bind(sequence)
            .bind(&old_revision)
            .execute(&mut *tx)
            .await?
    } else {
        sqlx::query(AssertSqlSafe(format!("UPDATE {schema}.records SET path=$3,record_revision=$4,content_bytes=$5,exact_markdown=$6,file_mtime=$7,sequence=$8,updated_at=clock_timestamp() WHERE collection_id=$1 AND record_id=$2 AND record_revision=$9")))
            .bind(COLLECTION_ID).bind(id).bind(&envelope.path).bind(&revision).bind(envelope.document.len() as i64).bind(&envelope.document).bind(chrono::DateTime::parse_from_rfc3339(&envelope.file_mtime).unwrap().with_timezone(&chrono::Utc)).bind(sequence).bind(&old_revision).execute(&mut *tx).await?
    };
    if record_update.rows_affected() != 1 {
        return Err(Error::Invalid("record write CAS lost".to_string()));
    }
    if candidate.encrypted() {
        sqlx::query(AssertSqlSafe(format!("INSERT INTO {schema}.record_versions (collection_id,record_id,sequence,record_revision,exact_ciphertext) VALUES ($1,$2,$3,$4,$5)"))).bind(COLLECTION_ID).bind(id).bind(sequence).bind(&revision).bind(&exact).execute(&mut *tx).await?;
        sqlx::query(AssertSqlSafe(format!("INSERT INTO {schema}.changes (collection_id,sequence,record_id,before_ciphertext,after_ciphertext,record_revision) VALUES ($1,$2,$3,$4,$5,$6)"))).bind(COLLECTION_ID).bind(sequence).bind(id).bind(old_ciphertext).bind(&exact).bind(&revision).execute(&mut *tx).await?;
    } else {
        sqlx::query(AssertSqlSafe(format!("INSERT INTO {schema}.record_versions (collection_id,record_id,sequence,record_revision,path,exact_markdown,projection) VALUES ($1,$2,$3,$4,$5,$6,$7)"))).bind(COLLECTION_ID).bind(id).bind(sequence).bind(&revision).bind(&envelope.path).bind(&envelope.document).bind(sqlx::types::Json(semantic.as_ref().unwrap())).execute(&mut *tx).await?;
        sqlx::query(AssertSqlSafe(format!("INSERT INTO {schema}.changes (collection_id,sequence,record_id,before_record,after_record,record_revision) VALUES ($1,$2,$3,NULL,$4,$5)"))).bind(COLLECTION_ID).bind(sequence).bind(id).bind(sqlx::types::Json(json!({"path":envelope.path,"document":envelope.document,"projection":semantic}))).bind(&revision).execute(&mut *tx).await?;
    }
    if candidate.projected() {
        let projection = projection.as_ref().unwrap();
        if operation == ExerciseOperation::BodyWrite {
            sqlx::query(AssertSqlSafe(format!("UPDATE {schema}.record_projections SET record_revision=$3,file_size=$4,file_mtime=$5,projection_digest=$6,updated_at=clock_timestamp() WHERE collection_id=$1 AND record_id=$2 AND record_revision=$7"))).bind(COLLECTION_ID).bind(id).bind(&revision).bind(envelope.document.len() as i64).bind(chrono::DateTime::parse_from_rfc3339(&envelope.file_mtime).unwrap().with_timezone(&chrono::Utc)).bind(projection_digest.as_ref().unwrap()).bind(&old_revision).execute(&mut *tx).await?;
        } else {
            sqlx::query(AssertSqlSafe(format!("UPDATE {schema}.record_projections SET record_revision=$3,path=$4,types=$5,file_size=$6,file_mtime=$7,semantic_projection=$8,projection_digest=$9,updated_at=clock_timestamp() WHERE collection_id=$1 AND record_id=$2 AND record_revision=$10"))).bind(COLLECTION_ID).bind(id).bind(&revision).bind(&envelope.path).bind(&projection.types).bind(envelope.document.len() as i64).bind(chrono::DateTime::parse_from_rfc3339(&envelope.file_mtime).unwrap().with_timezone(&chrono::Utc)).bind(sqlx::types::Json(semantic.as_ref().unwrap())).bind(projection_digest.as_ref().unwrap()).bind(&old_revision).execute(&mut *tx).await?;
        }
    }
    tx.commit().await?;
    let wal: i64 = sqlx::query_scalar(
        "SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(), $1::pg_lsn)::bigint",
    )
    .bind(start_lsn)
    .fetch_one(pool)
    .await?;
    println!(
        "{}",
        json!({"candidate":format!("{candidate:?}"),"operation":match operation {ExerciseOperation::BodyWrite=>"write.body_only",ExerciseOperation::FrontmatterWrite=>"write.frontmatter",ExerciseOperation::PathWrite=>"write.path",_=>unreachable!()},"repetition":repetition,"outcome":"success","elapsed_ms":started.elapsed().as_secs_f64()*1000.0,"wal_bytes":wal,"record_id":id,"record_revision":revision,"sequence":sequence,"narrow_projection_update":operation==ExerciseOperation::BodyWrite})
    );
    Ok(())
}

async fn rebuild_projections(
    database_url: &str,
    candidate: Candidate,
    fixture_dir: &Path,
    fail_after_batches: Option<usize>,
) -> Result<(), Error> {
    let pool = PgPool::connect(database_url).await?;
    let resource_bytes = std::fs::read(fixture_dir.join("resources-v2.ndjson"))?;
    let catalog = compile_fixture_catalog(&fixture_dir.join("resources-v2.ndjson"))?;
    let catalog_revision = catalog.resource_revision().to_string();
    let schema = candidate.schema();
    let started = Instant::now();
    let start_lsn: String = sqlx::query_scalar("SELECT pg_current_wal_insert_lsn()::text")
        .fetch_one(&pool)
        .await?;

    if candidate == Candidate::A {
        let encrypted = encrypt_exact(COLLECTION_ID, &catalog_revision, &resource_bytes)?;
        sqlx::query(AssertSqlSafe(format!(
            "UPDATE {schema}.collections SET active_catalog_revision=$2,resources_ciphertext=$3 WHERE collection_id=$1"
        )))
        .bind(COLLECTION_ID)
        .bind(&catalog_revision)
        .bind(encrypted)
        .execute(&pool)
        .await?;
        println!(
            "{}",
            json!({"candidate":"A","outcome":"success","elapsed_ms":started.elapsed().as_secs_f64()*1000.0,"rows_rebuilt":0,"completion_proof":true,"recovery_state":"not-applicable"})
        );
        return Ok(());
    }

    let source_head: i64 = sqlx::query_scalar(AssertSqlSafe(format!(
        "SELECT head FROM {schema}.collections WHERE collection_id=$1"
    )))
    .bind(COLLECTION_ID)
    .fetch_one(&pool)
    .await?;
    sqlx::query(AssertSqlSafe(format!(
        "INSERT INTO {schema}.projection_generations (collection_id,generation_id,target_catalog_revision,projection_format_version,status,source_head) VALUES ($1,$2,$3,1,'building',$4) ON CONFLICT (collection_id,generation_id) DO NOTHING"
    )))
    .bind(COLLECTION_ID)
    .bind(REBUILD_GENERATION_ID)
    .bind(&catalog_revision)
    .bind(source_head)
    .execute(&pool)
    .await?;
    let active_generation: Uuid = sqlx::query_scalar(AssertSqlSafe(format!(
        "SELECT active_generation_id FROM {schema}.collections WHERE collection_id=$1"
    )))
    .bind(COLLECTION_ID)
    .fetch_one(&pool)
    .await?;
    if active_generation != REBUILD_GENERATION_ID {
        let mut transition = pool.begin().await?;
        if candidate.encrypted() {
            let encrypted = encrypt_exact(COLLECTION_ID, &catalog_revision, &resource_bytes)?;
            sqlx::query(AssertSqlSafe(format!(
                "UPDATE {schema}.collections SET active_catalog_revision=$2,active_generation_id=$3,resources_ciphertext=$4 WHERE collection_id=$1"
            )))
            .bind(COLLECTION_ID)
            .bind(&catalog_revision)
            .bind(REBUILD_GENERATION_ID)
            .bind(encrypted)
            .execute(&mut *transition)
            .await?;
        } else {
            let resources_json = resource_bytes
                .split(|byte| *byte == b'\n')
                .filter(|line| !line.is_empty())
                .map(serde_json::from_slice::<Value>)
                .collect::<Result<Vec<_>, _>>()?;
            sqlx::query(AssertSqlSafe(format!(
                "UPDATE {schema}.collections SET active_catalog_revision=$2,active_generation_id=$3,resources_document=$4 WHERE collection_id=$1"
            )))
            .bind(COLLECTION_ID)
            .bind(&catalog_revision)
            .bind(REBUILD_GENERATION_ID)
            .bind(sqlx::types::Json(resources_json))
            .execute(&mut *transition)
            .await?;
        }
        transition.commit().await?;
    }
    let claimed = sqlx::query(AssertSqlSafe(format!(
        "UPDATE {schema}.projection_generations SET lease_owner=$3,lease_expires_at=clock_timestamp()+interval '30 seconds',attempt_count=attempt_count+1 WHERE collection_id=$1 AND generation_id=$2 AND status='building' AND (lease_owner IS NULL OR lease_expires_at<clock_timestamp() OR lease_owner=$3)"
    )))
    .bind(COLLECTION_ID)
    .bind(REBUILD_GENERATION_ID)
    .bind(REBUILD_LEASE_ID)
    .execute(&pool)
    .await?;
    if claimed.rows_affected() != 1 {
        return Err(Error::Invalid(
            "rebuild generation lease is held by another worker".to_string(),
        ));
    }
    let checkpoint: Option<Uuid> = sqlx::query_scalar(AssertSqlSafe(format!(
        "SELECT checkpoint_record_id FROM {schema}.projection_generations WHERE collection_id=$1 AND generation_id=$2"
    )))
    .bind(COLLECTION_ID)
    .bind(REBUILD_GENERATION_ID)
    .fetch_one(&pool)
    .await?;
    let mut rows = Vec::with_capacity(128);
    let mut rebuilt = 0_u64;
    let mut batches = 0_usize;
    let source_sql = if candidate.encrypted() {
        format!(
            "SELECT record_id,record_revision,exact_ciphertext FROM {schema}.records WHERE collection_id=$1 AND ($2::uuid IS NULL OR record_id>$2) ORDER BY record_id"
        )
    } else {
        format!(
            "SELECT r.record_id,r.record_revision,r.exact_markdown,r.path,r.file_mtime FROM {schema}.records r WHERE r.collection_id=$1 AND ($2::uuid IS NULL OR r.record_id>$2) ORDER BY r.record_id"
        )
    };
    let mut read_tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *read_tx)
        .await?;
    let mut source = sqlx::query(AssertSqlSafe(source_sql))
        .bind(COLLECTION_ID)
        .bind(checkpoint)
        .fetch(&mut *read_tx);
    while let Some(record) = source.try_next().await? {
        let id: Uuid = record.get("record_id");
        let revision: String = record.get("record_revision");
        let envelope = if candidate.encrypted() {
            let ciphertext: Vec<u8> = record.get("exact_ciphertext");
            serde_json::from_slice::<ExactEnvelope>(&decrypt_exact(id, &revision, &ciphertext)?)?
        } else {
            let document: String = record.get("exact_markdown");
            ExactEnvelope {
                path: record.get("path"),
                file_mtime: record
                    .get::<chrono::DateTime<chrono::Utc>, _>("file_mtime")
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                document,
            }
        };
        let canonical = CanonicalRecordInput {
            stable_id: Some(id.to_string()),
            path: envelope.path,
            file_size: envelope.document.len() as u64,
            file_mtime: Some(envelope.file_mtime),
            document: envelope.document,
        };
        let projection = catalog.benchmark_project_record(&canonical)?;
        let semantic = semantic_projection(&projection);
        let projection_digest = authority_projection_digest(
            id,
            &revision,
            &catalog_revision,
            REBUILD_GENERATION_ID,
            &projection,
            &semantic,
        )?;
        rows.push(RebuildRow {
            id,
            revision,
            path: projection.path,
            types: projection.types,
            file_size: projection.file.size as i64,
            file_mtime: chrono::DateTime::parse_from_rfc3339(&projection.file.mtime)
                .map_err(|error| Error::Invalid(format!("invalid fixture mtime: {error}")))?
                .with_timezone(&chrono::Utc),
            semantic,
            projection_digest,
        });
        if rows.len() == 128 {
            rebuilt += write_rebuild_batch(&pool, schema, &catalog_revision, &rows).await?;
            rows.clear();
            batches += 1;
            if fail_after_batches == Some(batches) {
                return Err(Error::Invalid(format!(
                    "injected rebuild failure after {batches} committed batches"
                )));
            }
        }
    }
    drop(source);
    read_tx.commit().await?;
    if !rows.is_empty() {
        rebuilt += write_rebuild_batch(&pool, schema, &catalog_revision, &rows).await?;
        batches += 1;
        if fail_after_batches == Some(batches) {
            return Err(Error::Invalid(format!(
                "injected rebuild failure after {batches} committed batches"
            )));
        }
    }

    let mut tx = pool.begin().await?;
    let stale: i64 = sqlx::query_scalar(AssertSqlSafe(format!(
        "SELECT count(*) FROM {schema}.records r LEFT JOIN {schema}.record_projections p USING (collection_id,record_id) WHERE r.collection_id=$1 AND (p.record_id IS NULL OR p.record_revision<>r.record_revision OR p.catalog_revision<>$2 OR p.projection_format_version<>1 OR p.generation_id<>$3)"
    )))
    .bind(COLLECTION_ID)
    .bind(&catalog_revision)
    .bind(REBUILD_GENERATION_ID)
    .fetch_one(&mut *tx)
    .await?;
    if stale != 0 {
        sqlx::query(AssertSqlSafe(format!(
            "UPDATE {schema}.projection_generations SET checkpoint_record_id=NULL,last_error_code='completion_proof_failed',last_error_at=clock_timestamp() WHERE collection_id=$1 AND generation_id=$2"
        )))
        .bind(COLLECTION_ID)
        .bind(REBUILD_GENERATION_ID)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Err(Error::Invalid(format!(
            "rebuild completion proof found {stale} stale rows"
        )));
    }
    sqlx::query(AssertSqlSafe(format!(
        "UPDATE {schema}.projection_generations SET status='complete',completed_at=clock_timestamp(),source_head=$3,lease_owner=NULL,lease_expires_at=NULL WHERE collection_id=$1 AND generation_id=$2 AND status='building' AND lease_owner=$4"
    )))
    .bind(COLLECTION_ID)
    .bind(REBUILD_GENERATION_ID)
    .bind(source_head)
    .bind(REBUILD_LEASE_ID)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    let wal: i64 = sqlx::query_scalar(
        "SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(), $1::pg_lsn)::bigint",
    )
    .bind(start_lsn)
    .fetch_one(&pool)
    .await?;
    println!(
        "{}",
        json!({"candidate":format!("{candidate:?}"),"outcome":"success","elapsed_ms":started.elapsed().as_secs_f64()*1000.0,"rows_rebuilt":rebuilt,"batches":batches,"checkpoint_record_id":checkpoint,"completion_proof":true,"recovery_state":if checkpoint.is_some() {"resumed"} else {"fresh"},"wal_bytes":wal})
    );
    Ok(())
}

async fn write_rebuild_batch(
    pool: &PgPool,
    schema: &str,
    catalog_revision: &str,
    rows: &[RebuildRow],
) -> Result<u64, Error> {
    let mut tx = pool.begin().await?;
    let ids = rows.iter().map(|row| row.id).collect::<Vec<_>>();
    sqlx::query(AssertSqlSafe(format!(
        "SELECT record_id FROM {schema}.records WHERE collection_id=$1 AND record_id=ANY($2) FOR NO KEY UPDATE"
    )))
    .bind(COLLECTION_ID)
    .bind(&ids)
    .fetch_all(&mut *tx)
    .await?;
    let mut upsert = QueryBuilder::<Postgres>::new(format!(
        "INSERT INTO {schema}.record_projections (collection_id,record_id,record_revision,catalog_revision,projection_format_version,generation_id,path,types,file_size,file_mtime,semantic_projection,projection_digest) SELECT "
    ));
    upsert.push_bind(COLLECTION_ID);
    upsert.push(",v.record_id,v.record_revision,v.catalog_revision,1,v.generation_id,v.path,v.types,v.file_size,v.file_mtime,v.semantic_projection,v.projection_digest FROM (");
    upsert.push_values(rows, |mut b, row| {
        b.push_bind(row.id)
            .push_bind(&row.revision)
            .push_bind(catalog_revision)
            .push_bind(REBUILD_GENERATION_ID)
            .push_bind(&row.path)
            .push_bind(&row.types)
            .push_bind(row.file_size)
            .push_bind(row.file_mtime)
            .push_bind(sqlx::types::Json(&row.semantic))
            .push_bind(&row.projection_digest);
    });
    upsert.push(format!(
        ") AS v(record_id,record_revision,catalog_revision,generation_id,path,types,file_size,file_mtime,semantic_projection,projection_digest) JOIN {schema}.records r ON r.collection_id="
    ));
    upsert.push_bind(COLLECTION_ID);
    upsert.push(" AND r.record_id=v.record_id AND r.record_revision=v.record_revision ON CONFLICT (collection_id,record_id) DO UPDATE SET record_revision=excluded.record_revision,catalog_revision=excluded.catalog_revision,projection_format_version=excluded.projection_format_version,generation_id=excluded.generation_id,path=excluded.path,types=excluded.types,file_size=excluded.file_size,file_mtime=excluded.file_mtime,semantic_projection=excluded.semantic_projection,projection_digest=excluded.projection_digest,updated_at=clock_timestamp()");
    let updated = upsert.build().execute(&mut *tx).await?.rows_affected();
    let checkpoint = rows.last().expect("non-empty rebuild batch").id;
    sqlx::query(AssertSqlSafe(format!(
        "UPDATE {schema}.projection_generations SET checkpoint_record_id=$3,lease_expires_at=clock_timestamp()+interval '30 seconds' WHERE collection_id=$1 AND generation_id=$2 AND status='building' AND lease_owner=$4"
    )))
    .bind(COLLECTION_ID)
    .bind(REBUILD_GENERATION_ID)
    .bind(checkpoint)
    .bind(REBUILD_LEASE_ID)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(updated)
}

#[derive(Deserialize)]
struct ExactEnvelope {
    path: String,
    file_mtime: String,
    document: String,
}

async fn query_workload(
    database_url: &str,
    candidate: Candidate,
    fixture_dir: &Path,
    workload_path: &Path,
    workload_id: &str,
    budget_path: &Path,
    large_fixture_entitlement: bool,
) -> Result<(), Error> {
    let pool = PgPool::connect(database_url).await?;
    let contract: WorkloadContract = serde_json::from_reader(File::open(workload_path)?)?;
    let workload = contract
        .query_workloads
        .iter()
        .find(|workload| workload.id == workload_id)
        .ok_or_else(|| Error::Invalid(format!("unknown workload: {workload_id}")))?;
    workload.candidate_ir.clone().compile()?;
    for scan in &workload.provider_scans {
        scan.candidate_ir.clone().compile()?;
    }
    let budget_manifest: BudgetManifest = serde_json::from_reader(File::open(budget_path)?)?;
    let mut scanned_records_limit = budget_manifest.defaults.scanned_records;
    let mut scanned_bytes_limit = budget_manifest.defaults.scanned_ciphertext_bytes;
    let mut snapshot_limit_ms = budget_manifest.defaults.snapshot_lifetime_ms;
    let mut deadline_ms = budget_manifest.defaults.operation_deadline_ms;
    if large_fixture_entitlement {
        let diagnostic = &budget_manifest.entitlements.large_fixture_v1;
        scanned_records_limit = diagnostic.scanned_records;
        scanned_bytes_limit = diagnostic.scanned_ciphertext_bytes;
        snapshot_limit_ms = diagnostic.snapshot_lifetime_ms;
        deadline_ms = diagnostic.operation_deadline_ms;
    }
    if workload.page.offset > budget_manifest.defaults.maximum_offset {
        return emit_preflight_budget(candidate, workload, "ordering");
    }
    let catalog = compile_fixture_catalog(&fixture_dir.join("resources.ndjson"))?;
    let schema = candidate.schema();
    let predicate = if candidate == Candidate::A {
        "TRUE".to_string()
    } else {
        compile_candidate_sql(&workload.candidate_ir, candidate)
            .unwrap_or_else(|| "TRUE".to_string())
    };
    let needs_body = expression_needs_body(&workload.candidate_ir)
        || workload
            .response_fields
            .iter()
            .any(|field| field == "body" || field == "document");
    let current = "p.record_revision=r.record_revision AND p.catalog_revision=c.active_catalog_revision AND p.projection_format_version=c.active_projection_format_version AND p.generation_id=c.active_generation_id AND g.status IN ('building','complete')";
    let sql = if candidate == Candidate::A {
        format!("SELECT record_id,record_revision,exact_ciphertext FROM {schema}.records WHERE collection_id=$1 ORDER BY record_id")
    } else if candidate.encrypted() {
        let exact = if needs_body {
            "r.exact_ciphertext".to_string()
        } else {
            format!("CASE WHEN NOT COALESCE({current},false) THEN r.exact_ciphertext END")
        };
        format!("SELECT r.record_id,r.record_revision,{exact} AS exact_ciphertext,COALESCE({current},false) AS projection_current,p.path,p.types,p.file_size,p.file_mtime,p.semantic_projection,p.projection_digest FROM {schema}.records r JOIN {schema}.collections c USING (collection_id) LEFT JOIN {schema}.record_projections p USING (collection_id,record_id) LEFT JOIN {schema}.projection_generations g ON g.collection_id=p.collection_id AND g.generation_id=p.generation_id WHERE r.collection_id=$1 AND ((COALESCE({current},false) AND ({predicate})) OR NOT COALESCE({current},false)) ORDER BY r.record_id")
    } else {
        let exact = if needs_body {
            "r.exact_markdown".to_string()
        } else {
            format!("CASE WHEN NOT COALESCE({current},false) THEN r.exact_markdown END")
        };
        format!("SELECT r.record_id,r.record_revision,{exact} AS exact_markdown,COALESCE({current},false) AS projection_current,p.path,p.types,p.file_size,p.file_mtime,p.semantic_projection,p.projection_digest FROM {schema}.records r JOIN {schema}.collections c USING (collection_id) LEFT JOIN {schema}.record_projections p USING (collection_id,record_id) LEFT JOIN {schema}.projection_generations g ON g.collection_id=p.collection_id AND g.generation_id=p.generation_id WHERE r.collection_id=$1 AND ((COALESCE({current},false) AND ({predicate})) OR NOT COALESCE({current},false)) ORDER BY r.record_id")
    };
    let started = Instant::now();
    let cancel_after = (workload.id == "sdk.cancel_broad_body_scan")
        .then_some(std::time::Duration::from_millis(50));
    let deadline = cancel_after.unwrap_or(std::time::Duration::from_millis(
        deadline_ms.min(snapshot_limit_ms),
    ));
    let mut transaction = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *transaction)
        .await?;
    let mut database_rows = sqlx::query(AssertSqlSafe(sql))
        .bind(COLLECTION_ID)
        .fetch(&mut *transaction);
    let mut sql_candidate_rows = 0_usize;
    let mut documents_decrypted = 0_usize;
    let mut ciphertext_bytes = 0_u64;
    let mut plaintext_bytes = 0_u64;
    let mut decrypted_bytes_peak = 0_u64;
    let mut canonical_facts = Vec::new();
    let mut terminal_budget = None;
    let mut cancelled = false;
    loop {
        let Some(remaining) = deadline.checked_sub(started.elapsed()) else {
            if cancel_after.is_some() {
                cancelled = true;
            } else {
                terminal_budget = Some("time");
            }
            break;
        };
        let row = match tokio::time::timeout(remaining, database_rows.try_next()).await {
            Ok(result) => result?,
            Err(_) if cancel_after.is_some() => {
                cancelled = true;
                break;
            }
            Err(_) => {
                terminal_budget = Some("time");
                break;
            }
        };
        let Some(row) = row else { break };
        sql_candidate_rows += 1;
        if sql_candidate_rows > scanned_records_limit {
            terminal_budget = Some("scan");
            break;
        }
        let id: Uuid = row.get("record_id");
        let revision: String = row.get("record_revision");
        let (record, body, projection) = if candidate == Candidate::A {
            let ciphertext: Vec<u8> = row.get("exact_ciphertext");
            ciphertext_bytes += ciphertext.len() as u64;
            let plaintext = decrypt_exact(id, &revision, &ciphertext)?;
            decrypted_bytes_peak = decrypted_bytes_peak.max(plaintext.len() as u64);
            plaintext_bytes += plaintext.len() as u64;
            let envelope: ExactEnvelope = serde_json::from_slice(&plaintext)?;
            documents_decrypted += 1;
            let canonical = CanonicalRecordInput {
                stable_id: Some(id.to_string()),
                path: envelope.path.clone(),
                file_size: envelope.document.len() as u64,
                file_mtime: Some(envelope.file_mtime.clone()),
                document: envelope.document.clone(),
            };
            let classified = catalog.classify_record(&canonical)?;
            let projection = catalog.benchmark_project_record(&canonical)?;
            (
                RecordLine {
                    record_id: id.to_string(),
                    path: envelope.path,
                    document: envelope.document,
                    file_mtime: envelope.file_mtime,
                },
                classified.body,
                projection,
            )
        } else {
            let projection_current: bool = row.get("projection_current");
            let current_projection = if projection_current {
                let semantic: sqlx::types::Json<Value> = row.get("semantic_projection");
                let projection = projection_from_row(&row, &semantic.0)?;
                let expected_digest = authority_projection_digest(
                    id,
                    &revision,
                    catalog.resource_revision(),
                    GENERATION_ID,
                    &projection,
                    &semantic.0,
                )?;
                let stored_digest: String = row.get("projection_digest");
                if stored_digest != expected_digest {
                    return Err(Error::Invalid(format!(
                        "projection digest verification failed for {id}"
                    )));
                }
                Some(projection)
            } else {
                None
            };
            let row_needs_body = if workload.provider_scans.is_empty() {
                needs_body
            } else {
                current_projection.as_ref().is_none_or(|projection| {
                    workload.provider_scans.iter().any(|scan| {
                        scan.include_body && scan.candidate_ir.evaluate_canonical(projection, "")
                    })
                })
            };
            let mut exact = None;
            if row_needs_body || !projection_current {
                if candidate.encrypted() {
                    let ciphertext: Vec<u8> = row.get("exact_ciphertext");
                    ciphertext_bytes += ciphertext.len() as u64;
                    let plaintext = decrypt_exact(id, &revision, &ciphertext)?;
                    decrypted_bytes_peak = decrypted_bytes_peak.max(plaintext.len() as u64);
                    plaintext_bytes += plaintext.len() as u64;
                    exact = Some(serde_json::from_slice::<ExactEnvelope>(&plaintext)?);
                    documents_decrypted += 1;
                } else {
                    let document: String = row.get("exact_markdown");
                    plaintext_bytes += document.len() as u64;
                    exact = Some(ExactEnvelope {
                        path: row.get("path"),
                        file_mtime: row
                            .get::<chrono::DateTime<chrono::Utc>, _>("file_mtime")
                            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                        document,
                    });
                }
            }
            let projection = if let Some(projection) = current_projection {
                projection
            } else {
                let envelope = exact.as_ref().ok_or_else(|| {
                    Error::Invalid("stale projection fallback has no exact record".to_string())
                })?;
                catalog.benchmark_project_record(&CanonicalRecordInput {
                    stable_id: Some(id.to_string()),
                    path: envelope.path.clone(),
                    document: envelope.document.clone(),
                    file_size: envelope.document.len() as u64,
                    file_mtime: Some(envelope.file_mtime.clone()),
                })?
            };
            let envelope = exact.unwrap_or_else(|| ExactEnvelope {
                path: projection.path.clone(),
                file_mtime: projection.file.mtime.clone(),
                document: String::new(),
            });
            let body = if envelope.document.is_empty() {
                String::new()
            } else {
                catalog
                    .classify_record(&CanonicalRecordInput {
                        stable_id: Some(id.to_string()),
                        path: envelope.path.clone(),
                        document: envelope.document.clone(),
                        file_size: envelope.document.len() as u64,
                        file_mtime: Some(envelope.file_mtime.clone()),
                    })?
                    .body
            };
            (
                RecordLine {
                    record_id: id.to_string(),
                    path: envelope.path,
                    document: envelope.document,
                    file_mtime: envelope.file_mtime,
                },
                body,
                projection,
            )
        };
        if workload.candidate_ir.evaluate_canonical(&projection, &body) {
            canonical_facts.push(result_fact(
                workload,
                &record,
                &revision,
                &body,
                &projection,
            )?);
        }
        if ciphertext_bytes > scanned_bytes_limit || plaintext_bytes > scanned_bytes_limit {
            terminal_budget = Some("scan");
            break;
        }
        if decrypted_bytes_peak > budget_manifest.defaults.simultaneously_decrypted_bytes {
            terminal_budget = Some("scan");
            break;
        }
    }
    drop(database_rows);
    let snapshot_lifetime_ms = started.elapsed().as_secs_f64() * 1000.0;
    if cancelled || terminal_budget.is_some() {
        let cleanup_started = Instant::now();
        transaction.rollback().await?;
        pool.close().await;
        let cleanup_ms = cleanup_started.elapsed().as_secs_f64() * 1000.0;
        if cancelled {
            println!(
                "{}",
                json!({
                    "candidate":format!("{candidate:?}"),"workload_id":workload_id,
                    "outcome":"cancelled","elapsed_ms":started.elapsed().as_secs_f64()*1000.0,
                    "sql_candidate_rows":sql_candidate_rows,"canonical_rows_evaluated":sql_candidate_rows,
                    "documents_decrypted":documents_decrypted,"ciphertext_bytes":ciphertext_bytes,
                    "plaintext_bytes":plaintext_bytes,"cancellation_cleanup_ms":cleanup_ms,
                    "transaction_released":true,"pool_permit_released":true,"plaintext_released":true,
                    "snapshot_lifetime_ms":snapshot_lifetime_ms
                })
            );
            return Ok(());
        }
        let kind = terminal_budget.expect("checked above");
        println!(
            "{}",
            json!({
                "candidate":format!("{candidate:?}"),"workload_id":workload_id,
                "outcome":"budget","budget_kind":kind,
                "budget_accepted":workload.acceptable_budget_kinds.iter().any(|allowed| allowed == kind),
                "elapsed_ms":started.elapsed().as_secs_f64()*1000.0,
                "sql_candidate_rows":sql_candidate_rows,"canonical_rows_evaluated":sql_candidate_rows,
                "documents_decrypted":documents_decrypted,"ciphertext_bytes":ciphertext_bytes,
                "plaintext_bytes":plaintext_bytes,"snapshot_lifetime_ms":snapshot_lifetime_ms,
                "transaction_released":true,"pool_permit_released":true,"plaintext_released":true
            })
        );
        return Ok(());
    }
    transaction.commit().await?;
    let mut provider = HashMap::new();
    for scan in &workload.provider_scans {
        provider.insert(
            format!("{}:{}", workload.id, scan.id),
            canonical_facts
                .iter()
                .filter(|fact| match scan.id.as_str() {
                    "requests" => is_pickle_request(fact),
                    "responses" => !is_pickle_request(fact),
                    _ => true,
                })
                .cloned()
                .collect(),
        );
    }
    let canonical_fact_count = canonical_facts.len();
    let actual = expected_workload(workload, canonical_facts, &mut provider)?;
    let result_items = actual["returned"]
        .as_u64()
        .unwrap_or_else(|| actual["consumerResultCount"].as_u64().unwrap_or(0));
    let result_bytes = serde_json::to_vec(&actual)?.len() as u64;
    let group_count = actual["groups"].as_array().map_or(0, Vec::len);
    let group_bytes = actual["groups"]
        .as_array()
        .map(serde_json::to_vec)
        .transpose()?
        .map_or(0, |bytes| bytes.len() as u64);
    let budget_kind = if group_count > budget_manifest.defaults.groups
        || group_bytes > budget_manifest.defaults.aggregation_state_bytes
    {
        Some("groups")
    } else if result_items > budget_manifest.defaults.result_items
        || result_bytes > budget_manifest.defaults.result_bytes
    {
        Some("result")
    } else if canonical_fact_count > budget_manifest.defaults.top_k_entries
        && !workload.order.is_empty()
    {
        Some("ordering")
    } else {
        None
    };
    if let Some(budget_kind) = budget_kind {
        println!(
            "{}",
            json!({
                "candidate":format!("{candidate:?}"),"workload_id":workload_id,
                "outcome":"budget","budget_kind":budget_kind,
                "budget_accepted":workload.acceptable_budget_kinds.iter().any(|allowed| allowed == budget_kind),
                "elapsed_ms":started.elapsed().as_secs_f64()*1000.0,
                "sql_candidate_rows":sql_candidate_rows,"canonical_rows_evaluated":sql_candidate_rows,
                "documents_decrypted":documents_decrypted,"ciphertext_bytes":ciphertext_bytes,
                "plaintext_bytes":plaintext_bytes,"result_items":result_items,"result_bytes":result_bytes,
                "snapshot_lifetime_ms":snapshot_lifetime_ms,"transaction_released":true,
                "pool_permit_released":true,"plaintext_released":true
            })
        );
        return Ok(());
    }
    let expected: Value =
        serde_json::from_reader(File::open(fixture_dir.join("expected-results.json"))?)?;
    let expected_workload = &expected["workloads"][workload_id];
    if &actual != expected_workload {
        return Err(Error::SeedMismatch(first_json_difference(
            "$",
            expected_workload,
            &actual,
        )));
    }
    println!(
        "{}",
        json!({
            "candidate":format!("{candidate:?}"),"workload_id":workload_id,"outcome":"success",
            "elapsed_ms":started.elapsed().as_secs_f64()*1000.0,"sql_candidate_rows":sql_candidate_rows,
            "canonical_rows_evaluated":sql_candidate_rows,"documents_decrypted":documents_decrypted,
            "ciphertext_bytes":ciphertext_bytes,"plaintext_bytes":plaintext_bytes,
            "result_items":result_items,"result_bytes":result_bytes,"completeness_digest":actual["orderedRecordIdsDigest"].clone(),
            "accounted_operator_bytes_peak":decrypted_bytes_peak.max(group_bytes),
            "snapshot_lifetime_ms":snapshot_lifetime_ms,"transaction_released":true,
            "pool_permit_released":true,"plaintext_released":true,
            "key_cache_misses":if candidate.encrypted() && documents_decrypted > 0 {1} else {0},
            "key_cache_hits":if candidate.encrypted() {documents_decrypted.saturating_sub(1)} else {0},
            "kms_unwraps":if candidate.encrypted() && documents_decrypted > 0 {1} else {0}
        })
    );
    Ok(())
}

fn emit_preflight_budget(
    candidate: Candidate,
    workload: &Workload,
    budget_kind: &str,
) -> Result<(), Error> {
    println!(
        "{}",
        json!({
            "candidate":format!("{candidate:?}"),"workload_id":workload.id,
            "outcome":"budget","budget_kind":budget_kind,
            "budget_accepted":workload.acceptable_budget_kinds.iter().any(|allowed| allowed == budget_kind),
            "elapsed_ms":0.0,"transaction_released":true,"pool_permit_released":true,
            "plaintext_released":true
        })
    );
    Ok(())
}

fn projection_from_row(
    row: &sqlx::postgres::PgRow,
    semantic: &Value,
) -> Result<BenchmarkProjection, Error> {
    let path: String = row.get("path");
    let name = path.rsplit('/').next().unwrap_or(&path).to_string();
    let (basename, extension) = name
        .rsplit_once('.')
        .map(|(a, b)| (a.to_string(), b.to_string()))
        .unwrap_or((name.clone(), String::new()));
    Ok(BenchmarkProjection {
        schema_version: "hosted-benchmark-projection-v1".to_string(),
        path: path.clone(),
        types: row.get("types"),
        file: BenchmarkFileFacts {
            path,
            name,
            basename,
            extension,
            size: row.get::<i64, _>("file_size") as u64,
            mtime: row
                .get::<chrono::DateTime<chrono::Utc>, _>("file_mtime")
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        },
        persisted_frontmatter: value_map(semantic, "persisted_frontmatter")?,
        effective_frontmatter: value_map(semantic, "effective_frontmatter")?,
        relationships: serde_json::from_value(semantic["relationships"].clone())?,
        diagnostics: serde_json::from_value::<Vec<BenchmarkDiagnostic>>(
            semantic["diagnostics"].clone(),
        )?,
    })
}

fn value_map(value: &Value, key: &str) -> Result<serde_json::Map<String, Value>, Error> {
    value
        .get(key)
        .and_then(Value::as_object)
        .cloned()
        .ok_or_else(|| Error::Invalid(format!("projection has no {key} object")))
}

fn exact_aad(id: Uuid, revision: &str) -> Vec<u8> {
    format!("mdbase-hosted-benchmark-v1:{COLLECTION_ID}:{id}:{revision}").into_bytes()
}

fn decrypt_exact(id: Uuid, revision: &str, ciphertext: &[u8]) -> Result<Vec<u8>, Error> {
    if ciphertext.len() < 12 {
        return Err(Error::Invalid("short benchmark ciphertext".to_string()));
    }
    let cipher = Aes256Gcm::new_from_slice(&DATA_KEY)
        .map_err(|_| Error::Invalid("invalid benchmark key".to_string()))?;
    let nonce = Nonce::try_from(&ciphertext[..12])
        .map_err(|_| Error::Invalid("invalid benchmark nonce".to_string()))?;
    cipher
        .decrypt(
            &nonce,
            Payload {
                msg: &ciphertext[12..],
                aad: &exact_aad(id, revision),
            },
        )
        .map_err(|_| Error::Invalid("benchmark decryption failed".to_string()))
}

fn expression_needs_body(expression: &CandidateExpression) -> bool {
    match expression {
        CandidateExpression::BodyContains { .. } => true,
        CandidateExpression::All { all } | CandidateExpression::Any { any: all } => {
            all.iter().any(expression_needs_body)
        }
        CandidateExpression::Not { not } => expression_needs_body(not),
        _ => false,
    }
}

struct SqlCandidate {
    sql: String,
    exact: bool,
}

fn compile_candidate_sql(expression: &CandidateExpression, candidate: Candidate) -> Option<String> {
    compile_sql(expression, candidate).map(|value| value.sql)
}

fn compile_sql(expression: &CandidateExpression, candidate: Candidate) -> Option<SqlCandidate> {
    match expression {
        CandidateExpression::All { all } => {
            let values = all
                .iter()
                .filter_map(|item| compile_sql(item, candidate))
                .collect::<Vec<_>>();
            Some(SqlCandidate {
                sql: if values.is_empty() {
                    "TRUE".to_string()
                } else {
                    format!(
                        "({})",
                        values
                            .iter()
                            .map(|v| v.sql.as_str())
                            .collect::<Vec<_>>()
                            .join(" AND ")
                    )
                },
                exact: values.len() == all.len() && values.iter().all(|v| v.exact),
            })
        }
        CandidateExpression::Any { any } => {
            let values = any
                .iter()
                .map(|item| compile_sql(item, candidate))
                .collect::<Vec<_>>();
            if values.iter().any(Option::is_none) {
                None
            } else {
                let values = values.into_iter().flatten().collect::<Vec<_>>();
                Some(SqlCandidate {
                    sql: format!(
                        "({})",
                        values
                            .iter()
                            .map(|v| v.sql.as_str())
                            .collect::<Vec<_>>()
                            .join(" OR ")
                    ),
                    exact: values.iter().all(|v| v.exact),
                })
            }
        }
        CandidateExpression::Not { not } => compile_sql(not, candidate).and_then(|value| {
            value.exact.then(|| SqlCandidate {
                sql: format!("NOT ({})", value.sql),
                exact: true,
            })
        }),
        CandidateExpression::TypeIn { type_in } => Some(SqlCandidate {
            sql: format!(
                "p.types && ARRAY[{}]::text[]",
                type_in
                    .iter()
                    .map(|v| quote(v))
                    .collect::<Vec<_>>()
                    .join(",")
            ),
            exact: true,
        }),
        CandidateExpression::FieldEq { field_eq } => json_compare(&field_eq.0, &field_eq.1, "="),
        CandidateExpression::FieldIn { field_in } => Some(SqlCandidate {
            sql: format!(
                "({})",
                field_in
                    .1
                    .iter()
                    .filter_map(|v| json_compare(&field_in.0, v, "="))
                    .map(|v| v.sql)
                    .collect::<Vec<_>>()
                    .join(" OR ")
            ),
            exact: true,
        }),
        CandidateExpression::FieldContains { field_contains } => {
            json_contains(&field_contains.0, &field_contains.1)
        }
        CandidateExpression::FieldContainsText {
            field_contains_text,
        } => field_text_sql(&field_contains_text.0).map(|field| SqlCandidate {
            sql: format!(
                "lower({field}) LIKE {} ESCAPE E'\\\\'",
                quote(&format!(
                    "%{}%",
                    escape_like(&field_contains_text.1.to_lowercase())
                ))
            ),
            exact: true,
        }),
        CandidateExpression::FieldLt { field_lt } => json_compare(&field_lt.0, &field_lt.1, "<"),
        CandidateExpression::RelationshipTargetEq {
            relationship_target_eq,
        } => Some(SqlCandidate {
            sql: format!(
                "p.semantic_projection @> {}::jsonb",
                quote(&json!({"relationships":[{"target":relationship_target_eq}]}).to_string())
            ),
            exact: true,
        }),
        CandidateExpression::BodyContains { body_contains } if !candidate.encrypted() => {
            Some(SqlCandidate {
                sql: format!(
                    "r.exact_markdown ILIKE {} ESCAPE E'\\\\'",
                    quote(&format!("%{}%", escape_like(body_contains)))
                ),
                exact: true,
            })
        }
        CandidateExpression::BodyContains { .. } => None,
    }
}

fn field_text_sql(path: &str) -> Option<String> {
    if path == "path" {
        Some("p.path".to_string())
    } else if path == "file.basename" {
        Some("regexp_replace(regexp_replace(p.path, '^.*/', ''), '\\.[^.]+$', '')".to_string())
    } else if path == "file.mtime" {
        Some("p.file_mtime::text".to_string())
    } else {
        let parts = path.split('.').collect::<Vec<_>>();
        matches!(
            parts.first(),
            Some(&"persisted_frontmatter") | Some(&"effective_frontmatter")
        )
        .then(|| format!("p.semantic_projection #>> '{{{}}}'", parts.join(",")))
    }
}

fn json_compare(path: &str, value: &Value, operator: &str) -> Option<SqlCandidate> {
    let field = field_text_sql(path)?;
    let sql = match value {
        Value::Number(number) => format!("({field})::numeric {operator} {number}"),
        Value::Bool(boolean) => format!("({field})::boolean {operator} {boolean}"),
        Value::String(string) => format!("{field} {operator} {}", quote(string)),
        _ => return None,
    };
    Some(SqlCandidate { sql, exact: true })
}
fn json_contains(path: &str, value: &Value) -> Option<SqlCandidate> {
    let parts = path.split('.').collect::<Vec<_>>();
    if !matches!(
        parts.first(),
        Some(&"persisted_frontmatter") | Some(&"effective_frontmatter")
    ) {
        return None;
    }
    let mut nested = json!([value]);
    for key in parts.iter().skip(1).rev() {
        nested = json!({*key:nested});
    }
    nested = json!({parts[0]:nested});
    Some(SqlCandidate {
        sql: format!(
            "p.semantic_projection @> {}::jsonb",
            quote(&nested.to_string())
        ),
        exact: true,
    })
}
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

async fn storage_metrics(database_url: &str, candidate: Candidate) -> Result<(), Error> {
    let pool = PgPool::connect(database_url).await?;
    let rows = sqlx::query("SELECT c.relname,pg_relation_size(c.oid)::bigint AS table_bytes,CASE WHEN c.reltoastrelid=0 THEN 0 ELSE pg_total_relation_size(c.reltoastrelid) END::bigint AS toast_bytes,pg_indexes_size(c.oid)::bigint AS index_bytes,pg_total_relation_size(c.oid)::bigint AS total_bytes FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='r' ORDER BY c.relname")
        .bind(candidate.schema()).fetch_all(&pool).await?;
    let relations = rows.iter().map(|row| json!({"relation":row.get::<String,_>("relname"),"table_bytes":row.get::<i64,_>("table_bytes"),"toast_bytes":row.get::<i64,_>("toast_bytes"),"index_bytes":row.get::<i64,_>("index_bytes"),"total_bytes":row.get::<i64,_>("total_bytes")})).collect::<Vec<_>>();
    println!(
        "{}",
        serde_json::to_string_pretty(
            &json!({"candidate":format!("{candidate:?}"),"database_bytes":sqlx::query_scalar::<_,i64>("SELECT pg_database_size(current_database())::bigint").fetch_one(&pool).await?,"relations":relations})
        )?
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_encryption_binds_identity_revision_and_plaintext_nonce() {
        let id = Uuid::from_u128(7);
        let first = encrypt_exact(id, "sha256:r1", b"first").unwrap();
        let second = encrypt_exact(id, "sha256:r1", b"second").unwrap();
        assert_ne!(&first[..12], &second[..12]);
        assert_eq!(decrypt_exact(id, "sha256:r1", &first).unwrap(), b"first");
        assert!(decrypt_exact(Uuid::from_u128(8), "sha256:r1", &first).is_err());
        assert!(decrypt_exact(id, "sha256:r2", &first).is_err());
    }

    #[test]
    fn sql_like_literals_cannot_become_wildcards() {
        assert_eq!(escape_like(r"10%_done\now"), r"10\%\_done\\now");
        let expression: CandidateExpression = serde_json::from_value(json!({
            "bodyContains": "%_"
        }))
        .unwrap();
        let sql = compile_candidate_sql(&expression, Candidate::CNoGin).unwrap();
        assert!(sql.contains(r"%\%\_%"));
        assert!(sql.contains("ESCAPE"));
    }

    #[test]
    fn typed_json_comparisons_do_not_use_lexicographic_number_order() {
        let number = json_compare("effective_frontmatter.priority", &json!(10), "<").unwrap();
        let boolean = json_compare("effective_frontmatter.archived", &json!(false), "=").unwrap();
        assert!(number.sql.contains("::numeric"));
        assert!(boolean.sql.contains("::boolean"));
    }

    #[test]
    fn frozen_budget_manifest_deserializes_without_raising_defaults() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../config/hosted-execution-budgets.json");
        let manifest: BudgetManifest = serde_json::from_reader(File::open(path).unwrap()).unwrap();
        assert_eq!(manifest.defaults.scanned_records, 100_000);
        assert_eq!(manifest.defaults.operation_deadline_ms, 30_000);
        assert_eq!(manifest.defaults.result_items, 10_000);
        assert_eq!(manifest.defaults.simultaneously_decrypted_bytes, 8_388_608);
    }

    #[test]
    fn projection_digest_rejects_record_and_generation_substitution() {
        let projection = BenchmarkProjection {
            schema_version: "hosted-benchmark-projection-v1".to_string(),
            path: "notes/one.md".to_string(),
            types: vec!["note".to_string()],
            file: BenchmarkFileFacts {
                path: "notes/one.md".to_string(),
                name: "one.md".to_string(),
                basename: "one".to_string(),
                extension: "md".to_string(),
                size: 4,
                mtime: "2026-01-01T00:00:00.000Z".to_string(),
            },
            persisted_frontmatter: Default::default(),
            effective_frontmatter: Default::default(),
            relationships: vec![],
            diagnostics: vec![],
        };
        let semantic = semantic_projection(&projection);
        let first = authority_projection_digest(
            Uuid::from_u128(1),
            "sha256:r1",
            "sha256:c1",
            Uuid::from_u128(2),
            &projection,
            &semantic,
        )
        .unwrap();
        let substituted = authority_projection_digest(
            Uuid::from_u128(3),
            "sha256:r1",
            "sha256:c1",
            Uuid::from_u128(4),
            &projection,
            &semantic,
        )
        .unwrap();
        assert_ne!(first, substituted);
    }
}
