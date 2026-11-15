import { randomUUID } from "node:crypto";
import type { DatabasePool } from "../../db.js";
import {
  BETA_ENTITLEMENT_PROFILE,
  OPEN_BETA_ENTITLEMENT_PROFILE
} from "../account/entitlements.js";
import {
  PLUS_AND_APPS_BETA_MESSAGE_KIND,
  PLUS_AND_APPS_MESSAGE_KIND,
  PLUS_AND_APPS_TEMPLATE_VERSION
} from "../email/beta-welcome-email.js";
import { scheduleEmail } from "../email/scheduled-email.js";
import type { OperatorMutation } from "../../instance-admin.js";

interface Recipient {
  user_id: string;
  email_identity_id: string;
  beta: boolean;
  scheduled: boolean;
}

export interface AnnouncementCounts {
  /** Accounts that would receive it (or did) and were not queued before. */
  standard: number;
  beta: number;
  already_scheduled: number;
}

/**
 * Lists the accounts the Plus and apps announcement goes to: unsuspended, with
 * a verified primary address. The worker checks suspension, the announcements
 * preference and suppression again when each message is due. `userId` narrows
 * it to one account, for a test send.
 */
async function recipients(db: DatabasePool, userId: string | null): Promise<Recipient[]> {
  const accounts = await db.query<{ user_id: string; email_identity_id: string }>(
    `SELECT account.id AS user_id, identity.id AS email_identity_id
     FROM users account
     JOIN email_identities identity
       ON identity.user_id = account.id AND identity.is_primary
          AND identity.retired_at IS NULL AND identity.verified_at IS NOT NULL
     WHERE account.suspended_at IS NULL${userId ? " AND account.id = $1" : ""}
     ORDER BY account.id`,
    userId ? [userId] : []
  );
  const beta = await db.query<{ user_id: string }>(
    `SELECT DISTINCT user_id FROM account_entitlement_grants
     WHERE profile_code IN ($1, $2) AND revoked_at IS NULL
       AND (ends_at IS NULL OR ends_at > now())`,
    [BETA_ENTITLEMENT_PROFILE, OPEN_BETA_ENTITLEMENT_PROFILE]
  );
  const scheduled = await db.query<{ user_id: string }>(
    "SELECT user_id FROM email_jobs WHERE message_kind IN ($1, $2)",
    [PLUS_AND_APPS_MESSAGE_KIND, PLUS_AND_APPS_BETA_MESSAGE_KIND]
  );
  const betaIds = new Set(beta.rows.map((row) => row.user_id));
  const scheduledIds = new Set(scheduled.rows.map((row) => row.user_id));
  return accounts.rows.map((row) => ({
    ...row,
    beta: betaIds.has(row.user_id),
    scheduled: scheduledIds.has(row.user_id)
  }));
}

function deduplicationPrefix(): string {
  return `${PLUS_AND_APPS_MESSAGE_KIND}:`;
}

function count(rows: Recipient[]): AnnouncementCounts {
  const fresh = rows.filter((row) => !row.scheduled);
  return {
    standard: fresh.filter((row) => !row.beta).length,
    beta: fresh.filter((row) => row.beta).length,
    already_scheduled: rows.length - fresh.length
  };
}

export async function previewPlusAndAppsAnnouncement(
  db: DatabasePool,
  userId: string | null
): Promise<AnnouncementCounts> {
  return count(await recipients(db, userId));
}

/**
 * Queues the announcement for each recipient, due now. Both variants share one
 * deduplication key per account, so a rerun queues only accounts added since.
 */
export async function schedulePlusAndAppsAnnouncement(
  db: DatabasePool,
  userId: string | null,
  mutation: OperatorMutation
): Promise<AnnouncementCounts & { operation_id: string }> {
  const rows = await recipients(db, userId);
  const scheduledFor = new Date();
  for (const row of rows) {
    if (row.scheduled) continue;
    const queued = await scheduleEmail(db, {
      userId: row.user_id,
      emailIdentityId: row.email_identity_id,
      messageKind: row.beta ? PLUS_AND_APPS_BETA_MESSAGE_KIND : PLUS_AND_APPS_MESSAGE_KIND,
      templateVersion: PLUS_AND_APPS_TEMPLATE_VERSION,
      category: "onboarding",
      deduplicationKey: deduplicationPrefix() + row.user_id,
      scheduledFor
    });
    // A concurrent run queued it between the listing and this insert.
    if (queued.duplicate) row.scheduled = true;
  }
  const counts = count(rows);
  await db.query(
    `INSERT INTO audit_events (id, user_id, event_type, subject_id, metadata)
     VALUES ($1, $2, 'email.announcement_scheduled', $3, $4::jsonb)`,
    [
      randomUUID(),
      userId,
      PLUS_AND_APPS_MESSAGE_KIND,
      JSON.stringify({
        actor: mutation.actor,
        reason: mutation.reason,
        operation_id: mutation.operationId,
        template_version: PLUS_AND_APPS_TEMPLATE_VERSION,
        ...counts
      })
    ]
  );
  return { operation_id: mutation.operationId, ...counts };
}
