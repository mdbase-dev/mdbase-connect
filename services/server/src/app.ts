import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import Fastify, { LogController, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import formbody from "@fastify/formbody";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type {
  ApplicationProvisions,
  ApplicationRequirements,
  ApplicationNotifications,
  CollectionContractDescriptor,
  CollectionOperation,
  ContractRequirement,
  EncryptedRelayOperationRequest,
  GrantEncryption,
  GrantPolicy,
  GrantScope,
  NotificationCriterion,
  TypePackProvision
} from "@mdbase/connect-protocol";
import {
  CONTROL_PROTOCOL_VERSION,
  ENCRYPTED_RELAY_PROTOCOL_VERSION,
  RELAY_ENCRYPTION_SUITE
} from "@mdbase/connect-protocol";
import { z } from "zod";
import { SyncError } from "@mdbase/connect-sync";
import type { DatabasePool, DatabaseQueryable } from "./db.js";
import {
  registerApplicationManifest,
  type RegisteredApplicationManifest
} from "./manifest.js";
import { ConnectorOperationError, RelayHub, RelayUnavailableError } from "./relay.js";
import type { RelayBroker } from "./relay-broker.js";
import {
  canonicalUserCode,
  isP256PublicKey,
  pkceChallenge,
  randomToken,
  randomUserCode,
  safeEqual,
  tokenHash
} from "./security.js";
import {
  collectionContractDescriptorSchema
} from "./protocol-schemas.js";
import {
  asSyncMutation,
  contractRequirements,
  effectiveHostedContractDescriptors,
  hostedContractDescriptors,
  HostedAuthorityRegistry,
  typesForContracts,
  type HostedTemplate
} from "./hosted.js";
import {
  HostedProviderClient,
  HostedProviderResponseError
} from "./hosted-provider.js";
import { hostedReplicaCollectionOperations } from "./hosted-replica-policy.js";
import {
  AuthorityProofError,
  verifyAuthorityRequestProof
} from "./authority-proof.js";
import type { GitHubAuthConfig } from "./github-auth.js";
import { AuthenticationPolicyStore } from "./authentication-policy.js";
import type { GoogleAuthConfig } from "./google-auth.js";
import type {
  AuthenticationLegalDocuments,
  RegistrationMode
} from "./runtime-config.js";
import {
  activeGrantForToken,
  NotificationService,
  type NotificationTransports
} from "./notifications.js";
import type { EmailTransport } from "./email.js";
import {
  accessView,
  COLLECTION_OPERATIONS,
  requireCollectionAction,
  resolveHostedCollectionAccess,
  resolveLocalCollectionAccess,
  type CollectionAction,
  type CollectionAccessContext
} from "./collection-access.js";
import {
  listLocalCollectionsVisibleToUser,
  listHostedCollectionsVisibleToUser,
  resolveHostedCollection
} from "./collection-catalog.js";
import { planCollectionGrant } from "./grant-planner.js";
import {
  ProviderRevocationWorker,
  queueHostedGrantRevocation
} from "./hosted-capability-lifecycle.js";
import { registerErrorHandler } from "./platform/error-handler.js";
import {
  apiError,
  oauthError,
  RequestValidationError
} from "./platform/http-errors.js";
import { registerSystemRoutes } from "./features/system/routes.js";
import { registerPasswordAuthRoutes } from "./features/auth/password-routes.js";
import { registerExternalAuthRoutes } from "./features/auth/external-routes.js";
import {
  registerConnectorPairingRoutes
} from "./features/connectors/pairing-routes.js";
import { registerAccountSessionRoutes } from "./features/account/session-routes.js";
import { registerMirrorPairingRoutes } from "./features/mirrors/pairing-routes.js";
import {
  registerConnectorManagementRoutes
} from "./features/connectors/management-routes.js";
import {
  registerConnectorInventoryRoutes
} from "./features/connectors/inventory-routes.js";
import {
  registerAuthorityConflictRoutes
} from "./features/connectors/authority-conflict-routes.js";
import {
  registerConnectorControlRoutes
} from "./features/connectors/control-routes.js";
import {
  registerAuthorityAdoptionRoutes
} from "./features/authority-adoption/routes.js";
import {
  authorityImportTransferView,
  authorityPairing,
  authorityTransferResponse,
  authorityTransferView,
  mirrorAuthorityTransfer,
  recoverExpiredAuthorityTransfers,
  retireAuthorityCandidates,
  type AuthorityImportTransferRow,
  type AuthorityTransferDetails,
  type AuthorityTransferRow
} from "./features/authority-transfer/lifecycle.js";
import {
  registerHostedToLocalTransferRoutes
} from "./features/authority-transfer/hosted-to-local-routes.js";
import {
  registerLocalToHostedTransferRoutes
} from "./features/authority-transfer/local-to-hosted-routes.js";
import {
  registerNotificationRoutes
} from "./features/notifications/routes.js";
import {
  registerLocalOperationRoutes
} from "./features/operations/local-routes.js";
import {
  allowedTypesForRequirements,
  assertCollectionSupportsOperations,
  assertOperationsAllowedByRequirements,
  collectionSupportsOperations,
  contractsSatisfy,
  operationsAllowedByRequirements,
  requiredContractsForRequirements,
  requiredTypePackProvisions,
  requiresHostedCollection,
  rotateGrantEncryption,
  scopeForRequirements
} from "./features/grants/policy.js";
import {
  canManageHostedReplica,
  createHostedCollectionForUser,
  deleteHostedCollectionForUser,
  hostedControlSnapshot,
  hostedMirrorReplicas,
  narrowHostedGrantForUser,
  permitsHostedCollectionAction,
  renameHostedCollectionForUser,
  requireHostedReplica,
  revokeHostedGrantForUser,
  revokeHostedReplicaForUser
} from "./features/hosted/service.js";
import {
  registerConnectorHostedRoutes
} from "./features/hosted/connector-routes.js";
import {
  registerHostedAccountRoutes
} from "./features/hosted/account-routes.js";
import {
  registerReferenceSyncRoutes
} from "./features/hosted/reference-sync-routes.js";
import {
  registerConnectorRelayRoute
} from "./features/connectors/relay-route.js";
import { sessionToken } from "./platform/session-cookies.js";
import { audit } from "./platform/audit-events.js";
import {
  authorityImportCapability,
  authorityUrl
} from "./platform/authority-url.js";
import {
  authenticatedUser,
  bearerToken,
  connectorFromRequest,
  requireConnector,
  requireUser,
  type User
} from "./platform/request-authentication.js";

const operationSchema = z.enum(COLLECTION_OPERATIONS);
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const DEVICE_AUTHORIZATION_SECONDS = 600;
const DEVICE_POLL_INTERVAL_SECONDS = 5;
interface BuildOptions {
  db: DatabasePool;
  revision?: string;
  devAuth?: boolean;
  tailscaleAuth?: boolean;
  githubAuth?: GitHubAuthConfig;
  googleAuth?: GoogleAuthConfig;
  registration?: RegistrationMode;
  authRateLimitSecret?: string;
  authenticationLegalDocuments?: AuthenticationLegalDocuments;
  emailTransport?: EmailTransport;
  hostedCollections?: boolean;
  hostedProvider?: HostedProviderClient;
  hostedReferenceAuthority?: boolean;
  publicUrl?: string;
  portalDist?: string;
  allowInsecureManifests?: boolean;
  trustProxy?: boolean;
  relayBroker?: RelayBroker;
  notifications?: {
    publicKey?: string;
    transports: NotificationTransports;
    pollIntervalMs?: number;
  };
}

export async function buildApp(options: BuildOptions) {
  const app = Fastify({
    logger: process.env.NODE_ENV !== "test",
    // OAuth callbacks carry short-lived credentials in the query string.
    // Fastify's default access log includes the complete URL.
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: options.trustProxy ?? options.tailscaleAuth === true,
    bodyLimit: 2 * 1024 * 1024,
    requestTimeout: 35_000
  });
  const publicUrl = options.publicUrl ?? "http://127.0.0.1:8787";
  const authenticationPolicy = new AuthenticationPolicyStore(
    options.db,
    options.registration ?? "closed"
  );
  const relay = new RelayHub(options.db, options.relayBroker);
  const notifications = options.notifications
    ? new NotificationService(
        options.db,
        options.notifications.transports,
        options.notifications.pollIntervalMs,
        (error) => app.log.error({ err: error }, "notification delivery worker failed")
      )
    : undefined;
  if (options.hostedProvider && options.hostedReferenceAuthority) {
    throw new Error("Hosted provider and reference authority modes are mutually exclusive.");
  }
  if (options.hostedCollections && !options.hostedProvider && !options.hostedReferenceAuthority) {
    throw new Error("Hosted collections require a configured storage provider.");
  }
  const hostedReference = options.hostedReferenceAuthority
    ? new HostedAuthorityRegistry(options.db)
    : undefined;
  const providerRevocations = options.hostedProvider
    ? new ProviderRevocationWorker(
        options.db,
        options.hostedProvider,
        (error) => app.log.error(
          { err: error },
          "hosted provider revocation worker failed"
        )
      )
    : undefined;

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'", ...(options.googleAuth ? ["https://accounts.google.com/gsi/"] : [])],
        fontSrc: ["'self'", "data:"],
        formAction: ["'self'"],
        frameSrc: options.googleAuth ? ["https://accounts.google.com/gsi/"] : ["'none'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'", ...(options.googleAuth ? ["https://accounts.google.com/gsi/client"] : [])],
        styleSrc: ["'self'", "'unsafe-inline'", ...(options.googleAuth ? ["https://accounts.google.com/gsi/style"] : [])],
        upgradeInsecureRequests: null
      }
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: options.googleAuth
      ? { policy: "same-origin-allow-popups" }
      : { policy: "same-origin" }
  });
  await app.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: "1 minute"
  });
  await app.register(formbody);
  await app.register(cors, { origin: true, credentials: false });
  await app.register(websocket);

  app.addHook("onClose", async () => {
    await providerRevocations?.close();
    await notifications?.close();
    await relay.close();
  });
  notifications?.start();
  providerRevocations?.start();

  app.addHook("onRequest", async (request, reply) => {
    if (
      !options.hostedCollections
      && (
        request.url.startsWith("/v1/hosted/")
        || request.url.startsWith("/v1/mirror-pairing-requests")
        || request.url.startsWith("/v1/authority-transfers")
      )
    ) {
      return reply.code(404).send(apiError("not_found", "Not found."));
    }
    if (
      options.hostedProvider
      && request.url.startsWith("/v1/authorities/")
      && request.url.includes("/sync/")
    ) {
      return reply.code(421).send({
        ...apiError(
          "sync_provider_direct_required",
          "Connect directly to the collection's hosted storage provider."
        ),
        sync_url: authorityUrl(
          options.hostedProvider.url,
          request.url.split("/")[3] ?? "",
          "sync"
        )
      });
    }
    if (
      !["GET", "HEAD", "OPTIONS"].includes(request.method)
      && sessionToken(request)
      && request.headers.origin
      && request.headers.origin !== new URL(publicUrl).origin
    ) {
      return reply.code(403).send(apiError("origin_denied", "The request origin is not allowed."));
    }
  });

  registerErrorHandler(app);
  registerSystemRoutes(app, {
    db: options.db,
    relay,
    hostedCollections: options.hostedCollections === true,
    hostedProvider: options.hostedProvider,
    revision: options.revision
  });
  registerPasswordAuthRoutes(app, {
    db: options.db,
    publicUrl,
    authenticationPolicy,
    authRateLimitSecret: options.authRateLimitSecret,
    authenticationLegalDocuments: options.authenticationLegalDocuments,
    emailTransport: options.emailTransport,
    providers: {
      development: options.devAuth === true,
      tailscale: options.tailscaleAuth === true,
      github: options.githubAuth !== undefined,
      google: options.googleAuth !== undefined
    }
  });
  registerExternalAuthRoutes(app, {
    db: options.db,
    publicUrl,
    authenticationPolicy,
    githubAuth: options.githubAuth,
    googleAuth: options.googleAuth
  });
  registerConnectorPairingRoutes(app, {
    db: options.db,
    publicUrl,
    tailscaleAuth: options.tailscaleAuth
  });
  registerAccountSessionRoutes(app, {
    db: options.db,
    publicUrl,
    developmentAuth: options.devAuth
  });
  registerMirrorPairingRoutes(app, {
    db: options.db,
    publicUrl,
    tailscaleAuth: options.tailscaleAuth,
    hostedProvider: options.hostedProvider,
    hostedReference
  });
  registerConnectorManagementRoutes(app, {
    db: options.db,
    tailscaleAuth: options.tailscaleAuth
  });
  registerConnectorInventoryRoutes(app, { db: options.db });
  registerAuthorityConflictRoutes(app, { db: options.db, relay });
  registerConnectorControlRoutes(app, { db: options.db });
  registerAuthorityAdoptionRoutes(app, {
    db: options.db,
    publicUrl,
    tailscaleAuth: options.tailscaleAuth,
    hostedCollections: options.hostedCollections,
    hostedProvider: options.hostedProvider
  });
  registerHostedToLocalTransferRoutes(app, {
    db: options.db,
    publicUrl,
    tailscaleAuth: options.tailscaleAuth,
    hostedProvider: options.hostedProvider,
    hostedReference,
    relay
  });
  registerLocalToHostedTransferRoutes(app, {
    db: options.db,
    hostedCollections: options.hostedCollections,
    hostedProvider: options.hostedProvider,
    hostedReference,
    relay
  });
  registerNotificationRoutes(app, {
    db: options.db,
    service: notifications,
    publicKey: options.notifications?.publicKey,
    transports: options.notifications?.transports,
    hostedProvider: options.hostedProvider
  });
  registerLocalOperationRoutes(app, { db: options.db, relay });
  registerConnectorHostedRoutes(app, {
    db: options.db,
    publicUrl,
    hostedCollections: options.hostedCollections,
    hostedProvider: options.hostedProvider,
    hostedReference,
    approveAuthorization: (input) => approveHostedAuthorization(
      options.db,
      options.hostedProvider!,
      input
    )
  });
  registerHostedAccountRoutes(app, {
    db: options.db,
    publicUrl,
    tailscaleAuth: options.tailscaleAuth,
    hostedCollections: options.hostedCollections,
    hostedProvider: options.hostedProvider,
    hostedReference
  });
  registerReferenceSyncRoutes(app, {
    db: options.db,
    hostedReference
  });
  registerConnectorRelayRoute(app, { db: options.db, relay });

  app.get("/v1/me", async (request, reply) => {
    const authenticated = await requireUser(request, reply, options.db, options.tailscaleAuth);
    if (!authenticated) return;
    if (options.hostedCollections) {
      await recoverExpiredAuthorityTransfers(options.db, options.hostedProvider, hostedReference);
    }
    const { authentication_provider: authenticationProvider, ...user } = authenticated;
    const connectors = await options.db.query(
      `SELECT c.id, c.name, c.last_seen_at, c.created_at
       FROM connectors c
       WHERE c.user_id = $1 AND c.revoked_at IS NULL
       ORDER BY c.created_at`,
      [user.id]
    );
    const localCatalog = await listLocalCollectionsVisibleToUser(
      options.db,
      user.id
    );
    const localAuthorityIds = localCatalog.map(
      (collection) => collection.authorityRowId
    );
    const collections = localAuthorityIds.length
      ? await options.db.query(
          `SELECT col.id, col.connector_id, col.local_id, col.display_name,
                  col.spec_version, col.enabled, col.authority_state,
                  col.authority_epoch, col.contracts, col.last_seen_at,
                  connector.name AS connector_name
           FROM collections col
           JOIN connectors connector ON connector.id = col.connector_id
           WHERE col.id IN (${sqlPlaceholders(localAuthorityIds.length)})
             AND connector.revoked_at IS NULL
             AND col.authority_state = 'active'
             AND col.present = true
           ORDER BY col.display_name`,
          localAuthorityIds
        )
      : { rows: [] };
    const hostedCatalog = options.hostedCollections
      ? (await listHostedCollectionsVisibleToUser(options.db, user.id))
          .filter((collection) =>
            collection.locator.authorityState !== "importing"
          )
      : [];
    const hostedCollections = {
      rows: await Promise.all(hostedCatalog.map(async (collection) => ({
        id: collection.locator.collectionId,
        display_name: collection.locator.displayName,
        template: collection.template,
        contracts: collection.contracts,
        provider_url: collection.locator.providerUrl ?? null,
        authority_state:
          collection.locator.authorityState as "active" | "transferring" | "transferred",
        authority_epoch: collection.locator.authorityEpoch,
        transferred_collection_id: collection.transferredCollectionId,
        created_at: collection.createdAt,
        access: accessView(requireCollectionAction(
          await resolveHostedCollectionAccess(
            options.db,
            user.id,
            collection.locator.collectionId
          ),
          "collection.discover"
        ))
      })))
    };
    const hostedReplicas = {
      rows: await hostedMirrorReplicas(
        options.db,
        hostedCollections.rows.map((collection) => collection.id)
      )
    };
    const hostedReplicaStatuses = new Map<string, {
      head: number;
      acknowledged_sequence: number;
      last_seen_at: string | null;
      token_expires_at: string;
    }>();
    if (options.hostedProvider) {
      const statusGroups = await Promise.all(hostedCollections.rows.map(async (collection) => {
        try {
          return await options.hostedProvider!.replicaStatuses(collection.id);
        } catch (error) {
          request.log.warn({ error, collection_id: collection.id }, "Hosted mirror status is unavailable");
          return [];
        }
      }));
      for (const status of statusGroups.flat()) hostedReplicaStatuses.set(status.id, status);
    }
    const grants = await options.db.query(
      `SELECT g.id, g.operations, g.scope, g.created_at, g.revoked_at,
              CASE WHEN g.application_origin = '' THEN a.homepage
                   ELSE g.application_origin END AS application_origin,
              COALESCE(col.local_id, g.hosted_collection_id) AS collection_id,
              a.id AS application_id,
              a.family_identity AS application_family_id,
              a.distribution, a.name AS application_name,
              a.homepage, a.project_url, a.icon,
              COALESCE(col.display_name, hosted.display_name) AS collection_name,
              CASE WHEN g.hosted_collection_id IS NULL THEN 'local' ELSE 'hosted' END AS collection_kind
       FROM grants g
       JOIN applications a ON a.id = g.application_id
       LEFT JOIN collections col ON col.id = g.collection_id
       LEFT JOIN hosted_collections hosted ON hosted.id = g.hosted_collection_id
       WHERE g.user_id = $1
         AND (g.activated_at IS NOT NULL OR g.revoked_at IS NOT NULL)
       ORDER BY g.created_at DESC`,
      [user.id]
    );
    const pendingAuthorizations = await options.db.query(
      `SELECT ar.id, ar.flow, ar.user_code, ar.requested_operations,
              ar.collection_id, ar.expires_at,
              a.id AS application_id, a.distribution, a.name AS application_name,
              a.homepage, a.project_url, a.icon,
              a.requirements, a.provisions, a.notifications
       FROM authorization_requests ar
       JOIN applications a ON a.id = ar.application_id
       WHERE ar.user_id = $1 AND ar.completed_at IS NULL AND ar.denied_at IS NULL
         AND ar.expires_at > now()
       ORDER BY ar.expires_at`,
      [user.id]
    );
    const authenticationSettings = await authenticationPolicy.current();
    return {
      user,
      hosted_collections_available: options.hostedCollections === true,
      authentication: {
        provider: authenticationProvider ?? (options.tailscaleAuth ? "tailscale" : "session"),
        registration: authenticationSettings.registrationMode
      },
      connectors: connectors.rows,
      collections: await Promise.all(collections.rows.map(async (collection) => {
        const access = await resolveLocalCollectionAccess(
          options.db,
          user.id,
          collection.id
        );
        return {
          ...collection,
          id: collection.local_id,
          ...(access ? {
            access: accessView(access),
            authority: {
              kind: "local",
              collection_id: access.collection.collectionId,
              epoch: access.collection.authorityEpoch,
              state: access.collection.authorityState
            }
          } : {})
        };
      })),
      hosted_collections: hostedCollections.rows.map((collection) => ({
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
        contracts: contractRequirements(effectiveHostedContractDescriptors(collection.contracts, collection.template)),
        replicas: hostedReplicas.rows
          .filter((replica) => replica.collection_id === collection.id)
          .map((replica) => ({
            ...replica,
            sync_status: hostedReplicaStatuses.get(replica.id) ?? null
          }))
      })),
      grants: grants.rows.map((grant) => ({
        ...grant,
        application_origin: normalizedApplicationOrigin(grant.application_origin)
      })),
      pending_authorizations: await Promise.all(pendingAuthorizations.rows.map(async (authorization) => {
        const live = requiresHostedCollection(authorization.requirements)
          ? { collections: [], unavailable_connectors: [] }
          : await liveAuthorizationCollections(
              options.db,
              relay,
              user.id,
              authorization.id
            );
        return {
          ...authorization,
          available_collections: live.collections,
          unavailable_connectors: live.unavailable_connectors
        };
      }))
    };
  });

  app.post("/v1/connectors/grants", async (request, reply) => {
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return;
    const input = z.object({
      application_id: z.uuid(),
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
    const collection = await options.db.query<{ id: string; contracts: CollectionContractDescriptor[]; spec_version: string }>(
      `SELECT id, contracts, spec_version FROM collections
       WHERE connector_id = $1 AND local_id = $2 AND enabled = true
         AND present = true AND authority_state = 'active'`,
      [connector.id, input.collection_id]
    );
    if (!collection.rows[0]) return reply.code(404).send(apiError("collection_not_found", "Collection is not synchronized yet."));
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
    assertOperationsAllowedByRequirements(input.operations, application.rows[0].requirements);
    assertCollectionSupportsOperations(collection.rows[0].spec_version, input.operations);
    const scope = scopeForRequirements(
      application.rows[0].requirements,
      collection.rows[0].contracts
    );
    if (!contractsSatisfy(
      collection.rows[0].contracts,
      requiredContractsForRequirements(application.rows[0].requirements)
    )) {
      return reply.code(409).send(apiError(
        "incompatible_collection",
        "This collection does not provide the contracts required by the application."
      ));
    }
    const grant = await createOrUpdateGrant(options.db, {
      userId: connector.user_id,
      applicationId: input.application_id,
      collectionId: collection.rows[0].id,
      operations: input.operations,
      scope,
      applicationOrigin: new URL(application.rows[0].homepage).origin,
      notificationCriteria: application.rows[0].notifications.criteria
    });
    await relay.pushPolicy(connector.id);
    await audit(options.db, connector.user_id, "grant.created", grant.id, {
      ...input,
      connector_id: connector.id
    });
    return reply.code(201).send({ grant });
  });

  app.patch("/v1/connectors/grants/:grantId", async (request, reply) => {
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return;
    const { grantId } = z.object({ grantId: z.uuid() }).parse(request.params);
    const input = z.object({ operations: z.array(operationSchema).min(1) }).parse(request.body);
    const current = await options.db.query<{ requirements: ApplicationRequirements; spec_version: string }>(
      `SELECT a.requirements, col.spec_version FROM grants g
       JOIN applications a ON a.id = g.application_id
       JOIN collections col ON col.id = g.collection_id
       WHERE g.id = $1 AND g.revoked_at IS NULL AND g.activated_at IS NOT NULL
         AND g.collection_id IN
         (SELECT id FROM collections WHERE connector_id = $2)`,
      [grantId, connector.id]
    );
    if (!current.rows[0]) return reply.code(404).send(apiError("grant_not_found", "Active grant not found."));
    assertOperationsAllowedByRequirements(input.operations, current.rows[0].requirements);
    assertCollectionSupportsOperations(current.rows[0].spec_version, input.operations);
    const grant = await options.db.query(
      `UPDATE grants SET operations = $3::jsonb
       WHERE id = $1 AND revoked_at IS NULL AND activated_at IS NOT NULL
         AND collection_id IN
         (SELECT id FROM collections WHERE connector_id = $2)
       RETURNING id, operations`,
      [grantId, connector.id, JSON.stringify([...new Set(input.operations)])]
    );
    if (!grant.rows[0]) return reply.code(404).send(apiError("grant_not_found", "Active grant not found."));
    await rotateGrantEncryption(options.db, grantId);
    await relay.pushPolicy(connector.id);
    await audit(options.db, connector.user_id, "grant.updated", grantId, input);
    return { grant: grant.rows[0] };
  });

  app.delete("/v1/connectors/grants/:grantId", async (request, reply) => {
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return;
    const { grantId } = z.object({ grantId: z.uuid() }).parse(request.params);
    const active = await options.db.query(
      `UPDATE grants SET revoked_at = now()
       WHERE id = $1 AND revoked_at IS NULL AND activated_at IS NOT NULL
         AND collection_id IN
         (SELECT id FROM collections WHERE connector_id = $2)
       RETURNING id`,
      [grantId, connector.id]
    );
    if (!active.rows[0]) return reply.code(404).send(apiError("grant_not_found", "Active grant not found."));
    await options.db.query("UPDATE access_tokens SET revoked_at = now() WHERE grant_id = $1", [grantId]);
    await options.db.query("UPDATE refresh_tokens SET revoked_at = now() WHERE grant_id = $1", [grantId]);
    await relay.pushPolicy(connector.id);
    await audit(options.db, connector.user_id, "grant.revoked", grantId, { connector_id: connector.id });
    return { ok: true };
  });

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

  app.post("/v1/apps/register", async (request) => {
    const input = z.object({ manifest: z.unknown() }).strict().parse(request.body);
    const registered = registerApplicationManifest(
      input.manifest,
      options.allowInsecureManifests
    );
    const application = await upsertApplication(options.db, registered);
    await reconcileApplicationGrants(options.db, relay, options.hostedProvider, application);
    return { application };
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
      await providerRevocations?.drain();
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
      return {
        id: collection.locator.collectionId,
        display_name: collection.locator.displayName,
        template: collection.template,
        kind: "hosted" as const,
        connector_name: "Hosted by mdbase",
        spec_version: "0.3.0",
        contracts: contractRequirements(effectiveHostedContractDescriptors(
          collection.contracts,
          collection.template
        )),
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
      redirect_uri: string | null;
      state: string | null;
      code_challenge: string | null;
    }>(
      `SELECT completed_at, denied_at, expires_at, application_id, grant_id,
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
    return { status: "pending" };
  });

  app.post("/v1/authorization-requests/:requestId/approve", async (request, reply) => {
    const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
    if (!user) return;
    const { requestId } = z.object({ requestId: z.uuid() }).parse(request.params);
    const input = z.object({
      collection_id: z.uuid(),
      offer_id: z.uuid().optional(),
      operations: z.array(operationSchema).min(1)
    }).parse(request.body);
    let approved: boolean;
    if (input.offer_id) {
      approved = await approvePortalAuthorization(options.db, relay, {
        requestId,
        userId: user.id,
        offerId: input.offer_id,
        collectionId: input.collection_id,
        operations: input.operations
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
      approved = await approveHostedAuthorization(options.db, options.hostedProvider, {
        requestId,
        userId: user.id,
        collectionId: input.collection_id,
        operations: input.operations,
        contracts: effectiveHostedContractDescriptors(
          hosted.contracts,
          hosted.template
        ),
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

  if (options.portalDist && existsSync(options.portalDist)) {
    await app.register(fastifyStatic, { root: resolve(options.portalDist), wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === "GET" && request.headers.accept?.includes("text/html")) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send(apiError("not_found", "Not found."));
    });
  }

  return { app, relay };
}

async function upsertApplication(
  db: DatabasePool,
  discovered: RegisteredApplicationManifest
): Promise<{
  id: string;
  distribution: "web" | "portable";
  name: string;
  homepage: string;
  project_url: string | null;
  icon: string | null;
  redirect_uris: string[];
  canonical_identity: string;
  family_identity: string;
  requirements: ApplicationRequirements;
  provisions: ApplicationProvisions;
  notifications: ApplicationNotifications;
}> {
  const application = await db.query<{
    id: string;
    distribution: "web" | "portable";
    name: string;
    homepage: string;
    project_url: string | null;
    icon: string | null;
    redirect_uris: string[];
    canonical_identity: string;
    family_identity: string;
    requirements: ApplicationRequirements;
    provisions: ApplicationProvisions;
    notifications: ApplicationNotifications;
  }>(
    `INSERT INTO applications
       (id, canonical_identity, family_identity, manifest_version, distribution, name, homepage,
        project_url, icon, redirect_uris, requirements, provisions, notifications)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb,
             $12::jsonb, $13::jsonb)
     ON CONFLICT(canonical_identity) DO UPDATE SET
       family_identity = excluded.family_identity,
       manifest_version = excluded.manifest_version,
       distribution = excluded.distribution,
       name = excluded.name,
       homepage = excluded.homepage,
       project_url = excluded.project_url,
       icon = excluded.icon,
       redirect_uris = excluded.redirect_uris,
       requirements = excluded.requirements,
       provisions = excluded.provisions,
       notifications = excluded.notifications,
       updated_at = now()
     RETURNING id, distribution, name, homepage, project_url, icon, redirect_uris,
               canonical_identity, family_identity, requirements, provisions, notifications`,
    [
      randomUUID(),
      discovered.canonicalIdentity,
      discovered.familyIdentity,
      discovered.manifest.manifest_version,
      discovered.manifest.distribution === "portable" ? "portable" : "web",
      discovered.manifest.name,
      discovered.manifest.distribution === "portable"
        ? ""
        : discovered.manifest.homepage,
      discovered.manifest.distribution === "portable"
        ? discovered.manifest.project_url ?? null
        : null,
      discovered.manifest.icon ?? null,
      JSON.stringify(
        discovered.manifest.distribution === "portable"
          ? []
          : discovered.manifest.redirect_uris
      ),
      JSON.stringify(discovered.manifest.requirements),
      JSON.stringify(discovered.manifest.provisions),
      JSON.stringify(discovered.manifest.notifications)
    ]
  );
  return application.rows[0];
}

async function createOrUpdateGrant(
  db: DatabasePool,
  input: {
    userId: string;
    applicationId: string;
    collectionId: string;
    operations: string[];
    scope: GrantScope;
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
                           application_origin = $4,
                           notification_criteria = $5::jsonb
         WHERE id = $1 RETURNING id, operations, scope`,
        [
          existing.rows[0].id,
          JSON.stringify(operations),
          JSON.stringify(input.scope),
          input.applicationOrigin,
          JSON.stringify(input.notificationCriteria)
        ]
      )
    : await db.query<{ id: string; operations: string[]; scope: GrantScope }>(
        `INSERT INTO grants
           (id, user_id, application_id, collection_id, operations, scope,
            application_origin, notification_criteria)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8::jsonb)
         RETURNING id, operations, scope`,
        [
          randomUUID(),
          input.userId,
          input.applicationId,
          input.collectionId,
          JSON.stringify(operations),
          JSON.stringify(input.scope),
          input.applicationOrigin,
          JSON.stringify(input.notificationCriteria)
        ]
      );
  if (existing.rows[0]?.encryption) await rotateGrantEncryption(db, existing.rows[0].id);
  return grant.rows[0];
}

async function syncHostedNotificationGrant(
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
    created_at: string | Date;
  }>(
    `SELECT g.id, g.application_id, a.name AS application_name,
            a.homepage AS application_homepage,
            CASE WHEN g.application_origin = '' THEN a.homepage
                 ELSE g.application_origin END AS application_origin,
            a.icon AS application_icon,
            g.hosted_collection_id AS collection_id,
            hosted.display_name AS collection_name,
            g.operations, g.scope, g.notification_criteria, g.created_at
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
  const grant: GrantPolicy = {
    id: row.id,
    application_id: row.application_id,
    collection_id: row.collection_id,
    operations: row.operations as GrantPolicy["operations"],
    scope: row.scope,
    application_name: row.application_name,
    application_homepage: row.application_homepage,
    application_origin: row.application_origin,
    ...(row.application_icon ? { application_icon: row.application_icon } : {}),
    collection_name: row.collection_name,
    notification_criteria: row.notification_criteria,
    created_at: new Date(row.created_at).toISOString()
  };
  await provider.upsertNotificationGrant(row.collection_id, grant);
}

async function reconcileApplicationGrants(
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
  }>(
    `SELECT g.id, g.user_id, col.connector_id, g.hosted_collection_id, g.hosted_replica_id,
            g.operations, col.contracts AS local_contracts, col.spec_version,
            hosted.contracts AS hosted_contracts, hosted.template,
            replica.allowed_types, g.scope, g.notification_criteria
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
    if (scopeMatches && collectionCompatible && replicaScopeMatches) continue;
    const mayNarrow = desiredScope.contracts.length > 0
      && (grant.scope.contracts.length === 0
        || isContractSubset(desiredScope.contracts, grant.scope.contracts));
    if ((scopeMatches || mayNarrow) && collectionCompatible) {
      if (grant.hosted_replica_id) {
        if (!hostedProvider) throw new Error("Hosted provider unavailable during grant reconciliation.");
        const write = grant.operations.some((operation) => ["create", "update", "delete", "rename", "create_type", "update_type", "install_type_pack", "create_view_source", "update_view_source", "delete_view_source", "put_timer", "cancel_timer", "reconcile_timers"].includes(operation));
        await hostedProvider.updateApplicationReplica(grant.hosted_replica_id, {
          grantId: grant.id,
          mode: write ? "read_write" : "read_only",
          allowedTypes: desiredAllowedTypes,
          contractScope: desiredScope.access === "contract" ? desiredScope.contracts : [],
          fullCollection: application.requirements.access === "full_collection",
          allowedOperations: hostedReplicaCollectionOperations(grant.operations)
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
        if (!hostedProvider) throw new Error("Hosted provider unavailable during grant reconciliation.");
        await hostedProvider.revokeReplica(grant.hosted_replica_id);
        if (grant.hosted_collection_id) {
          await hostedProvider.revokeNotificationGrant(grant.hosted_collection_id, grant.id);
        }
        await db.query("UPDATE hosted_replicas SET revoked_at = now() WHERE id = $1", [
          grant.hosted_replica_id
        ]);
      }
      await db.query("UPDATE grants SET revoked_at = now() WHERE id = $1", [grant.id]);
      await db.query("UPDATE access_tokens SET revoked_at = now() WHERE grant_id = $1", [grant.id]);
      await db.query("UPDATE refresh_tokens SET revoked_at = now() WHERE grant_id = $1", [grant.id]);
      await audit(db, grant.user_id, "grant.revoked_after_manifest_change", grant.id, {
        application_id: application.id,
        previous_scope: grant.scope,
        required_scope: desiredScope
      });
    }
    if (grant.connector_id) changedConnectors.add(grant.connector_id);
  }
  for (const connectorId of changedConnectors) await relay.pushPolicy(connectorId);
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
  const available = new Set(superset.map((contract) => `${contract.id}@${contract.version}`));
  return subset.every((contract) => available.has(`${contract.id}@${contract.version}`));
}

function sameStrings(left: string[], right: string[]): boolean {
  const leftValues = new Set(left);
  const rightValues = new Set(right);
  return leftValues.size === rightValues.size
    && [...leftValues].every((value) => rightValues.has(value));
}

function sqlPlaceholders(count: number, offset = 0): string {
  return Array.from(
    { length: count },
    (_, index) => `$${index + offset + 1}`
  ).join(", ");
}

interface LiveAuthorizationCollection {
  id: string;
  offer_id: string;
  kind: "local";
  connector_name: string;
  display_name: string;
  spec_version: string;
  contracts: CollectionContractDescriptor[];
  access: ReturnType<typeof accessView>;
}

async function liveAuthorizationCollections(
  db: DatabasePool,
  relay: RelayHub,
  userId: string,
  authorizationId: string
): Promise<{
  collections: LiveAuthorizationCollection[];
  unavailable_connectors: Array<{
    connector_id: string;
    connector_name: string;
    reason: "offline" | "paused";
  }>;
}> {
  await db.query(
    `DELETE FROM authorization_collection_offers
     WHERE authorization_id = $1 AND expires_at <= now()`,
    [authorizationId]
  );
  const visibleCollections = await listLocalCollectionsVisibleToUser(db, userId);
  const visibleByConnector = new Map<string, Set<string>>();
  for (const collection of visibleCollections) {
    if (
      collection.authorityState !== "active"
      || !collection.connectorId
    ) continue;
    const ids = visibleByConnector.get(collection.connectorId) ?? new Set();
    ids.add(collection.authorityRowId);
    visibleByConnector.set(collection.connectorId, ids);
  }
  const ownerConnectors = await db.query<{
    id: string;
    name: string;
    inventory_revision: string | number;
  }>(
    `SELECT id, name, inventory_revision FROM connectors
     WHERE user_id = $1 AND revoked_at IS NULL
     ORDER BY created_at`,
    [userId]
  );
  const ownerConnectorIds = new Set(ownerConnectors.rows.map(({ id }) => id));
  const sharedConnectorIds = [...visibleByConnector.keys()]
    .filter((id) => !ownerConnectorIds.has(id));
  const sharedConnectors = sharedConnectorIds.length
    ? await db.query<{
        id: string;
        name: string;
        inventory_revision: string | number;
      }>(
        `SELECT id, name, inventory_revision FROM connectors
         WHERE id IN (${sqlPlaceholders(sharedConnectorIds.length)})
           AND revoked_at IS NULL
         ORDER BY created_at`,
        sharedConnectorIds
      )
    : { rows: [] };
  const connectors = {
    rows: [...ownerConnectors.rows, ...sharedConnectors.rows]
  };
  const settled = await Promise.allSettled(connectors.rows.map(async (connector) => ({
    connector,
    response: await relay.authorizationOffers(connector.id, authorizationId)
  })));
  const collections: LiveAuthorizationCollection[] = [];
  const unavailableConnectors: Array<{
    connector_id: string;
    connector_name: string;
    reason: "offline" | "paused";
  }> = [];

  for (const [index, result] of settled.entries()) {
    const connector = connectors.rows[index];
    if (result.status === "rejected") {
      unavailableConnectors.push({
        connector_id: connector.id,
        connector_name: connector.name,
        reason: "offline"
      });
      continue;
    }
    if (result.value.response.paused) {
      unavailableConnectors.push({
        connector_id: connector.id,
        connector_name: connector.name,
        reason: "paused"
      });
      continue;
    }
    const authoritative = await db.query<{
      id: string;
      local_id: string;
      authority_epoch: string | number;
    }>(
      `SELECT id, local_id, authority_epoch FROM collections
       WHERE connector_id = $1
         AND present = true AND enabled = true AND authority_state = 'active'`,
      [connector.id]
    );
    const visibleIds = visibleByConnector.get(connector.id) ?? new Set();
    const byLocalId = new Map(authoritative.rows
      .filter((collection) => visibleIds.has(collection.id))
      .map((collection) => [collection.local_id, collection] as const));
    for (const offered of result.value.response.collections) {
      const collection = byLocalId.get(offered.collection_id);
      if (!collection) continue;
      const offer = await db.query<{ id: string }>(
        `INSERT INTO authorization_collection_offers
           (id, authorization_id, user_id, connector_id, collection_id, local_id,
            authority_epoch, inventory_revision, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + interval '45 seconds')
         ON CONFLICT(authorization_id, connector_id, collection_id) DO UPDATE SET
           local_id = excluded.local_id,
           authority_epoch = excluded.authority_epoch,
           inventory_revision = excluded.inventory_revision,
           expires_at = excluded.expires_at
         WHERE authorization_collection_offers.consumed_at IS NULL
         RETURNING id`,
        [
          randomUUID(),
          authorizationId,
          userId,
          connector.id,
          collection.id,
          offered.collection_id,
          Number(collection.authority_epoch),
          Number(connector.inventory_revision)
        ]
      );
      if (!offer.rows[0]) continue;
      const access = await resolveLocalCollectionAccess(
        db,
        userId,
        collection.id
      );
      if (!access || !access.actions.has("application.authorize")) continue;
      collections.push({
        id: offered.collection_id,
        offer_id: offer.rows[0].id,
        kind: "local",
        connector_name: connector.name,
        display_name: offered.display_name,
        spec_version: offered.spec_version,
        contracts: offered.contracts,
        access: accessView(access)
      });
    }
  }

  collections.sort((left, right) =>
    left.display_name.localeCompare(right.display_name, undefined, { sensitivity: "base" })
    || left.connector_name.localeCompare(right.connector_name, undefined, { sensitivity: "base" })
  );
  return {
    collections,
    unavailable_connectors: unavailableConnectors
  };
}

async function approvePortalAuthorization(
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

async function approveAuthorization(
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

async function approveHostedAuthorization(
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

async function denyAuthorization(
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

function deniedAuthorizationRedirect(input: { redirect_uri: string; state: string | null }): string {
  const redirect = new URL(input.redirect_uri);
  redirect.searchParams.set("error", "access_denied");
  if (input.state) redirect.searchParams.set("state", input.state);
  return redirect.href;
}

function applicationOriginForRedirect(redirectUri: string, homepage: string): string {
  const redirect = new URL(redirectUri);
  return ["http:", "https:"].includes(redirect.protocol)
    ? redirect.origin
    : new URL(homepage).origin;
}

function normalizedApplicationOrigin(value: string): string {
  return value === "null" ? "null" : new URL(value).origin;
}

async function createAuthorizationRedirect(
  db: DatabasePool,
  publicUrl: string,
  input: {
    application_id: string;
    grant_id: string;
    redirect_uri: string;
    state: string | null;
    code_challenge: string;
  }
): Promise<string> {
  const code = randomToken("code");
  await db.query(
    `INSERT INTO authorization_codes
       (id, code_hash, grant_id, application_id, redirect_uri, code_challenge, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + interval '2 minutes')`,
    [randomUUID(), tokenHash(code), input.grant_id, input.application_id, input.redirect_uri, input.code_challenge]
  );
  const redirect = new URL(input.redirect_uri);
  redirect.searchParams.set("code", code);
  if (input.state) redirect.searchParams.set("state", input.state);
  redirect.searchParams.set("iss", publicUrl);
  return redirect.href;
}

async function issueApplicationTokens(
  db: DatabaseQueryable,
  hostedProvider: HostedProviderClient | undefined,
  grantId: string
): Promise<{
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_expires_in: number;
  collection_id: string;
  collection_name: string;
  operations: string[];
  scope: GrantScope;
  grant_id: string;
  encryption: GrantEncryption | null;
  application_origin: string;
  authority?: {
    operations_url: string;
    sync_url: string;
    replica_id: string;
    access_token: string;
    proof_public_key?: string;
  };
}> {
  const grant = await db.query<{
    user_id: string;
    collection_id: string;
    local_authority_row_id: string | null;
    collection_name: string;
    hosted_collection_id: string | null;
    hosted_replica_id: string | null;
    provider_url: string | null;
    operations: string[];
    scope: GrantScope;
    encryption: GrantEncryption | null;
    proof_public_key: string | null;
    application_origin: string;
  }>(
    `SELECT g.user_id,
            COALESCE(col.local_id, g.hosted_collection_id) AS collection_id,
            g.collection_id AS local_authority_row_id,
            COALESCE(col.display_name, hosted.display_name) AS collection_name,
            g.hosted_collection_id, g.hosted_replica_id, hosted.provider_url,
            g.operations, g.scope, g.encryption, g.proof_public_key,
            CASE WHEN g.application_origin = '' THEN app.homepage
                 ELSE g.application_origin END AS application_origin
     FROM grants g
     JOIN users u ON u.id = g.user_id
     JOIN applications app ON app.id = g.application_id
     LEFT JOIN collections col ON col.id = g.collection_id
     LEFT JOIN hosted_collections hosted ON hosted.id = g.hosted_collection_id
     LEFT JOIN hosted_replicas replica ON replica.id = g.hosted_replica_id
     WHERE g.id = $1 AND g.revoked_at IS NULL
       AND g.activated_at IS NOT NULL
       AND u.suspended_at IS NULL
       AND (g.hosted_replica_id IS NULL OR replica.revoked_at IS NULL)`,
    [grantId]
  );
  if (!grant.rows[0]) throw new RequestValidationError("The application grant is no longer active.");
  if (grant.rows[0].hosted_collection_id) {
    requireCollectionAction(
      await resolveHostedCollectionAccess(
        db,
        grant.rows[0].user_id,
        grant.rows[0].hosted_collection_id
      ),
      "application.authorize"
    );
  } else if (grant.rows[0].local_authority_row_id) {
    requireCollectionAction(
      await resolveLocalCollectionAccess(
        db,
        grant.rows[0].user_id,
        grant.rows[0].local_authority_row_id
      ),
      "application.authorize"
    );
  }
  const accessToken = randomToken("mdb");
  const refreshToken = randomToken("ref");
  let authority: {
    operations_url: string;
    sync_url: string;
    replica_id: string;
    access_token: string;
    proof_public_key?: string;
  } | undefined;
  if (grant.rows[0].hosted_collection_id) {
    if (!hostedProvider || !grant.rows[0].hosted_replica_id || !grant.rows[0].provider_url) {
      throw new RequestValidationError("The hosted application capability is unavailable.");
    }
    const providerToken = randomToken("hsa");
    await hostedProvider.rotateReplicaToken(grant.rows[0].hosted_replica_id, providerToken, 3_600);
    authority = {
      operations_url: authorityUrl(
        grant.rows[0].provider_url,
        grant.rows[0].collection_id,
        "operations"
      ),
      sync_url: authorityUrl(
        grant.rows[0].provider_url,
        grant.rows[0].collection_id,
        "sync"
      ),
      replica_id: grant.rows[0].hosted_replica_id,
      access_token: providerToken,
      ...(grant.rows[0].proof_public_key
        ? { proof_public_key: grant.rows[0].proof_public_key }
        : {})
    };
  }
  await db.query(
    `INSERT INTO access_tokens (id, token_hash, grant_id, expires_at)
     VALUES ($1, $2, $3, now() + interval '1 hour')`,
    [randomUUID(), tokenHash(accessToken), grantId]
  );
  await db.query(
    `INSERT INTO refresh_tokens (id, token_hash, grant_id, expires_at)
     VALUES ($1, $2, $3, now() + interval '30 days')`,
    [randomUUID(), tokenHash(refreshToken), grantId]
  );
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: 3600,
    refresh_expires_in: 30 * 24 * 60 * 60,
    collection_id: grant.rows[0].collection_id,
    collection_name: grant.rows[0].collection_name,
    operations: grant.rows[0].operations,
    scope: grant.rows[0].scope,
    grant_id: grantId,
    encryption: grant.rows[0].encryption,
    application_origin: normalizedApplicationOrigin(grant.rows[0].application_origin),
    ...(authority ? { authority } : {})
  };
}
