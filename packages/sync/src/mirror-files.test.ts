import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type {
  CollectionFileDescriptor,
  CommitFileUploadReceipt,
  DeleteFileReceipt,
  DeleteFileRequest,
  JsonObject,
  MoveFileReceipt,
  MoveFileRequest,
  OpenFileUploadRequest,
  SyncChange,
  SyncFileSnapshotPage,
  SyncMutation,
  SyncRecord,
  SyncSession,
  SyncSnapshotRecord
} from "@mdbase-dev/connect-protocol";
import { describe, expect, it } from "vitest";
import { documentRevision } from "./mirror-format.js";
import { pathSelected } from "./mirror-files.js";
import {
  DirectoryMirror,
  MemoryMirrorBlobStore,
  MemoryMirrorStateStore,
  WritableDirectoryMirror,
  type MirrorBlobStore,
  type MirrorFileSystem
} from "./mirror.js";
import type { SyncTransport } from "./sync-types.js";

const utf8 = new TextEncoder();
const text = new TextDecoder();

class BinaryFileSystem implements MirrorFileSystem {
  readonly files = new Map<string, Uint8Array>();
  binaryWrites = 0;
  maxWriteChunk = 0;

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async read(path: string): Promise<string | null> {
    const value = this.files.get(path);
    return value ? text.decode(value) : null;
  }

  async write(path: string, value: string): Promise<void> {
    this.files.set(path, utf8.encode(value));
  }

  async move(source: string, target: string): Promise<void> {
    const value = this.files.get(source);
    if (!value) throw new Error(`missing move source: ${source}`);
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
      .filter((path) => !path.endsWith(".md")
        && !excluded.has(path)
        && !path.split("/").some((component) => component.startsWith(".")))
      .sort();
  }

  async readBinary(path: string): Promise<AsyncIterable<Uint8Array> | null> {
    const value = this.files.get(path);
    if (!value) return null;
    return (async function* () { yield value.slice(); })();
  }

  async inspectBinary(path: string): Promise<{ size: number; content_digest: `sha256:${string}` } | null> {
    const value = this.files.get(path);
    return value
      ? { size: value.byteLength, content_digest: digest(value) }
      : null;
  }

  async writeBinary(path: string, source: AsyncIterable<Uint8Array>): Promise<void> {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of source) {
      this.maxWriteChunk = Math.max(this.maxWriteChunk, chunk.byteLength);
      chunks.push(chunk.slice());
      size += chunk.byteLength;
    }
    const staged = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      staged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.binaryWrites += 1;
    this.files.set(path, staged);
  }
}

class CorruptibleBlobStore implements MirrorBlobStore {
  readonly blobs = new Map<string, Uint8Array>();

  async has(contentDigest: `sha256:${string}`): Promise<boolean> {
    return this.blobs.has(contentDigest);
  }

  async *read(contentDigest: `sha256:${string}`): AsyncGenerator<Uint8Array> {
    const value = this.blobs.get(contentDigest);
    if (!value) throw new Error("missing blob");
    yield value.slice();
  }

  async write(
    contentDigest: `sha256:${string}`,
    source: AsyncIterable<Uint8Array>
  ): Promise<void> {
    const values: number[] = [];
    for await (const chunk of source) values.push(...chunk);
    this.blobs.set(contentDigest, new Uint8Array(values));
  }

  async remove(contentDigest: `sha256:${string}`): Promise<void> {
    this.blobs.delete(contentDigest);
  }

  async prune(retained: ReadonlySet<`sha256:${string}`>): Promise<void> {
    for (const digest of this.blobs.keys()) {
      if (!retained.has(digest as `sha256:${string}`)) this.blobs.delete(digest);
    }
  }
}

interface SnapshotContext {
  head: number;
  records: SyncSnapshotRecord[];
  files: CollectionFileDescriptor[];
}

class FileTransport implements SyncTransport {
  readonly replicaId = "00000000-0000-4000-8000-000000000001";
  records: SyncSnapshotRecord[] = [];
  files: CollectionFileDescriptor[] = [];
  events: SyncChange[] = [];
  bytes = new Map<string, Uint8Array>();
  revisionBytes = new Map<string, Uint8Array>();
  downloads = 0;
  chunkSize = 3;
  mode: "read_only" | "read_write" = "read_only";
  uploadCalls: OpenFileUploadRequest[] = [];
  moveCalls: MoveFileRequest[] = [];
  deleteCalls: DeleteFileRequest[] = [];
  failAfterUploadCommit = false;
  private fileSequence = 1;
  private readonly uploadReceipts = new Map<string, CommitFileUploadReceipt>();
  private readonly snapshots = new Map<string, SnapshotContext>();
  private snapshotSequence = 0;

  async openSession(): Promise<SyncSession> {
    const snapshotId = `snapshot-${this.snapshotSequence++}`;
    const head = this.events.at(-1)?.sequence ?? 0;
    this.snapshots.set(snapshotId, {
      head,
      records: structuredClone(this.records),
      files: structuredClone(this.files)
    });
    return {
      protocol_version: 1,
      protocol_profile: "exact_document_v1",
      session_id: `session-${snapshotId}`,
      replica_id: this.replicaId,
      collection_id: "00000000-0000-4000-8000-000000000002",
      mode: this.mode,
      scope_epoch: 1,
      retained_after: 0,
      head,
      snapshot_id: snapshotId,
      resources: {
        revision: "resources:1",
        spec_version: "0.3.0",
        types: [],
        contracts: [],
        documents: []
      }
    };
  }

  async snapshot(snapshotId: string) {
    const snapshot = this.requireSnapshot(snapshotId);
    return {
      protocol_version: 1 as const,
      snapshot_id: snapshotId,
      scope_epoch: 1,
      cursor: snapshot.head,
      records: structuredClone(snapshot.records)
    };
  }

  async fileSnapshot(snapshotId: string): Promise<SyncFileSnapshotPage> {
    const snapshot = this.requireSnapshot(snapshotId);
    return {
      protocol_version: 1,
      type: "file_snapshot_page",
      snapshot_id: snapshotId,
      scope_epoch: 1,
      cursor: snapshot.head,
      files: structuredClone(snapshot.files)
    };
  }

  async *downloadFile(file: CollectionFileDescriptor): AsyncGenerator<Uint8Array> {
    this.downloads += 1;
    const value = this.revisionBytes.get(`${file.file_id}:${file.revision}`) ?? this.bytes.get(file.file_id);
    if (!value) throw new Error("missing test object");
    for (let offset = 0; offset < value.byteLength; offset += this.chunkSize) {
      yield value.slice(offset, offset + this.chunkSize);
    }
  }

  async uploadFile(
    request: OpenFileUploadRequest,
    source: AsyncIterable<Uint8Array>
  ): Promise<CommitFileUploadReceipt> {
    this.uploadCalls.push(structuredClone(request));
    const replay = this.uploadReceipts.get(request.transfer_id);
    if (replay) return structuredClone(replay);
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of source) {
      chunks.push(chunk.slice());
      size += chunk.byteLength;
    }
    const value = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      value.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (size !== request.size || digest(value) !== request.content_digest) throw new Error("bad upload");
    const current = this.files.find((candidate) => candidate.path === request.path);
    if (current?.revision !== request.if_revision || (!current && request.if_revision)) {
      throw Object.assign(new Error("stale file revision"), { code: "stale_file_revision" });
    }
    const descriptor = file(
      current?.file_id ?? `01930000-0000-7000-8000-${String(this.fileSequence).padStart(12, "0")}`,
      request.path,
      value,
      `file:${++this.fileSequence}`,
      request.path.endsWith(".png") ? "image" : "other"
    );
    if (request.media_type) descriptor.media_type = request.media_type;
    this.files = [...this.files.filter((candidate) => candidate.file_id !== descriptor.file_id), descriptor];
    this.bytes.set(descriptor.file_id, value);
    this.revisionBytes.set(`${descriptor.file_id}:${descriptor.revision}`, value);
    this.events.push({ sequence: this.nextEventSequence(), type: "file_put", file: descriptor });
    const receipt: CommitFileUploadReceipt = {
      protocol_version: 1,
      type: "file_upload_committed",
      transfer_id: request.transfer_id,
      file: descriptor
    };
    this.uploadReceipts.set(request.transfer_id, structuredClone(receipt));
    if (this.failAfterUploadCommit) {
      this.failAfterUploadCommit = false;
      throw new Error("connection dropped after commit");
    }
    return receipt;
  }

  async moveFile(request: MoveFileRequest): Promise<MoveFileReceipt> {
    this.moveCalls.push(structuredClone(request));
    const current = this.files.find((candidate) => candidate.file_id === request.file_id);
    if (!current || current.path !== request.from_path || current.revision !== request.if_revision) {
      throw Object.assign(new Error("stale file revision"), { code: "stale_file_revision" });
    }
    if (this.files.some((candidate) => candidate.file_id !== request.file_id && candidate.path === request.path)) {
      throw Object.assign(new Error("path occupied"), { code: "path_occupied" });
    }
    const moved = { ...current, path: request.path, revision: `file:${++this.fileSequence}` };
    this.files = this.files.map((candidate) => candidate.file_id === request.file_id ? moved : candidate);
    const value = this.bytes.get(request.file_id);
    if (value) this.revisionBytes.set(`${request.file_id}:${moved.revision}`, value);
    this.events.push({ sequence: this.nextEventSequence(), type: "file_put", file: moved });
    return { protocol_version: 1, type: "file_moved", mutation_id: request.mutation_id, file: moved };
  }

  async deleteFile(request: DeleteFileRequest): Promise<DeleteFileReceipt> {
    this.deleteCalls.push(structuredClone(request));
    const current = this.files.find((candidate) => candidate.file_id === request.file_id);
    if (!current || current.path !== request.path || current.revision !== request.if_revision) {
      throw Object.assign(new Error("stale file revision"), { code: "stale_file_revision" });
    }
    const revision = `file:${++this.fileSequence}`;
    this.files = this.files.filter((candidate) => candidate.file_id !== request.file_id);
    this.bytes.delete(request.file_id);
    this.events.push({
      sequence: this.nextEventSequence(),
      type: "file_remove",
      file_id: request.file_id,
      previous_path: request.path,
      revision
    });
    return {
      protocol_version: 1,
      type: "file_deleted",
      mutation_id: request.mutation_id,
      file_id: request.file_id,
      previous_path: request.path,
      revision
    };
  }

  async changes(after: number) {
    const events = this.events.filter((event) => event.sequence > after);
    const head = this.events.at(-1)?.sequence ?? after;
    return {
      protocol_version: 1 as const,
      scope_epoch: 1,
      events: structuredClone(events),
      cursor: head,
      head,
      has_more: false,
      reset_required: false
    };
  }

  async mutate(_mutation: SyncMutation): Promise<never> {
    throw new Error("unused");
  }

  private requireSnapshot(id: string): SnapshotContext {
    const snapshot = this.snapshots.get(id);
    if (!snapshot) throw new Error("expired test snapshot");
    return snapshot;
  }

  private nextEventSequence(): number {
    return (this.events.at(-1)?.sequence ?? 0) + 1;
  }
}

function digest(value: Uint8Array): `sha256:${string}` {
  return `sha256:${bytesToHex(sha256(value))}`;
}

function file(
  fileId: string,
  path: string,
  value: Uint8Array,
  revision = "file:1",
  mediaClass: CollectionFileDescriptor["media_class"] = "image"
): CollectionFileDescriptor {
  return {
    file_id: fileId,
    path,
    revision,
    content_digest: digest(value),
    size: value.byteLength,
    media_type: mediaClass === "image" ? "image/png" : "application/octet-stream",
    media_class: mediaClass,
    modified_at: "2026-08-01T00:00:00.000Z"
  };
}

function record(recordId: string, path: string, body: string): SyncSnapshotRecord<JsonObject> {
  return {
    record_id: recordId,
    path,
    revision: documentRevision(body),
    frontmatter: {},
    body,
    types: [],
    document: body
  };
}

function mirror(
  transport: FileTransport,
  fileSystem = new BinaryFileSystem(),
  stateStore = new MemoryMirrorStateStore(),
  selectiveSync = { file_classes: ["image" as const], excluded_folders: [] as string[] },
  blobStore = new MemoryMirrorBlobStore()
) {
  return {
    fileSystem,
    stateStore,
    mirror: new DirectoryMirror(transport.replicaId, transport, {
      fileSystem,
      stateStore,
      blobStore,
      selectiveSync
    })
  };
}

function writableMirror(
  transport: FileTransport,
  fileSystem = new BinaryFileSystem(),
  stateStore = new MemoryMirrorStateStore(),
  blobStore = new MemoryMirrorBlobStore()
) {
  transport.mode = "read_write";
  return {
    fileSystem,
    stateStore,
    mirror: new WritableDirectoryMirror(transport.replicaId, transport, {
      fileSystem,
      stateStore,
      blobStore,
      selectiveSync: { file_classes: ["image", "other"], excluded_folders: [] }
    })
  };
}

describe("portable collection file mirror", () => {
  it("keeps metadata-only as the safe default", async () => {
    const transport = new FileTransport();
    const bytes = utf8.encode("image bytes");
    transport.files = [file("00000000-0000-4000-8000-000000000010", "images/photo.png", bytes)];
    transport.bytes.set(transport.files[0]!.file_id, bytes);
    const fileSystem = new BinaryFileSystem();
    const target = new DirectoryMirror(transport.replicaId, transport, {
      fileSystem,
      stateStore: new MemoryMirrorStateStore()
    });

    await target.sync();

    expect(transport.downloads).toBe(0);
    expect(fileSystem.files.size).toBe(0);
  });

  it("streams selected R2-backed files through verified staging and reuses the cache", async () => {
    const transport = new FileTransport();
    transport.chunkSize = 64 * 1024;
    const bytes = new Uint8Array(1024 * 1024 + 17).map((_, index) => index % 251);
    const descriptor = file("00000000-0000-4000-8000-000000000011", "media/large.png", bytes);
    transport.files = [descriptor];
    transport.bytes.set(descriptor.file_id, bytes);
    const { mirror: target, fileSystem, stateStore } = mirror(transport);

    await target.sync();
    expect(fileSystem.files.get(descriptor.path)).toEqual(bytes);
    expect(fileSystem.maxWriteChunk).toBeLessThanOrEqual(64 * 1024);
    expect((await stateStore.read())?.files?.[descriptor.file_id]?.file).toEqual(descriptor);
    expect(transport.downloads).toBe(1);

    await target.sync();
    expect(transport.downloads).toBe(1);
  }, 15_000);

  it("applies folder exclusions to Markdown and files without prefix-neighbor mistakes", async () => {
    const transport = new FileTransport();
    const hiddenBytes = utf8.encode("hidden");
    const neighborBytes = utf8.encode("neighbor");
    transport.records = [
      record("record-hidden", "archive/note.md", "hidden note"),
      record("record-neighbor", "Archive 2/note.md", "neighbor note")
    ];
    transport.files = [
      file("00000000-0000-4000-8000-000000000012", "archive/photo.png", hiddenBytes),
      file("00000000-0000-4000-8000-000000000013", "Archive 2/photo.png", neighborBytes)
    ];
    for (const descriptor of transport.files) {
      transport.bytes.set(descriptor.file_id, descriptor === transport.files[0] ? hiddenBytes : neighborBytes);
    }
    const { mirror: target, fileSystem } = mirror(
      transport,
      new BinaryFileSystem(),
      new MemoryMirrorStateStore(),
      { file_classes: ["image"], excluded_folders: ["Archive"] }
    );

    await target.sync();

    expect(fileSystem.files.has("archive/note.md")).toBe(false);
    expect(fileSystem.files.has("archive/photo.png")).toBe(false);
    expect(text.decode(fileSystem.files.get("Archive 2/note.md"))).toBe("neighbor note");
    expect(fileSystem.files.get("Archive 2/photo.png")).toEqual(neighborBytes);
  });

  it("persists writable initialization file conflicts for explicit resolution", async () => {
    const transport = new FileTransport();
    const remoteBytes = utf8.encode("remote image bytes");
    const localBytes = utf8.encode("important local image bytes");
    const fileId = "00000000-0000-4000-8000-000000000012";
    const descriptor = file(fileId, "images/collision.png", remoteBytes);
    transport.files = [descriptor];
    transport.bytes.set(fileId, remoteBytes);
    const fileSystem = new BinaryFileSystem();
    fileSystem.files.set(descriptor.path, localBytes);
    const { mirror: target, stateStore } = writableMirror(transport, fileSystem);

    const plan = await target.inspect();
    expect(plan).toMatchObject({
      kind: "initial",
      summary: { conflicts: 1, blocking_issues: 0 },
      issues: [{ code: "local_collision", path: descriptor.path, blocking: false }]
    });
    expect(plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: "record_conflict", identity: fileId, entity: "file" })
      ])
    );

    await expect(target.apply(plan)).resolves.toMatchObject({ status: "attention", conflicts: 1 });
    expect(fileSystem.files.get(descriptor.path)).toEqual(localBytes);
    expect((await stateStore.read())?.planned_conflicts).toHaveProperty(fileId);
    expect(await target.status()).toMatchObject({
      conflicts: [{ entity: "file", object_id: fileId, path: descriptor.path }]
    });

    await expect(target.resolveConflict(fileId, "different-decision", "remote"))
      .rejects.toMatchObject({ code: "mirror_conflict_stale" });
    await target.resolveConflict(
      fileId,
      (await target.status()).conflicts[0]!.decision_id,
      "remote"
    );
    expect(fileSystem.files.get(descriptor.path)).toEqual(remoteBytes);
    expect((await target.status()).conflicts).toEqual([]);
  });

  it("matches excluded folders by portable Unicode identity", () => {
    const policy = {
      file_classes: ["image" as const],
      excluded_folders: ["Privat\u00e9"]
    };

    expect(pathSelected(policy, "PRIVAT\u0065\u0301/photo.png")).toBe(false);
    expect(pathSelected(policy, "Privat\u00e9 2/photo.png")).toBe(true);
  });

  it("reconciles policy changes without deleting authority data", async () => {
    const transport = new FileTransport();
    const bytes = utf8.encode("photo");
    const descriptor = file("00000000-0000-4000-8000-000000000014", "Archive/photo.png", bytes);
    transport.records = [record("archived-record", "Archive/note.md", "archived")];
    transport.files = [descriptor];
    transport.bytes.set(descriptor.file_id, bytes);
    const fileSystem = new BinaryFileSystem();
    const stateStore = new MemoryMirrorStateStore();

    await mirror(transport, fileSystem, stateStore).mirror.sync();
    expect(fileSystem.files.has("Archive/photo.png")).toBe(true);

    await mirror(transport, fileSystem, stateStore, {
      file_classes: ["image"],
      excluded_folders: ["Archive"]
    }).mirror.sync();
    expect(fileSystem.files.has("Archive/photo.png")).toBe(false);
    expect(fileSystem.files.has("Archive/note.md")).toBe(false);
    expect(transport.files).toHaveLength(1);

    await mirror(transport, fileSystem, stateStore).mirror.sync();
    expect(fileSystem.files.get("Archive/photo.png")).toEqual(bytes);
    expect(text.decode(fileSystem.files.get("Archive/note.md"))).toBe("archived");
  });

  it("rebuilds an updated file over its last verified projection", async () => {
    const transport = new FileTransport();
    const first = utf8.encode("first version");
    const second = utf8.encode("second version");
    const fileId = "00000000-0000-4000-8000-000000000021";
    transport.files = [file(fileId, "images/versioned.png", first, "file:1")];
    transport.bytes.set(fileId, first);
    const fileSystem = new BinaryFileSystem();
    const stateStore = new MemoryMirrorStateStore();
    await mirror(transport, fileSystem, stateStore).mirror.sync();

    transport.files = [file(fileId, "images/versioned.png", second, "file:2")];
    transport.bytes.set(fileId, second);
    await mirror(
      transport,
      fileSystem,
      stateStore,
      { file_classes: ["image", "audio"], excluded_folders: [] }
    ).mirror.sync();

    expect(fileSystem.files.get("images/versioned.png")).toEqual(second);
  });

  it("does not install corrupt bytes or advance durable state", async () => {
    const transport = new FileTransport();
    const expected = utf8.encode("expected");
    const descriptor = file("00000000-0000-4000-8000-000000000015", "images/corrupt.png", expected);
    transport.files = [descriptor];
    transport.bytes.set(descriptor.file_id, utf8.encode("corrupt"));
    const { mirror: target, fileSystem, stateStore } = mirror(transport);

    await expect(target.sync()).rejects.toMatchObject({ code: "file_integrity_failed" });
    expect(fileSystem.files.has(descriptor.path)).toBe(false);
    expect(await stateStore.read()).toBeNull();

    transport.bytes.set(descriptor.file_id, expected);
    await target.sync();
    expect(fileSystem.files.get(descriptor.path)).toEqual(expected);
    expect(transport.downloads).toBe(2);
  });

  it("detects and replaces a corrupt content-addressed cache entry", async () => {
    const transport = new FileTransport();
    const bytes = utf8.encode("healthy object");
    const descriptor = file("00000000-0000-4000-8000-000000000022", "images/cached.png", bytes);
    transport.files = [descriptor];
    transport.bytes.set(descriptor.file_id, bytes);
    const blobStore = new CorruptibleBlobStore();
    blobStore.blobs.set(descriptor.content_digest, utf8.encode("bad cache"));
    const staleDigest = `sha256:${"00".repeat(32)}` as const;
    blobStore.blobs.set(staleDigest, utf8.encode("unreferenced cache"));
    const { mirror: target, fileSystem } = mirror(
      transport,
      new BinaryFileSystem(),
      new MemoryMirrorStateStore(),
      { file_classes: ["image"], excluded_folders: [] },
      blobStore
    );

    await target.sync();

    expect(transport.downloads).toBe(1);
    expect([...blobStore.blobs.keys()]).toEqual([descriptor.content_digest]);
    expect(blobStore.blobs.get(descriptor.content_digest)).toEqual(bytes);
    expect(fileSystem.files.get(descriptor.path)).toEqual(bytes);
  });

  it("atomically applies incremental file moves after staging new bytes", async () => {
    const transport = new FileTransport();
    const first = utf8.encode("first");
    const second = utf8.encode("second");
    const fileId = "00000000-0000-4000-8000-000000000016";
    const original = file(fileId, "images/old.png", first);
    transport.files = [original];
    transport.bytes.set(fileId, first);
    const { mirror: target, fileSystem, stateStore } = mirror(transport);
    await target.sync();

    const moved = file(fileId, "images/new.png", second, "file:2");
    transport.files = [moved];
    transport.bytes.set(fileId, second);
    transport.events = [{ sequence: 1, type: "file_put", file: moved }];
    await target.sync();

    expect(fileSystem.files.has(original.path)).toBe(false);
    expect(fileSystem.files.get(moved.path)).toEqual(second);
    expect((await stateStore.read())?.cursor).toBe(1);
  });

  it("refuses to erase locally modified binary files", async () => {
    const transport = new FileTransport();
    const bytes = utf8.encode("authority");
    const descriptor = file("00000000-0000-4000-8000-000000000017", "images/local.png", bytes);
    transport.files = [descriptor];
    transport.bytes.set(descriptor.file_id, bytes);
    const { mirror: target, fileSystem } = mirror(transport);
    await target.sync();
    fileSystem.files.set(descriptor.path, utf8.encode("local edit"));
    transport.files = [];
    transport.events = [{
      sequence: 1,
      type: "file_remove",
      file_id: descriptor.file_id,
      previous_path: descriptor.path,
      revision: "file:deleted"
    }];

    await expect(target.sync()).resolves.toMatchObject({
      status: "attention",
      issues: [{ code: "mirror_diverged", path: descriptor.path, blocking: true }]
    });
    expect(text.decode(fileSystem.files.get(descriptor.path))).toBe("local edit");
  });

  it("rejects hidden file manifests and cross-kind physical path collisions", async () => {
    const hiddenTransport = new FileTransport();
    const bytes = utf8.encode("hidden");
    hiddenTransport.files = [file(
      "00000000-0000-4000-8000-000000000018",
      ".private/secret.png",
      bytes
    )];
    await expect(mirror(hiddenTransport).mirror.sync()).rejects.toMatchObject({
      code: "invalid_file_path"
    });

    const collisionTransport = new FileTransport();
    collisionTransport.records = [record("record-collision", "Images/Photo.PNG", "record")];
    const descriptor = file(
      "00000000-0000-4000-8000-000000000019",
      "images/photo.png",
      bytes
    );
    collisionTransport.files = [descriptor];
    collisionTransport.bytes.set(descriptor.file_id, bytes);
    await expect(mirror(collisionTransport).mirror.sync()).rejects.toMatchObject({
      code: "invalid_record_path"
    });
  });

  it("supports verified zero-byte objects", async () => {
    const transport = new FileTransport();
    const bytes = new Uint8Array();
    const descriptor = file("00000000-0000-4000-8000-000000000020", "empty.bin", bytes, "file:1", "other");
    transport.files = [descriptor];
    transport.bytes.set(descriptor.file_id, bytes);
    const { mirror: target, fileSystem } = mirror(
      transport,
      new BinaryFileSystem(),
      new MemoryMirrorStateStore(),
      { file_classes: ["other"], excluded_folders: [] }
    );

    await target.sync();
    expect(fileSystem.files.get("empty.bin")).toEqual(bytes);
  });

  it("uploads replacements, preserves identity on moves, deletes, and adds files", async () => {
    const transport = new FileTransport();
    const originalBytes = utf8.encode("original");
    const fileId = "00000000-0000-4000-8000-000000000030";
    const original = file(fileId, "images/original.png", originalBytes);
    transport.files = [original];
    transport.bytes.set(fileId, originalBytes);
    const { mirror: target, fileSystem, stateStore } = writableMirror(transport);
    await target.sync();

    const replacement = utf8.encode("replacement");
    fileSystem.files.set(original.path, replacement);
    const writesAfterDownload = fileSystem.binaryWrites;
    await target.sync();
    expect(transport.uploadCalls.at(-1)?.if_revision).toBe(original.revision);
    expect(transport.files[0]).toMatchObject({ file_id: fileId, content_digest: digest(replacement) });
    expect(fileSystem.binaryWrites).toBe(writesAfterDownload);

    fileSystem.files.delete(original.path);
    fileSystem.files.set("images/renamed.png", replacement);
    await target.sync();
    expect(transport.moveCalls).toHaveLength(1);
    expect(transport.moveCalls[0]).toMatchObject({
      file_id: fileId,
      from_path: original.path,
      path: "images/renamed.png"
    });
    expect(transport.files[0]?.file_id).toBe(fileId);

    fileSystem.files.delete("images/renamed.png");
    await target.sync();
    expect(transport.deleteCalls).toHaveLength(1);
    expect(transport.files).toHaveLength(0);

    const added = utf8.encode("brand new");
    fileSystem.files.set("assets/new.bin", added);
    await target.sync();
    expect(transport.uploadCalls.at(-1)).toMatchObject({
      path: "assets/new.bin",
      content_digest: digest(added),
      size: added.byteLength
    });
    expect((await stateStore.read())?.batch).toBeUndefined();
    expect((await target.status()).conflicts).toEqual([]);
  });

  it("replays an ambiguously committed upload and then sends a newer local edit", async () => {
    const transport = new FileTransport();
    const fileSystem = new BinaryFileSystem();
    const stateStore = new MemoryMirrorStateStore();
    const first = utf8.encode("first durable snapshot");
    const second = utf8.encode("second live edit");
    fileSystem.files.set("assets/retry.bin", first);
    transport.failAfterUploadCommit = true;
    const { mirror: target } = writableMirror(transport, fileSystem, stateStore);

    await expect(target.sync()).resolves.toMatchObject({
      status: "failed",
      failure: { message: "connection dropped after commit" }
    });
    expect((await stateStore.read())?.batch).toMatchObject({
      phase: "blocked",
      next_action: 0
    });
    fileSystem.files.set("assets/retry.bin", second);

    await target.sync();

    expect(transport.uploadCalls).toHaveLength(2);
    expect(fileSystem.files.get("assets/retry.bin")).toEqual(second);
    await target.sync();

    expect(transport.uploadCalls).toHaveLength(3);
    expect(transport.uploadCalls[1]?.transfer_id).toBe(transport.uploadCalls[0]?.transfer_id);
    expect(transport.uploadCalls[2]?.transfer_id).not.toBe(transport.uploadCalls[0]?.transfer_id);
    expect(transport.bytes.get(transport.files[0]!.file_id)).toEqual(second);
    expect((await stateStore.read())?.batch).toBeUndefined();
    expect((await target.status()).state).toBe("up_to_date");
  });

  it("retains a stale writable file mutation and the user's bytes for resolution", async () => {
    const transport = new FileTransport();
    const authorityBytes = utf8.encode("authority");
    const localBytes = utf8.encode("local");
    const remoteBytes = utf8.encode("remote");
    const fileId = "00000000-0000-4000-8000-000000000031";
    const initial = file(fileId, "images/conflict.png", authorityBytes);
    transport.files = [initial];
    transport.bytes.set(fileId, authorityBytes);
    const { mirror: target, fileSystem, stateStore } = writableMirror(transport);
    await target.sync();
    fileSystem.files.set(initial.path, localBytes);
    const remote = file(fileId, initial.path, remoteBytes, "file:remote");
    transport.files = [remote];
    transport.bytes.set(fileId, remoteBytes);
    transport.revisionBytes.set(`${fileId}:${remote.revision}`, remoteBytes);
    transport.events.push({ sequence: 1, type: "file_put", file: remote });

    await expect(target.sync()).resolves.toMatchObject({ status: "attention", conflicts: 1 });

    expect(fileSystem.files.get(initial.path)).toEqual(localBytes);
    expect(await target.status()).toMatchObject({
      state: "attention",
      pending_files: 0,
      conflicts: [{
        entity: "file",
        object_id: fileId,
        path: initial.path,
        kind: "conflicted"
      }]
    });
    const stableDecision = (await target.status()).conflicts[0]!.decision_id;
    await target.sync();
    expect((await target.status()).conflicts[0]!.decision_id).toBe(stableDecision);

    const latestBytes = utf8.encode("hosted edit after conflict");
    const latest = file(fileId, initial.path, latestBytes, "file:latest");
    transport.files = [latest];
    transport.bytes.set(fileId, latestBytes);
    transport.revisionBytes.set(`${fileId}:${latest.revision}`, latestBytes);
    transport.events.push({ sequence: 2, type: "file_put", file: latest });

    const reviewedDecision = (await target.status()).conflicts[0]!.decision_id;
    await expect(target.resolveConflict(fileId, reviewedDecision, "remote")).rejects.toMatchObject({
      code: "mirror_conflict_stale"
    });
    expect(fileSystem.files.get(initial.path)).toEqual(localBytes);
    expect((await target.status()).conflicts).toHaveLength(1);

    await target.sync();
    await target.resolveConflict(
      fileId,
      (await target.status()).conflicts[0]!.decision_id,
      "remote"
    );
    expect(fileSystem.files.get(initial.path)).toEqual(latestBytes);
    expect((await target.status()).conflicts).toEqual([]);
  });

  it("plans durable conflict cleanup when local and hosted file bytes converge", async () => {
    const transport = new FileTransport();
    const initialBytes = utf8.encode("initial");
    const localBytes = utf8.encode("same eventual bytes");
    const remoteBytes = utf8.encode("first remote edit");
    const fileId = "00000000-0000-4000-8000-000000000039";
    const initial = file(fileId, "images/converged.png", initialBytes);
    transport.files = [initial];
    transport.bytes.set(fileId, initialBytes);
    const { mirror: target, fileSystem } = writableMirror(transport);
    await target.sync();
    fileSystem.files.set(initial.path, localBytes);
    const conflicted = file(fileId, initial.path, remoteBytes, "file:conflicted");
    transport.files = [conflicted];
    transport.bytes.set(fileId, remoteBytes);
    transport.events.push({ sequence: 1, type: "file_put", file: conflicted });
    await target.sync();
    expect((await target.status()).conflicts).toHaveLength(1);

    const converged = file(fileId, initial.path, localBytes, "file:converged");
    transport.files = [converged];
    transport.bytes.set(fileId, localBytes);
    transport.events.push({ sequence: 2, type: "file_put", file: converged });
    const plan = await target.inspect();
    expect(plan.actions.map(({ command }) => command)).toEqual([
      "clear_conflict",
      "advance_checkpoint"
    ]);

    await target.sync();
    expect((await target.status()).conflicts).toEqual([]);
    expect(fileSystem.files.get(initial.path)).toEqual(localBytes);
  });

  it("rebases a local file-conflict resolution onto the latest authority revision", async () => {
    const transport = new FileTransport();
    const initialBytes = utf8.encode("initial");
    const localBytes = utf8.encode("keep local");
    const remoteBytes = utf8.encode("remote concurrent edit");
    const fileId = "00000000-0000-4000-8000-000000000032";
    const initial = file(fileId, "images/rebase.png", initialBytes);
    transport.files = [initial];
    transport.bytes.set(fileId, initialBytes);
    transport.revisionBytes.set(`${fileId}:${initial.revision}`, initialBytes);
    const { mirror: target, fileSystem } = writableMirror(transport);
    await target.sync();
    fileSystem.files.set(initial.path, localBytes);
    const remote = file(fileId, initial.path, remoteBytes, "file:remote-concurrent");
    transport.files = [remote];
    transport.bytes.set(fileId, remoteBytes);
    transport.revisionBytes.set(`${fileId}:${remote.revision}`, remoteBytes);
    transport.events.push({ sequence: 1, type: "file_put", file: remote });
    await expect(target.sync()).resolves.toMatchObject({ status: "attention", conflicts: 1 });

    const uploadsBeforeResolution = transport.uploadCalls.length;
    await target.resolveConflict(
      fileId,
      (await target.status()).conflicts[0]!.decision_id,
      "local"
    );
    await target.sync();

    expect(transport.uploadCalls.at(-1)).toMatchObject({
      if_revision: remote.revision,
      content_digest: digest(localBytes)
    });
    expect(transport.uploadCalls).toHaveLength(uploadsBeforeResolution + 1);
    expect(transport.bytes.get(fileId)).toEqual(localBytes);
    expect(fileSystem.files.get(initial.path)).toEqual(localBytes);
    expect((await target.status()).state).toBe("up_to_date");
  });

  it("orders a local resolution after a concurrent remote move", async () => {
    const transport = new FileTransport();
    const initialBytes = utf8.encode("initial move bytes");
    const localBytes = utf8.encode("local replacement after move");
    const fileId = "00000000-0000-4000-8000-000000000033";
    const initial = file(fileId, "images/local-name.png", initialBytes);
    transport.files = [initial];
    transport.bytes.set(fileId, initialBytes);
    transport.revisionBytes.set(`${fileId}:${initial.revision}`, initialBytes);
    const { mirror: target, fileSystem, stateStore } = writableMirror(transport);
    await target.sync();
    fileSystem.files.set(initial.path, localBytes);
    const movedRemote = file(fileId, "images/remote-name.png", initialBytes, "file:remote-move");
    transport.files = [movedRemote];
    transport.revisionBytes.set(`${fileId}:${movedRemote.revision}`, initialBytes);
    transport.events.push({ sequence: 1, type: "file_put", file: movedRemote });
    await expect(target.sync()).resolves.toMatchObject({ status: "attention", conflicts: 1 });

    await target.resolveConflict(
      fileId,
      (await target.status()).conflicts[0]!.decision_id,
      "local"
    );
    const resolutionPlan = await target.inspect();
    expect(resolutionPlan.actions.map(({ command }) => command)).toEqual([
      "put_remote",
      "move_remote",
      "advance_checkpoint"
    ]);
    await target.sync();

    expect(transport.moveCalls.at(-1)).toMatchObject({
      from_path: movedRemote.path,
      path: initial.path
    });
    expect(transport.moveCalls.at(-1)?.if_revision).toMatch(/^file:\d+$/u);
    expect(transport.moveCalls.at(-1)?.if_revision).not.toBe(movedRemote.revision);
    expect(transport.uploadCalls.at(-1)?.if_revision).toBe(movedRemote.revision);
    expect(transport.files[0]).toMatchObject({ path: initial.path, content_digest: digest(localBytes) });
    expect(fileSystem.files.get(initial.path)).toEqual(localBytes);
  });

  it("does not discover hidden folders in writable file scans", async () => {
    const transport = new FileTransport();
    const fileSystem = new BinaryFileSystem();
    fileSystem.files.set(".private/secret.png", utf8.encode("secret"));
    fileSystem.files.set("images/visible.png", utf8.encode("visible"));
    const { mirror: target } = writableMirror(transport, fileSystem);

    await target.sync();

    expect(transport.uploadCalls.map((request) => request.path)).toEqual(["images/visible.png"]);
  });
});
