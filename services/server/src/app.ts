import { existsSync } from "node:fs";
import { resolve } from "node:path";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import formbody from "@fastify/formbody";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import rawBody from "fastify-raw-body";
import Fastify, { LogController } from "fastify";
import { AuthenticationPolicyStore } from "./authentication-policy.js";
import { ApplicationReconciliationWorker } from "./application-reconciliation.js";
import type { DatabasePool } from "./db.js";
import type { EmailTransport } from "./email.js";
import { registerResendWebhookRoute } from "./email-provider-webhooks.js";
import { renderScheduledEmail } from "./beta-welcome-email.js";
import { ScheduledEmailWorker } from "./scheduled-email.js";
import { UsageRetentionWorker } from "./usage-report.js";
import type { GitHubAuthConfig } from "./github-auth.js";
import type { GoogleAuthConfig } from "./google-auth.js";
import { HostedAuthorityRegistry } from "./hosted.js";
import { ProviderRevocationWorker } from "./hosted-capability-lifecycle.js";
import { LogServiceClient } from "./features/next/log-service-client.js";
import { PolicyEmitter } from "./features/next/policy-outbox.js";
import { registerNextHostedRoutes } from "./features/next/hosted-routes.js";
import { loadPolicySigner, type NextControlPlaneConfig } from "./features/next/policy-keys.js";
import { NextRelayDevices } from "./features/next/devices.js";
import { NoisePipes, registerNoisePipeClientRoute } from "./features/next/noise-pipes.js";
import { registerNextDeviceRoutes } from "./features/next/device-routes.js";
import type { HostedProviderClient } from "./hosted-provider.js";
import { NotificationService, type NotificationTransports } from "./notifications.js";
import { RelayHub } from "./relay.js";
import { LocalRelayBroker, type RelayBroker } from "./relay-broker.js";
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
import { approveHostedAuthorization } from "./features/authorizations/hosted-approval-service.js";
import { registerAuthorityAdoptionRoutes } from "./features/authority-adoption/routes.js";
import { registerHostedToLocalTransferRoutes } from "./features/authority-transfer/hosted-to-local-routes.js";
import { registerLocalToHostedTransferRoutes } from "./features/authority-transfer/local-to-hosted-routes.js";
import { registerLocalFileRoutes } from "./features/files/local-routes.js";
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
import { registerHostedSharingRoutes } from "./features/hosted/sharing-routes.js";
import { registerReferenceSyncRoutes } from "./features/hosted/reference-sync-routes.js";
import { registerMirrorPairingRoutes } from "./features/mirrors/pairing-routes.js";
import { registerNotificationRoutes } from "./features/notifications/routes.js";
import type { PushTargetSealer } from "./features/next/push-target-seal.js";
import type { TimerGrantResolver } from "./features/next/timers/grants.js";
import { registerTimerRoutes } from "./features/next/timers/routes.js";
import { TimerWorker, notificationsConsumer } from "./features/next/timers/worker.js";
import { registerOnboardingRoutes } from "./features/onboarding/routes.js";
import { registerPeopleRoutes } from "./features/account/people-routes.js";
import { registerLocalOperationRoutes } from "./features/operations/local-routes.js";
import { registerSystemRoutes } from "./features/system/routes.js";
import { registerLifecycleDiagnosticRoute } from "./features/system/lifecycle-diagnostics.js";
import { registerErrorHandler } from "./platform/error-handler.js";
import { authorityUrl } from "./platform/authority-url.js";
import { apiError } from "./platform/http-errors.js";
import { sessionToken } from "./platform/session-cookies.js";

interface BuildOptions {
  db: DatabasePool;
  revision?: string;
  environment?: string;
  devAuth?: boolean;
  tailscaleAuth?: boolean;
  githubAuth?: GitHubAuthConfig;
  googleAuth?: GoogleAuthConfig;
  registration?: RegistrationMode;
  authRateLimitSecret?: string;
  betaAccessOrigin?: string;
  managementOrigins?: string[];
  editorOrigin?: string;
  authenticationLegalDocuments?: AuthenticationLegalDocuments;
  emailTransport?: EmailTransport;
  resendWebhookSecret?: string;
  accountDeletionEnabled?: boolean;
  hostedCollections?: boolean;
  hostedSharing?: boolean;
  hostedProvider?: HostedProviderClient;
  hostedReferenceAuthority?: boolean;
  publicUrl?: string;
  /** Validated by runtime configuration; loopback tests default to publicUrl. */
  identityIssuer?: string;
  portalDist?: string;
  allowInsecureManifests?: boolean;
  trustProxy?: boolean;
  relayBroker?: RelayBroker;
  /** mdbase-next control plane; absent unless MDBASE_NEXT_CONTROL_PLANE=1. */
  nextControlPlane?: NextControlPlaneConfig;
  notifications?: {
    publicKey?: string;
    transports: NotificationTransports;
    pollIntervalMs?: number;
    /** Seals push targets at rest (MDBASE_NEXT_PUSH_TOKEN_KEY). */
    pushTargetSealer?: PushTargetSealer;
  };
  /** mdbase-next opaque timer service (MDBASE_NEXT_TIMERS=1). */
  nextTimers?: {
    pollIntervalMs?: number;
    resolver?: TimerGrantResolver;
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
  const accountOrigins = new Set([
    new URL(publicUrl).origin,
    ...(options.managementOrigins ?? []).map((origin) => new URL(origin).origin)
  ]);
  const authenticationPolicy = new AuthenticationPolicyStore(
    options.db,
    options.registration ?? "closed"
  );
  const relayBroker = options.relayBroker ?? new LocalRelayBroker();
  const relay = new RelayHub(options.db, relayBroker);
  const noisePipes = options.nextControlPlane ? new NoisePipes(options.db, relayBroker) : undefined;
  const notifications = options.notifications
    ? new NotificationService(
        options.db,
        options.notifications.transports,
        options.notifications.pollIntervalMs,
        (error) => app.log.error({ err: error }, "notification delivery worker failed"),
        options.notifications.pushTargetSealer,
        options.nextTimers?.resolver
      )
    : undefined;
  const timers = options.nextTimers
    ? new TimerWorker(
        options.db,
        [notificationsConsumer(() => {
          void notifications?.drainOnce().catch(
            (error) => app.log.error({ err: error }, "notification delivery worker failed")
          );
        }, options.nextTimers.resolver)],
        {
          pollIntervalMs: options.nextTimers.pollIntervalMs,
          resolver: options.nextTimers.resolver,
          onError: (error) => app.log.error({ err: error }, "timer worker failed"),
          onMetric: (metric) => app.log.warn(metric, "privacy-safe Connect metric")
        }
      )
    : undefined;
  const scheduledEmails = options.emailTransport
    ? new ScheduledEmailWorker(
        options.db,
        options.emailTransport,
        renderScheduledEmail,
        publicUrl,
        undefined,
        (error) => app.log.error(
          { err: error },
          "scheduled email delivery worker failed"
        )
      )
    : undefined;
  const usageRetention = new UsageRetentionWorker(
    options.db,
    (error) => app.log.error({ err: error }, "usage retention worker failed")
  );
  if (options.hostedProvider && options.hostedReferenceAuthority) {
    throw new Error("Hosted provider and reference authority modes are mutually exclusive.");
  }
  if (options.hostedCollections && !options.hostedProvider && !options.hostedReferenceAuthority) {
    throw new Error("Hosted collections require a configured storage provider.");
  }
  const hostedReference = options.hostedReferenceAuthority
    ? new HostedAuthorityRegistry(options.db)
    : undefined;
  const applicationReconciliation = new ApplicationReconciliationWorker(
    options.db,
    relay,
    options.hostedProvider,
    (event) => app.log.error(
      { phase: event.phase, errorClass: event.errorClass },
      "application reconciliation operation failed"
    )
  );
  const providerRevocations = options.hostedProvider
    ? new ProviderRevocationWorker(
        options.db,
        options.hostedProvider,
        (error) => app.log.error(
          { err: error },
          "hosted provider cleanup worker failed"
        )
      )
    : undefined;

  const nextPolicyEmitter = options.nextControlPlane
    ? new PolicyEmitter(
        options.db,
        new LogServiceClient(options.nextControlPlane.logService),
        loadPolicySigner(options.nextControlPlane, Date.now()),
        (error, collectionId) => app.log.error({ err: error, collectionId }, "mdbase-next policy emission failed")
      )
    : undefined;

  await app.register(cookie);
  await app.register(helmet, {
    referrerPolicy: {
      policy: "strict-origin-when-cross-origin"
    },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'", ...(options.googleAuth ? ["https://accounts.google.com/gsi/"] : [])],
        fontSrc: ["'self'", "data:"],
        formAction: ["'self'"],
        frameSrc: options.googleAuth ? ["https://accounts.google.com/gsi/"] : ["'none'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", "data:", "https:"],
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
  await app.register(rawBody, {
    global: false,
    encoding: "utf8",
    runFirst: true
  });
  await app.register(cors, {
    origin: true,
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS"]
  });
  await app.register(websocket);
  app.addContentTypeParser(
    "application/mdbase-connect-file",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body)
  );

  app.addHook("onClose", async () => {
    await scheduledEmails?.close();
    await usageRetention.close();
    await applicationReconciliation.close();
    await providerRevocations?.close();
    await nextPolicyEmitter?.close();
    await timers?.close();
    await notifications?.close();
    noisePipes?.close();
    await relay.close();
  });
  notifications?.start();
  timers?.start();
  // Test hook intentionally drains the same production worker; it does not
  // bypass leases, cursors, result rows, or provider/relay behavior.
  app.decorate("drainApplicationReconciliation", () =>
    applicationReconciliation.drainUntilIdle()
  );
  applicationReconciliation.start();
  nextPolicyEmitter?.start();
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
      sessionToken(request)
      && request.headers.origin
      && !accountOrigins.has(request.headers.origin)
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
    revision: options.revision,
    environment: options.environment,
    publicUrl,
    editorOrigin: options.editorOrigin
  });
  if (options.resendWebhookSecret) {
    registerResendWebhookRoute(app, {
      db: options.db,
      signingSecret: options.resendWebhookSecret
    });
  }
  if (options.betaAccessOrigin) {
    registerBetaAccessRoutes(app, {
      allowedOrigin: options.betaAccessOrigin
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
    managementOrigins: options.managementOrigins,
    authenticationPolicy,
    githubAuth: options.githubAuth,
    googleAuth: options.googleAuth,
    authRateLimitSecret: options.authRateLimitSecret,
    authenticationLegalDocuments: options.authenticationLegalDocuments
  });
  registerConnectorPairingRoutes(app, {
    db: options.db,
    publicUrl,
    tailscaleAuth: options.tailscaleAuth
  });
  registerAccountSessionRoutes(app, {
    db: options.db,
    publicUrl,
    managementOrigins: options.managementOrigins,
    developmentAuth: options.devAuth
  });
  registerAccountManagementRoutes(app, {
    db: options.db,
    publicUrl,
    managementOrigins: options.managementOrigins,
    authenticationPolicy,
    tailscaleAuth: options.tailscaleAuth,
    developmentAuth: options.devAuth,
    passwordAuthenticationAvailable: Boolean(options.authRateLimitSecret),
    accountDeletionEnabled: options.accountDeletionEnabled !== false
      && hostedReference === undefined,
    githubAvailable: options.githubAuth !== undefined,
    googleAvailable: options.googleAuth !== undefined,
    hostedProvider: options.hostedProvider,
    triggerProviderCleanup: () => {
      void providerRevocations?.drain().catch((error) => app.log.error(
        { err: error },
        "hosted account cleanup trigger failed"
      ));
    }
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
    tailscaleAuth: options.tailscaleAuth,
    relay
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
    hostedProvider: options.hostedProvider,
    grantResolver: options.nextTimers?.resolver
  });
  if (timers) {
    registerTimerRoutes(app, {
      db: options.db,
      resolver: options.nextTimers?.resolver,
      hostedProvider: options.hostedProvider,
      onWrite: () => timers.wake()
    });
  }
  registerLifecycleDiagnosticRoute(app, {
    db: options.db,
    hostedProvider: options.hostedProvider
  });
  registerLocalOperationRoutes(app, { db: options.db, relay });
  registerPeopleRoutes(app, {
    db: options.db,
    issuer: options.identityIssuer ?? new URL(publicUrl).origin,
    publicUrl,
    editorOrigin: options.editorOrigin
  });
  registerLocalFileRoutes(app, { db: options.db, relay });
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
  registerHostedSharingRoutes(app, {
    db: options.db,
    hostedCollections: options.hostedCollections,
    hostedSharing: options.hostedSharing,
    tailscaleAuth: options.tailscaleAuth
  });
  registerOnboardingRoutes(app, {
    db: options.db,
    publicUrl,
    editorOrigin: options.editorOrigin,
    hostedCollections: options.hostedCollections,
    hostedProvider: options.hostedProvider
  });
  registerReferenceSyncRoutes(app, {
    db: options.db,
    hostedReference
  });
  if (options.nextControlPlane) {
    relay.useNextDevices(new NextRelayDevices(options.db, noisePipes));
    registerNextDeviceRoutes(app, { db: options.db });
    registerNoisePipeClientRoute(app, { db: options.db, broker: relayBroker });
    registerNextHostedRoutes(app, { db: options.db, tokens: options.nextControlPlane.serviceTokens });
  }
  registerConnectorRelayRoute(app, { db: options.db, relay });
  registerApplicationRoutes(app, {
    db: options.db,
    allowInsecureManifests: options.allowInsecureManifests
  });
  registerAccountOverviewRoute(app, {
    db: options.db,
    relay,
    publicUrl,
    authenticationPolicy,
    tailscaleAuth: options.tailscaleAuth,
    hostedCollections: options.hostedCollections,
    hostedSharing: options.hostedSharing,
    hostedProvider: options.hostedProvider,
    hostedReference
  });
  registerConnectorGrantRoutes(app, { db: options.db, relay });
  registerAuthorizationRoutes(app, {
    nextClientKeys: options.nextControlPlane !== undefined,
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

  scheduledEmails?.start();
  usageRetention.start();

  return { app, relay, timers };
}
