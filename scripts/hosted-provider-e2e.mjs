import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { chromium, expect } from "@playwright/test";

process.env.NODE_ENV = "test";
const execute = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "..");
const providerBinary = resolve(
  process.env.MDBASE_CONNECT_PROVIDER_E2E_BINARY
    ?? join(repoRoot, "target", "debug", "mdbase-connect-hosted-provider")
);
const postgresContainer = `mdbase-connect-provider-e2e-${process.pid}`;
const databasePassword = `test-${crypto.randomUUID()}`;
const internalToken = `internal-${crypto.randomUUID()}-${crypto.randomUUID()}`;
const masterKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const mirrorRoot = await mkdtemp(join(tmpdir(), "mdbase-provider-mirror-"));
const writableMirrorRoot = await mkdtemp(join(tmpdir(), "mdbase-provider-writable-mirror-"));
const importMirrorRoot = await mkdtemp(join(tmpdir(), "mdbase-provider-import-mirror-"));
const browserMirrorRoot = await mkdtemp(join(tmpdir(), "mdbase-provider-browser-mirror-"));
const mirrorStateRoot = await mkdtemp(join(tmpdir(), "mdbase-provider-mirror-state-"));
process.env.MDBASE_CONNECT_MIRROR_STATE_DIR = mirrorStateRoot;
const children = new Set();
let postgresStarted = false;
let controlApp;
let controlDatabase;
let manifestServer;
let notificationCallbackServer;

const { HttpSyncTransport, MemoryReplicaStore, OfflineReplica, SyncError } =
  await import("../packages/sync/dist/index.js");
const { DirectoryMirror, MirrorDivergenceError } = await import("../packages/sync/dist/node.js");
const { mirrorProfileDirectory } = await import("../packages/sync/dist/device.js");
const { resolveTasknotesSyncContract, TasknotesOfflineCollection } =
  await import("../packages/tasknotes/dist/index.js");
const { MdbaseConnect, MemoryGrantKeyStore } = await import("../packages/client/dist/index.js");
const { buildApp } = await import("../services/server/dist/app.js");
const { createDatabase } = await import("../services/server/dist/db.js");
const { HostedProviderClient } = await import("../services/server/dist/hosted-provider.js");

try {
  phase("starting disposable PostgreSQL 18");
  const databaseUrl = await startPostgres();
  let provider = await startProvider(databaseUrl);
  await assert.rejects(
    () => startProvider(
      databaseUrl,
      0,
      Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
    ),
    /Provider exited during startup/
  );

  phase("checking HTTP and credential boundaries");
  assert.equal((await rawRequest(provider.url, "/health")).status, 200);
  assert.equal((await rawRequest(provider.url, "/ready")).status, 200);
  assert.equal(
    (await rawRequest(provider.url, "/internal/v1/collections", { method: "POST", body: {} })).status,
    401
  );
  const preflight = await rawRequest(provider.url, syncPath(crypto.randomUUID(), "sessions"), {
    method: "OPTIONS",
    headers: {
      origin: "http://127.0.0.1",
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization,content-type"
    }
  });
  assert.ok([200, 204].includes(preflight.status));
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
  const publicPreflight = await rawRequest(provider.url, syncPath(crypto.randomUUID(), "sessions"), {
    method: "OPTIONS",
    headers: {
      origin: "https://evil.example",
      "access-control-request-method": "POST"
    }
  });
  assert.equal(publicPreflight.headers.get("access-control-allow-origin"), "*");

  phase("provisioning a portable application type through the internal authority");
  const provisionCollectionId = crypto.randomUUID();
  await internalRequest(provider.url, "/internal/v1/collections", {
    method: "POST",
    body: { collection_id: provisionCollectionId, template: "mdbase", display_name: "Provision probe" }
  });
  const typeProvision = {
    name: "Workout",
    document: "---\nkind: mdbase.type\nname: workout\nversion: 1\nschema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\nx-workout:\n  contract: workout.record\n  version: 1\n---\n",
    provides: [{ id: "workout.record", version: 1 }]
  };
  const provisionedTypes = await internalRequest(
    provider.url,
    `/internal/v1/collections/${provisionCollectionId}/types/provision`,
    { method: "POST", body: { types: [typeProvision] } }
  );
  assert.deepEqual(
    provisionedTypes.contracts.map(({ id, version, type_name }) => ({ id, version, type_name })),
    [{ id: "workout.record", version: 1, type_name: "workout" }]
  );
  const repeatedProvision = await internalRequest(
    provider.url,
    `/internal/v1/collections/${provisionCollectionId}/types/provision`,
    { method: "POST", body: { types: [typeProvision] } }
  );
  assert.equal(repeatedProvision.contracts.length, 1);
  await internalRequest(provider.url, `/internal/v1/collections/${provisionCollectionId}`, {
    method: "DELETE"
  });

  phase("running a hosted mutation through the durable notification runtime");
  const notificationSignals = [];
  const notificationRequests = [];
  const callbackPort = await availablePort();
  notificationCallbackServer = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    assert.equal(request.headers.authorization, `Bearer ${internalToken}`);
    const signal = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    notificationRequests.push(signal);
    if (notificationRequests.length === 1) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "temporarily_unavailable" } }));
      return;
    }
    notificationSignals.push(signal);
    response.writeHead(202, { "content-type": "application/json" });
    response.end(JSON.stringify({ accepted: true, duplicate: false }));
  });
  await new Promise((resolveListen, reject) => {
    notificationCallbackServer.once("error", reject);
    notificationCallbackServer.listen(callbackPort, "127.0.0.1", resolveListen);
  });
  const notificationProvider = await startProvider(databaseUrl, 0, masterKey, {
    MDBASE_CONNECT_CONTROL_PLANE_URL: `http://127.0.0.1:${callbackPort}`,
    MDBASE_CONNECT_HOSTED_MAINTENANCE_INTERVAL_SECONDS: "1",
    MDBASE_CONNECT_HOSTED_NOTIFICATION_INTERVAL_SECONDS: "1"
  });
  const notificationCollectionId = crypto.randomUUID();
  const notificationReplicaId = crypto.randomUUID();
  const notificationToken = `notification-${crypto.randomUUID()}-${crypto.randomUUID()}`;
  const notificationGrantId = crypto.randomUUID();
  const timerReplicaId = crypto.randomUUID();
  const timerToken = `timer-${crypto.randomUUID()}-${crypto.randomUUID()}`;
  await internalRequest(notificationProvider.url, "/internal/v1/collections", {
    method: "POST",
    body: {
      collection_id: notificationCollectionId,
      template: "tasknotes",
      display_name: "Notification tasks"
    }
  });
  await internalRequest(
    notificationProvider.url,
    `/internal/v1/collections/${notificationCollectionId}/replicas`,
    {
      method: "POST",
      body: {
        replica_id: notificationReplicaId,
        name: "Notification writer",
        mode: "read_write",
        allowed_types: ["task"],
        token: notificationToken
      }
    }
  );
  await internalRequest(
    notificationProvider.url,
    `/internal/v1/collections/${notificationCollectionId}/replicas`,
    {
      method: "POST",
      body: {
        replica_id: timerReplicaId,
        name: "Task reminder timer capability",
        purpose: "application",
        mode: "read_write",
        allowed_types: ["task"],
        allowed_operations: ["list_timers", "reconcile_timers"],
        grant_id: notificationGrantId,
        token: timerToken
      }
    }
  );
  await internalRequest(
    notificationProvider.url,
    `/internal/v1/collections/${notificationCollectionId}/notification-grants/${notificationGrantId}`,
    {
      method: "PUT",
      body: {
        id: notificationGrantId,
        application_id: crypto.randomUUID(),
        application_name: "Tasks",
        application_homepage: "https://tasks.example",
        application_origin: "https://tasks.example",
        collection_id: notificationCollectionId,
        collection_name: "Notification tasks",
        operations: ["changes", "list_timers", "reconcile_timers"],
        scope: { contracts: [], access: "full_collection" },
        notification_criteria: [
          {
            id: "task.created",
            event: { id: "mdbase.record.created", version: 1 },
            presentation: { title: "A task was created" }
          },
          {
            id: "task.reminder",
            event: { id: "timer.fired", version: 1 },
            presentation: { title: "Task reminder" }
          }
        ],
        created_at: new Date().toISOString()
      }
    }
  );
  const notificationReceipt = await new HttpSyncTransport(
    notificationProvider.url,
    notificationCollectionId,
    notificationToken
  ).mutate(createMutation(
    notificationReplicaId,
    crypto.randomUUID(),
    "tasks/private-notification.md",
    "Private notification title"
  ));
  assert.equal(notificationReceipt.status, "applied");
  const secondNotificationReceipt = await new HttpSyncTransport(
    notificationProvider.url,
    notificationCollectionId,
    notificationToken
  ).mutate(createMutation(
    notificationReplicaId,
    crypto.randomUUID(),
    "tasks/second-private-notification.md",
    "Second private notification title"
  ));
  assert.equal(secondNotificationReceipt.status, "applied");
  await waitFor(
    () => notificationSignals.length === 2,
    "Hosted runtime did not retry and emit both notification signals",
    600
  );
  assert.equal(notificationSignals[0].grant_id, notificationGrantId);
  assert.equal(notificationSignals[0].criterion_id, "task.created");
  assert.match(notificationSignals[0].signal_id, /^inv_/);
  assert.equal(JSON.stringify(notificationSignals[0]).includes("private-notification"), false);
  assert.equal(JSON.stringify(notificationSignals[0]).includes("Private notification title"), false);
  assert.equal(notificationRequests.length, 3);
  assert.deepEqual(notificationRequests[0], notificationRequests[1]);
  assert.equal(notificationSignals[1].criterion_id, "task.created");
  assert.equal(Number(notificationSignals[0].cursor) < Number(notificationSignals[1].cursor), true);
  assert.notEqual(notificationSignals[0].signal_id, notificationSignals[1].signal_id);
  const timerResponse = await rawRequest(
    notificationProvider.url,
    `/v1/hosted/collections/${notificationCollectionId}/operations/reconcile_timers`,
    {
      method: "POST",
      token: timerToken,
      body: {
        namespace: "task-reminders",
        criterion_id: "task.reminder",
        timers: [{
          id: "private-task:private-reminder",
          fire_at: new Date(Date.now() - 1_000).toISOString(),
          data: { private: "timer-state-stays-hosted" }
        }]
      }
    }
  );
  assert.equal(timerResponse.status, 200);
  const timerResult = timerResponse.body.result;
  assert.equal(timerResult.timers[0].id, "private-task:private-reminder");
  assert.equal(JSON.stringify(timerResult).includes(notificationGrantId), false);
  await waitFor(
    () => notificationSignals.length === 3,
    "Hosted authority did not fire the application timer",
    600
  );
  assert.equal(notificationSignals[2].grant_id, notificationGrantId);
  assert.equal(notificationSignals[2].criterion_id, "task.reminder");
  assert.equal(JSON.stringify(notificationSignals[2]).includes("private-task"), false);
  assert.equal(JSON.stringify(notificationSignals[2]).includes("timer-state-stays-hosted"), false);
  await stopProvider(notificationProvider);
  await new Promise((resolveClose) => notificationCallbackServer.close(resolveClose));
  notificationCallbackServer = undefined;

  phase("enforcing durable collection, document, and replica quotas");
  const quotaProvider = await startProvider(databaseUrl, 0, masterKey, {
    MDBASE_CONNECT_HOSTED_MAX_RECORDS_PER_COLLECTION: "1",
    MDBASE_CONNECT_HOSTED_MAX_BYTES_PER_COLLECTION: "1024",
    MDBASE_CONNECT_HOSTED_MAX_BYTES_PER_DOCUMENT: "512",
    MDBASE_CONNECT_HOSTED_MAX_REPLICAS_PER_COLLECTION: "1"
  });
  const quotaCollectionId = crypto.randomUUID();
  const quotaReplicaId = crypto.randomUUID();
  const quotaToken = `quota-${crypto.randomUUID()}-${crypto.randomUUID()}`;
  await internalRequest(quotaProvider.url, "/internal/v1/collections", {
    method: "POST",
    // Exercise the pre-display-name control-plane document during rolling upgrades.
    body: { collection_id: quotaCollectionId, template: "tasknotes" }
  });
  await internalRequest(quotaProvider.url, "/internal/v1/collections", {
    method: "POST",
    body: { collection_id: quotaCollectionId, template: "tasknotes" }
  });
  await internalRequest(
    quotaProvider.url,
    `/internal/v1/collections/${quotaCollectionId}/replicas`,
    {
      method: "POST",
      body: {
        replica_id: quotaReplicaId,
        name: "Quota writer",
        mode: "read_write",
        allowed_types: ["task"],
        token: quotaToken
      }
    }
  );
  await internalRequest(
    quotaProvider.url,
    `/internal/v1/collections/${quotaCollectionId}/replicas`,
    {
      method: "POST",
      body: {
        replica_id: quotaReplicaId,
        name: "Quota writer",
        mode: "read_write",
        allowed_types: ["task"],
        token: quotaToken
      }
    }
  );
  const changedReplicaRetry = await rawRequest(
    quotaProvider.url,
    `/internal/v1/collections/${quotaCollectionId}/replicas`,
    {
      method: "POST",
      token: internalToken,
      body: {
        replica_id: quotaReplicaId,
        name: "Changed retry",
        mode: "read_write",
        allowed_types: ["task"],
        token: quotaToken
      }
    }
  );
  assert.equal(changedReplicaRetry.status, 409);
  assert.equal(changedReplicaRetry.body.error.code, "replica_conflict");
  const replicaQuota = await rawRequest(
    quotaProvider.url,
    `/internal/v1/collections/${quotaCollectionId}/replicas`,
    {
      method: "POST",
      token: internalToken,
      body: {
        replica_id: crypto.randomUUID(),
        name: "Too many",
        mode: "read_only",
        allowed_types: ["task"],
        token: `quota-${crypto.randomUUID()}-${crypto.randomUUID()}`
      }
    }
  );
  assert.equal(replicaQuota.status, 429);
  assert.equal(replicaQuota.body.error.code, "replica_quota_exceeded");
  const quotaTransport = new HttpSyncTransport(quotaProvider.url, quotaCollectionId, quotaToken);
  const quotaRecordId = crypto.randomUUID();
  const quotaCreate = await quotaTransport.mutate(
    createMutation(quotaReplicaId, quotaRecordId, "tasks/within-quota.md", "Within quota")
  );
  assert.equal(quotaCreate.status, "applied");
  const recordQuota = await quotaTransport.mutate(
    createMutation(quotaReplicaId, crypto.randomUUID(), "tasks/too-many.md", "Too many")
  );
  assert.equal(recordQuota.status, "rejected");
  assert.equal(recordQuota.error.code, "collection_quota_exceeded");
  const documentQuota = await quotaTransport.mutate({
    ...updateMutation(quotaReplicaId, quotaCreate.record, { title: "Too large" }),
    input: { patch: { title: "Too large" }, body: "x".repeat(600) }
  });
  assert.equal(documentQuota.status, "rejected");
  assert.equal(documentQuota.error.code, "document_quota_exceeded");
  await stopProvider(quotaProvider);

  phase("automatically bounding retained change history");
  await execute("docker", [
    "exec",
    postgresContainer,
    "createdb",
    "--username", "mdbase",
    "mdbase_maintenance"
  ]);
  const maintenanceDatabaseUrl = databaseUrl.replace(/\/mdbase$/, "/mdbase_maintenance");
  const maintenanceProvider = await startProvider(maintenanceDatabaseUrl, 0, masterKey, {
    MDBASE_CONNECT_HOSTED_RETAIN_CHANGES: "1",
    MDBASE_CONNECT_HOSTED_MAINTENANCE_INTERVAL_SECONDS: "1"
  });
  const maintenanceCollectionId = crypto.randomUUID();
  const maintenanceReplicaId = crypto.randomUUID();
  const maintenanceToken = `maintenance-${crypto.randomUUID()}-${crypto.randomUUID()}`;
  await internalRequest(maintenanceProvider.url, "/internal/v1/collections", {
    method: "POST",
    body: { collection_id: maintenanceCollectionId, template: "tasknotes", display_name: "Maintenance tasks" }
  });
  await internalRequest(
    maintenanceProvider.url,
    `/internal/v1/collections/${maintenanceCollectionId}/replicas`,
    {
      method: "POST",
      body: {
        replica_id: maintenanceReplicaId,
        name: "Retention probe",
        mode: "read_write",
        allowed_types: ["task"],
        token: maintenanceToken
      }
    }
  );
  const maintenanceTransport = transport(maintenanceProvider.url, maintenanceCollectionId, {
    token: maintenanceToken
  });
  for (let index = 0; index < 3; index += 1) {
    const receipt = await maintenanceTransport.mutate(createMutation(
      maintenanceReplicaId,
      crypto.randomUUID(),
      `tasks/retention-${index}.md`,
      `Retention ${index}`
    ));
    assert.equal(receipt.status, "applied");
  }
  await waitFor(async () => (await maintenanceTransport.changes(0, 200)).reset_required, (
    "Provider did not compact retained history on schedule"
  ));
  await stopProvider(maintenanceProvider);

  phase("provisioning collections and replicas through the Node control plane");
  controlDatabase = await createDatabase("memory");
  const controlPort = await availablePort();
  const controlUrl = `http://127.0.0.1:${controlPort}`;
  ({ app: controlApp } = await buildApp({
    db: controlDatabase,
    devAuth: true,
    hostedCollections: true,
    hostedProvider: new HostedProviderClient({ url: provider.url, internalToken }),
    publicUrl: controlUrl,
    portalDist: join(repoRoot, "apps", "portal", "dist"),
    allowInsecureManifests: true
  }));
  await controlApp.listen({ host: "127.0.0.1", port: controlPort });
  const login = await rawRequest(controlUrl, "/v1/dev/session", {
    method: "POST",
    body: { name: "Hosted E2E", email: "hosted-e2e@example.com" }
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  const created = await controlRequest(controlUrl, "/v1/hosted/collections", cookie, {
    method: "POST",
    body: { display_name: "Task app data", template: "tasknotes" }
  });
  const collectionId = created.collection.id;
  assert.equal(created.collection.sync_url, provider.url);
  const other = await controlRequest(controlUrl, "/v1/hosted/collections", cookie, {
    method: "POST",
    body: { display_name: "Hosted writing", template: "mdbase" }
  });
  const genericCollectionId = other.collection.id;
  const writer = await registerReplica(controlUrl, cookie, collectionId, "Writer", "read_write", ["task"]);
  const reader = await registerReplica(controlUrl, cookie, collectionId, "Reader", "read_write", ["task"]);
  const mirror = await registerReplica(controlUrl, cookie, collectionId, "Mirror", "read_only", ["task"]);
  const writableMirror = await registerReplica(controlUrl, cookie, collectionId, "Writable mirror", "read_write", ["task"]);
  const importMirror = await registerReplica(controlUrl, cookie, collectionId, "Import mirror", "read_write", ["task"]);
  const readOnly = await registerReplica(controlUrl, cookie, collectionId, "Read only", "read_only", ["task"]);
  const hidden = await registerReplica(controlUrl, cookie, collectionId, "Hidden scope", "read_only", ["note"]);
  const recovery = await registerReplica(controlUrl, cookie, collectionId, "Recovery", "read_write", ["task"]);
  assert.equal(writer.syncUrl, provider.url);
  const deniedBrowserSync = await rawRequest(provider.url, syncPath(collectionId, "sessions"), {
    method: "POST",
    token: writer.token,
    headers: { origin: "https://evil.example" }
  });
  assert.equal(deniedBrowserSync.status, 403);
  assert.equal(deniedBrowserSync.body.error.code, "origin_denied");

  const payloadTable = await controlDatabase.query(
    "SELECT table_name FROM information_schema.tables WHERE table_name = 'hosted_authority_states'"
  );
  assert.equal(payloadTable.rows.length, 0);
  const metadata = await controlDatabase.query(
    "SELECT provider_url FROM hosted_collections WHERE id = $1",
    [collectionId]
  );
  assert.equal(metadata.rows[0].provider_url, provider.url);
  const credentialMetadata = await controlDatabase.query(
    "SELECT token_hash FROM hosted_replicas WHERE id = $1",
    [writer.id]
  );
  assert.equal(credentialMetadata.rows[0].token_hash, null);
  assert.equal(
    (
      await rawRequest(controlUrl, syncPath(collectionId, "mutations"), {
        method: "POST",
        token: writer.token,
        bodyText: "{not-json"
      })
    ).status,
    421
  );

  phase("exercising hosted lifecycle and writable enrollment in a real browser");
  await portalLifecycleE2E(controlUrl, browserMirrorRoot);

  phase("creating the first compatible hosted collection inside browser authorization");
  const emptyLogin = await rawRequest(controlUrl, "/v1/dev/session", {
    method: "POST",
    body: { name: "Inline E2E", email: "inline-hosted-e2e@example.com" }
  });
  assert.equal(emptyLogin.status, 200);
  const emptyCookie = emptyLogin.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(emptyCookie);
  const inlineManifest = await openManifestServer({
    name: "TaskNotes Inline E2E",
    requirements: { contracts: [{ id: "tasknotes.task", version: 1 }] }
  });
  try {
    const inlineStorage = memoryStorage();
    let inlineAuthorizationUrl;
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { assign: (value) => { inlineAuthorizationUrl = value; } }
    });
    const inlineSdk = new MdbaseConnect({
      serverUrl: controlUrl,
      manifest: inlineManifest.manifestUrl,
      redirectUri: inlineManifest.redirectUri,
      storage: inlineStorage,
      keyStore: new MemoryGrantKeyStore()
    });
    void inlineSdk.authorize(["describe", "read", "query", "create", "update"]);
    await waitFor(() => inlineAuthorizationUrl, "SDK did not start inline hosted authorization");
    const inlineCallback = await authorizeHostedApplicationByCreating(
      inlineAuthorizationUrl,
      emptyCookie,
      inlineManifest.origin
    );
    await inlineSdk.completeAuthorization(inlineCallback);
    const inlineToken = inlineStorage.token();
    assert.equal(inlineToken.hosted.providerUrl, provider.url);
    const inlineDescription = await inlineSdk.describe();
    assert.equal(inlineDescription.contracts[0]?.id, "tasknotes.task");
  } finally {
    await new Promise((resolveClose) => inlineManifest.server.close(resolveClose));
  }

  assert.equal(
    (await rawRequest(provider.url, syncPath(collectionId, "sessions"), { method: "POST" })).status,
    401
  );

  phase("authorizing the browser SDK directly against the hosted data plane");
  const manifest = await openManifestServer({
    requirements: { contracts: [], access: "full_collection" }
  });
  manifestServer = manifest.server;
  const storage = memoryStorage();
  let authorizationUrl;
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { assign: (value) => { authorizationUrl = value; } }
  });
  const hostedSdk = new MdbaseConnect({
    serverUrl: controlUrl,
    manifest: manifest.manifestUrl,
    redirectUri: manifest.redirectUri,
    storage,
    keyStore: new MemoryGrantKeyStore()
  });
  void hostedSdk.authorize([
    "describe", "changes", "read", "query", "list_views", "execute_view",
    "create", "update", "delete", "rename", "create_type"
  ]);
  await waitFor(() => authorizationUrl, "SDK did not start hosted authorization");
  const callbackUrl = await authorizeHostedApplication(
    authorizationUrl,
    cookie,
    genericCollectionId,
    manifest.origin
  );
  await hostedSdk.completeAuthorization(callbackUrl);
  const storedHostedToken = storage.token();
  assert.equal(storedHostedToken.hosted.providerUrl, provider.url);
  assert.equal(storedHostedToken.encryption, undefined);
  const appToken = storedHostedToken.hosted.accessToken;
  const appReplicaId = storedHostedToken.hosted.replicaId;
  const appSync = await rawRequest(provider.url, syncPath(genericCollectionId, "sessions"), {
    method: "POST",
    token: appToken,
    headers: { origin: manifest.origin }
  });
  assert.equal(appSync.status, 200);
  assert.equal(appSync.body.replica_id, appReplicaId);
  const wrongSyncOrigin = await rawRequest(
    provider.url,
    syncPath(genericCollectionId, "sessions"),
    {
      method: "POST",
      token: appToken,
      headers: { origin: "https://evil.example" }
    }
  );
  assert.equal(wrongSyncOrigin.status, 403);
  assert.equal(wrongSyncOrigin.body.error.code, "origin_denied");
  const wrongOrigin = await rawRequest(
    provider.url,
    `/v1/hosted/collections/${genericCollectionId}/operations/query`,
    {
      method: "POST",
      token: appToken,
      headers: { origin: "https://evil.example" },
      body: {}
    }
  );
  assert.equal(wrongOrigin.status, 403);
  assert.equal(wrongOrigin.body.error.code, "origin_denied");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init = {}) => {
    const url = String(input);
    if (!url.startsWith(`${provider.url}/v1/hosted/`)) return originalFetch(input, init);
    const headers = new Headers(init.headers);
    headers.set("origin", manifest.origin);
    return originalFetch(input, { ...init, headers });
  };
  const description = await hostedSdk.describe();
  assert.equal(description.display_name, "Hosted writing");
  assert.deepEqual(description.contracts, []);
  const sdkCreated = await hostedSdk.create({
    path: "Draft.md",
    frontmatter: { title: "Created through hosted SDK" },
    body: "Generic mdbase Markdown."
  });
  assert.equal(sdkCreated.valid, true);
  assert.deepEqual(sdkCreated.result.types, []);
  const sdkUpdated = await hostedSdk.update({
    path: "Draft.md",
    fields: { title: "Updated through hosted SDK" },
    if_revision: sdkCreated.result.revision
  });
  assert.equal(sdkUpdated.valid, true);
  const sdkRenamed = await hostedSdk.rename({
    from: "Draft.md",
    to: "Writing/Draft.md",
    if_revision: sdkUpdated.result.revision
  });
  assert.equal(sdkRenamed.valid, true);
  assert.equal((await hostedSdk.query()).result.results[0].path, "Writing/Draft.md");
  const viewType = await hostedSdk.createType({
    document: `---
kind: mdbase.type
name: view
version: 1
match:
  where:
    type: view
schema:
  dialect: json-schema-2020-12
  value:
    type: object
---
`
  });
  assert.equal(viewType.valid, true);
  const viewRecord = await hostedSdk.create({
    path: "Views/writing.md",
    frontmatter: {
      type: "view",
      id: "writing.views",
      version: 1,
      name: "Writing views",
      properties: {
        "projection.display_title": { label: "Display title" }
      },
      query: {
        where: 'file.path != "Views/writing.md"',
        projections: { display_title: { expr: 'title + "!"' } }
      },
      views: [{
        id: "all",
        name: "All writing",
        select: ["title", "projection.display_title"]
      }]
    }
  });
  assert.equal(viewRecord.valid, true);
  const listedViews = await hostedSdk.listViews();
  assert.equal(listedViews.valid, true);
  assert.equal(listedViews.result.views[0].views[0].id, "all");
  assert.deepEqual(listedViews.result.views[0].views[0].properties[1], {
    key: "display_title",
    label: "Display title"
  });
  const executedView = await hostedSdk.executeView({
    path: "Views/writing.md",
    view: "all"
  });
  assert.equal(executedView.valid, true);
  assert.deepEqual(
    executedView.result.results.map((record) => record.path),
    ["Writing/Draft.md"]
  );
  assert.equal(
    executedView.result.results[0].values.display_title,
    "Updated through hosted SDK!"
  );
  assert.equal((await hostedSdk.delete({
    path: "Views/writing.md",
    if_revision: viewRecord.result.revision
  })).valid, true);
  assert.equal((await hostedSdk.delete({
    path: "Writing/Draft.md",
    if_revision: sdkRenamed.result.revision
  })).valid, true);
  const hostedSync = hostedSdk.hostedSync();
  assert.ok(hostedSync);
  const offline = new OfflineReplica(hostedSync.transport, store(hostedSync.replicaId));
  await offline.initialize();
  await offline.queueCreate({
    recordId: crypto.randomUUID(),
    path: "Offline.md",
    frontmatter: { title: "Created through application sync" },
    body: "",
    types: []
  });
  await offline.sync();
  assert.equal((await offline.records())[0].frontmatter.title, "Created through application sync");
  globalThis.fetch = originalFetch;
  const dashboardWithApp = await controlRequest(controlUrl, "/v1/me", cookie);
  const hostedGrant = dashboardWithApp.grants.find((grant) => grant.collection_id === genericCollectionId);
  assert.ok(hostedGrant);
  assert.equal(hostedGrant.collection_kind, "hosted");
  assert.equal(
    dashboardWithApp.hosted_collections
      .find((collection) => collection.id === collectionId)
      .replicas.some((replica) => replica.id === appReplicaId),
    false
  );
  assert.equal(
    dashboardWithApp.hosted_collections
      .find((collection) => collection.id === genericCollectionId)
      .replicas.some((replica) => replica.id === appReplicaId),
    false
  );
  await controlRequest(controlUrl, `/v1/grants/${hostedGrant.id}`, cookie, {
    method: "PATCH",
    body: { operations: ["describe", "read", "query"] }
  });
  const deniedWrite = await rawRequest(
    provider.url,
    `/v1/hosted/collections/${genericCollectionId}/operations/create`,
    {
      method: "POST",
      token: appToken,
      headers: { origin: manifest.origin },
      body: {
        path: "permission-expansion.md",
        frontmatter: { title: "Must not exist" }
      }
    }
  );
  assert.equal(deniedWrite.status, 403);
  assert.equal(deniedWrite.body.error.code, "insufficient_access");
  const deniedChanges = await rawRequest(
    provider.url,
    `${syncPath(genericCollectionId, "changes")}?after=0&limit=10`,
    {
      method: "GET",
      token: appToken,
      headers: { origin: manifest.origin }
    }
  );
  assert.equal(deniedChanges.status, 403);
  assert.equal(deniedChanges.body.error.code, "insufficient_access");
  await controlRequest(controlUrl, `/v1/grants/${hostedGrant.id}`, cookie, { method: "DELETE" });
  const revokedApp = await rawRequest(
    provider.url,
    `/v1/hosted/collections/${genericCollectionId}/operations/query`,
    { method: "POST", token: appToken, headers: { origin: manifest.origin }, body: {} }
  );
  assert.equal(revokedApp.status, 401);
  assert.equal(
    (
      await rawRequest(provider.url, syncPath(genericCollectionId, "sessions"), {
        method: "POST",
        token: writer.token
      })
    ).status,
    401
  );

  phase("driving the Rust authority through the public TypeScript SDK");
  const writerTransport = transport(provider.url, collectionId, writer);
  const readerTransport = transport(provider.url, collectionId, reader);
  const recoveryTransport = transport(provider.url, collectionId, recovery);
  const writerClient = replica(writerTransport, writer.id);
  const readerClient = replica(readerTransport, reader.id);
  const recoveryStore = store(recovery.id);
  const recoveryClient = new OfflineReplica(recoveryTransport, recoveryStore);
  await Promise.all([writerClient.initialize(), readerClient.initialize(), recoveryClient.initialize()]);

  const resources = await writerClient.collectionResources();
  assert.ok(resources);
  const tasknotes = new TasknotesOfflineCollection(
    writerClient,
    resolveTasknotesSyncContract(resources)
  );
  const recordId = await tasknotes.create({
    title: "Created offline",
    path: "tasks/offline.md",
    body: "Created without a network round trip."
  });
  const originalMutation = structuredClone((await writerClient.pending())[0]);
  await tasknotes.sync();
  await readerClient.pull();
  assert.equal(findRecord(await readerClient.records(), recordId).frontmatter.title, "Created offline");
  const forbiddenPlaintextColumns = await postgresQuery(
    `SELECT table_name || '.' || column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name LIKE 'hosted_provider_%'
       AND column_name IN ('document', 'frontmatter', 'body', 'receipt')`
  );
  assert.equal(forbiddenPlaintextColumns, "");
  const encryptedPayload = await postgresQuery(
    `SELECT encode(payload_ciphertext, 'hex')
     FROM hosted_provider_records
     WHERE collection_id = '${collectionId}' AND record_id = '${recordId}'`
  );
  assert.ok(encryptedPayload.length > 64);
  assert.ok(!encryptedPayload.includes(Buffer.from("Created offline").toString("hex")));
  const plaintextRecordPaths = await postgresQuery(
    `SELECT table_name || '.' || column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name IN ('hosted_provider_records', 'hosted_provider_record_versions')
       AND column_name = 'path'`
  );
  assert.equal(plaintextRecordPaths, "");

  const replay = await writerTransport.mutate(originalMutation);
  assert.equal(replay.status, "previously_applied");
  assert.equal(replay.record?.path, "tasks/offline.md");
  await expectSyncError(
    () => writerTransport.mutate({
      ...originalMutation,
      input: { ...originalMutation.input, path: "tasks/reused-id.md" }
    }),
    "mutation_id_reused"
  );

  const readOnlyReceipt = await transport(provider.url, collectionId, readOnly).mutate(
    createMutation(readOnly.id, crypto.randomUUID(), "tasks/forbidden.md", "Forbidden")
  );
  assert.equal(readOnlyReceipt.status, "rejected");
  assert.equal(readOnlyReceipt.error.code, "replica_read_only");

  const duplicateRecord = await writerTransport.mutate(
    createMutation(writer.id, recordId, "tasks/duplicate-id.md", "Duplicate ID")
  );
  assert.equal(duplicateRecord.status, "rejected");
  assert.equal(duplicateRecord.error.code, "record_conflict");

  const missingPredecessor = await writerTransport.mutate({
    ...updateMutation(writer.id, findRecord(await writerClient.records(), recordId), { status: "done" }),
    causal_predecessor: crypto.randomUUID()
  });
  assert.equal(missingPredecessor.status, "rejected");
  assert.equal(missingPredecessor.error.code, "causal_predecessor_missing");

  phase("checking pinned snapshots, scope projection, and optimistic conflicts");
  const pinned = await readerTransport.openSession();
  const pinnedBefore = findRecord(await snapshotAll(readerTransport, pinned), recordId);
  await writerClient.queueUpdate({ recordId, patch: { status: "done" } });
  await writerClient.sync();
  const pinnedAfterMutation = findRecord(await snapshotAll(readerTransport, pinned), recordId);
  assert.equal(pinnedAfterMutation.revision, pinnedBefore.revision);
  assert.equal(pinnedAfterMutation.frontmatter.status, "open");

  const stale = findRecord(await readerClient.records(), recordId);
  await readerClient.queueUpdate({
    recordId,
    patch: { title: "Stale tablet edit" },
    baseRevision: stale.revision
  });
  await readerClient.sync();
  assert.equal((await readerClient.conflicts())[0].status, "conflicted");
  assert.equal((await readerClient.conflicts())[0].conflict.current.frontmatter.status, "done");
  const conflictedMutationId = (await readerClient.conflicts())[0].conflict.mutation.mutation_id;
  const afterConflict = await readerTransport.mutate({
    ...createMutation(reader.id, crypto.randomUUID(), "tasks/after-conflict.md", "After conflict"),
    causal_predecessor: conflictedMutationId
  });
  assert.equal(afterConflict.status, "rejected");
  assert.equal(afterConflict.error.code, "causal_predecessor_not_applied");

  const hiddenTransport = transport(provider.url, collectionId, hidden);
  const hiddenSession = await hiddenTransport.openSession();
  assert.deepEqual(hiddenSession.resources.types, []);
  assert.deepEqual((await snapshotAll(hiddenTransport, hiddenSession)), []);
  const hiddenChanges = await hiddenTransport.changes(0, 200);
  assert.deepEqual(hiddenChanges.events, []);
  assert.equal(hiddenChanges.cursor, hiddenChanges.head);

  phase("racing writers through two provider instances");
  const secondProvider = await startProvider(databaseUrl);
  const authority = findRecord(
    await snapshotAll(writerTransport, await writerTransport.openSession()),
    recordId
  );
  const [left, right] = await Promise.all([
    writerTransport.mutate(updateMutation(writer.id, authority, { title: "Writer one" })),
    transport(secondProvider.url, collectionId, reader).mutate(
      updateMutation(reader.id, authority, { title: "Writer two" })
    )
  ]);
  assert.deepEqual(
    [left.status, right.status].sort(),
    ["applied", "conflicted"]
  );
  const afterRace = await writerTransport.openSession();
  assert.equal(afterRace.head, authoritySequence(left, right));
  await stopProvider(secondProvider);

  phase("materializing, updating, renaming, and protecting a filesystem mirror");
  const symlinkMirrorRoot = await mkdtemp(join(tmpdir(), "mdbase-provider-symlink-mirror-"));
  const symlinkOutsideRoot = await mkdtemp(join(tmpdir(), "mdbase-provider-symlink-outside-"));
  try {
    await symlink(symlinkOutsideRoot, join(symlinkMirrorRoot, ".mdbase"), "dir");
    await execute(process.execPath, [
      join(repoRoot, "packages", "sync", "dist", "cli.js"),
      "init",
      symlinkMirrorRoot,
      "--server", provider.url,
      "--collection", collectionId,
      "--replica", mirror.id
    ], {
      env: { ...process.env, MDBASE_CONNECT_REPLICA_TOKEN: mirror.token }
    });
    await assert.rejects(
      () => readFile(join(symlinkOutsideRoot, "connect-mirror.json"), "utf8"),
      { code: "ENOENT" }
    );
    assert.equal(
      (await stat(join(await mirrorProfileDirectory(symlinkMirrorRoot), "credentials.json"))).mode & 0o777,
      0o600
    );
  } finally {
    await rm(symlinkMirrorRoot, { recursive: true, force: true });
    await rm(symlinkOutsideRoot, { recursive: true, force: true });
  }
  await execute(process.execPath, [
    join(repoRoot, "packages", "sync", "dist", "cli.js"),
    "init",
    mirrorRoot,
    "--server", provider.url,
    "--collection", collectionId,
    "--replica", mirror.id
  ], {
    env: { ...process.env, MDBASE_CONNECT_REPLICA_TOKEN: mirror.token }
  });
  const mirrorProfileRoot = await mirrorProfileDirectory(mirrorRoot);
  const configurationMode = (await stat(join(mirrorProfileRoot, "credentials.json"))).mode & 0o777;
  assert.equal(configurationMode, 0o600);
  await assert.rejects(
    () => readFile(join(mirrorRoot, ".mdbase", "connect-mirror.json"), "utf8"),
    { code: "ENOENT" }
  );
  assert.match(await readFile(join(mirrorRoot, "mdbase.yaml"), "utf8"), /spec_version: 0\.3\.0/);
  assert.match(await readFile(join(mirrorRoot, "_types", "task.md"), "utf8"), /x-tasknotes:/);
  const directoryMirror = new DirectoryMirror(
    mirrorRoot,
    mirror.id,
    transport(provider.url, collectionId, mirror)
  );
  const originalMirror = await readFile(join(mirrorRoot, "tasks", "offline.md"), "utf8");
  assert.match(originalMirror, /status: done/);
  await writeFile(join(mirrorRoot, "tasks", "offline.md"), `${originalMirror}\nlocal divergence\n`);
  await assert.rejects(() => directoryMirror.sync(), MirrorDivergenceError);
  await writeFile(join(mirrorRoot, "tasks", "offline.md"), originalMirror);

  await writerClient.initialize();
  await writerClient.queueRename({ recordId, path: "tasks/renamed.md" });
  await writerClient.sync();
  await directoryMirror.sync();
  await assert.rejects(() => readFile(join(mirrorRoot, "tasks", "offline.md"), "utf8"), { code: "ENOENT" });
  assert.match(await readFile(join(mirrorRoot, "tasks", "renamed.md"), "utf8"), /type: task/);

  phase("round-tripping writable files with stable identity and explicit conflict resolution");
  const mirrorCli = join(repoRoot, "packages", "sync", "dist", "cli.js");
  await writeFile(
    join(importMirrorRoot, "imported-before-init.md"),
    "---\ntype: task\ntitle: Imported during init\nstatus: open\n---\nAlready local.\n"
  );
  await execute(process.execPath, [
    mirrorCli,
    "init",
    importMirrorRoot,
    "--server", provider.url,
    "--collection", collectionId,
    "--replica", importMirror.id,
    "--writable"
  ], {
    env: { ...process.env, MDBASE_CONNECT_REPLICA_TOKEN: importMirror.token }
  });
  assert.equal(
    (await snapshotAll(writerTransport, await writerTransport.openSession()))
      .some((record) => record.path === "imported-before-init.md"),
    true
  );
  await execute(process.execPath, [
    mirrorCli,
    "init",
    writableMirrorRoot,
    "--server", provider.url,
    "--collection", collectionId,
    "--replica", writableMirror.id,
    "--writable"
  ], {
    env: { ...process.env, MDBASE_CONNECT_REPLICA_TOKEN: writableMirror.token }
  });
  assert.equal(
    (
      await stat(join(await mirrorProfileDirectory(writableMirrorRoot), "credentials.json"))
    ).mode & 0o777,
    0o600
  );
  const writableOriginal = await readFile(join(writableMirrorRoot, "tasks", "renamed.md"), "utf8");
  const locallyUpdated = writableOriginal.replace(/title: .*\n/, "title: Edited on disk\n");
  await writeFile(join(writableMirrorRoot, "tasks", "renamed.md"), locallyUpdated);
  await execute(process.execPath, [mirrorCli, "sync", writableMirrorRoot]);
  let writableAuthority = findRecord(
    await snapshotAll(writerTransport, await writerTransport.openSession()),
    recordId
  );
  assert.equal(writableAuthority.frontmatter.title, "Edited on disk");

  await rename(
    join(writableMirrorRoot, "tasks", "renamed.md"),
    join(writableMirrorRoot, "tasks", "disk-renamed.md")
  );
  await execute(process.execPath, [mirrorCli, "sync", writableMirrorRoot]);
  writableAuthority = findRecord(
    await snapshotAll(writerTransport, await writerTransport.openSession()),
    recordId
  );
  assert.equal(writableAuthority.path, "tasks/disk-renamed.md");

  const localCreatedPath = join(writableMirrorRoot, "tasks", "local-created.md");
  await writeFile(localCreatedPath, "---\ntype: task\ntitle: Local creation\nstatus: open\n---\nCreated locally.\n");
  await execute(process.execPath, [mirrorCli, "sync", writableMirrorRoot]);
  let recordsAfterLocalCreate = await snapshotAll(writerTransport, await writerTransport.openSession());
  const locallyCreated = recordsAfterLocalCreate.find((record) => record.path === "tasks/local-created.md");
  assert.ok(locallyCreated);
  assert.equal(locallyCreated.body, "Created locally.\n");

  const localBeforeConflict = await readFile(join(writableMirrorRoot, "tasks", "disk-renamed.md"), "utf8");
  await writeFile(
    join(writableMirrorRoot, "tasks", "disk-renamed.md"),
    localBeforeConflict.replace(/title: .*\n/, "title: Local conflict winner\n")
  );
  const remoteDuringConflict = await writerTransport.mutate(
    updateMutation(writer.id, writableAuthority, { title: "Remote concurrent edit" })
  );
  assert.equal(remoteDuringConflict.status, "applied");
  const conflictedSync = await execute(process.execPath, [mirrorCli, "sync", writableMirrorRoot]);
  assert.match(conflictedSync.stdout, /Action needed for 1 note/);
  const conflictedStatus = JSON.parse(
    (await execute(process.execPath, [mirrorCli, "status", writableMirrorRoot, "--json"])).stdout
  );
  assert.equal(conflictedStatus.state, "attention");
  assert.equal(conflictedStatus.conflicts[0].record_id, recordId);
  await assert.rejects(
    () => readFile(join(writableMirrorRoot, ".mdbase", "conflicts", `${recordId}.json`), "utf8"),
    { code: "ENOENT" }
  );
  await execute(process.execPath, [
    mirrorCli, "resolve", writableMirrorRoot, recordId, "--use", "local"
  ]);
  await execute(process.execPath, [mirrorCli, "sync", writableMirrorRoot]);
  writableAuthority = findRecord(
    await snapshotAll(writerTransport, await writerTransport.openSession()),
    recordId
  );
  assert.equal(writableAuthority.frontmatter.title, "Local conflict winner");

  await unlink(localCreatedPath);
  await execute(process.execPath, [mirrorCli, "sync", writableMirrorRoot]);
  recordsAfterLocalCreate = await snapshotAll(writerTransport, await writerTransport.openSession());
  assert.equal(recordsAfterLocalCreate.some((record) => record.record_id === locallyCreated.record_id), false);

  const resourceDocument = await readFile(join(writableMirrorRoot, "_types", "task.md"), "utf8");
  await writeFile(join(writableMirrorRoot, "_types", "task.md"), `${resourceDocument}\nunsafe local schema edit\n`);
  await assert.rejects(
    () => execute(process.execPath, [mirrorCli, "sync", writableMirrorRoot]),
    (error) => /must be resolved before the mirror can continue/.test(error.stderr ?? "")
  );
  await writeFile(join(writableMirrorRoot, "_types", "task.md"), resourceDocument);

  phase("forcing pagination and validating a restart against durable state");
  const bulkCount = Number(process.env.MDBASE_CONNECT_PROVIDER_E2E_BULK_COUNT ?? 205);
  assert.ok(Number.isInteger(bulkCount) && bulkCount >= 205 && bulkCount <= 20_000);
  const stressRun = bulkCount >= 10_000;
  let finalBulkRecordId;
  const recordsBeforeBulk = (
    await snapshotAll(writerTransport, await writerTransport.openSession())
  ).length;
  const mutationLatencies = [];
  for (let index = 0; index < bulkCount; index += 1) {
    const bulkRecordId = crypto.randomUUID();
    if (index === bulkCount - 1) finalBulkRecordId = bulkRecordId;
    const mutationStarted = performance.now();
    const receipt = await writerTransport.mutate(
      createMutation(
        writer.id,
        bulkRecordId,
        `tasks/bulk-${String(index).padStart(3, "0")}.md`,
        `Bulk ${index}`
      )
    );
    mutationLatencies.push(performance.now() - mutationStarted);
    assert.equal(receipt.status, "applied");
  }
  const pagedSession = await writerTransport.openSession();
  let pages = 0;
  let pagedRecords = [];
  let page;
  const snapshotStarted = performance.now();
  do {
    const snapshot = await writerTransport.snapshot(pagedSession.snapshot_id, page);
    pages += 1;
    pagedRecords.push(...snapshot.records);
    page = snapshot.next_page;
  } while (page);
  const snapshotMs = performance.now() - snapshotStarted;
  assert.equal(pages, Math.ceil((bulkCount + recordsBeforeBulk) / 200));
  assert.equal(pagedRecords.length, bulkCount + recordsBeforeBulk);

  if (stressRun) {
    const changeLatencies = [];
    let changeCursor = 0;
    while (changeCursor < pagedSession.head) {
      const changesStarted = performance.now();
      const changes = await writerTransport.changes(changeCursor, 200);
      changeLatencies.push(performance.now() - changesStarted);
      assert.ok(changes.cursor > changeCursor);
      changeCursor = changes.cursor;
    }
    const benchmarkReplicaId = crypto.randomUUID();
    const benchmarkToken = `benchmark-${crypto.randomUUID()}-${crypto.randomUUID()}`;
    await internalRequest(provider.url, `/internal/v1/collections/${collectionId}/replicas`, {
      method: "POST",
      body: {
        replica_id: benchmarkReplicaId,
        name: "Performance probe",
        purpose: "application",
        grant_id: crypto.randomUUID(),
        mode: "read_only",
        allowed_types: ["task"],
        allowed_operations: ["read", "query"],
        token: benchmarkToken,
        token_ttl_seconds: 600
      }
    });
    const readLatencies = [];
    const queryLatencies = [];
    for (let index = 0; index < 25; index += 1) {
      let started = performance.now();
      const read = await rawRequest(
        provider.url,
        `/v1/hosted/collections/${collectionId}/operations/read`,
        { method: "POST", token: benchmarkToken, body: { path: "tasks/bulk-204.md" } }
      );
      readLatencies.push(performance.now() - started);
      assert.equal(read.status, 200);
      started = performance.now();
      const query = await rawRequest(
        provider.url,
        `/v1/hosted/collections/${collectionId}/operations/query`,
        { method: "POST", token: benchmarkToken, body: { types: ["task"], limit: 20 } }
      );
      queryLatencies.push(performance.now() - started);
      assert.equal(query.status, 200);
    }
    const result = {
      records: pagedRecords.length,
      mutation_p95_ms: percentile(mutationLatencies, 0.95),
      snapshot_ms: snapshotMs,
      change_page_p95_ms: percentile(changeLatencies, 0.95),
      warm_read_p95_ms: percentile(readLatencies, 0.95),
      warm_query_p95_ms: percentile(queryLatencies, 0.95)
    };
    process.stdout.write(`[provider-e2e] performance ${JSON.stringify(result)}\n`);
    assert.ok(result.mutation_p95_ms < 200, `mutation p95 budget exceeded: ${result.mutation_p95_ms}`);
    assert.ok(result.snapshot_ms < 10_000, `snapshot budget exceeded: ${result.snapshot_ms}`);
    assert.ok(result.change_page_p95_ms < 150, `change page p95 budget exceeded: ${result.change_page_p95_ms}`);
    assert.ok(result.warm_read_p95_ms < 100, `warm read p95 budget exceeded: ${result.warm_read_p95_ms}`);
    assert.ok(result.warm_query_p95_ms < 300, `warm query p95 budget exceeded: ${result.warm_query_p95_ms}`);
  }

  const durableHead = pagedSession.head;
  await stopProvider(provider);
  provider = await startProvider(databaseUrl, Number(new URL(provider.url).port));
  const restartedWriter = transport(provider.url, collectionId, writer);
  assert.equal((await restartedWriter.openSession()).head, durableHead);
  assert.equal(
    (await snapshotAll(restartedWriter, await restartedWriter.openSession())).length,
    bulkCount + recordsBeforeBulk
  );

  phase("restoring a logical backup into a fresh database");
  const providerPort = Number(new URL(provider.url).port);
  await stopProvider(provider);
  await execute("docker", [
    "exec",
    postgresContainer,
    "pg_dump",
    "--username", "mdbase",
    "--dbname", "mdbase",
    "--format", "custom",
    "--file", "/tmp/mdbase-provider.dump"
  ]);
  await execute("docker", [
    "exec",
    postgresContainer,
    "createdb",
    "--username", "mdbase",
    "mdbase_restore"
  ]);
  await execute("docker", [
    "exec",
    postgresContainer,
    "pg_restore",
    "--username", "mdbase",
    "--dbname", "mdbase_restore",
    "--exit-on-error",
    "/tmp/mdbase-provider.dump"
  ]);
  const restoredDatabaseUrl = databaseUrl.replace(/\/mdbase$/, "/mdbase_restore");
  provider = await startProvider(restoredDatabaseUrl, providerPort);
  const restoredWriter = transport(provider.url, collectionId, writer);
  assert.equal((await restoredWriter.openSession()).head, durableHead);
  assert.equal(
    (await snapshotAll(restoredWriter, await restoredWriter.openSession())).length,
    bulkCount + recordsBeforeBulk
  );
  await stopProvider(provider);
  provider = await startProvider(databaseUrl, providerPort);

  phase("checking reset recovery, token rotation, revocation, and body limits");
  const restartedRecoveryTransport = transport(provider.url, collectionId, recovery);
  const restartedRecoveryClient = new OfflineReplica(restartedRecoveryTransport, recoveryStore);
  const queuedId = crypto.randomUUID();
  await restartedRecoveryClient.queueCreate({
    mutationId: queuedId,
    path: "tasks/queued-during-reset.md",
    frontmatter: { type: "task", title: "Still queued" },
    types: ["task"]
  });
  const restartedWriterClient = replica(restartedWriter, writer.id);
  await restartedWriterClient.initialize();
  const leasedBeforeCompaction = await restartedWriter.openSession();
  const leasedRecord = findRecord(
    await snapshotAll(restartedWriter, leasedBeforeCompaction),
    recordId
  );
  const postLeaseUpdate = await restartedWriter.mutate(
    updateMutation(writer.id, leasedRecord, { title: "Changed after snapshot lease" })
  );
  assert.equal(postLeaseUpdate.status, "applied");
  await restartedWriterClient.queueCreate({
    path: "tasks/advance-head.md",
    frontmatter: { type: "task", title: "Advance head" },
    types: ["task"]
  });
  await restartedWriterClient.sync();
  const compactHead = (await restartedWriter.openSession()).head;
  await controlRequest(
    controlUrl,
    `/v1/hosted/collections/${collectionId}/maintenance/compact`,
    cookie,
    { method: "POST", body: { through: compactHead } }
  );
  const pinnedAfterCompaction = findRecord(
    await snapshotAll(restartedWriter, leasedBeforeCompaction),
    recordId
  );
  assert.equal(pinnedAfterCompaction.revision, leasedRecord.revision);
  assert.notEqual(pinnedAfterCompaction.frontmatter.title, "Changed after snapshot lease");
  await restartedRecoveryClient.pull();
  assert.ok((await restartedRecoveryClient.pending()).some((item) => item.mutation_id === queuedId));

  const rotation = await controlRequest(
    controlUrl,
    `/v1/hosted/replicas/${recovery.id}/token`,
    cookie,
    { method: "POST" }
  );
  const rotatedToken = rotation.token;
  assert.equal(rotation.sync_url, provider.url);
  await expectSyncError(() => restartedRecoveryTransport.openSession(), "invalid_replica_token");
  await new HttpSyncTransport(provider.url, collectionId, rotatedToken).openSession();
  await controlRequest(controlUrl, `/v1/hosted/replicas/${recovery.id}`, cookie, {
    method: "DELETE"
  });
  await expectSyncError(
    () => new HttpSyncTransport(provider.url, collectionId, rotatedToken).openSession(),
    "invalid_replica_token"
  );

  const oversized = await rawRequest(provider.url, syncPath(collectionId, "mutations"), {
    method: "POST",
    token: writer.token,
    bodyText: JSON.stringify({ oversized: "x".repeat(3 * 1024 * 1024 + 1) })
  });
  assert.equal(oversized.status, 413);

  await postgresQuery(
    `UPDATE hosted_provider_record_versions
     SET payload_ciphertext = set_byte(
       payload_ciphertext,
       20,
       get_byte(payload_ciphertext, 20) # 1
     )
     WHERE collection_id = '${collectionId}' AND record_id = '${finalBulkRecordId}'`
  );
  await expectSyncError(
    async () => snapshotAll(restartedWriter, await restartedWriter.openSession()),
    "provider_internal_error"
  );

  process.stdout.write("mdbase PostgreSQL hosted provider e2e passed\n");
} finally {
  delete globalThis.location;
  if (notificationCallbackServer) {
    await new Promise((resolveClose) => notificationCallbackServer.close(resolveClose));
  }
  if (manifestServer) await new Promise((resolveClose) => manifestServer.close(resolveClose));
  if (controlApp) await controlApp.close();
  if (controlDatabase) await controlDatabase.end();
  for (const child of [...children]) await stopProvider(child);
  if (postgresStarted) {
    await execute("docker", ["rm", "-f", postgresContainer]).catch(() => {});
  }
  await rm(mirrorRoot, { recursive: true, force: true });
  await rm(writableMirrorRoot, { recursive: true, force: true });
  await rm(importMirrorRoot, { recursive: true, force: true });
  await rm(browserMirrorRoot, { recursive: true, force: true });
  await rm(mirrorStateRoot, { recursive: true, force: true });
}

function phase(message) {
  process.stdout.write(`[provider-e2e] ${message}\n`);
}

async function portalLifecycleE2E(controlUrl, browserMirrorDirectory) {
  const browser = await chromium.launch({ headless: true });
  let connector;
  try {
    const page = await browser.newPage();
    await page.goto(`${controlUrl}/login`);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { name: "Your connections." })).toBeVisible();

    await page.getByRole("button", { name: "Create hosted collection" }).click();
    await expect(page.getByText(/Starts as a clean mdbase 0\.3 collection/)).toBeVisible();
    await expect(page.getByText(/TaskNotes/)).toHaveCount(0);
    await page.getByLabel("Collection name").fill("Browser E2E collection");
    await page.getByRole("button", { name: "Create collection" }).click();
    const row = page.locator("article.hosted-row").filter({ hasText: "Browser E2E collection" });
    await expect(row).toBeVisible();
    await expect(row).toContainText("mdbase · authoritative on mdbase");

    const dashboard = await page.evaluate(async () => {
      const response = await fetch("/v1/me");
      return response.json();
    });
    const collectionId = dashboard.hosted_collections.find(
      (collection) => collection.display_name === "Browser E2E collection"
    ).id;
    await row.getByRole("button", { name: "Sync folder" }).click();
    await expect(row.locator("code").filter({ hasText: "mdbase-mirror connect" }))
      .toContainText(`--collection ${collectionId}`);
    await expect(row).toContainText("No credential is displayed or saved inside the folder");

    const mirrorCli = join(repoRoot, "packages", "sync", "dist", "cli.js");
    connector = spawn(process.execPath, [
      mirrorCli,
      "connect",
      browserMirrorDirectory,
      "--server", controlUrl,
      "--collection", collectionId,
      "--name", "Browser writable mirror",
      "--no-open"
    ], {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let connectorOutput = "";
    let connectorError = "";
    connector.stdout.on("data", (chunk) => { connectorOutput += chunk; });
    connector.stderr.on("data", (chunk) => { connectorError += chunk; });
    const verificationUri = await waitForOutput(
      () => connectorOutput.match(/https?:\/\/[^\s]+\/mirror\/[0-9a-f-]+/)?.[0],
      "Mirror CLI did not print a browser approval URL"
    );
    await page.goto(verificationUri);
    await expect(page.getByRole("heading", { name: "Browser writable mirror" })).toBeVisible();
    await expect(page.getByLabel("Hosted collection").locator("option:checked"))
      .toHaveText("Browser E2E collection");
    await page.getByRole("button", { name: "Sync this collection" }).click();
    await expect(page.getByRole("heading", { name: "Return to your computer." })).toBeVisible();
    const connectorExit = connector.exitCode
      ?? await new Promise((resolveExit) => connector.once("exit", resolveExit));
    assert.equal(connectorExit, 0, `Mirror CLI failed:\n${connectorError}\n${connectorOutput}`);
    assert.match(connectorOutput, /Sync connected/);
    await assert.rejects(
      () => readFile(join(browserMirrorDirectory, ".mdbase", "connect-mirror.json"), "utf8"),
      { code: "ENOENT" }
    );
    assert.equal(
      (
        await stat(join(await mirrorProfileDirectory(browserMirrorDirectory), "credentials.json"))
      ).mode & 0o777,
      0o600
    );
    const browserStatus = JSON.parse(
      (await execute(process.execPath, [mirrorCli, "status", browserMirrorDirectory, "--json"])).stdout
    );
    assert.equal(browserStatus.state, "up_to_date");

    await page.goto(controlUrl);
    const connectedRow = page.locator("article.hosted-row").filter({
      hasText: "Browser E2E collection"
    });
    await connectedRow.getByText("Manage mirrors").click();
    await expect(connectedRow).toContainText("Browser writable mirror");
    await expect(connectedRow).toContainText("Two-way · up to date");
    page.once("dialog", (dialog) => dialog.accept());
    await connectedRow.getByRole("button", { name: "Revoke" }).click();
    await expect(connectedRow).not.toContainText("Browser writable mirror");

    await connectedRow.getByRole("button", { name: "Rename" }).click();
    await connectedRow.getByLabel("Collection name").fill("Browser renamed collection");
    await connectedRow.getByRole("button", { name: "Save" }).click();
    const renamedRow = page.locator("article.hosted-row").filter({ hasText: "Browser renamed collection" });
    await expect(renamedRow).toBeVisible();
    page.once("dialog", (dialog) => dialog.accept());
    await renamedRow.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByText("Browser renamed collection", { exact: true })).toHaveCount(0);
  } finally {
    if (connector?.exitCode === null && connector.signalCode === null) connector.kill("SIGTERM");
    await browser.close();
  }
}

async function authorizeHostedApplication(authorizationUrl, cookie, collectionId, callbackOrigin) {
  const browser = await chromium.launch({ headless: true });
  try {
    const separator = cookie.indexOf("=");
    assert.ok(separator > 0, "Development session cookie is malformed");
    const context = await browser.newContext();
    await context.addCookies([{
      name: cookie.slice(0, separator),
      value: cookie.slice(separator + 1),
      url: new URL(authorizationUrl).origin
    }]);
    const page = await context.newPage();
    await page.goto(authorizationUrl);
    await expect(page.getByRole("heading", { name: "Hosted SDK E2E" })).toBeVisible();
    await expect(page.getByText("Hosted SDK E2E is asking to use one collection. Choose where it can work and review what it can do.")).toBeVisible();
    const collection = page.getByLabel("Collection and location");
    await expect(collection.locator("option")).toHaveCount(2);
    await collection.selectOption(collectionId);
    await expect(collection.locator("option:checked")).toHaveText("Hosted writing · Hosted by mdbase");
    await page.getByRole("button", { name: "Allow Hosted SDK E2E" }).click();
    const outcome = await Promise.race([
      page.waitForURL(
        (url) => url.origin === callbackOrigin && url.searchParams.has("code")
      ).then(() => "approved"),
      page.locator(".message.error").waitFor({ state: "visible" }).then(() => "error")
    ]);
    if (outcome === "error") {
      throw new Error(`Hosted authorization failed: ${await page.locator(".message.error").innerText()}`);
    }
    return page.url();
  } finally {
    await browser.close();
  }
}

async function authorizeHostedApplicationByCreating(authorizationUrl, cookie, callbackOrigin) {
  const browser = await chromium.launch({ headless: true });
  try {
    const separator = cookie.indexOf("=");
    assert.ok(separator > 0, "Development session cookie is malformed");
    const context = await browser.newContext();
    await context.addCookies([{
      name: cookie.slice(0, separator),
      value: cookie.slice(separator + 1),
      url: new URL(authorizationUrl).origin
    }]);
    const page = await context.newPage();
    await page.goto(authorizationUrl);
    await expect(page.getByRole("heading", { name: "TaskNotes Inline E2E" })).toBeVisible();
    const collection = page.getByLabel("Collection and location");
    await expect(collection.locator("option")).toHaveCount(1);
    await expect(collection.locator("option:checked")).toHaveText("No compatible collection");
    await expect(collection).toBeDisabled();
    await page.getByRole("button", { name: "Create an mdbase cloud collection" }).click();
    await expect(collection.locator("option")).toHaveCount(1);
    await expect(collection.locator("option:checked")).toHaveText("My tasks · mdbase cloud");
    await expect(collection).toBeEnabled();
    await page.getByRole("button", { name: "Allow TaskNotes Inline E2E" }).click();
    await page.waitForURL((url) => url.origin === callbackOrigin && url.searchParams.has("code"));
    return page.url();
  } finally {
    await browser.close();
  }
}

async function startPostgres() {
  await execute("docker", [
    "run", "--rm", "--detach", "--name", postgresContainer,
    "--env", "POSTGRES_USER=mdbase",
    "--env", `POSTGRES_PASSWORD=${databasePassword}`,
    "--env", "POSTGRES_DB=mdbase",
    "--publish", "127.0.0.1::5432",
    "postgres:18-alpine"
  ]);
  postgresStarted = true;
  const { stdout } = await execute("docker", ["port", postgresContainer, "5432/tcp"]);
  const port = stdout.trim().match(/:(\d+)$/)?.[1];
  if (!port) throw new Error(`Could not resolve PostgreSQL port from ${stdout}`);
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const ready = await execute(
      "docker",
      ["exec", postgresContainer, "pg_isready", "--username", "mdbase", "--dbname", "mdbase"]
    ).then(() => true, () => false);
    if (ready) return `postgres://mdbase:${databasePassword}@127.0.0.1:${port}/mdbase`;
    await delay(250);
  }
  const { stdout: logs = "" } = await execute("docker", ["logs", postgresContainer])
    .catch(() => ({ stdout: "" }));
  throw new Error(`PostgreSQL did not become ready\n${logs}`);
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a local port");
  await new Promise((resolveClose) => server.close(resolveClose));
  return address.port;
}

async function startProvider(
  databaseUrl,
  port = 0,
  providerMasterKey = masterKey,
  extraEnvironment = {}
) {
  const child = spawn(providerBinary, [], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      MDBASE_CONNECT_HOSTED_PROVIDER_INTERNAL_TOKEN: internalToken,
      MDBASE_CONNECT_HOSTED_PROVIDER_MASTER_KEY: providerMasterKey,
      HOST: "127.0.0.1",
      PORT: String(port),
      RUST_LOG: "warn",
      ...extraEnvironment
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  children.add(child);
  let logs = "";
  child.stderr.on("data", (chunk) => { logs += chunk; });
  const url = await new Promise((resolveUrl, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Provider startup timed out:\n${logs}`)), 20_000);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Provider exited during startup (${code}):\n${logs}`));
    });
    child.stdout.on("data", (chunk) => {
      logs += chunk;
      const match = logs.match(/HOSTED_PROVIDER_LISTENING=(http:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timeout);
        resolveUrl(match[1]);
      }
    });
  });
  child.url = url;
  child.logs = () => logs;
  return child;
}

async function stopProvider(child) {
  if (!child || !children.has(child)) return;
  children.delete(child);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await new Promise((resolveExit) => {
    if (child.exitCode !== null || child.signalCode !== null) resolveExit();
    else child.once("exit", resolveExit);
  });
}

async function postgresQuery(sql) {
  const { stdout } = await execute("docker", [
    "exec",
    postgresContainer,
    "psql",
    "--username", "mdbase",
    "--dbname", "mdbase",
    "--tuples-only",
    "--no-align",
    "--command", sql
  ]);
  return stdout.trim();
}

async function registerReplica(url, cookie, collectionId, name, mode, allowedTypes) {
  const response = await controlRequest(url, `/v1/hosted/collections/${collectionId}/replicas`, cookie, {
    method: "POST",
    body: {
      name,
      mode,
      allowed_types: allowedTypes
    }
  });
  return {
    id: response.replica.id,
    token: response.token,
    syncUrl: response.sync_url
  };
}

function transport(url, collectionId, replicaValue) {
  return new HttpSyncTransport(url, collectionId, replicaValue.token);
}

function store(replicaId) {
  return new MemoryReplicaStore({ replicaId, records: {}, pending: [], conflicts: {} });
}

function replica(syncTransport, replicaId) {
  return new OfflineReplica(syncTransport, store(replicaId));
}

function syncPath(collectionId, endpoint) {
  return `/v1/hosted/collections/${collectionId}/sync/${endpoint}`;
}

function createMutation(replicaId, recordId, path, title) {
  return {
    mutation_id: crypto.randomUUID(),
    replica_id: replicaId,
    scope_epoch: 1,
    operation: "create",
    record_id: recordId,
    input: {
      path,
      frontmatter: { type: "task", title, status: "open" },
      body: "",
      types: ["task"]
    },
    created_at: new Date().toISOString()
  };
}

function updateMutation(replicaId, record, patch) {
  return {
    mutation_id: crypto.randomUUID(),
    replica_id: replicaId,
    scope_epoch: 1,
    operation: "update",
    record_id: record.record_id,
    base_revision: record.revision,
    input: { patch },
    created_at: new Date().toISOString()
  };
}

async function snapshotAll(syncTransport, session) {
  const records = [];
  let page;
  do {
    const snapshot = await syncTransport.snapshot(session.snapshot_id, page);
    assert.equal(snapshot.cursor, session.head);
    records.push(...snapshot.records);
    page = snapshot.next_page;
  } while (page);
  return records;
}

function findRecord(records, recordId) {
  const record = records.find((candidate) => candidate.record_id === recordId);
  assert.ok(record, `Record ${recordId} was not found`);
  return record;
}

function authoritySequence(left, right) {
  const applied = [left, right].find((receipt) => receipt.status === "applied");
  assert.ok(applied);
  return applied.sequence;
}

async function internalRequest(url, path, options = {}) {
  const response = await rawRequest(url, path, { ...options, token: internalToken });
  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}: ${JSON.stringify(response.body)}`);
  }
  return response.body;
}

async function controlRequest(url, path, cookie, options = {}) {
  const response = await rawRequest(url, path, { ...options, cookie });
  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}: ${JSON.stringify(response.body)}`);
  }
  return response.body;
}

async function rawRequest(url, path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.cookie) headers.cookie = options.cookie;
  let body;
  if (options.bodyText !== undefined) {
    body = options.bodyText;
    headers["content-type"] = "application/json";
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers["content-type"] = "application/json";
  }
  const response = await fetch(`${url}${path}`, {
    method: options.method ?? "GET",
    headers,
    body
  });
  const text = await response.text();
  let responseBody;
  try {
    responseBody = text ? JSON.parse(text) : undefined;
  } catch {
    responseBody = text;
  }
  return {
    ok: response.ok,
    status: response.status,
    body: responseBody,
    headers: response.headers
  };
}

async function expectSyncError(action, code) {
  await assert.rejects(action, (error) => error instanceof SyncError && error.code === code);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function percentile(values, quantile) {
  const ordered = [...values].sort((left, right) => left - right);
  return Number(ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * quantile))].toFixed(2));
}

async function waitFor(action, message, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await action();
    if (value) return value;
    await delay(25);
  }
  throw new Error(message);
}

async function waitForOutput(action, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = action();
    if (value) return value;
    await delay(50);
  }
  throw new Error(message);
}

async function openManifestServer({
  name = "Hosted SDK E2E",
  requirements = { contracts: [] }
} = {}) {
  const server = createServer((_request, response) => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Manifest server is unavailable");
    const origin = `http://127.0.0.1:${address.port}`;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      manifest_version: 1,
      id: name === "TaskNotes Inline E2E"
        ? "dev.mdbase.tasknotes-inline-e2e"
        : "dev.mdbase.hosted-sdk-e2e",
      name,
      homepage: origin,
      redirect_uris: [`${origin}/auth/mdbase/callback`],
      requirements
    }));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Manifest server is unavailable");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    server,
    origin,
    manifestUrl: `${origin}/.well-known/mdbase-app.json`,
    redirectUri: `${origin}/auth/mdbase/callback`
  };
}

function memoryStorage() {
  const values = new Map();
  return {
    get length() { return values.size; },
    clear() { values.clear(); },
    getItem(key) { return values.get(key) ?? null; },
    key(index) { return [...values.keys()][index] ?? null; },
    removeItem(key) { values.delete(key); },
    setItem(key, value) { values.set(key, String(value)); },
    token() {
      const value = [...values.entries()]
        .find(([key]) => key.startsWith("mdbase-connect:token:"))?.[1];
      assert.ok(value, "SDK did not persist a hosted token");
      return JSON.parse(value);
    }
  };
}
