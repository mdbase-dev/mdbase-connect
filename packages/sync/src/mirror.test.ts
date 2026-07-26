import { describe, expect, it } from "vitest";
import { MemoryHostedAuthority } from "./index.js";
import {
  DirectoryMirror,
  MemoryMirrorLease,
  MemoryMirrorStateStore,
  MirrorInitializationConflictError,
  WritableDirectoryMirror,
  portableMirrorRuntime,
  type MirrorFileSystem,
  type MirrorRuntime,
  type MirrorState
} from "./mirror.js";

class TestFileSystem implements MirrorFileSystem {
  readonly files = new Map<string, string>();
  reads = 0;
  writes = 0;
  lists = 0;
  failAfterWrites: number | null = null;

  async read(path: string): Promise<string | null> {
    this.reads += 1;
    return this.files.get(path) ?? null;
  }

  async write(path: string, value: string): Promise<void> {
    if (this.failAfterWrites !== null && this.writes >= this.failAfterWrites) {
      throw new Error("injected adapter write failure");
    }
    this.writes += 1;
    this.files.set(path, value);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async listMarkdown(excluded: ReadonlySet<string>): Promise<string[]> {
    this.lists += 1;
    return [...this.files.keys()]
      .filter((path) => path.endsWith(".md") && !excluded.has(path))
      .sort();
  }
}

class CountingStateStore extends MemoryMirrorStateStore {
  reads = 0;
  writes = 0;

  override async read(): Promise<MirrorState | null> {
    this.reads += 1;
    return super.read();
  }

  override async write(state: MirrorState): Promise<void> {
    this.writes += 1;
    await super.write(state);
  }
}

function deterministicRuntime(): MirrorRuntime {
  let sequence = 0;
  return {
    digest: portableMirrorRuntime.digest,
    randomId: () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`,
    now: () => "2026-07-27T00:00:00.000Z"
  };
}

function records(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    record_id: `portable-${index}`,
    path: `notes/${String(index).padStart(5, "0")}.md`,
    frontmatter: { type: "note", title: `Portable ${index}` },
    body: `Body ${index}`,
    types: ["note"]
  }));
}

describe("platform-neutral directory mirror", () => {
  it("materializes through injected adapters and keeps receive-only state compact", async () => {
    const hosted = new MemoryHostedAuthority({ snapshotPageSize: 2 });
    hosted.seed(records(5));
    const replicaId = hosted.registerReplica({ name: "Mobile", mode: "read_only" });
    const fileSystem = new TestFileSystem();
    const stateStore = new CountingStateStore();
    const mirror = new DirectoryMirror(replicaId, hosted.transport(replicaId), {
      fileSystem,
      stateStore,
      lease: new MemoryMirrorLease(),
      runtime: deterministicRuntime()
    });

    await mirror.sync();

    expect(fileSystem.files).toHaveLength(5);
    expect(stateStore.writes).toBe(1);
    const state = await stateStore.read();
    expect(state).not.toBeNull();
    expect(Object.values(state!.records)).toHaveLength(5);
    for (const entry of Object.values(state!.records)) {
      expect(entry).not.toHaveProperty("record");
    }
  });

  it("does a complete collision preflight before writing any hosted document", async () => {
    const hosted = new MemoryHostedAuthority({ snapshotPageSize: 1 });
    hosted.seed(records(3));
    const replicaId = hosted.registerReplica({ name: "Mobile", mode: "read_only" });
    const fileSystem = new TestFileSystem();
    fileSystem.files.set("notes/00002.md", "unmanaged local bytes\n");
    const stateStore = new CountingStateStore();
    const mirror = new DirectoryMirror(replicaId, hosted.transport(replicaId), {
      fileSystem,
      stateStore,
      runtime: deterministicRuntime()
    });

    await expect(mirror.sync()).rejects.toEqual(
      new MirrorInitializationConflictError(["notes/00002.md"])
    );
    expect(fileSystem.writes).toBe(0);
    expect(fileSystem.files.has("notes/00000.md")).toBe(false);
    expect(await stateStore.read()).toBeNull();
  });

  it("does not advance durable state when a mobile adapter fails mid-apply", async () => {
    const hosted = new MemoryHostedAuthority({ snapshotPageSize: 1 });
    hosted.seed(records(3));
    const replicaId = hosted.registerReplica({ name: "Mobile", mode: "read_only" });
    const fileSystem = new TestFileSystem();
    fileSystem.failAfterWrites = 1;
    const stateStore = new CountingStateStore();
    const mirror = new DirectoryMirror(replicaId, hosted.transport(replicaId), {
      fileSystem,
      stateStore,
      runtime: deterministicRuntime()
    });

    await expect(mirror.sync()).rejects.toThrow("injected adapter write failure");
    expect(await stateStore.read()).toBeNull();

    fileSystem.failAfterWrites = null;
    await mirror.sync();
    expect(fileSystem.files).toHaveLength(3);
    expect((await stateStore.read())?.cursor).toBe(0);
  });

  it("rejects a snapshot boundary change before applying files", async () => {
    const hosted = new MemoryHostedAuthority({ snapshotPageSize: 1 });
    hosted.seed(records(2));
    const replicaId = hosted.registerReplica({ name: "Mobile", mode: "read_only" });
    const base = hosted.transport(replicaId);
    let pages = 0;
    const fileSystem = new TestFileSystem();
    const mirror = new DirectoryMirror(replicaId, {
      ...base,
      snapshot: async (snapshotId, page) => {
        const result = await base.snapshot(snapshotId, page);
        pages += 1;
        return pages === 2 ? { ...result, cursor: result.cursor + 1 } : result;
      }
    }, {
      fileSystem,
      stateStore: new MemoryMirrorStateStore(),
      runtime: deterministicRuntime()
    });

    await expect(mirror.sync()).rejects.toMatchObject({ code: "invalid_snapshot" });
    expect(fileSystem.writes).toBe(0);
  });

  it("uploads an existing mobile-vault document through the writable core", async () => {
    const hosted = new MemoryHostedAuthority();
    const replicaId = hosted.registerReplica({
      name: "Mobile writer",
      mode: "read_write",
      allowedTypes: ["note"]
    });
    const fileSystem = new TestFileSystem();
    fileSystem.files.set("local.md", "---\ntype: note\ntitle: Local\n---\nMobile body");
    const mirror = new WritableDirectoryMirror(replicaId, hosted.transport(replicaId), {
      fileSystem,
      stateStore: new MemoryMirrorStateStore(),
      runtime: deterministicRuntime()
    });

    await mirror.sync();

    const transport = hosted.transport(replicaId);
    const session = await transport.openSession();
    const snapshot = await transport.snapshot(session.snapshot_id);
    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.records[0]).toMatchObject({
      path: "local.md",
      frontmatter: { type: "note", title: "Local" },
      body: "Mobile body"
    });
  });

  it("checkpoints a 2,000-record no-op sync only once", async () => {
    const hosted = new MemoryHostedAuthority({ snapshotPageSize: 100 });
    hosted.seed(records(2_000));
    const replicaId = hosted.registerReplica({ name: "Large mobile vault", mode: "read_only" });
    const fileSystem = new TestFileSystem();
    const stateStore = new CountingStateStore();
    const mirror = new DirectoryMirror(replicaId, hosted.transport(replicaId), {
      fileSystem,
      stateStore,
      runtime: deterministicRuntime()
    });

    await mirror.sync();
    fileSystem.reads = 0;
    const writesBefore = stateStore.writes;
    await mirror.sync();

    expect(fileSystem.reads).toBe(2_000);
    expect(fileSystem.writes).toBe(2_000);
    expect(stateStore.writes - writesBefore).toBe(1);
  });
});
