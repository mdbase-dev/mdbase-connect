/**
 * The migration action executor: one collection's Driver, driven from the DO's
 * alarm. Each step is prepare (native saves the exact action and the platform
 * confirms the write), execute (one bounded request), settle (native binds the
 * result; the platform confirms again). The native checkpoint and action
 * ledger are the only state machine; the run record (`migration-run.ts`) only
 * holds operator inputs, the provider run and why the loop waits or stopped.
 *
 * Stops for an operator, never retries a possibly-landed effect:
 * - a saved action this wake does not hold the ticket for (evicted or lost
 *   acknowledgement): its outcome is UNKNOWN;
 * - an effect request whose reply was lost, a settlement whose physical
 *   confirmation failed, or a native refusal of a result;
 * - rollback (route-back is an operator procedure), unsupported actions.
 *
 * Waits: the Driver's one-shot `Wait` (paused, draining, keying), Connect's
 * explicit "no outcome, retry" replies (503, busy, retention pending) and log
 * evidence that has not arrived yet (the held ticket is retried in this
 * instance; an eviction meanwhile makes it UNKNOWN, as above).
 */
import type { CborValue } from "../../../packages/sdk/src/cbor.js";
import type { MigrationPendingTicket } from "./engine.js";
import type { MigrationProviderResult } from "./migration-provider-result.js";
import type { MigrationSourceResult } from "./migration-source-result.js";
import type { RollbackScope } from "./migration-rollback-input.ts";
import { MAX_GEN0_RECORD_BYTES, MAX_GEN0_FILE_CHUNK_BYTES, MAX_GEN0_FILE_TOTAL_BYTES, type Gen0FileChunkInput, type Gen0Placement, type Gen0Placements, type Gen0Result, type Gen0Sealed, type Gen0Source, type Gen0WindowInput } from "./migration-gen0-input.ts";
import type { LogAppendSent } from "./migration-log-output.js";
import { LegacySourceError, type CheckpointRequest, type FileRow, type Page, type PageLimits, type RecordRow, type ResourceRow } from "./legacy-source/source.ts";
import { LegacyBindingError } from "./legacy-source/bindings.ts";
import type { ClaimBinding, ConnectReply, MigrationConnect } from "./migration-connect.ts";
import { PAUSE_REASON, atPreCutoverPause, STEP, type NativeState, type RunRecord, type RunStore } from "./migration-run.ts";

/** Native `hd_migration_idle` codes. */
export const IDLE = {
  none: 0, continue: 1, waitPaused: 2, waitDraining: 3, waitKeying: 4, done: 5, rebuildGated: 6,
  outstanding: 7, refused: 8, unavailable: 9,
} as const;

/** Log actions settled by entries the control plane appends (cutover onward):
 * the push-less host must ask for the head to see them. */
const OTHER_WRITER = new Set([15, 16, 17, 18]);

/** Reader page bound: at most 64 rows, and the executor's own 1 MiB of documents. */
export const PAGE_LIMITS = { maxRecords: 64, maxDecodedBytes: 1 << 20 } as const;
export const WAIT_MS = 5_000;
/** Spacing of native refusals/unavailability: MAX_REFUSALS of these before an operator stop. */
export const REFUSAL_WAIT_MS = 30_000;
export const RETRY_MS = 5_000;
/** Held-ticket retries (log evidence, explicit Connect retry) before an operator stop. */
export const MAX_TRIES = 60;
/** Consecutive refusals with nothing saved before an operator stop. */
export const MAX_REFUSALS = 5;
const RETENTION_MS = 90 * 24 * 3600_000;

/** A settlement refused before any write: the ticket is still live. */
export class SettlementRefused extends Error {}
/** Thrown after a settlement may have landed: the outcome is UNKNOWN. */
export class SettlementUnknown extends Error {}

export type Prepared = { ticket: MigrationPendingTicket; fields: CborValue[] } | { idle: number };

/** The DO's private native/host bridge. Errors from `prepare` mean nothing was
 * handed out; a saved-but-unconfirmed action shows up as `outstanding`. */
export interface MigrationHost {
  state(): NativeState;
  /** The claim the last prepare read (owner, start), DATA. */
  claim(): { owner_account: string; started_us: string } | null;
  prepare(signal: AbortSignal): Promise<Prepared>;
  keyingWait(t: MigrationPendingTicket, signal: AbortSignal): Promise<string>;
  targetCreated(t: MigrationPendingTicket, signal: AbortSignal): Promise<string>;
  provider(t: MigrationPendingTicket, result: MigrationProviderResult, signal: AbortSignal): Promise<string>;
  rollbackScope(t: MigrationPendingTicket): RollbackScope;
  rollbackResult(t: MigrationPendingTicket, body: unknown, signal: AbortSignal): Promise<string>;
  source(t: MigrationPendingTicket, result: MigrationSourceResult, signal: AbortSignal): Promise<string>;
  gen0Placements(t: MigrationPendingTicket): Gen0Placements;
  gen0FileChunk(t: MigrationPendingTicket, input: Gen0FileChunkInput): Gen0Sealed;
  gen0Window(t: MigrationPendingTicket, input: Gen0WindowInput): Gen0Sealed;
  gen0Finish(t: MigrationPendingTicket): Gen0Sealed;
  gen0Result(t: MigrationPendingTicket, result: Gen0Result, signal: AbortSignal): Promise<string>;
  logAppend(t: MigrationPendingTicket): LogAppendSent;
  logResult(t: MigrationPendingTicket, signal: AbortSignal): Promise<string>;
  /** Drop the RAM ticket; the saved action stays UNKNOWN. */
  release(t: MigrationPendingTicket): void;
  /** Move log traffic until quiet (the engine catches up); `head` first asks
   * the log for its head, to learn entries other writers appended. */
  pump(signal: AbortSignal, head?: boolean): Promise<void>;
  /** Drop the cache and reopen the engine over it empty (a gated `Rebuild`). */
  resetForRebuild(signal: AbortSignal): Promise<void>;
  putObject(collection: string, object: { address: string; kind: number; bytes: Uint8Array }, signal: AbortSignal): Promise<void>;
  hasObjects(collection: string, addresses: string[], signal: AbortSignal): Promise<boolean[]>;
}

/** The legacy reader surface the executor uses (`legacy-source/source.ts`). */
export interface MigrationSource {
  openCheckpoint(req: CheckpointRequest, signal: AbortSignal): Promise<{ session: string }>;
  nextPage(id: string, table: "resources", cursor: string | null, limits: PageLimits, signal: AbortSignal): Promise<Page<ResourceRow>>;
  nextPage(id: string, table: "records", cursor: string | null, limits: PageLimits, signal: AbortSignal): Promise<Page<RecordRow>>;
  nextPage(id: string, table: "files", cursor: string | null, limits: PageLimits, signal: AbortSignal): Promise<Page<FileRow>>;
  hydrateKeys(id: string, table: "resources", keys: string[], limits: PageLimits, signal: AbortSignal): Promise<Page<ResourceRow>>;
  hydrateKeys(id: string, table: "records", keys: string[], limits: PageLimits, signal: AbortSignal): Promise<Page<RecordRow>>;
  hydrateKeys(id: string, table: "files", keys: string[], limits: PageLimits, signal: AbortSignal): Promise<Page<FileRow>>;
  streamContent(id: string, sourceRef: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
  streamRecord(id: string, contentRef: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
  close(id: string): Promise<void>;
}

export interface ExecutorDeps {
  collection: string;
  host: MigrationHost;
  connect: () => MigrationConnect;
  source: () => Promise<MigrationSource>;
  store: RunStore;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** When to wake again (`null`: stopped, done or no run). */
export interface WakeResult { state: RunRecord["state"] | "idle"; reason: string | null; nextAt: number | null }

type Live = { ticket: MigrationPendingTicket; fields: CborValue[]; tries: number; posted: boolean; sealed?: Gen0Sealed };
type Step = { settled: true } | { wait: string; ms: number } | { stop: string };
const settled: Step = { settled: true };
const stop = (code: string): Step => ({ stop: code });
const wait = (reason: string, ms = RETRY_MS): Step => ({ wait: reason, ms });

const TABLES = ["resources", "files", "records"] as const;
const hex = (b: Uint8Array) => Array.from(b, v => v.toString(16).padStart(2, "0")).join("");
const nat = (v: CborValue | undefined): number | null => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;

/** Connect replies that explicitly carry no outcome and ask for a retry. */
function retryable(r: ConnectReply): boolean {
  return r.status === 503 || r.status === 429 || r.code === "busy" || r.code === "migration_source_unavailable"
    || r.code === "legacy_retention_pending";
}
const MEMBERS_STOP = new Set(["migration_members_invalid", "migration_policy_blocked", "migration_members_over_cap"]);

export class MigrationExecutor {
  readonly #d: ExecutorDeps;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  /** The ticket this instance holds (RAM only: an eviction makes it UNKNOWN). */
  #live: Live | null = null;
  /** The open legacy read the Driver's current read/gen0 actions bind to. */
  #read: { session: string; S0: number } | null = null;
  #sourcePort: MigrationSource | null = null;
  #running: Promise<WakeResult> | null = null;

  constructor(deps: ExecutorDeps) {
    this.#d = deps;
    this.#now = deps.now ?? Date.now;
    this.#sleep = deps.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
  }

  /** Single flight per instance: a concurrent wake joins the running one. */
  wake(signal: AbortSignal, budget = { actions: 64, ms: 60_000 }): Promise<WakeResult> {
    this.#running ??= this.#wake(signal, budget).finally(() => { this.#running = null; });
    return this.#running;
  }

  async #wake(signal: AbortSignal, budget: { actions: number; ms: number }): Promise<WakeResult> {
    const run = await this.#d.store.load();
    if (!run || run.collection !== this.#d.collection) return { state: "idle", reason: null, nextAt: null };
    if (run.state === "stopped" || run.state === "done") return { state: run.state, reason: run.reason, nextAt: null };
    const deadline = this.#now() + budget.ms;
    for (let i = 0; i < budget.actions && this.#now() < deadline; i++) {
      if (signal.aborted) break;
      let step: Step;
      try {
        step = this.#live ? await this.#execute(run, signal) : await this.#next(run, signal);
      } catch (error) {
        step = stop(error instanceof SettlementUnknown ? "settlement_unknown" : `executor_error:${code(error)}`);
      }
      if ("settled" in step) {
        if (run.state !== "running" || run.reason !== null) await this.#save(run, "running", null);
        continue;
      }
      if ("wait" in step) {
        await this.#save(run, "waiting", step.wait);
        return { state: "waiting", reason: step.wait, nextAt: this.#now() + step.ms };
      }
      if (step.stop === "done") {
        await this.#closeRead();
        await this.#save(run, "done", null);
        return { state: "done", reason: null, nextAt: null };
      }
      if (this.#live) { this.#d.host.release(this.#live.ticket); this.#live = null; }
      await this.#closeRead();
      await this.#save(run, "stopped", step.stop);
      return { state: "stopped", reason: step.stop, nextAt: null };
    }
    return { state: run.state, reason: run.reason, nextAt: this.#now() + 100 };
  }

  async #save(run: RunRecord, state: RunRecord["state"], reason: string | null): Promise<void> {
    run.state = state; run.reason = reason; run.updatedAt = this.#now();
    await this.#d.store.save(run);
  }

  /** Gate on the saved state, run the members-policy hooks, then prepare. */
  async #next(run: RunRecord, signal: AbortSignal): Promise<Step> {
    const native = this.#d.host.state();
    if (native.outstanding) return stop(`outstanding_unknown:${native.outstanding.kind}`);
    const cp = native.checkpoint;
    if (run.pauseBeforeCutover && (run.resumeRunSequence === null || run.resumeRunSequence !== native.runSequence)
        && cp && cp.step >= STEP.verified && cp.step < STEP.rollingBack) {
      // Before prepare: no cutover ticket/intent can escape this stop. SQL is
      // scheduling DATA only; native remains the authority for every effect.
      return stop(atPreCutoverPause(native) ? PAUSE_REASON : "migration_pause_point_passed");
    }
    if (cp) {
      if (cp.step === STEP.routed) return stop("done");
      if (cp.step >= STEP.rolledBack) return stop(`terminal:${cp.step}`);
      if (cp.step < STEP.rollingBack && cp.step >= STEP.baseAppended && !run.membersBase) {
        // After the fence and the base append.
        const m = await this.#members(run, signal);
        if (m) return m;
        run.membersBase = true;
        await this.#d.store.save(run);
      }
    }
    let prepared: Prepared;
    try {
      prepared = await this.#d.host.prepare(signal);
    } catch {
      prepared = { idle: this.#d.host.state().outstanding ? IDLE.outstanding : IDLE.unavailable };
    }
    const claim = this.#d.host.claim();
    if (claim) { run.owner = claim.owner_account; run.startedUs = claim.started_us; }
    if ("idle" in prepared) return this.#idle(run, prepared.idle, signal);
    run.refusals = 0;
    run.last = { sequence: prepared.ticket.sequence, kind: prepared.ticket.kind };
    await this.#d.store.save(run);
    this.#live = { ticket: prepared.ticket, fields: prepared.fields, tries: 0, posted: false };
    return this.#execute(run, signal);
  }

  async #idle(run: RunRecord, idle: number, signal: AbortSignal): Promise<Step> {
    switch (idle) {
      case IDLE.continue: return settled;
      // A one-shot Wait after "not yet": the next prepare asks again.
      case IDLE.waitPaused: return wait("paused", WAIT_MS);
      case IDLE.waitDraining: return wait("draining", WAIT_MS);
      case IDLE.waitKeying: return wait("keying", WAIT_MS);
      case IDLE.done: {
        const cp = this.#d.host.state().checkpoint;
        return stop(cp?.step === STEP.routed ? "done" : `terminal:${cp?.step ?? "unknown"}`);
      }
      case IDLE.rebuildGated:
        await this.#d.host.resetForRebuild(signal);
        return settled;
      case IDLE.outstanding: return stop("outstanding_unknown");
      default:
        if (this.#d.host.state().outstanding) return stop("outstanding_unknown");
        run.refusals++;
        if (run.refusals > MAX_REFUSALS) return stop(idle === IDLE.unavailable ? "native_unavailable" : "native_refused");
        return wait(idle === IDLE.unavailable ? "native_unavailable" : "native_refused", REFUSAL_WAIT_MS);
    }
  }

  /** Execute and settle the held ticket. */
  async #execute(run: RunRecord, signal: AbortSignal): Promise<Step> {
    const live = this.#live!;
    let step: Step;
    try { step = await this.#perform(run, live, signal); }
    catch (error) {
      if (error instanceof SettlementRefused) step = stop(`settlement_refused:${live.ticket.kind}`);
      else throw error;
    }
    if ("settled" in step) this.#live = null;
    else if ("wait" in step && ++live.tries > MAX_TRIES) return stop(`retry_exhausted:${step.wait}`);
    return step;
  }

  #binding(run: RunRecord): ClaimBinding | null {
    return run.owner && run.startedUs && run.migrationId
      ? { owner_account: run.owner, started_us: run.startedUs, migration_id: run.migrationId } : null;
  }

  /** members-policy: queue the collection's current members on the target. */
  async #members(run: RunRecord, signal: AbortSignal): Promise<Step | null> {
    const binding = this.#binding(run);
    if (!binding) return stop("members_binding_unknown");
    let r: ConnectReply;
    try { r = await this.#d.connect().membersPolicy(run.collection, binding, signal); }
    catch { return wait("members_unavailable"); } // Idempotent (queues only the difference).
    if (r.status >= 200 && r.status < 300) return null;
    if (r.code && MEMBERS_STOP.has(r.code)) return stop(r.code);
    if (retryable(r)) return wait("members_unavailable");
    return stop(`members_refused:${r.code ?? r.status}`);
  }

  /** One Connect read whose reply settles the held action. */
  async #provider(run: RunRecord, t: MigrationPendingTicket, kind: MigrationProviderResult["kind"], request: () => Promise<ConnectReply>,
    signal: AbortSignal, effect: boolean, onBody?: (body: unknown) => void): Promise<Step> {
    let r: ConnectReply;
    try { r = await request(); }
    catch (error) {
      // A lost reply to an effect is UNKNOWN; a read can be asked again.
      if (effect) return stop(`effect_unknown:${t.kind}`);
      return wait(`connect_unavailable:${code(error)}`);
    }
    if (r.status < 200 || r.status >= 300) {
      if (retryable(r)) return wait(`connect_retry:${r.code ?? r.status}`);
      return stop(`connect_refused:${t.kind}:${r.code ?? r.status}`);
    }
    onBody?.(r.body);
    await this.#d.host.provider(t, { kind, body: r.body } as MigrationProviderResult, signal);
    if (onBody) await this.#d.store.save(run);
    return settled;
  }

  async #perform(run: RunRecord, live: Live, signal: AbortSignal): Promise<Step> {
    const { ticket: t, fields: f } = live;
    const host = this.#d.host, connect = () => this.#d.connect(), c = run.collection;
    const keepRun = (body: unknown) => {
      const id = (body as { migration_id?: unknown } | null)?.migration_id;
      if (typeof id === "string") run.migrationId = id;
    };
    switch (t.kind) {
      case 0: // EnsureBackup: the operator's in-force hold.
        await host.provider(t, { kind: "backup", hold_id: run.backupHold }, signal);
        return settled;
      case 1: // CreateCollection: verified keying, else wait for it.
        try { await host.targetCreated(t, signal); }
        catch (error) {
          if (!(error instanceof SettlementRefused)) throw error;
          await host.keyingWait(t, signal);
        }
        return settled;
      case 10: { // MayFence: the account view.
        if (!run.owner) return stop("owner_unknown");
        const owner = run.owner;
        return this.#provider(run, t, "account", () => connect().account(owner, signal), signal, false);
      }
      case 11: // Fence (idempotent; native requires the same provider run).
        return this.#provider(run, t, "fence", () => connect().fence(c, signal), signal, true, keepRun);
      case 12: // DrainStatus.
        return this.#provider(run, t, "drain", () => connect().source(c, signal), signal, false, keepRun);
      case 13: { // ListReplicas.
        const b = this.#binding(run);
        if (!b) return stop("binding_unknown");
        return this.#provider(run, t, "replicas", () => connect().replicas(c, b, signal), signal, false);
      }
      case 14: { // RevokeReplicas{ids}.
        const b = this.#binding(run), ids = f[1];
        if (!b) return stop("binding_unknown");
        if (!Array.isArray(ids) || !ids.length || !ids.every(i => typeof i === "string")) return stop("revoke_ids_invalid");
        return this.#provider(run, t, "revoked", () => connect().revoke(c, b, ids as string[], signal), signal, true);
      }
      case 19: { // Route{s_final, cutover_seq, barrier_f, final_digest}.
        const [, s, cs, bf, digest] = f;
        if (nat(s) === null || nat(cs) === null || nat(bf) === null || !(digest instanceof Uint8Array)) return stop("route_fields_invalid");
        const facts = { s_final: s as number, cutover_seq: cs as number, barrier_f: bf as number, final_digest: hex(digest) };
        return this.#provider(run, t, "cutover", () => connect().cutover(c, facts, signal), signal, true);
      }
      case 2: return this.#open(run, t, f, signal);
      case 3: return this.#page(t, f, signal);
      case 4: case 5: return this.#gen0(run, live, signal);
      case 15: { // AppendCutover: the control plane appends it (cutover-policy).
        if (!live.posted) {
          const posted = await this.#cutoverPolicy(run, signal);
          if (posted) return posted;
          live.posted = true;
        }
        return this.#log(t, signal, false);
      }
      case 6: return this.#log(t, signal, true);
      // Members are final once cutover-policy accepts them: Connect refuses any
      // member change after the cutover is queued, and the final compare
      // reads the log, so a later members-policy could only be refused.
      case 7: case 8: case 9: case 16: case 18:
        return this.#log(t, signal, false);
      case 20: case 21:
        return this.#rollback(run, t, signal);
      default:
        return stop(`unsupported_action:${t.kind}`);
    }
  }

  async #rollback(run: RunRecord, ticket: MigrationPendingTicket, signal: AbortSignal): Promise<Step> {
    const scope = this.#d.host.rollbackScope(ticket);
    if (!run.owner || !run.startedUs) return stop("rollback_binding_unknown");
    const binding = { owner_account: run.owner, started_us: run.startedUs, migration_id: scope.providerMigrationId };
    let reply: ConnectReply;
    try {
      const connect = this.#d.connect();
      reply = scope.original
        ? await connect.rollbackReceipt(run.collection, binding, scope, signal)
        : await connect.rollback(run.collection, binding, scope, signal);
    } catch {
      // Even read-only lookup failure stops here. Never replay a restore or
      // substitute active/bare restored state for its original receipt.
      return stop(scope.original ? "rollback_receipt_unavailable" : "rollback_effect_unknown");
    }
    if (reply.status < 200 || reply.status >= 300) return stop(`rollback_refused:${reply.code ?? reply.status}`);
    await this.#d.host.rollbackResult(ticket, reply.body, signal);
    return settled;
  }

  async #cutoverPolicy(run: RunRecord, signal: AbortSignal): Promise<Step | null> {
    const b = this.#binding(run), cp = this.#d.host.state().checkpoint;
    if (!b) return stop("binding_unknown");
    if (!cp || cp.baseSeq === null) return stop("base_seq_unknown");
    for (let attempt = 0; attempt < 2; attempt++) {
      let r: ConnectReply;
      try { r = await this.#d.connect().cutoverPolicy(run.collection, b, cp.revoked, cp.baseSeq, signal); }
      catch { return wait("cutover_policy_unavailable"); } // Found, never twice.
      if (r.status >= 200 && r.status < 300) return null;
      if (r.code === "migration_members_not_queued" && attempt === 0) {
        const m = await this.#members(run, signal);
        if (m) return m;
        continue;
      }
      if (retryable(r) || r.code === "migration_base_not_logged") return wait(`cutover_policy_retry:${r.code ?? r.status}`);
      return stop(`cutover_policy_refused:${r.code ?? r.status}`);
    }
    return wait("cutover_policy_retry");
  }

  /** Log-settled actions: catch up, then let native read the evidence. */
  async #log(t: MigrationPendingTicket, signal: AbortSignal, append: boolean): Promise<Step> {
    for (let i = 0; i < 3; i++) {
      if (append) {
        // Seals once and sends, or resends a dropped batch; refuses otherwise
        // (in flight, answered, or refs lost to an eviction: native settles Stale).
        try { this.#d.host.logAppend(t); } catch { /* Native decides on settlement. */ }
      }
      await this.#d.host.pump(signal, OTHER_WRITER.has(t.kind));
      try { await this.#d.host.logResult(t, signal); return settled; }
      catch (error) { if (!(error instanceof SettlementRefused)) throw error; }
      if (i < 2) await this.#sleep(250 * (i + 1));
    }
    return wait(`log_pending:${t.kind}`);
  }

  async #source(): Promise<MigrationSource> {
    return this.#sourcePort ??= await this.#d.source();
  }
  async #closeRead(): Promise<void> {
    const read = this.#read;
    this.#read = null;
    if (read && this.#sourcePort) await this.#sourcePort.close(read.session).catch(() => undefined);
  }

  async #open(run: RunRecord, t: MigrationPendingTicket, f: CborValue[], signal: AbortSignal): Promise<Step> {
    const head = nat(f[2]);
    // Fence-first only: the read is at the fenced, drained head.
    if (head === null) return stop("source_open_unfenced_unsupported");
    await this.#closeRead();
    const request: CheckpointRequest = { collection: run.collection, S0: head, expectedState: "migrating",
      backupHold: run.backupHold, retainUntil: new Date(this.#now() + RETENTION_MS).toISOString() };
    let opened: { session: string };
    try { opened = await (await this.#source()).openCheckpoint(request, signal); }
    catch (error) { return this.#sourceError(error); }
    this.#read = { session: opened.session, S0: head };
    await this.#d.host.source(t, { kind: "opened", request, session: opened.session }, signal);
    return settled;
  }

  async #page(t: MigrationPendingTicket, f: CborValue[], signal: AbortSignal): Promise<Step> {
    const read = this.#read, table = TABLES[nat(f[2]) ?? 9], cursor = f[3], rows = nat(f[4]);
    if (!read) return stop("source_read_lost");
    if (!table || (cursor !== null && typeof cursor !== "string") || rows === null) return stop("page_fields_invalid");
    const limits = { maxRecords: Math.min(rows, PAGE_LIMITS.maxRecords), maxDecodedBytes: PAGE_LIMITS.maxDecodedBytes };
    let page: MigrationSourceResult;
    try {
      const source = await this.#source(), after = cursor as string | null;
      page = { kind: "page", session: read.session, after, page: table === "resources"
        ? { table, page: await source.nextPage(read.session, table, after, limits, signal) }
        : table === "records" ? { table, page: await source.nextPage(read.session, table, after, limits, signal) }
        : { table, page: await source.nextPage(read.session, table, after, limits, signal) } };
    } catch (error) { return this.#sourceError(error); }
    await this.#d.host.source(t, page, signal);
    return settled;
  }

  #sourceError(error: unknown): Step {
    // A source refusal (state, head, hold, bindings) needs an operator; a
    // transport failure is retried on the held ticket (reads have no effect).
    if (error instanceof LegacySourceError || error instanceof LegacyBindingError) return stop(`source_refused:${error.code}`);
    return wait(`source_unavailable:${code(error)}`);
  }

  /** Native alone selects the exact bounded prefix and owns cursor/done. Once
   * sealing starts, a partial stream/upload failure stops for an operator: it
   * cannot be replayed against the advanced RAM custody. Completed windows are
   * retained with the original live ticket for idempotent object re-upload. */
  async #gen0(run: RunRecord, live: Live, signal: AbortSignal): Promise<Step> {
    const t = live.ticket;
    if (!live.sealed) {
      try {
        if (t.kind === 5) live.sealed = this.#d.host.gen0Finish(t);
        else {
          const read = this.#read;
          if (!read) return stop("source_read_lost");
          const source: Gen0Source = { collection: run.collection, S0: read.S0, session: read.session };
          const placements = this.#d.host.gen0Placements(t).rows;
          const rows = await this.#windowRows(t, source, placements, signal);
          live.sealed = this.#d.host.gen0Window(t, { source, rows });
        }
      } catch (error) {
        if (error instanceof Gen0Unsupported) return stop(error.message);
        if (error instanceof LegacySourceError || error instanceof LegacyBindingError) return stop(`source_refused:${error.code}`);
        // The stop reason is a bounded code; operators need the cause from logs.
        try {
          console.warn(JSON.stringify({ event: "migration_gen0_window_unknown", name: error instanceof Error ? error.name : typeof error,
            message: error instanceof Error ? error.message.slice(0, 500) : null, stack: error instanceof Error ? (error.stack ?? "").slice(0, 2000) : null }));
        } catch { /* Logging is not authority. */ }
        return stop(`gen0_window_unknown:${code(error)}`);
      }
    }
    return this.#uploadAndSettle(run.collection, t, live.sealed, signal);
  }

  /** Hydrate only selected legacy keys, not a whole-table scan per window.
   * Opaque file refs are streamed/uploaded before the next hydration invalidates
   * them. Text retained here is already bounded by native's window selection. */
  async #windowRows(t: MigrationPendingTicket, source: Gen0Source, placements: Gen0Placement[], signal: AbortSignal): Promise<Gen0WindowInput["rows"]> {
    const rows: Gen0WindowInput["rows"] = [], src = await this.#source();
    for (const kind of [2, 0, 1] as const) {
      const table = kind === 0 ? "resources" : kind === 1 ? "records" : "files";
      let keys = placements.filter(p => p.kind === kind).map(p => p.key);
      while (keys.length) {
        signal.throwIfAborted();
        const request = keys.slice(0, PAGE_LIMITS.maxRecords);
        const page = table === "resources" ? await src.hydrateKeys(source.session, table, request, PAGE_LIMITS, signal)
          : table === "records" ? await src.hydrateKeys(source.session, table, request, PAGE_LIMITS, signal)
          : await src.hydrateKeys(source.session, table, request, PAGE_LIMITS, signal);
        const seen = new Set<string>();
        for (const row of page.rows) {
          const key = "fileId" in row ? row.fileId : "recordId" in row ? row.recordId : row.path;
          if (!request.includes(key) || seen.has(key)) throw new Gen0Unsupported("gen0_hydration_invalid");
          seen.add(key);
          if ("fileId" in row) await this.#sealFile(t, source, row, signal);
          else if ("recordId" in row) {
            const record = typeof row.document === "string" ? row
              : { ...row, document: await inlineRecord(src, source.session, row, signal), contentRef: null };
            rows.push({ record });
          } else rows.push({ resource: row });
        }
        if (!seen.size || (page.done && seen.size !== request.length)) throw new Gen0Unsupported("gen0_hydration_incomplete");
        keys = keys.filter(k => !seen.has(k));
      }
    }
    return rows;
  }

  /** Sequential AttachmentV1 chunks, each uploaded before reading another.
   * EOF is checked too: extra/missing source bytes never reach window settlement. */
  async #sealFile(t: MigrationPendingTicket, source: Gen0Source, file: FileRow, signal: AbortSignal): Promise<void> {
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_GEN0_FILE_TOTAL_BYTES) throw new Gen0Unsupported("gen0_file_policy_unsupported");
    const src = await this.#source();
    const stream = await src.streamContent(source.session, file.sourceRef, signal);
    for await (const { offset, bytes } of fileChunks(stream, file.size, signal)) {
      const sealed = this.#d.host.gen0FileChunk(t, { source, file, offset, bytes });
      for (const object of sealed.objects) await this.#d.host.putObject(source.collection, object, signal);
    }
  }

  /** PutObject every sealed object (idempotent), HasObjects over what native
   * must verify, then settle; a missing object keeps the staging for a retry. */
  async #uploadAndSettle(collection: string, t: MigrationPendingTicket, sealed: Gen0Sealed, signal: AbortSignal): Promise<Step> {
    try {
      for (const o of sealed.objects) await this.#d.host.putObject(collection, o, signal);
      const present = await this.#d.host.hasObjects(collection, sealed.verify, signal);
      if (present.some(p => !p)) return wait("objects_missing");
      await this.#d.host.gen0Result(t, { collection, present }, signal);
      return settled;
    } catch (error) {
      if (error instanceof SettlementRefused || error instanceof SettlementUnknown) throw error;
      return wait(`objects_unavailable:${code(error)}`);
    }
  }
}

/** A record returned by reference still fits the native record model. Consume
 * its bounded stream before hydration invalidates the handle; never truncate. */
async function inlineRecord(src: MigrationSource, session: string, row: RecordRow, signal: AbortSignal): Promise<string> {
  if (!row.contentRef || !Number.isSafeInteger(row.documentBytes) || row.documentBytes < 0
    || row.documentBytes > MAX_GEN0_RECORD_BYTES) throw new Gen0Unsupported("gen0_record_policy_unsupported");
  const reader = (await src.streamRecord(session, row.contentRef, signal)).getReader();
  const bytes = new Uint8Array(row.documentBytes);
  let offset = 0, done = false;
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) { done = true; signal.throwIfAborted(); break; }
      try {
        signal.throwIfAborted();
        if (part.value.length > 64 * 1024 || offset + part.value.length > bytes.length)
          throw new Gen0Unsupported("gen0_record_stream_over_budget");
        bytes.set(part.value, offset); offset += part.value.length;
      } finally { part.value.fill(0); }
    }
    if (offset !== bytes.length) throw new Gen0Unsupported("gen0_record_stream_incomplete");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } finally {
    bytes.fill(0);
    if (!done) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

class Gen0Unsupported extends Error {}

function code(error: unknown): string {
  const m = error instanceof Error ? error.message : String(error);
  return /^[a-z0-9_:.-]{1,80}$/.test(m) ? m : "error";
}

async function* fileChunks(stream: ReadableStream<Uint8Array>, size: number, signal: AbortSignal): AsyncGenerator<{ offset: number; bytes: Uint8Array }> {
  const reader = stream.getReader();
  let buffer = new Uint8Array(Math.min(size, MAX_GEN0_FILE_CHUNK_BYTES));
  let total = 0, fill = 0, complete = false;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) { signal.throwIfAborted(); break; }
      try {
        signal.throwIfAborted();
        if (value.length > MAX_GEN0_FILE_CHUNK_BYTES) throw new Gen0Unsupported("gen0_file_chunk_over_budget");
        if (total + value.length > size) throw new Gen0Unsupported("gen0_file_size_mismatch");
        for (let at = 0; at < value.length;) {
          const take = Math.min(buffer.length - fill, value.length - at);
          buffer.set(value.subarray(at, at + take), fill);
          fill += take; total += take; at += take;
          if (fill === buffer.length) {
            yield { offset: total - fill, bytes: buffer };
            buffer.fill(0); fill = 0;
            if (total < size) buffer = new Uint8Array(Math.min(size - total, MAX_GEN0_FILE_CHUNK_BYTES));
          }
        }
      } finally { value.fill(0); }
    }
    if (total !== size) throw new Gen0Unsupported("gen0_file_size_mismatch");
    if (size === 0) yield { offset: 0, bytes: buffer };
    complete = true;
  } finally {
    buffer.fill(0);
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
