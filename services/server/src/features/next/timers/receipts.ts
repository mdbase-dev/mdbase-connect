import { createHash } from "node:crypto";
import type { DatabaseQueryable } from "../../../database-types.js";
import { canonicalJson } from "../../../canonical-json.js";
import { authorizeTimerOperation, type TimerGrant } from "./grants.js";
import { criterionSchema, namespaceSchema, timerIdSchema, TimerError, type DesiredTimer, type TimerView } from "./model.js";
import { lockNamespace } from "./store.js";

// Store boundary only: caller owns BEGIN/COMMIT and authenticates again after
// locks and before COMMIT. The HTTP receiver must hold current authority locks.
const MAX_RESULT_BYTES = 1024 * 1024 - 1024;
const MAX_RECEIPTS_PER_GRANT = 8192;
const MAX_RECEIPT_BYTES_PER_GRANT = 32 * 1024 * 1024;
const ADMISSION_WINDOW_MS = 5 * 60_000;
const RETENTION_MS = 7 * 24 * 60 * 60_000;
const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type Result = { namespace: string; timers: TimerView[]; cancelled_ids: string[] };
export interface TimerOperationReceipt {
  protocol_version: 1;
  operation_id: string;
  namespace: string;
  expected_revision: number;
  committed_revision: number;
  result: Result;
}
interface ReceiptRow {
  operation_id: string;
  namespace: string;
  request_digest: Buffer;
  terms_digest: Buffer;
  expected_revision: string | number;
  committed_revision: string | number;
  result_metadata: Result;
}
export interface TimerReceiptAuthority {
  grant: TimerGrant;
  // Digest of actual retained immutable consent, not a caller's JSON or an
  // inferred member/owner/backend marker. PRIVATE dependencies still deny.
  termsDigest: Buffer;
}
function conflict(): never {
  throw new TimerError(409, "operation_conflict", "The timer operation identity or intent is no longer applicable.");
}
function receipt(row: ReceiptRow): TimerOperationReceipt {
  return { protocol_version: 1, operation_id: row.operation_id, namespace: row.namespace,
    expected_revision: Number(row.expected_revision), committed_revision: Number(row.committed_revision),
    result: row.result_metadata };
}
function validateOperation(id: string, revision: number): void {
  if (!UUID7.test(id) || !Number.isSafeInteger(revision) || revision < 0 || revision === Number.MAX_SAFE_INTEGER) {
    throw new TimerError(400, "invalid_request", "A UUIDv7 operation and safe namespace revision are required.");
  }
}
function checkAuthority(authority: TimerReceiptAuthority, grantId: string, criterionId?: string): void {
  if (authority.grant.grantId !== grantId || authority.termsDigest.length !== 32) {
    throw new Error("Invalid timer receipt authority binding.");
  }
  authorizeTimerOperation(authority.grant, "reconcile_timers", criterionId);
}

/** Read-only: no locks, expiry cleanup, namespace creation or worker dispatch. */
export async function lookupTimerReceipt(
  db: DatabaseQueryable, grantId: string, namespace: string, operationId: string,
  authority: TimerReceiptAuthority
): Promise<TimerOperationReceipt | null> {
  namespaceSchema.parse(namespace);
  if (!UUID7.test(operationId)) throw new TimerError(400, "invalid_request", "A UUIDv7 operation is required.");
  checkAuthority(authority, grantId);
  const rows = await db.query<ReceiptRow>(
    `SELECT operation_id, namespace, request_digest, terms_digest, expected_revision,
       committed_revision, result_metadata FROM next_timer_operation_receipts
     WHERE grant_id = $1 AND operation_id = $2`, [grantId, operationId]);
  const row = rows.rows[0];
  if (!row) return null; // UNKNOWN, never proof of no effect.
  if (row.namespace !== namespace || !row.terms_digest.equals(authority.termsDigest)) conflict();
  return receipt(row);
}

/** Same transaction: exact retained replay returns the original metadata only. */
export async function recordTimerReconcile(
  db: DatabaseQueryable, grantId: string, namespace: string,
  input: { operationId: string; expectedRevision: number; criterionId: string; desired: DesiredTimer[] },
  authenticate: () => Promise<TimerReceiptAuthority>,
  mutate: (grant: TimerGrant) => Promise<Result>
): Promise<TimerOperationReceipt> {
  namespaceSchema.parse(namespace);
  validateOperation(input.operationId, input.expectedRevision);
  criterionSchema.parse(input.criterionId);
  if (input.desired.length > 10_000) throw new TimerError(413, "too_large", "Too many desired timers.");
  const ids = new Set<string>();
  for (const timer of input.desired) {
    timerIdSchema.parse(timer.id);
    if (ids.has(timer.id) || !Number.isFinite(timer.fireAt.getTime())) throw new TimerError(400, "invalid_request", "Invalid desired timer snapshot.");
    ids.add(timer.id);
  }
  // Includes grant-wide quota/identity lock before namespace lock.
  await lockNamespace(db, grantId, namespace);
  const authority = await authenticate();
  checkAuthority(authority, grantId, input.criterionId);
  const digest = createHash("sha256").update(canonicalJson({ namespace,
    criterion_id: input.criterionId, expected_revision: input.expectedRevision,
    timers: input.desired.map(t => ({ id: t.id, fire_at: t.fireAt.toISOString(), data: t.data ?? null })) })).digest();
  const rows = await db.query<ReceiptRow>(
    `SELECT operation_id, namespace, request_digest, terms_digest, expected_revision,
       committed_revision, result_metadata FROM next_timer_operation_receipts
     WHERE grant_id = $1 AND operation_id = $2`, [grantId, input.operationId]);
  const old = rows.rows[0];
  if (old) {
    if (old.namespace !== namespace || Number(old.expected_revision) !== input.expectedRevision
      || !old.request_digest.equals(digest) || !old.terms_digest.equals(authority.termsDigest)) conflict();
    return receipt(old);
  }
  // UUIDv7 timestamp is immutable in the identity. Once retention has elapsed,
  // an old missing identity can never be admitted again, even with changed JSON.
  const issuedAt = Number.parseInt(input.operationId.slice(0, 8) + input.operationId.slice(9, 13), 16);
  if (Math.abs(Date.now() - issuedAt) > ADMISSION_WINDOW_MS) {
    throw new TimerError(409, "operation_not_admitted", "The missing timer operation cannot be admitted; its outcome remains unknown.", {
      reason: "operation_clock_window", admission: "not_admitted", operation_outcome: "unknown"
    });
  }
  const state = await db.query<{ intent_revision: string | number }>(
    "SELECT intent_revision FROM next_timer_namespace_intents WHERE grant_id = $1 AND namespace = $2", [grantId, namespace]);
  if (Number(state.rows[0]?.intent_revision ?? 0) !== input.expectedRevision) conflict();
  if (!state.rows.length) {
    const count = await db.query<{ count: string | number }>("SELECT count(*) AS count FROM next_timer_namespace_intents WHERE grant_id = $1", [grantId]);
    if (Number(count.rows[0].count) >= 256) throw new TimerError(429, "rate_limited", "Timer namespace capacity reached.");
  }
  // Conservative closed-metadata upper bound checked BEFORE invoking any timer
  // mutation. Includes actual cancelled IDs, maximal safe integer/status and
  // generous ISO timestamp lengths; the envelope has a reserved 1 KiB budget.
  const active = await db.query<{ timer_id: string }>(
    "SELECT timer_id FROM next_timers WHERE grant_id = $1 AND namespace = $2 AND status IN ('scheduled', 'firing')", [grantId, namespace]);
  const forecast: Result = { namespace,
    cancelled_ids: active.rows.filter(t => !ids.has(t.timer_id)).map(t => t.timer_id),
    timers: input.desired.map(t => ({ id: t.id, criterion_id: input.criterionId, fire_at: t.fireAt.toISOString(),
      generation: Number.MAX_SAFE_INTEGER, status: "cancelled", created_at: "0".repeat(32), updated_at: "0".repeat(32), fired_at: "0".repeat(32) })) };
  const forecastBytes = Buffer.byteLength(JSON.stringify(forecast));
  if (forecastBytes > MAX_RESULT_BYTES) throw new TimerError(413, "too_large", "Timer receipt metadata exceeds capacity.");
  // Cleanup is write-side only, after new-operation admission. Expired identities
  // are not reused and namespace intent revisions are never reset or pruned.
  await db.query("DELETE FROM next_timer_operation_receipts WHERE grant_id = $1 AND committed_at < $2",
    [grantId, new Date(Date.now() - RETENTION_MS).toISOString()]);
  const quota = await db.query<{ count: string; bytes: string }>(
    `SELECT count(*) AS count, COALESCE(sum(octet_length(result_metadata::text)), 0) AS bytes
     FROM next_timer_operation_receipts WHERE grant_id = $1`, [grantId]);
  if (Number(quota.rows[0].bytes) + forecastBytes > MAX_RECEIPT_BYTES_PER_GRANT) {
    throw new TimerError(413, "too_large", "Timer receipt metadata exceeds capacity.");
  }
  if (Number(quota.rows[0].count) >= MAX_RECEIPTS_PER_GRANT) {
    throw new TimerError(429, "rate_limited", "Timer receipt capacity reached.");
  }
  const result = await mutate(authority.grant);
  // Closed metadata projection: no timer data (or future unknown fields) copied.
  const metadata: Result = { namespace, cancelled_ids: [...result.cancelled_ids], timers: result.timers.map(t => ({
    id: t.id, criterion_id: t.criterion_id, fire_at: t.fire_at, generation: t.generation, status: t.status,
    created_at: t.created_at, updated_at: t.updated_at, fired_at: t.fired_at
  })) };
  const encoded = JSON.stringify(metadata);
  if (Buffer.byteLength(encoded) > MAX_RESULT_BYTES || Number(quota.rows[0].bytes) + Buffer.byteLength(encoded) > MAX_RECEIPT_BYTES_PER_GRANT) {
    throw new TimerError(413, "too_large", "Timer receipt metadata exceeds capacity.");
  }
  const current = await authenticate();
  checkAuthority(current, grantId, input.criterionId);
  if (!current.termsDigest.equals(authority.termsDigest)) conflict();
  const after = await db.query<{ intent_revision: string | number }>(
    "SELECT intent_revision FROM next_timer_namespace_intents WHERE grant_id = $1 AND namespace = $2", [grantId, namespace]);
  const revision = Number(after.rows[0]?.intent_revision);
  if (revision !== input.expectedRevision + 1) throw new Error("Timer mutation did not advance exactly one namespace intent.");
  const inserted = await db.query<ReceiptRow>(
    `INSERT INTO next_timer_operation_receipts (grant_id, operation_id, namespace, request_digest,
       terms_digest, expected_revision, committed_revision, result_metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     RETURNING operation_id, namespace, request_digest, terms_digest, expected_revision, committed_revision, result_metadata`,
    [grantId, input.operationId, namespace, digest, authority.termsDigest, input.expectedRevision, revision, encoded]);
  return receipt(inserted.rows[0]);
}
