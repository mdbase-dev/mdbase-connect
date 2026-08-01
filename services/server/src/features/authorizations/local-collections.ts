import { randomUUID } from "node:crypto";
import type {
  ApplicationProvisions,
  ApplicationRequirements,
  CollectionContractDescriptor,
  CollectionTypeDescriptor
} from "@mdbase-dev/connect-protocol";
import { accessView, resolveLocalCollectionAccess } from "../../collection-access.js";
import { listLocalCollectionsVisibleToUser } from "../../collection-catalog.js";
import type { DatabasePool } from "../../db.js";
import type { RelayHub } from "../../relay.js";
import { sqlPlaceholders } from "../../platform/sql.js";

export interface LiveAuthorizationCollection {
  id: string;
  offer_id: string;
  kind: "local";
  connector_name: string;
  display_name: string;
  spec_version: string;
  contracts: CollectionContractDescriptor[];
  types: CollectionTypeDescriptor[];
  access: ReturnType<typeof accessView>;
}

export async function liveAuthorizationCollections(
  db: DatabasePool,
  relay: RelayHub,
  userId: string,
  authorizationId: string
): Promise<{
  collections: LiveAuthorizationCollection[];
  unavailable_connectors: Array<{
    connector_id: string;
    connector_name: string;
    reason: "offline" | "paused";
  }>;
}> {
  const authorization = await db.query<{
    requirements: ApplicationRequirements;
    provisions: ApplicationProvisions;
  }>(
    `SELECT a.requirements, a.provisions
     FROM authorization_requests ar
     JOIN applications a ON a.id = ar.application_id
     WHERE ar.id = $1 AND ar.user_id = $2
       AND ar.completed_at IS NULL AND ar.denied_at IS NULL
       AND ar.expires_at > now()`,
    [authorizationId, userId]
  );
  const pending = authorization.rows[0];
  if (!pending) return { collections: [], unavailable_connectors: [] };
  await db.query(
    `DELETE FROM authorization_collection_offers
     WHERE authorization_id = $1 AND expires_at <= now()`,
    [authorizationId]
  );
  const visibleCollections = await listLocalCollectionsVisibleToUser(db, userId);
  const visibleByConnector = new Map<string, Set<string>>();
  for (const collection of visibleCollections) {
    if (
      collection.authorityState !== "active"
      || !collection.connectorId
    ) continue;
    const ids = visibleByConnector.get(collection.connectorId) ?? new Set();
    ids.add(collection.authorityRowId);
    visibleByConnector.set(collection.connectorId, ids);
  }
  const ownerConnectors = await db.query<{
    id: string;
    name: string;
    inventory_revision: string | number;
  }>(
    `SELECT id, name, inventory_revision FROM connectors
     WHERE user_id = $1 AND revoked_at IS NULL
     ORDER BY created_at`,
    [userId]
  );
  const ownerConnectorIds = new Set(ownerConnectors.rows.map(({ id }) => id));
  const sharedConnectorIds = [...visibleByConnector.keys()]
    .filter((id) => !ownerConnectorIds.has(id));
  const sharedConnectors = sharedConnectorIds.length
    ? await db.query<{
        id: string;
        name: string;
        inventory_revision: string | number;
      }>(
        `SELECT id, name, inventory_revision FROM connectors
         WHERE id IN (${sqlPlaceholders(sharedConnectorIds.length)})
           AND revoked_at IS NULL
         ORDER BY created_at`,
        sharedConnectorIds
      )
    : { rows: [] };
  const connectors = {
    rows: [...ownerConnectors.rows, ...sharedConnectors.rows]
  };
  const settled = await Promise.allSettled(connectors.rows.map(async (connector) => ({
    connector,
    response: await relay.authorizationOffers(
      connector.id,
      authorizationId,
      pending.requirements,
      pending.provisions
    )
  })));
  const collections: LiveAuthorizationCollection[] = [];
  const unavailableConnectors: Array<{
    connector_id: string;
    connector_name: string;
    reason: "offline" | "paused";
  }> = [];

  for (const [index, result] of settled.entries()) {
    const connector = connectors.rows[index];
    if (result.status === "rejected") {
      unavailableConnectors.push({
        connector_id: connector.id,
        connector_name: connector.name,
        reason: "offline"
      });
      continue;
    }
    if (result.value.response.paused) {
      unavailableConnectors.push({
        connector_id: connector.id,
        connector_name: connector.name,
        reason: "paused"
      });
      continue;
    }
    const authoritative = await db.query<{
      id: string;
      local_id: string;
      authority_epoch: string | number;
    }>(
      `SELECT id, local_id, authority_epoch FROM collections
       WHERE connector_id = $1
         AND present = true AND enabled = true AND authority_state = 'active'`,
      [connector.id]
    );
    const visibleIds = visibleByConnector.get(connector.id) ?? new Set();
    const byLocalId = new Map(authoritative.rows
      .filter((collection) => visibleIds.has(collection.id))
      .map((collection) => [collection.local_id, collection] as const));
    for (const offered of result.value.response.collections) {
      const collection = byLocalId.get(offered.collection_id);
      if (!collection) continue;
      const offer = await db.query<{ id: string }>(
        `INSERT INTO authorization_collection_offers
           (id, authorization_id, user_id, connector_id, collection_id, local_id,
            authority_epoch, inventory_revision, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + interval '45 seconds')
         ON CONFLICT(authorization_id, connector_id, collection_id) DO UPDATE SET
           local_id = excluded.local_id,
           authority_epoch = excluded.authority_epoch,
           inventory_revision = excluded.inventory_revision,
           expires_at = excluded.expires_at
         WHERE authorization_collection_offers.consumed_at IS NULL
         RETURNING id`,
        [
          randomUUID(),
          authorizationId,
          userId,
          connector.id,
          collection.id,
          offered.collection_id,
          Number(collection.authority_epoch),
          Number(connector.inventory_revision)
        ]
      );
      if (!offer.rows[0]) continue;
      const access = await resolveLocalCollectionAccess(
        db,
        userId,
        collection.id
      );
      if (!access || !access.actions.has("application.authorize")) continue;
      collections.push({
        id: offered.collection_id,
        offer_id: offer.rows[0].id,
        kind: "local",
        connector_name: connector.name,
        display_name: offered.display_name,
        spec_version: offered.spec_version,
        contracts: offered.contracts,
        types: offered.types,
        access: accessView(access)
      });
    }
  }

  collections.sort((left, right) =>
    left.display_name.localeCompare(right.display_name, undefined, {
      sensitivity: "base"
    })
    || left.connector_name.localeCompare(right.connector_name, undefined, {
      sensitivity: "base"
    })
  );
  return {
    collections,
    unavailable_connectors: unavailableConnectors
  };
}
