import { mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryHostedAuthority } from "./index.js";
import {
  DirectoryMirror,
  MirrorDivergenceError,
  WritableDirectoryMirror,
  WritableMirrorConflictError
} from "./node.js";

describe("receive-only Markdown mirror", () => {
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
      const mirror = new DirectoryMirror(root, mirrorId, hosted.transport(mirrorId));
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
      const mirror = new DirectoryMirror(root, mirrorId, hosted.transport(mirrorId));
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
      const mirror = new DirectoryMirror(root, mirrorId, hosted.transport(mirrorId));
      await mirror.sync();
      await writeFile(join(root, ".mdbase/connect-sync.json"), JSON.stringify({ protocol_version: 1, replica_id: "another" }));
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
      const mirror = new DirectoryMirror(root, mirrorId, hosted.transport(mirrorId));
      await expect(mirror.sync()).rejects.toMatchObject({ code: "symlink_denied" });
      await expect(readFile(join(outside, "escape.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("never follows a symlinked mirror metadata directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdbase-sync-mirror-"));
    const outside = await mkdtemp(join(tmpdir(), "mdbase-sync-outside-"));
    try {
      const hosted = new MemoryHostedAuthority();
      const mirrorId = hosted.registerReplica({ name: "Laptop mirror", mode: "read_only" });
      await symlink(outside, join(root, ".mdbase"), "dir");
      const mirror = new DirectoryMirror(root, mirrorId, hosted.transport(mirrorId));
      await expect(mirror.sync()).rejects.toMatchObject({ code: "symlink_denied" });
      await expect(readFile(join(outside, "connect-sync.json"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("writable Markdown mirror", () => {
  it("imports existing local Markdown during initialization", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdbase-sync-writable-"));
    try {
      const hosted = new MemoryHostedAuthority();
      const replicaId = hosted.registerReplica({ name: "Writable laptop", mode: "read_write", allowedTypes: ["task"] });
      await writeFile(join(root, "existing.md"), "---\ntype: task\ntitle: Existing local note\n---\nLocal body");
      const mirror = new WritableDirectoryMirror(root, replicaId, hosted.transport(replicaId));
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

  it("uploads local updates, creates, exact renames, and deletes with stable identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdbase-sync-writable-"));
    try {
      const hosted = new MemoryHostedAuthority();
      const replicaId = hosted.registerReplica({ name: "Writable laptop", mode: "read_write", allowedTypes: ["task"] });
      const mirror = new WritableDirectoryMirror(root, replicaId, hosted.transport(replicaId));
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
      const mirror = new WritableDirectoryMirror(root, replicaId, hosted.transport(replicaId));
      await mirror.sync();
      await writeFile(join(root, "task.md"), "---\ntype: task\ntitle: Local\n---\n");
      await hosted.transport(writer).mutate({
        mutation_id: crypto.randomUUID(), replica_id: writer, scope_epoch: 1,
        operation: "update", record_id: recordId, base_revision: created.record.revision,
        input: { patch: { title: "Remote" } }, created_at: new Date().toISOString()
      });
      await expect(mirror.sync()).rejects.toBeInstanceOf(WritableMirrorConflictError);
      expect(await readFile(join(root, "task.md"), "utf8")).toContain("title: Local");
      expect(await readFile(join(root, ".mdbase", "conflicts", `${recordId}.json`), "utf8"))
        .toContain('"status": "conflicted"');
      await expect(mirror.sync()).rejects.toBeInstanceOf(WritableMirrorConflictError);
      await mirror.resolveConflict(recordId, "local");
      await mirror.sync();
      const session = await hosted.transport(replicaId).openSession();
      const current = (await hosted.transport(replicaId).snapshot(session.snapshot_id)).records[0]!;
      expect(current.frontmatter.title).toBe("Local");
      await expect(readFile(join(root, ".mdbase", "conflicts", `${recordId}.json`), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
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
      const mirror = new WritableDirectoryMirror(root, replicaId, unreliable);
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
      const mirror = new WritableDirectoryMirror(root, replicaId, hosted.transport(replicaId));
      await mirror.sync();
      await writeFile(join(root, "mdbase.yaml"), "spec_version: 0.4.0\n");
      await expect(mirror.sync()).rejects.toBeInstanceOf(MirrorDivergenceError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
