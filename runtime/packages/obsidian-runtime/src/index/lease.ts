/**
 * The folder lease inside one Obsidian profile: a Web Lock per collection
 * (shared-origin ownership). IndexedDB, OPFS and Web Locks are shared by every plugin and every
 * vault window of the profile. The browser releases the lock when the holder's
 * realm dies (window closed, renderer crash), so no stale-lease handling is
 * needed in-app.
 *
 * The Web Lock does not exclude the desktop daemon or the `mdbase` library,
 * which take an OS lock on `<root>/.mdbase/host.lock` that Obsidian cannot take.
 * {@link tryAcquireFolderLease} is the in-app host's lease (detection/yield):
 * the Web Lock plus the folder host descriptor
 * `<root>/.mdbase/host.json` (`mdbn_local_host::host_lock`). It refuses while
 * another host's descriptor is live, publishes its own and heartbeats it, and
 * yields (`onLost`) as soon as it finds a descriptor that is not its own: the
 * daemon refuses to open over a fresh Obsidian descriptor and re-asserts its own
 * every 15 s while it holds the OS lock. Descriptor checks/publication are NOT
 * atomic against that OS lock: this is detection/yield, not cross-process mutual
 * exclusion. Shared exclusion or explicit residual acceptance remains required.
 */

/** A held lease. */
export interface Lease {
  readonly name: string;
  release(): void;
}

/** The lock name for a collection. */
export function leaseName(collectionId: string): string {
  return `mdbase:replica:${collectionId.toLowerCase()}`;
}

/** Take the lease if free; `null` if another context holds it. */
export function tryAcquireLease(collectionId: string, locks: LockManager = navigator.locks): Promise<Lease | null> {
  const name = leaseName(collectionId);
  return new Promise((resolve, reject) => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    locks
      .request(name, { mode: "exclusive", ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(null);
          return undefined;
        }
        resolve({ name, release });
        return held;
      })
      .catch(reject);
  });
}

/** `mdbn_local_host::HostKind`, as serialised. */
export type HostKind = "daemon" | "obsidian" | "library" | (string & {});

/** `mdbn_local_host::Descriptor` (`host.json`): diagnostics, no secrets. */
export interface HostDescriptor {
  readonly host: HostKind;
  readonly pid?: number;
  readonly device?: string;
  readonly since_ms: number;
  readonly heartbeat_ms: number;
}

/** Access to `<collection root>/.mdbase/host.json` (vault adapter on desktop). */
export interface HostDescriptorIo {
  /** The file's text, or `null` when there is none. Rejects if it exists but cannot be read. */
  read(): Promise<string | null>;
  /** Replace the file. */
  write(text: string): Promise<void>;
  /** Remove the file. */
  remove(): Promise<void>;
}

/** How often the in-app host refreshes its descriptor. */
export const HOST_HEARTBEAT_MS = 15_000;
/** A descriptor not refreshed for this long belongs to a dead host. */
export const HOST_DESCRIPTOR_STALE_MS = 60_000;
/** `mdbn_local_host::host_lock::MAX_DESCRIPTOR_BYTES`. */
export const MAX_DESCRIPTOR_BYTES = 4096;

/** Why the folder lease was refused or lost. */
export type FolderLeaseRefusal = "lease_held" | "hosted_by_daemon" | "hosted_elsewhere" | "descriptor_unreadable";

/** A held folder lease. */
export interface FolderLease extends Lease {
  /** Called once on descriptor loss/IO failure. Fence hosting immediately;
   * registration after loss also receives the latched reason. */
  onLost(cb: (reason: FolderLeaseRefusal) => void): void;
}

/** Options (tests inject time and timers). */
export interface FolderLeaseOptions {
  readonly locks?: LockManager;
  readonly now?: () => number;
  /** This host's identity in the descriptor (`device`); random by default. */
  readonly instance?: string;
  readonly pid?: number;
  /** Desktop: whether a process is alive (`process.kill(pid, 0)`); absent on mobile. */
  readonly pidAlive?: (pid: number) => boolean;
  readonly setInterval?: (f: () => void, ms: number) => unknown;
  readonly clearInterval?: (h: unknown) => void;
}

type Parsed = { kind: "absent" } | { kind: "unreadable" } | { kind: "present"; d: HostDescriptor };

/** Parse `host.json` as `mdbn_local_host` would; anything malformed is unreadable. */
export function parseHostDescriptor(text: string | null): Parsed {
  if (text === null) return { kind: "absent" };
  if (new TextEncoder().encode(text).length > MAX_DESCRIPTOR_BYTES) return { kind: "unreadable" };
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    const n = (x: unknown) => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
    if (typeof v !== "object" || v === null || typeof v.host !== "string" || !n(v.since_ms) || !n(v.heartbeat_ms)) {
      return { kind: "unreadable" };
    }
    if (v.pid !== undefined && v.pid !== null && !n(v.pid)) return { kind: "unreadable" };
    if (v.device !== undefined && v.device !== null && typeof v.device !== "string") return { kind: "unreadable" };
    return {
      kind: "present",
      d: {
        host: v.host,
        ...(typeof v.pid === "number" ? { pid: v.pid } : {}),
        ...(typeof v.device === "string" ? { device: v.device } : {}),
        since_ms: v.since_ms as number,
        heartbeat_ms: v.heartbeat_ms as number,
      },
    };
  } catch {
    return { kind: "unreadable" };
  }
}

/** Whether a foreign descriptor means the folder is hosted now. */
function live(d: HostDescriptor, now: number, pidAlive?: (pid: number) => boolean): boolean {
  const fresh = now - d.heartbeat_ms <= HOST_DESCRIPTOR_STALE_MS;
  if (d.host === "daemon" || d.host === "library") {
    // OS-lock hosts: the process is the truth where it can be checked. The
    // daemon heartbeats; the library does not, so without a check it is live.
    if (pidAlive && d.pid !== undefined) return pidAlive(d.pid);
    return d.host === "library" || fresh;
  }
  return fresh;
}

function randomInstance(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return `obsidian-${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Take the in-app host's folder lease: the Web Lock, then the folder host
 * descriptor. Refuses while the daemon, the library or another Obsidian host
 * is live on the folder, or when the descriptor cannot be read (fail closed).
 */
export async function tryAcquireFolderLease(
  collectionId: string,
  io: HostDescriptorIo,
  opts: FolderLeaseOptions = {},
): Promise<{ readonly lease: FolderLease } | { readonly refused: FolderLeaseRefusal }> {
  const now = opts.now ?? Date.now;
  const instance = opts.instance ?? randomInstance();
  const setI = opts.setInterval ?? ((f, ms) => setInterval(f, ms));
  const clearI = opts.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  const lease = await tryAcquireLease(collectionId, opts.locks);
  if (!lease) return { refused: "lease_held" };
  let handedOff = false;
  try {
  const read = async (): Promise<Parsed> => {
    try {
      return parseHostDescriptor(await io.read());
    } catch {
      return { kind: "unreadable" };
    }
  };
  const ours = (p: Parsed) => p.kind === "present" && p.d.host === "obsidian" && p.d.device === instance;
  const before = await read();
  if (before.kind === "unreadable") {
    lease.release();
    return { refused: "descriptor_unreadable" };
  }
  if (before.kind === "present" && !ours(before) && live(before.d, now(), opts.pidAlive)) {
    lease.release();
    return { refused: before.d.host === "daemon" ? "hosted_by_daemon" : "hosted_elsewhere" };
  }
  const since = now();
  const publish = (t: number) =>
    io.write(
      JSON.stringify({ host: "obsidian", ...(opts.pid !== undefined ? { pid: opts.pid } : {}), device: instance, since_ms: since, heartbeat_ms: t }),
    );
  await publish(since);
  if (!ours(await read())) {
    lease.release();
    return { refused: "hosted_elsewhere" };
  }
  const lost = new Set<(r: FolderLeaseRefusal) => void>();
  let done = false, beating = false;
  let inFlight: Promise<void> | null = null;
  let loss: FolderLeaseRefusal | null = null;
  let timer: unknown = null;
  const notify = (cb: (r: FolderLeaseRefusal) => void, reason: FolderLeaseRefusal) => {
    try { cb(reason); } catch { /* One consumer cannot prevent the others fencing. */ }
  };
  const releaseAfterDrain = () => {
    const pending = inFlight;
    if (pending) void pending.then(() => lease.release(), () => lease.release());
    else lease.release();
  };
  const lose = (reason: FolderLeaseRefusal) => {
    if (done) return;
    done = true;
    loss = reason;
    try {
      if (timer !== null) clearI(timer);
    } finally {
      for (const cb of lost) notify(cb, reason);
      releaseAfterDrain();
    }
  };
  const beat = async () => {
    if (done || beating) return;
    beating = true;
    try {
      const cur = await read();
      if (done) return;
      if (!ours(cur)) {
        // Missing/unreadable ownership is loss, not permission to republish.
        lose(cur.kind !== "present" ? "descriptor_unreadable" : cur.d.host === "daemon" ? "hosted_by_daemon" : "hosted_elsewhere");
        return;
      }
      await publish(now());
    } finally {
      beating = false;
    }
  };
  timer = setI(() => {
    if (done || inFlight) return;
    const pending = beat().catch(() => lose("descriptor_unreadable"));
    inFlight = pending;
    void pending.finally(() => { if (inFlight === pending) inFlight = null; }).catch(() => {});
  }, HOST_HEARTBEAT_MS);
  handedOff = true;
  return {
    lease: {
      name: lease.name,
      onLost: (cb) => {
        if (lost.has(cb)) return;
        lost.add(cb);
        if (loss !== null) notify(cb, loss);
      },
      release: () => {
        if (done) return;
        done = true;
        if (timer !== null) clearI(timer);
        // Remove the descriptor only while it is still ours, and only then
        // free the Web Lock, so another window never loses its fresh one.
        // An already-started publication cannot be cancelled by this IO seam.
        // Drain it before cleanup/unlock; no write may outlive Web Lock ownership.
        void (inFlight ?? Promise.resolve())
          .then(() => read())
          .then((cur) => (ours(cur) ? io.remove() : undefined))
          .catch(() => {})
          .finally(() => lease.release());
      },
    },
  };
  } finally {
    // Any initial publication, clock, verification or timer setup exception
    // must relinquish the acquired Web Lock before propagating to the caller.
    if (!handedOff) lease.release();
  }
}
