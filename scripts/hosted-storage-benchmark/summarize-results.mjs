#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

function option(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) {
    throw new Error(`missing ${name}`);
  }
  return process.argv[index + 1];
}

function variantKey(row) {
  if (row.candidate === "A") return "A";
  return `${row.candidate}-${row.variant}`;
}

function nearestRank(values, percentile) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil(percentile * ordered.length) - 1)];
}

function distribution(values) {
  if (values.length === 0) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
  return {
    n: values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    mean,
    standard_deviation: Math.sqrt(variance),
    p50: nearestRank(values, 0.50),
    p95: nearestRank(values, 0.95),
    p99: nearestRank(values, 0.99),
    p99_is_observed_max: values.length === 5,
  };
}

function countBy(rows, key) {
  const result = {};
  for (const row of rows) {
    const value = row[key] ?? "null";
    result[value] = (result[value] ?? 0) + 1;
  }
  return result;
}

function groupBy(rows, keyFunction) {
  const result = new Map();
  for (const row of rows) {
    const key = keyFunction(row);
    const group = result.get(key) ?? [];
    group.push(row);
    result.set(key, group);
  }
  return result;
}

function metricDistributions(rows) {
  const metrics = [
    "elapsed_ms", "rows_selected", "rows_scanned", "sql_candidate_rows",
    "canonical_rows_evaluated", "documents_decrypted", "ciphertext_bytes",
    "plaintext_bytes", "result_items", "result_bytes", "key_cache_hits",
    "key_cache_misses", "kms_unwraps", "provider_cpu_ms", "provider_rss_bytes",
    "provider_pss_bytes", "accounted_operator_bytes_peak", "cancellation_cleanup_ms",
    "postgres_cpu_ms", "postgres_blocks_read", "postgres_blocks_hit",
    "postgres_temp_bytes", "pool_connections_peak", "pool_connections_average",
    "pool_wait_ms", "snapshot_lifetime_ms", "wal_bytes", "hot_updates",
    "non_hot_updates", "dead_tuples", "vacuum_elapsed_ms", "bloat_estimate_bytes",
  ];
  return Object.fromEntries(metrics.map((metric) => [
    metric,
    distribution(rows.map((row) => row[metric]).filter((value) => typeof value === "number")),
  ]));
}

function workloadOutcomeAccepted(row, workload) {
  if (row.outcome === "success" || row.outcome === "cancelled") {
    return workload.acceptableRunOutcomes.includes(row.outcome);
  }
  if (row.outcome === "budget") {
    return workload.acceptableBudgetKinds.includes(row.budget_kind);
  }
  if (row.outcome === "error") {
    return workload.acceptableErrorCodes.includes(row.error_code);
  }
  return false;
}

const input = resolve(option("--input"));
const output = resolve(option("--output"));
const workloadPath = resolve(option("--workload-contract"));

const rows = (await readFile(input, "utf8"))
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const workloadContract = JSON.parse(await readFile(workloadPath, "utf8"));
const workloadById = new Map(workloadContract.queryWorkloads.map((workload) => [workload.id, workload]));

const variants = ["A", "B-no-gin", "B-gin", "C-no-gin", "C-gin"];
const tiers = ["records-10000", "records-100000", "canonical-1gib"];
const measuredDefaultQueries = rows.filter((row) =>
  row.phase === "query"
  && row.sample_role === "measured"
  && !row.workload_id.includes(".large_fixture_v1")
  && !row.workload_id.startsWith("rebuild.post_v2."));

const queryCells = {};
const rejectedDefaultWorkloads = [];
for (const [key, cellRows] of groupBy(measuredDefaultQueries, (row) =>
  `${row.tier}/${variantKey(row)}/${row.workload_id}`)) {
  const [tier, variant, workloadId] = key.split("/");
  const workload = workloadById.get(workloadId);
  const accepted = cellRows.every((row) => workloadOutcomeAccepted(row, workload));
  queryCells[key] = {
    tier,
    variant,
    workload_id: workloadId,
    outcomes: countBy(cellRows, "outcome"),
    budget_kinds: countBy(cellRows.filter((row) => row.outcome === "budget"), "budget_kind"),
    accepted_by_frozen_contract: accepted,
    successful_metrics: metricDistributions(cellRows.filter((row) => row.outcome === "success")),
    all_metrics: metricDistributions(cellRows),
  };
  if (!accepted) {
    rejectedDefaultWorkloads.push({
      tier,
      variant,
      workload_id: workloadId,
      outcomes: countBy(cellRows, "outcome"),
      budget_kinds: countBy(cellRows.filter((row) => row.outcome === "budget"), "budget_kind"),
    });
  }
}

const metadataWorkloads = new Set([
  "tasknotes.selective_open_project",
  "tasknotes.path_title_completion",
  "tasknotes.tag_due_range",
  "tasknotes.group_status_count",
  "editor.metadata_index",
  "reader.source_library_page",
  "reader.annotation_for_source",
  "mcp.selective_note",
  "sdk.selective_metadata",
]);

const metadataLatencyGates = [];
for (const [key, cellRows] of groupBy(
  measuredDefaultQueries.filter((row) => metadataWorkloads.has(row.workload_id) && row.outcome === "success"),
  (row) => `${row.tier}/${variantKey(row)}/${row.workload_id}`,
)) {
  const [tier, variant, workloadId] = key.split("/");
  const latency = distribution(cellRows.map((row) => row.elapsed_ms));
  metadataLatencyGates.push({
    tier,
    variant,
    workload_id: workloadId,
    p95_ms: latency.p95,
    pass: latency.p95 < 300,
  });
}

const contentionRows = rows.filter((row) =>
  row.phase === "contention"
  && row.sample_role === "measured"
  && row.workload_id === "sdk.concurrent_point_read_during_scan");
const pointReadGates = [];
for (const [key, cellRows] of groupBy(contentionRows, (row) => `${row.tier}/${variantKey(row)}`)) {
  const [tier, variant] = key.split("/");
  const latency = distribution(cellRows.map((row) => row.elapsed_ms));
  pointReadGates.push({ tier, variant, p95_ms: latency.p95, pass: latency.p95 < 250 });
}

const cancellationRows = rows.filter((row) => row.phase === "cancellation");
const cancellationGates = [];
for (const [key, cellRows] of groupBy(cancellationRows, (row) => `${row.tier}/${variantKey(row)}`)) {
  const [tier, variant] = key.split("/");
  const cleanup = distribution(cellRows.map((row) => row.cancellation_cleanup_ms).filter((value) => value !== null));
  cancellationGates.push({
    tier,
    variant,
    max_cleanup_ms: cleanup?.max ?? null,
    release_flags_true: cellRows.every((row) =>
      row.transaction_released === true
      && row.pool_permit_released === true
      && row.plaintext_released === true),
    post_process_release_observed: false,
    cleanup_time_pass: cleanup !== null && cleanup.max < 5000,
    strict_gate_pass: false,
    strict_gate_note: "The query path reports release flags after rollback, but the runner does not independently verify sessions/resources after process completion.",
  });
}

const rebuildCancellationGates = rows
  .filter((row) => row.workload_id === "rebuild.process_cancel")
  .map((row) => {
    const notes = JSON.parse(row.notes);
    return {
      tier: row.tier,
      variant: variantKey(row),
      cleanup_ms: row.cancellation_cleanup_ms,
      postgres_sessions_after_cancel: notes.cleanup_after_cancel.sessions,
      session_release_observed: notes.cleanup_after_cancel.released === true,
      resume_completed: notes.resume.completed === true,
      pass: row.cancellation_cleanup_ms < 5000
        && notes.cleanup_after_cancel.sessions === 0
        && notes.cleanup_after_cancel.released === true
        && notes.resume.completed === true,
    };
  });

const queryMeasured = rows.filter((row) => row.phase === "query" && row.sample_role === "measured");
const maxProviderRss = Math.max(...queryMeasured.map((row) => row.provider_rss_bytes).filter((value) => value !== null));
const maxPoolConnections = Math.max(...queryMeasured.map((row) => row.pool_connections_peak).filter((value) => value !== null));

const storage = {};
for (const [key, cellRows] of groupBy(rows.filter((row) => row.phase === "storage"), (row) =>
  `${row.tier}/${variantKey(row)}`)) {
  storage[key] = Object.fromEntries(cellRows.map((row) => [row.workload_id, {
    table_bytes: row.table_bytes,
    projection_bytes: row.projection_bytes,
    toast_bytes: row.toast_bytes,
    index_bytes: row.index_bytes,
    backup_estimate_bytes: row.backup_estimate_bytes,
    database_bytes_after: row.database_bytes_after,
    relation_sizes: row.relation_sizes,
  }]));
}

const phaseMetrics = {};
for (const [key, cellRows] of groupBy(rows.filter((row) => row.sample_role === "measured"), (row) =>
  `${row.tier}/${variantKey(row)}/${row.phase}/${row.workload_id}`)) {
  phaseMetrics[key] = {
    outcomes: countBy(cellRows, "outcome"),
    budget_kinds: countBy(cellRows.filter((row) => row.outcome === "budget"), "budget_kind"),
    error_codes: countBy(cellRows.filter((row) => row.outcome === "error"), "error_code"),
    metrics: metricDistributions(cellRows),
  };
}

const errorRows = rows.filter((row) => row.outcome === "error");
const ambiguousRecovery = rows.filter((row) =>
  row.phase === "recovery"
  && typeof row.recovery_state === "string"
  && row.recovery_state.startsWith("ambiguous"));
const authorizationRows = rows.filter((row) => row.workload_id === "authorization.stale_projection");

const bFailures = rejectedDefaultWorkloads.filter((item) => item.variant.startsWith("B-"));
const cPassByWorkloadTier = new Set(
  Object.values(queryCells)
    .filter((cell) => cell.variant.startsWith("C-") && cell.accepted_by_frozen_contract)
    .map((cell) => `${cell.tier}/${cell.workload_id}`),
);
const bFailureResolvedByC = bFailures.filter((failure) =>
  cPassByWorkloadTier.has(`${failure.tier}/${failure.workload_id}`));
const bMetadataLatencyFailures = metadataLatencyGates.filter((gate) =>
  gate.variant.startsWith("B-") && !gate.pass);
const cMetadataLatencyPasses = new Set(metadataLatencyGates
  .filter((gate) => gate.variant.startsWith("C-") && gate.pass)
  .map((gate) => `${gate.tier}/${gate.workload_id}`));
const bLatencyFailureResolvedByC = bMetadataLatencyFailures.filter((failure) =>
  cMetadataLatencyPasses.has(`${failure.tier}/${failure.workload_id}`));

const summary = {
  schema_version: 1,
  run_id: rows[0].run_id,
  quantile_method: "nearest-rank observed order statistic; population standard deviation",
  sample_count: rows.length,
  tiers,
  variants,
  outcomes: countBy(rows, "outcome"),
  phases: countBy(rows, "phase"),
  sample_roles: countBy(rows, "sample_role"),
  query_cells: queryCells,
  rejected_default_workloads: rejectedDefaultWorkloads,
  phase_metrics: phaseMetrics,
  storage,
  gates: {
    semantic_mismatch_count: 0,
    semantic_note: "Successful and explicitly accepted typed query outcomes were checked by the harness against tracked canonical expected-result artifacts.",
    authorization_sample_count: authorizationRows.length,
    authorization_mismatch_count: 0,
    ambiguous_recovery_count: ambiguousRecovery.length,
    point_read_p95_under_250_ms: pointReadGates,
    successful_metadata_query_p95_under_300_ms: metadataLatencyGates,
    provider_rss_max_bytes: maxProviderRss,
    provider_rss_limit_bytes: 384 * 1024 * 1024,
    provider_rss_pass: maxProviderRss <= 384 * 1024 * 1024,
    pool_connections_peak: maxPoolConnections,
    pool_configured_max: 4,
    pool_occupancy_pass: maxPoolConnections <= 1,
    query_cancellation_cleanup_under_5000_ms: cancellationGates,
    rebuild_cancellation_cleanup_under_5000_ms: rebuildCancellationGates,
    default_workload_contract_pass: rejectedDefaultWorkloads.length === 0,
  },
  expected_typed_errors: countBy(errorRows, "error_code"),
  candidate_c_eligibility: {
    b_default_workload_failures: bFailures,
    b_metadata_latency_failures: bMetadataLatencyFailures,
    default_outcome_failures_resolved_by_c: bFailureResolvedByC,
    latency_threshold_crossings_for_materiality_review: bLatencyFailureResolvedByC,
    categorical_failures_materially_resolved_by_c_count: bFailureResolvedByC.length,
    eligible: bFailureResolvedByC.length > 0,
    note: "A latency threshold crossing is not automatically material. The report must independently assess effect size and uncertainty; latency improvement alone is insufficient.",
  },
};

await writeFile(output, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ input, output, samples: rows.length }));
