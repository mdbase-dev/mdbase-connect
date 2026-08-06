import { createHash, randomUUID } from "node:crypto";
import {
  open,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  JsonObject,
  SelectiveSyncPolicy
} from "@mdbase-dev/connect-protocol";
import type { SyncTransport } from "./index.js";
import { SyncError } from "./index.js";
import { applySyncJournalEvent, type SyncJournalEvent } from "./sync-journal.js";
import {
  DirectoryMirror as PortableDirectoryMirror,
  WritableDirectoryMirror as PortableWritableDirectoryMirror,
  type AcquiredMirrorLease,
  type DirectoryMirrorOptions as PortableDirectoryMirrorOptions,
  type MirrorFileSystem,
  type MirrorBlobStore,
  type MirrorLease,
  type MirrorProgress,
  type MirrorRuntime,
  type MirrorState,
  type MirrorStateStore
} from "./mirror.js";

export {
  authorityFileHash,
  authorityManifestDigest,
  MemoryMirrorBlobStore,
  MemoryMirrorLease,
  MemoryMirrorStateStore,
  MirrorDivergenceError,
  portableMirrorRuntime,
  recordMarkdownDocument,
  type AcquiredMirrorLease,
  type AuthorityPromotionManifest,
  type MirrorBinaryInfo,
  type MirrorBlobStore,
  type MirrorFileEntry,
  type MirrorFileSystem,
  type MirrorInitializationPreview,
  type MirrorLease,
  type MirrorProgress,
  type MirrorRuntime,
  type MirrorState,
  type MirrorStateStore,
  type MirrorStatus
} from "./mirror.js";

/** Node adapter options; omitted adapters use safe Node defaults. */
export interface DirectoryMirrorOptions {
  stateStore?: MirrorStateStore;
  fileSystem?: MirrorFileSystem;
  blobStore?: MirrorBlobStore;
  selectiveSync?: SelectiveSyncPolicy;
  lease?: MirrorLease;
  runtime?: MirrorRuntime;
  onProgress?: (progress: MirrorProgress) => void;
}

const nodeMirrorRuntime: MirrorRuntime = Object.freeze({
  digest: (value: string) => createHash("sha256").update(value).digest("hex"),
  randomId: () => randomUUID(),
  now: () => new Date().toISOString()
});

export class NodeMirrorStateStore implements MirrorStateStore {
  private statePath: Promise<string> | null = null;

  constructor(
    private readonly root: string,
    private readonly stateRoot = process.env.MDBASE_CONNECT_MIRROR_STATE_DIR
  ) {}

  async read(): Promise<MirrorState | null> {
    const value = await readOptional(await this.path());
    if (value === null) return null;
    try {
      const state = JSON.parse(value) as MirrorState;
      const journal = await readOptional(await this.journalPath());
      if (journal !== null) {
        const lines = journal.split("\n");
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index]!;
          if (line === "") continue;
          try {
            applySyncJournalEvent(state, JSON.parse(line) as SyncJournalEvent);
          } catch (error) {
            if (index === lines.length - 1) break;
            throw error;
          }
        }
      }
      return state;
    } catch {
      throw new SyncError("invalid_mirror_state", "Mirror metadata is corrupt.");
    }
  }

  async write(state: MirrorState): Promise<void> {
    const path = await this.path();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await atomicWrite(path, `${JSON.stringify(state, null, 2)}\n`);
    await unlink(await this.journalPath()).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  async appendJournal(event: SyncJournalEvent): Promise<void> {
    const path = await this.journalPath();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const output = await open(path, "a", 0o600);
    try {
      await output.writeFile(`${JSON.stringify(event)}\n`);
      await output.sync();
    } finally {
      await output.close();
    }
  }

  async directory(): Promise<string> {
    return dirname(await this.path());
  }

  private path(): Promise<string> {
    this.statePath ??= mirrorDeviceDirectory(this.root, this.stateRoot)
      .then((directory) => join(directory, "mirror-state.json"));
    return this.statePath;
  }

  private async journalPath(): Promise<string> {
    return join(dirname(await this.path()), "mirror-journal.ndjson");
  }
}

interface MirrorLeaseRecord {
  version: 1;
  owner_id: string;
  pid: number;
  acquired_at: string;
}

/**
 * Cross-process exclusion for a physical mirror folder.
 *
 * The lease is device-local and keyed by canonical path plus filesystem
 * identity. Unlike credentials and mirror state, its base directory cannot be
 * overridden per client: Electron and Obsidian must contend in the same
 * OS-user-wide namespace even when they keep separate application state.
 */
export class NodeMirrorLease implements MirrorLease {
  constructor(private readonly root: string) {}

  async acquire(): Promise<AcquiredMirrorLease> {
    const directory = await mirrorLeaseDirectory(this.root);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, "mirror.lock");
    const record: MirrorLeaseRecord = {
      version: 1,
      owner_id: randomUUID(),
      pid: process.pid,
      acquired_at: new Date().toISOString()
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await writeFile(path, `${JSON.stringify(record)}\n`, {
          flag: "wx",
          mode: 0o600
        });
        let released = false;
        return {
          runExclusive: async <Value>(operation: () => Promise<Value>) => operation(),
          release: async () => {
            if (released) return;
            const current = await readLeaseRecord(path);
            if (current?.owner_id === record.owner_id) await unlinkOptional(path);
            released = true;
          }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (attempt === 0 && await removeStaleLease(path)) continue;
        throw new SyncError(
          "mirror_folder_in_use",
          "Another mdbase mirror process is already using this folder."
        );
      }
    }
    throw new SyncError(
      "mirror_folder_in_use",
      "Another mdbase mirror process is already using this folder."
    );
  }

  async runExclusive<Value>(operation: () => Promise<Value>): Promise<Value> {
    const acquired = await this.acquire();
    try {
      return await operation();
    } finally {
      await acquired.release();
    }
  }
}

export async function mirrorDeviceDirectory(root: string, stateRoot?: string): Promise<string> {
  const { resolvedRoot, canonicalRoot, digest } = await mirrorFolderIdentity(root);
  const base = stateRoot
    ? resolve(stateRoot)
    : process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support", "mdbase-connect")
      : process.platform === "win32"
        ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "mdbase-connect")
        : join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "mdbase-connect");
  const resolvedBase = resolve(base);
  let canonicalBase = resolvedBase;
  try {
    canonicalBase = await realpath(canonicalBase);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (
    isWithinDirectory(resolvedBase, resolvedRoot)
    || isWithinDirectory(canonicalBase, canonicalRoot)
  ) {
    throw new SyncError(
      "mirror_state_inside_collection",
      "Device credentials and sync state must be stored outside the mirrored folder."
    );
  }
  return join(base, "mirrors", digest);
}

/**
 * Return the one per-user lease directory for a physical folder.
 *
 * This deliberately ignores MDBASE_CONNECT_MIRROR_STATE_DIR, XDG_STATE_HOME,
 * and LOCALAPPDATA. Those are valid per-application state choices, but allowing
 * them to choose the lock namespace would let two clients bypass exclusion.
 */
export async function mirrorLeaseDirectory(root: string): Promise<string> {
  const { digest } = await mirrorFolderIdentity(root);
  const base = process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "mdbase-connect")
    : process.platform === "win32"
      ? join(homedir(), "AppData", "Local", "mdbase-connect")
      : join(homedir(), ".local", "state", "mdbase-connect");
  return join(base, "mirror-leases", digest);
}

async function mirrorFolderIdentity(root: string): Promise<{
  resolvedRoot: string;
  canonicalRoot: string;
  digest: string;
}> {
  const resolvedRoot = resolve(root);
  const canonicalRoot = await realpath(resolvedRoot);
  const rootIdentity = await stat(canonicalRoot);
  const digest = createHash("sha256")
    .update(canonicalRoot)
    .update("\0")
    .update(`${rootIdentity.dev}:${rootIdentity.ino}:${rootIdentity.birthtimeMs}`)
    .digest("hex");
  return { resolvedRoot, canonicalRoot, digest };
}

function isWithinDirectory(candidate: string, directory: string): boolean {
  const offset = relative(directory, candidate);
  return offset === ""
    || (offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset));
}

export class NodeMirrorFileSystem implements MirrorFileSystem {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async exists(path: string): Promise<boolean> {
    const target = await this.safePath(path);
    try {
      await lstat(target);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async read(path: string): Promise<string | null> {
    return readOptional(await this.safePath(path));
  }

  async write(path: string, value: string): Promise<void> {
    const target = await this.safePath(path);
    await mkdir(dirname(target), { recursive: true });
    await atomicWrite(target, value);
  }

  async move(sourcePath: string, targetPath: string): Promise<void> {
    const source = await this.safePath(sourcePath);
    const target = await this.safePath(targetPath);
    await mkdir(dirname(target), { recursive: true });
    await rename(source, target);
    await syncDirectory(dirname(target));
    if (dirname(source) !== dirname(target)) await syncDirectory(dirname(source));
  }

  async remove(path: string): Promise<void> {
    const target = await this.safePath(path);
    if (await readOptional(target) !== null) await unlink(target);
  }

  async listMarkdown(excluded: ReadonlySet<string>): Promise<string[]> {
    const root = await realpath(this.root);
    const files: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (hiddenOrReservedMirrorEntry(entry.name)) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await visit(path);
        else if (entry.isFile() && entry.name.endsWith(".md")) {
          const pathValue = relative(root, path).split(sep).join("/");
          if (!excluded.has(pathValue)) files.push(pathValue);
        }
      }
    };
    await visit(root);
    files.sort();
    return files;
  }

  async listBinary(excluded: ReadonlySet<string>): Promise<string[]> {
    const root = await realpath(this.root);
    const files: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (hiddenOrReservedMirrorEntry(entry.name)) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await visit(path);
        else if (entry.isFile() && !entry.name.toLowerCase().endsWith(".md")) {
          const value = relative(root, path).split(sep).join("/");
          if (!excluded.has(value)) files.push(value);
        }
      }
    };
    await visit(root);
    files.sort();
    return files;
  }

  async inspectBinary(path: string): Promise<{ size: number; content_digest: `sha256:${string}` } | null> {
    const target = await this.safePath(path);
    let input;
    try {
      input = await open(target, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      const metadata = await input.stat();
      if (!metadata.isFile() || metadata.nlink !== 1) {
        throw new SyncError("invalid_path", "Mirror output must be one regular, non-hard-linked file.");
      }
      const hash = createHash("sha256");
      const buffer = new Uint8Array(64 * 1024);
      let size = 0;
      while (true) {
        const { bytesRead } = await input.read(buffer, 0, buffer.byteLength);
        if (bytesRead === 0) break;
        size += bytesRead;
        hash.update(buffer.subarray(0, bytesRead));
      }
      return { size, content_digest: `sha256:${hash.digest("hex")}` };
    } finally {
      await input.close();
    }
  }

  async readBinary(path: string): Promise<AsyncIterable<Uint8Array> | null> {
    const target = await this.safePath(path);
    let input;
    try {
      input = await open(target, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const metadata = await input.stat();
    if (!metadata.isFile() || metadata.nlink !== 1) {
      await input.close();
      throw new SyncError("invalid_path", "Mirror input must be one regular, non-hard-linked file.");
    }
    return (async function* (): AsyncGenerator<Uint8Array> {
      try {
        const buffer = new Uint8Array(64 * 1024);
        while (true) {
          const { bytesRead } = await input.read(buffer, 0, buffer.byteLength);
          if (bytesRead === 0) return;
          yield buffer.slice(0, bytesRead);
        }
      } finally {
        await input.close();
      }
    })();
  }

  async writeBinary(path: string, source: AsyncIterable<Uint8Array>): Promise<void> {
    const target = await this.safePath(path);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.mdbase-${randomUUID()}.tmp`;
    const output = await open(temporary, "wx", 0o600);
    try {
      for await (const chunk of source) await writeHandleAll(output, chunk);
      await output.sync();
      await output.close();
      await rename(temporary, target);
      await syncDirectory(dirname(target));
    } catch (error) {
      await output.close().catch(() => undefined);
      await unlinkOptional(temporary);
      throw error;
    }
  }

  private async safePath(relativePath: string): Promise<string> {
    if (
      relativePath.startsWith("/")
      || relativePath.includes("\\")
      || relativePath.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw new SyncError("invalid_path", "Mirror received an unsafe record path.");
    }
    const root = await realpath(this.root);
    const path = resolve(root, relativePath);
    if (path !== root && !path.startsWith(`${root}${sep}`)) {
      throw new SyncError("path_traversal", "Mirror path escaped its collection root.");
    }
    const parts = relativePath.split("/");
    let candidate = root;
    for (const [index, part] of parts.entries()) {
      candidate = join(candidate, part);
      try {
        const metadata = await lstat(candidate);
        if (metadata.isSymbolicLink()) {
          throw new SyncError("symlink_denied", "Mirror paths cannot traverse symbolic links.");
        }
        if (index < parts.length - 1 && !metadata.isDirectory()) {
          throw new SyncError("invalid_path", "Mirror path parent is not a directory.");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        throw error;
      }
    }
    return path;
  }
}

function hiddenOrReservedMirrorEntry(name: string): boolean {
  return name.startsWith(".")
    || ["node_modules", "_contracts", "_schemas", "_types", "_views"].includes(name.toLowerCase());
}

export class NodeMirrorBlobStore implements MirrorBlobStore {
  private directoryPromise: Promise<string> | null = null;

  constructor(
    private readonly root: string,
    private readonly stateRoot = process.env.MDBASE_CONNECT_MIRROR_STATE_DIR
  ) {}

  async has(contentDigest: `sha256:${string}`): Promise<boolean> {
    const path = await this.path(contentDigest);
    try {
      const metadata = await lstat(path);
      return metadata.isFile() && !metadata.isSymbolicLink();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async *read(contentDigest: `sha256:${string}`): AsyncGenerator<Uint8Array> {
    const path = await this.path(contentDigest);
    const input = await open(path, "r");
    try {
      const metadata = await input.stat();
      if (!metadata.isFile()) throw new SyncError("file_blob_missing", "A staged collection file is unavailable.");
      const buffer = new Uint8Array(64 * 1024);
      while (true) {
        const { bytesRead } = await input.read(buffer, 0, buffer.byteLength);
        if (bytesRead === 0) return;
        yield buffer.slice(0, bytesRead);
      }
    } finally {
      await input.close();
    }
  }

  async write(
    contentDigest: `sha256:${string}`,
    source: AsyncIterable<Uint8Array>
  ): Promise<void> {
    const target = await this.path(contentDigest);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    const output = await open(temporary, "wx", 0o600);
    try {
      for await (const chunk of source) await writeHandleAll(output, chunk);
      await output.sync();
      await output.close();
      await rename(temporary, target);
      await syncDirectory(dirname(target));
    } catch (error) {
      await output.close().catch(() => undefined);
      await unlinkOptional(temporary);
      throw error;
    }
  }

  async remove(contentDigest: `sha256:${string}`): Promise<void> {
    await unlinkOptional(await this.path(contentDigest));
  }

  async prune(retained: ReadonlySet<`sha256:${string}`>): Promise<void> {
    const directory = await this.directory();
    const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      if (
        !entry.isFile()
        || !/^[0-9a-f]{64}$/u.test(entry.name)
        || retained.has(`sha256:${entry.name}`)
      ) continue;
      await unlinkOptional(join(directory, entry.name));
    }
  }

  private async path(contentDigest: string): Promise<string> {
    if (!/^sha256:[0-9a-f]{64}$/u.test(contentDigest)) {
      throw new SyncError("invalid_file_digest", "Collection file digest is invalid.");
    }
    return join(await this.directory(), contentDigest.slice("sha256:".length));
  }

  private async directory(): Promise<string> {
    this.directoryPromise ??= mirrorDeviceDirectory(this.root, this.stateRoot)
      .then((path) => join(path, "file-blobs"));
    return this.directoryPromise;
  }
}

/** Node wrapper with automatic filesystem, state, and lease adapters. */
export class DirectoryMirror<Frontmatter extends JsonObject = JsonObject>
  extends PortableDirectoryMirror<Frontmatter> {
  constructor(
    root: string,
    replicaId: string,
    transport: SyncTransport<Frontmatter>,
    options: DirectoryMirrorOptions = {}
  ) {
    const resolvedRoot = resolve(root);
    const portableOptions: PortableDirectoryMirrorOptions = {
      stateStore: options.stateStore ?? new NodeMirrorStateStore(resolvedRoot),
      fileSystem: options.fileSystem ?? new NodeMirrorFileSystem(resolvedRoot),
      blobStore: options.blobStore ?? new NodeMirrorBlobStore(resolvedRoot),
      selectiveSync: options.selectiveSync,
      lease: options.lease ?? new NodeMirrorLease(resolvedRoot),
      runtime: options.runtime ?? nodeMirrorRuntime,
      onProgress: options.onProgress
    };
    super(replicaId, transport, portableOptions);
  }
}

/** Node wrapper for a writable mirror. */
export class WritableDirectoryMirror<Frontmatter extends JsonObject = JsonObject>
  extends PortableWritableDirectoryMirror<Frontmatter> {
  constructor(
    root: string,
    replicaId: string,
    transport: SyncTransport<Frontmatter>,
    options: DirectoryMirrorOptions = {}
  ) {
    const resolvedRoot = resolve(root);
    const portableOptions: PortableDirectoryMirrorOptions = {
      stateStore: options.stateStore ?? new NodeMirrorStateStore(resolvedRoot),
      fileSystem: options.fileSystem ?? new NodeMirrorFileSystem(resolvedRoot),
      blobStore: options.blobStore ?? new NodeMirrorBlobStore(resolvedRoot),
      selectiveSync: options.selectiveSync,
      lease: options.lease ?? new NodeMirrorLease(resolvedRoot),
      runtime: options.runtime ?? nodeMirrorRuntime,
      onProgress: options.onProgress
    };
    super(replicaId, transport, portableOptions);
  }
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readLeaseRecord(path: string): Promise<MirrorLeaseRecord | null> {
  const source = await readOptional(path);
  if (source === null) return null;
  try {
    const record = JSON.parse(source) as Partial<MirrorLeaseRecord>;
    if (
      record.version !== 1
      || typeof record.owner_id !== "string"
      || !Number.isSafeInteger(record.pid)
      || record.pid! <= 0
      || typeof record.acquired_at !== "string"
    ) return null;
    return record as MirrorLeaseRecord;
  } catch {
    return null;
  }
}

async function removeStaleLease(path: string): Promise<boolean> {
  const record = await readLeaseRecord(path);
  if (record === null || processIsAlive(record.pid)) return false;
  const current = await readLeaseRecord(path);
  if (
    current === null
    || current.owner_id !== record.owner_id
    || current.pid !== record.pid
  ) return false;
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function unlinkOptional(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function atomicWrite(path: string, value: string): Promise<void> {
  const temporary = `${path}.mdbase-${randomUUID()}.tmp`;
  const output = await open(temporary, "wx", 0o600);
  try {
    await output.writeFile(value, "utf8");
    await output.sync();
    await output.close();
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    await output.close().catch(() => undefined);
    await unlinkOptional(temporary);
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const directory = await open(path, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}

async function writeHandleAll(
  output: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await output.write(
      chunk,
      offset,
      chunk.byteLength - offset
    );
    if (bytesWritten <= 0) {
      throw new SyncError("mirror_write_failed", "Could not make progress writing collection file bytes.");
    }
    offset += bytesWritten;
  }
}
