#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const benchmarkRoot = join(root, "docs/benchmarks/hosted-storage-model");
const args = parseArgs(process.argv.slice(2));
const container = args.container ?? "mdbase-benchmark-pg";
const port = args.port ?? "55440";
const runId = args.runId ?? `local-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const output = resolve(args.output ?? join(benchmarkRoot, "results", runId));
const rawPath = join(output, "raw", "samples.ndjson");
const commandLog = join(output, "commands.log");
const quick = Boolean(args.quick);
const resume = Boolean(args.resume);
const requestedTiers = String(args.tiers ?? (quick ? "records-10000" : "records-10000,records-100000,canonical-1gib")).split(",");
const requestedVariants = String(args.variants ?? (quick ? "a,b-no-gin,c-no-gin" : "a,b-no-gin,b-gin,c-no-gin,c-gin")).split(",");
const binary = join(root, "target/release/hosted-storage-benchmark");
const workloadPath = join(benchmarkRoot, "workload-contract.json");
const fixtureContractPath = join(benchmarkRoot, "fixture-contract.json");
const budgetPath = join(root, "config/hosted-execution-budgets.json");
const rawSchemaPath = join(benchmarkRoot, "raw-result.schema.json");
const schemas = join(benchmarkRoot, "schemas");
const rebuildGenerationId = "018f0000-0000-7000-8000-000000000003";
const optionalFields = [
  "rows_selected", "rows_scanned", "sql_candidate_rows", "canonical_rows_evaluated", "documents_decrypted", "ciphertext_bytes", "plaintext_bytes", "result_items", "result_bytes", "completeness_digest", "key_cache_hits", "key_cache_misses", "kms_unwraps", "provider_cpu_ms", "provider_rss_bytes", "provider_pss_bytes", "accounted_operator_bytes_peak", "cancellation_cleanup_ms", "postgres_cpu_ms", "postgres_blocks_read", "postgres_blocks_hit", "postgres_temp_bytes", "pool_connections_peak", "pool_connections_average", "pool_wait_ms", "snapshot_lifetime_ms", "table_bytes", "projection_bytes", "toast_bytes", "index_bytes", "wal_bytes", "backup_estimate_bytes", "hot_updates", "non_hot_updates", "dead_tuples", "vacuum_elapsed_ms", "bloat_estimate_bytes", "failure_stage", "checkpoint_record_id", "lease_state", "recovery_state", "authorization_classification", "transaction_released", "pool_permit_released", "plaintext_released", "page_boundaries", "relation_sizes", "database_bytes_before", "database_bytes_after", "notes",
];

const variants = {
  a: { cli: "a", candidate: "A", variant: "encrypted-scan", schema: "candidate_a", schemaFile: "candidate-a.sql" },
  "b-no-gin": { cli: "b-no-gin", candidate: "B", variant: "no-gin", schema: "candidate_b_no_gin", schemaFile: "candidate-b-no-gin.sql" },
  "b-gin": { cli: "b-gin", candidate: "B", variant: "gin", schema: "candidate_b_gin", schemaFile: "candidate-b-gin.sql" },
  "c-no-gin": { cli: "c-no-gin", candidate: "C", variant: "no-gin", schema: "candidate_c_no_gin", schemaFile: "candidate-c-no-gin.sql" },
  "c-gin": { cli: "c-gin", candidate: "C", variant: "gin", schema: "candidate_c_gin", schemaFile: "candidate-c-gin.sql" },
};

for (const tier of requestedTiers) {
  if (!existsSync(join(benchmarkRoot, "fixtures", tier, "records.ndjson"))) {
    throw new Error(`missing generated fixture for ${tier}`);
  }
}
for (const key of requestedVariants) {
  if (!variants[key]) throw new Error(`unknown variant ${key}`);
}

mkdirSync(join(output, "raw"), { recursive: true });
if (!resume) {
  writeFileSync(rawPath, "");
  writeFileSync(commandLog, "");
}

let completed;
let workloadContract;

await main();

async function main() {
  run("cargo", ["build", "--release", "-p", "connect-hosted-storage-benchmark"], { cwd: root });
  const environment = captureEnvironment();
  writeFileSync(join(output, "environment.json"), `${JSON.stringify(environment, null, 2)}\n`);
  completed = resume ? completedKeys() : new Set();
  workloadContract = JSON.parse(readFileSync(workloadPath, "utf8"));

for (const tier of requestedTiers) {
  const fixtureDir = join(benchmarkRoot, "fixtures", tier);
  const fixtureManifest = JSON.parse(readFileSync(join(fixtureDir, "fixture-manifest.json"), "utf8"));
  for (const key of requestedVariants) {
    const variant = variants[key];
    const database = safeDbName(`hs_${runId}_${tier}_${key}`);
    const validationDb = childDbName(database, "validation");
    const context = { tier, fixtureDir, fixtureManifest, key, variant, database };
    if (!completed.has(`${tier}/${key}/validation-import`)) {
      recreateDatabase(validationDb);
      applySchema(validationDb, variant);
      recordHarness(context, validationDb, "import", "fixture.validation_import", 0, "validation", "not-applicable", [
        "import", "--database-url", databaseUrl(validationDb), "--candidate", variant.cli, "--fixture-dir", fixtureDir,
      ], "validation-import");
      for (const workload of workloadContract.queryWorkloads) {
        recordQuery(context, validationDb, workload, 0, "validation", "cold-key", false, `validation-query-${workload.id}`);
      }
      dropDatabase(validationDb);
    }

    if (!completed.has(`${tier}/${key}/measured-import`)) {
      recreateDatabase(database);
      applySchema(database, variant);
      const imported = recordHarness(context, database, "import", "fixture.import", 0, "measured", "not-applicable", [
        "import", "--database-url", databaseUrl(database), "--candidate", variant.cli, "--fixture-dir", fixtureDir,
      ], "measured-import");
      if (imported && variant.candidate !== "A") recordEmbeddedBackfill(context, imported);
      recordStorage(context, database, "post-import");
      recordBackupEstimate(context, database);
    }

    const warmups = quick ? 0 : tier === "canonical-1gib" ? 1 : 2;
    const measurements = quick ? 1 : tier === "canonical-1gib" ? 5 : 7;
    for (const workload of workloadContract.queryWorkloads) {
      if (workload.id === "sdk.cancel_broad_body_scan") {
        for (let repetition = 0; repetition < (quick ? 1 : 5); repetition += 1) {
          recordQuery(context, database, workload, repetition, "measured", "warm-key", false, `cancel-${workload.id}-${repetition}`);
        }
        continue;
      }
      for (let repetition = 0; repetition < warmups; repetition += 1) {
        recordQuery(context, database, workload, repetition, "warmup", repetition === 0 ? "cold-key" : "warm-key", false, `warmup-${workload.id}-${repetition}`);
      }
      for (let repetition = 0; repetition < measurements; repetition += 1) {
        recordQuery(context, database, workload, repetition, "measured", "warm-key", false, `query-${workload.id}-${repetition}`);
      }
    }

    if (tier === "canonical-1gib") {
      for (const workload of workloadContract.queryWorkloads) {
        recordQuery(context, database, workload, 0, "validation", "cold-key", true, `diagnostic-${workload.id}`);
      }
    }

    await recordContention(context, database);
    if (tier === "records-10000") {
      recordStateEvidence(context, database);
    }
    await recordRebuild(context, database);
    recordExercises(context, database);
    recordTableHealth(context, database, "after-writes");
    recordVacuum(context, database);
    recordStorage(context, database, "final");
  }
}

writeFileSync(join(output, "run-complete.json"), `${JSON.stringify({ runId, completedAt: new Date().toISOString(), tiers: requestedTiers, variants: requestedVariants }, null, 2)}\n`);
  console.log(JSON.stringify({ runId, output, rawPath }));
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) throw new Error(`unexpected argument ${value}`);
    const key = value.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (values[index + 1] && !values[index + 1].startsWith("--")) parsed[key] = values[++index];
    else parsed[key] = true;
  }
  return parsed;
}

function run(command, commandArgs, options = {}) {
  const cwd = options.cwd ?? root;
  appendFileSync(commandLog, `${new Date().toISOString()} ${cwd} $ ${command} ${commandArgs.map(shellQuote).join(" ")}\n`);
  const result = spawnSync(command, commandArgs, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  });
  if (options.allowFailure) return result;
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function timed(command, commandArgs, options = {}) {
  const before = postgresStats(options.database);
  const cpuBefore = postgresCpuUsec();
  const startedAt = new Date().toISOString();
  const invocation = [command, ...commandArgs].map(shellQuote).join(" ");
  const result = run("zsh", ["-c", `TIMEFMT='%U %S %M'; time ${invocation}`], { allowFailure: options.allowFailure });
  const cpuAfter = postgresCpuUsec();
  const after = postgresStats(options.database);
  const stderrLines = result.stderr.trim().split("\n");
  const usageLine = stderrLines.pop() ?? "0 0 0";
  const [user, system, maxRssKiB] = usageLine.split(/\s+/).map((value) => Number(value.replace(/s$/, "")));
  result.stderr = stderrLines.join("\n");
  return {
    result,
    startedAt,
    providerCpuMs: (user + system) * 1000,
    providerRssBytes: maxRssKiB * 1024,
    postgresCpuMs: (cpuAfter - cpuBefore) / 1000,
    postgresBlocksRead: after.blks_read - before.blks_read,
    postgresBlocksHit: after.blks_hit - before.blks_hit,
    postgresTempBytes: after.temp_bytes - before.temp_bytes,
    databaseBytesBefore: before.database_bytes,
    databaseBytesAfter: after.database_bytes,
  };
}

function harnessArgs(commandArgs) {
  return [binary, ...commandArgs];
}

function recordHarness(context, database, phase, workloadId, repetition, sampleRole, cacheState, commandArgs, checkpointKey, allowFailure = false) {
  if (completed.has(`${context.tier}/${context.key}/${checkpointKey}`)) return null;
  const measured = timed(binary, commandArgs, { database, allowFailure });
  const lines = measured.result.stdout.trim().split("\n").filter(Boolean);
  const payload = lines.length ? JSON.parse(lines.at(-1)) : {};
  const sample = sampleBase(context, phase, workloadId, repetition, sampleRole, cacheState, measured.startedAt);
  Object.assign(sample, mapPayload(payload), {
    provider_cpu_ms: measured.providerCpuMs,
    provider_rss_bytes: measured.providerRssBytes,
    postgres_cpu_ms: measured.postgresCpuMs,
    postgres_blocks_read: measured.postgresBlocksRead,
    postgres_blocks_hit: measured.postgresBlocksHit,
    postgres_temp_bytes: measured.postgresTempBytes,
    database_bytes_before: measured.databaseBytesBefore,
    database_bytes_after: measured.databaseBytesAfter,
  });
  if (measured.result.status !== 0) {
    sample.outcome = "error";
    sample.error_code = normalizeErrorCode(measured.result.stderr);
    sample.error_details = measured.result.stderr.trim().slice(0, 2000);
    sample.elapsed_ms ??= 0;
  }
  writeSample(sample, checkpointKey);
  return { payload, measured, sample };
}

function recordEmbeddedBackfill(context, imported) {
  const sample = sampleBase(context, "backfill", "projection.initial_generation", 0, "measured", context.variant.candidate === "C" ? "not-applicable" : "warm-key", imported.measured.startedAt);
  Object.assign(sample, {
    outcome: "success",
    elapsed_ms: imported.payload.projection_elapsed_ms,
    rows_selected: imported.payload.records,
    rows_scanned: imported.payload.records,
    wal_bytes: imported.payload.wal_bytes,
    provider_rss_bytes: imported.measured.providerRssBytes,
    provider_cpu_ms: imported.measured.providerCpuMs,
    database_bytes_before: imported.measured.databaseBytesBefore,
    database_bytes_after: imported.measured.databaseBytesAfter,
    notes: "Projection generation timing is isolated inside the measured initial import; persistence WAL is shared with that import and is not double-counted in aggregate storage totals.",
  });
  writeSample(sample, "embedded-backfill");
}

function recordQuery(context, database, workload, repetition, sampleRole, cacheState, diagnostic, checkpointKey, sampleWorkloadId = null) {
  const result = recordHarness(context, database, workload.id === "sdk.cancel_broad_body_scan" ? "cancellation" : "query", sampleWorkloadId ?? (diagnostic ? `${workload.id}.large_fixture_v1` : workload.id), repetition, sampleRole, cacheState, [
    "query", "--database-url", databaseUrl(database), "--candidate", context.variant.cli,
    "--fixture-dir", context.fixtureDir, "--workload-contract", workloadPath,
    "--workload-id", workload.id, "--budget-manifest", budgetPath,
    ...(diagnostic ? ["--large-fixture-entitlement"] : []),
  ], checkpointKey, false);
  if (result && result.sample.outcome === "budget" && !workload.acceptableBudgetKinds.includes(result.sample.budget_kind)) {
    result.sample.notes = "Typed budget outcome is not accepted by the frozen workload contract.";
    rewriteLastSample(result.sample, checkpointKey);
  }
}

function recordStorage(context, database, label) {
  const key = `storage-${label}`;
  if (completed.has(`${context.tier}/${context.key}/${key}`)) return;
  const measured = timed(binary, ["storage", "--database-url", databaseUrl(database), "--candidate", context.variant.cli], { database });
  const payload = JSON.parse(measured.result.stdout);
  const sample = sampleBase(context, "storage", `storage.${label}`, 0, "measured", "not-applicable", measured.startedAt);
  const relations = payload.relations;
  Object.assign(sample, {
    elapsed_ms: 0,
    outcome: "success",
    relation_sizes: relations,
    table_bytes: sum(relations, "table_bytes"),
    projection_bytes: relations.find((row) => row.relation === "record_projections")?.total_bytes ?? 0,
    toast_bytes: sum(relations, "toast_bytes"),
    index_bytes: sum(relations, "index_bytes"),
    database_bytes_after: payload.database_bytes,
    provider_cpu_ms: measured.providerCpuMs,
    provider_rss_bytes: measured.providerRssBytes,
    postgres_cpu_ms: measured.postgresCpuMs,
    postgres_blocks_read: measured.postgresBlocksRead,
    postgres_blocks_hit: measured.postgresBlocksHit,
    postgres_temp_bytes: measured.postgresTempBytes,
  });
  writeSample(sample, key);
}

function recordBackupEstimate(context, database) {
  const key = "backup-estimate";
  if (completed.has(`${context.tier}/${context.key}/${key}`)) return;
  const path = `/tmp/${safeDbName(database)}.dump`;
  const startedAt = new Date().toISOString();
  const started = performance.now();
  run("docker", ["exec", container, "pg_dump", "-U", "postgres", "-Fc", "-f", path, database]);
  const bytes = Number(run("docker", ["exec", container, "stat", "-c", "%s", path]).stdout.trim());
  run("docker", ["exec", container, "rm", "-f", path]);
  const sample = sampleBase(context, "storage", "storage.backup_estimate", 0, "measured", "not-applicable", startedAt);
  Object.assign(sample, { outcome: "success", elapsed_ms: performance.now() - started, backup_estimate_bytes: bytes });
  writeSample(sample, key);
}

function recordExercises(context, database) {
  for (const [operation, workloadId, samples] of [
    ["body-write", "write.body_only", quick ? 3 : 22],
    ["frontmatter-write", "write.frontmatter", quick ? 3 : 22],
    ["path-write", "write.path", quick ? 3 : 22],
    ["recovery", "write.recovery", 1],
    ["authorization", "authorization.stale_projection", 1],
    ["cas-loss", "write.cas_loss", 1],
    ["supersession", "write.catalog_supersession", 1],
  ]) {
    const key = `exercise-${operation}`;
    if (completed.has(`${context.tier}/${context.key}/${key}`)) continue;
    const measured = timed(binary, ["exercise", "--database-url", databaseUrl(database), "--candidate", context.variant.cli, "--fixture-dir", context.fixtureDir, "--operation", operation, "--samples", String(samples)], { database });
    const payloads = measured.result.stdout.trim().split("\n").filter(Boolean).map(JSON.parse);
    payloads.forEach((payload, index) => {
      const sampleRole = samples > 2 && index < 2 ? "warmup" : "measured";
      const sample = sampleBase(context, operation === "point-read" ? "contention" : operation === "recovery" ? "recovery" : "write", workloadId, Math.max(0, index - (samples > 2 ? 2 : 0)), sampleRole, context.variant.candidate === "C" ? "not-applicable" : "warm-key", new Date().toISOString());
      Object.assign(sample, mapPayload(payload), {
        provider_cpu_ms: measured.providerCpuMs / payloads.length,
        provider_rss_bytes: measured.providerRssBytes,
        postgres_cpu_ms: measured.postgresCpuMs / payloads.length,
        postgres_blocks_read: Math.round(measured.postgresBlocksRead / payloads.length),
        postgres_blocks_hit: Math.round(measured.postgresBlocksHit / payloads.length),
        postgres_temp_bytes: Math.round(measured.postgresTempBytes / payloads.length),
      });
      writeSample(sample, `${key}-${index}`);
    });
    markCheckpoint(context, key);
  }
}

async function recordContention(context, database) {
  const key = "contention-point-read";
  if (completed.has(`${context.tier}/${context.key}/${key}`)) return;
  const scanArgs = [
    "query", "--database-url", databaseUrl(database), "--candidate", context.variant.cli,
    "--fixture-dir", context.fixtureDir, "--workload-contract", workloadPath,
    "--workload-id", "sdk.selective_body_no_return", "--budget-manifest", budgetPath,
    ...(context.tier === "canonical-1gib" ? ["--large-fixture-entitlement"] : []),
  ];
  appendFileSync(commandLog, `${new Date().toISOString()} ${root} $ ${binary} ${scanArgs.map(shellQuote).join(" ")} # concurrent scan\n`);
  const scan = spawn(binary, scanArgs, { cwd: root, env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
  let scanStdout = "";
  let scanStderr = "";
  scan.stdout.setEncoding("utf8");
  scan.stderr.setEncoding("utf8");
  scan.stdout.on("data", (chunk) => { scanStdout += chunk; });
  scan.stderr.on("data", (chunk) => { scanStderr += chunk; });
  const scanExit = new Promise((resolveExit) => scan.on("exit", (code) => resolveExit(code)));
  await new Promise((resolveStart) => setTimeout(resolveStart, 25));
  const measured = timed(binary, ["exercise", "--database-url", databaseUrl(database), "--candidate", context.variant.cli, "--fixture-dir", context.fixtureDir, "--operation", "point-read", "--samples", quick ? "3" : "20"], { database });
  const scanStatus = await scanExit;
  const payloads = measured.result.stdout.trim().split("\n").filter(Boolean).map(JSON.parse);
  payloads.forEach((payload, repetition) => {
    const sample = sampleBase(context, "contention", "sdk.concurrent_point_read_during_scan", repetition, "measured", context.variant.candidate === "C" ? "not-applicable" : "warm-key", new Date().toISOString());
    Object.assign(sample, mapPayload(payload), {
      provider_cpu_ms: measured.providerCpuMs / payloads.length,
      provider_rss_bytes: measured.providerRssBytes,
      postgres_cpu_ms: measured.postgresCpuMs / payloads.length,
      postgres_blocks_read: Math.round(measured.postgresBlocksRead / payloads.length),
      postgres_blocks_hit: Math.round(measured.postgresBlocksHit / payloads.length),
      postgres_temp_bytes: Math.round(measured.postgresTempBytes / payloads.length),
      notes: `Point read overlapped sdk.selective_body_no_return; scan exit=${scanStatus}; scan stdout=${scanStdout.trim().slice(0, 500)}; scan stderr=${scanStderr.trim().slice(0, 500)}`,
    });
    writeSample(sample, `${key}-${repetition}`);
  });
  markCheckpoint(context, key);
}

function recordStateEvidence(context, database) {
  if (context.variant.candidate === "A") return;
  const key = "state-evidence";
  if (completed.has(`${context.tier}/${context.key}/${key}`)) return;
  const stateDb = childDbName(database, "state");
  dropDatabase(stateDb);
  run("docker", ["exec", container, "createdb", "-U", "postgres", "-T", database, stateDb]);
  const url = databaseUrl(stateDb);
  const schema = context.variant.schema;
  const firstId = psql(stateDb, `SELECT record_id FROM ${schema}.records ORDER BY record_id LIMIT 1`);
  psql(stateDb, `UPDATE ${schema}.record_projections SET record_revision='sha256:stale' WHERE record_id='${firstId}'`);
  const stale = recordHarness(context, stateDb, "query", "state.stale_projection_union", 0, "validation", "cold-key", ["query", "--database-url", url, "--candidate", context.variant.cli, "--fixture-dir", context.fixtureDir, "--workload-contract", workloadPath, "--workload-id", "editor.metadata_index", "--budget-manifest", budgetPath], `${key}-stale`, false);
  if (stale) stale.sample.notes = "Committed stale binding was included and canonically evaluated.";
  psql(stateDb, `DELETE FROM ${schema}.record_projections WHERE record_id='${firstId}'`);
  recordHarness(context, stateDb, "query", "state.missing_projection_union", 0, "validation", "cold-key", ["query", "--database-url", url, "--candidate", context.variant.cli, "--fixture-dir", context.fixtureDir, "--workload-contract", workloadPath, "--workload-id", "editor.metadata_index", "--budget-manifest", budgetPath], `${key}-missing`, false);
  dropDatabase(stateDb);

  const corruptDb = childDbName(database, "corrupt");
  run("docker", ["exec", container, "createdb", "-U", "postgres", "-T", database, corruptDb]);
  psql(corruptDb, `UPDATE ${schema}.record_projections SET projection_digest='sha256:corrupt' WHERE record_id=(SELECT record_id FROM ${schema}.records ORDER BY record_id LIMIT 1)`);
  recordHarness(context, corruptDb, "recovery", "state.corrupt_projection_digest", 0, "validation", "cold-key", ["query", "--database-url", databaseUrl(corruptDb), "--candidate", context.variant.cli, "--fixture-dir", context.fixtureDir, "--workload-contract", workloadPath, "--workload-id", "editor.metadata_index", "--budget-manifest", budgetPath], `${key}-corrupt`, true);
  dropDatabase(corruptDb);
  markCheckpoint(context, key);
}

async function recordRebuild(context, database) {
  const key = "rebuild";
  if (completed.has(`${context.tier}/${context.key}/${key}`)) return;
  if (context.variant.candidate !== "A" && context.tier === "records-10000") {
    const cancelDb = childDbName(database, "rebuild_cancel");
    dropDatabase(cancelDb);
    run("docker", ["exec", container, "createdb", "-U", "postgres", "-T", database, cancelDb]);
    const cancelArgs = ["rebuild", "--database-url", databaseUrl(cancelDb), "--candidate", context.variant.cli, "--fixture-dir", context.fixtureDir, "--batch-delay-ms", "10"];
    appendFileSync(commandLog, `${new Date().toISOString()} ${root} $ ${binary} ${cancelArgs.map(shellQuote).join(" ")} # terminate after durable checkpoint\n`);
    const cancelStartedAt = new Date().toISOString();
    const cancelStarted = performance.now();
    const stateBeforeCancel = rebuildState(cancelDb, context.variant.schema);
    const cancelled = spawn(binary, cancelArgs, { cwd: root, env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
    const cancelExitPromise = new Promise((resolveExit) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolveExit(value);
      };
      cancelled.once("exit", (code, signal) => finish({ code, signal }));
      cancelled.once("error", (error) => finish({ code: null, signal: null, error: error.message }));
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 80));
    const signalRequestedAt = new Date().toISOString();
    const killRequested = cancelled.kill("SIGTERM");
    const cancelExit = await cancelExitPromise;
    const cancelElapsedMs = performance.now() - cancelStarted;
    const cancelEndedAt = new Date().toISOString();
    const stateAfterCancel = rebuildState(cancelDb, context.variant.schema);
    const cancelCleanup = await waitForDatabaseCleanup(cancelDb);
    const checkpointChanged = stateBeforeCancel?.checkpoint !== stateAfterCancel?.checkpoint;
    const cancellationOutcome = cancelExit.signal === "SIGTERM" ? "cancelled" : cancelExit.code === 0 ? "success" : "error";
    const failureStage = stateAfterCancel?.checkpoint ? "after-durable-checkpoint" : "before-durable-checkpoint";
    const resumableState = stateAfterCancel?.status === "building" && Boolean(stateAfterCancel?.checkpoint);
    psql(cancelDb, `UPDATE ${context.variant.schema}.projection_generations SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE generation_id='${rebuildGenerationId}'`);
    const resumed = recordHarness(context, cancelDb, "recovery", "rebuild.resume_after_cancel", 0, "validation", "warm-key", ["rebuild", "--database-url", databaseUrl(cancelDb), "--candidate", context.variant.cli, "--fixture-dir", context.fixtureDir], `${key}-cancel-resume`, false);
    const stateAfterResume = rebuildState(cancelDb, context.variant.schema);
    const resumeCleanup = await waitForDatabaseCleanup(cancelDb);
    const resumeCompleted = resumed?.sample.outcome === "success"
      && stateAfterResume?.status === "complete"
      && resumeCleanup.released;
    const cancelSample = sampleBase(context, "recovery", "rebuild.process_cancel", 0, "validation", "warm-key", cancelStartedAt);
    Object.assign(cancelSample, {
      outcome: cancellationOutcome,
      elapsed_ms: cancelElapsedMs,
      failure_stage: failureStage,
      checkpoint_record_id: stateAfterCancel?.checkpoint ?? null,
      lease_state: stateAfterCancel?.status ?? null,
      recovery_state: resumeCompleted ? "resumed-complete" : resumableState ? "building-resumable" : stateAfterCancel?.status === "complete" ? "complete-before-cancel" : "unknown",
      cancellation_cleanup_ms: cancelCleanup.elapsedMs,
      transaction_released: cancelCleanup.released,
      notes: JSON.stringify({
        process: {
          pid: cancelled.pid,
          signal_requested: "SIGTERM",
          signal_requested_at: signalRequestedAt,
          kill_requested: killRequested,
          exited: true,
          exit_code: cancelExit.code,
          exit_signal: cancelExit.signal,
          error: cancelExit.error ?? null,
          started_at: cancelStartedAt,
          ended_at: cancelEndedAt,
          elapsed_ms: cancelElapsedMs,
        },
        checkpoint: {
          before: stateBeforeCancel?.checkpoint ?? null,
          after: stateAfterCancel?.checkpoint ?? null,
          changed: checkpointChanged,
        },
        state_before: stateBeforeCancel,
        state_after_cancel: stateAfterCancel,
        cleanup_after_cancel: cancelCleanup,
        resume: {
          sample_outcome: resumed?.sample.outcome ?? null,
          state: stateAfterResume,
          cleanup: resumeCleanup,
          completed: resumeCompleted,
        },
      }),
    });
    writeSample(cancelSample, `${key}-cancelled`);
    dropDatabase(cancelDb);
    const supersedeDb = childDbName(database, "rebuild_supersede");
    run("docker", ["exec", container, "createdb", "-U", "postgres", "-T", database, supersedeDb]);
    recordHarness(context, supersedeDb, "recovery", "rebuild.supersession_setup", 0, "validation", "warm-key", ["rebuild", "--database-url", databaseUrl(supersedeDb), "--candidate", context.variant.cli, "--fixture-dir", context.fixtureDir, "--fail-after-batches", "1"], `${key}-supersede-setup`, true);
    psql(supersedeDb, `UPDATE ${context.variant.schema}.collections SET active_generation_id='018f0000-0000-7000-8000-000000000002' WHERE collection_id='018f0000-0000-7000-8000-000000000001'`);
    recordHarness(context, supersedeDb, "recovery", "rebuild.generation_superseded", 0, "validation", "warm-key", ["rebuild", "--database-url", databaseUrl(supersedeDb), "--candidate", context.variant.cli, "--fixture-dir", context.fixtureDir], `${key}-superseded`, true);
    dropDatabase(supersedeDb);
    recordHarness(context, database, "recovery", "rebuild.injected_process_exit", 0, "validation", "warm-key", ["rebuild", "--database-url", databaseUrl(database), "--candidate", context.variant.cli, "--fixture-dir", context.fixtureDir, "--fail-after-batches", "2"], `${key}-failure`, true);
    const durableFailureState = rebuildState(database, context.variant.schema);
    if (!durableFailureState?.last_error_code || !durableFailureState?.last_error_at) throw new Error("rebuild failure did not persist bounded durable error state");
    const durableFailureSample = sampleBase(context, "recovery", "rebuild.durable_error_state", 0, "validation", "warm-key", new Date().toISOString());
    Object.assign(durableFailureSample, { outcome: "success", elapsed_ms: 0, checkpoint_record_id: durableFailureState.checkpoint, lease_state: durableFailureState.status, recovery_state: "durable-error-recorded", notes: JSON.stringify(durableFailureState) });
    writeSample(durableFailureSample, `${key}-durable-error`);
    psql(database, `UPDATE ${context.variant.schema}.projection_generations SET lease_owner='018f0000-0000-7000-8000-000000000099',lease_expires_at=clock_timestamp()+interval '1 hour' WHERE generation_id='018f0000-0000-7000-8000-000000000003'`);
    recordHarness(context, database, "recovery", "rebuild.stolen_lease_fence", 0, "validation", "warm-key", ["rebuild", "--database-url", databaseUrl(database), "--candidate", context.variant.cli, "--fixture-dir", context.fixtureDir], `${key}-lease-held`, true);
    psql(database, `UPDATE ${context.variant.schema}.projection_generations SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE generation_id='018f0000-0000-7000-8000-000000000003'`);
  }
  recordHarness(context, database, "rebuild", "write.resource_rebuild", 0, "measured", context.variant.candidate === "C" ? "not-applicable" : "warm-key", ["rebuild", "--database-url", databaseUrl(database), "--candidate", context.variant.cli, "--fixture-dir", context.fixtureDir], `${key}-complete`, false);
  if (context.tier === "records-10000") {
    for (const workload of workloadContract.queryWorkloads) {
      recordQuery(context, database, workload, 0, "validation", "warm-key", false, `${key}-post-v2-${workload.id}`, `rebuild.post_v2.${workload.id}`);
    }
  }
  markCheckpoint(context, key);
}

function recordTableHealth(context, database, label) {
  const key = `health-${label}`;
  if (completed.has(`${context.tier}/${context.key}/${key}`)) return;
  psql(database, "SELECT pg_stat_force_next_flush()", false);
  const stats = JSON.parse(psql(database, `SELECT json_build_object('hot',coalesce(sum(n_tup_hot_upd),0),'updates',coalesce(sum(n_tup_upd),0),'dead',coalesce(sum(n_dead_tup),0)) FROM pg_stat_user_tables WHERE schemaname='${context.variant.schema}'`));
  const avg = Number(psql(database, `SELECT coalesce(sum(pg_relation_size(c.oid))/nullif(sum(s.n_live_tup),0),0)::bigint FROM pg_stat_user_tables s JOIN pg_class c ON c.relname=s.relname JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname=s.schemaname WHERE s.schemaname='${context.variant.schema}'`));
  const sample = sampleBase(context, "write", `health.${label}`, 0, "measured", "not-applicable", new Date().toISOString());
  Object.assign(sample, { outcome: "success", elapsed_ms: 0, hot_updates: Number(stats.hot), non_hot_updates: Number(stats.updates) - Number(stats.hot), dead_tuples: Number(stats.dead), bloat_estimate_bytes: Math.max(0, Math.round(Number(stats.dead) * avg)), notes: "Bloat is the frozen dead-tuple-count times mean live tuple bytes estimate; pgstattuple was not installed." });
  writeSample(sample, key);
}

function recordVacuum(context, database) {
  const key = "vacuum";
  if (completed.has(`${context.tier}/${context.key}/${key}`)) return;
  const startedAt = new Date().toISOString();
  const started = performance.now();
  for (const table of ["records", "record_versions", "changes", ...(context.variant.candidate === "A" ? [] : ["record_projections"])]) {
    psql(database, `VACUUM (ANALYZE) ${context.variant.schema}.${table}`, false);
  }
  const sample = sampleBase(context, "vacuum", "vacuum.explicit", 0, "measured", "not-applicable", startedAt);
  Object.assign(sample, { outcome: "success", elapsed_ms: performance.now() - started, vacuum_elapsed_ms: performance.now() - started });
  writeSample(sample, key);
}

function sampleBase(context, phase, workloadId, repetition, sampleRole, cacheState, startedAt) {
  const budget = JSON.parse(readFileSync(budgetPath, "utf8"));
  return {
    schema_version: 1,
    run_id: runId,
    candidate: context.variant.candidate,
    variant: context.variant.variant,
    tier: context.tier,
    fixture_digest: sha256(join(context.fixtureDir, "fixture-manifest.json")),
    phase,
    workload_id: workloadId,
    repetition,
    sample_role: sampleRole,
    cache_state: cacheState,
    workload_contract_digest: sha256(workloadPath),
    fixture_contract_digest: sha256(fixtureContractPath),
    schema_digest: sha256(join(schemas, context.variant.schemaFile)),
    budget_manifest_revision: budget.revision,
    budget_manifest_digest: sha256(budgetPath),
    outcome: "success",
    budget_kind: null,
    error_code: null,
    error_details: null,
    started_at: startedAt,
    elapsed_ms: 0,
    ...Object.fromEntries(optionalFields.map((field) => [field, null])),
  };
}

function mapPayload(payload) {
  const aliases = {
    elapsed_ms: ["elapsed_ms", "elapsedMs"],
    rows_selected: ["rows_selected", "rowsSelected"],
    rows_scanned: ["rows_scanned", "rowsScanned"],
    sql_candidate_rows: ["sql_candidate_rows", "sqlCandidateRows"],
    canonical_rows_evaluated: ["canonical_rows_evaluated", "canonicalRowsEvaluated"],
    documents_decrypted: ["documents_decrypted", "documentsDecrypted"],
    ciphertext_bytes: ["ciphertext_bytes", "ciphertextBytes"],
    plaintext_bytes: ["plaintext_bytes", "plaintextBytes"],
    result_items: ["result_items", "resultItems"],
    result_bytes: ["result_bytes", "resultBytes"],
    completeness_digest: ["completeness_digest", "completenessDigest"],
    key_cache_hits: ["key_cache_hits", "keyCacheHits"],
    key_cache_misses: ["key_cache_misses", "keyCacheMisses"],
    kms_unwraps: ["kms_unwraps", "kmsUnwraps"],
    provider_pss_bytes: ["provider_pss_bytes", "providerPssBytes"],
    accounted_operator_bytes_peak: ["accounted_operator_bytes_peak", "accountedOperatorBytesPeak"],
    cancellation_cleanup_ms: ["cancellation_cleanup_ms", "cancellationCleanupMs"],
    snapshot_lifetime_ms: ["snapshot_lifetime_ms", "snapshotLifetimeMs"],
    wal_bytes: ["wal_bytes", "walBytes"],
    failure_stage: ["failure_stage", "failureStage"],
    checkpoint_record_id: ["checkpoint_record_id", "checkpointRecordId"],
    recovery_state: ["recovery_state", "recoveryState"],
    lease_state: ["lease_state", "leaseState"],
    authorization_classification: ["authorization_classification", "authorizationClassification"],
    transaction_released: ["transaction_released", "transactionReleased"],
    pool_permit_released: ["pool_permit_released", "poolPermitReleased"],
    plaintext_released: ["plaintext_released", "plaintextReleased"],
    page_boundaries: ["page_boundaries", "pageBoundaries"],
    pool_connections_peak: ["pool_connections_peak", "poolConnectionsPeak"],
    pool_connections_average: ["pool_connections_average", "poolConnectionsAverage"],
    pool_wait_ms: ["pool_wait_ms", "poolWaitMs"],
  };
  const mapped = {};
  for (const [target, sources] of Object.entries(aliases)) {
    const source = sources.find((candidate) => payload[candidate] !== undefined);
    if (source) mapped[target] = payload[source];
  }
  if (payload.records !== undefined && mapped.rows_selected === undefined) mapped.rows_selected = payload.records;
  if (payload.notes !== undefined) mapped.notes = typeof payload.notes === "string" ? payload.notes : JSON.stringify(payload.notes);
  if (payload.outcome) mapped.outcome = payload.outcome;
  if (payload.budget_kind) mapped.budget_kind = payload.budget_kind;
  return mapped;
}

function writeSample(sample, checkpointKey) {
  if (sample.outcome !== "budget") sample.budget_kind = null;
  if (sample.outcome !== "error") sample.error_code = null;
  appendFileSync(rawPath, `${JSON.stringify(sample)}\n`);
  appendFileSync(join(output, "checkpoints.ndjson"), `${JSON.stringify({ key: `${sample.tier}/${variantKey(sample)}/${checkpointKey}`, at: new Date().toISOString() })}\n`);
}

function rewriteLastSample() {
  // Samples are immutable evidence; explanatory gate annotations are added by the summarizer.
}

function markCheckpoint(context, key) {
  appendFileSync(join(output, "checkpoints.ndjson"), `${JSON.stringify({ key: `${context.tier}/${context.key}/${key}`, at: new Date().toISOString() })}\n`);
}

function completedKeys() {
  const path = join(output, "checkpoints.ndjson");
  if (!existsSync(path)) return new Set();
  return new Set(readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line).key));
}

function variantKey(sample) {
  if (sample.candidate === "A") return "a";
  return `${sample.candidate.toLowerCase()}-${sample.variant}`;
}

function recreateDatabase(database) {
  dropDatabase(database);
  run("docker", ["exec", container, "createdb", "-U", "postgres", database]);
}

function dropDatabase(database) {
  run("docker", ["exec", container, "dropdb", "-U", "postgres", "--if-exists", "--force", database]);
}

function applySchema(database, variant) {
  run(binary, ["schema", "--database-url", databaseUrl(database), "--candidate", variant.cli, "--schema-dir", schemas]);
}

function databaseUrl(database) {
  return `postgresql://postgres:benchmark@127.0.0.1:${port}/${database}`;
}

function psql(database, sql, tuplesOnly = true) {
  const commandArgs = ["exec", container, "psql", "-U", "postgres", "-d", database, "-v", "ON_ERROR_STOP=1"];
  if (tuplesOnly) commandArgs.push("-At");
  commandArgs.push("-c", sql);
  return run("docker", commandArgs).stdout.trim();
}

function rebuildState(database, schema) {
  const value = psql(database, `SELECT json_build_object('status',status,'checkpoint',checkpoint_record_id,'lease_owner',lease_owner,'lease_expires_at',lease_expires_at,'attempt_count',attempt_count,'last_error_code',last_error_code,'last_error_at',last_error_at) FROM ${schema}.projection_generations WHERE generation_id='${rebuildGenerationId}'`);
  return value ? JSON.parse(value) : null;
}

async function waitForDatabaseCleanup(database, timeoutMs = 5_000) {
  const started = performance.now();
  let sessions = Number(psql(database, "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid <> pg_backend_pid()"));
  while (sessions > 0 && performance.now() - started < timeoutMs) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    sessions = Number(psql(database, "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid <> pg_backend_pid()"));
  }
  return { sessions, released: sessions === 0, elapsedMs: performance.now() - started };
}

function postgresStats(database) {
  if (!database) return { blks_read: 0, blks_hit: 0, temp_bytes: 0 };
  const value = psql(database, "SELECT json_build_object('blks_read',blks_read,'blks_hit',blks_hit,'temp_bytes',temp_bytes,'database_bytes',pg_database_size(current_database())) FROM pg_stat_database WHERE datname=current_database()");
  return JSON.parse(value || '{"blks_read":0,"blks_hit":0,"temp_bytes":0,"database_bytes":0}');
}

function postgresCpuUsec() {
  const result = run("docker", ["exec", container, "cat", "/sys/fs/cgroup/cpu.stat"], { allowFailure: true });
  const match = result.stdout.match(/^usage_usec\s+(\d+)/m);
  return match ? Number(match[1]) : 0;
}

function captureEnvironment() {
  const git = (cwd) => {
    const status = run("git", ["status", "--porcelain", "--untracked-files=all"], { cwd }).stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3))
      .filter((path) => !path.startsWith("docs/benchmarks/hosted-storage-model/results/"));
    return {
      revision: run("git", ["rev-parse", "HEAD"], { cwd }).stdout.trim(),
      dirty: status.length > 0,
      dirtyPaths: status,
    };
  };
  return {
    runId,
    capturedAt: new Date().toISOString(),
    host: {
      uname: run("uname", ["-a"]).stdout.trim(),
      cpu: readFileSync("/proc/cpuinfo", "utf8").match(/^model name\s*:\s*(.+)$/m)?.[1] ?? null,
      cpuCount: Number(run("nproc", []).stdout.trim()),
      memoryBytes: Number(readFileSync("/proc/meminfo", "utf8").match(/^MemTotal:\s+(\d+)/m)?.[1] ?? 0) * 1024,
      filesystem: run("df", ["-T", root]).stdout.trim(),
    },
    tools: {
      docker: run("docker", ["--version"]).stdout.trim(),
      postgres: psql("postgres", "SHOW server_version"),
      rust: run("rustc", ["--version"]).stdout.trim(),
      node: process.version,
      openssl: run("openssl", ["version"]).stdout.trim(),
    },
    postgres: {
      image: run("docker", ["inspect", "--format", "{{.Config.Image}}", container]).stdout.trim(),
      settings: JSON.parse(psql("postgres", "SELECT json_object_agg(name,setting) FROM pg_settings WHERE name IN ('shared_buffers','work_mem','maintenance_work_mem','wal_level','max_connections','autovacuum')")),
      container: run("docker", ["inspect", "--format", "{{json .HostConfig}}", container]).stdout.trim(),
    },
    revisions: { connect: git(root), mdbaseRs: git(resolve(root, "../mdbase-rs")) },
    contracts: { workload: sha256(workloadPath), fixture: sha256(fixtureContractPath), budgets: sha256(budgetPath), rawSchema: sha256(rawSchemaPath) },
    command: process.argv,
    syntheticFixturesOnly: true,
    sharedServicesContacted: false,
  };
}

function sha256(path) {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function safeDbName(value) {
  return value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 55);
}

function childDbName(database, suffix) {
  const normalizedSuffix = suffix.toLowerCase().replace(/[^a-z0-9_]+/g, "_");
  return `${database.slice(0, 54 - normalizedSuffix.length)}_${normalizedSuffix}`;
}

function shellQuote(value) {
  return /^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : JSON.stringify(value);
}

function sum(rows, field) {
  return rows.reduce((total, row) => total + Number(row[field] ?? 0), 0);
}

function normalizeErrorCode(stderr) {
  if (stderr.includes("projection digest verification failed")) return "authorization_classification_failed";
  if (stderr.includes("injected rebuild failure")) return "injected_process_exit";
  if (stderr.includes("injected_rebuild_failure")) return "injected_process_exit";
  if (stderr.includes("completion proof")) return "completion_proof_failed";
  if (stderr.includes("lease is held")) return "lease_held";
  if (stderr.includes("rebuild_generation_superseded")) return "generation_superseded";
  if (stderr.includes("catalog_superseded")) return "catalog_superseded";
  return "benchmark_operation_failed";
}
