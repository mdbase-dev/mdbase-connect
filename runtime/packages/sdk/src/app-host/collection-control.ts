/** Generic owner-only setup journal/control channel, separate from the ONE native
 * UI data port. No SQL, host/session, ciphertext, signing or credential RPC. */
import { AppCollectionSetupError, decode, modelPackPlan, modelResourcePlan, type AppCollectionSetupJournal } from "./collection-setup-journal.js";
import type { ModelResourcePlan, ModelResourceSetupJournal, ModelSetupIntent, ModelSetupScope } from "./collection-setup-types.js";
import type { PeopleAuthority, PeopleRequestOptions } from "../people.js";
import { mdbaseError } from "../errors.js";
import type { WriteLedgerEntry, WriteLedgerStore } from "../write-ledger.js";
import { ledgerEntry } from "./ledger-rows.js";
import type { AppLedgerRows } from "../app-storage/collection-sql.js";
import { collectionPeopleDto, collectionPeopleError, decodeCollectionPeopleError, type CollectionPeopleResource } from "./collection-people.js";

export interface AppCollectionControlBinding {
  readonly scope: ModelSetupScope;
  readonly generation: string;
}
/** Native Core's reviewable setup (present only when decisions were sent). */
export interface AppResourceReview {
  readonly packs: readonly {
    readonly id: string;
    readonly version: string;
    readonly status: "current" | "install" | "upgrade" | "downgrade" | "reconfigure" | "conflict";
    readonly installedVersion: string | null;
    readonly resources: readonly {
      readonly target: string;
      readonly kind: string;
      readonly mode: "managed" | "seed";
      readonly action: "create" | "update" | "delete" | "adopt" | "preserve" | "conflict";
      readonly installed: boolean;
      readonly currentDigest?: string;
      readonly reason?: string;
    }[];
  }[];
  readonly configuration: readonly { readonly requirement: string; readonly path: string; readonly action: "add" | "conflict"; readonly value?: string | number | boolean | null }[];
  readonly staged: readonly { readonly path: string; readonly document: string }[];
}
export interface AppResourceAssessment {
  readonly status: "current" | "provision" | "conflict";
  readonly assessmentDigest: string;
  readonly review?: AppResourceReview;
}
/** Reviewed decisions: an unmanaged definition target → its exact reviewed digest. */
export interface AppResourceDecisions {
  readonly adopt?: Readonly<Record<string, string>>;
}
/** SDK-private producer port. Inputs are declaration DATA, outputs are Core
 * resource DATA/guarded ops only; apply here never submits a mutation.
 * Passing decisions (even `{}`) asks assess for the review. */
export interface AppResourceSetupPort {
  assess(manifest: unknown, signal: AbortSignal, decisions?: AppResourceDecisions): Promise<AppResourceAssessment>;
  apply(manifest: unknown, assessmentDigest: string, signal: AbortSignal, decisions?: AppResourceDecisions): Promise<ModelResourcePlan>;
  /** Native witness: true only for a FINAL rejected receipt of exactly this
   * mutation on the original session. The only way a round is recorded rejected. */
  rejected?(mutationId: string, signal: AbortSignal): Promise<boolean>;
}
const digestText = /^sha256:[0-9a-f]{64}$/;
const plainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const text = (v: unknown, max = 4096): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
export function resourceDecisions(value: unknown): AppResourceDecisions {
  if (!plainObject(value) || Object.keys(value).some(k => k !== "adopt")) throw fail("binding");
  if (value.adopt === undefined) return Object.freeze({});
  const adopt = value.adopt;
  if (!plainObject(adopt) || Object.keys(adopt).length > 256) throw fail("binding");
  const copy: Record<string, string> = {};
  for (const [target, digest] of Object.entries(adopt)) {
    if (!text(target) || typeof digest !== "string" || !digestText.test(digest)) throw fail("binding");
    copy[target] = digest;
  }
  return Object.freeze({adopt: Object.freeze(copy)});
}
const keys = (v: Record<string, unknown>, required: string, optional: readonly string[] = []) => {
  const want = required.split(",");
  return want.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => want.includes(k) || optional.includes(k));
};
function resourceReview(value: unknown): AppResourceReview {
  if (!plainObject(value) || !keys(value, "configuration,packs,staged")
    || !Array.isArray(value.packs) || value.packs.length > 16
    || !Array.isArray(value.configuration) || value.configuration.length > 64
    || !Array.isArray(value.staged) || value.staged.length > 1024) throw fail("binding");
  const packs = value.packs.map(pack => {
    if (!plainObject(pack) || !keys(pack, "id,installedVersion,resources,status,version") || !text(pack.id, 150) || !text(pack.version, 128)
      || !["current", "install", "upgrade", "downgrade", "reconfigure", "conflict"].includes(pack.status as string)
      || !(pack.installedVersion === null || text(pack.installedVersion, 128)) || !Array.isArray(pack.resources) || pack.resources.length > 1024) throw fail("binding");
    const resources = pack.resources.map(row => {
      if (!plainObject(row) || !keys(row, "action,installed,kind,mode,target", ["currentDigest", "reason"]) || !text(row.target) || !text(row.kind, 64)
        || (row.mode !== "managed" && row.mode !== "seed") || typeof row.installed !== "boolean"
        || !["create", "update", "delete", "adopt", "preserve", "conflict"].includes(row.action as string)
        || (row.currentDigest !== undefined && (typeof row.currentDigest !== "string" || !digestText.test(row.currentDigest)))
        || (row.reason !== undefined && !text(row.reason, 8192))) throw fail("binding");
      return Object.freeze({...row}) as AppResourceReview["packs"][number]["resources"][number];
    });
    return Object.freeze({id: pack.id, version: pack.version, status: pack.status, installedVersion: pack.installedVersion, resources: Object.freeze(resources)}) as AppResourceReview["packs"][number];
  });
  const configuration = value.configuration.map(row => {
    if (!plainObject(row) || !keys(row, "action,path,requirement", ["value"]) || !text(row.requirement, 256) || !text(row.path, 1024)
      || (row.action !== "add" && row.action !== "conflict")
      || !(row.value === undefined || row.value === null || ["string", "number", "boolean"].includes(typeof row.value))) throw fail("binding");
    return Object.freeze({...row}) as AppResourceReview["configuration"][number];
  });
  const staged = value.staged.map(row => {
    if (!plainObject(row) || !keys(row, "document,path") || !text(row.path) || typeof row.document !== "string" || row.document.length > 512 * 1024) throw fail("binding");
    return Object.freeze({path: row.path, document: row.document});
  });
  return Object.freeze({packs: Object.freeze(packs), configuration: Object.freeze(configuration), staged: Object.freeze(staged)});
}
export function resourceAssessment(value: unknown, reviewing = false): AppResourceAssessment {
  const v = value as AppResourceAssessment;
  if (!v || typeof v !== "object" || Object.keys(v).sort().join(",") !== (reviewing ? "assessmentDigest,review,status" : "assessmentDigest,status")
    || !["current", "provision", "conflict"].includes(v.status)
    || typeof v.assessmentDigest !== "string" || !digestText.test(v.assessmentDigest)) throw fail("binding");
  return Object.freeze({ status: v.status, assessmentDigest: v.assessmentDigest, ...(reviewing ? {review: resourceReview(v.review)} : {}) });
}
export interface AppCollectionControlClient {
  readonly resourceSetup: AppResourceSetupPort;
  readonly journal: ModelResourceSetupJournal;
  /** Fixed metadata READ proxy; present only with a people-enabled SDK handoff. */
  readonly peopleAuthority?: PeopleAuthority;
  /** The write ledger's durable store: rows in the replica database. */
  readonly ledger: WriteLedgerStore;
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
type Action = "load" | "prepare" | "prepareResources" | "prepareResourceRound" | "recordAttempt" | "recordConfirmed" | "recordVerified" | "recordResourceAttempt" | "recordResourceConfirmed" | "recordResourceVerified" | "recordResourceRejected" | "assess" | "foreground" | "peopleIdentity" | "peopleMembers" | "resourcesAssess" | "resourcesApply" | LedgerAction;
type LedgerAction = "ledgerList" | "ledgerPut" | "ledgerRemove";
const ledgerAction = (action: Action): action is LedgerAction => action === "ledgerList" || action === "ledgerPut" || action === "ledgerRemove";
/** Ledger rows are small; a listing stays well inside one packet. */
const LEDGER_ROW_MAX = 16 * 1024, LEDGER_LIST_MAX = 448 * 1024;
const actions = ["load", "prepare", "prepareResources", "prepareResourceRound", "recordAttempt", "recordConfirmed", "recordVerified", "recordResourceAttempt", "recordResourceConfirmed", "recordResourceVerified", "recordResourceRejected", "assess", "foreground", "peopleIdentity", "peopleMembers", "resourcesAssess", "resourcesApply", "ledgerList", "ledgerPut", "ledgerRemove"] as const;
const peopleResource = (action: Action): CollectionPeopleResource | null => action === "peopleIdentity" ? "identity" : action === "peopleMembers" ? "members" : null;
const readAction = (action: Action) => action === "load" || action === "assess" || action === "foreground" || action === "resourcesAssess" || action === "resourcesApply" || peopleResource(action) !== null;
const journalAction = (action: Action) => action === "load" || action === "prepare" || action === "prepareResources" || action === "prepareResourceRound" || action.startsWith("record");
/** Shared by every tab's control onto one open collection: the tab whose setup
 * is between its prepare and its verified/rejected step. */
export interface AppCollectionSetupTurn { owner: object | null }

/** Worker-side fixed verbs under the original adapter's child lifetime. */
export function attachAppCollectionControl(port: MessagePort, source: AppCollectionControlBinding, options: {
  journal: AppCollectionSetupJournal;
  /** Closure over the original native facade port, never a host/context loan. */
  resourceSetup?: AppResourceSetupPort;
  /** SAME original host authority; configured privately by the SDK adapter. */
  peopleAuthority?: PeopleAuthority;
  /** Write-ledger rows in the replica database; answered at once, beside other verbs. */
  ledger?(): AppLedgerRows | null;
  /** One per open collection, shared by every tab's control. While one tab's
   * setup is in progress, another tab's journal requests are refused `busy`
   * (not started), so it waits for that setup instead of racing its steps. */
  setupTurn?: AppCollectionSetupTurn;
  signal: AbortSignal;
  isCurrent(): boolean;
  assess(state: "ready" | "setup_required"): void;
  foreground(active: boolean): void;
  onProtocolFailure(): void;
}): {close(): Promise<void>} {
  options = Object.freeze({...options});
  const original = pin(source);
  let stopped = false, work: Promise<void> | null = null, closing: Promise<void> | null = null, lastId = 0;
  const me = {}, turn = options.setupTurn;
  const release = () => { if (turn?.owner === me) turn.owner = null; };
  const current = () => {
    if (stopped || options.signal.aborted || options.isCurrent() !== true) throw fail();
  };
  const reply = (id: number, kind: "result" | "error", value: unknown) => {
    current(); const packet = [1, original.binding, original.generation, id, kind, value];
    if (!bounded(packet)) throw fail("binding"); port.postMessage(packet);
  };
  const stop = () => {
    if (stopped) return;
    stopped = true; release(); port.onmessage = port.onmessageerror = null;
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
      if (ledgerAction(action)) {
        // Synchronous SQLite between native calls: never queued behind setup work.
        let result: unknown = null;
        try {
          const rows = options.ledger?.() ?? null;
          if (!rows) throw fail("recovery_required");
          if (action === "ledgerList") { if (payload !== null) throw fail("binding"); result = rows.list(LEDGER_LIST_MAX); }
          else if (action === "ledgerRemove") { if (typeof payload !== "string" || !uuid.test(payload)) throw fail("binding"); rows.remove(payload); }
          else {
            if (!Array.isArray(payload) || payload.length !== 2 || typeof payload[0] !== "string" || !uuid.test(payload[0])
              || typeof payload[1] !== "string" || payload[1].length > LEDGER_ROW_MAX) throw fail("binding");
            rows.put(payload[0], payload[1]);
          }
        } catch (error) { reply(id, "error", error instanceof AppCollectionControlError ? error.reason : "recovery_required"); return; }
        reply(id, "result", result); return;
      }
      if (work) { reply(id, "error", "busy"); return; }
      if (turn && journalAction(action) && turn.owner !== null && turn.owner !== me) { reply(id, "error", "busy"); return; }
      const operation = async () => {
        current(); let result: unknown = null;
        switch (action) {
          case "resourcesAssess": case "resourcesApply": {
            const producer = options.resourceSetup;
            if (!producer) throw fail("recovery_required");
            // Decisions travel as an array member; a manifest is never an array.
            if (action === "resourcesAssess") {
              const reviewing = Array.isArray(payload);
              if (reviewing && payload.length !== 2) throw fail("binding");
              result = reviewing ? resourceAssessment(await producer.assess(payload[0], options.signal, resourceDecisions(payload[1])), true)
                : resourceAssessment(await producer.assess(payload, options.signal));
            } else {
              if (!Array.isArray(payload) || (payload.length !== 2 && payload.length !== 3) || typeof payload[1] !== "string"
                || !digestText.test(payload[1])) throw fail("binding");
              result = modelResourcePlan(payload.length === 3
                ? await producer.apply(payload[0], payload[1], options.signal, resourceDecisions(payload[2]))
                : await producer.apply(payload[0], payload[1], options.signal));
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
          // The owner starting a new recovery pass ends its turn: any tab may recover.
          case "load": if (payload !== null) throw fail("binding"); release(); result = await options.journal.load(options.signal); break;
          case "prepare": result = await options.journal.prepare(modelPackPlan(payload), options.signal); current(); if (turn) turn.owner = me; break;
          case "prepareResources": result = await options.journal.prepareResources(modelResourcePlan(payload), options.signal); current(); if (turn) turn.owner = me; break;
          case "prepareResourceRound":
            if (!Array.isArray(payload) || payload.length !== 2 || typeof payload[1] !== "string") throw fail("binding");
            result = await options.journal.prepareResourceRound(modelResourcePlan(payload[0]), payload[1], options.signal); current(); if (turn) turn.owner = me; break;
          case "assess": if (payload !== "ready" && payload !== "setup_required") throw fail("binding"); options.assess(payload); break;
          case "foreground": if (typeof payload !== "boolean") throw fail("binding"); options.foreground(payload); break;
          case "recordResourceRejected": {
            // "Applied nothing, may replace" is never taken on the UI's word:
            // only a final native rejection of the journaled mutation counts.
            // The journal then binds it to that intent's exact predecessor.
            if (typeof payload !== "string" || !uuid.test(payload)) throw fail("binding");
            const witness = options.resourceSetup?.rejected;
            if (!witness || await witness(payload, options.signal) !== true) throw fail("recovery_required");
            current(); result = await options.journal.recordResourceRejected(payload, options.signal); release(); break;
          }
          default:
            if (typeof payload !== "string" || !uuid.test(payload)) throw fail("binding");
            result = await options.journal[action](payload, options.signal);
            if (action === "recordVerified" || action === "recordResourceVerified") release();
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
  const side = new Map<number, (value?: unknown, error?: unknown) => void>();
  const current = () => { if (stopped || options.signal.aborted || options.isCurrent() !== true) throw fail(); };
  const close = () => {
    if (stopped) return; stopped = true;
    options.signal.removeEventListener("abort", close);
    port.onmessage = port.onmessageerror = null;
    const old = pending; pending = null;
    old?.finish(undefined, fail(readAction(old.action) ? "fenced" : "outcome_unknown"));
    for (const finish of side.values()) finish(undefined, fail("fenced"));
    side.clear();
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
      const sideFinish = side.get(packet[3]);
      if (sideFinish && ["result", "error"].includes(packet[4])) {
        side.delete(packet[3]);
        sideFinish(packet[4] === "result" ? packet[5] : undefined, packet[4] === "error" ? fail(packet[5] === "binding" ? "binding" : "recovery_required") : undefined);
        return;
      }
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
  const sideRequest = (action: LedgerAction, payload: unknown): Promise<unknown> => {
    try { current(); if (next > 0xffffffff) {close(); throw fail();} }
    catch (error) { return Promise.reject(error); }
    const id = next++;
    return new Promise((resolve, reject) => {
      side.set(id, (value, error) => error ? reject(error) : resolve(value));
      try {
        const packet = [1, original.binding, original.generation, id, action, payload];
        if (!bounded(packet)) throw fail("binding"); port.postMessage(packet);
      } catch (error) {side.delete(id); reject(error);}
    });
  };
  const ledger: WriteLedgerStore = Object.freeze({
    async list() {
      const rows = await sideRequest("ledgerList", null);
      if (!Array.isArray(rows)) throw fail("recovery_required");
      return rows.flatMap((row: unknown) => {
        try { const entry = ledgerEntry(JSON.parse(String(row))); return entry ? [entry] : []; } catch { return []; }
      });
    },
    async put(entry: WriteLedgerEntry) { await sideRequest("ledgerPut", [entry.mutationId, JSON.stringify(entry)]); },
    async remove(mutationId: string) { await sideRequest("ledgerRemove", mutationId); },
  });
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
    recordResourceRejected: (id, signal) => resource("recordResourceRejected", id, signal),
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
    async assess(manifest: unknown, signal: AbortSignal, decisions?: AppResourceDecisions) {
      const reviewing = decisions !== undefined;
      const value = await request("resourcesAssess", reviewing ? [manifest, resourceDecisions(decisions)] : manifest, signal); delivery("resourcesAssess", signal);
      const result = resourceAssessment(value, reviewing); delivery("resourcesAssess", signal); return result;
    },
    async apply(manifest: unknown, assessmentDigest: string, signal: AbortSignal, decisions?: AppResourceDecisions) {
      if (!digestText.test(assessmentDigest)) throw fail("binding");
      const value = await request("resourcesApply", decisions === undefined ? [manifest, assessmentDigest] : [manifest, assessmentDigest, resourceDecisions(decisions)], signal); delivery("resourcesApply", signal);
      const result = modelResourcePlan(value); delivery("resourcesApply", signal); return result;
    },
  });
  return Object.freeze({journal, close, resourceSetup, ledger, ...(peopleAuthority ? {peopleAuthority} : {}),
    async assess(state: "ready" | "setup_required", signal: AbortSignal) {await request("assess", state, signal); delivery("assess", signal);},
    async setForeground(active: boolean, signal: AbortSignal) {await request("foreground", active, signal); delivery("foreground", signal);},
  });
}
