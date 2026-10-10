/**
 * Browser apps to a device replica through Connect's relay, with the access token kept
 * inside the Connect client (`@mdbase-dev/connect/next`, control contracts pinned to
 * Connect #600/#604):
 *
 * 1. `next.route(collection)` lists the grant's targets (no token in the response);
 * 2. `next.openPipe(collection, target)` re-validates that target, authenticates the
 *    relay pipe (`pipe_auth` → `pipe_opened`) and returns an authenticated byte duplex;
 * 3. this module frames `u32be(len) ‖ Noise message` on that duplex exactly once and
 *    runs Noise IK with a prologue binding the relay collection, the route's grant and
 *    the target device — the same values the relay gives the daemon in `pipe_open`.
 *    It never sends a second `pipe_auth` and never sees the token.
 *
 * **Sticky target.** Reconnects stay on the device they last reached while the route
 * still lists it; only then do they move. The client's read fence
 * (`MdbaseClient`, `confirmed_through`) keeps a switch from serving older data.
 */
import { uuidToBytes } from "../codec.js";
import { isMdbaseError, mdbaseError, type MdbaseError } from "../errors.js";
import type { Uuid } from "../wire.js";
import { clientPrologue, KeyPair, StaticKey } from "./noise.js";
import { MessageCarrier, noiseConnector } from "./noise-session.js";
import type { Connector } from "./port.js";
import { pipeCloseError } from "./relay-pipe.js";
import { registerNextRelayFence } from "./read-fence-policy.js";

/** The authenticated relay stream `openPipe` returns: raw chunks, not whole messages. */
export interface AuthenticatedRelayByteDuplex {
  send(bytes: Uint8Array): void;
  onmessage: ((bytes: Uint8Array) => void) | null;
  onclose: ((event?: { code?: number; reason?: string }) => void) | null;
  close(): void;
}

export interface NextRouteTarget {
  readonly kind: "desktop" | "cli" | "hosted";
  readonly device: string;
  readonly noise_pk: string;
  readonly url: string;
  readonly relay_collection?: string;
  /** Preference hint only; never authorization or proof of reachability. */
  readonly online?: boolean;
}

export interface NextRouteResponse {
  readonly collection: string;
  readonly grant: string;
  readonly targets: readonly NextRouteTarget[];
  readonly reason?: "no_device_registered";
}

/** What `mdbaseNext(connection)` from `@mdbase-dev/connect/next` provides. */
export interface NextBridge {
  route(collection: string, options?: { signal?: AbortSignal }): Promise<NextRouteResponse>;
  /** `options.signal` bounds the open and, once admitted, the pipe's whole lifetime. */
  openPipe(
    collection: string,
    target: NextRouteTarget,
    options?: { signal?: AbortSignal },
  ): Promise<AuthenticatedRelayByteDuplex>;
}

/** Max Noise message, and max relay chunk (`u32be` length + message). */
const MAX_MESSAGE = 65535;
const MAX_CHUNK = 4 + MAX_MESSAGE;
const MAX_EARLY = 16;
const MAX_EARLY_BYTES = 1 << 20;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

/**
 * Whole Noise messages over an authenticated relay duplex: `u32be(len) ‖ message` out,
 * reassembled from arbitrarily chunked input. Oversized lengths end the pipe.
 */
export function duplexCarrier(d: AuthenticatedRelayByteDuplex): MessageCarrier {
  let buf = new Uint8Array(0);
  let closed = false;
  let terminal: MdbaseError | undefined;
  let onmessage: MessageCarrier["onmessage"] = null;
  let onclose: MessageCarrier["onclose"] = null;
  // Messages that arrive before a consumer is attached (bounded), and the terminal
  // state, are kept and delivered when it attaches.
  const early: Uint8Array[] = [];
  let earlyBytes = 0;
  const carrier: MessageCarrier = {
    get onmessage() {
      return onmessage;
    },
    set onmessage(f) {
      onmessage = f;
      while (f && !closed && early.length && onmessage === f) {
        const m = early.shift()!;
        earlyBytes -= m.length;
        f(m);
      }
    },
    get onclose() {
      return onclose;
    },
    set onclose(f) {
      onclose = f;
      if (f && closed && terminal) f(terminal);
    },
    send(m) {
      if (closed) throw mdbaseError("unavailable", "relay pipe closed");
      if (m.length > MAX_MESSAGE) throw mdbaseError("too_large", "Noise message over 65535 bytes");
      const f = new Uint8Array(4 + m.length);
      new DataView(f.buffer).setUint32(0, m.length);
      f.set(m, 4);
      d.send(f);
    },
    close() {
      if (closed) return;
      closed = true;
      early.length = 0;
      earlyBytes = 0;
      d.close();
    },
  };
  const fail = (code?: number, reason?: string) => {
    if (closed) return;
    closed = true;
    buf = new Uint8Array(0);
    // Terminal purge: queued ciphertext is dropped; only the close event is kept.
    early.length = 0;
    earlyBytes = 0;
    terminal = pipeCloseError(code, reason);
    d.close();
    onclose?.(terminal);
  };
  const deliver = (m: Uint8Array) => {
    if (closed) return;
    if (onmessage) return onmessage(m);
    if (early.length >= MAX_EARLY || earlyBytes + m.length > MAX_EARLY_BYTES) return fail(4000, "invalid_frame");
    early.push(m);
    earlyBytes += m.length;
  };
  d.onmessage = (chunk) => {
    if (closed) return;
    if (chunk.length > MAX_CHUNK) return fail(4000, "invalid_frame");
    const b = new Uint8Array(buf.length + chunk.length);
    b.set(buf);
    b.set(chunk, buf.length);
    let off = 0;
    while (b.length - off >= 4) {
      const len = new DataView(b.buffer, b.byteOffset + off, 4).getUint32(0);
      if (len > MAX_MESSAGE) return fail(4000, "invalid_frame");
      if (b.length - off - 4 < len) break;
      const m = b.slice(off + 4, off + 4 + len);
      off += 4 + len;
      deliver(m);
      if (closed) return;
    }
    buf = b.slice(off);
    if (buf.length > MAX_CHUNK) fail(4000, "invalid_frame");
  };
  d.onclose = (ev) => fail(ev?.code, ev?.reason);
  return carrier;
}

export interface NextRelayConnectorOptions {
  /** `mdbaseNext(connection)` from `@mdbase-dev/connect/next`. */
  next: NextBridge;
  /** The collection the app holds a grant for (the route's `collection`). */
  collection: Uuid;
  /** The grant's client key, registered at consent (`nextClientKey`). */
  staticKey: KeyPair | StaticKey;
}

/**
 * Connect client errors as SDK errors: a missing or revoked authorization stops the
 * client (`unauthenticated`); anything else (refused or failed admission, timeouts,
 * a route that no longer validates) is `unavailable` and retried with backoff.
 */
async function bridged<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (isMdbaseError(e)) throw e;
    const code = (e as { code?: unknown } | null)?.code;
    if (code === "not_authorized") throw mdbaseError("unauthenticated", "Connect authorization is missing", "not_authorized");
    // Admission refused by the relay: the client passes its close code and known reason.
    const cause = (e as { cause?: { code?: unknown; reason?: unknown } } | null)?.cause;
    if (typeof cause?.code === "number") {
      throw pipeCloseError(cause.code, typeof cause.reason === "string" ? cause.reason : undefined);
    }
    throw mdbaseError("unavailable", "the relay pipe could not be opened", "relay_unavailable");
  }
}

/** Valid relay targets, sticky device first, then those hinted online, in route order. */
export function orderTargets(route: NextRouteResponse, sticky: string | null): NextRouteTarget[] {
  const usable = route.targets.filter(
    (t) => UUID.test(t.device) && /^[0-9a-f]{64}$/.test(t.noise_pk) && !!t.relay_collection && UUID.test(t.relay_collection),
  );
  const stuck = usable.filter((t) => t.device === sticky);
  if (stuck.length) return stuck;
  return [...usable.filter((t) => t.online === true), ...usable.filter((t) => t.online !== true)];
}

/**
 * A connector for web apps reaching a device replica through the relay. Every
 * (re)connect asks for a fresh route and pipe; the token never reaches this code.
 */
export function nextRelayConnector(o: NextRelayConnectorOptions): Connector & { readonly target: string | null } {
  // Pin original host references/scope before any route/pipe await.
  const collection = o.collection, next = o.next, staticKey = o.staticKey;
  if (!UUID.test(collection)) throw mdbaseError("invalid_request", "collection must be a UUID");
  const routeCall = next.route.bind(next), pipeCall = next.openPipe.bind(next);
  let sticky: string | null = null;
  const connector = noiseConnector({
    description: `next-relay:${collection}`,
    staticKey,
    target: async (signal) => {
      const route = await bridged(() => routeCall(collection, signal ? { signal } : {}));
      if (route.collection.toLowerCase() !== collection.toLowerCase() || !UUID.test(route.grant)) {
        throw mdbaseError("unauthenticated", "the route does not match this collection's grant", "route_mismatch");
      }
      const selected = orderTargets(route, sticky)[0];
      if (!selected) {
        throw mdbaseError(
          "unavailable",
          route.reason === "no_device_registered"
            ? "this collection has no device set up to serve it"
            : "no device of this collection is online",
          route.reason ?? "no_device_online",
        );
      }
      const target = Object.freeze({ ...selected });
      const hex = target.noise_pk;
      const remoteStatic = new Uint8Array(32);
      for (let i = 0; i < 32; i++) remoteStatic[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
      return {
        // Must equal the daemon's pipe_open prologue: relay collection, grant, device.
        prologue: clientPrologue(uuidToBytes(target.relay_collection!), uuidToBytes(route.grant), uuidToBytes(target.device)),
        remoteStatic,
        device: target.device,
        openCarrier: async (signal) => {
          const pipe = await bridged(() => pipeCall(collection, target, signal ? { signal } : {}));
          return duplexCarrier(pipe);
        },
      };
    },
  });
  return registerNextRelayFence({
    description: connector.description,
    open: async (hello, signal) => {
      const opened = await connector.open(hello, signal);
      sticky = opened.device ?? null;
      return opened;
    },
    get target() {
      return sticky;
    },
  });
}
