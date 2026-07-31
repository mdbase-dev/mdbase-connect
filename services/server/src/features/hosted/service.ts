import { randomUUID } from "node:crypto";
import type {
  ApplicationRequirements,
  CollectionContractDescriptor,
  CollectionTypeDescriptor,
  GrantScope
} from "@mdbase/connect-protocol";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  accessView,
  requireCollectionAction,
  resolveHostedCollectionAccess,
  type CollectionAction,
  type CollectionAccessContext
} from "../../collection-access.js";
import {
  listHostedCollectionsVisibleToUser
} from "../../collection-catalog.js";
import type {
  DatabasePool,
  DatabaseQueryable
} from "../../database-types.js";
import {
  contractRequirements,
  effectiveHostedContractDescriptors,
  hostedContractDescriptors,
  type HostedAuthorityRegistry,
  type HostedTemplate,
  typesForContracts
} from "../../hosted.js";
import type { HostedProviderClient } from "../../hosted-provider.js";
import {
  ProviderRevocationWorker,
  queueHostedGrantRevocation,
  queueHostedReplicaRevocation
} from "../../hosted-capability-lifecycle.js";
import {
  hostedReplicaCollectionOperations
} from "../../hosted-replica-policy.js";
import { tokenHash } from "../../security.js";
import { audit } from "../../platform/audit-events.js";
import { RequestValidationError, apiError } from "../../platform/http-errors.js";
import { bearerToken } from "../../platform/request-authentication.js";
import {
  recoverExpiredAuthorityTransfers
} from "../authority-transfer/lifecycle.js";
import { assertOperationsAllowedByRequirements } from "../grants/policy.js";

export interface HostedServiceOptions {
  db: DatabasePool;
  hostedCollections?: boolean;
  hostedProvider?: HostedProviderClient;
}

export interface HostedMirrorReplicaRow {
  id: string;
  collection_id: string;
  name: string;
  mode: "read_only" | "read_write";
  allowed_types: string[];
  revoked_at: string | null;
  created_at: string;
}

export async function hostedMirrorReplicas(
  db: DatabaseQueryable,
  collectionIds: string[]
): Promise<HostedMirrorReplicaRow[]> {
  if (collectionIds.length === 0) return [];
  const result = await db.query<HostedMirrorReplicaRow>(
    `SELECT id, collection_id, name, mode, allowed_types, revoked_at,
            created_at
     FROM hosted_replicas
     WHERE collection_id IN (${sqlPlaceholders(collectionIds.length)})
       AND purpose = 'mirror'
     ORDER BY created_at`,
    collectionIds
  );
  return result.rows;
}

export async function hostedControlSnapshot(
  options: HostedServiceOptions,
  hostedReference: HostedAuthorityRegistry | undefined,
  publicUrl: string,
  userId: string
): Promise<Record<string, unknown>> {
  if (!options.hostedCollections) {
    return {
      online: true,
      hosted_collections_available: false,
      hosted_collections: [],
      grants: [],
      pending_authorizations: []
    };
  }
  await recoverExpiredAuthorityTransfers(
    options.db,
    options.hostedProvider,
    hostedReference
  );
  const catalog = await listHostedCollectionsVisibleToUser(
    options.db,
    userId
  );
  const collections: { rows: Array<{
    id: string;
    display_name: string;
    template: HostedTemplate;
    contracts: CollectionContractDescriptor[];
    types: CollectionTypeDescriptor[];
    provider_url: string | null;
    authority_state: "active" | "transferring" | "transferred";
    authority_epoch: string | number;
    transferred_collection_id: string | null;
    created_at: string | Date;
    access: ReturnType<typeof accessView>;
  }> } = {
    rows: await Promise.all(catalog.map(async (collection) => ({
      id: collection.locator.collectionId,
      display_name: collection.locator.displayName,
      template: collection.template,
      contracts: collection.contracts,
      types: options.hostedProvider
        && collection.locator.authorityState === "active"
        ? await hostedTypeCandidates(
            options.hostedProvider,
            collection.locator.collectionId
          )
        : [],
      provider_url: collection.locator.providerUrl ?? null,
      authority_state: collection.locator.authorityState as
        | "active"
        | "transferring"
        | "transferred",
      authority_epoch: collection.locator.authorityEpoch,
      transferred_collection_id: collection.transferredCollectionId,
      created_at: collection.createdAt,
      access: accessView(requireCollectionAction(
        await resolveHostedCollectionAccess(
          options.db,
          userId,
          collection.locator.collectionId
        ),
        "collection.discover"
      ))
    })))
  };
  const replicas = {
    rows: await hostedMirrorReplicas(
      options.db,
      collections.rows.map((collection) => collection.id)
    )
  };
  const statuses = new Map<string, {
    head: number;
    acknowledged_sequence: number;
    last_seen_at: string | null;
    token_expires_at: string;
  }>();
  if (options.hostedProvider) {
    const groups = await Promise.all(
      collections.rows.map(async (collection) => {
        try {
          return await options.hostedProvider!.replicaStatuses(collection.id);
        } catch {
          return [];
        }
      })
    );
    for (const status of groups.flat()) {
      statuses.set(status.id, status);
    }
  }
  const grants = await options.db.query(
    `SELECT g.id, g.application_id,
            a.family_identity AS application_family_id,
            a.name AS application_name,
            a.distribution AS application_distribution,
            a.homepage AS application_homepage,
            a.project_url AS application_project_url,
            CASE WHEN g.application_origin = '' THEN a.homepage
                 ELSE g.application_origin END AS application_origin,
            a.icon AS application_icon,
            h.id AS collection_id, h.display_name AS collection_name,
            'hosted' AS collection_kind,
            g.operations, g.scope, g.notification_criteria, g.created_at
     FROM grants g
     JOIN applications a ON a.id = g.application_id
     JOIN hosted_collections h ON h.id = g.hosted_collection_id
     WHERE g.user_id = $1 AND g.revoked_at IS NULL
       AND g.activated_at IS NOT NULL
     ORDER BY a.name, h.display_name`,
    [userId]
  );
  const pending = await options.db.query(
    `SELECT ar.id, ar.application_id,
            a.name AS application_name,
            a.distribution AS application_distribution,
            a.homepage AS application_homepage,
            a.project_url AS application_project_url,
            a.icon AS application_icon, ar.flow, ar.user_code,
            ar.requested_operations, ar.collection_id, ar.expires_at,
            a.requirements, a.provisions, a.notifications
     FROM authorization_requests ar
     JOIN applications a ON a.id = ar.application_id
     WHERE ar.user_id = $1 AND ar.completed_at IS NULL
       AND ar.denied_at IS NULL AND ar.expires_at > now()
     ORDER BY ar.expires_at`,
    [userId]
  );
  return {
    online: true,
    hosted_collections_available: true,
    hosted_collections: collections.rows.map((collection) => ({
      ...collection,
      provider_url: collection.provider_url ?? publicUrl,
      spec_version: "0.3.0",
      authority_epoch: Number(collection.authority_epoch),
      authority: {
        kind: "hosted",
        collection_id: collection.id,
        epoch: Number(collection.authority_epoch),
        state: collection.authority_state
      },
      contracts: contractRequirements(
        effectiveHostedContractDescriptors(
          collection.contracts,
          collection.template
        )
      ),
      replicas: replicas.rows
        .filter((replica) => replica.collection_id === collection.id)
        .map((replica) => ({
          ...replica,
          sync_status: statuses.get(replica.id) ?? null
        }))
    })),
    grants: grants.rows.map((grant) => ({
      ...grant,
      application_origin: normalizedApplicationOrigin(
        grant.application_origin
      )
    })),
    pending_authorizations: pending.rows.map((authorization) => ({
      ...authorization,
      compatible_collection_ids: [],
      provisionable_collection_ids: []
    }))
  };
}

async function hostedTypeCandidates(
  provider: HostedProviderClient,
  collectionId: string
): Promise<CollectionTypeDescriptor[]> {
  try {
    return await provider.collectionTypeCandidates(collectionId);
  } catch {
    return [];
  }
}

export async function createHostedCollectionForUser(
  options: HostedServiceOptions,
  hostedReference: HostedAuthorityRegistry | undefined,
  publicUrl: string,
  userId: string,
  displayName: string,
  template: HostedTemplate
): Promise<Record<string, unknown>> {
  if (!options.hostedCollections) {
    throw new RequestValidationError("Hosted collections are not enabled.");
  }
  const collectionId = randomUUID();
  try {
    if (options.hostedProvider) {
      await options.hostedProvider.createCollection(
        collectionId,
        template,
        displayName
      );
    } else {
      await hostedReference!.create(collectionId, template);
    }
    await options.db.query(
      `INSERT INTO hosted_collections
         (id, user_id, display_name, template, provider_url, contracts)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        collectionId,
        userId,
        displayName,
        template,
        options.hostedProvider?.url ?? null,
        JSON.stringify(hostedContractDescriptors(template))
      ]
    );
  } catch (error) {
    if (options.hostedProvider) {
      await options.hostedProvider
        .deleteCollection(collectionId)
        .catch(() => undefined);
    } else {
      await hostedReference?.delete(collectionId).catch(() => undefined);
    }
    throw error;
  }
  await audit(
    options.db,
    userId,
    "hosted_collection.created",
    collectionId,
    { template, source: "desktop" }
  );
  return {
    id: collectionId,
    display_name: displayName,
    template,
    provider_url: options.hostedProvider?.url ?? publicUrl,
    spec_version: "0.3.0",
    contracts: contractRequirements(hostedContractDescriptors(template)),
    authority_state: "active",
    authority_epoch: 1,
    transferred_collection_id: null,
    created_at: new Date().toISOString(),
    replicas: []
  };
}

export async function renameHostedCollectionForUser(
  options: HostedServiceOptions,
  userId: string,
  collectionId: string,
  displayName: string
): Promise<{ id: string; display_name: string } | null> {
  if (!await permitsHostedCollectionAction(
    options.db,
    userId,
    collectionId,
    "collection.rename"
  )) {
    return null;
  }
  if (options.hostedProvider) {
    await options.hostedProvider.renameCollection(
      collectionId,
      displayName
    );
  }
  const renamed = await options.db.query<{
    id: string;
    display_name: string;
  }>(
    `UPDATE hosted_collections SET display_name = $3
     WHERE id = $1 AND user_id = $2
     RETURNING id, display_name`,
    [collectionId, userId, displayName]
  );
  await audit(
    options.db,
    userId,
    "hosted_collection.renamed",
    collectionId,
    { display_name: displayName, source: "desktop" }
  );
  return renamed.rows[0] ?? null;
}

export async function deleteHostedCollectionForUser(
  options: HostedServiceOptions,
  hostedReference: HostedAuthorityRegistry | undefined,
  userId: string,
  collectionId: string
): Promise<boolean> {
  if (!await permitsHostedCollectionAction(
    options.db,
    userId,
    collectionId,
    "collection.delete"
  )) {
    return false;
  }
  if (options.hostedProvider) {
    await options.hostedProvider.deleteCollection(collectionId);
  } else {
    await hostedReference!.delete(collectionId);
  }
  const connection = await options.db.connect();
  try {
    await connection.query("BEGIN");
    await connection.query(
      `DELETE FROM grants
       WHERE hosted_collection_id = $1 AND user_id = $2`,
      [collectionId, userId]
    );
    await connection.query(
      `DELETE FROM hosted_collections
       WHERE id = $1 AND user_id = $2`,
      [collectionId, userId]
    );
    await audit(
      connection,
      userId,
      "hosted_collection.deleted",
      collectionId,
      { source: "desktop" }
    );
    await connection.query("COMMIT");
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
  return true;
}

export async function revokeHostedReplicaForUser(
  options: HostedServiceOptions,
  hostedReference: HostedAuthorityRegistry | undefined,
  userId: string,
  replicaId: string
): Promise<boolean> {
  const found = await options.db.query<{
    collection_id: string;
    authorized_user_id: string | null;
    revoked_at: string | null;
  }>(
    `SELECT collection_id, authorized_user_id, revoked_at
     FROM hosted_replicas
     WHERE id = $1 AND purpose = 'mirror'`,
    [replicaId]
  );
  const replica = found.rows[0];
  const access = replica
    ? await resolveHostedCollectionAccess(
        options.db,
        userId,
        replica.collection_id
      )
    : null;
  if (
    !replica
    || !access
    || !canManageHostedReplica(access, replica.authorized_user_id)
  ) {
    return false;
  }
  if (replica.revoked_at) return true;
  if (options.hostedProvider) {
    const queued = await queueHostedReplicaRevocation(
      options.db,
      replicaId,
      replica.collection_id,
      "user_request"
    );
    if (queued) {
      await new ProviderRevocationWorker(
        options.db,
        options.hostedProvider
      ).drain();
    }
  } else {
    await hostedReference!.revokeReplica(replica.collection_id, replicaId);
    await options.db.query(
      `UPDATE hosted_replicas
       SET revoked_at = now(), token_hash = NULL
       WHERE id = $1`,
      [replicaId]
    );
    await options.db.query(
      "DELETE FROM mirror_pairing_requests WHERE replica_id = $1",
      [replicaId]
    );
  }
  await audit(
    options.db,
    userId,
    "hosted_replica.revoked",
    replicaId,
    { source: "desktop" }
  );
  return true;
}

export async function narrowHostedGrantForUser(
  options: HostedServiceOptions,
  userId: string,
  grantId: string,
  requestedOperations: string[]
): Promise<{ id: string; operations: string[] } | null> {
  const active = await options.db.query<{
    id: string;
    hosted_replica_id: string;
    operations: string[];
    scope: GrantScope;
    requirements: ApplicationRequirements;
    template: HostedTemplate;
    hosted_contracts: CollectionContractDescriptor[];
  }>(
    `SELECT g.id, g.hosted_replica_id, g.operations, g.scope,
            a.requirements, h.template,
            h.contracts AS hosted_contracts
     FROM grants g
     JOIN applications a ON a.id = g.application_id
     JOIN hosted_collections h ON h.id = g.hosted_collection_id
     WHERE g.id = $1 AND g.user_id = $2 AND g.revoked_at IS NULL
       AND g.activated_at IS NOT NULL`,
    [grantId, userId]
  );
  const current = active.rows[0];
  if (!current) return null;
  const operations = [...new Set(requestedOperations)];
  if (
    operations.some(
      (operation) => !current.operations.includes(operation)
    )
  ) {
    throw new RequestValidationError(
      "Existing access can be narrowed here, but broader access requires a new application request."
    );
  }
  assertOperationsAllowedByRequirements(operations, current.requirements);
  if (!options.hostedProvider) {
    throw new RequestValidationError(
      "Hosted application access is temporarily unavailable."
    );
  }
  const write = operations.some((operation) => [
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
  ].includes(operation));
  await options.hostedProvider.updateApplicationReplica(
    current.hosted_replica_id,
    {
      grantId,
      mode: write ? "read_write" : "read_only",
      allowedTypes: typesForContracts(
        effectiveHostedContractDescriptors(
          current.hosted_contracts,
          current.template
        ),
        current.scope.contracts
      ),
      contractScope: current.scope.access === "contract"
        ? current.scope.contracts
        : [],
      fullCollection: current.scope.access === "full_collection",
      allowedOperations: hostedReplicaCollectionOperations(operations)
    }
  );
  const updated = await options.db.query<{
    id: string;
    operations: string[];
  }>(
    `UPDATE grants SET operations = $2::jsonb
     WHERE id = $1 RETURNING id, operations`,
    [grantId, JSON.stringify(operations)]
  );
  await audit(
    options.db,
    userId,
    "grant.narrowed",
    grantId,
    {
      previous_operations: current.operations,
      operations,
      source: "desktop"
    }
  );
  return updated.rows[0] ?? null;
}

export async function revokeHostedGrantForUser(
  options: HostedServiceOptions,
  userId: string,
  grantId: string
): Promise<boolean> {
  if (!options.hostedProvider) {
    throw new RequestValidationError(
      "Hosted application access is temporarily unavailable."
    );
  }
  const queued = await queueHostedGrantRevocation(
    options.db,
    userId,
    grantId,
    "user_request"
  );
  if (!queued) return false;
  const worker = new ProviderRevocationWorker(
    options.db,
    options.hostedProvider
  );
  await worker.drain();
  await audit(
    options.db,
    userId,
    "grant.revoked",
    grantId,
    { source: "desktop" }
  );
  return true;
}

export async function permitsHostedCollectionAction(
  db: DatabasePool,
  userId: string,
  collectionId: string,
  action: CollectionAction,
  activeOnly = false
): Promise<boolean> {
  const access = await resolveHostedCollectionAccess(
    db,
    userId,
    collectionId
  );
  return Boolean(
    access
    && access.actions.has(action)
    && (!activeOnly || access.collection.authorityState === "active")
  );
}

export function canManageHostedReplica(
  access: CollectionAccessContext,
  authorizedUserId: string | null
): boolean {
  return access.actions.has("members.manage")
    || (
      authorizedUserId === access.userId
      && access.actions.has("mirror.enroll")
    );
}

export async function requireHostedReplica(
  request: FastifyRequest,
  reply: FastifyReply,
  db: DatabasePool
): Promise<{ id: string; collection_id: string } | null> {
  const bearer = bearerToken(request);
  if (!bearer) {
    reply.code(401).send(apiError(
      "invalid_replica_token",
      "Replica token required."
    ));
    return null;
  }
  const result = await db.query<{
    id: string;
    collection_id: string;
  }>(
    `SELECT id, collection_id FROM hosted_replicas
     WHERE token_hash = $1 AND revoked_at IS NULL`,
    [tokenHash(bearer)]
  );
  if (!result.rows[0]) {
    reply.code(401).send(apiError(
      "invalid_replica_token",
      "Replica token is invalid or revoked."
    ));
    return null;
  }
  return result.rows[0];
}

function normalizedApplicationOrigin(value: string): string {
  return value === "null" ? "null" : new URL(value).origin;
}

function sqlPlaceholders(count: number): string {
  return Array.from(
    { length: count },
    (_, index) => `$${index + 1}`
  ).join(", ");
}
