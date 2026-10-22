import type { MdbaseClient } from "../client.js";
import type { Session } from "../session.js";
import type { Op, Receipt } from "../wire.js";
import { MdbaseError, isMdbaseError, mdbaseError } from "../errors.js";
import { decode, modelResourcePlan } from "../app-host/collection-setup-journal.js";
import type { ModelResourceSetupJournal, ModelSetupIntent } from "../app-host/collection-setup-types.js";
import { catalogFingerprint, statusStamp } from "../app-host/collection-readiness.js";
import { AppCollectionControlError, resourceDecisions, type AppResourceAssessment, type AppResourceDecisions, type AppResourceSetupPort } from "../app-host/collection-control.js";
import { versionRelation } from "../semver.js";
import { setupPlan, setupRecords, type MdbaseSetupPlan, type MdbaseSetupPlanOptions, type MdbaseSetupRecord } from "./setup.js";
import type { AppReplicaScope } from "../app-host/owner.js";
import type { AppWebCollectionHandoff } from "../app-host/web-collection.js";
import type { compileApplicationManifest } from "./manifest.js";
import type { MdbaseApplicationFacetSnapshot, MdbaseApplicationRequestOptions } from "./entry.js";

export interface ApplicationConfigurationInput {
  readonly client: MdbaseClient;
  readonly compiledManifest: ReturnType<typeof compileApplicationManifest>;
  readonly journal: ModelResourceSetupJournal;
  readonly scope: Readonly<AppReplicaScope>;
  readonly generation: string;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  readonly setupMode: AppWebCollectionHandoff["setupMode"];
}
/** SDK-internal Core producer seam, not an application constructor option.
 * Implementations use the SAME native collection/control slot. Planning returns
 * immutable DATA, not a receipt, native authority or aggregate readiness. */
export type ApplicationConfigurationResources = AppResourceSetupPort;
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const hash = /^sha256:[0-9a-f]{64}$/;
const failure = (reason: string) => mdbaseError("unavailable", "application configuration unavailable", `configuration_${reason}`);
interface SetupRequest {
  readonly decisions?: AppResourceDecisions;
  /** The reviewed plan digest; a different assessment refuses `setup_changed`. */
  readonly expected?: string;
  readonly records?: readonly MdbaseSetupRecord[];
}
const changed = (mutationId?: string, cause?: unknown) => new MdbaseError(
  mdbaseError("conflict", "This collection changed since the setup was reviewed. Review it again.", "setup_changed").toProblem(),
  { ...(mutationId ? { mutationId } : {}), ...(cause === undefined ? {} : { cause }) });
/** Native refuses an adoption that no longer matches its reviewed row
 * (changed, deleted or no longer adoptable): that is a stale review. */
const reviewed = async <T>(work: Promise<T>, decisions: AppResourceDecisions | undefined): Promise<T> => {
  try { return await work; } catch (error) {
    if (decisions?.adopt && Object.keys(decisions.adopt).length && isMdbaseError(error, "unavailable") && error.reason === "resource_setup_unavailable")
      throw changed(undefined, error);
    throw error;
  }
};
/** R5.7: packs this collection has at a NEWER version than the app ships.
 * Same major: compatible, the app reads and writes with the installed
 * definitions (unknown fields are kept), so setup leaves the pack alone.
 * Different major: the app must be updated. Core reports both as `conflict`. */
export interface NewerPacks {
  /** Kept as installed: same major, newer version, no resource conflict. */
  readonly kept: readonly { readonly id: string; readonly version: string; readonly installedVersion: string }[];
  readonly compatible: ReadonlySet<string>;
  /** Installed at a newer major: the app must be updated. */
  readonly major: readonly string[];
}
export function newerPacks(assessed: AppResourceAssessment): NewerPacks {
  const compatible = new Set<string>(), major: string[] = [], kept: NewerPacks["kept"][number][] = [];
  for (const pack of assessed.review?.packs ?? []) {
    if (pack.status !== "conflict" && pack.status !== "downgrade") continue;
    const relation = pack.installedVersion ? versionRelation(pack.installedVersion, pack.version) : "unknown";
    // A resource-level conflict is a real conflict, whatever the versions.
    if (relation === "installed_newer" && !pack.resources.some(r => r.action === "conflict")) {
      compatible.add(pack.id); kept.push(Object.freeze({ id: pack.id, version: pack.version, installedVersion: pack.installedVersion! }));
    } else if (relation === "installed_newer_major") major.push(pack.id);
  }
  return Object.freeze({ kept: Object.freeze(kept), compatible, major: Object.freeze(major) });
}
/** The declaration without the given type packs (`provisions.type_packs[].manifest.id`). */
export function withoutPacks(manifest: unknown, ids: ReadonlySet<string>): unknown {
  const m = manifest as { provisions?: { type_packs?: readonly { manifest?: { id?: unknown } }[] } };
  const packs = m.provisions?.type_packs;
  if (!ids.size || !Array.isArray(packs)) return manifest;
  return { ...m, provisions: { ...m.provisions, type_packs: packs.filter(p => !(typeof p?.manifest?.id === "string" && ids.has(p.manifest.id))) } };
}
/** How long one request waits for this tab's control slot (held by people
 * metadata, or by another tab's setup in progress) before it reports busy. */
const SLOT_WAIT_MS = 15000;
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(signal.reason); return; }
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
  signal.addEventListener("abort", abort, { once: true });
});
/** A control request refused `busy` was never started: wait for the slot and
 * send it again. Still refused after SLOT_WAIT_MS: `configuration_busy_timeout`,
 * a recoverable problem. Never start a second automatic 15-second wait. */
function patient<T extends object>(target: T): T {
  return new Proxy({} as T, { get(_unused, key) {
    const value: unknown = Reflect.get(target, key, target);
    if (typeof value !== "function") return value;
    return async (...args: unknown[]) => {
      const signal = args.find((arg): arg is AbortSignal => arg instanceof AbortSignal);
      const until = Date.now() + SLOT_WAIT_MS;
      for (let delay = 25; ; delay = Math.min(delay * 2, 500)) {
        try { return await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args); } catch (error) {
          if (!(error instanceof AppCollectionControlError && error.reason === "busy") || !signal) throw error;
          if (Date.now() + delay > until) throw failure("busy_timeout");
          await sleep(delay, signal);
        }
      }
    };
  } });
}
const busy = (error: unknown) => isMdbaseError(error) && error.reason === "configuration_busy";
const snapshot = (code: string | null = null, checking = false): MdbaseApplicationFacetSnapshot =>
  Object.freeze({ checking, assessment: null, problem: code ? Object.freeze({ code }) : null });

/** Construction does no IO. The optional internal seam allows controller tests
 * before the canonical native binding lands; absence is explicitly unsupported. */
export function createApplicationConfiguration(source: ApplicationConfigurationInput,
  resources?: ApplicationConfigurationResources) {
  const input = Object.freeze({ ...source, scope: Object.freeze({ ...source.scope }), journal: patient(source.journal) });
  if (resources) resources = patient(resources);
  if (Object.values(input.scope).some(id => !uuid.test(id) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(id))
    || !uuid.test(input.generation) || !["inspect", "approved-new", "reconcile-original"].includes(input.setupMode))
    throw failure("binding");
  const scopeStamp = JSON.stringify([input.scope.account, input.scope.installation, input.scope.collection]);
  const lifetime = new AbortController();
  const readSignal = AbortSignal.any([input.signal, lifetime.signal]);
  const listeners = new Set<() => void>();
  let value = snapshot(), pending: Promise<unknown> | null = null;
  let closing: Promise<void> | null = null, closed = false;
  let assessedSession: Session | undefined;
  /** Catalog fingerprint when the delivered assessment started (P1). */
  let assessedCatalog: string | null = null, probing = false, probeAgain = false;
  // A collection change re-assesses in the background; it is never a problem.
  let failures = 0, dirty = false, scheduled = false, background: Promise<unknown> | null = null, lastStamp: string | null = null;
  const stamp = () => { try { return JSON.stringify([input.client.link, statusStamp(input.client)]); } catch { return null; } };
  const stops: Array<() => void> = [];
  const plans = new WeakMap<MdbaseSetupPlan, { readonly decisions: AppResourceDecisions; readonly records: readonly MdbaseSetupRecord[] }>();
  function check(signal?: AbortSignal, session?: Session) {
    signal?.throwIfAborted();
    if (closed || readSignal.aborted || input.isCurrent() !== true
      || JSON.stringify([input.journal.scope.account, input.journal.scope.installation, input.journal.scope.collection]) !== scopeStamp)
      throw failure("fenced");
    if (session && (session.closed || input.client.currentSession() !== session || session.hello.collection !== input.scope.collection))
      throw failure("fenced");
  }
  function publish(next: MdbaseApplicationFacetSnapshot) {
    value = Object.freeze(next);
    for (const listener of listeners) { try { listener(); } catch { /* Preserve original work disposition. */ } }
  }
  /** P1: with a settled assessment, re-assess only when the catalog changed. */
  function invalidate() {
    if (closed) return;
    const next = stamp();
    if (next !== null && next === lastStamp) return;
    lastStamp = next;
    if (pending || !value.assessment || assessedCatalog === null || input.client.link !== "open") { recheck(); return; }
    if (probing) { probeAgain = true; return; }
    probing = true;
    const assessed = value, catalog = assessedCatalog;
    void input.client.describe(readSignal).then(found => {
      if (!closed && value === assessed && catalogFingerprint(found) !== catalog) recheck();
    }, () => { if (!closed) recheck(); }).finally(() => {
      probing = false;
      if (probeAgain && !closed) { probeAgain = false; lastStamp = null; invalidate(); }
    });
  }
  function recheck() {
    if (closed) return;
    dirty = true;
    if (!pending) publish(snapshot(null, true));
    schedule();
  }
  function schedule() {
    if (closed || pending || scheduled || !dirty) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      if (closed || pending || !dirty) return;
      const work = run(false, {}, undefined, true); background = pending; void work.catch(() => {});
    }, failures ? Math.min(5000, 250 * 2 ** failures) : 50);
  }
  function getSnapshot() {
    if (value.assessment) {
      try { check(undefined, assessedSession); } catch {
        // A new session of the same current connection is re-assessed, not fenced.
        if (closed || readSignal.aborted || input.isCurrent() !== true) publish(snapshot("configuration_fenced"));
        else { dirty = true; lastStamp = null; publish(snapshot(null, true)); schedule(); }
      }
    }
    return value;
  }
  async function originalReceipt(intent: ModelSetupIntent, signal: AbortSignal, session: Session) {
    const receipt = await input.client.awaitReceipt(intent.mutationId, 120000, readSignal);
    check(signal, session);
    if (receipt.mutation !== intent.mutationId || receipt.state !== "confirmed" || receipt.status !== "applied"
      || (receipt.conflicts?.length ?? 0) !== 0 || receipt.published === "publishing" || receipt.published === "not_published")
      throw failure("recovery_required");
    return receipt;
  }
  async function retiredResourcesAbsent(paths: ReadonlySet<string>, signal: AbortSignal, session: Session) {
    let cursor: string | undefined, rows = 0, bytes = 0;
    const cursors = new Set<string>(), seen = new Set<string>(), utf8 = new TextEncoder();
    // Native list_resources owns unrestricted READ admission and the exact
    // cursor/prefix fence. This proves resource-namespace absence ONLY, never
    // native file absence, custody, or settlement of a different operation.
    for (let page = 0; page < 64; page++) {
      check(signal, session);
      const result = await input.client.resources.list({text: false, limit: 128,
        ...(cursor === undefined ? {} : {cursor}), signal: readSignal});
      check(signal, session);
      if (result.resources.length > 128) throw failure("recovery_required");
      for (const row of result.resources) {
        const size = utf8.encode(row.path).length;
        rows++; bytes += size + 128;
        if (!row.path || size > 4096 || seen.has(row.path) || row.state !== "confirmed"
          || !hash.test(row.revision) || !Number.isSafeInteger(row.size) || row.size < 0
          || rows > 4096 || bytes > 2 * 1024 * 1024 || paths.has(row.path)) throw failure("recovery_required");
        seen.add(row.path);
      }
      if (result.complete === true && result.cursor === undefined) return;
      if (result.complete !== false || !result.resources.length || typeof result.cursor !== "string"
        || !result.cursor || utf8.encode(result.cursor).length > 4096 || cursors.has(result.cursor))
        throw failure("recovery_required");
      cursors.add(result.cursor); cursor = result.cursor;
    }
    throw failure("recovery_required");
  }
  async function readback(intent: Exclude<ModelSetupIntent, { version: 1 }>, signal: AbortSignal, session: Session) {
    const rows = intent.version === 2 ? intent.plan.readback : intent.plan.resourceReadback;
    const retired = new Set(rows.filter(row => row.doc === null).map(row => row.path));
    if (retired.size) await retiredResourcesAbsent(retired, signal, session);
    for (const expected of rows) {
      if (expected.doc === null) continue;
      const actual = await input.client.resources.get(expected.path, readSignal);
      check(signal, session);
      if (actual.path !== expected.path || actual.text !== expected.doc || actual.state !== "confirmed")
        throw failure("recovery_required");
    }
    // A created record proves itself by identity, path and confirmation: Core
    // may canonicalize its frontmatter (defaults, declared type) on create.
    if (intent.version !== 2) for (const expected of intent.plan.sources) {
      const actual = await input.client.get(expected.id, undefined, readSignal);
      check(signal, session);
      if (actual.id !== expected.id || actual.path !== expected.path || actual.state.state !== "confirmed" || actual.state.hold || actual.state.unresolved)
        throw failure("recovery_required");
    }
  }
  async function confirmed(intent: Exclude<ModelSetupIntent, { version: 1 }>, signal: AbortSignal, session: Session) {
    await originalReceipt(intent, signal, session);
    if (intent.phase === "attempted") {
      intent = intent.version === 2 ? await input.journal.recordConfirmed(intent.mutationId, readSignal)
        : await input.journal.recordResourceConfirmed(intent.mutationId, readSignal);
      check(signal, session);
    }
    // A verified setup is settled: its files are ordinary collection state that
    // other apps' setups (the shared lock) and edits may change since. The
    // native assessment judges the current collection, never this readback.
    if (intent.phase === "verified") return intent;
    await readback(intent, signal, session);
    if (intent.phase === "confirmed") {
      intent = intent.version === 2 ? await input.journal.recordVerified(intent.mutationId, readSignal)
        : await input.journal.recordResourceVerified(intent.mutationId, readSignal);
      check(signal, session);
    }
    return intent;
  }
  /** Settle the retained journal before any new work: confirm an earlier
   * operation, or record a finally rejected one (which applied nothing). */
  async function recover(signal: AbortSignal, session: Session) {
    let original = await input.journal.load(readSignal);
    check(signal, session);
    if (!original) return { journaled: false, previous: null };
    original = decode(original, input.scope);
    if (original.version === 1 || original.phase === "prepared") throw failure("recovery_required");
    if (original.phase === "attempted" && (original.version === 3 || original.version === 4) && input.journal.recordResourceRejected) {
      const receipt = await input.client.awaitReceipt(original.mutationId, 120000, readSignal);
      check(signal, session);
      if (receipt.mutation === original.mutationId && receipt.state === "rejected") {
        original = decode(await input.journal.recordResourceRejected(original.mutationId, readSignal), input.scope);
        check(signal, session);
      }
    }
    if (original.version === 1) throw failure("recovery_required");
    if (original.phase === "rejected") return { journaled: true, previous: original.version === 4 ? original.previous : null };
    return { journaled: true, previous: await confirmed(original, signal, session) };
  }
  /** Assess with the declaration, leaving out packs installed at a newer
   * compatible version (R5.7). The same manifest must be used to apply. */
  async function effective(decisions: AppResourceDecisions | undefined, review: boolean) {
    const full = input.compiledManifest.manifest;
    let assessed = await reviewed(resources!.assess(full, readSignal, decisions), decisions);
    // The pack rows are only in a review: fetch one to tell a newer install from a conflict.
    let rows = assessed;
    if (assessed.status === "conflict" && !assessed.review) rows = await resources!.assess(full, readSignal, resourceDecisions({}));
    const newer = newerPacks(rows);
    if (!newer.compatible.size) return { assessed, manifest: full, newer };
    const manifest = withoutPacks(full, newer.compatible), next = review ? decisions ?? resourceDecisions({}) : decisions;
    assessed = await reviewed(resources!.assess(manifest, readSignal, next), next);
    return { assessed, manifest, newer };
  }
  async function perform(explicit: boolean, signal: AbortSignal, request: SetupRequest = {}) {
    check(signal);
    const session = await input.client.readyForRead(readSignal);
    check(signal, session);
    if (!stops.length) { lastStamp = stamp(); stops.push(input.client.onStatus(invalidate), input.client.onLink(invalidate)); }
    dirty = false;
    const { journaled, previous } = await recover(signal, session);
    if (!resources) throw failure("unsupported");
    // Taken before assessing: a change after it shows as a different catalog.
    let catalog: string | null = null;
    try { catalog = catalogFingerprint(await input.client.describe(readSignal)); } catch { /* no probe: every change re-assesses */ }
    check(signal, session);
    const chosen = await effective(request.decisions, false);
    let assessed = chosen.assessed;const manifest = chosen.manifest;
    check(signal, session);
    if (!hash.test(assessed.assessmentDigest) || !["current", "provision", "conflict"].includes(assessed.status))
      throw failure("response");
    if (request.expected !== undefined && assessed.assessmentDigest !== request.expected) throw changed();
    const automatic = !journaled && input.setupMode === "approved-new";
    if (assessed.status === "provision" && (explicit || automatic)) {
      if (input.setupMode === "reconcile-original") throw failure("recovery_required");
      // Declaration intent and the original native grant are independent of the
      // creation-mode hint. Ordinary native submit enforces every operation too.
      if (!(input.compiledManifest.operations.includes("apply_collection_setup")
        || input.compiledManifest.operations.includes("apply_type_pack"))
        || !session.hello.grant.capabilities.includes("definitions.manage")) throw failure("not_authorized");
      const records = request.records ?? [];
      if (records.length && !session.hello.grant.capabilities.includes("records.create")) throw failure("not_authorized");
      const produced = modelResourcePlan(await reviewed(resources.apply(manifest, assessed.assessmentDigest, readSignal, request.decisions), request.decisions));
      check(signal, session);
      if (produced.assessmentDigest !== assessed.assessmentDigest) throw failure("response");
      // Core plans definitions only. Starter records are the caller's reviewed,
      // create-only sources: fresh UUIDs, written in the same mutation.
      if (produced.sources.length) throw failure("unsupported_source_provision");
      const plan = records.length ? modelResourcePlan({ ...produced,
        sources: records.map(r => ({ id: crypto.randomUUID(), path: r.path, document: r.document })) }) : produced;
      let intent;
      if (previous) {
        if (!input.journal.prepareResourceRound) throw failure("recovery_required");
        intent = await input.journal.prepareResourceRound(plan, previous.mutationId, readSignal);
      } else intent = await input.journal.prepareResources(plan, readSignal);
      check(signal, session);
      intent = decode(intent, input.scope);
      if ((intent.version !== 3 && intent.version !== 4) || intent.phase !== "prepared"
        || JSON.stringify(intent.plan) !== JSON.stringify(plan)) throw failure("recovery_required");
      const attempted = decode(await input.journal.recordResourceAttempt(intent.mutationId, readSignal), input.scope);
      check(signal, session);
      if ((attempted.version !== 3 && attempted.version !== 4) || attempted.mutationId !== intent.mutationId || attempted.phase !== "attempted"
        || JSON.stringify(attempted.plan) !== JSON.stringify(plan)) throw failure("recovery_required");
      const ops: Op[] = [...plan.resourceOps, ...plan.sources.map(r => ({ kind: "create" as const, id: r.id, path: r.path, document: r.document }))];
      const writes = await input.client.submit(ops, { mutationId: intent.mutationId, wait: "confirmed", signal: readSignal });
      check(signal, session);
      if (writes.length !== 1 || writes[0]!.mutationId !== intent.mutationId) throw failure("recovery_required");
      let receipt: Receipt;
      try { receipt = await writes[0]!.confirmed; } catch (error) {
        check(signal, session);
        // A final rejection applied nothing (for example a definition or
        // starter path changed after review): settle it so setup can re-plan.
        if (writes[0]!.receipt.state !== "rejected" || !input.journal.recordResourceRejected) throw error;
        await input.journal.recordResourceRejected(intent.mutationId, readSignal);
        check(signal, session);
        throw changed(intent.mutationId, error);
      }
      check(signal, session);
      if (receipt.state !== "confirmed" || receipt.status !== "applied" || (receipt.conflicts?.length ?? 0) !== 0)
        throw failure("recovery_required");
      await confirmed(attempted, signal, session);
      // This final assessment covers the setup's own writes.
      dirty = false; lastStamp = stamp();
      try { catalog = catalogFingerprint(await input.client.describe(readSignal)); } catch { catalog = null; }
      assessed = await resources.assess(manifest, readSignal);
      check(signal, session);
      if (assessed.status !== "current" || !hash.test(assessed.assessmentDigest)) throw failure("recovery_required");
    }
    // A pack installed at a newer major is not a conflict to resolve: update the app.
    const code = assessed.status === "conflict" ? (chosen.newer.major.length ? "installed_newer" : "configuration_conflict") : null;
    const problem = code ? Object.freeze({ code }) : null;
    const assessment = Object.freeze({ status: assessed.status === "current" ? "ready" as const
      : assessed.status === "conflict" ? "incompatible" as const : "setup_required" as const, problem });
    assessedSession = session; assessedCatalog = catalog;
    const result = Object.freeze({ checking: false, assessment, problem });
    // Changed while assessed: keep checking; the scheduled re-assessment publishes.
    failures = 0;
    publish(dirty ? snapshot(null, true) : result);
    check(signal, session);
    return result;
  }
  /** Reviewable plan; changes no collection data. Recovery may first settle
   * the local setup journal of an earlier apply. Never prepares or submits. */
  function plan(options: MdbaseSetupPlanOptions = {}): Promise<MdbaseSetupPlan> {
    // Queues behind running work: recovery may settle the journal.
    try { check(options.signal); } catch (error) { return Promise.reject(error); }
    const before = pending;
    const work = (before ? before.then(() => {}, () => {}) : Promise.resolve()).then(() => planning(options));
    pending = work;
    void work.finally(() => { if (pending === work) pending = null; }).catch(() => {});
    return work;
  }
  async function planning(options: MdbaseSetupPlanOptions): Promise<MdbaseSetupPlan> {
    const records = setupRecords(options.records), decisions = resourceDecisions(options.adopt === undefined ? {} : { adopt: options.adopt });
    const signal = AbortSignal.any([readSignal, ...(options.signal ? [options.signal] : [])]);
    const session = await input.client.readyForRead(readSignal);
    check(signal, session);
    await recover(signal, session);
    if (!resources) throw failure("unsupported");
    const { assessed, newer } = await effective(decisions, true);
    check(signal, session);
    if (!assessed.review) throw failure("response");
    const occupied: { path: string; free: boolean }[] = [];
    if (assessed.status !== "current") for (const r of records) {
      const found = await input.client.find({ path: r.path }, undefined, readSignal);
      check(signal, session);
      occupied.push({ path: r.path, free: found === null });
    }
    const capabilities = session.hello.grant.capabilities;
    const result = setupPlan(assessed, { records: occupied,
      canManage: capabilities.includes("definitions.manage") && (input.compiledManifest.operations.includes("apply_collection_setup")
        || input.compiledManifest.operations.includes("apply_type_pack")),
      canCreateRecords: capabilities.includes("records.create"), newer });
    plans.set(result, Object.freeze({ decisions, records: records.filter(r => occupied.some(o => o.path === r.path && o.free)) }));
    return result;
  }
  function run(explicit: boolean, options: MdbaseApplicationRequestOptions = {}, request?: SetupRequest, unasked = false): Promise<MdbaseApplicationFacetSnapshot> {
    try { check(options.signal); } catch (error) { return Promise.reject(error); }
    // A background re-assessment is not the caller's conflict: wait for it.
    if (pending && pending === background) {
      const waited = pending;
      return waited.then(() => {}, () => {}).then(() => pending && pending !== waited ? Promise.reject(failure("busy")) : run(explicit, options, request));
    }
    if (pending) return Promise.reject(failure("busy"));
    const signal = AbortSignal.any([readSignal, ...(options.signal ? [options.signal] : [])]);
    const work = Promise.resolve().then(() => perform(explicit, signal, request)).catch(error => {
      const fenced = readSignal.aborted || signal.aborted;
      // A change during the assessment re-assesses; a background re-assessment
      // (nobody asked) that failed retries a few times. Only a settled failure is a problem.
      // A refused slot can settle by itself, but a full wait has already exhausted
      // the automatic busy budget. Changes cannot keep restarting that budget.
      const timedOut = isMdbaseError(error) && error.reason === "configuration_busy_timeout";
      if (timedOut) dirty = false;
      let retry = !fenced && !timedOut && (dirty || busy(error));
      if (retry && busy(error)) { dirty = true; failures = Math.min(failures + 1, 4); }
      if (!fenced && !timedOut && !dirty && unasked && failures < 5 && !closed && input.isCurrent() === true) { failures++; dirty = true; retry = true; }
      publish(retry ? snapshot(null, true) : snapshot(fenced ? "configuration_fenced" : timedOut ? "configuration_busy_timeout" : "configuration_unavailable"));
      throw error;
    });
    pending = work;
    publish(snapshot(null, true));
    void work.finally(() => { if (pending === work) pending = null; if (background === work) background = null; schedule(); }).catch(() => {});
    return work.then(result => { check(signal, assessedSession); return result; });
  }
  const close = () => {
    if (!closing) {
      closed = true;
      input.signal.removeEventListener("abort", abort);
      lifetime.abort();
      for (const stop of stops.splice(0)) stop();
      publish(snapshot("configuration_fenced"));
      const original = pending;
      closing = Promise.resolve().then(async () => { await original; });
    }
    return closing;
  };
  const abort = () => { void close().catch(() => {}); };
  input.signal.addEventListener("abort", abort, { once: true });
  return Object.freeze({ getSnapshot, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    assess: (options?: MdbaseApplicationRequestOptions) => run(false, options),
    configure: (options?: MdbaseApplicationRequestOptions) => run(true, options),
    plan,
    /** Apply a reviewed plan from `plan` exactly; a changed collection refuses. */
    async apply(reviewed: MdbaseSetupPlan, options: MdbaseApplicationRequestOptions = {}) {
      const bound = plans.get(reviewed);
      if (!bound) throw new TypeError("setup.apply needs a plan returned by setup.plan");
      if (reviewed.refusal) throw mdbaseError(reviewed.refusal.code === "setup_conflict" ? "conflict" : reviewed.refusal.code === "installed_newer" ? "upgrade_required" : "forbidden", reviewed.refusal.message, reviewed.refusal.code);
      if (reviewed.status === "current") { await run(false, options, { decisions: bound.decisions, expected: reviewed.digest }); return; }
      await run(true, options, { decisions: bound.decisions, expected: reviewed.digest, records: bound.records });
    },
    close });
}
