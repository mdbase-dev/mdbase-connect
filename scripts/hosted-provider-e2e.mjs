import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
const connectBinary = resolve(
  process.env.MDBASE_CONNECT_E2E_BINARY
    ?? join(repoRoot, "target", "debug", process.platform === "win32"
      ? "mdbase.exe"
      : "mdbase")
);
const postgresContainer = `mdbase-connect-provider-e2e-${process.pid}`;
const objectStoreContainer = `mdbase-connect-provider-objects-${process.pid}`;
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
const desktopMirrorRoot = await mkdtemp(join(tmpdir(), "mdbase-provider-desktop-mirror-"));
const desktopMirrorData = await mkdtemp(join(tmpdir(), "mdbase-provider-desktop-data-"));
process.env.MDBASE_CONNECT_MIRROR_STATE_DIR = mirrorStateRoot;
const children = new Set();
let postgresStarted = false;
let objectStoreStarted = false;
let objectStoreEndpoint;
let controlApp;
let controlDatabase;
let manifestServer;
let notificationCallbackServer;
let editorServer;
const WORK_ITEM_PROVISION = workItemTypePack({
  packId: "example.work-items",
  name: "Work items",
  contractId: "example.work-item",
  types: [{ name: "task", titleField: "title" }]
});

const { HttpSyncTransport, MemoryReplicaStore, OfflineReplica, SyncError } =
  await import("../packages/sync/dist/index.js");
const {
  DirectoryMirror,
  MirrorDivergenceError,
  WritableDirectoryMirror,
  authorityFileHash,
  authorityManifestDigest
} = await import("../packages/sync/dist/node.js");
const {
  AuthorityAdoptionClient,
  AuthorityAdoptionOutcomeUnknownError,
  buildPortableAuthoritySnapshot
} = await import("../packages/sync/dist/adoption.js");
const {
  MirrorEnrollmentClient
} = await import("../packages/sync/dist/enrollment.js");
const { mirrorProfileDirectory } = await import("../packages/sync/dist/device.js");
const {
  MdbaseConnect,
  MemoryGrantKeyStore,
  unwrapConnectOutcome
} = await import("../packages/client/dist/index.js");
const { buildApp } = await import("../services/server/dist/app.js");
const { createDatabase } = await import("../services/server/dist/db.js");
const { HostedProviderClient } = await import("../services/server/dist/hosted-provider.js");

try {
  phase("starting disposable PostgreSQL 18");
  const databaseUrl = await startPostgres();
  phase("starting disposable S3-compatible object storage");
  objectStoreEndpoint = await startObjectStore();
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

  phase("provisioning and enforcing portable data-contract views");
  const provisionCollectionId = crypto.randomUUID();
  const provisionAccountId = await provisionProviderAccount(provider.url);
  await internalRequest(provider.url, "/internal/v1/collections", {
    method: "POST",
    body: { account_id: provisionAccountId, collection_id: provisionCollectionId, template: "mdbase", display_name: "Provision probe" }
  });
  const typeProvision = workItemTypePack({
    packId: "example.workouts",
    name: "Workout",
    contractId: "workout.record",
    types: [
      { name: "workout", titleField: "title" },
      { name: "training", titleField: "summary" }
    ]
  });
  const provisionedTypes = await internalRequest(
    provider.url,
    `/internal/v1/collections/${provisionCollectionId}/type-packs/provision`,
    { method: "POST", body: { type_packs: [typeProvision] } }
  );
  assert.equal(provisionedTypes.contracts[0]?.id, "workout.record");
  assert.equal(provisionedTypes.contracts[0]?.version, "1.0.0");
  assert.deepEqual(
    provisionedTypes.contracts[0]?.implementations.map(({ type_name }) => type_name),
    ["training", "workout"]
  );
  const repeatedProvision = await internalRequest(
    provider.url,
    `/internal/v1/collections/${provisionCollectionId}/type-packs/provision`,
    { method: "POST", body: { type_packs: [typeProvision] } }
  );
  assert.equal(repeatedProvision.contracts.length, 1);

  const fullReplicaToken = `full-${crypto.randomUUID()}-${crypto.randomUUID()}`;
  await internalRequest(
    provider.url,
    `/internal/v1/collections/${provisionCollectionId}/replicas`,
    {
      method: "POST",
      body: {
        replica_id: crypto.randomUUID(),
        name: "Projection fixture writer",
        purpose: "application",
        mode: "read_write",
        allowed_types: [],
        contract_scope: [],
        full_collection: true,
        allowed_operations: ["create", "rename", "delete"],
        grant_id: crypto.randomUUID(),
        token: fullReplicaToken
      }
    }
  );
  for (const fixture of [
    {
      path: "workout.md",
      frontmatter: { type: "workout", title: "Visible workout", status: "open", secret: "hidden" }
    },
    {
      path: "training.md",
      frontmatter: { type: "training", summary: "Visible training", status: "open", secret: "hidden" }
    }
  ]) {
    const created = await rawRequest(
      provider.url,
      `/v1/authorities/${provisionCollectionId}/operations/create`,
      {
        method: "POST",
        token: fullReplicaToken,
        body: { ...fixture, body: "private markdown body" }
      }
    );
    assert.equal(created.status, 200, JSON.stringify(created.body));
  }
  const exactOnceCreateId = crypto.randomUUID();
  const exactOnceCreateInput = {
    path: "retry-target.md",
    frontmatter: { type: "workout", title: "Exactly once", status: "open" }
  };
  const firstCreate = await rawRequest(
    provider.url,
    `/v1/authorities/${provisionCollectionId}/operations/create`,
    {
      method: "POST",
      token: fullReplicaToken,
      requestId: exactOnceCreateId,
      body: exactOnceCreateInput
    }
  );
  const replayedCreate = await rawRequest(
    provider.url,
    `/v1/authorities/${provisionCollectionId}/operations/create`,
    {
      method: "POST",
      token: fullReplicaToken,
      requestId: exactOnceCreateId,
      body: exactOnceCreateInput
    }
  );
  assert.equal(firstCreate.status, 200, JSON.stringify(firstCreate.body));
  assert.deepEqual(replayedCreate.body, firstCreate.body);
  const reusedRequest = await rawRequest(
    provider.url,
    `/v1/authorities/${provisionCollectionId}/operations/create`,
    {
      method: "POST",
      token: fullReplicaToken,
      requestId: exactOnceCreateId,
      body: { ...exactOnceCreateInput, path: "different.md" }
    }
  );
  assert.equal(reusedRequest.status, 409, JSON.stringify(reusedRequest.body));
  assert.equal(reusedRequest.body.error.code, "operation_request_id_reused");

  const renameRequestId = crypto.randomUUID();
  const renameInput = { from: "retry-target.md", to: "retry-renamed.md" };
  const firstRename = await rawRequest(
    provider.url,
    `/v1/authorities/${provisionCollectionId}/operations/rename`,
    {
      method: "POST",
      token: fullReplicaToken,
      requestId: renameRequestId,
      body: renameInput
    }
  );
  const replayedRename = await rawRequest(
    provider.url,
    `/v1/authorities/${provisionCollectionId}/operations/rename`,
    {
      method: "POST",
      token: fullReplicaToken,
      requestId: renameRequestId,
      body: renameInput
    }
  );
  assert.equal(firstRename.status, 200, JSON.stringify(firstRename.body));
  assert.deepEqual(replayedRename.body, firstRename.body);

  const deleteRequestId = crypto.randomUUID();
  const deleteInput = { path: "retry-renamed.md" };
  const firstDelete = await rawRequest(
    provider.url,
    `/v1/authorities/${provisionCollectionId}/operations/delete`,
    {
      method: "POST",
      token: fullReplicaToken,
      requestId: deleteRequestId,
      body: deleteInput
    }
  );
  const replayedDelete = await rawRequest(
    provider.url,
    `/v1/authorities/${provisionCollectionId}/operations/delete`,
    {
      method: "POST",
      token: fullReplicaToken,
      requestId: deleteRequestId,
      body: deleteInput
    }
  );
  assert.equal(firstDelete.status, 200, JSON.stringify(firstDelete.body));
  assert.deepEqual(replayedDelete.body, firstDelete.body);

  const contractReplicaToken = `contract-${crypto.randomUUID()}-${crypto.randomUUID()}`;
  await internalRequest(
    provider.url,
    `/internal/v1/collections/${provisionCollectionId}/replicas`,
    {
      method: "POST",
      body: {
        replica_id: crypto.randomUUID(),
        name: "Contract projection reader",
        purpose: "application",
        mode: "read_write",
        allowed_types: ["training", "workout"],
        contract_scope: provisionedTypes.contracts,
        full_collection: false,
        allowed_operations: ["read", "query", "create", "update"],
        grant_id: crypto.randomUUID(),
        token: contractReplicaToken
      }
    }
  );
  const projectedQuery = await rawRequest(
    provider.url,
    `/v1/authorities/${provisionCollectionId}/operations/query`,
    { method: "POST", token: contractReplicaToken, body: {} }
  );
  assert.equal(projectedQuery.status, 200, JSON.stringify(projectedQuery.body));
  assert.ok(
    Array.isArray(projectedQuery.body.result?.result?.results),
    JSON.stringify(projectedQuery.body)
  );
  const projectedRecords = projectedQuery.body.result.result.results;
  assert.deepEqual(
    projectedRecords.map(({ frontmatter }) => frontmatter.title).sort(),
    ["Visible training", "Visible workout"]
  );
  for (const record of projectedRecords) {
    assert.equal(record.body, undefined);
    assert.equal(record.frontmatter.secret, undefined);
    assert.equal(record.contract.id, "workout.record");
  }
  const ambiguousCreate = await rawRequest(
    provider.url,
    `/v1/authorities/${provisionCollectionId}/operations/create`,
    {
      method: "POST",
      token: contractReplicaToken,
      body: {
        path: "ambiguous.md",
        frontmatter: { title: "Ambiguous", status: "open" }
      }
    }
  );
  assert.equal(ambiguousCreate.status, 403);
  const selectedCreate = await rawRequest(
    provider.url,
    `/v1/authorities/${provisionCollectionId}/operations/create`,
    {
      method: "POST",
      token: contractReplicaToken,
      body: {
        path: "selected.md",
        contract: { id: "workout.record", version: "1.0.0", type: "training" },
        frontmatter: { title: "Selected provider", status: "open" }
      }
    }
  );
  assert.equal(selectedCreate.status, 200, JSON.stringify(selectedCreate.body));
  assert.equal(selectedCreate.body.result.result.frontmatter.title, "Selected provider");
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
  const notificationReady = await rawRequest(notificationProvider.url, "/ready");
  assert.equal(notificationReady.status, 200);
  assert.equal(notificationReady.body.notifications.configured, true);
  assert.equal(notificationReady.body.notifications.recovery, "ok");
  assert.equal(notificationReady.body.notifications.consecutive_failures, 0);
  assert.match(notificationReady.body.notifications.last_success_at, /^\d{4}-\d{2}-\d{2}T/);
  const notificationCollectionId = crypto.randomUUID();
  const notificationAccountId = await provisionProviderAccount(notificationProvider.url);
  const notificationReplicaId = crypto.randomUUID();
  const notificationToken = `notification-${crypto.randomUUID()}-${crypto.randomUUID()}`;
  const notificationGrantId = crypto.randomUUID();
  const timerReplicaId = crypto.randomUUID();
  const timerToken = `timer-${crypto.randomUUID()}-${crypto.randomUUID()}`;
  await internalRequest(notificationProvider.url, "/internal/v1/collections", {
    method: "POST",
    body: {
      account_id: notificationAccountId,
      collection_id: notificationCollectionId,
      template: "mdbase",
      display_name: "Notification records"
    }
  });
  const notificationContracts = (
    await provisionTypes(notificationProvider.url, notificationCollectionId, [WORK_ITEM_PROVISION])
  ).contracts;
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
        contract_scope: notificationContracts,
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
        scope: { contracts: notificationContracts, access: "contract" },
        notification_criteria: [
          {
            id: "task.created",
            event: { id: "mdbase.record.created", version: "1.0.0" },
            presentation: { title: "A task was created" }
          },
          {
            id: "task.reminder",
            event: { id: "mdbase.runtime.timer.fired", version: "1.0.0" },
            presentation: { title: "Task reminder" }
          }
        ],
        created_at: new Date().toISOString()
      }
    }
  );
  const notificationReceipt = await new HttpSyncTransport(
    authoritySyncUrl(notificationProvider.url, notificationCollectionId),
    notificationToken
  ).mutate(createMutation(
    notificationReplicaId,
    crypto.randomUUID(),
    "tasks/private-notification.md",
    "Private notification title"
  ));
  assert.equal(notificationReceipt.status, "applied");
  const secondNotificationReceipt = await new HttpSyncTransport(
    authoritySyncUrl(notificationProvider.url, notificationCollectionId),
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
    `/v1/authorities/${notificationCollectionId}/operations/reconcile_timers`,
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
  await postgresQuery(`
    UPDATE hosted_provider_notification_grants
    SET grant_json = jsonb_set(
      jsonb_set(
        grant_json,
        '{notification_criteria,0,event,version}',
        '1'::jsonb
      ),
      '{notification_criteria,1,event,id}',
      '"timer.fired"'::jsonb
    )
    WHERE grant_id = '${notificationGrantId}';
    DELETE FROM _sqlx_migrations WHERE version IN (15, 16);
    UPDATE mdbase_runtime_schema SET version = 1 WHERE singleton = TRUE;
  `);
  const upgradedNotificationProvider = await startProvider(databaseUrl, 0, masterKey, {
    MDBASE_CONNECT_CONTROL_PLANE_URL: `http://127.0.0.1:${callbackPort}`,
    MDBASE_CONNECT_HOSTED_MAINTENANCE_INTERVAL_SECONDS: "1",
    MDBASE_CONNECT_HOSTED_NOTIFICATION_INTERVAL_SECONDS: "1"
  });
  const upgradedReady = await rawRequest(upgradedNotificationProvider.url, "/ready");
  assert.equal(upgradedReady.status, 200);
  assert.equal(upgradedReady.body.notifications.configured, true);
  assert.equal(upgradedReady.body.notifications.recovery, "ok");
  assert.equal(upgradedReady.body.notifications.consecutive_failures, 0);
  assert.equal(
    await postgresQuery(`
      SELECT grant_json #>> '{notification_criteria,0,event,version}'
      FROM hosted_provider_notification_grants
      WHERE grant_id = '${notificationGrantId}'
    `),
    "1.0.0"
  );
  assert.equal(
    await postgresQuery(`
      SELECT grant_json #>> '{notification_criteria,1,event,id}'
      FROM hosted_provider_notification_grants
      WHERE grant_id = '${notificationGrantId}'
    `),
    "mdbase.runtime.timer.fired"
  );
  assert.equal(
    await postgresQuery("SELECT version FROM mdbase_runtime_schema WHERE singleton = TRUE"),
    "2"
  );
  await stopProvider(upgradedNotificationProvider);
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
  const quotaAccountId = await provisionProviderAccount(quotaProvider.url, {
    hosted_storage_bytes: 500,
    retained_file_bytes: 1000,
    max_document_bytes: 512,
    max_replicas_per_collection: 1,
    max_hosted_collections: 2
  });
  const quotaReplicaId = crypto.randomUUID();
  const quotaToken = `quota-${crypto.randomUUID()}-${crypto.randomUUID()}`;
  await internalRequest(quotaProvider.url, "/internal/v1/collections", {
    method: "POST",
    body: {
      account_id: quotaAccountId,
      collection_id: quotaCollectionId,
      template: "mdbase",
      display_name: "Quota worklog"
    }
  });
  await internalRequest(quotaProvider.url, "/internal/v1/collections", {
    method: "POST",
    body: {
      account_id: quotaAccountId,
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
  const quotaTransport = new HttpSyncTransport(
    authoritySyncUrl(quotaProvider.url, quotaCollectionId),
    quotaToken
  );
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
  const accountBeforeAggregateProbe = (
    await internalRequest(
      quotaProvider.url,
      `/internal/v1/accounts/${quotaAccountId}`
    )
  ).account;
  const aggregateCollectionId = crypto.randomUUID();
  const aggregateReplicaId = crypto.randomUUID();
  const aggregateToken = `aggregate-${crypto.randomUUID()}-${crypto.randomUUID()}`;
  await internalRequest(quotaProvider.url, "/internal/v1/collections", {
    method: "POST",
    body: {
      account_id: quotaAccountId,
      collection_id: aggregateCollectionId,
      template: "mdbase",
      display_name: "Aggregate quota probe"
    }
  });
  await provisionTypes(quotaProvider.url, aggregateCollectionId, [WORK_ITEM_PROVISION]);
  await internalRequest(
    quotaProvider.url,
    `/internal/v1/collections/${aggregateCollectionId}/replicas`,
    {
      method: "POST",
      body: {
        replica_id: aggregateReplicaId,
        name: "Aggregate writer",
        mode: "read_write",
        allowed_types: ["task"],
        token: aggregateToken
      }
    }
  );
  const aggregateTransport = new HttpSyncTransport(
    authoritySyncUrl(quotaProvider.url, aggregateCollectionId),
    aggregateToken
  );
  const aggregateMutation = createMutation(
    aggregateReplicaId,
    crypto.randomUUID(),
    "tasks/aggregate.md",
    "Aggregate"
  );
  aggregateMutation.input.body = "x".repeat(
    500 - accountBeforeAggregateProbe.live_content_bytes + 1
  );
  await expectSyncError(
    () => aggregateTransport.mutate(aggregateMutation),
    "account_storage_quota_exceeded"
  );
  const accountAfterAggregateProbe = (
    await internalRequest(
      quotaProvider.url,
      `/internal/v1/accounts/${quotaAccountId}`
    )
  ).account;
  assert.equal(
    accountAfterAggregateProbe.live_content_bytes,
    accountBeforeAggregateProbe.live_content_bytes
  );
  const collectionQuota = await rawRequest(
    quotaProvider.url,
    "/internal/v1/collections",
    {
      method: "POST",
      token: internalToken,
      body: {
        account_id: quotaAccountId,
        collection_id: crypto.randomUUID(),
        template: "mdbase",
        display_name: "Too many collections"
      }
    }
  );
  assert.equal(collectionQuota.status, 429);
  assert.equal(
    collectionQuota.body.error.code,
    "account_collection_quota_exceeded"
  );
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
  const maintenanceAccountId = await provisionProviderAccount(maintenanceProvider.url);
  const maintenanceReplicaId = crypto.randomUUID();
  const maintenanceToken = `maintenance-${crypto.randomUUID()}-${crypto.randomUUID()}`;
  await internalRequest(maintenanceProvider.url, "/internal/v1/collections", {
    method: "POST",
    body: { account_id: maintenanceAccountId, collection_id: maintenanceCollectionId, template: "mdbase", display_name: "Maintenance records" }
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
  const localEditor = await startEditorServer();
  editorServer = localEditor.server;
  ({ app: controlApp } = await buildApp({
    db: controlDatabase,
    devAuth: true,
    hostedCollections: true,
    hostedProvider: new HostedProviderClient({ url: provider.url, internalToken }),
    publicUrl: controlUrl,
    editorOrigin: localEditor.origin,
    managementOrigins: [localEditor.origin],
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
  assert.equal(created.collection.sync_url, authoritySyncUrl(provider.url, collectionId));
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
  assert.equal(writer.syncUrl, authoritySyncUrl(provider.url, collectionId));
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

  phase("controlling a writable mirror through the Rust daemon");
  const connector = await controlRequest(controlUrl, "/v1/connectors", cookie, {
    method: "POST",
    body: { name: "Rust mirror controller" }
  });
  const desktopProfile = connectProfile(desktopMirrorData);
  const desktopDaemon = await startConnectDaemon(
    desktopProfile,
    controlUrl,
    connector.token
  );
  const desktopMirror = await connectCommand(desktopProfile, [
    "mirror", "add", collectionId, desktopMirrorRoot,
    "--two-way", "--name", "Daemon-managed mirror"
  ]);
  assert.equal(desktopMirror.collection_id, collectionId);
  assert.equal(desktopMirror.mode, "read_write");
  assert.equal(desktopMirror.state, "up_to_date");
  assert.match(await readFile(join(desktopMirrorRoot, "mdbase.yaml"), "utf8"), /spec_version: 0\.3\.0/);
  assert.equal((await stat(join(desktopMirrorData, "mirrors.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(desktopMirrorData)).mode & 0o777, 0o700);
  await mkdir(join(desktopMirrorRoot, "tasks"), { recursive: true });
  await writeFile(
    join(desktopMirrorRoot, "tasks", "desktop-managed.md"),
    "---\ntype: task\ntitle: Desktop managed\nstatus: open\n---\n"
  );
  await connectCommand(desktopProfile, ["mirror", "sync", desktopMirror.replica_id]);
  const desktopRecord = (
    await snapshotAll(
      transport(provider.url, collectionId, writer),
      await transport(provider.url, collectionId, writer).openSession()
    )
  ).find((record) => record.path === "tasks/desktop-managed.md");
  assert.equal(desktopRecord?.frontmatter.title, "Desktop managed");

  await localAuthorityImportE2E(
    controlUrl,
    cookie,
    provider.url,
    controlDatabase
  );
  await portableAuthorityAdoptionE2E(
    controlUrl,
    cookie,
    provider.url,
    controlDatabase
  );
  await waitFor(async () => {
    try {
      await connectCommand(desktopProfile, [
        "mirror", "remove", desktopMirror.replica_id, "--yes"
      ]);
      return true;
    } catch (error) {
      if (error?.stderr?.includes('"code":"mirror_busy"')) return false;
      throw error;
    }
  }, "Daemon-managed mirror remained busy during removal", 400);
  assert.deepEqual(await connectCommand(desktopProfile, ["mirror", "list"]), []);
  await stopConnectDaemon(desktopProfile, desktopDaemon);

  phase("exercising hosted lifecycle and writable enrollment in a real browser");
  await portalLifecycleE2E(controlUrl, provider.url, browserMirrorRoot);

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
    requirements: { contracts: [{ id: "workout.record", version: "1.0.0" }] },
    provisions: { type_packs: [typeProvision] }
  });
  try {
    const inlineStorage = memoryStorage();
    let inlineAuthorizationUrl;
    const inlineSdk = new MdbaseConnect({
      serverUrl: controlUrl,
      manifest: inlineManifest.manifestUrl,
      redirectUri: inlineManifest.redirectUri,
      storage: inlineStorage,
      keyStore: new MemoryGrantKeyStore(),
      navigate: (value) => { inlineAuthorizationUrl = value; }
    });
    const inlineAuthorization = inlineSdk.authorize({
      operations: ["describe", "read", "query", "create", "update"]
    });
    await waitFor(() => inlineAuthorizationUrl, "SDK did not start inline hosted authorization");
    await authorizeHostedApplicationByCreating(
      inlineAuthorizationUrl,
      emptyCookie
    );
    const { connection: inlineConnection } = unwrapConnectOutcome(
      await inlineAuthorization
    );
    const inlineToken = inlineStorage.token();
    assert.equal(
      inlineToken.authority.syncUrl,
      authoritySyncUrl(provider.url, inlineToken.collectionId)
    );
    const inlineOriginalFetch = globalThis.fetch;
    globalThis.fetch = (input, init = {}) => {
      const url = String(input);
      if (!url.startsWith(`${provider.url}/v1/authorities/`)) {
        return inlineOriginalFetch(input, init);
      }
      const headers = new Headers(init.headers);
      headers.set("origin", inlineManifest.origin);
      return inlineOriginalFetch(input, { ...init, headers });
    };
    const inlineDescription = unwrapConnectOutcome(
      await inlineConnection.describe().finally(() => {
        globalThis.fetch = inlineOriginalFetch;
      })
    );
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
  const hostedSdk = new MdbaseConnect({
    serverUrl: controlUrl,
    manifest: manifest.manifestUrl,
    redirectUri: manifest.redirectUri,
    storage,
    keyStore: new MemoryGrantKeyStore(),
    navigate: (value) => { authorizationUrl = value; }
  });
  const hostedAuthorization = hostedSdk.authorize({
    operations: [
      "describe", "changes", "read", "query", "list_views", "execute_view",
      "create", "update", "delete", "rename", "create_type"
    ]
  });
  await waitFor(() => authorizationUrl, "SDK did not start hosted authorization");
  await authorizeHostedApplication(
    authorizationUrl,
    cookie,
    genericCollectionId
  );
  const { connection: hostedConnection } = unwrapConnectOutcome(
    await hostedAuthorization
  );
  const storedHostedToken = storage.token();
  assert.equal(
    storedHostedToken.authority.syncUrl,
    authoritySyncUrl(provider.url, genericCollectionId)
  );
  assert.equal(storedHostedToken.encryption, undefined);
  const appReplicaId = storedHostedToken.authority.replicaId;
  const originalFetch = globalThis.fetch;
  let providerOrigin = manifest.origin;
  globalThis.fetch = (input, init = {}) => {
    const url = String(input);
    if (!url.startsWith(`${provider.url}/v1/authorities/`)) return originalFetch(input, init);
    const headers = new Headers(init.headers);
    headers.set("origin", providerOrigin);
    return originalFetch(input, { ...init, headers });
  };
  const hostedSync = hostedConnection.sync();
  assert.ok(hostedSync);
  const appSync = await hostedSync.transport.openSession();
  assert.equal(appSync.replica_id, appReplicaId);
  providerOrigin = "https://evil.example";
  await assert.rejects(() => hostedSync.transport.openSession());
  await assert.rejects(async () => unwrapConnectOutcome(await hostedConnection.query()));
  providerOrigin = manifest.origin;
  const description = unwrapConnectOutcome(await hostedConnection.describe());
  assert.equal(description.display_name, "Hosted writing");
  assert.deepEqual(description.contracts, []);
  const sdkCreated = unwrapConnectOutcome(await hostedConnection.create({
    path: "Draft.md",
    frontmatter: { title: "Created through hosted SDK" },
    body: "Generic mdbase Markdown."
  }));
  assert.equal(sdkCreated.path, "Draft.md");
  assert.deepEqual(sdkCreated.types, []);
  assert.deepEqual(sdkCreated.frontmatter, {
    title: "Created through hosted SDK"
  });
  assert.deepEqual(sdkCreated.effective_frontmatter, {
    title: "Created through hosted SDK"
  });
  assert.equal(sdkCreated.body, "Generic mdbase Markdown.\n");
  assert.equal(sdkCreated.file.name, "Draft.md");
  const sdkUpdated = unwrapConnectOutcome(await hostedConnection.update({
    path: "Draft.md",
    patch: { title: "Updated through hosted SDK" },
    if_revision: sdkCreated.revision
  }));
  assert.equal(sdkUpdated.frontmatter.title, "Updated through hosted SDK");
  assert.equal(
    sdkUpdated.effective_frontmatter.title,
    "Updated through hosted SDK"
  );
  assert.equal(sdkUpdated.file.name, "Draft.md");
  const sdkRenamed = unwrapConnectOutcome(await hostedConnection.rename({
    from: "Draft.md",
    to: "Writing/Draft.md",
    if_revision: sdkUpdated.revision
  }));
  assert.equal(sdkRenamed.path, "Writing/Draft.md");
  assert.equal(sdkRenamed.frontmatter.title, "Updated through hosted SDK");
  assert.equal(sdkRenamed.file.folder, "Writing");
  const defaultQuery = unwrapConnectOutcome(await hostedConnection.query());
  assert.equal(defaultQuery.results[0].path, "Writing/Draft.md");
  assert.equal(
    defaultQuery.results[0].effective_frontmatter.title,
    "Updated through hosted SDK"
  );
  assert.equal(defaultQuery.results[0].frontmatter, undefined);
  assert.equal(defaultQuery.results[0].file.path, "Writing/Draft.md");
  const bothQuery = unwrapConnectOutcome(
    await hostedConnection.query({ frontmatter_mode: "both" })
  );
  assert.equal(
    bothQuery.results[0].frontmatter.title,
    "Updated through hosted SDK"
  );
  assert.equal(
    bothQuery.results[0].effective_frontmatter.title,
    "Updated through hosted SDK"
  );
  const sdkBodyOnly = unwrapConnectOutcome(await hostedConnection.create({
    path: "Plain.md",
    body: "# Hosted plain Markdown",
    include_document: true
  }));
  assert.deepEqual(sdkBodyOnly.frontmatter, {});
  assert.deepEqual(sdkBodyOnly.effective_frontmatter, {});
  assert.equal(sdkBodyOnly.body, "# Hosted plain Markdown");
  assert.equal(sdkBodyOnly.document, "# Hosted plain Markdown");
  const sdkBodyOnlyUpdated = unwrapConnectOutcome(await hostedConnection.update({
    path: "Plain.md",
    patch: {},
    body: "# Hosted plain Markdown\n\nUpdated.",
    if_revision: sdkBodyOnly.revision,
    include_document: true
  }));
  assert.deepEqual(sdkBodyOnlyUpdated.frontmatter, {});
  assert.equal(
    sdkBodyOnlyUpdated.document,
    "# Hosted plain Markdown\n\nUpdated."
  );
  assert.equal(unwrapConnectOutcome(await hostedConnection.delete({
    path: "Plain.md",
    if_revision: sdkBodyOnlyUpdated.revision
  })).deleted, true);
  const viewType = unwrapConnectOutcome(await hostedConnection.createType({
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
  }));
  assert.equal(viewType.name, "view");
  const viewRecord = unwrapConnectOutcome(await hostedConnection.create({
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
  }));
  assert.equal(viewRecord.path, "Views/writing.md");
  const listedViews = unwrapConnectOutcome(await hostedConnection.listViews());
  assert.equal(listedViews.views[0].views[0].id, "all");
  assert.deepEqual(listedViews.views[0].views[0].properties[1], {
    key: "display_title",
    label: "Display title"
  });
  const executedView = unwrapConnectOutcome(await hostedConnection.executeView({
    path: "Views/writing.md",
    view: "all"
  }));
  assert.deepEqual(
    executedView.results.map((record) => record.path),
    ["Writing/Draft.md"]
  );
  assert.equal(
    executedView.results[0].values.display_title,
    "Updated through hosted SDK!"
  );
  assert.equal(unwrapConnectOutcome(await hostedConnection.delete({
    path: "Views/writing.md",
    if_revision: viewRecord.revision
  })).deleted, true);
  assert.equal(unwrapConnectOutcome(await hostedConnection.delete({
    path: "Writing/Draft.md",
    if_revision: sdkRenamed.revision
  })).deleted, true);
  const sync = hostedConnection.sync();
  assert.ok(sync);
  const offline = new OfflineReplica(sync.transport, store(sync.replicaId));
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
  const offlinePlain = await offline.queueCreate({
    recordId: crypto.randomUUID(),
    path: "Offline plain.md",
    body: "# Offline plain Markdown"
  });
  assert.deepEqual(offlinePlain.frontmatter, {});
  assert.deepEqual(offlinePlain.types, []);
  await offline.sync();
  const offlinePlainSynced = (await offline.records())
    .find((record) => record.record_id === offlinePlain.record_id);
  assert.deepEqual(offlinePlainSynced.frontmatter, {});
  assert.equal(offlinePlainSynced.body, "# Offline plain Markdown");
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
  await assert.rejects(
    async () => unwrapConnectOutcome(await hostedConnection.create({
      path: "permission-expansion.md",
      frontmatter: { title: "Must not exist" }
    })),
    (error) => error?.problem?.code === "insufficient_access"
  );
  await assert.rejects(
    () => hostedSync.transport.changes(0, 10),
    (error) => error?.code === "insufficient_access"
  );
  await controlRequest(controlUrl, `/v1/grants/${hostedGrant.id}`, cookie, { method: "DELETE" });
  await assert.rejects(
    async () => unwrapConnectOutcome(await hostedConnection.query()),
    (error) => error?.problem?.code === "authorization_expired"
  );
  globalThis.fetch = originalFetch;

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
  const storageUsage = await internalRequest(
    provider.url,
    `/internal/v1/collections/${collectionId}/usage`
  );
  assert.equal(storageUsage.usage.collection_id, collectionId);
  assert.ok(storageUsage.usage.record_count >= 1);
  assert.ok(storageUsage.usage.content_bytes > 0);
  assert.equal(storageUsage.usage.max_records, 100_000);
  assert.equal(storageUsage.usage.max_content_bytes, 1024 * 1024 * 1024);
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
        "--sync-url", authoritySyncUrl(provider.url, collectionId),
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
    "--sync-url", authoritySyncUrl(provider.url, collectionId),
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
  assert.match(
    await readFile(join(mirrorRoot, "_types", "task.md"), "utf8"),
    /implements:\s+- contract: example\.work-item/
  );
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
    "--sync-url", authoritySyncUrl(provider.url, collectionId),
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
    "--sync-url", authoritySyncUrl(provider.url, collectionId),
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

  const bodyOnlyFolder = join(writableMirrorRoot, "Canvas Bases");
  const bodyOnlyPath = join(bodyOnlyFolder, "Start Here.md");
  await mkdir(bodyOnlyFolder, { recursive: true });
  await writeFile(bodyOnlyPath, "# Start here\n\nNo frontmatter required.\n");
  await execute(process.execPath, [mirrorCli, "sync", writableMirrorRoot]);
  await execute(process.execPath, [mirrorCli, "sync", writableMirrorRoot]);
  let bodyOnlyAuthority = (
    await snapshotAll(writerTransport, await writerTransport.openSession())
  ).find((record) => record.path === "Canvas Bases/Start Here.md");
  assert.ok(bodyOnlyAuthority);
  assert.deepEqual(bodyOnlyAuthority.frontmatter, {});
  assert.deepEqual(bodyOnlyAuthority.types, []);
  assert.equal(bodyOnlyAuthority.body, "# Start here\n\nNo frontmatter required.\n");
  assert.equal(
    await readFile(bodyOnlyPath, "utf8"),
    "# Start here\n\nNo frontmatter required.\n"
  );

  const remotelyEditedBodyOnly = await writerTransport.mutate({
    mutation_id: crypto.randomUUID(),
    replica_id: writer.id,
    scope_epoch: 1,
    operation: "update",
    record_id: bodyOnlyAuthority.record_id,
    base_revision: bodyOnlyAuthority.revision,
    input: { patch: {}, body: "# Start here\n\nEdited remotely.\n" },
    created_at: new Date().toISOString()
  });
  assert.equal(remotelyEditedBodyOnly.status, "applied");
  await execute(process.execPath, [mirrorCli, "sync", writableMirrorRoot]);
  assert.equal(
    await readFile(bodyOnlyPath, "utf8"),
    "# Start here\n\nEdited remotely.\n"
  );

  await writeFile(bodyOnlyPath, "# Start here\n\nEdited locally.\n");
  await execute(process.execPath, [mirrorCli, "sync", writableMirrorRoot]);
  bodyOnlyAuthority = (
    await snapshotAll(writerTransport, await writerTransport.openSession())
  ).find((record) => record.record_id === bodyOnlyAuthority.record_id);
  assert.ok(bodyOnlyAuthority);
  assert.deepEqual(bodyOnlyAuthority.frontmatter, {});
  assert.equal(bodyOnlyAuthority.body, "# Start here\n\nEdited locally.\n");

  const renamedBodyOnlyPath = join(bodyOnlyFolder, "Welcome.md");
  await rename(bodyOnlyPath, renamedBodyOnlyPath);
  await execute(process.execPath, [mirrorCli, "sync", writableMirrorRoot]);
  bodyOnlyAuthority = (
    await snapshotAll(writerTransport, await writerTransport.openSession())
  ).find((record) => record.record_id === bodyOnlyAuthority.record_id);
  assert.ok(bodyOnlyAuthority);
  assert.equal(bodyOnlyAuthority.path, "Canvas Bases/Welcome.md");
  await unlink(renamedBodyOnlyPath);
  await execute(process.execPath, [mirrorCli, "sync", writableMirrorRoot]);
  assert.equal(
    (
      await snapshotAll(writerTransport, await writerTransport.openSession())
    ).some((record) => record.record_id === bodyOnlyAuthority.record_id),
    false
  );

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
  const authorityAccountId = await provisionProviderAccount(provider.url);
  const authorityReplicaId = crypto.randomUUID();
  const authorityToken = `authority-${crypto.randomUUID()}-${crypto.randomUUID()}`;
  await internalRequest(provider.url, "/internal/v1/collections", {
    method: "POST",
    body: {
      account_id: authorityAccountId,
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
    authoritySyncUrl(provider.url, authorityCollectionId),
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
    authorityTransport,
    {
      selectiveSync: {
        file_classes: ["image", "audio", "video", "pdf", "other"],
        excluded_folders: []
      }
    }
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
  const proofSession = await authorityTransport.openSession();
  const proofRecords = await snapshotAll(authorityTransport, proofSession);
  const proofEntries = (proofSession.resources.documents ?? []).map((resource) => ({
    kind: "resource",
    path: resource.path,
    identity: "",
    document_hash: sha256Hex(resource.document)
  }));
  for (const record of proofRecords) {
    proofEntries.push({
      kind: "record",
      path: record.path,
      identity: record.record_id,
      document_hash: sha256Hex(
        await readFile(join(authorityMirrorRoot, record.path), "utf8")
      )
    });
  }
  const snapshotProof = authorityManifestDigest(proofEntries);
  assert.equal(authorityProof.cursor, preparedTransfer.final_head);
  assert.equal(snapshotProof, preparedTransfer.manifest_digest);
  assert.equal(authorityProof.digest, snapshotProof);
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
  const cancelledAccountId = await provisionProviderAccount(provider.url);
  const cancelledReplicaId = crypto.randomUUID();
  const cancelledToken = `authority-cancel-${crypto.randomUUID()}-${crypto.randomUUID()}`;
  await internalRequest(provider.url, "/internal/v1/collections", {
    method: "POST",
    body: {
      account_id: cancelledAccountId,
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
      authoritySyncUrl(provider.url, cancelledCollectionId),
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
        `/v1/authorities/${collectionId}/operations/read`,
        { method: "POST", token: benchmarkToken, body: { path: "tasks/bulk-204.md" } }
      );
      readLatencies.push(performance.now() - started);
      assert.equal(read.status, 200);
      started = performance.now();
      const query = await rawRequest(
        provider.url,
        `/v1/authorities/${collectionId}/operations/query`,
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
  assert.equal(rotation.sync_url, authoritySyncUrl(provider.url, collectionId));
  await expectSyncError(() => restartedRecoveryTransport.openSession(), "invalid_replica_token");
  await new HttpSyncTransport(rotation.sync_url, rotatedToken).openSession();
  await controlRequest(controlUrl, `/v1/hosted/replicas/${recovery.id}`, cookie, {
    method: "DELETE"
  });
  await expectSyncError(
    () => new HttpSyncTransport(rotation.sync_url, rotatedToken).openSession(),
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
  if (notificationCallbackServer) {
    await new Promise((resolveClose) => notificationCallbackServer.close(resolveClose));
  }
  if (manifestServer) await new Promise((resolveClose) => manifestServer.close(resolveClose));
  if (editorServer) await new Promise((resolveClose) => editorServer.close(resolveClose));
  if (controlApp) await controlApp.close();
  if (controlDatabase) await controlDatabase.end();
  for (const child of [...children]) await stopProvider(child);
  if (postgresStarted) {
    await execute(
      "docker",
      ["rm", "-f", postgresContainer],
      { timeout: 30_000 }
    ).catch(() => {});
  }
  if (objectStoreStarted) {
    await execute(
      "docker",
      ["rm", "-f", objectStoreContainer],
      { timeout: 30_000 }
    ).catch(() => {});
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
  await rm(desktopMirrorRoot, { recursive: true, force: true });
  await rm(desktopMirrorData, { recursive: true, force: true });
}

function phase(message) {
  process.stdout.write(`[provider-e2e] ${message}\n`);
}

async function startEditorServer() {
  const root = join(repoRoot, "apps", "editor", "dist");
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? "/", "http://editor.test").pathname;
      const asset = pathname.startsWith("/assets/") ? pathname.slice(1) : "index.html";
      if (!/^(?:index\.html|assets\/[A-Za-z0-9_.-]+)$/u.test(asset)) {
        response.writeHead(404).end();
        return;
      }
      const contentType = asset.endsWith(".js")
        ? "text/javascript"
        : asset.endsWith(".css")
          ? "text/css"
          : asset.endsWith(".woff2")
            ? "font/woff2"
            : asset.endsWith(".woff")
              ? "font/woff"
              : "text/html";
      response.setHeader("content-type", contentType);
      response.end(await readFile(join(root, asset)));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Editor server is unavailable");
  return { server, origin: `http://127.0.0.1:${address.port}` };
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
    if (url.includes("/v1/authorities/") && init.headers?.authorization) {
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
      operations: ["describe", "query", "create", "sync"],
      openVerification() {},
      onDeviceCode(authorization) {
        globalThis.portableHarness.authorization = authorization;
        document.querySelector("#code").textContent = authorization.userCode;
      }
    }).then(async (authorizationOutcome) => {
      const { connection } = MdbaseConnect.unwrapConnectOutcome(authorizationOutcome);
      const created = MdbaseConnect.unwrapConnectOutcome(await connection.create({
        path: "portable-hosted-e2e.md",
        frontmatter: { title: "Created from a downloaded file" },
        body: "Direct to the hosted provider."
      }));
      const description = MdbaseConnect.unwrapConnectOutcome(await connection.describe());
      const records = MdbaseConnect.unwrapConnectOutcome(await connection.query({
        where: 'file.path == "portable-hosted-e2e.md"'
      }));
      globalThis.portableHarness.result = {
        route: connection.route,
        collectionId: connection.collectionId,
        displayName: description.display_name,
        created: created.path === "portable-hosted-e2e.md",
        records: records.results.length,
        syncAvailable: connection.sync() !== null,
        connections: manager.connections().length
      };
    }).catch((error) => {
      globalThis.portableHarness.error = {
        code: error && (error.problem?.code || error.code),
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
          operations: ["describe", "query", "create", "sync"]
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
      route: "remote",
      collectionId,
      displayName: "Hosted writing",
      created: true,
      records: 1,
      syncAvailable: true,
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
    assert.equal((await noProof.json()).error.code, "authority_proof_required");
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
    assert.equal((await replay.json()).error.code, "authority_proof_replayed");
    const tampered = await fetch(captured.url, {
      method: captured.method,
      headers: { ...captured.headers, origin: "null" },
      body: `${captured.body} `
    });
    assert.equal(tampered.status, 401);
    assert.equal((await tampered.json()).error.code, "invalid_authority_proof");
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

async function portalLifecycleE2E(controlUrl, providerUrl, browserMirrorDirectory) {
  const browser = await chromium.launch({ headless: true });
  let connector;
  try {
    const page = await browser.newPage();
    await page.goto(`${controlUrl}/login`);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { name: "Collections", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "New hosted collection" }).click();
    await page.getByLabel("Collection name").fill("Browser E2E collection");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await page.getByRole("link", { name: "All collections" }).click();
    const row = page.locator(".connect-collection-row").filter({
      hasText: "Browser E2E collection"
    });
    await expect(row).toBeVisible();
    await expect(row).toContainText("Hosted by mdbase");

    const dashboard = await page.evaluate(async (server) => {
      const response = await fetch(`${server}/v1/me`, { credentials: "include" });
      return response.json();
    }, controlUrl);
    const collectionId = dashboard.hosted_collections.find(
      (collection) => collection.display_name === "Browser E2E collection"
    ).id;
    const editorUrl = new URL("/", page.url());
    editorUrl.searchParams.set("collection", collectionId);
    editorUrl.searchParams.set("server", controlUrl);
    await expect(row.getByRole("link", { name: "Open", exact: true }))
      .toHaveAttribute("href", editorUrl.href);
    await expect(row.getByRole("link", { name: "Sync folder" }))
      .toHaveAttribute("href", `mdbase-connect://mirror?collection=${collectionId}`);

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
    await page.getByRole("link", { name: "All collections" }).click();
    const connectedRow = page.locator(".connect-collection-row").filter({
      hasText: "Browser E2E collection"
    });
    await connectedRow.getByText("Synced folders", { exact: true }).click();
    await expect(connectedRow).toContainText("Browser writable mirror");
    await expect(connectedRow).toContainText("Two-way sync");
    await connectedRow.getByRole("button", { name: "Revoke" }).click();
    await connectedRow.getByRole("button", { name: "Revoke", exact: true }).click();
    await expect(connectedRow.getByText("Browser writable mirror")).toHaveCount(0, {
      timeout: 20_000
    });

    await connectedRow.getByRole("button", { name: "Rename" }).click();
    await connectedRow.getByLabel("Rename Browser E2E collection")
      .fill("Browser renamed collection");
    await connectedRow.getByRole("button", { name: "Save", exact: true }).click();
    const renamedRow = page.locator(".connect-collection-row").filter({
      hasText: "Browser renamed collection"
    });
    await expect(renamedRow).toBeVisible({ timeout: 20_000 });
    await renamedRow.getByRole("button", { name: "Delete" }).click();
    await renamedRow.getByRole("button", { name: "Delete permanently" }).click();
    await expect(page.getByText("Browser renamed collection", { exact: true })).toHaveCount(0, {
      timeout: 20_000
    });

    await page.getByRole("button", { name: "New hosted collection" }).click();
    await page.getByLabel("Collection name").fill("Account deletion collection");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    const deletionCollection = page.locator(".connect-collection-row").filter({
      hasText: "Account deletion collection"
    });
    await expect(deletionCollection).toBeVisible();
    const deletionDashboard = await page.evaluate(async (server) => {
      const response = await fetch(`${server}/v1/me`, { credentials: "include" });
      return response.json();
    }, controlUrl);
    const deletionCollectionId = deletionDashboard.hosted_collections.find(
      (collection) => collection.display_name === "Account deletion collection"
    ).id;

    await page.getByRole("link", { name: "Account & sessions" }).click();
    await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
    await expect(page.getByRole("main").getByText(
      "Account deletion collection",
      { exact: true }
    )).toBeVisible();
    const account = await page.evaluate(async (server) => {
      const response = await fetch(`${server}/v1/account`, { credentials: "include" });
      return response.json();
    }, controlUrl);
    const accountCollection = account.storage.collections.find(
      (collection) => collection.id === deletionCollectionId
    );
    assert.equal(account.storage.status, "available");
    assert.equal(accountCollection.usage.collection_id, deletionCollectionId);
    assert.equal(accountCollection.usage.max_content_bytes, 1024 * 1024 * 1024);
    await page.getByRole("button", { name: "Delete account…" }).click();
    await expect(page.getByText(/Local files are never removed/)).toBeVisible();
    await expect(page.getByText(
      "Local collection and mirror files remain on your computers.",
      { exact: true }
    )).toBeVisible();
    await page.getByLabel("Type DELETE to confirm").fill("DELETE");
    await page.getByRole("button", { name: "Delete account permanently" }).click();
    await expect(page).toHaveURL(/\/connect\/account-deleted(?:\?.*)?$/);
    await expect(page.getByRole("heading", { name: "Your account has been deleted." }))
      .toBeVisible();
    assert.equal(
      (
        await rawRequest(
          providerUrl,
          `/internal/v1/collections/${deletionCollectionId}/usage`,
          { token: internalToken }
        )
      ).status,
      404
    );
    assert.match(
      await readFile(join(browserMirrorDirectory, "mdbase.yaml"), "utf8"),
      /spec_version: 0\.3\.0/
    );
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
  const connector = await controlRequest(controlUrl, "/v1/connectors", cookie, {
    method: "POST",
    body: { name: "Promotion computer" }
  });
  const profile = connectProfile(toolDirectory);
  let daemon = await startConnectDaemon(profile, controlUrl, connector.token);
  const mirror = await connectCommand(profile, [
    "mirror", "add", collectionId, mirrorDirectory,
    "--two-way", "--name", "Promotion mirror",
    "--files", "images,audio,videos,pdfs,other"
  ]);
  assert.equal(mirror.collection_id, collectionId);
  assert.equal(mirror.state, "up_to_date");
  assert.equal(mirror.mode, "read_write");

  const promotionStressCount = Number(
    process.env.MDBASE_CONNECT_PROVIDER_E2E_PROMOTION_COUNT ?? 0
  );
  assert.ok(
    Number.isInteger(promotionStressCount)
      && (promotionStressCount === 0 || promotionStressCount >= 205)
      && promotionStressCount <= 20_000
  );
  const syncMirror = async () => {
    const status = await connectCommand(profile, [
      "mirror", "sync", mirror.replica_id
    ]);
    assert.equal(status.state, "up_to_date");
    assert.equal(status.pending, 0);
    assert.deepEqual(status.conflicts, []);
  };
  const promotionStress = promotionStressCount > 0
    ? await prepareAuthorityPromotionStressFixture(
        syncMirror,
        mirrorDirectory,
        promotionStressCount
      )
    : null;

  await stopConnectDaemon(profile, daemon);
  daemon = await startConnectDaemon(profile, controlUrl, connector.token);
  const recovered = await connectCommand(profile, ["mirror", "list"]);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].replica_id, mirror.replica_id);

  const promotion = spawn(connectBinary, connectArguments(profile, [
    "--json", "mirror", "promote", mirror.replica_id, "--no-open"
  ]), {
    cwd: repoRoot,
    env: connectEnvironment(),
    stdio: ["ignore", "pipe", "pipe"]
  });
  let promotionOutput = "";
  let promotionError = "";
  promotion.stdout.on("data", (chunk) => { promotionOutput += chunk; });
  promotion.stderr.on("data", (chunk) => { promotionError += chunk; });
  let browser;
  try {
    let transferUri;
    try {
      transferUri = await waitForOutput(
        () => promotionError.match(/https?:\/\/[^\s]+\/transfer\/[0-9a-f-]+/)?.[0],
        "Promotion CLI did not print an authority confirmation URL"
      );
    } catch (error) {
      throw new Error(
        `${error.message}\nPromotion CLI stderr:\n${promotionError}\n`
          + `Promotion CLI stdout:\n${promotionOutput}`,
        { cause: error }
      );
    }
    browser = await chromium.launch({ headless: true });
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
      name: "Use the folder on Promotion mirror as the main copy?"
    })).toBeVisible();
    await expect(page.getByText(
      "Existing access is revoked. Connect applications again to use the local collection."
    )).toBeVisible();
    await page.getByRole("button", { name: "Move main copy" }).click();
    const promotionExit = await waitForExit(promotion, 30_000);
    assert.equal(
      promotionExit,
      0,
      `Promotion CLI failed:\n${promotionError}\n${promotionOutput}`
    );
    const result = JSON.parse(promotionOutput);
    assert.equal(result.collection_id, collectionId);
    assert.equal(result.authority_epoch, 2);
    assert.equal(result.path, mirrorDirectory);
    await expect(page.getByRole("heading", {
      name: "Promotion E2E collection now lives on your computer."
    })).toBeVisible();
  } finally {
    if (promotion.exitCode === null && promotion.signalCode === null) promotion.kill("SIGTERM");
    if (browser) await browser.close();
  }

  assert.deepEqual(await connectCommand(profile, ["mirror", "list"]), []);
  const localCollections = await connectCommand(profile, ["collection", "list"]);
  const localCollection = localCollections.find((candidate) => candidate.id === collectionId);
  assert.equal(localCollection?.path, mirrorDirectory);
  assert.equal(localCollection?.enabled, true);
  const validation = await connectCommand(profile, [
    "collection", "validate", collectionId
  ]);
  assert.equal(validation.valid, true);
  assert.match(
    await readFile(join(mirrorDirectory, "mdbase.yaml"), "utf8"),
    new RegExp(`collection_id: ${collectionId}`)
  );
  await assert.rejects(
    () => stat(join(toolDirectory, "mirrors", mirror.replica_id, "state.json")),
    { code: "ENOENT" }
  );
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
  await stopConnectDaemon(profile, daemon);
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

async function localAuthorityImportE2E(
  controlUrl,
  cookie,
  providerUrl,
  database
) {
  phase("moving a paged local authority into the live hosted provider");
  const connector = await controlRequest(controlUrl, "/v1/connectors", cookie, {
    method: "POST",
    body: { name: "Local authority importer" }
  });
  const collectionId = crypto.randomUUID();
  const recordCount = Number(
    process.env.MDBASE_CONNECT_PROVIDER_E2E_IMPORT_COUNT ?? 205
  );
  assert.ok(
    Number.isInteger(recordCount) && recordCount >= 205 && recordCount <= 20_000
  );
  const published = await rawRequest(controlUrl, "/v1/connectors/sync", {
    method: "POST",
    token: connector.token,
    body: {
      inventory_revision: 1,
      collections: [{
        id: collectionId,
        display_name: "Imported local authority",
        spec_version: "0.3.0",
        enabled: true,
        contracts: []
      }]
    }
  });
  assert.equal(published.status, 200, JSON.stringify(published.body));

  const snapshot = localAuthoritySnapshot(collectionId, recordCount);
  const begun = await rawRequest(
    controlUrl,
    `/v1/connectors/collections/${collectionId}/authority-transfers`,
    { method: "POST", token: connector.token, body: {} }
  );
  assert.equal(begun.status, 201, JSON.stringify(begun.body));
  assert.equal(begun.body.transfer.state, "prepared");
  assert.equal(begun.body.transfer.authority_epoch, 2);
  assert.ok(begun.body.import);

  const rejected = await absoluteRequest(begun.body.import.manifest_url, {
    method: "PUT",
    token: `wrong-${crypto.randomUUID()}-${crypto.randomUUID()}`,
    body: snapshot.manifest
  });
  assert.equal(rejected.status, 401);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const manifest = await absoluteRequest(begun.body.import.manifest_url, {
      method: "PUT",
      token: begun.body.import.access_token,
      body: snapshot.manifest
    });
    assert.equal(manifest.status, 200, JSON.stringify(manifest.body));
  }
  for (let offset = 0, page = 0; offset < snapshot.records.length; offset += 200, page += 1) {
    const body = {
      protocol_version: 1,
      page,
      records: snapshot.records.slice(offset, offset + 200)
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const uploaded = await absoluteRequest(begun.body.import.records_url, {
        method: "PUT",
        token: begun.body.import.access_token,
        body
      });
      assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
    }
  }
  await uploadAuthorityImportFiles(begun.body.import, snapshot.files);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const finalized = await absoluteRequest(begun.body.import.finalize_url, {
      method: "POST",
      token: begun.body.import.access_token
    });
    assert.equal(finalized.status, 200, JSON.stringify(finalized.body));
    assert.equal(finalized.body.state, "uploaded");
  }
  const finalizedUpload = await absoluteRequest(begun.body.import.records_url, {
    method: "PUT",
    token: begun.body.import.access_token,
    body: {
      protocol_version: 1,
      page: 0,
      records: snapshot.records.slice(0, 1)
    }
  });
  assert.equal(finalizedUpload.status, 409);
  assert.equal(finalizedUpload.body.error.code, "authority_import_finalized");

  const completed = await rawRequest(
    controlUrl,
    `/v1/connectors/authority-transfers/${begun.body.transfer.id}/complete`,
    {
      method: "POST",
      token: connector.token,
      body: {
        manifest_digest: snapshot.manifest.manifest_digest,
        source_revision: snapshot.manifest.source_revision,
        source_head: snapshot.manifest.source_head
      }
    }
  );
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.deepEqual(completed.body, {
    status: "completed",
    collection_id: collectionId,
    authority_epoch: 2
  });
  const repeatedCompletion = await rawRequest(
    controlUrl,
    `/v1/connectors/authority-transfers/${begun.body.transfer.id}/complete`,
    {
      method: "POST",
      token: connector.token,
      body: {
        manifest_digest: snapshot.manifest.manifest_digest,
        source_revision: snapshot.manifest.source_revision,
        source_head: snapshot.manifest.source_head
      }
    }
  );
  assert.equal(repeatedCompletion.status, 200);
  const mismatchedProviderCompletion = await rawRequest(
    providerUrl,
    `/internal/v1/authority-imports/${begun.body.transfer.id}`,
    {
      method: "POST",
      token: internalToken,
      body: {
        manifest_digest: "f".repeat(64),
        source_revision: snapshot.manifest.source_revision
      }
    }
  );
  assert.equal(mismatchedProviderCompletion.status, 409);
  assert.equal(
    mismatchedProviderCompletion.body.error.code,
    "authority_import_not_ready"
  );

  const replica = await registerReplica(
    controlUrl,
    cookie,
    collectionId,
    "Imported authority verifier",
    "read_write",
    []
  );
  const importedTransport = new HttpSyncTransport(replica.syncUrl, replica.token);
  const importedSession = await importedTransport.openSession();
  const importedRecords = await snapshotAll(importedTransport, importedSession);
  assert.equal(importedRecords.length, recordCount);
  const importedByPath = new Map(importedRecords.map((record) => [record.path, record]));
  for (const source of [snapshot.records[0], snapshot.records.at(-1)]) {
    assert.equal(importedByPath.get(source.path)?.record_id, source.record_id);
    assert.equal(
      importedByPath.get(source.path)?.revision,
      `sha256:${sha256Hex(source.document)}`
    );
    assert.deepEqual(importedByPath.get(source.path)?.types, ["task"]);
  }
  const importedResources = importedSession.resources.documents;
  assert.equal(
    importedResources.find((resource) => resource.path === "mdbase.yaml")?.document,
    snapshot.manifest.resources.documents.find((resource) => resource.path === "mdbase.yaml")?.document
  );
  assert.ok(importedResources.some(
    (resource) => resource.kind === "view" && resource.path === "views/imported.base"
  ));
  const importedFilePage = await importedTransport.fileSnapshot(importedSession.snapshot_id);
  assert.equal(importedFilePage.files.length, snapshot.files.length);
  const importedFile = importedFilePage.files[0];
  assert.deepEqual(importedFile, snapshot.files[0].descriptor);
  const importedFileChunks = [];
  for await (const chunk of importedTransport.downloadFile(importedFile)) {
    importedFileChunks.push(chunk);
  }
  assert.deepEqual(Buffer.concat(importedFileChunks), snapshot.files[0].bytes);

  const resumed = await rawRequest(
    controlUrl,
    `/v1/connectors/collections/${collectionId}/authority-transfers`,
    { method: "POST", token: connector.token, body: {} }
  );
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.transfer.state, "completed");
  assert.equal(resumed.body.import, undefined);
  const state = await database.query(
    `SELECT local.authority_state AS local_state, local.enabled,
            hosted.authority_state AS hosted_state, hosted.authority_epoch
     FROM collections local
     JOIN hosted_collections hosted ON hosted.id = local.local_id
     WHERE local.connector_id = $1 AND local.local_id = $2`,
    [connector.connector.id, collectionId]
  );
  assert.deepEqual(
    {
      local_state: state.rows[0].local_state,
      enabled: state.rows[0].enabled,
      hosted_state: state.rows[0].hosted_state,
      authority_epoch: Number(state.rows[0].authority_epoch)
    },
    {
      local_state: "retired",
      enabled: false,
      hosted_state: "active",
      authority_epoch: 2
    }
  );

  const cancelledCollectionId = crypto.randomUUID();
  const republished = await rawRequest(controlUrl, "/v1/connectors/sync", {
    method: "POST",
    token: connector.token,
    body: {
      inventory_revision: 2,
      collections: [{
        id: cancelledCollectionId,
        display_name: "Cancelled local import",
        spec_version: "0.3.0",
        enabled: true,
        contracts: []
      }]
    }
  });
  assert.equal(republished.status, 200);
  const cancellable = await rawRequest(
    controlUrl,
    `/v1/connectors/collections/${cancelledCollectionId}/authority-transfers`,
    { method: "POST", token: connector.token, body: {} }
  );
  assert.equal(cancellable.status, 201);
  const cancelled = await rawRequest(
    controlUrl,
    `/v1/connectors/authority-transfers/${cancellable.body.transfer.id}`,
    { method: "DELETE", token: connector.token }
  );
  assert.equal(cancelled.status, 200);
  const cancelledState = await database.query(
    `SELECT authority_state, enabled FROM collections
     WHERE connector_id = $1 AND local_id = $2`,
    [connector.connector.id, cancelledCollectionId]
  );
  assert.deepEqual(cancelledState.rows[0], {
    authority_state: "active",
    enabled: true
  });
  const removedTarget = await database.query(
    "SELECT id FROM hosted_collections WHERE id = $1",
    [cancelledCollectionId]
  );
  assert.equal(removedTarget.rows.length, 0);
}

async function portableAuthorityAdoptionE2E(
  controlUrl,
  cookie,
  providerUrl,
  database
) {
  phase("adopting a portable local collection with replacement staging and a lost response");
  const collectionId = crypto.randomUUID();
  let loseCompletionResponse = true;
  const request = async ({ url, method, headers, body, signal }) => {
    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal
    });
    const parsed = await response.json().catch(() => ({}));
    if (
      loseCompletionResponse
      && method === "POST"
      && new URL(url).pathname.endsWith("/complete")
    ) {
      loseCompletionResponse = false;
      throw new Error("simulated response loss after provider activation");
    }
    return {
      status: response.status,
      body: parsed,
      retryAfterMs: Number(response.headers.get("retry-after") ?? 0) * 1000 || undefined
    };
  };
  const client = new AuthorityAdoptionClient({ request });
  const session = await client.begin({
    controlUrl,
    collectionId,
    displayName: "Portable phone notes",
    sourceName: "Phone",
    retainMirror: true,
    mirrorName: "Original phone vault"
  });
  assert.equal(session.verificationUri, `${controlUrl}/adopt/${session.adoptionId}`);
  const adoption = await controlRequest(
    controlUrl,
    `/v1/authority-adoptions/${session.adoptionId}`,
    cookie
  );
  assert.equal(adoption.adoption.state, "requested");
  await controlRequest(
    controlUrl,
    `/v1/authority-adoptions/${session.adoptionId}/approve`,
    cookie,
    { method: "POST", body: {} }
  );
  let prepared = await client.waitForApproval(session, { pollIntervalMs: 250 });
  const resources = portableAdoptionResources(collectionId);
  const warm = buildPortableAuthoritySnapshot({
    collectionId,
    specVersion: "0.3.0",
    resources,
    records: [{
      path: "tasks/one.md",
      document: "---\ntitle: One\n---\n\nWarm snapshot\n"
    }]
  });
  await client.uploadSnapshot(session, prepared, warm);

  const fenced = buildPortableAuthoritySnapshot({
    collectionId,
    specVersion: "0.3.0",
    resources,
    records: [
      {
        path: "tasks/one.md",
        document: "---\ntitle: One\n---\n\nFinal snapshot\n"
      },
      {
        path: "tasks/late.md",
        document: "---\ntitle: Late\n---\n\nArrived before the fence\n"
      }
    ]
  });
  prepared = await client.exchange(session);
  assert.equal(prepared.status, "ready");
  await client.uploadSnapshot(session, prepared, fenced);
  await assert.rejects(
    () => client.complete(session, fenced),
    (error) => error instanceof AuthorityAdoptionOutcomeUnknownError
      && error.sourceMustRemainFenced
  );
  const recovered = await client.exchange(session);
  assert.equal(recovered.status, "completed");
  assert.equal(recovered.adoption.manifest_digest, fenced.manifest_digest);

  const contracts = await database.query(
    "SELECT contracts, authority_state, authority_epoch FROM hosted_collections WHERE id = $1",
    [collectionId]
  );
  assert.equal(contracts.rows[0].authority_state, "active");
  assert.equal(Number(contracts.rows[0].authority_epoch), 2);
  assert.equal(contracts.rows[0].contracts[0]?.id, "example.work-item");
  assert.equal(contracts.rows[0].contracts[0]?.version, "1.0.0");
  assert.deepEqual(
    contracts.rows[0].contracts[0]?.implementations.map(({ type_name }) => type_name),
    ["task"]
  );

  const mirrorSession = client.mirrorEnrollmentSession(session, recovered);
  assert.ok(mirrorSession);
  const enrollment = await new MirrorEnrollmentClient({ request }).waitForApproval(
    mirrorSession,
    { pollIntervalMs: 250 }
  );
  assert.equal(enrollment.collectionId, collectionId);
  assert.equal(enrollment.mode, "read_write");
  const transport = new HttpSyncTransport(enrollment.syncUrl, enrollment.accessToken);
  const opened = await transport.openSession();
  const records = await snapshotAll(transport, opened);
  assert.deepEqual(
    records.map(({ path }) => path).sort(),
    ["tasks/late.md", "tasks/one.md"]
  );
  assert.ok(records.every((record) => record.types.includes("task")));
  assert.ok(opened.resources.documents.some(
    (resource) => resource.kind === "view" && resource.path === "views/tasks.base"
  ));
  assert.equal(new URL(enrollment.syncUrl).origin, providerUrl);
}

function portableAdoptionResources(collectionId) {
  return [
    {
      path: "mdbase.yaml",
      kind: "configuration",
      document: `spec_version: 0.3.0\nx-mdbase-connect:\n  collection_id: ${collectionId}\nx-obsidian:\n  bases:\n    include:\n      - views/**/*.base\n`
    },
    ...WORK_ITEM_PROVISION.resources.map(({ source, document }) => ({
      path: source,
      kind: source.startsWith("_contracts/") ? "contract" : "type",
      document: source.startsWith("_types/")
        ? document.replace("schema:\n", "match:\n  path_glob: tasks/**/*.md\nschema:\n")
        : document
    })),
    {
      path: "views/tasks.base",
      kind: "view",
      document: "views: []\n"
    }
  ];
}

function localAuthoritySnapshot(collectionId, recordCount) {
  const configuration = [
    "spec_version: 0.3.0",
    "name: Imported local authority",
    "x-mdbase-connect:",
    `  collection_id: ${collectionId}`,
    "x-obsidian:",
    "  bases:",
    "    include:",
    "      - views/**/*.base",
    ""
  ].join("\n");
  const typeDocument = "---\nkind: mdbase.type\nname: task\nversion: 1\nmatch:\n  path_glob: notes/**/*.md\nschema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\n    properties:\n      title: { type: string }\n---\n";
  const viewDocument = "views: []\n";
  const resources = [
    {
      path: "mdbase.yaml",
      kind: "configuration",
      revision: `sha256:${sha256Hex(configuration)}`,
      document: configuration
    },
    {
      path: "_types/task.md",
      kind: "type",
      revision: `sha256:${sha256Hex(typeDocument)}`,
      document: typeDocument
    },
    {
      path: "views/imported.base",
      kind: "view",
      revision: `sha256:${sha256Hex(viewDocument)}`,
      document: viewDocument
    }
  ];
  const records = Array.from({ length: recordCount }, (_, index) => {
    const sequence = String(index).padStart(5, "0");
    const title = `Imported ${sequence}`;
    const document = `---\ntitle: ${title}\n---\nBody ${sequence}.\n`;
    return {
      record_id: crypto.randomUUID(),
      path: `notes/${sequence}.md`,
      document
    };
  });
  const importedBytes = Buffer.alloc(8 * 1024 * 1024 + 113, 0x5a);
  const importedFile = {
    descriptor: {
      file_id: crypto.randomUUID(),
      path: "images/imported.png",
      revision: "file:imported:1",
      content_digest: `sha256:${sha256Hex(importedBytes)}`,
      size: importedBytes.length,
      media_type: "image/png",
      media_class: "image",
      modified_at: "2026-08-01T00:00:00.000Z"
    },
    bytes: importedBytes
  };
  const files = [importedFile];
  const resourceRevision = lengthPrefixedDigest(
    resources.flatMap((resource) => [resource.path, resource.revision])
  );
  const sourceRevision = lengthPrefixedDigest([
    ...resources.flatMap((resource) => [
      "resource",
      resource.path,
      resource.revision
    ]),
    ...records.flatMap((record) => [
      "record",
      record.path,
      `sha256:${sha256Hex(record.document)}`
    ]),
    ...files.flatMap(({ descriptor: file }) => [
      "file",
      file.path,
      file.file_id,
      file.revision,
      file.content_digest,
      String(file.size),
      file.media_type ?? "",
      file.media_class
    ])
  ]);
  const manifestDigest = authorityManifestDigest([
    ...resources.map((resource) => ({
      kind: "resource",
      path: resource.path,
      identity: "",
      document_hash: sha256Hex(resource.document)
    })),
    ...records.map((record) => ({
      kind: "record",
      path: record.path,
      identity: record.record_id,
      document_hash: sha256Hex(record.document)
    })),
    ...files.map(({ descriptor: file }) => ({
      kind: "file",
      path: file.path,
      identity: file.file_id,
      document_hash: authorityFileHash(file)
    }))
  ]);
  return {
    manifest: {
      protocol_version: 1,
      collection_id: collectionId,
      source_head: recordCount,
      source_revision: sourceRevision,
      manifest_digest: manifestDigest,
      resources: {
        revision: resourceRevision,
        spec_version: "0.3.0",
        types: [],
        contracts: [],
        documents: resources
      },
      record_count: recordCount,
      file_count: files.length,
      files: files.map(({ descriptor }) => descriptor)
    },
    records,
    files
  };
}

async function uploadAuthorityImportFiles(capability, files) {
  for (const { descriptor, bytes } of files) {
    const transferId = crypto.randomUUID();
    const opened = await absoluteRequest(`${capability.files_url}/uploads`, {
      method: "POST",
      token: capability.access_token,
      body: {
        protocol_version: 1,
        type: "open_authority_import_file_upload",
        transfer_id: transferId,
        file_id: descriptor.file_id
      }
    });
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    const partSize = opened.body.strategy.kind === "object_put"
      ? Math.max(1, descriptor.size)
      : opened.body.strategy.part_size;
    const partCount = opened.body.strategy.kind === "object_put"
      ? 1
      : Math.ceil(descriptor.size / partSize);
    const parts = [];
    for (let index = 0; index < partCount; index += 1) {
      const offset = index * partSize;
      const partBytes = bytes.subarray(offset, Math.min(bytes.length, offset + partSize));
      const prepared = await absoluteRequest(
        `${capability.files_url}/uploads/${transferId}/parts`,
        {
          method: "POST",
          token: capability.access_token,
          body: {
            protocol_version: 1,
            type: "prepare_file_upload_part",
            transfer_id: transferId,
            part_number: index + 1,
            content_length: partBytes.length
          }
        }
      );
      assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
      const uploaded = await fetch(prepared.body.url, {
        method: prepared.body.method,
        headers: prepared.body.headers,
        body: partBytes,
        redirect: "error"
      });
      assert.equal(uploaded.status, 200);
      if (opened.body.strategy.kind === "object_multipart") {
        assert.ok(uploaded.headers.get("etag"));
        if (index === 0) {
          // Simulate a process restart: discard the browser-observed ETag and
          // recover the durable multipart receipt from R2 through the session.
          const resumed = await absoluteRequest(`${capability.files_url}/uploads`, {
            method: "POST",
            token: capability.access_token,
            body: {
              protocol_version: 1,
              type: "open_authority_import_file_upload",
              transfer_id: transferId,
              file_id: descriptor.file_id
            }
          });
          assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
          assert.deepEqual(resumed.body.received, [0]);
          assert.deepEqual(resumed.body.uploaded_parts, [{
            part_number: 1,
            etag: uploaded.headers.get("etag")
          }]);
          parts.push(...resumed.body.uploaded_parts);
        } else {
          parts.push({ part_number: index + 1, etag: uploaded.headers.get("etag") });
        }
      }
    }
    const commitBody = {
      protocol_version: 1,
      type: "commit_file_upload",
      transfer_id: transferId,
      ...(parts.length > 0 ? { parts } : {})
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const committed = await absoluteRequest(
        `${capability.files_url}/uploads/${transferId}/commit`,
        { method: "POST", token: capability.access_token, body: commitBody }
      );
      assert.equal(committed.status, 200, JSON.stringify(committed.body));
      assert.deepEqual(committed.body.file, descriptor);
    }
  }
}

function lengthPrefixedDigest(values) {
  const digest = createHash("sha256");
  for (const value of values) {
    const bytes = Buffer.from(value);
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    digest.update(length);
    digest.update(bytes);
  }
  return `sha256:${digest.digest("hex")}`;
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function absoluteRequest(url, options) {
  const endpoint = new URL(url);
  return rawRequest(endpoint.origin, `${endpoint.pathname}${endpoint.search}`, options);
}

async function prepareAuthorityPromotionStressFixture(
  syncMirror,
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
  await syncMirror();

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
  await syncMirror();

  const renameIndexes = paths
    .map((_, index) => index)
    .filter((index) => index >= 4 && index % 83 === 0);
  for (const index of renameIndexes) {
    const nextPath = paths[index].replace(/\.md$/, "-renamed.md");
    await rename(join(mirrorDirectory, paths[index]), join(mirrorDirectory, nextPath));
    paths[index] = nextPath;
  }
  await syncMirror();

  const deleteIndexes = paths
    .map((_, index) => index)
    .filter((index) => index >= 4 && index % 101 === 0);
  const deletedPath = paths[deleteIndexes[0]];
  for (const index of deleteIndexes) {
    await unlink(join(mirrorDirectory, paths[index]));
  }
  await syncMirror();

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
  await syncMirror();

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

async function authorizeHostedApplication(authorizationUrl, cookie, collectionId) {
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
    const collection = page.getByRole("radio", {
      name: /Hosted writing.*Hosted by mdbase/
    });
    await expect(collection).toHaveAttribute("value", collectionId);
    await collection.check();
    await expect(collection).toBeChecked();
    await expect(page.getByRole("button", { name: "Create hosted collection" })).toBeVisible();
    await page.getByRole("button", { name: "Allow Hosted SDK E2E" }).click();
    const outcome = await Promise.race([
      page.getByText("Access approved", { exact: true })
        .waitFor({ state: "visible" }).then(() => "approved"),
      page.locator(".message.error").waitFor({ state: "visible" }).then(() => "error")
    ]);
    if (outcome === "error") {
      throw new Error(`Hosted authorization failed: ${await page.locator(".message.error").innerText()}`);
    }
  } finally {
    await browser.close();
  }
}

async function authorizeHostedApplicationByCreating(authorizationUrl, cookie) {
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
    await expect(page.getByText("No compatible collection is ready.")).toBeVisible();
    await expect(page.getByRole("group", { name: "Collection and location" })).toHaveCount(0);
    await page.getByRole("button", { name: "Create hosted collection" }).click();
    await page.getByLabel("New collection name").fill("Workout records");
    await page.getByRole("button", { name: "Create collection" }).click();
    const collection = page.getByRole("radio", {
      name: /Workout records.*Hosted by mdbase.*Setup needed/
    });
    await expect(collection).toBeVisible();
    await expect(collection).toBeChecked();
    await expect(page.getByText(
      "Setup is required before access can become active. Add Workout’s starter type."
    )).toBeVisible();
    await expect(page.getByRole("radio", {
      name: /Add Workout Inline E2E’s starter type/
    })).toBeChecked();
    await page.getByRole("button", { name: "Set up and allow Workout Inline E2E" }).click();
    const outcome = await Promise.race([
      page.getByText("Access approved", { exact: true })
        .waitFor({ state: "visible" })
        .then(() => "approved"),
      page.locator(".message.error").waitFor({ state: "visible" }).then(() => "error")
    ]);
    if (outcome === "error") {
      throw new Error(`Inline hosted authorization failed: ${await page.locator(".message.error").innerText()}`);
    }
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

async function startObjectStore() {
  await execute("docker", [
    "run", "--rm", "--detach", "--name", objectStoreContainer,
    "--env", "MINIO_ROOT_USER=mdbase-test-access",
    "--env", "MINIO_ROOT_PASSWORD=mdbase-test-secret-key",
    "--publish", "127.0.0.1::9000",
    "minio/minio:RELEASE.2025-09-07T16-13-09Z",
    "server", "/data", "--address", ":9000"
  ]);
  objectStoreStarted = true;
  const { stdout } = await execute("docker", ["port", objectStoreContainer, "9000/tcp"]);
  const port = stdout.trim().match(/:(\d+)$/)?.[1];
  if (!port) throw new Error(`Could not resolve object-store port from ${stdout}`);
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const ready = await fetch(`http://127.0.0.1:${port}/minio/health/ready`)
      .then((response) => response.ok, () => false);
    if (ready) break;
    await delay(250);
  }
  await execute("docker", [
    "run", "--rm", "--network", `container:${objectStoreContainer}`,
    "--entrypoint", "/bin/sh",
    "minio/mc:RELEASE.2025-08-13T08-35-41Z",
    "-c",
    "mc alias set local http://127.0.0.1:9000 mdbase-test-access mdbase-test-secret-key && mc mb --ignore-existing local/mdbase-connect-files"
  ]);
  return `http://127.0.0.1:${port}`;
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

function connectProfile(stateDirectory) {
  return {
    stateDirectory,
    endpoint: process.platform === "win32"
      ? `\\\\.\\pipe\\mdbase-connect-provider-e2e-${process.pid}-${crypto.randomUUID()}`
      : join(stateDirectory, "daemon.sock")
  };
}

function connectArguments(profile, command) {
  return [
    "--state-dir", profile.stateDirectory,
    "--endpoint", profile.endpoint,
    "connect",
    ...command
  ];
}

function connectEnvironment(connectorToken) {
  return {
    ...process.env,
    MDBASE_CONNECT_ENV: "test",
    MDBASE_CONNECT_SECRET_BACKEND: "insecure-test-file",
    ...(connectorToken
      ? { MDBASE_CONNECT_CONNECTOR_TOKEN: connectorToken }
      : {})
  };
}

async function connectCommand(profile, command) {
  const { stdout } = await execute(
    connectBinary,
    connectArguments(profile, ["--json", ...command]),
    { cwd: repoRoot, env: connectEnvironment() }
  );
  return JSON.parse(stdout);
}

async function startConnectDaemon(profile, serverUrl, connectorToken) {
  const child = spawn(connectBinary, connectArguments(profile, [
    "daemon", "run",
    "--server-url", serverUrl,
    "--loopback-port", "0"
  ]), {
    cwd: repoRoot,
    env: connectEnvironment(connectorToken),
    stdio: ["ignore", "pipe", "pipe"]
  });
  children.add(child);
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  await waitFor(async () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Connect daemon exited during startup:\n${logs}`);
    }
    try {
      const status = await connectCommand(profile, ["daemon", "status"]);
      return status.running;
    } catch {
      return false;
    }
  }, `Connect daemon startup timed out:\n${logs}`, 400);
  return child;
}

async function stopConnectDaemon(profile, child) {
  await connectCommand(profile, ["daemon", "stop"]).catch(() => {});
  await stopProvider(child);
}

async function waitForExit(child, timeoutMilliseconds) {
  if (child.exitCode !== null) return child.exitCode;
  if (child.signalCode !== null) return null;
  return Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    delay(timeoutMilliseconds).then(() => {
      child.kill("SIGTERM");
      throw new Error(`Process did not exit within ${timeoutMilliseconds}ms`);
    })
  ]);
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
      MDBASE_CONNECT_R2_ENDPOINT: objectStoreEndpoint,
      MDBASE_CONNECT_R2_BUCKET: "mdbase-connect-files",
      MDBASE_CONNECT_R2_ACCESS_KEY_ID: "mdbase-test-access",
      MDBASE_CONNECT_R2_SECRET_ACCESS_KEY: "mdbase-test-secret-key",
      MDBASE_CONNECT_ALLOW_INSECURE_R2: "true",
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

function workItemTypePack({ packId, name, contractId, types }) {
  const version = "1.0.0";
  const contractSource = `_contracts/${contractId}.md`;
  const contractDocument = `---
kind: mdbase.contract
contract_type: record
id: ${contractId}
version: ${version}
record_schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [title, status]
    additionalProperties: false
    properties:
      title: { type: string, minLength: 1 }
      status: { enum: [open, done] }
---
`;
  const resources = [{ source: contractSource, document: contractDocument }];
  for (const { name, titleField } of types) {
    resources.push({
      source: `_types/${name}.md`,
      document: `---
kind: mdbase.type
name: ${name}
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [type, ${titleField}, status]
    additionalProperties: false
    properties:
      type: { const: ${name} }
      ${titleField}: { type: string, minLength: 1 }
      status: { enum: [open, done] }
      secret: { type: string }
implements:
  - contract: ${contractId}
    version: ${version}
    fields:
      title: ${titleField}
      status: status
---
`
    });
  }
  return {
    manifest: {
      kind: "mdbase.type-pack",
      id: packId,
      version,
      name,
      resources: resources.map(({ source, document }) => ({
        kind: source.startsWith("_contracts/") ? "contract" : "type",
        source,
        target: source,
        digest: `sha256:${createHash("sha256").update(document).digest("hex")}`
      }))
    },
    resources,
    provides: [{ id: contractId, version }]
  };
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
  return new HttpSyncTransport(authoritySyncUrl(url, collectionId), replicaValue.token);
}

function store(replicaId) {
  return new MemoryReplicaStore({ replicaId, records: {}, pending: [], conflicts: {} });
}

function replica(syncTransport, replicaId) {
  return new OfflineReplica(syncTransport, store(replicaId));
}

function syncPath(collectionId, endpoint) {
  return `/v1/authorities/${collectionId}/sync/${endpoint}`;
}

function authoritySyncUrl(url, collectionId) {
  return new URL(`/v1/authorities/${collectionId}/sync`, url).href;
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

async function provisionProviderAccount(url, overrides = {}, accountId = crypto.randomUUID()) {
  await internalRequest(url, `/internal/v1/accounts/${accountId}`, {
    method: "PUT",
    body: {
      entitlement_revision: 1,
      hosted_storage_bytes: 1024 * 1024 * 1024,
      retained_file_bytes: 2 * 1024 * 1024 * 1024,
      max_document_bytes: 2 * 1024 * 1024,
      max_single_file_bytes: 250 * 1024 * 1024,
      max_replicas_per_collection: 10,
      max_hosted_collections: 10,
      max_files_per_collection: 10_000,
      ...overrides
    }
  });
  return accountId;
}

function provisionTypes(url, collectionId, typePacks) {
  return internalRequest(
    url,
    `/internal/v1/collections/${collectionId}/type-packs/provision`,
    { method: "POST", body: { type_packs: typePacks } }
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
    const value = path.includes("/operations/")
      ? {
          protocol_version: 1,
          request_id: options.requestId ?? crypto.randomUUID(),
          input: options.body
        }
      : options.body;
    body = JSON.stringify(value);
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
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const value = action();
    if (value) return value;
    await delay(50);
  }
  throw new Error(message);
}

async function openManifestServer({
  name = "Hosted SDK E2E",
  requirements = { contracts: [] },
  provisions = { type_packs: [] }
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
