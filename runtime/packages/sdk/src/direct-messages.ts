// One ordered sequence of WebSocket-equivalent messages per direct operation.
import { isMdbaseError, mdbaseError, type MdbaseError } from "./errors.js";
import { enrollmentPin, MIN_BUNDLE_BYTES, MAX_BUNDLE_BYTES } from "./direct-credential.js";
import { MAX_FRAME } from "./transport/port.js";

type Operation = "pair" | "replica";
interface Events {
  ready(): void;
  message(value: unknown): void | Promise<void>;
  failed(error: MdbaseError): void;
}
interface Messages {
  send(value: string | Uint8Array): void;
  close(): void;
}

const unavailable = () => mdbaseError("unavailable", "Direct connection unavailable");
const unsupported = () => mdbaseError("unavailable", "Browser does not support pinned WebTransport", "browser_unsupported");
const disconnected = (code?: number) => code === 1008 ? mdbaseError("unauthenticated", "Authorization refused") : unavailable();
const invalidEnvelope = () => mdbaseError("invalid_request", "Invalid direct message envelope");

// A stream read can split either prefix, split a payload, or contain several messages.
// Allocate only after validating the outer length and retain at most one partial message.
async function* envelopes(reader: ReadableStreamDefaultReader<Uint8Array>, operation: Operation) {
  const header = new Uint8Array(4);
  let payload: Uint8Array | undefined;
  let offset = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      if (offset || payload) throw invalidEnvelope();
      return;
    }
    for (let pos = 0; pos < value.length;) {
      const target = payload ?? header;
      const take = Math.min(target.length - offset, value.length - pos);
      target.set(value.subarray(pos, pos + take), offset);
      offset += take;
      pos += take;
      if (offset < target.length) continue;
      offset = 0;
      if (payload) {
        yield payload;
        payload = undefined;
      } else {
        const length = new DataView(header.buffer).getUint32(0);
        if (operation === "pair" ? length < MIN_BUNDLE_BYTES || length > MAX_BUNDLE_BYTES : length < 5 || length > MAX_FRAME + 4) throw invalidEnvelope();
        payload = new Uint8Array(length);
      }
    }
  }
}

function pinnedMessages(endpoint: URL, pins: readonly string[], operation: Operation, events: Events): Messages {
  // Web IDL ignores unknown dictionary members. An implementation lacking the hash
  // option must never get a stream or credentials, even if ordinary TLS would succeed.
  let pinOptionRead = false;
  if (typeof WebTransport !== "function") throw unsupported();
  const session = new WebTransport(endpoint.href, {
    get serverCertificateHashes() {
      pinOptionRead = true;
      return pins.map(hex => ({ algorithm: "sha-256", value: Uint8Array.from(hex.match(/../g)!, byte => parseInt(byte, 16)) }));
    },
  });
  if (!pinOptionRead) {
    void session.ready.catch(() => {});
    void session.closed.catch(() => {});
    session.close();
    throw unsupported();
  }
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  let closed = false;
  let pending = 0;
  let queuedBytes = 0;
  let streamEnd: ReturnType<typeof setTimeout> | undefined;

  function fail(error: MdbaseError) {
    if (!closed) events.failed(error);
  }
  // Stream FIN/reset and the session's CLOSE capsule arrive independently. Only the
  // session can report a denied credential; bound the wait for a peer that only sent FIN.
  function streamEnded() {
    if (!closed && !streamEnd) streamEnd = setTimeout(() => fail(unavailable()), 1000);
  }
  void session.closed.then(info => {
    // A graceful close can resolve while the final reply is still queued for the
    // reader (notably the single-use pairing token). Allow it to drain.
    if (reader && !streamEnd && info.closeCode === 0) streamEnded();
    else fail(disconnected(info.closeCode));
  }, () => fail(unavailable()));
  async function run() {
    await session.ready;
    if (closed) return;
    const stream = await session.createBidirectionalStream();
    if (closed) {
      void stream.readable.cancel().catch(() => {});
      void stream.writable.abort().catch(() => {});
      return;
    }
    reader = stream.readable.getReader();
    writer = stream.writable.getWriter();
    events.ready();
    let pairReply: Uint8Array | undefined;
    for await (const payload of envelopes(reader, operation)) {
      if (closed) return;
      if (operation === "pair") {
        if (pairReply) throw invalidEnvelope();
        pairReply = payload;
      } else {
        await events.message(payload);
      }
      if (closed) return;
    }
    // A pair operation has one response. Require FIN so a second frame or
    // trailing partial frame cannot be discarded after accepting the first.
    if (pairReply && !closed) {
      await events.message(new TextDecoder("utf-8", { ignoreBOM: true }).decode(pairReply));
      return;
    }
    streamEnded();
  }
  void run().catch(error => {
    if (isMdbaseError(error)) fail(error);
    else streamEnded();
  });
  return {
    send(value) {
      if (closed || !writer) throw unavailable();
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
      if (!bytes.length || bytes.length > (operation === "pair" ? 8 : MAX_FRAME + 4)) throw invalidEnvelope();
      const size = bytes.length + 4;
      // FramePort.send is synchronous. Bound the underlying WritableStream's pending writes.
      if (pending >= 16 || queuedBytes + size > 32 * 1024 * 1024) {
        const error = mdbaseError("too_large", "Direct send queue is full");
        fail(error);
        throw error;
      }
      const envelope = new Uint8Array(size);
      new DataView(envelope.buffer).setUint32(0, bytes.length);
      envelope.set(bytes, 4);
      pending++;
      queuedBytes += size;
      void writer.write(envelope).catch(streamEnded).finally(() => {
        pending--;
        queuedBytes -= size;
      });
    },
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(streamEnd);
      if (reader) {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      if (writer) {
        void writer.abort().catch(() => {});
        writer.releaseLock();
      }
      session.close();
    },
  };
}

type Request = { operation: "pair" } | { operation: "replica"; hashes: readonly string[] };

export function openDirectMessages(server: string, request: Request, events: Events): Messages {
  const { operation } = request;
  // server has passed directBackendOrigin; its fragment selects exactly one transport.
  const descriptor = new URL(server);
  const endpoint = new URL(`/_mdbase/${operation}`, descriptor.origin);
  try {
    const pin = enrollmentPin(server);
    if (pin) {
      const pins = request.operation === "pair" ? [pin] : request.hashes;
      if (!pins.length) throw unavailable();
      return pinnedMessages(endpoint, pins, operation, events);
    }
    endpoint.protocol = "wss:";
    const socket = new WebSocket(endpoint);
    socket.binaryType = "arraybuffer";
    socket.onopen = events.ready;
    socket.onmessage = ({ data }) => events.message(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
    socket.onclose = event => events.failed(disconnected(event.code));
    socket.onerror = () => events.failed(unavailable());
    return {
      send: value => socket.send(value),
      close() {
        socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
        socket.close();
      },
    };
  } catch (error) {
    if (isMdbaseError(error)) throw error;
    throw unavailable();
  }
}
