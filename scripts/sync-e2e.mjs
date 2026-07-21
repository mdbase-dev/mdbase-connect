import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

process.env.NODE_ENV = "test";
const repoRoot = resolve(import.meta.dirname, "..");
const { buildApp } = await import("../services/server/dist/app.js");
const { createDatabase } = await import("../services/server/dist/db.js");
const {
  HttpSyncTransport,
  MemoryReplicaStore,
  OfflineReplica
} = await import("../packages/sync/dist/index.js");
const { DirectoryMirror } = await import("../packages/sync/dist/node.js");
const {
  resolveTasknotesSyncContract,
  TasknotesOfflineCollection
} = await import("../packages/tasknotes/dist/index.js");

const database = await createDatabase("memory");
const { app } = await buildApp({
  db: database,
  devAuth: true,
  hostedCollections: true,
  hostedReferenceAuthority: true,
  allowInsecureManifests: true,
  publicUrl: "http://127.0.0.1"
});
await app.listen({ host: "127.0.0.1", port: 0 });
const address = app.server.address();
if (!address || typeof address === "string") throw new Error("Server did not open a TCP port");
const serverUrl = `http://127.0.0.1:${address.port}`;
const mirrorRoot = await mkdtemp(join(tmpdir(), "mdbase-hosted-mirror-"));

try {
  const session = await request("/v1/dev/session", {
    method: "POST",
    body: { name: "Hosted User", email: "hosted@example.com" }
  });
  const cookie = session.response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Development session did not set a cookie");
  const created = await request("/v1/hosted/collections", {
    method: "POST",
    cookie,
    body: { display_name: "Hosted tasks", template: "tasknotes" }
  });
  const collectionId = created.body.collection.id;
  const writer = await createReplica(collectionId, cookie, "Android", "read_write");
  const reader = await createReplica(collectionId, cookie, "Tablet", "read_write");
  const mirror = await createReplica(collectionId, cookie, "Laptop mirror", "read_only");
  const recovery = await createReplica(collectionId, cookie, "Recovery client", "read_write");

  const writerTransport = new HttpSyncTransport(serverUrl, collectionId, writer.token);
  const readerTransport = new HttpSyncTransport(serverUrl, collectionId, reader.token);
  const recoveryTransport = new HttpSyncTransport(serverUrl, collectionId, recovery.token);
  const writerClient = new OfflineReplica(writerTransport, replicaStore(writer.replica.id));
  const readerClient = new OfflineReplica(readerTransport, replicaStore(reader.replica.id));
  const recoveryStore = replicaStore(recovery.replica.id);
  const recoveryClient = new OfflineReplica(recoveryTransport, recoveryStore);
  await Promise.all([writerClient.initialize(), readerClient.initialize(), recoveryClient.initialize()]);

  const resources = await writerClient.collectionResources();
  if (!resources) throw new Error("Hosted sync session did not include collection resources");
  const tasknotes = new TasknotesOfflineCollection(writerClient, resolveTasknotesSyncContract(resources));
  const recordId = await tasknotes.create({
    title: "Created offline",
    path: "tasks/offline.md",
    body: "Created without a network round trip."
  });
  const queuedCreate = (await writerClient.pending())[0];
  const mutationId = queuedCreate.mutation_id;
  await writerClient.sync();
  await readerClient.pull();
  const readerRecord = (await readerClient.records()).find((record) => record.record_id === recordId);
  if (!readerRecord || readerRecord.frontmatter.title !== "Created offline") {
    throw new Error("Second client did not receive authoritative offline create");
  }
  const replay = await writerTransport.mutate({
    mutation_id: mutationId,
    replica_id: writer.replica.id,
    scope_epoch: 1,
    operation: "create",
    record_id: recordId,
    input: {
      path: "tasks/should-not-exist.md",
      frontmatter: { type: "task", title: "Duplicate" },
      types: ["task"]
    },
    created_at: new Date().toISOString()
  });
  if (replay.status !== "previously_applied" || replay.record?.path !== "tasks/offline.md") {
    throw new Error(`Mutation replay was not idempotent: ${JSON.stringify(replay)}`);
  }

  const directoryMirror = new DirectoryMirror(
    mirrorRoot,
    mirror.replica.id,
    new HttpSyncTransport(serverUrl, collectionId, mirror.token)
  );
  await directoryMirror.sync();
  const markdown = await readFile(join(mirrorRoot, "tasks", "offline.md"), "utf8");
  if (!markdown.includes("title: Created offline") || !markdown.includes("Created without a network")) {
    throw new Error("Receive-only mirror did not materialize canonical Markdown");
  }

  await writerClient.queueUpdate({ recordId, patch: { status: "done" } });
  await writerClient.sync();
  await readerClient.queueUpdate({
    recordId,
    patch: { title: "Stale tablet edit" },
    baseRevision: readerRecord.revision
  });
  await readerClient.sync();
  const conflicts = await readerClient.conflicts();
  if (conflicts[0]?.status !== "conflicted"
      || conflicts[0].conflict.current?.frontmatter.status !== "done") {
    throw new Error(`Stale update did not return a usable conflict: ${JSON.stringify(conflicts)}`);
  }
  await directoryMirror.sync();
  if (!(await readFile(join(mirrorRoot, "tasks", "offline.md"), "utf8")).includes("status: done")) {
    throw new Error("Mirror did not receive the authoritative update");
  }

  const queuedMutationId = crypto.randomUUID();
  await recoveryClient.queueCreate({
    mutationId: queuedMutationId,
    path: "tasks/queued-during-reset.md",
    frontmatter: { type: "task", title: "Still queued" },
    types: ["task"]
  });
  await writerClient.queueCreate({
    path: "tasks/advance-head.md",
    frontmatter: { type: "task", title: "Advance head" },
    types: ["task"]
  });
  await writerClient.sync();
  const head = (await writerTransport.openSession()).head;
  await request(`/v1/hosted/collections/${collectionId}/maintenance/compact`, {
    method: "POST",
    cookie,
    body: { through: head }
  });
  await recoveryClient.pull();
  if (!(await recoveryClient.pending()).some((mutation) => mutation.mutation_id === queuedMutationId)) {
    throw new Error("Cursor reset discarded an offline mutation");
  }

  await request(`/v1/hosted/replicas/${recovery.replica.id}`, { method: "DELETE", cookie });
  await expectSyncFailure(() => recoveryClient.pull(), "invalid_replica_token");
  const renewal = await fetch(`${serverUrl}/v1/hosted/replicas/${recovery.replica.id}/token`, {
    method: "POST",
    headers: { cookie }
  });
  if (renewal.status !== 404) throw new Error(`Revoked replica renewed with HTTP ${renewal.status}`);

  process.stdout.write("mdbase hosted sync vertical slice passed\n");
} finally {
  await app.close();
  await database.end();
  await rm(mirrorRoot, { recursive: true, force: true });
}

function replicaStore(replicaId) {
  return new MemoryReplicaStore({ replicaId, records: {}, pending: [], conflicts: {} });
}

async function createReplica(collectionId, cookie, name, mode) {
  return (await request(`/v1/hosted/collections/${collectionId}/replicas`, {
    method: "POST",
    cookie,
    body: { name, mode, allowed_types: ["task"] }
  })).body;
}

async function request(path, options = {}) {
  const headers = {};
  if (options.cookie) headers.cookie = options.cookie;
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  if (body) headers["content-type"] = "application/json";
  const response = await fetch(`${serverUrl}${path}`, { method: options.method ?? "GET", headers, body });
  const responseBody = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}: ${JSON.stringify(responseBody)}`);
  return { response, body: responseBody };
}

async function expectSyncFailure(action, expectedCode) {
  try {
    await action();
  } catch (error) {
    if (error?.code === expectedCode) return;
    throw error;
  }
  throw new Error(`Expected sync failure ${expectedCode}`);
}
