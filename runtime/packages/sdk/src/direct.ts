import { connect, type ClientOptions, type MdbaseClient } from "./client.js";
import { mdbaseError, type MdbaseError } from "./errors.js";
import { framedPort, MAX_FRAME, type ByteChannel, type Connector } from "./transport/port.js";
import { directBackendOrigin } from "./direct-origin.js";
import { activePins, directCredential, pairingGrant } from "./direct-credential.js";
import { openDirectMessages } from "./direct-messages.js";
export { directBackendOrigin } from "./direct-origin.js";
export { createDirectGrantStore, type DirectGrantStore, type DirectBrowserGrant } from "./direct-grant-store.js";

export interface DirectOptions {
  server: string;
  /** Opaque grant returned by pairDirect for this server. */
  token: string;
  app: ClientOptions["app"];
  signal?: AbortSignal;
}

// Reaching the server can wait on the person: a browser may ask for permission to
// use the local network before it connects. The server's reply cannot.
const CONNECT_MS = 60_000;
const REPLY_MS = 10_000;

function handshakeDeadline(signal: AbortSignal | undefined, fail: (error: MdbaseError) => void) {
  const abort = () => fail(mdbaseError("cancelled", "Direct handshake cancelled"));
  const expire = () => fail(mdbaseError("unavailable", "Direct handshake timed out"));
  let timer = setTimeout(expire, CONNECT_MS);
  signal?.addEventListener("abort", abort, { once: true });
  return {
    /** The transport is open and the first message is on its way. */
    sent() {
      clearTimeout(timer);
      timer = setTimeout(expire, REPLY_MS);
    },
    clear() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    },
  };
}

/**
 * Redeem an operator-issued, single-use code at the selected backend and return its opaque browser grant.
 *
 * An `unavailable` failure with reason `code_not_sent` means the server was never
 * reached: the code is unused and can be submitted again. Any other failure after
 * the connection opened leaves the outcome unknown.
 */
export async function pairDirect({ server, code, signal }: { server: string; code: string; signal?: AbortSignal }): Promise<string> {
  server = directBackendOrigin(server);
  if (typeof code !== "string" || code.length !== 8 || !/^\d{8}$/.test(code)) throw mdbaseError("invalid_request", "Expected an eight-digit pairing code");
  if (signal?.aborted) throw mdbaseError("cancelled", "Pairing cancelled");
  return new Promise((resolve, reject) => {
    let sent = false;
    function finish() {
      code = "";
      deadline.clear();
      messages.close();
    }
    function fail(error: MdbaseError) {
      finish();
      reject(!sent && error.code === "unavailable" && !error.reason
        ? mdbaseError("unavailable", "Pairing server was not reached", "code_not_sent") : error);
    }
    const messages = openDirectMessages(server, { operation: "pair" }, {
      ready() {
        sent = true;
        deadline.sent();
        try { messages.send(code); code = ""; }
        catch { fail(mdbaseError("unavailable", "Pairing connection failed")); }
      },
      message(token) {
        try { resolve(pairingGrant(server, token)); }
        catch (error) { reject(error); }
        finish();
      },
      failed: fail,
    });
    const deadline = handshakeDeadline(signal, fail);
  });
}

/** Browser-only connection to an explicitly paired HTTPS backend. */
export async function connectDirect({ server, token, app, signal }: DirectOptions): Promise<MdbaseClient> {
  server = directBackendOrigin(server);
  let { bearer, calendar } = directCredential(server, token);
  token = "";
  const hashes = activePins(calendar);
  // A stream may already contain pushes after hello. Resume delivery once the
  // ordinary client has installed its Session handlers (also on failed attachment).
  let release!: () => void;
  const attached = new Promise<void>(resolve => { release = resolve; });
  const connector: Connector = {
    description: "paired direct",
    open(hello, abortSignal) {
      return new Promise((resolve, reject) => {
        const channel: ByteChannel = {
          onclose: null, ondata: null,
          write: bytes => messages.send(bytes),
          close: () => messages.close(),
        };
        const port = framedPort(channel);
        let receivedHello = false;
        const messages = openDirectMessages(server, { operation: "replica", hashes }, {
          ready() {
            try {
              // TLS can finish after a clock adjustment or the end of the calendar.
              const stillValid = activePins(calendar);
              if (!hashes.every(pin => stillValid.includes(pin))) {
                throw mdbaseError("unavailable", "Certificate slot changed during handshake");
              }
              deadline.sent();
              messages.send(bearer);
              bearer = "";
              port.send(hello);
            } catch { channel.onclose?.(mdbaseError("unavailable", "Direct connection failed")); }
          },
          message(data) {
            if (!(data instanceof Uint8Array) || data.length < 5 || data.length > MAX_FRAME + 4 ||
                new DataView(data.buffer, data.byteOffset).getUint32(0) !== data.length - 4) {
              channel.onclose?.(mdbaseError("invalid_request", "Invalid direct replica record"));
            } else {
              channel.ondata?.(data);
              return attached;
            }
          },
          failed(error) {
            if (receivedHello) void attached.then(() => channel.onclose?.(error));
            else channel.onclose?.(error);
          },
        });
        const deadline = handshakeDeadline(abortSignal, error => channel.onclose?.(error));
        port.onclose = error => {
          bearer = "";
          deadline.clear();
          reject(error ?? mdbaseError("unavailable", "Direct connection closed"));
        };
        port.onframe = helloResponse => {
          receivedHello = true;
          deadline.clear();
          port.onframe = null;
          port.onclose = null;
          resolve({ port, helloResponse });
        };
      });
    },
  };
  try { return await connect({ connector, app, signal, reconnect: false }); }
  finally { release(); }
}
