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
import { localBuild, localDeployment, rehearsalDiagnostics } from "../../local-deployment.js";
import type { DatabasePool } from "../../database-types.js";
import type { HostedProviderClient } from "../../hosted-provider.js";
import { flipEvidenceDigest } from "./account-backend-flip.js";
import { claim } from "./migration-provider.js";
import { labTargetSubCause, labTargetUnavailable } from "./migration-lab-target.js";
import { cutOverCollection, flipAccountBackend, RolloutRefused } from "./migration-rollout.js";
import { requireCompletedAccountMigration } from "./migration-sharing.js";
import { cleanUpRolledBackTimerImport } from "./migration-timer-cleanup.js";
import { legacyTimerGrantResolver } from "./timers/grants.js";
import { importHostedCollectionTimers } from "./timers/hosted-import.js";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u;
const CLI = "pnpm --filter @mdbase/connect-server next:migration-lab";
const MAX_REPLY_BYTES = 64 * 1024;

/** Native Driver steps (`hosted_import::Step`, mirrored by the Worker's status). */
export const PAUSE_REASON = "operator_pause_before_cutover";
export const STEP = { fenced: 6, drained: 7, verified: 8, cutoverIntent: 10, routed: 13, rollingBack: 20, rolledBack: 21, failed: 22, gone: 23 } as const;
/** Native rollback action kinds whose lost reply the Worker resolves from the provider receipt. */
const ROLLBACK_KINDS: Readonly<Record<number, string>> = { 20: "Unrevoke", 21: "Unfence" };

const statusSchema = z.object({
  run: z.object({ state: z.string(), reason: z.string().nullable(), backup_hold: z.string(), migration_id: z.string().nullable(),
    stop_before_flip: z.boolean().optional(), resumed_run_sequence: z.number().int().positive().nullable().optional() }).nullable(),
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

// Ready-stage wire v1: finite diagnostic DATA, never error messages or native tails.
const readyStage = z.enum([
  "background_guard", "physical_collection_guard", "collection_guard", "service_collection_persist",
  "alarm_guard", "open_retry_read", "open_retry_schedule", "custody_open_sealer", "engine_construct",
  "engine_config", "engine_cpp_open", "engine_open", "engine_noise_key", "custody_zeroize",
  "pin_digest", "pin_marker_read", "pin_mismatch", "live_admission", "sync", "pin_parked_guard",
  "timing_snapshot", "engine_reset", "open_failure_clear", "unknown"
]).catch("unknown");
const readyErrorName = z.enum(["Error", "TypeError", "RangeError", "AbortError", "TimeoutError", "other"]).catch("other");
const readyErrorCode = z.enum([
  "pitr_actor_closed", "hosted_alarm_inhibited", "physical_collection_mismatch", "collection_mismatch",
  "hosted_pin_parked", "custody_unavailable", "custody_aborted", "custody_invalid_record",
  "custody_identity_mismatch", "custody_record_changed", "custody_secret_invalid", "custody_envelope_invalid",
  "custody_key_not_configured", "kms_refused", "kms_invalid_response", "kms_aborted",
  "kms_credentials_unavailable", "cpp_owned_control_not_established", "hosted_engine_already_opened",
  "hosted_cache_reset", "pin_mismatch_reset", "unknown"
]).catch("unknown");

const rawSubCause = z.object({
  call: z.enum(["control_service_device_first", "control_service_device_recheck", "kms_unwrap", "control_log_token", "record_validate", "derive", "other"]),
  name: z.string().refine(value => Buffer.byteLength(value, "utf8") <= 128).nullable(),
  message: z.string().refine(value => Buffer.byteLength(value, "utf8") <= 4096).nullable(),
});
const rawWorkerError = z.object({ message: z.string().nullable(), stack: z.string().nullable(), sub_cause: rawSubCause.optional().catch(undefined) });

/** Bounded HTTP run provenance; LAB-only raw data is for protected operator capture. */
interface WorkerRunReplyDiagnostic {
  http_status: number | null;
  raw_error?: z.infer<typeof rawWorkerError>;
  worker_error_code: string | null;
  worker_error_class: "error" | "type_error" | "range_error" | "abort_error" | "timeout_error" | "other" | null;
  worker_error_stage: z.infer<typeof readyStage> | null;
  worker_error_name: z.infer<typeof readyErrorName> | null;
  worker_error_detail_code: z.infer<typeof readyErrorCode> | null;
  transport_error_class: "timeout" | "abort" | "network" | "other" | null;
  response_class: "json" | "non_json" | "empty" | "invalid_status" | "over_bound" | null;
}

/** One Worker call. HTTP run replies carry provenance; injected non-HTTP ports need not. */
export type WorkerReply = (
  | { kind: "ok"; status: WorkerStatus }
  | { kind: "refused"; code: string }
  | { kind: "unknown"; reason: string }
) & { diagnostic?: WorkerRunReplyDiagnostic };

/**
 * The native operator entry (`POST /internal/v1/migration/operator`
 * `{collection, operation, expected_run_sequence | expected_action_sequence}`),
 * which replies with the status body or 409 `{error}`. Route-back drives the
 * Worker only through this adapter, so it can follow that entry's final shape.
 */
export interface WorkerOperator {
  rollback(collection: string, expectedRunSequence: number): Promise<WorkerReply>;
  restart(collection: string, expectedRunSequence: number): Promise<WorkerReply>;
  resume(collection: string, expectedRunSequence: number): Promise<WorkerReply>;
  /** Settle a lost rollback reply from the provider's rollback receipt. */
  resolve(collection: string, expectedActionSequence: number): Promise<WorkerReply>;
}
export interface LabWorker extends WorkerOperator {
  run(collection: string, backupHold: string, stopBeforeFlip?: boolean): Promise<WorkerReply>;
  status(collection: string): Promise<WorkerReply>;
}

/** The control-plane side; refusals throw with a `code` (RolloutRefused, TimerImportRefused). */
export interface LabConnect {
  preflight(account: string): Promise<{ collection: string; backend: "legacy" | "next" }>;
  /** Canonical SHADOW/device/genesis bootstrap BEFORE Worker ready() custody. */
  prepareTarget(collection: string): Promise<void>;
  importTimers(collection: string): Promise<unknown>;
  cutover(collection: string): Promise<void>;
  flip(account: string, collection: string): Promise<void>;
  completion(account: string, collection: string): Promise<void>;
  cleanupTimers(collection: string, migrationId: string): Promise<{ deleted: number }>;
}

interface LabDeps {
  /** Literal LAB only enables token-free target sub-cause retention/capture. */
  environment?: string;
  worker: LabWorker;
  connect: LabConnect;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Overall polling budget per invocation (default two hours). */
  timeoutMs?: number;
  log?: (event: Record<string, unknown>) => void;
}

interface TargetReplyDiagnostic { raw_error?: { sub_cause: NonNullable<ReturnType<typeof labTargetSubCause>> } }
interface LabStop { step: string; reason: string; inspect: string; resume: string; worker_run_reply?: WorkerRunReplyDiagnostic; target_reply?: TargetReplyDiagnostic }
export type LabOutcome = { done: Record<string, unknown> } | { stopped: LabStop };

/** HTTPS client for the hosted Worker's internal migration entry (service token). */
export function labWorkerClient(config: { url: string; token: string; environment?: string }, fetchImpl: typeof fetch = fetch): LabWorker {
  const url = new URL(config.url);
  if ((localBuild() ? !localDeployment(config.environment, config.url) : config.environment === "local" || url.protocol !== "https:")
      || url.username || url.password || url.search || url.hash) {
    throw new Error("MDBASE_NEXT_HOSTED_SERVICE_URL must be an https origin without credentials.");
  }
  if (config.token.length < 32) throw new Error("MDBASE_NEXT_HOSTED_SERVICE_TOKEN must be at least 32 characters.");
  const base = url.toString().replace(/\/+$/u, "");
  const post = async (path: string, body: Record<string, unknown>): Promise<WorkerReply> => {
    const diagnostic: WorkerRunReplyDiagnostic | undefined = path === "/internal/v1/migration/run"
      ? { http_status: null, worker_error_code: null, worker_error_class: null, worker_error_stage: null,
        worker_error_name: null, worker_error_detail_code: null, transport_error_class: null, response_class: null }
      : undefined;
    const finish = (reply: WorkerReply): WorkerReply => diagnostic ? { ...reply, diagnostic } : reply;
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method: "POST", redirect: "manual", signal: AbortSignal.timeout(60_000),
        headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" }, body: JSON.stringify(body)
      });
    } catch (error) {
      if (diagnostic) diagnostic.transport_error_class = error instanceof Error
        ? error.name === "TimeoutError" ? "timeout" : error.name === "AbortError" ? "abort" : error.name === "TypeError" ? "network" : "other"
        : "other";
      return finish({ kind: "unknown", reason: "worker_unreachable" });
    }
    if (diagnostic) diagnostic.http_status = response.status;
    let parsed: unknown = null;
    try {
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > MAX_REPLY_BYTES) {
        if (diagnostic) diagnostic.response_class = "over_bound";
        return finish({ kind: "unknown", reason: "worker_reply_over_bound" });
      }
      if (diagnostic) diagnostic.response_class = text ? "non_json" : "empty";
      parsed = text ? JSON.parse(text) : null;
      if (diagnostic && text) diagnostic.response_class = "json";
    } catch { parsed = null; }
    const code = (parsed as { error?: unknown } | null)?.error;
    if (diagnostic) {
      // Only codes in the run-entry contract: an arbitrary error string can be a secret.
      if (typeof code === "string" && ["invalid_request", "migration_unconfigured", "migration_run_exists",
        "migration_pause_mode_conflict", "migration_run_ready_failed", "migration_run_failed"].includes(code)) diagnostic.worker_error_code = code;
      const errorClass = (parsed as { error_class?: unknown } | null)?.error_class;
      if (typeof errorClass === "string" && ["error", "type_error", "range_error", "abort_error", "timeout_error", "other"].includes(errorClass)) {
        diagnostic.worker_error_class = errorClass as NonNullable<WorkerRunReplyDiagnostic["worker_error_class"]>;
      }
      if (rehearsalDiagnostics(config.environment) && response.status === 500
          && (code === "migration_run_ready_failed" || code === "migration_run_failed")) {
        const raw = rawWorkerError.safeParse((parsed as { raw_error?: unknown }).raw_error);
        if (raw.success) diagnostic.raw_error = raw.data;
      }
      if (code === "migration_run_ready_failed") {
        const ready = parsed as { stage?: unknown; error_name?: unknown; error_code?: unknown };
        diagnostic.worker_error_stage = readyStage.parse(ready.stage);
        diagnostic.worker_error_name = readyErrorName.parse(ready.error_name);
        diagnostic.worker_error_detail_code = readyErrorCode.parse(ready.error_code);
      }
    }
    if (response.ok) {
      const status = statusSchema.safeParse(parsed);
      if (!status.success && diagnostic) diagnostic.response_class = "invalid_status";
      return finish(status.success ? { kind: "ok", status: status.data } : { kind: "unknown", reason: "worker_reply_invalid" });
    }
    // A typed error code is a refusal; anything else (gateway errors, no body) has no verified outcome.
    const typed = typeof code === "string" && /^[a-z][a-z0-9_:.-]{0,120}$/u.test(code);
    // Run refusals use the same finite contract as their diagnostic: a code-like
    // string outside it is UNKNOWN, not a safe public stop reason.
    const refusalCode = diagnostic ? diagnostic.worker_error_code : typed ? code as string : null;
    return finish(refusalCode !== null && (response.status < 500 || response.status === 503)
      ? { kind: "refused", code: refusalCode } : { kind: "unknown", reason: `worker_http_${response.status}` });
  };
  const operator = (collection: string, operation: string, key: string, sequence: number) =>
    post("/internal/v1/migration/operator", { collection, operation, [key]: sequence });
  return {
    run: (collection, backupHold, stopBeforeFlip = false) => post("/internal/v1/migration/run", {
      collection, backup_hold: backupHold, ...(stopBeforeFlip ? { stop_before_flip: true } : {})
    }),
    status: collection => post("/internal/v1/migration/status", { collection }),
    rollback: (collection, sequence) => operator(collection, "rollback", "expected_run_sequence", sequence),
    restart: (collection, sequence) => operator(collection, "restart", "expected_run_sequence", sequence),
    resume: (collection, sequence) => operator(collection, "resume", "expected_run_sequence", sequence),
    resolve: (collection, sequence) => operator(collection, "resolve", "expected_action_sequence", sequence)
  };
}

/** The control-plane port over the Connect database and the legacy provider. */
export function postgresLabConnect(options: {
  db: DatabasePool; source: DatabasePool; actor: string; timers: boolean; environment?: string;
  provider: Pick<HostedProviderClient, "legacyMigrationSource" | "legacyMigrationDrain" | "legacyMigrationRetain">;
  importTimers?: (collection: string) => Promise<unknown>;
  prepareTarget?: (collection: string) => Promise<void>;
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
    async prepareTarget(collection) {
      // A routed-but-not-flipped rerun already has its recorded NEXT target.
      // Do not re-enter the pre-cutover creator or replace its service keys.
      const routed = await db.query(
        `SELECT 1 FROM next_migration_collections c JOIN next_collections x ON x.collection_id=c.collection_id
         WHERE c.collection_id=$1 AND x.owner_user_id=c.account_id AND x.runtime='next'
           AND x.sync='cloud_copy' AND x.left_sync_at IS NULL
           AND EXISTS (SELECT 1 FROM next_service_devices d WHERE d.collection_id=x.collection_id AND d.kind='hosted')`, [collection]);
      if (routed.rows.length) return;
      if (!options.prepareTarget) labTargetUnavailable(options.environment, { call: "guard", guard: "composition" });
      await options.prepareTarget(collection);
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
      // A cohort completes on an accepted archive OR, without one, on the LAB
      // completion event; the strict readback requires exactly one of the two.
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
    if (run.reason === PAUSE_REASON) {
      if (run.stop_before_flip !== true || run.resumed_run_sequence !== null || !status.native.run_sequence
          || step !== STEP.verified || !checkpoint?.fenced || status.native.outstanding) return stopWith("migration_pause_not_current");
      if (!timersImported) return { action: "import_timers" };
    }
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
  resume: `${CLI} resume ${account}`,
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
export async function labRun(account: string, backupHold: string, deps: LabDeps, stopBeforeFlip = false): Promise<LabOutcome> {
  const cmd = commands(account, backupHold);
  const stop = (reason: string): LabOutcome => ({ stopped: { step: "preflight", reason,
    inspect: cmd.inspect, resume: cmd.labRun + (stopBeforeFlip ? " --stop-before-flip" : "") } });
  if (!UUID.test(account) || !UUID.test(backupHold)) return stop("invalid_request");
  let pre: Awaited<ReturnType<LabConnect["preflight"]>>;
  try { pre = await deps.connect.preflight(account); } catch (error) { return stop(codeOf(error)); }
  return driveLabRun(account, backupHold, pre, deps, stopBeforeFlip);
}

/** Continue the one preflight-bound collection, including after explicit resume. */
async function driveLabRun(account: string, backupHold: string, pre: Awaited<ReturnType<LabConnect["preflight"]>>,
  deps: LabDeps, stopBeforeFlip: boolean): Promise<LabOutcome> {
  const cmd = commands(account, backupHold), log = deps.log ?? (() => undefined);
  const stop = (step: string, reason: string, routeBack = false, diagnostic?: WorkerRunReplyDiagnostic, target?: TargetReplyDiagnostic): LabOutcome =>
    ({ stopped: { step, reason, inspect: cmd.inspect, resume: reason === PAUSE_REASON ? cmd.resume
      : routeBack ? cmd.routeBack : cmd.labRun + (stopBeforeFlip ? " --stop-before-flip" : ""),
      ...(diagnostic ? { worker_run_reply: diagnostic } : {}), ...(target ? { target_reply: target } : {}) } });
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
    // ready() needs an enrolled hosted identity. The executor's later target
    // action reuses the canonical immutable tuple; HTTP200 here is not H1.
    try { await deps.connect.prepareTarget(collection); }
    catch (error) {
      const cause = labTargetSubCause(error, deps.environment);
      const diagnostic = cause ? { raw_error: { sub_cause: cause } } : undefined;
      if (diagnostic) log({ step: "target_reply", ...diagnostic });
      return stop("prepare_target", codeOf(error), false, undefined, diagnostic);
    }
    log({ step: "prepare_target", collection });
    const started = await deps.worker.run(collection, backupHold, stopBeforeFlip);
    if (started.diagnostic) log({ step: "worker_run_reply", kind: started.kind, ...started.diagnostic });
    if (started.kind === "refused") return stop("worker_run", started.code, false, started.diagnostic);
    // Preserve the initial run reply before resolving it by read-only status, never retrying the run.
    const confirmed = started.kind === "ok" ? started : await readStatus(deps, collection, pace);
    if (confirmed.kind !== "ok") return stop("worker_run", confirmed.kind === "refused" ? confirmed.code : confirmed.reason, false, started.diagnostic);
    if (confirmed.status.run?.backup_hold !== backupHold) return stop("worker_run", confirmed.status.run ? "migration_run_exists" : "worker_run_missing", false, started.diagnostic);
    if (stopBeforeFlip ? confirmed.status.run.stop_before_flip !== true : confirmed.status.run.stop_before_flip === true) {
      return stop("worker_run", "migration_pause_mode_conflict");
    }
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

/** Explicit, sequence-bound resume; a lost operator reply is never retried or adopted. */
export async function resumeLab(account: string, deps: LabDeps): Promise<LabOutcome> {
  const cmd = commands(account);
  const stop = (reason: string): LabOutcome => ({ stopped: { step: "resume", reason, inspect: cmd.inspect, resume: cmd.resume } });
  if (!UUID.test(account)) return stop("invalid_request");
  let pre: Awaited<ReturnType<LabConnect["preflight"]>>;
  try { pre = await deps.connect.preflight(account); } catch (error) { return stop(codeOf(error)); }
  if (pre.backend !== "legacy") return stop("account_already_next");
  const before = await readStatus(deps, pre.collection, await poller(deps));
  if (before.kind !== "ok") return stop(before.kind === "refused" ? before.code : before.reason);
  const { run, native } = before.status;
  if ("error" in native) return stop(`native_state:${native.error}`);
  const sequence = native.run_sequence;
  if (!sequence) return stop("run_sequence_unavailable");
  if (!run || run.state !== "stopped" || run.reason !== PAUSE_REASON || run.stop_before_flip !== true
      || run.resumed_run_sequence !== null || native.checkpoint?.step !== STEP.verified
      || !native.checkpoint.fenced || native.outstanding || !UUID.test(run.backup_hold)) return stop("migration_pause_not_current");
  const resumed = await deps.worker.resume(pre.collection, sequence);
  if (resumed.kind !== "ok") return stop(resumed.kind === "refused"
    ? `operator_refused:${resumed.code}` : `operator_outcome_unknown:${resumed.reason}`);
  const after = resumed.status;
  if ("error" in after.native || after.native.run_sequence !== sequence || after.run?.resumed_run_sequence !== sequence
      || after.run.stop_before_flip !== true || after.run.backup_hold !== run.backup_hold
      || !["running", "waiting", "done"].includes(after.run.state)) {
    return stop("operator_outcome_unknown:resume_unconfirmed");
  }
  return driveLabRun(account, run.backup_hold, pre, deps, true);
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
        next: commands(account, status.run!.backup_hold).labRun + (status.run!.stop_before_flip ? " --stop-before-flip" : "")
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
