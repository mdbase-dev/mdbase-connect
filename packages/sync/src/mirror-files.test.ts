import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type {
  CollectionFileDescriptor,
  JsonObject,
  SyncChange,
  SyncFileSnapshotPage,
  SyncMutation,
  SyncRecord,
  SyncSession,
  SyncSnapshotRecord
} from "@mdbase/connect-protocol";
import { describe, expect, it } from "vitest";
import { documentRevision } from "./mirror-format.js";
import {
  DirectoryMirror,
  MemoryMirrorBlobStore,
  MemoryMirrorStateStore,
  MirrorDivergenceError,
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

  async read(path: string): Promise<string | null> {
    const value = this.files.get(path);
    return value ? text.decode(value) : null;
  }

  async write(path: string, value: string): Promise<void> {
    this.files.set(path, utf8.encode(value));
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async listMarkdown(excluded: ReadonlySet<string>): Promise<string[]> {
    return [...this.files.keys()]
      .filter((path) => path.endsWith(".md") && !excluded.has(path))
      .sort();
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
  downloads = 0;
  chunkSize = 3;
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
      session_id: `session-${snapshotId}`,
      replica_id: this.replicaId,
      collection_id: "00000000-0000-4000-8000-000000000002",
      mode: "read_only",
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
    const value = this.bytes.get(file.file_id);
    if (!value) throw new Error("missing test object");
    for (let offset = 0; offset < value.byteLength; offset += this.chunkSize) {
      yield value.slice(offset, offset + this.chunkSize);
    }
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
  });

  it("applies folder exclusions to Markdown and files without prefix-neighbor mistakes", async () => {
    const transport = new FileTransport();
    const hiddenBytes = utf8.encode("hidden");
    const neighborBytes = utf8.encode("neighbor");
    transport.records = [
      record("record-hidden", "Archive/note.md", "hidden note"),
      record("record-neighbor", "Archive 2/note.md", "neighbor note")
    ];
    transport.files = [
      file("00000000-0000-4000-8000-000000000012", "Archive/photo.png", hiddenBytes),
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

    expect(fileSystem.files.has("Archive/note.md")).toBe(false);
    expect(fileSystem.files.has("Archive/photo.png")).toBe(false);
    expect(text.decode(fileSystem.files.get("Archive 2/note.md"))).toBe("neighbor note");
    expect(fileSystem.files.get("Archive 2/photo.png")).toEqual(neighborBytes);
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
    const { mirror: target, fileSystem } = mirror(
      transport,
      new BinaryFileSystem(),
      new MemoryMirrorStateStore(),
      { file_classes: ["image"], excluded_folders: [] },
      blobStore
    );

    await target.sync();

    expect(transport.downloads).toBe(1);
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

    await expect(target.sync()).rejects.toBeInstanceOf(MirrorDivergenceError);
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
});
