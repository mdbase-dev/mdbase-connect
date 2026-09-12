import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const script = join(import.meta.dirname, "..", "performance-results.mjs");
const mirrorProfile = join(import.meta.dirname, "..", "mirror-profile.mjs");
const connectCommit = "a".repeat(40);
const mdbaseCommit = "b".repeat(40);

function engine() {
  return {
    tool: "mdbase-profile-engine",
    version: "0.3.0",
    generated_at: "2026-09-03T01:02:03.000Z",
    total_runtime_ms: 123,
    config: {
      scenario: "all", files: 5000, projects: 80, rename_refs: 100,
      seed: 42, fixture_root: "/secret/fixture"
    },
    fixture: { kept: true, task_files: 5000, project_files: 80, rename_reference_files: 100 },
    operations: [{
      name: "query|page", iterations: 5, total_ms: 50, min_ms: 8,
      mean_ms: 10, p50_ms: 9, p95_ms: 12, p99_ms: 13, max_ms: 14,
      stddev_ms: 2, ops_per_sec: 100,
      phases: { load: { mean_ms: 2, p95_ms: 3, max_ms: 4, secret: "discard" } },
      counters: { records: 5000 }, arbitrary_payload: { body: "discard" }
    }]
  };
}

function connect() {
  return {
    tool: "mdbase-profile-connect", version: "0.1.0-beta.94", scenario: "all",
    iterations: 5, concurrency: 4,
    operations: [{
      name: "query_page_200", iterations: 5, total_ms: 25, min_ms: 4,
      mean_ms: 5, p50_ms: 5, p95_ms: 6, max_ms: 7,
      operations_per_second: 200
    }]
  };
}

function mirror() {
  return {
    profile_version: 1,
    runtime: { node: "v24.0.0", platform: "linux-x64", gc_exposed: true },
    parameters: {
      records: 10000, changes: 100, rounds: 3, snapshot_page_size: 200,
      body_only_percent: 50, adapters: ["node", "portable"]
    },
    samples: [{
      name: "node_read_only_initial", wall_ms: 20, peak_heap_delta_mib: 3,
      peak_rss_delta_mib: 4, retained_heap_delta_mib: 1,
      heap_after_delta_mib: 2, fs_reads: 1, fs_writes: 2, fs_removes: 0,
      fs_lists: 1, state_reads: 1, state_writes: 1,
      transport_calls: { open_session: 1, snapshot: 50, file_snapshot: 0, changes: 0, mutate: 0 }
    }]
  };
}

function environment() {
  return {
    schema_version: 1, kind: "github-runner-environment", runner_os: "Linux",
    runner_arch: "X64", runner_name: "GitHub Actions 1", runner_image: "ubuntu24",
    cpu_model: "Test CPU", logical_cpus: 4, kernel: "Linux test",
    node: "v24.0.0", pnpm: "11.15.1", rustc: "rustc 1.94.0"
  };
}

function provider() {
  return {
    schema_version: 1,
    tool: "mdbase-provider-e2e-performance",
    generated_at: "2026-09-03T01:12:03.000Z",
    parameters: {
      bulk_records: 10000,
      records_before_bulk: 3,
      final_records: 10003,
      warm_samples: 25,
      percentile_method: "nearest-rank-floor"
    },
    metrics: {
      records: 10003,
      mutation_p95_ms: 20,
      snapshot_ms: 500,
      change_page_p95_ms: 10,
      warm_read_p95_ms: 4,
      warm_query_p95_ms: 8,
      rss_before_bytes: 1048576,
      pss_before_bytes: 524288,
      rss_after_queries_bytes: 2097152,
      pss_after_queries_bytes: 1048576,
      cold_read_ms: 15,
      cold_read_rss_delta_bytes: 100,
      cold_read_scanned_records: 1,
      cold_read_records_fetched: 1,
      cold_read_ciphertext_bytes: 200,
      cold_read_used_authority_bulk_materialization: false,
      cold_query_ms: 30,
      cold_query_rss_delta_bytes: 300,
      cold_query_scanned_records: 10003,
      cold_query_ciphertext_bytes: 400,
      measured_working_set_plaintext_bytes: 500,
      measured_scanned_records: 10003,
      measured_ciphertext_bytes: 600,
      measured_cgroup_current_bytes: 700,
      measured_cgroup_peak_bytes: 800,
      private_record_body: "must not persist"
    }
  };
}

async function fixtures(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "mdbase-performance-results-"));
  const values = {
    engine: engine(), connect: connect(), mirror: mirror(), environment: environment(),
    provider: options.provider ? provider() : null
  };
  for (const [name, value] of Object.entries(values)) {
    if (value) await writeFile(join(root, `${name}.json`), JSON.stringify(value));
  }
  return root;
}

function assembleArgs(root, options = {}) {
  const args = [
    script, "assemble",
    "--engine", join(root, "engine.json"),
    "--connect", join(root, "connect.json"),
    "--mirror", join(root, "mirror.json"),
    "--environment", join(root, "environment.json"),
    "--output", join(root, "observation.json"),
    "--summary", join(root, "summary.md"),
    "--repository", "mdbase-dev/mdbase-connect",
    "--commit", connectCommit,
    "--mdbase-rs-commit", mdbaseCommit,
    "--pnpm-lock-sha256", "c".repeat(64),
    "--cargo-lock-sha256", "d".repeat(64),
    "--revision-file-sha256", "e".repeat(64),
    "--workflow-sha256", "f".repeat(64),
    "--event", "schedule",
    "--run-id", options.runId ?? "123",
    "--run-attempt", options.runAttempt ?? "1",
    "--run-url", "https://github.com/mdbase-dev/mdbase-connect/actions/runs/123",
    "--profile-size", "5000",
    "--profile-iterations", "5",
    "--profile-concurrency", "4",
    "--provider-requested", String(Boolean(options.provider))
  ];
  if (options.provider) {
    args.push(
      "--provider", join(root, "provider.json"),
      "--provider-environment", join(root, "environment.json")
    );
  }
  return args;
}

test("mirror profiler implements the current text-read filesystem port", async () => {
  const { stdout } = await execute(process.execPath, [
    "--expose-gc", mirrorProfile,
    "--records", "10", "--changes", "2", "--rounds", "1", "--adapter", "both"
  ]);
  const report = JSON.parse(stdout);
  assert.equal(report.profile_version, 1);
  assert.equal(report.samples.length, 10);
  assert.deepEqual(
    [...new Set(report.samples.map((sample) => sample.name.split("_")[0]))],
    ["node", "portable"]
  );
});

test("assembles allowlisted core observations and an informational summary", async () => {
  const root = await fixtures();
  await execute(process.execPath, assembleArgs(root));
  const observation = JSON.parse(await readFile(join(root, "observation.json"), "utf8"));
  const summary = await readFile(join(root, "summary.md"), "utf8");

  assert.equal(observation.informational_only, true);
  assert.equal(observation.observations.engine.operations[0].operations_per_second, 100);
  assert.equal(observation.observations.connect.operations[0].latency_ms.p99, null);
  assert.equal(observation.observations.provider_10k, null);
  assert.equal(observation.observations.engine.config.fixture_root, undefined);
  assert.equal(observation.observations.engine.operations[0].arbitrary_payload, undefined);
  assert.doesNotMatch(JSON.stringify(observation), /secret|discard/);
  assert.match(summary, /Informational only/);
  assert.match(summary, /query\\\|page/);
  assert.match(summary, /Not requested for this observation/);
  assert.doesNotMatch(summary, /regression|faster|slower/i);
});

test("normalizes optional provider metrics without arbitrary provider fields", async () => {
  const root = await fixtures({ provider: true });
  await execute(process.execPath, assembleArgs(root, { provider: true }));
  const observation = JSON.parse(await readFile(join(root, "observation.json"), "utf8"));
  const summary = await readFile(join(root, "summary.md"), "utf8");

  assert.equal(observation.observations.provider_10k.parameters.bulk_records, 10000);
  assert.equal(observation.observations.provider_10k.latency_ms.warm_query_p95, 8);
  assert.equal(observation.observations.provider_10k.invariants.cold_read_used_authority_bulk_materialization, false);
  assert.doesNotMatch(JSON.stringify(observation), /private_record_body|must not persist/);
  assert.match(summary, /Hosted provider 10k/);
  assert.match(summary, /2\.00 MiB/);
});

test("records reruns idempotently in durable year/month history", async () => {
  const root = await fixtures();
  await execute(process.execPath, assembleArgs(root));
  const history = join(root, "history");
  const recordArgs = [
    script, "record", "--observation", join(root, "observation.json"),
    "--summary", join(root, "summary.md"), "--history-dir", history
  ];
  await execute(process.execPath, recordArgs);
  await execute(process.execPath, recordArgs);

  const index = JSON.parse(await readFile(join(history, "index.json"), "utf8"));
  assert.equal(index.schema_version, 1);
  assert.equal(index.results.length, 1);
  assert.equal(index.results[0].observation_id, "run-123-attempt-1");
  assert.equal(index.results[0].file, "results/2026/09/run-123-attempt-1.json");
  assert.match(await readFile(join(history, "README.md"), "utf8"), /informational/i);

  const changed = JSON.parse(await readFile(join(root, "observation.json"), "utf8"));
  changed.inputs.profile_size = 10000;
  await writeFile(join(root, "observation.json"), JSON.stringify(changed));
  await assert.rejects(
    execute(process.execPath, recordArgs),
    /refusing to replace different history result/
  );
});

test("rejects malformed producer identity, non-finite data, and missing provider output", async () => {
  const badIdentity = await fixtures();
  const badEngine = engine();
  badEngine.tool = "unknown";
  await writeFile(join(badIdentity, "engine.json"), JSON.stringify(badEngine));
  await assert.rejects(
    execute(process.execPath, assembleArgs(badIdentity)),
    /unsupported producer identity/
  );

  const badNumber = await fixtures();
  const badConnect = connect();
  badConnect.operations[0].mean_ms = null;
  await writeFile(join(badNumber, "connect.json"), JSON.stringify(badConnect));
  await assert.rejects(
    execute(process.execPath, assembleArgs(badNumber)),
    /must be finite/
  );

  const missingProvider = await fixtures();
  const args = assembleArgs(missingProvider);
  args[args.length - 1] = "true";
  await assert.rejects(
    execute(process.execPath, args),
    /provider request and provider result/
  );
});
