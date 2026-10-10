import type { CollectionContractDescriptor } from "@mdbase-dev/connect-protocol";
import type { DatabaseQueryable } from "./db.js";
import type { HostedTemplate } from "./hosted.js";
import { resolveActiveMembershipPolicy, type CollectionRole } from "./collection-policy.js";
import { resolveCollectionSharingAuthority } from "./collection-sharing-authority.js";
import { RequestValidationError } from "./platform/http-errors.js";

export type CollectionAuthorityKind = "local" | "hosted";

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
    sync: "private" | "cloud_copy";
  }>(
    `SELECT native.collection_id, native.owner_user_id, native.display_name, native.sync
     FROM next_collections native
     LEFT JOIN collection_memberships membership
       ON membership.collection_id = native.collection_id AND membership.user_id = $1
      AND membership.state = 'active' AND membership.revoked_at IS NULL
     LEFT JOIN collection_membership_policies policy
       ON policy.id = membership.current_policy_id AND policy.membership_id = membership.id
      AND policy.revision = membership.current_policy_revision
     WHERE native.runtime = 'next' AND native.left_sync_at IS NULL
       AND native.sync IN ('private', 'cloud_copy')
       AND (native.owner_user_id = $1 OR policy.id IS NOT NULL)
     ORDER BY native.collection_id LIMIT 1001`,
    [userId]
  );
  // Never silently truncate All collections: direct entry must not mistake a
  // bounded prefix for an absent collection.
  if (result.rows.length > 1000) throw new RequestValidationError("The collection inventory exceeds the management limit.", {
    statusCode: 409, code: "collection_inventory_limit"
  });
  const visible: NativeCollectionCatalogEntry[] = [];
  for (const row of result.rows) {
    const authority = await resolveCollectionSharingAuthority(db, row.collection_id);
    if (authority?.kind !== "native" || authority.user_id !== row.owner_user_id) continue;
    const owner = authority.user_id === userId;
    const policy = owner ? null : await resolveActiveMembershipPolicy(db, {
      collectionId: row.collection_id, ownerUserId: authority.user_id, userId
    });
    if (!owner && !policy?.actions.includes("collection.discover")) continue;
    // This read only describes the UI. Every sharing mutation still takes its
    // canonical owner/freeze/collection locks and rechecks current authority.
    const frozen = (await db.query(
      `SELECT cohort.name FROM next_migration_cohort_members member
       JOIN next_migration_cohorts cohort ON cohort.name = member.cohort
       WHERE member.account_id IN ($1, $2) AND cohort.frozen_at IS NOT NULL LIMIT 1`,
      [userId, authority.user_id]
    )).rows.length > 0;
    visible.push({
      id: row.collection_id, display_name: row.display_name, sync: row.sync,
      access: {
        relationship: owner ? "owner" : "member", role: owner ? "owner" : policy!.role,
        can_manage_members: !frozen && (owner || policy!.actions.includes("members.manage"))
      }
    });
  }
  return visible;
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
