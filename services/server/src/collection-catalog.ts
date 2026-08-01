import type { CollectionContractDescriptor } from "@mdbase-dev/connect-protocol";
import type { DatabaseQueryable } from "./db.js";
import type { HostedTemplate } from "./hosted.js";

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
     WHERE id = $1`,
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
    `SELECT id, user_id, display_name, template, provider_url, contracts,
            authority_state, authority_epoch, transferred_collection_id,
            created_at
     FROM hosted_collections
     WHERE user_id = $1
     ORDER BY display_name`,
    [userId]
  );
  return result.rows.map(hostedEntry);
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
    `SELECT id, local_id, user_id, connector_id, display_name,
            authority_state, authority_epoch
     FROM collections
     WHERE user_id = $1
     ORDER BY display_name`,
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
