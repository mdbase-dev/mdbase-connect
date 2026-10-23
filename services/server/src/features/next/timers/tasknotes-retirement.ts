import { createHash } from "node:crypto";
import type { DatabaseQueryable } from "../../../database-types.js";
import type { TimerGrant } from "./grants.js";
import { TimerError, type DesiredTimer } from "./model.js";
import { requireTimerMigrationEffects } from "./migration-effects.js";

const TASKNOTES_FAMILY = "bundle:dev.tasknotes.app";
// This TaskNotes-only policy spans manifest-specific registered UUIDs within
// one account and consented collection. Family is not publisher authentication.
const TASK_REMINDERS = "task-reminders";
const CRITERION = "task.reminder";

export async function taskReminderMembership(db: DatabaseQueryable, grant: TimerGrant, namespace: string, criterionId: string): Promise<boolean> {
  return namespace === TASK_REMINDERS && criterionId === CRITERION && Boolean(await scope(db,grant));
}

interface Scope { user_id: string; collection_id: string; principal_kind: "legacy" | "installation" }

/** The same transaction lock orders legacy writes, firing and transport
 * admission against the first native reconcile. Never lock another grant's
 * namespace: device-wide namespace locks would invert this ordering. */
async function scope(db: DatabaseQueryable, grant: TimerGrant): Promise<Scope | undefined> {
  const row = (await db.query<Scope>(
    `SELECT b.user_id,b.collection_id,b.principal_kind
     FROM next_background_grants b JOIN applications a ON a.id=b.application_id
     WHERE b.id=$1 AND b.principal_kind='installation' AND a.family_identity=$2
     UNION ALL
     SELECT g.user_id,COALESCE(c.local_id,g.hosted_collection_id,g.next_collection_id), 'legacy'
     FROM grants g JOIN applications a ON a.id=g.application_id LEFT JOIN collections c ON c.id=g.collection_id
     WHERE g.id=$1 AND a.family_identity=$2`, [grant.grantId,TASKNOTES_FAMILY])).rows[0];
  if (!row?.collection_id) return;
  const digest = createHash("sha256").update(`mdbase/tasknotes-retirement\0${row.user_id}\0${TASKNOTES_FAMILY}\0${row.collection_id}`).digest();
  await db.query("SELECT pg_advisory_xact_lock($1,$2)", [digest.readInt32BE(0),digest.readInt32BE(4)]);
  return row;
}

async function retired(db: DatabaseQueryable, row: Scope): Promise<boolean> {
  return (await db.query(`SELECT 1 FROM next_tasknotes_legacy_reminder_retirements
    WHERE user_id=$1 AND family_identity=$2 AND collection_id=$3`,
  [row.user_id,TASKNOTES_FAMILY,row.collection_id])).rows.length > 0;
}

/** False for native grants and every unrelated family/namespace/criterion. */
export async function legacyTaskReminderRetired(
  db: DatabaseQueryable, grant: TimerGrant, namespace: string, criterionId: string
): Promise<boolean> {
  if (namespace !== TASK_REMINDERS || criterionId !== CRITERION) return false;
  const row = await scope(db,grant);
  return !!row && row.principal_kind === "legacy" && await retired(db,row);
}

export async function requireTaskReminderWrite(db: DatabaseQueryable, grant: TimerGrant, namespace: string, criterionId: string): Promise<void> {
  if (await legacyTaskReminderRetired(db,grant,namespace,criterionId)) {
    throw new TimerError(409,"legacy_reminders_retired","TaskNotes reminders have moved to the native installation.");
  }
}

/** Caller owns the reconcile transaction. Only its first successful native
 * reconcile transfers history and fences ALL old devices in this exact tuple.
 * The hard-coded TaskNotes family spans versioned registration UUIDs. Only
 * legacy grants of this account, family and collection are retired; other
 * families and native grants retain their independent authority.
 * No native-to-native ownership or predecessor selection is implied. */
export async function retireLegacyTaskReminders(
  db: DatabaseQueryable, grant: TimerGrant, namespace: string, criterionId: string, desired: DesiredTimer[]
): Promise<void> {
  if (namespace !== TASK_REMINDERS || criterionId !== CRITERION) return;
  const row = await scope(db,grant);
  if (!row || row.principal_kind !== "installation") return;
  const values = [row.user_id,TASKNOTES_FAMILY,row.collection_id];
  const legacy = await db.query<{id:string}>(`SELECT g.id FROM grants g JOIN applications a ON a.id=g.application_id
    LEFT JOIN collections c ON c.id=g.collection_id
    WHERE g.user_id=$1 AND a.family_identity=$2
      AND COALESCE(c.local_id,g.hosted_collection_id,g.next_collection_id)=$3 ORDER BY g.id`,values);
  for (const old of legacy.rows) await requireTimerMigrationEffects(db,old.id);
  const inserted = await db.query(`INSERT INTO next_tasknotes_legacy_reminder_retirements(user_id,family_identity,collection_id)
    VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING user_id`,values);
  if (!inserted.rows.length) return;
  // Original imports retain their IDs and complete state on legacy grants.
  // TaskNotes IDs hash [task.id,reminder.id], not the grant. Match the desired
  // instant as well, so a changed reminder is not suppressed by old history.
  await db.query(
    `WITH originals AS (
       SELECT DISTINCT ON (t.timer_id) t.*
       FROM next_timers t JOIN grants g ON g.id=t.grant_id JOIN applications a ON a.id=g.application_id
       LEFT JOIN collections c ON c.id=g.collection_id
       WHERE g.user_id=$1 AND a.family_identity=$2
         AND COALESCE(c.local_id,g.hosted_collection_id,g.next_collection_id)=$3
         AND t.namespace='task-reminders' AND t.criterion_id='task.reminder'
         AND t.status IN ('scheduled','firing','fired')
         AND (t.timer_id,t.fire_at) IN (SELECT id,fire_at FROM jsonb_to_recordset($5::jsonb) AS d(id text,fire_at timestamptz))
       ORDER BY t.timer_id,(t.status='fired') DESC,t.updated_at DESC,t.grant_id
     )
     INSERT INTO next_timers(grant_id,namespace,timer_id,criterion_id,fire_at,generation,status,data,created_at,updated_at,fired_at)
     SELECT $4,namespace,timer_id,criterion_id,fire_at,generation,
       CASE WHEN status='firing' THEN 'scheduled' ELSE status END,NULL,created_at,updated_at,fired_at FROM originals
     ON CONFLICT (grant_id,namespace,timer_id) DO UPDATE
       SET status='fired',fired_at=EXCLUDED.fired_at,updated_at=EXCLUDED.updated_at
       WHERE next_timers.fire_at=EXCLUDED.fire_at AND EXCLUDED.status='fired'`,
    [...values,grant.grantId,JSON.stringify(desired.map(timer=>({id:timer.id,fire_at:timer.fireAt.toISOString()})))]);
  await db.query(`UPDATE next_timers t SET status='cancelled',updated_at=now()
    FROM grants g JOIN applications a ON a.id=g.application_id LEFT JOIN collections c ON c.id=g.collection_id
    WHERE t.grant_id=g.id AND g.user_id=$1 AND a.family_identity=$2
      AND COALESCE(c.local_id,g.hosted_collection_id,g.next_collection_id)=$3
      AND t.namespace='task-reminders' AND t.criterion_id='task.reminder'
      AND t.status IN ('scheduled','firing')`,values);
  // Signals (including original runtime signals) have a criterion but no
  // durable namespace. Fence this legacy criterion even after event pruning;
  // do not infer provenance from the optional retained NEXT event.
  for (const table of ["notification_deliveries","notification_webhook_deliveries"]) {
    await db.query(`UPDATE ${table} d SET status='discarded',lease_token=NULL,leased_until=NULL,
        last_error='legacy_reminders_retired'
      FROM notification_signals s JOIN grants g ON g.id=s.grant_id
      JOIN applications a ON a.id=g.application_id LEFT JOIN collections c ON c.id=g.collection_id
      WHERE d.signal_id=s.id AND g.user_id=$1 AND a.family_identity=$2
        AND COALESCE(c.local_id,g.hosted_collection_id,g.next_collection_id)=$3
        AND s.criterion_id='task.reminder'
        AND d.status IN ('pending','retry','sending')`,values);
  }
}
