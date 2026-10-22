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
 */
import { sha256 } from "@noble/hashes/sha2.js";

/** Upper bound on entries. 100,000 entries are 3.7 MB of canonical text (about
 * 2 MB compressed), well inside the Worker script size limit next to the
 * engine; validation and hashing run once per isolate (tens of ms at the cap);
 * lookups take at most 17 comparisons. */
export const MAX_KMS_COLLECTIONS = 100_000;
export const KMS_ALLOWLIST_SCHEMA = "mdbn-hosted-kms-collections/1";

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
  readonly size: number;
  readonly sha256: string;

  private constructor(text: string, digest: string) {
    this.text = text;
    this.size = text.length / ENTRY;
    this.sha256 = digest;
  }

  /** Validate canonical text exactly (order, case, separators, bound). Refuses
   * rather than normalizing, so the pinned digest is always the text's own. */
  static parse(text: string, expectedSha256?: string): KmsAllowlist {
    if (typeof text !== "string" || text.length % ENTRY !== 0 || text.length / ENTRY > MAX_KMS_COLLECTIONS) fail("kms_allowlist_invalid");
    let previous = "";
    for (let i = 0; i < text.length; i += ENTRY) {
      const id = text.slice(i, i + ENTRY - 1);
      if (text.charCodeAt(i + ENTRY - 1) !== 10 || !validUuid(id) || id <= previous) fail("kms_allowlist_invalid");
      previous = id;
    }
    const digest = kmsAllowlistDigest(text);
    if (expectedSha256 !== undefined && (!HEX64.test(expectedSha256) || expectedSha256 !== digest)) fail("kms_allowlist_digest_mismatch");
    return new KmsAllowlist(text, digest);
  }

  /** From an unordered list (the transitional KMS_COLLECTIONS secret). */
  static fromList(ids: readonly string[]): KmsAllowlist {
    if (ids.length > MAX_KMS_COLLECTIONS) fail("kms_allowlist_invalid");
    return KmsAllowlist.parse(canonicalKmsAllowlist(ids));
  }

  has(id: string): boolean {
    if (typeof id !== "string" || id.length !== ENTRY - 1) return false;
    let lo = 0, hi = this.size - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const at = this.text.slice(mid * ENTRY, mid * ENTRY + ENTRY - 1);
      if (at === id) return true;
      if (at < id) lo = mid + 1; else hi = mid - 1;
    }
    return false;
  }

  *ids(): IterableIterator<string> {
    for (let i = 0; i < this.text.length; i += ENTRY) yield this.text.slice(i, i + ENTRY - 1);
  }

  equals(other: KmsAllowlist): boolean { return this.text === other.text; }
}

export interface KmsAllowlistChange {
  added: number;
  retired: number;
}

/**
 * The cumulative rule. A serving allowlist only grows: every collection the
 * previous deployment served must still be served, unless it is named in the
 * separate, explicit retire list. A retired collection must have been served
 * and must not be served again by the same change.
 */
export function cumulativeKmsAllowlist(previous: KmsAllowlist, next: KmsAllowlist, retire: KmsAllowlist | null): KmsAllowlistChange {
  let retired = 0;
  if (retire) for (const id of retire.ids()) {
    if (!previous.has(id)) fail("kms_allowlist_retire_not_served");
    if (next.has(id)) fail("kms_allowlist_retire_still_served");
    retired++;
  }
  for (const id of previous.ids()) {
    if (!next.has(id) && !(retire?.has(id) ?? false)) fail("kms_allowlist_shrinks");
  }
  return { added: next.size - (previous.size - retired), retired };
}

/** The shape of the generated `#hosted-kms-collections` module. */
export interface BundledKmsAllowlist {
  schema: typeof KMS_ALLOWLIST_SCHEMA;
  sha256: string;
  text: string;
}

const verified = new WeakMap<BundledKmsAllowlist, KmsAllowlist>();

/** Validate the bundled module once per isolate (memoized on its identity). */
export function bundledKmsAllowlist(bundle: BundledKmsAllowlist): KmsAllowlist {
  const known = verified.get(bundle);
  if (known) return known;
  if (!bundle || bundle.schema !== KMS_ALLOWLIST_SCHEMA || typeof bundle.sha256 !== "string") fail("kms_allowlist_invalid");
  const allowlist = KmsAllowlist.parse(bundle.text, bundle.sha256);
  verified.set(bundle, allowlist);
  return allowlist;
}

/**
 * The deployment's allowlist.
 * - Bundled module present: it wins. The deployment must declare its digest
 *   (`KMS_COLLECTIONS_SHA256`, a plain var the deploy manifest pins) and the two
 *   must be equal. A transitional `KMS_COLLECTIONS` secret, if still set, must
 *   list exactly the same collections.
 * - No bundled module (source/test default): the transitional secret alone.
 * Any disagreement refuses (the caller fails closed).
 */
export function deploymentKmsAllowlist(bundle: BundledKmsAllowlist | null, declaredSha256: string | undefined, secret: string | undefined): KmsAllowlist {
  const legacy = secret === undefined ? null : KmsAllowlist.fromList(secret.split(",").map(x => x.trim()).filter(Boolean));
  if (!bundle) {
    if (declaredSha256 !== undefined) fail("kms_allowlist_digest_mismatch");
    return legacy ?? KmsAllowlist.parse("");
  }
  const allowlist = bundledKmsAllowlist(bundle);
  if (declaredSha256 !== allowlist.sha256) fail("kms_allowlist_digest_mismatch");
  if (legacy && !legacy.equals(allowlist)) fail("kms_allowlist_secret_disagrees");
  return allowlist;
}
