import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { probeDocument, publishTimings, runCanary, stageTimings } from "../hosted-sync-canary.mjs";

const COLLECTION = "01900000-0000-7000-8000-000000000000";
const ORIGIN = "https://connect.example";
const NAME = "Sync probe";
const PROBE_PATH = "status/sync-probe.md";
const SECRET = "super-secret-response-value";

// A fake `mdbase` CLI for two profiles, `writer` and `reader`, sharing a
// simulated hosted log in `world.json`. The writer's daemon notices a changed
// probe file on one status call (pending 1) and uploads it on the next, which
// also delivers it to the reader's folder and advances both heads.
const FAKE_CLI = `#!/usr/bin/env node
const { existsSync, readFileSync, renameSync, writeFileSync } = require("node:fs");
const { basename, join } = require("node:path");
const mode = process.env.FAKE_CLI_MODE ?? "success";
const root = process.env.FAKE_ROOT;
const args = process.argv.slice(2);
const stateDir = args[args.indexOf("--state-dir") + 1];
const role = basename(stateDir);
const command = args.slice(args.indexOf("--json") + 1).join(" ");
const fail = (code, reason) => {
  process.stdout.write(JSON.stringify({error:{code,reason,message:"${SECRET}"}}));
  process.exit(1);
};
if (command !== "status") process.exit(2);
if (mode === "not-running" && role === "reader") fail("daemon_not_running");
const worldFile = join(root, "world.json");
const world = JSON.parse(readFileSync(worldFile, "utf8"));
const save = () => {
  writeFileSync(worldFile + "." + process.pid, JSON.stringify(world));
  renameSync(worldFile + "." + process.pid, worldFile);
};
const read = (path) => existsSync(path) ? readFileSync(path, "utf8") : "";
let pending = 0;
if (role === "writer") {
  const content = read(join(root, "writer", "${PROBE_PATH}"));
  if (content !== world.uploaded) {
    if (!world.seen || mode === "stuck") { world.seen = true; pending = 1; }
    else {
      world.head += 1; world.uploaded = content; world.seen = false;
      if (!["reader-stalls", "reader-drops", "held"].includes(mode)) {
        writeFileSync(join(root, "reader", "${PROBE_PATH}"), content);
      }
    }
    save();
  }
}
const moved = world.head > 4;
const offline = (mode === "log-offline") || (mode === "reader-drops" && role === "reader" && moved);
// A reader that lost its log connection hears of no new head.
const head = role === "reader" && (mode === "heads-differ" || offline && moved) ? world.head - 1 : world.head;
process.stdout.write(JSON.stringify({
  readiness: {ready:true}, pid: 1, target: "isolated_profile", state_dir: stateDir,
  started_at_ms: 1, secret_backend: mode === "insecure" ? "insecure-test-file" : "keychain",
  device: {device_id: mode === "same-device" ? "device" : "device-" + role},
  account: {
    signed_in: mode !== "signed-out", online: true,
    server: mode === "other-origin" ? "https://connect-lab.example" : "${ORIGIN}",
    account_id: mode === "other-account" && role === "reader" ? "${SECRET}-other" : "${SECRET}",
    environment: "production"
  },
  collections: mode === "missing" && role === "reader" ? [] : [{
    id: "${COLLECTION}", name: "${NAME}", root: join(root, role), mode: "synced",
    log: "hosted", origin: "joined", state: "ready", notices: [],
    sync: {
      confirmed_through: head, head_known: head, pending,
      holds: mode === "held" && role === "reader" && moved ? 1 : 0, unresolved: 0,
      connection: offline ? "connecting" : "online", resyncing: false
    }
  }]
}));
`;

async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), "mdbase-sync-canary-"));
  const cli = resolve(root, "mdbase-fake.cjs");
  for (const role of ["writer", "reader"]) {
    await mkdir(resolve(root, role, "status"), { recursive: true });
    await writeFile(resolve(root, role, PROBE_PATH), probeDocument("initial"));
  }
  await writeFile(resolve(root, "world.json"), JSON.stringify({ head: 4, uploaded: probeDocument("initial") }));
  await writeFile(cli, FAKE_CLI);
  await chmod(cli, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, cli, writer: resolve(root, "writer"), reader: resolve(root, "reader") };
}

function argumentsFor(options, overrides = {}) {
  const values = {
    environment: "production",
    cli: options.cli,
    "writer-state-dir": options.writer,
    "reader-state-dir": options.reader,
    "expected-origin": ORIGIN,
    collection: COLLECTION,
    "expected-collection-name": NAME,
    "probe-path": PROBE_PATH,
    "timeout-ms": "5000",
    ...overrides
  };
  return Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .flatMap(([name, value]) => [`--${name}`, value]);
}

async function invoke(options, overrides = {}, environment = {}) {
  const { exitCode, result } = await runCanary(
    argumentsFor(options, overrides),
    { ...process.env, FAKE_ROOT: options.root, ...environment }
  );
  return { code: exitCode, json: result, text: JSON.stringify(result) };
}

function assertPrivate(result, options) {
  for (const forbidden of [SECRET, options.root, COLLECTION, "nonce"]) {
    assert.equal(result.text.includes(forbidden), false, forbidden);
  }
}

const shape = (stages) => stages.map(({ name, status }) => ({ name, status }));

test("times one edit from the writer's folder to the reader's", async (t) => {
  const options = await fixture(t);
  const result = await invoke(options);
  assert.equal(result.code, 0, result.text);
  assert.deepEqual(shape(result.json.stages), [
    { name: "detect", status: "operational" },
    { name: "upload", status: "operational" },
    { name: "notify", status: "operational" },
    { name: "apply", status: "operational" }
  ]);
  assert.equal(result.json.schema_version, 1);
  assert.equal(result.json.source, "sync");
  assert.equal(result.json.component, "hosted");
  assert.equal(result.json.environment, "production");
  assert.equal(result.json.status, "operational");
  assert.equal(result.json.error, undefined);
  assert.match(result.json.checked_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  assert.ok(result.json.stages.every((stage) => Number.isInteger(stage.duration_ms) && stage.duration_ms >= 0));
  assert.equal(result.json.duration_ms, result.json.stages.reduce((sum, stage) => sum + stage.duration_ms, 0));
  // The writer's daemon took two polls (notice, then upload).
  assert.ok(result.json.stages[0].duration_ms > 0);
  const written = await readFile(resolve(options.writer, PROBE_PATH), "utf8");
  assert.notEqual(written, probeDocument("initial"));
  assert.equal(await readFile(resolve(options.reader, PROBE_PATH), "utf8"), written);
  assertPrivate(result, options);

  const again = await invoke(options);
  assert.equal(again.code, 0, again.text);
  assert.notEqual(await readFile(resolve(options.writer, PROBE_PATH), "utf8"), written);
});

test("rejects missing, malformed, duplicate, or unsafe configuration before running the CLI", async (t) => {
  const options = await fixture(t);
  for (const overrides of [
    { collection: "not-a-uuid" },
    { "expected-origin": "https://connect.example/" },
    { "probe-path": "../escape.md" },
    { "probe-path": "/absolute.md" },
    { "timeout-ms": "300001" },
    { cli: "relative/mdbase" },
    { "reader-state-dir": "relative/state" },
    { "reader-state-dir": `${options.writer}/` },
    { environment: "Production" },
    { "timings-url": "https://ops.example/v1/timings" },
    { "timings-token-file": "/token" },
    { "timings-url": "http://ops.example/v1/timings", "timings-token-file": "/token" },
    { "timings-url": "https://ops.example/v1/timings", "timings-token-file": "token" },
    { "probe-path": undefined }
  ]) {
    const result = await invoke(options, overrides);
    assert.equal(result.code, 2, JSON.stringify(overrides));
    assert.deepEqual(result.json.error, { stage: "config", code: "invalid_config" });
    assert.deepEqual(shape(result.json.stages), [{ name: "config", status: "failed" }]);
  }
  const mixed = await invoke(options, {}, { MDBASE_SYNC_CANARY_COLLECTION: COLLECTION });
  assert.equal(mixed.code, 2);
  for (const name of ["MDBASE_HOME", "MDBASE_ENV", "MDBASE_SECRET_BACKEND"]) {
    const override = await invoke(options, {}, { [name]: "x" });
    assert.deepEqual(override.json.error, { stage: "config", code: "environment_override" });
  }
  const missingCli = await invoke(options, { cli: resolve(options.root, "missing") });
  assert.deepEqual(missingCli.json.error, { stage: "config", code: "cli_unavailable" });
  const missingState = await invoke(options, { "reader-state-dir": resolve(options.root, "missing") });
  assert.deepEqual(missingState.json.error, { stage: "config", code: "state_unavailable" });
  assert.equal(await readFile(resolve(options.writer, PROBE_PATH), "utf8"), probeDocument("initial"));
});

test("accepts every input from its environment variable", async (t) => {
  const options = await fixture(t);
  const environment = {};
  const values = argumentsFor(options);
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index].slice(2).toUpperCase().replaceAll("-", "_");
    environment[`MDBASE_SYNC_CANARY_${name}`] = values[index + 1];
  }
  const { exitCode } = await runCanary([], { ...process.env, FAKE_ROOT: options.root, ...environment });
  assert.equal(exitCode, 0);
});

test("refuses to write unless both devices are ready, distinct and on one account", async (t) => {
  for (const [mode, code] of [
    ["insecure", "insecure_secret_backend"],
    ["signed-out", "not_signed_in"],
    ["other-origin", "origin_mismatch"],
    ["missing", "missing_collection"],
    ["other-account", "account_mismatch"],
    ["same-device", "same_device"],
    ["not-running", "daemon_not_running"],
    ["heads-differ", "heads_differ"],
    ["log-offline", "log_offline"]
  ]) {
    const options = await fixture(t);
    // Each mode fails preflight at once; the budget only has to cover several
    // fake CLI starts on a loaded runner.
    const result = await invoke(options, { "timeout-ms": "30000" }, { FAKE_CLI_MODE: mode });
    assert.equal(result.code, 1, mode);
    assert.equal(result.json.status, "failed", mode);
    assert.deepEqual(result.json.error, { stage: "preflight", code }, mode);
    assert.deepEqual(shape(result.json.stages), [{ name: "preflight", status: "failed" }], mode);
    assert.equal(await readFile(resolve(options.writer, PROBE_PATH), "utf8"), probeDocument("initial"), mode);
    assertPrivate(result, options);
  }
});

test("names the stage an edit stopped at and why", async (t) => {
  for (const [mode, completed, error] of [
    ["stuck", ["detect"], { stage: "upload", code: "timeout" }],
    ["reader-stalls", ["detect", "upload", "notify"], { stage: "apply", code: "timeout" }],
    ["reader-drops", ["detect", "upload"], { stage: "notify", code: "log_offline" }],
    ["held", ["detect", "upload"], { stage: "notify", code: "holds_present" }]
  ]) {
    const options = await fixture(t);
    const result = await invoke(options, { "timeout-ms": "2000" }, { FAKE_CLI_MODE: mode });
    assert.equal(result.code, 1, mode);
    assert.deepEqual(result.json.error, error, mode);
    assert.deepEqual(shape(result.json.stages), [
      ...completed.map((name) => ({ name, status: "operational" })),
      { name: error.stage, status: "failed" }
    ], mode);
    assert.equal(result.json.duration_ms, result.json.stages.reduce((sum, stage) => sum + stage.duration_ms, 0));
    assertPrivate(result, options);
  }
});

test("never writes through a link out of the writer's folder", async (t) => {
  const options = await fixture(t);
  const outside = resolve(options.root, "outside.md");
  await writeFile(outside, "outside\n");
  await rm(resolve(options.writer, PROBE_PATH));
  await symlink(outside, resolve(options.writer, PROBE_PATH));
  const result = await invoke(options);
  assert.deepEqual(result.json.error, { stage: "write", code: "marker_mismatch" });
  assert.equal(await readFile(outside, "utf8"), "outside\n");

  const directory = await fixture(t);
  await rm(resolve(directory.writer, "status"), { recursive: true });
  await mkdir(resolve(directory.root, "elsewhere"));
  await symlink(resolve(directory.root, "elsewhere"), resolve(directory.writer, "status"));
  const escaped = await invoke(directory);
  assert.deepEqual(escaped.json.error, { stage: "write", code: "marker_mismatch" });
  await assert.rejects(readFile(resolve(directory.root, "elsewhere", "sync-probe.md")));
});

test("takes each milestone from its earliest evidence", () => {
  assert.deepEqual(stageTimings({ detect: 100, upload: 250, notify: 260, apply: 270 }), {
    stages: [
      { name: "detect", status: "operational", duration_ms: 100 },
      { name: "upload", status: "operational", duration_ms: 150 },
      { name: "notify", status: "operational", duration_ms: 10 },
      { name: "apply", status: "operational", duration_ms: 10 }
    ],
    missing: undefined,
    reachedAt: 270
  });
  // The reader's copy arrived before either device's status showed it.
  assert.deepEqual(stageTimings({ apply: 200 }).stages.map((stage) => stage.duration_ms), [200, 0, 0, 0]);
  assert.deepEqual(stageTimings({ detect: 50, upload: 300, notify: 120, apply: 400 }).stages
    .map((stage) => stage.duration_ms), [50, 70, 0, 280]);
  assert.deepEqual(stageTimings({ detect: 50 }), {
    stages: [{ name: "detect", status: "operational", duration_ms: 50 }],
    missing: "upload",
    reachedAt: 50
  });
});

test("publishes a result with the bearer token and reports failures without the token", async (t) => {
  const received = [];
  let reply = 202;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      received.push({ authorization: request.headers.authorization, body: JSON.parse(body) });
      response.writeHead(reply).end(SECRET);
    });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  t.after(() => server.close());
  const root = await mkdtemp(resolve(tmpdir(), "mdbase-sync-publish-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tokenFile = resolve(root, "token");
  await writeFile(tokenFile, "tok_value\n", { mode: 0o600 });
  const timingsUrl = `http://127.0.0.1:${server.address().port}/v1/timings`;
  const result = { schema_version: 1, source: "sync", status: "operational" };

  assert.equal(await publishTimings(result, { timingsUrl, timingsTokenFile: tokenFile }), undefined);
  assert.deepEqual(received, [{ authorization: "Bearer tok_value", body: result }]);
  reply = 503;
  assert.equal(await publishTimings(result, { timingsUrl, timingsTokenFile: tokenFile }), "HTTP 503");

  await chmod(tokenFile, 0o644);
  const shared = await publishTimings(result, { timingsUrl, timingsTokenFile: tokenFile });
  assert.equal(shared, "token file must be a private regular file");
  assert.equal(received.length, 2);
  assert.equal(
    await publishTimings(result, { timingsUrl, timingsTokenFile: resolve(root, "missing") }),
    "token file is unreadable"
  );
  await chmod(tokenFile, 0o600);
  assert.equal(
    await publishTimings(result, { timingsUrl: "http://127.0.0.1:1/v1/timings", timingsTokenFile: tokenFile }),
    "endpoint unreachable"
  );
});
