#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";

const [command, ...argv] = process.argv.slice(2);

if (command === "assemble") {
  await assemble(argv);
} else if (command === "record") {
  await record(argv);
} else {
  throw new Error("usage: performance-results.mjs assemble|record [options]");
}

async function assemble(args) {
  const { values } = parseArgs({
    args,
    options: {
      engine: { type: "string" },
      connect: { type: "string" },
      mirror: { type: "string" },
      environment: { type: "string" },
      provider: { type: "string" },
      "provider-environment": { type: "string" },
      output: { type: "string" },
      summary: { type: "string" },
      repository: { type: "string" },
      commit: { type: "string" },
      "mdbase-rs-commit": { type: "string" },
      "pnpm-lock-sha256": { type: "string" },
      "cargo-lock-sha256": { type: "string" },
      "revision-file-sha256": { type: "string" },
      "workflow-sha256": { type: "string" },
      event: { type: "string" },
      "run-id": { type: "string" },
      "run-attempt": { type: "string" },
      "run-url": { type: "string" },
      "profile-size": { type: "string" },
      "profile-iterations": { type: "string" },
      "profile-concurrency": { type: "string" },
      "provider-requested": { type: "string" }
    },
    strict: true
  });
  requireOptions(values, [
    "engine", "connect", "mirror", "environment", "output", "summary",
    "repository", "commit", "mdbase-rs-commit", "pnpm-lock-sha256",
    "cargo-lock-sha256", "revision-file-sha256", "workflow-sha256", "event", "run-id",
    "run-attempt", "run-url", "profile-size", "profile-iterations",
    "profile-concurrency", "provider-requested"
  ]);

  const engineRaw = await readJson(values.engine);
  const connectRaw = await readJson(values.connect);
  const mirrorRaw = await readJson(values.mirror);
  const coreEnvironment = normalizeEnvironment(await readJson(values.environment));
  const providerRequested = parseBoolean(values["provider-requested"], "--provider-requested");
  if (providerRequested !== Boolean(values.provider)) {
    throw new Error("provider request and provider result must either both be present or both be absent");
  }
  if (Boolean(values.provider) !== Boolean(values["provider-environment"])) {
    throw new Error("provider result and provider environment must be provided together");
  }

  const runId = positiveInteger(values["run-id"], "--run-id");
  const runAttempt = positiveInteger(values["run-attempt"], "--run-attempt");
  const observation = {
    schema_version: 1,
    kind: "mdbase-connect-performance-observation",
    informational_only: true,
    observation_id: `run-${runId}-attempt-${runAttempt}`,
    generated_at: isoTimestamp(engineRaw.generated_at, "engine.generated_at"),
    source: {
      repository: nonEmpty(values.repository, "--repository"),
      connect_commit: sha(values.commit, "--commit"),
      mdbase_rs_commit: sha(values["mdbase-rs-commit"], "--mdbase-rs-commit"),
      inputs_sha256: {
        pnpm_lock: sha256(values["pnpm-lock-sha256"], "--pnpm-lock-sha256"),
        cargo_lock: sha256(values["cargo-lock-sha256"], "--cargo-lock-sha256"),
        mdbase_rs_revision_file: sha256(values["revision-file-sha256"], "--revision-file-sha256"),
        workflow: sha256(values["workflow-sha256"], "--workflow-sha256")
      },
      event: nonEmpty(values.event, "--event"),
      run_id: runId,
      run_attempt: runAttempt,
      run_url: httpUrl(values["run-url"], "--run-url")
    },
    inputs: {
      profile_size: positiveInteger(values["profile-size"], "--profile-size"),
      profile_iterations: positiveInteger(values["profile-iterations"], "--profile-iterations"),
      profile_concurrency: positiveInteger(values["profile-concurrency"], "--profile-concurrency"),
      provider_10k_requested: providerRequested
    },
    environments: {
      core: coreEnvironment,
      provider: values["provider-environment"]
        ? normalizeEnvironment(await readJson(values["provider-environment"]))
        : null
    },
    observations: {
      engine: normalizeEngine(engineRaw),
      connect: normalizeConnect(connectRaw),
      mirror: normalizeMirror(mirrorRaw),
      provider_10k: values.provider ? normalizeProvider(await readJson(values.provider)) : null
    }
  };

  assertObservation(observation);
  const summary = renderSummary(observation);
  await mkdirFor(values.output);
  await mkdirFor(values.summary);
  await writeFile(values.output, `${JSON.stringify(observation, null, 2)}\n`);
  await writeFile(values.summary, summary);
}

async function record(args) {
  const { values } = parseArgs({
    args,
    options: {
      observation: { type: "string" },
      summary: { type: "string" },
      "history-dir": { type: "string" }
    },
    strict: true
  });
  requireOptions(values, ["observation", "summary", "history-dir"]);
  const observation = await readJson(values.observation);
  assertObservation(observation);
  const summary = await readFile(values.summary, "utf8");
  if (!summary.includes("Informational only")) {
    throw new Error("summary must identify the observation as informational only");
  }

  const date = new Date(observation.generated_at);
  const relativeDirectory = `results/${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  const stem = observation.observation_id;
  const historyDir = values["history-dir"];
  const resultsDir = join(historyDir, relativeDirectory);
  await mkdir(resultsDir, { recursive: true });
  const jsonRelative = `${relativeDirectory}/${stem}.json`;
  const markdownRelative = `${relativeDirectory}/${stem}.md`;
  await writeOnceOrEqual(
    join(historyDir, jsonRelative),
    `${JSON.stringify(observation, null, 2)}\n`
  );
  await writeOnceOrEqual(join(historyDir, markdownRelative), summary);

  let index = { schema_version: 1, results: [] };
  try {
    index = await readJson(join(historyDir, "index.json"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (index.schema_version !== 1 || !Array.isArray(index.results)) {
    throw new Error("unsupported performance history index");
  }
  const entry = {
    observation_id: observation.observation_id,
    generated_at: observation.generated_at,
    connect_commit: observation.source.connect_commit,
    mdbase_rs_commit: observation.source.mdbase_rs_commit,
    run_url: observation.source.run_url,
    provider_10k: observation.observations.provider_10k !== null,
    file: jsonRelative,
    summary: markdownRelative
  };
  const results = [entry, ...index.results.filter((item) => item.observation_id !== entry.observation_id)]
    .sort((left, right) => right.generated_at.localeCompare(left.generated_at));
  await writeFile(join(historyDir, "index.json"), `${JSON.stringify({ schema_version: 1, results }, null, 2)}\n`);
  await writeFile(join(historyDir, "README.md"), `# mdbase performance history\n\nPayload-free, non-blocking observations produced by the scheduled and manually dispatched mdbase Connect performance workflow. Results are informational and are not merge or release gates.\n\nLatest observation: [${observation.generated_at}](${markdownRelative}) from Connect \`${observation.source.connect_commit.slice(0, 12)}\` and mdbase-rs \`${observation.source.mdbase_rs_commit.slice(0, 12)}\`.\n`);
  process.stdout.write(`${join(historyDir, jsonRelative)}\n`);
}

function normalizeEngine(value) {
  if (value?.tool !== "mdbase-profile-engine" || typeof value.version !== "string") {
    throw new Error("engine report has an unsupported producer identity");
  }
  const config = object(value.config, "engine.config");
  const fixture = object(value.fixture, "engine.fixture");
  return {
    tool: value.tool,
    version: value.version,
    generated_at: isoTimestamp(value.generated_at, "engine.generated_at"),
    total_runtime_ms: finite(value.total_runtime_ms, "engine.total_runtime_ms"),
    config: {
      scenario: nonEmpty(config.scenario, "engine.config.scenario"),
      files: nonNegativeInteger(config.files, "engine.config.files"),
      projects: nonNegativeInteger(config.projects, "engine.config.projects"),
      rename_refs: nonNegativeInteger(config.rename_refs, "engine.config.rename_refs"),
      seed: nonNegativeInteger(config.seed, "engine.config.seed")
    },
    fixture: {
      task_files: nonNegativeInteger(fixture.task_files, "engine.fixture.task_files"),
      project_files: nonNegativeInteger(fixture.project_files, "engine.fixture.project_files"),
      rename_reference_files: nonNegativeInteger(fixture.rename_reference_files, "engine.fixture.rename_reference_files")
    },
    percentile_method: "linear-interpolation-r7",
    operations: operationList(value.operations, "engine.operations", "ops_per_sec")
  };
}

function normalizeConnect(value) {
  if (value?.tool !== "mdbase-profile-connect" || typeof value.version !== "string") {
    throw new Error("Connect report has an unsupported producer identity");
  }
  return {
    tool: value.tool,
    version: value.version,
    scenario: nonEmpty(value.scenario, "connect.scenario"),
    iterations: positiveInteger(value.iterations, "connect.iterations"),
    concurrency: positiveInteger(value.concurrency, "connect.concurrency"),
    percentile_method: "linear-interpolation-r7",
    operations: operationList(value.operations, "connect.operations", "operations_per_second")
  };
}

function operationList(value, label, throughputField) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array`);
  return value.map((item, index) => {
    const prefix = `${label}[${index}]`;
    const operation = {
      name: nonEmpty(item?.name, `${prefix}.name`),
      iterations: positiveInteger(item.iterations, `${prefix}.iterations`),
      total_ms: finite(item.total_ms, `${prefix}.total_ms`),
      latency_ms: {
        min: finite(item.min_ms, `${prefix}.min_ms`),
        mean: finite(item.mean_ms, `${prefix}.mean_ms`),
        p50: finite(item.p50_ms, `${prefix}.p50_ms`),
        p95: finite(item.p95_ms, `${prefix}.p95_ms`),
        p99: item.p99_ms === undefined ? null : finite(item.p99_ms, `${prefix}.p99_ms`),
        max: finite(item.max_ms, `${prefix}.max_ms`)
      },
      operations_per_second: finite(item[throughputField], `${prefix}.${throughputField}`)
    };
    if (item.requests_per_iteration !== undefined) {
      operation.requests_per_iteration = positiveInteger(item.requests_per_iteration, `${prefix}.requests_per_iteration`);
    }
    if (item.phases !== undefined) operation.phases = normalizePhaseMap(item.phases, `${prefix}.phases`);
    if (item.counters !== undefined) operation.counters = normalizeNumberMap(item.counters, `${prefix}.counters`);
    return operation;
  });
}

function normalizePhaseMap(value, label) {
  const source = object(value, label);
  return Object.fromEntries(Object.entries(source).map(([name, phase]) => [name, {
    mean_ms: finite(phase?.mean_ms, `${label}.${name}.mean_ms`),
    p95_ms: finite(phase?.p95_ms, `${label}.${name}.p95_ms`),
    max_ms: finite(phase?.max_ms, `${label}.${name}.max_ms`)
  }]));
}

function normalizeNumberMap(value, label) {
  const source = object(value, label);
  return Object.fromEntries(Object.entries(source).map(([name, number]) => [name, finite(number, `${label}.${name}`)]));
}

function normalizeMirror(value) {
  if (value?.profile_version !== 1) throw new Error("mirror report has an unsupported profile version");
  const runtime = object(value.runtime, "mirror.runtime");
  const parameters = object(value.parameters, "mirror.parameters");
  if (!Array.isArray(value.samples) || value.samples.length === 0) throw new Error("mirror.samples must be a non-empty array");
  return {
    profile_version: 1,
    runtime: {
      node: nonEmpty(runtime.node, "mirror.runtime.node"),
      platform: nonEmpty(runtime.platform, "mirror.runtime.platform"),
      gc_exposed: boolean(runtime.gc_exposed, "mirror.runtime.gc_exposed")
    },
    parameters: {
      records: positiveInteger(parameters.records, "mirror.parameters.records"),
      changes: positiveInteger(parameters.changes, "mirror.parameters.changes"),
      rounds: positiveInteger(parameters.rounds, "mirror.parameters.rounds"),
      snapshot_page_size: positiveInteger(parameters.snapshot_page_size, "mirror.parameters.snapshot_page_size"),
      body_only_percent: nonNegativeInteger(parameters.body_only_percent, "mirror.parameters.body_only_percent"),
      adapters: stringList(parameters.adapters, "mirror.parameters.adapters")
    },
    samples: value.samples.map((sample, index) => {
      const prefix = `mirror.samples[${index}]`;
      const calls = object(sample?.transport_calls, `${prefix}.transport_calls`);
      return {
        name: nonEmpty(sample.name, `${prefix}.name`),
        wall_ms: finite(sample.wall_ms, `${prefix}.wall_ms`),
        peak_heap_delta_mib: finite(sample.peak_heap_delta_mib, `${prefix}.peak_heap_delta_mib`),
        peak_rss_delta_mib: finite(sample.peak_rss_delta_mib, `${prefix}.peak_rss_delta_mib`),
        retained_heap_delta_mib: finite(sample.retained_heap_delta_mib, `${prefix}.retained_heap_delta_mib`),
        fs_reads: nonNegativeInteger(sample.fs_reads, `${prefix}.fs_reads`),
        fs_writes: nonNegativeInteger(sample.fs_writes, `${prefix}.fs_writes`),
        fs_removes: nonNegativeInteger(sample.fs_removes, `${prefix}.fs_removes`),
        fs_lists: nonNegativeInteger(sample.fs_lists, `${prefix}.fs_lists`),
        state_reads: nonNegativeInteger(sample.state_reads, `${prefix}.state_reads`),
        state_writes: nonNegativeInteger(sample.state_writes, `${prefix}.state_writes`),
        transport_calls: Object.fromEntries(["open_session", "snapshot", "file_snapshot", "changes", "mutate"]
          .map((name) => [name, nonNegativeInteger(calls[name], `${prefix}.transport_calls.${name}`)]))
      };
    })
  };
}

function normalizeProvider(value) {
  if (value?.schema_version !== 1 || value?.tool !== "mdbase-provider-e2e-performance") {
    throw new Error("provider report has an unsupported producer identity");
  }
  const parameters = object(value.parameters, "provider.parameters");
  const metrics = object(value.metrics, "provider.metrics");
  const latencyNames = ["mutation_p95_ms", "snapshot_ms", "change_page_p95_ms", "warm_read_p95_ms", "warm_query_p95_ms", "cold_read_ms", "cold_query_ms"];
  const byteNames = ["rss_before_bytes", "pss_before_bytes", "rss_after_queries_bytes", "pss_after_queries_bytes", "cold_read_rss_delta_bytes", "cold_read_ciphertext_bytes", "cold_query_rss_delta_bytes", "cold_query_ciphertext_bytes", "measured_working_set_plaintext_bytes", "measured_ciphertext_bytes", "measured_cgroup_current_bytes", "measured_cgroup_peak_bytes"];
  const countNames = ["records", "cold_read_scanned_records", "cold_read_records_fetched", "cold_query_scanned_records", "measured_scanned_records"];
  return {
    schema_version: 1,
    tool: value.tool,
    generated_at: isoTimestamp(value.generated_at, "provider.generated_at"),
    parameters: {
      bulk_records: positiveInteger(parameters.bulk_records, "provider.parameters.bulk_records"),
      records_before_bulk: nonNegativeInteger(parameters.records_before_bulk, "provider.parameters.records_before_bulk"),
      final_records: positiveInteger(parameters.final_records, "provider.parameters.final_records"),
      warm_samples: positiveInteger(parameters.warm_samples, "provider.parameters.warm_samples"),
      percentile_method: exactString(parameters.percentile_method, "nearest-rank-floor", "provider.parameters.percentile_method")
    },
    latency_ms: Object.fromEntries(latencyNames.map((name) => [name.replace(/_ms$/, ""), nullableFinite(metrics[name], `provider.metrics.${name}`)])),
    bytes: Object.fromEntries(byteNames.map((name) => [name.replace(/_bytes$/, ""), nullableFinite(metrics[name], `provider.metrics.${name}`)])),
    counts: Object.fromEntries(countNames.map((name) => [name, nullableNonNegativeInteger(metrics[name], `provider.metrics.${name}`)])),
    invariants: {
      cold_read_used_authority_bulk_materialization: boolean(metrics.cold_read_used_authority_bulk_materialization, "provider.metrics.cold_read_used_authority_bulk_materialization")
    }
  };
}

function normalizeEnvironment(value) {
  if (value?.schema_version !== 1 || value?.kind !== "github-runner-environment") {
    throw new Error("environment report has an unsupported producer identity");
  }
  return {
    schema_version: 1,
    runner_os: nonEmpty(value.runner_os, "environment.runner_os"),
    runner_arch: nonEmpty(value.runner_arch, "environment.runner_arch"),
    runner_name: nonEmpty(value.runner_name, "environment.runner_name"),
    runner_image: nullableString(value.runner_image, "environment.runner_image"),
    cpu_model: nullableString(value.cpu_model, "environment.cpu_model"),
    logical_cpus: nullableNonNegativeInteger(value.logical_cpus, "environment.logical_cpus"),
    kernel: nullableString(value.kernel, "environment.kernel"),
    node: nullableString(value.node, "environment.node"),
    pnpm: nullableString(value.pnpm, "environment.pnpm"),
    rustc: nullableString(value.rustc, "environment.rustc")
  };
}

function renderSummary(observation) {
  const lines = [
    "# mdbase performance observation",
    "",
    "> **Informational only.** GitHub-hosted runner measurements are not merge or release gates.",
    "",
    `- Observation: \`${escapeMarkdown(observation.observation_id)}\``,
    `- Connect: \`${observation.source.connect_commit}\``,
    `- mdbase-rs: \`${observation.source.mdbase_rs_commit}\``,
    `- Run: [${observation.source.run_id} attempt ${observation.source.run_attempt}](${observation.source.run_url})`,
    `- Core runner: ${environmentLabel(observation.environments.core)}`,
    "",
    "## Engine",
    "",
    ...operationTable(observation.observations.engine.operations),
    "",
    "## Connect core",
    "",
    ...operationTable(observation.observations.connect.operations),
    "",
    "## Mirrors",
    "",
    "| Workload | Wall ms | Peak heap MiB | Peak RSS MiB | FS reads | FS writes | Transport calls |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...observation.observations.mirror.samples.map((sample) => {
      const calls = Object.values(sample.transport_calls).reduce((sum, value) => sum + value, 0);
      return `| ${escapeMarkdown(sample.name)} | ${number(sample.wall_ms)} | ${number(sample.peak_heap_delta_mib)} | ${number(sample.peak_rss_delta_mib)} | ${sample.fs_reads} | ${sample.fs_writes} | ${calls} |`;
    }),
    ""
  ];
  const provider = observation.observations.provider_10k;
  lines.push("## Hosted provider 10k", "");
  if (provider === null) {
    lines.push("Not requested for this observation.", "");
  } else {
    lines.push(
      `Provider runner: ${environmentLabel(observation.environments.provider)}`,
      "",
      "| Metric | Value |",
      "|---|---:|",
      ...Object.entries(provider.latency_ms).map(([name, value]) => `| ${escapeMarkdown(name)} | ${number(value)} ms |`),
      `| records | ${provider.counts.records ?? "n/a"} |`,
      `| RSS before | ${bytes(provider.bytes.rss_before)} |`,
      `| RSS after queries | ${bytes(provider.bytes.rss_after_queries)} |`,
      `| cold-read rows fetched | ${provider.counts.cold_read_records_fetched ?? "n/a"} |`,
      ""
    );
  }
  lines.push("Compare observations only when workload, runtime, and runner fingerprints are comparable.", "");
  return `${lines.join("\n")}\n`;
}

function operationTable(operations) {
  return [
    "| Operation | Runs | Mean ms | p50 ms | p95 ms | p99 ms | Max ms | Ops/s |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...operations.map((operation) => `| ${escapeMarkdown(operation.name)} | ${operation.iterations} | ${number(operation.latency_ms.mean)} | ${number(operation.latency_ms.p50)} | ${number(operation.latency_ms.p95)} | ${number(operation.latency_ms.p99)} | ${number(operation.latency_ms.max)} | ${number(operation.operations_per_second)} |`)
  ];
}

function assertObservation(value) {
  if (value?.schema_version !== 1 || value?.kind !== "mdbase-connect-performance-observation" || value?.informational_only !== true) {
    throw new Error("unsupported performance observation");
  }
  if (!/^run-[1-9]\d*-attempt-[1-9]\d*$/.test(value.observation_id ?? "")) throw new Error("invalid observation id");
  isoTimestamp(value.generated_at, "generated_at");
  sha(value.source?.connect_commit, "source.connect_commit");
  sha(value.source?.mdbase_rs_commit, "source.mdbase_rs_commit");
  sha256(value.source?.inputs_sha256?.pnpm_lock, "source.inputs_sha256.pnpm_lock");
  sha256(value.source?.inputs_sha256?.cargo_lock, "source.inputs_sha256.cargo_lock");
  sha256(value.source?.inputs_sha256?.mdbase_rs_revision_file, "source.inputs_sha256.mdbase_rs_revision_file");
  sha256(value.source?.inputs_sha256?.workflow, "source.inputs_sha256.workflow");
  httpUrl(value.source?.run_url, "source.run_url");
  if (!value.observations?.engine || !value.observations?.connect || !value.observations?.mirror) throw new Error("observation is incomplete");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeOnceOrEqual(path, contents) {
  try {
    const existing = await readFile(path, "utf8");
    if (existing !== contents) throw new Error(`refusing to replace different history result: ${basename(path)}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await writeFile(path, contents);
  }
}

async function mkdirFor(path) {
  const index = path.lastIndexOf("/");
  if (index > 0) await mkdir(path.slice(0, index), { recursive: true });
}

function requireOptions(values, names) {
  for (const name of names) if (!values[name]) throw new Error(`missing --${name}`);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}
function nonEmpty(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}
function exactString(value, expected, label) {
  if (value !== expected) throw new Error(`${label} must be ${expected}`);
  return value;
}
function nullableString(value, label) {
  return value === null || value === undefined || value === "" ? null : nonEmpty(value, label);
}
function stringList(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array`);
  return value.map((item, index) => nonEmpty(item, `${label}[${index}]`));
}
function finite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}
function nullableFinite(value, label) {
  return value === null || value === undefined ? null : finite(value, label);
}
function positiveInteger(value, label) {
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}
function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}
function nullableNonNegativeInteger(value, label) {
  return value === null || value === undefined ? null : nonNegativeInteger(value, label);
}
function boolean(value, label) {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}
function parseBoolean(value, label) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${label} must be true or false`);
}
function sha(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) throw new Error(`${label} must be a 40-character lowercase SHA`);
  return value;
}
function sha256(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${label} must be a lowercase SHA-256`);
  return value;
}
function isoTimestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp`);
  return value;
}
function httpUrl(value, label) {
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error();
    return value;
  } catch {
    throw new Error(`${label} must be an HTTP URL`);
  }
}
function escapeMarkdown(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("`", "\\`").replaceAll("\n", " ");
}
function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "n/a";
}
function bytes(value) {
  return typeof value === "number" && Number.isFinite(value) ? `${(value / 2 ** 20).toFixed(2)} MiB` : "n/a";
}
function environmentLabel(value) {
  if (!value) return "not recorded";
  return [value.runner_os, value.runner_arch, value.runner_image, value.cpu_model].filter(Boolean).map(escapeMarkdown).join(" · ");
}
