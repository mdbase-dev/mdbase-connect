import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  ApplicationNotifications,
  ApplicationAuthorizationProof,
  ApplicationProvisions,
  ApplicationRequirements,
  CollectionContractDescriptor,
  CollectionOperation,
  ContractRequirement,
  ContractSetupChoice,
  GrantEncryption,
  GrantPolicy
} from "@mdbase-dev/connect-protocol";
import {
  GRANT_ENCRYPTION_PROTOCOL_VERSION,
  OPERATION_TRANSPORT_PROTOCOL_VERSION,
  RELAY_ENCRYPTION_SUITE
} from "@mdbase-dev/connect-protocol";
import {
  requireCollectionAction,
  resolveLocalCollectionAccess,
  type CollectionAccessContext
} from "../../collection-access.js";
import type { DatabasePool } from "../../db.js";
import { contractRequirements } from "../../hosted.js";
import { HostedProviderClient } from "../../hosted-provider.js";
import { hostedReplicaCollectionOperations } from "../../hosted-replica-policy.js";
import { planCollectionGrant } from "../../grant-planner.js";
import { RelayHub } from "../../relay.js";
import { randomToken } from "../../security.js";
import { audit } from "../../platform/audit-events.js";
import { RequestValidationError } from "../../platform/http-errors.js";
import {
  allowedTypesForRequirements,
  assertCollectionSupportsOperations,
  contractsSatisfy,
  requiredContractsForRequirements,
  requiredTypePackProvisions,
  requiresHostedCollection
} from "../grants/policy.js";
import { syncHostedNotificationGrant } from "../grants/service.js";
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
    contractSetups: ContractSetupChoice[];
  }
): Promise<boolean> {
  const connection = await db.connect();
  const grantId = randomUUID();
  let connectorId = "";
  let localCollectionId = "";
  let authorityRowId = "";
  let requirements: ApplicationRequirements;
  let provisions: ApplicationProvisions;
  let applicationDeclarationId = "";
  let applicationManifestDigest = "";
  let grant: GrantPolicy;
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
              ar.requested_operations, a.requirements, a.provisions, a.notifications,
              ar.operation_transport_protocol, ar.application_agreement_public_key,
              ar.application_signing_public_key, ar.application_authorization,
              ar.flow, ar.redirect_uri,
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
      || pending.operation_transport_protocol !== OPERATION_TRANSPORT_PROTOCOL_VERSION
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
         AND con.revoked_at IS NULL
         AND con.inventory_revision >= offer.inventory_revision
       FOR UPDATE`,
      [input.offerId, input.requestId, input.userId, input.collectionId]
    );
    const selected = offer.rows[0];
    if (!selected) {
      throw new RequestValidationError(
        "That collection is no longer being offered by a live connector. Refresh and choose again."
      );
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
      requirements: pending.requirements,
      availableContracts: selected.contracts,
      access: grantAccess
    });
    const operations = plan.operations;
    assertCollectionSupportsOperations(selected.spec_version, operations);
    const scope = plan.scope;
    if (!selected.relay_public_key) {
      throw new RequestValidationError(
        "Encrypted application authorization requires an up-to-date connector."
      );
    }
    const encryption: GrantEncryption = {
      protocol_version: GRANT_ENCRYPTION_PROTOCOL_VERSION,
      suite: RELAY_ENCRYPTION_SUITE,
      key_id: `enc_${randomUUID()}`,
      scope_epoch: 1,
      connector_id: selected.connector_id,
      collection_id: selected.local_id,
      application_agreement_public_key: pending.application_agreement_public_key,
      connector_agreement_public_key: selected.relay_public_key
    };
    const applicationInstallationId =
      pending.application_authorization.binding.application_installation_id;
    const applicationOrigin = pending.flow === "device_code"
      ? "null"
      : applicationOriginForRedirect(
          pending.redirect_uri!,
          pending.application_homepage
        );
    const inserted = await connection.query<{ created_at: string | Date }>(
      `INSERT INTO grants
         (id, user_id, application_id, collection_id, operations, scope, encryption,
          file_capability, application_origin, notification_criteria,
          application_authorization, application_installation_id, activated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb,
               $9, $10::jsonb, $11::jsonb, $12, NULL)
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
        applicationInstallationId
      ]
    );
    await connection.query(
      `UPDATE authorization_requests
       SET grant_id = $2,
           activation_started_at = now()
       WHERE id = $1`,
      [input.requestId, grantId]
    );
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
      encryption,
      ...(plan.fileCapability ? { file_capability: plan.fileCapability } : {}),
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
  try {
    await finalize.query("BEGIN");
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
      requirements,
      availableContracts: activation.contracts,
      access: grantAccess!
    }).scope;
    await finalize.query(
      `UPDATE grants SET activated_at = now(), scope = $2::jsonb
       WHERE id = $1 AND activated_at IS NULL`,
      [grantId, JSON.stringify(finalScope)]
    );
    grant!.scope = finalScope;
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
    await finalize.query("COMMIT");
  } catch (error) {
    await finalize.query("ROLLBACK");
    await abandonPendingAuthorizationGrant(db, input.requestId, grantId);
    await relay.pushPolicy(connectorId);
    throw error;
  } finally {
    finalize.release();
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

function verifyContractSetupAcknowledgement(
  requested: ContractSetupChoice[],
  acknowledged: ContractSetupChoice[] | undefined,
  contracts: CollectionContractDescriptor[]
): void {
  if (requested.length === 0) return;
  if (!acknowledged || !isDeepStrictEqual(acknowledged, requested)) {
    throw new RequestValidationError(
      "The collection authority did not acknowledge the exact contract setup that was approved."
    );
  }
  for (const setup of requested) {
    const contract = contracts.find((candidate) =>
      candidate.id === setup.contract.id
      && candidate.version === setup.contract.version
    );
    if (!contract) {
      throw new RequestValidationError(
        `Contract setup did not provide ${setup.contract.id} ${setup.contract.version}.`
      );
    }
    if (setup.mode === "starter") continue;
    const implementation = contract.implementations.find((candidate) =>
      candidate.type_name === setup.type_name
      && isDeepStrictEqual(candidate.fields, setup.fields)
      && isDeepStrictEqual(candidate.binding, setup.binding)
    );
    if (!implementation) {
      throw new RequestValidationError(
        `Contract setup did not apply the approved mapping to type '${setup.type_name}'.`
      );
    }
  }
}

function validateContractSetupChoices(
  setups: ContractSetupChoice[],
  required: ContractRequirement[],
  available: CollectionContractDescriptor[]
): void {
  const keys = new Set(setups.map(
    (setup) => `${setup.contract.id}@${setup.contract.version}#${setup.contract.digest}`
  ));
  if (
    keys.size !== setups.length
    || setups.some((setup) => !required.some((contract) =>
      contract.id === setup.contract.id
        && contract.version === setup.contract.version
        && contract.digest === setup.contract.digest
    ))
  ) {
    throw new RequestValidationError(
      "Contract setup may configure each contract required by this application only once."
    );
  }
  if (setups.length === 0) return;
  const missing = required.filter((contract) => !available.some((candidate) =>
    candidate.id === contract.id
      && candidate.version === contract.version
      && candidate.digest === contract.digest
  ));
  if (
    keys.size !== missing.length
    || missing.some((contract) =>
      !keys.has(`${contract.id}@${contract.version}#${contract.digest}`))
  ) {
    throw new RequestValidationError(
      "Choose starter or existing-type setup for each missing contract only."
    );
  }
}

export async function approveHostedAuthorization(
  db: DatabasePool,
  provider: HostedProviderClient,
  input: {
    requestId: string;
    userId: string;
    collectionId: string;
    operations: CollectionOperation[];
    contracts: CollectionContractDescriptor[];
    contractSetups: ContractSetupChoice[];
    access: CollectionAccessContext;
  }
): Promise<boolean> {
  const connection = await db.connect();
  let replicaId: string | null = null;
  let newReplicaId: string | null = null;
  let notificationGrantId: string | null = null;
  try {
    await connection.query("BEGIN");
    const authorization = await connection.query<{
      application_id: string;
      application_family_identity: string;
      application_manifest_digest: string;
      application_name: string;
      application_homepage: string;
      distribution: "web" | "portable";
      redirect_uri: string | null;
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
              ar.redirect_uri, ar.requested_operations,
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
    await connection.query(
      "SELECT id FROM hosted_collections WHERE id = $1 FOR UPDATE",
      [input.collectionId]
    );
    if (pending.collection_id && pending.collection_id !== input.collectionId) {
      throw new RequestValidationError(
        "This authorization request is restricted to a different collection."
      );
    }
    if (
      pending.distribution === "portable"
      && (
        pending.flow !== "device_code"
        || pending.operation_transport_protocol !== OPERATION_TRANSPORT_PROTOCOL_VERSION
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
      pending.operation_transport_protocol !== OPERATION_TRANSPORT_PROTOCOL_VERSION
      || !pending.application_agreement_public_key
      || !pending.application_signing_public_key
      || !pending.application_authorization
    ) {
      throw new RequestValidationError(
        "Hosted access requires a signed, key-bound application authorization request."
      );
    }
    const requiredContracts = requiredContractsForRequirements(pending.requirements);
    let availableDescriptors = input.contracts;
    validateContractSetupChoices(
      input.contractSetups,
      requiredContracts,
      availableDescriptors
    );
    let availableContracts = contractRequirements(availableDescriptors);
    const provisions = requiredTypePackProvisions(
      pending.requirements,
      pending.provisions,
      availableContracts
    );
    if (!provisions) {
      throw new RequestValidationError(
        "This hosted collection does not provide the contracts required by the application."
      );
    }
    const hasApplicationSetup = provisions.length > 0
      || (pending.provisions.configuration?.length ?? 0) > 0;
    if (hasApplicationSetup) {
      requireCollectionAction(input.access, "schema.manage");
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
      requirements: pending.requirements,
      availableContracts: availableDescriptors,
      access: input.access
    });
    const scope = plan.scope;
    const allowedTypes = allowedTypesForRequirements(
      availableDescriptors,
      pending.requirements
    );
    const operations = plan.operations;
    const applicationOrigin = pending.flow === "device_code"
      ? "null"
      : applicationOriginForRedirect(
          pending.redirect_uri!,
          pending.application_homepage
        );
    const allowedOrigin = pending.flow === "device_code"
      ? "null"
      : ["http:", "https:"].includes(new URL(pending.redirect_uri!).protocol)
        ? new URL(pending.redirect_uri!).origin
        : undefined;
    const applicationInstallationId =
      pending.application_authorization.binding.application_installation_id;
    const existing = await connection.query<{
      id: string;
      hosted_replica_id: string;
      application_installation_id: string | null;
    }>(
      `SELECT id, hosted_replica_id, application_installation_id
       FROM grants
       WHERE user_id = $1 AND application_id = $2
         AND hosted_collection_id = $3 AND revoked_at IS NULL
         AND hosted_replica_id IS NOT NULL
         AND (application_installation_id = $4 OR application_installation_id IS NULL)
       ORDER BY (application_installation_id = $4) DESC, created_at ASC
       FOR UPDATE`,
      [
        input.userId,
        pending.application_id,
        input.collectionId,
        applicationInstallationId
      ]
    );
    const retained = existing.rows[0];
    const grantId = retained?.id ?? randomUUID();
    replicaId = retained?.hosted_replica_id ?? randomUUID();

    for (const duplicate of existing.rows.slice(1)) {
      await provider.revokeReplica(duplicate.hosted_replica_id);
      await connection.query(
        "UPDATE hosted_replicas SET revoked_at = now() WHERE id = $1",
        [duplicate.hosted_replica_id]
      );
      await connection.query(
        "UPDATE grants SET revoked_at = now() WHERE id = $1",
        [duplicate.id]
      );
    }

    const replicaPolicy = {
      grantId,
      mode: plan.replicaMode,
      allowedTypes,
      contractScope: scope.access === "contract" ? scope.contracts : [],
      fullCollection: scope.access === "full_collection",
      allowedOperations: hostedReplicaCollectionOperations(operations),
      fileCapability: plan.fileCapability,
      allowedOrigin,
      proofPublicKey: pending.application_signing_public_key,
      applicationDeclarationId: declarationIdFromFamilyIdentity(
        pending.application_family_identity
      ),
      applicationDeclarationDigest: `sha256:${pending.application_manifest_digest}`
    };
    if (retained) {
      await provider.updateApplicationReplica(replicaId, replicaPolicy);
      await connection.query(
        `UPDATE hosted_replicas
         SET mode = $2, allowed_types = $3::jsonb, revoked_at = NULL
         WHERE id = $1`,
        [replicaId, plan.replicaMode, JSON.stringify(allowedTypes)]
      );
      await connection.query(
        `UPDATE grants SET
           operations = $2::jsonb, scope = $3::jsonb,
           proof_public_key = $4, application_origin = $5,
           file_capability = $6::jsonb, notification_criteria = $7::jsonb,
           application_authorization = $8::jsonb,
           application_installation_id = $9,
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
          applicationInstallationId
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
            allowed_types, token_hash)
         VALUES ($1, $2, $3, $4, 'application', $5, $6::jsonb, NULL)`,
        [
          replicaId,
          input.collectionId,
          input.userId,
          `${pending.application_name} application access`,
          plan.replicaMode,
          JSON.stringify(allowedTypes)
        ]
      );
      await connection.query(
        `INSERT INTO grants
            (id, user_id, application_id, hosted_collection_id, hosted_replica_id,
             operations, scope, encryption, proof_public_key, application_origin,
             file_capability, notification_criteria, application_authorization,
             application_installation_id)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, NULL, $8, $9,
                 $10::jsonb, $11::jsonb, $12::jsonb, $13)`,
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
          applicationInstallationId
        ]
      );
    }
    await connection.query(
      `UPDATE authorization_requests SET completed_at = now(), grant_id = $2
       WHERE id = $1 AND completed_at IS NULL`,
      [input.requestId, grantId]
    );
    await audit(connection, input.userId, "authorization.approved", input.requestId, {
      hosted_collection_id: input.collectionId,
      operations,
      scope,
      source: "portal"
    });
    await syncHostedNotificationGrant(connection, provider, grantId);
    await connection.query("COMMIT");
    return true;
  } catch (error) {
    await connection.query("ROLLBACK");
    if (notificationGrantId) {
      await provider
        .revokeNotificationGrant(input.collectionId, notificationGrantId)
        .catch(() => undefined);
    }
    if (newReplicaId) await provider.revokeReplica(newReplicaId).catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

export async function denyAuthorization(
  db: DatabasePool,
  input: {
    requestId: string;
    userId: string;
    connectorId?: string;
    source: "connector" | "portal";
  }
): Promise<boolean> {
  const pending = await db.query<{ id: string }>(
    `UPDATE authorization_requests SET completed_at = now(), denied_at = now()
     WHERE id = $1 AND user_id = $2 AND completed_at IS NULL
       AND grant_id IS NULL AND expires_at > now()
     RETURNING id`,
    [input.requestId, input.userId]
  );
  if (!pending.rows[0]) return false;
  await audit(db, input.userId, "authorization.denied", input.requestId, {
    ...(input.connectorId ? { connector_id: input.connectorId } : {}),
    source: input.source
  });
  return true;
}
