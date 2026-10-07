import { randomUUID } from "node:crypto";
import { assertFreshApplicationAuthorization, type ApplicationRequirements } from "../../application-requirements.js";
import {
  type ApplicationNotifications,
  type ApplicationAuthorizationProof,
  type ApplicationProvisions,
  type CollectionContractDescriptor,
  type CollectionOperation,
  type ContractSetupChoice,
  type FileAction,
  type GrantEncryption,
  type GrantPolicy,
  type NextNoiseAuthorization,
  GRANT_ENCRYPTION_PROTOCOL_VERSION,
  isSupportedOperationTransport,
  RELAY_ENCRYPTION_SUITE
} from "@mdbase-dev/connect-protocol";
import { copyClientNoiseKeyToGrant } from "../next/client-key.js";
import { nextNoiseConsentBinding } from "../next/consent-transport.js";
import { readAccountBackend } from "../account/backend-routes.js";
import { requireCollectionAction, resolveLocalCollectionAccess, type CollectionAccessContext } from "../../collection-access.js";
import type { DatabasePool } from "../../db.js";
import { planCollectionGrant } from "../../grant-planner.js";
import { RelayUnavailableError, type RelayHub } from "../../relay.js";
import { audit } from "../../platform/audit-events.js";
import { RequestValidationError } from "../../platform/http-errors.js";
import { assertOperationsAllowedByApplication, assertCollectionSupportsOperations, requiredContractsForRequirements, requiresHostedCollection, validateContractSetupChoices, verifyContractSetupAcknowledgement } from "../grants/policy.js";
import {
  applicationOriginForRedirect,
  normalizedApplicationOrigin
} from "./redirects.js";
import { declarationIdFromFamilyIdentity } from "../applications/identity.js";

export async function approvePortalAuthorization(
  db: DatabasePool,
  relay: RelayHub,
  input: {
    requestId: string;
    userId: string;
    offerId: string;
    collectionId: string;
    operations: CollectionOperation[];
    fileActions?: FileAction[];
    peoplePermissions?: string[];
    contractSetups: ContractSetupChoice[];
  },
  authority: { connectorId: string; generation: string }
): Promise<boolean> {
  const connection = await db.connect();
  const grantId = randomUUID();
  let connectorId = "";
  const authorityGeneration = authority.generation;
  let localCollectionId = "";
  let authorityRowId = "";
  let requirements: ApplicationRequirements;
  let provisions: ApplicationProvisions;
  let applicationDeclarationId = "";
  let applicationManifestDigest = "";
  let grant: GrantPolicy;
  let nextNoise: NextNoiseAuthorization | undefined;
  let grantAccess: CollectionAccessContext;
  try {
    await connection.query("BEGIN");
    const authorization = await connection.query<{
      application_id: string;
      application_family_identity: string;
      application_manifest_digest: string;
      application_name: string;
      distribution: "web" | "portable";
      application_homepage: string;
      application_project_url: string | null;
      application_icon: string | null;
      application_declaration: unknown | null;
      requested_operations: string[];
      requirements: ApplicationRequirements;
      provisions: ApplicationProvisions;
      notifications: ApplicationNotifications;
      operation_transport_protocol: number | null;
      application_agreement_public_key: string | null;
      application_signing_public_key: string | null;
      application_authorization: ApplicationAuthorizationProof | null;
      flow: "authorization_code" | "device_code";
      redirect_uri: string | null;
      device_origin: string | null;
      collection_id: string | null;
      grant_id: string | null;
      activation_started_at: string | Date | null;
    }>(
      `SELECT ar.application_id,
              a.family_identity AS application_family_identity,
              a.manifest_digest AS application_manifest_digest,
              a.name AS application_name,
              a.distribution, a.homepage AS application_homepage,
              a.project_url AS application_project_url, a.icon AS application_icon,
              a.application_declaration,
              ar.requested_operations, a.requirements, a.provisions, a.notifications,
              ar.operation_transport_protocol, ar.application_agreement_public_key,
              ar.application_signing_public_key, ar.application_authorization,
              ar.flow, ar.redirect_uri, ar.device_origin,
              ar.collection_id, ar.grant_id, ar.activation_started_at
       FROM authorization_requests ar
       JOIN applications a ON a.id = ar.application_id
       WHERE ar.id = $1 AND ar.user_id = $2 AND ar.completed_at IS NULL
         AND ar.denied_at IS NULL AND ar.expires_at > now()
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
    if (pending.collection_id && pending.collection_id !== input.collectionId) {
      throw new RequestValidationError(
        "This authorization request is restricted to a different collection."
      );
    }
    if (pending.grant_id) {
      const started = pending.activation_started_at
        ? new Date(pending.activation_started_at).getTime()
        : Date.now();
      if (Date.now() - started < 60_000) {
        throw new RequestValidationError(
          "This authorization is already being activated. Wait a moment and try again."
        );
      }
      await connection.query(
        `UPDATE authorization_requests
         SET grant_id = NULL, activation_started_at = NULL
         WHERE id = $1`,
        [input.requestId]
      );
      await connection.query(
        "DELETE FROM grants WHERE id = $1 AND activated_at IS NULL",
        [pending.grant_id]
      );
    }
    if (
      !pending.application_authorization
      || !isSupportedOperationTransport(pending.operation_transport_protocol ?? 0)
      || !pending.application_agreement_public_key
      || !pending.application_signing_public_key
    ) {
      throw new RequestValidationError(
        "Local access requires a signed, encrypted application authorization request."
      );
    }
    if (pending.flow === "device_code" && pending.distribution !== "portable") {
      throw new RequestValidationError(
        "Device authorization is reserved for downloaded applications."
      );
    }
    if (requiresHostedCollection(pending.requirements)) {
      throw new RequestValidationError("This application requires an mdbase cloud collection.");
    }
    const offer = await connection.query<{
      connector_id: string;
      authority_row_id: string;
      local_id: string;
      display_name: string;
      spec_version: string;
      contracts: CollectionContractDescriptor[];
      relay_public_key: string | null;
      authority_epoch: string | number;
    }>(
      `SELECT offer.connector_id, offer.collection_id AS authority_row_id,
              offer.local_id, col.display_name, col.spec_version,
              col.contracts, con.relay_public_key, col.authority_epoch
       FROM authorization_collection_offers offer
       JOIN collections col ON col.id = offer.collection_id
       JOIN connectors con ON con.id = offer.connector_id
       WHERE offer.id = $1 AND offer.authorization_id = $2
         AND offer.user_id = $3 AND offer.local_id = $4
         AND offer.consumed_at IS NULL AND offer.expires_at > now()
         AND col.present = true AND col.enabled = true
         AND col.authority_state = 'active'
         AND col.authority_epoch = offer.authority_epoch
         AND con.revoked_at IS NULL AND con.id = $5
         AND con.inventory_revision >= offer.inventory_revision
       FOR UPDATE`,
      [input.offerId, input.requestId, input.userId, input.collectionId, authority.connectorId]
    );
    const selected = offer.rows[0];
    if (!selected) {
      throw new RequestValidationError(
        "That collection is no longer being offered by a live connector. Refresh and choose again."
      );
    }
    if (relay.authorizationAuthority(
      selected.connector_id, pending.application_authorization.binding.contracts
    ) !== authorityGeneration) {
      throw new RelayUnavailableError();
    }
    grantAccess = requireCollectionAction(
      await resolveLocalCollectionAccess(
        connection,
        input.userId,
        selected.authority_row_id
      ),
      "application.authorize"
    );
    if (input.contractSetups.length > 0) {
      requireCollectionAction(grantAccess, "schema.manage");
    }
    validateContractSetupChoices(
      input.contractSetups,
      requiredContractsForRequirements(pending.requirements),
      selected.contracts
    );
    const plan = planCollectionGrant({
      requestedOperations: input.operations,
      applicationOperationCeiling:
        pending.requested_operations as CollectionOperation[],
      requestedFileActions: input.fileActions,
      requestedPeoplePermissions: input.peoplePermissions,
      requirements: pending.requirements,
      access: grantAccess
    });
    const operations = plan.operations;
    assertCollectionSupportsOperations(selected.spec_version, operations);
    const scope = plan.scope;
    const backend = await readAccountBackend(connection, input.userId);
    if (backend === "next") {
      const noiseDevice = relay.nextNoiseConsentDevice(selected.connector_id, authorityGeneration);
      if (!noiseDevice) throw new RelayUnavailableError();
      nextNoise = await nextNoiseConsentBinding(connection, {
        deviceId: noiseDevice, connectorId: selected.connector_id, accountId: input.userId,
        collectionId: selected.local_id, authorizationId: input.requestId, proof: pending.application_authorization
      });
      if (relay.nextNoiseConsentDevice(selected.connector_id, authorityGeneration) !== noiseDevice) throw new RelayUnavailableError();
    } else if (!selected.relay_public_key) {
      throw new RequestValidationError(
        "Encrypted application authorization requires an up-to-date connector."
      );
    }
    const encryption: GrantEncryption | undefined = nextNoise ? undefined : {
      protocol_version: GRANT_ENCRYPTION_PROTOCOL_VERSION,
      suite: RELAY_ENCRYPTION_SUITE,
      key_id: `enc_${randomUUID()}`,
      scope_epoch: 1,
      connector_id: selected.connector_id,
      collection_id: selected.local_id,
      application_agreement_public_key: pending.application_agreement_public_key,
      connector_agreement_public_key: selected.relay_public_key!
    };
    const applicationInstallationId =
      pending.application_authorization.binding.application_installation_id;
    const applicationOrigin = pending.flow === "device_code"
      ? pending.device_origin ?? "null"
      : applicationOriginForRedirect(
          pending.redirect_uri!,
          pending.application_homepage
        );
    const inserted = await connection.query<{ created_at: string | Date }>(
      `INSERT INTO grants
         (id, user_id, application_id, collection_id, operations, scope, encryption,
          file_capability, application_origin, notification_criteria,
          application_authorization, application_installation_id, activated_at,
          people_permissions, next_noise)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb,
               $9, $10::jsonb, $11::jsonb, $12, NULL, $13::jsonb, $14::jsonb)
       RETURNING created_at`,
      [
        grantId,
        input.userId,
        pending.application_id,
        selected.authority_row_id,
        JSON.stringify(operations),
        JSON.stringify(scope),
        encryption ? JSON.stringify(encryption) : null,
        plan.fileCapability ? JSON.stringify(plan.fileCapability) : null,
        applicationOrigin,
        JSON.stringify(pending.notifications.criteria),
        JSON.stringify(pending.application_authorization),
        applicationInstallationId,
        plan.peoplePermissions ? JSON.stringify(plan.peoplePermissions) : null,
        nextNoise ? JSON.stringify(nextNoise) : null
      ]
    );
    await connection.query(
      `UPDATE authorization_requests
       SET grant_id = $2,
           activation_started_at = now()
       WHERE id = $1`,
      [input.requestId, grantId]
    );
    await copyClientNoiseKeyToGrant(connection, input.requestId, grantId);
    connectorId = selected.connector_id;
    localCollectionId = selected.local_id;
    authorityRowId = selected.authority_row_id;
    requirements = pending.requirements;
    provisions = pending.provisions;
    applicationDeclarationId = declarationIdFromFamilyIdentity(
      pending.application_family_identity
    );
    applicationManifestDigest = pending.application_manifest_digest;
    grant = {
      id: grantId,
      application_id: pending.application_id,
      application_declaration_id: applicationDeclarationId,
      application_manifest_digest: applicationManifestDigest,
      collection_id: selected.local_id,
      operations: operations as GrantPolicy["operations"],
      scope,
      application_name: pending.application_name,
      application_distribution: pending.distribution,
      application_homepage: pending.application_homepage,
      ...(pending.application_project_url
        ? { application_project_url: pending.application_project_url }
        : {}),
      application_origin: normalizedApplicationOrigin(applicationOrigin),
      ...(pending.application_icon ? { application_icon: pending.application_icon } : {}),
      collection_name: selected.display_name,
      notification_criteria: pending.notifications.criteria,
      created_at: new Date(inserted.rows[0].created_at).toISOString(),
      ...(encryption ? { encryption } : {}),
      ...(nextNoise ? { next_noise: nextNoise } : {}),
      ...(plan.fileCapability ? { file_capability: plan.fileCapability } : {}),
      ...(pending.application_declaration == null
        ? {}
        : { application_declaration: pending.application_declaration }),
      application_authorization: pending.application_authorization
    };
    await connection.query("COMMIT");
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }

  let activation: Awaited<ReturnType<RelayHub["activateAuthorization"]>>;
  try {
    activation = await relay.activateAuthorization(connectorId, {
      authorityGeneration,
      authorityRowId,
      authorizationId: input.requestId,
      applicationDeclarationId,
      applicationManifestDigest,
      collectionId: localCollectionId,
      requirements: requirements!,
      provisions: provisions!,
      contractSetups: input.contractSetups,
      grant: grant!
    });
    verifyContractSetupAcknowledgement(
      input.contractSetups,
      activation.contract_setups,
      activation.contracts
    );
  } catch (error) {
    await abandonPendingAuthorizationGrant(db, input.requestId, grantId);
    await relay.pushPolicy(connectorId);
    throw error;
  }

  const finalize = await db.connect();
  let finalizeReleased = false;
  try {
    await finalize.query("BEGIN");
    await relay.assertAuthorizationAuthority(
      connectorId, authorityGeneration, grant!.application_authorization.binding.contracts,
      finalize
    );
    const authority = await finalize.query(
      `SELECT id FROM collections WHERE id = $1 AND connector_id = $2
         AND authority_state = 'active' AND present = true FOR UPDATE`,
      [authorityRowId, connectorId]
    );
    if (!authority.rows[0]) {
      throw new RequestValidationError("The selected collection authority changed during activation.");
    }
    const completed = await finalize.query(
      `UPDATE authorization_requests SET
         completed_at = now(),
         activation_started_at = NULL
       WHERE id = $1 AND user_id = $2 AND grant_id = $3
         AND completed_at IS NULL AND denied_at IS NULL
       RETURNING id`,
      [input.requestId, input.userId, grantId]
    );
    if (!completed.rows[0]) {
      throw new RequestValidationError(
        "The authorization request changed before activation completed."
      );
    }
    const finalScope = planCollectionGrant({
      requestedOperations: grant!.operations,
      applicationOperationCeiling: grant!.operations,
      requestedFileActions: grant!.file_capability?.actions,
      requirements,
      access: grantAccess!
    }).scope;
    await finalize.query(
      `UPDATE grants SET activated_at = now(), scope = $2::jsonb
       WHERE id = $1 AND activated_at IS NULL`,
      [grantId, JSON.stringify(finalScope)]
    );
    grant!.scope = finalScope;
    // Recovery is an exclusive transition for one app installation. Entering
    // the bridge retires every earlier grant; leaving it retires the live
    // recovery grant. Ordinary repeat authorizations keep their independent
    // lifecycle and must not invalidate another browser or refresh token.
    const entersRecovery = (
      grant!.application_authorization.binding.contracts
        .operation_transport_recovery ?? []
    ).length > 0;
    const superseded = [
      input.userId,
      grant!.application_id,
      authorityRowId,
      grant!.application_authorization.binding.application_installation_id,
      grantId,
      entersRecovery
    ];
    await finalize.query(
      `UPDATE access_tokens SET revoked_at = COALESCE(revoked_at, now())
       WHERE grant_id IN (
         SELECT id FROM grants
         WHERE user_id = $1 AND application_id = $2 AND collection_id = $3
           AND application_installation_id = $4 AND id <> $5
           AND revoked_at IS NULL AND activated_at IS NOT NULL
           AND ($6 OR application_authorization->'binding'->'contracts'
             ->'operation_transport_recovery' IS NOT NULL)
       )`,
      superseded
    );
    await finalize.query(
      `UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, now())
       WHERE grant_id IN (
         SELECT id FROM grants
         WHERE user_id = $1 AND application_id = $2 AND collection_id = $3
           AND application_installation_id = $4 AND id <> $5
           AND revoked_at IS NULL AND activated_at IS NOT NULL
           AND ($6 OR application_authorization->'binding'->'contracts'
             ->'operation_transport_recovery' IS NOT NULL)
       )`,
      superseded
    );
    await finalize.query(
      `UPDATE grants SET revoked_at = now()
       WHERE user_id = $1 AND application_id = $2 AND collection_id = $3
         AND application_installation_id = $4 AND id <> $5
         AND revoked_at IS NULL AND activated_at IS NOT NULL
         AND ($6 OR application_authorization->'binding'->'contracts'
           ->'operation_transport_recovery' IS NOT NULL)`,
      superseded
    );
    await finalize.query(
      `UPDATE authorization_collection_offers SET consumed_at = now()
       WHERE id = $1 AND authorization_id = $2`,
      [input.offerId, input.requestId]
    );
    await finalize.query(
      `UPDATE collections SET contracts = $2::jsonb, last_seen_at = now()
       WHERE id = $1`,
      [authorityRowId, JSON.stringify(activation.contracts)]
    );
    // The transaction still owns the user, connector-generation and collection
    // locks. Recheck in-memory liveness without another checkout or network I/O.
    if (relay.authorizationAuthority(
      connectorId, grant!.application_authorization.binding.contracts
    ) !== authorityGeneration) {
      throw new RequestValidationError("The connector session changed before publication.");
    }
    await finalize.query("COMMIT");
  } catch (error) {
    await finalize.query("ROLLBACK");
    // Compensation uses the pool; return the transaction's slot first.
    finalize.release();
    finalizeReleased = true;
    await abandonPendingAuthorizationGrant(db, input.requestId, grantId);
    await relay.pushPolicy(connectorId);
    throw error;
  } finally {
    if (!finalizeReleased) finalize.release();
  }
  await relay.pushPolicy(connectorId);
  await audit(db, input.userId, "authorization.approved", input.requestId, {
    connector_id: connectorId,
    collection_id: input.collectionId,
    operations: input.operations,
    scope: grant!.scope,
    source: "portal_live_offer"
  });
  return true;
}

async function abandonPendingAuthorizationGrant(
  db: DatabasePool,
  authorizationId: string,
  grantId: string
): Promise<void> {
  const connection = await db.connect();
  try {
    await connection.query("BEGIN");
    await connection.query(
      `UPDATE authorization_requests
       SET grant_id = NULL, activation_started_at = NULL
       WHERE id = $1 AND grant_id = $2`,
      [authorizationId, grantId]
    );
    await connection.query(
      "DELETE FROM grants WHERE id = $1 AND activated_at IS NULL",
      [grantId]
    );
    await connection.query("COMMIT");
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}
