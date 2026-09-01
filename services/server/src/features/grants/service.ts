import { isDeepStrictEqual } from "node:util";
import type {
  ApplicationNotifications,
  ApplicationRequirements,
  CollectionContractDescriptor,
  FileCapability,
  GrantSummary,
  GrantScope,
  NotificationCriterion
} from "@mdbase-dev/connect-protocol";
import {
  collectionGrantScope,
  isCanonicalCollectionGrantScope
} from "../../application-grant-scope.js";
import type { DatabasePool, DatabaseQueryable } from "../../db.js";
import { parsePersistedApplicationAuthorization } from "../../application-authorization.js";
import {
  quarantineMissingHostedCollection,
  queueHostedGrantRevocation
} from "../../hosted-capability-lifecycle.js";
import { contractRequirements, effectiveHostedContractDescriptors } from "../../hosted.js";
import {
  HostedProviderClient,
  HostedProviderResponseError
} from "../../hosted-provider.js";
import { fileCapabilityForRequirements } from "../../grant-planner.js";
import { RelayHub } from "../../relay.js";
import { audit } from "../../platform/audit-events.js";
import {
  collectionSupportsOperations,
  contractsSatisfy,
  operationsAllowedByRequirements,
  requiredContractsForRequirements,
  requiresHostedCollection
} from "./policy.js";

export async function syncHostedNotificationGrant(
  db: DatabaseQueryable,
  provider: HostedProviderClient,
  grantId: string
): Promise<void> {
  const result = await db.query<{
    id: string;
    application_id: string;
    application_name: string;
    application_distribution: "web" | "portable";
    application_homepage: string;
    application_project_url: string | null;
    application_origin: string;
    application_icon: string | null;
    collection_id: string;
    collection_name: string;
    operations: string[];
    scope: GrantScope;
    notification_criteria: NotificationCriterion[];
    file_capability: FileCapability | null;
    created_at: string | Date;
    application_authorization: import("@mdbase-dev/connect-protocol").ApplicationAuthorizationProof;
  }>(
    `SELECT g.id, g.application_id, a.name AS application_name,
            a.distribution AS application_distribution,
            a.homepage AS application_homepage,
            a.project_url AS application_project_url,
            CASE WHEN g.application_origin = '' THEN a.homepage
                 ELSE g.application_origin END AS application_origin,
            a.icon AS application_icon,
            g.hosted_collection_id AS collection_id,
            hosted.display_name AS collection_name,
            g.operations, g.scope, g.notification_criteria, g.file_capability,
            g.created_at, g.application_authorization
     FROM grants g
     JOIN applications a ON a.id = g.application_id
     JOIN hosted_collections hosted ON hosted.id = g.hosted_collection_id
     WHERE g.id = $1 AND g.revoked_at IS NULL
       AND g.activated_at IS NOT NULL`,
    [grantId]
  );
  const row = result.rows[0];
  if (!row) return;
  if (!isCanonicalCollectionGrantScope(row.scope)) {
    await provider.revokeNotificationGrant(row.collection_id, row.id);
    return;
  }
  if (row.notification_criteria.length === 0) {
    await provider.revokeNotificationGrant(row.collection_id, row.id);
    return;
  }
  row.application_authorization = parsePersistedApplicationAuthorization(
    row.application_authorization
  );
  const grant: GrantSummary = {
    id: row.id,
    application_id: row.application_id,
    application_declaration_id:
      row.application_authorization.binding.application_declaration_id,
    application_manifest_digest:
      row.application_authorization.binding.application_manifest_digest,
    collection_id: row.collection_id,
    operations: row.operations as GrantSummary["operations"],
    scope: row.scope,
    application_name: row.application_name,
    application_distribution: row.application_distribution,
    application_homepage: row.application_homepage,
    ...(row.application_project_url
      ? { application_project_url: row.application_project_url }
      : {}),
    application_origin: row.application_origin,
    ...(row.application_icon ? { application_icon: row.application_icon } : {}),
    collection_name: row.collection_name,
    notification_criteria: row.notification_criteria,
    created_at: new Date(row.created_at).toISOString(),
    contracts: row.application_authorization.binding.contracts,
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
       AND g.activated_at IS NOT NULL
       AND ($2::uuid IS NULL OR g.id = $2)`,
    [application.id, exactGrantId ?? null]
  );
  const changedConnectors = new Set<string>();
  for (const grant of grants.rows) {
    if (
      !isCanonicalCollectionGrantScope(grant.scope)
      || (grant.hosted_replica_id && (grant.allowed_types?.length ?? 0) > 0)
    ) {
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
    if (grant.hosted_replica_id) {
      if (!hostedProvider) {
        throw new Error("Hosted provider unavailable during notification reconciliation.");
      }
      try {
        await syncHostedNotificationGrant(db, hostedProvider, grant.id);
      } catch (error) {
        const missingCode = missingHostedResourceCode(error);
        if (!missingCode) throw error;
        await quarantineMissingHostedGrant(db, {
          userId: grant.user_id,
          grantId: grant.id,
          collectionId: grant.hosted_collection_id,
          applicationId: application.id,
          providerErrorCode: missingCode
        });
        if (grant.connector_id) changedConnectors.add(grant.connector_id);
        continue;
      }
    }
    const hostedDescriptors = grant.template
      ? effectiveHostedContractDescriptors(grant.hosted_contracts, grant.template)
      : [];
    const availableDescriptors = grant.template
      ? hostedDescriptors
      : grant.local_contracts ?? [];
    const availableContracts = contractRequirements(availableDescriptors);
    const desiredScope = collectionGrantScope();
    const desiredFileCapability = fileCapabilityForRequirements(application.requirements);
    const fileCapabilityMatches = isDeepStrictEqual(
      grant.file_capability,
      desiredFileCapability ?? null
    );
    const collectionKindCompatible = !requiresHostedCollection(application.requirements)
      || grant.template !== null;
    const collectionCompatible = application.requirements.access === "full_collection"
      && collectionKindCompatible
      && contractsSatisfy(availableContracts, requiredContracts)
      && (grant.template !== null
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
    hosted_replica_id: string | null;
  },
  reason: string
): Promise<void> {
  if (grant.hosted_replica_id) {
    const queued = await queueHostedGrantRevocation(
      db,
      grant.user_id,
      grant.id,
      reason
    );
    if (!queued) {
      throw new Error("Active hosted grant disappeared during retirement.");
    }
    await db.query(
      `UPDATE grants
       SET reauthorization_required_at = COALESCE(reauthorization_required_at, now()),
           reauthorization_reason = $2
       WHERE id = $1`,
      [grant.id, reason]
    );
    return;
  }
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

function missingHostedResourceCode(error: unknown): string | null {
  if (
    !(error instanceof HostedProviderResponseError)
    || error.status !== 404
    || !["hosted_collection_not_found", "replica_not_found"].includes(error.code)
  ) return null;
  return error.code;
}

async function quarantineMissingHostedGrant(
  db: DatabasePool,
  input: {
    userId: string;
    grantId: string;
    collectionId: string | null;
    applicationId: string;
    providerErrorCode: string;
  }
): Promise<void> {
  if (
    input.providerErrorCode === "hosted_collection_not_found"
    && input.collectionId
  ) {
    await quarantineMissingHostedCollection(db, input.collectionId);
    return;
  }
  const queued = await queueHostedGrantRevocation(
    db,
    input.userId,
    input.grantId,
    "hosted_resource_missing"
  );
  if (!queued) return;
  await audit(
    db,
    input.userId,
    "grant.revoked_after_hosted_resource_missing",
    input.grantId,
    {
      application_id: input.applicationId,
      provider_error_code: input.providerErrorCode
    }
  );
}
