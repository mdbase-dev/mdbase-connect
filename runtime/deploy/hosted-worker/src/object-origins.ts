/** Network destination authority from deployment configuration ONLY, never a
 * capability/request/log/SQL value. Exact HTTPS origins, no wildcard/suffix match.
 * DNS for configured provider names is part of deployment trust. This does not
 * authenticate object bytes, grant permissions, or prove native durability.
 */
const MAX_ORIGINS = 16;
const BINDING_ORIGIN = "https://log.internal";

function parsed(uri: string): URL {
  if (!uri.startsWith("https://") || uri.length > 8192 || uri.includes("#") ||
      /[\s\\\x00-\x1f\x7f]/u.test(uri) || uri.slice(8).split(/[/?]/, 1)[0].includes("@"))
    throw new Error("object destination refused");
  let url: URL;
  try { url = new URL(uri); } catch { throw new Error("object destination refused"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new Error("object destination refused");
  return url;
}
function providerName(host: string): boolean {
  // URL normalizes alternative IPv4 spellings before this check. Reject all IP
  // literals (including global ones), localhost and local/single-label names.
  return host.length <= 253 && !/^[\d.]+$/.test(host) && !host.includes(":") &&
    !host.endsWith(".") && host.includes(".") &&
    !/(^|\.)(localhost|local|internal|home|lan)$/.test(host) &&
    host.split(".").every(label => label.length > 0 && label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
}

/** Immutable snapshot of a trusted deployment's providers and binding topology.
 * No public mutable array/Set; changing the original config after an await cannot
 * authorize a new destination. log.internal is NEVER an ordinary fetch target.
 */
export class ObjectOriginPolicy {
  readonly #origins: Set<string>;
  readonly #logBinding: boolean;
  private constructor(origins: Set<string>, logBinding: boolean) {
    this.#origins = origins;
    this.#logBinding = logBinding;
    Object.freeze(this);
  }
  static configured(origins: readonly string[], logBinding = false): ObjectOriginPolicy {
    if (origins.length > MAX_ORIGINS || typeof logBinding !== "boolean")
      throw new Error("invalid object destination configuration");
    const allowed = new Set<string>();
    for (const origin of origins) {
      const url = parsed(origin);
      if (url.pathname !== "/" || url.search || !providerName(url.hostname) ||
          (origin !== url.origin && origin !== `${url.origin}/`) || allowed.has(url.origin))
        throw new Error("invalid object destination configuration");
      allowed.add(url.origin);
    }
    return new ObjectOriginPolicy(allowed, logBinding);
  }
  destination(uri: string): { url: URL; viaLog: boolean } {
    const url = parsed(uri);
    if (url.origin === BINDING_ORIGIN && this.#logBinding) return { url, viaLog: true };
    if (!providerName(url.hostname) || !this.#origins.has(url.origin))
      throw new Error("object destination refused");
    return { url, viaLog: false };
  }
}
export const DENY_OBJECT_ORIGINS = ObjectOriginPolicy.configured([]);

/** Var provisioned by trusted deployment tooling, never inferred from a reply.
 * Empty config denies direct transfers. A real LOG binding may still carry them;
 * an HTTPS log adapter is not that binding. Invalid config denies both routes.
 */
export function deploymentObjectOrigins(env: { OBJECT_STORAGE_ORIGINS?: string; LOG?: Fetcher }): ObjectOriginPolicy {
  try {
    const raw = env.OBJECT_STORAGE_ORIGINS ?? "";
    if (raw.length > 8192) return DENY_OBJECT_ORIGINS;
    const origins = raw.trim() ? raw.split(",").map(s => s.trim()) : [];
    return ObjectOriginPolicy.configured(origins, !!env.LOG);
  } catch { return DENY_OBJECT_ORIGINS; }
}
