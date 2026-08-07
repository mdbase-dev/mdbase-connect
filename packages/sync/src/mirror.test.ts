import { describe, expect, it } from "vitest";
import { MemoryAuthority, type SyncTransport } from "./index.js";
import { documentRevision } from "./mirror-format.js";
import {
  DirectoryMirror,
  MemoryMirrorLease,
  MemoryMirrorStateStore,
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

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

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

  async move(source: string, target: string): Promise<void> {
    const value = this.files.get(source);
    if (value === undefined) throw new Error(`missing move source: ${source}`);
    this.files.set(target, value);
    this.files.delete(source);
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
  return Array.from({ length: count }, (_, index) => {
    const body = `Body ${index}`;
    const document = `---\ntype: note\ntitle: Portable ${index}\n---\n\n${body}`;
    return {
      record_id: `portable-${index}`,
      path: `notes/${String(index).padStart(5, "0")}.md`,
      document,
      frontmatter: { type: "note", title: `Portable ${index}` },
      body,
      types: ["note"]
    };
  });
}

describe("platform-neutral directory mirror", () => {
  it("serializes empty frontmatter as body-only Markdown without changing bytes", () => {
    for (const body of ["", "# Note", "# Note\n", "---\nNot a complete frontmatter block"]) {
      expect(recordMarkdownDocument({
        record_id: "body-only",
        path: "note.md",
        document: body,
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

  it("inspects without side effects and rejects a stale reviewed plan", async () => {
    const hosted = new MemoryAuthority();
    hosted.seed(records(1));
    const replicaId = hosted.registerReplica({ name: "Reviewed mirror", mode: "read_only" });
    const fileSystem = new TestFileSystem();
    const stateStore = new MemoryMirrorStateStore();
    const mirror = new DirectoryMirror(replicaId, hosted.transport(replicaId), {
      fileSystem,
      stateStore,
      runtime: deterministicRuntime()
    });

    const plan = await mirror.inspect();
    expect(plan).toMatchObject({
      kind: "initial",
      summary: { uploads: 0, downloads: 1, conflicts: 0, blocking_issues: 0 },
      actions: [{
        command: "write_local",
        target: { entity: "record", path: "notes/00000.md" }
      }, { command: "advance_checkpoint" }]
    });
    expect(fileSystem.writes).toBe(0);
    expect(await stateStore.read()).toBeNull();

    await expect(mirror.apply(plan)).resolves.toMatchObject({ status: "applied" });
    const current = await mirror.inspect();
    fileSystem.files.set("notes/00000.md", "changed outside the plan");
    await expect(mirror.apply(current)).resolves.toMatchObject({
      status: "stale",
      failure: { code: "sync_plan_stale" }
    });
    expect(fileSystem.files.get("notes/00000.md")).toBe("changed outside the plan");
  });

  it("plans a byte-preserving local move as one identity-preserving move", async () => {
    const hosted = new MemoryAuthority();
    hosted.seed(records(1));
    const replicaId = hosted.registerReplica({ name: "Move planner", mode: "read_write" });
    const fileSystem = new TestFileSystem();
    const mirror = new WritableDirectoryMirror(replicaId, hosted.transport(replicaId), {
      fileSystem,
      stateStore: new MemoryMirrorStateStore(),
      runtime: deterministicRuntime()
    });
    await mirror.sync();
    const document = fileSystem.files.get("notes/00000.md")!;
    fileSystem.files.delete("notes/00000.md");
    fileSystem.files.set("archive/moved.md", document);

    const plan = await mirror.inspect();
    expect(plan.actions).toEqual([
      expect.objectContaining({
        command: "move_remote",
        source: expect.objectContaining({ entity: "record", path: "notes/00000.md" }),
        target_path: "archive/moved.md"
      }),
      expect.objectContaining({ command: "advance_checkpoint" })
    ]);
    await mirror.apply(plan);
    const session = await hosted.transport(replicaId).openSession();
    const snapshot = await hosted.transport(replicaId).snapshot(session.snapshot_id);
    expect(snapshot.records[0]).toMatchObject({
      record_id: "portable-0",
      path: "archive/moved.md",
      document
    });
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
    expect(stateStore.writes).toBe(2);
    const state = await stateStore.read();
    expect(state).not.toBeNull();
    expect(Object.values(state!.records)).toHaveLength(5);
    for (const entry of Object.values(state!.records)) {
      expect(entry).not.toHaveProperty("record");
    }
  });

  it("persists the exact authority document in writable mirror state", async () => {
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
    expect(entry.record?.document).toBe(records(1)[0]!.document);
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

    await expect(mirror.sync()).resolves.toMatchObject({
      status: "attention",
      issues: [{ code: "local_collision", path: "notes/00002.md", blocking: true }]
    });
    expect(fileSystem.writes).toBe(0);
    expect(fileSystem.files.has("notes/00000.md")).toBe(false);
    expect(await stateStore.read()).toBeNull();
  });

  it("persists writable initialization conflicts while applying independent downloads", async () => {
    const hosted = new MemoryAuthority();
    hosted.seed(records(2));
    const replicaId = hosted.registerReplica({ name: "Conflicted writer", mode: "read_write" });
    const fileSystem = new TestFileSystem();
    fileSystem.files.set("notes/00000.md", "important local bytes\n");
    const stateStore = new MemoryMirrorStateStore();
    const mirror = new WritableDirectoryMirror(replicaId, hosted.transport(replicaId), {
      fileSystem,
      stateStore,
      runtime: deterministicRuntime()
    });

    const plan = await mirror.inspect();
    expect(plan).toMatchObject({
      kind: "initial",
      summary: { downloads: 1, conflicts: 1, blocking_issues: 0 },
      issues: [{ code: "local_collision", path: "notes/00000.md", blocking: false }]
    });
    expect(plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: "record_conflict", identity: "portable-0" }),
        expect.objectContaining({
          command: "write_local",
          target: expect.objectContaining({ path: "notes/00001.md" })
        })
      ])
    );

    await expect(mirror.apply(plan)).resolves.toMatchObject({
      status: "attention",
      conflicts: 1
    });
    expect(fileSystem.files.get("notes/00000.md")).toBe("important local bytes\n");
    expect(fileSystem.files.get("notes/00001.md")).toBe(records(2)[1]!.document);
    expect((await stateStore.read())?.planned_conflicts).toHaveProperty("portable-0");

    await mirror.resolveConflict(
      "portable-0",
      (await mirror.status()).conflicts[0]!.decision_id,
      "remote"
    );
    expect(fileSystem.files.get("notes/00000.md")).toBe(records(2)[0]!.document);
    expect((await stateStore.read())?.planned_conflicts).toEqual({});
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

    await expect(mirror.sync()).resolves.toMatchObject({
      status: "failed",
      failure: { code: "sync_action_failed", message: "injected adapter write failure" }
    });
    expect(await stateStore.read()).toMatchObject({ cursor: 0, batch: { phase: "blocked" } });

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

      await expect(mirror.sync(), path).resolves.toMatchObject({
        status: "attention",
        issues: [{
          code: path === "Notes/Example.md" && recordId === "second"
            ? "local_collision"
            : "invalid_record_path",
          blocking: true
        }]
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
      operation: "move",
      record_id: "first",
      base_revision: current.revision,
      path: "notes/example.md",
      created_at: "2026-07-27T00:00:00.000Z"
    });
    forceReset = true;

    await expect(mirror.sync()).resolves.toMatchObject({
      status: "attention",
      issues: [{ code: "invalid_record_path", blocking: true }]
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

    await expect(mirror.sync()).resolves.toMatchObject({
      status: "attention",
      issues: [{ code: "invalid_record_path", blocking: true }]
    });
    expect(fileSystem.writes).toBe(writesBeforeChanges);
    expect(fileSystem.files.has("Notes/Example.md")).toBe(false);
    expect(fileSystem.files.has("notes/example.md")).toBe(false);
  });

  it("keeps paths reserved by conflicted and locally blocked records during page preflight", async () => {
    for (const blocker of ["conflict", "local_issue"] as const) {
      const runtime = deterministicRuntime();
      const stateStore = new MemoryMirrorStateStore();
      const fileSystem = new TestFileSystem();
      const localDocument = blocker === "local_issue" ? "---\ninvalid: [" : "Managed bytes";
      fileSystem.files.set("occupied.md", localDocument);
      const state: MirrorState = {
        protocol_version: 1,
        engine_version: 3,
        generation: 0,
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
        planned_conflicts: blocker === "conflict"
          ? {
              occupied: {
                entity: "record",
                local: {
                  state: "exact",
                  object: {
                    entity: "record",
                    identity: "occupied",
                    path: "occupied.md",
                    revision: documentRevision("Managed bytes"),
                    payload_revision: documentRevision("Managed bytes")
                  }
                },
                remote: { state: "absent" },
                conflict_kind: "rejected"
              }
            }
          : {}
      };
      await stateStore.write(state);
      const transport: SyncTransport = {
        openSession: async () => { throw new Error("unused"); },
        snapshot: async () => { throw new Error("unused"); },
        fileSnapshot: async () => { throw new Error("unused"); },
        downloadFile: async function* () { throw new Error("unused"); },
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

      const result = await mirror.sync();
      expect(result.status, blocker).toBe("attention");
      expect(result.issues, blocker).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "local_collision", blocking: true })
      ]));
      expect(fileSystem.files, blocker).toEqual(
        new Map([["occupied.md", localDocument]])
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

    await expect(mirror.sync()).resolves.toMatchObject({
      status: "attention",
      issues: [{ code: "invalid_record_path", blocking: true }]
    });
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
      document: "# Same content",
      revision: documentRevision("# Same content"),
      frontmatter: {},
      body: "# Same content",
      types: []
    };
    const stateStore = new MemoryMirrorStateStore();
    await stateStore.write({
      protocol_version: 1,
      engine_version: 3,
      generation: 0,
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
      mode: "read_only"
    });
    const fileSystem = new TestFileSystem();
    fileSystem.files.set("old.md", record.body);
    const transport: SyncTransport = {
      openSession: async () => { throw new Error("unused"); },
      snapshot: async () => { throw new Error("unused"); },
      fileSnapshot: async () => { throw new Error("unused"); },
      downloadFile: async function* () { throw new Error("unused"); },
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
      ["null.md", "---\nnull\n---\nBody"],
      ["list.md", "---\n- one\n- two\n---\nBody"],
      ["complex-key.md", "---\n? { parentNote: value }\n: nested\n---\nBody"],
      ["non-finite.md", "---\nvalue: .inf\n---\nBody"]
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
      operation: "put",
      record_id: "managed",
      base_revision: seededRevision,
      path: "managed.md",
      document: "---\ntitle: Remote\n---\n\nRemote body",
      created_at: "2026-07-27T00:00:00.000Z"
    });
    expect(remoteReceipt.status).toBe("applied");

    await mirror.sync();
    expect(fileSystem.files.get("managed.md")).toBe(malformed);
    await expect(mirror.status()).resolves.toMatchObject({
      state: "attention",
      conflicts: [{ entity: "record", object_id: "managed", kind: "conflicted" }],
      local_issues: []
    });

    fileSystem.files.set("managed.md", "# Repaired local body");
    await mirror.sync();
    await expect(mirror.status()).resolves.toMatchObject({
      state: "attention",
      conflicts: [{ entity: "record", object_id: "managed", kind: "conflicted" }],
      local_issues: []
    });

    await mirror.resolveConflict(
      "managed",
      (await mirror.status()).conflicts[0]!.decision_id,
      "local"
    );
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

  it("makes a 2,000-record no-op sync a zero-write operation", async () => {
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
    const stateBefore = await stateStore.read();
    const planBefore = await mirror.inspect();
    await mirror.sync();
    const stateAfter = await stateStore.read();
    const planAfter = await mirror.inspect();

    expect(fileSystem.reads).toBe(6_000);
    expect(fileSystem.writes).toBe(2_000);
    expect(stateStore.writes - writesBefore).toBe(0);
    expect(stateAfter).toEqual(stateBefore);
    expect(planBefore.actions).toEqual([]);
    expect(planAfter.fingerprint).toBe(planBefore.fingerprint);
  });
});
