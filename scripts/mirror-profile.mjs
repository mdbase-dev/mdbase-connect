#!/usr/bin/env node

import { performance } from "node:perf_hooks";
import { MemoryAuthority } from "../packages/sync/dist/index.js";
import {
  DirectoryMirror,
  MemoryMirrorLease,
  MemoryMirrorStateStore,
  WritableDirectoryMirror
} from "../packages/sync/dist/node.js";
import {
  DirectoryMirror as PortableDirectoryMirror,
  WritableDirectoryMirror as PortableWritableDirectoryMirror
} from "../packages/sync/dist/mirror.js";

function integerArgument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return value;
}

function stringArgument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
}

const recordCount = integerArgument("records", 10_000);
const changeCount = integerArgument("changes", 100);
const rounds = integerArgument("rounds", 3);
const pageSize = integerArgument("page-size", 200);
const adapterArgument = stringArgument("adapter", "both");
if (!["both", "node", "portable"].includes(adapterArgument)) {
  throw new Error("--adapter must be node, portable, or both");
}
const adapters = adapterArgument === "both" ? ["node", "portable"] : [adapterArgument];

class Probe {
  constructor() {
    this.reset();
  }

  reset() {
    this.peakHeap = process.memoryUsage().heapUsed;
    this.peakRss = process.memoryUsage().rss;
  }

  touch() {
    const usage = process.memoryUsage();
    this.peakHeap = Math.max(this.peakHeap, usage.heapUsed);
    this.peakRss = Math.max(this.peakRss, usage.rss);
  }
}

class CountingFileSystem {
  files = new Map();
  reads = 0;
  writes = 0;
  removes = 0;
  lists = 0;

  constructor(probe) {
    this.probe = probe;
  }

  reset() {
    this.reads = 0;
    this.writes = 0;
    this.removes = 0;
    this.lists = 0;
  }

  async read(path) {
    this.reads += 1;
    this.probe.touch();
    return this.files.get(path) ?? null;
  }

  async write(path, value) {
    this.writes += 1;
    this.files.set(path, value);
    this.probe.touch();
  }

  async remove(path) {
    this.removes += 1;
    this.files.delete(path);
    this.probe.touch();
  }

  async listMarkdown(excluded) {
    this.lists += 1;
    this.probe.touch();
    return [...this.files.keys()]
      .filter((path) => path.endsWith(".md") && !excluded.has(path))
      .sort();
  }

  metrics() {
    return {
      fs_reads: this.reads,
      fs_writes: this.writes,
      fs_removes: this.removes,
      fs_lists: this.lists
    };
  }
}

class CountingStateStore extends MemoryMirrorStateStore {
  reads = 0;
  writes = 0;

  constructor(probe) {
    super();
    this.probe = probe;
  }

  reset() {
    this.reads = 0;
    this.writes = 0;
  }

  async read() {
    this.reads += 1;
    const state = await super.read();
    this.probe.touch();
    return state;
  }

  async write(state) {
    this.writes += 1;
    await super.write(state);
    this.probe.touch();
  }

  metrics() {
    return {
      state_reads: this.reads,
      state_writes: this.writes
    };
  }
}

function countingTransport(transport, probe) {
  const calls = { open_session: 0, snapshot: 0, changes: 0, mutate: 0 };
  return {
    calls,
    reset() {
      calls.open_session = 0;
      calls.snapshot = 0;
      calls.changes = 0;
      calls.mutate = 0;
    },
    transport: {
      async openSession() {
        calls.open_session += 1;
        const result = await transport.openSession();
        probe.touch();
        return result;
      },
      async snapshot(snapshotId, page) {
        calls.snapshot += 1;
        const result = await transport.snapshot(snapshotId, page);
        probe.touch();
        return result;
      },
      async changes(after, limit) {
        calls.changes += 1;
        const result = await transport.changes(after, limit);
        probe.touch();
        return result;
      },
      async mutate(mutation) {
        calls.mutate += 1;
        const result = await transport.mutate(mutation);
        probe.touch();
        return result;
      }
    }
  };
}

function seededAuthority(mode) {
  const authority = new MemoryAuthority({ snapshotPageSize: pageSize });
  authority.seed(Array.from({ length: recordCount }, (_, index) => {
    const suffix = String(index).padStart(8, "0");
    return {
      record_id: `profile-record-${suffix}`,
      path: `notes/${suffix}.md`,
      frontmatter: {
        type: "note",
        title: `Profile note ${suffix}`,
        sequence: index,
        tags: ["profile", index % 2 === 0 ? "even" : "odd"]
      },
      body: `Profile body ${suffix}\n${"x".repeat(192)}`,
      types: ["note"]
    };
  }));
  const replicaId = authority.registerReplica({
    id: `profile-${mode}`,
    name: "Mirror profiler",
    mode
  });
  return { authority, replicaId };
}

async function measure(name, operation, probe, fileSystem, stateStore, transport) {
  fileSystem.reset();
  stateStore.reset();
  transport.reset();
  if (global.gc) global.gc();
  const before = process.memoryUsage();
  probe.reset();
  const started = performance.now();
  await operation();
  const wallMs = performance.now() - started;
  probe.touch();
  const after = process.memoryUsage();
  if (global.gc) global.gc();
  const retained = process.memoryUsage();
  return {
    name,
    wall_ms: Number(wallMs.toFixed(3)),
    peak_heap_delta_mib: Number(((probe.peakHeap - before.heapUsed) / 2 ** 20).toFixed(3)),
    peak_rss_delta_mib: Number(((probe.peakRss - before.rss) / 2 ** 20).toFixed(3)),
    retained_heap_delta_mib: Number(((retained.heapUsed - before.heapUsed) / 2 ** 20).toFixed(3)),
    heap_after_delta_mib: Number(((after.heapUsed - before.heapUsed) / 2 ** 20).toFixed(3)),
    ...fileSystem.metrics(),
    ...stateStore.metrics(),
    transport_calls: { ...transport.calls }
  };
}

async function readOnlyRound(adapter) {
  const probe = new Probe();
  const fileSystem = new CountingFileSystem(probe);
  const stateStore = new CountingStateStore(probe);
  const { authority, replicaId } = seededAuthority("read_only");
  const counted = countingTransport(authority.transport(replicaId), probe);
  const options = { fileSystem, stateStore, lease: new MemoryMirrorLease() };
  const mirror = adapter === "node"
    ? new DirectoryMirror(".", replicaId, counted.transport, options)
    : new PortableDirectoryMirror(replicaId, counted.transport, options);
  const initial = await measure(
    `${adapter}_read_only_initial`,
    () => mirror.sync(),
    probe,
    fileSystem,
    stateStore,
    counted
  );
  const noOp = await measure(
    `${adapter}_read_only_noop`,
    () => mirror.sync(),
    probe,
    fileSystem,
    stateStore,
    counted
  );

  const writerId = authority.registerReplica({
    id: "profile-incremental-writer",
    name: "Profile incremental writer",
    mode: "read_write",
    allowedTypes: ["note"]
  });
  const writer = authority.transport(writerId);
  for (let index = 0; index < changeCount; index += 1) {
    const suffix = String(recordCount + index).padStart(8, "0");
    const receipt = await writer.mutate({
      mutation_id: `profile-mutation-${suffix}`,
      replica_id: writerId,
      scope_epoch: 1,
      operation: "create",
      record_id: `profile-record-${suffix}`,
      input: {
        path: `notes/${suffix}.md`,
        frontmatter: { type: "note", title: `Incremental ${suffix}`, sequence: recordCount + index },
        body: `Incremental body ${suffix}`,
        types: ["note"]
      },
      created_at: "2026-01-01T00:00:00.000Z"
    });
    if (receipt.status !== "applied") throw new Error(`profile mutation ${suffix} failed`);
  }
  const incremental = await measure(
    `${adapter}_read_only_incremental`,
    () => mirror.sync(),
    probe,
    fileSystem,
    stateStore,
    counted
  );
  return [initial, noOp, incremental];
}

async function writableRound(adapter) {
  const probe = new Probe();
  const fileSystem = new CountingFileSystem(probe);
  const stateStore = new CountingStateStore(probe);
  const { authority, replicaId } = seededAuthority("read_write");
  const counted = countingTransport(authority.transport(replicaId), probe);
  const options = { fileSystem, stateStore, lease: new MemoryMirrorLease() };
  const mirror = adapter === "node"
    ? new WritableDirectoryMirror(".", replicaId, counted.transport, options)
    : new PortableWritableDirectoryMirror(replicaId, counted.transport, options);
  const initial = await measure(
    `${adapter}_read_write_initial`,
    () => mirror.sync(),
    probe,
    fileSystem,
    stateStore,
    counted
  );
  const noOp = await measure(
    `${adapter}_read_write_noop`,
    () => mirror.sync(),
    probe,
    fileSystem,
    stateStore,
    counted
  );
  return [initial, noOp];
}

const samples = [];
for (let round = 0; round < rounds; round += 1) {
  for (const adapter of adapters) {
    samples.push(...await readOnlyRound(adapter), ...await writableRound(adapter));
  }
}

process.stdout.write(`${JSON.stringify({
  profile_version: 1,
  runtime: {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    gc_exposed: typeof global.gc === "function"
  },
  parameters: {
    records: recordCount,
    changes: changeCount,
    rounds,
    snapshot_page_size: pageSize,
    adapters
  },
  samples
}, null, 2)}\n`);
