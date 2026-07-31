import { existsSync } from "node:fs";
import { resolve } from "node:path";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import formbody from "@fastify/formbody";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { LogController } from "fastify";
import { AuthenticationPolicyStore } from "./authentication-policy.js";
import type { DatabasePool } from "./db.js";
import type { EmailTransport } from "./email.js";
import type { GitHubAuthConfig } from "./github-auth.js";
import type { GoogleAuthConfig } from "./google-auth.js";
import { HostedAuthorityRegistry } from "./hosted.js";
import { ProviderRevocationWorker } from "./hosted-capability-lifecycle.js";
import type { HostedProviderClient } from "./hosted-provider.js";
import { NotificationService, type NotificationTransports } from "./notifications.js";
import { RelayHub } from "./relay.js";
import type { RelayBroker } from "./relay-broker.js";
import type {
  AuthenticationLegalDocuments,
  RegistrationMode
} from "./runtime-config.js";
import { registerAccountOverviewRoute } from "./features/account/me-routes.js";
import { registerAccountManagementRoutes } from "./features/account/management-routes.js";
import { registerAccountSessionRoutes } from "./features/account/session-routes.js";
import { registerApplicationRoutes } from "./features/applications/routes.js";
import { registerExternalAuthRoutes } from "./features/auth/external-routes.js";
import { registerPasswordAuthRoutes } from "./features/auth/password-routes.js";
import { registerAuthorizationRoutes } from "./features/authorizations/routes.js";
import { approveHostedAuthorization } from "./features/authorizations/approval-service.js";
import { registerAuthorityAdoptionRoutes } from "./features/authority-adoption/routes.js";
import { registerHostedToLocalTransferRoutes } from "./features/authority-transfer/hosted-to-local-routes.js";
import { registerLocalToHostedTransferRoutes } from "./features/authority-transfer/local-to-hosted-routes.js";
import { registerAuthorityConflictRoutes } from "./features/connectors/authority-conflict-routes.js";
import { registerBetaAccessRoutes } from "./features/beta-access/routes.js";
import { registerConnectorControlRoutes } from "./features/connectors/control-routes.js";
import { registerConnectorInventoryRoutes } from "./features/connectors/inventory-routes.js";
import { registerConnectorManagementRoutes } from "./features/connectors/management-routes.js";
import { registerConnectorPairingRoutes } from "./features/connectors/pairing-routes.js";
import { registerConnectorRelayRoute } from "./features/connectors/relay-route.js";
import { registerConnectorGrantRoutes } from "./features/grants/connector-routes.js";
import { registerConnectorHostedRoutes } from "./features/hosted/connector-routes.js";
import { registerHostedAccountRoutes } from "./features/hosted/account-routes.js";
import { registerReferenceSyncRoutes } from "./features/hosted/reference-sync-routes.js";
import { registerMirrorPairingRoutes } from "./features/mirrors/pairing-routes.js";
import { registerNotificationRoutes } from "./features/notifications/routes.js";
import { registerLocalOperationRoutes } from "./features/operations/local-routes.js";
import { registerSystemRoutes } from "./features/system/routes.js";
import { registerErrorHandler } from "./platform/error-handler.js";
import { authorityUrl } from "./platform/authority-url.js";
import { apiError } from "./platform/http-errors.js";
import { sessionToken } from "./platform/session-cookies.js";

interface BuildOptions {
  db: DatabasePool;
  revision?: string;
  devAuth?: boolean;
  tailscaleAuth?: boolean;
  githubAuth?: GitHubAuthConfig;
  googleAuth?: GoogleAuthConfig;
  registration?: RegistrationMode;
  authRateLimitSecret?: string;
  betaAccessOrigin?: string;
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
  if (options.betaAccessOrigin) {
    if (!options.authRateLimitSecret) {
      throw new Error("Beta access requests require a rate-limit secret.");
    }
    registerBetaAccessRoutes(app, {
      db: options.db,
      allowedOrigin: options.betaAccessOrigin,
      rateLimitSecret: options.authRateLimitSecret
    });
  }
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
  registerAccountManagementRoutes(app, {
    db: options.db,
    publicUrl,
    authenticationPolicy,
    tailscaleAuth: options.tailscaleAuth,
    developmentAuth: options.devAuth,
    passwordAuthenticationAvailable: Boolean(options.authRateLimitSecret),
    githubAvailable: options.githubAuth !== undefined,
    googleAvailable: options.googleAuth !== undefined,
    hostedProvider: options.hostedProvider,
    hostedReference
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
  registerApplicationRoutes(app, {
    db: options.db,
    relay,
    hostedProvider: options.hostedProvider,
    allowInsecureManifests: options.allowInsecureManifests
  });
  registerAccountOverviewRoute(app, {
    db: options.db,
    relay,
    publicUrl,
    authenticationPolicy,
    tailscaleAuth: options.tailscaleAuth,
    hostedCollections: options.hostedCollections,
    hostedProvider: options.hostedProvider,
    hostedReference
  });
  registerConnectorGrantRoutes(app, { db: options.db, relay });
  registerAuthorizationRoutes(app, {
    db: options.db,
    relay,
    publicUrl,
    tailscaleAuth: options.tailscaleAuth,
    hostedCollections: options.hostedCollections,
    hostedProvider: options.hostedProvider,
    drainProviderRevocations: async () => {
      await providerRevocations?.drain();
    }
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
