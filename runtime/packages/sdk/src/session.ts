/**
 * One client session over one port: request/response matching, cancellation, pushes,
 * and requests from the replica to the client (the editor fence, §14).
 *
 * A session does not reconnect. {@link MdbaseClient} owns reconnection and
 * re-subscription.
 */
import type { CborValue } from "./cbor.js";
import { Codec, SchemaError } from "./codec.js";
import { isMdbaseError, mdbaseError, MdbaseError } from "./errors.js";
import type { Connector, FramePort } from "./transport/port.js";
import { clientFrame, helloParams, HelloParams, helloResult, HelloResult, Problem, problem } from "./wire.js";

/** API versions this SDK speaks, highest first. */
export const API_VERSIONS = [{ major: 1, minor: 0 }];

export type PushHandler = (payload: CborValue) => void;
export type RequestHandler = (params: CborValue) => Promise<CborValue> | CborValue;

interface Pending {
  resolve(v: CborValue): void;
  reject(e: MdbaseError): void;
  cleanup(): void;
}

/** Turn a decoding failure into an API error: unknown variants mean upgrade. */
export function schemaToError(e: unknown, what: string): MdbaseError {
  if (isMdbaseError(e)) return e;
  if (e instanceof SchemaError && e.unknown) {
    return mdbaseError("upgrade_required", `${what}: ${e.message}`, { reason: "unknown_variant" });
  }
  return mdbaseError("internal", `${what}: ${e instanceof Error ? e.message : String(e)}`);
}

export class Session {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private pushHandlers = new Map<string, Set<PushHandler>>();
  private requestHandlers = new Map<string, RequestHandler>();
  private closeError: MdbaseError | undefined;
  private closedFlag = false;
  private closeListeners = new Set<(e?: MdbaseError) => void>();
  /** The replica's device ID, when the transport authenticated it. */
  device: string | undefined;

  private constructor(
    private port: FramePort,
    readonly hello: HelloResult,
  ) {
    port.onframe = (f) => this.onFrame(f);
    port.onclose = (e) => this.onClosed(e);
  }

  /** Open a port with `connector`, exchange `hello`, and return the session. */
  static async open(connector: Connector, params: HelloParams, signal?: AbortSignal): Promise<Session> {
    const helloFrame = clientFrame.enc({ kind: "request", id: 0, method: "hello", params: helloParams.enc(params) });
    let opened;
    try {
      opened = await connector.open(helloFrame, signal);
    } catch (e) {
      if (isMdbaseError(e)) throw e;
      throw mdbaseError("unavailable", `cannot reach the replica (${connector.description}): ${String(e)}`);
    }
    let hello: HelloResult;
    try {
      const f = clientFrame.dec(opened.helloResponse);
      if (f.kind !== "response" || f.id !== 0) throw mdbaseError("internal", "replica answered hello with another frame");
      if (f.problem) throw new MdbaseError(f.problem);
      hello = helloResult.dec(f.result ?? null);
    } catch (e) {
      opened.port.close();
      throw schemaToError(e, "hello");
    }
    const s = new Session(opened.port, hello);
    s.device = opened.device;
    return s;
  }

  get closed(): boolean {
    return this.closedFlag;
  }

  /** The error the session closed with, if any. */
  get error(): MdbaseError | undefined {
    return this.closeError;
  }

  onClose(fn: (e?: MdbaseError) => void): () => void {
    if (this.closedFlag) {
      queueMicrotask(() => fn(this.closeError));
      return () => {};
    }
    this.closeListeners.add(fn);
    return () => this.closeListeners.delete(fn);
  }

  /** Internal READ bridge, only this session's actual held private port. Never
   * retries onto another session or exposes a guessed native session identifier. */
  async readAppBases(bytes: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
    if (this.closedFlag) throw this.closeError ?? mdbaseError("unavailable", "session closed");
    if (signal?.aborted) throw mdbaseError("cancelled", "Bases read cancelled");
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 128 * 1024) throw mdbaseError("invalid_request", "Bases request bytes exceed bound");
    const port = this.port;
    if (typeof port.readAppBases !== "function") throw mdbaseError("invalid_request", "this transport does not support app Bases reads", {reason: "unsupported"});
    const reply = await port.readAppBases(bytes, signal);
    if (signal?.aborted) throw mdbaseError("cancelled", "Bases read cancelled");
    if (this.closedFlag || this.port !== port) throw this.closeError ?? mdbaseError("unavailable", "original Bases session closed");
    if (!(reply instanceof Uint8Array) || !reply.length || reply.length > 16 * 1024 * 1024) throw mdbaseError("internal", "Bases response bytes exceed bound");
    return reply;
  }

  /** Private native metadata READ on the original held session only. */
  async readAppBasesDiscovery(operation: "list-views" | "read-view-source", bytes: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
    if (this.closedFlag) throw this.closeError ?? mdbaseError("unavailable", "session closed");
    if (signal?.aborted) throw mdbaseError("cancelled", "Bases discovery cancelled");
    if (operation !== "list-views" && operation !== "read-view-source") throw mdbaseError("invalid_request", "unknown native Bases read");
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 128 * 1024) throw mdbaseError("invalid_request", "Bases request bytes exceed bound");
    const port = this.port;
    if (typeof port.readAppBasesDiscovery !== "function") throw mdbaseError("invalid_request", "this transport does not support native Bases discovery", {reason:"unsupported"});
    const reply = await port.readAppBasesDiscovery(operation,bytes,signal);
    try {
      if (signal?.aborted) throw mdbaseError("cancelled", "Bases discovery cancelled");
      if (this.closedFlag || this.port !== port) throw this.closeError ?? mdbaseError("unavailable", "original Bases session closed");
      if (!(reply instanceof Uint8Array) || !reply.length || reply.length > 1024 * 1024) throw mdbaseError("internal", "Bases discovery response bytes exceed bound");
      return reply;
    } catch (error) { if (reply instanceof Uint8Array) reply.fill(0); throw error; }
  }

  /** Send a request and wait for its result, decoded with `codec` when given. */
  request<T = CborValue>(
    method: string,
    params: CborValue,
    opts: { signal?: AbortSignal; codec?: Codec<T> } = {},
  ): Promise<T> {
    if (this.closedFlag) {
      return Promise.reject(this.closeError ?? mdbaseError("unavailable", "session closed"));
    }
    if (opts.signal?.aborted) return Promise.reject(mdbaseError("cancelled", "request aborted before sending"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        // The request completes with `cancelled` from the replica; reject now so the
        // caller isn't kept waiting on a slow link.
        try {
          this.sendFrame({ kind: "request", id: this.nextId++, method: "cancel", params: new Map([[0, id]]) });
        } catch { /* Cancellation still settles locally if the port has failed. */ }
        settle.reject(mdbaseError("cancelled", `${method} cancelled`));
      };
      const settle: Pending = {
        resolve: (v) => {
          settle.cleanup();
          try {
            resolve(opts.codec ? opts.codec.dec(v) : (v as T));
          } catch (e) {
            reject(schemaToError(e, `${method} result`));
          }
        },
        reject: (e) => {
          settle.cleanup();
          reject(e);
        },
        cleanup: () => {
          this.pending.delete(id);
          opts.signal?.removeEventListener("abort", onAbort);
        },
      };
      this.pending.set(id, settle);
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        this.sendFrame({ kind: "request", id, method, params });
      } catch (e) {
        settle.reject(isMdbaseError(e) ? e : mdbaseError("unavailable", String(e)));
      }
    });
  }

  /** Listen for pushes of `type`. Returns an unsubscribe function. */
  onPush(type: string, fn: PushHandler): () => void {
    let set = this.pushHandlers.get(type);
    if (!set) this.pushHandlers.set(type, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  /** Serve requests the replica sends to this client (e.g. `fence_apply`). */
  handle(method: string, fn: RequestHandler): void {
    this.requestHandlers.set(method, fn);
  }

  close(): void {
    this.port.close();
    this.onClosed();
  }

  /** Close with a reason (the replica's `closed` push). */
  closeWith(e: MdbaseError): void {
    this.fail(e);
  }

  private sendFrame(f: Parameters<typeof clientFrame.enc>[0]): void {
    this.port.send(clientFrame.enc(f));
  }

  private onFrame(raw: CborValue): void {
    let f;
    try {
      f = clientFrame.dec(raw);
    } catch (e) {
      // An unknown frame kind: a newer replica. Nothing to answer; drop it.
      if (e instanceof SchemaError && e.unknown) return;
      this.fail(mdbaseError("internal", `malformed frame from replica: ${String(e)}`));
      return;
    }
    switch (f.kind) {
      case "response": {
        const p = this.pending.get(f.id);
        if (!p) return;
        if (f.problem) p.reject(new MdbaseError(f.problem));
        else p.resolve(f.result ?? null);
        return;
      }
      case "push": {
        const set = this.pushHandlers.get(f.type);
        if (!set) return; // unknown push types are ignored (§13)
        for (const fn of [...set]) {
          try {
            fn(f.payload);
          } catch (e) {
            // A push handler bug must not break the session.
            queueMicrotask(() => {
              throw e;
            });
          }
        }
        return;
      }
      case "request":
        void this.serve(f.id, f.method, f.params);
        return;
    }
  }

  private async serve(id: number, method: string, params: CborValue): Promise<void> {
    const h = this.requestHandlers.get(method);
    let result: CborValue | undefined;
    let prob: Problem | undefined;
    if (!h) {
      prob = mdbaseError("invalid_request", `client does not serve ${method}`, { reason: "unknown_method" }).toProblem();
    } else {
      try {
        result = await h(params);
      } catch (e) {
        prob = (isMdbaseError(e) ? e : mdbaseError("internal", String(e))).toProblem();
      }
    }
    if (this.closedFlag) return;
    try {
      this.port.send(
        clientFrame.enc(
          prob ? { kind: "response", id, problem: prob } : { kind: "response", id, result: result ?? null },
        ),
      );
    } catch {
      // The port closed meanwhile.
    }
  }

  private fail(e: MdbaseError): void {
    this.port.close();
    this.onClosed(e);
  }

  private onClosed(e?: MdbaseError): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    this.closeError = e;
    const err = e ?? mdbaseError("unavailable", "connection to the replica closed");
    for (const p of [...this.pending.values()]) p.reject(err);
    this.pending.clear();
    for (const fn of [...this.closeListeners]) fn(e);
    this.closeListeners.clear();
  }
}

export { problem as problemCodec };
