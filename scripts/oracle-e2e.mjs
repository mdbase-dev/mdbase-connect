import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  decryptRelayResponse,
  encryptRelayRequest,
  MemoryGrantKeyStore
} from "../packages/client/dist/crypto.js";

const run = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "..");
const serverUrl = (process.env.MDBASE_CONNECT_ORACLE_URL ?? "https://oracle-vpn.tail2b6cde.ts.net").replace(/\/$/, "");
const appOrigin = (process.env.MDBASE_CONNECT_ORACLE_APP_ORIGIN ?? "https://oracle-vpn.tail2b6cde.ts.net:8443").replace(/\/$/, "");
const extension = process.platform === "win32" ? ".exe" : "";
const agentBinary = join(repoRoot, "target", "debug", `mdbase-connect-agent${extension}`);
const cliBinary = join(repoRoot, "target", "debug", `mdbase-connect${extension}`);
const benchmarkIterations = parseBenchmarkIterations(process.env.MDBASE_CONNECT_BENCHMARK_ITERATIONS);
const encryptedRelay = process.env.MDBASE_CONNECT_ORACLE_ENCRYPTION === "required";
const loopbackPort = await availableTcpPort();
const scratch = await mkdtemp(join(tmpdir(), "mdbase-connect-oracle-e2e-"));
const stateDir = join(scratch, "state");
const collectionPath = join(scratch, "tasks");
let connectorId;
let agent;
let relayContext;

try {
  const health = await request("/health");
  if (health.body.protocol_version !== 2) throw new Error(`Oracle protocol is ${health.body.protocol_version}, expected 2`);

  const connector = await request("/v1/connectors", {
    method: "POST",
    body: { name: `Protocol 2 E2E ${new Date().toISOString()}` }
  });
  connectorId = connector.body.connector.id;

  agent = startAgent([]);
  await waitForAgent();
  await run(cliBinary, [
    "--state-dir", stateDir,
    "collection", "create", collectionPath,
    "--name", "Oracle TaskNotes E2E"
  ]);
  await mkdir(join(collectionPath, "_types"), { recursive: true });
  await writeFile(join(collectionPath, "_types", "task.md"), taskType());
  await writeFile(join(collectionPath, "_types", "private.md"), privateType());
  await writeFile(join(collectionPath, "private.md"), `---\ntype: private\nsecret: oracle scope test\n---\n`);
  await stopAgent(agent);
  agent = startAgent(["--server-url", serverUrl, "--connector-token", connector.body.token]);

  const dashboard = await poll(async () => {
    const response = await request("/v1/me");
    const collection = response.body.collections.find((item) => item.connector_id === connectorId);
    return collection ? { dashboard: response.body, collection } : null;
  }, "ephemeral Oracle collection did not synchronize");

  const manifestUrl = `${appOrigin}/.well-known/mdbase-app.json`;
  const application = await request("/v1/apps/discover", {
    method: "POST",
    body: { manifest_url: manifestUrl }
  });
  const appId = application.body.application.id;
  const applicationKeyStore = encryptedRelay ? new MemoryGrantKeyStore() : undefined;
  const applicationKey = applicationKeyStore ? await applicationKeyStore.create("oracle-e2e-grant") : undefined;
  const redirectUri = `${appOrigin}/`;
  const verifier = "oracle-end-to-end-pkce-verifier-forty-three-characters";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const operations = "describe,changes,read,query,create,update";
  const authorizeUrl = new URL(`${serverUrl}/oauth/authorize`);
  authorizeUrl.search = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "oracle-e2e",
    operations,
    ...(applicationKey ? { relay_protocol: "3", application_public_key: applicationKey.publicKey } : {})
  }).toString();
  const authorize = await fetch(
    authorizeUrl,
    { redirect: "manual" }
  );
  if (authorize.status !== 302) throw new Error(`Oracle authorization returned HTTP ${authorize.status}`);
  const authorizationId = authorize.headers.get("location")?.split("/").at(-1);
  if (!authorizationId) throw new Error("Oracle authorization request ID missing");

  await poll(async () => {
    const snapshot = await cliJson(["access", "snapshot"]);
    return snapshot.result?.pending_authorizations?.some((pending) => pending.id === authorizationId)
      ? true
      : null;
  }, "Oracle authorization did not reach the connector");
  await cliJson([
    "access", "approve", authorizationId, dashboard.collection.local_id,
    "--operations", operations
  ]);

  const completed = await poll(async () => {
    const response = await request(`/v1/authorization-requests/${authorizationId}/status`);
    return response.body.redirect_uri ? response.body : null;
  }, "Oracle authorization did not complete");
  const callback = new URL(completed.redirect_uri);
  const token = await request("/oauth/token", {
    method: "POST",
    form: {
      grant_type: "authorization_code",
      code: callback.searchParams.get("code"),
      client_id: appId,
      redirect_uri: redirectUri,
      code_verifier: verifier
    }
  });
  if (token.body.scope?.contracts?.[0]?.id !== "tasknotes.task" || !token.body.refresh_token) {
    throw new Error(`Oracle authorization did not return contract scope: ${JSON.stringify(token.body)}`);
  }
  if (encryptedRelay) {
    if (!applicationKeyStore
        || !token.body.grant_id
        || token.body.encryption?.protocol_version !== 3
        || token.body.encryption?.application_public_key !== applicationKey?.publicKey) {
      throw new Error(`Oracle authorization did not establish encrypted relay protocol 3: ${JSON.stringify(token.body)}`);
    }
    relayContext = {
      store: applicationKeyStore,
      handle: "oracle-e2e-grant",
      binding: {
        grantId: token.body.grant_id,
        applicationId: appId,
        encryption: token.body.encryption
      }
    };
  }
  const refreshed = await request("/oauth/token", {
    method: "POST",
    form: {
      grant_type: "refresh_token",
      refresh_token: token.body.refresh_token,
      client_id: appId
    }
  });
  const accessToken = refreshed.body.access_token;
  if (relayContext) relayContext.binding.encryption = refreshed.body.encryption;
  const collectionId = dashboard.collection.id;

  const description = await operation(collectionId, "describe", accessToken, {});
  if (description.protocol_version !== 2
      || description.contracts?.[0]?.id !== "tasknotes.task"
      || description.types?.length !== 1
      || description.types?.[0]?.schema?.properties?.title?.type !== "string") {
    throw new Error(`Oracle discovery failed: ${JSON.stringify(description)}`);
  }

  const created = await operation(collectionId, "create", accessToken, {
    path: "tasks/oracle.md",
    frontmatter: { type: "task", title: "Oracle end to end", status: "open" }
  });
  const firstRevision = created.result?.revision;
  if (!created.valid || !firstRevision) throw new Error(`Oracle create failed: ${JSON.stringify(created)}`);

  const changes = await poll(async () => {
    const page = await operation(collectionId, "changes", accessToken, { after: description.change_cursor });
    return page.events?.some((event) => event.type === "mdbase.record.created") ? page : null;
  }, "Oracle change cursor did not observe create");
  if (changes.events.some((event) => "before" in event.payload || "after" in event.payload)) {
    throw new Error("Oracle change feed exposed record snapshots");
  }

  const updated = await operation(collectionId, "update", accessToken, {
    path: "tasks/oracle.md",
    fields: { status: "done" },
    if_revision: firstRevision
  });
  if (!updated.valid || updated.result?.revision === firstRevision) {
    throw new Error(`Oracle conditional update failed: ${JSON.stringify(updated)}`);
  }
  const conflict = await operation(collectionId, "update", accessToken, {
    path: "tasks/oracle.md",
    fields: { title: "Lost update" },
    if_revision: firstRevision
  });
  if (conflict.valid !== false
      || !conflict.diagnostics?.some((diagnostic) => diagnostic.code === "concurrent_modification")) {
    throw new Error(`Oracle stale revision was accepted: ${JSON.stringify(conflict)}`);
  }

  const read = await operation(collectionId, "read", accessToken, { path: "tasks/oracle.md" });
  if (!read.valid || read.result?.frontmatter?.status !== "done" || read.result?.frontmatter?.title !== "Oracle end to end") {
    throw new Error(`Oracle read-after-conflict failed: ${JSON.stringify(read)}`);
  }
  const privateRead = await rawOperation(collectionId, "read", accessToken, { path: "private.md" });
  if (privateRead.response.status !== 403 || privateRead.body.error?.code !== "access_denied") {
    throw new Error(`Oracle contract scope exposed a private record: ${JSON.stringify(privateRead.body)}`);
  }
  if (benchmarkIterations > 0) {
    const results = await benchmarkRelay(collectionId, accessToken, benchmarkIterations);
    process.stdout.write(`${JSON.stringify({ server: serverUrl, relay_protocol: relayContext ? 3 : 2, iterations: benchmarkIterations, results }, null, 2)}\n`);
  }
  process.stdout.write(`mdbase connect Oracle protocol ${relayContext ? 3 : 2} end-to-end path passed\n`);
} finally {
  if (agent) await stopAgent(agent);
  if (connectorId) {
    await fetch(`${serverUrl}/v1/connectors/${connectorId}`, { method: "DELETE" }).catch(() => undefined);
  }
  await rm(scratch, { recursive: true, force: true });
}

async function operation(collectionId, operationName, accessToken, input) {
  const { response, body } = await rawOperation(collectionId, operationName, accessToken, input);
  if (!response.ok) throw new Error(`Oracle ${operationName} returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body.result;
}

async function rawOperation(collectionId, operationName, accessToken, input) {
  const encryptedRequest = relayContext
    ? await encryptRelayRequest(
      relayContext.store,
      relayContext.handle,
      relayContext.binding,
      operationName,
      input
    )
    : input;
  const response = await fetch(`${serverUrl}/v1/collections/${collectionId}/operations/${operationName}`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify(encryptedRequest)
  });
  const body = await response.json();
  if (!response.ok || !relayContext) return { response, body };
  const decrypted = await decryptRelayResponse(
    relayContext.store,
    relayContext.handle,
    relayContext.binding,
    encryptedRequest,
    body.envelope
  );
  if (decrypted.ok) return { response, body: { ok: true, result: decrypted.result } };
  const status = decrypted.error.code === "access_denied" || decrypted.error.code === "access_paused" ? 403 : 502;
  return { response: syntheticResponse(status), body: { error: decrypted.error } };
}

async function benchmarkRelay(collectionId, accessToken, iterations) {
  const samples = { describe: [], query: [], create: [], read: [], update: [] };
  await operation(collectionId, "query", accessToken, { types: ["task"], limit: 1_000, include_body: false });
  for (let index = 0; index < iterations; index += 1) {
    await measure(samples.describe, () => operation(collectionId, "describe", accessToken, {}));
    await measure(samples.query, () => operation(collectionId, "query", accessToken, {
      types: ["task"], limit: 1_000, include_body: false
    }));
    const path = `tasks/benchmark-${Date.now()}-${index}.md`;
    const created = await measure(samples.create, () => operation(collectionId, "create", accessToken, {
      path,
      frontmatter: { type: "task", title: `Relay benchmark ${index}`, status: "open" }
    }));
    await measure(samples.read, () => operation(collectionId, "read", accessToken, { path }));
    await measure(samples.update, () => operation(collectionId, "update", accessToken, {
      path,
      fields: { status: "done" },
      if_revision: created.result.revision
    }));
  }
  return Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, summarize(values)]));
}

async function measure(samples, action) {
  const started = performance.now();
  const result = await action();
  samples.push(performance.now() - started);
  return result;
}

function summarize(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (value) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)];
  return {
    min_ms: round(sorted[0]),
    p50_ms: round(percentile(0.5)),
    p95_ms: round(percentile(0.95)),
    max_ms: round(sorted.at(-1))
  };
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function parseBenchmarkIterations(value) {
  if (value === undefined || value === "") return 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error("MDBASE_CONNECT_BENCHMARK_ITERATIONS must be an integer from 1 to 100.");
  }
  return parsed;
}

function syntheticResponse(status) {
  return { ok: status >= 200 && status < 300, status };
}

async function request(path, options = {}) {
  const headers = {};
  let body;
  if (options.body) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  if (options.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(options.form).toString();
  }
  const response = await fetch(`${serverUrl}${path}`, { method: options.method ?? "GET", headers, body });
  const responseBody = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}: ${JSON.stringify(responseBody)}`);
  return { response, body: responseBody };
}

async function cliJson(args) {
  const result = await run(cliBinary, ["--state-dir", stateDir, "--compact", ...args]);
  const parsed = JSON.parse(result.stdout);
  if (!parsed.ok) throw new Error(`Connector command failed: ${result.stdout}`);
  return parsed;
}

function startAgent(extraArgs) {
  const child = spawn(agentBinary, [
    "--state-dir", stateDir,
    "--loopback-port", String(loopbackPort),
    ...extraArgs
  ], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => process.stderr.write(`[oracle-agent] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[oracle-agent] ${chunk}`));
  return child;
}

async function availableTcpPort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not reserve an Oracle connector loopback port");
  }
  await new Promise((resolveClose) => server.close(resolveClose));
  return address.port;
}

async function stopAgent(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGINT");
  await new Promise((resolveExit) => child.once("exit", resolveExit));
}

async function waitForAgent() {
  await poll(async () => {
    try {
      await run(cliBinary, ["--state-dir", stateDir, "ping"]);
      return true;
    } catch {
      return null;
    }
  }, "ephemeral Oracle connector did not start");
}

async function poll(action, failureMessage) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const result = await action();
    if (result) return result;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(failureMessage);
}

function taskType() {
  return `---
kind: mdbase.type
name: task
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [type, title]
    additionalProperties: true
    properties:
      type: { const: task }
      title: { type: string }
      status: { enum: [open, done] }
x-tasknotes:
  contract: tasknotes.task
  version: 1
  field_roles: { title: title, status: status }
  status: { completed_values: [done], default: open }
---
`;
}

function privateType() {
  return `---
kind: mdbase.type
name: private
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    additionalProperties: true
    properties:
      type: { const: private }
      secret: { type: string }
---
`;
}
