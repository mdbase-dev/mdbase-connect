import { createHash } from "node:crypto";
import type { DatabaseQueryable } from "../../../database-types.js";
import { dataPermitted, type TimerGrant } from "./grants.js";
import {
  ACTIVE_STATUSES,
  LIST_RETENTION_MS,
  MAX_ACTIVE_PER_GRANT,
  MAX_ACTIVE_PER_NAMESPACE,
  TimerError,
  instant,
  sameData,
  timerView,
  type DesiredTimer,
  type TimerRow,
  type TimerView
} from "./model.js";

/**
 * Timer storage. Every write function runs inside the caller's transaction and
 * after `lockNamespace`, which serializes writers of one (grant, namespace).
 */

const COLUMNS = `grant_id, namespace, timer_id, criterion_id, fire_at, generation,
  status, data, created_at, updated_at, fired_at`;

export async function lockNamespace(
  db: DatabaseQueryable,
  grantId: string,
  namespace: string
): Promise<void> {
  // Grant-wide lock first: revision namespace capacity and receipt quotas must
  // serialize across namespaces. Imports take grant/namespace pairs in order.
  const grantDigest = createHash("sha256").update(`mdbase/v1/timer-receipts\0${grantId}`).digest();
  await db.query("SELECT pg_advisory_xact_lock($1, $2)", [grantDigest.readInt32BE(0), grantDigest.readInt32BE(4)]);
  const digest = createHash("sha256")
    .update(`mdbase/v1/timer-namespace\0${grantId}\0${namespace}`)
    .digest();
  await db.query("SELECT pg_advisory_xact_lock($1, $2)", [
    digest.readInt32BE(0),
    digest.readInt32BE(4)
  ]);
}

/** Advance every accepted intent, including no-op cancellation/reconciliation. */
export async function advanceTimerIntent(db: DatabaseQueryable, grantId: string, namespace: string): Promise<number> {
  const existing = await db.query("SELECT intent_revision FROM next_timer_namespace_intents WHERE grant_id = $1 AND namespace = $2", [grantId, namespace]);
  if (!existing.rows.length) {
    const count = await db.query<{ count: string | number }>("SELECT count(*) AS count FROM next_timer_namespace_intents WHERE grant_id = $1", [grantId]);
    if (Number(count.rows[0].count) >= 256) throw new TimerError(429, "rate_limited", "Timer namespace capacity reached.");
  }
  const rows = await db.query<{ intent_revision: string | number }>(
    `INSERT INTO next_timer_namespace_intents (grant_id, namespace, intent_revision)
       VALUES ($1, $2, 1)
     ON CONFLICT (grant_id, namespace) DO UPDATE
       SET intent_revision = next_timer_namespace_intents.intent_revision + 1
       WHERE next_timer_namespace_intents.intent_revision < 9007199254740991
     RETURNING intent_revision`, [grantId, namespace]);
  if (rows.rows.length !== 1) throw new TimerError(413, "too_large", "Timer namespace revision exhausted.");
  return Number(rows.rows[0].intent_revision);
}

export async function listTimers(
  db: DatabaseQueryable,
  grant: TimerGrant,
  namespace: string,
  now = new Date()
): Promise<TimerView[]> {
  const rows = await db.query<TimerRow>(
    `SELECT ${COLUMNS} FROM next_timers
     WHERE grant_id = $1 AND namespace = $2
       AND (status IN ('scheduled', 'firing') OR updated_at > $3)
     ORDER BY fire_at, timer_id`,
    [grant.grantId, namespace, new Date(now.getTime() - LIST_RETENTION_MS).toISOString()]
  );
  return rows.rows.map((row) => timerView(row, dataPermitted(grant)));
}

async function selectTimer(
  db: DatabaseQueryable,
  grantId: string,
  namespace: string,
  timerId: string
): Promise<TimerRow | null> {
  const rows = await db.query<TimerRow>(
    `SELECT ${COLUMNS} FROM next_timers
     WHERE grant_id = $1 AND namespace = $2 AND timer_id = $3`,
    [grantId, namespace, timerId]
  );
  return rows.rows[0] ?? null;
}

function assertData(grant: TimerGrant, data: unknown): void {
  if (data !== null && !dataPermitted(grant)) {
    throw new TimerError(400, "invalid_request", "Timer data is accepted only for synced collections with a cloud copy.", {
      reason: "timer_data_not_permitted"
    });
  }
}

/**
 * Put one timer. Identical to the stored, non-cancelled timer: no change (a
 * fired timer is not re-armed). Otherwise a new generation, `scheduled`.
 */
export async function putTimer(
  db: DatabaseQueryable,
  grant: TimerGrant,
  namespace: string,
  criterionId: string,
  desired: DesiredTimer
): Promise<TimerView> {
  assertData(grant, desired.data);
  await advanceTimerIntent(db, grant.grantId, namespace);
  return putTimerRow(db, grant, namespace, criterionId, desired);
}

async function putTimerRow(
  db: DatabaseQueryable, grant: TimerGrant, namespace: string,
  criterionId: string, desired: DesiredTimer
): Promise<TimerView> {
  const existing = await selectTimer(db, grant.grantId, namespace, desired.id);
  const fireAt = desired.fireAt.toISOString();
  const data = desired.data === null ? null : JSON.stringify(desired.data);
  if (!existing) {
    const inserted = await db.query<TimerRow>(
      `INSERT INTO next_timers
         (grant_id, namespace, timer_id, criterion_id, fire_at, generation,
          status, data)
       VALUES ($1, $2, $3, $4, $5, 1, 'scheduled', $6::jsonb)
       RETURNING ${COLUMNS}`,
      [grant.grantId, namespace, desired.id, criterionId, fireAt, data]
    );
    return timerView(inserted.rows[0], dataPermitted(grant));
  }
  if (
    existing.status !== "cancelled"
    && instant(existing.fire_at) === fireAt
    && existing.criterion_id === criterionId
    && sameData(existing.data, desired.data)
  ) {
    return timerView(existing, dataPermitted(grant));
  }
  const generation = Number(existing.generation);
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("Invalid persisted timer generation.");
  if (generation === Number.MAX_SAFE_INTEGER) throw new TimerError(413, "too_large", "Timer generation exhausted.");
  const updated = await db.query<TimerRow>(
    `UPDATE next_timers
     SET criterion_id = $4, fire_at = $5, generation = $6, status = 'scheduled',
         data = $7::jsonb, fired_at = NULL, updated_at = now()
     WHERE grant_id = $1 AND namespace = $2 AND timer_id = $3
     RETURNING ${COLUMNS}`,
    [
      grant.grantId,
      namespace,
      desired.id,
      criterionId,
      fireAt,
      generation + 1,
      data
    ]
  );
  return timerView(updated.rows[0], dataPermitted(grant));
}

/** Cancel a scheduled or firing timer. `false` when there is nothing to cancel. */
export async function cancelTimer(
  db: DatabaseQueryable,
  grant: TimerGrant,
  namespace: string,
  timerId: string,
  generation?: number
): Promise<boolean> {
  await advanceTimerIntent(db, grant.grantId, namespace);
  const existing = await selectTimer(db, grant.grantId, namespace, timerId);
  if (!existing || !(ACTIVE_STATUSES as readonly string[]).includes(existing.status)) return false;
  if (generation !== undefined && Number(existing.generation) !== generation) return false;
  const updated = await db.query(
    `UPDATE next_timers SET status = 'cancelled', updated_at = now()
     WHERE grant_id = $1 AND namespace = $2 AND timer_id = $3
       AND generation = $4 AND status IN ('scheduled', 'firing')
     RETURNING timer_id`,
    [grant.grantId, namespace, timerId, Number(existing.generation)]
  );
  return updated.rows.length > 0;
}

/**
 * Replace the active set of (grant, namespace): put every desired timer, cancel
 * active timers absent from the set. Fired and cancelled timers are untouched.
 */
export async function reconcileTimers(
  db: DatabaseQueryable,
  grant: TimerGrant,
  namespace: string,
  criterionId: string,
  desired: DesiredTimer[]
): Promise<{ namespace: string; timers: TimerView[]; cancelled_ids: string[] }> {
  const ids = new Set<string>();
  for (const timer of desired) {
    if (ids.has(timer.id)) {
      throw new TimerError(400, "invalid_request", `Duplicate timer id ${timer.id}.`, {
        reason: "duplicate_timer_id"
      });
    }
    ids.add(timer.id);
    assertData(grant, timer.data);
  }
  await advanceTimerIntent(db, grant.grantId, namespace);
  const timers: TimerView[] = [];
  for (const timer of desired) {
    timers.push(await putTimerRow(db, grant, namespace, criterionId, timer));
  }
  const active = await db.query<{ timer_id: string }>(
    `SELECT timer_id FROM next_timers
     WHERE grant_id = $1 AND namespace = $2 AND status IN ('scheduled', 'firing')
     ORDER BY timer_id`,
    [grant.grantId, namespace]
  );
  const cancelled: string[] = [];
  for (const { timer_id } of active.rows) {
    if (ids.has(timer_id)) continue;
    await db.query(
      `UPDATE next_timers SET status = 'cancelled', updated_at = now()
       WHERE grant_id = $1 AND namespace = $2 AND timer_id = $3`,
      [grant.grantId, namespace, timer_id]
    );
    cancelled.push(timer_id);
  }
  return { namespace, timers, cancelled_ids: cancelled };
}

/** Throws `too_large` when a write left too many active timers. */
export async function enforceTimerQuota(
  db: DatabaseQueryable,
  grantId: string,
  namespace: string
): Promise<void> {
  const counts = await db.query<{ namespace: string; active: number | string }>(
    `SELECT namespace, count(*) AS active FROM next_timers
     WHERE grant_id = $1 AND status IN ('scheduled', 'firing')
     GROUP BY namespace`,
    [grantId]
  );
  let total = 0;
  for (const row of counts.rows) {
    const active = Number(row.active);
    total += active;
    if (row.namespace === namespace && active > MAX_ACTIVE_PER_NAMESPACE) {
      throw new TimerError(413, "too_large", "Too many active timers in this namespace.", {
        limit: MAX_ACTIVE_PER_NAMESPACE
      });
    }
  }
  if (total > MAX_ACTIVE_PER_GRANT) {
    throw new TimerError(413, "too_large", "Too many active timers for this grant.", {
      limit: MAX_ACTIVE_PER_GRANT
    });
  }
}

/** Cancel every active timer of grants that are revoked. Returns timers cancelled. */
export async function cancelRevokedGrantTimers(db: DatabaseQueryable): Promise<number> {
  const result = await db.query(
    `UPDATE next_timers SET status = 'cancelled', updated_at = now()
     WHERE status IN ('scheduled', 'firing')
       AND grant_id IN (SELECT id FROM grants WHERE revoked_at IS NOT NULL)
     RETURNING timer_id`
  );
  return result.rows.length;
}

/**
 * Erase stored `data` for a collection's grants. Called when a collection leaves
 * `cloud_copy` (control plane state change), so no readable timer data outlives it.
 */
export async function eraseTimerData(
  db: DatabaseQueryable,
  collectionId: string
): Promise<number> {
  // `collectionId` is the logical ID (next_collections), or an authority-row ID.
  const grants = `SELECT id FROM grants
    WHERE hosted_collection_id = $1 OR collection_id = $1
       OR collection_id IN (SELECT id FROM collections WHERE local_id = $1)`;
  const timers = await db.query(
    `UPDATE next_timers SET data = NULL, updated_at = now()
     WHERE data IS NOT NULL AND grant_id IN (${grants})
     RETURNING timer_id`,
    [collectionId]
  );
  await db.query(
    `UPDATE next_timer_events SET data = NULL
     WHERE data IS NOT NULL AND grant_id IN (${grants})`,
    [collectionId]
  );
  return timers.rows.length;
}

export interface ImportedTimer {
  grant_id: string;
  namespace: string;
  id: string;
  criterion_id: string;
  fire_at: string;
  data?: unknown;
}

/**
 * Cutover copy of active legacy timers. Idempotent: a timer that already exists
 * is left alone. Data is kept only for cloud-copy grants.
 */
export async function importTimer(
  db: DatabaseQueryable,
  grant: TimerGrant,
  timer: ImportedTimer
): Promise<boolean> {
  const data = dataPermitted(grant) && timer.data !== undefined && timer.data !== null
    ? JSON.stringify(timer.data)
    : null;
  await lockNamespace(db, grant.grantId, timer.namespace);
  if (await selectTimer(db, grant.grantId, timer.namespace, timer.id)) return false;
  await advanceTimerIntent(db, grant.grantId, timer.namespace);
  const inserted = await db.query(
    `INSERT INTO next_timers
       (grant_id, namespace, timer_id, criterion_id, fire_at, generation, status, data)
     VALUES ($1, $2, $3, $4, $5, 1, 'scheduled', $6::jsonb)
     ON CONFLICT (grant_id, namespace, timer_id) DO NOTHING
     RETURNING timer_id`,
    [grant.grantId, timer.namespace, timer.id, timer.criterion_id, new Date(timer.fire_at).toISOString(), data]
  );
  return inserted.rows.length > 0;
}
