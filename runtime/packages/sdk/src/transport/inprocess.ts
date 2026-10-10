/**
 * In-process transport (`replica-client-api.md` §12.1): a plugin or app shares the
 * runtime instance of its JS process and exchanges frames as JS values, with no
 * encoding and no Noise.
 *
 * Trust: everything in the JS process is trusted. A connection without a
 * grant gets host privileges (device approval, materialization), so only the plugin
 * that hosts the runtime should connect without one; other plugins attach with their
 * grant. The runtime decides; this connector only passes the options through.
 */
import type { CborValue } from "../cbor.js";
import { mdbaseError } from "../errors.js";
import type { Connector, FramePort } from "./port.js";

export interface InProcessConnectOptions {
  /** The grant of a plugin attaching to another plugin's host; absent for the hosting plugin. */
  grant?: string;
  /** The collection to attach to, when the runtime hosts several. */
  collection?: string;
}

/** What a shared runtime offers in process. */
export interface InProcessRuntime {
  connect(options: InProcessConnectOptions): FramePort;
}

/** A connector to a runtime in this JS process. */
export function inProcessConnector(runtime: InProcessRuntime, options: InProcessConnectOptions = {}): Connector {
  return {
    description: "in-process",
    open(hello: CborValue, signal?: AbortSignal) {
      return new Promise((resolve, reject) => {
        let port: FramePort;
        try {
          port = runtime.connect(options);
        } catch (e) {
          reject(mdbaseError("unavailable", `runtime refused to connect: ${String(e)}`));
          return;
        }
        const onAbort = () => {
          port.close();
          reject(mdbaseError("cancelled", "connect aborted"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        port.onframe = (f) => {
          // The first frame back is the hello response (request ID 0).
          signal?.removeEventListener("abort", onAbort);
          port.onframe = null;
          port.onclose = null;
          resolve({ port, helloResponse: f });
        };
        port.onclose = (e) => {
          signal?.removeEventListener("abort", onAbort);
          reject(e ?? mdbaseError("unavailable", "runtime closed the session"));
        };
        port.send(hello);
      });
    },
  };
}
