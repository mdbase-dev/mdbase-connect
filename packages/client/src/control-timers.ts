/** Fixed control-plane timer/channel requests, never data-replica operations. */
import type { MdbaseConnection } from "./connection.js";
import type { ConnectRequestOptions } from "./operation-types.js";
import { connectError, MdbaseConnectError } from "./errors.js";
import { base64UrlBytes, bytesToBase64Url, randomBase64Url } from "./base64.js";
import { requestAbortReason, withCooperativeRequestBudget } from "./request-budget.js";

export interface TimerChannelRegistration { channelId: string; installationId: string; criteria: string[] }
export interface WebPushTimerOptions extends ConnectRequestOptions {
  serviceWorker: ServiceWorkerRegistration; criteria?: string[]; installationId?: string;
}
export interface FcmTimerOptions extends ConnectRequestOptions { token: string; criteria?: string[]; installationId?: string }
/** Structurally implements the NEXT SDK's AppTimersPort without an SDK dependency. */
export interface ConnectAppTimersPort {
  list(namespace: string, options: ConnectRequestOptions): Promise<unknown>;
  put(namespace: string, id: string, body: { criterion_id: string; fire_at: string }, options: ConnectRequestOptions): Promise<unknown>;
  cancel(namespace: string, id: string, generation: number | undefined, options: ConnectRequestOptions): Promise<unknown>;
  reconcile(namespace: string, body: { criterion_id: string; timers: { id: string; fire_at: string }[] }, options: ConnectRequestOptions): Promise<unknown>;
  registerWebPush(options: WebPushTimerOptions): Promise<TimerChannelRegistration>;
  unregisterWebPush(serviceWorker: ServiceWorkerRegistration | undefined, options: ConnectRequestOptions): Promise<void>;
  registerFcm(options: FcmTimerOptions): Promise<TimerChannelRegistration & { transport: "fcm" }>;
  unregisterFcm(options: ConnectRequestOptions): Promise<void>;
  close(): void;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const NS = /^[A-Za-z0-9._-]{1,64}$/u;
const ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const fail = () => connectError("invalid_request", "Invalid opaque timer or channel input.");
function segment(s: string, pattern: RegExp): string {
  if (typeof s !== "string" || !pattern.test(s)) throw fail();
  return encodeURIComponent(s);
}
function desired(body: { criterion_id: string; fire_at: string }): { criterion_id: string; fire_at: string } {
  if (!body || typeof body.criterion_id !== "string" || !body.criterion_id.length || body.criterion_id.length > 100
    || typeof body.fire_at !== "string" || !Number.isFinite(Date.parse(body.fire_at))) throw fail();
  return { criterion_id: body.criterion_id, fire_at: body.fire_at };
}
function origin(s: string): string {
  const u = new URL(s);
  if (u.protocol !== "https:" || u.origin !== s.replace(/\/$/u, "")) throw fail();
  return u.origin;
}
async function boundedJSON(response: Response, signal: AbortSignal): Promise<unknown> {
  if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw fail();
  const reader = response.body?.getReader(); if (!reader) throw fail();
  const chunks: Uint8Array[] = []; let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) throw requestAbortReason(signal);
    for (;;) {
      const r = await reader.read();
      if (signal.aborted) throw requestAbortReason(signal);
      if (r.done) break;
      size += r.value.length;
      if (size > 1024 * 1024) throw connectError("invalid_operation_response", "Control-plane metadata exceeds the bounded response budget.");
      chunks.push(r.value);
    }
    const bytes = new Uint8Array(size); let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally {
    chunks.length = 0; signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {}); reader.releaseLock();
  }
}

/** Bind one app consent; scope/mode decisions remain the control plane's authority. */
export function appTimers(connection: MdbaseConnection): ConnectAppTimersPort {
  const transport = connection["transport"], internals = connection["internals"];
  const server = origin(transport["serverUrl"]); // Before reading credentials.
  const initial = transport.currentToken();
  if (!initial?.grantId || !UUID.test(initial.grantId) || !UUID.test(initial.collectionId) || !initial.keyHandle) {
    throw connectError("not_authorized", "A retained app consent is required for timers.");
  }
  const identity = (t: typeof initial) => JSON.stringify([
    t.grantId, t.collectionId, t.clientId, t.keyHandle, t.applicationOrigin,
    t.operations, t.scope, t.encryption, (t as { nextNoise?: unknown }).nextNoise,
    t.authority && [t.authority.replicaId, t.authority.operationsUrl, t.authority.syncUrl, t.authority.filesUrl, t.authority.proofPublicKey]
  ]);
  const pinned = identity(initial), lifetime = new AbortController();
  const prefix = `/v1/next/collections/${initial.collectionId}/timers`;
  const run = async <T>(options: ConnectRequestOptions, write: boolean,
    operation: (request: (path: string, method?: string, data?: unknown, noBody?: boolean) => Promise<unknown>, check: () => void, signal: AbortSignal) => Promise<T>): Promise<T> => {
    const signal = options.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal;
    return withCooperativeRequestBudget({
      ...options, signal,
      timeoutMs: options.timeoutMs == null ? 10_000 : Math.min(options.timeoutMs, 10_000)
    }, 10_000, async budget => {
      const token = transport.currentToken();
      if (!token || identity(token) !== pinned || !Number.isFinite(token.expiresAt) || token.expiresAt <= Date.now()) {
        throw connectError("not_authorized", "The retained timer consent is unavailable.");
      }
      const snapshot = JSON.stringify(token), leases = transport["grantKeyLeases"](); let dispatched = false;
      const check = () => {
        if (budget.signal.aborted) throw requestAbortReason(budget.signal);
        const current = transport.currentToken();
        if (!current || !Number.isFinite(current.expiresAt) || current.expiresAt <= Date.now()
          || JSON.stringify(current) !== snapshot || origin(transport["serverUrl"]) !== server) {
          throw connectError("authority_authorization_changed", "The retained timer consent changed.");
        }
      };
      try {
        await leases.retain(token, budget.signal); check();
        // Private fixed-route helper: never returned or accepted from the caller.
        const request = async (path: string, method = "GET", data?: unknown, noBody = false): Promise<unknown> => {
          check(); const body = data === undefined ? undefined : JSON.stringify(data);
          if (body && new TextEncoder().encode(body).length > 2 * 1024 * 1024) throw fail();
          dispatched ||= write && method !== "GET";
          const response = await fetch(server + path, { method, signal: budget.signal, redirect: "error", credentials: "omit", cache: "no-store",
            headers: { authorization: `Bearer ${token.accessToken}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
            ...(body === undefined ? {} : { body }) });
          try {
            check();
            if (!response.ok) throw connectError(response.status === 401 || response.status === 403 ? "not_authorized" : "operation_failed",
              "Control-plane timer or channel request failed.", { status: response.status,
                operationOutcome: dispatched && response.status >= 500 ? "unknown" : "rejected" });
            const result = noBody ? undefined : await boundedJSON(response, budget.signal);
            check(); return result;
          } finally { if (!response.body?.locked) await response.body?.cancel().catch(() => {}); }
        };
        const result = await operation(request, check, budget.signal); check(); return result;
      } catch (error) {
        if (error instanceof MdbaseConnectError && error.problem.operation_outcome === "rejected") throw error;
        if (dispatched) throw connectError("operation_failed", "Timer or channel write outcome is unknown.", { operationOutcome: "unknown" });
        if (budget.signal.aborted) throw requestAbortReason(budget.signal);
        if (error instanceof MdbaseConnectError) throw error;
        throw connectError("operation_failed", "Control-plane timer or channel request failed.", { operationOutcome: "not_sent" });
      } finally { leases.release(); }
    });
  };
  const registration = async (options: WebPushTimerOptions | FcmTimerOptions, native: boolean): Promise<TimerChannelRegistration> =>
    run(options, true, async (request, check, signal) => {
      const application = await internals.register({ signal, timeoutMs: null }); check();
      const declared = application.notifications?.criteria.map(c => c.id) ?? [];
      const criteria = [...new Set(options.criteria ?? declared)];
      if (!criteria.length || criteria.length > 100 || criteria.some(c => !declared.includes(c))) throw fail();
      if (native && application.notifications?.native_delivery?.mode !== "managed_fcm") throw fail();
      const storageKey = `${internals.notificationKey(initial.collectionId, native ? "fcm" : "web_push")}:control-timers`;
      const previous = internals.storage.getItem(storageKey);
      const saved = previous ? JSON.parse(previous) as TimerChannelRegistration & { grantId?: string; previousTarget?: unknown } : null;
      const installationId = options.installationId ?? (saved && saved.grantId === initial.grantId ? saved.installationId : undefined) ?? randomBase64Url(24);
      if (typeof installationId !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/u.test(installationId)) throw fail();
      if (saved && saved.grantId === initial.grantId) {
        if (!saved.channelId || saved.previousTarget !== undefined) {
          throw connectError("operation_failed", "Channel registration requires reconciliation before replacement.", { operationOutcome: "unknown" });
        }
        if (saved.installationId !== installationId) {
          throw connectError("operation_failed", "Unregister the acknowledged installation before replacing it.", { operationOutcome: "not_sent" });
        }
      }
      let data: unknown;
      if (native) {
        const token = (options as FcmTimerOptions).token;
        if (typeof token !== "string" || !token.length || token.length > 4096) throw fail();
        data = { installation_id: installationId, criteria, transport: "fcm", token };
      } else {
        const worker = (options as WebPushTimerOptions).serviceWorker;
        const keyBody = await request("/v1/notifications/vapid-public-key") as { public_key?: string };
        if (typeof keyBody.public_key !== "string" || !/^[A-Za-z0-9_-]{87}$/u.test(keyBody.public_key)) throw fail();
        const vapid = base64UrlBytes(keyBody.public_key);
        if (vapid.length !== 65 || vapid[0] !== 4 || bytesToBase64Url(vapid) !== keyBody.public_key) throw fail();
        let subscription = await worker.pushManager.getSubscription(); check();
        if (!subscription) {
          subscription = await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapid });
          try { check(); }
          catch (error) { await subscription.unsubscribe().catch(() => false); throw error; }
        }
        const sub = subscription.toJSON();
        if (!sub.endpoint || !sub.keys?.p256dh || !sub.keys.auth) throw fail();
        data = { installation_id: installationId, criteria, subscription: { endpoint: sub.endpoint, expirationTime: sub.expirationTime ?? null, keys: sub.keys } };
      }
      // Persist only this target. A different acknowledged installation must
      // first be explicitly unregistered; uncertain targets cannot be replaced.
      check();
      internals.storage.setItem(storageKey, JSON.stringify({
        installationId, grantId: initial.grantId,
        ...(saved && saved.grantId === initial.grantId && saved.installationId === installationId && saved.channelId ? { channelId: saved.channelId } : {})
      }));
      const result = await request("/v1/notifications/channels", "POST", data) as { channel_id?: string };
      if (typeof result.channel_id !== "string" || !UUID.test(result.channel_id)) throw fail();
      check(); const registration = { channelId: result.channel_id, installationId, criteria };
      internals.storage.setItem(storageKey, JSON.stringify({ ...registration, grantId: initial.grantId }));
      return registration;
    });
  const unregister = async (native: boolean, worker: ServiceWorkerRegistration | undefined, options: ConnectRequestOptions) =>
    run(options, true, async (request, check) => {
      const key = `${internals.notificationKey(initial.collectionId, native ? "fcm" : "web_push")}:control-timers`;
      const saved = internals.storage.getItem(key);
      if (saved) {
        const r = JSON.parse(saved) as TimerChannelRegistration & { grantId?: string; previousTarget?: unknown };
        if (r.grantId !== initial.grantId) throw fail();
        if (!r.channelId || r.previousTarget !== undefined) {
          // An uncertain registration is not proof that no remote channel exists.
          throw connectError("operation_failed", "Channel registration requires reconciliation before removal.", { operationOutcome: "unknown" });
        }
        if (!UUID.test(r.channelId)) throw fail();
        await request(`/v1/notifications/channels/${r.channelId}`, "DELETE", undefined, true); check();
        internals.storage.removeItem(key);
      }
      if (worker) { const sub = await worker.pushManager.getSubscription(); check(); if (sub) { await sub.unsubscribe(); check(); } }
    });
  return Object.freeze({
    list: (ns, o) => run(o, false, request => request(`${prefix}/${segment(ns, NS)}`)),
    put: (ns, id, body, o) => {
      const path = `${prefix}/${segment(ns, NS)}/${segment(id, ID)}`, input = desired(body);
      return run(o, true, request => request(path, "PUT", input));
    },
    cancel: (ns, id, generation, o) => run(o, true, request => {
      if (generation !== undefined && (!Number.isSafeInteger(generation) || generation < 1)) throw fail();
      return request(`${prefix}/${segment(ns, NS)}/${segment(id, ID)}${generation === undefined ? "" : `?generation=${generation}`}`, "DELETE");
    }),
    reconcile: (ns, body, o) => {
      const path = `${prefix}/${segment(ns, NS)}/reconcile`, c = body.criterion_id;
      if (typeof c !== "string" || !c.length || c.length > 100 || !Array.isArray(body.timers) || body.timers.length > 10_000) throw fail();
      const timers = body.timers.map(t => { segment(t.id, ID); return { id: t.id, fire_at: desired({ criterion_id: c, fire_at: t.fire_at }).fire_at }; });
      if (new Set(timers.map(t => t.id)).size !== timers.length) throw fail();
      return run(o, true, request => request(path, "POST", { criterion_id: c, timers }));
    },
    registerWebPush: o => registration({ ...o, criteria: o.criteria ? [...o.criteria] : undefined }, false),
    unregisterWebPush: (worker, o) => unregister(false, worker, o),
    registerFcm: async o => ({ ...await registration({ ...o, criteria: o.criteria ? [...o.criteria] : undefined }, true), transport: "fcm" as const }),
    unregisterFcm: o => unregister(true, undefined, o),
    close: () => lifetime.abort(),
  } satisfies ConnectAppTimersPort);
}
