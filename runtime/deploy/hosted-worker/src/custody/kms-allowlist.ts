/** The hosted KMS collection allowlist: the exact collections this deployment's
 * KMS custody serves. Shared by the Worker (runtime lookup) and
 * build-kms-allowlist.mjs (build check). Erasable TypeScript only, so Node runs
 * the build script without a transform step.
 *
 * Canonical text: each lowercase, non-nil UUID followed by "\n", in strictly
 * ascending order (so no duplicates), nothing else. The empty text is the empty
 * (deny-all) allowlist. Its plain SHA-256 is the digest a deploy manifest pins.
 *
 * Every entry is exactly 37 bytes, so membership is a binary search over the
 * canonical text itself: no split array, no Set, O(log n) per lookup and one
 * O(n) validation pass per isolate.
 *
 * Allow-all: the exact text "*\n" (KMS_ALLOW_ALL_TEXT) admits every valid
 * collection ID. It is pinned by digest exactly like a list, and it is valid
 * only for the control plane's own hosted and escrow deployments in staging
 * and production (`deploymentKmsAllowlist`). A migration Worker, LAB, local
 * builds and the transitional secret cannot use it. The encryption context
 * still binds every ciphertext to its collection and device.
 */
import { sha256 } from "@noble/hashes/sha2.js";

/** Upper bound on entries. 100,000 entries are 3.7 MB of canonical text (about
 * 2 MB compressed), well inside the Worker script size limit next to the
 * engine; validation and hashing run once per isolate (tens of ms at the cap);
 * lookups take at most 17 comparisons. */
export const MAX_KMS_COLLECTIONS = 100_000;
export const KMS_ALLOWLIST_SCHEMA = "mdbn-hosted-kms-collections/1";
/** The canonical allow-all text. Not a UUID line, so it never collides with a list. */
export const KMS_ALLOW_ALL_TEXT = "*\n";
/** The only deployments an allow-all module may name: the CP's own service roles. */
export type KmsAllowAllRole = "hosted" | "escrow";

const ENTRY = 37;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const NIL = "00000000-0000-0000-0000-000000000000";
const HEX64 = /^[0-9a-f]{64}$/;

function fail(code: string): never { throw new Error(code); }
function validUuid(id: string): boolean { return UUID.test(id) && id !== NIL; }
function hex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Plain SHA-256 (lowercase hex) of the canonical text's UTF-8 (ASCII) bytes. */
export function kmsAllowlistDigest(text: string): string {
  return hex(sha256(new TextEncoder().encode(text)));
}

/** The canonical text of a set of collections (sorted, deduplicated). */
export function canonicalKmsAllowlist(ids: Iterable<string>): string {
  const sorted = [...new Set(ids)].sort();
  if (sorted.length > MAX_KMS_COLLECTIONS || !sorted.every(validUuid)) fail("kms_allowlist_invalid");
  return sorted.map(id => id + "\n").join("");
}

/** An immutable, validated allowlist over its canonical text. */
export class KmsAllowlist {
  readonly text: string;
  /** Listed entries; 0 for allow-all (which lists nothing and admits everything). */
  readonly size: number;
  readonly sha256: string;
  /** True only for the exact allow-all text. */
  readonly all: boolean;

  private constructor(text: string, digest: string, all: boolean) {
    this.text = text;
    this.all = all;
    this.size = all ? 0 : text.length / ENTRY;
    this.sha256 = digest;
  }

  /** Validate canonical text exactly (order, case, separators, bound). Refuses
   * rather than normalizing, so the pinned digest is always the text's own.
   * The exact allow-all text parses as allow-all; nothing else does. */
  static parse(text: string, expectedSha256?: string): KmsAllowlist {
    const all = text === KMS_ALLOW_ALL_TEXT;
    if (!all) {
      if (typeof text !== "string" || text.length % ENTRY !== 0 || text.length / ENTRY > MAX_KMS_COLLECTIONS) fail("kms_allowlist_invalid");
      let previous = "";
      for (let i = 0; i < text.length; i += ENTRY) {
        const id = text.slice(i, i + ENTRY - 1);
        if (text.charCodeAt(i + ENTRY - 1) !== 10 || !validUuid(id) || id <= previous) fail("kms_allowlist_invalid");
        previous = id;
      }
    }
    const digest = kmsAllowlistDigest(text);
    if (expectedSha256 !== undefined && (!HEX64.test(expectedSha256) || expectedSha256 !== digest)) fail("kms_allowlist_digest_mismatch");
    return new KmsAllowlist(text, digest, all);
  }

  /** From an unordered list (the transitional KMS_COLLECTIONS secret). UUIDs
   * only: a list can never express allow-all. */
  static fromList(ids: readonly string[]): KmsAllowlist {
    if (ids.length > MAX_KMS_COLLECTIONS) fail("kms_allowlist_invalid");
    return KmsAllowlist.parse(canonicalKmsAllowlist(ids));
  }

  has(id: string): boolean {
    if (typeof id !== "string" || id.length !== ENTRY - 1) return false;
    if (this.all) return validUuid(id);
    let lo = 0, hi = this.size - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const at = this.text.slice(mid * ENTRY, mid * ENTRY + ENTRY - 1);
      if (at === id) return true;
      if (at < id) lo = mid + 1; else hi = mid - 1;
    }
    return false;
  }

  /** Listed entries (none for allow-all). */
  *ids(): IterableIterator<string> {
    if (this.all) return;
    for (let i = 0; i < this.text.length; i += ENTRY) yield this.text.slice(i, i + ENTRY - 1);
  }

  equals(other: KmsAllowlist): boolean { return this.text === other.text; }
}

export interface KmsAllowlistChange {
  /** Newly served entries, or "all" when the change moves to allow-all. */
  added: number | "all";
  retired: number;
}

/**
 * The cumulative rule. A serving allowlist only grows: every collection the
 * previous deployment served must still be served, unless it is named in the
 * separate, explicit retire list. A retired collection must have been served
 * and must not be served again by the same change.
 *
 * Allow-all serves every collection, so any list -> allow-all is growth (and a
 * retire list cannot accompany it: every named ID is still served). Allow-all
 * -> any list is ALWAYS refused (`kms_allowlist_all_shrinks`), even with a
 * retire list: no list can name every collection that allow-all may already
 * be serving. Narrowing a serving allow-all deployment is an incident action
 * outside this rule (an IAM deny on the collection-id context, or a new
 * deployment built with --initial).
 */
export function cumulativeKmsAllowlist(previous: KmsAllowlist, next: KmsAllowlist, retire: KmsAllowlist | null): KmsAllowlistChange {
  if (retire?.all) fail("kms_allowlist_invalid");
  if (previous.all && !next.all) fail("kms_allowlist_all_shrinks");
  let retired = 0;
  if (retire) for (const id of retire.ids()) {
    if (!previous.has(id)) fail("kms_allowlist_retire_not_served");
    if (next.has(id)) fail("kms_allowlist_retire_still_served");
    retired++;
  }
  if (next.all) return { added: previous.all ? 0 : "all", retired };
  for (const id of previous.ids()) {
    if (!next.has(id) && !(retire?.has(id) ?? false)) fail("kms_allowlist_shrinks");
  }
  return { added: next.size - (previous.size - retired), retired };
}

/** The shape of the generated `#hosted-kms-collections` module. `role` is present
 * exactly when `text` is allow-all, and names the one CP role it was built for. */
export interface BundledKmsAllowlist {
  schema: typeof KMS_ALLOWLIST_SCHEMA;
  sha256: string;
  text: string;
  role?: KmsAllowAllRole;
}

/** What the running deployment is, from its own configuration (never a request).
 * `role` is the custody role being constructed; `serviceKind` is the declared
 * SERVICE_KIND var (absent on migration Workers); `migration` is true when any
 * migration binding is configured. */
export interface KmsDeployment {
  role: KmsAllowAllRole;
  serviceKind: string | undefined;
  migration: boolean;
}

const verified = new WeakMap<BundledKmsAllowlist, KmsAllowlist>();

/** Validate the bundled module once per isolate (memoized on its identity). */
export function bundledKmsAllowlist(bundle: BundledKmsAllowlist): KmsAllowlist {
  const known = verified.get(bundle);
  if (known) return known;
  if (!bundle || bundle.schema !== KMS_ALLOWLIST_SCHEMA || typeof bundle.sha256 !== "string") fail("kms_allowlist_invalid");
  const allowlist = KmsAllowlist.parse(bundle.text, bundle.sha256);
  // Allow-all must name its CP role; a list must not carry one.
  if (allowlist.all ? bundle.role !== "hosted" && bundle.role !== "escrow" : Object.hasOwn(bundle, "role")) fail("kms_allowlist_invalid");
  verified.set(bundle, allowlist);
  return allowlist;
}

/**
 * The deployment's allowlist.
 * - Bundled module present: it wins. The deployment must declare its digest
 *   (`KMS_COLLECTIONS_SHA256`, a plain var the deploy manifest pins) and the two
 *   must be equal. Staging/production use ONLY this module; an inherited obsolete
 *   KMS_COLLECTIONS binding is inert and may be removed independently.
 * - Allow-all: only a staging/production CP deployment whose declared
 *   SERVICE_KIND equals both the module's role and the custody role being built,
 *   with no migration binding. Anything else refuses `kms_allowlist_all_refused`.
 * - LAB/local compatibility: the source/test default still reads the secret,
 *   or checks its equality to a bundled module. Remove with the final legacy
 *   LAB/local build; it never admits a staging/production deployment.
 * Any digest disagreement refuses (the caller fails closed).
 */
export function deploymentKmsAllowlist(bundle: BundledKmsAllowlist | null, declaredSha256: string | undefined, secret: string | undefined,
  environment: string, deployment?: KmsDeployment): KmsAllowlist {
  if (!["local", "lab", "staging", "production"].includes(environment)) fail("kms_invalid_config");
  const transitional = environment === "lab" || environment === "local";
  if (!transitional && !bundle) fail("kms_allowlist_bundle_required");
  const legacy = transitional && secret !== undefined ? KmsAllowlist.fromList(secret.split(",").map(x => x.trim()).filter(Boolean)) : null;
  if (!bundle) {
    if (declaredSha256 !== undefined) fail("kms_allowlist_digest_mismatch");
    return legacy ?? KmsAllowlist.parse("");
  }
  const allowlist = bundledKmsAllowlist(bundle);
  if (declaredSha256 !== allowlist.sha256) fail("kms_allowlist_digest_mismatch");
  if (allowlist.all && (transitional || !deployment || deployment.migration
      || deployment.serviceKind !== bundle.role || deployment.role !== bundle.role)) fail("kms_allowlist_all_refused");
  if (legacy && !legacy.equals(allowlist)) fail("kms_allowlist_secret_disagrees");
  return allowlist;
}
