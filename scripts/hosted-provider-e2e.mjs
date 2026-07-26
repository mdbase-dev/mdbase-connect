import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
const authorityMirrorRoot = await mkdtemp(join(tmpdir(), "mdbase-provider-authority-mirror-"));
const promotionMirrorRoot = await mkdtemp(join(tmpdir(), "mdbase-provider-promotion-mirror-"));
const promotionToolRoot = await mkdtemp(join(tmpdir(), "mdbase-provider-promotion-tool-"));
const mirrorStateRoot = await mkdtemp(join(tmpdir(), "mdbase-provider-mirror-state-"));
const portableRoot = await mkdtemp(join(tmpdir(), "mdbase-provider-portable-"));
process.env.MDBASE_CONNECT_MIRROR_STATE_DIR = mirrorStateRoot;
const children = new Set();
let postgresStarted = false;
let controlApp;
let controlDatabase;
let manifestServer;
let notificationCallbackServer;
const WORK_ITEM_PROVISION = {
  name: "task",
  document: "---\nkind: mdbase.type\nname: task\nversion: 1\nschema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\n    required: [type, title]\n    properties:\n      type: { const: task }\n      title: { type: string }\n      status: { enum: [open, done] }\nx-example:\n  contract: example.work-item\n  version: 1\n---\n",
  provides: [{ id: "example.work-item", version: 1 }]
};

const { HttpSyncTransport, MemoryReplicaStore, OfflineReplica, SyncError } =
  await import("../packages/sync/dist/index.js");
const {
  DirectoryMirror,
  MirrorDivergenceError,
  WritableDirectoryMirror
} = await import("../packages/sync/dist/node.js");
const { mirrorProfileDirectory } = await import("../packages/sync/dist/device.js");
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
      template: "mdbase",
      display_name: "Notification records"
    }
  });
  await provisionTypes(notificationProvider.url, notificationCollectionId, [WORK_ITEM_PROVISION]);
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
    body: {
      collection_id: quotaCollectionId,
      template: "mdbase",
      display_name: "Quota worklog"
    }
  });
  await internalRequest(quotaProvider.url, "/internal/v1/collections", {
    method: "POST",
    body: {
      collection_id: quotaCollectionId,
      template: "mdbase",
      display_name: "Quota worklog"
    }
  });
  await provisionTypes(quotaProvider.url, quotaCollectionId, [WORK_ITEM_PROVISION]);
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
    body: { collection_id: maintenanceCollectionId, template: "mdbase", display_name: "Maintenance records" }
  });
  await provisionTypes(maintenanceProvider.url, maintenanceCollectionId, [WORK_ITEM_PROVISION]);
  await internalRequest(
    maintenanceProvider.url,
    `/internal/v1/collections/${maintenanceCollectionId}/replicas`,
    {
      method: "POST",
      body: {
        replica_id: maintenanceReplicaId,
        name: "Retention probe",
        mode: "read_write",
        allowed_types: [],
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
    body: { display_name: "Hosted records", template: "mdbase" }
  });
  const collectionId = created.collection.id;
  assert.equal(created.collection.sync_url, provider.url);
  await provisionTypes(provider.url, collectionId, [WORK_ITEM_PROVISION]);
  const other = await controlRequest(controlUrl, "/v1/hosted/collections", cookie, {
    method: "POST",
    body: { display_name: "Hosted writing", template: "mdbase" }
  });
  const genericCollectionId = other.collection.id;
  const writer = await registerReplica(controlUrl, cookie, collectionId, "Writer", "read_write", []);
  const reader = await registerReplica(controlUrl, cookie, collectionId, "Reader", "read_write", []);
  const mirror = await registerReplica(controlUrl, cookie, collectionId, "Mirror", "read_only", []);
  const writableMirror = await registerReplica(controlUrl, cookie, collectionId, "Writable mirror", "read_write", []);
  const importMirror = await registerReplica(controlUrl, cookie, collectionId, "Import mirror", "read_write", []);
  const readOnly = await registerReplica(controlUrl, cookie, collectionId, "Read only", "read_only", []);
  const hidden = await registerReplica(controlUrl, cookie, collectionId, "Hidden scope", "read_only", ["note"]);
  const recovery = await registerReplica(controlUrl, cookie, collectionId, "Recovery", "read_write", []);
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

  phase("moving hosted authority through the CLI and browser confirmation flow");
  await authorityPromotionCliE2E(
    controlUrl,
    cookie,
    controlDatabase,
    promotionMirrorRoot,
    promotionToolRoot
  );

  phase("creating the first compatible hosted collection inside browser authorization");
  const emptyLogin = await rawRequest(controlUrl, "/v1/dev/session", {
    method: "POST",
    body: { name: "Inline E2E", email: "inline-hosted-e2e@example.com" }
  });
  assert.equal(emptyLogin.status, 200);
  const emptyCookie = emptyLogin.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(emptyCookie);
  const inlineManifest = await openManifestServer({
    name: "Workout Inline E2E",
    requirements: { contracts: [{ id: "workout.record", version: 1 }] },
    provisions: { types: [typeProvision] }
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
    void inlineSdk.authorize({
      operations: ["describe", "read", "query", "create", "update"]
    });
    await waitFor(() => inlineAuthorizationUrl, "SDK did not start inline hosted authorization");
    const inlineCallback = await authorizeHostedApplicationByCreating(
      inlineAuthorizationUrl,
      emptyCookie,
      inlineManifest.origin
    );
    const { connection: inlineConnection } = await inlineSdk.completeAuthorization(inlineCallback);
    const inlineToken = inlineStorage.token();
    assert.equal(inlineToken.hosted.providerUrl, provider.url);
    const inlineOriginalFetch = globalThis.fetch;
    globalThis.fetch = (input, init = {}) => {
      const url = String(input);
      if (!url.startsWith(`${provider.url}/v1/hosted/`)) {
        return inlineOriginalFetch(input, init);
      }
      const headers = new Headers(init.headers);
      headers.set("origin", inlineManifest.origin);
      return inlineOriginalFetch(input, { ...init, headers });
    };
    const inlineDescription = await inlineConnection.describe().finally(() => {
      globalThis.fetch = inlineOriginalFetch;
    });
    assert.equal(inlineDescription.contracts[0]?.id, "workout.record");
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
  void hostedSdk.authorize({
    operations: [
      "describe", "changes", "read", "query", "list_views", "execute_view",
      "create", "update", "delete", "rename", "create_type"
    ]
  });
  await waitFor(() => authorizationUrl, "SDK did not start hosted authorization");
  const callbackUrl = await authorizeHostedApplication(
    authorizationUrl,
    cookie,
    genericCollectionId,
    manifest.origin
  );
  const { connection: hostedConnection } = await hostedSdk.completeAuthorization(callbackUrl);
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
  const description = await hostedConnection.describe();
  assert.equal(description.display_name, "Hosted writing");
  assert.deepEqual(description.contracts, []);
  const sdkCreated = await hostedConnection.create({
    path: "Draft.md",
    frontmatter: { title: "Created through hosted SDK" },
    body: "Generic mdbase Markdown."
  });
  assert.equal(sdkCreated.valid, true);
  assert.deepEqual(sdkCreated.result.types, []);
  assert.deepEqual(sdkCreated.result.frontmatter, {
    title: "Created through hosted SDK"
  });
  assert.deepEqual(sdkCreated.result.effective_frontmatter, {
    title: "Created through hosted SDK"
  });
  assert.equal(sdkCreated.result.body, "Generic mdbase Markdown.\n");
  assert.equal(sdkCreated.result.file.name, "Draft.md");
  const sdkUpdated = await hostedConnection.update({
    path: "Draft.md",
    patch: { title: "Updated through hosted SDK" },
    if_revision: sdkCreated.result.revision
  });
  assert.equal(sdkUpdated.valid, true);
  assert.equal(sdkUpdated.result.frontmatter.title, "Updated through hosted SDK");
  assert.equal(
    sdkUpdated.result.effective_frontmatter.title,
    "Updated through hosted SDK"
  );
  assert.equal(sdkUpdated.result.file.name, "Draft.md");
  const sdkRenamed = await hostedConnection.rename({
    from: "Draft.md",
    to: "Writing/Draft.md",
    if_revision: sdkUpdated.result.revision
  });
  assert.equal(sdkRenamed.valid, true);
  assert.equal(sdkRenamed.result.path, "Writing/Draft.md");
  assert.equal(sdkRenamed.result.frontmatter.title, "Updated through hosted SDK");
  assert.equal(sdkRenamed.result.file.folder, "Writing");
  const defaultQuery = await hostedConnection.query();
  assert.equal(defaultQuery.result.results[0].path, "Writing/Draft.md");
  assert.equal(
    defaultQuery.result.results[0].effective_frontmatter.title,
    "Updated through hosted SDK"
  );
  assert.equal(defaultQuery.result.results[0].frontmatter, undefined);
  assert.equal(defaultQuery.result.results[0].file.path, "Writing/Draft.md");
  const bothQuery = await hostedConnection.query({ frontmatter_mode: "both" });
  assert.equal(
    bothQuery.result.results[0].frontmatter.title,
    "Updated through hosted SDK"
  );
  assert.equal(
    bothQuery.result.results[0].effective_frontmatter.title,
    "Updated through hosted SDK"
  );
  const viewType = await hostedConnection.createType({
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
  const viewRecord = await hostedConnection.create({
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
  const listedViews = await hostedConnection.listViews();
  assert.equal(listedViews.valid, true);
  assert.equal(listedViews.result.views[0].views[0].id, "all");
  assert.deepEqual(listedViews.result.views[0].views[0].properties[1], {
    key: "display_title",
    label: "Display title"
  });
  const executedView = await hostedConnection.executeView({
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
  assert.equal((await hostedConnection.delete({
    path: "Views/writing.md",
    if_revision: viewRecord.result.revision
  })).valid, true);
  assert.equal((await hostedConnection.delete({
    path: "Writing/Draft.md",
    if_revision: sdkRenamed.result.revision
  })).valid, true);
  const hostedSync = hostedConnection.hostedSync();
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

  phase("authorizing a real file URL directly against the hosted data plane");
  await portableHostedFileE2E(controlUrl, cookie, genericCollectionId, portableRoot);

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

  const createdOffline = await writerClient.queueCreate({
    path: "tasks/offline.md",
    frontmatter: { type: "task", title: "Created offline", status: "open" },
    body: "Created without a network round trip.",
    types: ["task"]
  });
  const recordId = createdOffline.record_id;
  const originalMutation = structuredClone((await writerClient.pending())[0]);
  await writerClient.sync();
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
  const hiddenChanges = await hiddenTransport.changes(hiddenSession.head, 200);
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
    await assert.rejects(
      () => execute(process.execPath, [
        join(repoRoot, "packages", "sync", "dist", "cli.js"),
        "init",
        symlinkMirrorRoot,
        "--server", provider.url,
        "--collection", collectionId,
        "--replica", mirror.id
      ], {
        env: { ...process.env, MDBASE_CONNECT_REPLICA_TOKEN: mirror.token }
      }),
      (error) => error.stderr.includes(
        ".mdbase must be an ordinary directory inside the mirrored folder."
      )
    );
    await assert.rejects(
      () => readFile(join(symlinkOutsideRoot, "connect-mirror.json"), "utf8"),
      { code: "ENOENT" }
    );
    await assert.rejects(
      async () => stat(join(
        await mirrorProfileDirectory(symlinkMirrorRoot),
        "credentials.json"
      )),
      { code: "ENOENT" }
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
  assert.match(await readFile(join(mirrorRoot, "_types", "task.md"), "utf8"), /x-example:/);
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
  assert.match(await readFile(join(mirrorRoot, "tasks", "renamed.md"), "utf8"), /title:/);

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

  phase("fencing, proving, completing, and cancelling authority transfers");
  const authorityCollectionId = crypto.randomUUID();
  const authorityReplicaId = crypto.randomUUID();
  const authorityToken = `authority-${crypto.randomUUID()}-${crypto.randomUUID()}`;
  await internalRequest(provider.url, "/internal/v1/collections", {
    method: "POST",
    body: {
      collection_id: authorityCollectionId,
      template: "mdbase",
      display_name: "Authority transfer probe"
    }
  });
  await internalRequest(
    provider.url,
    `/internal/v1/collections/${authorityCollectionId}/replicas`,
    {
      method: "POST",
      body: {
        replica_id: authorityReplicaId,
        name: "Promotion mirror",
        purpose: "mirror",
        mode: "read_write",
        allowed_types: [],
        token: authorityToken
      }
    }
  );
  const authorityTransport = new HttpSyncTransport(
    provider.url,
    authorityCollectionId,
    authorityToken
  );
  const authorityCreate = await authorityTransport.mutate({
    mutation_id: crypto.randomUUID(),
    replica_id: authorityReplicaId,
    scope_epoch: 1,
    operation: "create",
    record_id: crypto.randomUUID(),
    input: {
      path: "notes/authority.md",
      frontmatter: { title: "Authority" },
      body: "Durable Markdown.\n",
      types: []
    },
    created_at: new Date().toISOString()
  });
  assert.equal(authorityCreate.status, "applied");
  const authorityMirror = new WritableDirectoryMirror(
    authorityMirrorRoot,
    authorityReplicaId,
    authorityTransport
  );
  await authorityMirror.sync();
  assert.equal(
    await postgresQuery(
      `SELECT acknowledged_sequence
       FROM hosted_provider_replicas WHERE id = '${authorityReplicaId}'`
    ),
    "1"
  );
  const transferId = crypto.randomUUID();
  const preparedTransfer = await internalRequest(
    provider.url,
    `/internal/v1/collections/${authorityCollectionId}/authority-transfers`,
    {
      method: "POST",
      body: {
        transfer_id: transferId,
        replica_id: authorityReplicaId,
        ttl_seconds: 600
      }
    }
  );
  assert.equal(preparedTransfer.state, "prepared");
  assert.equal(preparedTransfer.final_head, 1);
  assert.equal(preparedTransfer.authority_epoch, 2);
  assert.match(preparedTransfer.manifest_digest, /^[a-f0-9]{64}$/);
  const fencedMutation = await rawRequest(
    provider.url,
    syncPath(authorityCollectionId, "mutations"),
    {
      method: "POST",
      token: authorityToken,
      body: {
        mutation_id: crypto.randomUUID(),
        replica_id: authorityReplicaId,
        scope_epoch: 1,
        operation: "create",
        record_id: crypto.randomUUID(),
        input: {
          path: "notes/fenced.md",
          frontmatter: { title: "Fenced" },
          body: "",
          types: []
        },
        created_at: new Date().toISOString()
      }
    }
  );
  assert.equal(fencedMutation.status, 404);
  assert.equal(fencedMutation.body.error.code, "hosted_collection_not_found");
  await authorityMirror.sync();
  const authorityProof = await authorityMirror.authorityPromotionManifest();
  assert.equal(authorityProof.cursor, preparedTransfer.final_head);
  assert.equal(authorityProof.digest, preparedTransfer.manifest_digest);
  const mismatchedProof = await rawRequest(
    provider.url,
    `/internal/v1/authority-transfers/${transferId}`,
    {
      method: "POST",
      token: internalToken,
      body: { manifest_digest: "0".repeat(64) }
    }
  );
  assert.equal(mismatchedProof.status, 409);
  assert.equal(mismatchedProof.body.error.code, "authority_manifest_mismatch");
  const completedTransfer = await internalRequest(
    provider.url,
    `/internal/v1/authority-transfers/${transferId}`,
    {
      method: "POST",
      body: { manifest_digest: authorityProof.digest }
    }
  );
  assert.equal(completedTransfer.state, "completed");
  assert.equal(
    (await internalRequest(
      provider.url,
      `/internal/v1/authority-transfers/${transferId}`,
      {
        method: "POST",
        body: { manifest_digest: authorityProof.digest }
      }
    )).state,
    "completed"
  );
  await expectSyncError(() => authorityTransport.openSession(), "invalid_replica_token");
  assert.equal(
    await postgresQuery(
      `SELECT state || ':' || authority_epoch
       FROM hosted_provider_collections WHERE id = '${authorityCollectionId}'`
    ),
    "transferred:2"
  );

  const cancelledCollectionId = crypto.randomUUID();
  const cancelledReplicaId = crypto.randomUUID();
  const cancelledToken = `authority-cancel-${crypto.randomUUID()}-${crypto.randomUUID()}`;
  await internalRequest(provider.url, "/internal/v1/collections", {
    method: "POST",
    body: {
      collection_id: cancelledCollectionId,
      template: "mdbase",
      display_name: "Cancelled authority probe"
    }
  });
  await internalRequest(
    provider.url,
    `/internal/v1/collections/${cancelledCollectionId}/replicas`,
    {
      method: "POST",
      body: {
        replica_id: cancelledReplicaId,
        name: "Cancelled promotion mirror",
        mode: "read_write",
        allowed_types: [],
        token: cancelledToken
      }
    }
  );
  const cancelledTransferId = crypto.randomUUID();
  await internalRequest(
    provider.url,
    `/internal/v1/collections/${cancelledCollectionId}/authority-transfers`,
    {
      method: "POST",
      body: {
        transfer_id: cancelledTransferId,
        replica_id: cancelledReplicaId,
        ttl_seconds: 600
      }
    }
  );
  const cancelledTransfer = await internalRequest(
    provider.url,
    `/internal/v1/authority-transfers/${cancelledTransferId}`,
    { method: "DELETE" }
  );
  assert.equal(cancelledTransfer.state, "aborted");
  assert.equal(
    (await new HttpSyncTransport(
      provider.url,
      cancelledCollectionId,
      cancelledToken
    ).openSession()).head,
    0
  );

  phase("forcing pagination and validating a restart against durable state");
  const bulkCount = Number(process.env.MDBASE_CONNECT_PROVIDER_E2E_BULK_COUNT ?? 205);
  assert.ok(Number.isInteger(bulkCount) && bulkCount >= 205 && bulkCount <= 20_000);
  const stressRun = bulkCount >= 10_000;
  let finalBulkRecordId;
  const bulkStartSession = await writerTransport.openSession();
  const recordsBeforeBulk = (
    await snapshotAll(writerTransport, bulkStartSession)
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
    // Resource changes intentionally require a fresh snapshot. Start from the
    // snapshot immediately before this record-only bulk phase so the benchmark
    // measures its change pages instead of rediscovering that earlier reset.
    let changeCursor = bulkStartSession.head;
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
  await rm(authorityMirrorRoot, { recursive: true, force: true });
  await rm(promotionMirrorRoot, { recursive: true, force: true });
  await rm(promotionToolRoot, { recursive: true, force: true });
  await rm(mirrorStateRoot, { recursive: true, force: true });
  await rm(portableRoot, { recursive: true, force: true });
}

function phase(message) {
  process.stdout.write(`[provider-e2e] ${message}\n`);
}

async function portableHostedFileE2E(controlUrl, cookie, collectionId, directory) {
  const bundle = (await readFile(
    join(repoRoot, "packages", "client", "dist", "browser", "mdbase-connect.min.js"),
    "utf8"
  )).replaceAll("</script", "<\\/script");
  const file = join(directory, "portable-hosted.html");
  await writeFile(file, `<!doctype html>
<meta charset="utf-8">
<title>Portable hosted mdbase E2E</title>
<button id="connect">Connect</button>
<output id="code"></output>
<script>${bundle}</script>
<script>
  const manager = new MdbaseConnect.MdbaseConnect({
    serverUrl: ${JSON.stringify(controlUrl)},
    manifest: {
      manifest_version: 1,
      distribution: "portable",
      id: "dev.mdbase.portable-hosted-e2e",
      name: "Portable Hosted E2E",
      project_url: "https://apps.example/portable-hosted-e2e",
      requirements: {
        access: "full_collection",
        contracts: [],
        collection_kind: "hosted"
      }
    }
  });
  globalThis.portableHarness = {
    environment: manager.environment(),
    initialConnections: manager.connections().length
  };
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes("/v1/hosted/collections/") && init.headers?.authorization) {
      globalThis.portableHarness.capturedRequest = {
        url,
        method: init.method,
        headers: { ...init.headers },
        body: init.body
      };
    }
    return nativeFetch(input, init);
  };
  document.querySelector("#connect").onclick = () => {
    manager.authorize({
      operations: ["describe", "query", "create"],
      openVerification() {},
      onDeviceCode(authorization) {
        globalThis.portableHarness.authorization = authorization;
        document.querySelector("#code").textContent = authorization.userCode;
      }
    }).then(async ({ connection }) => {
      const created = await connection.create({
        path: "portable-hosted-e2e.md",
        frontmatter: { title: "Created from a downloaded file" },
        body: "Direct to the hosted provider."
      });
      const description = await connection.describe();
      const records = await connection.query({
        where: 'file.path == "portable-hosted-e2e.md"'
      });
      globalThis.portableHarness.result = {
        route: connection.route,
        collectionId: connection.collectionId,
        displayName: description.display_name,
        created: created.valid,
        records: records.result.results.length,
        connections: manager.connections().length
      };
    }).catch((error) => {
      globalThis.portableHarness.error = {
        code: error && error.code,
        message: error && error.message
      };
    });
  };
</script>`);

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(new URL(`file://${file}`).href);
    const environment = await page.evaluate(() => globalThis.portableHarness);
    assert.equal(environment.environment.applicationOrigin, "null");
    assert.equal(environment.environment.credentialStorage, "memory");
    assert.equal(environment.initialConnections, 0);
    await page.click("#connect");
    await page.waitForFunction(() => Boolean(globalThis.portableHarness.authorization));
    const authorization = await page.evaluate(
      () => globalThis.portableHarness.authorization
    );
    const claimed = await controlRequest(
      controlUrl,
      "/v1/device-authorization-requests/lookup",
      cookie,
      {
        method: "POST",
        body: { user_code: authorization.userCode }
      }
    );
    const pending = await controlRequest(
      controlUrl,
      `/v1/authorization-requests/${claimed.request_id}`,
      cookie
    );
    assert.ok(pending.collections.length > 0);
    assert.ok(pending.collections.every((collection) => collection.kind === "hosted"));
    assert.ok(pending.collections.some((collection) => collection.id === collectionId));
    await controlRequest(
      controlUrl,
      `/v1/authorization-requests/${claimed.request_id}/approve`,
      cookie,
      {
        method: "POST",
        body: {
          collection_id: collectionId,
          operations: ["describe", "query", "create"]
        }
      }
    );
    await page.waitForFunction(
      () => Boolean(globalThis.portableHarness.result || globalThis.portableHarness.error),
      undefined,
      { timeout: 20_000 }
    );
    const result = await page.evaluate(() => globalThis.portableHarness);
    assert.equal(result.error, undefined);
    assert.deepEqual(result.result, {
      route: "hosted",
      collectionId,
      displayName: "Hosted writing",
      created: true,
      records: 1,
      connections: 1
    });
    const captured = result.capturedRequest;
    assert.ok(captured.headers["x-mdbase-proof-signature"]);
    const noProof = await fetch(captured.url, {
      method: captured.method,
      headers: {
        authorization: captured.headers.authorization,
        "content-type": captured.headers["content-type"],
        origin: "null"
      },
      body: captured.body
    });
    assert.equal(noProof.status, 401);
    assert.equal((await noProof.json()).error.code, "hosted_proof_required");
    const noProofOrOrigin = await fetch(captured.url, {
      method: captured.method,
      headers: {
        authorization: captured.headers.authorization,
        "content-type": captured.headers["content-type"]
      },
      body: captured.body
    });
    assert.equal(noProofOrOrigin.status, 403);
    assert.equal((await noProofOrOrigin.json()).error.code, "origin_denied");
    const replay = await fetch(captured.url, {
      method: captured.method,
      headers: { ...captured.headers, origin: "null" },
      body: captured.body
    });
    assert.equal(replay.status, 401);
    assert.equal((await replay.json()).error.code, "hosted_proof_replayed");
    const tampered = await fetch(captured.url, {
      method: captured.method,
      headers: { ...captured.headers, origin: "null" },
      body: `${captured.body} `
    });
    assert.equal(tampered.status, 401);
    assert.equal((await tampered.json()).error.code, "invalid_hosted_proof");
    const missingOrigin = await fetch(captured.url, {
      method: captured.method,
      headers: captured.headers,
      body: captured.body
    });
    assert.equal(missingOrigin.status, 403);
    assert.equal((await missingOrigin.json()).error.code, "origin_denied");

    const independentPage = await context.newPage();
    await independentPage.goto(new URL(`file://${file}`).href);
    const independent = await independentPage.evaluate(() => globalThis.portableHarness);
    assert.equal(independent.initialConnections, 0);
    assert.equal(independent.environment.credentialStorage, "memory");
    await independentPage.close();
    await context.close();
  } finally {
    await browser.close();
  }
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
    await expect(page.getByText(/application-specific template/i)).toHaveCount(0);
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

async function authorityPromotionCliE2E(
  controlUrl,
  cookie,
  database,
  mirrorDirectory,
  toolDirectory
) {
  const hosted = await controlRequest(controlUrl, "/v1/hosted/collections", cookie, {
    method: "POST",
    body: { display_name: "Promotion E2E collection", template: "mdbase" }
  });
  const collectionId = hosted.collection.id;
  const mirrorCli = join(repoRoot, "packages", "sync", "dist", "cli.js");
  const connectProcess = spawn(process.execPath, [
    mirrorCli,
    "connect",
    mirrorDirectory,
    "--server", controlUrl,
    "--collection", collectionId,
    "--name", "Promotion computer",
    "--no-open"
  ], {
    cwd: repoRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let connectOutput = "";
  let connectError = "";
  connectProcess.stdout.on("data", (chunk) => { connectOutput += chunk; });
  connectProcess.stderr.on("data", (chunk) => { connectError += chunk; });
  const mirrorVerificationUri = await waitForOutput(
    () => connectOutput.match(/https?:\/\/[^\s]+\/mirror\/[0-9a-f-]+/)?.[0],
    "Promotion mirror did not print its approval URL"
  );
  const pairingId = new URL(mirrorVerificationUri).pathname.split("/").at(-1);
  await controlRequest(
    controlUrl,
    `/v1/mirror-pairing-requests/${pairingId}/approve`,
    cookie,
    { method: "POST", body: { collection_id: collectionId } }
  );
  const connectExit = connectProcess.exitCode
    ?? await new Promise((resolveExit) => connectProcess.once("exit", resolveExit));
  assert.equal(connectExit, 0, `Promotion mirror connect failed:\n${connectError}\n${connectOutput}`);

  const promotionStressCount = Number(
    process.env.MDBASE_CONNECT_PROVIDER_E2E_PROMOTION_COUNT ?? 0
  );
  assert.ok(
    Number.isInteger(promotionStressCount)
      && (promotionStressCount === 0 || promotionStressCount >= 205)
      && promotionStressCount <= 20_000
  );
  const promotionStress = promotionStressCount > 0
    ? await prepareAuthorityPromotionStressFixture(
        mirrorCli,
        mirrorDirectory,
        promotionStressCount
      )
    : null;

  const connector = await controlRequest(controlUrl, "/v1/connectors", cookie, {
    method: "POST",
    body: { name: "Promotion computer" }
  });
  const fakeConnectCli = join(toolDirectory, "mdbase-connect-e2e.mjs");
  await writeFile(fakeConnectCli, `#!/usr/bin/env node
import { readFile } from "node:fs/promises";
const args = process.argv.slice(2);
const collection = args.indexOf("collection");
const action = args[collection + 1];
let id = args[collection + 2] ?? "";
if (action === "add") {
  const source = await readFile(id + "/mdbase.yaml", "utf8");
  id = source.match(/collection_id:\\s*["']?([0-9a-f-]{36})/i)?.[1] ?? "";
  if (process.env.MDBASE_PROMOTION_PUBLISH !== "0") {
    const response = await fetch(process.env.MDBASE_PROMOTION_CONTROL_URL + "/v1/connectors/sync", {
      method: "POST",
      headers: {
        authorization: "Bearer " + process.env.MDBASE_PROMOTION_CONNECTOR_TOKEN,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        inventory_revision: 1,
        collections: [{
          id,
          display_name: "Promotion E2E collection",
          spec_version: "0.3.0",
          enabled: true,
          contracts: []
        }]
      })
    });
    if (!response.ok) {
      process.stderr.write(await response.text());
      process.exit(1);
    }
  }
}
process.stdout.write(JSON.stringify({
  id: crypto.randomUUID(),
  protocol_version: 1,
  ok: true,
  result: action === "add" ? { id } : { valid: true }
}) + "\\n");
`, { mode: 0o700 });

  const promotion = spawn(process.execPath, [
    mirrorCli,
    "promote",
    mirrorDirectory,
    "--no-open",
    "--connect-cli", fakeConnectCli
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      MDBASE_PROMOTION_CONTROL_URL: controlUrl,
      MDBASE_PROMOTION_CONNECTOR_TOKEN: connector.token,
      MDBASE_PROMOTION_PUBLISH: "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let promotionOutput = "";
  let promotionError = "";
  promotion.stdout.on("data", (chunk) => { promotionOutput += chunk; });
  promotion.stderr.on("data", (chunk) => { promotionError += chunk; });
  const transferUri = await waitForOutput(
    () => promotionOutput.match(/https?:\/\/[^\s]+\/transfer\/[0-9a-f-]+/)?.[0],
    "Promotion CLI did not print an authority confirmation URL"
  );
  const browser = await chromium.launch({ headless: true });
  try {
    const separator = cookie.indexOf("=");
    const context = await browser.newContext();
    await context.addCookies([{
      name: cookie.slice(0, separator),
      value: cookie.slice(separator + 1),
      url: controlUrl
    }]);
    const page = await context.newPage();
    await page.goto(transferUri);
    await expect(page.getByRole("heading", {
      name: "Make Promotion computer authoritative?"
    })).toBeVisible();
    await expect(page.getByText(
      "Existing access is revoked. Connect applications again to use the local collection."
    )).toBeVisible();
    await page.getByRole("button", { name: "Move authority" }).click();
    await waitForOutput(
      () => promotionOutput.includes("Local collection registered.") || undefined,
      "Promotion CLI did not materialize the local collection"
    );
    promotion.kill("SIGTERM");
    await new Promise((resolveExit) => promotion.once("exit", resolveExit));

    const resumedPromotion = spawn(process.execPath, [
      mirrorCli,
      "promote",
      mirrorDirectory,
      "--no-open",
      "--connect-cli", fakeConnectCli
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        MDBASE_PROMOTION_CONTROL_URL: controlUrl,
        MDBASE_PROMOTION_CONNECTOR_TOKEN: connector.token,
        MDBASE_PROMOTION_PUBLISH: "1"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let resumedOutput = "";
    let resumedError = "";
    resumedPromotion.stdout.on("data", (chunk) => { resumedOutput += chunk; });
    resumedPromotion.stderr.on("data", (chunk) => { resumedError += chunk; });
    const promotionExit = resumedPromotion.exitCode
      ?? await new Promise((resolveExit) => resumedPromotion.once("exit", resolveExit));
    assert.equal(
      promotionExit,
      0,
      `Promotion CLI resume failed:\n${resumedError}\n${resumedOutput}`
    );
    assert.match(resumedOutput, /Resuming the materialized authority handoff/);
    assert.match(resumedOutput, /Authority moved/);
    await expect(page.getByRole("heading", {
      name: "Promotion E2E collection now lives on your computer."
    })).toBeVisible();
  } finally {
    if (promotion.exitCode === null && promotion.signalCode === null) promotion.kill("SIGTERM");
    await browser.close();
  }

  assert.match(
    await readFile(join(mirrorDirectory, "mdbase.yaml"), "utf8"),
    new RegExp(`collection_id: ${collectionId}`)
  );
  const profileDirectory = await mirrorProfileDirectory(mirrorDirectory);
  await assert.rejects(
    () => readFile(join(profileDirectory, "credentials.json"), "utf8"),
    { code: "ENOENT" }
  );
  const authorityReceipt = JSON.parse(
    await readFile(join(profileDirectory, "authority.json"), "utf8")
  );
  assert.equal(authorityReceipt.collection_id, collectionId);
  assert.equal(authorityReceipt.authority_epoch, 2);
  if (promotionStress) {
    assert.equal(await countMarkdownFiles(mirrorDirectory), promotionStress.expectedCount);
    assert.match(
      await readFile(join(mirrorDirectory, promotionStress.updatedPath), "utf8"),
      /Updated during authority stress wave/
    );
    await assert.rejects(
      () => readFile(join(mirrorDirectory, promotionStress.deletedPath), "utf8"),
      { code: "ENOENT" }
    );
    assert.match(
      await readFile(join(mirrorDirectory, promotionStress.addedPath), "utf8"),
      /Added during authority stress wave/
    );
  }
  const state = await database.query(
    `SELECT hosted.authority_state AS hosted_state,
            local.authority_state AS local_state,
            local.enabled, local.authority_epoch
     FROM hosted_collections hosted
     JOIN collections local ON local.id = hosted.transferred_collection_id
     WHERE hosted.id = $1`,
    [collectionId]
  );
  assert.deepEqual(
    {
      hosted_state: state.rows[0].hosted_state,
      local_state: state.rows[0].local_state,
      enabled: state.rows[0].enabled,
      authority_epoch: Number(state.rows[0].authority_epoch)
    },
    {
      hosted_state: "transferred",
      local_state: "active",
      enabled: true,
      authority_epoch: 2
    }
  );
}

async function prepareAuthorityPromotionStressFixture(
  mirrorCli,
  mirrorDirectory,
  recordCount
) {
  phase(`preparing ${recordCount} complex documents for authority promotion`);
  const started = performance.now();
  const paths = Array.from(
    { length: recordCount },
    (_, index) => authorityStressPath(index)
  );
  await writeFilesInBatches(paths, 64, async (path, index) => {
    const absolutePath = join(mirrorDirectory, path);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, authorityStressDocument(index));
  });
  await syncPromotionMirror(mirrorCli, mirrorDirectory);

  const updateIndexes = paths
    .map((_, index) => index)
    .filter((index) => index >= 4 && index % 47 === 0);
  await writeFilesInBatches(updateIndexes, 64, async (index) => {
    const absolutePath = join(mirrorDirectory, paths[index]);
    const document = await readFile(absolutePath, "utf8");
    await writeFile(
      absolutePath,
      `${document}\nUpdated during authority stress wave ${index}.\n`
    );
  });
  await syncPromotionMirror(mirrorCli, mirrorDirectory);

  const renameIndexes = paths
    .map((_, index) => index)
    .filter((index) => index >= 4 && index % 83 === 0);
  for (const index of renameIndexes) {
    const nextPath = paths[index].replace(/\.md$/, "-renamed.md");
    await rename(join(mirrorDirectory, paths[index]), join(mirrorDirectory, nextPath));
    paths[index] = nextPath;
  }
  await syncPromotionMirror(mirrorCli, mirrorDirectory);

  const deleteIndexes = paths
    .map((_, index) => index)
    .filter((index) => index >= 4 && index % 101 === 0);
  const deletedPath = paths[deleteIndexes[0]];
  for (const index of deleteIndexes) {
    await unlink(join(mirrorDirectory, paths[index]));
  }
  await syncPromotionMirror(mirrorCli, mirrorDirectory);

  const addedCount = Math.min(25, Math.max(1, Math.ceil(recordCount / 200)));
  const addedPaths = Array.from(
    { length: addedCount },
    (_, index) => `stress/late-arrivals/added-${String(index).padStart(3, "0")}.md`
  );
  await writeFilesInBatches(addedPaths, 64, async (path, index) => {
    const absolutePath = join(mirrorDirectory, path);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(
      absolutePath,
      `${authorityStressDocument(recordCount + index)}\nAdded during authority stress wave.\n`
    );
  });
  await syncPromotionMirror(mirrorCli, mirrorDirectory);

  const expectedCount = recordCount - deleteIndexes.length + addedCount;
  assert.equal(await countMarkdownFiles(mirrorDirectory), expectedCount);
  phase(
    `authority promotion stress fixture converged at ${expectedCount} documents `
      + `in ${Math.round(performance.now() - started)}ms`
  );
  return {
    addedPath: addedPaths[0],
    deletedPath,
    expectedCount,
    updatedPath: paths[updateIndexes[0]]
  };
}

function authorityStressPath(index) {
  const sentinels = [
    "stress/ordering/zulu.md",
    "stress/ordering/äther.md",
    "stress/ordering/東京.md",
    "stress/ordering/🧪-experiment.md"
  ];
  if (index < sentinels.length) return sentinels[index];
  return [
    "stress",
    "deep",
    `group-${String(index % 32).padStart(2, "0")}`,
    `chapter-${String(Math.floor(index / 256)).padStart(2, "0")}`,
    `record-${String(index).padStart(5, "0")}.md`
  ].join("/");
}

function authorityStressDocument(index) {
  const title = `Complex record ${index} — ${index % 2 === 0 ? "東京" : "naïve 🧪"}`;
  return `---
title: ${JSON.stringify(title)}
category: research
sequence: ${index}
active: ${index % 7 !== 0}
tags:
  - authority-stress
  - cohort-${index % 13}
metadata:
  owner:
    name: ${JSON.stringify(`Researcher ${index % 17}`)}
    locale: ${JSON.stringify(index % 2 === 0 ? "ja-JP" : "fr-FR")}
  metrics:
    confidence: ${((index % 100) / 100).toFixed(2)}
    samples: [${index}, ${index + 1}, ${index + 2}]
  reviewers:
    - name: Reviewer A
      approved: ${index % 3 === 0}
    - name: Reviewer B
      approved: ${index % 5 === 0}
related:
  - "[[stress/ordering/zulu]]"
  - "[[stress/ordering/äther]]"
---
# ${title}

This is a nested, Unicode-rich authority transfer fixture.

| measure | value |
| --- | ---: |
| index | ${index} |
| square | ${index * index} |

\`\`\`json
{"index":${index},"flags":[true,false,null],"label":${JSON.stringify(title)}}
\`\`\`
`;
}

async function syncPromotionMirror(mirrorCli, mirrorDirectory) {
  await execute(process.execPath, [mirrorCli, "sync", mirrorDirectory]);
  const status = JSON.parse(
    (await execute(process.execPath, [
      mirrorCli,
      "status",
      mirrorDirectory,
      "--json"
    ])).stdout
  );
  assert.equal(status.state, "up_to_date");
  assert.equal(status.pending, 0);
  assert.deepEqual(status.conflicts, []);
}

async function writeFilesInBatches(values, batchSize, action) {
  for (let start = 0; start < values.length; start += batchSize) {
    await Promise.all(
      values
        .slice(start, start + batchSize)
        .map((value, offset) => action(value, start + offset))
    );
  }
}

async function countMarkdownFiles(root) {
  let count = 0;
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".md")) count += 1;
    }
  };
  await visit(root);
  return count;
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
    await expect(collection.locator(`option[value="${collectionId}"]`)).toHaveCount(1);
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
    await expect(page.getByRole("heading", { name: "Workout Inline E2E" })).toBeVisible();
    const collection = page.getByLabel("Collection and location");
    await expect(collection.locator("option")).toHaveCount(1);
    await expect(collection.locator("option:checked")).toHaveText("No compatible collection");
    await expect(collection).toBeDisabled();
    await page.getByRole("button", { name: "Create an mdbase cloud collection" }).click();
    await expect(collection.locator("option")).toHaveCount(1);
    await expect(collection.locator("option:checked")).toHaveText(
      "My collection · mdbase cloud · setup required"
    );
    await expect(page.getByText("allowing access will add Workout")).toBeVisible();
    await expect(collection).toBeEnabled();
    await page.getByRole("button", { name: "Allow Workout Inline E2E" }).click();
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

function provisionTypes(url, collectionId, types) {
  return internalRequest(
    url,
    `/internal/v1/collections/${collectionId}/types/provision`,
    { method: "POST", body: { types } }
  );
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
  requirements = { contracts: [] },
  provisions = { types: [] }
} = {}) {
  const server = createServer((_request, response) => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Manifest server is unavailable");
    const origin = `http://127.0.0.1:${address.port}`;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      manifest_version: 1,
      id: name === "Workout Inline E2E"
        ? "dev.mdbase.workout-inline-e2e"
        : "dev.mdbase.hosted-sdk-e2e",
      name,
      homepage: origin,
      redirect_uris: [`${origin}/auth/mdbase/callback`],
      requirements,
      provisions
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
        .find(([key]) => key.includes(":token:"))?.[1];
      assert.ok(value, "SDK did not persist a hosted token");
      return JSON.parse(value);
    }
  };
}
