/** Generic owner-only setup journal/control channel, separate from the ONE native
 * UI data port. No SQL, host/session, ciphertext, signing or credential RPC. */
import { AppCollectionSetupError, decode, modelPackPlan, modelResourcePlan, type AppCollectionSetupJournal } from "./collection-setup-journal.js";
import type { ModelResourcePlan, ModelResourceSetupJournal, ModelSetupIntent, ModelSetupScope } from "./collection-setup-types.js";
import type { PeopleAuthority, PeopleRequestOptions } from "../people.js";
import { mdbaseError } from "../errors.js";
import { collectionPeopleDto, collectionPeopleError, decodeCollectionPeopleError, type CollectionPeopleResource } from "./collection-people.js";

export interface AppCollectionControlBinding {
  readonly scope: ModelSetupScope;
  readonly generation: string;
}
export interface AppResourceAssessment {
  readonly status: "current" | "provision" | "conflict";
  readonly assessmentDigest: string;
}
/** SDK-private producer port. Inputs are declaration DATA, outputs are Core
 * resource DATA/guarded ops only; apply here never submits a mutation. */
export interface AppResourceSetupPort {
  assess(manifest: unknown, signal: AbortSignal): Promise<AppResourceAssessment>;
  apply(manifest: unknown, assessmentDigest: string, signal: AbortSignal): Promise<ModelResourcePlan>;
}
export function resourceAssessment(value: unknown): AppResourceAssessment {
  const v = value as AppResourceAssessment;
  if (!v || typeof v !== "object" || Object.keys(v).sort().join(",") !== "assessmentDigest,status"
    || !["current", "provision", "conflict"].includes(v.status)
    || typeof v.assessmentDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(v.assessmentDigest)) throw fail("binding");
  return Object.freeze({ status: v.status, assessmentDigest: v.assessmentDigest });
}
export interface AppCollectionControlClient {
  readonly resourceSetup: AppResourceSetupPort;
  readonly journal: ModelResourceSetupJournal;
  /** Fixed metadata READ proxy; present only with a people-enabled SDK handoff. */
  readonly peopleAuthority?: PeopleAuthority;
  /** Actual same-scope setup-engine assessment, NOT discovery/readiness authority. */
  assess(state: "ready" | "setup_required", signal: AbortSignal): Promise<void>;
  setForeground(active: boolean, signal: AbortSignal): Promise<void>;
  close(): void;
}
const MAX = 512 * 1024 + 8192;
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
export class AppCollectionControlError extends Error {
  constructor(readonly reason: AppCollectionSetupError["reason"] | "busy") {
    super(`app collection control: ${reason}`); this.name = "AppCollectionControlError";
  }
}
const fail = (reason: AppCollectionControlError["reason"] = "fenced") => new AppCollectionControlError(reason);
function pin(source: AppCollectionControlBinding) {
  const scope = Object.freeze({account: source.scope.account, installation: source.scope.installation, collection: source.scope.collection});
  if (Object.values(scope).some(id => !uuid.test(id) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(id)) || !uuid.test(source.generation)) throw fail("binding");
  return {scope, generation: source.generation, binding: JSON.stringify([scope.account, scope.installation, scope.collection])};
}
function bounded(value: unknown): boolean {
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX; } catch { return false; }
}
type Action = "load" | "prepare" | "prepareResources" | "prepareResourceRound" | "recordAttempt" | "recordConfirmed" | "recordVerified" | "recordResourceAttempt" | "recordResourceConfirmed" | "recordResourceVerified" | "assess" | "foreground" | "peopleIdentity" | "peopleMembers" | "resourcesAssess" | "resourcesApply";
const actions = ["load", "prepare", "prepareResources", "prepareResourceRound", "recordAttempt", "recordConfirmed", "recordVerified", "recordResourceAttempt", "recordResourceConfirmed", "recordResourceVerified", "assess", "foreground", "peopleIdentity", "peopleMembers", "resourcesAssess", "resourcesApply"] as const;
const peopleResource = (action: Action): CollectionPeopleResource | null => action === "peopleIdentity" ? "identity" : action === "peopleMembers" ? "members" : null;
const readAction = (action: Action) => action === "load" || action === "assess" || action === "foreground" || action === "resourcesAssess" || action === "resourcesApply" || peopleResource(action) !== null;

/** Worker-side fixed verbs under the original adapter's child lifetime. */
export function attachAppCollectionControl(port: MessagePort, source: AppCollectionControlBinding, options: {
  journal: AppCollectionSetupJournal;
  /** Closure over the original native facade port, never a host/context loan. */
  resourceSetup?: AppResourceSetupPort;
  /** SAME original host authority; configured privately by the SDK adapter. */
  peopleAuthority?: PeopleAuthority;
  signal: AbortSignal;
  isCurrent(): boolean;
  assess(state: "ready" | "setup_required"): void;
  foreground(active: boolean): void;
  onProtocolFailure(): void;
}): {close(): Promise<void>} {
  options = Object.freeze({...options});
  const original = pin(source);
  let stopped = false, work: Promise<void> | null = null, closing: Promise<void> | null = null, lastId = 0;
  const current = () => {
    if (stopped || options.signal.aborted || options.isCurrent() !== true) throw fail();
  };
  const reply = (id: number, kind: "result" | "error", value: unknown) => {
    current(); const packet = [1, original.binding, original.generation, id, kind, value];
    if (!bounded(packet)) throw fail("binding"); port.postMessage(packet);
  };
  const stop = () => {
    if (stopped) return;
    stopped = true; port.onmessage = port.onmessageerror = null;
    try { port.postMessage([1, original.binding, original.generation, 0, "closed", null]); } catch { /* fail-stop */ }
    port.close();
  };
  const bad = () => { try {stop();} finally {options.onProtocolFailure();} };
  port.onmessageerror = bad;
  port.onmessage = event => {
    const packet: unknown = event.data;
    try {
      current();
      if (Array.isArray(packet) && packet.length === 6 && packet[0] === 1 && packet[1] === original.binding && packet[2] === original.generation && packet[3] === 0 && packet[4] === "detach" && packet[5] === null) {bad(); return;}
      if (!Array.isArray(packet) || packet.length !== 6 || packet[0] !== 1 || packet[1] !== original.binding || packet[2] !== original.generation ||
        !Number.isInteger(packet[3]) || packet[3] < 1 || packet[3] > 0xffffffff || !actions.includes(packet[4] as Action) || !bounded(packet)) throw fail("binding");
      const id: number = packet[3], action: Action = packet[4], payload: unknown = packet[5];
      if (id <= lastId) throw fail("binding"); lastId = id;
      if (work) { reply(id, "error", "busy"); return; }
      const operation = async () => {
        current(); let result: unknown = null;
        switch (action) {
          case "resourcesAssess": case "resourcesApply": {
            const producer = options.resourceSetup;
            if (!producer) throw fail("recovery_required");
            if (action === "resourcesAssess") result = resourceAssessment(await producer.assess(payload, options.signal));
            else {
              if (!Array.isArray(payload) || payload.length !== 2 || typeof payload[1] !== "string"
                || !/^sha256:[0-9a-f]{64}$/.test(payload[1])) throw fail("binding");
              result = modelResourcePlan(await producer.apply(payload[0], payload[1], options.signal));
            }
            current(); break;
          }
          case "peopleIdentity": case "peopleMembers": {
            if (payload !== null) throw fail("binding");
            const authority = options.peopleAuthority;
            if (!authority) throw mdbaseError("upgrade_required", "people metadata is unsupported", "people_unsupported");
            const checkAuthority = () => {
              current();
              if (authority.collection !== original.scope.collection || authority.isCurrent() !== true) throw mdbaseError("unauthenticated", "people scope changed", "people_fenced");
            };
            checkAuthority();
            const resource = peopleResource(action)!;
            const value = await authority.request(resource, {signal: options.signal});
            checkAuthority(); result = collectionPeopleDto(resource, value); checkAuthority();
            // Apply the existing full packet budget AFTER projecting allowed fields.
            if (!bounded([1, original.binding, original.generation, id, "result", result])) throw mdbaseError("unavailable", "invalid people response", "people_response");
            break;
          }
          case "load": if (payload !== null) throw fail("binding"); result = await options.journal.load(options.signal); break;
          case "prepare": result = await options.journal.prepare(modelPackPlan(payload), options.signal); break;
          case "prepareResources": result = await options.journal.prepareResources(modelResourcePlan(payload), options.signal); break;
          case "prepareResourceRound":
            if (!Array.isArray(payload) || payload.length !== 2 || typeof payload[1] !== "string") throw fail("binding");
            result = await options.journal.prepareResourceRound(modelResourcePlan(payload[0]), payload[1], options.signal); break;
          case "assess": if (payload !== "ready" && payload !== "setup_required") throw fail("binding"); options.assess(payload); break;
          case "foreground": if (typeof payload !== "boolean") throw fail("binding"); options.foreground(payload); break;
          default:
            if (typeof payload !== "string" || !uuid.test(payload)) throw fail("binding");
            result = await options.journal[action](payload, options.signal);
        }
        current(); reply(id, "result", result);
      };
      const pending = work = Promise.resolve().then(operation).catch(error => {
        if (stopped || options.signal.aborted) return;
        try {
          const resource = peopleResource(action);
          reply(id, "error", resource ? collectionPeopleError(resource, error) : error instanceof AppCollectionSetupError || error instanceof AppCollectionControlError ? error.reason : "recovery_required");
        }
        catch { bad(); }
      });
      void pending.finally(() => {if (work === pending) work = null;}).catch(() => {});
    } catch { bad(); }
  };
  port.start();
  return {close() {
    if (closing) return closing;
    closing = Promise.resolve().then(async () => { stop(); await work; });
    return closing;
  }};
}

/** UI-side original journal proxy. One outstanding request, no queue/retry/timer.
 * Local cancellation retains the slot until its original reply or channel close. */
export function appCollectionControlClient(port: MessagePort, source: AppCollectionControlBinding, options: {
  signal: AbortSignal; isCurrent(): boolean; onClose(): void;
  /** Set only for a handoff whose original Worker configured people authority. */
  people?: boolean;
}): AppCollectionControlClient {
  options = Object.freeze({...options});
  const original = pin(source);
  let stopped = false, next = 1;
  let pending: {id: number; action: Action; finish(value?: unknown, error?: unknown): void} | null = null;
  const current = () => { if (stopped || options.signal.aborted || options.isCurrent() !== true) throw fail(); };
  const close = () => {
    if (stopped) return; stopped = true;
    options.signal.removeEventListener("abort", close);
    port.onmessage = port.onmessageerror = null;
    const old = pending; pending = null;
    old?.finish(undefined, fail(readAction(old.action) ? "fenced" : "outcome_unknown"));
    try {port.postMessage([1, original.binding, original.generation, 0, "detach", null]);} catch { /* already closed */ }
    try {port.close();} finally {options.onClose();}
  };
  options.signal.addEventListener("abort", close, {once: true});
  port.onmessageerror = close;
  port.onmessage = event => {
    try {
      current(); const packet: unknown = event.data;
      if (!Array.isArray(packet) || packet.length !== 6 || packet[0] !== 1 || packet[1] !== original.binding || packet[2] !== original.generation || !bounded(packet)) throw fail();
      if (packet[3] === 0 && packet[4] === "closed" && packet[5] === null) {close(); return;}
      if (!pending || packet[3] !== pending.id || !["result", "error"].includes(packet[4])) throw fail();
      const completed = pending;
      // Decode while the original waiter is still retained, so a malformed
      // error closes/rejects it instead of abandoning an unsettled promise.
      const error = packet[4] === "error" ? peopleResource(completed.action) && packet[5] !== "busy" ? decodeCollectionPeopleError(packet[5]) : packet[5] === "busy" ? fail("busy") : fail(["binding", "fenced", "recovery_required", "outcome_unknown"].includes(packet[5]) ? packet[5] : "recovery_required") : undefined;
      pending = null;
      completed.finish(packet[4] === "result" ? packet[5] : undefined, error);
    } catch { close(); }
  };
  port.start();
  const request = (action: Action, payload: unknown, signal: AbortSignal): Promise<unknown> => {
    try { current(); if (signal.aborted) throw fail(); if (pending) throw fail("busy"); if (next > 0xffffffff) {close(); throw fail();} }
    catch (error) { return Promise.reject(error); }
    const id = next++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const abort = () => finish(undefined, fail(readAction(action) ? "fenced" : "outcome_unknown"));
      const finish = (value?: unknown, error?: unknown) => {
        if (settled) return; settled = true; signal.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(value);
      };
      pending = {id, action, finish}; signal.addEventListener("abort", abort, {once: true});
      try {
        const packet = [1, original.binding, original.generation, id, action, payload];
        if (!bounded(packet)) throw fail("binding"); port.postMessage(packet);
      } catch (error) {pending = null; finish(undefined, error); close();}
    });
  };
  // A private waiter can settle before a public async wrapper resumes. Fence the
  // ORIGINAL caller again at every delivery boundary, never undo a committed MID.
  const delivery = (action: Action, signal: AbortSignal) => {
    const reason = readAction(action) ? "fenced" : "outcome_unknown";
    try { current(); if (signal.aborted) throw fail(); } catch { throw fail(reason); }
  };
  const intent = async (action: Action, payload: unknown, signal: AbortSignal) => {
    const value = await request(action, payload, signal); delivery(action, signal);
    const decoded = decode(value, original.scope); delivery(action, signal); return decoded;
  };
  const pack = async (action: Action, payload: unknown, signal: AbortSignal) => {
    const value = await intent(action, payload, signal); delivery(action, signal);
    if (value.version !== 2) throw fail("recovery_required"); return value;
  };
  const resource = async (action: Action, payload: unknown, signal: AbortSignal) => {
    const value = await intent(action, payload, signal); delivery(action, signal);
    if (value.version !== 3 && value.version !== 4) throw fail("recovery_required"); return value;
  };
  const journal = Object.freeze<ModelResourceSetupJournal>({
    scope: original.scope,
    async load(signal: AbortSignal) {
      const value = await request("load", null, signal); delivery("load", signal);
      const decoded = value === null ? null : decode(value, original.scope); delivery("load", signal); return decoded;
    },
    prepare: (plan, signal) => pack("prepare", modelPackPlan(plan), signal),
    recordAttempt: (id, signal) => pack("recordAttempt", id, signal),
    recordConfirmed: (id, signal) => pack("recordConfirmed", id, signal),
    recordVerified: (id, signal) => pack("recordVerified", id, signal),
    async prepareResources(plan, signal) { const value = await resource("prepareResources", modelResourcePlan(plan), signal); delivery("prepareResources", signal); if (value.version !== 3) throw fail("recovery_required"); return value; },
    async prepareResourceRound(plan, previousMutationId, signal) { const value = await resource("prepareResourceRound", [modelResourcePlan(plan), previousMutationId], signal); delivery("prepareResourceRound", signal); if (value.version !== 4) throw fail("recovery_required"); return value; },
    recordResourceAttempt: (id, signal) => resource("recordResourceAttempt", id, signal),
    recordResourceConfirmed: (id, signal) => resource("recordResourceConfirmed", id, signal),
    recordResourceVerified: (id, signal) => resource("recordResourceVerified", id, signal),
  });
  const peopleAuthority: PeopleAuthority | undefined = options.people === true ? Object.freeze({
    collection: original.scope.collection,
    isCurrent() {try {current(); return true;} catch {return false;}},
    async request(resource: "identity" | "members", requestOptions: PeopleRequestOptions = {}): Promise<unknown> {
      if (resource !== "identity" && resource !== "members") throw mdbaseError("invalid_request", "invalid people resource");
      const action: Action = resource === "identity" ? "peopleIdentity" : "peopleMembers";
      const signal = requestOptions.signal ?? options.signal;
      try {
        const value = await request(action, null, signal); delivery(action, signal);
        const result = collectionPeopleDto(resource, value); delivery(action, signal); return result;
      } catch (error) {
        // Even a rejected original READ cannot deliver after the caller/scope cuts.
        try {delivery(action, signal);} catch {throw mdbaseError("unauthenticated", "people scope changed", "people_fenced");}
        if (error instanceof AppCollectionControlError) throw mdbaseError(error.reason === "busy" ? "unavailable" : "unauthenticated", "people metadata request failed", error.reason === "busy" ? "people_busy" : "people_fenced");
        throw error;
      }
    },
  }) : undefined;
  const resourceSetup: AppResourceSetupPort = Object.freeze({
    async assess(manifest: unknown, signal: AbortSignal) {
      const value = await request("resourcesAssess", manifest, signal); delivery("resourcesAssess", signal);
      const result = resourceAssessment(value); delivery("resourcesAssess", signal); return result;
    },
    async apply(manifest: unknown, assessmentDigest: string, signal: AbortSignal) {
      if (!/^sha256:[0-9a-f]{64}$/.test(assessmentDigest)) throw fail("binding");
      const value = await request("resourcesApply", [manifest, assessmentDigest], signal); delivery("resourcesApply", signal);
      const result = modelResourcePlan(value); delivery("resourcesApply", signal); return result;
    },
  });
  return Object.freeze({journal, close, resourceSetup, ...(peopleAuthority ? {peopleAuthority} : {}),
    async assess(state: "ready" | "setup_required", signal: AbortSignal) {await request("assess", state, signal); delivery("assess", signal);},
    async setForeground(active: boolean, signal: AbortSignal) {await request("foreground", active, signal); delivery("foreground", signal);},
  });
}
