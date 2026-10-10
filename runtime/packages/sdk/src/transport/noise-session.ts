/**
 * A client session over Noise IK (`replica-client-api.md` §12.2, §12.3):
 *
 * - message 1 carries the `hello` request frame, message 2 the response;
 * - afterwards, the plaintext of the transport messages is one byte stream of
 *   `u32be(length) ‖ frame` records, cut into messages of at most 65,535 bytes;
 * - sessions end after 24 h or 2^30 messages, and the client reconnects.
 *
 * Carriers move whole Noise messages: one WebSocket message each (relay, hosted), or
 * `u16be(length) ‖ message` on a byte stream (local IPC). See
 * the SDK client wire and Noise framing contract.
 */
import { CborValue, decode, encode } from "../cbor.js";
import { isMdbaseError, mdbaseError, MdbaseError } from "../errors.js";
import { IkInitiator, KeyPair, MAX_PLAINTEXT, MAX_SESSION_MESSAGES, NoiseError, NoiseTransport, StaticKey } from "./noise.js";
import { ByteChannel, Connector, framedPort, OpenedPort } from "./port.js";

/** A message-oriented channel carrying whole Noise messages. */
export interface MessageCarrier {
  send(message: Uint8Array): void;
  onmessage: ((message: Uint8Array) => void) | null;
  onclose: ((error?: MdbaseError) => void) | null;
  close(): void;
}

/** Session lifetime (§12.3). */
export const SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000;

export interface NoiseTarget {
  /** Opens a carrier to the target (a new connection each time). */
  openCarrier(signal?: AbortSignal): Promise<MessageCarrier>;
  /** The Noise prologue binding collection, grant and target (`clientPrologue`). */
  prologue: Uint8Array;
  /** The responder's static public key (the replica's enrolled `noise_pk`). */
  remoteStatic: Uint8Array;
  /**
   * Sent in clear as the first carrier message, before Noise message 1: the 64-byte
   * prologue on local IPC and the localhost link, so one endpoint can serve many
   * collections. Tampering only fails the handshake.
   */
  preamble?: Uint8Array;
  /** The target's device ID, as the route named it (head-witness bookkeeping). */
  device?: string;
}

export interface NoiseConnectorOptions {
  /** This client's static key: the grant's `client_pk` (or the host app's key). */
  staticKey: KeyPair | StaticKey;
  /** Where to connect. Called for every (re)connect, so routing can change. */
  target: (signal?: AbortSignal) => Promise<NoiseTarget>;
  description: string;
  /** Override the 24 h lifetime (tests). */
  lifetimeMs?: number;
  /**
   * The payload of Noise message 1, from the encoded-as-value `hello` request frame.
   * Default: the encoded frame itself (§12.3). The localhost link (§12.4) sends
   * `{0: token, 1: hello-params}` instead.
   */
  firstPayload?: (hello: CborValue) => Uint8Array;
}

/**
 * The next message on `c`. Messages that arrive after it, before the transport is set
 * up, are kept in `backlog` (a replica may push right after the handshake).
 */
function nextMessage(c: MessageCarrier, backlog: Uint8Array[], signal?: AbortSignal): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(mdbaseError("cancelled", "connect aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });
    c.onmessage = (m) => {
      signal?.removeEventListener("abort", onAbort);
      c.onmessage = (later) => void backlog.push(later);
      resolve(m);
    };
    c.onclose = (e) => {
      signal?.removeEventListener("abort", onAbort);
      reject(e ?? mdbaseError("unavailable", "connection closed during the handshake"));
    };
  });
}

/** A byte channel over an established Noise transport. */
export function noiseChannel(
  c: MessageCarrier,
  t: NoiseTransport,
  lifetimeMs = SESSION_LIFETIME_MS,
  backlog: Uint8Array[] = [],
): ByteChannel {
  const empty = new Uint8Array(0);
  let closed = false;
  const timer = setTimeout(() => fail(), lifetimeMs);
  (timer as { unref?: () => void }).unref?.();
  const ch: ByteChannel = {
    ondata: null,
    onclose: null,
    write(bytes) {
      if (closed) throw mdbaseError("unavailable", "connection closed");
      for (let off = 0; off < bytes.length; off += MAX_PLAINTEXT) {
        if (t.send.count >= MAX_SESSION_MESSAGES - 1) {
          fail();
          throw mdbaseError("unavailable", "session message limit reached; reconnecting");
        }
        c.send(t.send.encrypt(empty, bytes.subarray(off, off + MAX_PLAINTEXT)));
      }
    },
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      c.close();
    },
  };
  const onMessage = (m: Uint8Array) => {
    if (closed) return;
    let p: Uint8Array;
    try {
      p = t.recv.decrypt(empty, m);
    } catch {
      fail(mdbaseError("unavailable", "transport message failed authentication", "noise"));
      return;
    }
    ch.ondata?.(p);
  };
  c.onmessage = onMessage;
  c.onclose = (e) => fail(e);
  if (backlog.length) {
    // Deliver what arrived during setup once the caller has wired `ondata`.
    const early = backlog.splice(0);
    queueMicrotask(() => early.forEach(onMessage));
  }
  function fail(e?: MdbaseError) {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    c.close();
    ch.onclose?.(e);
  }
  return ch;
}

/** A {@link Connector} that opens Noise IK sessions to a replica. */
export function noiseConnector(o: NoiseConnectorOptions): Connector {
  return {
    description: o.description,
    async open(hello: CborValue, signal?: AbortSignal): Promise<OpenedPort> {
      const aborted = () => mdbaseError("cancelled", "connect aborted");
      if (signal?.aborted) throw aborted();
      const target = await o.target(signal);
      if (signal?.aborted) throw aborted();
      const carrier = await target.openCarrier(signal);
      if (signal?.aborted) {
        carrier.close();
        throw aborted();
      }
      try {
        const hs = new IkInitiator({
          prologue: target.prologue,
          staticKey: o.staticKey,
          remoteStatic: target.remoteStatic,
        });
        const backlog: Uint8Array[] = [];
        const reply = nextMessage(carrier, backlog, signal);
        // Observe a close/abort while asynchronous DH is still in flight.
        reply.catch(() => {});
        if (target.preamble) carrier.send(target.preamble);
        const m1 = await hs.writeMessage1(o.firstPayload ? o.firstPayload(hello) : encode(hello));
        if (signal?.aborted) throw aborted();
        carrier.send(m1);
        const { payload, transport } = await hs.readMessage2(await reply);
        const helloResponse = decode(payload);
        const port = framedPort(noiseChannel(carrier, transport, o.lifetimeMs, backlog));
        return { port, helloResponse, ...(target.device ? { device: target.device } : {}) };
      } catch (e) {
        carrier.close();
        if (isMdbaseError(e)) throw e;
        if (e instanceof NoiseError) {
          // A responder that doesn't hold the expected key, or a tampered handshake.
          throw mdbaseError("unauthenticated", `handshake failed: ${e.message}`, "noise");
        }
        throw mdbaseError("unavailable", `handshake failed: ${String(e)}`);
      }
    },
  };
}

// ------------------------------------------------------------------ carriers

/** The subset of the WebSocket API the SDK uses (browser `WebSocket`, Node 22's, `ws`). */
export interface WebSocketLike {
  binaryType: string;
  readyState: number;
  send(data: Uint8Array | string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

const defaultWs: WebSocketFactory = (url) => {
  const Ws = (globalThis as { WebSocket?: new (u: string) => WebSocketLike }).WebSocket;
  if (!Ws) throw mdbaseError("unavailable", "no WebSocket implementation; pass webSocket");
  return new Ws(url);
};

/** Open a WebSocket carrying one Noise message per binary message. */
export function webSocketCarrier(url: string, factory: WebSocketFactory = defaultWs, signal?: AbortSignal): Promise<MessageCarrier> {
  return new Promise((resolve, reject) => {
    let ws: WebSocketLike;
    try {
      ws = factory(url);
    } catch (e) {
      reject(isMdbaseError(e) ? e : mdbaseError("unavailable", `cannot open ${url}: ${String(e)}`));
      return;
    }
    ws.binaryType = "arraybuffer";
    let open = false;
    const carrier: MessageCarrier = {
      onmessage: null,
      onclose: null,
      send(m) {
        ws.send(m);
      },
      close() {
        try {
          ws.close(1000);
        } catch {
          // already closed
        }
      },
    };
    const onAbort = () => {
      ws.close();
      reject(mdbaseError("cancelled", "connect aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    ws.onopen = () => {
      open = true;
      signal?.removeEventListener("abort", onAbort);
      resolve(carrier);
    };
    ws.onmessage = (ev) => {
      const d = ev.data;
      if (d instanceof ArrayBuffer) carrier.onmessage?.(new Uint8Array(d));
      else if (ArrayBuffer.isView(d)) carrier.onmessage?.(new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
      // Text messages are not part of the protocol: ignore.
    };
    ws.onerror = () => {};
    ws.onclose = (ev) => {
      const err = closeError(ev.code, ev.reason);
      if (!open) {
        signal?.removeEventListener("abort", onAbort);
        reject(err ?? mdbaseError("unavailable", `cannot connect to ${url}`));
      } else carrier.onclose?.(err);
    };
  });
}

/**
 * Close codes the relay uses to say why (control defines them; see the interface note).
 * 4404: no device online for a private collection. 4401: not authorized. 4429: rate limited.
 */
function closeError(code?: number, reason?: string): MdbaseError | undefined {
  switch (code) {
    case 4404:
      return mdbaseError("unavailable", reason || "no device of this collection is online", "no_device_online");
    case 4401:
      return mdbaseError("unauthenticated", reason || "relay refused the session");
    case 4403:
      return mdbaseError("forbidden", reason || "relay refused the session");
    case 4429:
      return mdbaseError("rate_limited", reason || "rate limited");
    default:
      return undefined;
  }
}

/** A duplex byte stream (a Node socket, a named pipe). */
export interface ByteStream {
  write(b: Uint8Array): void;
  ondata: ((b: Uint8Array) => void) | null;
  onclose: ((e?: Error) => void) | null;
  close(): void;
}

/** Carry Noise messages on a byte stream as `u16be(length) ‖ message`. */
export function streamCarrier(s: ByteStream): MessageCarrier {
  let buf = new Uint8Array(0);
  const carrier: MessageCarrier = {
    onmessage: null,
    onclose: null,
    send(m) {
      if (m.length > 0xffff) throw mdbaseError("too_large", "Noise message over 65535 bytes");
      const out = new Uint8Array(2 + m.length);
      out[0] = m.length >> 8;
      out[1] = m.length & 0xff;
      out.set(m, 2);
      s.write(out);
    },
    close() {
      s.close();
    },
  };
  s.ondata = (chunk) => {
    const b = new Uint8Array(buf.length + chunk.length);
    b.set(buf);
    b.set(chunk, buf.length);
    let off = 0;
    while (b.length - off >= 2) {
      const len = (b[off]! << 8) | b[off + 1]!;
      if (b.length - off - 2 < len) break;
      carrier.onmessage?.(b.slice(off + 2, off + 2 + len));
      off += 2 + len;
    }
    buf = b.slice(off);
  };
  s.onclose = (e) => carrier.onclose?.(e ? mdbaseError("unavailable", e.message) : undefined);
  return carrier;
}
