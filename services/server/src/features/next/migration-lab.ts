// Shared orchestration of one account's hosted migration (`lab-run`) and
// of its pre-cutover route-back (`route-back`), for the operator CLI
// (migration-lab-cli.ts). Ordinary archived starts share the managed path in
// LAB, staging and production; recorded fixture starts keep their singleton.
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
//
// A managed account runs in two phases. Every member's Worker run is in pause
// mode: phase 1 brings EVERY member to the verified, fenced pre-cutover pause
// with its timers imported, and only then does phase 2 resume and cut each over
// back to back and flip once. Before any cutover intent, route-back returns
// the whole set; after one, the driver only moves forward.
import { z } from "zod";
import { localBuild, localDeployment, rehearsalDiagnostics } from "../../local-deployment.js";
import type { DatabasePool, DatabaseQueryable } from "../../database-types.js";
import type { HostedProviderClient } from "../../hosted-provider.js";
import { audit } from "../../platform/audit-events.js";
import { flipEvidenceDigest } from "./account-backend-flip.js";
import { inTransaction } from "./bootstrap-common.js";
import { SCOPED_HOSTED_ARCHIVE_SCHEMA } from "./migration-archive-profile.js";
import { BINDING, latchPhase, latchRefused, lockManagedAccount, MANAGED_RUN, type ManagedRun, managedRunSchema, type PhaseLatch,
  readIntents, readManagedRun, readPhaseLatch, recordedStartContract, WORKER_INTENT } from "./migration-managed-ledger.js";
import { claim } from "./migration-provider.js";
import { labTargetSubCause, labTargetUnavailable, migrationJobEnvironment } from "./migration-lab-target.js";
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
    stop_before_flip: z.boolean().optional(), resumed_run_sequence: z.number().int().positive().nullable().optional(),
    /** The last prepared action; timeline DATA only, absent from older Workers. */
    last: z.object({ sequence: z.number().int().nonnegative(), kind: z.number().int().nonnegative() }).nullable().optional() }).nullable(),
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
/** Bounded, content-free refusal facts: UUIDs and finite predicates only. */
type RefusalDetails = Readonly<Record<string, unknown>>;
type ManagedPreflight = { job: "managed"; collections: string[]; backend: "legacy" | "next"; cut_over_collections: string[]; run: ManagedRun | null;
  /** Members with a durable dispatch intent (a read; claimWorkerRun stays authoritative), and whether
   * the start's accepted archive is scoped (its original fence can never be taken again). */
  intents: string[]; archive_scoped: boolean; phase_latch: PhaseLatch | null;
  /** Inspection only: the admission refusal `status` reports instead of throwing. */
  refusal?: { code: string; details?: RefusalDetails } };
type Preflight = { collection: string; backend: "legacy" | "next" } | ManagedPreflight;
export interface LabConnect {
  preflight(account: string, options?: { inspect?: boolean }): Promise<Preflight>;
  /** Existing CP audit rows bind the original set/hold and reserve ONE dispatch per collection. */
  bindRun?(account: string, collections: readonly string[], hold: string, operatorStopBeforeFlip: boolean): Promise<void>;
  claimWorkerRun?(account: string, collection: string): Promise<boolean>;
  /** The account's one-way phase latch (migration-managed-ledger.ts), committed before the first resume or rollback. */
  latchPhase?(account: string, phase: PhaseLatch): Promise<void>;
  /** Canonical SHADOW/device/genesis bootstrap BEFORE Worker ready() custody. */
  prepareTarget(collection: string): Promise<void>;
  importTimers(collection: string): Promise<unknown>;
  cutover(collection: string): Promise<void>;
  flip(account: string, collections: string | readonly string[]): Promise<void>;
  completion(account: string, collections: string | readonly string[]): Promise<void>;
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
interface LabStop { step: string; reason: string; inspect: string; resume: string; collection_id?: string; collection_ids?: readonly string[];
  /** Managed only: `prepare` (before the barrier) or `cutover` (forward only). */
  phase?: "prepare" | "cutover"; details?: RefusalDetails;
  worker_run_reply?: WorkerRunReplyDiagnostic; target_reply?: TargetReplyDiagnostic }
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

const refusalDetails = (error: unknown): { details?: RefusalDetails } =>
  error instanceof RolloutRefused && error.details ? { details: error.details } : {};

/** The control-plane port over the Connect database and the legacy provider. */
export function postgresLabConnect(options: {
  db: DatabasePool; source: DatabasePool; actor: string; timers: boolean; environment?: string;
  provider: Pick<HostedProviderClient, "legacyMigrationSource" | "legacyMigrationDrain" | "legacyMigrationRetain">;
  importTimers?: (collection: string) => Promise<unknown>;
  prepareTarget?: (collection: string) => Promise<void>;
}): LabConnect {
  const { db, provider } = options;
  // Deployment admission, independent of each account's recorded start contract.
  const deployment = localBuild() ? (options.environment === "local" ? "lab" : undefined) : migrationJobEnvironment(options.environment);
  if (!deployment) throw new RolloutRefused("lab_only", "The migration job is unavailable in this build/environment.", 503);
  return {
    async preflight(account, { inspect = false } = {}) {
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
      const job = await recordedStartContract(db, account, deployment);
      const hosted = (await db.query<{ id: string; state: string; quarantined: boolean; deleted: boolean; cut_over: boolean }>(
        `SELECT h.id::text AS id, h.authority_state AS state, h.quarantined_at IS NOT NULL AS quarantined,
           EXISTS (SELECT 1 FROM next_collection_deletion_facts d WHERE d.collection_id=h.id) AS deleted,
           EXISTS (SELECT 1 FROM next_migration_collections c WHERE c.collection_id=h.id AND c.account_id=h.user_id) AS cut_over
         FROM hosted_collections h WHERE h.user_id=$1 AND h.authority_state<>'transferred' ORDER BY h.id`, [account])).rows;
      if (job === "managed") {
        if (!hosted.length) throw new RolloutRefused("managed_inventory_empty", "No held hosted collections; use the separately admitted zero-hosted path.");
        if (hosted.length > 16) throw new RolloutRefused("managed_inventory_over_cap", "The managed account exceeds the 16-collection bound.");
        // Admission refuses; inspection (status) reports the first refusal and still lists the set.
        let refusal: ManagedPreflight["refusal"], run: ManagedRun | null = null;
        const refuse = (error: unknown) => {
          if (!inspect || !(error instanceof RolloutRefused)) throw error;
          refusal ??= { code: error.code, ...refusalDetails(error) };
        };
        const unsettled = hosted.filter(c => c.state !== "active" || c.quarantined || c.deleted).map(c => ({ collection_id: c.id,
          predicate: c.deleted ? "deleted" : c.quarantined ? "quarantined" : ["importing", "transferring"].includes(c.state) ? c.state : "authority_other" }));
        if (unsettled.length) refuse(new RolloutRefused("collections_unsettled", "Every held hosted collection must remain eligible.", 409, { unsettled }));
        const collections = hosted.map(c => c.id);
        let latch: PhaseLatch | null = null;
        try { run = await readManagedRun(db, account); latch = await readPhaseLatch(db, account); } catch (error) { refuse(error); }
        if (run && run.collections.join() !== collections.join()) {
          refuse(new RolloutRefused("collections_mismatch", "The held set changed since the original run.", 409, {
            added: collections.filter(id => !run!.collections.includes(id)), missing: run.collections.filter(id => !collections.includes(id)) }));
        }
        const intents = await readIntents(db, account);
        // The same predicate as the CP's original-archive fence (migration-provider.ts).
        const scoped = (await db.query<{ scoped: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM next_migration_cohort_members m JOIN next_migration_archive_acceptances a ON a.cohort=m.cohort
             WHERE m.account_id=$1 AND m.started_at IS NOT NULL AND a.verified_result->>'schema'=$2) AS scoped`,
          [account, SCOPED_HOSTED_ARCHIVE_SCHEMA])).rows[0]?.scoped === true;
        return { job, collections, backend: row.backend === "next" ? "next" : "legacy", run, intents, archive_scoped: scoped, phase_latch: latch,
          cut_over_collections: hosted.filter(c => c.cut_over).map(c => c.id), ...(refusal ? { refusal } : {}) };
      }
      if (hosted.length !== 1 || hosted[0]!.state !== "active") {
        throw new RolloutRefused("lab_inventory_invalid", "The rehearsal account must have exactly one settled hosted collection.");
      }
      return { collection: hosted[0]!.id, backend: row.backend === "next" ? "next" : "legacy" };
    },
    async bindRun(account, collections, hold, operatorStop) {
      await inTransaction(db, async client => {
        await lockManagedAccount(client, account, deployment);
        const member = (await client.query<{ started_us: string }>(
          `SELECT (extract(epoch FROM started_at)*1000000)::bigint::text AS started_us FROM next_migration_cohort_members
           WHERE account_id=$1 AND started_at IS NOT NULL AND terminal_excluded_at IS NULL`, [account])).rows[0];
        if (!member) throw new RolloutRefused("account_not_started", "The account's migration has not started.");
        const held = (await client.query<{ id: string }>(
          "SELECT id::text FROM hosted_collections WHERE user_id=$1 AND authority_state<>'transferred' ORDER BY id FOR SHARE", [account])).rows.map(c => c.id);
        if (held.join() !== collections.join() || new Set(collections).size !== collections.length)
          throw new RolloutRefused("collections_mismatch", "The managed run must bind the complete distinct held set.");
        const expected = managedRunSchema.parse({ binding: BINDING, collections, backup_hold: hold,
          operator_stop_before_flip: operatorStop, started_us: member.started_us });
        const original = await readManagedRun(client, account);
        if (original) {
          if (JSON.stringify(original) !== JSON.stringify(expected)) throw new RolloutRefused("managed_run_conflict", "Resume the original collection set, hold and pause intent.");
        } else await audit(client, account, MANAGED_RUN, account, expected);
      });
    },
    async claimWorkerRun(account, collection) {
      return inTransaction(db, async client => {
        await lockManagedAccount(client, account, deployment);
        // No new dispatch once either phase latch is recorded.
        const latch = await readPhaseLatch(client, account);
        if (latch) throw latchRefused(latch);
        const run = await readManagedRun(client, account);
        if (!run?.collections.includes(collection)) throw new RolloutRefused("managed_run_missing", "No original run binding for this collection.");
        const current = await claim(client, collection, true);
        if (current.account !== account || current.started_us !== run.started_us) throw new RolloutRefused("migration_source_changed", "The original migration claim changed.");
        const prior = await client.query("SELECT 1 FROM audit_events WHERE user_id=$1 AND subject_id=$2 AND event_type=$3", [account, collection, WORKER_INTENT]);
        if (prior.rows.length) return false;
        // COMMIT precedes dispatch. An unknown COMMIT or lost Worker reply can
        // only reconcile by status, including after process loss; never replay.
        // The dispatch is always pause mode, so even a late original can only
        // reach the verified pre-cutover pause, never cut over by itself.
        await audit(client, account, WORKER_INTENT, collection,
          { binding: BINDING, backup_hold: run.backup_hold, started_us: run.started_us, worker_pause: true });
        return true;
      });
    },
    async latchPhase(account, phase) {
      await inTransaction(db, async client => {
        await lockManagedAccount(client, account, deployment);
        const run = await readManagedRun(client, account);
        if (!run) throw new RolloutRefused("managed_run_missing", "No original run binding for this account.");
        await latchPhase(client, account, phase, run);
      });
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
      const collections = typeof collection === "string" ? [collection] : collection;
      if (!collections.length) throw new RolloutRefused("managed_inventory_empty", "The hosted migration driver requires a nonempty set.");
      if (new Set(collections).size !== collections.length) throw new RolloutRefused("collections_duplicated", "A collection is named twice.");
      const rows = (await db.query<{ collection_id: string; barrier_f: string; final_digest: string }>(
        "SELECT collection_id::text, barrier_f::text, final_digest FROM next_migration_collections WHERE collection_id=ANY($1::uuid[]) AND account_id=$2",
        [collections, account])).rows;
      if (rows.length !== collections.length) throw new RolloutRefused("cutover_not_recorded", "No cutover is recorded for every named collection.");
      await flipAccountBackend(db, account, collections, flipEvidenceDigest(rows), { enabled: options.timers, provider }, deployment);
    },
    async completion(account, collection) {
      // A cohort completes on an accepted archive OR, without one, on the LAB
      // completion event; the strict readback requires exactly one of the two.
      // A suspended owner's migration completes too (suspension is unchanged).
      const collections = typeof collection === "string" ? [collection] : collection;
      if (!collections.length) throw new RolloutRefused("managed_inventory_empty", "The hosted migration driver requires a nonempty set.");
      try {
        for (const id of collections)
          await requireCompletedAccountMigration(db, id, account, { suspendedOwner: true });
      } catch (error) {
        if ((error as { code?: unknown })?.code === "collection_migrating") {
          throw new RolloutRefused("lab_completion_missing", "The completion readback refuses this account.");
        }
        throw error;
      }
    },
    async cleanupTimers(collection, migrationId) {
      const current = await claim(db, collection);
      return cleanUpRolledBackTimerImport(db, provider, deployment, collection,
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

/** One timeline line per Worker status change (DATA only, no decisions). */
function workerTimeline(status: WorkerStatus, tMs: number) {
  const checkpoint = "error" in status.native ? null : status.native.checkpoint;
  return { step: "worker_timeline", t_ms: tMs, state: status.run?.state ?? null, reason: status.run?.reason ?? null,
    checkpoint_step: checkpoint?.step ?? null, last_kind: status.run?.last?.kind ?? null };
}

/** Poll the Worker with capped exponential backoff; status reads are read-only. */
async function poller(deps: LabDeps) {
  const sleep = deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now, deadline = now() + (deps.timeoutMs ?? 2 * 60 * 60 * 1000);
  let delay = 1000, signature = "";
  return {
    sleep,
    expired: () => now() > deadline,
    async wait(status?: WorkerStatus) {
      // Pacing ignores the timeline-only `last` field, as before it was parsed.
      const next = JSON.stringify(status ? { ...status, run: status.run && { ...status.run, last: undefined } } : null);
      delay = next !== signature ? 1000 : Math.min(delay * 2, 5_000);
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

/** Whether a member's original run has consumed the operator resume (phase 2). */
const resumedMember = ({ run, native }: WorkerStatus) =>
  !("error" in native) && !!run && !!native.run_sequence && run.resumed_run_sequence === native.run_sequence;
/** At or past cutover intent, or recorded as cut over: never rolled back. */
const committedMember = ({ native }: WorkerStatus, cutOver: boolean) => cutOver
  || !("error" in native) && !!native.checkpoint && native.checkpoint.step >= STEP.cutoverIntent && native.checkpoint.step < STEP.rollingBack;
/** The shared barrier: the original run stopped at the verified, fenced pre-cutover pause. */
function atVerifiedPause(status: WorkerStatus): boolean {
  const { run, native } = status;
  return !("error" in native) && !!native.run_sequence && !!run && run.state === "stopped" && run.reason === PAUSE_REASON
    && run.stop_before_flip === true && run.resumed_run_sequence === null && native.checkpoint?.step === STEP.verified
    && native.checkpoint.fenced && !native.outstanding && UUID.test(run.backup_hold);
}

type Pace = Awaited<ReturnType<typeof poller>>;
interface PollContext { deps: LabDeps; pace: Pace; elapsed: () => number; log: (event: Record<string, unknown>) => void;
  stop: (step: string, reason: string, routeBack?: boolean) => LabOutcome; importTimers: () => Promise<LabOutcome | null> }
/** Poll one original run, importing its timers once drained, until it is routed
 * or (`pause`) at the verified pre-cutover pause. `bind` checks every read. */
async function pollRun(ctx: PollContext, collection: string,
  options: { pause: boolean; bind?: (status: WorkerStatus) => string | null; initial?: WorkerReply })
  : Promise<{ outcome: LabOutcome } | { at: "paused" | "routed"; timersImported: boolean }> {
  let timersImported = false, timeline = "", initial = options.initial;
  for (;;) {
    const reply: WorkerReply = initial ?? await readStatus(ctx.deps, collection, ctx.pace); initial = undefined;
    if (reply.kind !== "ok") return { outcome: ctx.stop("worker_status", reply.kind === "refused" ? reply.code : reply.reason) };
    const unbound = options.bind?.(reply.status);
    if (unbound) return { outcome: ctx.stop("worker_status", unbound) };
    const line = workerTimeline(reply.status, ctx.elapsed()), key = JSON.stringify({ ...line, t_ms: 0 });
    if (key !== timeline) { timeline = key; ctx.log(line); }
    const decision = decidePoll(reply.status, timersImported);
    if (decision.action === "stop") {
      if (options.pause && decision.reason === PAUSE_REASON) return { at: "paused", timersImported };
      return { outcome: ctx.stop("worker_status", decision.reason, decision.routeBack) };
    }
    if (decision.action === "routed") return options.pause ? { outcome: ctx.stop("worker_status", "managed_phase_inconsistent") } : { at: "routed", timersImported };
    if (decision.action === "import_timers") {
      const stopped = await ctx.importTimers(); if (stopped) return { outcome: stopped };
      timersImported = true; continue;
    }
    if (ctx.pace.expired()) return { outcome: ctx.stop("worker_status", "poll_timeout") };
    await ctx.pace.wait(reply.status);
  }
}

/** Import one collection's timers; only `timer_source_changed` is retried. */
async function importWithRetry(deps: LabDeps, pace: Pace, collection: string, log: (event: Record<string, unknown>) => void,
  stop: (code: string) => LabOutcome): Promise<LabOutcome | null> {
  for (let attempt = 1; ; attempt++) {
    try { log({ step: "import_timers", manifest: await deps.connect.importTimers(collection) }); return null; } catch (error) {
      const code = codeOf(error);
      if (code !== "timer_source_changed" || attempt >= 5) return stop(code);
      log({ step: "import_timers", retry: code, attempt }); await pace.wait();
    }
  }
}

/** Canonical target bootstrap before Worker ready() custody; a refusal carries
 * only the bounded LAB sub-cause. */
async function prepareTarget(deps: LabDeps, collection: string, log: (event: Record<string, unknown>) => void)
  : Promise<{ code: string; diagnostic?: TargetReplyDiagnostic } | null> {
  try { await deps.connect.prepareTarget(collection); } catch (error) {
    const cause = labTargetSubCause(error, deps.environment), diagnostic = cause ? { raw_error: { sub_cause: cause } } : undefined;
    if (diagnostic) log({ step: "target_reply", ...diagnostic });
    return { code: codeOf(error), ...(diagnostic ? { diagnostic } : {}) };
  }
  log({ step: "prepare_target", collection }); return null;
}

/** The one combined flip; the flip rereads ALL sources, so a changed source
 * refreshes every manifest before retrying. */
async function flipOnce(deps: LabDeps, account: string, named: string | readonly string[], log: (event: Record<string, unknown>) => void,
  stop: (code: string) => LabOutcome, reimport: () => Promise<LabOutcome | null>): Promise<LabOutcome | null> {
  for (let attempt = 1; ; attempt++) {
    try { await deps.connect.flip(account, named); return null; } catch (error) {
      const code = codeOf(error);
      if (code !== "timers_source_changed" || attempt >= 5) return stop(code);
      log({ step: "flip", retry: code, attempt });
      const stopped = await reimport(); if (stopped) return stopped;
    }
  }
}

/**
 * preflight → start the Worker run → poll → import timers once drained →
 * confirm cutover → flip → read back the completion. A managed account runs
 * the two phases (driveManaged); a recorded fixture keeps its singleton.
 */
export async function labRun(account: string, backupHold: string, deps: LabDeps, stopBeforeFlip = false): Promise<LabOutcome> {
  const cmd = commands(account, backupHold);
  const stop = (reason: string, error?: unknown): LabOutcome => ({ stopped: { step: "preflight", reason,
    inspect: cmd.inspect, resume: cmd.labRun + (stopBeforeFlip ? " --stop-before-flip" : ""), ...refusalDetails(error) } });
  if (!UUID.test(account) || !UUID.test(backupHold)) return stop("invalid_request");
  let pre: Preflight;
  try { pre = await deps.connect.preflight(account); } catch (error) { return stop(codeOf(error), error); }
  return "job" in pre ? driveManaged(account, backupHold, pre, deps, { operatorStop: stopBeforeFlip, resume: false })
    : driveLabRun(account, backupHold, pre, deps, stopBeforeFlip);
}

/** The recorded LAB fixture's one collection; its Worker pause is the operator flag. */
async function driveLabRun(account: string, backupHold: string, pre: Exclude<Preflight, ManagedPreflight>,
  deps: LabDeps, stopBeforeFlip: boolean): Promise<LabOutcome> {
  const cmd = commands(account, backupHold), log = deps.log ?? (() => undefined), pace = await poller(deps);
  const now = deps.now ?? Date.now, startedAt = now(), { collection } = pre;
  const stop = (step: string, reason: string, routeBack = false, diagnostic?: WorkerRunReplyDiagnostic, target?: TargetReplyDiagnostic): LabOutcome =>
    ({ stopped: { step, reason, inspect: cmd.inspect, resume: reason === PAUSE_REASON ? cmd.resume
      : routeBack ? cmd.routeBack : cmd.labRun + (stopBeforeFlip ? " --stop-before-flip" : ""),
      ...(diagnostic ? { worker_run_reply: diagnostic } : {}), ...(target ? { target_reply: target } : {}) } });
  log({ step: "preflight", collection, backend: pre.backend });
  const importTimers = () => importWithRetry(deps, pace, collection, log, code => stop("import_timers", code));
  if (pre.backend === "legacy") {
    const target = await prepareTarget(deps, collection, log);
    if (target) return stop("prepare_target", target.code, false, undefined, target.diagnostic);
    const started = await deps.worker.run(collection, backupHold, stopBeforeFlip);
    if (started.diagnostic) log({ step: "worker_run_reply", kind: started.kind, ...started.diagnostic });
    if (started.kind === "refused") return stop("worker_run", started.code, false, started.diagnostic);
    // Preserve the initial run reply before resolving it by read-only status, never retrying the run.
    const confirmed = started.kind === "ok" ? started : await readStatus(deps, collection, pace);
    if (confirmed.kind !== "ok") return stop("worker_run", confirmed.kind === "refused" ? confirmed.code : confirmed.reason, false, started.diagnostic);
    if (confirmed.status.run?.backup_hold !== backupHold) return stop("worker_run", confirmed.status.run ? "migration_run_exists" : "worker_run_missing", false, started.diagnostic);
    if (stopBeforeFlip ? confirmed.status.run.stop_before_flip !== true : confirmed.status.run.stop_before_flip === true)
      return stop("worker_run", "migration_pause_mode_conflict");
    log({ step: "worker_run", state: confirmed.status.run.state });
    const polled = await pollRun({ deps, pace, log, elapsed: () => now() - startedAt, stop, importTimers }, collection, { pause: false });
    if ("outcome" in polled) return polled.outcome;
    log({ step: "worker_status", routed: true });
    if (!polled.timersImported) { const stopped = await importTimers(); if (stopped) return stopped; }
    try { await deps.connect.cutover(collection); } catch (error) { return stop("cutover", codeOf(error)); }
    log({ step: "cutover", recorded: true });
    const flipped = await flipOnce(deps, account, collection, log, code => stop("flip", code), importTimers);
    if (flipped) return flipped;
    log({ step: "flip", backend: "next" });
  }
  try { await deps.connect.completion(account, collection); } catch (error) { return stop("verify_completion", codeOf(error)); }
  return { done: { account_id: account, collection_id: collection, backend: "next", lab_complete: true } };
}

/** A managed account's two phases (see the file header). Phase 1 dispatches a member
 * only with no run, no native state and no durable intent. A member past the barrier
 * (resume consumed, cutover intent or later, cut over) makes every invocation forward only. */
async function driveManaged(account: string, hold: string, pre: ManagedPreflight, deps: LabDeps,
  mode: { operatorStop: boolean; resume: boolean }): Promise<LabOutcome> {
  const cmd = commands(account, hold), { collections } = pre;
  const log = deps.log ?? (() => undefined), pace = await poller(deps), now = deps.now ?? Date.now, startedAt = now();
  const rerun = cmd.labRun + (mode.operatorStop ? " --stop-before-flip" : "");
  let current: string | undefined, phase: "prepare" | "cutover" = "prepare", committed = false;
  const stop = (step: string, reason: string, o: { routeBack?: boolean; diagnostic?: WorkerRunReplyDiagnostic; target?: TargetReplyDiagnostic; error?: unknown } = {}): LabOutcome =>
    ({ stopped: { step, reason, inspect: cmd.inspect,
      // Route-back only while nothing is committed; once past the barrier, forward only.
      resume: reason === PAUSE_REASON ? cmd.resume : o.routeBack && !committed ? cmd.routeBack : phase === "cutover" ? cmd.resume : rerun,
      phase, collection_ids: collections, ...(current ? { collection_id: current } : {}), ...refusalDetails(o.error),
      ...(o.diagnostic ? { worker_run_reply: o.diagnostic } : {}), ...(o.target ? { target_reply: o.target } : {}) } });
  if (!collections.length || collections.length > 16 || new Set(collections).size !== collections.length
      || collections.some((id, i) => !UUID.test(id) || i > 0 && id <= collections[i - 1]!)) return stop("preflight", "managed_inventory_invalid");
  log({ step: "preflight", collection_ids: collections, backend: pre.backend });
  if (pre.backend === "legacy") {
    if (pre.phase_latch === "route_back") return stop("preflight", "managed_route_back_started", { routeBack: true });
    try {
      if (!deps.connect.bindRun) throw new Error("Managed run ledger unavailable.");
      await deps.connect.bindRun(account, collections, hold, mode.operatorStop);
    } catch (error) { return stop("bind_run", codeOf(error), { error }); }
    const memberLog = (collection: string) => (event: Record<string, unknown>) => log({ ...event, collection_id: collection });
    const importTimers = (collection: string) => () => {
      current = collection;
      return importWithRetry(deps, pace, collection, memberLog(collection), code => stop("import_timers", code));
    };
    const context = (collection: string): PollContext => ({ deps, pace, elapsed: () => now() - startedAt, log: memberLog(collection),
      stop: (step, reason, routeBack) => stop(step, reason, { routeBack }), importTimers: importTimers(collection) });
    // Every read binds the original hold and the Worker's pause mode.
    const bind = (status: WorkerStatus) => !status.run ? "worker_run_missing" : status.run.backup_hold !== hold ? "migration_run_exists"
      : status.run.stop_before_flip !== true ? "migration_pause_mode_conflict" : null;
    const cutOver = (collection: string) => pre.cut_over_collections.includes(collection);

    // Observe the whole set first (read-only); the phase follows from durable state.
    const observed = new Map<string, WorkerStatus>();
    for (const collection of collections) {
      current = collection;
      const reply = await readStatus(deps, collection, pace);
      if (reply.kind !== "ok") return stop("worker_status", reply.kind === "refused" ? reply.code : reply.reason);
      observed.set(collection, reply.status);
    }
    current = undefined;
    committed = pre.phase_latch === "cutover" || collections.some(c => committedMember(observed.get(c)!, cutOver(c)));
    if (!committed && !collections.some(c => resumedMember(observed.get(c)!))) {
      if (mode.resume) {
        // An explicit resume crosses the barrier only from a complete pause pass.
        current = collections.find(c => bind(observed.get(c)!) || !atVerifiedPause(observed.get(c)!));
        if (current) return stop("resume", "managed_pause_incomplete");
      } else {
        for (const collection of collections) {
          current = collection;
          const status = observed.get(collection)!;
          let initial: WorkerReply = { kind: "ok", status };
          if (!status.run) {
            if ("error" in status.native) return stop("worker_status", `native_state:${status.native.error}`);
            if (cutOver(collection) || status.native.checkpoint || status.native.outstanding) return stop("worker_status", "worker_run_missing");
            // A durable intent with no visible run is UNKNOWN: never re-enter target creation or dispatch.
            if (pre.intents.includes(collection)) return stop("worker_run", "worker_run_outcome_unknown");
            const target = await prepareTarget(deps, collection, memberLog(collection));
            if (target) return stop("prepare_target", target.code, { target: target.diagnostic });
            try {
              if (!deps.connect.claimWorkerRun || !await deps.connect.claimWorkerRun(account, collection)) return stop("worker_run", "worker_run_outcome_unknown");
            } catch (error) { return stop("worker_run", codeOf(error), { error }); }
            const started = await deps.worker.run(collection, hold, true);
            if (started.diagnostic) memberLog(collection)({ step: "worker_run_reply", kind: started.kind, ...started.diagnostic });
            if (started.kind === "refused") return stop("worker_run", started.code, { diagnostic: started.diagnostic });
            const confirmed = started.kind === "ok" ? started : await readStatus(deps, collection, pace);
            if (confirmed.kind !== "ok") return stop("worker_run", confirmed.kind === "refused" ? confirmed.code : confirmed.reason, { diagnostic: started.diagnostic });
            const unbound = bind(confirmed.status); if (unbound) return stop("worker_run", unbound, { diagnostic: started.diagnostic });
            memberLog(collection)({ step: "worker_run", state: confirmed.status.run?.state });
            initial = confirmed;
          }
          // Phase 1 never follows a run past the pause: a resumed run here is a concurrent operator.
          const polled = await pollRun(context(collection), collection, { pause: true, initial,
            bind: s => bind(s) ?? (resumedMember(s) || committedMember(s, false) ? "managed_phase_inconsistent" : null) });
          if ("outcome" in polled) return polled.outcome;
          memberLog(collection)({ step: "worker_status", paused: true });
        }
        current = undefined;
        if (mode.operatorStop) return stop("worker_status", PAUSE_REASON);
      }
    }
    // The account latch commits before the first resume: no route-back has begun, and none can now.
    if (pre.phase_latch !== "cutover") {
      try {
        if (!deps.connect.latchPhase) throw new Error("Managed run ledger unavailable.");
        await deps.connect.latchPhase(account, "cutover");
      } catch (error) { const code = codeOf(error); return stop("cutover_latch", code, { error, routeBack: code === "managed_route_back_started" }); }
    }
    committed = true; phase = "cutover";
    for (const collection of collections) {
      current = collection;
      const reply = await readStatus(deps, collection, pace);
      if (reply.kind !== "ok") return stop("worker_status", reply.kind === "refused" ? reply.code : reply.reason);
      const unbound = bind(reply.status); if (unbound) return stop("worker_status", unbound);
      let initial: WorkerReply = reply;
      if (!resumedMember(reply.status) && !committedMember(reply.status, cutOver(collection))) {
        if (!atVerifiedPause(reply.status)) return stop("worker_status", "managed_phase_inconsistent");
        const resumed = await resumeWorker(collection, reply.status, deps.worker);
        if (resumed.kind !== "ok") return stop("resume", resumed.kind === "refused" ? resumed.code : resumed.reason);
        memberLog(collection)({ step: "resume", run_sequence: "error" in resumed.status.native ? null : resumed.status.native.run_sequence ?? null });
        initial = resumed;
      }
      const polled = await pollRun(context(collection), collection, { pause: false, bind, initial });
      if ("outcome" in polled) return polled.outcome;
      memberLog(collection)({ step: "worker_status", routed: true });
      committed = true;
      if (!polled.timersImported) { const stopped = await importTimers(collection)(); if (stopped) return stopped; }
      try { await deps.connect.cutover(collection); } catch (error) { return stop("cutover", codeOf(error), { error }); }
      memberLog(collection)({ step: "cutover", recorded: true });
    }
    current = undefined;
    const flipped = await flipOnce(deps, account, collections, log, code => stop("flip", code), async () => {
      for (const collection of collections) { const stopped = await importTimers(collection)(); if (stopped) return stopped; }
      current = undefined; return null;
    });
    if (flipped) return flipped;
    log({ step: "flip", backend: "next", collection_ids: collections });
  }
  try { await deps.connect.completion(account, collections); } catch (error) { return stop("verify_completion", codeOf(error), { error }); }
  return { done: { account_id: account, collection_ids: collections, backend: "next", migration_complete: true } };
}

async function resumeWorker(collection: string, before: WorkerStatus, worker: LabWorker): Promise<WorkerReply> {
  const refuse = (code: string): WorkerReply => ({ kind: "refused", code });
  const { run, native } = before;
  if ("error" in native) return refuse(`native_state:${native.error}`);
  const sequence = native.run_sequence;
  if (!sequence) return refuse("run_sequence_unavailable");
  if (!atVerifiedPause(before)) return refuse("migration_pause_not_current");
  const resumed = await worker.resume(collection, sequence);
  if (resumed.kind !== "ok") return refuse(resumed.kind === "refused"
    ? `operator_refused:${resumed.code}` : `operator_outcome_unknown:${resumed.reason}`);
  const after = resumed.status;
  if ("error" in after.native || after.native.run_sequence !== sequence || after.run?.resumed_run_sequence !== sequence
      || after.run.stop_before_flip !== true || after.run.backup_hold !== run!.backup_hold
      || !["running", "waiting", "done"].includes(after.run.state)) return refuse("operator_outcome_unknown:resume_unconfirmed");
  return resumed;
}

/** Explicit, sequence-bound resume; a lost operator reply is never retried or adopted. */
export async function resumeLab(account: string, deps: LabDeps): Promise<LabOutcome> {
  const cmd = commands(account);
  const stop = (reason: string, error?: unknown): LabOutcome => ({ stopped: { step: "resume", reason, inspect: cmd.inspect, resume: cmd.resume,
    ...refusalDetails(error) } });
  if (!UUID.test(account)) return stop("invalid_request");
  let pre: Preflight;
  try { pre = await deps.connect.preflight(account); } catch (error) { return stop(codeOf(error), error); }
  if ("job" in pre) {
    if (!pre.run) return stop("managed_run_missing");
    return driveManaged(account, pre.run.backup_hold, pre, deps, { operatorStop: pre.run.operator_stop_before_flip, resume: true });
  }
  if (pre.backend !== "legacy") return stop("account_already_next");
  const before = await readStatus(deps, pre.collection, await poller(deps));
  if (before.kind !== "ok") return stop(before.kind === "refused" ? before.code : before.reason);
  const resumed = await resumeWorker(pre.collection, before.status, deps.worker);
  if (resumed.kind !== "ok") return stop(resumed.kind === "refused" ? resumed.code : resumed.reason);
  return driveLabRun(account, before.status.run!.backup_hold, pre, deps, true);
}

/**
 * rollback → resolve a lost rollback reply from the receipt → timer cleanup → (fixture
 * job only) restart with the expected run sequence and wait for the re-fence. A managed
 * account is inspected whole before any mutation: no phase 2 latch, nothing resumed or at
 * cutover intent; a durable intent with no run stays UNKNOWN; a never-dispatched member is
 * left untouched. Its latch then commits, the account is re-inspected, and the route-back
 * is terminal for the attempt.
 */
export async function routeBack(account: string, deps: LabDeps): Promise<LabOutcome> {
  const cmd = commands(account);
  const stop = (step: string, reason: string, error?: unknown): LabOutcome => ({ stopped: { step, reason, inspect: cmd.inspect, resume: cmd.routeBack,
    ...refusalDetails(error) } });
  if (!UUID.test(account)) return stop("preflight", "invalid_request");
  let pre: Preflight;
  try { pre = await deps.connect.preflight(account); } catch (error) { return stop("preflight", codeOf(error), error); }
  if (pre.backend !== "legacy") return stop("preflight", "account_already_next");
  if (!("job" in pre)) return routeBackCollection(account, pre.collection, deps, true);
  let managed = pre;
  // Phase 2 may have sent a resume whose reply or arrival is unknown: forward only.
  const forward = (): LabOutcome => ({ stopped: { step: "preflight", reason: "managed_cutover_started", inspect: cmd.inspect,
    resume: cmd.resume, collection_ids: managed.collections } });
  if (managed.phase_latch === "cutover") return forward();
  const inspect = async (): Promise<LabOutcome | { collection: string; dispatched: boolean }[]> => {
    const observed = await Promise.all(managed.collections.map(async collection => ({ collection, reply: await deps.worker.status(collection) })));
    const plan: { collection: string; dispatched: boolean }[] = [];
    for (const { collection, reply } of observed) {
      const refuse = (reason: string): LabOutcome => ({ stopped: { step: "worker_status", reason, inspect: cmd.inspect, resume: cmd.routeBack,
        collection_id: collection, collection_ids: managed.collections } });
      if (reply.kind !== "ok") return refuse(reply.kind === "refused" ? reply.code : reply.reason);
      const { status } = reply;
      // A routed sibling keeps its serving custody: partial cutover is forward only.
      if (committedMember(status, managed.cut_over_collections.includes(collection))) return refuse("migration_post_cutover");
      if (resumedMember(status)) return refuse("managed_cutover_started");
      if ("error" in status.native) return refuse(`native_state:${status.native.error}`);
      if (!status.run) {
        if (status.native.checkpoint || status.native.outstanding) return refuse("worker_run_missing");
        if (managed.intents.includes(collection)) return refuse("worker_run_outcome_unknown");
        plan.push({ collection, dispatched: false });
        continue;
      }
      if (!managed.run || status.run.backup_hold !== managed.run.backup_hold || status.run.stop_before_flip !== true) return refuse("managed_run_conflict");
      const decision = decideRouteBack(status, "start");
      if (decision.action === "stop") return refuse(decision.reason);
      plan.push({ collection, dispatched: true });
    }
    return plan;
  };
  let plan = await inspect();
  if (!Array.isArray(plan)) return plan;
  if (plan.some(member => member.dispatched) && managed.phase_latch !== "route_back") {
    // Latch before the first rollback, then re-inspect: no dispatch intent or resume can begin after it.
    try {
      if (!deps.connect.latchPhase) throw new Error("Managed run ledger unavailable.");
      await deps.connect.latchPhase(account, "route_back");
      const latched = await deps.connect.preflight(account);
      if (!("job" in latched)) throw new RolloutRefused("start_profile_invalid", "The recorded start changed.");
      managed = latched;
    } catch (error) { return codeOf(error) === "managed_cutover_started" ? forward() : stop("route_back_latch", codeOf(error), error); }
    plan = await inspect();
    if (!Array.isArray(plan)) return plan;
  }
  const notDispatched = plan.filter(member => !member.dispatched).map(member => member.collection);
  const rerun = commands(account, managed.run?.backup_hold).labRun + (managed.run?.operator_stop_before_flip ? " --stop-before-flip" : "");
  if (notDispatched.length === plan.length) return { stopped: { step: "worker_status", reason: "managed_nothing_dispatched",
    inspect: cmd.inspect, resume: rerun, collection_ids: managed.collections } };
  // Terminal for the attempt: under the latch nothing resumes, so a re-fenced run could never
  // continue, and a scoped archive's original fence is never taken again. Sources stay active.
  const results: Record<string, unknown>[] = [];
  for (const { collection, dispatched } of plan) {
    if (!dispatched) { results.push({ collection_id: collection, not_dispatched: true }); continue; }
    const result = await routeBackCollection(account, collection, { ...deps,
      log: event => deps.log?.({ ...event, collection_id: collection }) }, false);
    if ("stopped" in result) return { stopped: { ...result.stopped, collection_id: collection, collection_ids: managed.collections } };
    results.push(result.done);
  }
  return { done: { account_id: account, collection_ids: managed.collections, collections: results, not_dispatched: notDispatched,
    disposition: "fresh_attempt_required" } };
}

/** Canonical per-collection rollback (and, with `restart`, restart/re-fence); shared by fixture and managed jobs. */
async function routeBackCollection(account: string, collection: string, deps: LabDeps, restart: boolean): Promise<LabOutcome> {
  const cmd = commands(account), log = deps.log ?? (() => undefined);
  const stop = (step: string, reason: string): LabOutcome => ({ stopped: { step, reason, inspect: cmd.inspect, resume: cmd.routeBack } });
  const pace = await poller(deps), tried = new Set<string>();
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
        // Cleanup succeeds only on a settled rollback with the legacy source active and unfenced.
        if (!restart) return { done: { account_id: account, collection_id: collection, rolled_back: true,
          legacy_verified: decision.migrationId !== null, run_sequence: decision.sequence } };
        stopped = await operate("restart", () => deps.worker.restart(collection, decision.sequence));
        phase = "restarted";
        break;
    }
    if (stopped) return stopped;
  }
}

/** Read-only: the account's control-plane facts and the Worker status. A managed
 * account is listed even when its admission refuses (`refusal`). */
export async function labStatus(account: string, deps: Pick<LabDeps, "worker" | "connect">): Promise<Record<string, unknown>> {
  const pre = await deps.connect.preflight(account, { inspect: true });
  if ("job" in pre) {
    const collections = await Promise.all(pre.collections.map(async collection_id => {
      const reply = await deps.worker.status(collection_id);
      return { collection_id, cut_over: pre.cut_over_collections.includes(collection_id), intent: pre.intents.includes(collection_id),
        worker: reply.kind === "ok" ? reply.status : reply };
    }));
    return { account_id: account, ...pre, collection_ids: pre.collections, collections };
  }
  const reply = await deps.worker.status(pre.collection);
  return { account_id: account, ...pre, worker: reply.kind === "ok" ? reply.status : reply };
}
