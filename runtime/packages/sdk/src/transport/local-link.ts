/**
 * The localhost link between the Obsidian runtime and the desktop daemon
 * (`replica-client-api.md` §12.4):
 *
 * - `ws://127.0.0.1:<port>/v1/plugin`, port and per-start token from the daemon's
 *   owner-only `local-link.json` (read by the host: `readLocalLink` in
 *   `@mdbase-dev/sdk/node`, or the plugin's own desktop file API);
 * - the daemon's Noise key from its owner-only `daemon.json` is **pinned** as the IK
 *   responder key, so a process squatting on the port fails the handshake;
 * - the 64-byte prologue goes first in clear (one WebSocket message), then Noise
 *   message 1 whose encrypted payload is `{0: token, 1: hello-params}`: the token never
 *   appears in a URL or in clear;
 * - prologue: `"mdbase/v1/client" ‖ collection ‖ 16 zero bytes ‖ daemon device ID`
 *   (zero device ID for a local-only collection); the zero grant marks the hosting
 *   session;
 * - message 2 carries the `hello` response frame; frames as §12.3;
 * - the daemon serves the session only if the user linked this static key to the
 *   collection on screen (`link_not_approved` otherwise), and only the data, holds,
 *   files, presence and fence methods (anything else: `confirm_in_daemon_ui`).
 */
import { CborValue, encode } from "../cbor.js";
import { uuidToBytes } from "../codec.js";
import { mdbaseError } from "../errors.js";
import { clientFrame, Uuid } from "../wire.js";
import { clientPrologue, generateKeyPair, KeyPair, StaticKey } from "./noise.js";
import { noiseConnector, webSocketCarrier, WebSocketFactory } from "./noise-session.js";
import type { Connector } from "./port.js";

export interface LocalLink {
  port: number;
  /** 32 bytes, fresh at each daemon start. */
  token: Uint8Array;
  /** The daemon's device ID (`daemon.json`). */
  device: Uuid;
  /** The daemon's replica Noise public key (`daemon.json`): pinned. */
  noisePublicKey: Uint8Array;
}

export interface LocalLinkConnectorOptions {
  link: LocalLink | (() => Promise<LocalLink>);
  collection: Uuid;
  /** A local-only collection uses the zero device ID in the prologue. */
  localOnly?: boolean;
  /**
   * Initiator static key. Pass a key kept for this plugin installation: the daemon
   * serves a collection on the link only to a key the user linked to it on screen
   * (once per collection and key). The token only proves the plugin
   * can read the link file. An ephemeral key (the default) asks the user every time.
   */
  staticKey?: KeyPair | StaticKey;
  /** WebSocket factory (Obsidian desktop: the global WebSocket, Origin app://obsidian.md). */
  webSocket?: WebSocketFactory;
}

const ZERO16 = new Uint8Array(16);

/** `{0: token, 1: hello-params}`, canonical, from the `hello` request frame. */
export function localLinkFirstPayload(token: Uint8Array, hello: CborValue): Uint8Array {
  if (token.length !== 32) throw mdbaseError("invalid_request", "the link token is 32 bytes");
  const f = clientFrame.dec(hello);
  if (f.kind !== "request" || f.method !== "hello") throw mdbaseError("internal", "expected the hello request");
  return encode(
    new Map<number, CborValue>([
      [0, token],
      [1, f.params],
    ]),
  );
}

/** A connector to the desktop daemon over the authenticated localhost link. */
export function localLinkConnector(o: LocalLinkConnectorOptions): Connector {
  const collection = uuidToBytes(o.collection);
  const staticKey = o.staticKey ?? generateKeyPair();
  let current: LocalLink | null = null;
  return noiseConnector({
    description: "localhost-link",
    staticKey,
    firstPayload: (hello) => localLinkFirstPayload(current!.token, hello),
    target: async () => {
      // Re-read every (re)connect: the daemon mints a new port and token at each start.
      current = typeof o.link === "function" ? await o.link() : o.link;
      const link = current;
      if (!Number.isInteger(link.port) || link.port <= 0 || link.port > 65535) {
        throw mdbaseError("unavailable", "invalid local link port", "daemon_not_running");
      }
      const prologue = clientPrologue(collection, null, o.localOnly ? ZERO16 : uuidToBytes(link.device));
      return {
        prologue,
        preamble: prologue,
        remoteStatic: link.noisePublicKey,
        openCarrier: (signal) => webSocketCarrier(`ws://127.0.0.1:${link.port}/v1/plugin`, o.webSocket, signal),
      };
    },
  });
}
