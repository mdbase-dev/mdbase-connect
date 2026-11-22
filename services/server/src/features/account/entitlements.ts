import { randomUUID } from "node:crypto";
import type { DatabasePool, DatabaseQueryable } from "../../database-types.js";

export const BETA_ENTITLEMENT_PROFILE = "beta_v1";
/** Held permanently by accounts that signed up during the open beta; no longer granted. */
export const OPEN_BETA_ENTITLEMENT_PROFILE = "open_beta_v1";
/** The free plan every account holds once backfilled (pricing §6). */
export const FREE_ENTITLEMENT_PROFILE = "free_v1";
/** The storage-only trial a public signup holds for its first month. */
export const TRIAL_ENTITLEMENT_PROFILE = "trial_v1";
const TRIAL_DURATION = "30 days";

export interface EffectiveEntitlement {
  profileCodes: string[];
  hostedStorageBytes: number;
  retainedFileBytes: number;
  maxDocumentBytes: number;
  maxSingleFileBytes: number;
  maxMirrorReplicasPerCollection: number;
  maxApplicationReplicasPerCollection: number;
  maxHostedCollections: number;
  maxFilesPerCollection: number;
  maxCollectionMemberSeats: number;
  /** An active trial that raises hosted storage above the account's other grants. */
  trial: null | {
    endsAt: Date;
    /** Hosted storage once the trial ends: the maximum across the other grants. */
    hostedStorageBytesAfter: number;
  };
}

export class HostedEntitlementRequiredError extends Error {
  constructor() {
    super("This account does not have hosted storage access.");
    this.name = "HostedEntitlementRequiredError";
  }
}

interface EntitlementProfileRow {
  profile_code: string;
  ends_at: Date | null;
  hosted_storage_bytes: string | number;
  retained_file_bytes: string | number;
  max_document_bytes: string | number;
  max_single_file_bytes: string | number;
  max_mirror_replicas_per_collection: string | number;
  max_application_replicas_per_collection: string | number;
  max_hosted_collections: string | number;
  max_files_per_collection: string | number;
  max_collection_member_seats: string | number;
}

export async function attachInvitationEntitlement(
  db: DatabaseQueryable,
  invitationId: string,
  profileCode: string
): Promise<void> {
  const attached = await db.query(
    `INSERT INTO invitation_entitlements (invitation_id, profile_code)
     SELECT $1, profile.code
     FROM entitlement_profiles profile
     WHERE profile.code = $2
     ON CONFLICT (invitation_id) DO UPDATE SET
       profile_code = EXCLUDED.profile_code
     RETURNING invitation_id`,
    [invitationId, profileCode]
  );
  if (!attached.rows[0]) {
    throw new TypeError(`Unknown entitlement profile: ${profileCode}`);
  }
}

export async function materializeInvitationEntitlement(
  db: DatabaseQueryable,
  userId: string,
  invitationId: string,
  profileCode: string | null
): Promise<{ providerAccountId: string; entitlementRevision: number } | null> {
  if (!profileCode) return null;
  await db.query(
    `INSERT INTO account_entitlement_grants
       (id, user_id, profile_code, source, source_invitation_id)
     VALUES ($1, $2, $3, 'invitation', $4)
     ON CONFLICT DO NOTHING`,
    [randomUUID(), userId, profileCode, invitationId]
  );
  const providerAccountId = randomUUID();
  const account = await db.query<{
    provider_account_id: string;
    entitlement_revision: string | number;
  }>(
    `INSERT INTO account_storage_accounts
       (user_id, provider_account_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET
       updated_at = account_storage_accounts.updated_at
     RETURNING provider_account_id, entitlement_revision`,
    [userId, providerAccountId]
  );
  await db.query(
    `INSERT INTO account_email_preferences (user_id)
     VALUES ($1)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );
  return {
    providerAccountId: account.rows[0]!.provider_account_id,
    entitlementRevision: safeNumber(
      account.rows[0]!.entitlement_revision,
      "entitlement revision"
    )
  };
}

/**
 * Grants a just-created public-signup account the permanent free plan and its
 * first-month storage trial. Runs in the account-creation transaction, so the
 * account holds no grants yet.
 */
export async function materializePublicSignupEntitlement(
  db: DatabaseQueryable,
  userId: string
): Promise<{
  providerAccountId: string;
  entitlementRevision: number;
  trialEndsAt: Date;
}> {
  await db.query(
    `INSERT INTO account_entitlement_grants
       (id, user_id, profile_code, source, source_reference)
     VALUES ($1, $2, $3, 'subscription', 'public_signup_v2')`,
    [randomUUID(), userId, FREE_ENTITLEMENT_PROFILE]
  );
  const trial = await db.query<{ ends_at: Date }>(
    `INSERT INTO account_entitlement_grants
       (id, user_id, profile_code, source, source_reference, ends_at)
     VALUES ($1, $2, $3, 'subscription', 'public_signup_trial_v1',
             now() + $4::interval)
     RETURNING ends_at`,
    [randomUUID(), userId, TRIAL_ENTITLEMENT_PROFILE, TRIAL_DURATION]
  );
  const account = await db.query<{
    provider_account_id: string;
    entitlement_revision: string | number;
  }>(
    `INSERT INTO account_storage_accounts
       (user_id, provider_account_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET
       updated_at = account_storage_accounts.updated_at
     RETURNING provider_account_id, entitlement_revision`,
    [userId, randomUUID()]
  );
  await db.query(
    `INSERT INTO account_email_preferences (user_id)
     VALUES ($1)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );
  return {
    providerAccountId: account.rows[0]!.provider_account_id,
    entitlementRevision: safeNumber(
      account.rows[0]!.entitlement_revision,
      "entitlement revision"
    ),
    trialEndsAt: trial.rows[0]!.ends_at
  };
}

export async function ensureDevelopmentEntitlement(
  db: DatabaseQueryable,
  userId: string
): Promise<void> {
  await db.query(
    `INSERT INTO account_entitlement_grants
       (id, user_id, profile_code, source, source_reference)
     VALUES ($1, $2, $3, 'operator', 'development_auth')
     ON CONFLICT DO NOTHING`,
    [randomUUID(), userId, BETA_ENTITLEMENT_PROFILE]
  );
  await db.query(
    `INSERT INTO account_storage_accounts (user_id, provider_account_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId, randomUUID()]
  );
  await db.query(
    `INSERT INTO account_email_preferences (user_id)
     VALUES ($1)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );
}

export async function effectiveEntitlement(
  db: DatabaseQueryable,
  userId: string
): Promise<EffectiveEntitlement | null> {
  const profiles = await db.query<EntitlementProfileRow>(
    `SELECT entitlement_grant.profile_code, entitlement_grant.ends_at,
            profile.hosted_storage_bytes, profile.retained_file_bytes,
            profile.max_document_bytes, profile.max_single_file_bytes,
            profile.max_mirror_replicas_per_collection,
            profile.max_application_replicas_per_collection,
            profile.max_hosted_collections,
            profile.max_files_per_collection,
            profile.max_collection_member_seats
     FROM account_entitlement_grants entitlement_grant
     JOIN entitlement_profiles profile
       ON profile.code = entitlement_grant.profile_code
     WHERE entitlement_grant.user_id = $1
       AND entitlement_grant.revoked_at IS NULL
       AND entitlement_grant.starts_at <= now()
       AND (entitlement_grant.ends_at IS NULL
            OR entitlement_grant.ends_at > now())
     ORDER BY entitlement_grant.profile_code`,
    [userId]
  );
  if (profiles.rows.length === 0) return null;
  return {
    profileCodes: profiles.rows.map((profile) => profile.profile_code),
    hostedStorageBytes: maximum(profiles.rows, "hosted_storage_bytes"),
    retainedFileBytes: maximum(profiles.rows, "retained_file_bytes"),
    maxDocumentBytes: maximum(profiles.rows, "max_document_bytes"),
    maxSingleFileBytes: maximum(profiles.rows, "max_single_file_bytes"),
    maxMirrorReplicasPerCollection: maximum(
      profiles.rows,
      "max_mirror_replicas_per_collection"
    ),
    maxApplicationReplicasPerCollection: maximum(
      profiles.rows,
      "max_application_replicas_per_collection"
    ),
    maxHostedCollections: maximum(profiles.rows, "max_hosted_collections"),
    maxFilesPerCollection: maximum(profiles.rows, "max_files_per_collection"),
    maxCollectionMemberSeats: maximum(
      profiles.rows,
      "max_collection_member_seats"
    ),
    trial: activeTrial(profiles.rows)
  };
}

function activeTrial(rows: EntitlementProfileRow[]): EffectiveEntitlement["trial"] {
  const trials = rows.filter((row) => row.profile_code === TRIAL_ENTITLEMENT_PROFILE);
  if (trials.length === 0) return null;
  const others = rows.filter((row) => row.profile_code !== TRIAL_ENTITLEMENT_PROFILE);
  const hostedStorageBytesAfter = others.length === 0
    ? 0
    : maximum(others, "hosted_storage_bytes");
  // An operator can grant the trial profile without an end; that storage never drops.
  if (
    maximum(trials, "hosted_storage_bytes") <= hostedStorageBytesAfter
    || trials.some((row) => row.ends_at === null)
  ) return null;
  const endsAt = Math.max(...trials.map((row) => new Date(row.ends_at!).getTime()));
  return { endsAt: new Date(endsAt), hostedStorageBytesAfter };
}

export async function grantOperatorEntitlement(
  db: DatabasePool,
  input: {
    userId: string;
    profileCode: string;
    actor: string;
    reason: string;
    operationId: string;
  }
): Promise<{ changed: boolean; entitlementRevision: number }> {
  const connection = await db.connect();
  try {
    await connection.query("BEGIN");
    const user = await connection.query(
      "SELECT id FROM users WHERE id = $1 FOR UPDATE",
      [input.userId]
    );
    if (!user.rows[0]) throw new HostedEntitlementRequiredError();
    const profile = await connection.query(
      "SELECT code FROM entitlement_profiles WHERE code = $1",
      [input.profileCode]
    );
    if (!profile.rows[0]) {
      throw new TypeError(`Unknown entitlement profile: ${input.profileCode}`);
    }
    const active = await connection.query(
      `SELECT id FROM account_entitlement_grants
       WHERE user_id = $1 AND profile_code = $2
         AND revoked_at IS NULL AND starts_at <= now()
         AND (ends_at IS NULL OR ends_at > now())
       LIMIT 1`,
      [input.userId, input.profileCode]
    );
    let changed = false;
    if (!active.rows[0]) {
      const inserted = await connection.query(
        `INSERT INTO account_entitlement_grants
           (id, user_id, profile_code, source, source_reference)
         VALUES ($1, $2, $3, 'operator', $4)
         ON CONFLICT DO NOTHING RETURNING id`,
        [randomUUID(), input.userId, input.profileCode, input.operationId]
      );
      changed = Boolean(inserted.rows[0]);
    }
    const entitlementRevision = await recordEntitlementChange(
      connection,
      input.userId,
      changed
    );
    await connection.query(
      `INSERT INTO account_email_preferences (user_id)
       VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
      [input.userId]
    );
    await connection.query(
      `INSERT INTO audit_events
         (id, user_id, event_type, subject_id, metadata)
       VALUES ($1, $2, 'entitlement.granted', $4, $3::jsonb)`,
      [
        randomUUID(),
        input.userId,
        JSON.stringify({
          profile: input.profileCode,
          actor: input.actor,
          reason: input.reason,
          operation_id: input.operationId,
          changed,
          entitlement_revision: entitlementRevision
        }),
        input.userId
      ]
    );
    await connection.query("COMMIT");
    return { changed, entitlementRevision };
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Moves an account's entitlement revision past a grant change, so the hosted
 * provider reconciles the new limits, and returns the revision. An account without
 * a storage account gets one at revision 1. The caller holds the account's users
 * row lock.
 */
export async function recordEntitlementChange(
  connection: DatabaseQueryable,
  userId: string,
  changed: boolean
): Promise<number> {
  const existing = await connection.query<{
    entitlement_revision: string | number;
  }>(
    `SELECT entitlement_revision FROM account_storage_accounts
     WHERE user_id = $1 FOR UPDATE`,
    [userId]
  );
  if (!existing.rows[0]) {
    await connection.query(
      `INSERT INTO account_storage_accounts (user_id, provider_account_id)
       VALUES ($1, $2)`,
      [userId, randomUUID()]
    );
    return 1;
  }
  const revision = safeNumber(existing.rows[0].entitlement_revision, "entitlement revision");
  if (!changed) return revision;
  await connection.query(
    `UPDATE account_storage_accounts SET
       entitlement_revision = $2, updated_at = now()
     WHERE user_id = $1`,
    [userId, revision + 1]
  );
  return revision + 1;
}

function maximum(
  rows: EntitlementProfileRow[],
  key: Exclude<keyof EntitlementProfileRow, "profile_code" | "ends_at">
): number {
  return Math.max(...rows.map((row) => safeNumber(row[key], key)));
}

function safeNumber(value: string | number, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`Stored ${label} is invalid.`);
  }
  return number;
}
