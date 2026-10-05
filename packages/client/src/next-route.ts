import { connectError } from "./errors.js";
import type { StoredToken } from "./internal-types.js";
import type { ConnectRequestOptions } from "./operation-types.js";
import { withRequestBudget } from "./request-budget.js";
import { admitNextPipe, type AuthenticatedRelayByteDuplex } from "./next-pipe.js";

export interface NextRouteTarget {
  readonly kind: "desktop" | "cli" | "hosted";
  readonly device: string;
  readonly noise_pk: string;
  readonly url: string;
  readonly relay_collection?: string;
  /** Preference snapshot only; not an authorization or reachability proof. */
  readonly online?: boolean;
}
export interface NextRouteResponse {
  readonly collection: string;
  readonly grant: string;
  readonly targets: readonly NextRouteTarget[];
  readonly reason?: "no_device_registered";
}
export interface MdbaseNext {
  route(collection: string, options?: ConnectRequestOptions): Promise<NextRouteResponse>;
  openPipe(collection: string, target: NextRouteTarget, options?: ConnectRequestOptions): Promise<AuthenticatedRelayByteDuplex>;
}

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
const invalid = () => connectError("invalid_operation_response", "Invalid Next route, authorization binding or relay destination.");
export function assertNextCollection(id: string): void {
  if (typeof id !== "string" || !UUID.test(id)) throw invalid();
}
function origin(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.origin !== value.replace(/\/$/u, "")) throw invalid();
    return url.origin;
  } catch { throw invalid(); }
}
function binding(token: StoredToken): string {
  if (!token.grantId || !UUID.test(token.grantId) || !token.keyHandle || !token.applicationOrigin
    || !token.clientId || token.authority || !token.accessToken || token.expiresAt <= Date.now() + 1000) throw invalid();
  return JSON.stringify([token.collectionId.toLowerCase(), token.grantId.toLowerCase(), token.clientId,
    token.keyHandle, token.applicationOrigin, token.savedAt]);
}
function targetKey(target: NextRouteTarget): string {
  return JSON.stringify([target.kind, target.device, target.noise_pk, target.url, target.relay_collection]);
}
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) throw invalid();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 65_536) throw invalid();
      chunks.push(value);
    }
  } catch { await reader.cancel().catch(() => {}); throw invalid(); }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw invalid(); }
}
function decode(raw: unknown, collection: string, grant: string, relayUrl: string): NextRouteResponse {
  if (!raw || typeof raw !== "object") throw invalid();
  const value = raw as Record<string, unknown>;
  if (typeof value.collection !== "string" || value.collection.toLowerCase() !== collection.toLowerCase()
    || typeof value.grant !== "string" || value.grant.toLowerCase() !== grant.toLowerCase()
    || !Array.isArray(value.targets) || value.targets.length > 64
    || (value.reason !== undefined && value.reason !== "no_device_registered")) throw invalid();
  const targets = value.targets.map(rawTarget => {
    if (!rawTarget || typeof rawTarget !== "object") throw invalid();
    const t = rawTarget as Record<string, unknown>;
    if (typeof t.kind !== "string" || !["desktop", "cli", "hosted"].includes(t.kind)
      || typeof t.device !== "string" || !UUID.test(t.device)
      || typeof t.noise_pk !== "string" || !/^[0-9a-f]{64}$/u.test(t.noise_pk) || /^0{64}$/u.test(t.noise_pk)
      || t.url !== relayUrl || typeof t.relay_collection !== "string" || !UUID.test(t.relay_collection)
      || (t.online !== undefined && typeof t.online !== "boolean")) throw invalid();
    return Object.freeze({ kind: t.kind, device: t.device, noise_pk: t.noise_pk, url: t.url,
      relay_collection: t.relay_collection, ...(t.online === undefined ? {} : { online: t.online }) }) as NextRouteTarget;
  });
  return Object.freeze({ collection: value.collection, grant: value.grant, targets: Object.freeze(targets),
    ...(value.reason ? { reason: value.reason as "no_device_registered" } : {}) });
}

/** Internal credential owner. Only its narrow MdbaseNext facade is public. */
export function connectionNext(context: {
  serverUrl: string;
  collection: string;
  current(): StoredToken | null;
  lease(signal: AbortSignal): Promise<{ token: StoredToken; release(): void }>;
}): MdbaseNext {
  const provenance = new WeakMap<NextRouteTarget, { collection: string; grant: string; binding: string; target: string }>();
  const config = () => {
    const cp = origin(context.serverUrl); // Before token lookup, lease, or network.
    return { cp, relay: `${cp.replace(/^https:/u, "wss:")}/v1/next/relay/client` };
  };
  const check = (expected: string) => {
    const current = context.current();
    if (!current || binding(current) !== expected) throw invalid();
  };
  const lookup = async (collection: string, token: StoredToken, expected: string, signal: AbortSignal) => {
    const { cp, relay } = config();
    check(expected);
    const response = await fetch(`${cp}/v1/next/collections/${collection}/route`, {
      headers: { Authorization: `Bearer ${token.accessToken}` }, credentials: "omit", redirect: "error", signal
    });
    const result = decode(await boundedJson(response), collection, token.grantId!, relay);
    check(expected);
    return result;
  };
  const validate = (collection: string) => {
    assertNextCollection(collection);
    if (collection.toLowerCase() !== context.collection.toLowerCase()) throw invalid();
    config();
  };
  return Object.freeze({
    async route(collection: string, options: ConnectRequestOptions = {}) {
      validate(collection);
      return withRequestBudget(options, 10_000, async budget => {
        const lease = await context.lease(budget.signal);
        try {
          const expected = binding(lease.token);
          const route = await lookup(collection, lease.token, expected, budget.signal);
          for (const target of route.targets) provenance.set(target, {
            collection: collection.toLowerCase(), grant: route.grant, binding: expected, target: targetKey(target)
          });
          return route;
        } finally { lease.release(); }
      });
    },
    async openPipe(collection: string, target: NextRouteTarget, options: ConnectRequestOptions = {}) {
      validate(collection);
      const prior = target && provenance.get(target);
      if (!prior || prior.collection !== collection.toLowerCase() || prior.target !== targetKey(target)) throw invalid();
      return withRequestBudget(options, 10_000, async budget => {
        check(prior.binding);
        const lease = await context.lease(budget.signal);
        // Released exactly once: by the pipe when it ends, or here if it never opened.
        let released = false;
        const release = () => { if (!released) { released = true; lease.release(); } };
        try {
          if (binding(lease.token) !== prior.binding) throw invalid();
          const fresh = await lookup(collection, lease.token, prior.binding, budget.signal);
          if (fresh.grant !== prior.grant || !fresh.targets.some(t => targetKey(t) === prior.target)) throw invalid();
          check(prior.binding);
          const pipe = await admitNextPipe({ url: target.url, signal: budget.signal,
            auth: JSON.stringify({ type: "pipe_auth", access_token: lease.token.accessToken,
              collection: target.relay_collection, grant: prior.grant, device: target.device, device_noise_pk: target.noise_pk }),
            check: () => check(prior.binding), release, lifetime: options.signal });
          return pipe;
        } catch (error) { release(); throw error; }
      });
    }
  });
}
