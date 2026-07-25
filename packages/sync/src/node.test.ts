import { mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryHostedAuthority } from "./index.js";
import {
  authorityManifestDigest,
  DirectoryMirror,
  MemoryMirrorStateStore,
  MirrorDivergenceError,
  WritableDirectoryMirror,
  type DirectoryMirrorOptions,
  type MirrorFileSystem
} from "./node.js";

function deviceState(): DirectoryMirrorOptions {
  return { stateStore: new MemoryMirrorStateStore() };
}

class MemoryMirrorFileSystem implements MirrorFileSystem {
  readonly files = new Map<string, string>();

  async read(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async write(path: string, value: string): Promise<void> {
    this.files.set(path, value);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async listMarkdown(excluded: ReadonlySet<string>): Promise<string[]> {
    return [...this.files.keys()]
      .filter((path) => path.endsWith(".md") && !excluded.has(path))
      .sort();
  }
}

describe("receive-only Markdown mirror", () => {
  it("runs against a filesystem-neutral adapter", async () => {
    const hosted = new MemoryHostedAuthority();
    const writer = hosted.registerReplica({ name: "Writer", mode: "read_write", allowedTypes: ["task"] });
    const mirrorId = hosted.registerReplica({ name: "Portable mirror", mode: "read_only" });
    await hosted.transport(writer).mutate({
      mutation_id: crypto.randomUUID(),
      replica_id: writer,
      scope_epoch: 1,
      operation: "create",
      record_id: crypto.randomUUID(),
      input: { path: "portable.md", frontmatter: { type: "task", title: "Portable" }, types: ["task"] },
      created_at: new Date().toISOString()
    });
    const fileSystem = new MemoryMirrorFileSystem();
    const mirror = new DirectoryMirror(".", mirrorId, hosted.transport(mirrorId), {
      fileSystem,
      stateStore: new MemoryMirrorStateStore()
    });
    await mirror.sync();
    expect(fileSystem.files.get("portable.md")).toContain("title: Portable");
  });

  it("materializes stable records, renames them, and pauses on local divergence", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdbase-sync-mirror-"));
    try {
      const hosted = new MemoryHostedAuthority({
        resources: {
          revision: "resources:1",
          spec_version: "0.3.0",
          types: [],
          contracts: [],
          documents: [{
            path: "mdbase.yaml",
            kind: "configuration",
            revision: "config:1",
            document: "spec_version: 0.3.0\n"
          }]
        }
      });
      const writer = hosted.registerReplica({ name: "Writer", mode: "read_write", allowedTypes: ["task"] });
      const mirrorId = hosted.registerReplica({ name: "Laptop mirror", mode: "read_only" });
      const recordId = crypto.randomUUID();
      const created = await hosted.transport(writer).mutate({
        mutation_id: crypto.randomUUID(), replica_id: writer, scope_epoch: 1,
        operation: "create", record_id: recordId,
        input: { path: "tasks/one.md", frontmatter: { type: "task", title: "One" }, body: "Hello", types: ["task"] },
        created_at: new Date().toISOString()
      });
      if (created.status !== "applied" || !created.record) throw new Error("create failed");
      const mirror = new DirectoryMirror(root, mirrorId, hosted.transport(mirrorId), deviceState());
      await mirror.sync();
      expect(await readFile(join(root, "mdbase.yaml"), "utf8")).toBe("spec_version: 0.3.0\n");
      expect(await readFile(join(root, "tasks/one.md"), "utf8")).toContain("title: One");
      await hosted.transport(writer).mutate({
        mutation_id: crypto.randomUUID(), replica_id: writer, scope_epoch: 1,
        operation: "rename", record_id: recordId, base_revision: created.record.revision,
        input: { path: "tasks/renamed.md" }, created_at: new Date().toISOString()
      });
      await mirror.sync();
      await expect(readFile(join(root, "tasks/one.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await writeFile(join(root, "tasks/renamed.md"), "local edit\n");
      const latest = (await hosted.transport(mirrorId).snapshot((await hosted.transport(mirrorId).openSession()).snapshot_id)).records[0];
      await hosted.transport(writer).mutate({
        mutation_id: crypto.randomUUID(), replica_id: writer, scope_epoch: 1,
        operation: "update", record_id: recordId, base_revision: latest.revision,
        input: { patch: { title: "Remote edit" } }, created_at: new Date().toISOString()
      });
      await expect(mirror.sync()).rejects.toBeInstanceOf(MirrorDivergenceError);
      expect(await readFile(join(root, "tasks/renamed.md"), "utf8")).toBe("local edit\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detects a locally deleted managed file even when the authority is unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdbase-sync-mirror-"));
    try {
      const hosted = new MemoryHostedAuthority();
      const writer = hosted.registerReplica({ name: "Writer", mode: "read_write", allowedTypes: ["task"] });
      const mirrorId = hosted.registerReplica({ name: "Laptop mirror", mode: "read_only" });
      await hosted.transport(writer).mutate({
        mutation_id: crypto.randomUUID(), replica_id: writer, scope_epoch: 1,
        operation: "create", record_id: crypto.randomUUID(),
        input: { path: "tasks/one.md", frontmatter: { type: "task", title: "One" }, types: ["task"] },
        created_at: new Date().toISOString()
      });
      const mirror = new DirectoryMirror(root, mirrorId, hosted.transport(mirrorId), deviceState());
      await mirror.sync();
      await unlink(join(root, "tasks/one.md"));
      await expect(mirror.sync()).rejects.toBeInstanceOf(MirrorDivergenceError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects corrupt or cross-replica mirror metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdbase-sync-mirror-"));
    try {
      const hosted = new MemoryHostedAuthority();
      const mirrorId = hosted.registerReplica({ name: "Laptop mirror", mode: "read_only" });
      const stateStore = new MemoryMirrorStateStore();
      const mirror = new DirectoryMirror(root, mirrorId, hosted.transport(mirrorId), { stateStore });
      await mirror.sync();
      await stateStore.write({
        protocol_version: 1,
        replica_id: "another",
        scope_epoch: 1,
        cursor: 0,
        records: {}
      });
      await expect(mirror.sync()).rejects.toMatchObject({ code: "invalid_mirror_state" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never follows a record-path symlink outside the mirror root", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdbase-sync-mirror-"));
    const outside = await mkdtemp(join(tmpdir(), "mdbase-sync-outside-"));
    try {
      const hosted = new MemoryHostedAuthority();
      const writer = hosted.registerReplica({ name: "Writer", mode: "read_write", allowedTypes: ["task"] });
      const mirrorId = hosted.registerReplica({ name: "Laptop mirror", mode: "read_only" });
      await hosted.transport(writer).mutate({
        mutation_id: crypto.randomUUID(), replica_id: writer, scope_epoch: 1,
        operation: "create", record_id: crypto.randomUUID(),
        input: { path: "linked/escape.md", frontmatter: { type: "task", title: "Escape" }, types: ["task"] },
        created_at: new Date().toISOString()
      });
      await symlink(outside, join(root, "linked"), "dir");
      const mirror = new DirectoryMirror(root, mirrorId, hosted.transport(mirrorId), deviceState());
      await expect(mirror.sync()).rejects.toMatchObject({ code: "symlink_denied" });
      await expect(readFile(join(outside, "escape.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("keeps replica state out of a symlinked collection metadata directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdbase-sync-mirror-"));
    const outside = await mkdtemp(join(tmpdir(), "mdbase-sync-outside-"));
    try {
      const hosted = new MemoryHostedAuthority();
      const mirrorId = hosted.registerReplica({ name: "Laptop mirror", mode: "read_only" });
      await symlink(outside, join(root, ".mdbase"), "dir");
      const mirror = new DirectoryMirror(root, mirrorId, hosted.transport(mirrorId), deviceState());
      await mirror.sync();
      await expect(readFile(join(outside, "connect-sync.json"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("writable Markdown mirror", () => {
  it("builds a stable content-only authority manifest", async () => {
    expect(authorityManifestDigest([
      {
        kind: "resource",
        path: "mdbase.yaml",
        document_hash: "ff".repeat(32)
      },
      {
        kind: "record",
        path: "tasks/a.md",
        document_hash: "00".repeat(32)
      }
    ])).toBe("c3a6c98f15ed143bf4b9642e32c9f4c775ca8ad4978a42a4dbd69f79f6fc5e0f");

    const hosted = new MemoryHostedAuthority({
      resources: {
        revision: "resources:1",
        spec_version: "0.3.0",
        types: [],
        contracts: [],
        documents: [{
          path: "mdbase.yaml",
          kind: "configuration",
          revision: "config:1",
          document: "spec_version: 0.3.0\n"
        }]
      }
    });
    const replicaId = hosted.registerReplica({ name: "Promotion candidate", mode: "read_write" });
    await hosted.transport(replicaId).mutate({
      mutation_id: crypto.randomUUID(),
      replica_id: replicaId,
      scope_epoch: 1,
      operation: "create",
      record_id: crypto.randomUUID(),
      input: { path: "note.md", frontmatter: { title: "Local" }, types: [] },
      created_at: new Date().toISOString()
    });
    const fileSystem = new MemoryMirrorFileSystem();
    const mirror = new WritableDirectoryMirror(
      "/virtual",
      replicaId,
      hosted.transport(replicaId),
      { stateStore: new MemoryMirrorStateStore(), fileSystem }
    );
    await mirror.sync();

    const first = await mirror.authorityPromotionManifest();
    const second = await mirror.authorityPromotionManifest();
    expect(first).toEqual(second);
    expect(first.cursor).toBe(1);
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("refuses promotion when the mirror is read-only or has unmanaged Markdown", async () => {
    const hosted = new MemoryHostedAuthority();
    const readOnlyId = hosted.registerReplica({ name: "Read only", mode: "read_only" });
    const readOnly = new DirectoryMirror(
      "/virtual",
      readOnlyId,
      hosted.transport(readOnlyId),
      { stateStore: new MemoryMirrorStateStore(), fileSystem: new MemoryMirrorFileSystem() }
    );
    await readOnly.sync();
    await expect(readOnly.authorityPromotionManifest()).rejects.toMatchObject({
      code: "promotion_requires_writable_mirror"
    });

    const writableId = hosted.registerReplica({ name: "Writable", mode: "read_write" });
    const fileSystem = new MemoryMirrorFileSystem();
    const writable = new WritableDirectoryMirror(
      "/virtual",
      writableId,
      hosted.transport(writableId),
      { stateStore: new MemoryMirrorStateStore(), fileSystem }
    );
    await writable.sync();
    fileSystem.files.set("unmanaged.md", "---\ntitle: Unmanaged\n---\n");
    await expect(writable.authorityPromotionManifest()).rejects.toMatchObject({
      code: "promotion_unmanaged_files"
    });
  });

  it("imports existing local Markdown during initialization", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdbase-sync-writable-"));
    try {
      const hosted = new MemoryHostedAuthority();
      const replicaId = hosted.registerReplica({ name: "Writable laptop", mode: "read_write", allowedTypes: ["task"] });
      await writeFile(join(root, "existing.md"), "---\ntype: task\ntitle: Existing local note\n---\nLocal body");
      const mirror = new WritableDirectoryMirror(root, replicaId, hosted.transport(replicaId), deviceState());
      await mirror.sync();
      const session = await hosted.transport(replicaId).openSession();
      expect((await hosted.transport(replicaId).snapshot(session.snapshot_id)).records).toEqual([
        expect.objectContaining({
          path: "existing.md",
          frontmatter: { type: "task", title: "Existing local note" },
          body: "Local body"
        })
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("previews initial folder collisions before writing any hosted files", async () => {
    const hosted = new MemoryHostedAuthority();
    const writer = hosted.registerReplica({ name: "Writer", mode: "read_write", allowedTypes: ["task"] });
    const replicaId = hosted.registerReplica({ name: "Writable laptop", mode: "read_write", allowedTypes: ["task"] });
    for (const path of ["a.md", "b.md"]) {
      await hosted.transport(writer).mutate({
        mutation_id: crypto.randomUUID(),
        replica_id: writer,
        scope_epoch: 1,
        operation: "create",
        record_id: crypto.randomUUID(),
        input: { path, frontmatter: { type: "task", title: path }, types: ["task"] },
        created_at: new Date().toISOString()
      });
    }
    const fileSystem = new MemoryMirrorFileSystem();
    fileSystem.files.set("b.md", "---\ntype: task\ntitle: Different\n---\n");
    const mirror = new WritableDirectoryMirror(".", replicaId, hosted.transport(replicaId), {
      fileSystem,
      stateStore: new MemoryMirrorStateStore()
    });
    await expect(mirror.previewInitialization()).resolves.toMatchObject({
      download_documents: 1,
      collisions: ["b.md"]
    });
    await expect(mirror.sync()).rejects.toMatchObject({
      code: "mirror_initialization_conflict",
      paths: ["b.md"]
    });
    expect(fileSystem.files.has("a.md")).toBe(false);
    expect(fileSystem.files.get("b.md")).toContain("title: Different");
  });

  it("uploads local updates, creates, exact renames, and deletes with stable identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdbase-sync-writable-"));
    try {
      const hosted = new MemoryHostedAuthority();
      const replicaId = hosted.registerReplica({ name: "Writable laptop", mode: "read_write", allowedTypes: ["task"] });
      const mirror = new WritableDirectoryMirror(root, replicaId, hosted.transport(replicaId), deviceState());
      await mirror.sync();
      await writeFile(join(root, "first.md"), "---\ntype: task\ntitle: First\n---\nLocal body");
      await mirror.sync();
      let session = await hosted.transport(replicaId).openSession();
      let records = (await hosted.transport(replicaId).snapshot(session.snapshot_id)).records;
      expect(records).toHaveLength(1);
      const recordId = records[0]!.record_id;
      await writeFile(join(root, "first.md"), "---\ntype: task\ntitle: Updated\n---\nChanged body");
      await mirror.sync();
      session = await hosted.transport(replicaId).openSession();
      records = (await hosted.transport(replicaId).snapshot(session.snapshot_id)).records;
      expect(records[0]).toMatchObject({
        record_id: recordId,
        frontmatter: { type: "task", title: "Updated" },
        body: "Changed body"
      });
      await rename(join(root, "first.md"), join(root, "renamed.md"));
      await mirror.sync();
      session = await hosted.transport(replicaId).openSession();
      records = (await hosted.transport(replicaId).snapshot(session.snapshot_id)).records;
      expect(records[0]).toMatchObject({ record_id: recordId, path: "renamed.md" });
      await unlink(join(root, "renamed.md"));
      await mirror.sync();
      session = await hosted.transport(replicaId).openSession();
      expect((await hosted.transport(replicaId).snapshot(session.snapshot_id)).records).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves local content on conflict and supports explicit local resolution", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdbase-sync-writable-"));
    try {
      const hosted = new MemoryHostedAuthority();
      const writer = hosted.registerReplica({ name: "Remote writer", mode: "read_write", allowedTypes: ["task"] });
      const replicaId = hosted.registerReplica({ name: "Writable laptop", mode: "read_write", allowedTypes: ["task"] });
      const recordId = crypto.randomUUID();
      const created = await hosted.transport(writer).mutate({
        mutation_id: crypto.randomUUID(), replica_id: writer, scope_epoch: 1,
        operation: "create", record_id: recordId,
        input: { path: "task.md", frontmatter: { type: "task", title: "Base" }, types: ["task"] },
        created_at: new Date().toISOString()
      });
      if (created.status !== "applied" || !created.record) throw new Error("create failed");
      const mirror = new WritableDirectoryMirror(root, replicaId, hosted.transport(replicaId), deviceState());
      await mirror.sync();
      await writeFile(join(root, "task.md"), "---\ntype: task\ntitle: Local\n---\n");
      await hosted.transport(writer).mutate({
        mutation_id: crypto.randomUUID(), replica_id: writer, scope_epoch: 1,
        operation: "update", record_id: recordId, base_revision: created.record.revision,
        input: { patch: { title: "Remote" } }, created_at: new Date().toISOString()
      });
      await mirror.sync();
      expect(await readFile(join(root, "task.md"), "utf8")).toContain("title: Local");
      expect(await mirror.status()).toMatchObject({
        state: "attention",
        conflicts: [{ record_id: recordId, path: "task.md", kind: "conflicted" }]
      });
      await mirror.sync();
      await mirror.resolveConflict(recordId, "local");
      await mirror.sync();
      const session = await hosted.transport(replicaId).openSession();
      const current = (await hosted.transport(replicaId).snapshot(session.snapshot_id)).records[0]!;
      expect(current.frontmatter.title).toBe("Local");
      expect(await mirror.status()).toMatchObject({ state: "up_to_date", conflicts: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("continues synchronizing unrelated notes while one note needs conflict resolution", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdbase-sync-writable-"));
    try {
      const hosted = new MemoryHostedAuthority();
      const writer = hosted.registerReplica({
        name: "Remote writer",
        mode: "read_write",
        allowedTypes: ["task"]
      });
      const replicaId = hosted.registerReplica({
        name: "Writable laptop",
        mode: "read_write",
        allowedTypes: ["task"]
      });
      const firstId = crypto.randomUUID();
      const secondId = crypto.randomUUID();
      const first = await hosted.transport(writer).mutate({
        mutation_id: crypto.randomUUID(),
        replica_id: writer,
        scope_epoch: 1,
        operation: "create",
        record_id: firstId,
        input: { path: "a.md", frontmatter: { type: "task", title: "A" }, types: ["task"] },
        created_at: new Date().toISOString()
      });
      await hosted.transport(writer).mutate({
        mutation_id: crypto.randomUUID(),
        replica_id: writer,
        scope_epoch: 1,
        operation: "create",
        record_id: secondId,
        input: { path: "b.md", frontmatter: { type: "task", title: "B" }, types: ["task"] },
        created_at: new Date().toISOString()
      });
      if (first.status !== "applied" || !first.record) throw new Error("create failed");
      const mirror = new WritableDirectoryMirror(
        root,
        replicaId,
        hosted.transport(replicaId),
        deviceState()
      );
      await mirror.sync();
      await writeFile(join(root, "a.md"), "---\ntype: task\ntitle: Local A\n---\n");
      await writeFile(join(root, "b.md"), "---\ntype: task\ntitle: Local B\n---\n");
      await hosted.transport(writer).mutate({
        mutation_id: crypto.randomUUID(),
        replica_id: writer,
        scope_epoch: 1,
        operation: "update",
        record_id: firstId,
        base_revision: first.record.revision,
        input: { patch: { title: "Remote A" } },
        created_at: new Date().toISOString()
      });

      await mirror.sync();
      expect(await mirror.status()).toMatchObject({
        state: "attention",
        pending: 1,
        conflicts: [{ record_id: firstId, path: "a.md" }]
      });
      const session = await hosted.transport(replicaId).openSession();
      const records = await hosted.transport(replicaId).snapshot(session.snapshot_id);
      expect(records.records.find((record) => record.record_id === secondId)?.frontmatter.title)
        .toBe("Local B");
      expect(await readFile(join(root, "a.md"), "utf8")).toContain("title: Local A");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rebases a local rename and edit together after a concurrent remote edit", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdbase-sync-writable-"));
    try {
      const hosted = new MemoryHostedAuthority();
      const writer = hosted.registerReplica({
        name: "Remote writer",
        mode: "read_write",
        allowedTypes: ["task"]
      });
      const replicaId = hosted.registerReplica({
        name: "Writable laptop",
        mode: "read_write",
        allowedTypes: ["task"]
      });
      const recordId = crypto.randomUUID();
      const created = await hosted.transport(writer).mutate({
        mutation_id: crypto.randomUUID(),
        replica_id: writer,
        scope_epoch: 1,
        operation: "create",
        record_id: recordId,
        input: { path: "before.md", frontmatter: { type: "task", title: "Base" }, types: ["task"] },
        created_at: new Date().toISOString()
      });
      if (created.status !== "applied" || !created.record) throw new Error("create failed");
      const mirror = new WritableDirectoryMirror(
        root,
        replicaId,
        hosted.transport(replicaId),
        deviceState()
      );
      await mirror.sync();
      await rename(join(root, "before.md"), join(root, "local.md"));
      await hosted.transport(writer).mutate({
        mutation_id: crypto.randomUUID(),
        replica_id: writer,
        scope_epoch: 1,
        operation: "update",
        record_id: recordId,
        base_revision: created.record.revision,
        input: { patch: { title: "Remote" } },
        created_at: new Date().toISOString()
      });

      await mirror.sync();
      await writeFile(join(root, "local.md"), "---\ntype: task\ntitle: Local\n---\n");
      await mirror.resolveConflict(recordId, "local");
      await mirror.sync();
      const session = await hosted.transport(replicaId).openSession();
      const current = (await hosted.transport(replicaId).snapshot(session.snapshot_id)).records[0]!;
      expect(current).toMatchObject({
        record_id: recordId,
        path: "local.md",
        frontmatter: { type: "task", title: "Local" }
      });
      await expect(readFile(join(root, "before.md"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(root, "local.md"), "utf8")).toContain("title: Local");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("can discard a rejected local change and restore the hosted record", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdbase-sync-writable-"));
    try {
      const hosted = new MemoryHostedAuthority();
      const replicaId = hosted.registerReplica({
        name: "Writable laptop",
        mode: "read_write",
        allowedTypes: ["task"]
      });
      const recordId = crypto.randomUUID();
      await hosted.transport(replicaId).mutate({
        mutation_id: crypto.randomUUID(),
        replica_id: replicaId,
        scope_epoch: 1,
        operation: "create",
        record_id: recordId,
        input: { path: "task.md", frontmatter: { type: "task", title: "Task" }, types: ["task"] },
        created_at: new Date().toISOString()
      });
      const upstream = hosted.transport(replicaId);
      const rejecting = {
        openSession: () => upstream.openSession(),
        snapshot: (snapshotId: string, page?: string) => upstream.snapshot(snapshotId, page),
        changes: (after: number, limit?: number) => upstream.changes(after, limit),
        mutate: async (mutation: Parameters<typeof upstream.mutate>[0]) => (
          mutation.operation === "update"
            ? {
                mutation_id: mutation.mutation_id,
                status: "rejected" as const,
                error: { code: "scope_denied", message: "Record is outside this mirror's scope." }
              }
            : upstream.mutate(mutation)
        )
      };
      const mirror = new WritableDirectoryMirror(root, replicaId, rejecting, deviceState());
      await mirror.sync();
      await writeFile(join(root, "task.md"), "---\ntype: note\ntitle: Outside scope\n---\n");
      await mirror.sync();
      expect(await mirror.status()).toMatchObject({
        state: "attention",
        pending: 1,
        conflicts: [{ record_id: recordId, kind: "rejected" }]
      });
      await mirror.resolveConflict(recordId, "remote");
      expect(await readFile(join(root, "task.md"), "utf8")).toContain("type: task");
      expect(await mirror.status()).toMatchObject({
        state: "up_to_date",
        pending: 0,
        conflicts: []
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("replays a journaled mutation after the server commits but the response is lost", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdbase-sync-writable-"));
    try {
      const hosted = new MemoryHostedAuthority();
      const replicaId = hosted.registerReplica({ name: "Writable laptop", mode: "read_write", allowedTypes: ["task"] });
      const upstream = hosted.transport(replicaId);
      let loseResponse = true;
      const unreliable = {
        openSession: () => upstream.openSession(),
        snapshot: (snapshotId: string, page?: string) => upstream.snapshot(snapshotId, page),
        changes: (after: number, limit?: number) => upstream.changes(after, limit),
        async mutate(mutation: Parameters<typeof upstream.mutate>[0]) {
          const receipt = await upstream.mutate(mutation);
          if (loseResponse) {
            loseResponse = false;
            throw new Error("connection reset after commit");
          }
          return receipt;
        }
      };
      const mirror = new WritableDirectoryMirror(root, replicaId, unreliable, deviceState());
      await mirror.sync();
      await writeFile(join(root, "task.md"), "---\ntype: task\ntitle: Durable\n---\n");
      await expect(mirror.sync()).rejects.toThrow("connection reset after commit");
      await mirror.sync();
      const session = await upstream.openSession();
      expect(session.head).toBe(1);
      expect((await upstream.snapshot(session.snapshot_id)).records).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never treats schema resources as writable record changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdbase-sync-writable-"));
    try {
      const hosted = new MemoryHostedAuthority({
        resources: {
          revision: "resources:1",
          spec_version: "0.3.0",
          types: [],
          contracts: [],
          documents: [{
            path: "mdbase.yaml",
            kind: "configuration",
            revision: "config:1",
            document: "spec_version: 0.3.0\n"
          }]
        }
      });
      const replicaId = hosted.registerReplica({ name: "Writable laptop", mode: "read_write" });
      const mirror = new WritableDirectoryMirror(root, replicaId, hosted.transport(replicaId), deviceState());
      await mirror.sync();
      await writeFile(join(root, "mdbase.yaml"), "spec_version: 0.4.0\n");
      await expect(mirror.sync()).rejects.toBeInstanceOf(MirrorDivergenceError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
