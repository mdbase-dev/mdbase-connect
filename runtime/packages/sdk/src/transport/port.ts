/**
 * The transport seam. Every transport ends in a {@link FramePort}: a duplex channel of
 * client frames as decoded `mdb-cbor/1` values (`replica-client-api.md` §1, §12).
 *
 * - In-process: the shared runtime hands out a port directly (§12.1).
 * - Local IPC and relay: bytes, Noise, `u32be(length) ‖ frame` records, turned into a
 *   port by {@link framedPort}.
 *
 * A {@link Connector} opens a port and performs the `hello` exchange, because over
 * Noise the hello travels inside the handshake (§12.3).
 */
import { CborValue, decode, encode } from "../cbor.js";
import { mdbaseError, MdbaseError } from "../errors.js";

export interface FramePort {
  /** Optional trusted app-host READ bridge on this exact held session. No RPC
   * opcode, caller session ID, cursor or fallback to generic execute_view. */
  readAppBases?(request: Uint8Array, signal?: AbortSignal): Promise<Uint8Array>;
  readAppBasesDiscovery?(operation: "list-views" | "read-view-source", request: Uint8Array, signal?: AbortSignal): Promise<Uint8Array>;
  send(frame: CborValue): void;
  /** Set by the session. Called once per received frame. */
  onframe: ((frame: CborValue) => void) | null;
  /** Called once, when the port closes for any reason. */
  onclose: ((error?: MdbaseError) => void) | null;
  close(): void;
}

export interface OpenedPort {
  port: FramePort;
  /** The `c-response` frame answering the `hello` request. */
  helloResponse: CborValue;
  /** The replica's device ID, when the transport authenticated it (Noise target). */
  device?: string;
}

/** Opens a port to a replica and performs the hello exchange. */
export interface Connector {
  /** `hello` is the complete `c-request` frame (request ID 0). */
  open(hello: CborValue, signal?: AbortSignal): Promise<OpenedPort>;
  /** A short description for diagnostics ("in-process", "ipc:/run/…", "relay:…"). */
  readonly description: string;
}

/** Maximum frame size on byte transports (§12.2). */
export const MAX_FRAME = 16 * 1024 * 1024;

/**
 * Splits a byte stream into `u32be(length) ‖ frame` records. Feed it chunks; it
 * returns complete frames.
 */
export class RecordReader {
  // Chunks are kept as a list and copied once per complete frame, so reading is
  // linear in the bytes received (no re-concatenation per chunk).
  private chunks: Uint8Array[] = [];
  private head = 0; // offset into chunks[0]
  private buffered = 0;

  push(chunk: Uint8Array): Uint8Array[] {
    if (chunk.length) {
      this.chunks.push(chunk);
      this.buffered += chunk.length;
    }
    const out: Uint8Array[] = [];
    for (;;) {
      if (this.buffered < 4) break;
      const len = new DataView(this.peek(4).buffer).getUint32(0);
      if (len > MAX_FRAME) throw mdbaseError("too_large", `frame of ${len} bytes exceeds ${MAX_FRAME}`);
      if (this.buffered < 4 + len) break;
      this.skip(4);
      out.push(this.take(len));
    }
    return out;
  }

  private peek(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let o = 0;
    let off = this.head;
    for (const c of this.chunks) {
      const k = Math.min(n - o, c.length - off);
      out.set(c.subarray(off, off + k), o);
      o += k;
      off = 0;
      if (o === n) break;
    }
    return out;
  }

  private take(n: number): Uint8Array {
    const out = this.peek(n);
    this.skip(n);
    return out;
  }

  private skip(n: number): void {
    this.buffered -= n;
    while (n > 0) {
      const c = this.chunks[0]!;
      const avail = c.length - this.head;
      if (n < avail) {
        this.head += n;
        return;
      }
      n -= avail;
      this.chunks.shift();
      this.head = 0;
    }
  }
}

export function record(frame: Uint8Array): Uint8Array {
  if (frame.length > MAX_FRAME) throw mdbaseError("too_large", `frame of ${frame.length} bytes exceeds ${MAX_FRAME}`);
  const out = new Uint8Array(4 + frame.length);
  new DataView(out.buffer).setUint32(0, frame.length);
  out.set(frame, 4);
  return out;
}

/** A byte channel carrying the plaintext record stream (after Noise, if any). */
export interface ByteChannel {
  write(bytes: Uint8Array): void;
  ondata: ((bytes: Uint8Array) => void) | null;
  onclose: ((error?: MdbaseError) => void) | null;
  close(): void;
}

/** Turn a byte channel of `u32be(length) ‖ frame` records into a frame port. */
export function framedPort(ch: ByteChannel): FramePort {
  const reader = new RecordReader();
  let closed = false;
  // Frames that arrive before the session installs its handler are held, so nothing
  // pushed right after the handshake is lost.
  let handler: ((f: CborValue) => void) | null = null;
  const held: CborValue[] = [];
  const port: FramePort = {
    get onframe() {
      return handler;
    },
    set onframe(h) {
      handler = h;
      if (h && held.length) for (const f of held.splice(0)) h(f);
    },
    onclose: null,
    send(frame) {
      if (closed) throw mdbaseError("unavailable", "connection closed");
      ch.write(record(encode(frame)));
    },
    close() {
      if (closed) return;
      closed = true;
      ch.close();
      port.onclose?.();
    },
  };
  ch.ondata = (bytes) => {
    try {
      for (const f of reader.push(bytes)) {
        const v = decode(f);
        if (handler) handler(v);
        else if (held.length < 1024) held.push(v);
        else throw mdbaseError("too_large", "too many frames before the session started");
      }
    } catch (e) {
      // A peer that sends non-canonical or oversized frames is broken: drop the link.
      fail(e instanceof MdbaseError ? e : mdbaseError("internal", `invalid frame from replica: ${String(e)}`));
    }
  };
  ch.onclose = (err) => fail(err);
  function fail(err?: MdbaseError) {
    if (closed) return;
    closed = true;
    ch.close();
    port.onclose?.(err);
  }
  return port;
}

/** Two connected in-memory ports (tests, and same-process hosts). */
export function portPair(): [FramePort, FramePort] {
  const mk = (): FramePort & { peer?: FramePort; closed: boolean } => ({
    onframe: null,
    onclose: null,
    closed: false,
    send(frame) {
      if (this.closed) throw mdbaseError("unavailable", "connection closed");
      const peer = this.peer!;
      queueMicrotask(() => {
        if (!(peer as unknown as { closed: boolean }).closed) peer.onframe?.(frame);
      });
    },
    close() {
      if (this.closed) return;
      this.closed = true;
      this.onclose?.();
      const peer = this.peer as FramePort & { closed: boolean };
      if (!peer.closed) {
        peer.closed = true;
        queueMicrotask(() => peer.onclose?.());
      }
    },
  });
  const a = mk();
  const b = mk();
  a.peer = b;
  b.peer = a;
  return [a, b];
}
