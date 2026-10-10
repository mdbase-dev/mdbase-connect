/** First-party local Core data facade across ONE owned MessagePort.
 * The trusted Worker owns WASM + SQL + keys. This carries only ordinary client
 * frames and bounded native Bases READ bytes, never bootstrap, signing,
 * custody, log tokens, caller session IDs or SQL commands.
 * Same-origin JS remains trusted; this is not a third-party grant boundary.
 * Closing a facade does NOT retire the runtime or release its owner lease.
 */
import { decode, encode, type CborValue } from "../cbor.js";
import { mdbaseError } from "../errors.js";
import { inProcessConnector } from "../transport/inprocess.js";
import { MAX_FRAME, type Connector, type FramePort } from "../transport/port.js";
import type { AppWasmRuntime } from "./wasm-runtime.js";

export interface AppLocalScope {
  readonly account: string;
  readonly installation: string;
  readonly collection: string;
  isCurrent(): boolean;
}
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
const unavailable = () => mdbaseError("unavailable", "app local facade unavailable; reopen and reconcile");
function pin(source: AppLocalScope): { binding: string; current(): boolean } {
  const ids = [source.account, source.installation, source.collection];
  if (ids.some(id => typeof id !== "string" || !UUID.test(id)) || typeof source.isCurrent !== "function") throw unavailable();
  const binding = JSON.stringify(ids.map(id => id.toLowerCase()));
  const check = source.isCurrent.bind(source);
  return { binding, current: () => {
    try { return check() === true && JSON.stringify([source.account, source.installation, source.collection].map(id => id.toLowerCase())) === binding; }
    catch { return false; }
  } };
}
/** Private channel protocol: version, exact original scope, frame/close, bytes.
 * Close/errors are content-free; native failures are not serialized to the UI. */
type BasesRequestPacket = "bases-request" | "bases-list-views-request" | "bases-read-view-source-request";
type BasesPacket = BasesRequestPacket | "bases-response" | "bases-list-views-response" | "bases-read-view-source-response";
const packetKinds = ["bases-request", "bases-response", "bases-list-views-request", "bases-list-views-response", "bases-read-view-source-request", "bases-read-view-source-response"] as const;
const responseFor = (kind: BasesRequestPacket): BasesPacket => kind === "bases-request" ? "bases-response" : kind === "bases-list-views-request" ? "bases-list-views-response" : "bases-read-view-source-response";
const packetMax = (kind: BasesPacket) => kind.endsWith("request") ? 128 * 1024 : kind === "bases-response" ? MAX_FRAME : 1024 * 1024;
function bridge(channel: MessagePort, source: AppLocalScope, receive: (frame: CborValue) => void, ended: () => void,
  bases?: (kind: BasesPacket, id: number, bytes: Uint8Array) => void) {
  const scope = pin(source);
  let closed = false;
  const stop = () => {
    if (closed) return;
    closed = true;
    channel.onmessage = null;
    channel.onmessageerror = null;
    try { channel.postMessage([1, scope.binding, "close"]); } catch { /* fail-stop channel */ }
    channel.close();
    ended();
  };
  const current = () => {
    if (closed || !scope.current()) { stop(); throw unavailable(); }
  };
  channel.onmessageerror = stop;
  channel.onmessage = event => {
    try {
      current();
      const packet: unknown = event.data;
      if (!Array.isArray(packet) || packet[0] !== 1 || packet[1] !== scope.binding) throw unavailable();
      if (packet.length === 3 && packet[2] === "close") { stop(); return; }
      if (packet.length === 5 && packetKinds.includes(packet[2] as BasesPacket)) {
        const kind = packet[2] as BasesPacket, id = packet[3], bytes = packet[4], max = packetMax(kind);
        if (!bases || !Number.isInteger(id) || id < 1 || id > 0xffffffff || !(bytes instanceof Uint8Array) || !bytes.length || bytes.length > max) throw unavailable();
        current(); bases(kind, id, bytes); return;
      }
      if (packet.length !== 4 || packet[2] !== "frame" || !(packet[3] instanceof Uint8Array)
        || packet[3].length === 0 || packet[3].length > MAX_FRAME) throw unavailable();
      const frame = decode(new Uint8Array(packet[3]));
      current();
      receive(frame);
    } catch { stop(); }
  };
  channel.start();
  return {
    close: stop,
    send(frame: CborValue) {
      try {
        current();
        const bytes = encode(frame);
        if (!bytes.length || bytes.length > MAX_FRAME) throw unavailable();
        current();
        // Independently owned encoded bytes, not a caller buffer/Buffer view.
        channel.postMessage([1, scope.binding, "frame", bytes], [bytes.buffer]);
      } catch { stop(); throw unavailable(); }
    },
    /** Internal independently owned full ArrayBuffer, transferred once. */
    control(kind: BasesPacket, id: number, bytes: Uint8Array) {
      try {
        current();
        const max = packetMax(kind);
        if (!Number.isInteger(id) || id < 1 || id > 0xffffffff || !(bytes instanceof Uint8Array) || !bytes.length || bytes.length > max || !(bytes.buffer instanceof ArrayBuffer) || bytes.byteOffset !== 0 || bytes.byteLength !== bytes.buffer.byteLength) throw unavailable();
        current(); channel.postMessage([1, scope.binding, kind, id, bytes], [bytes.buffer]);
      } catch { stop(); throw unavailable(); }
    },
    current,
  };
}

/** Worker-side attachment, AFTER ownership and genuine native bootstrap/adoption.
 * AppWasmRuntime checks the original collection; a caller cannot choose a grant
 * or request a different native authority. No host-control RPC is exposed. */
export function attachAppLocalFacade(runtime: Pick<AppWasmRuntime, "connect"> & Partial<Pick<AppWasmRuntime, "executeBases" | "discoverBases">>, channel: MessagePort, source: AppLocalScope): { close(): void } {
  const original = pin(source);
  if (!original.current()) throw unavailable();
  let native: FramePort;
  try { native = runtime.connect({ collection: source.collection }); }
  catch { channel.close(); throw unavailable(); }
  let wire: ReturnType<typeof bridge>;
  try {
    wire = bridge(channel, source, frame => native.send(frame), () => native.close(), (kind, id, bytes) => {
      let reply: Uint8Array;
      try {
        if (kind === "bases-request" && typeof runtime.executeBases === "function") reply = runtime.executeBases(native, bytes);
        else if ((kind === "bases-list-views-request" || kind === "bases-read-view-source-request") && typeof runtime.discoverBases === "function") reply = runtime.discoverBases(native,kind === "bases-list-views-request" ? "list-views" : "read-view-source",bytes);
        else throw unavailable();
      } finally { bytes.fill(0); }
      try { wire.current(); wire.control(responseFor(kind as BasesRequestPacket), id, reply); }
      catch (error) { if (reply.byteLength) reply.fill(0); throw error; }
    });
    native.onframe = frame => { try { wire.send(frame); } catch { /* closed and fenced facade */ } };
    native.onclose = () => wire.close();
  } catch { native.close(); channel.close(); throw unavailable(); }
  return { close: () => wire.close() };
}

export interface AppLocalConnector extends Connector {
  /** Host MUST call this before Worker termination (also on Worker error), so
   * pending hello/RPCs are rejected rather than waiting on a dead MessagePort. */
  close(): void;
}
/** UI-side data connector. A channel is single-use: replacement requires a new
 * owner-provided channel, never replaying hello or writes into a prior session. */
export function appLocalConnector(channel: MessagePort, source: AppLocalScope): AppLocalConnector {
  const original = pin(source);
  let used = false, closed = false;
  let wire: ReturnType<typeof bridge> | undefined;
  // One outstanding native read per held channel. Cancellation settles locally
  // but retains this slot until the original reply (or close); no queued work.
  let pending: {id: number; response: BasesPacket; finish(bytes?: Uint8Array, error?: unknown): void} | null = null;
  let nextBasesId = 1;
  return {
    description: "app-local",
    close() { closed = true; if (wire) wire.close(); else channel.close(); },
    async open(hello, signal) {
      // Reject a second open without disrupting the first live session.
      if (used) throw unavailable();
      if (!original.current() || signal?.aborted || closed) { channel.close(); throw unavailable(); }
      used = true;
      let port: FramePort | undefined;
      const active = wire = bridge(channel, source, frame => port?.onframe?.(frame), () => {
        const stopped = pending; pending = null; stopped?.finish(undefined, unavailable());
        port?.onclose?.(unavailable());
      }, (kind, id, bytes) => {
        if (!pending || kind !== pending.response || id !== pending.id) { bytes.fill(0); throw unavailable(); }
        const completed = pending; pending = null; completed.finish(bytes);
      });
      const readBases = (kind: BasesRequestPacket, request: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> => {
          try {
            active.current();
            if (signal?.aborted) throw mdbaseError("cancelled", "Bases read cancelled");
            if (!(request instanceof Uint8Array) || !request.length || request.length > 128 * 1024) throw mdbaseError("invalid_request", "Bases request bytes exceed bound");
            if (pending) throw mdbaseError("too_large", "one Bases read is already outstanding");
            if (nextBasesId > 0xffffffff) { active.close(); throw unavailable(); }
          } catch (error) { return Promise.reject(error); }
          const id = nextBasesId++;
          return new Promise<Uint8Array>((resolve, reject) => {
            let settled = false;
            const finish = (bytes?: Uint8Array, error?: unknown) => {
              if (settled) { bytes?.fill(0); return; } settled = true; signal?.removeEventListener("abort", abort);
              if (error !== undefined) reject(error); else resolve(bytes!);
            };
            const abort = () => finish(undefined, mdbaseError("cancelled", "Bases read cancelled"));
            pending = {id, response:responseFor(kind), finish}; signal?.addEventListener("abort", abort, {once: true});
            try { active.control(kind, id, new Uint8Array(request)); }
            catch (error) { if (pending?.id === id) pending = null; finish(undefined, error); }
          });
      };
      port = { onframe: null, onclose: null, send: frame => active.send(frame), close: () => active.close(),
        readAppBases: (request,signal) => readBases("bases-request",request,signal),
        readAppBasesDiscovery(operation,request,signal) {
          if (operation !== "list-views" && operation !== "read-view-source") return Promise.reject(mdbaseError("invalid_request", "unknown native Bases read"));
          return readBases(operation === "list-views" ? "bases-list-views-request" : "bases-read-view-source-request",request,signal);
        },
      };
      try {
        if (signal?.aborted || closed) throw unavailable();
        return await inProcessConnector({ connect: () => port! }).open(hello, signal);
      } catch { active.close(); throw unavailable(); }
    },
  };
}
