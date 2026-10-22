/**
 * The SDK's one semantic-version implementation (SemVer 2.0.0): parsing and
 * precedence, prereleases included. Apps and SDK modules use this rather than
 * their own comparison. Build metadata never affects precedence.
 */
export interface MdbaseVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Prerelease identifiers: numeric ones as numbers, e.g. `rc.12` → ["rc", 12]. */
  readonly prerelease: readonly (string | number)[];
}

const NUM = "0|[1-9]\\d*", ID = `(?:${NUM}|\\d*[a-zA-Z-][0-9a-zA-Z-]*)`;
const VERSION = new RegExp(`^v?(${NUM})\\.(${NUM})\\.(${NUM})(?:-(${ID}(?:\\.${ID})*))?(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?$`);

/** Parse `1.2.3`, `0.3.0-rc.12`, `1.0.0+build`; null when it is not SemVer. */
export function parseVersion(value: unknown): MdbaseVersion | null {
  if (typeof value !== "string" || value.length > 256) return null;
  const m = VERSION.exec(value.trim());
  if (!m) return null;
  const parts = [m[1], m[2], m[3]].map(Number);
  if (parts.some(n => !Number.isSafeInteger(n))) return null;
  const prerelease = m[4] ? m[4].split(".").map(id => /^\d+$/.test(id) ? Number(id) : id) : [];
  if (prerelease.some(id => typeof id === "number" && !Number.isSafeInteger(id))) return null;
  return Object.freeze({ major: parts[0]!, minor: parts[1]!, patch: parts[2]!, prerelease: Object.freeze(prerelease) });
}

/** SemVer precedence: negative when a < b, 0 when equal, positive when a > b.
 * Null when either side is not a version. A release outranks its prereleases. */
export function compareVersions(a: string | MdbaseVersion, b: string | MdbaseVersion): number | null {
  const x = typeof a === "string" ? parseVersion(a) : a, y = typeof b === "string" ? parseVersion(b) : b;
  if (!x || !y) return null;
  for (const key of ["major", "minor", "patch"] as const) if (x[key] !== y[key]) return x[key] < y[key] ? -1 : 1;
  if (!x.prerelease.length && !y.prerelease.length) return 0;
  if (!x.prerelease.length) return 1;
  if (!y.prerelease.length) return -1;
  for (let i = 0; i < Math.max(x.prerelease.length, y.prerelease.length); i++) {
    const p = x.prerelease[i], q = y.prerelease[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    // Numeric identifiers rank below alphanumeric ones.
    if (typeof p === "number" && typeof q === "number") return p < q ? -1 : 1;
    if (typeof p === "number") return -1;
    if (typeof q === "number") return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** How an installed version relates to the version an app ships. Policy:
 * a newer install with the same major is compatible (read and write, keeping
 * fields the app does not know); a different major asks for an app update. */
export type MdbaseVersionRelation = "same" | "installed_older" | "installed_newer" | "installed_newer_major" | "unknown";

export function versionRelation(installed: string, wanted: string): MdbaseVersionRelation {
  const i = parseVersion(installed), w = parseVersion(wanted);
  const order = i && w ? compareVersions(i, w) : null;
  if (order === null) return "unknown";
  if (order === 0) return "same";
  if (order < 0) return "installed_older";
  return i!.major === w!.major ? "installed_newer" : "installed_newer_major";
}
