const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const AUTHORITY_PATH =
  /^\/v1\/authorities\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(operations|sync|files)$/i;

/**
 * A URL a client may send credentials or collection data to: HTTPS, or HTTP
 * on a loopback host for development, with no embedded credentials.
 */
export function serviceUrl(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const transport = url.protocol === "https:"
    || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
  return transport && !url.username && !url.password ? url : null;
}

/**
 * A token response's remote authority capability, bound to its collection:
 * operation, sync and file endpoints on one service origin, each at the exact
 * `/v1/authorities/<collection>/<endpoint>` path with no query or fragment.
 */
export function validAuthorityTokenResponse(value: unknown, collectionId: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (typeof collectionId !== "string") return false;
  const authority = value as {
    operations_url?: unknown;
    sync_url?: unknown;
    files_url?: unknown;
    replica_id?: unknown;
    access_token?: unknown;
    proof_public_key?: unknown;
  };
  if (
    typeof authority.replica_id !== "string"
    || authority.replica_id.length === 0
    || typeof authority.access_token !== "string"
    || authority.access_token.length === 0
    || (
      authority.proof_public_key !== undefined
      && (
        typeof authority.proof_public_key !== "string"
        || authority.proof_public_key.length === 0
      )
    )
  ) return false;
  const endpoints = [
    [authority.operations_url, "operations"],
    [authority.sync_url, "sync"],
    [authority.files_url, "files"]
  ] as const;
  const urls = endpoints.map(([value, endpoint]) => {
    const url = serviceUrl(value);
    const path = url && !url.search && !url.hash ? AUTHORITY_PATH.exec(url.pathname) : null;
    return path?.[1] === collectionId && path[2] === endpoint ? url : null;
  });
  return urls.every((url) => url !== null && url.origin === urls[0]!.origin);
}
