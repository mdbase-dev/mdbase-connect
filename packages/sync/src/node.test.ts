import { createHash } from "node:crypto";
import { mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { JsonObject, SyncMutation } from "@mdbase-dev/connect-protocol";
import { MemoryAuthority } from "./index.js";
import { documentRevision, projectionMarkdownDocument } from "./mirror-format.js";
import {
  authorityFileHash,
  authorityManifestDigest,
  DirectoryMirror,
  MemoryMirrorBlobStore,
  MemoryMirrorLease,
  MemoryMirrorStateStore,
  WritableDirectoryMirror,
  type DirectoryMirrorOptions,
  type MirrorFileSystem,
  type MirrorProgress
} from "./node.js";

function deviceState(): DirectoryMirrorOptions {
  return {
    stateStore: new MemoryMirrorStateStore(),
    lease: new MemoryMirrorLease()
  };
}

function putMutation(input: {
  replicaId: string;
  recordId: string;
  path: string;
  frontmatter?: JsonObject;
  body?: string;
  baseRevision?: string;
}): SyncMutation {
  const frontmatter = input.frontmatter ?? {};
  const body = input.body ?? "";
  return {
    mutation_id: crypto.randomUUID(), replica_id: input.replicaId, scope_epoch: 1,
    operation: "put", record_id: input.recordId,
    ...(input.baseRevision ? { base_revision: input.baseRevision } : {}),
    path: input.path,
    document: projectionMarkdownDocument({ frontmatter, body }),
    created_at: new Date().toISOString()
  };
}

const fullFileSync = {
  file_classes: ["image", "audio", "video", "pdf", "other"] as const,
  excluded_folders: [] as string[]
};

class MemoryMirrorFileSystem implements MirrorFileSystem {
  readonly files = new Map<string, string>();

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async read(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async write(path: string, value: string): Promise<void> {
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
    return [...this.files.keys()]
      .filter((path) => path.endsWith(".md") && !excluded.has(path))
      .sort();
  }

  async listBinary(excluded: ReadonlySet<string>): Promise<string[]> {
    return [...this.files.keys()]
      .filter((path) => !path.endsWith(".md") && !excluded.has(path))
      .sort();
  }

  async inspectBinary(path: string) {
    const value = this.files.get(path);
    if (value === undefined) return null;
    const bytes = new TextEncoder().encode(value);
    return {
      size: bytes.byteLength,
      content_digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const
    };
  }

  async readBinary(path: string): Promise<AsyncIterable<Uint8Array> | null> {
    const value = this.files.get(path);
    if (value === undefined) return null;
    return (async function* () { yield new TextEncoder().encode(value); })();
  }

  async writeBinary(path: string, source: AsyncIterable<Uint8Array>): Promise<void> {
    const chunks: number[] = [];
    for await (const chunk of source) chunks.push(...chunk);
    this.files.set(path, new TextDecoder().decode(new Uint8Array(chunks)));
  }
}

class CountingMirrorStateStore extends MemoryMirrorStateStore {
  writes = 0;

  override async write(state: Parameters<MemoryMirrorStateStore["write"]>[0]): Promise<void> {
    this.writes += 1;
    await super.write(state);
  }
}

describe("receive-only Markdown mirror", () => {
  it("runs against a filesystem-neutral adapter", async () => {
    const hosted = new MemoryAuthority();
    const writer = hosted.registerReplica({ name: "Writer", mode: "read_write", allowedTypes: ["task"] });
    const mirrorId = hosted.registerReplica({ name: "Portable mirror", mode: "read_only" });
    await hosted.transport(writer).mutate(putMutation({
      replicaId: writer, recordId: crypto.randomUUID(), path: "portable.md",
      frontmatter: { type: "task", title: "Portable" }
    }));
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
      const hosted = new MemoryAuthority({
        resources: {
          revision: "resources:1",
          spec_version: "0.3.0",
          types: [],
          contracts: [],
          documents: [{
            path: "mdbase.yaml",
            kind: "configuration",
            revision: documentRevision("spec_version: 0.3.0\n"),
            document: "spec_version: 0.3.0\n"
          }, {
            path: "mdbase.lock.yaml",
            kind: "lock",
            revision: documentRevision("kind: mdbase.type-pack-lock\nlock_version: 1\npacks: []\n"),
            document: "kind: mdbase.type-pack-lock\nlock_version: 1\npacks: []\n"
          }]
        }
      });
      const writer = hosted.registerReplica({ name: "Writer", mode: "read_write", allowedTypes: ["task"] });
      const mirrorId = hosted.registerReplica({ name: "Laptop mirror", mode: "read_only" });
      const recordId = crypto.randomUUID();
      const created = await hosted.transport(writer).mutate(putMutation({
        replicaId: writer, recordId, path: "tasks/one.md",
        frontmatter: { type: "task", title: "One" }, body: "Hello"
      }));
      if (created.status !== "applied" || !created.record) throw new Error("create failed");
      const mirror = new DirectoryMirror(root, mirrorId, hosted.transport(mirrorId), deviceState());
      await mirror.sync();
      expect(await readFile(join(root, "mdbase.yaml"), "utf8")).toBe("spec_version: 0.3.0\n");
      expect(await readFile(join(root, "mdbase.lock.yaml"), "utf8"))
        .toContain("kind: mdbase.type-pack-lock");
      expect(await readFile(join(root, "tasks/one.md"), "utf8")).toContain("title: One");
      await hosted.transport(writer).mutate({
        mutation_id: crypto.randomUUID(), replica_id: writer, scope_epoch: 1,
        operation: "move", record_id: recordId, base_revision: created.record.revision,
        path: "tasks/renamed.md", created_at: new Date().toISOString()
      });
      await mirror.sync();
      await expect(readFile(join(root, "tasks/one.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await writeFile(join(root, "tasks/renamed.md"), "local edit\n");
      const latest = (await hosted.transport(mirrorId).snapshot((await hosted.transport(mirrorId).openSession()).snapshot_id)).records[0];
      await hosted.transport(writer).mutate(putMutation({
        replicaId: writer, recordId, path: latest.path, baseRevision: latest.revision,
        frontmatter: { ...latest.frontmatter, title: "Remote edit" }, body: latest.body
      }));
      await expect(mirror.sync()).resolves.toMatchObject({
        status: "attention",
        issues: [{ code: "mirror_diverged", path: "tasks/renamed.md", blocking: true }]
      });
      expect(await readFile(join(root, "tasks/renamed.md"), "utf8")).toBe("local edit\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detects a locally deleted managed file even when the authority is unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdbase-sync-mirror-"));
    try {
      const hosted = new MemoryAuthority();
      const writer = hosted.registerReplica({ name: "Writer", mode: "read_write", allowedTypes: ["task"] });
      const mirrorId = hosted.registerReplica({ name: "Laptop mirror", mode: "read_only" });
      await hosted.transport(writer).mutate(putMutation({
        replicaId: writer, recordId: crypto.randomUUID(), path: "tasks/one.md",
        frontmatter: { type: "task", title: "One" }
      }));
      const mirror = new DirectoryMirror(root, mirrorId, hosted.transport(mirrorId), deviceState());
      await mirror.sync();
      await unlink(join(root, "tasks/one.md"));
      await expect(mirror.sync()).resolves.toMatchObject({
        status: "attention",
        issues: [{ code: "mirror_diverged", path: "tasks/one.md", blocking: true }]
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects corrupt or cross-replica mirror metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdbase-sync-mirror-"));
    try {
      const hosted = new MemoryAuthority();
      const mirrorId = hosted.registerReplica({ name: "Laptop mirror", mode: "read_only" });
      const stateStore = new MemoryMirrorStateStore();
      const mirror = new DirectoryMirror(root, mirrorId, hosted.transport(mirrorId), { stateStore });
      await mirror.sync();
      const obsolete = await stateStore.read();
      if (!obsolete) throw new Error("missing mirror state");
      delete obsolete.engine_version;
      await stateStore.write(obsolete);
      await expect(mirror.sync()).rejects.toMatchObject({
        code: "mirror_state_upgrade_required"
      });
      await stateStore.write({
        protocol_version: 1,
        engine_version: 3,
        generation: 0,
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
      const hosted = new MemoryAuthority();
      const writer = hosted.registerReplica({ name: "Writer", mode: "read_write", allowedTypes: ["task"] });
      const mirrorId = hosted.registerReplica({ name: "Laptop mirror", mode: "read_only" });
      await hosted.transport(writer).mutate(putMutation({
        replicaId: writer, recordId: crypto.randomUUID(), path: "linked/escape.md",
        frontmatter: { type: "task", title: "Escape" }
      }));
      await symlink(outside, join(root, "linked"), "dir");
      const mirror = new DirectoryMirror(root, mirrorId, hosted.transport(mirrorId), deviceState());
      await expect(mirror.sync()).resolves.toMatchObject({
        status: "failed",
        failure: { code: "symlink_denied" }
      });
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
      const hosted = new MemoryAuthority();
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
  it("builds a stable canonical authority manifest", async () => {
    expect(authorityManifestDigest([
      {
        kind: "resource",
        path: "mdbase.yaml",
        identity: "",
        document_hash: "ff".repeat(32)
      },
      {
        kind: "record",
        path: "tasks/a.md",
        identity: "01911111-1111-7111-8111-111111111111",
        document_hash: "00".repeat(32)
      }
    ])).toBe("729589d937fa3c4c43b41a3ecb003c26787770a5d40f7c2fd2b1d8ded1a51c98");

    expect(authorityManifestDigest([
      {
        kind: "record",
        path: "zulu.md",
        identity: "01911111-1111-7111-8111-111111111111",
        document_hash: "aa".repeat(32)
      },
      {
        kind: "record",
        path: "äther.md",
        identity: "01922222-2222-7222-8222-222222222222",
        document_hash: "bb".repeat(32)
      }
    ])).toBe("26d4e8989355717c3e6781c970eedecc7afe09cc08ce16d79568aba9fe3957f5");

    const fileHash = authorityFileHash({
      file_id: "01933333-3333-7333-8333-333333333333",
      path: "images/a.png",
      revision: "file:fixture",
      content_digest: `sha256:${"11".repeat(32)}`,
      size: 9,
      media_type: "image/png",
      media_class: "image",
      modified_at: "2026-08-01T00:00:00.000Z"
    });
    expect(fileHash).toBe("e6103240352c525d69c02c125a92b212fb5e026ec70fbd126afe203f5385dd05");
    expect(authorityManifestDigest([{
      kind: "file",
      path: "images/a.png",
      identity: "01933333-3333-7333-8333-333333333333",
      document_hash: fileHash
    }])).toBe("a70c97aff8c2de2ade687415b98b5d0666edcb4f0fe0c4c0fc1c303650c9d09a");

    const hosted = new MemoryAuthority({
      resources: {
        revision: "resources:1",
        spec_version: "0.3.0",
        types: [],
        contracts: [],
        documents: [{
          path: "mdbase.yaml",
          kind: "configuration",
          revision: documentRevision("spec_version: 0.3.0\n"),
          document: "spec_version: 0.3.0\n"
        }]
      }
    });
    const replicaId = hosted.registerReplica({ name: "Promotion candidate", mode: "read_write" });
    await hosted.transport(replicaId).mutate(putMutation({
      replicaId, recordId: crypto.randomUUID(), path: "note.md",
      frontmatter: { title: "Local" }
    }));
    const fileSystem = new MemoryMirrorFileSystem();
    const mirror = new WritableDirectoryMirror(
      "/virtual",
      replicaId,
      hosted.transport(replicaId),
      {
        stateStore: new MemoryMirrorStateStore(),
        fileSystem,
        blobStore: new MemoryMirrorBlobStore(),
        lease: new MemoryMirrorLease(),
        selectiveSync: fullFileSync
      }
    );
    await mirror.sync();

    const first = await mirror.authorityPromotionManifest();
    const second = await mirror.authorityPromotionManifest();
    expect(first).toEqual(second);
    expect(first.cursor).toBe(1);
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("refuses promotion when the mirror is read-only or has unmanaged Markdown", async () => {
    const hosted = new MemoryAuthority();
    const readOnlyId = hosted.registerReplica({ name: "Read only", mode: "read_only" });
    const readOnly = new DirectoryMirror(
      "/virtual",
      readOnlyId,
      hosted.transport(readOnlyId),
      {
        stateStore: new MemoryMirrorStateStore(),
        fileSystem: new MemoryMirrorFileSystem(),
        blobStore: new MemoryMirrorBlobStore(),
        lease: new MemoryMirrorLease()
      }
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
      {
        stateStore: new MemoryMirrorStateStore(),
        fileSystem,
        blobStore: new MemoryMirrorBlobStore(),
        lease: new MemoryMirrorLease(),
        selectiveSync: fullFileSync
      }
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
      const hosted = new MemoryAuthority();
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

  it("persists initial folder conflicts while downloading independent hosted files", async () => {
    const hosted = new MemoryAuthority();
    const writer = hosted.registerReplica({ name: "Writer", mode: "read_write", allowedTypes: ["task"] });
    const replicaId = hosted.registerReplica({ name: "Writable laptop", mode: "read_write", allowedTypes: ["task"] });
    for (const path of ["a.md", "b.md"]) {
      await hosted.transport(writer).mutate(putMutation({
        replicaId: writer, recordId: crypto.randomUUID(), path,
        frontmatter: { type: "task", title: path }
      }));
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
    await expect(mirror.sync()).resolves.toMatchObject({
      status: "attention",
      conflicts: 1,
      issues: [{ code: "local_collision", path: "b.md", blocking: false }]
    });
    expect(fileSystem.files.has("a.md")).toBe(true);
    expect(fileSystem.files.get("b.md")).toContain("title: Different");
  });

  it("uploads local updates, creates, exact renames, and deletes with stable identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdbase-sync-writable-"));
    try {
      const hosted = new MemoryAuthority();
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
      const hosted = new MemoryAuthority();
      const writer = hosted.registerReplica({ name: "Remote writer", mode: "read_write", allowedTypes: ["task"] });
      const replicaId = hosted.registerReplica({ name: "Writable laptop", mode: "read_write", allowedTypes: ["task"] });
      const recordId = crypto.randomUUID();
      const created = await hosted.transport(writer).mutate(putMutation({
        replicaId: writer, recordId, path: "task.md",
        frontmatter: { type: "task", title: "Base" }
      }));
      if (created.status !== "applied" || !created.record) throw new Error("create failed");
      const mirror = new WritableDirectoryMirror(root, replicaId, hosted.transport(replicaId), deviceState());
      await mirror.sync();
      await writeFile(join(root, "task.md"), "---\ntype: task\ntitle: Local\n---\n");
      await hosted.transport(writer).mutate(putMutation({
        replicaId: writer, recordId, path: created.record.path,
        baseRevision: created.record.revision,
        frontmatter: { ...created.record.frontmatter, title: "Remote" }, body: created.record.body
      }));
      await mirror.sync();
      expect(await readFile(join(root, "task.md"), "utf8")).toContain("title: Local");
      expect(await mirror.status()).toMatchObject({
        state: "attention",
        conflicts: [{ entity: "record", object_id: recordId, path: "task.md", kind: "conflicted" }]
      });
      await mirror.sync();
      await mirror.resolveConflict(
        recordId,
        (await mirror.status()).conflicts[0]!.decision_id,
        "local"
      );
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
      const hosted = new MemoryAuthority();
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
      const first = await hosted.transport(writer).mutate(putMutation({
        replicaId: writer, recordId: firstId, path: "a.md",
        frontmatter: { type: "task", title: "A" }
      }));
      await hosted.transport(writer).mutate(putMutation({
        replicaId: writer, recordId: secondId, path: "b.md",
        frontmatter: { type: "task", title: "B" }
      }));
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
      await hosted.transport(writer).mutate(putMutation({
        replicaId: writer, recordId: firstId, path: first.record.path,
        baseRevision: first.record.revision,
        frontmatter: { ...first.record.frontmatter, title: "Remote A" }, body: first.record.body
      }));

      await mirror.sync();
      expect(await mirror.status()).toMatchObject({
        state: "attention",
        pending: 0,
        conflicts: [{ entity: "record", object_id: firstId, path: "a.md" }]
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
      const hosted = new MemoryAuthority();
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
      const created = await hosted.transport(writer).mutate(putMutation({
        replicaId: writer, recordId, path: "before.md",
        frontmatter: { type: "task", title: "Base" }
      }));
      if (created.status !== "applied" || !created.record) throw new Error("create failed");
      const mirror = new WritableDirectoryMirror(
        root,
        replicaId,
        hosted.transport(replicaId),
        deviceState()
      );
      await mirror.sync();
      await rename(join(root, "before.md"), join(root, "local.md"));
      await hosted.transport(writer).mutate(putMutation({
        replicaId: writer, recordId, path: created.record.path,
        baseRevision: created.record.revision,
        frontmatter: { ...created.record.frontmatter, title: "Remote" }, body: created.record.body
      }));

      await mirror.sync();
      await writeFile(join(root, "local.md"), "---\ntype: task\ntitle: Local\n---\n");
      await mirror.sync();
      await mirror.resolveConflict(
        recordId,
        (await mirror.status()).conflicts[0]!.decision_id,
        "local"
      );
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
      const hosted = new MemoryAuthority();
      const replicaId = hosted.registerReplica({
        name: "Writable laptop",
        mode: "read_write",
        allowedTypes: ["task"]
      });
      const recordId = crypto.randomUUID();
      await hosted.transport(replicaId).mutate(putMutation({
        replicaId, recordId, path: "task.md",
        frontmatter: { type: "task", title: "Task" }
      }));
      const upstream = hosted.transport(replicaId);
      const rejecting = {
        ...upstream,
        openSession: () => upstream.openSession(),
        snapshot: (snapshotId: string, page?: string) => upstream.snapshot(snapshotId, page),
        changes: (after: number, limit?: number) => upstream.changes(after, limit),
        mutate: async (mutation: Parameters<typeof upstream.mutate>[0]) => (
          mutation.operation === "put" && mutation.base_revision !== undefined
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
        pending: 0,
        conflicts: [{ entity: "record", object_id: recordId, kind: "rejected" }]
      });
      await mirror.resolveConflict(
        recordId,
        (await mirror.status()).conflicts[0]!.decision_id,
        "remote"
      );
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
      const hosted = new MemoryAuthority();
      const replicaId = hosted.registerReplica({ name: "Writable laptop", mode: "read_write", allowedTypes: ["task"] });
      const upstream = hosted.transport(replicaId);
      let loseResponse = true;
      const unreliable = {
        ...upstream,
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
      await expect(mirror.sync()).resolves.toMatchObject({
        status: "failed",
        failure: { message: "connection reset after commit" }
      });
      await mirror.sync();
      const session = await upstream.openSession();
      expect(session.head).toBe(1);
      expect((await upstream.snapshot(session.snapshot_id)).records).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("checkpoints large imports in bounded batches and safely replays an interrupted batch", async () => {
    const hosted = new MemoryAuthority();
    const replicaId = hosted.registerReplica({
      name: "Large writable mirror",
      mode: "read_write"
    });
    const upstream = hosted.transport(replicaId);
    const fileSystem = new MemoryMirrorFileSystem();
    const stateStore = new CountingMirrorStateStore();
    const progress: MirrorProgress[] = [];
    let mutationCalls = 0;
    let loseResponseAt = 95;
    const unreliable = {
      ...upstream,
      openSession: () => upstream.openSession(),
      snapshot: (snapshotId: string, page?: string) => upstream.snapshot(snapshotId, page),
      changes: (after: number, limit?: number) => upstream.changes(after, limit),
      async mutate(mutation: Parameters<typeof upstream.mutate>[0]) {
        const receipt = await upstream.mutate(mutation);
        mutationCalls += 1;
        if (mutationCalls === loseResponseAt) {
          loseResponseAt = -1;
          throw new Error("connection reset after a checkpointed server commit");
        }
        return receipt;
      }
    };
    const mirror = new WritableDirectoryMirror(".", replicaId, unreliable, {
      fileSystem,
      stateStore,
      onProgress: (event) => progress.push(event)
    });
    await mirror.sync();
    for (let index = 0; index < 150; index += 1) {
      fileSystem.files.set(
        `bulk-${String(index).padStart(3, "0")}.md`,
        `---\ntype: note\ntitle: Bulk ${index}\n---\nLocal body ${index}\n`
      );
    }

    await expect(mirror.sync()).resolves.toMatchObject({
      status: "failed",
      failure: { message: "connection reset after a checkpointed server commit" }
    });
    await mirror.sync();

    const session = await upstream.openSession();
    const snapshot = await upstream.snapshot(session.snapshot_id);
    expect(snapshot.records).toHaveLength(100);
    const secondPage = await upstream.snapshot(session.snapshot_id, snapshot.next_page);
    expect(secondPage.records).toHaveLength(50);
    expect(await mirror.status()).toMatchObject({ state: "up_to_date", pending: 0 });
    expect(stateStore.writes).toBeLessThan(15);
    expect(progress).toContainEqual({
      phase: "applying",
      completed: 94,
      total: 150,
      done: false
    });
    expect(progress).toContainEqual({
      phase: "applying",
      completed: 150,
      total: 150,
      done: true
    });
  });

  it("never treats schema resources as writable record changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdbase-sync-writable-"));
    try {
      const hosted = new MemoryAuthority({
        resources: {
          revision: "resources:1",
          spec_version: "0.3.0",
          types: [],
          contracts: [],
          documents: [{
            path: "mdbase.yaml",
            kind: "configuration",
            revision: documentRevision("spec_version: 0.3.0\n"),
            document: "spec_version: 0.3.0\n"
          }]
        }
      });
      const replicaId = hosted.registerReplica({ name: "Writable laptop", mode: "read_write" });
      const mirror = new WritableDirectoryMirror(root, replicaId, hosted.transport(replicaId), deviceState());
      await mirror.sync();
      await writeFile(join(root, "mdbase.yaml"), "spec_version: 0.4.0\n");
      await expect(mirror.sync()).resolves.toMatchObject({
        status: "attention",
        issues: [{ code: "mirror_diverged", path: "mdbase.yaml", blocking: true }]
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
