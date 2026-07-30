import { randomUUID } from "node:crypto";
import type {
  ApplicationNotifications,
  ApplicationProvisions,
  ApplicationRequirements,
  CollectionContractDescriptor,
  CollectionOperation,
  GrantEncryption,
  GrantPolicy,
  GrantScope
} from "@mdbase/connect-protocol";
import {
  ENCRYPTED_RELAY_PROTOCOL_VERSION,
  RELAY_ENCRYPTION_SUITE
} from "@mdbase/connect-protocol";
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
  assertOperationsAllowedByRequirements,
  contractsSatisfy,
  requiredContractsForRequirements,
  requiredTypePackProvisions,
  requiresHostedCollection,
  scopeForRequirements
} from "../grants/policy.js";
import { syncHostedNotificationGrant } from "../grants/service.js";
import {
  applicationOriginForRedirect,
  normalizedApplicationOrigin
} from "./redirects.js";

export async function approvePortalAuthorization(
  db: DatabasePool,
  relay: RelayHub,
  input: {
    requestId: string;
    userId: string;
    offerId: string;
    collectionId: string;
    operations: CollectionOperation[];
  }
): Promise<boolean> {
  const connection = await db.connect();
  const grantId = randomUUID();
  let connectorId = "";
  let localCollectionId = "";
  let authorityRowId = "";
  let requirements: ApplicationRequirements;
  let provisions: ApplicationProvisions;
  let grant: GrantPolicy;
  let grantAccess: CollectionAccessContext;
  try {
    await connection.query("BEGIN");
    const authorization = await connection.query<{
      application_id: string;
      application_name: string;
      distribution: "web" | "portable";
      application_homepage: string;
      application_project_url: string | null;
      application_icon: string | null;
      requested_operations: string[];
      requirements: ApplicationRequirements;
      provisions: ApplicationProvisions;
      notifications: ApplicationNotifications;
      relay_protocol: number | null;
      application_agreement_public_key: string | null;
      application_signing_public_key: string | null;
      flow: "authorization_code" | "device_code";
      redirect_uri: string | null;
      collection_id: string | null;
      grant_id: string | null;
      activation_started_at: string | Date | null;
    }>(
      `SELECT ar.application_id, a.name AS application_name,
              a.distribution, a.homepage AS application_homepage,
              a.project_url AS application_project_url, a.icon AS application_icon,
              ar.requested_operations, a.requirements, a.provisions, a.notifications,
              ar.relay_protocol, ar.application_agreement_public_key,
              ar.application_signing_public_key, ar.flow, ar.redirect_uri,
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
      pending.distribution === "portable"
      && (
        pending.flow !== "device_code"
        || pending.relay_protocol !== ENCRYPTED_RELAY_PROTOCOL_VERSION
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
    let encryption: GrantEncryption | undefined;
    if (pending.relay_protocol === ENCRYPTED_RELAY_PROTOCOL_VERSION) {
      if (!pending.application_agreement_public_key || !selected.relay_public_key) {
        throw new RequestValidationError(
          "Encrypted relay protocol 1 requires an up-to-date connector."
        );
      }
      encryption = {
        protocol_version: ENCRYPTED_RELAY_PROTOCOL_VERSION,
        suite: RELAY_ENCRYPTION_SUITE,
        key_id: `enc_${randomUUID()}`,
        scope_epoch: 1,
        connector_id: selected.connector_id,
        collection_id: selected.local_id,
        application_agreement_public_key: pending.application_agreement_public_key,
        connector_agreement_public_key: selected.relay_public_key
      };
    }
    const applicationOrigin = pending.flow === "device_code"
      ? "null"
      : applicationOriginForRedirect(
          pending.redirect_uri!,
          pending.application_homepage
        );
    const inserted = await connection.query<{ created_at: string | Date }>(
      `INSERT INTO grants
         (id, user_id, application_id, collection_id, operations, scope, encryption,
          application_origin, notification_criteria, activated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9::jsonb, NULL)
       RETURNING created_at`,
      [
        grantId,
        input.userId,
        pending.application_id,
        selected.authority_row_id,
        JSON.stringify(operations),
        JSON.stringify(scope),
        encryption ? JSON.stringify(encryption) : null,
        applicationOrigin,
        JSON.stringify(pending.notifications.criteria)
      ]
    );
    await connection.query(
      `UPDATE authorization_requests
       SET grant_id = $2, activation_started_at = now()
       WHERE id = $1`,
      [input.requestId, grantId]
    );
    connectorId = selected.connector_id;
    localCollectionId = selected.local_id;
    authorityRowId = selected.authority_row_id;
    requirements = pending.requirements;
    provisions = pending.provisions;
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
      ...(encryption ? { encryption } : {})
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
      collectionId: localCollectionId,
      requirements: requirements!,
      provisions: provisions!,
      grant: grant!
    });
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

export async function approveAuthorization(
  db: DatabasePool,
  relay: RelayHub,
  input: {
    requestId: string;
    userId: string;
    connectorId: string;
    collectionId: string;
    operations: string[];
    source: "connector" | "portal";
  }
): Promise<boolean> {
  const connection = await db.connect();
  const grantId = randomUUID();
  let scope: GrantScope;
  try {
    await connection.query("BEGIN");
    const authorization = await connection.query<{
    application_id: string;
    distribution: "web" | "portable";
    application_homepage: string;
    requested_operations: string[];
    requirements: ApplicationRequirements;
    notifications: ApplicationNotifications;
    relay_protocol: number | null;
    application_agreement_public_key: string | null;
    application_signing_public_key: string | null;
    flow: "authorization_code" | "device_code";
    redirect_uri: string | null;
    collection_id: string | null;
  }>(
    `SELECT ar.application_id, a.distribution, a.homepage AS application_homepage,
            ar.requested_operations, a.requirements, a.notifications,
            ar.relay_protocol, ar.application_agreement_public_key,
            ar.application_signing_public_key, ar.flow, ar.redirect_uri,
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
    if (
      pending.distribution === "portable"
      && (
        pending.flow !== "device_code"
        || pending.relay_protocol !== ENCRYPTED_RELAY_PROTOCOL_VERSION
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
    if (requiresHostedCollection(pending.requirements)) {
      throw new RequestValidationError("This application requires an mdbase cloud collection.");
    }
    if (input.operations.some((operation) => !pending.requested_operations.includes(operation))) {
      throw new RequestValidationError("Approved operations must be requested by the application.");
    }
    assertOperationsAllowedByRequirements(input.operations, pending.requirements);
    const collection = await connection.query<{
    contracts: CollectionContractDescriptor[];
    local_id: string;
    relay_public_key: string | null;
    spec_version: string;
    }>(
    `SELECT col.contracts, col.local_id, col.spec_version, con.relay_public_key
     FROM collections col JOIN connectors con ON con.id = col.connector_id
     WHERE col.id = $1 AND col.connector_id = $2 AND col.enabled = true
       AND col.present = true AND col.authority_state = 'active'
       AND con.revoked_at IS NULL`,
    [input.collectionId, input.connectorId]
    );
    scope = scopeForRequirements(
      pending.requirements,
      collection.rows[0]?.contracts ?? []
    );
    if (!collection.rows[0]) {
      throw new RequestValidationError(
        "This collection does not provide the contracts required by the application."
      );
    }
    if (
      pending.collection_id
      && pending.collection_id !== collection.rows[0].local_id
    ) {
      throw new RequestValidationError(
        "This authorization request is restricted to a different collection."
      );
    }
    assertCollectionSupportsOperations(collection.rows[0].spec_version, input.operations);
    if (!contractsSatisfy(
      collection.rows[0].contracts,
      requiredContractsForRequirements(pending.requirements)
    )) {
      throw new RequestValidationError(
        "This collection does not provide the contracts required by the application."
      );
    }
    let encryption: GrantEncryption | null = null;
    if (pending.relay_protocol === ENCRYPTED_RELAY_PROTOCOL_VERSION) {
      if (!pending.application_agreement_public_key || !collection.rows[0].relay_public_key) {
        throw new RequestValidationError(
          "Encrypted relay protocol 1 requires an up-to-date connector."
        );
      }
      encryption = {
        protocol_version: ENCRYPTED_RELAY_PROTOCOL_VERSION,
        suite: RELAY_ENCRYPTION_SUITE,
        key_id: `enc_${randomUUID()}`,
        scope_epoch: 1,
        connector_id: input.connectorId,
        collection_id: collection.rows[0].local_id,
        application_agreement_public_key: pending.application_agreement_public_key,
        connector_agreement_public_key: collection.rows[0].relay_public_key
      };
    }
    await connection.query(
    `INSERT INTO grants
       (id, user_id, application_id, collection_id, operations, scope, encryption,
        application_origin, notification_criteria)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9::jsonb)`,
    [
      grantId,
      input.userId,
      pending.application_id,
      input.collectionId,
      JSON.stringify(input.operations),
      JSON.stringify(scope),
      encryption ? JSON.stringify(encryption) : null,
      pending.flow === "device_code"
        ? "null"
        : applicationOriginForRedirect(pending.redirect_uri!, pending.application_homepage),
      JSON.stringify(pending.notifications.criteria)
    ]
    );
    await connection.query(
      "UPDATE authorization_requests SET completed_at = now(), grant_id = $2 WHERE id = $1",
      [input.requestId, grantId]
    );
    await connection.query("COMMIT");
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
  await relay.pushPolicy(input.connectorId);
  await audit(db, input.userId, "authorization.approved", input.requestId, {
    connector_id: input.connectorId,
    collection_id: input.collectionId,
    operations: input.operations,
    scope,
    source: input.source
  });
  return true;
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
    access: CollectionAccessContext;
  }
): Promise<boolean> {
  const connection = await db.connect();
  let replicaId: string | null = null;
  let notificationGrantId: string | null = null;
  try {
    await connection.query("BEGIN");
    const authorization = await connection.query<{
      application_id: string;
      application_name: string;
      application_homepage: string;
      distribution: "web" | "portable";
      redirect_uri: string | null;
      requested_operations: string[];
      requirements: ApplicationRequirements;
      provisions: ApplicationProvisions;
      notifications: ApplicationNotifications;
      relay_protocol: number | null;
      application_agreement_public_key: string | null;
      application_signing_public_key: string | null;
      flow: "authorization_code" | "device_code";
      collection_id: string | null;
    }>(
      `SELECT ar.application_id, a.name AS application_name,
              a.distribution, a.homepage AS application_homepage,
              ar.redirect_uri, ar.requested_operations,
              a.requirements, a.provisions, a.notifications,
              ar.relay_protocol, ar.application_agreement_public_key,
              ar.application_signing_public_key, ar.flow,
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
    if (pending.collection_id && pending.collection_id !== input.collectionId) {
      throw new RequestValidationError(
        "This authorization request is restricted to a different collection."
      );
    }
    if (
      pending.distribution === "portable"
      && (
        pending.flow !== "device_code"
        || pending.relay_protocol !== ENCRYPTED_RELAY_PROTOCOL_VERSION
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
      pending.relay_protocol !== ENCRYPTED_RELAY_PROTOCOL_VERSION
      || !pending.application_agreement_public_key
      || !pending.application_signing_public_key
    ) {
      throw new RequestValidationError(
        "Remote authority access requires independent agreement and signing keys."
      );
    }
    const requiredContracts = requiredContractsForRequirements(pending.requirements);
    let availableDescriptors = input.contracts;
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
    if (provisions.length > 0) {
      requireCollectionAction(input.access, "schema.manage");
      availableDescriptors = await provider.provisionTypePacks(
        input.collectionId,
        provisions
      );
      availableContracts = contractRequirements(availableDescriptors);
      await connection.query(
        "UPDATE hosted_collections SET contracts = $2::jsonb WHERE id = $1",
        [input.collectionId, JSON.stringify(availableDescriptors)]
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
    const grantId = randomUUID();
    notificationGrantId = grantId;
    replicaId = randomUUID();
    const bootstrapToken = randomToken("hsa");
    await provider.registerReplica(input.collectionId, {
      id: replicaId,
      name: `${pending.application_name} application access`,
      purpose: "application",
      mode: plan.replicaMode,
      allowedTypes,
      contractScope: scope.access === "contract" ? scope.contracts : [],
      fullCollection: scope.access === "full_collection",
      allowedOperations: hostedReplicaCollectionOperations(operations),
      allowedOrigin,
      proofPublicKey: pending.application_signing_public_key!,
      grantId,
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
          notification_criteria)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, NULL, $8, $9, $10::jsonb)`,
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
        JSON.stringify(pending.notifications.criteria)
      ]
    );
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
    if (replicaId) await provider.revokeReplica(replicaId).catch(() => undefined);
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
