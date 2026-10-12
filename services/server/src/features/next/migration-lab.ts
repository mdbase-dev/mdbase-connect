// LAB orchestration of one fixture account's hosted migration (`lab-run`) and
// of its pre-cutover route-back (`route-back`), for the operator CLI
// (migration-lab-cli.ts). Environment `lab` only.
//
// The hosted Worker's migration run (POST /internal/v1/migration/run|status on
// the next hosted service) fences, drains, imports, revokes and cuts the
// collection over; this module starts it, polls it, imports the timers once it
// is drained, then confirms the cutover, flips the account and reads back the
// LAB completion. Every step is derived from durable state (Worker status and
// control-plane rows), so a rerun resumes where the last one stopped.
//
// Anything not known to be safe stops for an operator and names the step, the
// reason code and the commands to inspect and resume. A mutation is never
// retried after an unknown outcome; only read-only status reads and the
// idempotent timer import after `timer_source_changed` are retried.
import { z } from "zod";
import type { DatabasePool } from "../../database-types.js";
import type { HostedProviderClient } from "../../hosted-provider.js";
import { flipEvidenceDigest } from "./account-backend-flip.js";
import { claim } from "./migration-provider.js";
import { cutOverCollection, flipAccountBackend, RolloutRefused } from "./migration-rollout.js";
import { LAB_COMPLETION_EVENT, requireCompletedAccountMigration } from "./migration-sharing.js";
import { cleanUpRolledBackTimerImport } from "./migration-timer-cleanup.js";
import { legacyTimerGrantResolver } from "./timers/grants.js";
import { importHostedCollectionTimers } from "./timers/hosted-import.js";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u;
const CLI = "pnpm --filter @mdbase/connect-server next:migration-lab";
const MAX_REPLY_BYTES = 64 * 1024;

/** Native Driver steps (`hosted_import::Step`, mirrored by the Worker's status). */
export const STEP = { fenced: 6, drained: 7, cutoverIntent: 10, routed: 13, rollingBack: 20, rolledBack: 21, failed: 22, gone: 23 } as const;
/** Native rollback action kinds whose lost reply the Worker resolves from the provider receipt. */
const ROLLBACK_KINDS: Readonly<Record<number, string>> = { 20: "Unrevoke", 21: "Unfence" };

const statusSchema = z.object({
  run: z.object({ state: z.string(), reason: z.string().nullable(), backup_hold: z.string(), migration_id: z.string().nullable() }).nullable(),
  native: z.union([
    z.object({ error: z.string() }),
    z.object({
      /** Current immutable native run sequence; absent from Workers without the operator entry. */
      run_sequence: z.number().int().positive().nullable().optional(),
      checkpoint: z.object({ step: z.number().int().nonnegative(), fenced: z.boolean() }).nullable(),
      outstanding: z.object({ sequence: z.number().int().positive(), kind: z.number().int().nonnegative() }).nullable()
    })
  ])
});
export type WorkerStatus = z.infer<typeof statusSchema>;

/** One Worker call: a parsed status, a typed refusal, or no verified outcome. */
export type WorkerReply =
  | { kind: "ok"; status: WorkerStatus }
  | { kind: "refused"; code: string }
  | { kind: "unknown"; reason: string };

/**
 * The native operator entry (`POST /internal/v1/migration/operator`
 * `{collection, operation, expected_run_sequence | expected_action_sequence}`),
 * which replies with the status body or 409 `{error}`. Route-back drives the
 * Worker only through this adapter, so it can follow that entry's final shape.
 */
export interface WorkerOperator {
  rollback(collection: string, expectedRunSequence: number): Promise<WorkerReply>;
  restart(collection: string, expectedRunSequence: number): Promise<WorkerReply>;
  /** Settle a lost rollback reply from the provider's rollback receipt. */
  resolve(collection: string, expectedActionSequence: number): Promise<WorkerReply>;
}
export interface LabWorker extends WorkerOperator {
  run(collection: string, backupHold: string): Promise<WorkerReply>;
  status(collection: string): Promise<WorkerReply>;
}

/** The control-plane side; refusals throw with a `code` (RolloutRefused, TimerImportRefused). */
export interface LabConnect {
  preflight(account: string): Promise<{ collection: string; backend: "legacy" | "next" }>;
  importTimers(collection: string): Promise<unknown>;
  cutover(collection: string): Promise<void>;
  flip(account: string, collection: string): Promise<void>;
  completion(account: string, collection: string): Promise<void>;
  cleanupTimers(collection: string, migrationId: string): Promise<{ deleted: number }>;
}

interface LabDeps {
  worker: LabWorker;
  connect: LabConnect;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Overall polling budget per invocation (default two hours). */
  timeoutMs?: number;
  log?: (event: Record<string, unknown>) => void;
}

interface LabStop { step: string; reason: string; inspect: string; resume: string }
export type LabOutcome = { done: Record<string, unknown> } | { stopped: LabStop };

/** HTTPS client for the hosted Worker's internal migration entry (service token). */
export function labWorkerClient(config: { url: string; token: string }, fetchImpl: typeof fetch = fetch): LabWorker {
  const url = new URL(config.url);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("MDBASE_NEXT_HOSTED_SERVICE_URL must be an https origin without credentials.");
  }
  if (config.token.length < 32) throw new Error("MDBASE_NEXT_HOSTED_SERVICE_TOKEN must be at least 32 characters.");
  const base = url.toString().replace(/\/+$/u, "");
  const post = async (path: string, body: Record<string, unknown>): Promise<WorkerReply> => {
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method: "POST", redirect: "manual", signal: AbortSignal.timeout(60_000),
        headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" }, body: JSON.stringify(body)
      });
    } catch { return { kind: "unknown", reason: "worker_unreachable" }; }
    let parsed: unknown = null;
    try {
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > MAX_REPLY_BYTES) return { kind: "unknown", reason: "worker_reply_over_bound" };
      parsed = text ? JSON.parse(text) : null;
    } catch { parsed = null; }
    if (response.ok) {
      const status = statusSchema.safeParse(parsed);
      return status.success ? { kind: "ok", status: status.data } : { kind: "unknown", reason: "worker_reply_invalid" };
    }
    const code = (parsed as { error?: unknown } | null)?.error;
    // A typed error code is a refusal; anything else (gateway errors, no body) has no verified outcome.
    const typed = typeof code === "string" && /^[a-z][a-z0-9_:.-]{0,120}$/u.test(code);
    return typed && (response.status < 500 || response.status === 503)
      ? { kind: "refused", code: code as string } : { kind: "unknown", reason: `worker_http_${response.status}` };
  };
  const operator = (collection: string, operation: string, key: string, sequence: number) =>
    post("/internal/v1/migration/operator", { collection, operation, [key]: sequence });
  return {
    run: (collection, backupHold) => post("/internal/v1/migration/run", { collection, backup_hold: backupHold }),
    status: collection => post("/internal/v1/migration/status", { collection }),
    rollback: (collection, sequence) => operator(collection, "rollback", "expected_run_sequence", sequence),
    restart: (collection, sequence) => operator(collection, "restart", "expected_run_sequence", sequence),
    resolve: (collection, sequence) => operator(collection, "resolve", "expected_action_sequence", sequence)
  };
}

/** The control-plane port over the Connect database and the legacy provider. */
export function postgresLabConnect(options: {
  db: DatabasePool; source: DatabasePool; actor: string; timers: boolean;
  provider: Pick<HostedProviderClient, "legacyMigrationSource" | "legacyMigrationDrain" | "legacyMigrationRetain">;
  importTimers?: (collection: string) => Promise<unknown>;
}): LabConnect {
  const { db, provider } = options;
  return {
    async preflight(account) {
      const row = (await db.query<{ backend: string; member: boolean; released: boolean; frozen: boolean; started: boolean; excluded: boolean }>(
        `SELECT u.account_backend AS backend, m.account_id IS NOT NULL AS member, c.released_at IS NOT NULL AS released,
           c.frozen_at IS NOT NULL AS frozen, m.started_at IS NOT NULL AS started, m.terminal_excluded_at IS NOT NULL AS excluded
         FROM users u LEFT JOIN next_migration_cohort_members m ON m.account_id=u.id LEFT JOIN next_migration_cohorts c ON c.name=m.cohort
         WHERE u.id=$1`, [account])).rows[0];
      if (!row) throw new RolloutRefused("account_not_found", "Account not found.", 404);
      if (!row.member || !row.released) throw new RolloutRefused("account_not_released", "The account is not in a released migration cohort.");
      if (row.excluded) throw new RolloutRefused("account_deletion_accepted", "The account's deletion was accepted.");
      if (!row.frozen) throw new RolloutRefused("cohort_not_frozen", "The account's cohort is not frozen.");
      if (!row.started) throw new RolloutRefused("account_not_started", "The account's migration has not started.");
      const lab = await db.query(
        `SELECT 1 FROM audit_events WHERE user_id=$1 AND event_type='next_migration.start' AND subject_id=$1::text
           AND metadata->>'profile'='lab-fixture-v1' LIMIT 1`, [account]);
      if (!lab.rows.length) throw new RolloutRefused("lab_profile_missing", "The account did not start with the LAB fixture profile.");
      const hosted = (await db.query<{ id: string; state: string }>(
        "SELECT id::text AS id, authority_state AS state FROM hosted_collections WHERE user_id=$1 AND authority_state<>'transferred'", [account])).rows;
      if (hosted.length !== 1 || hosted[0]!.state !== "active") {
        throw new RolloutRefused("lab_inventory_invalid", "The LAB fixture account must have exactly one settled hosted collection.");
      }
      return { collection: hosted[0]!.id, backend: row.backend === "next" ? "next" : "legacy" };
    },
    importTimers: options.importTimers ?? (collection => importHostedCollectionTimers({
      db, source: options.source, provider, resolver: legacyTimerGrantResolver, collection, actor: options.actor
    })),
    async cutover(collection) {
      const row = (await db.query<{ s_final: string; cutover_seq: string; barrier_f: string; final_digest: string }>(
        "SELECT s_final::text, cutover_seq::text, barrier_f::text, final_digest FROM next_migration_collections WHERE collection_id=$1",
        [collection])).rows[0];
      if (!row) throw new RolloutRefused("cutover_not_recorded", "The Worker reports a routed run but no cutover is recorded.");
      let state: string;
      try { state = (await provider.legacyMigrationDrain(collection, { deadline: Date.now() + 25_000 })).state; } catch {
        throw new RolloutRefused("migration_source_unavailable", "No verified legacy provider outcome.", 503);
      }
      if (state === "migrated") return;
      // The documented retry of the same recorded cutover: moves legacy to `migrated`.
      await cutOverCollection(db, provider, collection, { s_final: Number(row.s_final), cutover_seq: Number(row.cutover_seq),
        barrier_f: Number(row.barrier_f), final_digest: row.final_digest });
    },
    async flip(account, collection) {
      const rows = (await db.query<{ collection_id: string; barrier_f: string; final_digest: string }>(
        "SELECT collection_id::text, barrier_f::text, final_digest FROM next_migration_collections WHERE collection_id=$1 AND account_id=$2",
        [collection, account])).rows;
      if (rows.length !== 1) throw new RolloutRefused("cutover_not_recorded", "No cutover is recorded for the account's collection.");
      await flipAccountBackend(db, account, [collection], flipEvidenceDigest(rows), { enabled: options.timers, provider }, "lab");
    },
    async completion(account, collection) {
      const event = await db.query(
        `SELECT 1 FROM audit_events e JOIN next_migration_cohort_members m ON m.cohort=e.subject_id
         WHERE m.account_id=$1 AND e.user_id IS NULL AND e.event_type=$2 LIMIT 1`, [account, LAB_COMPLETION_EVENT]);
      if (!event.rows.length) throw new RolloutRefused("lab_completion_missing", "The cohort has no LAB completion.");
      try { await requireCompletedAccountMigration(db, collection, account); } catch (error) {
        if ((error as { code?: unknown })?.code === "collection_migrating") {
          throw new RolloutRefused("lab_completion_missing", "The completion readback refuses this account.");
        }
        throw error;
      }
    },
    async cleanupTimers(collection, migrationId) {
      const current = await claim(db, collection);
      return cleanUpRolledBackTimerImport(db, provider, "lab", collection,
        { owner_account: current.account, started_us: current.started_us, migration_id: migrationId });
    }
  };
}

/** A stable code for an error, never its message (which may carry configuration). */
function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[a-z][a-z0-9_:.-]{0,120}$/u.test(code)) return code;
  if (typeof code === "string" && /^[0-9A-Z]{5}$/u.test(code)) return `postgres_${code}`;
  return "unexpected_error";
}

type PollDecision = { action: "wait" } | { action: "import_timers" } | { action: "routed" } | { action: "stop"; reason: string; routeBack: boolean };
const stopWith = (reason: string, routeBack = false): PollDecision => ({ action: "stop", reason, routeBack });
const ROLLBACK_REASONS = /^(rolling_back|rollback_needs_operator|migration_rollback_|effect_unknown:Un|outstanding_unknown:Un)/u;

/** lab-run: what one Worker status means (the decision table; see docs/lab-migration-run.md). */
export function decidePoll(status: WorkerStatus, timersImported: boolean): PollDecision {
  if ("error" in status.native) return stopWith(`native_state:${status.native.error}`);
  const run = status.run, checkpoint = status.native.checkpoint;
  if (!run) return stopWith("worker_run_missing");
  const step = checkpoint?.step ?? null;
  if (run.state === "stopped") {
    const reason = run.reason ?? "stopped";
    return stopWith(reason, ROLLBACK_REASONS.test(reason) || step === STEP.rollingBack || step === STEP.rolledBack);
  }
  if (run.state === "done") return step === STEP.routed ? { action: "routed" } : stopWith(`run_done_at_step:${step ?? "none"}`, step === STEP.rolledBack);
  if (run.state !== "running" && run.state !== "waiting") return stopWith(`worker_state_unknown:${run.state}`);
  if (step === STEP.rollingBack || step === STEP.rolledBack) return stopWith("rolling_back", true);
  if (step === STEP.failed || step === STEP.gone) return stopWith(`run_step:${step}`);
  if (!timersImported && checkpoint?.fenced && step !== null && step >= STEP.drained && step <= STEP.routed) return { action: "import_timers" };
  return { action: "wait" };
}

type RouteBackDecision =
  | { action: "wait" } | { action: "done" }
  | { action: "resolve"; sequence: number }
  | { action: "rollback"; sequence: number }
  | { action: "cleanup_restart"; sequence: number; migrationId: string | null }
  | { action: "stop"; reason: string };
/** What this invocation already asked the Worker to do. */
export type RouteBackPhase = "start" | "rolling_back" | "restarted";

/** route-back: what one Worker status means (the decision table; see docs/lab-migration-run.md). */
export function decideRouteBack(status: WorkerStatus, phase: RouteBackPhase): RouteBackDecision {
  if ("error" in status.native) return { action: "stop", reason: `native_state:${status.native.error}` };
  const run = status.run, { checkpoint, outstanding } = status.native, sequence = status.native.run_sequence ?? null;
  if (!run || !checkpoint) return { action: "stop", reason: "worker_run_missing" };
  const step = checkpoint.step;
  if (run.state === "running" || run.state === "waiting") {
    if (step === STEP.rollingBack || step === STEP.rolledBack || phase === "rolling_back") return { action: "wait" };
    // The restarted run (or, on a rerun, a later run) ends route-back once it has fenced again.
    if (phase === "restarted" || sequence !== null && sequence > 1) {
      return checkpoint.fenced && step >= STEP.fenced && step < STEP.rollingBack ? { action: "done" } : { action: "wait" };
    }
    return { action: "stop", reason: "migration_run_active" };
  }
  if (run.state !== "stopped" && run.state !== "done") return { action: "stop", reason: `worker_state_unknown:${run.state}` };
  if (phase === "restarted") return { action: "stop", reason: run.reason ?? "restarted_run_stopped" };
  if (outstanding) {
    return ROLLBACK_KINDS[outstanding.kind] ? { action: "resolve", sequence: outstanding.sequence }
      : { action: "stop", reason: `outstanding_unknown:${outstanding.kind}` };
  }
  if (sequence === null) return { action: "stop", reason: "run_sequence_unavailable" };
  if (step === STEP.rolledBack) return { action: "cleanup_restart", sequence, migrationId: run.migration_id };
  if (step === STEP.rollingBack) return { action: "stop", reason: run.reason ?? "rolling_back" };
  if (step >= STEP.cutoverIntent) return { action: "stop", reason: step >= STEP.failed ? `run_step:${step}` : "migration_post_cutover" };
  return { action: "rollback", sequence };
}

const commands = (account: string, hold?: string) => ({
  inspect: `${CLI} status ${account}`,
  labRun: `${CLI} lab-run ${account} ${hold ?? "<backup-hold-id>"}`,
  routeBack: `${CLI} route-back ${account}`
});

/** Poll the Worker with capped exponential backoff; status reads are read-only. */
async function poller(deps: LabDeps) {
  const sleep = deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now, deadline = now() + (deps.timeoutMs ?? 2 * 60 * 60 * 1000);
  let delay = 1000, signature = "";
  return {
    sleep,
    expired: () => now() > deadline,
    async wait(status?: WorkerStatus) {
      const next = JSON.stringify(status ?? null);
      delay = next !== signature ? 1000 : Math.min(delay * 2, 30_000);
      signature = next;
      await sleep(delay);
    }
  };
}

async function readStatus(deps: LabDeps, collection: string, pace: Awaited<ReturnType<typeof poller>>): Promise<WorkerReply> {
  let reply: WorkerReply = { kind: "unknown", reason: "worker_unreachable" };
  for (let attempt = 0; attempt < 5; attempt++) {
    reply = await deps.worker.status(collection);
    if (reply.kind !== "unknown") return reply;
    await pace.wait();
  }
  return reply;
}

/**
 * preflight → start the Worker run → poll → import timers once drained →
 * confirm cutover → flip → read back the LAB completion.
 */
export async function labRun(account: string, backupHold: string, deps: LabDeps): Promise<LabOutcome> {
  const cmd = commands(account, backupHold), log = deps.log ?? (() => undefined);
  const stop = (step: string, reason: string, routeBack = false): LabOutcome =>
    ({ stopped: { step, reason, inspect: cmd.inspect, resume: routeBack ? cmd.routeBack : cmd.labRun } });
  if (!UUID.test(account) || !UUID.test(backupHold)) return stop("preflight", "invalid_request");
  let pre: Awaited<ReturnType<LabConnect["preflight"]>>;
  try { pre = await deps.connect.preflight(account); } catch (error) { return stop("preflight", codeOf(error)); }
  const { collection } = pre;
  log({ step: "preflight", collection, backend: pre.backend });
  const pace = await poller(deps);

  const importTimers = async (): Promise<LabOutcome | null> => {
    for (let attempt = 1; ; attempt++) {
      try { log({ step: "import_timers", manifest: await deps.connect.importTimers(collection) }); return null; } catch (error) {
        const code = codeOf(error);
        if (code !== "timer_source_changed" || attempt >= 5) return stop("import_timers", code);
        log({ step: "import_timers", retry: code, attempt });
        await pace.wait();
      }
    }
  };

  if (pre.backend === "legacy") {
    const started = await deps.worker.run(collection, backupHold);
    if (started.kind === "refused") return stop("worker_run", started.code);
    // A lost reply is resolved by reading the run back, never by sending it again.
    const confirmed = started.kind === "ok" ? started : await readStatus(deps, collection, pace);
    if (confirmed.kind !== "ok") return stop("worker_run", confirmed.kind === "refused" ? confirmed.code : confirmed.reason);
    if (confirmed.status.run?.backup_hold !== backupHold) return stop("worker_run", confirmed.status.run ? "migration_run_exists" : "worker_run_missing");
    log({ step: "worker_run", state: confirmed.status.run.state });

    let timersImported = false;
    for (;;) {
      const reply = await readStatus(deps, collection, pace);
      if (reply.kind !== "ok") return stop("worker_status", reply.kind === "refused" ? reply.code : reply.reason);
      const decision = decidePoll(reply.status, timersImported);
      if (decision.action === "stop") return stop("worker_status", decision.reason, decision.routeBack);
      if (decision.action === "routed") break;
      if (decision.action === "import_timers") {
        const stopped = await importTimers();
        if (stopped) return stopped;
        timersImported = true;
        continue;
      }
      if (pace.expired()) return stop("worker_status", "poll_timeout");
      await pace.wait(reply.status);
    }
    log({ step: "worker_status", routed: true });
    if (!timersImported) { const stopped = await importTimers(); if (stopped) return stopped; }
    try { await deps.connect.cutover(collection); } catch (error) { return stop("cutover", codeOf(error)); }
    log({ step: "cutover", recorded: true });
    for (let attempt = 1; ; attempt++) {
      try { await deps.connect.flip(account, collection); break; } catch (error) {
        const code = codeOf(error);
        if (code !== "timers_source_changed" || attempt >= 5) return stop("flip", code);
        log({ step: "flip", retry: code, attempt });
        const stopped = await importTimers();
        if (stopped) return stopped;
      }
    }
    log({ step: "flip", backend: "next" });
  }
  try { await deps.connect.completion(account, collection); } catch (error) { return stop("verify_completion", codeOf(error)); }
  return { done: { account_id: account, collection_id: collection, backend: "next", lab_complete: true } };
}

/**
 * rollback → resolve a lost rollback reply from the receipt → timer cleanup →
 * restart with the expected run sequence (re-import) → wait for the re-fence.
 */
export async function routeBack(account: string, deps: LabDeps): Promise<LabOutcome> {
  const cmd = commands(account), log = deps.log ?? (() => undefined);
  const stop = (step: string, reason: string): LabOutcome => ({ stopped: { step, reason, inspect: cmd.inspect, resume: cmd.routeBack } });
  if (!UUID.test(account)) return stop("preflight", "invalid_request");
  let pre: Awaited<ReturnType<LabConnect["preflight"]>>;
  try { pre = await deps.connect.preflight(account); } catch (error) { return stop("preflight", codeOf(error)); }
  if (pre.backend !== "legacy") return stop("preflight", "account_already_next");
  const { collection } = pre, pace = await poller(deps), tried = new Set<string>();
  let phase: RouteBackPhase = "start";
  // Each operator call is bound to the expected sequence; a lost reply stops (a rerun re-reads state first).
  const operate = async (step: string, call: () => Promise<WorkerReply>): Promise<LabOutcome | null> => {
    if (tried.has(step)) return stop(step, `${step}_did_not_settle`);
    tried.add(step);
    const reply = await call();
    if (reply.kind === "ok") { log({ step, state: reply.status.run?.state ?? null }); return null; }
    return stop(step, reply.kind === "refused" ? `operator_refused:${reply.code}` : `operator_outcome_unknown:${reply.reason}`);
  };
  for (;;) {
    const reply = await readStatus(deps, collection, pace);
    if (reply.kind !== "ok") return stop("worker_status", reply.kind === "refused" ? reply.code : reply.reason);
    const { status } = reply, decision = decideRouteBack(status, phase);
    let stopped: LabOutcome | null = null;
    switch (decision.action) {
      case "stop": return stop(phase === "restarted" ? "refence" : "worker_status", decision.reason);
      case "done": return { done: {
        account_id: account, collection_id: collection, refenced: true,
        run_sequence: "error" in status.native ? null : status.native.run_sequence ?? null,
        next: commands(account, status.run!.backup_hold).labRun
      } };
      case "wait":
        if (pace.expired()) return stop(phase === "restarted" ? "refence" : "rollback", "poll_timeout");
        await pace.wait(status);
        continue;
      case "resolve":
        stopped = await operate(`resolve_receipt:${decision.sequence}`, () => deps.worker.resolve(collection, decision.sequence));
        phase = "rolling_back";
        break;
      case "rollback":
        stopped = await operate("rollback", () => deps.worker.rollback(collection, decision.sequence));
        phase = "rolling_back";
        break;
      case "cleanup_restart":
        if (decision.migrationId) {
          try { log({ step: "timer_cleanup", ...(await deps.connect.cleanupTimers(collection, decision.migrationId)) }); } catch (error) {
            return stop("timer_cleanup", codeOf(error));
          }
        }
        stopped = await operate("restart", () => deps.worker.restart(collection, decision.sequence));
        phase = "restarted";
        break;
    }
    if (stopped) return stopped;
  }
}

/** Read-only: the account's control-plane facts and the Worker status. */
export async function labStatus(account: string, deps: Pick<LabDeps, "worker" | "connect">): Promise<Record<string, unknown>> {
  const pre = await deps.connect.preflight(account);
  const reply = await deps.worker.status(pre.collection);
  return { account_id: account, ...pre, worker: reply.kind === "ok" ? reply.status : reply };
}
