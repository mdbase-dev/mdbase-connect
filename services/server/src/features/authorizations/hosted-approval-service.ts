// Approval of an application's access to a hosted collection: the hosted-provider
// half of consent, split from approval-service.ts (local collections).
import { randomUUID } from "node:crypto";
import { assertFreshApplicationAuthorization, type ApplicationRequirements } from "../../application-requirements.js";
import { type ApplicationNotifications, type ApplicationAuthorizationProof, type ApplicationProvisions, type CollectionOperation, type ContractSetupChoice, type FileAction, isSupportedOperationTransport } from "@mdbase-dev/connect-protocol";
import { isCanonicalCollectionGrantScope } from "../../application-grant-scope.js";
import { copyClientNoiseKeyToGrant } from "../next/client-key.js";
import { queueNextGrantPolicy } from "../next/grant-policy.js";
import { requireCollectionAction, resolveHostedCollectionAccess, type CollectionAccessContext } from "../../collection-access.js";
import type { DatabasePool } from "../../db.js";
import {
  matchesMembershipBinding,
  membershipBindingForAccess
} from "../../collection-membership-binding.js";
import { contractRequirements } from "../../hosted.js";
import { HostedProviderClient } from "../../hosted-provider.js";
import {
  hostedReplicaCollectionOperations,
  retainedReplicaPolicy
} from "../../hosted-replica-policy.js";
import { planCollectionGrant } from "../../grant-planner.js";
import { randomToken } from "../../security.js";
import { audit } from "../../platform/audit-events.js";
import { RequestValidationError } from "../../platform/http-errors.js";
import { assertOperationsAllowedByApplication, contractsSatisfy, requiredContractsForRequirements, requiredTypePackProvisions, validateContractSetupChoices, verifyContractSetupAcknowledgement } from "../grants/policy.js";
import { syncHostedNotificationGrant } from "../grants/service.js";
import { applicationOriginForRedirect } from "./redirects.js";
import { declarationIdFromFamilyIdentity } from "../applications/identity.js";

export async function approveHostedAuthorization(
  db: DatabasePool,
  provider: HostedProviderClient,
  input: {
    requestId: string;
    userId: string;
    collectionId: string;
    operations: CollectionOperation[];
    fileActions?: FileAction[];
    peoplePermissions?: string[];
    contractSetups: ContractSetupChoice[];
    access: CollectionAccessContext;
  }
): Promise<boolean> {
  const connection = await db.connect();
  let newReplicaId: string | null = null;
  let notificationGrantId: string | null = null;
  let retainedReplicaUpdated = false;
  let compensateRetainedReplica: (() => Promise<void>) | null = null;
  let reconcileContracts = false;
  try {
    await connection.query("BEGIN");
    const hostedCollection = await connection.query(
      `SELECT id FROM hosted_collections
       WHERE id = $1 AND quarantined_at IS NULL
       FOR UPDATE`,
      [input.collectionId]
    );

    const authorization = await connection.query<{
      application_declaration?: unknown;
      application_id: string;
      application_family_identity: string;
      application_manifest_digest: string;
      application_name: string;
      application_homepage: string;
      distribution: "web" | "portable";
      redirect_uri: string | null;
      device_origin: string | null;
      requested_operations: string[];
      requirements: ApplicationRequirements;
      provisions: ApplicationProvisions;
      notifications: ApplicationNotifications;
      operation_transport_protocol: number | null;
      application_agreement_public_key: string | null;
      application_signing_public_key: string | null;
      application_authorization: ApplicationAuthorizationProof | null;
      flow: "authorization_code" | "device_code";
      collection_id: string | null;
    }>(
      `SELECT ar.application_id,
              a.family_identity AS application_family_identity,
              a.manifest_digest AS application_manifest_digest,
              a.name AS application_name,
              a.distribution, a.homepage AS application_homepage,
              ar.redirect_uri, ar.device_origin, ar.requested_operations,
              a.application_declaration,
              a.requirements, a.provisions, a.notifications,
              ar.operation_transport_protocol, ar.application_agreement_public_key,
              ar.application_signing_public_key, ar.application_authorization, ar.flow,
              ar.collection_id
       FROM authorization_requests ar
       JOIN applications a ON a.id = ar.application_id
       WHERE ar.id = $1 AND ar.user_id = $2 AND ar.completed_at IS NULL
         AND ar.grant_id IS NULL AND ar.denied_at IS NULL AND ar.expires_at > now()
       FOR UPDATE`,
      [input.requestId, input.userId]
    );
    const pending = authorization.rows[0];
    if (!pending) {
      await connection.query("ROLLBACK");
      return false;
    }
    assertFreshApplicationAuthorization(pending.requirements);
    assertOperationsAllowedByApplication(
      pending.requested_operations,
      pending.requirements,
      pending.notifications,
      pending.provisions
    );
    const freshV2 = pending.requirements.capabilities?.contract_version === 2;
    if (freshV2) await provider.assertFreshV2AuthorizationSupport();
    const currentAccess = requireCollectionAction(
      await resolveHostedCollectionAccess(
        connection,
        input.userId,
        input.collectionId
      ),
      "application.authorize"
    );
    if (!hostedCollection.rows[0] || currentAccess.collection.authorityState !== "active") {
      throw new RequestValidationError(
        "This hosted collection is not available for application authorization."
      );
    }
    if (pending.collection_id && pending.collection_id !== input.collectionId) {
      throw new RequestValidationError(
        "This authorization request is restricted to a different collection."
      );
    }
    if (
      pending.distribution === "portable"
      && (
        pending.flow !== "device_code"
        || !isSupportedOperationTransport(pending.operation_transport_protocol ?? 0)
        || !pending.application_agreement_public_key
        || !pending.application_signing_public_key
      )
    ) {
      throw new RequestValidationError(
        "Downloaded applications require a key-bound device authorization request."
      );
    }
    if (pending.flow === "device_code" && pending.distribution !== "portable") {
      throw new RequestValidationError(
        "Device authorization is reserved for downloaded applications."
      );
    }
    if (
      !isSupportedOperationTransport(pending.operation_transport_protocol ?? 0)
      || !pending.application_agreement_public_key
      || !pending.application_signing_public_key
      || !pending.application_authorization
    ) {
      throw new RequestValidationError(
        "Hosted access requires a signed, key-bound application authorization request."
      );
    }
    const requiredContracts = requiredContractsForRequirements(pending.requirements);
    const provisions = pending.provisions.type_packs ?? [];
    const hasApplicationSetup = provisions.length > 0
      || (pending.provisions.configuration?.length ?? 0) > 0;
    // The SQL cache may have rolled back after a prior external setup committed.
    // Never use that cache as authority for missing-contract choices.
    reconcileContracts = requiredContracts.length > 0 || hasApplicationSetup;
    let availableDescriptors = reconcileContracts
      ? await provider.collectionContracts(input.collectionId) : [];
    validateContractSetupChoices(input.contractSetups, requiredContracts, availableDescriptors);
    let availableContracts = contractRequirements(availableDescriptors);
    const contractProvisions = requiredTypePackProvisions(
      pending.requirements,
      pending.provisions,
      availableContracts
    );
    if (!contractProvisions) {
      throw new RequestValidationError(
        "This hosted collection does not provide the contracts required by the application."
      );
    }
    if (hasApplicationSetup) {
      requireCollectionAction(currentAccess, "schema.manage");
      const setupResult = await provider.provisionApplicationSetup(
        input.collectionId,
        {
          applicationId: declarationIdFromFamilyIdentity(
            pending.application_family_identity
          ),
          declarationDigest: `sha256:${pending.application_manifest_digest}`,
          requirements: pending.requirements,
          provisions: {
            ...pending.provisions,
            type_packs: provisions
          },
          contractSetups: input.contractSetups
        }
      );
      if (input.contractSetups.length > 0) {
        verifyContractSetupAcknowledgement(
          input.contractSetups,
          setupResult.contractSetups,
          setupResult.contracts
        );
      }
      availableDescriptors = setupResult.contracts;
      availableContracts = contractRequirements(availableDescriptors);
    }
    if (reconcileContracts) {
      await connection.query(
        "UPDATE hosted_collections SET contracts = $2::jsonb WHERE id = $1",
        [input.collectionId, JSON.stringify(availableDescriptors)]
      );
    }
    if (!hasApplicationSetup && input.contractSetups.length > 0) {
      throw new RequestValidationError(
        "Contract setup may only implement a missing contract installed by this application."
      );
    }
    if (!contractsSatisfy(availableContracts, requiredContracts)) {
      throw new RequestValidationError(
        "This hosted collection does not provide the contracts required by the application."
      );
    }
    const plan = planCollectionGrant({
      requestedOperations: input.operations,
      applicationOperationCeiling:
        pending.requested_operations as CollectionOperation[],
      requestedFileActions: input.fileActions,
      requestedPeoplePermissions: input.peoplePermissions,
      requirements: pending.requirements,
      access: currentAccess
    });
    const scope = plan.scope;
    const allowedTypes: string[] = [];
    const operations = plan.operations;
    const applicationOrigin = pending.flow === "device_code"
      ? pending.device_origin ?? "null"
      : applicationOriginForRedirect(
          pending.redirect_uri!,
          pending.application_homepage
        );
    const allowedOrigin = applicationOrigin;
    const applicationInstallationId =
      pending.application_authorization.binding.application_installation_id;
    const membershipBinding = membershipBindingForAccess(currentAccess);
    const existing = await retainedReplicaPolicy.loadCandidates(connection, {
      userId: input.userId,
      applicationId: pending.application_id,
      collectionId: input.collectionId,
      applicationInstallationId
    });
    const retained = existing.rows.find((candidate) =>
      matchesMembershipBinding(candidate, membershipBinding)
      && isCanonicalCollectionGrantScope(candidate.scope)
      && candidate.allowed_types.length === 0
    );
    const grantId = retained?.id ?? randomUUID();
    const replicaId = retained?.hosted_replica_id ?? randomUUID();

    for (const obsolete of existing.rows.filter((candidate) =>
      candidate.id !== retained?.id
    )) {
      await connection.query(
        `UPDATE hosted_replicas
         SET revoked_at = COALESCE(revoked_at, now()), token_hash = NULL
         WHERE id = $1`,
        [obsolete.hosted_replica_id]
      );
      await connection.query(
        `UPDATE grants
         SET revoked_at = COALESCE(revoked_at, now()),
             reauthorization_required_at = COALESCE(reauthorization_required_at, now()),
             reauthorization_reason = 'collection_level_authorization'
         WHERE id = $1`,
        [obsolete.id]
      );
      await connection.query(
        "UPDATE access_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE grant_id = $1",
        [obsolete.id]
      );
      await connection.query(
        "UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE grant_id = $1",
        [obsolete.id]
      );
      const cleanup = await connection.query(
        `SELECT id FROM provider_revocation_jobs
         WHERE replica_id = $1 AND completed_at IS NULL`,
        [obsolete.hosted_replica_id]
      );
      if (cleanup.rows[0]) {
        await connection.query(
          `UPDATE provider_revocation_jobs
           SET grant_id = COALESCE(grant_id, $2)
           WHERE id = $1`,
          [cleanup.rows[0].id, obsolete.id]
        );
      } else {
        await connection.query(
          `INSERT INTO provider_revocation_jobs
             (id, replica_id, grant_id, collection_id, reason)
           VALUES ($1, $2, $3, $4, 'collection_level_authorization')`,
          [
            randomUUID(),
            obsolete.hosted_replica_id,
            obsolete.id,
            input.collectionId
          ]
        );
      }
    }

    const replicaPolicy = {
      grantId,
      mode: plan.replicaMode,
      allowedTypes,
      contractScope: [],
      fullCollection: true,
      allowedOperations: hostedReplicaCollectionOperations(operations),
      operationTransportProtocol:
        pending.application_authorization.binding.contracts.operation_transport,
      operationTransportRecoveryProtocols:
        pending.application_authorization.binding.contracts
          .operation_transport_recovery ?? [],
      fileCapability: plan.fileCapability,
      allowedOrigin,
      proofPublicKey: pending.application_signing_public_key,
      applicationDeclarationId: declarationIdFromFamilyIdentity(
        pending.application_family_identity
      ),
      applicationDeclarationDigest: `sha256:${pending.application_manifest_digest}`,
      applicationDeclaration: pending.application_declaration,
      applicationAuthorization: pending.application_authorization
    };
    if (freshV2) await provider.assertFreshV2AuthorizationSupport();
    if (retained) {
      compensateRetainedReplica = retainedReplicaPolicy.compensation(
        provider,
        replicaId,
        retained
      );
      retainedReplicaUpdated = true;
      await provider.updateApplicationReplica(replicaId, replicaPolicy);
      await connection.query(
        `UPDATE hosted_replicas
         SET mode = $2, allowed_types = $3::jsonb, revoked_at = NULL,
             membership_id = $4, membership_policy_id = $5,
             membership_policy_revision = $6
         WHERE id = $1`,
        [
          replicaId,
          plan.replicaMode,
          JSON.stringify(allowedTypes),
          membershipBinding?.membershipId ?? null,
          membershipBinding?.policyId ?? null,
          membershipBinding?.policyRevision ?? null
        ]
      );
      await connection.query(
        `UPDATE grants SET
           operations = $2::jsonb, scope = $3::jsonb,
           proof_public_key = $4, application_origin = $5,
           file_capability = $6::jsonb, notification_criteria = $7::jsonb,
           application_authorization = $8::jsonb,
           application_installation_id = $9,
           logical_collection_id = $10, membership_id = $11,
           membership_policy_id = $12, membership_policy_revision = $13,
           people_permissions = $14::jsonb,
           activated_at = now(), revoked_at = NULL
         WHERE id = $1`,
        [
          grantId,
          JSON.stringify(operations),
          JSON.stringify(scope),
          pending.application_signing_public_key,
          applicationOrigin,
          plan.fileCapability ? JSON.stringify(plan.fileCapability) : null,
          JSON.stringify(pending.notifications.criteria),
          JSON.stringify(pending.application_authorization),
          applicationInstallationId,
          input.collectionId,
          membershipBinding?.membershipId ?? null,
          membershipBinding?.policyId ?? null,
          membershipBinding?.policyRevision ?? null,
          plan.peoplePermissions ? JSON.stringify(plan.peoplePermissions) : null
        ]
      );
      await connection.query(
        "DELETE FROM refresh_tokens WHERE grant_id = $1",
        [grantId]
      );
    } else {
      newReplicaId = replicaId;
      notificationGrantId = grantId;
      const bootstrapToken = randomToken("hsa");
      await provider.registerReplica(input.collectionId, {
        id: replicaId,
        name: `${pending.application_name} application access`,
        purpose: "application",
        ...replicaPolicy,
        token: bootstrapToken,
        tokenTtlSeconds: 3_600
      });
      await connection.query(
        `INSERT INTO hosted_replicas
           (id, collection_id, authorized_user_id, name, purpose, mode,
            allowed_types, token_hash, membership_id, membership_policy_id,
            membership_policy_revision)
         VALUES ($1, $2, $3, $4, 'application', $5, $6::jsonb, NULL,
                 $7, $8, $9)`,
        [
          replicaId,
          input.collectionId,
          input.userId,
          `${pending.application_name} application access`,
          plan.replicaMode,
          JSON.stringify(allowedTypes),
          membershipBinding?.membershipId ?? null,
          membershipBinding?.policyId ?? null,
          membershipBinding?.policyRevision ?? null
        ]
      );
      await connection.query(
        `INSERT INTO grants
            (id, user_id, application_id, hosted_collection_id, hosted_replica_id,
             operations, scope, encryption, proof_public_key, application_origin,
             file_capability, notification_criteria, application_authorization,
             application_installation_id, logical_collection_id, membership_id,
             membership_policy_id, membership_policy_revision, people_permissions)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, NULL, $8, $9,
                 $10::jsonb, $11::jsonb, $12::jsonb, $13, $14, $15, $16, $17,
                 $18::jsonb)`,
        [
          grantId,
          input.userId,
          pending.application_id,
          input.collectionId,
          replicaId,
          JSON.stringify(operations),
          JSON.stringify(scope),
          pending.application_signing_public_key,
          applicationOrigin,
          plan.fileCapability ? JSON.stringify(plan.fileCapability) : null,
          JSON.stringify(pending.notifications.criteria),
          JSON.stringify(pending.application_authorization),
          applicationInstallationId,
          input.collectionId,
          membershipBinding?.membershipId ?? null,
          membershipBinding?.policyId ?? null,
          membershipBinding?.policyRevision ?? null,
          plan.peoplePermissions ? JSON.stringify(plan.peoplePermissions) : null
        ]
      );
    }
    await connection.query(
      `UPDATE authorization_requests SET completed_at = now(), grant_id = $2
       WHERE id = $1 AND completed_at IS NULL`,
      [input.requestId, grantId]
    );
    // A retained grant reactivated here takes exactly this request's attested key.
    await copyClientNoiseKeyToGrant(connection, input.requestId, grantId);
    await queueNextGrantPolicy(connection, grantId);
    await audit(connection, input.userId, "authorization.approved", input.requestId, {
      hosted_collection_id: input.collectionId,
      operations,
      scope,
      source: "portal"
    });
    await syncHostedNotificationGrant(connection, provider, grantId);
    if (freshV2) await provider.assertFreshV2AuthorizationSupport();
    await connection.query("COMMIT");
    return true;
  } catch (error) {
    await connection.query("ROLLBACK").catch(() => undefined);
    if (notificationGrantId) {
      await provider
        .revokeNotificationGrant(input.collectionId, notificationGrantId)
        .catch(() => undefined);
    }
    if (newReplicaId) await provider.revokeReplica(newReplicaId).catch(() => undefined);
    if (retainedReplicaUpdated) await compensateRetainedReplica?.();
    if (reconcileContracts) {
      // Setup is committed by a separate authority, not by this SQL transaction.
      // Refresh compatibility metadata only: never replay setup or mapping choices
      // and never issue access while compensating a failed approval.
      try {
        const contracts = await provider.collectionContracts(input.collectionId);
        await connection.query(
          "UPDATE hosted_collections SET contracts = $2::jsonb WHERE id = $1 AND quarantined_at IS NULL",
          [input.collectionId, JSON.stringify(contracts)]
        );
      } catch {
        // Preserve the original approval error. The next approval reads authority
        // metadata again, so an unavailable refresh cannot poison future setup.
      }
    }
    throw error;
  } finally {
    connection.release();
  }
}
