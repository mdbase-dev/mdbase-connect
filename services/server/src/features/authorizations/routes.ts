import { randomUUID } from "node:crypto";
import type {
  ApplicationNotifications,
  ApplicationRequirements,
  CollectionContractDescriptor,
  CollectionTypeDescriptor,
  GrantEncryption,
  GrantScope
} from "@mdbase-dev/connect-protocol";
import { ENCRYPTED_RELAY_PROTOCOL_VERSION } from "@mdbase-dev/connect-protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  accessView,
  COLLECTION_OPERATIONS,
  requireCollectionAction,
  resolveHostedCollectionAccess,
  resolveLocalCollectionAccess
} from "../../collection-access.js";
import {
  listHostedCollectionsVisibleToUser,
  resolveHostedCollection
} from "../../collection-catalog.js";
import type { DatabasePool } from "../../db.js";
import {
  contractRequirements,
  effectiveHostedContractDescriptors,
  typesForContracts
} from "../../hosted.js";
import type { HostedProviderClient } from "../../hosted-provider.js";
import { hostedReplicaCollectionOperations } from "../../hosted-replica-policy.js";
import { planCollectionGrant } from "../../grant-planner.js";
import {
  AuthorityProofError,
  verifyAuthorityRequestProof
} from "../../authority-proof.js";
import type { RelayHub } from "../../relay.js";
import {
  canonicalUserCode,
  isP256PublicKey,
  pkceChallenge,
  randomToken,
  randomUserCode,
  safeEqual,
  tokenHash
} from "../../security.js";
import {
  collectionContractDescriptorSchema,
  contractSetupChoiceSchema
} from "../../protocol-schemas.js";
import { queueHostedGrantRevocation } from "../../hosted-capability-lifecycle.js";
import { audit } from "../../platform/audit-events.js";
import { apiError, oauthError } from "../../platform/http-errors.js";
import {
  authenticatedUser,
  requireConnector,
  requireUser
} from "../../platform/request-authentication.js";
import {
  assertCollectionSupportsOperations,
  assertOperationsAllowedByRequirements,
  contractsSatisfy,
  requiredContractsForRequirements,
  requiredTypePackProvisions,
  requiresHostedCollection,
  rotateGrantEncryption
} from "../grants/policy.js";
import { createOrUpdateGrant } from "../grants/service.js";
import { liveAuthorizationCollections } from "./local-collections.js";
import {
  approveAuthorization,
  approveHostedAuthorization,
  approvePortalAuthorization,
  denyAuthorization
} from "./approval-service.js";
import {
  createAuthorizationRedirect,
  deniedAuthorizationRedirect
} from "./redirects.js";
import { issueApplicationTokens } from "./token-service.js";

const operationSchema = z.enum(COLLECTION_OPERATIONS);
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const DEVICE_AUTHORIZATION_SECONDS = 600;
const DEVICE_POLL_INTERVAL_SECONDS = 5;

interface AuthorizationRouteOptions {
  db: DatabasePool;
  relay: RelayHub;
  publicUrl: string;
  tailscaleAuth?: boolean;
  hostedCollections?: boolean;
  hostedProvider?: HostedProviderClient;
  drainProviderRevocations(): Promise<void>;
}

export function registerAuthorizationRoutes(
  app: FastifyInstance,
  options: AuthorizationRouteOptions
): void {
  const relay = options.relay;
  const publicUrl = options.publicUrl;
  app.post("/v1/connectors/authorization-requests/:requestId/approve", async (request, reply) => {
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return;
    const { requestId } = z.object({ requestId: z.uuid() }).parse(request.params);
    const input = z.object({
      collection_id: z.uuid(),
      operations: z.array(operationSchema).min(1),
      contracts: z.array(collectionContractDescriptorSchema).max(100).optional()
    }).parse(request.body);
    if (input.contracts) {
      await options.db.query(
        `UPDATE collections SET contracts = $3::jsonb, last_seen_at = now()
         WHERE connector_id = $1 AND local_id = $2 AND enabled = true
           AND present = true AND authority_state = 'active'`,
        [connector.id, input.collection_id, JSON.stringify(input.contracts)]
      );
    }
    const collection = await options.db.query<{ id: string }>(
      `SELECT id FROM collections
       WHERE connector_id = $1 AND local_id = $2 AND enabled = true
         AND present = true AND authority_state = 'active'`,
      [connector.id, input.collection_id]
    );
    if (!collection.rows[0]) return reply.code(404).send(apiError("collection_not_found", "Collection is not available on this computer."));
    const result = await approveAuthorization(options.db, relay, {
      requestId,
      userId: connector.user_id,
      connectorId: connector.id,
      collectionId: collection.rows[0].id,
      operations: input.operations,
      source: "connector"
    });
    if (!result) return reply.code(404).send(apiError("authorization_not_found", "Authorization request expired or was not found."));
    return { ok: true };
  });

  app.post("/v1/connectors/authorization-requests/:requestId/deny", async (request, reply) => {
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return;
    const { requestId } = z.object({ requestId: z.uuid() }).parse(request.params);
    const denied = await denyAuthorization(options.db, {
      requestId,
      userId: connector.user_id,
      connectorId: connector.id,
      source: "connector"
    });
    if (!denied) return reply.code(404).send(apiError("authorization_not_found", "Authorization request expired or was not found."));
    return { ok: true };
  });

  app.post("/oauth/device_authorization", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const input = z.object({
      client_id: z.uuid(),
      operations: z.string().default("read,query"),
      collection_id: z.uuid().optional(),
      code_challenge: z.string().min(43).max(128),
      code_challenge_method: z.literal("S256"),
      relay_protocol: z.coerce.number().int(),
      application_agreement_public_key: z.string().min(80).max(200),
      application_signing_public_key: z.string().min(80).max(200)
    }).strict().parse(request.body);
    if (
      input.relay_protocol !== ENCRYPTED_RELAY_PROTOCOL_VERSION
      || !isP256PublicKey(input.application_agreement_public_key)
      || !isP256PublicKey(input.application_signing_public_key)
      || input.application_agreement_public_key === input.application_signing_public_key
    ) {
      return reply.code(400).send(apiError(
        "invalid_encryption_request",
        "Portable authorization requires encrypted relay protocol 1 and independent P-256 agreement and signing keys."
      ));
    }
    const application = await options.db.query<{
      id: string;
      distribution: "web" | "portable";
      requirements: ApplicationRequirements;
    }>(
      "SELECT id, distribution, requirements FROM applications WHERE id = $1",
      [input.client_id]
    );
    if (!application.rows[0] || application.rows[0].distribution !== "portable") {
      return reply.code(400).send(apiError(
        "invalid_client",
        "Only a registered portable application can use device authorization."
      ));
    }
    const requestedOperations = [...new Set(
      input.operations.split(",").map((value) => value.trim()).filter(Boolean)
    )]
      .map((value) => operationSchema.parse(value));
    if (requestedOperations.length === 0) {
      return reply.code(400).send(apiError(
        "invalid_operations",
        "At least one collection operation is required."
      ));
    }
    assertOperationsAllowedByRequirements(
      requestedOperations,
      application.rows[0].requirements
    );
    const authorizationId = randomUUID();
    const deviceCode = randomToken("device");
    const userCode = randomUserCode();
    await options.db.query(
      `INSERT INTO authorization_requests
         (id, user_id, application_id, flow, redirect_uri, state, code_challenge,
          requested_operations, collection_id, relay_protocol,
          application_agreement_public_key, application_signing_public_key,
          device_code_hash, user_code, user_code_hash,
          poll_interval_seconds, expires_at)
       VALUES ($1, NULL, $2, 'device_code', NULL, NULL, $3, $4::jsonb, $5, $6,
               $7, $8, $9, $10, $11, $12, now() + interval '10 minutes')`,
      [
        authorizationId,
        input.client_id,
        input.code_challenge,
        JSON.stringify(requestedOperations),
        input.collection_id ?? null,
        ENCRYPTED_RELAY_PROTOCOL_VERSION,
        input.application_agreement_public_key,
        input.application_signing_public_key,
        tokenHash(deviceCode),
        userCode,
        tokenHash(canonicalUserCode(userCode)),
        DEVICE_POLL_INTERVAL_SECONDS
      ]
    );
    const verificationUri = `${publicUrl}/device`;
    return reply.header("cache-control", "no-store").send({
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: verificationUri,
      verification_uri_complete: `${verificationUri}?user_code=${encodeURIComponent(userCode)}`,
      expires_in: DEVICE_AUTHORIZATION_SECONDS,
      interval: DEVICE_POLL_INTERVAL_SECONDS
    });
  });

  app.post("/v1/grants", async (request, reply) => {
    const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
    if (!user) return;
    const input = z.object({
      application_id: z.uuid(),
      collection_id: z.uuid(),
      operations: z.array(operationSchema).min(1)
    }).parse(request.body);
    const ownership = await options.db.query<{ id: string; connector_id: string; contracts: CollectionContractDescriptor[]; spec_version: string }>(
      `SELECT col.id, col.connector_id, col.contracts, col.spec_version FROM collections col
       JOIN connectors c ON c.id = col.connector_id
       WHERE col.local_id = $1 AND col.user_id = $2
         AND col.authority_state = 'active' AND col.present = true
         AND c.revoked_at IS NULL`,
      [input.collection_id, user.id]
    );
    const collectionAccess = await resolveLocalCollectionAccess(
      options.db,
      user.id,
      ownership.rows[0]?.id ?? input.collection_id
    );
    if (
      !ownership.rows[0]
      || !collectionAccess?.actions.has("application.authorize")
    ) {
      return reply.code(404).send(apiError(
        "collection_not_found",
        "Collection not found."
      ));
    }
    const application = await options.db.query<{
      id: string;
      distribution: "web" | "portable";
      homepage: string;
      requirements: ApplicationRequirements;
      notifications: ApplicationNotifications;
    }>(
      "SELECT id, distribution, homepage, requirements, notifications FROM applications WHERE id = $1",
      [input.application_id]
    );
    if (!application.rows[0]) return reply.code(404).send(apiError("application_not_found", "Application not found."));
    if (application.rows[0].distribution === "portable") {
      return reply.code(409).send(apiError(
        "portable_approval_required",
        "Downloaded applications must use their key-bound device authorization request."
      ));
    }
    if (requiresHostedCollection(application.rows[0].requirements)) {
      return reply.code(409).send(apiError(
        "incompatible_collection",
        "This application requires an mdbase cloud collection."
      ));
    }
    assertCollectionSupportsOperations(ownership.rows[0].spec_version, input.operations);
    if (!contractsSatisfy(
      ownership.rows[0].contracts,
      requiredContractsForRequirements(application.rows[0].requirements)
    )) {
      return reply.code(409).send(apiError(
        "incompatible_collection",
        "This collection does not provide the contracts required by the application."
      ));
    }
    const plan = planCollectionGrant({
      requestedOperations: input.operations,
      applicationOperationCeiling: input.operations,
      requirements: application.rows[0].requirements,
      availableContracts: ownership.rows[0].contracts,
      access: collectionAccess
    });
    const grant = await createOrUpdateGrant(options.db, {
      userId: user.id,
      applicationId: input.application_id,
      collectionId: ownership.rows[0].id,
      operations: plan.operations,
      scope: plan.scope,
      applicationOrigin: new URL(application.rows[0].homepage).origin,
      notificationCriteria: application.rows[0].notifications.criteria
    });
    await relay.pushPolicy(ownership.rows[0].connector_id);
    await audit(options.db, user.id, "grant.created", grant.id, input);
    return reply.code(201).send({ grant });
  });

  app.patch("/v1/grants/:grantId", async (request, reply) => {
    const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
    if (!user) return;
    const { grantId } = z.object({ grantId: z.uuid() }).parse(request.params);
    const input = z.object({
      operations: z.array(operationSchema).min(1)
    }).strict().parse(request.body);
    const active = await options.db.query<{
      id: string;
      connector_id: string | null;
      hosted_replica_id: string | null;
      operations: string[];
      encryption: GrantEncryption | null;
      scope: GrantScope;
      requirements: ApplicationRequirements;
      template: string | null;
      hosted_contracts: CollectionContractDescriptor[] | null;
    }>(
      `SELECT g.id, g.operations, g.encryption, g.scope, a.requirements, col.connector_id,
              g.hosted_replica_id, hosted.template, hosted.contracts AS hosted_contracts
       FROM grants g
       JOIN applications a ON a.id = g.application_id
       LEFT JOIN collections col ON col.id = g.collection_id
       LEFT JOIN hosted_collections hosted ON hosted.id = g.hosted_collection_id
       WHERE g.id = $1 AND g.user_id = $2 AND g.revoked_at IS NULL
         AND g.activated_at IS NOT NULL`,
      [grantId, user.id]
    );
    const current = active.rows[0];
    if (!current) return reply.code(404).send(apiError("grant_not_found", "Active grant not found."));
    const operations = [...new Set(input.operations)];
    if (operations.some((operation) => !current.operations.includes(operation))) {
      return reply.code(409).send(apiError(
        "permission_expansion_requires_approval",
        "Existing access can be narrowed here, but broader access requires a new application request."
      ));
    }
    assertOperationsAllowedByRequirements(operations, current.requirements);
    if (current.hosted_replica_id) {
      if (!options.hostedProvider) {
        return reply.code(503).send(apiError("hosted_provider_unavailable", "Hosted application access is temporarily unavailable."));
      }
      const write = operations.some((operation) => ["create", "update", "delete", "rename", "create_type", "update_type", "install_type_pack", "create_view_source", "update_view_source", "delete_view_source", "put_timer", "cancel_timer", "reconcile_timers"].includes(operation));
      await options.hostedProvider.updateApplicationReplica(current.hosted_replica_id, {
        grantId,
        mode: write ? "read_write" : "read_only",
        allowedTypes: typesForContracts(
          effectiveHostedContractDescriptors(current.hosted_contracts, current.template!),
          current.scope.contracts
        ),
        contractScope: current.scope.access === "contract" ? current.scope.contracts : [],
        fullCollection: current.scope.access === "full_collection",
        allowedOperations: hostedReplicaCollectionOperations(operations)
      });
    }
    const updated = await options.db.query<{ id: string; operations: string[] }>(
      "UPDATE grants SET operations = $2::jsonb WHERE id = $1 RETURNING id, operations",
      [grantId, JSON.stringify(operations)]
    );
    if (current.encryption) await rotateGrantEncryption(options.db, grantId);
    if (current.connector_id) await relay.pushPolicy(current.connector_id);
    await audit(options.db, user.id, "grant.narrowed", grantId, {
      previous_operations: current.operations,
      operations
    });
    return { grant: updated.rows[0] };
  });

  app.delete("/v1/grants/:grantId", async (request, reply) => {
    const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
    if (!user) return;
    const { grantId } = z.object({ grantId: z.uuid() }).parse(request.params);
    const active = await options.db.query<{
      id: string;
      connector_id: string | null;
      hosted_collection_id: string | null;
      hosted_replica_id: string | null;
    }>(
      `SELECT g.id, col.connector_id, g.hosted_collection_id, g.hosted_replica_id FROM grants g
       LEFT JOIN collections col ON col.id = g.collection_id
       WHERE g.id = $1 AND g.user_id = $2 AND g.revoked_at IS NULL
         AND g.activated_at IS NOT NULL`,
      [grantId, user.id]
    );
    if (!active.rows[0]) return reply.code(404).send(apiError("grant_not_found", "Active grant not found."));
    if (active.rows[0].hosted_replica_id) {
      if (!options.hostedProvider) {
        return reply.code(503).send(apiError("hosted_provider_unavailable", "Hosted application access is temporarily unavailable."));
      }
      const queued = await queueHostedGrantRevocation(
        options.db,
        user.id,
        grantId,
        "user_request"
      );
      if (!queued) {
        return reply.code(404).send(apiError(
          "grant_not_found",
          "Active grant not found."
        ));
      }
      await options.drainProviderRevocations();
    } else {
      await options.db.query(
        "UPDATE grants SET revoked_at = now() WHERE id = $1",
        [grantId]
      );
      await options.db.query(
        "UPDATE access_tokens SET revoked_at = now() WHERE grant_id = $1",
        [grantId]
      );
      await options.db.query(
        "UPDATE refresh_tokens SET revoked_at = now() WHERE grant_id = $1",
        [grantId]
      );
    }
    if (active.rows[0].connector_id) await relay.pushPolicy(active.rows[0].connector_id);
    await audit(options.db, user.id, "grant.revoked", grantId, {});
    return { ok: true };
  });

  app.get("/oauth/authorize", async (request, reply) => {
    const query = z.object({
      client_id: z.uuid(),
      redirect_uri: z.url(),
      code_challenge: z.string().min(43).max(128),
      code_challenge_method: z.literal("S256"),
      state: z.string().max(500).optional(),
      operations: z.string().default("read,query"),
      collection_id: z.uuid().optional(),
      relay_protocol: z.coerce.number().int().optional(),
      application_agreement_public_key: z.string().min(80).max(200).optional(),
      application_signing_public_key: z.string().min(80).max(200).optional()
    }).parse(request.query);
    const encryptionRequested = query.relay_protocol !== undefined
      || query.application_agreement_public_key !== undefined
      || query.application_signing_public_key !== undefined;
    if (encryptionRequested && (
      query.relay_protocol !== ENCRYPTED_RELAY_PROTOCOL_VERSION
      || !query.application_agreement_public_key
      || !isP256PublicKey(query.application_agreement_public_key)
      || !query.application_signing_public_key
      || !isP256PublicKey(query.application_signing_public_key)
      || query.application_agreement_public_key === query.application_signing_public_key
    )) {
      return reply.code(400).send(apiError(
        "invalid_encryption_request",
        "Encrypted relay authorization requires protocol 1 and independent P-256 agreement and signing keys."
      ));
    }
    const application = await options.db.query<{
      id: string;
      distribution: "web" | "portable";
      redirect_uris: string[];
      requirements: ApplicationRequirements;
    }>(
      "SELECT id, distribution, redirect_uris, requirements FROM applications WHERE id = $1",
      [query.client_id]
    );
    if (
      !application.rows[0]
      || application.rows[0].distribution !== "web"
      || !application.rows[0].redirect_uris.includes(query.redirect_uri)
    ) {
      return reply.code(400).send(apiError("invalid_client", "Unknown application or redirect URI."));
    }
    const user = await authenticatedUser(request, options.db, options.tailscaleAuth);
    if (!user) {
      const returnTo = `${publicUrl}${request.url}`;
      return reply.redirect(`/login?return_to=${encodeURIComponent(returnTo)}`);
    }
    const requestedOperations = [...new Set(query.operations.split(","))].map((value) => operationSchema.parse(value));
    assertOperationsAllowedByRequirements(requestedOperations, application.rows[0].requirements);
    const authorizationId = randomUUID();
    await options.db.query(
      `INSERT INTO authorization_requests
         (id, user_id, application_id, redirect_uri, state, code_challenge,
          requested_operations, collection_id, relay_protocol,
          application_agreement_public_key, application_signing_public_key,
          expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11,
               now() + interval '10 minutes')`,
      [
        authorizationId,
        user.id,
        query.client_id,
        query.redirect_uri,
        query.state ?? null,
        query.code_challenge,
        JSON.stringify(requestedOperations),
        query.collection_id ?? null,
        query.relay_protocol ?? null,
        query.application_agreement_public_key ?? null,
        query.application_signing_public_key ?? null
      ]
    );
    return reply.redirect(`/authorize/${authorizationId}`);
  });

  app.post("/v1/device-authorization-requests/lookup", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
    if (!user) return;
    const input = z.object({
      user_code: z.string().min(8).max(20)
    }).strict().parse(request.body);
    const canonicalCode = canonicalUserCode(input.user_code);
    if (canonicalCode.length !== 8) {
      return reply.code(404).send(apiError(
        "device_authorization_not_found",
        "This code is invalid or has expired."
      ));
    }
    const claimed = await options.db.query<{ id: string; user_code: string }>(
      `UPDATE authorization_requests
       SET user_id = $2
       WHERE id = (
         SELECT id FROM authorization_requests
         WHERE flow = 'device_code' AND user_code_hash = $1
           AND expires_at > now() AND device_consumed_at IS NULL
           AND (user_id IS NULL OR user_id = $2)
         LIMIT 1
       )
       RETURNING id, user_code`,
      [tokenHash(canonicalCode), user.id]
    );
    const authorization = claimed.rows[0];
    if (!authorization) {
      return reply.code(404).send(apiError(
        "device_authorization_not_found",
        "This code is invalid or has expired."
      ));
    }
    await audit(options.db, user.id, "device_authorization.claimed", authorization.id, {
      user_code_suffix: canonicalCode.slice(-4)
    });
    return reply.header("cache-control", "no-store").send({
      request_id: authorization.id,
      user_code: authorization.user_code
    });
  });

  app.get("/v1/authorization-requests/:requestId", async (request, reply) => {
    const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
    if (!user) return;
    const { requestId } = z.object({ requestId: z.uuid() }).parse(request.params);
    const authorization = await options.db.query(
      `SELECT ar.id, ar.flow, ar.user_code, ar.requested_operations,
              ar.collection_id, ar.expires_at,
              a.id AS application_id, a.distribution, a.name AS application_name,
              a.homepage, a.project_url, a.icon,
              a.requirements, a.provisions, a.notifications
       FROM authorization_requests ar JOIN applications a ON a.id = ar.application_id
       WHERE ar.id = $1 AND ar.user_id = $2 AND ar.expires_at > now()
         AND ar.completed_at IS NULL AND ar.denied_at IS NULL`,
      [requestId, user.id]
    );
    if (!authorization.rows[0]) return reply.code(404).send(apiError("authorization_not_found", "Authorization request expired or was not found."));
    const local = requiresHostedCollection(authorization.rows[0].requirements)
      ? { collections: [], unavailable_connectors: [] }
      : await liveAuthorizationCollections(options.db, relay, user.id, requestId);
    const hosted = options.hostedCollections
      ? (await listHostedCollectionsVisibleToUser(options.db, user.id))
          .filter((collection) =>
            collection.locator.authorityState === "active"
          )
      : [];
    const hostedCollections = await Promise.all(hosted.map(async (collection) => {
      const access = requireCollectionAction(
        await resolveHostedCollectionAccess(
          options.db,
          user.id,
          collection.locator.collectionId
        ),
        "application.authorize"
      );
      const contracts = effectiveHostedContractDescriptors(
        collection.contracts,
        collection.template
      );
      const provisions = requiredTypePackProvisions(
        authorization.rows[0].requirements,
        authorization.rows[0].provisions,
        contractRequirements(contracts)
      );
      const types = options.hostedProvider && provisions?.length
        ? await hostedTypeCandidates(
            options.hostedProvider,
            collection.locator.collectionId
          )
        : [];
      return {
        id: collection.locator.collectionId,
        display_name: collection.locator.displayName,
        template: collection.template,
        kind: "hosted" as const,
        connector_name: "Hosted by mdbase",
        spec_version: "0.3.0",
        contracts: contractRequirements(contracts),
        types,
        access: accessView(access)
      };
    }));
    const availableCollections = [
      ...local.collections,
      ...hostedCollections
    ];
    return {
      authorization: authorization.rows[0],
      hosted_collections_available: options.hostedCollections === true,
      unavailable_connectors: local.unavailable_connectors,
      collections: requiresHostedCollection(authorization.rows[0].requirements)
        ? availableCollections.filter((collection) => collection.kind === "hosted")
        : availableCollections
    };
  });

  app.get("/v1/authorization-requests/:requestId/status", async (request, reply) => {
    const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
    if (!user) return;
    const { requestId } = z.object({ requestId: z.uuid() }).parse(request.params);
    const authorization = await options.db.query<{
      completed_at: string | null;
      denied_at: string | null;
      expires_at: string;
      flow: "authorization_code" | "device_code";
      application_id: string;
      grant_id: string | null;
      activation_started_at: string | null;
      redirect_uri: string | null;
      state: string | null;
      code_challenge: string | null;
    }>(
      `SELECT completed_at, denied_at, expires_at, application_id, grant_id,
              activation_started_at,
              flow, redirect_uri, state, code_challenge
       FROM authorization_requests
       WHERE id = $1 AND user_id = $2 AND expires_at > now()`,
      [requestId, user.id]
    );
    const value = authorization.rows[0];
    if (!value) return reply.code(404).send(apiError("authorization_not_found", "Authorization request expired or was not found."));
    if (value.denied_at) {
      return value.flow === "device_code"
        ? { status: "denied" }
        : { status: "denied", redirect_uri: deniedAuthorizationRedirect({
            redirect_uri: value.redirect_uri!,
            state: value.state
          }) };
    }
    if (value.completed_at && value.grant_id) {
      if (value.flow === "device_code") return { status: "approved" };
      return {
        status: "approved",
        redirect_uri: await createAuthorizationRedirect(options.db, publicUrl, {
          application_id: value.application_id,
          redirect_uri: value.redirect_uri!,
          state: value.state,
          code_challenge: value.code_challenge!,
          grant_id: value.grant_id
        })
      };
    }
    if (value.grant_id && value.activation_started_at) {
      return { status: "setting_up" };
    }
    return { status: "pending" };
  });

  app.post("/v1/authorization-requests/:requestId/approve", async (request, reply) => {
    const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
    if (!user) return;
    const { requestId } = z.object({ requestId: z.uuid() }).parse(request.params);
    const input = z.object({
      collection_id: z.uuid(),
      offer_id: z.uuid().optional(),
      operations: z.array(operationSchema).min(1),
      contract_setups: z.array(contractSetupChoiceSchema).max(20).default([])
    }).parse(request.body);
    let approved: boolean;
    if (input.offer_id) {
      approved = await approvePortalAuthorization(options.db, relay, {
        requestId,
        userId: user.id,
        offerId: input.offer_id,
        collectionId: input.collection_id,
        operations: input.operations,
        contractSetups: input.contract_setups
      });
    } else {
      const access = await resolveHostedCollectionAccess(
        options.db,
        user.id,
        input.collection_id
      );
      const hosted = await resolveHostedCollection(
        options.db,
        input.collection_id
      );
      if (
        !access
        || !hosted
        || hosted.locator.authorityState !== "active"
        || !options.hostedProvider
      ) {
        return reply.code(404).send(apiError("collection_not_found", "Collection not found."));
      }
      requireCollectionAction(access, "application.authorize");
      if (input.contract_setups.length > 0) {
        requireCollectionAction(access, "schema.manage");
      }
      approved = await approveHostedAuthorization(options.db, options.hostedProvider, {
        requestId,
        userId: user.id,
        collectionId: input.collection_id,
        operations: input.operations,
        contracts: effectiveHostedContractDescriptors(
          hosted.contracts,
          hosted.template
        ),
        contractSetups: input.contract_setups,
        access
      });
    }
    if (!approved) return reply.code(404).send(apiError("authorization_not_found", "Authorization request expired or was not found."));
    return { ok: true };
  });

  app.post("/v1/authorization-requests/:requestId/deny", async (request, reply) => {
    const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
    if (!user) return;
    const { requestId } = z.object({ requestId: z.uuid() }).parse(request.params);
    const denied = await denyAuthorization(options.db, {
      requestId,
      userId: user.id,
      source: "portal"
    });
    if (!denied) return reply.code(404).send(apiError("authorization_not_found", "Authorization request expired or was not found."));
    return { ok: true };
  });

  app.post("/oauth/token", async (request, reply) => {
    const input = z.discriminatedUnion("grant_type", [
      z.object({
        grant_type: z.literal("authorization_code"),
        code: z.string().min(1),
        client_id: z.uuid(),
        redirect_uri: z.url(),
        code_verifier: z.string().min(43).max(128)
      }),
      z.object({
        grant_type: z.literal("refresh_token"),
        refresh_token: z.string().min(1),
        client_id: z.uuid()
      }),
      z.object({
        grant_type: z.literal(DEVICE_GRANT_TYPE),
        device_code: z.string().min(1),
        client_id: z.uuid(),
        code_verifier: z.string().min(43).max(128)
      })
    ]).parse(request.body);

    if (input.grant_type === DEVICE_GRANT_TYPE) {
      reply.header("cache-control", "no-store");
      const device = await options.db.query<{
        id: string;
        application_id: string;
        grant_id: string | null;
        code_challenge: string;
        denied_at: string | null;
        completed_at: string | null;
        expires_at: string | Date;
        device_consumed_at: string | null;
      }>(
        `SELECT id, application_id, grant_id, code_challenge, denied_at,
                completed_at, expires_at, device_consumed_at
         FROM authorization_requests
         WHERE flow = 'device_code' AND device_code_hash = $1`,
        [tokenHash(input.device_code)]
      );
      const pending = device.rows[0];
      if (
        !pending
        || pending.application_id !== input.client_id
        || !safeEqual(pending.code_challenge, pkceChallenge(input.code_verifier))
        || pending.device_consumed_at
      ) {
        return reply.code(400).send(oauthError(
          "invalid_grant",
          "The device authorization is invalid or has already been used."
        ));
      }
      if (new Date(pending.expires_at).getTime() <= Date.now()) {
        return reply.code(400).send(oauthError(
          "expired_token",
          "The device authorization has expired."
        ));
      }
      const acceptedPoll = await options.db.query(
        `UPDATE authorization_requests SET last_polled_at = now()
         WHERE id = $1 AND device_consumed_at IS NULL
           AND (
             last_polled_at IS NULL
             OR last_polled_at <= now() - interval '5 seconds'
           )
         RETURNING id`,
        [pending.id]
      );
      if (!acceptedPoll.rows[0]) {
        return reply.code(400).send(oauthError(
          "slow_down",
          "Poll no more often than the interval returned by the device authorization endpoint."
        ));
      }
      if (pending.denied_at) {
        return reply.code(400).send(oauthError(
          "access_denied",
          "Collection access was not approved."
        ));
      }
      if (!pending.completed_at || !pending.grant_id) {
        return reply.code(400).send(oauthError(
          "authorization_pending",
          "The user has not completed the authorization request."
        ));
      }
      const connection = await options.db.connect();
      try {
        await connection.query("BEGIN");
        const consumed = await connection.query<{ grant_id: string }>(
          `UPDATE authorization_requests SET device_consumed_at = now()
           WHERE id = $1 AND device_consumed_at IS NULL
           RETURNING grant_id`,
          [pending.id]
        );
        if (!consumed.rows[0]) {
          await connection.query("ROLLBACK");
          return reply.code(400).send(oauthError(
            "invalid_grant",
            "The device authorization has already been used."
          ));
        }
        const tokens = await issueApplicationTokens(
          connection,
          options.hostedProvider,
          consumed.rows[0].grant_id
        );
        await connection.query("COMMIT");
        return tokens;
      } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
      } finally {
        connection.release();
      }
    }

    if (input.grant_type === "authorization_code") {
      const code = await options.db.query<{
        id: string;
        grant_id: string;
        application_id: string;
        redirect_uri: string;
        code_challenge: string;
      }>(
        `SELECT ac.id, ac.grant_id, ac.application_id, ac.redirect_uri,
                ac.code_challenge
         FROM authorization_codes ac
         JOIN grants g ON g.id = ac.grant_id
         JOIN users u ON u.id = g.user_id
         WHERE ac.code_hash = $1 AND ac.used_at IS NULL
           AND ac.expires_at > now() AND g.revoked_at IS NULL
           AND u.suspended_at IS NULL`,
        [tokenHash(input.code)]
      );
      const authorizationCode = code.rows[0];
      if (!authorizationCode
        || authorizationCode.application_id !== input.client_id
        || authorizationCode.redirect_uri !== input.redirect_uri
        || !safeEqual(authorizationCode.code_challenge, pkceChallenge(input.code_verifier))) {
        return reply.code(400).send(apiError("invalid_grant", "Authorization code is invalid or expired."));
      }
      const consumed = await options.db.query(
        "UPDATE authorization_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id",
        [authorizationCode.id]
      );
      if (!consumed.rows[0]) {
        return reply.code(400).send(apiError("invalid_grant", "Authorization code has already been used."));
      }
      return issueApplicationTokens(options.db, options.hostedProvider, authorizationCode.grant_id);
    }

    const refresh = await options.db.query<{
      id: string;
      grant_id: string;
      proof_public_key: string | null;
    }>(
      `SELECT rt.id, rt.grant_id, g.proof_public_key
       FROM refresh_tokens rt
       JOIN grants g ON g.id = rt.grant_id
       JOIN users u ON u.id = g.user_id
       WHERE rt.token_hash = $1 AND rt.used_at IS NULL AND rt.revoked_at IS NULL
         AND rt.expires_at > now() AND g.revoked_at IS NULL
         AND g.activated_at IS NOT NULL AND g.application_id = $2
         AND u.suspended_at IS NULL`,
      [tokenHash(input.refresh_token), input.client_id]
    );
    const current = refresh.rows[0];
    if (!current) {
      return reply.code(400).send(apiError("invalid_grant", "Refresh token is invalid or expired."));
    }
    if (current.proof_public_key) {
      const refreshBody = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: input.refresh_token,
        client_id: input.client_id
      }).toString();
      try {
        verifyAuthorityRequestProof(
          request.headers,
          current.proof_public_key,
          {
            method: "POST",
            target: "/oauth/token",
            body: refreshBody,
            credential: input.refresh_token
          }
        );
      } catch (error) {
        if (!(error instanceof AuthorityProofError)) throw error;
        return reply.code(400).send(oauthError(
          "invalid_grant",
          "The refresh request is not signed by the approved application key."
        ));
      }
    }
    const rotated = await options.db.query(
      `UPDATE refresh_tokens SET used_at = now()
       WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL RETURNING id`,
      [current.id]
    );
    if (!rotated.rows[0]) {
      return reply.code(400).send(apiError("invalid_grant", "Refresh token has already been used."));
    }
    return issueApplicationTokens(options.db, options.hostedProvider, current.grant_id);
  });
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
