/**
 * The control plane's routing endpoint for mdbase-next apps:
 * `GET {server}/v1/next/collections/:id/route` with the app's access token.
 *
 * ```json
 * {"collection": "…", "grant": "…", "targets": [{"kind": "…", "device": "<uuid>",
 *   "noise_pk": "<64 hex>", "url": "wss://…/v1/next/relay/client", "relay_collection": "…"}],
 *  "reason": "no_device_registered"}
 * ```
 *
 * `routeFromControl` turns one response into the `RelayRoute` `relayConnector` wants,
 * and `controlRouteResolver` fetches it on every (re)connect, so the three app ports
 * share one mapping.
 */
import { fromHex } from "../cbor.js";
import { mdbaseError } from "../errors.js";
import type { RelayRoute } from "./relay.js";

export interface ControlRouteTarget {
  kind: string;
  device: string;
  noise_pk: string;
  url: string;
  relay_collection?: string;
}

export interface ControlRouteResponse {
  collection: string;
  grant: string;
  targets: ControlRouteTarget[];
  reason?: string;
}

/**
 * The first usable target, or `null` when there is none (the SDK then reports
 * `unavailable` / `no_device_online`; `no_device_registered` is kept as the reason).
 * Relay targets (with `relay_collection`) use the relay Noise pipe and need the
 * access token; others are direct WebSockets (the hosted replica).
 */
export function routeFromControl(res: ControlRouteResponse, accessToken: string): RelayRoute | null {
  for (const t of res.targets ?? []) {
    if (!/^[0-9a-f]{64}$/i.test(t.noise_pk) || !t.url || !t.device) continue;
    const route: RelayRoute = { url: t.url, targetDevice: t.device, noisePublicKey: fromHex(t.noise_pk) };
    if (t.relay_collection) route.pipe = { collection: t.relay_collection, accessToken };
    return route;
  }
  return null;
}

export interface ControlRouteOptions {
  /** Connect's HTTPS origin, e.g. `https://connect.mdbase.dev`. */
  server: string;
  /** The collection ID the app holds a grant for. */
  collection: string;
  /** The app's current access token (refreshed by the caller). */
  accessToken: () => Promise<string> | string;
  fetch?: typeof fetch;
}

/** A `resolveRoute` for `relayConnector`, backed by the control plane. */
export function controlRouteResolver(o: ControlRouteOptions): () => Promise<RelayRoute | null> {
  let server: URL;
  try {
    server = new URL(o.server);
  } catch {
    throw mdbaseError("invalid_request", "The control plane requires an HTTPS origin");
  }
  if (server.protocol !== "https:" || server.username || server.password || server.pathname !== "/" || server.search || server.hash) {
    throw mdbaseError("invalid_request", "The control plane requires an HTTPS origin without credentials, path, query or fragment");
  }
  // Snapshot the validated destination before retrieving any access token.
  const url = `${server.origin}/v1/next/collections/${encodeURIComponent(o.collection)}/route`;
  const f = o.fetch ?? globalThis.fetch.bind(globalThis);
  return async () => {
    const token = await o.accessToken();
    let res: Response;
    try {
      res = await f(url, { headers: { authorization: `Bearer ${token}` }, redirect: "error" });
    } catch {
      throw mdbaseError("unavailable", "cannot reach the control plane", "control_unreachable");
    }
    if (res.status === 401) throw mdbaseError("unauthenticated", "the control plane refused the access token");
    if (res.status === 409) {
      // The grant has no registered client key: consent must run again.
      throw mdbaseError("unauthenticated", "this app's key is not registered with its grant", "client_key_required");
    }
    if (!res.ok) throw mdbaseError("unavailable", `control plane answered ${res.status}`, "control_error");
    const body = (await res.json()) as ControlRouteResponse;
    const route = routeFromControl(body, token);
    if (!route && body.reason === "no_device_registered") {
      throw mdbaseError("unavailable", "this collection has no device set up to serve it", "no_device_registered");
    }
    return route;
  };
}
