import { describe, expect, it } from "vitest";
import { MemoryAuthority, type SyncTransport } from "./index.js";
import { documentRevision } from "./mirror-format.js";
import {
  DirectoryMirror,
  MemoryMirrorLease,
  MemoryMirrorStateStore,
  MirrorInitializationConflictError,
  WritableDirectoryMirror,
  portableMirrorRuntime,
  recordMarkdownDocument,
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
  it("serializes empty frontmatter as body-only Markdown without changing bytes", () => {
    for (const body of ["", "# Note", "# Note\n", "---\nNot a complete frontmatter block"]) {
      expect(recordMarkdownDocument({
        record_id: "body-only",
        path: "note.md",
        revision: "revision",
        frontmatter: {},
        body,
        types: []
      })).toBe(body);
    }
  });

  it("materializes the authority's exact snapshot Markdown bytes", async () => {
    const hosted = new MemoryAuthority();
    hosted.seed([{
      record_id: "exact-record",
      path: "exact.md",
      frontmatter: { type: "note", title: "Exact" },
      body: "Exact body.\n",
      types: ["note"]
    }]);
    const replicaId = hosted.registerReplica({ name: "Exact mirror", mode: "read_only" });
    const base = hosted.transport(replicaId);
    const exactDocument = "---\ntitle: Exact\ntype: note\n---\n\nExact body.\n";
    const fileSystem = new TestFileSystem();
    const mirror = new DirectoryMirror(replicaId, {
      ...base,
      snapshot: async (snapshotId, page) => {
        const snapshot = await base.snapshot(snapshotId, page);
        return {
          ...snapshot,
          records: snapshot.records.map((record) => ({
            ...record,
            revision: documentRevision(exactDocument),
            document: exactDocument
          }))
        };
      }
    }, {
      fileSystem,
      stateStore: new MemoryMirrorStateStore(),
      runtime: deterministicRuntime()
    });

    await mirror.sync();

    expect(fileSystem.files.get("exact.md")).toBe(exactDocument);
  });

  it("materializes through injected adapters and keeps receive-only state compact", async () => {
    const hosted = new MemoryAuthority({ snapshotPageSize: 2 });
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

  it("does not persist snapshot-only document bytes in writable mirror state", async () => {
    const hosted = new MemoryAuthority();
    hosted.seed(records(1));
    const replicaId = hosted.registerReplica({ name: "Writer", mode: "read_write" });
    const stateStore = new MemoryMirrorStateStore();
    const mirror = new WritableDirectoryMirror(replicaId, hosted.transport(replicaId), {
      fileSystem: new TestFileSystem(),
      stateStore,
      runtime: deterministicRuntime()
    });

    await mirror.sync();

    const state = await stateStore.read();
    const entry = Object.values(state!.records)[0]!;
    expect(entry.record).toBeDefined();
    expect(entry.record).not.toHaveProperty("document");
  });

  it("does a complete collision preflight before writing any hosted document", async () => {
    const hosted = new MemoryAuthority({ snapshotPageSize: 1 });
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
    const hosted = new MemoryAuthority({ snapshotPageSize: 1 });
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
    const hosted = new MemoryAuthority({ snapshotPageSize: 1 });
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

  it("rejects executable and hidden record paths before materialization", async () => {
    for (const path of ["payload.bat", ".git/hooks/post-checkout.md"]) {
      const hosted = new MemoryAuthority();
      hosted.seed([{
        record_id: `hostile-${path}`,
        path,
        frontmatter: {},
        body: "malware",
        types: []
      }]);
      const replicaId = hosted.registerReplica({ name: "Guarded mirror", mode: "read_only" });
      const fileSystem = new TestFileSystem();
      const mirror = new DirectoryMirror(replicaId, hosted.transport(replicaId), {
        fileSystem,
        stateStore: new MemoryMirrorStateStore(),
        runtime: deterministicRuntime()
      });

      await expect(mirror.sync()).rejects.toMatchObject({ code: "invalid_record_path" });
      expect(fileSystem.writes).toBe(0);
      expect(fileSystem.files.has(path)).toBe(false);
    }
  });

  it("does not let authority configuration enable executable record extensions", async () => {
    const configuration =
      "spec_version: 0.3.0\nsettings:\n  record_extensions: [bat]\n";
    const hosted = new MemoryAuthority({
      resources: {
        revision: "resources:hostile-extension",
        spec_version: "0.3.0",
        types: [],
        contracts: [],
        documents: [{
          path: "mdbase.yaml",
          kind: "configuration",
          revision: documentRevision(configuration),
          document: configuration
        }]
      }
    });
    hosted.seed([{
      record_id: "hostile-extension",
      path: "payload.bat",
      frontmatter: {},
      body: "malware",
      types: []
    }]);
    const replicaId = hosted.registerReplica({ name: "Guarded mirror", mode: "read_only" });
    const fileSystem = new TestFileSystem();
    const mirror = new DirectoryMirror(replicaId, hosted.transport(replicaId), {
      fileSystem,
      stateStore: new MemoryMirrorStateStore(),
      runtime: deterministicRuntime()
    });

    await expect(mirror.sync()).rejects.toMatchObject({ code: "invalid_record_path" });
    expect(fileSystem.writes).toBe(0);
    expect(fileSystem.files.has("payload.bat")).toBe(false);
  });

  it("rejects snapshot documents that disagree with their record metadata", async () => {
    const hosted = new MemoryAuthority();
    hosted.seed([{
      record_id: "inconsistent-document",
      path: "notes/example.md",
      frontmatter: { title: "Declared" },
      body: "Declared body",
      types: []
    }]);
    const replicaId = hosted.registerReplica({ name: "Guarded mirror", mode: "read_only" });
    const base = hosted.transport(replicaId);
    const hostileDocument = "# Different\n";
    const fileSystem = new TestFileSystem();
    const mirror = new DirectoryMirror(replicaId, {
      ...base,
      snapshot: async (snapshotId, page) => {
        const snapshot = await base.snapshot(snapshotId, page);
        return {
          ...snapshot,
          records: snapshot.records.map((record) => ({
            ...record,
            revision: documentRevision(hostileDocument),
            document: hostileDocument
          }))
        };
      }
    }, {
      fileSystem,
      stateStore: new MemoryMirrorStateStore(),
      runtime: deterministicRuntime()
    });

    await expect(mirror.sync()).rejects.toMatchObject({ code: "invalid_snapshot" });
    expect(fileSystem.writes).toBe(0);
  });

  it("rejects snapshot documents that disagree with record or resource revisions", async () => {
    const configuration = "spec_version: 0.3.0\n";
    const hosted = new MemoryAuthority({
      resources: {
        revision: "resources:invalid-revision",
        spec_version: "0.3.0",
        types: [],
        contracts: [],
        documents: [{
          path: "mdbase.yaml",
          kind: "configuration",
          revision: documentRevision(configuration),
          document: configuration
        }]
      }
    });
    hosted.seed([{
      record_id: "invalid-revision",
      path: "notes/example.md",
      frontmatter: {},
      body: "Body",
      types: []
    }]);
    const replicaId = hosted.registerReplica({ name: "Guarded mirror", mode: "read_only" });
    const base = hosted.transport(replicaId);
    for (const target of ["record", "resource"] as const) {
      const fileSystem = new TestFileSystem();
      const mirror = new DirectoryMirror(replicaId, {
        ...base,
        openSession: async () => {
          const session = await base.openSession();
          return target === "resource"
            ? {
                ...session,
                resources: {
                  ...session.resources,
                  documents: session.resources.documents?.map((resource) => ({
                    ...resource,
                    revision: `sha256:${"0".repeat(64)}`
                  }))
                }
              }
            : session;
        },
        snapshot: async (snapshotId, page) => {
          const snapshot = await base.snapshot(snapshotId, page);
          return target === "record"
            ? {
                ...snapshot,
                records: snapshot.records.map((record) => ({
                  ...record,
                  revision: `sha256:${"0".repeat(64)}`
                }))
              }
            : snapshot;
        }
      }, {
        fileSystem,
        stateStore: new MemoryMirrorStateStore(),
        runtime: deterministicRuntime()
      });

      await expect(mirror.sync(), target).rejects.toMatchObject({ code: "invalid_snapshot" });
      expect(fileSystem.writes, target).toBe(0);
    }
  });

  it("rejects duplicate identities and cross-platform path aliases across snapshot pages", async () => {
    for (const target of ["identity", "path"] as const) {
      const hosted = new MemoryAuthority({ snapshotPageSize: 1 });
      hosted.seed([
        {
          record_id: "first",
          path: "Notes/Example.md",
          frontmatter: {},
          body: "First",
          types: []
        },
        {
          record_id: "second",
          path: target === "path" ? "notes/example.md" : "notes/second.md",
          frontmatter: {},
          body: "Second",
          types: []
        }
      ]);
      const replicaId = hosted.registerReplica({ name: "Guarded mirror", mode: "read_only" });
      const base = hosted.transport(replicaId);
      const fileSystem = new TestFileSystem();
      let firstRecordId: string | undefined;
      const mirror = new DirectoryMirror(replicaId, {
        ...base,
        snapshot: async (snapshotId, page) => {
          const snapshot = await base.snapshot(snapshotId, page);
          return target === "identity"
            ? {
                ...snapshot,
                records: snapshot.records.map((record) => ({
                  ...record,
                  record_id: firstRecordId ??= record.record_id
                }))
              }
            : snapshot;
        }
      }, {
        fileSystem,
        stateStore: new MemoryMirrorStateStore(),
        runtime: deterministicRuntime()
      });

      await expect(mirror.sync(), target).rejects.toMatchObject({ code: "invalid_snapshot" });
      expect(fileSystem.writes, target).toBe(0);
    }
  });

  it("rejects exact, cross-platform, and same-record spelling aliases", async () => {
    for (const { path, recordId } of [
      { path: "Notes/Example.md", recordId: "second" },
      { path: "notes/example.md", recordId: "second" },
      { path: "notes/example.md", recordId: "first" }
    ]) {
      const hosted = new MemoryAuthority();
      hosted.seed([{
        record_id: "first",
        path: "Notes/Example.md",
        frontmatter: {},
        body: "Same bytes",
        types: []
      }]);
      const replicaId = hosted.registerReplica({ name: "Guarded mirror", mode: "read_only" });
      const base = hosted.transport(replicaId);
      let emitAlias = false;
      const fileSystem = new TestFileSystem();
      const mirror = new DirectoryMirror(replicaId, {
        ...base,
        changes: async (after, limit) => emitAlias
          ? {
              protocol_version: 1,
              scope_epoch: 1,
              events: [{
                sequence: 1,
                type: "put",
                record: {
                  record_id: recordId,
                  path,
                  revision: documentRevision("Same bytes"),
                  frontmatter: {},
                  body: "Same bytes",
                  types: []
                }
              }],
              cursor: 1,
              head: 1,
              has_more: false,
              reset_required: false
            }
          : base.changes(after, limit)
      }, {
        fileSystem,
        stateStore: new MemoryMirrorStateStore(),
        runtime: deterministicRuntime()
      });
      await mirror.sync();
      emitAlias = true;

      await expect(mirror.sync(), path).rejects.toMatchObject({
        code: "invalid_record_path"
      });
      expect(fileSystem.files.get("Notes/Example.md")).toBe("Same bytes");
      expect(fileSystem.files.has("notes/example.md")).toBe(false);
    }
  });

  it("rejects a same-record spelling alias during reset rebuild", async () => {
    const hosted = new MemoryAuthority();
    hosted.seed([{
      record_id: "first",
      path: "Notes/Example.md",
      frontmatter: {},
      body: "Stable bytes",
      types: []
    }]);
    const replicaId = hosted.registerReplica({
      name: "Guarded reset mirror",
      mode: "read_only"
    });
    const writerId = hosted.registerReplica({
      name: "Reset writer",
      mode: "read_write"
    });
    const base = hosted.transport(replicaId);
    let forceReset = false;
    const fileSystem = new TestFileSystem();
    const mirror = new DirectoryMirror(replicaId, {
      ...base,
      changes: async (after, limit) => forceReset
        ? {
            protocol_version: 1,
            scope_epoch: 1,
            events: [],
            cursor: after,
            head: after + 1,
            has_more: false,
            reset_required: true
          }
        : base.changes(after, limit)
    }, {
      fileSystem,
      stateStore: new MemoryMirrorStateStore(),
      runtime: deterministicRuntime()
    });
    await mirror.sync();
    const writer = hosted.transport(writerId);
    const session = await writer.openSession();
    const current = (await writer.snapshot(session.snapshot_id)).records[0]!;
    await writer.mutate({
      mutation_id: "case-only-reset",
      replica_id: writerId,
      scope_epoch: 1,
      operation: "rename",
      record_id: "first",
      base_revision: current.revision,
      input: { path: "notes/example.md" },
      created_at: "2026-07-27T00:00:00.000Z"
    });
    forceReset = true;

    await expect(mirror.sync()).rejects.toMatchObject({
      code: "invalid_record_path"
    });
    expect(fileSystem.files.get("Notes/Example.md")).toBe("Stable bytes");
    expect(fileSystem.files.has("notes/example.md")).toBe(false);
  });

  it("preflights a complete incremental page before writing aliased records", async () => {
    const hosted = new MemoryAuthority();
    const replicaId = hosted.registerReplica({ name: "Guarded mirror", mode: "read_only" });
    const base = hosted.transport(replicaId);
    let emitAliases = false;
    const fileSystem = new TestFileSystem();
    const mirror = new DirectoryMirror(replicaId, {
      ...base,
      changes: async (after, limit) => emitAliases
        ? {
            protocol_version: 1,
            scope_epoch: 1,
            events: ["Notes/Example.md", "notes/example.md"].map((path, index) => ({
              sequence: index + 1,
              type: "put" as const,
              record: {
                record_id: `record-${index}`,
                path,
                revision: documentRevision(`Body ${index}`),
                frontmatter: {},
                body: `Body ${index}`,
                types: []
              }
            })),
            cursor: 2,
            head: 2,
            has_more: false,
            reset_required: false
          }
        : base.changes(after, limit)
    }, {
      fileSystem,
      stateStore: new MemoryMirrorStateStore(),
      runtime: deterministicRuntime()
    });
    await mirror.sync();
    const writesBeforeChanges = fileSystem.writes;
    emitAliases = true;

    await expect(mirror.sync()).rejects.toMatchObject({ code: "invalid_record_path" });
    expect(fileSystem.writes).toBe(writesBeforeChanges);
    expect(fileSystem.files.has("Notes/Example.md")).toBe(false);
    expect(fileSystem.files.has("notes/example.md")).toBe(false);
  });

  it("keeps paths reserved by conflicted and locally blocked records during page preflight", async () => {
    for (const blocker of ["conflict", "local_issue"] as const) {
      const runtime = deterministicRuntime();
      const stateStore = new MemoryMirrorStateStore();
      const fileSystem = new TestFileSystem();
      fileSystem.files.set("occupied.md", "Managed bytes");
      const state: MirrorState = {
        protocol_version: 1,
        replica_id: "reader",
        scope_epoch: 1,
        cursor: 0,
        records: {
          occupied: {
            path: "occupied.md",
            revision: documentRevision("Managed bytes"),
            hash: runtime.digest("Managed bytes")
          }
        },
        resources: {},
        mode: "read_only",
        pending: [],
        conflicts: blocker === "conflict"
          ? {
              occupied: {
                mutation_id: "blocked",
                status: "rejected",
                error: { code: "blocked", message: "Needs a decision." }
              }
            }
          : {},
        local_issues: blocker === "local_issue"
          ? {
              "occupied.md": {
                path: "occupied.md",
                code: "invalid_frontmatter",
                message: "Fix the local file.",
                hash: runtime.digest("Managed bytes")
              }
            }
          : {}
      };
      await stateStore.write(state);
      const transport: SyncTransport = {
        openSession: async () => { throw new Error("unused"); },
        snapshot: async () => { throw new Error("unused"); },
        mutate: async () => { throw new Error("unused"); },
        changes: async () => ({
          protocol_version: 1,
          scope_epoch: 1,
          events: [
            {
              sequence: 1,
              type: "put",
              record: {
                record_id: "occupied",
                path: "moved.md",
                revision: documentRevision("Remote occupied"),
                frontmatter: {},
                body: "Remote occupied",
                types: []
              }
            },
            {
              sequence: 2,
              type: "put",
              record: {
                record_id: "new-record",
                path: "occupied.md",
                revision: documentRevision("New record"),
                frontmatter: {},
                body: "New record",
                types: []
              }
            }
          ],
          cursor: 2,
          head: 2,
          has_more: false,
          reset_required: false
        })
      };
      const mirror = new DirectoryMirror("reader", transport, {
        fileSystem,
        stateStore,
        runtime
      });

      await expect(mirror.sync(), blocker).rejects.toMatchObject({
        code: "invalid_record_path"
      });
      expect(fileSystem.files, blocker).toEqual(
        new Map([["occupied.md", "Managed bytes"]])
      );
      expect((await stateStore.read())?.cursor, blocker).toBe(0);
    }
  });

  it("rejects local cross-platform aliases before writable capture uploads either file", async () => {
    const hosted = new MemoryAuthority();
    const replicaId = hosted.registerReplica({ name: "Guarded writer", mode: "read_write" });
    const fileSystem = new TestFileSystem();
    fileSystem.files.set("Notes/Example.md", "One");
    fileSystem.files.set("notes/example.md", "Two");
    const mirror = new WritableDirectoryMirror(replicaId, hosted.transport(replicaId), {
      fileSystem,
      stateStore: new MemoryMirrorStateStore(),
      runtime: deterministicRuntime()
    });

    await expect(mirror.sync()).rejects.toMatchObject({ code: "invalid_record_path" });
    expect(hosted.serialize().records).toEqual([]);
  });

  it("rejects persisted state containing physical path aliases", async () => {
    const hosted = new MemoryAuthority();
    hosted.seed([{
      record_id: "first",
      path: "Notes/Example.md",
      frontmatter: {},
      body: "One",
      types: []
    }]);
    const replicaId = hosted.registerReplica({ name: "Guarded mirror", mode: "read_only" });
    const stateStore = new MemoryMirrorStateStore();
    const mirror = new DirectoryMirror(replicaId, hosted.transport(replicaId), {
      fileSystem: new TestFileSystem(),
      stateStore,
      runtime: deterministicRuntime()
    });
    await mirror.sync();
    const state = (await stateStore.read())!;
    state.records.second = {
      ...state.records.first!,
      path: "notes/example.md"
    };
    await stateStore.write(state);

    await expect(mirror.status()).rejects.toMatchObject({ code: "invalid_mirror_state" });
  });

  it("binds hosted resource kinds to safe filesystem namespaces", async () => {
    const configuration = "spec_version: 0.3.0\n";
    const packageDocument = "{\"scripts\":{\"postinstall\":\"malware\"}}\n";
    const hosted = new MemoryAuthority({
      resources: {
        revision: "resources:hostile",
        spec_version: "0.3.0",
        types: [],
        contracts: [],
        documents: [
          {
            path: "mdbase.yaml",
            kind: "configuration",
            revision: documentRevision(configuration),
            document: configuration
          },
          {
            path: "package.json",
            kind: "schema",
            revision: documentRevision(packageDocument),
            document: packageDocument
          }
        ]
      }
    });
    const replicaId = hosted.registerReplica({ name: "Guarded resources", mode: "read_only" });
    const fileSystem = new TestFileSystem();
    const mirror = new DirectoryMirror(replicaId, hosted.transport(replicaId), {
      fileSystem,
      stateStore: new MemoryMirrorStateStore(),
      runtime: deterministicRuntime()
    });

    await expect(mirror.sync()).rejects.toMatchObject({ code: "invalid_snapshot" });
    expect(fileSystem.writes).toBe(0);
    expect(fileSystem.files.has("package.json")).toBe(false);
  });

  it("uploads an existing mobile-vault document through the writable core", async () => {
    const hosted = new MemoryAuthority();
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

  it("uses the record policy consistently in writable initialization preview and capture", async () => {
    const hosted = new MemoryAuthority();
    const replicaId = hosted.registerReplica({ name: "Mobile writer", mode: "read_write" });
    const fileSystem = new TestFileSystem();
    fileSystem.files.set("valid.md", "# Valid");
    fileSystem.files.set(".private/ignored.md", "# Ignored");
    const mirror = new WritableDirectoryMirror(replicaId, hosted.transport(replicaId), {
      fileSystem,
      stateStore: new MemoryMirrorStateStore(),
      runtime: deterministicRuntime()
    });

    await expect(mirror.previewInitialization()).resolves.toMatchObject({
      upload_documents: 1,
      local_issues: []
    });
    await mirror.sync();
    const session = await hosted.transport(replicaId).openSession();
    const snapshot = await hosted.transport(replicaId).snapshot(session.snapshot_id);
    expect(snapshot.records.map((record) => record.path)).toEqual(["valid.md"]);
  });

  it("syncs body-only, empty, and frontmatter-looking Markdown through mobile-safe adapters", async () => {
    const hosted = new MemoryAuthority();
    const replicaId = hosted.registerReplica({
      name: "Mobile writer",
      mode: "read_write"
    });
    const fileSystem = new TestFileSystem();
    fileSystem.files.set("Start Here.md", "# Start here\n");
    fileSystem.files.set("Empty.md", "");
    fileSystem.files.set("Horizontal.md", "---\nNot a complete frontmatter block");
    fileSystem.files.set("Empty frontmatter.md", "---\n---\nExplicitly empty frontmatter");
    const mirror = new WritableDirectoryMirror(replicaId, hosted.transport(replicaId), {
      fileSystem,
      stateStore: new MemoryMirrorStateStore(),
      runtime: deterministicRuntime()
    });

    await mirror.sync();
    await mirror.sync();

    let session = await hosted.transport(replicaId).openSession();
    let snapshot = await hosted.transport(replicaId).snapshot(session.snapshot_id);
    expect(session.head).toBe(4);
    expect(snapshot.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "Start Here.md",
        frontmatter: {},
        body: "# Start here\n",
        types: []
      }),
      expect.objectContaining({ path: "Empty.md", frontmatter: {}, body: "" }),
      expect.objectContaining({
        path: "Horizontal.md",
        frontmatter: {},
        body: "---\nNot a complete frontmatter block"
      }),
      expect.objectContaining({
        path: "Empty frontmatter.md",
        frontmatter: {},
        body: "Explicitly empty frontmatter"
      })
    ]));

    fileSystem.files.set("Start Here.md", "# Start here\n\nEdited on mobile.\n");
    await mirror.sync();
    session = await hosted.transport(replicaId).openSession();
    snapshot = await hosted.transport(replicaId).snapshot(session.snapshot_id);
    expect(snapshot.records.find((record) => record.path === "Start Here.md")).toMatchObject({
      frontmatter: {},
      body: "# Start here\n\nEdited on mobile.\n"
    });

    const readerId = hosted.registerReplica({ name: "Second mobile", mode: "read_only" });
    const readerFiles = new TestFileSystem();
    const reader = new DirectoryMirror(readerId, hosted.transport(readerId), {
      fileSystem: readerFiles,
      stateStore: new MemoryMirrorStateStore(),
      runtime: deterministicRuntime()
    });
    await reader.sync();
    expect(readerFiles.files.get("Start Here.md")).toBe("# Start here\n\nEdited on mobile.\n");
    expect(readerFiles.files.get("Empty.md")).toBe("");

    const renamed = fileSystem.files.get("Start Here.md")!;
    fileSystem.files.delete("Start Here.md");
    fileSystem.files.set("Welcome.md", renamed);
    await mirror.sync();
    session = await hosted.transport(replicaId).openSession();
    snapshot = await hosted.transport(replicaId).snapshot(session.snapshot_id);
    expect(snapshot.records.find((record) => record.path === "Welcome.md")).toMatchObject({
      frontmatter: {},
      body: "# Start here\n\nEdited on mobile.\n"
    });

    fileSystem.files.delete("Welcome.md");
    await mirror.sync();
    session = await hosted.transport(replicaId).openSession();
    snapshot = await hosted.transport(replicaId).snapshot(session.snapshot_id);
    expect(snapshot.records.some((record) => record.path === "Welcome.md")).toBe(false);
  });

  it("does not rewrite non-canonical source bytes while replaying its own accepted events", async () => {
    const hosted = new MemoryAuthority();
    const replicaId = hosted.registerReplica({ name: "Writer", mode: "read_write" });
    const fileSystem = new TestFileSystem();
    const source = "---\ntitle:   Locally formatted\nlist: [one, two]\n---\nBody without trailing newline";
    fileSystem.files.set("formatted.md", source);
    const mirror = new WritableDirectoryMirror(replicaId, hosted.transport(replicaId), {
      fileSystem,
      stateStore: new MemoryMirrorStateStore(),
      runtime: deterministicRuntime()
    });

    await mirror.sync();
    await mirror.sync();

    expect(fileSystem.files.get("formatted.md")).toBe(source);
    await expect(mirror.status()).resolves.toMatchObject({
      state: "up_to_date",
      pending: 0,
      local_issues: []
    });
  });

  it("applies a remote rename even when its content-derived revision is unchanged", async () => {
    const runtime = deterministicRuntime();
    const record = {
      record_id: "stable-revision",
      path: "new.md",
      revision: documentRevision("# Same content"),
      frontmatter: {},
      body: "# Same content",
      types: []
    };
    const stateStore = new MemoryMirrorStateStore();
    await stateStore.write({
      protocol_version: 1,
      replica_id: "reader",
      scope_epoch: 1,
      cursor: 0,
      records: {
        "stable-revision": {
          path: "old.md",
          revision: record.revision,
          hash: runtime.digest(record.body)
        }
      },
      resources: {},
      mode: "read_only",
      pending: [],
      conflicts: {},
      local_issues: {}
    });
    const fileSystem = new TestFileSystem();
    fileSystem.files.set("old.md", record.body);
    const transport: SyncTransport = {
      openSession: async () => { throw new Error("unused"); },
      snapshot: async () => { throw new Error("unused"); },
      mutate: async () => { throw new Error("unused"); },
      changes: async (after) => ({
        protocol_version: 1,
        scope_epoch: 1,
        events: after === 0 ? [{ type: "put", record }] : [],
        cursor: 1,
        head: 1,
        has_more: false,
        reset_required: false
      })
    };
    const mirror = new DirectoryMirror("reader", transport, {
      fileSystem,
      stateStore,
      runtime
    });

    await mirror.sync();

    expect(fileSystem.files.has("old.md")).toBe(false);
    expect(fileSystem.files.get("new.md")).toBe("# Same content");
  });

  it("uploads malformed or non-object frontmatter as opaque Markdown", async () => {
    for (const [path, document] of [
      ["broken.md", "---\nbroken: [\n---\nBody"],
      ["scalar.md", "---\nhello\n---\nBody"],
      ["null.md", "---\nnull\n---\nBody"]
    ]) {
      const hosted = new MemoryAuthority();
      const replicaId = hosted.registerReplica({ name: "Mobile writer", mode: "read_write" });
      const fileSystem = new TestFileSystem();
      fileSystem.files.set(path, document);
      fileSystem.files.set("valid.md", "# Valid body-only note");
      const mirror = new WritableDirectoryMirror(replicaId, hosted.transport(replicaId), {
        fileSystem,
        stateStore: new MemoryMirrorStateStore(),
        runtime: deterministicRuntime()
      });

      await mirror.sync();
      await expect(mirror.status()).resolves.toMatchObject({
        state: "up_to_date",
        local_issues: []
      });
      const session = await hosted.transport(replicaId).openSession();
      expect((await hosted.transport(replicaId).snapshot(session.snapshot_id)).records)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ path, frontmatter: {}, body: document }),
          expect.objectContaining({
            path: "valid.md",
            frontmatter: {},
            body: "# Valid body-only note"
          })
        ]));

      fileSystem.files.set(path, "# Fixed body-only note");
      await mirror.sync();
      await expect(mirror.status()).resolves.toMatchObject({
        state: "up_to_date",
        local_issues: []
      });
      const fixedSession = await hosted.transport(replicaId).openSession();
      expect((await hosted.transport(replicaId).snapshot(fixedSession.snapshot_id)).records)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({
            path,
            frontmatter: {},
            body: "# Fixed body-only note"
          })
        ]));
    }
  });

  it("syncs a malformed managed file and preserves normal conflict handling", async () => {
    const hosted = new MemoryAuthority();
    hosted.seed([{
      record_id: "managed",
      path: "managed.md",
      frontmatter: { title: "Original" },
      body: "Original body",
      types: []
    }]);
    const replicaId = hosted.registerReplica({ name: "Local writer", mode: "read_write" });
    const remoteId = hosted.registerReplica({ name: "Remote writer", mode: "read_write" });
    const fileSystem = new TestFileSystem();
    const mirror = new WritableDirectoryMirror(replicaId, hosted.transport(replicaId), {
      fileSystem,
      stateStore: new MemoryMirrorStateStore(),
      runtime: deterministicRuntime()
    });
    await mirror.sync();
    const seededRevision = (await hosted.transport(remoteId)
      .snapshot((await hosted.transport(remoteId).openSession()).snapshot_id))
      .records[0]!.revision;

    const malformed = "---\ntitle: [\n---\nDo not overwrite these bytes";
    fileSystem.files.set("managed.md", malformed);
    const remoteReceipt = await hosted.transport(remoteId).mutate({
      mutation_id: "remote-managed-update",
      replica_id: remoteId,
      scope_epoch: 1,
      operation: "update",
      record_id: "managed",
      base_revision: seededRevision,
      input: { patch: { title: "Remote" }, body: "Remote body" },
      created_at: "2026-07-27T00:00:00.000Z"
    });
    expect(remoteReceipt.status).toBe("applied");

    await mirror.sync();
    expect(fileSystem.files.get("managed.md")).toBe(malformed);
    await expect(mirror.status()).resolves.toMatchObject({
      state: "attention",
      conflicts: [{ record_id: "managed", kind: "conflicted" }],
      local_issues: []
    });

    fileSystem.files.set("managed.md", "# Repaired local body");
    await mirror.sync();
    await expect(mirror.status()).resolves.toMatchObject({
      state: "attention",
      conflicts: [{ record_id: "managed", kind: "conflicted" }],
      local_issues: []
    });

    await mirror.resolveConflict("managed", "local");
    await mirror.sync();
    const session = await hosted.transport(replicaId).openSession();
    const snapshot = await hosted.transport(replicaId).snapshot(session.snapshot_id);
    expect(snapshot.records.find((record) => record.record_id === "managed")).toMatchObject({
      frontmatter: {},
      body: "# Repaired local body"
    });
    await expect(mirror.status()).resolves.toMatchObject({
      state: "up_to_date",
      conflicts: [],
      local_issues: []
    });
  });

  it("checkpoints a 2,000-record no-op sync only once", async () => {
    const hosted = new MemoryAuthority({ snapshotPageSize: 100 });
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
