/**
 * The responder side of a client Noise session, bridged to any {@link Connector}
 * (usually a {@link MemoryReplica}). Tests use it to run the IPC and relay transports
 * end to end; it also documents what a daemon or hosted replica does on accept.
 */
import { decode, encode } from "../cbor.js";
import { ERROR_CODES } from "../errors.js";
import { IkResponder, KeyPair } from "../transport/noise.js";
import { MessageCarrier, noiseChannel } from "../transport/noise-session.js";
import { Connector, framedPort } from "../transport/port.js";
import { clientFrame } from "../wire.js";

export interface ServeNoiseOptions {
  staticKey: KeyPair;
  prologue: Uint8Array;
  /** Accept only these client keys (the active grants' `client_pk`s); default any. */
  authorize?: (clientKey: Uint8Array) => boolean;
}

/** Accept one Noise session on `carrier` and serve it from `backend`. */
export function serveNoise(carrier: MessageCarrier, backend: Connector, o: ServeNoiseOptions): void {
  const hs = new IkResponder({ prologue: o.prologue, staticKey: o.staticKey });
  carrier.onmessage = async (m1) => {
    carrier.onmessage = null;
    let hello;
    let clientKey;
    try {
      const r = hs.readMessage1(m1);
      hello = decode(r.payload);
      clientKey = r.remoteStatic;
    } catch {
      carrier.close();
      return;
    }
    if (o.authorize && !o.authorize(clientKey)) {
      const f = clientFrame.dec(hello);
      const id = f.kind === "request" ? f.id : 0;
      const refusal = clientFrame.enc({
        kind: "response",
        id,
        problem: { code: "unauthenticated", recovery: ERROR_CODES.unauthenticated, message: "no active grant for this key" },
      });
      carrier.send(hs.writeMessage2(encode(refusal)).message);
      carrier.close();
      return;
    }
    const opened = await backend.open(hello);
    const { message, transport } = hs.writeMessage2(encode(opened.helloResponse));
    carrier.send(message);
    const port = framedPort(noiseChannel(carrier, transport));
    // Bridge the decrypted client port to the backend's port.
    port.onframe = (f) => {
      try {
        opened.port.send(f);
      } catch {
        // backend went away
      }
    };
    opened.port.onframe = (f) => {
      try {
        port.send(f);
      } catch {
        // client went away
      }
    };
    port.onclose = () => opened.port.close();
    opened.port.onclose = () => port.close();
  };
}
