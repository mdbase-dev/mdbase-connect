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
/** Opaque registry identifier, bounded for origin-local storage/lock namespaces. */
export function isAppInstallationId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64 && !/[^A-Za-z0-9_-]/.test(value);
}
/** The same bounded protected owner used by the sign-in and grant stores. */
export function isInstallationOwner(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 256 && !/[\u0000-\u001f\u007f]/.test(v);
}
function appSignInLockName(scope: Readonly<{cpOrigin: string; appId: string; owner?: string}>): string {
  const u = new URL(scope.cpOrigin);
  if (u.origin !== scope.cpOrigin || u.username || u.password || !["https:", "http:"].includes(u.protocol) || !isAppInstallationId(scope.appId)) throw new AppReplicaOwnerError("invalid_scope");
  // Unowned callers retain their original namespace. Owned callers lock the
  // exact protected store, so a scoped child cannot collide with its live root.
  if (scope.owner === undefined) return `mdbase-app-sign-in-v1-${scope.appId}-${scope.cpOrigin}`;
  if (!isInstallationOwner(scope.owner)) throw new AppReplicaOwnerError("invalid_scope");
  return `mdbase-app-sign-in-v2-${JSON.stringify([scope.cpOrigin, scope.owner, scope.appId])}`;
}
export function acquireAppSignInLease(locks: AppLockPort | undefined, scope: Readonly<{cpOrigin: string; appId: string; owner?: string}>, signal?: AbortSignal): Promise<AppReplicaLease> {
  const ownedName = appSignInLockName(scope);
  const legacyName = appSignInLockName({cpOrigin: scope.cpOrigin, appId: scope.appId});
  if (scope.owner === undefined) return acquireNamedLease(locks, legacyName, signal);
  return (async () => {
    // Older OWNED builds also held v1. Taking both excludes those roots without
    // changing the protected ledger or treating a name as recovery authority.
    const legacy = await acquireNamedLease(locks, legacyName, signal);
    try {
      const owned = await acquireNamedLease(locks, ownedName, signal);
      return {release: async () => {await owned.release(); await legacy.release();}};
    } catch (error) {await legacy.release(); throw error;}
  })();
}
/** Internal scoped-facade bridge. The root takes REAL v1 for its whole lifetime;
 * its fixed root/child composition borrows that guard while each protected store
 * also takes its real owner-v2 lease. All native custody requests pass through.
 * Compatibility consumer: older owned SDK builds whose sole sign-in lease is v1.
 * Remove this bridge only when those builds are no longer supported. */
export function createAppSignInRootGuard(locks: AppLockPort, scope: Readonly<{cpOrigin: string; appId: string}>, signal: AbortSignal): {locks: AppLockPort; close(): Promise<void>} {
  const name = appSignInLockName({cpOrigin: scope.cpOrigin, appId: scope.appId});
  let root: Promise<AppReplicaLease> | null = null, closed = false, borrowers = 0;
  const guarded: AppLockPort = {
    request: async (requested, options, hold) => {
      if (closed) throw new AppReplicaOwnerError("aborted");
      if (requested !== name) return locks.request(requested, options, hold);
      root ??= acquireNamedLease(locks, name, signal).catch(error => {root = null; throw error;});
      try {await root;} catch (error) {
        // Preserve Web Locks ifAvailable semantics and the typed busy outcome.
        if (error instanceof AppReplicaOwnerError && error.reason === "busy") return hold(null);
        throw error;
      }
      if (closed) throw new AppReplicaOwnerError("aborted");
      ++borrowers;
      try {await hold({});} finally {--borrowers;}
    },
  };
  return {locks: guarded, close: async () => {
    closed = true;
    // Closing all original stores must precede releasing the migration guard.
    // A failed drain retains it until Worker termination, never a second owner.
    if (borrowers !== 0) throw new AppReplicaOwnerError("shutdown_failed");
    let lease: AppReplicaLease;
    try {if (!root) return; lease = await root;} catch {return;} // failed acquisition owns nothing
    await lease.release();
  }};
}
/** Waiting (not owning) side of the Web Locks API. */
export interface AppLockWaitPort {
  request(name: string, options: { mode: "shared"; signal: AbortSignal }, granted: (lock: object | null) => Promise<void>): Promise<void>;
}
/** Resolves once no other tab holds this app's sign-in slot (the "open in
 * another tab" case). Shared and released at once: it never owns the slot, so
 * the caller still acquires it normally and may lose to a faster tab. */
export function waitForAppSignInRelease(locks: AppLockWaitPort, scope: Readonly<{cpOrigin: string; appId: string; owner?: string}>, signal: AbortSignal): Promise<void> {
  try { return locks.request(appSignInLockName(scope), { mode: "shared", signal }, async () => {}); }
  catch (error) { return Promise.reject(error); }
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
