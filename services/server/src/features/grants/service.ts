import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  ApplicationNotifications,
  ApplicationRequirements,
  CollectionContractDescriptor,
  ContractRequirement,
  FileCapability,
  GrantEncryption,
  GrantSummary,
  GrantScope,
  NotificationCriterion
} from "@mdbase-dev/connect-protocol";
import type { DatabasePool, DatabaseQueryable } from "../../db.js";
import { queueHostedGrantRevocation } from "../../hosted-capability-lifecycle.js";
import { contractRequirements, effectiveHostedContractDescriptors } from "../../hosted.js";
import { HostedProviderClient } from "../../hosted-provider.js";
import { fileCapabilityForRequirements } from "../../grant-planner.js";
import { hostedReplicaCollectionOperations } from "../../hosted-replica-policy.js";
import { RelayHub } from "../../relay.js";
import { audit } from "../../platform/audit-events.js";
import {
  allowedTypesForRequirements,
  collectionSupportsOperations,
  contractsSatisfy,
  operationsAllowedByRequirements,
  requiredContractsForRequirements,
  requiresHostedCollection,
  rotateGrantEncryption,
  scopeForRequirements
} from "./policy.js";

export async function createOrUpdateGrant(
  db: DatabasePool,
  input: {
    userId: string;
    applicationId: string;
    collectionId: string;
    operations: string[];
    scope: GrantScope;
    fileCapability?: FileCapability;
    applicationOrigin: string;
    notificationCriteria: NotificationCriterion[];
  }
): Promise<{ id: string; operations: string[]; scope: GrantScope }> {
  const operations = [...new Set(input.operations)];
  const existing = await db.query<{ id: string; encryption: GrantEncryption | null }>(
    `SELECT id, encryption FROM grants WHERE user_id = $1 AND application_id = $2
     AND collection_id = $3 AND revoked_at IS NULL AND activated_at IS NOT NULL
     ORDER BY created_at DESC LIMIT 1`,
    [input.userId, input.applicationId, input.collectionId]
  );
  const grant = existing.rows[0]
    ? await db.query<{ id: string; operations: string[]; scope: GrantScope }>(
        `UPDATE grants SET operations = $2::jsonb, scope = $3::jsonb,
                           file_capability = $4::jsonb, application_origin = $5,
                           notification_criteria = $6::jsonb
         WHERE id = $1 RETURNING id, operations, scope`,
        [
          existing.rows[0].id,
          JSON.stringify(operations),
          JSON.stringify(input.scope),
          input.fileCapability ? JSON.stringify(input.fileCapability) : null,
          input.applicationOrigin,
          JSON.stringify(input.notificationCriteria)
        ]
      )
    : await db.query<{ id: string; operations: string[]; scope: GrantScope }>(
        `INSERT INTO grants
           (id, user_id, application_id, collection_id, operations, scope,
            file_capability, application_origin, notification_criteria)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9::jsonb)
         RETURNING id, operations, scope`,
        [
          randomUUID(),
          input.userId,
          input.applicationId,
          input.collectionId,
          JSON.stringify(operations),
          JSON.stringify(input.scope),
          input.fileCapability ? JSON.stringify(input.fileCapability) : null,
          input.applicationOrigin,
          JSON.stringify(input.notificationCriteria)
        ]
      );
  if (existing.rows[0]?.encryption) {
    await rotateGrantEncryption(db, existing.rows[0].id);
  }
  return grant.rows[0];
}

export async function syncHostedNotificationGrant(
  db: DatabaseQueryable,
  provider: HostedProviderClient,
  grantId: string
): Promise<void> {
  const result = await db.query<{
    id: string;
    application_id: string;
    application_name: string;
    application_homepage: string;
    application_origin: string;
    application_icon: string | null;
    collection_id: string;
    collection_name: string;
    operations: string[];
    scope: GrantScope;
    notification_criteria: NotificationCriterion[];
    file_capability: FileCapability | null;
    created_at: string | Date;
  }>(
    `SELECT g.id, g.application_id, a.name AS application_name,
            a.homepage AS application_homepage,
            CASE WHEN g.application_origin = '' THEN a.homepage
                 ELSE g.application_origin END AS application_origin,
            a.icon AS application_icon,
            g.hosted_collection_id AS collection_id,
            hosted.display_name AS collection_name,
            g.operations, g.scope, g.notification_criteria, g.file_capability,
            g.created_at
     FROM grants g
     JOIN applications a ON a.id = g.application_id
     JOIN hosted_collections hosted ON hosted.id = g.hosted_collection_id
     WHERE g.id = $1 AND g.revoked_at IS NULL
       AND g.activated_at IS NOT NULL`,
    [grantId]
  );
  const row = result.rows[0];
  if (!row) return;
  if (row.notification_criteria.length === 0) {
    await provider.revokeNotificationGrant(row.collection_id, row.id);
    return;
  }
  const grant: GrantSummary = {
    id: row.id,
    application_id: row.application_id,
    collection_id: row.collection_id,
    operations: row.operations as GrantSummary["operations"],
    scope: row.scope,
    application_name: row.application_name,
    application_homepage: row.application_homepage,
    application_origin: row.application_origin,
    ...(row.application_icon ? { application_icon: row.application_icon } : {}),
    collection_name: row.collection_name,
    notification_criteria: row.notification_criteria,
    created_at: new Date(row.created_at).toISOString(),
    ...(row.file_capability ? { file_capability: row.file_capability } : {})
  };
  await provider.upsertNotificationGrant(row.collection_id, grant);
}

export async function reconcileApplicationGrants(
  db: DatabasePool,
  relay: RelayHub,
  hostedProvider: HostedProviderClient | undefined,
  application: {
    id: string;
    requirements: ApplicationRequirements;
    notifications: ApplicationNotifications;
  }
): Promise<void> {
  const requiredContracts = requiredContractsForRequirements(application.requirements);
  const grants = await db.query<{
    id: string;
    user_id: string;
    connector_id: string | null;
    hosted_collection_id: string | null;
    hosted_replica_id: string | null;
    operations: string[];
    local_contracts: CollectionContractDescriptor[] | null;
    spec_version: string | null;
    hosted_contracts: CollectionContractDescriptor[] | null;
    template: string | null;
    allowed_types: string[] | null;
    scope: GrantScope;
    notification_criteria: NotificationCriterion[];
    file_capability: FileCapability | null;
  }>(
    `SELECT g.id, g.user_id, col.connector_id, g.hosted_collection_id, g.hosted_replica_id,
            g.operations, col.contracts AS local_contracts, col.spec_version,
            hosted.contracts AS hosted_contracts, hosted.template,
            replica.allowed_types, g.scope, g.notification_criteria,
            g.file_capability
     FROM grants g
     LEFT JOIN collections col ON col.id = g.collection_id
     LEFT JOIN hosted_collections hosted ON hosted.id = g.hosted_collection_id
     LEFT JOIN hosted_replicas replica ON replica.id = g.hosted_replica_id
     WHERE g.application_id = $1 AND g.revoked_at IS NULL
       AND g.activated_at IS NOT NULL`,
    [application.id]
  );
  const changedConnectors = new Set<string>();
  for (const grant of grants.rows) {
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
    if (grant.hosted_replica_id) {
      if (!hostedProvider) {
        throw new Error("Hosted provider unavailable during notification reconciliation.");
      }
      await syncHostedNotificationGrant(db, hostedProvider, grant.id);
    }
    const hostedDescriptors = grant.template
      ? effectiveHostedContractDescriptors(grant.hosted_contracts, grant.template)
      : [];
    const availableDescriptors = grant.template
      ? hostedDescriptors
      : grant.local_contracts ?? [];
    const availableContracts = contractRequirements(availableDescriptors);
    const desiredScope = scopeForRequirements(
      application.requirements,
      availableDescriptors
    );
    const desiredFileCapability = fileCapabilityForRequirements(application.requirements);
    const fileCapabilityMatches = isDeepStrictEqual(
      grant.file_capability,
      desiredFileCapability ?? null
    );
    const collectionKindCompatible = !requiresHostedCollection(application.requirements)
      || grant.template !== null;
    const collectionCompatible = collectionKindCompatible
      && contractsSatisfy(availableContracts, requiredContracts)
      && (grant.template !== null
        || (grant.spec_version !== null
          && collectionSupportsOperations(grant.spec_version, grant.operations)))
      && operationsAllowedByRequirements(grant.operations, application.requirements);
    const scopeMatches = scopesEqual(grant.scope, desiredScope);
    const desiredAllowedTypes = grant.template
      ? allowedTypesForRequirements(hostedDescriptors, application.requirements)
      : [];
    const replicaScopeMatches = !grant.hosted_replica_id
      || sameStrings(grant.allowed_types ?? [], desiredAllowedTypes);
    if (
      scopeMatches
      && collectionCompatible
      && replicaScopeMatches
      && fileCapabilityMatches
    ) continue;
    const mayNarrow = desiredScope.contracts.length > 0
      && (grant.scope.contracts.length === 0
        || isContractSubset(desiredScope.contracts, grant.scope.contracts));
    if ((scopeMatches || mayNarrow) && collectionCompatible && fileCapabilityMatches) {
      if (grant.hosted_replica_id) {
        if (!hostedProvider) {
          throw new Error("Hosted provider unavailable during grant reconciliation.");
        }
        const write = grant.operations.some((operation) =>
          [
            "create",
            "update",
            "delete",
            "rename",
            "create_type",
            "update_type",
            "install_type_pack",
            "create_view_source",
            "update_view_source",
            "delete_view_source",
            "put_timer",
            "cancel_timer",
            "reconcile_timers"
          ].includes(operation)
        ) || desiredFileCapability?.actions.some((action) =>
          ["add", "replace", "move", "delete"].includes(action)
        ) === true;
        await hostedProvider.updateApplicationReplica(grant.hosted_replica_id, {
          grantId: grant.id,
          mode: write ? "read_write" : "read_only",
          allowedTypes: desiredAllowedTypes,
          contractScope: desiredScope.access === "contract" ? desiredScope.contracts : [],
          fullCollection: application.requirements.access === "full_collection",
          allowedOperations: hostedReplicaCollectionOperations(grant.operations),
          fileCapability: desiredFileCapability
        });
        await db.query(
          "UPDATE hosted_replicas SET allowed_types = $2::jsonb, mode = $3 WHERE id = $1",
          [
            grant.hosted_replica_id,
            JSON.stringify(desiredAllowedTypes),
            write ? "read_write" : "read_only"
          ]
        );
      }
      await db.query("UPDATE grants SET scope = $2::jsonb WHERE id = $1", [
        grant.id,
        JSON.stringify(desiredScope)
      ]);
      await rotateGrantEncryption(db, grant.id);
      await audit(db, grant.user_id, "grant.scope_reconciled", grant.id, {
        application_id: application.id,
        scope: desiredScope
      });
    } else {
      if (grant.hosted_replica_id) {
        const queued = await queueHostedGrantRevocation(
          db,
          grant.user_id,
          grant.id,
          "application_manifest_change"
        );
        if (!queued) {
          throw new Error(
            "Active hosted grant disappeared during manifest reconciliation."
          );
        }
      } else {
        await db.query("UPDATE grants SET revoked_at = now() WHERE id = $1", [grant.id]);
        await db.query(
          "UPDATE access_tokens SET revoked_at = now() WHERE grant_id = $1",
          [grant.id]
        );
        await db.query(
          "UPDATE refresh_tokens SET revoked_at = now() WHERE grant_id = $1",
          [grant.id]
        );
      }
      await audit(db, grant.user_id, "grant.revoked_after_manifest_change", grant.id, {
        application_id: application.id,
        previous_scope: grant.scope,
        required_scope: desiredScope
      });
    }
    if (grant.connector_id) changedConnectors.add(grant.connector_id);
  }
  for (const connectorId of changedConnectors) {
    await relay.pushPolicy(connectorId);
  }
}

function scopesEqual(left: GrantScope, right: GrantScope): boolean {
  return left.access === right.access
    && isContractSubset(left.contracts, right.contracts)
    && isContractSubset(right.contracts, left.contracts);
}

function isContractSubset(
  subset: ContractRequirement[],
  superset: ContractRequirement[]
): boolean {
  const available = new Set(
    superset.map((contract) => `${contract.id}@${contract.version}`)
  );
  return subset.every((contract) =>
    available.has(`${contract.id}@${contract.version}`)
  );
}

function sameStrings(left: string[], right: string[]): boolean {
  const leftValues = new Set(left);
  const rightValues = new Set(right);
  return leftValues.size === rightValues.size
    && [...leftValues].every((value) => rightValues.has(value));
}
