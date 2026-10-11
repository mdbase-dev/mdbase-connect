// Approval of an application's access to a Private native collection. The grant
// row is an offer published to the collection's policy log; the replica admits the
// app only after one of the account's devices signs a grant approval for it.
import { randomUUID } from "node:crypto";
import type { ApplicationAuthorizationProof, ApplicationNotifications, ApplicationProvisions, CollectionOperation, FileAction } from "@mdbase-dev/connect-protocol";
import { isSupportedOperationTransport } from "@mdbase-dev/connect-protocol";
import { assertFreshApplicationAuthorization, type ApplicationRequirements } from "../../application-requirements.js";
import { memberAccess, ownerAccess, requireCollectionAction, type CollectionAccessContext } from "../../collection-access.js";
import type { CollectionLocator } from "../../collection-catalog.js";
import { resolveActiveMembershipPolicy } from "../../collection-policy.js";
import { lockCollectionSharingAuthority, resolveCollectionSharingAuthority } from "../../collection-sharing-authority.js";
import type { DatabaseQueryable } from "../../database-types.js";
import type { DatabasePool } from "../../db.js";
import { planCollectionGrant } from "../../grant-planner.js";
import { audit } from "../../platform/audit-events.js";
import { RequestValidationError } from "../../platform/http-errors.js";
import { CreateError, currentMember } from "../next/bootstrap-common.js";
import { copyClientNoiseKeyToGrant } from "../next/client-key.js";
import { queueNextGrantPolicy } from "../next/grant-policy.js";
import { membershipBindingForAccess } from "../../collection-membership-binding.js";
import { assertOperationsAllowedByApplication, requiresHostedCollection } from "../grants/policy.js";
import { applicationOriginForRedirect } from "./redirects.js";

/**
 * The user's access to a synced Private native collection: owner, or a member
 * with an active policy who is also a current member in the collection's log.
 * Null when the collection is not a current Private collection for this user.
 */
export async function resolveNativeCollectionAccess(db: DatabaseQueryable, userId: string, collectionId: string): Promise<CollectionAccessContext | null> {
  const authority = await resolveCollectionSharingAuthority(db, collectionId);
  if (authority?.kind !== "native") return null;
  const native = (await db.query<{ display_name: string | null }>(
    `SELECT display_name FROM next_collections WHERE collection_id = $1
     AND runtime = 'next' AND sync = 'private' AND left_sync_at IS NULL`,
    [collectionId]
  )).rows[0];
  if (!native) return null;
  try { await currentMember(db, collectionId, userId); }
  catch (error) {
    if (error instanceof CreateError) return null;
    throw error;
  }
  const locator: CollectionLocator = {
    collectionId, authorityKind: "native", authorityRowId: collectionId, ownerUserId: authority.user_id,
    authorityEpoch: 0, authorityState: "active", displayName: native.display_name ?? "New collection"
  };
  if (authority.user_id === userId) return ownerAccess(locator, userId);
  const policy = await resolveActiveMembershipPolicy(db, { collectionId, ownerUserId: authority.user_id, userId });
  return policy ? memberAccess(locator, policy) : null;
}

export async function approveNativeAuthorization(
  db: DatabasePool,
  input: {
    requestId: string;
    userId: string;
    collectionId: string;
    operations: CollectionOperation[];
    fileActions?: FileAction[];
    peoplePermissions?: string[];
  }
): Promise<boolean> {
  const connection = await db.connect();
  try {
    await connection.query("BEGIN");
    const authorization = await connection.query<{
      application_id: string;
      application_homepage: string;
      distribution: "web" | "portable";
      redirect_uri: string | null;
      device_origin: string | null;
      requested_operations: string[];
      requirements: ApplicationRequirements;
      provisions: ApplicationProvisions;
      notifications: ApplicationNotifications;
      operation_transport_protocol: number | null;
      application_signing_public_key: string | null;
      application_authorization: ApplicationAuthorizationProof | null;
      flow: "authorization_code" | "device_code";
      collection_id: string | null;
      has_client_key: boolean;
    }>(
      `SELECT ar.application_id, a.distribution, a.homepage AS application_homepage,
              ar.redirect_uri, ar.device_origin, ar.requested_operations,
              a.requirements, a.provisions, a.notifications,
              ar.operation_transport_protocol, ar.application_signing_public_key,
              ar.application_authorization, ar.flow, ar.collection_id,
              EXISTS (SELECT 1 FROM next_authorization_client_keys ck WHERE ck.request_id = ar.id) AS has_client_key
       FROM authorization_requests ar
       JOIN applications a ON a.id = ar.application_id
       WHERE ar.id = $1 AND ar.user_id = $2 AND ar.completed_at IS NULL
         AND ar.grant_id IS NULL AND ar.denied_at IS NULL AND ar.expires_at > now()
       FOR UPDATE OF ar`,
      [input.requestId, input.userId]
    );
    const pending = authorization.rows[0];
    if (!pending) {
      await connection.query("ROLLBACK");
      return false;
    }
    assertFreshApplicationAuthorization(pending.requirements);
    assertOperationsAllowedByApplication(pending.requested_operations, pending.requirements, pending.notifications, pending.provisions);
    if (pending.collection_id && pending.collection_id !== input.collectionId) {
      throw new RequestValidationError("This authorization request is restricted to a different collection.");
    }
    if (requiresHostedCollection(pending.requirements)) {
      throw new RequestValidationError("This application requires an mdbase cloud collection.");
    }
    if (pending.flow !== "authorization_code" || pending.distribution !== "web") {
      throw new RequestValidationError("Private collections are available to web applications through this approval.");
    }
    if (!isSupportedOperationTransport(pending.operation_transport_protocol ?? 0)
        || !pending.application_signing_public_key || !pending.application_authorization || !pending.has_client_key) {
      throw new RequestValidationError("Private collections require a signed, key-bound application authorization request.");
    }
    // Account and collection authority are locked and rechecked inside the transaction.
    if (!await lockCollectionSharingAuthority(connection, input.collectionId)) {
      throw new RequestValidationError("This collection is not available for application authorization.");
    }
    const access = requireCollectionAction(
      await resolveNativeCollectionAccess(connection, input.userId, input.collectionId),
      "application.authorize"
    );
    const plan = planCollectionGrant({
      requestedOperations: input.operations,
      applicationOperationCeiling: pending.requested_operations as CollectionOperation[],
      requestedFileActions: input.fileActions,
      requestedPeoplePermissions: input.peoplePermissions,
      requirements: pending.requirements,
      access
    });
    const applicationOrigin = applicationOriginForRedirect(pending.redirect_uri!, pending.application_homepage);
    const installation = pending.application_authorization.binding.application_installation_id;
    // One live grant per installation and collection: an earlier one is replaced
    // (its log grant is revoked by the grant lifecycle trigger).
    const replaced = await connection.query<{ id: string }>(
      `UPDATE grants SET revoked_at = now()
       WHERE user_id = $1 AND application_id = $2 AND application_installation_id = $3
         AND next_collection_id = $4 AND revoked_at IS NULL
       RETURNING id`,
      [input.userId, pending.application_id, installation, input.collectionId]
    );
    for (const table of ["access_tokens", "refresh_tokens"] as const) {
      await connection.query(
        `UPDATE ${table} SET revoked_at = COALESCE(revoked_at, now()) WHERE grant_id = ANY($1::uuid[])`,
        [replaced.rows.map((row) => row.id)]
      );
    }
    for (const row of replaced.rows) {
      await audit(connection, input.userId, "grant.revoked", row.id, {
        next_collection_id: input.collectionId, reason: "replaced", authorization_request_id: input.requestId
      });
    }
    // A member's grant is bound to the membership policy it was approved under, so
    // removing the member (or changing their role) revokes it with the membership.
    const membership = membershipBindingForAccess(access);
    const grantId = randomUUID();
    await connection.query(
      `INSERT INTO grants
         (id, user_id, application_id, next_collection_id, operations, scope, encryption,
          proof_public_key, application_origin, file_capability, notification_criteria,
          application_authorization, application_installation_id, people_permissions,
          logical_collection_id, membership_id, membership_policy_id, membership_policy_revision)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, NULL, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13::jsonb,
               $4, $14, $15, $16)`,
      [
        grantId, input.userId, pending.application_id, input.collectionId,
        JSON.stringify(plan.operations), JSON.stringify(plan.scope),
        pending.application_signing_public_key, applicationOrigin,
        plan.fileCapability ? JSON.stringify(plan.fileCapability) : null,
        JSON.stringify(pending.notifications.criteria),
        JSON.stringify(pending.application_authorization), installation,
        plan.peoplePermissions ? JSON.stringify(plan.peoplePermissions) : null,
        membership?.membershipId ?? null, membership?.policyId ?? null, membership?.policyRevision ?? null
      ]
    );
    await connection.query(
      "UPDATE authorization_requests SET completed_at = now(), grant_id = $2 WHERE id = $1 AND completed_at IS NULL",
      [input.requestId, grantId]
    );
    await copyClientNoiseKeyToGrant(connection, input.requestId, grantId);
    if (!await queueNextGrantPolicy(connection, grantId)) {
      throw new RequestValidationError("This collection is not available for application authorization.");
    }
    await audit(connection, input.userId, "authorization.approved", input.requestId, {
      next_collection_id: input.collectionId,
      operations: plan.operations,
      scope: plan.scope,
      source: "portal"
    });
    await connection.query("COMMIT");
    return true;
  } catch (error) {
    await connection.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}
