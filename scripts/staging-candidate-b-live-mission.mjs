#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";

const execFileAsync = promisify(execFile);
const STAGING_ORIGIN = "https://connect-staging.mdbase.dev";
const FIXTURE_PREFIX = "candidate-b-live-v1";

function fail(message) {
  throw new Error(message);
}

function parsePositiveInteger(value, label, maximum) {
  if (!/^[1-9][0-9]*$/u.test(value ?? "")) fail(`${label} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    fail(`${label} must be at most ${maximum}.`);
  }
  return parsed;
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) {
      fail(`Every mission option requires one value (near ${flag ?? "end of arguments"}).`);
    }
    values.set(flag.slice(2), value);
  }
  const collectionId = values.get("collection");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(collectionId ?? "")) {
    fail("--collection must be a lowercase UUID.");
  }
  const stateDir = values.get("state-dir");
  if (!isAbsolute(stateDir ?? "") || !stateDir.startsWith("/dev/shm/mdbase-candidate-b-")) {
    fail("--state-dir must be an isolated /dev/shm/mdbase-candidate-b-* directory.");
  }
  const cli = resolve(values.get("cli") ?? "target/debug/mdbase");
  const output = values.get("output");
  if (!isAbsolute(output ?? "")) fail("--output must be an absolute path.");
  const expectedVersion = values.get("expected-version");
  if (!/^0\.1\.0-beta\.[1-9][0-9]*$/u.test(expectedVersion ?? "")) {
    fail("--expected-version must be an exact 0.1.0-beta.N release.");
  }
  const expectedCollectionName = values.get("collection-name");
  if (!expectedCollectionName || expectedCollectionName.length > 200) {
    fail("--collection-name must identify the isolated staging collection.");
  }
  const resumeValue = values.get("resume") ?? "disabled";
  if (!["disabled", "enabled"].includes(resumeValue)) fail("--resume must be enabled or disabled.");
  return {
    collectionId,
    stateDir,
    cli,
    output,
    expectedVersion,
    expectedCollectionName,
    records: parsePositiveInteger(values.get("records") ?? "2505", "--records", 9_000),
    concurrency: parsePositiveInteger(values.get("concurrency") ?? "16", "--concurrency", 32),
    resume: resumeValue === "enabled"
  };
}

function percentile(values, percentileValue) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1)] ?? 0;
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function missionRecord(index) {
  const padded = String(index).padStart(6, "0");
  const statuses = ["open", "in-progress", "done", "cancelled"];
  const priorities = [1, 2, 3, 4, 5];
  const path = `${FIXTURE_PREFIX}/tasks/task-${padded}.md`;
  const frontmatter = {
    title: `Synthetic task ${padded}`,
    type: "task",
    status: statuses[index % statuses.length],
    priority: priorities[index % priorities.length],
    due: `2026-${String((index % 12) + 1).padStart(2, "0")}-${String((index % 28) + 1).padStart(2, "0")}`,
    contexts: [`context-${index % 17}`, `context-${index % 31}`],
    project: `project-${index % 43}`,
    recurrence: index % 11 === 0 ? "FREQ=WEEKLY" : null,
    tags: ["candidate-b-mission", `shard-${index % 29}`]
  };
  const body = [
    `# Synthetic task ${padded}`,
    "",
    `Deterministic mission body needle-${index % 97}.`,
    "#mission-body",
    "[[../../../targets/alpha|Alpha alias label]]",
    "[Alpha markdown](../../../targets/alpha.md#alpha)",
    index % 13 === 0 ? "![[../../../targets/alpha#Alpha]]" : "",
    index % 19 === 0 ? "[[missing-mission-target]]" : ""
  ].filter(Boolean).join("\n") + "\n";
  return { path, frontmatter, body, types: ["task"] };
}

function envelopeValue(value, operation) {
  if (value?.valid !== true || value?.result === undefined) {
    fail(`${operation} did not return a valid canonical envelope: ${JSON.stringify(value)}`);
  }
  return value.result;
}

function diagnosticCodes(value) {
  return (value?.diagnostics ?? []).map((diagnostic) => diagnostic?.code).filter(Boolean);
}

async function main() {
  const startedAt = new Date().toISOString();
  const options = parseArguments(process.argv.slice(2));
  const apply = process.env.MDBASE_CANDIDATE_B_STAGING_MISSION_APPLY;
  if (apply !== `staging:${options.collectionId}`) {
    fail(`Set MDBASE_CANDIDATE_B_STAGING_MISSION_APPLY=staging:${options.collectionId}.`);
  }
  const cloud = JSON.parse(await readFile(resolve(options.stateDir, "cloud.json"), "utf8"));
  if (cloud.server_url !== STAGING_ORIGIN) fail("The isolated CLI profile is not bound to staging.");

  const childEnvironment = {
    ...process.env,
    MDBASE_CONNECT_ENV: "test",
    MDBASE_CONNECT_SECRET_BACKEND: "insecure-test-file"
  };
  const baseArguments = [
    "connect", "--state-dir", options.stateDir, "--json", "operation", options.collectionId
  ];
  const runCli = async (argumentsList, timeout = 30_000) => {
    const started = performance.now();
    const { stdout, stderr } = await execFileAsync(options.cli, argumentsList, {
      env: childEnvironment,
      timeout,
      maxBuffer: 8 * 1024 * 1024
    });
    if (stderr.trim()) fail(`mdbase wrote unexpected stderr: ${stderr.trim()}`);
    return { value: JSON.parse(stdout), elapsedMs: performance.now() - started };
  };
  const operation = async (name, input, timeout) => runCli(
    [...baseArguments, name, "--input", JSON.stringify(input)],
    timeout
  );

  const version = JSON.parse((await execFileAsync(options.cli, ["version", "--json"], {
    env: childEnvironment
  })).stdout);
  if (version.cli !== options.expectedVersion || version.operation_transport_protocol !== 3) {
    fail(`The mission requires the exact ${options.expectedVersion}/v3 CLI, got ${JSON.stringify(version)}.`);
  }
  const described = (await operation("describe", {})).value;
  if (described.collection_id !== options.collectionId || described.display_name !== options.expectedCollectionName) {
    fail("The authorized collection is not the isolated Candidate B staging fixture.");
  }

  const folderPredicate = `file.inFolder("${FIXTURE_PREFIX}/tasks")`;
  const fixtures = Array.from({ length: options.records }, (_, index) => missionRecord(index));
  const fixturesByPath = new Map(fixtures.map((fixture) => [fixture.path, fixture]));
  const fixtureDigest = sha256(fixtures.map((fixture) => JSON.stringify(fixture)).join("\n"));
  const existingPaths = new Set();
  let existingCursor;
  do {
    const existingPage = envelopeValue((await operation("query", {
      where: folderPredicate,
      order_by: [{ field: "file.path", direction: "asc" }],
      pagination: "cursor",
      ...(existingCursor ? { cursor: existingCursor } : {}),
      include_body: true,
      frontmatter_mode: "both",
      limit: 500
    })).value, "preflight query");
    for (const record of existingPage.results) {
      const expected = fixturesByPath.get(record.path);
      if (!expected
          || !isDeepStrictEqual(record.frontmatter, expected.frontmatter)
          || !isDeepStrictEqual(record.types, expected.types)
          || record.body !== expected.body) {
        fail(`The existing fixture record ${record.path} does not match this deterministic run.`);
      }
      existingPaths.add(record.path);
    }
    existingCursor = existingPage.meta?.cursor;
  } while (existingCursor);
  if (existingPaths.size !== 0 && !options.resume) {
    fail(`The ${FIXTURE_PREFIX} fixture prefix is not empty.`);
  }

  const createLatencies = [];
  let providerInternalErrors = 0;
  let nextIndex = 0;
  let stopWorkers = false;
  const errorCode = (error) => {
    try {
      return JSON.parse(error?.stdout ?? "")?.error?.code;
    } catch {
      return undefined;
    }
  };
  const createFixture = async (fixture, index) => {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const started = performance.now();
      try {
        const created = await operation("create", fixture);
        const record = envelopeValue(created.value, `create ${index}`);
        if (record.path !== fixture.path || !record.revision?.startsWith("sha256:")) {
          fail(`Create ${index} returned the wrong record identity.`);
        }
        return performance.now() - started;
      } catch (error) {
        if (errorCode(error) !== "provider_internal_error") throw error;
        providerInternalErrors += 1;
        try {
          const recovered = envelopeValue((await operation("read", { path: fixture.path })).value, `reconcile create ${index}`);
          if (recovered.path === fixture.path
            && recovered.frontmatter?.title === fixture.frontmatter.title
            && recovered.body === fixture.body) {
            return performance.now() - started;
          }
        } catch {
          // A missing read is the expected retry case after a failed create.
        }
        if (attempt === 5) throw error;
        await new Promise((resolveRetry) => setTimeout(resolveRetry, 100 * 2 ** (attempt - 1)));
      }
    }
    fail(`Create ${index} exhausted its bounded retry loop.`);
  };
  const workers = Array.from({ length: options.concurrency }, async () => {
    while (!stopWorkers) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= fixtures.length) return;
      if (existingPaths.has(fixtures[index].path)) continue;
      try {
        createLatencies.push(await createFixture(fixtures[index], index));
      } catch (error) {
        stopWorkers = true;
        throw error;
      }
    }
  });
  await Promise.all(workers);
  if (providerInternalErrors !== 0) {
    fail(`The provider returned ${providerInternalErrors} internal error(s) during concurrent fixture creation.`);
  }

  const queryBase = {
    types: ["task"],
    where: folderPredicate,
    order_by: [{ field: "file.path", direction: "asc" }],
    pagination: "cursor"
  };
  const firstPage = envelopeValue((await operation("query", { ...queryBase, limit: 17 })).value, "first cursor page");
  if (firstPage.results.length !== 17 || !firstPage.meta?.cursor || firstPage.meta.total_count !== options.records) {
    fail("The first cursor page did not bind the complete deterministic fixture.");
  }

  const lateRecord = {
    ...missionRecord(options.records),
    path: `${FIXTURE_PREFIX}/tasks/task-snapshot-late.md`,
    frontmatter: { ...missionRecord(options.records).frontmatter, title: "Snapshot-late task" }
  };
  envelopeValue((await operation("create", lateRecord)).value, "snapshot-late create");

  const seenPaths = firstPage.results.map((record) => record.path);
  const pageSizes = [firstPage.results.length];
  let cursor = firstPage.meta.cursor;
  while (cursor) {
    const page = envelopeValue((await operation("query", { ...queryBase, cursor, limit: 43 })).value, "next cursor page");
    seenPaths.push(...page.results.map((record) => record.path));
    pageSizes.push(page.results.length);
    cursor = page.meta?.cursor ?? null;
  }
  if (seenPaths.length !== options.records || seenPaths.includes(lateRecord.path)) {
    fail("The generation-pinned cursor did not preserve snapshot-head stability.");
  }
  if (new Set(seenPaths).size !== seenPaths.length || !seenPaths.every((path, index) => index === 0 || seenPaths[index - 1] < path)) {
    fail("Cursor traversal was not unique and canonically ordered.");
  }

  const fresh = envelopeValue((await operation("query", {
    ...queryBase, pagination: undefined, limit: 1
  })).value, "fresh query");
  if (fresh.meta?.total_count !== options.records + 1) fail("A fresh query did not observe the concurrent write.");

  const releasable = envelopeValue((await operation("query", { ...queryBase, limit: 5 })).value, "releasable cursor");
  const released = await operation("query", { release_cursor: releasable.meta.cursor });
  envelopeValue(released.value, "cursor release");
  const reused = (await operation("query", { ...queryBase, cursor: releasable.meta.cursor, limit: 5 })).value;
  if (reused.valid !== false || !diagnosticCodes(reused).some((code) => code.includes("cursor"))) {
    fail("A released cursor did not fail with a typed cursor diagnostic.");
  }

  const bodySuccess = (await operation("query", {
    ...queryBase,
    where: `${folderPredicate} && record.priority == 1 && file.body.lower().contains('deterministic mission body')`,
    include_body: true,
    limit: 20
  }, 60_000)).value;
  const bodyResult = envelopeValue(bodySuccess, "bounded body query");
  if (bodyResult.results.length !== 20 || bodyResult.results.some((record) => !record.body?.includes("Deterministic mission body"))) {
    fail("The bounded exact/body query returned incomplete exact documents.");
  }

  const bodyBudget = (await operation("query", {
    ...queryBase,
    where: `${folderPredicate} && file.body.lower().contains('needle-that-does-not-exist')`,
    limit: 20
  }, 60_000)).value;
  if (bodyBudget.valid !== false || !diagnosticCodes(bodyBudget).includes("hosted_exact_document_budget_exceeded")) {
    fail(`The unbounded body residual did not return its typed exact-document budget: ${JSON.stringify(bodyBudget)}`);
  }

  const grouped = envelopeValue((await operation("query", {
    types: ["task"],
    where: folderPredicate,
    group_by: [{ field: "record.status" }],
    summaries: [{ field: "record.priority", function: "sum", name: "priority_sum" }],
    limit: 25
  })).value, "grouped query");
  if (!Array.isArray(grouped.meta?.groups) || grouped.meta.groups.length !== 4) {
    fail("The bounded grouped query did not return four deterministic status groups.");
  }

  const casPath = `${FIXTURE_PREFIX}/cas/source.md`;
  const casCreated = envelopeValue((await operation("create", {
    path: casPath,
    frontmatter: { title: "CAS source", type: "task", status: "open" },
    body: `[[../target|CAS target alias]]\n`,
    types: ["task"]
  })).value, "CAS create");
  const casUpdated = envelopeValue((await operation("update", {
    path: casPath,
    patch: { status: "done" },
    if_revision: casCreated.revision
  })).value, "CAS update");
  const stale = (await operation("update", {
    path: casPath,
    patch: { status: "cancelled" },
    if_revision: casCreated.revision
  })).value;
  if (stale.valid !== false || !diagnosticCodes(stale).includes("concurrent_modification")) {
    fail("A stale CAS update did not return a typed revision diagnostic.");
  }
  const renamedPath = `${FIXTURE_PREFIX}/cas/renamed.md`;
  const renamed = envelopeValue((await operation("rename", {
    from: casPath,
    to: renamedPath,
    update_refs: true,
    if_revision: casUpdated.revision
  })).value, "CAS rename");
  envelopeValue((await operation("delete", {
    path: renamedPath,
    if_revision: renamed.revision,
    check_backlinks: true
  })).value, "CAS delete");

  const changes = (await operation("changes", { after: 0, limit: 200 })).value;
  if (!Array.isArray(changes.changes) || changes.changes.length === 0) fail("The change stream returned no live mutations.");

  const cancellationStarted = performance.now();
  const cancellation = await new Promise((resolveCancellation, rejectCancellation) => {
    const child = spawn(options.cli, [
      ...baseArguments,
      "query",
      "--input",
      JSON.stringify({
        ...queryBase,
        where: `${folderPredicate} && file.body.lower().contains('cancellation-never-matches')`,
        limit: 20
      })
    ], { env: childEnvironment, stdio: ["ignore", "ignore", "ignore"] });
    const timer = setTimeout(() => child.kill("SIGTERM"), 40);
    child.once("error", rejectCancellation);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveCancellation({ code, signal, elapsedMs: performance.now() - cancellationStarted });
    });
  });
  if (cancellation.signal !== "SIGTERM") fail("The cancellation probe did not interrupt the live client request.");
  envelopeValue((await operation("query", { ...queryBase, limit: 1 })).value, "post-cancellation query");

  const finishedAt = new Date().toISOString();
  const report = {
    format: "mdbase-candidate-b-live-staging-mission/v1",
    environment: "isolated-staging",
    connect_origin: STAGING_ORIGIN,
    collection_id: options.collectionId,
    collection_name: described.display_name,
    fixture_prefix: FIXTURE_PREFIX,
    fixture_digest: fixtureDigest,
    started_at: startedAt,
    finished_at: finishedAt,
    cli_version: version,
    records_created: createLatencies.length + 2,
    fixture_records_resumed: existingPaths.size,
    deterministic_fixture_records: options.records,
    concurrency: options.concurrency,
    create_latency_ms: createLatencies.length === 0 ? null : {
      minimum: Math.min(...createLatencies),
      p50: percentile(createLatencies, 0.5),
      p95: percentile(createLatencies, 0.95),
      p99: percentile(createLatencies, 0.99),
      maximum: Math.max(...createLatencies)
    },
    provider_internal_errors: providerInternalErrors,
    cursor: {
      first_page_size: 17,
      subsequent_page_size: 43,
      pages: pageSizes.length,
      traversed_records: seenPaths.length,
      snapshot_late_record_excluded: true,
      fresh_total_after_concurrent_write: fresh.meta.total_count,
      early_release_typed_failure: diagnosticCodes(reused)
    },
    body: {
      successful_exact_page_items: bodyResult.results.length,
      budget_failure: diagnosticCodes(bodyBudget)
    },
    grouping: { groups: grouped.meta.groups.length },
    cas: { stale_failure: diagnosticCodes(stale), create_update_rename_delete: true },
    changes_observed: changes.changes.length,
    cancellation: { ...cancellation, post_cancel_query: "passed" }
  };
  await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({
    status: "passed",
    output: options.output,
    fixture_digest: fixtureDigest,
    records: options.records,
    cursor_pages: pageSizes.length,
    typed_budget: diagnosticCodes(bodyBudget)
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
