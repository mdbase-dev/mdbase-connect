import { createHash, randomUUID } from "node:crypto";
import {
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
import type { JsonObject } from "@mdbase-dev/connect-protocol";
import type { SyncTransport } from "./index.js";
import { SyncError } from "./index.js";
import {
  DirectoryMirror as PortableDirectoryMirror,
  WritableDirectoryMirror as PortableWritableDirectoryMirror,
  type AcquiredMirrorLease,
  type DirectoryMirrorOptions as PortableDirectoryMirrorOptions,
  type MirrorFileSystem,
  type MirrorLease,
  type MirrorProgress,
  type MirrorRuntime,
  type MirrorState,
  type MirrorStateStore
} from "./mirror.js";

export {
  authorityManifestDigest,
  MemoryMirrorLease,
  MemoryMirrorStateStore,
  MirrorDivergenceError,
  MirrorInitializationConflictError,
  portableMirrorRuntime,
  recordMarkdownDocument,
  WritableMirrorConflictError,
  WritableMirrorRejectedError,
  type AcquiredMirrorLease,
  type AuthorityPromotionManifest,
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
      return JSON.parse(value) as MirrorState;
    } catch {
      throw new SyncError("invalid_mirror_state", "Mirror metadata is corrupt.");
    }
  }

  async write(state: MirrorState): Promise<void> {
    const path = await this.path();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await atomicWrite(path, `${JSON.stringify(state, null, 2)}\n`);
  }

  async directory(): Promise<string> {
    return dirname(await this.path());
  }

  private path(): Promise<string> {
    this.statePath ??= mirrorDeviceDirectory(this.root, this.stateRoot)
      .then((directory) => join(directory, "mirror-state.json"));
    return this.statePath;
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

  async read(path: string): Promise<string | null> {
    return readOptional(await this.safePath(path));
  }

  async write(path: string, value: string): Promise<void> {
    const target = await this.safePath(path);
    await mkdir(dirname(target), { recursive: true });
    await atomicWrite(target, value);
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
        if (entry.name === ".mdbase") continue;
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
  await writeFile(temporary, value, { mode: 0o600 });
  await rename(temporary, path);
}
