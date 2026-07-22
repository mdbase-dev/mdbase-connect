import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { chromium } from "@playwright/test";
import {
  decryptRelayResponse,
  encryptRelayRequest,
  MemoryGrantKeyStore
} from "../packages/client/dist/crypto.js";
import { MdbaseConnect } from "../packages/client/dist/index.js";

process.env.NODE_ENV = "test";
const run = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "..");
const configuredLoopbackPort = process.env.MDBASE_CONNECT_E2E_LOOPBACK_PORT;
const loopbackPort = configuredLoopbackPort === undefined
  ? await availableTcpPort()
  : Number(configuredLoopbackPort);
if (!Number.isInteger(loopbackPort) || loopbackPort < 1 || loopbackPort > 65_535) {
  throw new Error("MDBASE_CONNECT_E2E_LOOPBACK_PORT must be a valid TCP port");
}
const loopbackUrl = `http://127.0.0.1:${loopbackPort}`;
const { buildApp } = await import("../services/server/dist/app.js");
const { createDatabase } = await import("../services/server/dist/db.js");
const database = await createDatabase("memory");
const { app } = await buildApp({
  db: database,
  devAuth: true,
  allowInsecureManifests: true,
  publicUrl: "http://127.0.0.1"
});
await app.listen({ host: "127.0.0.1", port: 0 });
const serverAddress = app.server.address();
if (!serverAddress || typeof serverAddress === "string") throw new Error("Server did not open a TCP port");
const serverUrl = `http://127.0.0.1:${serverAddress.port}`;
const scratch = await mkdtemp(join(tmpdir(), "mdbase-connect-e2e-"));
const stateDir = join(scratch, "state");
const collectionPath = join(scratch, "workouts");
const extension = process.platform === "win32" ? ".exe" : "";
const agentBinary = join(repoRoot, "target", "debug", `mdbase-connect-agent${extension}`);
const cliBinary = join(repoRoot, "target", "debug", `mdbase-connect${extension}`);
let agent;
let manifestServer;
let browserManifestServer;
let directOrigin;
const applicationKeyStore = new MemoryGrantKeyStore();
let relayContext;

class MemoryStorage {
  values = new Map();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key) { return this.values.get(key) ?? null; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  removeItem(key) { this.values.delete(key); }
  setItem(key, value) { this.values.set(key, value); }
}

try {
  const session = await request("/v1/dev/session", {
    method: "POST",
    body: { name: "MVP User", email: "mvp@example.com" }
  });
  const cookie = session.response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Development session did not set a cookie");
  const connector = await request("/v1/connectors", {
    method: "POST",
    cookie,
    body: { name: "MVP computer" }
  });

  agent = startAgent([]);
  await waitForAgent();
  await run(cliBinary, [
    "--state-dir", stateDir,
    "collection", "create", collectionPath,
    "--name", "Workouts"
  ]);
  await writeFile(
    join(collectionPath, "mdbase.yaml"),
    `${await readFile(join(collectionPath, "mdbase.yaml"), "utf8")}\nx-obsidian:\n  bases:\n    include: ["TaskNotes/Views/**/*.base"]\n`
  );
  await mkdir(join(collectionPath, "TaskNotes", "Views"), { recursive: true });
  await writeFile(join(collectionPath, "TaskNotes", "Views", "tasks.base"), `formulas:
  lane: if(status == "open", "Ready", "Other")
properties:
  formula.lane:
    displayName: Lane
views:
  - type: tasknotesKanban
    name: Open tasks
    filters:
      and:
        - 'status == "open"'
    groupBy:
      property: status
      direction: ASC
    order: [status, formula.lane, file.name]
    sort:
      - property: file.path
        direction: ASC
`);
  await mkdir(join(collectionPath, "_types"), { recursive: true });
  await writeFile(join(collectionPath, "_types", "task.md"), `---
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
  field_roles:
    title: title
    status: status
  status:
    completed_values: [done]
---
`);
  await writeFile(join(collectionPath, "_types", "private.md"), `---
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
`);
  await writeFile(join(collectionPath, "private.md"), `---
type: private
secret: connector scope test
---
`);
  await mkdir(join(collectionPath, "bulk"), { recursive: true });
  await Promise.all(Array.from({ length: 1_000 }, (_, index) => writeFile(
    join(collectionPath, "bulk", `${String(index).padStart(4, "0")}.md`),
    `---\ntype: task\ntitle: Bulk ${index}\nstatus: open\n---\n`
  )));
  await stopAgent(agent);
  agent = startAgent(["--server-url", serverUrl, "--connector-token", connector.body.token]);

  const dashboard = await poll(async () => {
    const current = await request("/v1/me", { cookie });
    return current.body.collections.length ? current.body : null;
  }, "collection metadata did not reach the portal");
  const collection = dashboard.collections[0];

  const manifest = await openManifestServer();
  manifestServer = manifest.server;
  browserManifestServer = manifest.browserServer;
  directOrigin = manifest.origin;
  const application = await request("/v1/apps/discover", {
    method: "POST",
    body: { manifest_url: manifest.manifestUrl }
  });
  const appId = application.body.application.id;
  const applicationKey = await applicationKeyStore.create("e2e-grant");
  const verifier = "end-to-end-pkce-verifier-with-forty-three-characters";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = await fetch(
    `${serverUrl}/oauth/authorize?client_id=${appId}&redirect_uri=${encodeURIComponent(manifest.redirectUri)}&code_challenge=${challenge}&code_challenge_method=S256&state=e2e&operations=describe,changes,read,query,create,update&relay_protocol=3&application_public_key=${encodeURIComponent(applicationKey.publicKey)}`,
    { headers: { cookie }, redirect: "manual" }
  );
  if (authorize.status !== 302) throw new Error(`Authorization start returned HTTP ${authorize.status}`);
  const authorizationId = authorize.headers.get("location")?.split("/").at(-1);
  if (!authorizationId) throw new Error("Authorization request ID missing");
  await poll(async () => {
    const snapshot = await cliJson(["access", "snapshot"]);
    return snapshot.result?.pending_authorizations?.some((pending) => pending.id === authorizationId)
      ? snapshot
      : null;
  }, "authorization request did not reach the local connector controls");
  await cliJson([
    "access", "approve", authorizationId, collection.local_id,
    "--operations", "describe,changes,read,query,create,update"
  ]);
  const completed = await poll(async () => {
    const current = await request(`/v1/authorization-requests/${authorizationId}/status`, { cookie });
    return current.body.redirect_uri ? current : null;
  }, "approved authorization did not return to the browser");
  const callback = new URL(completed.body.redirect_uri);
  const token = await request("/oauth/token", {
    method: "POST",
    form: {
      grant_type: "authorization_code",
      code: callback.searchParams.get("code"),
      client_id: appId,
      redirect_uri: manifest.redirectUri,
      code_verifier: verifier
    }
  });
  if (token.body.scope?.contracts?.[0]?.id !== "tasknotes.task" || !token.body.refresh_token) {
    throw new Error(`Authorization did not return contract scope and refresh token: ${JSON.stringify(token.body)}`);
  }
  if (token.body.encryption?.protocol_version !== 3
      || token.body.encryption?.application_public_key !== applicationKey.publicKey
      || !token.body.grant_id) {
    throw new Error(`Authorization did not establish encrypted relay protocol 3: ${JSON.stringify(token.body)}`);
  }
  relayContext = {
    store: applicationKeyStore,
    handle: "e2e-grant",
    binding: {
      grantId: token.body.grant_id,
      applicationId: appId,
      encryption: token.body.encryption
    }
  };
  const hostileReady = await fetch(`${loopbackUrl}/v1/ready`, {
    headers: { origin: "https://hostile.example" }
  });
  if (hostileReady.status !== 403 || hostileReady.headers.has("access-control-allow-origin")) {
    throw new Error("Hostile origin could read loopback readiness");
  }
  const directReady = await fetch(`${loopbackUrl}/v1/ready`, {
    headers: { origin: directOrigin }
  });
  const directReadyBody = await directReady.json();
  if (directReady.status !== 200
      || directReady.headers.get("access-control-allow-origin") !== directOrigin
      || directReadyBody.loopback_protocol_version !== 1) {
    throw new Error(`Authorized origin could not discover direct access: ${JSON.stringify(directReadyBody)}`);
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
  relayContext.binding.encryption = refreshed.body.encryption;
  const sdkStorage = new MemoryStorage();
  sdkStorage.setItem(`mdbase-connect:token:${serverUrl}:${manifest.manifestUrl}`, JSON.stringify({
    accessToken,
    refreshToken: refreshed.body.refresh_token,
    clientId: appId,
    collectionId: collection.id,
    operations: refreshed.body.operations,
    scope: refreshed.body.scope,
    // Direct access remains usable while the cloud access token needs renewal.
    expiresAt: Date.now() - 1,
    refreshExpiresAt: Date.now() + refreshed.body.refresh_expires_in * 1_000,
    grantId: refreshed.body.grant_id,
    encryption: refreshed.body.encryption,
    applicationOrigin: refreshed.body.application_origin,
    keyHandle: "e2e-grant"
  }));
  const sdk = new MdbaseConnect({
    serverUrl,
    manifestUrl: manifest.manifestUrl,
    redirectUri: manifest.redirectUri,
    storage: sdkStorage,
    keyStore: applicationKeyStore,
    loopbackUrl
  });
  const browserFetch = globalThis.fetch;
  globalThis.fetch = (input, init = {}) => {
    if (!String(input).startsWith(`${loopbackUrl}/`)) return browserFetch(input, init);
    const headers = new Headers(init.headers);
    headers.set("origin", directOrigin);
    return browserFetch(input, { ...init, headers });
  };
  try {
    if (await sdk.requestDirectAccess() !== "available") {
      throw new Error("Browser SDK did not discover the direct connector");
    }
    const sdkQuery = await sdk.query({ limit: 1_100 });
    if (!sdkQuery.valid
        || sdkQuery.result.results.length !== 1_000
        || sdk.connection()?.route !== "direct") {
      throw new Error("Browser SDK did not complete the 1,000-record query directly");
    }
  } finally {
    globalThis.fetch = browserFetch;
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const browserContext = await browser.newContext();
    await browserContext.grantPermissions(["local-network-access"], { origin: manifest.browserOrigin });
    const page = await browserContext.newPage();
    await page.goto(`${manifest.browserOrigin}/browser-e2e`);
    await page.waitForFunction(() => Boolean(globalThis.directHarness?.publicKey));
    const browserPublicKey = await page.evaluate(() => globalThis.directHarness.publicKey);
    const browserApplication = await request("/v1/apps/discover", {
      method: "POST",
      body: { manifest_url: manifest.browserManifestUrl }
    });
    const browserAppId = browserApplication.body.application.id;
    const browserVerifier = "browser-end-to-end-pkce-verifier-forty-three-chars";
    const browserChallenge = createHash("sha256").update(browserVerifier).digest("base64url");
    const browserOperations = [
      "describe", "changes", "read", "query", "validate", "create", "update", "delete", "rename",
      "read_type", "create_type", "update_type", "list_views", "execute_view"
    ];
    const browserAuthorize = await fetch(
      `${serverUrl}/oauth/authorize?client_id=${browserAppId}&redirect_uri=${encodeURIComponent(manifest.browserRedirectUri)}&code_challenge=${browserChallenge}&code_challenge_method=S256&state=browser-e2e&operations=${browserOperations.join(",")}&relay_protocol=3&application_public_key=${encodeURIComponent(browserPublicKey)}`,
      { headers: { cookie }, redirect: "manual" }
    );
    if (browserAuthorize.status !== 302) {
      throw new Error(`Browser authorization start returned HTTP ${browserAuthorize.status}`);
    }
    const browserAuthorizationId = browserAuthorize.headers.get("location")?.split("/").at(-1);
    if (!browserAuthorizationId) throw new Error("Browser authorization request ID missing");
    await poll(async () => {
      const snapshot = await cliJson(["access", "snapshot"]);
      return snapshot.result?.pending_authorizations?.some(
        (pending) => pending.id === browserAuthorizationId
      ) ? snapshot : null;
    }, "browser authorization request did not reach the local connector controls");
    await cliJson([
      "access", "approve", browserAuthorizationId, collection.local_id,
      "--operations", browserOperations.join(",")
    ]);
    const browserCompleted = await poll(async () => {
      const current = await request(
        `/v1/authorization-requests/${browserAuthorizationId}/status`,
        { cookie }
      );
      return current.body.redirect_uri ? current : null;
    }, "approved browser authorization did not return to the browser");
    const browserCallback = new URL(browserCompleted.body.redirect_uri);
    const browserToken = await request("/oauth/token", {
      method: "POST",
      form: {
        grant_type: "authorization_code",
        code: browserCallback.searchParams.get("code"),
        client_id: browserAppId,
        redirect_uri: manifest.browserRedirectUri,
        code_verifier: browserVerifier
      }
    });
    const browserResult = await page.evaluate(async (config) => {
      return globalThis.directHarness.exercise(config);
    }, {
      serverUrl,
      loopbackUrl,
      manifestUrl: manifest.browserManifestUrl,
      redirectUri: manifest.browserRedirectUri,
      loopbackUrl,
      token: {
        accessToken: browserToken.body.access_token,
        refreshToken: browserToken.body.refresh_token,
        clientId: browserAppId,
        collectionId: browserToken.body.collection_id,
        operations: browserToken.body.operations,
        scope: browserToken.body.scope,
        // Exercise genuine cloud-independent access, not merely deferred renewal.
        expiresAt: Date.now() - 60_000,
        refreshExpiresAt: Date.now() - 30_000,
        grantId: browserToken.body.grant_id,
        encryption: browserToken.body.encryption,
        applicationOrigin: browserToken.body.application_origin,
        keyHandle: "browser-e2e-grant"
      }
    });
    if (browserResult.status !== "available"
        || browserResult.route !== "direct"
        || browserResult.records !== 1_002
        || !browserResult.read
        || !browserResult.updated
        || !browserResult.renamed
        || !browserResult.validated
        || !browserResult.createdType
        || !browserResult.readType
        || !browserResult.updatedType
        || !browserResult.listedView
        || !browserResult.executedView
        || !browserResult.changed
        || !browserResult.deleted) {
      throw new Error(`Real browser direct-operation matrix failed: ${JSON.stringify(browserResult)}`);
    }
    await browserContext.close();
  } finally {
    await browser.close();
  }

  const descriptionResponse = await rawOperation(collection.id, "describe", accessToken, {});
  const descriptionBody = await descriptionResponse.json();
  if (descriptionResponse.status !== 200
      || descriptionBody.result?.protocol_version !== 2
      || descriptionBody.result?.contracts?.[0]?.id !== "tasknotes.task"
      || descriptionBody.result?.types?.length !== 1
      || descriptionBody.result?.types?.[0]?.schema?.properties?.title?.type !== "string") {
    throw new Error(`Unexpected collection description: ${JSON.stringify(descriptionBody)}`);
  }
  const changeCursor = descriptionBody.result.change_cursor;

  const create = await poll(async () => {
    const response = await rawOperation(collection.id, "create", accessToken, {
      path: "sessions/first.md",
      frontmatter: { type: "task", title: "First connected workout", status: "open" },
      body: "Created through the relay."
    });
    return response.status === 200 ? response : null;
  }, "authorized relay create did not reach the connector");
  const createBody = await create.json();
  const firstRevision = createBody.result?.result?.revision;
  if (!firstRevision) throw new Error(`Create did not return a revision: ${JSON.stringify(createBody)}`);

  const createdChanges = await poll(async () => {
    const response = await rawOperation(collection.id, "changes", accessToken, {
      after: changeCursor
    });
    const body = await response.json();
    return body.result?.events?.some((event) => event.type === "mdbase.record.created" && event.payload.path === "sessions/first.md")
      ? body.result
      : null;
  }, "filesystem create event did not reach the change journal");
  const createdEvent = createdChanges.events.find((event) => event.type === "mdbase.record.created");
  if ("after" in createdEvent.payload || "before" in createdEvent.payload) {
    throw new Error("Change feed persisted record contents");
  }

  const update = await rawOperation(collection.id, "update", accessToken, {
    path: "sessions/first.md",
    fields: { status: "done" },
    if_revision: firstRevision
  });
  const updateBody = await update.json();
  const updatedRevision = updateBody.result?.result?.revision;
  if (update.status !== 200 || !updateBody.result?.valid || updatedRevision === firstRevision) {
    throw new Error(`Revision-safe update failed: ${JSON.stringify(updateBody)}`);
  }
  const conflict = await rawOperation(collection.id, "update", accessToken, {
    path: "sessions/first.md",
    fields: { title: "Lost update" },
    if_revision: firstRevision
  });
  const conflictBody = await conflict.json();
  if (conflict.status !== 200
      || conflictBody.result?.valid !== false
      || !conflictBody.result?.diagnostics?.some((diagnostic) => diagnostic.code === "concurrent_modification")) {
    throw new Error(`Stale revision was not rejected: ${JSON.stringify(conflictBody)}`);
  }

  const read = await rawOperation(collection.id, "read", accessToken, {
    path: "sessions/first.md"
  });
  const readBody = await read.json();
  if (read.status !== 200
      || readBody.result?.result?.frontmatter?.title !== "First connected workout"
      || readBody.result?.result?.frontmatter?.status !== "done") {
    throw new Error(`Unexpected relay read response: ${JSON.stringify(readBody)}`);
  }
  const bulkQuery = await rawOperation(collection.id, "query", accessToken, { limit: 1_100 });
  const bulkQueryBody = await bulkQuery.json();
  if (bulkQuery.status !== 200 || bulkQueryBody.result?.result?.results?.length < 1_001) {
    throw new Error(`Direct 1,000-record query was incomplete: ${JSON.stringify(bulkQueryBody)}`);
  }
  const downgrade = await fetch(`${serverUrl}/v1/collections/${collection.id}/operations/read`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ path: "sessions/first.md" })
  });
  if (downgrade.status !== 426) {
    throw new Error(`Encrypted grant accepted plaintext downgrade with HTTP ${downgrade.status}`);
  }
  const replayEnvelope = await encryptRelayRequest(
    relayContext.store,
    relayContext.handle,
    relayContext.binding,
    "read",
    { path: "sessions/first.md" }
  );
  const replayFirst = await rawDirectEnvelope(replayEnvelope);
  if (replayFirst.status !== 200) throw new Error(`Fresh encrypted request failed with HTTP ${replayFirst.status}`);
  const replaySecond = await rawEncryptedEnvelope(collection.id, "read", accessToken, replayEnvelope);
  const replayFirstBody = await replayFirst.json();
  const replaySecondBody = await replaySecond.json();
  if (replaySecond.status !== 200
      || !sameEnvelope(replaySecondBody.envelope, replayFirstBody.envelope)) {
    throw new Error(`Direct-to-relay retry did not return the durable encrypted receipt: ${JSON.stringify({
      direct: replayFirstBody,
      relay: replaySecondBody,
      relayStatus: replaySecond.status
    })}`);
  }
  const tampered = {
    ...await encryptRelayRequest(
      relayContext.store,
      relayContext.handle,
      relayContext.binding,
      "read",
      { path: "sessions/first.md" }
    )
  };
  tampered.ciphertext = `${tampered.ciphertext.startsWith("A") ? "B" : "A"}${tampered.ciphertext.slice(1)}`;
  const tamperedResponse = await rawEncryptedEnvelope(collection.id, "read", accessToken, tampered);
  if (tamperedResponse.status !== 502
      || (await tamperedResponse.json()).error?.code !== "encrypted_relay_rejected") {
    throw new Error("Connector did not reject tampered ciphertext");
  }
  const privateRead = await rawOperation(collection.id, "read", accessToken, {
    path: "private.md"
  });
  const privateBody = await privateRead.json();
  if (privateRead.status !== 403 || privateBody.error?.code !== "access_denied") {
    throw new Error(`Contract scope exposed a private record: ${JSON.stringify(privateBody)}`);
  }
  const scopedQuery = await rawOperation(collection.id, "query", accessToken, {});
  const scopedQueryBody = await scopedQuery.json();
  if (scopedQuery.status !== 200
      || scopedQueryBody.result?.result?.results?.some((record) => record.path === "private.md")) {
    throw new Error(`Contract scope did not constrain query results: ${JSON.stringify(scopedQueryBody)}`);
  }

  await cliJson(["access", "pause", "true"]);
  const paused = await rawOperation(collection.id, "read", accessToken, {
    path: "sessions/first.md"
  });
  if (paused.status !== 403) throw new Error(`Paused local access returned HTTP ${paused.status}`);
  const localActivity = await cliJson(["activity", "--limit", "20"]);
  if (!localActivity.result.some((entry) => entry.outcome === "denied" && entry.operation === "read")) {
    throw new Error("Paused operation was not recorded in local activity");
  }
  await cliJson(["access", "pause", "false"]);

  await cliJson(["access", "revoke", token.body.grant_id]);
  const revoked = await rawOperation(collection.id, "read", accessToken, {
    path: "sessions/first.md"
  });
  if (revoked.status !== 403) throw new Error(`Revoked direct grant returned HTTP ${revoked.status}`);
  const revokedRefresh = await fetch(`${serverUrl}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshed.body.refresh_token,
      client_id: appId
    })
  });
  if (revokedRefresh.status !== 400) {
    throw new Error(`Revoked grant refreshed with HTTP ${revokedRefresh.status}`);
  }
  process.stdout.write("mdbase connect end-to-end MVP path passed\n");
} finally {
  if (agent) await stopAgent(agent);
  if (browserManifestServer) {
    await new Promise((resolveClose) => browserManifestServer.close(resolveClose));
  }
  if (manifestServer) await new Promise((resolveClose) => manifestServer.close(resolveClose));
  await app.close();
  await database.end();
  await rm(scratch, { recursive: true, force: true });
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
  child.stdout.on("data", (chunk) => process.stderr.write(`[agent] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[agent] ${chunk}`));
  return child;
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
  }, "local connector agent did not start");
}

async function request(path, options = {}) {
  const headers = {};
  let body;
  if (options.cookie) headers.cookie = options.cookie;
  if (options.body) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  if (options.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(options.form).toString();
  }
  const response = await fetch(`${serverUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body
  });
  const responseBody = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}: ${JSON.stringify(responseBody)}`);
  return { response, body: responseBody };
}

async function rawEncryptedEnvelope(collectionId, operation, accessToken, envelope) {
  return fetch(`${serverUrl}/v1/collections/${collectionId}/operations/${operation}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(envelope)
  });
}

async function rawDirectEnvelope(envelope) {
  if (!directOrigin) throw new Error("Direct origin is unavailable");
  return fetch(`${loopbackUrl}/v1/operations`, {
    method: "POST",
    headers: {
      origin: directOrigin,
      "content-type": "application/mdbase-connect+json"
    },
    body: JSON.stringify(envelope)
  });
}

async function rawOperation(collectionId, operation, accessToken, input) {
  if (!relayContext) {
    return rawEncryptedEnvelope(collectionId, operation, accessToken, input);
  }
  const encryptedRequest = await encryptRelayRequest(
    relayContext.store,
    relayContext.handle,
    relayContext.binding,
    operation,
    input
  );
  const response = await rawDirectEnvelope(encryptedRequest);
  if (!response.ok) return response;
  const routed = await response.json();
  const decrypted = await decryptRelayResponse(
    relayContext.store,
    relayContext.handle,
    relayContext.binding,
    encryptedRequest,
    routed.envelope
  );
  if (decrypted.ok) {
    return syntheticResponse(200, { ok: true, result: decrypted.result });
  }
  const denied = decrypted.error.code === "access_paused" || decrypted.error.code === "access_denied";
  return syntheticResponse(denied ? 403 : 502, { error: decrypted.error });
}

function syntheticResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; }
  };
}

function sameEnvelope(left, right) {
  const keys = Object.keys(left ?? {});
  return keys.length === Object.keys(right ?? {}).length
    && keys.every((key) => left[key] === right[key]);
}

async function poll(action, failureMessage) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await action();
    if (result) return result;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(failureMessage);
}

async function availableTcpPort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not reserve an end-to-end loopback port");
  }
  await new Promise((resolveClose) => server.close(resolveClose));
  return address.port;
}

async function openManifestServer() {
  const primary = await openApplicationServer(
    "MVP Workout App",
    [{ id: "tasknotes.task", version: 1 }]
  );
  const browser = await openApplicationServer("Browser direct E2E", [], "full_collection");
  return {
    server: primary.server,
    browserServer: browser.server,
    origin: primary.origin,
    browserOrigin: browser.origin,
    manifestUrl: primary.manifestUrl,
    browserManifestUrl: browser.manifestUrl,
    redirectUri: primary.redirectUri,
    browserRedirectUri: browser.redirectUri
  };
}

async function openApplicationServer(name, contracts, access) {
  const server = createServer(async (request, response) => {
    const address = server.address();
    const origin = `http://localhost:${address.port}`;
    if (request.url === "/client/index.js" || request.url === "/client/crypto.js") {
      response.setHeader("content-type", "text/javascript");
      response.end(await readFile(join(repoRoot, "packages", "client", "dist", request.url.split("/").at(-1))));
      return;
    }
    if (request.url === "/protocol/index.js") {
      response.setHeader("content-type", "text/javascript");
      response.end(await readFile(join(repoRoot, "packages", "protocol", "dist", "index.js")));
      return;
    }
    if (request.url === "/browser-e2e") {
      response.setHeader("content-type", "text/html");
      response.end(`<!doctype html>
<meta charset="utf-8">
<script type="importmap">{"imports":{"@mdbase/connect-protocol":"${origin}/protocol/index.js"}}</script>
<script type="module">
  import { MdbaseConnect, MemoryGrantKeyStore } from "${origin}/client/index.js";
  const keyStore = new MemoryGrantKeyStore();
  const key = await keyStore.create("browser-e2e-grant");
  globalThis.directHarness = {
    publicKey: key.publicKey,
    async exercise(config) {
      const tokenKey = \`mdbase-connect:token:\${config.serverUrl}:\${config.manifestUrl}\`;
      localStorage.setItem(tokenKey, JSON.stringify(config.token));
      const connect = new MdbaseConnect({
        serverUrl: config.serverUrl,
        manifestUrl: config.manifestUrl,
        redirectUri: config.redirectUri,
        keyStore,
        loopbackUrl: config.loopbackUrl
      });
      const status = await connect.requestDirectAccess();
      const description = await connect.describe();
      const created = await connect.create({
        path: "browser/direct.md",
        frontmatter: { type: "task", title: "Real browser direct", status: "open" },
        body: "Created in Chromium."
      });
      const revision = created.result.revision;
      const read = await connect.read({ path: "browser/direct.md" });
      const updated = await connect.update({
        path: "browser/direct.md",
        patch: { status: "done" },
        if_revision: revision
      });
      const readUpdated = await connect.read({ path: "browser/direct.md" });
      const renamed = await connect.rename({
        from: "browser/direct.md",
        to: "browser/renamed.md"
      });
      const query = await connect.query({ limit: 1_100 });
      const validated = await connect.validate();
      const typeDocument = \`---
kind: mdbase.type
name: browsernote
version: 1
description: Browser note
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    properties:
      title: { type: string }
---
\`;
      const createdType = await connect.createType({ document: typeDocument });
      const readType = await connect.readType({ name: "browsernote" });
      const updatedType = await connect.updateType({
        name: "browsernote",
        document: typeDocument.replace("Browser note", "Updated browser note"),
        if_revision: readType.result.revision
      });
      const views = await connect.listViews();
      const executedView = await connect.executeView({
        path: "TaskNotes/Views/tasks.base",
        view: "open-tasks"
      });
      const changed = await connect.changes({ after: description.change_cursor });
      const deleted = await connect.delete({ path: "browser/renamed.md" });
      return {
        status,
        route: connect.connection()?.route,
        records: query.result.results.length,
        read: read.result.body.includes("Created in Chromium"),
        updated: updated.valid && readUpdated.result.frontmatter.status === "done",
        renamed: renamed.result.path === "browser/renamed.md",
        validated: validated.valid,
        createdType: createdType.valid && createdType.result.path === "_types/browsernote.md",
        readType: readType.valid && readType.result.document.includes("Browser note"),
        updatedType: updatedType.valid && updatedType.result.document.includes("Updated browser note"),
        listedView: views.valid
          && views.result.views.some((document) =>
            document.source.path === "TaskNotes/Views/tasks.base"
              && document.views.some((view) => view.id === "open-tasks"
                && view.properties[1].key === "formula.lane"
                && view.properties[1].label === "Lane")
          ),
        executedView: executedView.valid
          && executedView.result.results.length === 1000
          && executedView.result.meta.groups[0].values.status === "open"
          && executedView.result.results[0].values["formula.lane"] === "Ready"
          && !("file.path" in executedView.result.results[0].values),
        changed: changed.events.length > 0,
        deleted: deleted.result.deleted
      };
    }
  };
</script>`);
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      manifest_version: 1,
      name,
      homepage: origin,
      redirect_uris: [`${origin}/auth/mdbase/callback`],
      requirements: { contracts, ...(access ? { access } : {}) }
    }));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  const origin = `http://localhost:${address.port}`;
  return {
    server,
    origin,
    manifestUrl: `${origin}/.well-known/mdbase-app.json`,
    redirectUri: `${origin}/auth/mdbase/callback`
  };
}
