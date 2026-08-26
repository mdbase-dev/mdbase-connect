import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  markerDocumentSha256,
  runCanary
} from "../hosted-read-canary.mjs";
const COLLECTION = "01900000-0000-7000-8000-000000000000";
const ORIGIN = "https://connect.example";
const NAME = "Status marker";
const MARKER_PATH = "status/canary.md";
const DOCUMENT = "---\ntype: status\n---\noperational\n";
const SECRET = "super-secret-response-value";

async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), "mdbase-hosted-canary-"));
  const stateDir = resolve(root, "state");
  const cli = resolve(root, "mdbase-fake");
  await mkdir(stateDir);
  await writeFile(resolve(stateDir, "cloud.json"), `${JSON.stringify({ server_url: ORIGIN })}\n`);
  await writeFile(cli, `#!/usr/bin/env node
const mode = process.env.FAKE_CLI_MODE ?? "success";
const args = process.argv.slice(2);
const operationIndex = args.indexOf("operation");
const operation = operationIndex === -1 ? null : args[operationIndex + 2];
if (mode === "timeout") await new Promise((resolve) => setTimeout(resolve, 10000));
if (mode === "cli-failure") { process.stderr.write("${SECRET}\\n"); process.exit(1); }
if (mode === "malformed" && operation === "describe") { process.stdout.write("${SECRET} not-json"); process.exit(0); }
if (args.includes("connections")) {
  const operations = mode === "broad-grant" ? ["describe", "read", "query"] : ["describe", "read"];
  const connections = mode === "missing-grant" ? [] : [{collection_id:"${COLLECTION}",collection_name:"${NAME}",operations,credential:"${SECRET}"}];
  process.stdout.write(JSON.stringify(connections));
} else if (operation === "describe") {
  process.stdout.write(JSON.stringify({collection_id:"${COLLECTION}",display_name:"${NAME}",secret:"${SECRET}"}));
} else if (operation === "read") {
  process.stdout.write(JSON.stringify({valid:true,result:{path:"${MARKER_PATH}",document:${JSON.stringify(DOCUMENT)},body:"${SECRET}"},diagnostics:[]}));
} else { process.exit(3); }
`);
  await chmod(cli, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, stateDir, cli };
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
    "expected-marker-sha256": markerDocumentSha256(DOCUMENT),
    "timeout-ms": "2000",
    ...overrides
  };
  return Object.entries(values).flatMap(([name, value]) => [`--${name}`, value]);
}

async function invoke(options, overrides = {}, environment = {}, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl ?? (async () => Response.json({
    application: {
      id: "01900000-0000-7000-8000-000000000001",
      manifest_digest: "a".repeat(64)
    }
  }));
  const { exitCode, result } = await runCanary(
    argumentsFor(options, overrides),
    { ...process.env, ...environment },
    { fetchImpl }
  );
  return {
    code: exitCode,
    stdout: `${JSON.stringify(result)}\n`,
    stderr: "",
    json: result
  };
}

test("reports a successful least-privilege hosted read", async (t) => {
  const options = await fixture(t);
  const result = await invoke(options);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(result.json.stages.map(({ name, status }) => ({ name, status })), [
    { name: "config", status: "operational" },
    { name: "registration", status: "operational" },
    { name: "connections", status: "operational" },
    { name: "describe", status: "operational" },
    { name: "read", status: "operational" },
    { name: "digest", status: "operational" }
  ]);
  assert.equal(result.json.schema_version, 1);
  assert.equal(result.json.environment, "production");
  assert.equal(result.json.component, "hosted_canary");
  assert.equal(result.json.status, "operational");
  assert.match(result.json.checked_at, /^\d{4}-\d{2}-\d{2}T/u);
  assert.ok(Number.isInteger(result.json.duration_ms));
});

test("registers the exact portable CLI application without exposing its response", async (t) => {
  const options = await fixture(t);
  let request;
  const result = await invoke(options, {}, {}, {
    fetchImpl: async (url, init) => {
      request = { url, init };
      return Response.json({
        application: {
          id: "01900000-0000-7000-8000-000000000001",
          manifest_digest: "b".repeat(64),
          private_value: SECRET
        }
      });
    }
  });
  assert.equal(result.code, 0);
  assert.equal(request.url, `${ORIGIN}/v1/apps/register`);
  assert.equal(request.init.method, "POST");
  const body = JSON.parse(request.init.body);
  assert.equal(body.manifest.id, "dev.mdbase.cli");
  assert.equal(body.manifest.distribution, "portable");
  assert.deepEqual(body.manifest.requirements.contracts, []);
  assert.doesNotMatch(result.stdout, new RegExp(SECRET, "u"));
});

test("reports registration failure with only a fixed status code", async (t) => {
  const options = await fixture(t);
  const result = await invoke(options, {}, {}, {
    fetchImpl: async () => new Response(SECRET, { status: 502 })
  });
  assert.equal(result.code, 1);
  assert.deepEqual(result.json.error, { stage: "registration", code: "http_502" });
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(SECRET, "u"));
});

test("rejects a state directory bound to the wrong origin", async (t) => {
  const options = await fixture(t);
  await writeFile(resolve(options.stateDir, "cloud.json"), JSON.stringify({ server_url: "https://other.example" }));
  const result = await invoke(options);
  assert.equal(result.code, 2);
  assert.deepEqual(result.json.error, { stage: "config", code: "origin_mismatch" });
});

test("rejects an inherited daemon endpoint override", async (t) => {
  const options = await fixture(t);
  const result = await invoke(options, {}, { MDBASE_CONNECT_SOCKET: "tcp://127.0.0.1:9999" });
  assert.equal(result.code, 2);
  assert.deepEqual(result.json.error, { stage: "config", code: "endpoint_override" });
});

test("rejects a missing hosted grant", async (t) => {
  const options = await fixture(t);
  const result = await invoke(options, {}, { FAKE_CLI_MODE: "missing-grant" });
  assert.equal(result.code, 1);
  assert.deepEqual(result.json.error, { stage: "connections", code: "missing_grant" });
});

test("rejects a broader than necessary hosted grant", async (t) => {
  const options = await fixture(t);
  const result = await invoke(options, {}, { FAKE_CLI_MODE: "broad-grant" });
  assert.equal(result.code, 1);
  assert.deepEqual(result.json.error, { stage: "connections", code: "grant_mismatch" });
});

test("reports a marker digest mismatch without exposing the document", async (t) => {
  const options = await fixture(t);
  const result = await invoke(options, {
    "expected-marker-sha256": `sha256:${"0".repeat(64)}`
  });
  assert.equal(result.code, 1);
  assert.deepEqual(result.json.error, { stage: "digest", code: "digest_mismatch" });
  assert.doesNotMatch(result.stdout, /operational\n|type: status/u);
});

test("reports malformed CLI JSON with a fixed privacy-safe error", async (t) => {
  const options = await fixture(t);
  const result = await invoke(options, {}, { FAKE_CLI_MODE: "malformed" });
  assert.equal(result.code, 1);
  assert.deepEqual(result.json.error, { stage: "describe", code: "malformed_json" });
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(SECRET, "u"));
});

test("bounds the complete probe with a timeout", async (t) => {
  const options = await fixture(t);
  const result = await invoke(options, { "timeout-ms": "50" }, { FAKE_CLI_MODE: "timeout" });
  assert.equal(result.code, 1);
  assert.deepEqual(result.json.error, { stage: "connections", code: "timeout" });
  assert.ok(result.json.duration_ms < 2000);
});

test("returns exit 2 for invalid explicit configuration", async (t) => {
  const options = await fixture(t);
  const result = await invoke(options, { collection: "not-a-uuid" });
  assert.equal(result.code, 2);
  assert.deepEqual(result.json.error, { stage: "config", code: "invalid_config" });
  assert.equal(result.json.environment, "production");
});

test("accepts all non-secret inputs from the documented environment variables", async (t) => {
  const options = await fixture(t);
  const environment = {
    ...process.env,
    MDBASE_HOSTED_CANARY_ENVIRONMENT: "staging",
    MDBASE_HOSTED_CANARY_CLI: options.cli,
    MDBASE_HOSTED_CANARY_STATE_DIR: options.stateDir,
    MDBASE_HOSTED_CANARY_EXPECTED_ORIGIN: ORIGIN,
    MDBASE_HOSTED_CANARY_COLLECTION: COLLECTION,
    MDBASE_HOSTED_CANARY_EXPECTED_COLLECTION_NAME: NAME,
    MDBASE_HOSTED_CANARY_MARKER_PATH: MARKER_PATH,
    MDBASE_HOSTED_CANARY_EXPECTED_MARKER_SHA256: markerDocumentSha256(DOCUMENT),
    MDBASE_HOSTED_CANARY_TIMEOUT_MS: "2000"
  };
  const { exitCode, result } = await runCanary([], environment, {
    fetchImpl: async () => Response.json({
      application: {
        id: "01900000-0000-7000-8000-000000000001",
        manifest_digest: "c".repeat(64)
      }
    })
  });
  assert.equal(exitCode, 0);
  assert.equal(result.environment, "staging");
});

test("never reflects CLI response bodies, diagnostics, or stderr", async (t) => {
  const options = await fixture(t);
  const result = await invoke(options, {}, { FAKE_CLI_MODE: "cli-failure" });
  assert.equal(result.code, 1);
  assert.deepEqual(result.json.error, { stage: "connections", code: "cli_failed" });
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, new RegExp(SECRET, "u"));
});
