import type { CollectionContractDescriptor } from "@mdbase-dev/connect-protocol";
import type { DatabaseQueryable } from "./db.js";
import type { HostedTemplate } from "./hosted.js";
import { decodeStoredMembershipPolicy, resolveActiveMembershipPolicy, type CollectionRole } from "./collection-policy.js";
import { projectNextMigrationFreeze, type NextMigrationFreezeRow } from "./features/next/migration-topology.js";
import { RequestValidationError } from "./platform/http-errors.js";

export type CollectionAuthorityKind = "local" | "hosted" | "native";

export interface CollectionLocator {
  collectionId: string;
  authorityKind: CollectionAuthorityKind;
  authorityRowId: string;
  ownerUserId: string;
  authorityEpoch: number;
  authorityState: string;
  displayName: string;
  connectorId?: string;
  providerUrl?: string;
}

export interface HostedCollectionCatalogEntry {
  locator: CollectionLocator & {
    authorityKind: "hosted";
  };
  template: HostedTemplate;
  contracts: CollectionContractDescriptor[];
  transferredCollectionId: string | null;
  createdAt: string | Date;
}

export async function resolveHostedCollection(
  db: DatabaseQueryable,
  collectionId: string
): Promise<HostedCollectionCatalogEntry | null> {
  const result = await db.query<{
    id: string;
    user_id: string;
    display_name: string;
    template: HostedTemplate;
    provider_url: string | null;
    contracts: CollectionContractDescriptor[];
    authority_state: string;
    authority_epoch: string | number;
    transferred_collection_id: string | null;
    created_at: string | Date;
  }>(
    `SELECT id, user_id, display_name, template, provider_url, contracts,
            authority_state, authority_epoch, transferred_collection_id,
            created_at
     FROM hosted_collections
     WHERE id = $1 AND quarantined_at IS NULL`,
    [collectionId]
  );
  return result.rows[0] ? hostedEntry(result.rows[0]) : null;
}

export async function listHostedCollectionsVisibleToUser(
  db: DatabaseQueryable,
  userId: string
): Promise<HostedCollectionCatalogEntry[]> {
  const result = await db.query<{
    id: string;
    user_id: string;
    display_name: string;
    template: HostedTemplate;
    provider_url: string | null;
    contracts: CollectionContractDescriptor[];
    authority_state: string;
    authority_epoch: string | number;
    transferred_collection_id: string | null;
    created_at: string | Date;
  }>(
    `SELECT hosted.id, hosted.user_id, hosted.display_name, hosted.template,
            hosted.provider_url, hosted.contracts, hosted.authority_state,
            hosted.authority_epoch, hosted.transferred_collection_id,
            hosted.created_at
     FROM hosted_collections hosted
     LEFT JOIN next_collections native
       ON native.collection_id = hosted.id AND native.runtime = 'next'
     LEFT JOIN collection_memberships membership
       ON membership.collection_id = hosted.id
      AND membership.user_id = $1
      AND membership.state = 'active'
      AND membership.revoked_at IS NULL
     LEFT JOIN collection_membership_policies policy
       ON policy.id = membership.current_policy_id
      AND policy.membership_id = membership.id
      AND policy.revision = membership.current_policy_revision
     WHERE hosted.quarantined_at IS NULL AND native.collection_id IS NULL
       AND (hosted.user_id = $1
        OR (hosted.authority_state = 'active' AND policy.id IS NOT NULL))
     ORDER BY hosted.display_name`,
    [userId]
  );
  const visible = await Promise.all(result.rows.map(async (row) => {
    if (row.user_id === userId) return row;
    const policy = await resolveActiveMembershipPolicy(db, {
      collectionId: row.id,
      ownerUserId: row.user_id,
      userId
    });
    return policy ? row : null;
  }));
  return visible.flatMap((row) => row ? [hostedEntry(row)] : []);
}

export async function resolveLocalCollection(
  db: DatabaseQueryable,
  authorityRowId: string
): Promise<CollectionLocator | null> {
  const result = await db.query<{
    id: string;
    local_id: string;
    user_id: string;
    connector_id: string;
    display_name: string;
    authority_state: string;
    authority_epoch: string | number;
  }>(
    `SELECT id, local_id, user_id, connector_id, display_name,
            authority_state, authority_epoch
     FROM collections
     WHERE id = $1`,
    [authorityRowId]
  );
  const row = result.rows[0];
  return row
    ? {
        collectionId: row.local_id,
        authorityKind: "local",
        authorityRowId: row.id,
        ownerUserId: row.user_id,
        authorityEpoch: Number(row.authority_epoch),
        authorityState: row.authority_state,
        displayName: row.display_name,
        connectorId: row.connector_id
      }
    : null;
}

/**
 * Owner-only today. Future membership expands this repository query; callers
 * already consume logical catalog visibility instead of connector ownership.
 */
export async function listLocalCollectionsVisibleToUser(
  db: DatabaseQueryable,
  userId: string
): Promise<CollectionLocator[]> {
  const result = await db.query<{
    id: string;
    local_id: string;
    user_id: string;
    connector_id: string;
    display_name: string;
    authority_state: string;
    authority_epoch: string | number;
  }>(
    `SELECT col.id, col.local_id, col.user_id, col.connector_id, col.display_name,
            col.authority_state, col.authority_epoch
     FROM collections col
     LEFT JOIN next_collections native
       ON native.collection_id = col.local_id AND native.runtime = 'next'
     WHERE col.user_id = $1 AND native.collection_id IS NULL
     ORDER BY col.display_name`,
    [userId]
  );
  return result.rows.map((row) => ({
    collectionId: row.local_id,
    authorityKind: "local",
    authorityRowId: row.id,
    ownerUserId: row.user_id,
    authorityEpoch: Number(row.authority_epoch),
    authorityState: row.authority_state,
    displayName: row.display_name,
    connectorId: row.connector_id
  }));
}

interface NativeCollectionCatalogEntry {
  id: string;
  display_name: string | null;
  sync: "private" | "cloud_copy";
  access: {
    relationship: "owner" | "member";
    role: CollectionRole;
    can_manage_members: boolean;
  };
}

/** Account management metadata, not device enrollment or a content grant. */
export async function listNativeCollectionsVisibleToUser(
  db: DatabaseQueryable,
  userId: string
): Promise<NativeCollectionCatalogEntry[]> {
  const result = await db.query<{
    collection_id: string; owner_user_id: string; display_name: string | null;
    sync: "private" | "cloud_copy"; owner_frozen: boolean; viewer_frozen: boolean;
    owner_account_backend: string; owner_started_at: Date | null; owner_terminal_excluded_at: Date | null;
    owner_completed_at: Date | null; owner_completed_revision: string | null; owner_flipped_at: Date | null;
    viewer_account_backend: string; viewer_started_at: Date | null; viewer_terminal_excluded_at: Date | null;
    viewer_completed_at: Date | null; viewer_completed_revision: string | null; viewer_flipped_at: Date | null;
  } & Record<string, unknown>>(
    `SELECT native.collection_id, native.owner_user_id, native.display_name, native.sync,
       policy.id AS policy_id,membership.id AS membership_id,membership.user_id,
       identity.owner_user_id AS policy_owner_user_id,policy.revision,policy.role,policy.preset_version,
       policy.actions,policy.operations,policy.scope_ceiling,policy.file_ceiling,
       owner_cohort.frozen_at IS NOT NULL AS owner_frozen,owner.account_backend AS owner_account_backend,
       owner_member.started_at AS owner_started_at,owner_member.terminal_excluded_at AS owner_terminal_excluded_at,
       owner_cohort.completed_at AS owner_completed_at,owner_cohort.completed_revision::text AS owner_completed_revision,
       owner_flip.flipped_at AS owner_flipped_at,
       viewer_cohort.frozen_at IS NOT NULL AS viewer_frozen,viewer.account_backend AS viewer_account_backend,
       viewer_member.started_at AS viewer_started_at,viewer_member.terminal_excluded_at AS viewer_terminal_excluded_at,
       viewer_cohort.completed_at AS viewer_completed_at,viewer_cohort.completed_revision::text AS viewer_completed_revision,
       viewer_flip.flipped_at AS viewer_flipped_at
     FROM next_collections native
     JOIN users owner ON owner.id=native.owner_user_id AND owner.suspended_at IS NULL
     LEFT JOIN next_migration_cohort_members owner_member ON owner_member.account_id=owner.id
     LEFT JOIN next_migration_cohorts owner_cohort ON owner_cohort.name=owner_member.cohort
     LEFT JOIN next_migration_account_flips owner_flip ON owner_flip.account_id=owner.id
     LEFT JOIN users viewer ON viewer.id=$1
     LEFT JOIN next_migration_cohort_members viewer_member ON viewer_member.account_id=viewer.id
     LEFT JOIN next_migration_cohorts viewer_cohort ON viewer_cohort.name=viewer_member.cohort
     LEFT JOIN next_migration_account_flips viewer_flip ON viewer_flip.account_id=viewer.id
     LEFT JOIN collection_identities identity ON identity.id=native.collection_id
     LEFT JOIN next_collection_deletion_facts deleted ON deleted.collection_id=native.collection_id
     LEFT JOIN collection_memberships membership
       ON membership.collection_id = native.collection_id AND membership.user_id = $1
      AND membership.state = 'active' AND membership.revoked_at IS NULL
     LEFT JOIN collection_membership_policies policy
       ON policy.id = membership.current_policy_id AND policy.membership_id = membership.id
      AND policy.revision = membership.current_policy_revision
     WHERE native.runtime = 'next' AND native.left_sync_at IS NULL
       AND native.sync IN ('private', 'cloud_copy')
       AND deleted.collection_id IS NULL
       AND (native.owner_user_id = $1 OR policy.id IS NOT NULL)
     ORDER BY native.collection_id LIMIT 1001`,
    [userId]
  );
  // Never silently truncate All collections: direct entry must not mistake a
  // bounded prefix for an absent collection.
  if (result.rows.length > 1000) throw new RequestValidationError("The collection inventory exceeds the management limit.", {
    statusCode: 409, code: "collection_inventory_limit"
  });
  if (result.rows.length === 0) return [];
  // Runtime, owner suspension and deletion denial are selected together. There
  // is no retained-legacy fallback; mutation-time authority locks are unchanged.
  const migrationRows: NextMigrationFreezeRow[] = [];
  for (const row of result.rows) {
    if (row.owner_frozen) migrationRows.push({
      account_id: row.owner_user_id, account_backend: row.owner_account_backend,
      started_at: row.owner_started_at, terminal_excluded_at: row.owner_terminal_excluded_at,
      completed_at: row.owner_completed_at, completed_revision: row.owner_completed_revision, flipped_at: row.owner_flipped_at
    });
    if (row.viewer_frozen) migrationRows.push({
      account_id: userId, account_backend: row.viewer_account_backend,
      started_at: row.viewer_started_at, terminal_excluded_at: row.viewer_terminal_excluded_at,
      completed_at: row.viewer_completed_at, completed_revision: row.viewer_completed_revision, flipped_at: row.viewer_flipped_at
    });
  }
  const frozen = await projectNextMigrationFreeze(db, migrationRows);
  return result.rows.flatMap(row => {
    const owner = row.owner_user_id === userId;
    const policy = owner ? null : decodeStoredMembershipPolicy({
      id: row.policy_id, membership_id: row.membership_id, collection_id: row.collection_id,
      user_id: row.user_id, owner_user_id: row.policy_owner_user_id, revision: row.revision,
      role: row.role, preset_version: row.preset_version, actions: row.actions,
      operations: row.operations, scope_ceiling: row.scope_ceiling, file_ceiling: row.file_ceiling
    }, row.owner_user_id);
    if (!owner && !policy?.actions.includes("collection.discover")) return [];
    return [{
      id: row.collection_id, display_name: row.display_name, sync: row.sync,
      access: {
        relationship: owner ? "owner" as const : "member" as const, role: owner ? "owner" as const : policy!.role,
        can_manage_members: !frozen.has(userId) && !frozen.has(row.owner_user_id)
          && (owner || policy!.actions.includes("members.manage"))
      }
    }];
  });
}

function hostedEntry(row: {
  id: string;
  user_id: string;
  display_name: string;
  template: HostedTemplate;
  provider_url: string | null;
  contracts: CollectionContractDescriptor[];
  authority_state: string;
  authority_epoch: string | number;
  transferred_collection_id: string | null;
  created_at: string | Date;
}): HostedCollectionCatalogEntry {
  return {
    locator: {
      collectionId: row.id,
      authorityKind: "hosted",
      authorityRowId: row.id,
      ownerUserId: row.user_id,
      authorityEpoch: Number(row.authority_epoch),
      authorityState: row.authority_state,
      displayName: row.display_name,
      ...(row.provider_url ? { providerUrl: row.provider_url } : {})
    },
    template: row.template,
    contracts: row.contracts,
    transferredCollectionId: row.transferred_collection_id,
    createdAt: row.created_at
  };
}
