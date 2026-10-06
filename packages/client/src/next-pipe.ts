import { connectError } from "./errors.js";

/** Relay close reasons passed through (control contract); any other text is dropped. */
const REASONS = new Set(["unauthenticated", "grant_inactive", "connector_offline", "connector_busy",
  "device_mismatch", "device_key_mismatch", "invalid_frame", "handshake_timeout", "idle", "lifetime",
  "pipe_closed", "grant_revoked", "not_served"]);

export interface AuthenticatedRelayByteDuplex {
  send(bytes: Uint8Array): void;
  onmessage: ((bytes: Uint8Array) => void) | null;
  /** Terminal. `reason` is a sanitized relay reason token (e.g. `device_key_mismatch`). */
  onclose: ((event?: { code?: number; reason?: string }) => void) | null;
  close(): void;
}

const MAX_CHUNK = 65_539;
const MAX_BUFFER = 1_048_576;
const failed = (close?: { code?: number; reason?: string }) => connectError(
  "invalid_operation_response", "The Next relay pipe is unavailable or invalid.",
  // Bounded admission metadata (close code and known reason) for the SDK's mapping.
  close?.code === undefined ? undefined : { cause: Object.freeze({ ...close }) });

/** Internal only: the narrow client API never exposes this credential-bearing input. */
export function admitNextPipe(input: {
  url: string;
  auth: string;
  check(): void;
  release(): void;
  signal: AbortSignal;
  /** The caller's own signal: aborting it closes the pipe for its whole lifetime. */
  lifetime?: AbortSignal;
}): Promise<AuthenticatedRelayByteDuplex> {
  return new Promise((resolve, reject) => {
    let socket: WebSocket | undefined;
    let credential = input.auth;
    // Drop the second string reference before installing asynchronous callbacks.
    input.auth = "";
    let admitted = false, terminal = false, released = false;
    let message: AuthenticatedRelayByteDuplex["onmessage"] = null;
    let close: AuthenticatedRelayByteDuplex["onclose"] = null;
    let closed: { code?: number; reason?: string } = {};
    const queue: Uint8Array[] = [];
    let buffered = 0;
    const release = () => { if (!released) { released = true; input.release(); } };
    const end = (code = 4000, reason?: string) => {
      if (terminal) return;
      terminal = true;
      credential = "";
      queue.length = 0; buffered = 0;
      closed = reason && REASONS.has(reason) ? { code, reason } : { code };
      clearTimeout(deadline);
      input.signal.removeEventListener("abort", abort);
      input.lifetime?.removeEventListener("abort", abort);
      if (socket) {
        socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
        try { socket.close(); } catch { /* terminal */ }
      }
      release();
      if (!admitted) reject(failed(closed));
      else { try { close?.(closed); } catch { /* listener errors never resurrect the pipe */ } }
    };
    const abort = () => end();
    const deadline = setTimeout(() => end(), 10_000);
    const duplex: AuthenticatedRelayByteDuplex = {
      send(bytes) {
        if (terminal || !admitted || !(bytes instanceof Uint8Array) || bytes.byteLength === 0
          || bytes.byteLength > MAX_CHUNK || !socket || socket.bufferedAmount + bytes.byteLength > MAX_BUFFER) {
          end(); throw failed();
        }
        try { input.check(); socket.send(new Uint8Array(bytes)); }
        catch { end(); throw failed(); }
      },
      get onmessage() { return message; },
      set onmessage(listener) {
        message = listener;
        while (!terminal && message && queue.length) {
          const bytes = queue.shift()!; buffered -= bytes.byteLength;
          try { message(bytes); } catch { end(); }
        }
      },
      get onclose() { return close; },
      set onclose(listener) { close = listener; if (terminal) { try { close?.(closed); } catch { /* terminal */ } } },
      close: () => end(1000)
    };
    input.signal.addEventListener("abort", abort, { once: true });
    input.lifetime?.addEventListener("abort", abort, { once: true });
    try {
      if (input.signal.aborted || input.lifetime?.aborted) { end(); return; }
      input.check();
      socket = new WebSocket(input.url);
      socket.binaryType = "arraybuffer";
      socket.onopen = () => {
        if (terminal) return;
        try { input.check(); socket!.send(credential); credential = ""; }
        catch { end(); }
      };
      socket.onmessage = event => {
        if (terminal) return;
        try {
          input.check();
          if (!admitted) {
            if (typeof event.data !== "string" || event.data.length > 4096) throw failed();
            const ack = JSON.parse(event.data);
            if (!ack || Object.keys(ack).length !== 2 || ack.type !== "pipe_opened"
              || typeof ack.pipe_id !== "string"
              || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(ack.pipe_id)) throw failed();
            admitted = true; clearTimeout(deadline);
            resolve(duplex);
            return;
          }
          if (!(event.data instanceof ArrayBuffer) || event.data.byteLength === 0
            || event.data.byteLength > MAX_CHUNK) throw failed();
          const bytes = new Uint8Array(event.data).slice();
          if (message) message(bytes);
          else {
            if (queue.length >= 16 || buffered + bytes.byteLength > MAX_BUFFER) throw failed();
            queue.push(bytes); buffered += bytes.byteLength;
          }
        } catch { end(); }
      };
      socket.onclose = event => end(Number.isInteger(event.code) ? event.code : 4000, event.reason);
      socket.onerror = () => end();
    } catch { end(); }
  });
}
