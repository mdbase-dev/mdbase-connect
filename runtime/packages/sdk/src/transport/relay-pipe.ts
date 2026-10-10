/**
 * The relay's Noise pipe for thin clients (Connect `GET /v1/next/relay/client`,
 * Connect #596):
 *
 * 1. Open the WebSocket. Browsers can't set headers, so the first **text** frame is
 *    `{type: "pipe_auth", access_token, collection, grant, device, device_noise_pk}`.
 * 2. Wait for `{type: "pipe_opened", pipe_id}` before sending any binary frame.
 * 3. Binary frames then carry the §12.3 stream: `u32be(len) ‖ Noise message`, at most
 *    65,539 bytes per frame. The relay forwards them opaquely. Authorization is the
 *    replica's (Noise IK with the grant's `client_pk`); relay admission is a filter.
 * 4. `{type: "pipe_close", pipe_id, reason}` or a close code ends the pipe.
 *
 * Close codes → the 15 codes: 4401 → `unauthenticated`; 4403 (`grant_inactive`) →
 * `forbidden`; 4404 (`connector_offline`: no bound daemon) → `unavailable` /
 * `no_device_online`; 4429 (`connector_busy`) → `rate_limited`; 4000 with
 * `device_key_mismatch` → `unauthenticated` (the routed key isn't the device's; never
 * retried blindly); other 4000 reasons → `unavailable` with that reason.
 */
import { mdbaseError, MdbaseError } from "../errors.js";
import { toHex } from "../cbor.js";
import type { MessageCarrier, WebSocketFactory, WebSocketLike } from "./noise-session.js";

export interface PipeAuth {
  /** The app's Connect access token. */
  accessToken: string;
  /** The relay's (Connect's local) collection ID. */
  collection: string;
  grant: string;
  /** Target device and its Noise key, as the routing endpoint returned them. */
  device: string;
  devicePublicKey: Uint8Array;
}

/** Max binary frame: u32be length + one Noise message. */
const MAX_PIPE_FRAME = 4 + 65535;

export function pipeCloseError(code?: number, reason?: string): MdbaseError {
  const r = reason || undefined;
  switch (code) {
    case 4401:
      return mdbaseError("unauthenticated", r ?? "relay: unauthenticated", "relay_unauthenticated");
    case 4403:
      return mdbaseError("forbidden", r ?? "relay: grant inactive", r ?? "grant_inactive");
    case 4404:
      return mdbaseError("unavailable", "no device of this collection is online", {
        reason: "no_device_online",
        ...(r ? { details: new Map([["relay", r]]) } : {}),
      });
    case 4429:
      return mdbaseError("rate_limited", r ?? "relay: busy", { reason: r ?? "connector_busy", retryAfterMs: 5000 });
    case 4000:
      if (r === "device_key_mismatch") return mdbaseError("unauthenticated", "relay: the routed key is not the device's", r);
      return mdbaseError("unavailable", `relay closed the pipe: ${r ?? "unknown"}`, r ?? "pipe_closed");
    default:
      return mdbaseError("unavailable", `relay connection closed${code ? ` (${code})` : ""}`, "relay_closed");
  }
}

function defaultWs(url: string): WebSocketLike {
  const Ws = (globalThis as { WebSocket?: new (u: string) => WebSocketLike }).WebSocket;
  if (!Ws) throw mdbaseError("unavailable", "no WebSocket implementation; pass webSocket");
  return new Ws(url);
}

/** Open a relay pipe and return a carrier of whole Noise messages. */
export function relayPipeCarrier(
  url: string,
  auth: PipeAuth,
  factory: WebSocketFactory = defaultWs,
  signal?: AbortSignal,
): Promise<MessageCarrier> {
  // The access token travels in the first frame: never over plaintext.
  let scheme = "";
  try {
    scheme = new URL(url).protocol;
  } catch {
    return Promise.reject(mdbaseError("invalid_request", `invalid relay URL ${url}`, "relay_url"));
  }
  if (scheme !== "wss:") {
    return Promise.reject(mdbaseError("invalid_request", "relay pipes require wss:", "relay_insecure"));
  }
  if (!auth.grant) {
    return Promise.reject(mdbaseError("invalid_request", "relay pipes require a grant", "grant_required"));
  }
  return new Promise((resolve, reject) => {
    let ws: WebSocketLike;
    try {
      ws = factory(url);
    } catch (e) {
      reject(mdbaseError("unavailable", `cannot open ${url}: ${String(e)}`));
      return;
    }
    ws.binaryType = "arraybuffer";
    let opened = false;
    let settled = false;
    let buf = new Uint8Array(0);
    const carrier: MessageCarrier = {
      onmessage: null,
      onclose: null,
      send(m) {
        if (m.length > 65535) throw mdbaseError("too_large", "Noise message over 65535 bytes");
        const f = new Uint8Array(4 + m.length);
        new DataView(f.buffer).setUint32(0, m.length);
        f.set(m, 4);
        ws.send(f);
      },
      close() {
        try {
          ws.close(1000);
        } catch {
          // closed
        }
      },
    };
    const fail = (e: MdbaseError) => {
      if (!settled) {
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        reject(e);
      } else carrier.onclose?.(e);
    };
    const onAbort = () => {
      ws.close();
      fail(mdbaseError("cancelled", "connect aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    ws.onopen = () => {
      // A text frame: the credential never goes in the URL.
      ws.send(
        JSON.stringify({
          type: "pipe_auth",
          access_token: auth.accessToken,
          collection: auth.collection,
          grant: auth.grant,
          device: auth.device,
          device_noise_pk: toHex(auth.devicePublicKey),
        }),
      );
    };
    ws.onmessage = (ev) => {
      const d = ev.data;
      if (typeof d === "string") {
        let msg: { type?: string; reason?: string };
        try {
          msg = JSON.parse(d) as typeof msg;
        } catch {
          return;
        }
        if (msg.type === "pipe_opened" && !opened) {
          opened = true;
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          resolve(carrier);
        } else if (msg.type === "pipe_close") {
          ws.close();
          fail(pipeCloseError(4000, msg.reason));
        }
        return;
      }
      if (!opened) return; // binary before pipe_opened: not part of the protocol
      const chunk =
        d instanceof ArrayBuffer
          ? new Uint8Array(d)
          : ArrayBuffer.isView(d)
            ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength)
            : null;
      if (!chunk) return;
      if (chunk.length > MAX_PIPE_FRAME) {
        ws.close();
        fail(mdbaseError("too_large", "relay frame over the limit"));
        return;
      }
      // Tolerate a relay that re-chunks: parse u32be-prefixed messages from a stream.
      const b = new Uint8Array(buf.length + chunk.length);
      b.set(buf);
      b.set(chunk, buf.length);
      let off = 0;
      while (b.length - off >= 4) {
        const len = new DataView(b.buffer, b.byteOffset + off, 4).getUint32(0);
        if (len > 65535) {
          ws.close();
          fail(mdbaseError("internal", "relay sent an oversized Noise message"));
          return;
        }
        if (b.length - off - 4 < len) break;
        carrier.onmessage?.(b.slice(off + 4, off + 4 + len));
        off += 4 + len;
      }
      buf = b.slice(off);
    };
    ws.onerror = () => {};
    ws.onclose = (ev) => fail(pipeCloseError(ev.code, ev.reason));
  });
}
