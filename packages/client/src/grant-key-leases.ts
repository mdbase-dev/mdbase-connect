import type { StoredToken } from "./internal-types.js";

interface WebLockManager {
  request<Result>(
    name: string,
    options: { mode: "shared" | "exclusive"; signal?: AbortSignal },
    callback: () => Result | PromiseLike<Result>
  ): Promise<Result>;
}

export class GrantKeyLeaseRegistry {
  private readonly leases = new Map<string, Map<string, number>>();
  private readonly locks = webLockManager();
  readonly retainAutomaticallyRetiredKeys = this.locks === null;

  constructor(
    private readonly namespace: string,
    private readonly onFinalRelease: (collectionId: string, keyHandle: string) => void
  ) {}

  async acquire(collectionId: string, keyHandle: string, signal?: AbortSignal): Promise<() => void> {
    const releaseLocal = this.acquireLocal(collectionId, keyHandle);
    if (!this.locks) return releaseLocal;
    try {
      const releaseWeb = await acquireSharedWebLock(
        this.locks,
        this.lockName(collectionId, keyHandle),
        signal
      );
      return once(() => {
        releaseWeb();
        releaseLocal();
      });
    } catch (error) {
      releaseLocal();
      throw error;
    }
  }

  deleteExclusive(
    collectionId: string,
    keyHandle: string,
    action: () => void | Promise<void>
  ): void {
    if (this.retainAutomaticallyRetiredKeys) return;
    if (this.locks) {
      void this.locks.request(
        this.lockName(collectionId, keyHandle),
        { mode: "exclusive" },
        action
      ).catch(() => undefined);
    } else if (!this.has(collectionId, keyHandle)) {
      void Promise.resolve().then(action).catch(() => undefined);
    }
  }

  has(collectionId: string, keyHandle: string): boolean {
    return this.leases.get(collectionId)?.has(keyHandle) ?? false;
  }

  handles(collectionId: string): Iterable<string> {
    return this.leases.get(collectionId)?.keys() ?? [];
  }

  private acquireLocal(collectionId: string, keyHandle: string): () => void {
    const collection = this.leases.get(collectionId) ?? new Map<string, number>();
    collection.set(keyHandle, (collection.get(keyHandle) ?? 0) + 1);
    this.leases.set(collectionId, collection);
    return once(() => {
      const remaining = (collection.get(keyHandle) ?? 1) - 1;
      if (remaining > 0) collection.set(keyHandle, remaining);
      else {
        collection.delete(keyHandle);
        if (collection.size === 0) this.leases.delete(collectionId);
        this.onFinalRelease(collectionId, keyHandle);
      }
    });
  }

  private lockName(collectionId: string, keyHandle: string): string {
    return `mdbase-connect:grant-key:${this.namespace}:${collectionId}:${keyHandle}`;
  }
}

export class GrantKeyLeaseSet {
  private readonly releases = new Map<string, Promise<() => void>>();

  constructor(
    private readonly collectionId: string,
    private readonly acquire: (
      collectionId: string,
      keyHandle: string,
      signal?: AbortSignal
    ) => Promise<() => void>
  ) {}

  async retain(
    tokenOrHandle: StoredToken | string | null | undefined,
    signal?: AbortSignal
  ): Promise<void> {
    const handle = typeof tokenOrHandle === "string" ? tokenOrHandle : tokenOrHandle?.keyHandle;
    if (!handle) return;
    let lease = this.releases.get(handle);
    if (!lease) {
      lease = this.acquire(this.collectionId, handle, signal);
      this.releases.set(handle, lease);
    }
    try {
      await lease;
    } catch (error) {
      if (this.releases.get(handle) === lease) this.releases.delete(handle);
      this.release();
      throw error;
    }
  }

  release(): void {
    for (const lease of this.releases.values()) void lease.then((release) => release());
    this.releases.clear();
  }
}

export async function retainCurrentGrantToken(
  readCurrent: () => StoredToken | null,
  leases: GrantKeyLeaseSet,
  signal?: AbortSignal
): Promise<StoredToken | null> {
  while (true) {
    const snapshot = readCurrent();
    if (!snapshot) return null;
    await leases.retain(snapshot, signal);
    const current = readCurrent();
    if (!current) return null;
    if (current.keyHandle === snapshot.keyHandle) return current;
  }
}

function webLockManager(): WebLockManager | null | undefined {
  const locks = typeof navigator === "undefined"
    ? undefined
    : (navigator as Navigator & { locks?: WebLockManager }).locks;
  if (locks) return locks;
  const browser = typeof window !== "undefined"
    || typeof (globalThis as { importScripts?: unknown }).importScripts === "function";
  return browser ? null : undefined;
}

async function acquireSharedWebLock(
  locks: WebLockManager,
  name: string,
  signal?: AbortSignal
): Promise<() => void> {
  let acquired!: () => void;
  let rejectAcquisition!: (error: unknown) => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve, reject) => {
    acquired = resolve;
    rejectAcquisition = reject;
  });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const request = locks.request(name, { mode: "shared", ...(signal ? { signal } : {}) }, async () => {
    acquired();
    await held;
  });
  void request.catch(rejectAcquisition);
  await ready;
  return once(release);
}

function once(action: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    action();
  };
}
