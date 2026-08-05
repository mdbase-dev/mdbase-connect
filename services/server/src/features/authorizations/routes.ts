import { randomUUID } from "node:crypto";
import type {
  ApplicationNotifications,
  ApplicationRequirements,
  CollectionContractDescriptor,
  CollectionTypeDescriptor,
  FileCapability,
  GrantEncryption,
  GrantScope
} from "@mdbase-dev/connect-protocol";
import { OPERATION_TRANSPORT_PROTOCOL_VERSION } from "@mdbase-dev/connect-protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { verifyApplicationAuthorization } from "../../application-authorization.js";
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
import {
  contractRequirements,
  effectiveHostedContractDescriptors,
  typesForContracts
} from "../../hosted.js";
import type { HostedProviderClient } from "../../hosted-provider.js";
import { hostedReplicaCollectionOperations } from "../../hosted-replica-policy.js";
import { planCollectionGrant } from "../../grant-planner.js";
import {
  canonicalUserCode,
  randomToken,
  randomUserCode,
  tokenHash
} from "../../security.js";
import { contractSetupChoiceSchema } from "../../protocol-schemas.js";
import { audit } from "../../platform/audit-events.js";
import { apiError } from "../../platform/http-errors.js";
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
  approveHostedAuthorization,
  approvePortalAuthorization,
  denyAuthorization
} from "./approval-service.js";
import { registerGrantRevocationRoute } from "./grant-revocation-route.js";
import { registerAuthorizationPollingRoutes } from "./polling-routes.js";
import {
  createAuthorizationRedirect,
  deniedAuthorizationRedirect
} from "./redirects.js";
import type { AuthorizationRouteOptions } from "./route-options.js";

const operationSchema = z.enum(COLLECTION_OPERATIONS);
const DEVICE_POLL_INTERVAL_SECONDS = 5;

export function registerAuthorizationRoutes(
  app: FastifyInstance,
  options: AuthorizationRouteOptions
): void {
  const relay = options.relay;
  const publicUrl = options.publicUrl;
  registerGrantRevocationRoute(app, options);
  app.post("/v1/connectors/authorization-requests/:requestId/approve", async (request, reply) => {
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return;
    z.object({ requestId: z.uuid() }).parse(request.params);
    return reply.code(409).send(apiError(
      "portal_activation_required",
      "Approve this signed request in the portal."
    ));
  });

  app.post("/v1/connectors/authorization-requests/:requestId/deny", async (request, reply) => {
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return;
    z.object({ requestId: z.uuid() }).parse(request.params);
    return reply.code(409).send(apiError(
      "portal_activation_required",
      "Deny this signed request in the portal."
    ));
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
      application_authorization: z.string().min(1).max(16_384)
    }).strict().parse(request.body);
    const application = await options.db.query<{
      id: string;
      distribution: "web" | "portable";
      manifest_digest: string | null;
      requirements: ApplicationRequirements;
    }>(
      "SELECT id, distribution, manifest_digest, requirements FROM applications WHERE id = $1",
      [input.client_id]
    );
    if (
      !application.rows[0]
      || application.rows[0].distribution !== "portable"
      || !application.rows[0].manifest_digest
    ) {
      return reply.code(400).send(apiError(
        "invalid_client",
        "Only a registered portable application can use device authorization."
      ));
    }
    const requestedOperations = [...new Set(
      input.operations.split(",").map((value) => value.trim()).filter(Boolean)
    )]
      .map((value) => operationSchema.parse(value));
    if (requestedOperations.length === 0 && !application.rows[0].requirements.files) {
      return reply.code(400).send(apiError(
        "invalid_operations",
        "At least one record operation or file capability is required."
      ));
    }
    assertOperationsAllowedByRequirements(
      requestedOperations,
      application.rows[0].requirements
    );
    const proof = await verifyApplicationAuthorization(
      input.application_authorization,
      {
        applicationId: input.client_id,
        applicationManifestDigest: application.rows[0].manifest_digest,
        flow: "device_code",
        codeChallenge: input.code_challenge,
        requestedOperations,
        requestedFiles: application.rows[0].requirements.files,
        collectionId: input.collection_id
      }
    );
    const authorizationId = proof.binding.authorization_id;
    const deviceCode = randomToken("device");
    const userCode = randomUserCode();
    const inserted = await options.db.query(
      `INSERT INTO authorization_requests
         (id, user_id, application_id, flow, redirect_uri, state, code_challenge,
          requested_operations, collection_id, operation_transport_protocol,
          application_agreement_public_key, application_signing_public_key,
          application_authorization, application_installation_id,
          device_code_hash, user_code, user_code_hash,
          poll_interval_seconds, expires_at)
       VALUES ($1, NULL, $2, 'device_code', NULL, NULL, $3, $4::jsonb, $5, $6,
               $7, $8, $9::jsonb, $10, $11, $12, $13, $14,
               $15::timestamptz)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        authorizationId,
        input.client_id,
        input.code_challenge,
        JSON.stringify(requestedOperations),
        input.collection_id ?? null,
        OPERATION_TRANSPORT_PROTOCOL_VERSION,
        proof.binding.grant_agreement_public_key,
        proof.binding.grant_signing_public_key,
        JSON.stringify(proof),
        proof.binding.application_installation_id,
        tokenHash(deviceCode),
        userCode,
        tokenHash(canonicalUserCode(userCode)),
        DEVICE_POLL_INTERVAL_SECONDS,
        proof.binding.expires_at
      ]
    );
    if (!inserted.rows[0]) {
      return reply.code(400).send(apiError(
        "authorization_replayed",
        "The application authorization request has already been used."
      ));
    }
    const verificationUri = `${publicUrl}/device`;
    return reply.header("cache-control", "no-store").send({
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: verificationUri,
      verification_uri_complete: `${verificationUri}?user_code=${encodeURIComponent(userCode)}`,
      expires_in: Math.max(
        1,
        Math.floor((Date.parse(proof.binding.expires_at) - Date.now()) / 1_000)
      ),
      interval: DEVICE_POLL_INTERVAL_SECONDS
    });
  });

  app.post("/v1/grants", async (request, reply) => {
    const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
    if (!user) return;
    const input = z.object({
      application_id: z.uuid(),
      collection_id: z.uuid(),
      operations: z.array(operationSchema)
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
    return reply.code(409).send(apiError(
      "application_authorization_required",
      "Start the application's signed authorization flow before granting local access."
    ));
  });

  app.patch("/v1/grants/:grantId", async (request, reply) => {
    const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
    if (!user) return;
    const { grantId } = z.object({ grantId: z.uuid() }).parse(request.params);
    const input = z.object({
      operations: z.array(operationSchema)
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
      file_capability: FileCapability | null;
      application_origin: string;
      proof_public_key: string;
    }>(
      `SELECT g.id, g.operations, g.encryption, g.scope, g.file_capability,
              g.application_origin, g.proof_public_key,
              a.requirements, col.connector_id,
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
      const write = operations.some((operation) => ["create", "update", "delete", "rename", "create_type", "update_type", "apply_type_pack", "create_view_source", "update_view_source", "delete_view_source", "put_timer", "cancel_timer", "reconcile_timers"].includes(operation))
        || current.file_capability?.actions.some((action) => ["add", "replace", "move", "delete"].includes(action)) === true;
      await options.hostedProvider.updateApplicationReplica(current.hosted_replica_id, {
        grantId,
        mode: write ? "read_write" : "read_only",
        allowedTypes: typesForContracts(
          effectiveHostedContractDescriptors(current.hosted_contracts, current.template!),
          current.scope.contracts
        ),
        contractScope: current.scope.access === "contract" ? current.scope.contracts : [],
        fullCollection: current.scope.access === "full_collection",
        allowedOperations: hostedReplicaCollectionOperations(operations),
        fileCapability: current.file_capability ?? undefined,
        allowedOrigin: current.application_origin,
        proofPublicKey: current.proof_public_key
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

  app.post("/oauth/authorization_request", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const input = z.object({
      client_id: z.uuid(),
      redirect_uri: z.url(),
      code_challenge: z.string().min(43).max(128),
      code_challenge_method: z.literal("S256"),
      state: z.string().min(1).max(500),
      operations: z.string().default("read,query"),
      collection_id: z.uuid().optional(),
      application_authorization: z.string().min(1).max(16_384)
    }).strict().parse(request.body);
    const application = await options.db.query<{
      id: string;
      distribution: "web" | "portable";
      manifest_digest: string | null;
      redirect_uris: string[];
      requirements: ApplicationRequirements;
    }>(
      "SELECT id, distribution, manifest_digest, redirect_uris, requirements FROM applications WHERE id = $1",
      [input.client_id]
    );
    if (
      !application.rows[0]
      || application.rows[0].distribution !== "web"
      || !application.rows[0].manifest_digest
      || !application.rows[0].redirect_uris.includes(input.redirect_uri)
    ) {
      return reply.code(400).send(apiError("invalid_client", "Unknown application or redirect URI."));
    }
    const requestedOperations = [...new Set(
      input.operations.split(",").map((value) => value.trim()).filter(Boolean)
    )].map((value) => operationSchema.parse(value));
    if (requestedOperations.length === 0 && !application.rows[0].requirements.files) {
      return reply.code(400).send(apiError(
        "invalid_operations",
        "At least one record operation or file capability is required."
      ));
    }
    assertOperationsAllowedByRequirements(requestedOperations, application.rows[0].requirements);
    const proof = await verifyApplicationAuthorization(
      input.application_authorization,
      {
        applicationId: input.client_id,
        applicationManifestDigest: application.rows[0].manifest_digest,
        flow: "authorization_code",
        redirectUri: input.redirect_uri,
        state: input.state,
        codeChallenge: input.code_challenge,
        requestedOperations,
        requestedFiles: application.rows[0].requirements.files,
        collectionId: input.collection_id
      }
    );
    const authorizationId = proof.binding.authorization_id;
    const inserted = await options.db.query(
      `INSERT INTO authorization_requests
         (id, user_id, application_id, redirect_uri, state, code_challenge,
          requested_operations, collection_id, operation_transport_protocol,
          application_agreement_public_key, application_signing_public_key,
          application_authorization, application_installation_id,
          expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11,
               $12::jsonb, $13, $14::timestamptz)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        authorizationId,
        null,
        input.client_id,
        input.redirect_uri,
        input.state,
        input.code_challenge,
        JSON.stringify(requestedOperations),
        input.collection_id ?? null,
        OPERATION_TRANSPORT_PROTOCOL_VERSION,
        proof.binding.grant_agreement_public_key,
        proof.binding.grant_signing_public_key,
        JSON.stringify(proof),
        proof.binding.application_installation_id,
        proof.binding.expires_at
      ]
    );
    if (!inserted.rows[0]) {
      return reply.code(400).send(apiError(
        "authorization_replayed",
        "The application authorization request has already been used."
      ));
    }
    return reply.header("cache-control", "no-store").send({
      authorization_id: authorizationId,
      authorization_uri: `${publicUrl}/oauth/authorize?request_id=${encodeURIComponent(authorizationId)}`,
      expires_in: Math.max(
        1,
        Math.floor((Date.parse(proof.binding.expires_at) - Date.now()) / 1_000)
      )
    });
  });

  app.get("/oauth/authorize", async (request, reply) => {
    const { request_id: requestId } = z.object({
      request_id: z.uuid()
    }).strict().parse(request.query);
    const user = await authenticatedUser(request, options.db, options.tailscaleAuth);
    if (!user) {
      const returnTo = `${publicUrl}${request.url}`;
      return reply.redirect(`/login?return_to=${encodeURIComponent(returnTo)}`);
    }
    const claimed = await options.db.query<{ id: string }>(
      `UPDATE authorization_requests SET user_id = $2
       WHERE id = $1 AND flow = 'authorization_code'
         AND expires_at > now() AND denied_at IS NULL
         AND (user_id IS NULL OR user_id = $2)
       RETURNING id`,
      [requestId, user.id]
    );
    if (!claimed.rows[0]) {
      return reply.code(404).send(apiError(
        "authorization_not_found",
        "Authorization request expired or was not found."
      ));
    }
    return reply.redirect(`/authorize/${requestId}`);
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
        : {
            status: "denied",
            redirect_uri: deniedAuthorizationRedirect({
              redirect_uri: value.redirect_uri!,
              state: value.state
            })
          };
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
      operations: z.array(operationSchema),
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

  registerAuthorizationPollingRoutes(app, options);
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
