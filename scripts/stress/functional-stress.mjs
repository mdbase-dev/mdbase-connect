import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { deterministicUuid, parseDuration, SeededRandom } from "./random.mjs";
import { createStressSystem } from "./systems.mjs";

process.env.NODE_ENV = "test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const failureRoot = resolve(repoRoot, ".tmp/stress-failures");
const syncModuleUrl = new URL("../../packages/sync/dist/index.js", import.meta.url);
const syncNodeModuleUrl = new URL("../../packages/sync/dist/node.js", import.meta.url);

const PROFILES = {
  quick: {
    seeds: 2,
    steps: 120,
    clients: 3,
    initialRecords: 6,
    faultRate: 0.05,
    checkpointEvery: 30,
    mirrorEvery: 60,
    durationMs: 0,
    transport: "both"
  },
  functional: {
    seeds: 20,
    steps: 1_000,
    clients: 5,
    initialRecords: 12,
    faultRate: 0.04,
    checkpointEvery: 100,
    mirrorEvery: 250,
    durationMs: 0,
    transport: "memory"
  },
  scale: {
    seeds: 1,
    steps: 15_000,
    clients: 10,
    initialRecords: 100,
    faultRate: 0.01,
    checkpointEvery: 500,
    mirrorEvery: 2_000,
    durationMs: 0,
    transport: "memory"
  },
  soak: {
    seeds: 1,
    steps: Number.MAX_SAFE_INTEGER,
    clients: 8,
    initialRecords: 30,
    faultRate: 0.01,
    checkpointEvery: 250,
    mirrorEvery: 1_000,
    durationMs: 8 * 60 * 60 * 1_000,
    transport: "memory"
  }
};

export async function runStressCampaign(rawOptions = {}) {
  const options = resolveOptions(rawOptions);
  const modes = options.transport === "both" ? ["memory", "http"] : [options.transport];
  const campaignStarted = performance.now();
  const results = [];

  for (let seedIndex = 0; seedIndex < options.seeds; seedIndex += 1) {
    const seed = options.seed ?? `${options.profile}-${seedIndex + 1}`;
    const seedResults = [];
    for (const mode of modes) {
      const result = await runScenario({ ...options, seed, mode });
      results.push(result);
      seedResults.push(result);
      process.stdout.write(formatResult(result));
    }
    if (seedResults.length === 2) {
      assert.deepEqual(
        seedResults[0].records,
        seedResults[1].records,
        `Seed ${seed} produced different final collections through memory and HTTP transports`
      );
      assert.equal(
        seedResults[0].actionDigest,
        seedResults[1].actionDigest,
        `Seed ${seed} followed different semantic actions through memory and HTTP transports`
      );
      process.stdout.write(`stress differential seed=${seed} passed\n`);
    }
  }

  const summary = {
    profile: options.profile,
    scenarios: results.length,
    operations: results.reduce((sum, result) => sum + result.metrics.steps, 0),
    injectedFaults: results.reduce((sum, result) => sum + result.metrics.injectedFaults, 0),
    conflicts: results.reduce((sum, result) => sum + result.metrics.conflictsObserved, 0),
    restarts: results.reduce((sum, result) => sum + result.metrics.restarts, 0),
    compactions: results.reduce((sum, result) => sum + result.metrics.compactions, 0),
    elapsedMs: Math.round(performance.now() - campaignStarted)
  };
  process.stdout.write(`stress campaign passed ${JSON.stringify(summary)}\n`);
  return { options, results, summary };
}

async function runScenario(options) {
  const started = performance.now();
  const random = new SeededRandom(options.seed);
  const collectionId = deterministicUuid(options.seed, "collection", 0);
  const system = await createStressSystem(options.mode, { collectionId });
  const { MemoryReplicaStore, OfflineReplica } = await import(syncModuleUrl);
  const trace = [];
  const semanticActions = [];
  const metrics = {
    steps: 0,
    creates: 0,
    updates: 0,
    renames: 0,
    deletes: 0,
    syncs: 0,
    pulls: 0,
    concurrentRaces: 0,
    conflictsObserved: 0,
    injectedFaults: 0,
    duplicateDeliveries: 0,
    restarts: 0,
    compactions: 0,
    mirrorSyncs: 0,
    checkpoints: 0,
    maxHeapBytes: process.memoryUsage().heapUsed,
    maxRssBytes: process.memoryUsage().rss
  };
  const ids = new IdSequence(options.seed);
  const clients = [];
  let observer;
  let mirrorProbe;

  try {
    for (let index = 0; index < options.clients; index += 1) {
      const replica = await system.createReplica(`Stress writer ${index + 1}`);
      const store = new MemoryReplicaStore({
        replicaId: replica.id,
        records: {},
        pending: [],
        conflicts: {}
      });
      const transport = new FaultInjectingTransport(system, replica, metrics);
      const client = new OfflineReplica(transport, store);
      await client.initialize();
      clients.push({ index, replica, store, transport, client });
    }
    observer = await system.createReplica("Stress observer", "read_only");
    mirrorProbe = options.mirrorEvery > 0
      ? await createMirrorProbe(system, metrics)
      : null;

    await seedCollection(clients, ids, options.initialRecords, metrics, semanticActions);
    await pullAll(clients, metrics);
    await checkpoint(system, observer, clients, metrics);
    await mirrorProbe?.sync();
    await runDirectedPrelude({
      step: -1,
      system,
      observer,
      clients,
      random,
      ids,
      metrics,
      faultRate: options.faultRate,
      semanticActions
    });
    await checkpoint(system, observer, clients, metrics);

    const deadline = options.durationMs > 0 ? performance.now() + options.durationMs : Infinity;
    for (let step = 0; step < options.steps && performance.now() < deadline; step += 1) {
      const action = await executeRandomAction({
        step,
        system,
        observer,
        clients,
        random,
        ids,
        metrics,
        faultRate: options.faultRate,
        semanticActions
      });
      appendTrace(trace, { step, ...action });
      metrics.steps += 1;
      sampleMemory(metrics);

      if ((step + 1) % options.checkpointEvery === 0) {
        await checkpoint(system, observer, clients, metrics);
      }
      if (mirrorProbe && (step + 1) % options.mirrorEvery === 0) {
        await mirrorProbe.sync();
      }
    }

    await settleClients(clients, metrics);
    const authoritative = await snapshot(system.transportFor(observer));
    assertRecordsWellFormed(authoritative, "authority");
    for (const client of clients) {
      assert.deepEqual(
        normalizeRecords(await client.client.records()),
        normalizeRecords(authoritative),
        `Replica ${client.index + 1} did not converge`
      );
      assert.equal((await client.client.pending()).length, 0, `Replica ${client.index + 1} retained pending mutations`);
      assert.equal((await client.client.conflicts()).length, 0, `Replica ${client.index + 1} retained conflicts`);
      const beforeNoOp = normalizeRecords(await client.client.records());
      await client.client.pull();
      assert.deepEqual(normalizeRecords(await client.client.records()), beforeNoOp, "No-op pull changed replica state");
    }

    await system.restart();
    metrics.restarts += 1;
    await pullAll(clients, metrics);
    const afterRestart = await snapshot(system.transportFor(observer));
    assert.deepEqual(normalizeRecords(afterRestart), normalizeRecords(authoritative), "Authority restart changed collection state");
    await mirrorProbe?.verify(afterRestart);
    await assertRevocationBoundary(system, OfflineReplica, MemoryReplicaStore);

    const records = normalizeRecords(afterRestart);
    return {
      seed: options.seed,
      mode: options.mode,
      records,
      recordDigest: digest(records),
      actionDigest: digest(semanticActions),
      metrics,
      elapsedMs: Math.round(performance.now() - started)
    };
  } catch (error) {
    const diagnostics = await collectFailureDiagnostics(system, observer, clients);
    const artifact = await writeFailureArtifact({
      options,
      trace,
      semanticActions,
      metrics,
      diagnostics,
      error
    });
    error.stressArtifact = artifact;
    throw error;
  } finally {
    await mirrorProbe?.close().catch(() => {});
    await system.close().catch(() => {});
  }
}

async function collectFailureDiagnostics(system, observer, clients) {
  const diagnostics = { authority: null, clients: [] };
  if (observer) {
    try {
      diagnostics.authority = normalizeRecords(await snapshot(system.transportFor(observer)));
    } catch (error) {
      diagnostics.authority = { error: error?.message ?? String(error) };
    }
  }
  for (const client of clients) {
    try {
      diagnostics.clients.push({
        index: client.index,
        records: normalizeRecords(await client.client.records()),
        pending: await client.client.pending(),
        conflicts: await client.client.conflictEntries()
      });
    } catch (error) {
      diagnostics.clients.push({ index: client.index, error: error?.message ?? String(error) });
    }
  }
  return diagnostics;
}

async function runDirectedPrelude(context) {
  const writer = context.clients[0];
  const firstRecord = (await writer.client.records())[0];
  assert.ok(firstRecord, "Directed stress prelude requires one seeded record");
  const lostMutation = context.ids.next("mutation");
  await writer.client.queueUpdate({
    recordId: firstRecord.record_id,
    mutationId: lostMutation,
    patch: { lost_response_recovered: true }
  });
  writer.transport.failNext("mutate", "after");
  await assert.rejects(() => writer.client.sync(), InjectedFault);
  context.metrics.injectedFaults += 1;
  assert.ok(
    (await writer.client.pending()).some((mutation) => mutation.mutation_id === lostMutation),
    "Lost mutation response removed the durable pending mutation"
  );
  await writer.client.sync();
  context.metrics.syncs += 2;
  assert.ok(
    !(await writer.client.pending()).some((mutation) => mutation.mutation_id === lostMutation),
    "Retry did not consume the previously applied mutation receipt"
  );
  context.semanticActions.push({
    kind: "lost-response-retry",
    client: writer.index,
    recordId: firstRecord.record_id,
    mutationId: lostMutation
  });

  const pendingClient = context.clients.at(-1);
  const recordId = context.ids.next("record");
  const mutationId = context.ids.next("mutation");
  const path = `records/queued-across-compaction-${context.ids.count("record")}.md`;
  await pendingClient.client.queueCreate({
    recordId,
    mutationId,
    path,
    frontmatter: { title: "Queued across compaction" },
    body: "This mutation must survive a cursor reset.",
    types: []
  });
  const head = (await context.system.transportFor(context.observer).openSession()).head;
  await context.system.compact(head);
  context.metrics.compactions += 1;
  await pendingClient.client.pull();
  context.metrics.pulls += 1;
  assert.ok(
    (await pendingClient.client.pending()).some((mutation) => mutation.mutation_id === mutationId),
    "Cursor reset discarded an offline mutation"
  );
  await pendingClient.client.sync();
  context.metrics.syncs += 1;
  context.semanticActions.push({
    kind: "compaction-with-pending",
    client: pendingClient.index,
    head,
    recordId,
    mutationId,
    path
  });

  await context.system.restart();
  context.metrics.restarts += 1;
  context.semanticActions.push({ kind: "restart" });
  await concurrentUpdate(context);
}

async function seedCollection(clients, ids, count, metrics, semanticActions) {
  const writer = clients[0];
  for (let index = 0; index < count; index += 1) {
    const recordId = ids.next("record");
    const mutationId = ids.next("mutation");
    const path = `records/seed-${index + 1}.md`;
    await writer.client.queueCreate({
      recordId,
      mutationId,
      path,
      frontmatter: { title: `Seed ${index + 1}`, counter: 0 },
      body: `Initial body ${index + 1}`,
      types: []
    });
    metrics.creates += 1;
    semanticActions.push({ kind: "create", client: writer.index, recordId, mutationId, path, value: index + 1 });
  }
  await writer.client.sync();
  metrics.syncs += 1;
}

async function executeRandomAction(context) {
  const { random, clients } = context;
  let kind = random.weighted([
    { value: "create", weight: 20 },
    { value: "update", weight: 18 },
    { value: "rename", weight: 9 },
    { value: "delete", weight: 7 },
    { value: "sync", weight: 17 },
    { value: "pull", weight: 10 },
    { value: "concurrent", weight: 7 },
    { value: "restart", weight: 4 },
    { value: "compact", weight: 4 },
    { value: "noop", weight: 4 }
  ]);
  const selected = random.pick(clients);
  const editable = await editableRecords(selected);
  if (["update", "rename", "delete"].includes(kind) && editable.length === 0) kind = "create";

  switch (kind) {
    case "create": return queueCreate(context, selected);
    case "update": return queueUpdate(context, selected, random.pick(editable));
    case "rename": return queueRename(context, selected, random.pick(editable));
    case "delete": return queueDelete(context, selected, random.pick(editable));
    case "sync": return synchronizeWithFault(context, selected);
    case "pull": return pullWithFault(context, selected);
    case "concurrent": return concurrentUpdate(context);
    case "restart": {
      await context.system.restart();
      context.metrics.restarts += 1;
      context.semanticActions.push({ kind: "restart" });
      return { kind };
    }
    case "compact": {
      const session = await context.system.transportFor(context.observer).openSession();
      await context.system.compact(session.head);
      context.metrics.compactions += 1;
      context.semanticActions.push({ kind: "compact", head: session.head });
      return { kind, head: session.head };
    }
    case "noop": {
      selected.transport.clearFaults();
      await selected.client.sync();
      const before = normalizeReplicaState(selected.store);
      await selected.client.sync();
      const after = normalizeReplicaState(selected.store);
      assert.deepEqual(after, before, "A second no-op sync changed durable replica state");
      context.metrics.syncs += 2;
      context.semanticActions.push({ kind: "noop", client: selected.index });
      return { kind, client: selected.index };
    }
    default: throw new Error(`Unknown stress action ${kind}`);
  }
}

async function queueCreate(context, selected) {
  const ordinal = context.ids.count("record");
  const recordId = context.ids.next("record");
  const mutationId = context.ids.next("mutation");
  const path = `records/generated-${ordinal}.md`;
  await selected.client.queueCreate({
    recordId,
    mutationId,
    path,
    frontmatter: { title: `Generated ${ordinal}`, counter: context.step, writer: selected.index },
    body: `Created at stress step ${context.step}`,
    types: []
  });
  context.metrics.creates += 1;
  const action = { kind: "create", client: selected.index, recordId, mutationId, path, value: context.step };
  context.semanticActions.push(action);
  return action;
}

async function queueUpdate(context, selected, record) {
  const mutationId = context.ids.next("mutation");
  const patch = { counter: context.step, writer: selected.index };
  await selected.client.queueUpdate({ recordId: record.record_id, mutationId, patch });
  context.metrics.updates += 1;
  const action = { kind: "update", client: selected.index, recordId: record.record_id, mutationId, patch };
  context.semanticActions.push(action);
  return action;
}

async function queueRename(context, selected, record) {
  const mutationId = context.ids.next("mutation");
  const path = `records/renamed-${context.ids.count("path")}.md`;
  context.ids.next("path");
  await selected.client.queueRename({ recordId: record.record_id, mutationId, path });
  context.metrics.renames += 1;
  const action = { kind: "rename", client: selected.index, recordId: record.record_id, mutationId, path };
  context.semanticActions.push(action);
  return action;
}

async function queueDelete(context, selected, record) {
  const mutationId = context.ids.next("mutation");
  await selected.client.queueDelete({ recordId: record.record_id, mutationId });
  context.metrics.deletes += 1;
  const action = { kind: "delete", client: selected.index, recordId: record.record_id, mutationId };
  context.semanticActions.push(action);
  return action;
}

async function synchronizeWithFault(context, selected) {
  const pending = await selected.client.pending();
  let fault = null;
  if (pending.length > 0 && context.random.chance(context.faultRate)) {
    fault = context.random.pick(["before", "after", "duplicate"]);
    selected.transport.failNext("mutate", fault);
  }
  try {
    await selected.client.sync();
    context.metrics.syncs += 1;
  } catch (error) {
    if (!(error instanceof InjectedFault)) throw error;
    context.metrics.injectedFaults += 1;
  }
  context.metrics.conflictsObserved += (await selected.client.conflicts()).length;
  const action = { kind: "sync", client: selected.index, fault };
  context.semanticActions.push(action);
  return action;
}

async function pullWithFault(context, selected) {
  let fault = null;
  if (context.random.chance(context.faultRate)) {
    fault = context.random.pick(["before", "after"]);
    selected.transport.failNext("changes", fault);
  }
  try {
    await selected.client.pull();
    context.metrics.pulls += 1;
  } catch (error) {
    if (!(error instanceof InjectedFault)) throw error;
    context.metrics.injectedFaults += 1;
  }
  const action = { kind: "pull", client: selected.index, fault };
  context.semanticActions.push(action);
  return action;
}

async function concurrentUpdate(context) {
  if (context.clients.length < 2) return { kind: "concurrent", skipped: "one client" };
  const firstIndex = context.random.integer(0, context.clients.length - 1);
  let secondIndex = context.random.integer(0, context.clients.length - 2);
  if (secondIndex >= firstIndex) secondIndex += 1;
  const first = context.clients[firstIndex];
  const second = context.clients[secondIndex];
  await stabilizeClient(first, context.metrics);
  await stabilizeClient(second, context.metrics);
  await Promise.all([first.client.pull(), second.client.pull()]);
  context.metrics.pulls += 2;
  const firstRecords = await first.client.records();
  const secondRecords = new Map((await second.client.records()).map((record) => [record.record_id, record]));
  const common = firstRecords.filter((record) => secondRecords.get(record.record_id)?.revision === record.revision);
  if (common.length === 0) return { kind: "concurrent", skipped: "no common record" };
  const record = context.random.pick(common);
  const firstMutation = context.ids.next("mutation");
  const secondMutation = context.ids.next("mutation");
  await first.client.queueUpdate({
    recordId: record.record_id,
    mutationId: firstMutation,
    patch: { race: context.step, writer: first.index }
  });
  await second.client.queueUpdate({
    recordId: record.record_id,
    mutationId: secondMutation,
    patch: { race: context.step, writer: second.index }
  });
  const firstWins = context.random.chance(0.5);
  first.transport.delayNext("mutate", firstWins ? 0 : 8);
  second.transport.delayNext("mutate", firstWins ? 8 : 0);
  const settled = await Promise.allSettled([first.client.sync(), second.client.sync()]);
  for (const result of settled) if (result.status === "rejected") throw result.reason;
  context.metrics.syncs += 2;
  context.metrics.concurrentRaces += 1;
  const conflicts = (await first.client.conflicts()).length + (await second.client.conflicts()).length;
  assert.ok(conflicts >= 1, "Concurrent writes from one revision did not create a conflict");
  context.metrics.conflictsObserved += conflicts;
  const action = {
    kind: "concurrent",
    recordId: record.record_id,
    first: first.index,
    second: second.index,
    firstMutation,
    secondMutation,
    firstWins
  };
  context.semanticActions.push(action);
  return action;
}

async function stabilizeClient(client, metrics) {
  client.transport.clearFaults();
  for (const { recordId } of await client.client.conflictEntries()) {
    await client.client.resolveConflict(recordId, "remote");
  }
  await client.client.sync();
  metrics.syncs += 1;
}

async function settleClients(clients, metrics) {
  for (const client of clients) client.transport.clearFaults();
  for (let round = 0; round < 30; round += 1) {
    for (const client of clients) {
      for (const { recordId } of await client.client.conflictEntries()) {
        await client.client.resolveConflict(recordId, "remote");
      }
      await client.client.sync();
      metrics.syncs += 1;
    }
    for (const client of clients) {
      for (const { recordId } of await client.client.conflictEntries()) {
        await client.client.resolveConflict(recordId, "remote");
      }
      await client.client.pull();
      metrics.pulls += 1;
    }
    const unsettled = await Promise.all(clients.map(async ({ client }) =>
      (await client.pending()).length + (await client.conflicts()).length
    ));
    if (unsettled.every((count) => count === 0)) return;
  }
  throw new Error("Replicas did not settle after 30 recovery rounds");
}

async function pullAll(clients, metrics) {
  for (const client of clients) {
    client.transport.clearFaults();
    await client.client.pull();
    metrics.pulls += 1;
  }
}

async function checkpoint(system, observer, clients, metrics) {
  const authoritative = await snapshot(system.transportFor(observer));
  assertRecordsWellFormed(authoritative, "authority checkpoint");
  for (const client of clients) assertReplicaWellFormed(client);
  metrics.checkpoints += 1;
}

async function snapshot(transport) {
  const session = await transport.openSession();
  const records = [];
  let page;
  do {
    const value = await transport.snapshot(session.snapshot_id, page);
    assert.equal(value.cursor, session.head, "Snapshot cursor changed within one session");
    records.push(...value.records);
    page = value.next_page;
  } while (page);
  return records;
}

function assertReplicaWellFormed(client) {
  const data = client.store.data;
  assertRecordsWellFormed(Object.values(data.records), `replica ${client.index + 1}`);
  assert.equal(new Set(data.pending.map((mutation) => mutation.mutation_id)).size, data.pending.length, "Pending mutation IDs are not unique");
  for (const [recordId, receipt] of Object.entries(data.conflicts)) {
    assert.equal(receipt.conflict?.record_id ?? recordId, recordId, "Conflict is indexed under another record");
  }
}

function assertRecordsWellFormed(records, label) {
  assert.equal(new Set(records.map((record) => record.record_id)).size, records.length, `${label} has duplicate record IDs`);
  assert.equal(new Set(records.map((record) => record.path)).size, records.length, `${label} has duplicate paths`);
  for (const record of records) {
    assert.ok(record.path.endsWith(".md"), `${label} contains a non-Markdown record path`);
    assert.ok(record.revision, `${label} contains a record without a revision`);
  }
}

async function editableRecords(client) {
  const blocked = new Set((await client.client.conflictEntries()).map(({ recordId }) => recordId));
  return (await client.client.records()).filter((record) => !blocked.has(record.record_id));
}

async function assertRevocationBoundary(system, OfflineReplica, MemoryReplicaStore) {
  const replica = await system.createReplica("Revocation probe", "read_only");
  const store = new MemoryReplicaStore({ replicaId: replica.id, records: {}, pending: [], conflicts: {} });
  const client = new OfflineReplica(system.transportFor(replica), store);
  await client.initialize();
  await system.revoke(replica);
  await assert.rejects(
    () => client.pull(),
    (error) => ["replica_revoked", "invalid_replica_token"].includes(error?.code),
    "Revoked replica remained usable"
  );
}

async function createMirrorProbe(system, metrics) {
  const [{ DirectoryMirror, MemoryMirrorLease, NodeMirrorStateStore, recordMarkdownDocument }] = await Promise.all([
    import(syncNodeModuleUrl)
  ]);
  const replica = await system.createReplica("Stress mirror", "read_only");
  const root = await mkdtemp(join(tmpdir(), "mdbase-connect-stress-mirror-"));
  const stateRoot = await mkdtemp(join(tmpdir(), "mdbase-connect-stress-state-"));
  const transport = new DynamicTransport(system, replica);
  const mirror = new DirectoryMirror(root, replica.id, transport, {
    stateStore: new NodeMirrorStateStore(root, stateRoot),
    lease: new MemoryMirrorLease()
  });

  return {
    async sync() {
      await mirror.sync();
      metrics.mirrorSyncs += 1;
    },
    async verify(records) {
      await mirror.sync();
      metrics.mirrorSyncs += 1;
      const before = await recordFileStats(root, records);
      for (const record of records) {
        assert.equal(
          await readFile(join(root, record.path), "utf8"),
          recordMarkdownDocument(record),
          `Mirror content differs for ${record.path}`
        );
      }
      assert.deepEqual(
        await markdownPaths(root),
        records.map((record) => record.path).sort(),
        "Mirror contains missing or unexpected Markdown records"
      );
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
      await mirror.sync();
      metrics.mirrorSyncs += 1;
      assert.deepEqual(await recordFileStats(root, records), before, "No-op mirror sync rewrote record files");
    },
    async close() {
      await rm(root, { recursive: true, force: true });
      await rm(stateRoot, { recursive: true, force: true });
    }
  };
}

async function recordFileStats(root, records) {
  return Promise.all(records.map(async (record) => {
    const value = await stat(join(root, record.path));
    return { path: record.path, size: value.size, mtimeMs: value.mtimeMs, ino: value.ino };
  }));
}

async function markdownPaths(root) {
  const found = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".md")) found.push(relative(root, path));
    }
  }
  await visit(root);
  return found.sort();
}

class DynamicTransport {
  constructor(system, replica) {
    this.system = system;
    this.replica = replica;
  }
  openSession() { return this.system.transportFor(this.replica).openSession(); }
  snapshot(snapshotId, page) { return this.system.transportFor(this.replica).snapshot(snapshotId, page); }
  fileSnapshot(snapshotId, page) { return this.system.transportFor(this.replica).fileSnapshot(snapshotId, page); }
  changes(after, limit) { return this.system.transportFor(this.replica).changes(after, limit); }
  mutate(mutation) { return this.system.transportFor(this.replica).mutate(mutation); }
}

class FaultInjectingTransport extends DynamicTransport {
  constructor(system, replica, metrics) {
    super(system, replica);
    this.metrics = metrics;
    this.faults = new Map();
    this.delays = new Map();
  }

  failNext(operation, mode) {
    this.faults.set(operation, mode);
  }

  delayNext(operation, milliseconds) {
    this.delays.set(operation, milliseconds);
  }

  clearFaults() {
    this.faults.clear();
    this.delays.clear();
  }

  async changes(after, limit) {
    return this.execute("changes", () => super.changes(after, limit));
  }

  async mutate(mutation) {
    return this.execute("mutate", () => super.mutate(mutation));
  }

  async execute(operation, action) {
    const delay = this.delays.get(operation) ?? 0;
    this.delays.delete(operation);
    if (delay > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
    const fault = this.faults.get(operation);
    this.faults.delete(operation);
    if (fault === "before") throw new InjectedFault(operation, fault);
    const result = await action();
    if (fault === "after") throw new InjectedFault(operation, fault);
    if (fault === "duplicate") {
      const duplicate = await action();
      assert.equal(duplicate.mutation_id, result.mutation_id, "Duplicate mutation returned another receipt");
      assert.deepEqual(
        normalizeDuplicateReceipt(duplicate),
        normalizeDuplicateReceipt(result),
        "Duplicate mutation returned different content"
      );
      this.metrics.duplicateDeliveries += 1;
    }
    return result;
  }
}

class InjectedFault extends Error {
  constructor(operation, phase) {
    super(`Injected ${phase}-response ${operation} failure`);
    this.name = "InjectedFault";
  }
}

class IdSequence {
  constructor(seed) {
    this.seed = seed;
    this.counters = new Map();
  }
  count(namespace) {
    return this.counters.get(namespace) ?? 0;
  }
  next(namespace) {
    const ordinal = this.count(namespace);
    this.counters.set(namespace, ordinal + 1);
    return deterministicUuid(this.seed, namespace, ordinal);
  }
}

function normalizeDuplicateReceipt(receipt) {
  return { ...receipt, status: receipt.status === "previously_applied" ? "applied" : receipt.status };
}

function normalizeReplicaState(store) {
  const data = store.data;
  return {
    ...structuredClone(data),
    records: Object.fromEntries(Object.entries(data.records).sort(([left], [right]) => left.localeCompare(right))),
    pending: [...data.pending].sort((left, right) => left.mutation_id.localeCompare(right.mutation_id)),
    conflicts: Object.fromEntries(Object.entries(data.conflicts).sort(([left], [right]) => left.localeCompare(right)))
  };
}

function normalizeRecords(records) {
  return records.map((record) => ({
    record_id: record.record_id,
    path: record.path,
    revision: record.revision,
    frontmatter: structuredClone(record.frontmatter),
    body: record.body,
    types: [...record.types]
  })).sort((left, right) => left.record_id.localeCompare(right.record_id));
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function appendTrace(trace, entry) {
  trace.push(entry);
  if (trace.length > 50_000) trace.shift();
}

function sampleMemory(metrics) {
  const usage = process.memoryUsage();
  metrics.maxHeapBytes = Math.max(metrics.maxHeapBytes, usage.heapUsed);
  metrics.maxRssBytes = Math.max(metrics.maxRssBytes, usage.rss);
}

async function writeFailureArtifact(value) {
  await mkdir(failureRoot, { recursive: true });
  const name = `${safeName(value.options.seed)}-${value.options.mode}-${Date.now()}.json`;
  const path = join(failureRoot, name);
  await writeFile(path, `${JSON.stringify({
    ...value,
    error: {
      name: value.error?.name,
      message: value.error?.message,
      stack: value.error?.stack
    }
  }, null, 2)}\n`);
  return path;
}

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9_.-]+/g, "-").slice(0, 80);
}

function formatResult(result) {
  return `stress ${result.mode} seed=${result.seed} passed steps=${result.metrics.steps} records=${result.records.length} faults=${result.metrics.injectedFaults} conflicts=${result.metrics.conflictsObserved} restarts=${result.metrics.restarts} compactions=${result.metrics.compactions} elapsed_ms=${result.elapsedMs} digest=${result.recordDigest.slice(0, 12)}\n`;
}

function resolveOptions(raw) {
  const profileName = raw.profile ?? "quick";
  const profile = PROFILES[profileName];
  if (!profile) throw new Error(`Unknown stress profile ${profileName}`);
  const options = { ...profile, ...raw, profile: profileName };
  if (raw.seed !== undefined && raw.seeds === undefined) options.seeds = 1;
  for (const field of ["seeds", "steps", "clients", "initialRecords", "checkpointEvery", "mirrorEvery"]) {
    if (!Number.isSafeInteger(options[field]) || options[field] < (field === "mirrorEvery" ? 0 : 1)) {
      throw new Error(`${field} must be a ${field === "mirrorEvery" ? "non-negative" : "positive"} integer`);
    }
  }
  if (typeof options.faultRate !== "number" || options.faultRate < 0 || options.faultRate > 1) {
    throw new Error("faultRate must be between 0 and 1");
  }
  if (!["memory", "http", "both"].includes(options.transport)) {
    throw new Error("transport must be memory, http, or both");
  }
  return options;
}

function parseArguments(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if (argument === "--profile") options.profile = value;
    else if (argument === "--seed") options.seed = value;
    else if (argument === "--seeds") options.seeds = parsePositiveInteger(value, argument);
    else if (argument === "--steps") options.steps = parsePositiveInteger(value, argument);
    else if (argument === "--clients") options.clients = parsePositiveInteger(value, argument);
    else if (argument === "--initial-records") options.initialRecords = parsePositiveInteger(value, argument);
    else if (argument === "--fault-rate") options.faultRate = Number.parseFloat(value);
    else if (argument === "--checkpoint-every") options.checkpointEvery = parsePositiveInteger(value, argument);
    else if (argument === "--mirror-every") options.mirrorEvery = Number.parseInt(value, 10);
    else if (argument === "--transport") options.transport = value;
    else if (argument === "--duration") options.durationMs = parseDuration(value);
    else if (argument === "--no-mirror") {
      options.mirrorEvery = 0;
      continue;
    } else if (["--help", "-h"].includes(argument)) {
      process.stdout.write(help());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument ${argument}`);
    }
    index += 1;
  }
  return options;
}

function parsePositiveInteger(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} requires a positive integer`);
  return parsed;
}

function help() {
  return `Usage: node scripts/stress/functional-stress.mjs [options]\n\n` +
    `  --profile quick|functional|scale|soak\n` +
    `  --transport memory|http|both\n` +
    `  --seed VALUE             replay one exact seed\n` +
    `  --seeds N                number of independent scenarios\n` +
    `  --steps N                maximum randomized steps per scenario\n` +
    `  --clients N              concurrent writable replicas\n` +
    `  --initial-records N      records present before random actions\n` +
    `  --fault-rate N           probability from 0 through 1\n` +
    `  --duration 30s|5m|8h     stop each scenario after elapsed time\n` +
    `  --no-mirror              skip real filesystem mirror checks\n`;
}

const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  runStressCampaign(parseArguments(process.argv.slice(2))).catch((error) => {
    process.stderr.write(
      `${error?.stack ?? error}\n`
      + (error?.stressArtifact ? `Stress failure artifact: ${error.stressArtifact}\n` : "")
    );
    process.exitCode = 1;
  });
}
