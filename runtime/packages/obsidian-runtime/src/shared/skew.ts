/**
 * The version-skew rule (`replica-client-api.md` §13, host eligibility).
 *
 * > A host older than the log's semantics major, or older than a runtime that is
 * > present, attaches as a client instead of hosting.
 *
 * Pure decisions only; `registry.ts` carries them out.
 */

/** Semantics version (`00-overview.md` §6.3). */
export interface Sem {
  readonly major: number;
  readonly minor: number;
}

/** A client API version (`major.minor`). */
export interface ApiVersion {
  readonly major: number;
  readonly minor: number;
}

/** What a runtime build declares when it registers. */
export interface RuntimeInfo {
  /** Runtime ABI major: the registry slot. Runtimes of different ABI majors never share a slot. */
  readonly abiMajor: number;
  /** The runtime build's version (semver), e.g. `1.4.0` or `1.5.0-rc.1`. */
  readonly runtimeVersion: string;
  /** The semantics version the runtime implements. */
  readonly sem: Sem;
  /** Client API versions this runtime serves as a host. */
  readonly serves: readonly ApiVersion[];
  /** Client API versions this runtime's own plugin side speaks. */
  readonly speaks: readonly ApiVersion[];
}

/** The outcome for one runtime that wants to use one collection. */
export type Role =
  | { readonly kind: "host" }
  | { readonly kind: "client"; readonly of: string; readonly api: ApiVersion }
  | { readonly kind: "handoff"; readonly from: string }
  | { readonly kind: "daemon" }
  | { readonly kind: "upgrade_required"; readonly reason: UpgradeReason };

/** Why a plugin is told to upgrade. */
export type UpgradeReason =
  /** The log's semantics ratchet is above this runtime and nobody newer hosts. */
  | "log_semantics_newer"
  /** The current host serves none of the API versions this runtime speaks. */
  | "host_api_incompatible";

/** What is known when a runtime asks for a collection. */
export interface SkewInput {
  readonly me: RuntimeInfo;
  /** The runtime currently hosting the collection in this process, if any. */
  readonly host: RuntimeInfo | null;
  /** The log's semantics ratchet (`min_sem_major` / highest major seen), if known. */
  readonly logSemMajor: number | null;
  /** The desktop daemon hosts this collection (it holds the folder lease). */
  readonly daemonHosts: boolean;
}

/** Compare semver strings (`MAJOR.MINOR.PATCH[-pre][+build]`). Build metadata is ignored. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    const d = pa.core[i]! - pb.core[i]!;
    if (d !== 0) return Math.sign(d);
  }
  // A version without pre-release ranks above one with it.
  if (pa.pre.length === 0 || pb.pre.length === 0) {
    return pa.pre.length === pb.pre.length ? 0 : pa.pre.length === 0 ? 1 : -1;
  }
  const n = Math.min(pa.pre.length, pb.pre.length);
  for (let i = 0; i < n; i++) {
    const x = pa.pre[i]!;
    const y = pb.pre[i]!;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Math.sign(Number(x) - Number(y));
    if (xn) return -1;
    if (yn) return 1;
    return x < y ? -1 : 1;
  }
  return Math.sign(pa.pre.length - pb.pre.length);
}

function parseSemver(v: string): { core: [number, number, number]; pre: string[] } {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v);
  if (!m) throw new Error(`not a semver version: ${v}`);
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
}

function compareSem(a: Sem, b: Sem): number {
  return a.major !== b.major ? Math.sign(a.major - b.major) : Math.sign(a.minor - b.minor);
}

/**
 * `a` is newer than `b`: a higher `sem`, or the same `sem` and a higher runtime
 * version (§13 step 3).
 */
export function isNewer(a: RuntimeInfo, b: RuntimeInfo): boolean {
  const s = compareSem(a.sem, b.sem);
  if (s !== 0) return s > 0;
  return compareSemver(a.runtimeVersion, b.runtimeVersion) > 0;
}

/** The highest API version both sides can use, or `null`. */
export function commonApi(clientSpeaks: readonly ApiVersion[], hostServes: readonly ApiVersion[]): ApiVersion | null {
  let best: ApiVersion | null = null;
  for (const c of clientSpeaks) {
    if (!hostServes.some((h) => h.major === c.major && h.minor === c.minor)) continue;
    if (!best || c.major > best.major || (c.major === best.major && c.minor > best.minor)) best = c;
  }
  return best;
}

/** Whether a runtime may host a log with this ratchet. */
export function mayHost(me: RuntimeInfo, logSemMajor: number | null): boolean {
  return logSemMajor === null || me.sem.major >= logSemMajor;
}

/**
 * Decide what `me` does with a collection (§13 steps 2–5).
 *
 * - The desktop daemon, when it hosts, always wins: plugins attach to it and
 *   act as the editor fence.
 * - No host in this process: host if the log's ratchet allows, else upgrade.
 * - A host exists and `me` is newer (and may host): hand off.
 * - Otherwise attach as a client when an API version is shared, else upgrade.
 */
export function decideRole(input: SkewInput): Role {
  const { me, host, logSemMajor, daemonHosts } = input;
  if (daemonHosts) return { kind: "daemon" };
  if (!host) {
    return mayHost(me, logSemMajor) ? { kind: "host" } : { kind: "upgrade_required", reason: "log_semantics_newer" };
  }
  if (host.runtimeVersion !== me.runtimeVersion && isNewer(me, host) && mayHost(me, logSemMajor)) {
    return { kind: "handoff", from: host.runtimeVersion };
  }
  const api = commonApi(me.speaks, host.serves);
  if (!api) return { kind: "upgrade_required", reason: "host_api_incompatible" };
  if (!mayHost(host, logSemMajor) && !mayHost(me, logSemMajor)) {
    return { kind: "upgrade_required", reason: "log_semantics_newer" };
  }
  return { kind: "client", of: host.runtimeVersion, api };
}
