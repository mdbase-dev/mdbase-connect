/**
 * Opt-in mdbase-next bridge (`@mdbase-dev/connect/next`): authenticated routing and
 * relay pipes for a retained Connect grant. The access token never leaves this
 * package; callers receive route metadata and an authenticated byte duplex that the
 * mdbase-next SDK frames and runs Noise IK over.
 *
 * Kept out of the root, /advanced and /crypto entries (and so out of the classic
 * browser bundle).
 */
import type { MdbaseConnection } from "./connection.js";
import { connectError } from "./errors.js";
import { retainCurrentGrantToken } from "./grant-key-leases.js";
import { connectionNext, type MdbaseNext } from "./next-route.js";

export type { MdbaseNext, NextRouteResponse, NextRouteTarget } from "./next-route.js";
export type { AuthenticatedRelayByteDuplex } from "./next-pipe.js";

const bridges = new WeakMap<object, MdbaseNext>();

/**
 * The Next bridge of one connected collection. Route targets are bound to the
 * bridge that returned them: `openPipe` accepts only a target from this bridge's
 * own `route`, re-fetched and revalidated before the pipe opens.
 */
export function mdbaseNext(connection: MdbaseConnection): MdbaseNext {
  const cached = bridges.get(connection);
  if (cached) return cached;
  // Internal access without adding members to the bundled connection classes.
  const transport = connection["transport"];
  const bridge = connectionNext({
    serverUrl: transport["serverUrl"],
    collection: transport["collectionId"],
    current: () => transport.currentToken(),
    lease: async signal => {
      const leases = transport["grantKeyLeases"]();
      try {
        const token = await retainCurrentGrantToken(() => transport.currentToken(), leases, signal);
        if (!token) throw connectError("not_authorized", "Connect this application before accessing a collection.");
        return { token, release: () => leases.release() };
      } catch (error) {
        leases.release();
        throw error;
      }
    }
  });
  bridges.set(connection, bridge);
  return bridge;
}
