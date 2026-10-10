/** First-party app ownership. Web Locks + exclusive SQLite handles are required;
 * a Worker is not an isolation boundary against JavaScript on this origin. */
export interface AppInstallationScope { readonly account: string; readonly installation: string }
export interface AppReplicaScope extends AppInstallationScope { readonly collection: string }
export class AppReplicaOwnerError extends Error {
  constructor(readonly reason: "invalid_scope" | "unavailable" | "busy" | "aborted" | "initialization_failed" | "shutdown_failed") {
    super(`app replica owner: ${reason}`);
    this.name = "AppReplicaOwnerError";
  }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Identical account/install/collection namespace to the app sahpool adapter. */
export function appReplicaLockName(scope: AppReplicaScope): string {
  const ids = [scope.account, scope.installation, scope.collection];
  if (ids.some((id) => typeof id !== "string" || !UUID.test(id))) throw new AppReplicaOwnerError("invalid_scope");
  return `mdbase-app-${ids.map((id) => id.toLowerCase()).join("-")}`;
}
/** Installation custody is single-owner across collection switches, BEFORE keys
 * are unwrapped or a native module opens. Collection locks alone do not do this. */
export function appInstallationLockName(scope: AppInstallationScope): string {
  const ids = [scope.account, scope.installation];
  if (ids.some(id => typeof id !== "string" || !UUID.test(id))) throw new AppReplicaOwnerError("invalid_scope");
  return `mdbase-app-installation-${ids.map(id => id.toLowerCase()).join("-")}`;
}
export interface AppLockPort {
  request(name: string, options: { mode: "exclusive"; ifAvailable: true }, hold: (lock: object | null) => Promise<void>): Promise<void>;
}
export interface AppReplicaLease {
  /** Call only AFTER all owned Workers/ports are stopped. Idempotent. */
  release(): Promise<void>;
}

/** Nonwaiting acquisition. Busy means attach to the owner or retry, never open a
 * second store. Signal cancels ACQUISITION only; it must not unlock a live Worker. */
export function acquireAppReplicaLease(locks: AppLockPort | undefined, scope: AppReplicaScope, signal?: AbortSignal): Promise<AppReplicaLease> {
  return acquireNamedLease(locks, appReplicaLockName(scope), signal);
}
export function acquireAppInstallationLease(locks: AppLockPort | undefined, scope: AppInstallationScope, signal?: AbortSignal): Promise<AppReplicaLease> {
  return acquireNamedLease(locks, appInstallationLockName(scope), signal);
}
/** Origin-local pre-account sign-in slot. No placeholder account or device keys.
 * Keep this lease until all pairing IO and protected ledger handles are closed. */
export function acquireAppSignInLease(locks: AppLockPort | undefined, scope: Readonly<{cpOrigin: string; appId: "tasknotes-web" | "tasknotes-mobile"}>, signal?: AbortSignal): Promise<AppReplicaLease> {
  const u = new URL(scope.cpOrigin);
  if (u.origin !== scope.cpOrigin || u.username || u.password || !["https:", "http:"].includes(u.protocol) || !["tasknotes-web", "tasknotes-mobile"].includes(scope.appId)) throw new AppReplicaOwnerError("invalid_scope");
  return acquireNamedLease(locks, `mdbase-app-sign-in-v1-${scope.appId}-${scope.cpOrigin}`, signal);
}
function acquireNamedLease(locks: AppLockPort | undefined, name: string, signal?: AbortSignal): Promise<AppReplicaLease> {
  if (!locks) return Promise.reject(new AppReplicaOwnerError("unavailable"));
  if (signal?.aborted) return Promise.reject(new AppReplicaOwnerError("aborted"));
  let stopHold!: () => void;
  const hold = new Promise<void>((resolve) => { stopHold = resolve; });
  let acquiredResolve!: (lease: AppReplicaLease) => void;
  let acquiredReject!: (error: unknown) => void;
  const acquired = new Promise<AppReplicaLease>((resolve, reject) => { acquiredResolve = resolve; acquiredReject = reject; });
  let cancelled = false;
  const onAbort = () => { cancelled = true; acquiredReject(new AppReplicaOwnerError("aborted")); };
  signal?.addEventListener("abort", onAbort, { once: true });
  // Schedule through a microtask so request is assigned even with a synchronous
  // test/host callback. ifAvailable + signal is forbidden by Web Locks; abort is
  // handled separately and never unlocks an already acquired owner.
  const request = Promise.resolve().then(() => locks.request(name, { mode: "exclusive", ifAvailable: true }, async (lock) => {
    signal?.removeEventListener("abort", onAbort);
    if (cancelled || signal?.aborted) { acquiredReject(new AppReplicaOwnerError("aborted")); return; }
    if (!lock) { acquiredReject(new AppReplicaOwnerError("busy")); return; }
    acquiredResolve({ release: () => { stopHold(); return request; } });
    await hold;
  }));
  void request.catch(() => { signal?.removeEventListener("abort", onAbort); acquiredReject(new AppReplicaOwnerError("unavailable")); });
  return acquired;
}

export interface AppOwnedWorker {
  /** Drain/close RPCs, keys and database handles. Does not certify any receipt. */
  stop(): Promise<void>;
  /** Fail-stop the Worker, even if graceful stop rejected or never completed. */
  terminate(): void;
}
export interface AppInstallationCustodyAuthority {
  readonly scope: Readonly<AppInstallationScope>;
  /** Owned initialization/lifetime only: true AFTER installation acquisition,
   * false once close/abort begins, even while termination retains the leases.
   * Trusted first-party host callback, not key isolation or a readiness proof. */
  isCurrent(): boolean;
}
export interface OwnedAppWorker<W extends AppOwnedWorker> {
  worker: W;
  readonly scope: Readonly<AppReplicaScope>;
  /** Stops/terminates before unlocking, including aborted openings. */
  close(): Promise<void>;
}

/** Create a Worker only after exclusive ownership. Its initialization receives the
 * caller's scope signal; no subscriptions are exposed until initialization resolves.
 * Lifetime abort closes the Worker, never just the owner lock. */
export async function openOwnedAppWorker<W extends AppOwnedWorker>(
  options: {
    locks: AppLockPort | undefined;
    scope: AppReplicaScope;
    create(scope: Readonly<AppReplicaScope>): W;
    initialize(worker: W, signal: AbortSignal | undefined, scope: Readonly<AppReplicaScope>, installation: AppInstallationCustodyAuthority): Promise<void>;
    signal?: AbortSignal;
    closeTimeoutMs?: number;
  },
): Promise<OwnedAppWorker<W>> {
  const timeoutMs = options.closeTimeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new RangeError("invalid Worker close timeout");
  // Pin all scope fields before the first await; callbacks use this snapshot,
  // not a caller object that may change while waiting for installation ownership.
  const signal = options.signal;
  const scope = Object.freeze({ account: options.scope.account, installation: options.scope.installation, collection: options.scope.collection });
  appReplicaLockName(scope); // validate collection before acquiring either lock
  const installation = await acquireAppInstallationLease(options.locks, scope, signal);
  let collection: AppReplicaLease;
  try { collection = await acquireAppReplicaLease(options.locks, scope, signal); }
  catch (error) { await installation.release(); throw error; }
  const lease: AppReplicaLease = { release: async () => { await collection.release(); await installation.release(); } };
  let worker: W;
  try {
    if (signal?.aborted) throw new AppReplicaOwnerError("aborted");
    worker = options.create(scope);
  } catch {
    await lease.release();
    throw new AppReplicaOwnerError(signal?.aborted ? "aborted" : "initialization_failed");
  }
  let closing: Promise<void> | undefined;
  const custodyAuthority: AppInstallationCustodyAuthority = Object.freeze({
    scope: Object.freeze({ account: scope.account, installation: scope.installation }),
    isCurrent: () => !closing && !signal?.aborted,
  });
  let abortOpening!: () => void;
  const aborted = new Promise<never>((_, reject) => { abortOpening = () => reject(new AppReplicaOwnerError("aborted")); });
  const close = (): Promise<void> => closing ??= (async () => {
    signal?.removeEventListener("abort", onAbort);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => worker.stop()),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
      ]);
    } catch {
      // Fail-stop below; graceful failure is not confirmation or rollback.
    } finally {
      if (timer) clearTimeout(timer);
    }
    try { worker.terminate(); } catch { throw new AppReplicaOwnerError("shutdown_failed"); }
    // If termination fails the lease deliberately stays held: no second writer.
    await lease.release();
  })();
  const onAbort = () => { abortOpening(); void close().catch(() => {}); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal?.aborted) throw new AppReplicaOwnerError("aborted");
    await Promise.race([Promise.resolve().then(() => options.initialize(worker, signal, scope, custodyAuthority)), aborted]);
    if (signal?.aborted || closing) throw new AppReplicaOwnerError("aborted");
    return { worker, scope, close };
  } catch {
    await close();
    throw new AppReplicaOwnerError(signal?.aborted ? "aborted" : "initialization_failed");
  }
}
