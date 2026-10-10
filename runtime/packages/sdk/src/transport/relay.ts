/**
 * Remote thin clients: a Noise IK session through mdbase's relay, or straight to the
 * hosted replica over a WebSocket (`replica-client-api.md` §12.3).
 *
 * The control plane's routing endpoint lists the targets for a collection: online
 * device replicas (private collections) or the hosted replica (cloud copy), each with
 * its device ID and Noise public key. How that endpoint is called, and the relay URL
 * format, belong to the control workstream; this module takes a `resolveRoute`
 * callback so they can change without touching the session code.
 */
import { uuidToBytes } from "../codec.js";
import { mdbaseError } from "../errors.js";
import type { Uuid } from "../wire.js";
import { clientPrologue, KeyPair, StaticKey } from "./noise.js";
import { noiseConnector, webSocketCarrier, WebSocketFactory } from "./noise-session.js";
import type { Connector } from "./port.js";
import { relayPipeCarrier } from "./relay-pipe.js";

export interface RelayRoute {
  /** WebSocket URL that reaches this target (relay session URL or the hosted replica). */
  url: string;
  /** The target replica's device ID. */
  targetDevice: Uuid;
  /** The target's enrolled Noise public key (32 bytes). */
  noisePublicKey: Uint8Array;
  /**
   * Set for the relay's Noise pipe (`/v1/next/relay/client`): the relay's
   * collection ID and the app's access token, sent in the first text frame. Absent for
   * a direct WebSocket to the hosted replica (one Noise message per WS message).
   */
  pipe?: { collection: string; accessToken: string };
}

export interface RelayConnectorOptions {
  collection: Uuid;
  /** The grant this client holds (absent only for a hosting app). */
  grant: Uuid | null;
  /** The grant's client key (`client_pk`); in browsers a non-extractable WebCrypto key. */
  staticKey: KeyPair | StaticKey;
  /**
   * Where to connect now. Return `null` when no target is reachable: for a private
   * collection that means none of the user's devices is online.
   */
  resolveRoute: () => Promise<RelayRoute | null>;
  webSocket?: WebSocketFactory;
}

/** A connector for web apps and other remote clients. */
export function relayConnector(o: RelayConnectorOptions): Connector {
  const collection = uuidToBytes(o.collection);
  const grant = o.grant ? uuidToBytes(o.grant) : null;
  return noiseConnector({
    description: `relay:${o.collection}`,
    staticKey: o.staticKey,
    target: async () => {
      const route = await o.resolveRoute();
      if (!route) {
        throw mdbaseError("unavailable", "no device of this collection is online", "no_device_online");
      }
      return {
        prologue: clientPrologue(collection, grant, uuidToBytes(route.targetDevice)),
        remoteStatic: route.noisePublicKey,
        device: route.targetDevice,
        openCarrier: (signal) =>
          route.pipe
            ? relayPipeCarrier(
                route.url,
                {
                  accessToken: route.pipe.accessToken,
                  collection: route.pipe.collection,
                  grant: o.grant ?? "",
                  device: route.targetDevice,
                  devicePublicKey: route.noisePublicKey,
                },
                o.webSocket,
                signal,
              )
            : webSocketCarrier(route.url, o.webSocket, signal),
      };
    },
  });
}
