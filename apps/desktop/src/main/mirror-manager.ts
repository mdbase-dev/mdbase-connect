import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface MirrorCloudCredential {
  serverUrl: string;
  connectorToken: string;
}

export interface MirrorConflictSummary {
  record_id: string;
  path: string | null;
  kind: "conflicted" | "rejected";
  message: string;
}

export interface DesktopMirrorSummary {
  collection_id: string;
  replica_id: string;
  name: string;
  mode: "read_only" | "read_write";
  path: string;
  state: "not_initialized" | "up_to_date" | "changes_waiting" | "attention" | "offline";
  pending: number;
  conflicts: MirrorConflictSummary[];
  cursor: number | null;
  last_synced_at: string | null;
  syncing: boolean;
  progress?: {
    phase: "uploading" | "applying";
    completed: number;
    total: number | null;
  };
  error?: string;
}

interface MirrorRegistryEntry {
  collection_id: string;
  replica_id: string;
  name: string;
  mode: "read_only" | "read_write";
  path: string;
  created_at: string;
}

interface MirrorRegistry {
  version: 1;
  mirrors: MirrorRegistryEntry[];
}

interface MirrorPairingResponse {
  pairing_id: string;
  pairing_secret: string;
}

interface MirrorExchangeResponse {
  status: "paired";
  replica: {
    id: string;
    collection_id: string;
    name: string;
    mode: "read_only" | "read_write";
  };
  token: string;
  token_expires_at: string;
  sync_url: string;
}

interface RuntimeState {
  syncing: boolean;
  progress?: DesktopMirrorSummary["progress"];
  error?: string;
}

const SYNC_INTERVAL_MS = 5_000;
const TOKEN_RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1_000;

export class MirrorManager {
  private entries: MirrorRegistryEntry[] = [];
  private readonly runtime = new Map<string, RuntimeState>();
  private timer: NodeJS.Timeout | null = null;
  private initialized = false;

  constructor(private readonly userData: string) {}

  async start(): Promise<void> {
    if (this.initialized) return;
    this.entries = await this.readRegistry();
    this.initialized = true;
    this.timer = setInterval(() => void this.syncAll(), SYNC_INTERVAL_MS);
    this.timer.unref();
    void this.syncAll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async list(): Promise<DesktopMirrorSummary[]> {
    await this.start();
    return Promise.all(this.entries.map((entry) => this.summary(entry)));
  }

  async connect(input: {
    collectionId: string;
    path: string;
    mode: "read_only" | "read_write";
    name?: string;
    cloud: MirrorCloudCredential;
    transferredAuthority?: boolean;
  }): Promise<DesktopMirrorSummary> {
    await this.start();
    const selectedPath = resolve(input.path);
    await mkdir(selectedPath, { recursive: true });
    const canonicalPath = await realpath(selectedPath);
    if (this.entries.some((entry) => pathsOverlap(entry.path, canonicalPath))) {
      throw new Error("That folder overlaps another collection mirror.");
    }
    const name = input.name?.trim()
      || `${hostname().trim() || "This computer"} mirror`;
    const pairing = await jsonRequest<MirrorPairingResponse>(
      `${input.cloud.serverUrl}/v1/mirror-pairing-requests`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mirror_name: name,
          mode: input.mode,
          collection_id: input.collectionId
        })
      }
    );
    await jsonRequest(
      `${input.cloud.serverUrl}/v1/connectors/mirror-pairing-requests/${pairing.pairing_id}/approve`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.cloud.connectorToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ collection_id: input.collectionId })
      }
    );
    const exchanged = await jsonRequest<MirrorExchangeResponse>(
      `${input.cloud.serverUrl}/v1/mirror-pairing-requests/${pairing.pairing_id}/exchange`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${pairing.pairing_secret}` }
      }
    );
    const {
      clearMirrorMarker,
      markMirror,
      saveMirrorProfile,
      transitionAuthorityToMirror
    } = await import("@mdbase/connect-sync/device");
    const entry: MirrorRegistryEntry = {
      collection_id: exchanged.replica.collection_id,
      replica_id: exchanged.replica.id,
      name: exchanged.replica.name,
      mode: exchanged.replica.mode,
      path: canonicalPath,
      created_at: new Date().toISOString()
    };
    let roleMarked = false;
    try {
      if (input.transferredAuthority) {
        await transitionAuthorityToMirror(canonicalPath, input.collectionId);
      } else {
        await markMirror(canonicalPath, input.collectionId);
      }
      roleMarked = true;
      await saveMirrorProfile(
        canonicalPath,
        {
          version: 1,
          sync_url: canonicalSyncUrl(
            exchanged.sync_url,
            exchanged.replica.collection_id
          ),
          control_url: canonicalOrigin(input.cloud.serverUrl),
          collection_id: exchanged.replica.collection_id,
          replica_id: exchanged.replica.id,
          mode: exchanged.replica.mode,
          name: exchanged.replica.name,
          enrollment_id: pairing.pairing_id,
          access_token_expires_at: exchanged.token_expires_at
        },
        {
          access_token: exchanged.token,
          refresh_token: pairing.pairing_secret
        },
        this.mirrorStateRoot()
      );
      this.entries.push(entry);
      await this.writeRegistry();
    } catch (error) {
      this.entries = this.entries.filter(
        (candidate) => candidate.replica_id !== exchanged.replica.id
      );
      await this.removeProfile(canonicalPath).catch(() => undefined);
      if (roleMarked && !input.transferredAuthority) {
        await clearMirrorMarker(canonicalPath, input.collectionId).catch(() => undefined);
      }
      await jsonRequest(
        `${input.cloud.serverUrl}/v1/connectors/hosted/replicas/${encodeURIComponent(exchanged.replica.id)}`,
        {
          method: "DELETE",
          headers: { authorization: `Bearer ${input.cloud.connectorToken}` }
        }
      ).catch(() => undefined);
      throw error;
    }
    await this.sync(entry);
    return this.summary(entry);
  }

  async syncNow(replicaId: string): Promise<DesktopMirrorSummary> {
    await this.start();
    const entry = this.entry(replicaId);
    await this.sync(entry);
    return this.summary(entry);
  }

  async resolveConflict(
    replicaId: string,
    recordId: string,
    resolution: "local" | "remote"
  ): Promise<DesktopMirrorSummary> {
    await this.start();
    const entry = this.entry(replicaId);
    if (entry.mode !== "read_write") {
      throw new Error("Receive-only mirrors do not have writable conflicts.");
    }
    const mirror = await this.mirrorFor(entry);
    await mirror.resolveConflict(recordId, resolution);
    await this.sync(entry);
    return this.summary(entry);
  }

  async remove(replicaId: string): Promise<void> {
    await this.start();
    const entry = this.entry(replicaId);
    const previous = this.entries;
    this.entries = this.entries.filter((candidate) => candidate.replica_id !== replicaId);
    this.runtime.delete(replicaId);
    try {
      await this.writeRegistry();
    } catch (error) {
      this.entries = previous;
      throw error;
    }
    await this.removeProfile(entry.path);
  }

  pathFor(replicaId: string): string | null {
    return this.entries.find((entry) => entry.replica_id === replicaId)?.path ?? null;
  }

  private async syncAll(): Promise<void> {
    if (!this.initialized) return;
    await Promise.allSettled(this.entries.map((entry) => this.sync(entry)));
  }

  private async sync(entry: MirrorRegistryEntry): Promise<void> {
    const current = this.runtime.get(entry.replica_id);
    if (current?.syncing) return;
    this.runtime.set(entry.replica_id, { syncing: true });
    try {
      const mirror = await this.mirrorFor(entry, (progress) => {
        this.runtime.set(entry.replica_id, {
          syncing: true,
          progress: {
            phase: progress.phase,
            completed: progress.completed,
            total: progress.total
          }
        });
      });
      const preview = await mirror.previewInitialization();
      if (preview.collisions.length > 0) {
        throw new Error(
          `Existing Markdown differs from the collection authority: ${preview.collisions.join(", ")}.`
        );
      }
      await mirror.sync();
      this.runtime.set(entry.replica_id, { syncing: false });
    } catch (error) {
      this.runtime.set(entry.replica_id, {
        syncing: false,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  private async summary(entry: MirrorRegistryEntry): Promise<DesktopMirrorSummary> {
    const runtime = this.runtime.get(entry.replica_id) ?? { syncing: false };
    try {
      const status = await (await this.mirrorFor(entry)).status();
      return {
        collection_id: entry.collection_id,
        replica_id: entry.replica_id,
        name: entry.name,
        path: entry.path,
        ...status,
        mode: entry.mode,
        syncing: runtime.syncing,
        ...(runtime.progress ? { progress: runtime.progress } : {}),
        ...(runtime.error ? { error: runtime.error } : {})
      };
    } catch (error) {
      return {
        collection_id: entry.collection_id,
        replica_id: entry.replica_id,
        name: entry.name,
        mode: entry.mode,
        path: entry.path,
        state: "offline",
        pending: 0,
        conflicts: [],
        cursor: null,
        last_synced_at: null,
        syncing: runtime.syncing,
        error: runtime.error ?? (error instanceof Error ? error.message : String(error))
      };
    }
  }

  private async mirrorFor(
    entry: MirrorRegistryEntry,
    onProgress?: (progress: {
      phase: "uploading" | "applying";
      completed: number;
      total: number | null;
      done: boolean;
    }) => void
  ) {
    const { HttpSyncTransport } = await import("@mdbase/connect-sync");
    const { DirectoryMirror, NodeMirrorStateStore, WritableDirectoryMirror } =
      await import("@mdbase/connect-sync/node");
    const stored = await this.currentProfile(entry);
    const transport = new HttpSyncTransport(
      stored.profile.sync_url,
      stored.credentials.access_token
    );
    const options = {
      stateStore: new NodeMirrorStateStore(entry.path, this.mirrorStateRoot()),
      ...(onProgress ? { onProgress } : {})
    };
    return entry.mode === "read_write"
      ? new WritableDirectoryMirror(entry.path, entry.replica_id, transport, options)
      : new DirectoryMirror(entry.path, entry.replica_id, transport, options);
  }

  private async currentProfile(entry: MirrorRegistryEntry) {
    const { loadMirrorProfile, updateMirrorCredentials } =
      await import("@mdbase/connect-sync/device");
    let stored = await loadMirrorProfile(entry.path, this.mirrorStateRoot());
    const expiry = stored.profile.access_token_expires_at;
    if (
      stored.profile.control_url
      && stored.profile.enrollment_id
      && stored.credentials.refresh_token
      && expiry
      && Date.parse(expiry) - Date.now() < TOKEN_RENEWAL_WINDOW_MS
    ) {
      const renewed = await jsonRequest<MirrorExchangeResponse>(
        `${stored.profile.control_url}/v1/mirror-pairing-requests/${stored.profile.enrollment_id}/renew`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${stored.credentials.refresh_token}` }
        }
      );
      stored = await updateMirrorCredentials(
        entry.path,
        {
          access_token: renewed.token,
          refresh_token: stored.credentials.refresh_token
        },
        renewed.token_expires_at,
        this.mirrorStateRoot()
      );
    }
    return stored;
  }

  private async removeProfile(path: string): Promise<void> {
    const { mirrorProfileDirectory } = await import("@mdbase/connect-sync/device");
    const profileDirectory = await mirrorProfileDirectory(path, this.mirrorStateRoot());
    await rm(profileDirectory, { recursive: true, force: true });
  }

  private entry(replicaId: string): MirrorRegistryEntry {
    const entry = this.entries.find((candidate) => candidate.replica_id === replicaId);
    if (!entry) throw new Error("That mirror is not controlled by this computer.");
    return entry;
  }

  private registryPath(): string {
    return join(this.userData, "mirrors.json");
  }

  private mirrorStateRoot(): string {
    return join(this.userData, "mirror-state");
  }

  private async readRegistry(): Promise<MirrorRegistryEntry[]> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.registryPath(), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error("Hosted mirror settings could not be read.");
    }
    if (!isMirrorRegistry(parsed)) {
      throw new Error("Hosted mirror settings are invalid.");
    }
    return parsed.mirrors.map((entry) => ({ ...entry, path: resolve(entry.path) }));
  }

  private async writeRegistry(): Promise<void> {
    const path = this.registryPath();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    const registry: MirrorRegistry = { version: 1, mirrors: this.entries };
    await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  }
}

function isMirrorRegistry(value: unknown): value is MirrorRegistry {
  if (!value || typeof value !== "object") return false;
  const registry = value as Partial<MirrorRegistry>;
  return registry.version === 1
    && Array.isArray(registry.mirrors)
    && registry.mirrors.every((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const candidate = entry as Partial<MirrorRegistryEntry>;
      return typeof candidate.collection_id === "string"
        && typeof candidate.replica_id === "string"
        && typeof candidate.name === "string"
        && ["read_only", "read_write"].includes(candidate.mode ?? "")
        && typeof candidate.path === "string"
        && isAbsolute(candidate.path)
        && typeof candidate.created_at === "string";
    });
}

function canonicalOrigin(value: string): string {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Hosted mirror services must use HTTPS outside local development.");
  }
  return url.origin;
}

function canonicalSyncUrl(value: string, collectionId: string): string {
  const url = new URL(value);
  const path = `/v1/authorities/${encodeURIComponent(collectionId)}/sync`;
  if (
    !["http:", "https:"].includes(url.protocol)
    || url.username
    || url.password
    || url.pathname.replace(/\/$/, "") !== path
    || url.search
    || url.hash
  ) {
    throw new Error("The authority returned an invalid sync URL.");
  }
  return `${url.origin}${path}`;
}

export function pathsOverlap(left: string, right: string): boolean {
  const fromLeft = relative(left, right);
  const fromRight = relative(right, left);
  return fromLeft === ""
    || (!fromLeft.startsWith("..") && !isAbsolute(fromLeft))
    || (!fromRight.startsWith("..") && !isAbsolute(fromRight));
}

async function jsonRequest<Result = unknown>(
  url: string,
  init: RequestInit
): Promise<Result> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const value = await response.json().catch(() => null) as {
    error?: { message?: string };
  } | null;
  if (!response.ok) {
    throw new Error(value?.error?.message ?? `Hosted mirror request failed with HTTP ${response.status}.`);
  }
  return value as Result;
}
