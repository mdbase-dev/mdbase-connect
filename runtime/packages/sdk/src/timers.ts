import { isMdbaseError, mdbaseError } from "./errors.js";

/** Backend-independent, content-free Connect control-plane timers. */
export interface DesiredTimer { id: string; fireAt: string }
export interface Timer extends DesiredTimer {
  criterionId: string;
  generation: number;
  status: "scheduled" | "firing" | "fired" | "cancelled";
  createdAt: string;
  updatedAt: string;
  firedAt: string | null;
}
export interface TimerRequestOptions { signal?: AbortSignal }
export interface TimerReconcileInput { namespace: string; criterionId: string; timers: readonly DesiredTimer[] }
export interface TimerList { namespace: string; timers: Timer[]; intentRevision?: number }
/** Caller persists this original identity and desired snapshot BEFORE dispatch. */
export interface TimerOperationIdentity { namespace: string; operationId: string; expectedRevision: number }
export interface TimerRecoverableReconcileInput extends TimerReconcileInput, TimerOperationIdentity {}
export interface TimerOperationReceipt extends TimerOperationIdentity {
  protocolVersion: 1;
  committedRevision: number;
  result: TimerReconciliation;
}
export type TimerOperationLookup = { outcome: "committed"; receipt: TimerOperationReceipt }
  | { outcome: "unknown"; namespace: string; operationId: string };
export interface TimerReconciliation extends TimerList { cancelledIds: string[] }
export interface TimerCancellation { namespace: string; id: string; cancelled: boolean }
export interface TimerChannelRegistration { channelId: string; installationId: string; criteria: string[] }
export interface WebPushChannelOptions extends TimerRequestOptions {
  serviceWorker: ServiceWorkerRegistration;
  criteria?: string[];
  installationId?: string;
}
export interface FcmChannelOptions extends TimerRequestOptions {
  /** Native FCM registration token; never logged or retained by this class. */
  token: string;
  criteria?: string[];
  installationId?: string;
}

/**
 * A narrow retained-app-grant port, supplied by the Connect client. Its owner
 * authenticates fixed timer/channel HTTP routes, enforces grant lifetime and
 * bounds response bodies. No bearer, signer, arbitrary URL or request callback.
 * Writes MUST NOT retry after ambiguous admission. This is not a replica port.
 */
export interface AppTimersPort {
  list(namespace: string, options: TimerRequestOptions): Promise<unknown>;
  put(namespace: string, id: string, body: { criterion_id: string; fire_at: string }, options: TimerRequestOptions): Promise<unknown>;
  cancel(namespace: string, id: string, generation: number | undefined, options: TimerRequestOptions): Promise<unknown>;
  reconcile(namespace: string, body: { criterion_id: string; timers: { id: string; fire_at: string }[] }, options: TimerRequestOptions): Promise<unknown>;
  /** Optional original-operation profile; old ports must refuse, never emulate. */
  reconcileWithReceipt?(namespace: string, body: { criterion_id: string; timers: { id: string; fire_at: string }[];
    recovery: { protocol_version: 1; operation_id: string; expected_revision: number } }, options: TimerRequestOptions): Promise<unknown>;
  lookupOperation?(namespace: string, operationId: string, options: TimerRequestOptions): Promise<unknown>;
  registerWebPush(options: WebPushChannelOptions): Promise<TimerChannelRegistration>;
  unregisterWebPush(serviceWorker: ServiceWorkerRegistration | undefined, options: TimerRequestOptions): Promise<void>;
  registerFcm(options: FcmChannelOptions): Promise<TimerChannelRegistration & { transport: "fcm" }>;
  unregisterFcm(options: TimerRequestOptions): Promise<void>;
  /** Close an owned retained-grant port; never remove persistent channels. */
  close?(): void;
}

const NS = /^[A-Za-z0-9._-]{1,64}$/;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i;
const MAX_TIMERS = 10_000;
const invalid = () => mdbaseError("invalid_request", "Invalid opaque timer request.");
const badResponse = () => mdbaseError("internal", "Invalid control-plane timer response.", "invalid_timer_response");
function instant(value: unknown): value is string {
  return typeof value === "string" && INSTANT.test(value) && Number.isFinite(Date.parse(value));
}
function namespace(value: string): void { if (typeof value !== "string" || !NS.test(value)) throw invalid(); }
function id(value: string): void { if (typeof value !== "string" || !ID.test(value)) throw invalid(); }
function criterion(value: string): void { if (typeof value !== "string" || !value.length || value.length > 100) throw invalid(); }
function desired(value: DesiredTimer): { id: string; fire_at: string } {
  if (!value || Object.keys(value).some(k => k !== "id" && k !== "fireAt")) throw invalid();
  id(value.id);
  if (!instant(value.fireAt)) throw invalid();
  return { id: value.id, fire_at: new Date(value.fireAt).toISOString() };
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw badResponse();
  return value as Record<string, unknown>;
}
function timer(value: unknown): Timer {
  const r = object(value);
  if (typeof r.id !== "string" || !ID.test(r.id) || typeof r.criterion_id !== "string"
    || !r.criterion_id.length || r.criterion_id.length > 100 || !instant(r.fire_at)
    || !Number.isSafeInteger(r.generation) || (r.generation as number) < 1
    || !["scheduled", "firing", "fired", "cancelled"].includes(r.status as string)
    || !instant(r.created_at) || !instant(r.updated_at)
    || (r.fired_at !== null && !instant(r.fired_at))) throw badResponse();
  // Do not forward server-side optional `data` or arbitrary response properties.
  return { id: r.id, criterionId: r.criterion_id, fireAt: r.fire_at,
    generation: r.generation as number, status: r.status as Timer["status"],
    createdAt: r.created_at, updatedAt: r.updated_at, firedAt: r.fired_at as string | null };
}
function list(value: unknown, expected: string): TimerList {
  const r = object(value);
  if (r.namespace !== expected || !Array.isArray(r.timers) || r.timers.length > MAX_TIMERS) throw badResponse();
  const timers = r.timers.map(timer);
  if (new Set(timers.map(t => t.id)).size !== timers.length) throw badResponse();
  if (r.intent_revision !== undefined && (!Number.isSafeInteger(r.intent_revision) || (r.intent_revision as number) < 0)) throw badResponse();
  return { namespace: expected, timers, ...(r.intent_revision === undefined ? {} : { intentRevision: r.intent_revision as number }) };
}
function operationIdentity(input: TimerOperationIdentity): TimerOperationIdentity {
  const { namespace: ns, operationId, expectedRevision } = input;
  namespace(ns);
  if (typeof operationId !== "string" || !UUID7.test(operationId) || !Number.isSafeInteger(expectedRevision)
    || expectedRevision < 0 || expectedRevision === Number.MAX_SAFE_INTEGER) throw invalid();
  return { namespace: ns, operationId, expectedRevision };
}
function reconciliation(value: unknown, ns: string): TimerReconciliation {
  const raw = object(value), result = list(raw, ns);
  if (!Array.isArray(raw.cancelled_ids) || raw.cancelled_ids.length > MAX_TIMERS
    || raw.cancelled_ids.some(v => typeof v !== "string" || !ID.test(v))
    || new Set(raw.cancelled_ids).size !== raw.cancelled_ids.length) throw badResponse();
  return { ...result, cancelledIds: [...raw.cancelled_ids] as string[] };
}
function receipt(value: unknown, identity: TimerOperationIdentity): TimerOperationReceipt {
  const r = object(value);
  if (r.protocol_version !== 1 || r.namespace !== identity.namespace || r.operation_id !== identity.operationId
    || r.expected_revision !== identity.expectedRevision || r.committed_revision !== identity.expectedRevision + 1
    || Object.keys(r).some(k => !["protocol_version", "namespace", "operation_id", "expected_revision", "committed_revision", "result"].includes(k))) throw badResponse();
  const rawResult = object(r.result);
  if (Object.keys(rawResult).some(k => !["namespace", "timers", "cancelled_ids"].includes(k))) throw badResponse();
  const result = reconciliation(rawResult, identity.namespace);
  const fields = ["id", "criterion_id", "fire_at", "generation", "status", "created_at", "updated_at", "fired_at"];
  for (const raw of rawResult.timers as unknown[]) if (Object.keys(object(raw)).some(k => !fields.includes(k))) throw badResponse();
  if (result.cancelledIds.some(id => result.timers.some(t => t.id === id))) throw badResponse();
  return { protocolVersion: 1, ...identity, committedRevision: r.committed_revision as number, result };
}

/** Opaque timer HTTP API. Works without opening a data-replica/Noise session. */
export class TimersApi {
  private readonly lifetime = new AbortController();
  constructor(private readonly port: AppTimersPort) {}
  /** Stops this facade; an uncertain write is never replayed or reported cancelled. */
  close(): void {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort();
    this.port.close?.();
  }
  private async run<T>(options: TimerRequestOptions, write: boolean, f: (options: TimerRequestOptions) => Promise<T>): Promise<T> {
    const signal = options.signal ? AbortSignal.any([this.lifetime.signal, options.signal]) : this.lifetime.signal;
    if (signal.aborted) throw mdbaseError("cancelled", "Timer request cancelled before dispatch.");
    let result: T;
    try { result = await f({ signal }); }
    catch (error) {
      // Connect's narrow HTTP port reports uncertain admission in its structured
      // problem. Do not leak a foreign error class into mutation outcome handling.
      const outcome = error && typeof error === "object"
        ? (error as { problem?: { operation_outcome?: unknown } }).problem?.operation_outcome
        : undefined;
      if (write && outcome === "unknown") {
        throw mdbaseError("outcome_unknown", "Timer or channel write outcome is unknown.");
      }
      if (write && isMdbaseError(error, "internal") && error.reason === "invalid_timer_response") {
        throw mdbaseError("outcome_unknown", "Timer write returned an invalid response.");
      }
      throw error;
    }
    if (signal.aborted) throw mdbaseError(write ? "outcome_unknown" : "cancelled", "Timer request ended before its response was observed.");
    return result;
  }
  list(namespaceId: string, options: TimerRequestOptions = {}): Promise<TimerList> {
    namespace(namespaceId);
    return this.run(options, false, async o => list(await this.port.list(namespaceId, o), namespaceId));
  }
  put(input: { namespace: string; criterionId: string; timer: DesiredTimer }, options: TimerRequestOptions = {}): Promise<Timer> {
    namespace(input.namespace); criterion(input.criterionId);
    const d = desired(input.timer);
    const ns = input.namespace, c = input.criterionId;
    return this.run(options, true, async o => {
      const r = timer(await this.port.put(ns, d.id, { criterion_id: c, fire_at: d.fire_at }, o));
      if (r.id !== d.id || r.criterionId !== c || Date.parse(r.fireAt) !== Date.parse(d.fire_at)) throw badResponse();
      // An identical PUT may return fired: it must not be treated as re-armed.
      return r;
    });
  }
  cancel(input: { namespace: string; id: string; generation?: number }, options: TimerRequestOptions = {}): Promise<TimerCancellation> {
    namespace(input.namespace); id(input.id);
    if (input.generation !== undefined && (!Number.isSafeInteger(input.generation) || input.generation < 1)) throw invalid();
    const { namespace: ns, id: timerId, generation } = input;
    return this.run(options, true, async o => {
      const r = object(await this.port.cancel(ns, timerId, generation, o));
      if (r.namespace !== ns || r.id !== timerId || typeof r.cancelled !== "boolean") throw badResponse();
      return { namespace: ns, id: timerId, cancelled: r.cancelled };
    });
  }
  reconcile(input: TimerReconcileInput, options: TimerRequestOptions = {}): Promise<TimerReconciliation> {
    namespace(input.namespace); criterion(input.criterionId);
    if (!Array.isArray(input.timers) || input.timers.length > MAX_TIMERS) throw invalid();
    const timers = input.timers.map(desired);
    const expected = new Map(timers.map(t => [t.id, t.fire_at]));
    if (expected.size !== timers.length) throw invalid();
    const ns = input.namespace, c = input.criterionId;
    return this.run(options, true, async o => {
      const raw = object(await this.port.reconcile(ns, { criterion_id: c, timers }, o));
      const result = list(raw, ns);
      if (result.timers.length !== timers.length || result.timers.some(t => !expected.has(t.id)
        || t.criterionId !== c || Date.parse(t.fireAt) !== Date.parse(expected.get(t.id)!))
        || !Array.isArray(raw.cancelled_ids) || raw.cancelled_ids.length > MAX_TIMERS
        || raw.cancelled_ids.some(v => typeof v !== "string" || !ID.test(v) || expected.has(v))
        || new Set(raw.cancelled_ids).size !== raw.cancelled_ids.length) throw badResponse();
      return { ...result, cancelledIds: raw.cancelled_ids as string[] };
    });
  }
  /** No ID generation, journal, automatic replay or consent adoption. */
  reconcileWithReceipt(input: TimerRecoverableReconcileInput, options: TimerRequestOptions = {}): Promise<TimerOperationReceipt> {
    const identity = operationIdentity(input), c = input.criterionId;
    criterion(c);
    if (!Array.isArray(input.timers) || input.timers.length > MAX_TIMERS) throw invalid();
    const timers = input.timers.map(desired), expected = new Map(timers.map(t => [t.id, t.fire_at]));
    if (expected.size !== timers.length) throw invalid();
    const method = this.port.reconcileWithReceipt;
    if (!method) throw mdbaseError("upgrade_required", "Timer port does not support original-operation recovery.", "timer_operation_recovery_unavailable");
    const recovery = { protocol_version: 1 as const, operation_id: identity.operationId, expected_revision: identity.expectedRevision };
    return this.run(options, true, async o => {
      const result = receipt(await method.call(this.port, identity.namespace, { criterion_id: c, timers, recovery }, o), identity);
      if (result.result.timers.length !== timers.length || result.result.timers.some(t => t.criterionId !== c
        || !expected.has(t.id) || Date.parse(t.fireAt) !== Date.parse(expected.get(t.id)!))) throw badResponse();
      return result;
    });
  }
  /** Read-only original receipt lookup. Missing is UNKNOWN, never proof of no effect. */
  lookupOperation(input: TimerOperationIdentity, options: TimerRequestOptions = {}): Promise<TimerOperationLookup> {
    const identity = operationIdentity(input), method = this.port.lookupOperation;
    if (!method) throw mdbaseError("upgrade_required", "Timer port does not support original-operation recovery.", "timer_operation_recovery_unavailable");
    // This is a read-only HTTP lookup, but all failures leave the ORIGINAL
    // mutation unresolved; never expose a lookup-attempt failure as no effect.
    return this.run<TimerOperationLookup>(options, true, async o => {
      const raw = object(await method.call(this.port, identity.namespace, identity.operationId, o));
      if (raw.outcome === "committed" && Object.keys(raw).length === 2) return { outcome: "committed", receipt: receipt(raw.receipt, identity) };
      if (raw.outcome === "unknown" && raw.namespace === identity.namespace && raw.operation_id === identity.operationId
        && Object.keys(raw).length === 3) return { outcome: "unknown", namespace: identity.namespace, operationId: identity.operationId };
      throw badResponse();
    }).catch(() => {
      // Include run's pre-dispatch abort/closed checks: a failed lookup attempt
      // never classifies the ORIGINAL mutation as cancelled or not sent.
      throw mdbaseError("outcome_unknown", "Original timer operation could not be recovered.");
    });
  }
  registerWebPush(options: WebPushChannelOptions): Promise<TimerChannelRegistration> {
    return this.run(options, true, o => this.port.registerWebPush({ ...options, ...o }));
  }
  unregisterWebPush(serviceWorker?: ServiceWorkerRegistration, options: TimerRequestOptions = {}): Promise<void> {
    return this.run(options, true, o => this.port.unregisterWebPush(serviceWorker, o));
  }
  registerFcm(options: FcmChannelOptions): Promise<TimerChannelRegistration & { transport: "fcm" }> {
    return this.run(options, true, o => this.port.registerFcm({ ...options, ...o }));
  }
  unregisterFcm(options: TimerRequestOptions = {}): Promise<void> {
    return this.run(options, true, o => this.port.unregisterFcm(o));
  }
}
