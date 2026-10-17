/** Durable run record, checkpoint view and the internal run/status entry for the
 * migration executor (`migration-executor.ts`). The run record is host DATA
 * (operator inputs, the provider run, members-policy bookkeeping, why it
 * stopped); the native checkpoint and action ledger stay the only migration
 * state machine. The checkpoint view is decoded from SQL for status and loop
 * gating only and never settles anything. */
import { decode, type CborValue } from "../../../packages/sdk/src/cbor.ts";
import { boundedText, serviceAuthorization } from "./service-devices.ts";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const NIL = "00000000-0000-0000-0000-000000000000";
const MAX_ENTRY_BYTES = 1024;
export const RUN_KEY = "migration-run";
export const PAUSE_REASON = "operator_pause_before_cutover";

/** Driver `Step` values (`migrate-portable` `hosted_import::Step`). */
export const STEP = {
  start: 0, backupHeld: 1, created: 2, baseIntent: 3, baseAppended: 4, shadowed: 5, fenced: 6, drained: 7,
  verified: 8, revoked: 9, cutoverIntent: 10, replaying: 11, replayed: 12, routed: 13,
  rollingBack: 20, rolledBack: 21, failed: 22, gone: 23,
} as const;

/** What status and the loop read from the saved checkpoint (wire fmt 1). */
export interface CheckpointView {
  step: number;
  fenced: boolean;
  fenceFirst: boolean;
  sFinal: number | null;
  baseSeq: number | null;
  cutoverSeq: number | null;
  revoked: string[];
  attempts: number;
  failure: string | null;
  /** H7: `LiveDigest::digest` of the S_final source read (hex), recorded with `verified`. */
  sourceDigest: string | null;
  /** The latest rebuilt-cache compare's target side: digest (hex), log head, counts. */
  target: { digest: string; head: number; records: number; files: number; fileBytes: number } | null;
}

/** The status `verification` projection: digests and counts only, never content. */
export interface VerificationView {
  records: number;
  files: number;
  file_bytes: number;
  source_digest: string;
  target_digest: string;
  log_head: number;
}

function uint(v: CborValue | undefined): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

const hex32 = (v: CborValue | undefined): string | null =>
  v instanceof Uint8Array && v.length === 32 ? Array.from(v, b => b.toString(16).padStart(2, "0")).join("") : null;

/** Optional B32 (absent is null; present must be 32 bytes). */
function optHash(m: Map<CborValue, CborValue>, k: number): string | null {
  if (!m.has(k)) return null;
  const h = hex32(m.get(k));
  if (h === null) throw new Error("migration_checkpoint_invalid");
  return h;
}

/** Target facts (keys 23-27) are all present or all absent, as native writes them. */
function targetFacts(m: Map<CborValue, CborValue>): CheckpointView["target"] {
  const keys = [23, 24, 25, 26, 27];
  const present = keys.filter(k => m.has(k)).length;
  if (present === 0) return null;
  const digest = optHash(m, 23), [head, records, files, fileBytes] = [24, 25, 26, 27].map(k => uint(m.get(k)));
  if (present !== keys.length || digest === null || head === null || records === null || files === null || fileBytes === null) {
    throw new Error("migration_checkpoint_invalid");
  }
  return { digest, head, records, files, fileBytes };
}

/** Decode `mig_checkpoint.v`; throws on anything but the fmt-1 map. */
export function decodeCheckpoint(bytes: Uint8Array): CheckpointView {
  const v = decode(bytes);
  if (!(v instanceof Map)) throw new Error("migration_checkpoint_invalid");
  const m = v as Map<CborValue, CborValue>;
  if (m.get(0) !== 1) throw new Error("migration_checkpoint_invalid");
  const step = uint(m.get(2)), attempts = uint(m.get(20));
  const revoked = m.get(12) ?? [];
  if (step === null || attempts === null || typeof m.get(9) !== "boolean" || !Array.isArray(revoked) ||
      !revoked.every(r => typeof r === "string")) throw new Error("migration_checkpoint_invalid");
  const failure = m.get(19);
  return {
    step, attempts, fenced: m.get(9) === true, fenceFirst: m.get(21) === true,
    sFinal: uint(m.get(10)), baseSeq: uint(m.get(7)), cutoverSeq: uint(m.get(13)),
    revoked: [...revoked as string[]].sort(), failure: typeof failure === "string" ? failure : null,
    sourceDigest: optHash(m, 22), target: targetFacts(m),
  };
}

/** Recorded at native step `verified` (8), kept through `routed` (13); null
 * before, after a rollback or failure, or while either side is missing. */
export function verificationView(cp: CheckpointView | null): VerificationView | null {
  if (!cp || cp.step < STEP.verified || cp.step > STEP.routed || !cp.sourceDigest || !cp.target) return null;
  return { records: cp.target.records, files: cp.target.files, file_bytes: cp.target.fileBytes,
    source_digest: cp.sourceDigest, target_digest: cp.target.digest, log_head: cp.target.head };
}

export interface NativeState {
  /** Current immutable run sequence, null before initialization/schema upgrade. */
  runSequence: number | null;
  checkpoint: CheckpointView | null;
  /** The saved unsettled action: its outcome is UNKNOWN unless this wake holds its ticket. */
  outstanding: { sequence: number; kind: number } | null;
}

type Sql = Pick<SqlStorage, "exec">;
function table(sql: Sql, name: string): boolean {
  return sql.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name).toArray().length === 1;
}

/** Read-only view of the native checkpoint and the outstanding action row. */
export function readNativeState(sql: Sql): NativeState {
  let checkpoint: CheckpointView | null = null, outstanding: NativeState["outstanding"] = null;
  if (table(sql, "mig_checkpoint")) {
    const row = sql.exec<{ v: ArrayBuffer }>("SELECT v FROM mig_checkpoint WHERE k=0").toArray()[0];
    if (row) checkpoint = decodeCheckpoint(new Uint8Array(row.v));
  }
  if (table(sql, "mig_native_action")) {
    const rows = sql.exec<{ seq: number; kind: number }>(
      "SELECT seq, kind FROM mig_native_action WHERE settled=0 ORDER BY seq LIMIT 2").toArray();
    if (rows.length > 1) throw new Error("migration_ledger_corrupt");
    if (rows[0]) outstanding = { sequence: rows[0].seq, kind: rows[0].kind };
  }
  let runSequence: number | null = null;
  if (table(sql, "mig_native_run") && sql.exec<{ name: string }>("PRAGMA table_info(mig_native_run)").toArray().some(c => c.name === "seq")) {
    const row = sql.exec<{ seq: number }>("SELECT seq FROM mig_native_run ORDER BY seq DESC LIMIT 1").toArray()[0];
    if (row) { if (!Number.isSafeInteger(row.seq) || row.seq <= 0) throw new Error("migration_ledger_corrupt"); runSequence = row.seq; }
  }
  return { runSequence, checkpoint, outstanding };
}

/** Host scheduling gate only, not effect or settlement authority. */
export function atPreCutoverPause(native: NativeState): boolean {
  const cp = native.checkpoint;
  return native.runSequence !== null && !native.outstanding && cp?.step === STEP.verified && cp.fenced
    && cp.baseSeq !== null && cp.sFinal !== null && cp.cutoverSeq === null && cp.failure === null;
}

export type RunState = "running" | "waiting" | "stopped" | "done";

/** The executor's durable record (DO storage `migration-run`). */
export interface RunRecord {
  v: 1;
  collection: string;
  /** Operator input: the in-force `hosted_provider_backup_holds.id`. */
  backupHold: string;
  /** Explicit operator intent: stop after H1, before preparing cutover. */
  pauseBeforeCutover: boolean;
  /** Consumed resume intent belongs to this immutable native run only. */
  resumeRunSequence: number | null;
  state: RunState;
  /** Why it waits or stopped (stable code, never secret or row content). */
  reason: string | null;
  /** The provider run from the fence/drain bodies (claim-bound Connect calls). */
  migrationId: string | null;
  /** The current claim's owner and start, as last read by a prepare. */
  owner: string | null;
  startedUs: string | null;
  /** members-policy queued after the fence and base append / before the final compare. */
  membersBase: boolean;
  membersFinal: boolean;
  /** The last action this executor prepared. */
  last: { sequence: number; kind: number } | null;
  /** Consecutive native refusals with nothing outstanding. */
  refusals: number;
  startedAt: number;
  updatedAt: number;
}

export function newRun(collection: string, backupHold: string, now: number, pauseBeforeCutover = false): RunRecord {
  return { v: 1, collection, backupHold, pauseBeforeCutover, resumeRunSequence: null, state: "running", reason: null, migrationId: null, owner: null, startedUs: null,
    membersBase: false, membersFinal: false, last: null, refusals: 0, startedAt: now, updatedAt: now };
}

export interface RunStore {
  load(): Promise<RunRecord | null>;
  save(run: RunRecord): Promise<void>;
}

/** The DO's run store; each save is followed by the platform's physical sync. */
export function storageRunStore(storage: Pick<DurableObjectStorage, "get" | "put" | "sync">): RunStore {
  return {
    async load() {
      const v = await storage.get<Omit<RunRecord, "pauseBeforeCutover" | "resumeRunSequence"> & { pauseBeforeCutover?: unknown; resumeRunSequence?: unknown }>(RUN_KEY);
      if (!v) return null;
      if (v.v !== 1 || !UUID.test(v.collection)
          || (v.pauseBeforeCutover !== undefined && typeof v.pauseBeforeCutover !== "boolean")) throw new Error("migration_run_invalid");
      const resumeRunSequence = v.resumeRunSequence ?? null;
      if (resumeRunSequence !== null && (typeof resumeRunSequence !== "number" || !Number.isSafeInteger(resumeRunSequence)
          || resumeRunSequence <= 0 || v.pauseBeforeCutover !== true)) throw new Error("migration_run_invalid");
      // Pre-pause v1 jobs have no scheduling intent. Retire this read compatibility
      // when the supported predecessor floor no longer includes those jobs.
      return { ...v, pauseBeforeCutover: v.pauseBeforeCutover ?? false, resumeRunSequence };
    },
    async save(run) {
      await storage.put(RUN_KEY, run);
      await storage.sync();
    },
  };
}

const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const uuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v) && v !== NIL;

async function entryBody(request: Request, token: string | undefined, keys: readonly string[], pause = false):
  Promise<Record<string, unknown> | Response> {
  const denied = serviceAuthorization(request, token);
  if (denied) return denied;
  const text = await boundedText(request, MAX_ENTRY_BYTES);
  try {
    const body = text === null ? null : JSON.parse(text) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) return json(400, { error: "invalid_request" });
    const b = body as Record<string, unknown>;
    const hasPause = pause && Object.hasOwn(b, "stop_before_flip");
    if (Object.keys(b).length !== keys.length + (hasPause ? 1 : 0) || !keys.every(k => uuid(b[k]))
        || (hasPause && typeof b.stop_before_flip !== "boolean")) return json(400, { error: "invalid_request" });
    return b;
  } catch { return json(400, { error: "invalid_request" }); }
}

/** Service-token run entry; old callers omit the explicit pause intent. */
export async function migrationRunRequest(request: Request, token?: string):
  Promise<{ collection: string; backupHold: string; pauseBeforeCutover: boolean } | Response> {
  const body = await entryBody(request, token, ["collection", "backup_hold"], true);
  return body instanceof Response ? body : { collection: body.collection as string, backupHold: body.backup_hold as string,
    pauseBeforeCutover: body.stop_before_flip === true };
}

/** `POST /internal/v1/migration/status {collection}` (service token). */
export async function migrationStatusRequest(request: Request, token?: string): Promise<{ collection: string } | Response> {
  const body = await entryBody(request, token, ["collection"]);
  return body instanceof Response ? body : { collection: body.collection as string };
}

/** The status body: run record, checkpoint view and the verification
 * projection; no secrets or content. */
export function migrationStatus(run: RunRecord | null, native: NativeState | { error: string }) {
  return {
    verification: "error" in native ? null : verificationView(native.checkpoint),
    run: run && { state: run.state, reason: run.reason, stop_before_flip: run.pauseBeforeCutover, resumed_run_sequence: run.resumeRunSequence, backup_hold: run.backupHold, migration_id: run.migrationId,
      members_base: run.membersBase, members_final: run.membersFinal, last: run.last,
      started_at: new Date(run.startedAt).toISOString(), updated_at: new Date(run.updatedAt).toISOString() },
    native: "error" in native ? native : {
      run_sequence: native.runSequence,
      checkpoint: native.checkpoint && { step: native.checkpoint.step, fenced: native.checkpoint.fenced,
        attempts: native.checkpoint.attempts, s_final: native.checkpoint.sFinal, base_seq: native.checkpoint.baseSeq,
        cutover_seq: native.checkpoint.cutoverSeq, failure: native.checkpoint.failure },
      outstanding: native.outstanding,
    },
  };
}
