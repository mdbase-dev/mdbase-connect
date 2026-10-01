import { describe, expect, it } from "vitest";
import { MemoryAuthority, type SyncTransport } from "./index.js";
import { SyncError } from "./sync-error.js";
import { physicalMirrorPathKey } from "./mirror-physical-path.js";
import {
  MemoryMirrorStateStore,
  WritableDirectoryMirror,
  type MirrorFileSystem,
  type MirrorState
} from "./mirror.js";

class TextFileSystem implements MirrorFileSystem {
  readonly files = new Map<string, string>();
  constructor(private readonly insensitive = false) {}
  private actualPath(path: string) {
    return this.insensitive ? [...this.files.keys()].find((candidate) =>
      physicalMirrorPathKey(candidate) === physicalMirrorPathKey(path)) ?? path : path;
  }
  async exists(path: string) { return this.files.has(this.actualPath(path)); }
  async read(path: string) { return this.files.get(this.actualPath(path)) ?? null; }
  async readText(path: string) { return this.read(path); }
  async write(path: string, document: string) { this.files.set(path, document); }
  async move(source: string, target: string) {
    source = this.actualPath(source);
    if (this.files.has(this.actualPath(target))) throw new Error("occupied move target");
    const document = this.files.get(source);
    if (document === undefined) throw new Error(`Missing source ${source}`);
    this.files.set(target, document);
    this.files.delete(source);
  }
  async remove(path: string) { this.files.delete(this.actualPath(path)); }
  async inspectBinary() { return null; }
  async writeBinary(): Promise<void> { throw new Error("unused binary write"); }
  async listMarkdown(excluded: ReadonlySet<string>) {
    return [...this.files.keys()].filter((path) => !excluded.has(path)).sort();
  }
}

/** A killed process cannot persist a catch block's recovery writes. */
class CrashGate {
  readonly trace: string[] = [];
  crashed = false;
  constructor(private readonly cut?: number) {}

  wrap<Port extends object>(name: string, port: Port): Port {
    return new Proxy(port, {
      get: (target, property) => {
        const value = Reflect.get(target, property);
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          this.boundary(`${name}.${String(property)}:before`);
          const result = await value.apply(target, args);
          this.boundary(`${name}.${String(property)}:after`);
          return result;
        };
      }
    });
  }

  private boundary(label: string) {
    if (this.crashed) throw new Error("process killed");
    this.trace.push(label);
    if (this.trace.length - 1 === this.cut) {
      this.crashed = true;
      throw new Error("process killed");
    }
  }
}

const seeds = ["a", "b", "c", "d"].map((id) => ({
  record_id: id, path: `${id}.md`, document: `base ${id}`,
  frontmatter: {}, body: `base ${id}`, types: []
}));

async function fixture(initial: boolean, swap = false, spelling = false) {
  const authority = new MemoryAuthority({ snapshotPageSize: 1 });
  authority.seed(seeds);
  const replicaId = authority.registerReplica({ name: "Fault injection", mode: "read_write" });
  const transport = authority.transport(replicaId);
  const fileSystem = new TextFileSystem(spelling);
  const stateStore = new MemoryMirrorStateStore();
  const create = (gate?: CrashGate) => new WritableDirectoryMirror(replicaId,
    gate ? gate.wrap("transport", transport) : transport, {
      fileSystem: gate ? gate.wrap("filesystem", fileSystem) : fileSystem,
      stateStore: gate ? gate.wrap("state", stateStore) : stateStore
    });
  const expected = new Map(seeds.map((record) => [record.path, record.document]));
  if (!initial) {
    await create().sync();
    if (spelling) {
      await transport.mutate({
        operation: "move", mutation_id: "spelling-rename", replica_id: replicaId, scope_epoch: 1,
        record_id: "a", base_revision: (await stateStore.read())!.records.a!.revision, path: "A.md",
        created_at: "2026-10-01T00:00:00.000Z"
      });
      expected.delete("a.md");
      expected.set("A.md", "base a");
      return { authority, transport, fileSystem, stateStore, create, expected };
    }
    if (swap) {
      const initialRecords = (await stateStore.read())!.records;
      for (const [id, path] of [["a", "temporary.md"], ["b", "a.md"], ["a", "b.md"]]) {
        await transport.mutate({
          operation: "move", mutation_id: `${id}-${path}`, replica_id: replicaId, scope_epoch: 1,
          record_id: id!, base_revision: initialRecords[id!]!.revision, path: path!,
          created_at: "2026-10-01T00:00:00.000Z"
        });
      }
      expected.set("a.md", "base b");
      expected.set("b.md", "base a");
      return { authority, transport, fileSystem, stateStore, create, expected };
    }
    const remoteId = authority.registerReplica({ name: "Other device", mode: "read_write" });
    const remote = authority.transport(remoteId);
    await remote.mutate({
      operation: "put", mutation_id: "remote-put", replica_id: remoteId, scope_epoch: 1,
      record_id: "a", base_revision: (await stateStore.read())!.records.a!.revision,
      path: "a.md", document: "remote a", created_at: "2026-10-01T00:00:00.000Z"
    });
    await remote.mutate({
      operation: "move", mutation_id: "remote-move", replica_id: remoteId, scope_epoch: 1,
      record_id: "c", base_revision: (await stateStore.read())!.records.c!.revision,
      path: "c-moved.md", created_at: "2026-10-01T00:00:00.000Z"
    });
    await remote.mutate({
      operation: "delete", mutation_id: "remote-delete", replica_id: remoteId, scope_epoch: 1,
      record_id: "d", base_revision: (await stateStore.read())!.records.d!.revision,
      created_at: "2026-10-01T00:00:00.000Z"
    });
    await fileSystem.move("b.md", "b-moved.md");
    fileSystem.files.set("new.md", "new local document");
    expected.set("a.md", "remote a");
    expected.delete("b.md");
    expected.set("b-moved.md", "base b");
    expected.delete("c.md");
    expected.set("c-moved.md", "base c");
    expected.delete("d.md");
    expected.set("new.md", "new local document");
  }
  return { authority, transport, fileSystem, stateStore, create, expected };
}

async function assertConverged(context: Awaited<ReturnType<typeof fixture>>) {
  const restarted = context.create();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    expect((await restarted.sync()).status).toBe("applied");
  }
  expect((await restarted.inspect()).actions).toEqual([]);
  expect(context.fileSystem.files).toEqual(context.expected);
  const remoteRecords = context.authority.serialize().records;
  expect(new Set(remoteRecords.map((record) => record.path)).size).toBe(context.expected.size);
  expect(new Map(remoteRecords.map((record) => [record.path, record.document]))).toEqual(context.expected);
  const state = (await context.stateStore.read())!;
  expect(state.batch).toBeUndefined();
  expect(Object.keys(state.records)).toHaveLength(context.expected.size);
}

describe("directory mirror process-death boundaries", () => {
  it("retries a lease expiring between snapshot pages without partially materializing", async () => {
    const context = await fixture(true);
    let pages = 0;
    let expire = true;
    const transport: SyncTransport = {
      ...context.transport,
      snapshot: async (id, page) => {
        if (++pages === 2 && expire) throw new SyncError("snapshot_expired", "lease expired");
        return context.transport.snapshot(id, page);
      }
    };
    const replicaId = (await context.transport.openSession()).replica_id;
    const mirror = new WritableDirectoryMirror(replicaId, transport, context);
    await expect(mirror.sync()).rejects.toMatchObject({ code: "snapshot_expired" });
    expect(await context.stateStore.read()).toBeNull();
    expect(context.fileSystem.files.size).toBe(0);
    expire = false;
    expect((await mirror.sync()).status).toBe("applied");
    await assertConverged(context);
  });

  it.each(["initial", "incremental", "swap", "spelling"])("converges after every await before/after boundary (%s)", async (scenario) => {
    const initial = scenario === "initial";
    const swap = scenario === "swap";
    const spelling = scenario === "spelling";
    const baseline = await fixture(initial, swap, spelling);
    const trace = new CrashGate();
    expect((await baseline.create(trace).sync()).status).toBe("applied");
    expect(trace.trace).toContain("state.write:before");
    expect(trace.trace).toContain("state.appendJournal:after");

    for (let cut = 0; cut < trace.trace.length; cut += 1) {
      const context = await fixture(initial, swap, spelling);
      const planned = await context.create().inspect();
      const prior: MirrorState | null = await context.stateStore.read();
      const gate = new CrashGate(cut);
      // Depending on the boundary, death is thrown directly or classified as
      // an action failure before the next persistence attempt is also killed.
      await context.create(gate).sync().catch(() => undefined);
      expect(gate.crashed, `${cut}: ${trace.trace[cut]}`).toBe(true);
      const durable = await context.stateStore.read();
      if (durable?.last_completed_plan === planned.fingerprint) {
        // No checkpoint may claim the inspected head before all effects exist.
        expect(context.fileSystem.files).toEqual(context.expected);
      } else {
        expect(durable?.cursor ?? null).toBe(prior?.cursor ?? (durable ? 0 : null));
      }
      await assertConverged(context);
    }
  });

  it.each(["put", "move", "delete"] as const)("retries a committed %s with a lost response only once", async (operation) => {
    const context = await fixture(true);
    await context.create().sync();
    if (operation === "put") {
      context.fileSystem.files.set("a.md", "local replacement");
      context.expected.set("a.md", "local replacement");
    } else if (operation === "move") {
      await context.fileSystem.move("a.md", "renamed.md");
      context.expected.delete("a.md");
      context.expected.set("renamed.md", "base a");
    } else {
      context.fileSystem.files.delete("a.md");
      context.expected.delete("a.md");
    }
    const mutations: string[] = [];
    const lossy: SyncTransport = {
      ...context.transport,
      mutate: async (mutation) => {
        mutations.push(mutation.mutation_id);
        const receipt = await context.transport.mutate(mutation);
        if (mutations.length === 1) throw new Error("reply lost after commit");
        return receipt;
      }
    };
    const replicaId = (await context.transport.openSession()).replica_id;
    const mirror = new WritableDirectoryMirror(replicaId, lossy, context);
    expect((await mirror.sync()).status).toBe("failed");
    expect((await mirror.sync()).status).toBe("applied");
    expect(mutations).toHaveLength(2);
    expect(new Set(mutations).size).toBe(1);
    expect(context.authority.serialize().changes).toHaveLength(1);
    await assertConverged(context);
  });
});
