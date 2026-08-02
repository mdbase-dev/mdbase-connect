import { randomUUID } from "node:crypto";
import type { DatabasePool, DatabaseQueryable } from "./database-types.js";
import type {
  HostedAccountLimits,
  HostedAccountUsage,
  HostedProviderClient
} from "./hosted-provider.js";

export const BETA_ENTITLEMENT_PROFILE = "beta_v1";

export interface EffectiveEntitlement {
  profileCodes: string[];
  hostedStorageBytes: number;
  retainedFileBytes: number;
  maxDocumentBytes: number;
  maxSingleFileBytes: number;
  maxReplicasPerCollection: number;
  maxHostedCollections: number;
  maxFilesPerCollection: number;
}

export class HostedEntitlementRequiredError extends Error {
  constructor() {
    super("This account does not have hosted storage access.");
    this.name = "HostedEntitlementRequiredError";
  }
}

export interface ReconciledHostedAccount {
  providerAccountId: string;
  entitlementRevision: number;
  entitlement: EffectiveEntitlement;
  usage: HostedAccountUsage;
}

interface EntitlementProfileRow {
  profile_code: string;
  hosted_storage_bytes: string | number;
  retained_file_bytes: string | number;
  max_document_bytes: string | number;
  max_single_file_bytes: string | number;
  max_replicas_per_collection: string | number;
  max_hosted_collections: string | number;
  max_files_per_collection: string | number;
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
    `SELECT entitlement_grant.profile_code,
            profile.hosted_storage_bytes, profile.retained_file_bytes,
            profile.max_document_bytes, profile.max_single_file_bytes,
            profile.max_replicas_per_collection, profile.max_hosted_collections,
            profile.max_files_per_collection
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
    maxReplicasPerCollection: maximum(
      profiles.rows,
      "max_replicas_per_collection"
    ),
    maxHostedCollections: maximum(profiles.rows, "max_hosted_collections"),
    maxFilesPerCollection: maximum(profiles.rows, "max_files_per_collection")
  };
}

export async function reconcileHostedAccount(
  db: DatabaseQueryable,
  provider: HostedProviderClient,
  userId: string
): Promise<ReconciledHostedAccount> {
  const entitlement = await effectiveEntitlement(db, userId);
  if (!entitlement) throw new HostedEntitlementRequiredError();
  const account = await db.query<{
    provider_account_id: string;
    entitlement_revision: string | number;
  }>(
    `SELECT provider_account_id, entitlement_revision
     FROM account_storage_accounts WHERE user_id = $1`,
    [userId]
  );
  const row = account.rows[0];
  if (!row) throw new HostedEntitlementRequiredError();
  const entitlementRevision = safeNumber(
    row.entitlement_revision,
    "entitlement revision"
  );
  const limits: HostedAccountLimits = {
    hosted_storage_bytes: entitlement.hostedStorageBytes,
    retained_file_bytes: entitlement.retainedFileBytes,
    max_document_bytes: entitlement.maxDocumentBytes,
    max_single_file_bytes: entitlement.maxSingleFileBytes,
    max_replicas_per_collection: entitlement.maxReplicasPerCollection,
    max_hosted_collections: entitlement.maxHostedCollections,
    max_files_per_collection: entitlement.maxFilesPerCollection
  };
  const usage = await provider.upsertAccount(
    row.provider_account_id,
    entitlementRevision,
    limits
  );
  await db.query(
    `UPDATE account_storage_accounts SET provider_revision = $2,
            updated_at = now()
     WHERE user_id = $1 AND entitlement_revision = $2`,
    [userId, entitlementRevision]
  );
  return {
    providerAccountId: row.provider_account_id,
    entitlementRevision,
    entitlement,
    usage
  };
}

export async function reconcileHostedAccountCollections(
  db: DatabaseQueryable,
  provider: HostedProviderClient,
  userId: string
): Promise<ReconciledHostedAccount & { reconciledCollections: number }> {
  const account = await reconcileHostedAccount(db, provider, userId);
  const collections = await db.query<{ id: string }>(
    `SELECT id FROM hosted_collections
     WHERE user_id = $1
       AND authority_state IN ('importing', 'active', 'transferring')
     ORDER BY id`,
    [userId]
  );
  let reconciledCollections = 0;
  for (const collection of collections.rows) {
    await provider.reconcileCollectionAccount(
      account.providerAccountId,
      collection.id
    );
    reconciledCollections += 1;
  }
  const usage = await provider.accountUsage(account.providerAccountId);
  return { ...account, usage, reconciledCollections };
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
    const existingAccount = await connection.query<{
      entitlement_revision: string | number;
    }>(
      `SELECT entitlement_revision FROM account_storage_accounts
       WHERE user_id = $1 FOR UPDATE`,
      [input.userId]
    );
    let entitlementRevision = existingAccount.rows[0]
      ? safeNumber(
          existingAccount.rows[0].entitlement_revision,
          "entitlement revision"
        )
      : 1;
    if (!existingAccount.rows[0]) {
      await connection.query(
        `INSERT INTO account_storage_accounts (user_id, provider_account_id)
         VALUES ($1, $2)`,
        [input.userId, randomUUID()]
      );
    } else if (changed) {
      entitlementRevision += 1;
      await connection.query(
        `UPDATE account_storage_accounts SET
           entitlement_revision = $2, updated_at = now()
         WHERE user_id = $1`,
        [input.userId, entitlementRevision]
      );
    }
    await connection.query(
      `INSERT INTO account_email_preferences (user_id)
       VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
      [input.userId]
    );
    await connection.query(
      `INSERT INTO audit_events
         (id, user_id, event_type, subject_id, metadata)
       VALUES ($1, $2, 'entitlement.granted', $2, $3::jsonb)`,
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
        })
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

function maximum(
  rows: EntitlementProfileRow[],
  key: Exclude<keyof EntitlementProfileRow, "profile_code">
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
