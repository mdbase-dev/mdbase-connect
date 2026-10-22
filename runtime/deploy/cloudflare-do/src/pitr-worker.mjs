// Required isolated LOG profile: physical/phase restriction is not admission.
// Native REQUIRED remains before SQL/keys; every request still returns503.
import { LogCollection as NativeLogCollection } from "../build/worker/shim.mjs";
import { PitrActorRestriction } from "../../hosted-worker/src/pitr-actor.ts";
import { PitrWork } from "../../hosted-worker/src/pitr-cut.ts";
import { parsePitrBinding } from "../../hosted-worker/src/pitr-phase.ts";

const deny = () => new Response(null, { status: 503, headers: { "cache-control": "no-store" } });
// Private SDK intrinsics only, never remotely callable Worker/DO RPC methods.
const sdkNames = ["prekeyBegin", "prekeyAccept", "prekeyCurrent", "prekeyFinish"];
const sdk = Object.freeze(sdkNames.map(name => NativeLogCollection.prototype[name]));
const hasSdk = sdk.every(method => typeof method === "function");
const sourceFetch = globalThis.fetch.bind(globalThis);
function cpOrigin(value) {
  try {
    if (typeof value !== "string" || value.length > 255 || !/^[!-~]+$/.test(value)) return null;
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value && !url.username && !url.password ? value : null;
  } catch { return null; }
}
function requiredEnv(env) {
  // Do not spread env: getter-backed secrets/bindings must remain untouched.
  const scoped = Object.create(env);
  Object.defineProperty(scoped, "LOGSVC_PITR_REQUIRED", { value: "1" });
  return scoped;
}
export class LogCollection extends NativeLogCollection {
  #state;
  #work;
  #restriction = null;
  #cut = null;
  #native = null;
  #source = null;
  constructor(state, env) {
    const scoped = requiredEnv(env);
    super(state, scoped); // Actual native closed constructor, never ordinary SQL.
    this.#state = state;
    this.#work = new PitrWork(promise => state.waitUntil(promise));
    this.#work.close();
    try {
      const restriction = PitrActorRestriction.fromLog(state, scoped, this.#work);
      if (restriction) {
        this.#cut = restriction.cut(() => this.#stopResources());
        this.#restriction = restriction;
        const origin = hasSdk ? cpOrigin(scoped.CP_URL) : null;
        if (origin) {
          this.#native = Object.freeze({
            begin: request => sdk[0].call(this, request),
            accept: (handle, bytes) => sdk[1].call(this, handle, bytes),
            current: handle => sdk[2].call(this, handle),
            finish: handle => sdk[3].call(this, handle),
          });
          this.#source = Object.freeze({ origin, authority: () => scoped.PITR_AUTHORITY_TOKEN, fetch: sourceFetch });
        }
      }
    } catch { /* Invalid profiles stay CLOSED; never try ordinary construction. */ }
  }
  #stopResources() {
    this.#state.setWebSocketAutoResponse(undefined);
    for (const ws of this.#state.getWebSockets()) { try { ws.close(1008, "PITR closed"); } catch {} }
  }
  async fetch(request) {
    let ticket;
    try {
      const url = new URL(request.url);
      if (this.#restriction && request.method === "POST" && url.pathname === "/v1/rpc"
          && [...url.searchParams].length === 1 && url.searchParams.has("c") && !request.signal.aborted) {
        this.#cut.assertRestrictionIdle();
        ticket = this.#work.beginClosed();
        await this.#restriction.assertSeedCurrent(url.searchParams.get("c"), ticket.signal);
        ticket.check();
        if (request.signal.aborted) throw new Error("pitr_actor_closed");
        if (this.#native && this.#source) {
          await this.#restriction.observeOriginalCp(request, ticket.signal, this.#native, this.#source,
            () => { ticket.check(); this.#cut.assertRestrictionIdle(); });
        }
      }
    } catch { /* Every source/native failure remains CLOSED, never ordinary. */ }
    finally { ticket?.finish(); }
    return deny();
  }
  // Keep the actual native CLOSED lifecycle/sole deleteAlarm await. Its promise
  // participates in THIS work/cut; cancellation or close never settles it early.
  alarm() { return this.#work.trackClosed(() => super.alarm()); }
  webSocketMessage(ws, message) { return this.#work.trackClosed(() => super.webSocketMessage(ws, message)); }
  webSocketClose(ws, code, reason, clean) { return this.#work.trackClosed(() => super.webSocketClose(ws, code, reason, clean)); }
  webSocketError(ws, error) { return this.#work.trackClosed(() => super.webSocketError(ws, error)); }
}
// Hide inherited SDK names on the exported class. Only captured intrinsics above
// can reach native sequencing inside the SAME existing callback Work/Cut.
for (const name of sdkNames) Object.defineProperty(LogCollection.prototype, name, { value: undefined });
const LOCATION_HINTS = new Set(["oc", "apac", "wnam", "enam", "weur"]);
export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const binding = parsePitrBinding(env.PITR_BINDING);
      if (!binding || request.method !== "POST" || url.pathname !== "/v1/rpc"
          || [...url.searchParams].length !== 1 || !url.searchParams.has("c") || request.signal.aborted
          || typeof env.PITR_MINIMUM_EPOCH !== "string" || !/^[1-9][0-9]{0,15}$/.test(env.PITR_MINIMUM_EPOCH)
          || !Number.isSafeInteger(Number(env.PITR_MINIMUM_EPOCH)) || !env.PITR_PHASE) return deny();
      const collection = url.searchParams.get("c");
      if (!binding.members.some(m => m.kind !== "hosted" && m.collection === collection)) return deny();
      const namespace = env.LOG;
      // Same placement rule as the native Worker (src/do_location.rs): absent or
      // empty is the platform default, anything outside the region set refuses.
      const hint = env.LOGSVC_DO_LOCATION_HINT === undefined ? "" : String(env.LOGSVC_DO_LOCATION_HINT).trim();
      if (hint !== "" && !LOCATION_HINTS.has(hint)) return deny();
      const id = namespace.idFromName(collection);
      const stub = hint === "" ? namespace.get(id) : namespace.get(id, { locationHint: hint });
      // Actual request bytes/header/nonce reach ONLY the native pre-key reader;
      // absence of the SDK/public audience retains the metadata-only restriction.
      // Forwarding is DATA, never caller authentication; native missing inputs deny.
      const original = hasSdk && cpOrigin(env.CP_URL) && binding.members.some(m => m.kind === "log" && m.collection === collection);
      await stub.fetch(original ? new Request(request)
        : new Request(url.href, { method: "POST", signal: request.signal }));
    } catch { /* No ordinary Worker fallback, including absent/foreign namespace. */ }
    return deny();
  },
};
