import { isDeepStrictEqual } from "node:util";
import type { ApplicationRequirements } from "../applications/application-requirements.js";
import type {
  ApplicationNotifications,
  CollectionContractDescriptor,
  FileCapability,
  GrantScope,
  NotificationCriterion
} from "@mdbase-dev/connect-protocol";
import {
  collectionGrantScope,
  isCanonicalCollectionGrantScope
} from "./application-grant-scope.js";
import type { DatabasePool } from "../../db.js";
import { fileCapabilityPermittedByRequirements } from "./grant-planner.js";
import { RelayHub } from "../relay/relay.js";
import { audit } from "../../platform/audit-events.js";
import {
  collectionSupportsOperations,
  contractsSatisfy,
  operationsAllowedByRequirements,
  requiredContractsForRequirements,
  requiresHostedCollection
} from "./policy.js";

export async function reconcileApplicationGrants(
  db: DatabasePool,
  relay: RelayHub,
  application: {
    id: string;
    family_identity: string;
    manifest_digest: string;
    requirements: ApplicationRequirements;
    notifications: ApplicationNotifications;
  },
  exactGrantId?: string
): Promise<void> {
  const requiredContracts = requiredContractsForRequirements(application.requirements);
  const grants = await db.query<{
    id: string;
    user_id: string;
    connector_id: string | null;
    hosted_collection_id: string | null;
    hosted_replica_id: string | null;
    next_collection_id: string | null;
    next_collection_sync: string | null;
    operations: string[];
    local_contracts: CollectionContractDescriptor[] | null;
    spec_version: string | null;
    scope: GrantScope;
    notification_criteria: NotificationCriterion[];
    file_capability: FileCapability | null;
  }>(
    `SELECT g.id, g.user_id, col.connector_id, g.hosted_collection_id, g.hosted_replica_id,
            g.next_collection_id, g.next_collection_sync,
            g.operations, col.contracts AS local_contracts, col.spec_version,
            g.scope, g.notification_criteria,
            g.file_capability
     FROM grants g
     LEFT JOIN collections col ON col.id = g.collection_id
     WHERE g.application_id = $1 AND g.revoked_at IS NULL
       AND g.activated_at IS NOT NULL
       AND ($2::uuid IS NULL OR g.id = $2)`,
    [application.id, exactGrantId ?? null]
  );
  const changedConnectors = new Set<string>();
  for (const grant of grants.rows) {
    if (!isCanonicalCollectionGrantScope(grant.scope)) {
      await retireGrantForReauthorization(
        db,
        grant,
        "collection_level_authorization"
      );
      await audit(db, grant.user_id, "grant.revoked_legacy_scope", grant.id, {
        application_id: application.id
      });
      if (grant.connector_id) changedConnectors.add(grant.connector_id);
      continue;
    }
    const retainedCriteria = grant.notification_criteria.filter((authorized) =>
      application.notifications.criteria.some((declared) =>
        isDeepStrictEqual(authorized, declared)
      )
    );
    const notificationsChanged = !isDeepStrictEqual(
      retainedCriteria,
      grant.notification_criteria
    );
    if (notificationsChanged) {
      await db.query(
        "UPDATE grants SET notification_criteria = $2::jsonb WHERE id = $1",
        [grant.id, JSON.stringify(retainedCriteria)]
      );
      grant.notification_criteria = retainedCriteria;
      await audit(
        db,
        grant.user_id,
        "grant.notifications_narrowed",
        grant.id,
        {
          application_id: application.id,
          criterion_ids: retainedCriteria.map((criterion) => criterion.id)
        }
      );
      if (grant.connector_id) changedConnectors.add(grant.connector_id);
    }
    const availableContracts = grant.local_contracts ?? [];
    const desiredScope = collectionGrantScope();
    const fileCapabilityMatches = fileCapabilityPermittedByRequirements(
      application.requirements,
      grant.file_capability
    );
    // A synced collection has no row in collections: its contracts and format
    // live in its own log and were checked at approval.
    const synced = grant.next_collection_id !== null;
    const collectionKindCompatible = !requiresHostedCollection(application.requirements)
      || grant.next_collection_sync === "cloud_copy";
    const collectionCompatible = application.requirements.access === "full_collection"
      && collectionKindCompatible
      && (synced || contractsSatisfy(availableContracts, requiredContracts))
      && (synced
        || (grant.spec_version !== null
          && collectionSupportsOperations(grant.spec_version, grant.operations)))
      && operationsAllowedByRequirements(grant.operations, application.requirements);
    if (collectionCompatible && fileCapabilityMatches) continue;
    await retireGrantForReauthorization(db, grant, "application_manifest_change");
    await audit(db, grant.user_id, "grant.revoked_after_manifest_change", grant.id, {
      application_id: application.id,
      previous_scope: grant.scope,
      required_scope: desiredScope
    });
    if (grant.connector_id) changedConnectors.add(grant.connector_id);
  }
  for (const connectorId of changedConnectors) {
    await relay.pushPolicy(connectorId);
  }
}

async function retireGrantForReauthorization(
  db: DatabasePool,
  grant: {
    id: string;
    user_id: string;
  },
  reason: string
): Promise<void> {
  await db.query(
    `UPDATE grants
     SET revoked_at = COALESCE(revoked_at, now()),
         reauthorization_required_at = COALESCE(reauthorization_required_at, now()),
         reauthorization_reason = $2
     WHERE id = $1`,
    [grant.id, reason]
  );
  await db.query(
    "UPDATE access_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE grant_id = $1",
    [grant.id]
  );
  await db.query(
    "UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE grant_id = $1",
    [grant.id]
  );
}
