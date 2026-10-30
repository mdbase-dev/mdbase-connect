import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { markerSha256, runCanary } from "../hosted-read-canary.mjs";

const COLLECTION = "01900000-0000-7000-8000-000000000000";
const ORIGIN = "https://connect.example";
const NAME = "Status marker";
const MARKER_PATH = "status/canary.md";
const DOCUMENT = "---\ntype: status\n---\noperational\n";
const SECRET = "super-secret-response-value";

// A fake `mdbase` CLI. `status` answers "connecting" twice before the account
// relay and hosted log report online, so polling is exercised on every run.
const FAKE_CLI = `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const mode = process.env.FAKE_CLI_MODE ?? "success";
const args = process.argv.slice(2);
const stateDir = args[args.indexOf("--state-dir") + 1];
const command = args.slice(args.indexOf("--json") + 1).join(" ");
const counter = join(stateDir, "status-calls");
appendFileSync(join(stateDir, "calls"), command + "\\n");
const fail = (code, reason) => {
  process.stdout.write(JSON.stringify({error:{code,reason,message:"${SECRET}"}}));
  process.exit(1);
};
if (mode === "timeout" && command === "status") setTimeout(() => {}, 10000);
else if (mode === "cli-failure" && command === "daemon start") { process.stderr.write("${SECRET}"); process.exit(1); }
else if (mode === "signal" && command === "daemon start") process.kill(process.pid, "SIGTERM");
else if (mode === "output-limit" && command === "status") process.stdout.write("${SECRET}".repeat(60000));
else if (mode === "malformed" && command === "status") process.stdout.write("${SECRET} not-json");
else if (mode === "start-failed" && command === "daemon start") fail("unavailable", "start_failed");
else if (mode === "unknown-reason" && command === "daemon start") fail("unavailable", "${SECRET}");
else if (mode === "stop-failed" && command === "daemon stop") fail("unavailable", "daemon_unreachable");
else if (command === "daemon start") process.stdout.write(JSON.stringify({readiness:{ready:true},started:mode !== "already-running"}));
else if (command === "daemon stop") process.stdout.write(JSON.stringify({stopped:true}));
else if (command === "status") {
  // A status call slower than the time left before the deadline.
  if (mode === "slow-offline") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
  let calls = 0;
  try { calls = Number(readFileSync(counter, "utf8")); } catch {}
  writeFileSync(counter, String(calls + 1));
  const ready = calls >= 2 && mode !== "log-offline";
  const collection = {
    id: "${COLLECTION}", name: mode === "renamed" ? "Other" : "${NAME}",
    root: process.env.FAKE_ROOT, mode: mode === "local" ? "local" : "synced",
    log: mode === "local" ? "none" : "hosted", origin: "joined",
    state: mode === "failed" ? "failed" : "ready", notices: [],
    sync: {
      confirmed_through: mode === "behind" ? 3 : 4, head_known: 4, pending: 0,
      holds: mode === "held" ? 1 : 0, unresolved: 0,
      connection: ready ? "online" : "connecting", resyncing: false
    }
  };
  process.stdout.write(JSON.stringify({
    readiness: {ready:true}, pid: 1, target: "isolated_profile", state_dir: stateDir,
    started_at_ms: 1, secret_backend: mode === "insecure" ? "insecure-test-file" : "keychain",
    account: {
      signed_in: mode !== "signed-out", online: calls >= 1 && mode !== "account-offline" && mode !== "slow-offline",
      server: mode === "other-origin" ? "https://connect-lab.example" : "${ORIGIN}",
      account_id: "${SECRET}", environment: "production",
      ...(mode === "account-error" ? {last_error: "${SECRET}"} : {})
    },
    collections: mode === "missing" ? [] : [collection]
  }));
} else process.exit(2);
`;

async function fixture(t, { document = DOCUMENT } = {}) {
  const root = await mkdtemp(resolve(tmpdir(), "mdbase-hosted-canary-"));
  const stateDir = resolve(root, "state");
  const collectionRoot = resolve(root, "collection");
  const cli = resolve(root, "mdbase-fake.cjs");
  await mkdir(stateDir);
  await mkdir(resolve(collectionRoot, "status"), { recursive: true });
  await writeFile(resolve(collectionRoot, MARKER_PATH), document);
  await writeFile(cli, FAKE_CLI);
  await chmod(cli, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, stateDir, collectionRoot, cli };
}

function argumentsFor({ stateDir, cli }, overrides = {}) {
  const values = {
    environment: "production",
    cli,
    "state-dir": stateDir,
    "expected-origin": ORIGIN,
    collection: COLLECTION,
    "expected-collection-name": NAME,
    "marker-path": MARKER_PATH,
    "expected-marker-sha256": markerSha256(Buffer.from(DOCUMENT, "utf8")),
    "timeout-ms": "3000",
    ...overrides
  };
  return Object.entries(values).flatMap(([name, value]) => [`--${name}`, value]);
}

async function invoke(options, overrides = {}, environment = {}) {
  const { exitCode, result } = await runCanary(
    argumentsFor(options, overrides),
    { ...process.env, FAKE_ROOT: options.collectionRoot, ...environment }
  );
  return { code: exitCode, json: result, text: `${JSON.stringify(result)}\n` };
}

async function calls(options) {
  return (await readFile(resolve(options.stateDir, "calls"), "utf8").catch(() => ""))
    .split("\n").filter(Boolean);
}

function assertPrivate(result, options) {
  for (const forbidden of [SECRET, options.root, options.stateDir, options.collectionRoot, DOCUMENT]) {
    assert.equal(result.text.includes(forbidden), false);
  }
}

test("reports a fresh hosted read of the marker and stops its daemon", async (t) => {
  const options = await fixture(t);
  const result = await invoke(options);
  assert.equal(result.code, 0);
  assert.deepEqual(result.json.stages.map(({ name, status }) => ({ name, status })), [
    { name: "config", status: "operational" },
    { name: "registration", status: "operational" },
    { name: "connections", status: "operational" },
    { name: "describe", status: "operational" },
    { name: "read", status: "operational" },
    { name: "digest", status: "operational" },
    { name: "shutdown", status: "operational" }
  ]);
  assert.equal(result.json.schema_version, 1);
  assert.equal(result.json.environment, "production");
  assert.equal(result.json.component, "hosted_canary");
  assert.equal(result.json.status, "operational");
  assert.equal(result.json.error, undefined);
  assert.match(result.json.checked_at, /^\d{4}-\d{2}-\d{2}T/u);
  assert.ok(Number.isInteger(result.json.duration_ms));
  const made = await calls(options);
  assert.equal(made[0], "daemon start");
  assert.equal(made.at(-1), "daemon stop");
  assert.ok(made.filter((call) => call === "status").length >= 3);
  assertPrivate(result, options);
});

test("rejects missing, malformed, duplicate, or unsafe configuration before running the CLI", async (t) => {
  const options = await fixture(t);
  for (const overrides of [
    { collection: "not-a-uuid" },
    { "expected-origin": "https://connect.example/" },
    { "marker-path": "../escape.md" },
    { "marker-path": "/absolute.md" },
    { "marker-path": "status\\canary.md" },
    { "expected-marker-sha256": "sha256:abc" },
    { "timeout-ms": "300001" },
    { cli: "relative/mdbase" },
    { "state-dir": "relative/state" },
    { environment: "Production" }
  ]) {
    const result = await invoke(options, overrides);
    assert.equal(result.code, 2);
    assert.deepEqual(result.json.error, { stage: "config", code: "invalid_config" });
  }
  const duplicate = await runCanary(
    [...argumentsFor(options), "--collection", COLLECTION],
    { ...process.env }
  );
  assert.equal(duplicate.exitCode, 2);
  const mixed = await invoke(options, {}, { MDBASE_HOSTED_CANARY_COLLECTION: COLLECTION });
  assert.equal(mixed.code, 2);
  for (const name of ["MDBASE_HOME", "MDBASE_ENV", "MDBASE_SECRET_BACKEND"]) {
    const override = await invoke(options, {}, { [name]: "x" });
    assert.equal(override.code, 2);
    assert.deepEqual(override.json.error, { stage: "config", code: "environment_override" });
  }
  const missingCli = await invoke(options, { cli: resolve(options.root, "missing") });
  assert.deepEqual(missingCli.json.error, { stage: "config", code: "cli_unavailable" });
  const missingState = await invoke(options, { "state-dir": resolve(options.root, "missing") });
  assert.deepEqual(missingState.json.error, { stage: "config", code: "state_unavailable" });
  assert.deepEqual(await calls(options), []);
});

test("accepts every input from its environment variable", async (t) => {
  const options = await fixture(t);
  const environment = {};
  const values = argumentsFor(options);
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index].slice(2).toUpperCase().replaceAll("-", "_");
    environment[`MDBASE_HOSTED_CANARY_${name}`] = values[index + 1];
  }
  const { exitCode } = await runCanary([], { ...process.env, FAKE_ROOT: options.collectionRoot, ...environment });
  assert.equal(exitCode, 0);
});

test("classifies probe failures with fixed codes and always stops an owned daemon", async (t) => {
  for (const [mode, stage, code] of [
    ["start-failed", "registration", "start_failed"],
    ["unknown-reason", "registration", "unavailable"],
    ["cli-failure", "registration", "cli_failed"],
    ["signal", "registration", "cli_signaled"],
    ["insecure", "registration", "insecure_secret_backend"],
    ["signed-out", "registration", "not_signed_in"],
    ["other-origin", "registration", "origin_mismatch"],
    ["account-error", "registration", "account_error"],
    ["account-offline", "registration", "account_offline"],
    ["malformed", "registration", "malformed_json"],
    ["output-limit", "registration", "output_limit"],
    ["missing", "connections", "missing_collection"],
    ["renamed", "connections", "collection_mismatch"],
    ["local", "connections", "collection_mismatch"],
    ["failed", "describe", "collection_failed"],
    ["held", "describe", "holds_present"],
    ["log-offline", "describe", "log_offline"],
    ["behind", "describe", "not_caught_up"]
  ]) {
    const options = await fixture(t);
    const result = await invoke(options, { "timeout-ms": "1500" }, { FAKE_CLI_MODE: mode });
    assert.equal(result.code, 1, mode);
    assert.equal(result.json.status, "failed", mode);
    assert.deepEqual(result.json.error, { stage, code }, mode);
    assert.equal(result.json.stages.at(-1).name, "shutdown", mode);
    assert.equal((await calls(options)).at(-1), "daemon stop", mode);
    assertPrivate(result, options);
  }
});

test("never stops a daemon this run did not start", async (t) => {
  const options = await fixture(t);
  const result = await invoke(options, {}, { FAKE_CLI_MODE: "already-running" });
  assert.equal(result.code, 1);
  assert.deepEqual(result.json.error, { stage: "registration", code: "daemon_already_running" });
  assert.deepEqual(await calls(options), ["daemon start"]);
});

test("reports a failed shutdown after an otherwise operational probe", async (t) => {
  const options = await fixture(t);
  const result = await invoke(options, {}, { FAKE_CLI_MODE: "stop-failed" });
  assert.equal(result.code, 1);
  assert.equal(result.json.status, "failed");
  assert.deepEqual(result.json.error, { stage: "shutdown", code: "daemon_unreachable" });
  assert.ok(result.json.stages.slice(0, 6).every((stage) => stage.status === "operational"));
});

test("a deadline that expires during a poll reports why the probe was waiting", async (t) => {
  const options = await fixture(t);
  const result = await invoke(options, { "timeout-ms": "1000" }, { FAKE_CLI_MODE: "slow-offline" });
  assert.equal(result.code, 1);
  assert.deepEqual(result.json.error, { stage: "registration", code: "account_offline" });
  assert.equal((await calls(options)).at(-1), "daemon stop");
});

test("bounds a hanging CLI by the probe deadline", async (t) => {
  const options = await fixture(t);
  const result = await invoke(options, { "timeout-ms": "300" }, { FAKE_CLI_MODE: "timeout" });
  assert.equal(result.code, 1);
  assert.deepEqual(result.json.error, { stage: "registration", code: "timeout" });
});

test("rejects a changed, missing, or escaping marker without reflecting it", async (t) => {
  const changed = await fixture(t, { document: `${DOCUMENT}${SECRET}\n` });
  const changedResult = await invoke(changed);
  assert.deepEqual(changedResult.json.error, { stage: "digest", code: "digest_mismatch" });
  assertPrivate(changedResult, changed);

  const missing = await fixture(t);
  await rm(resolve(missing.collectionRoot, MARKER_PATH));
  assert.deepEqual((await invoke(missing)).json.error, { stage: "read", code: "marker_missing" });

  const escaping = await fixture(t);
  const outside = resolve(escaping.root, "outside.md");
  await writeFile(outside, DOCUMENT);
  await rm(resolve(escaping.collectionRoot, MARKER_PATH));
  await symlink(outside, resolve(escaping.collectionRoot, MARKER_PATH));
  assert.deepEqual((await invoke(escaping)).json.error, { stage: "read", code: "marker_mismatch" });

  const escapingDirectory = await fixture(t);
  await rm(resolve(escapingDirectory.collectionRoot, "status"), { recursive: true });
  await mkdir(resolve(escapingDirectory.root, "elsewhere"));
  await writeFile(resolve(escapingDirectory.root, "elsewhere", "canary.md"), DOCUMENT);
  await symlink(resolve(escapingDirectory.root, "elsewhere"), resolve(escapingDirectory.collectionRoot, "status"));
  assert.deepEqual((await invoke(escapingDirectory)).json.error, { stage: "read", code: "marker_mismatch" });
});

test("digests the marker's exact bytes", () => {
  assert.equal(
    markerSha256(Buffer.alloc(0)),
    "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  );
});
