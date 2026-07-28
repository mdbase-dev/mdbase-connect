import { ECDH, randomUUID } from "node:crypto";
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
  ContractRequirement,
  EncryptedRelayOperationRequest,
  GrantEncryption,
  GrantPolicy,
  GrantScope,
  NotificationCriterion,
  TypeProvision
} from "@mdbase/connect-protocol";
import {
  ENCRYPTED_RELAY_PROTOCOL_VERSION,
  RELAY_ENCRYPTION_SUITE
} from "@mdbase/connect-protocol";
import { z, ZodError } from "zod";
import { SyncError } from "@mdbase/connect-sync";
import type { DatabasePool, DatabaseQueryable } from "./db.js";
import {
  AuthRateLimiter,
  type AuthRateLimitRule
} from "./auth-rate-limit.js";
import {
  ApplicationManifestError,
  registerApplicationManifest,
  type RegisteredApplicationManifest
} from "./manifest.js";
import { ConnectorOperationError, RelayHub, RelayUnavailableError } from "./relay.js";
import type { RelayBroker } from "./relay-broker.js";
import {
  canonicalUserCode,
  pkceChallenge,
  randomToken,
  randomUserCode,
  safeEqual,
  tokenHash
} from "./security.js";
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
  HostedProviderResponseError,
  HostedProviderUnavailableError
} from "./hosted-provider.js";
import {
  AuthorityProofError,
  verifyAuthorityRequestProof
} from "./authority-proof.js";
import {
  exchangeGitHubCode,
  GitHubIdentityError,
  type GitHubAuthConfig
} from "./github-auth.js";
import {
  AccountUnavailableError,
  createExternalSession
} from "./external-auth.js";
import { AuthenticationPolicyStore } from "./authentication-policy.js";
import {
  InvalidInvitationError,
  InvitationTargetConflictError,
  PasswordAccountService,
  PasswordAuthenticationUnavailableError,
  PasswordLoginRejectedError,
  AuthenticationPolicyIncompleteError
} from "./password-auth.js";
import {
  PASSWORD_MAX_UTF8_BYTES,
  PasswordPolicyError
} from "./password.js";
import {
  InvalidEmailAddressError,
  normalizeEmailAddress
} from "./email-identity.js";
import {
  GoogleIdentityError,
  verifyGoogleCredential,
  type GoogleAuthConfig
} from "./google-auth.js";
import type {
  AuthenticationLegalDocuments,
  RegistrationMode
} from "./runtime-config.js";
import {
  activeGrantForToken,
  NotificationService,
  type NotificationTransports
} from "./notifications.js";

const OPERATIONS = [
  "describe",
  "changes",
  "read",
  "query",
  "validate",
  "list_views",
  "execute_view",
  "read_view_source",
  "create_view_source",
  "update_view_source",
  "delete_view_source",
  "create",
  "update",
  "delete",
  "rename",
  "read_type",
  "create_type",
  "update_type",
  "list_timers",
  "put_timer",
  "cancel_timer",
  "reconcile_timers",
  "sync"
] as const;
const operationSchema = z.enum(OPERATIONS);
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const PASSWORD_LOGIN_EMAIL_LIMIT: AuthRateLimitRule = {
  maxAttempts: 5,
  windowSeconds: 15 * 60,
  baseBlockSeconds: 5 * 60,
  maxBlockSeconds: 60 * 60
};
const PASSWORD_LOGIN_IP_LIMIT: AuthRateLimitRule = {
  maxAttempts: 30,
  windowSeconds: 15 * 60,
  baseBlockSeconds: 5 * 60,
  maxBlockSeconds: 60 * 60
};
const PASSWORD_SIGNUP_TOKEN_LIMIT: AuthRateLimitRule = {
  maxAttempts: 5,
  windowSeconds: 60 * 60,
  baseBlockSeconds: 15 * 60,
  maxBlockSeconds: 6 * 60 * 60
};
const PASSWORD_SIGNUP_IP_LIMIT: AuthRateLimitRule = {
  maxAttempts: 10,
  windowSeconds: 60 * 60,
  baseBlockSeconds: 15 * 60,
  maxBlockSeconds: 6 * 60 * 60
};
const PASSWORD_AUTH_GLOBAL_LIMIT: AuthRateLimitRule = {
  maxAttempts: 300,
  windowSeconds: 60,
  baseBlockSeconds: 60,
  maxBlockSeconds: 15 * 60
};
const DEVICE_AUTHORIZATION_SECONDS = 600;
const DEVICE_POLL_INTERVAL_SECONDS = 5;
const contractRequirementSchema = z.object({
  id: z.string().trim().min(1).max(100),
  version: z.number().int().positive()
}).strict();
const encryptedRelayRequestSchema = z.object({
  type: z.literal("encrypted_operation_request"),
  protocol_version: z.literal(ENCRYPTED_RELAY_PROTOCOL_VERSION),
  suite: z.literal(RELAY_ENCRYPTION_SUITE),
  request_id: z.uuid(),
  grant_id: z.uuid(),
  application_id: z.uuid(),
  connector_id: z.uuid(),
  collection_id: z.uuid(),
  operation: operationSchema,
  scope_epoch: z.number().int().positive(),
  key_id: z.string().min(1).max(200),
  counter: z.string().regex(/^[1-9][0-9]{0,19}$/),
  ciphertext: z.string().min(1).max(2_800_000).regex(/^[A-Za-z0-9_-]+$/)
}).strict();
const syncMutationSchema = z.object({
  mutation_id: z.uuid(),
  replica_id: z.uuid(),
  scope_epoch: z.number().int().positive(),
  operation: z.enum(["create", "update", "rename", "delete"]),
  record_id: z.uuid(),
  base_revision: z.string().min(1).optional(),
  input: z.record(z.string(), z.unknown()),
  created_at: z.iso.datetime(),
  causal_predecessor: z.uuid().optional()
}).strict();

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

interface User {
  id: string;
  email: string | null;
  name: string;
  login: string | null;
  authentication_provider?: "github" | "google" | "password" | "session" | "tailscale";
}

interface ConnectorIdentity {
  id: string;
  user_id: string;
}

interface AuthorityTransferRow {
  id: string;
  user_id: string;
  hosted_collection_id: string;
  pairing_id: string;
  replica_id: string;
  local_collection_id: string | null;
  state: "requested" | "approved" | "prepared" | "activating" | "completed" | "cancelled" | "expired";
  final_head: string | number | null;
  next_authority_epoch: string | number | null;
  manifest_digest: string | null;
  expires_at: string | Date;
}

interface AuthorityTransferDetails extends AuthorityTransferRow {
  collection_name?: string;
  mirror_name?: string;
}

interface AuthorityImportTransferRow {
  id: string;
  user_id: string;
  hosted_collection_id: string;
  local_collection_id: string;
  state: "requested" | "prepared" | "activating" | "completed" | "cancelled" | "expired";
  final_head: string | number | null;
  next_authority_epoch: string | number;
  manifest_digest: string | null;
  source_revision: string | null;
  expires_at: string | Date;
}

interface AuthorityAdoptionRow {
  id: string;
  secret_hash: string;
  collection_id: string;
  display_name: string;
  source_name: string;
  retain_mirror: boolean;
  mirror_name: string | null;
  user_id: string | null;
  state: "requested" | "approved" | "prepared" | "activating" | "completed" | "cancelled" | "expired";
  next_authority_epoch: string | number;
  final_head: string | number | null;
  manifest_digest: string | null;
  source_revision: string | null;
  contracts: CollectionContractDescriptor[];
  expires_at: string | Date;
  approved_at: string | Date | null;
  prepared_at: string | Date | null;
  completed_at: string | Date | null;
}

interface AuthorityPairing {
  pairing_id: string;
  user_id: string;
  collection_id: string;
  replica_id: string;
  mode: "read_only" | "read_write";
  allowed_types: string[];
  authority_state: "active" | "transferring" | "transferred";
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
  const revision = options.revision?.trim() || undefined;
  const authenticationPolicy = new AuthenticationPolicyStore(
    options.db,
    options.registration ?? "closed"
  );
  const passwordAccounts = new PasswordAccountService(
    options.db,
    authenticationPolicy
  );
  const authenticationRateLimiter = options.authRateLimitSecret
    ? new AuthRateLimiter(options.db, options.authRateLimitSecret)
    : null;
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
    await notifications?.close();
    await relay.close();
  });
  notifications?.start();

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

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApplicationManifestError) {
      return reply.code(400).send(apiError("invalid_application_manifest", error.message));
    }
    if (error instanceof ZodError) {
      return reply.code(400).send(apiError("invalid_request", error.issues[0]?.message ?? "Invalid request."));
    }
    if (error instanceof RequestValidationError) {
      return reply.code(400).send(apiError("invalid_request", error.message));
    }
    if (error instanceof OriginDeniedError) {
      return reply.code(403).send(apiError(
        "origin_denied",
        "The request origin is not allowed."
      ));
    }
    if (error instanceof RelayUnavailableError) {
      return reply.code(409).send(apiError("connector_offline", error.message));
    }
    if (error instanceof ConnectorOperationError) {
      return reply.code(409).send(apiError(error.code, error.message));
    }
    if (error instanceof SyncError) {
      const denied = error.code === "replica_revoked" || error.code === "scope_denied" || error.code === "read_only_replica";
      return reply.code(denied ? 403 : 400).send(apiError(error.code, error.message));
    }
    if (error instanceof HostedProviderResponseError) {
      if ([400, 404, 409, 429].includes(error.status)) {
        return reply.code(error.status).send(apiError(error.code, error.message));
      }
      request.log.error({ provider_status: error.status, provider_code: error.code }, "Hosted provider rejected control request");
      return reply.code(502).send(apiError(
        "hosted_provider_error",
        "The hosted storage provider could not complete the request."
      ));
    }
    if (error instanceof HostedProviderUnavailableError) {
      request.log.error({ error: error.cause }, "Hosted provider is unavailable");
      return reply.code(503).send(apiError("hosted_provider_unavailable", error.message));
    }
    if (error instanceof GitHubIdentityError) {
      request.log.warn({ error: error.message }, "GitHub authentication failed");
      return reply.code(502).send(apiError(
        "identity_provider_error",
        "GitHub sign-in could not be completed. Please try again."
      ));
    }
    if (error instanceof GoogleIdentityError) {
      request.log.warn({ error: error.message }, "Google authentication failed");
      return reply.code(502).send(apiError(
        "identity_provider_error",
        "Google sign-in could not be completed. Please try again."
      ));
    }
    if (error instanceof AccountUnavailableError) {
      return reply.code(403).send(apiError(
        "account_not_allowed",
        "This account does not have access."
      ));
    }
    if (error instanceof PasswordLoginRejectedError) {
      return reply.code(401).send(apiError(
        "invalid_credentials",
        "Email or password is incorrect."
      ));
    }
    if (
      error instanceof InvalidInvitationError
      || error instanceof InvitationTargetConflictError
    ) {
      return reply.code(400).send(apiError(
        "invalid_invitation",
        "This invitation is invalid, expired, or can no longer be used."
      ));
    }
    if (error instanceof PasswordPolicyError) {
      return reply.code(400).send(apiError("invalid_password", error.message));
    }
    if (error instanceof InvalidEmailAddressError) {
      return reply.code(400).send(apiError(
        "invalid_request",
        "Email address is invalid."
      ));
    }
    if (error instanceof PasswordAuthenticationUnavailableError) {
      return reply.code(503).send(apiError(
        "authentication_unavailable",
        "Password authentication is temporarily unavailable."
      ));
    }
    if (error instanceof AuthenticationPolicyIncompleteError) {
      request.log.error("Password authentication policy is incomplete");
      return reply.code(503).send(apiError(
        "authentication_unavailable",
        "Password authentication is temporarily unavailable."
      ));
    }
    const statusCode = httpErrorStatus(error);
    if (statusCode === 413) {
      return reply.code(413).send(apiError(
        "payload_too_large",
        "The request body exceeds the allowed size."
      ));
    }
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send(apiError(
        "invalid_request",
        "The request body is invalid."
      ));
    }
    request.log.error(error);
    return reply.code(500).send(apiError("internal_error", "The request could not be completed."));
  });

  app.get("/health", async () => ({
    ok: true,
    service: "mdbase-connect",
    protocol_version: 1,
    ...(revision ? { revision } : {})
  }));
  app.get("/ready", async (_request, reply) => {
    try {
      await options.db.query("SELECT 1");
      await relay.ready();
      if (options.hostedCollections && options.hostedProvider) {
        await options.hostedProvider.ready();
      }
      return { ok: true, service: "mdbase-connect" };
    } catch {
      return reply.code(503).send({ ok: false, service: "mdbase-connect" });
    }
  });

  app.get("/v1/auth/config", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    const authenticationSettings = await authenticationPolicy.current();
    const passwordLogin =
      authenticationSettings.passwordAuthEnabled
      && authenticationRateLimiter !== null;
    const passwordRegistration =
      passwordLogin
      && authenticationSettings.registrationMode === "invite"
      && Boolean(authenticationSettings.termsVersion)
      && Boolean(authenticationSettings.privacyVersion)
      && options.authenticationLegalDocuments !== undefined;
    const providers = [
      ...(options.googleAuth
        ? [{ id: "google" as const, label: "Continue with Google", login_url: "/auth/google" }]
        : []),
      ...(options.githubAuth
        ? [{ id: "github" as const, label: "Continue with GitHub", login_url: "/auth/github" }]
        : [])
    ];
    const provider = options.tailscaleAuth
      ? "tailscale"
      : options.githubAuth
        ? "github"
        : options.googleAuth
          ? "google"
          : options.devAuth
            ? "development"
            : "session";
    return {
      provider,
      providers,
      registration: authenticationSettings.registrationMode,
      development_login: options.devAuth === true,
      ...(passwordLogin
        ? {
            password_login: true,
            ...(passwordRegistration
              ? {
                  password_registration: true,
                  agreements: {
                    terms: {
                      version: authenticationSettings.termsVersion!,
                      url: options.authenticationLegalDocuments!.termsUrl
                    },
                    privacy: {
                      version: authenticationSettings.privacyVersion!,
                      url: options.authenticationLegalDocuments!.privacyUrl
                    }
                  }
                }
              : {})
          }
        : {}),
      ...(providers.length === 1 ? { login_url: providers[0].login_url } : {})
    };
  });

  app.post("/v1/auth/password/signup", async (request, reply) => {
    reply.header("cache-control", "no-store");
    requireSameOrigin(request, publicUrl);
    if (!authenticationRateLimiter) {
      throw new PasswordAuthenticationUnavailableError();
    }
    if (!options.authenticationLegalDocuments) {
      throw new AuthenticationPolicyIncompleteError();
    }
    const input = z.object({
      invitation_token: z.string().min(1).max(200),
      name: z.string().trim().min(1).max(100),
      password: z.string().min(1).max(PASSWORD_MAX_UTF8_BYTES),
      terms_version: z.string().min(1).max(100),
      privacy_version: z.string().min(1).max(100)
    }).strict().parse(request.body);
    const allowed = await consumeAuthenticationLimits(
      authenticationRateLimiter,
      [
        {
          scope: "password.signup.token",
          key: input.invitation_token,
          rule: PASSWORD_SIGNUP_TOKEN_LIMIT
        },
        {
          scope: "password.signup.ip",
          key: request.ip,
          rule: PASSWORD_SIGNUP_IP_LIMIT
        },
        {
          scope: "password.signup.global",
          key: "global",
          rule: PASSWORD_AUTH_GLOBAL_LIMIT
        }
      ],
      reply
    );
    if (!allowed) return;
    const session = await passwordAccounts.acceptInvitation({
      invitationToken: input.invitation_token,
      name: input.name,
      password: input.password,
      termsVersion: input.terms_version,
      privacyVersion: input.privacy_version
    });
    setSessionCookie(reply, session.token, publicUrl);
    return reply.code(201).send({ user: session.user });
  });

  app.post("/v1/auth/password/invitation", async (request, reply) => {
    reply.header("cache-control", "no-store");
    requireSameOrigin(request, publicUrl);
    if (!authenticationRateLimiter) {
      throw new PasswordAuthenticationUnavailableError();
    }
    if (!options.authenticationLegalDocuments) {
      throw new AuthenticationPolicyIncompleteError();
    }
    const input = z.object({
      invitation_token: z.string().min(1).max(200)
    }).strict().parse(request.body);
    const allowed = await consumeAuthenticationLimits(
      authenticationRateLimiter,
      [
        {
          scope: "password.signup.token",
          key: input.invitation_token,
          rule: PASSWORD_SIGNUP_TOKEN_LIMIT
        },
        {
          scope: "password.signup.ip",
          key: request.ip,
          rule: PASSWORD_SIGNUP_IP_LIMIT
        },
        {
          scope: "password.signup.global",
          key: "global",
          rule: PASSWORD_AUTH_GLOBAL_LIMIT
        }
      ],
      reply
    );
    if (!allowed) return;
    const invitation = await passwordAccounts.invitationDetails(
      input.invitation_token
    );
    return {
      invitation: {
        email: invitation.email,
        expires_at: invitation.expiresAt.toISOString(),
        terms_version: invitation.termsVersion,
        privacy_version: invitation.privacyVersion
      }
    };
  });

  app.post("/v1/auth/password/login", async (request, reply) => {
    reply.header("cache-control", "no-store");
    requireSameOrigin(request, publicUrl);
    if (!authenticationRateLimiter) {
      throw new PasswordAuthenticationUnavailableError();
    }
    const input = z.object({
      email: z.email().max(320),
      password: z.string().min(1).max(PASSWORD_MAX_UTF8_BYTES)
    }).strict().parse(request.body);
    const normalizedEmail = normalizeEmailAddress(input.email);
    const allowed = await consumeAuthenticationLimits(
      authenticationRateLimiter,
      [
        {
          scope: "password.login.email",
          key: normalizedEmail,
          rule: PASSWORD_LOGIN_EMAIL_LIMIT
        },
        {
          scope: "password.login.ip",
          key: request.ip,
          rule: PASSWORD_LOGIN_IP_LIMIT
        },
        {
          scope: "password.login.global",
          key: "global",
          rule: PASSWORD_AUTH_GLOBAL_LIMIT
        }
      ],
      reply
    );
    if (!allowed) return;
    const session = await passwordAccounts.authenticate({
      email: normalizedEmail,
      password: input.password
    });
    setSessionCookie(reply, session.token, publicUrl);
    return { user: session.user };
  });

  app.get("/auth/github", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    if (!options.githubAuth) return reply.code(404).send(apiError("not_found", "Not found."));
    const query = z.object({ return_to: z.string().max(2_048).optional() }).parse(request.query);
    const state = randomToken("oauth");
    const codeVerifier = randomToken("pkce");
    const authenticationSettings = await authenticationPolicy.current();
    await options.db.query(
      "DELETE FROM oauth_login_states WHERE expires_at <= now() OR consumed_at IS NOT NULL"
    );
    await options.db.query(
      `INSERT INTO oauth_login_states
         (id, provider, state_hash, return_to, code_verifier, expires_at)
       VALUES ($1, 'github', $2, $3, $4, now() + interval '10 minutes')`,
      [randomUUID(), tokenHash(state), safeReturnTarget(query.return_to, publicUrl), codeVerifier]
    );
    reply.setCookie(oauthStateCookieName(publicUrl, "github"), state, {
      httpOnly: true,
      sameSite: "lax",
      secure: publicUrl.startsWith("https:"),
      path: "/",
      maxAge: 10 * 60
    });
    const authorize = new URL("https://github.com/login/oauth/authorize");
    authorize.searchParams.set("client_id", options.githubAuth.clientId);
    authorize.searchParams.set("redirect_uri", `${publicUrl}/auth/github/callback`);
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("code_challenge", pkceChallenge(codeVerifier));
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set(
      "allow_signup",
      authenticationSettings.registrationMode === "open" ? "true" : "false"
    );
    return reply.redirect(authorize.href);
  });

  app.get("/auth/github/callback", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    if (!options.githubAuth) return reply.code(404).send(apiError("not_found", "Not found."));
    const query = z.object({
      code: z.string().min(1).max(500).optional(),
      state: z.string().min(1).max(200).optional(),
      error: z.string().max(200).optional()
    }).parse(request.query);
    const cookieName = oauthStateCookieName(publicUrl, "github");
    const cookieState = request.cookies[cookieName];
    reply.clearCookie(cookieName, { path: "/", secure: publicUrl.startsWith("https:") });
    if (query.error || !query.code || !query.state || !cookieState || !safeEqual(query.state, cookieState)) {
      return reply.code(400).send(apiError("invalid_login", "The GitHub sign-in request is invalid or expired."));
    }
    const state = await options.db.query<{ code_verifier: string; return_to: string }>(
      `UPDATE oauth_login_states SET consumed_at = now()
       WHERE provider = 'github' AND state_hash = $1 AND consumed_at IS NULL AND expires_at > now()
       RETURNING code_verifier, return_to`,
      [tokenHash(query.state)]
    );
    if (!state.rows[0]) {
      return reply.code(400).send(apiError("invalid_login", "The GitHub sign-in request is invalid or expired."));
    }
    const identity = await exchangeGitHubCode(options.githubAuth, {
      code: query.code,
      codeVerifier: state.rows[0].code_verifier,
      redirectUri: `${publicUrl}/auth/github/callback`
    });
    if (!/^[1-9][0-9]*$/.test(identity.id) || !identity.login || identity.login.length > 100) {
      throw new GitHubIdentityError("GitHub returned an invalid user identity.");
    }
    const authenticationSettings = await authenticationPolicy.current();
    if (!identityAllowed(
      authenticationSettings.registrationMode,
      options.githubAuth.allowedUserIds,
      identity.id
    )) {
      request.log.warn({ github_user_id: identity.id }, "GitHub user is not on the login allowlist");
      return reply.code(403).send(apiError("account_not_allowed", "This account does not have access."));
    }
    const name = (identity.name?.trim() || identity.login).slice(0, 100);
    const email = identity.email?.trim().toLowerCase() || null;
    const session = await createExternalSession(options.db, {
      provider: "github",
      subject: identity.id,
      name,
      login: identity.login,
      email,
      emailVerified: false,
      avatarUrl: null
    });
    setSessionCookie(reply, session.token, publicUrl);
    return reply.redirect(state.rows[0].return_to);
  });

  app.get("/auth/google", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    if (!options.googleAuth) return reply.code(404).send(apiError("not_found", "Not found."));
    const query = z.object({ return_to: z.string().max(2_048).optional() }).parse(request.query);
    const state = randomToken("oauth");
    const nonce = randomToken("nonce");
    await options.db.query(
      "DELETE FROM oauth_login_states WHERE expires_at <= now() OR consumed_at IS NOT NULL"
    );
    await options.db.query(
      `INSERT INTO oauth_login_states
         (id, provider, state_hash, return_to, code_verifier, expires_at)
       VALUES ($1, 'google', $2, $3, $4, now() + interval '10 minutes')`,
      [randomUUID(), tokenHash(state), safeReturnTarget(query.return_to, publicUrl), nonce]
    );
    reply.setCookie(oauthStateCookieName(publicUrl, "google"), state, {
      httpOnly: true,
      sameSite: "lax",
      secure: publicUrl.startsWith("https:"),
      path: "/",
      maxAge: 10 * 60
    });
    reply.header("cache-control", "no-store");
    return { client_id: options.googleAuth.clientId, nonce };
  });

  app.post("/auth/google/callback", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    if (!options.googleAuth) return reply.code(404).send(apiError("not_found", "Not found."));
    if (
      request.headers.origin !== new URL(publicUrl).origin
      || request.headers["x-mdbase-auth"] !== "google"
    ) {
      return reply.code(403).send(apiError("origin_denied", "The sign-in response origin is not allowed."));
    }
    const input = z.object({ credential: z.string().min(100).max(20_000) }).strict().parse(request.body);
    const cookieName = oauthStateCookieName(publicUrl, "google");
    const cookieState = request.cookies[cookieName];
    reply.clearCookie(cookieName, { path: "/", secure: publicUrl.startsWith("https:") });
    if (!cookieState) {
      return reply.code(400).send(apiError("invalid_login", "The Google sign-in request is invalid or expired."));
    }
    const state = await options.db.query<{ code_verifier: string; return_to: string }>(
      `UPDATE oauth_login_states SET consumed_at = now()
       WHERE provider = 'google' AND state_hash = $1 AND consumed_at IS NULL AND expires_at > now()
       RETURNING code_verifier, return_to`,
      [tokenHash(cookieState)]
    );
    if (!state.rows[0]) {
      return reply.code(400).send(apiError("invalid_login", "The Google sign-in request is invalid or expired."));
    }
    const identity = await verifyGoogleCredential(options.googleAuth, {
      credential: input.credential,
      nonce: state.rows[0].code_verifier
    });
    if (!/^[A-Za-z0-9_-]{1,255}$/.test(identity.id)) {
      throw new GoogleIdentityError("Google returned an invalid account subject.");
    }
    const authenticationSettings = await authenticationPolicy.current();
    if (!identityAllowed(
      authenticationSettings.registrationMode,
      options.googleAuth.allowedSubjects,
      identity.id
    )) {
      request.log.warn({ google_subject: identity.id }, "Google user is not on the login allowlist");
      return reply.code(403).send(apiError("account_not_allowed", "This account does not have access."));
    }
    const name = identity.name.trim().slice(0, 100);
    if (!name) throw new GoogleIdentityError("Google returned an invalid account name.");
    const email = identity.emailVerified
      ? identity.email?.trim().toLowerCase().slice(0, 320) || null
      : null;
    const session = await createExternalSession(options.db, {
      provider: "google",
      subject: identity.id,
      name,
      login: null,
      email,
      emailVerified: identity.emailVerified,
      avatarUrl: identity.avatarUrl
    });
    setSessionCookie(reply, session.token, publicUrl);
    return { redirect_to: state.rows[0].return_to };
  });

  app.post("/v1/pairing-requests", async (request, reply) => {
    const input = z.object({
      connector_name: z.string().trim().min(1).max(100)
    }).parse(request.body);
    const id = randomUUID();
    const secret = randomToken("pair");
    await options.db.query(
      `INSERT INTO pairing_requests (id, secret_hash, connector_name, expires_at)
       VALUES ($1, $2, $3, now() + interval '10 minutes')`,
      [id, tokenHash(secret), input.connector_name]
    );
    return reply.code(201).send({
      pairing_id: id,
      pairing_secret: secret,
      verification_uri: `${publicUrl}/pair/${id}`,
      expires_in: 600
    });
  });

  app.get("/v1/pairing-requests/:pairingId", async (request, reply) => {
    const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
    if (!user) return;
    const { pairingId } = z.object({ pairingId: z.uuid() }).parse(request.params);
    const pairing = await options.db.query<{
      id: string;
      connector_name: string;
      approved_at: string | null;
      consumed_at: string | null;
      expires_at: string;
    }>(
      `SELECT id, connector_name, approved_at, consumed_at, expires_at
       FROM pairing_requests WHERE id = $1 AND expires_at > now()`,
      [pairingId]
    );
    if (!pairing.rows[0]) {
      return reply.code(404).send(apiError("pairing_not_found", "Pairing request expired or was not found."));
    }
    return { pairing: pairing.rows[0] };
  });

  app.post("/v1/pairing-requests/:pairingId/approve", async (request, reply) => {
    const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
    if (!user) return;
    const { pairingId } = z.object({ pairingId: z.uuid() }).parse(request.params);
    const approved = await options.db.query(
      `UPDATE pairing_requests SET user_id = $2, approved_at = now()
       WHERE id = $1 AND approved_at IS NULL AND consumed_at IS NULL AND expires_at > now()
       RETURNING id, connector_name`,
      [pairingId, user.id]
    );
    if (!approved.rows[0]) {
      return reply.code(404).send(apiError("pairing_not_found", "Pairing request expired or was already used."));
    }
    await audit(options.db, user.id, "connector.pairing_approved", pairingId, {
      name: approved.rows[0].connector_name
    });
    return {
      ok: true,
      deep_link: `mdbase-connect://paired?server=${encodeURIComponent(publicUrl)}&pairing_id=${pairingId}`
    };
  });

  app.post("/v1/pairing-requests/:pairingId/exchange", async (request, reply) => {
    const { pairingId } = z.object({ pairingId: z.uuid() }).parse(request.params);
    const secret = bearerToken(request);
    if (!secret) return reply.code(401).send(apiError("invalid_pairing", "Pairing secret required."));
    const pairing = await options.db.query<{
      id: string;
      connector_name: string;
      user_id: string | null;
      approved_at: string | null;
      consumed_at: string | null;
    }>(
      `SELECT id, connector_name, user_id, approved_at, consumed_at
       FROM pairing_requests
       WHERE id = $1 AND secret_hash = $2 AND expires_at > now()`,
      [pairingId, tokenHash(secret)]
    );
    const pending = pairing.rows[0];
    if (!pending) return reply.code(404).send(apiError("pairing_not_found", "Pairing request expired or was not found."));
    if (pending.consumed_at) return reply.code(409).send(apiError("pairing_used", "Pairing request has already been used."));
    if (!pending.approved_at || !pending.user_id) return reply.code(202).send({ status: "pending" });

    const consumed = await options.db.query(
      `UPDATE pairing_requests SET consumed_at = now()
       WHERE id = $1 AND consumed_at IS NULL RETURNING id`,
      [pairingId]
    );
    if (!consumed.rows[0]) return reply.code(409).send(apiError("pairing_used", "Pairing request has already been used."));
    const token = randomToken("con");
    const connector = await options.db.query<{ id: string; name: string }>(
      `INSERT INTO connectors (id, user_id, name, token_hash)
       VALUES ($1, $2, $3, $4) RETURNING id, name`,
      [randomUUID(), pending.user_id, pending.connector_name, tokenHash(token)]
    );
    await audit(options.db, pending.user_id, "connector.created", connector.rows[0].id, {
      name: pending.connector_name,
      pairing_id: pairingId
    });
    return { status: "paired", connector: connector.rows[0], token };
  });

  app.post("/v1/mirror-pairing-requests", async (request, reply) => {
    const input = z.object({
      mirror_name: z.string().trim().min(1).max(200),
      mode: z.enum(["read_only", "read_write"]),
      collection_id: z.uuid().optional()
    }).strict().parse(request.body);
    const id = randomUUID();
    const secret = randomToken("mir");
    await options.db.query(
      `INSERT INTO mirror_pairing_requests
         (id, secret_hash, mirror_name, mode, collection_hint, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + interval '10 minutes')`,
      [id, tokenHash(secret), input.mirror_name, input.mode, input.collection_id ?? null]
    );
    return reply.code(201).send({
      pairing_id: id,
      pairing_secret: secret,
      verification_uri: `${publicUrl}/mirror/${id}`,
      expires_in: 600
    });
  });

  app.get("/v1/mirror-pairing-requests/:pairingId", async (request, reply) => {
    const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
    if (!user) return;
    const { pairingId } = z.object({ pairingId: z.uuid() }).parse(request.params);
    const pairing = await options.db.query<{
      id: string;
      mirror_name: string;
      mode: "read_only" | "read_write";
      collection_hint: string | null;
      collection_id: string | null;
      approved_at: string | null;
      consumed_at: string | null;
      user_id: string | null;
    }>(
      `SELECT id, mirror_name, mode, collection_hint, collection_id, approved_at, consumed_at, user_id
       FROM mirror_pairing_requests
       WHERE id = $1 AND (expires_at > now() OR approved_at IS NOT NULL)`,
      [pairingId]
    );
    const pending = pairing.rows[0];
    if (!pending || (pending.user_id && pending.user_id !== user.id)) {
      return reply.code(404).send(apiError(
        "mirror_pairing_not_found",
        "Mirror approval expired or was not found."
      ));
    }
    const collections = await options.db.query<{ id: string; display_name: string }>(
      `SELECT id, display_name FROM hosted_collections
       WHERE user_id = $1 AND authority_state = 'active' ORDER BY display_name`,
      [user.id]
    );
    const { user_id: _userId, ...publicPairing } = pending;
    return { pairing: publicPairing, collections: collections.rows };
  });

  app.post("/v1/mirror-pairing-requests/:pairingId/approve", async (request, reply) => {
    const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
    if (!user) return;
    const { pairingId } = z.object({ pairingId: z.uuid() }).parse(request.params);
    const input = z.object({ collection_id: z.uuid() }).strict().parse(request.body);
    const approved = await options.db.query<{
      id: string;
      mirror_name: string;
      mode: "read_only" | "read_write";
    }>(
      `UPDATE mirror_pairing_requests
       SET user_id = $2, collection_id = $3, approved_at = now()
       WHERE id = $1 AND approved_at IS NULL AND consumed_at IS NULL
         AND expires_at > now()
         AND EXISTS (
           SELECT 1 FROM hosted_collections
           WHERE id = $3 AND user_id = $2 AND authority_state = 'active'
         )
       RETURNING id, mirror_name, mode`,
      [pairingId, user.id, input.collection_id]
    );
    if (!approved.rows[0]) {
      return reply.code(404).send(apiError(
        "mirror_pairing_not_found",
        "Mirror approval expired, was already used, or the collection was not found."
      ));
    }
    await audit(options.db, user.id, "hosted_replica.pairing_approved", pairingId, {
      collection_id: input.collection_id,
      mode: approved.rows[0].mode
    });
    return { ok: true };
  });

  app.post("/v1/mirror-pairing-requests/:pairingId/exchange", async (request, reply) => {
    const { pairingId } = z.object({ pairingId: z.uuid() }).parse(request.params);
    const secret = bearerToken(request);
    if (!secret) {
      return reply.code(401).send(apiError("invalid_mirror_pairing", "Mirror pairing secret required."));
    }
    const pairing = await options.db.query<{
      mirror_name: string;
      mode: "read_only" | "read_write";
      user_id: string | null;
      collection_id: string | null;
      replica_id: string | null;
      approved_at: string | null;
      consumed_at: string | null;
    }>(
      `SELECT mirror_name, mode, user_id, collection_id, replica_id, approved_at, consumed_at
       FROM mirror_pairing_requests
       WHERE id = $1 AND secret_hash = $2
         AND (expires_at > now() OR consumed_at IS NOT NULL)`,
      [pairingId, tokenHash(secret)]
    );
    const pending = pairing.rows[0];
    if (!pending) {
      return reply.code(404).send(apiError(
        "mirror_pairing_not_found",
        "Mirror approval expired or was not found."
      ));
    }
    if (!pending.approved_at || !pending.user_id || !pending.collection_id) {
      return reply.code(202).send({ status: "pending" });
    }
    if (pending.consumed_at && pending.replica_id) {
      return rotateMirrorPairingToken(
        options,
        hostedReference,
        publicUrl,
        pending.replica_id,
        pending.collection_id
      );
    }

    const replicaId = randomUUID();
    const token = randomToken("hsr");
    const tokenExpiresAt = replicaTokenExpiry();
    let registered = false;
    const connection = await options.db.connect();
    try {
      await connection.query("BEGIN");
      const locked = await connection.query<{
        mirror_name: string;
        mode: "read_only" | "read_write";
        user_id: string;
        collection_id: string;
        replica_id: string | null;
        consumed_at: string | null;
      }>(
        `SELECT mirror_name, mode, user_id, collection_id, replica_id, consumed_at
         FROM mirror_pairing_requests
         WHERE id = $1 AND secret_hash = $2 AND approved_at IS NOT NULL
         FOR UPDATE`,
        [pairingId, tokenHash(secret)]
      );
      const current = locked.rows[0];
      if (!current) {
        await connection.query("ROLLBACK");
        return reply.code(404).send(apiError(
          "mirror_pairing_not_found",
          "Mirror approval was not found."
        ));
      }
      if (current.consumed_at && current.replica_id) {
        await connection.query("COMMIT");
        return rotateMirrorPairingToken(
          options,
          hostedReference,
          publicUrl,
          current.replica_id,
          current.collection_id
        );
      }
      if (options.hostedProvider) {
        await options.hostedProvider.registerReplica(current.collection_id, {
          id: replicaId,
          name: current.mirror_name,
          mode: current.mode,
          allowedTypes: [],
          token
        });
      } else {
        await hostedReference!.registerReplica(current.collection_id, {
          id: replicaId,
          name: current.mirror_name,
          mode: current.mode,
          allowedTypes: []
        });
      }
      registered = true;
      await connection.query(
        `INSERT INTO hosted_replicas
           (id, collection_id, name, mode, allowed_types, token_hash)
         VALUES ($1, $2, $3, $4, '[]'::jsonb, $5)`,
        [
          replicaId,
          current.collection_id,
          current.mirror_name,
          current.mode,
          options.hostedProvider ? null : tokenHash(token)
        ]
      );
      await connection.query(
        `UPDATE mirror_pairing_requests
         SET replica_id = $2, consumed_at = now()
         WHERE id = $1`,
        [pairingId, replicaId]
      );
      await audit(connection, current.user_id, "hosted_replica.created", replicaId, {
        collection_id: current.collection_id,
        mode: current.mode,
        source: "browser_pairing"
      });
      await connection.query("COMMIT");
      return {
        status: "paired",
        replica: {
          id: replicaId,
          collection_id: current.collection_id,
          name: current.mirror_name,
          mode: current.mode
        },
        token,
        token_expires_at: tokenExpiresAt,
        sync_url: authorityUrl(
          options.hostedProvider?.url ?? publicUrl,
          current.collection_id,
          "sync"
        )
      };
    } catch (error) {
      await connection.query("ROLLBACK");
      if (registered) {
        if (options.hostedProvider) await options.hostedProvider.revokeReplica(replicaId).catch(() => undefined);
        else await hostedReference!.revokeReplica(pending.collection_id, replicaId).catch(() => undefined);
      }
      throw error;
    } finally {
      connection.release();
    }
  });

  app.post("/v1/mirror-pairing-requests/:pairingId/renew", async (request, reply) => {
    const { pairingId } = z.object({ pairingId: z.uuid() }).parse(request.params);
    const secret = bearerToken(request);
    if (!secret) {
      return reply.code(401).send(apiError("invalid_mirror_pairing", "Mirror refresh credential required."));
    }
    const pairing = await options.db.query<{
      secret_hash: string;
      replica_id: string | null;
      collection_id: string | null;
      consumed_at: string | null;
    }>(
      `SELECT secret_hash, replica_id, collection_id, consumed_at
       FROM mirror_pairing_requests WHERE id = $1`,
      [pairingId]
    );
    const renewal = pairing.rows[0];
    if (
      !renewal
      || !safeEqual(renewal.secret_hash, tokenHash(secret))
      || !renewal.consumed_at
      || !renewal.replica_id
      || !renewal.collection_id
    ) {
      return reply.code(404).send(apiError(
        "mirror_pairing_not_found",
        "This device can no longer renew mirror access."
      ));
    }
    return rotateMirrorPairingToken(
      options,
      hostedReference,
      publicUrl,
      renewal.replica_id,
      renewal.collection_id
    );
  });

  app.post("/v1/authority-adoptions", async (request, reply) => {
    if (!options.hostedCollections || !options.hostedProvider) {
      return reply.code(404).send(apiError(
        "hosted_adoption_unavailable",
        "This Connect server cannot adopt local collections."
      ));
    }
    await recoverExpiredAuthorityAdoptions(options.db, options.hostedProvider);
    const input = z.object({
      collection_id: z.uuid(),
      display_name: z.string().trim().min(1).max(200),
      source_name: z.string().trim().min(1).max(200),
      retain_mirror: z.boolean().default(true),
      mirror_name: z.string().trim().min(1).max(200).optional()
    }).strict().parse(request.body);
    const id = randomUUID();
    const secret = randomToken("adp");
    const expiresIn = 30 * 60;
    await options.db.query(
      `INSERT INTO authority_adoption_requests
         (id, secret_hash, collection_id, display_name, source_name,
          retain_mirror, mirror_name, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() + interval '30 minutes')`,
      [
        id,
        tokenHash(secret),
        input.collection_id,
        input.display_name,
        input.source_name,
        input.retain_mirror,
        input.retain_mirror ? (input.mirror_name ?? input.source_name) : null
      ]
    );
    return reply.code(201).send({
      adoption_id: id,
      adoption_secret: secret,
      verification_uri: `${publicUrl}/adopt/${id}`,
      expires_in: expiresIn
    });
  });

  app.get("/v1/authority-adoptions/:adoptionId", async (request, reply) => {
    const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
    if (!user) return;
    const { adoptionId } = z.object({ adoptionId: z.uuid() }).parse(request.params);
    await recoverExpiredAuthorityAdoptions(options.db, options.hostedProvider);
    const found = await options.db.query<AuthorityAdoptionRow>(
      `${authorityAdoptionSelect()}
       WHERE adoption.id = $1
         AND (adoption.expires_at > now() OR adoption.state NOT IN ('requested', 'approved', 'prepared'))
         AND (adoption.user_id IS NULL OR adoption.user_id = $2)`,
      [adoptionId, user.id]
    );
    const adoption = found.rows[0];
    if (!adoption) {
      return reply.code(404).send(apiError(
        "authority_adoption_not_found",
        "Collection adoption expired or was not found."
      ));
    }
    return { adoption: authorityAdoptionView(adoption) };
  });

  app.post("/v1/authority-adoptions/:adoptionId/approve", async (request, reply) => {
    if (!options.hostedCollections || !options.hostedProvider) {
      return reply.code(404).send(apiError(
        "hosted_adoption_unavailable",
        "This Connect server cannot adopt local collections."
      ));
    }
    const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
    if (!user) return;
    const { adoptionId } = z.object({ adoptionId: z.uuid() }).parse(request.params);
    z.object({}).strict().parse(request.body ?? {});
    await recoverExpiredAuthorityAdoptions(options.db, options.hostedProvider);
    const connection = await options.db.connect();
    try {
      await connection.query("BEGIN");
      const locked = await connection.query<AuthorityAdoptionRow>(
        `${authorityAdoptionSelect()}
         WHERE adoption.id = $1 FOR UPDATE`,
        [adoptionId]
      );
      const adoption = locked.rows[0];
      if (
        !adoption
        || (adoption.user_id !== null && adoption.user_id !== user.id)
        || new Date(adoption.expires_at).getTime() <= Date.now()
      ) {
        await connection.query("ROLLBACK");
        return reply.code(404).send(apiError(
          "authority_adoption_not_found",
          "Collection adoption expired or was not found."
        ));
      }
      if (adoption.state !== "requested") {
        await connection.query("COMMIT");
        if (["approved", "prepared", "activating", "completed"].includes(adoption.state)) {
          return { adoption: authorityAdoptionView(adoption) };
        }
        return reply.code(409).send(apiError(
          "authority_adoption_inactive",
          "Collection adoption is no longer awaiting approval."
        ));
      }
      const hosted = await connection.query<{ id: string }>(
        `INSERT INTO hosted_collections
           (id, user_id, display_name, template, provider_url, contracts,
            authority_state, authority_epoch)
         VALUES ($1, $2, $3, 'mdbase', $4, '[]'::jsonb, 'importing', $5)
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        [
          adoption.collection_id,
          user.id,
          adoption.display_name,
          options.hostedProvider.url,
          Number(adoption.next_authority_epoch)
        ]
      );
      if (!hosted.rows[0]) {
        await connection.query("ROLLBACK");
        return reply.code(409).send(apiError(
          "authority_adoption_collection_conflict",
          "A hosted collection already uses this collection identity."
        ));
      }
      if (adoption.retain_mirror) {
        await connection.query(
          `INSERT INTO mirror_pairing_requests
             (id, secret_hash, mirror_name, mode, user_id, collection_hint,
              collection_id, approved_at, expires_at)
           VALUES ($1, $2, $3, 'read_write', $4, $5, $5, now(), now() + interval '24 hours')`,
          [
            adoption.id,
            adoption.secret_hash,
            adoption.mirror_name ?? adoption.source_name,
            user.id,
            adoption.collection_id
          ]
        );
      }
      const approved = await connection.query<AuthorityAdoptionRow>(
        `UPDATE authority_adoption_requests
         SET user_id = $2, state = 'approved', approved_at = now()
         WHERE id = $1 AND state = 'requested'
         RETURNING *`,
        [adoptionId, user.id]
      );
      await audit(connection, user.id, "authority_adoption.approved", adoptionId, {
        collection_id: adoption.collection_id,
        retain_mirror: adoption.retain_mirror
      });
      await connection.query("COMMIT");
      return { adoption: authorityAdoptionView(approved.rows[0]) };
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
  });

  app.post("/v1/authority-adoptions/:adoptionId/exchange", async (request, reply) => {
    if (!options.hostedCollections || !options.hostedProvider) {
      return reply.code(404).send(apiError(
        "hosted_adoption_unavailable",
        "This Connect server cannot adopt local collections."
      ));
    }
    const { adoptionId } = z.object({ adoptionId: z.uuid() }).parse(request.params);
    z.object({}).strict().parse(request.body ?? {});
    const secret = bearerToken(request);
    if (!secret) {
      return reply.code(401).send(apiError(
        "invalid_authority_adoption",
        "Collection adoption credential required."
      ));
    }
    await recoverExpiredAuthorityAdoptions(options.db, options.hostedProvider);
    const adoption = await authorityAdoptionBySecret(options.db, adoptionId, secret);
    if (!adoption) {
      return reply.code(404).send(apiError(
        "authority_adoption_not_found",
        "Collection adoption expired or was not found."
      ));
    }
    if (adoption.state === "requested") {
      return reply.code(202).send({ status: "pending" });
    }
    if (adoption.state === "completed") {
      return {
        status: "completed",
        adoption: authorityAdoptionView(adoption)
      };
    }
    if (adoption.state === "activating") {
      return {
        status: "activating",
        adoption: authorityAdoptionView(adoption)
      };
    }
    if (adoption.state === "expired") {
      return reply.code(409).send(apiError(
        "authority_adoption_expired",
        "Collection adoption expired before hosted activation began."
      ));
    }
    if (adoption.state === "cancelled") {
      return reply.code(409).send(apiError(
        "authority_adoption_cancelled",
        "Collection adoption was cancelled before hosted activation began."
      ));
    }
    if (!["approved", "prepared"].includes(adoption.state)) {
      return reply.code(409).send(apiError(
        "authority_adoption_inactive",
        "Collection adoption is no longer active."
      ));
    }
    const importToken = randomToken("ati");
    const prepared = await options.hostedProvider.prepareAuthorityImport({
      transferId: adoption.id,
      collectionId: adoption.collection_id,
      displayName: adoption.display_name,
      token: importToken,
      authorityEpoch: Number(adoption.next_authority_epoch),
      ttlSeconds: 30 * 60
    });
    const saved = await options.db.query<AuthorityAdoptionRow>(
      `UPDATE authority_adoption_requests
       SET state = 'prepared', prepared_at = COALESCE(prepared_at, now()),
           expires_at = $2
       WHERE id = $1 AND state IN ('approved', 'prepared')
       RETURNING *`,
      [adoption.id, prepared.expires_at]
    );
    if (!saved.rows[0]) {
      return reply.code(409).send(apiError(
        "authority_adoption_state_changed",
        "Collection adoption changed state while upload access was prepared."
      ));
    }
    return {
      status: "ready",
      adoption: authorityAdoptionView(saved.rows[0]),
      staged: {
        state: prepared.state,
        manifest_digest: prepared.manifest_digest,
        source_revision: prepared.source_revision,
        source_head: prepared.source_head
      },
      import: authorityImportCapability(
        options.hostedProvider.url,
        adoption.id,
        importToken
      )
    };
  });

  app.post("/v1/authority-adoptions/:adoptionId/complete", async (request, reply) => {
    if (!options.hostedProvider) {
      return reply.code(404).send(apiError(
        "hosted_adoption_unavailable",
        "This Connect server cannot adopt local collections."
      ));
    }
    const { adoptionId } = z.object({ adoptionId: z.uuid() }).parse(request.params);
    const secret = bearerToken(request);
    if (!secret) {
      return reply.code(401).send(apiError(
        "invalid_authority_adoption",
        "Collection adoption credential required."
      ));
    }
    const input = z.object({
      manifest_digest: z.string().regex(/^[a-f0-9]{64}$/),
      source_revision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      source_head: z.number().int().nonnegative()
    }).strict().parse(request.body);
    const adoption = await authorityAdoptionBySecret(options.db, adoptionId, secret);
    if (!adoption) {
      return reply.code(404).send(apiError(
        "authority_adoption_not_found",
        "Collection adoption was not found."
      ));
    }
    if (adoption.state === "completed") {
      if (
        adoption.manifest_digest !== input.manifest_digest
        || adoption.source_revision !== input.source_revision
        || Number(adoption.final_head) !== input.source_head
      ) {
        return reply.code(409).send(apiError(
          "authority_adoption_snapshot_mismatch",
          "Completed adoption belongs to a different source snapshot."
        ));
      }
      return {
        status: "completed",
        adoption: authorityAdoptionView(adoption)
      };
    }
    if (
      !["prepared", "activating"].includes(adoption.state)
      || (
        adoption.state === "prepared"
        && new Date(adoption.expires_at).getTime() <= Date.now()
      )
    ) {
      return reply.code(409).send(apiError(
        "authority_adoption_inactive",
        "Collection adoption is no longer prepared."
      ));
    }
    if (
      adoption.state === "activating"
      && (
        adoption.manifest_digest !== input.manifest_digest
        || adoption.source_revision !== input.source_revision
        || Number(adoption.final_head) !== input.source_head
      )
    ) {
      return reply.code(409).send(apiError(
        "authority_adoption_snapshot_mismatch",
        "Authority activation must resume with the same fenced source snapshot."
      ));
    }
    if (adoption.state === "prepared") {
      const reserved = await options.db.query(
        `UPDATE authority_adoption_requests
         SET state = 'activating', manifest_digest = $2,
             source_revision = $3, final_head = $4
         WHERE id = $1 AND state = 'prepared'`,
        [
          adoption.id,
          input.manifest_digest,
          input.source_revision,
          input.source_head
        ]
      );
      if (reserved.rowCount !== 1) {
        return reply.code(409).send(apiError(
          "authority_adoption_state_changed",
          "Collection adoption changed state while activation was reserved."
        ));
      }
    }
    const completed = await options.hostedProvider.completeAuthorityImport(
      adoption.id,
      input.manifest_digest,
      input.source_revision
    );
    if (
      completed.id !== adoption.id
      || completed.collection_id !== adoption.collection_id
      || completed.state !== "completed"
      || completed.authority_epoch !== Number(adoption.next_authority_epoch)
      || completed.manifest_digest !== input.manifest_digest
      || completed.source_revision !== input.source_revision
      || completed.source_head !== input.source_head
    ) {
      throw new RequestValidationError(
        "The hosted authority activated a different adoption snapshot."
      );
    }
    const connection = await options.db.connect();
    try {
      await connection.query("BEGIN");
      const current = await connection.query<AuthorityAdoptionRow>(
        `${authorityAdoptionSelect()}
         WHERE adoption.id = $1 FOR UPDATE`,
        [adoption.id]
      );
      if (current.rows[0]?.state === "completed") {
        await connection.query("COMMIT");
        return {
          status: "completed",
          adoption: authorityAdoptionView(current.rows[0])
        };
      }
      if (current.rows[0]?.state !== "activating") {
        throw new RequestValidationError(
          "Collection adoption is not reserved for activation."
        );
      }
      const activated = await connection.query(
        `UPDATE hosted_collections
         SET authority_state = 'active', authority_epoch = $2, contracts = $3::jsonb
         WHERE id = $1 AND authority_state = 'importing'`,
        [
          adoption.collection_id,
          completed.authority_epoch,
          JSON.stringify(completed.contracts)
        ]
      );
      const committed = await connection.query<AuthorityAdoptionRow>(
        `UPDATE authority_adoption_requests
         SET state = 'completed', contracts = $2::jsonb, completed_at = now()
         WHERE id = $1 AND state = 'activating'
         RETURNING *`,
        [adoption.id, JSON.stringify(completed.contracts)]
      );
      if (activated.rowCount !== 1 || !committed.rows[0]) {
        throw new RequestValidationError(
          "Authority metadata changed while adoption completed."
        );
      }
      await audit(connection, adoption.user_id!, "authority_adoption.completed", adoption.id, {
        collection_id: adoption.collection_id,
        authority_epoch: completed.authority_epoch,
        retain_mirror: adoption.retain_mirror
      });
      await connection.query("COMMIT");
      return {
        status: "completed",
        adoption: authorityAdoptionView(committed.rows[0])
      };
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
  });

  app.delete("/v1/authority-adoptions/:adoptionId", async (request, reply) => {
    if (!options.hostedProvider) {
      return reply.code(404).send(apiError(
        "hosted_adoption_unavailable",
        "This Connect server cannot adopt local collections."
      ));
    }
    const { adoptionId } = z.object({ adoptionId: z.uuid() }).parse(request.params);
    const secret = bearerToken(request);
    if (!secret) {
      return reply.code(401).send(apiError(
        "invalid_authority_adoption",
        "Collection adoption credential required."
      ));
    }
    const adoption = await authorityAdoptionBySecret(options.db, adoptionId, secret);
    if (!adoption) {
      return reply.code(404).send(apiError(
        "authority_adoption_not_found",
        "Collection adoption was not found."
      ));
    }
    if (adoption.state === "completed") {
      return reply.code(409).send(apiError(
        "authority_adoption_completed",
        "Completed collection adoption cannot be cancelled."
      ));
    }
    if (adoption.state === "activating") {
      return reply.code(409).send(apiError(
        "authority_adoption_activation_started",
        "Hosted authority activation has started and can no longer be cancelled."
      ));
    }
    if (adoption.state !== "cancelled") {
      const cancelled = await options.db.query(
        `UPDATE authority_adoption_requests
         SET state = 'cancelled', cancelled_at = now()
         WHERE id = $1 AND state IN ('requested', 'approved', 'prepared', 'expired')`,
        [adoption.id]
      );
      if (cancelled.rowCount !== 1) {
        return reply.code(409).send(apiError(
          "authority_adoption_state_changed",
          "Collection adoption changed state while cancellation was reserved."
        ));
      }
    }
    try {
      await options.hostedProvider.abortAuthorityImport(adoption.id);
    } catch (error) {
      if (
        !(error instanceof HostedProviderResponseError)
        || !["authority_import_not_found", "authority_import_inactive"].includes(error.code)
      ) {
        throw error;
      }
    }
    const connection = await options.db.connect();
    try {
      await connection.query("BEGIN");
      await connection.query("DELETE FROM mirror_pairing_requests WHERE id = $1", [adoption.id]);
      await connection.query(
        `DELETE FROM hosted_collections
         WHERE id = $1 AND authority_state = 'importing'`,
        [adoption.collection_id]
      );
      if (adoption.user_id) {
        await audit(connection, adoption.user_id, "authority_adoption.cancelled", adoption.id, {
          collection_id: adoption.collection_id
        });
      }
      await connection.query("COMMIT");
      return { ok: true };
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
  });

  app.post("/v1/mirror-pairing-requests/:pairingId/authority-transfers", async (request, reply) => {
    const { pairingId } = z.object({ pairingId: z.uuid() }).parse(request.params);
    z.object({}).strict().parse(request.body ?? {});
    await recoverExpiredAuthorityTransfers(options.db, options.hostedProvider, hostedReference);
    const secret = bearerToken(request);
    if (!secret) {
      return reply.code(401).send(apiError(
        "invalid_mirror_pairing",
        "Mirror refresh credential required."
      ));
    }
    const pairing = await authorityPairing(options.db, pairingId, secret);
    if (!pairing) {
      return reply.code(404).send(apiError(
        "mirror_pairing_not_found",
        "This device can no longer move collection authority."
      ));
    }
    if (pairing.mode !== "read_write" || pairing.allowed_types.length > 0) {
      return reply.code(409).send(apiError(
        "promotion_mirror_ineligible",
        "Authority can move only to an active, two-way, full collection mirror."
      ));
    }
    const existing = await options.db.query<AuthorityTransferRow>(
      `SELECT id, user_id, hosted_collection_id, pairing_id, replica_id, local_collection_id,
              state, final_head, next_authority_epoch, manifest_digest, expires_at
       FROM authority_transfers
       WHERE pairing_id = $1 AND state IN ('requested', 'approved', 'prepared')
       ORDER BY created_at DESC LIMIT 1`,
      [pairingId]
    );
    if (existing.rows[0]) {
      return reply.code(200).send(authorityTransferResponse(existing.rows[0], publicUrl));
    }
    if (pairing.authority_state !== "active") {
      return reply.code(409).send(apiError(
        "authority_transfer_unavailable",
        "This hosted collection is not available for authority transfer."
      ));
    }
    const transferId = randomUUID();
    const transfer = await options.db.query<AuthorityTransferRow>(
      `INSERT INTO authority_transfers
         (id, user_id, hosted_collection_id, pairing_id, replica_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + interval '30 minutes')
       RETURNING id, user_id, hosted_collection_id, pairing_id, replica_id,
                 local_collection_id, state, final_head, next_authority_epoch,
                 manifest_digest, expires_at`,
      [transferId, pairing.user_id, pairing.collection_id, pairingId, pairing.replica_id]
    );
    await audit(options.db, pairing.user_id, "authority_transfer.requested", transferId, {
      collection_id: pairing.collection_id,
      replica_id: pairing.replica_id
    });
    return reply.code(201).send(authorityTransferResponse(transfer.rows[0], publicUrl));
  });

  app.get("/v1/authority-transfers/:transferId", async (request, reply) => {
    const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
    if (!user) return;
    const { transferId } = z.object({ transferId: z.uuid() }).parse(request.params);
    await recoverExpiredAuthorityTransfers(options.db, options.hostedProvider, hostedReference);
    const transfer = await options.db.query<AuthorityTransferDetails>(
      `SELECT transfer.id, transfer.user_id, transfer.hosted_collection_id,
              transfer.pairing_id, transfer.replica_id, transfer.local_collection_id,
              transfer.state, transfer.final_head, transfer.next_authority_epoch,
              transfer.manifest_digest, transfer.expires_at,
              hosted.display_name AS collection_name,
              replica.name AS mirror_name
       FROM authority_transfers transfer
       JOIN hosted_collections hosted ON hosted.id = transfer.hosted_collection_id
       JOIN hosted_replicas replica ON replica.id = transfer.replica_id
       WHERE transfer.id = $1 AND transfer.user_id = $2`,
      [transferId, user.id]
    );
    if (!transfer.rows[0]) {
      return reply.code(404).send(apiError(
        "authority_transfer_not_found",
        "Authority transfer was not found."
      ));
    }
    return { transfer: authorityTransferView(transfer.rows[0], publicUrl) };
  });

  app.post("/v1/authority-transfers/:transferId/approve", async (request, reply) => {
    const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
    if (!user) return;
    const { transferId } = z.object({ transferId: z.uuid() }).parse(request.params);
    z.object({}).strict().parse(request.body ?? {});
    await recoverExpiredAuthorityTransfers(options.db, options.hostedProvider, hostedReference);
    const approved = await options.db.query<AuthorityTransferRow>(
      `UPDATE authority_transfers
       SET state = 'approved', approved_at = now()
       WHERE id = $1 AND user_id = $2 AND state = 'requested' AND expires_at > now()
       RETURNING id, user_id, hosted_collection_id, pairing_id, replica_id,
                 local_collection_id, state, final_head, next_authority_epoch,
                 manifest_digest, expires_at`,
      [transferId, user.id]
    );
    if (!approved.rows[0]) {
      const existing = await options.db.query<AuthorityTransferRow>(
        `SELECT id, user_id, hosted_collection_id, pairing_id, replica_id,
                local_collection_id, state, final_head, next_authority_epoch,
                manifest_digest, expires_at
         FROM authority_transfers WHERE id = $1 AND user_id = $2`,
        [transferId, user.id]
      );
      if (existing.rows[0]?.state === "approved" || existing.rows[0]?.state === "prepared") {
        return { transfer: authorityTransferView(existing.rows[0], publicUrl) };
      }
      return reply.code(409).send(apiError(
        "authority_transfer_inactive",
        "Authority transfer expired or is no longer awaiting approval."
      ));
    }
    await audit(options.db, user.id, "authority_transfer.approved", transferId, {
      collection_id: approved.rows[0].hosted_collection_id
    });
    return { transfer: authorityTransferView(approved.rows[0], publicUrl) };
  });

  app.post("/v1/authority-transfers/:transferId/prepare", async (request, reply) => {
    const { transferId } = z.object({ transferId: z.uuid() }).parse(request.params);
    z.object({}).strict().parse(request.body ?? {});
    await recoverExpiredAuthorityTransfers(options.db, options.hostedProvider, hostedReference);
    const transfer = await mirrorAuthorityTransfer(
      options.db,
      transferId,
      bearerToken(request)
    );
    if (!transfer) {
      return reply.code(404).send(apiError(
        "authority_transfer_not_found",
        "Authority transfer was not found for this mirror."
      ));
    }
    const connection = await options.db.connect();
    try {
      await connection.query("BEGIN");
      const locked = await connection.query<AuthorityTransferRow>(
        `SELECT id, user_id, hosted_collection_id, pairing_id, replica_id,
                local_collection_id, state, final_head, next_authority_epoch,
                manifest_digest, expires_at
         FROM authority_transfers WHERE id = $1 FOR UPDATE`,
        [transferId]
      );
      const current = locked.rows[0];
      if (!current || current.pairing_id !== transfer.pairing_id) {
        await connection.query("ROLLBACK");
        return reply.code(404).send(apiError(
          "authority_transfer_not_found",
          "Authority transfer was not found for this mirror."
        ));
      }
      if (current.state === "requested") {
        await connection.query("COMMIT");
        return reply.code(202).send({ status: "pending" });
      }
      if (current.state === "prepared") {
        await connection.query("COMMIT");
        return { transfer: authorityTransferView(current, publicUrl) };
      }
      if (current.state !== "approved") {
        await connection.query("ROLLBACK");
        return reply.code(409).send(apiError(
          "authority_transfer_inactive",
          "Authority transfer is no longer active."
        ));
      }
      const prepared = options.hostedProvider
        ? await options.hostedProvider.prepareAuthorityTransfer(
            current.hosted_collection_id,
            { transferId, replicaId: current.replica_id, ttlSeconds: 900 }
          )
        : await hostedReference!.prepareAuthorityTransfer(
            current.hosted_collection_id,
            { transferId, replicaId: current.replica_id, ttlSeconds: 900 }
          );
      const saved = await connection.query<AuthorityTransferRow>(
        `UPDATE authority_transfers
         SET state = 'prepared', final_head = $2, next_authority_epoch = $3,
             manifest_digest = $4, expires_at = $5, prepared_at = now()
         WHERE id = $1 AND state = 'approved'
         RETURNING id, user_id, hosted_collection_id, pairing_id, replica_id,
                   local_collection_id, state, final_head, next_authority_epoch,
                   manifest_digest, expires_at`,
        [
          transferId,
          prepared.final_head,
          prepared.authority_epoch,
          prepared.manifest_digest,
          prepared.expires_at
        ]
      );
      await connection.query(
        `UPDATE hosted_collections
         SET authority_state = 'transferring'
         WHERE id = $1 AND authority_state = 'active'`,
        [current.hosted_collection_id]
      );
      await audit(connection, current.user_id, "authority_transfer.prepared", transferId, {
        collection_id: current.hosted_collection_id,
        final_head: prepared.final_head,
        authority_epoch: prepared.authority_epoch
      });
      await connection.query("COMMIT");
      return { transfer: authorityTransferView(saved.rows[0], publicUrl) };
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
  });

  app.post("/v1/authority-transfers/:transferId/complete", async (request, reply) => {
    const { transferId } = z.object({ transferId: z.uuid() }).parse(request.params);
    const input = z.object({
      manifest_digest: z.string().regex(/^[a-f0-9]{64}$/)
    }).strict().parse(request.body);
    const transfer = await mirrorAuthorityTransfer(
      options.db,
      transferId,
      bearerToken(request)
    );
    if (!transfer) {
      return reply.code(404).send(apiError(
        "authority_transfer_not_found",
        "Authority transfer was not found for this mirror."
      ));
    }
    if (transfer.state === "completed" && transfer.local_collection_id) {
      return {
        status: "completed",
        collection_id: transfer.hosted_collection_id,
        local_collection_id: transfer.local_collection_id,
        authority_epoch: Number(transfer.next_authority_epoch)
      };
    }
    if (transfer.state !== "prepared") {
      return reply.code(409).send(apiError(
        "authority_transfer_inactive",
        "Authority transfer is not prepared."
      ));
    }
    const candidates = await options.db.query<{ id: string; connector_id: string }>(
      `SELECT collection.id, collection.connector_id
       FROM collections collection
       JOIN connectors connector ON connector.id = collection.connector_id
       WHERE connector.user_id = $1
         AND collection.local_id = $2
         AND collection.authority_state = 'candidate'
       ORDER BY collection.last_seen_at DESC`,
      [transfer.user_id, transfer.hosted_collection_id]
    );
    if (candidates.rows.length === 0) {
      return reply.code(202).send({
        status: "waiting_for_connector",
        message: "The local connector has not registered the promoted collection yet."
      });
    }
    if (candidates.rows.length > 1) {
      return reply.code(409).send(apiError(
        "authority_target_ambiguous",
        "More than one computer registered this promoted collection."
      ));
    }
    const candidate = candidates.rows[0];
    const completed = options.hostedProvider
      ? await options.hostedProvider.completeAuthorityTransfer(transferId, input.manifest_digest)
      : await hostedReference!.completeAuthorityTransfer(transferId, input.manifest_digest);
    const connection = await options.db.connect();
    try {
      await connection.query("BEGIN");
      const locked = await connection.query<AuthorityTransferRow>(
        `SELECT id, user_id, hosted_collection_id, pairing_id, replica_id,
                local_collection_id, state, final_head, next_authority_epoch,
                manifest_digest, expires_at
         FROM authority_transfers WHERE id = $1 FOR UPDATE`,
        [transferId]
      );
      if (locked.rows[0]?.state === "completed" && locked.rows[0].local_collection_id) {
        await connection.query("COMMIT");
        return {
          status: "completed",
          collection_id: transfer.hosted_collection_id,
          local_collection_id: locked.rows[0].local_collection_id,
          authority_epoch: Number(locked.rows[0].next_authority_epoch)
        };
      }
      await connection.query(
        `UPDATE collections
         SET authority_state = 'active', authority_epoch = $2, enabled = true,
             last_seen_at = now()
         WHERE id = $1 AND authority_state = 'candidate'`,
        [candidate.id, completed.authority_epoch]
      );
      await connection.query(
        `UPDATE hosted_collections
         SET authority_state = 'transferred', authority_epoch = $2,
             transferred_collection_id = $3
         WHERE id = $1`,
        [transfer.hosted_collection_id, completed.authority_epoch, candidate.id]
      );
      const grants = await connection.query<{ id: string }>(
        "SELECT id FROM grants WHERE hosted_collection_id = $1",
        [transfer.hosted_collection_id]
      );
      const grantIds = grants.rows.map(({ id }) => id);
      await connection.query(
        `UPDATE access_tokens SET revoked_at = COALESCE(revoked_at, now())
         WHERE grant_id IN (
           SELECT id FROM grants WHERE hosted_collection_id = $1
         )`,
        [transfer.hosted_collection_id]
      );
      await connection.query(
        `UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, now())
         WHERE grant_id IN (
           SELECT id FROM grants WHERE hosted_collection_id = $1
         )`,
        [transfer.hosted_collection_id]
      );
      await connection.query(
        `UPDATE grants SET revoked_at = COALESCE(revoked_at, now())
         WHERE hosted_collection_id = $1`,
        [transfer.hosted_collection_id]
      );
      await connection.query(
        `UPDATE hosted_replicas
         SET revoked_at = COALESCE(revoked_at, now()), token_hash = NULL
         WHERE collection_id = $1`,
        [transfer.hosted_collection_id]
      );
      await connection.query(
        `UPDATE authority_transfers
         SET state = 'completed', local_collection_id = $2,
             next_authority_epoch = $3, completed_at = now()
         WHERE id = $1`,
        [transferId, candidate.id, completed.authority_epoch]
      );
      await audit(connection, transfer.user_id, "authority_transfer.completed", transferId, {
        collection_id: transfer.hosted_collection_id,
        local_collection_id: candidate.id,
        connector_id: candidate.connector_id,
        authority_epoch: completed.authority_epoch,
        revoked_grants: grantIds.length
      });
      await connection.query("COMMIT");
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
    await relay.pushPolicy(candidate.connector_id);
    return {
      status: "completed",
      collection_id: transfer.hosted_collection_id,
      local_collection_id: candidate.id,
      authority_epoch: completed.authority_epoch
    };
  });

  app.delete("/v1/authority-transfers/:transferId", async (request, reply) => {
    const { transferId } = z.object({ transferId: z.uuid() }).parse(request.params);
    const user = await authenticatedUser(request, options.db, options.tailscaleAuth);
    const transfer = user
      ? (await options.db.query<AuthorityTransferRow>(
          `SELECT id, user_id, hosted_collection_id, pairing_id, replica_id,
                  local_collection_id, state, final_head, next_authority_epoch,
                  manifest_digest, expires_at
           FROM authority_transfers WHERE id = $1 AND user_id = $2`,
          [transferId, user.id]
        )).rows[0]
      : await mirrorAuthorityTransfer(options.db, transferId, bearerToken(request));
    if (!transfer) {
      return reply.code(404).send(apiError(
        "authority_transfer_not_found",
        "Authority transfer was not found."
      ));
    }
    const connection = await options.db.connect();
    try {
      await connection.query("BEGIN");
      const locked = await connection.query<AuthorityTransferRow>(
        `SELECT id, user_id, hosted_collection_id, pairing_id, replica_id,
                local_collection_id, state, final_head, next_authority_epoch,
                manifest_digest, expires_at
         FROM authority_transfers WHERE id = $1 FOR UPDATE`,
        [transferId]
      );
      const current = locked.rows[0];
      if (!current || current.user_id !== transfer.user_id) {
        await connection.query("ROLLBACK");
        return reply.code(404).send(apiError(
          "authority_transfer_not_found",
          "Authority transfer was not found."
        ));
      }
      if (current.state === "completed") {
        await connection.query("ROLLBACK");
        return reply.code(409).send(apiError(
          "authority_transfer_completed",
          "Completed authority transfer cannot be cancelled."
        ));
      }
      if (current.state === "prepared") {
        if (options.hostedProvider) await options.hostedProvider.abortAuthorityTransfer(transferId);
        else await hostedReference!.abortAuthorityTransfer(transferId);
      }
      await connection.query(
        `UPDATE authority_transfers
         SET state = 'cancelled', cancelled_at = now()
         WHERE id = $1 AND state <> 'completed'`,
        [transferId]
      );
      await connection.query(
        `UPDATE hosted_collections SET authority_state = 'active'
         WHERE id = $1 AND authority_state = 'transferring'`,
        [current.hosted_collection_id]
      );
      await retireAuthorityCandidates(
        connection,
        current.user_id,
        current.hosted_collection_id
      );
      await audit(connection, current.user_id, "authority_transfer.cancelled", transferId, {
        collection_id: current.hosted_collection_id
      });
      await connection.query("COMMIT");
      return { ok: true };
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
  });

  app.post("/v1/dev/session", async (request, reply) => {
    if (!options.devAuth) return reply.code(404).send({ error: { code: "not_found", message: "Not found." } });
    const input = z.object({ email: z.email(), name: z.string().trim().min(1).max(100) }).parse(request.body);
    const id = randomUUID();
    const user = await options.db.query<User>(
      `INSERT INTO users (id, email, name) VALUES ($1, $2, $3)
       ON CONFLICT(email) DO UPDATE SET name = excluded.name
       RETURNING id, email, name`,
      [id, input.email.toLowerCase(), input.name]
    );
    const token = randomToken("ses");
    await options.db.query(
      `INSERT INTO sessions
         (id, user_id, token_hash, account_session_epoch, expires_at)
       SELECT $1, id, $3, session_epoch, now() + interval '30 days'
       FROM users WHERE id = $2 AND suspended_at IS NULL`,
      [randomUUID(), user.rows[0].id, tokenHash(token)]
    );
    setSessionCookie(reply, token, publicUrl);
    return { user: user.rows[0] };
  });

  app.post("/v1/logout", async (request, reply) => {
    const token = sessionToken(request);
    if (token) await options.db.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash(token)]);
    reply.clearCookie("mdbase_session", { path: "/" });
    reply.clearCookie("__Host-mdbase_session", { path: "/", secure: true });
    return { ok: true };
  });

  app.get("/v1/me", async (request, reply) => {
    const authenticated = await requireUser(request, reply, options.db, options.tailscaleAuth);
    if (!authenticated) return;
    if (options.hostedCollections) {
      await recoverExpiredAuthorityTransfers(options.db, options.hostedProvider, hostedReference);
    }
    const { authentication_provider: authenticationProvider, ...user } = authenticated;
    const connectors = await options.db.query(
      `SELECT c.id, c.name, c.last_seen_at, c.created_at
       FROM connectors c WHERE c.user_id = $1 ORDER BY c.created_at`,
      [user.id]
    );
    const collections = await options.db.query(
      `SELECT col.id, col.connector_id, col.local_id, col.display_name, col.spec_version, col.enabled,
              col.authority_state, col.authority_epoch, col.contracts, col.last_seen_at,
              c.name AS connector_name
       FROM collections col JOIN connectors c ON c.id = col.connector_id
       WHERE c.user_id = $1 AND col.authority_state = 'active'
         AND col.present = true
       ORDER BY col.display_name`,
      [user.id]
    );
    const hostedCollections = options.hostedCollections
      ? await options.db.query<{
          id: string;
          display_name: string;
          template: string;
          contracts: CollectionContractDescriptor[];
          provider_url: string | null;
          authority_state: "active" | "transferring" | "transferred";
          authority_epoch: string | number;
          transferred_collection_id: string | null;
          created_at: string;
        }>(
          `SELECT id, display_name, template, provider_url, contracts, authority_state,
                  authority_epoch, transferred_collection_id, created_at
           FROM hosted_collections
           WHERE user_id = $1 AND authority_state <> 'importing'
           ORDER BY display_name`,
          [user.id]
        )
      : { rows: [] };
    const hostedReplicas = hostedCollections.rows.length
      ? await options.db.query<{
          id: string;
          collection_id: string;
          name: string;
          mode: "read_only" | "read_write";
          allowed_types: string[];
          revoked_at: string | null;
          created_at: string;
        }>(
          `SELECT r.id, r.collection_id, r.name, r.mode, r.allowed_types,
                  r.revoked_at, r.created_at
           FROM hosted_replicas r JOIN hosted_collections c ON c.id = r.collection_id
           WHERE c.user_id = $1 AND r.purpose = 'mirror' ORDER BY r.created_at`,
          [user.id]
        )
      : { rows: [] };
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
              COALESCE(g.collection_id, g.hosted_collection_id) AS collection_id,
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
              ar.collection_hint, ar.expires_at,
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
      collections: collections.rows,
      hosted_collections: hostedCollections.rows.map((collection) => ({
        ...collection,
        provider_url: collection.provider_url ?? publicUrl,
        spec_version: "0.3.0",
        authority_epoch: Number(collection.authority_epoch),
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

  app.post("/v1/connectors", async (request, reply) => {
    const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
    if (!user) return;
    const input = z.object({ name: z.string().trim().min(1).max(100) }).parse(request.body);
    const token = randomToken("con");
    const connector = await options.db.query<{ id: string; name: string }>(
      `INSERT INTO connectors (id, user_id, name, token_hash)
       VALUES ($1, $2, $3, $4) RETURNING id, name`,
      [randomUUID(), user.id, input.name, tokenHash(token)]
    );
    await audit(options.db, user.id, "connector.created", connector.rows[0].id, { name: input.name });
    return reply.code(201).send({ connector: connector.rows[0], token });
  });

  app.patch("/v1/connectors/self", async (request, reply) => {
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return;
    const input = z.object({ name: z.string().trim().min(1).max(100) }).strict().parse(request.body);
    const renamed = await options.db.query<{ id: string; name: string }>(
      "UPDATE connectors SET name = $2 WHERE id = $1 RETURNING id, name",
      [connector.id, input.name]
    );
    await audit(options.db, connector.user_id, "connector.renamed", connector.id, {
      name: input.name,
      source: "local_controller"
    });
    return { connector: renamed.rows[0] };
  });

  app.patch("/v1/connectors/:connectorId", async (request, reply) => {
    const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
    if (!user) return;
    const { connectorId } = z.object({ connectorId: z.uuid() }).parse(request.params);
    const input = z.object({ name: z.string().trim().min(1).max(100) }).strict().parse(request.body);
    const renamed = await options.db.query<{ id: string; name: string }>(
      "UPDATE connectors SET name = $3 WHERE id = $1 AND user_id = $2 RETURNING id, name",
      [connectorId, user.id, input.name]
    );
    if (!renamed.rows[0]) return reply.code(404).send(apiError("connector_not_found", "Computer not found."));
    await audit(options.db, user.id, "connector.renamed", connectorId, { name: input.name });
    return { connector: renamed.rows[0] };
  });

  app.delete("/v1/connectors/:connectorId", async (request, reply) => {
    const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
    if (!user) return;
    const { connectorId } = z.object({ connectorId: z.uuid() }).parse(request.params);
    const removed = await options.db.query(
      "DELETE FROM connectors WHERE id = $1 AND user_id = $2 RETURNING id",
      [connectorId, user.id]
    );
    if (!removed.rows[0]) return reply.code(404).send(apiError("connector_not_found", "Computer not found."));
    await audit(options.db, user.id, "connector.revoked", connectorId, {});
    return { ok: true };
  });

  app.post("/v1/connectors/sync", async (request, reply) => {
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return;
    const input = z.object({
      relay_public_key: z.string().min(80).max(200).refine(isP256PublicKey).optional(),
      inventory_revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      collections: z.array(z.object({
        id: z.uuid(),
        display_name: z.string().min(1).max(200),
        spec_version: z.string().min(1).max(30),
        enabled: z.boolean(),
        contracts: z.array(contractRequirementSchema).max(100).default([])
      })).max(1_000)
    }).parse(request.body);
    if (new Set(input.collections.map((collection) => collection.id)).size !== input.collections.length) {
      throw new RequestValidationError("A collection may appear only once in an inventory.");
    }
    const connection = await options.db.connect();
    try {
      await connection.query("BEGIN");
      await connection.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [
        connector.user_id
      ]);
      const accepted = await connection.query(
        `UPDATE connectors SET
           inventory_revision = $2,
           relay_public_key = COALESCE($3, relay_public_key),
           last_seen_at = now()
         WHERE id = $1 AND inventory_revision < $2
         RETURNING id`,
        [connector.id, input.inventory_revision, input.relay_public_key ?? null]
      );
      if (!accepted.rows[0]) {
        const current = await connection.query<{ inventory_revision: string | number }>(
          "SELECT inventory_revision FROM connectors WHERE id = $1",
          [connector.id]
        );
        await connection.query("COMMIT");
        return {
          accepted: false,
          inventory_revision: Number(current.rows[0]?.inventory_revision ?? 0),
          collections: []
        };
      }

      const synchronized = [];
      for (const collection of input.collections) {
        const existing = await connection.query<{
          id: string;
          authority_state: "active" | "candidate" | "retired";
          authority_epoch: string | number;
        }>(
          `SELECT id, authority_state, authority_epoch
           FROM collections WHERE connector_id = $1 AND local_id = $2`,
          [connector.id, collection.id]
        );
        const activeAuthority = await connection.query<{
          id: string;
          authority_epoch: string | number;
        }>(
          `SELECT id, authority_epoch FROM collections
           WHERE user_id = $1 AND local_id = $2 AND authority_state = 'active'`,
          [connector.user_id, collection.id]
        );
        const hosted = await connection.query<{
          authority_state: "active" | "transferring" | "transferred";
          authority_epoch: string | number;
          transferred_collection_id: string | null;
        }>(
          `SELECT authority_state, authority_epoch, transferred_collection_id
           FROM hosted_collections WHERE id = $1 AND user_id = $2`,
          [collection.id, connector.user_id]
        );
        const existingCollection = existing.rows[0];
        const currentAuthority = activeAuthority.rows[0];
        const hostedCollection = hosted.rows[0];
        const isActivatedTransfer = Boolean(
          hostedCollection?.authority_state === "transferred"
          && hostedCollection.transferred_collection_id
          && hostedCollection.transferred_collection_id === existingCollection?.id
        );
        const authorityState: "active" | "candidate" = hostedCollection
          ? (isActivatedTransfer ? "active" : "candidate")
          : (currentAuthority && currentAuthority.id !== existingCollection?.id
            ? "candidate"
            : "active");
        const authorityEpoch = Number(
          hostedCollection?.authority_epoch
          ?? currentAuthority?.authority_epoch
          ?? existingCollection?.authority_epoch
          ?? 1
        );
        const enabled = authorityState === "active" && collection.enabled;
        const row = await connection.query<{
          id: string;
          local_id: string;
          authority_state: "active" | "candidate" | "retired";
          authority_epoch: string | number;
        }>(
          `INSERT INTO collections
             (id, user_id, connector_id, local_id, display_name, spec_version, enabled,
              reported_enabled, present, authority_state, authority_epoch, contracts,
              last_inventory_revision)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9, $10, $11::jsonb, $12)
           ON CONFLICT(connector_id, local_id) DO UPDATE SET
             user_id = excluded.user_id,
             display_name = excluded.display_name,
             spec_version = excluded.spec_version,
             enabled = excluded.enabled,
             reported_enabled = excluded.reported_enabled,
             present = true,
             authority_state = excluded.authority_state,
             authority_epoch = excluded.authority_epoch,
             contracts = excluded.contracts,
             last_inventory_revision = excluded.last_inventory_revision,
             last_seen_at = now(),
             removed_at = NULL
           RETURNING id, local_id, authority_state, authority_epoch`,
          [
            randomUUID(),
            connector.user_id,
            connector.id,
            collection.id,
            collection.display_name,
            collection.spec_version,
            enabled,
            collection.enabled,
            authorityState,
            authorityEpoch,
            JSON.stringify(collection.contracts),
            input.inventory_revision
          ]
        );
        synchronized.push({
          ...row.rows[0],
          authority_epoch: Number(row.rows[0].authority_epoch)
        });
      }

      const removed = await connection.query<{ id: string }>(
        `UPDATE collections SET
           present = false,
           enabled = false,
           authority_state = 'retired',
           removed_at = now()
         WHERE connector_id = $1 AND present = true
           AND last_inventory_revision < $2
         RETURNING id`,
        [connector.id, input.inventory_revision]
      );
      for (const collection of removed.rows) {
        const revoked = await connection.query<{ id: string }>(
          `UPDATE grants SET revoked_at = COALESCE(revoked_at, now())
           WHERE collection_id = $1 AND revoked_at IS NULL
           RETURNING id`,
          [collection.id]
        );
        for (const grant of revoked.rows) {
          await connection.query(
            "UPDATE access_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE grant_id = $1",
            [grant.id]
          );
          await connection.query(
            "UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE grant_id = $1",
            [grant.id]
          );
        }
      }
      await connection.query("COMMIT");
      return {
        accepted: true,
        inventory_revision: input.inventory_revision,
        collections: synchronized
      };
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
  });

  app.post("/v1/connectors/collections/:collectionId/authority-transfers", async (request, reply) => {
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return;
    const { collectionId } = z.object({ collectionId: z.uuid() }).parse(request.params);
    z.object({}).strict().parse(request.body ?? {});
    if (!options.hostedCollections || !options.hostedProvider) {
      return reply.code(404).send(apiError(
        "remote_authority_unavailable",
        "This Connect server has no remote collection authority."
      ));
    }
    await recoverExpiredAuthorityTransfers(options.db, options.hostedProvider, hostedReference);
    const source = await options.db.query<{
      id: string;
      local_id: string;
      display_name: string;
      authority_epoch: string | number;
      contracts: CollectionContractDescriptor[];
      authority_state: "active" | "retired";
      enabled: boolean;
      reported_enabled: boolean;
    }>(
      `SELECT id, local_id, display_name, authority_epoch, contracts,
              authority_state, enabled, reported_enabled
       FROM collections
       WHERE connector_id = $1 AND user_id = $2 AND local_id = $3
         AND authority_state IN ('active', 'retired') AND present = true`,
      [connector.id, connector.user_id, collectionId]
    );
    const local = source.rows[0];
    if (!local) {
      return reply.code(404).send(apiError(
        "authority_source_not_found",
        "The active local collection authority was not found."
      ));
    }
    const existing = await options.db.query<AuthorityImportTransferRow>(
      `SELECT id, user_id, hosted_collection_id, local_collection_id, state,
              final_head, next_authority_epoch, manifest_digest,
              source_revision, expires_at
       FROM authority_transfers
       WHERE local_collection_id = $1 AND direction = 'to_hosted'
         AND (
           (
             state IN ('requested', 'prepared', 'activating')
             AND next_authority_epoch = $2
           )
           OR (
             state = 'completed'
             AND next_authority_epoch = $3
           )
         )
       ORDER BY created_at DESC LIMIT 1`,
      [
        local.id,
        Number(local.authority_epoch) + 1,
        Number(local.authority_epoch)
      ]
    );
    if (
      existing.rows[0]?.state === "completed"
      && local.authority_state === "retired"
    ) {
      return {
        transfer: authorityImportTransferView(existing.rows[0])
      };
    }
    if (existing.rows[0]?.state === "activating") {
      return {
        transfer: authorityImportTransferView(existing.rows[0])
      };
    }
    if (local.authority_state !== "active" || !local.enabled || !local.reported_enabled) {
      return reply.code(409).send(apiError(
        "authority_transfer_inactive",
        "The local collection is no longer an active authority."
      ));
    }
    let transfer = existing.rows[0];
    if (!transfer) {
      const transferId = randomUUID();
      const authorityEpoch = Number(local.authority_epoch) + 1;
      const expiresAt = new Date(Date.now() + 30 * 60 * 1_000);
      const connection = await options.db.connect();
      try {
        await connection.query("BEGIN");
        const target = await connection.query<{ id: string }>(
          `INSERT INTO hosted_collections
             (id, user_id, display_name, template, provider_url, contracts,
              authority_state, authority_epoch)
           VALUES ($1, $2, $3, 'mdbase', $4, $5::jsonb, 'importing', $6)
           ON CONFLICT (id) DO UPDATE SET
             display_name = EXCLUDED.display_name,
             provider_url = EXCLUDED.provider_url,
             contracts = EXCLUDED.contracts,
             authority_state = 'importing',
             authority_epoch = EXCLUDED.authority_epoch
           WHERE hosted_collections.user_id = EXCLUDED.user_id
             AND hosted_collections.authority_state = 'transferred'
           RETURNING id`,
          [
            local.local_id,
            connector.user_id,
            local.display_name,
            options.hostedProvider.url,
            JSON.stringify(local.contracts ?? []),
            authorityEpoch
          ]
        );
        if (!target.rows[0]) {
          throw new RequestValidationError(
            "The remote collection identity is already in use by an active authority."
          );
        }
        const inserted = await connection.query<AuthorityImportTransferRow>(
          `INSERT INTO authority_transfers
             (id, user_id, hosted_collection_id, local_collection_id, direction,
              state, next_authority_epoch, expires_at)
           VALUES ($1, $2, $3, $4, 'to_hosted', 'requested', $5, $6)
           RETURNING id, user_id, hosted_collection_id, local_collection_id, state,
                     final_head, next_authority_epoch, manifest_digest,
                     source_revision, expires_at`,
          [
            transferId,
            connector.user_id,
            local.local_id,
            local.id,
            authorityEpoch,
            expiresAt
          ]
        );
        transfer = inserted.rows[0];
        await audit(connection, connector.user_id, "authority_transfer.requested", transferId, {
          collection_id: local.local_id,
          direction: "to_hosted",
          connector_id: connector.id,
          authority_epoch: authorityEpoch
        });
        await connection.query("COMMIT");
      } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
      } finally {
        connection.release();
      }
    }
    const transferId = transfer!.id;
    const authorityEpoch = Number(transfer!.next_authority_epoch);
    const importToken = randomToken("ati");
    const prepared = await options.hostedProvider.prepareAuthorityImport({
      transferId,
      collectionId: local.local_id,
      displayName: local.display_name,
      token: importToken,
      authorityEpoch,
      ttlSeconds: 30 * 60
    });
    const refreshed = await options.db.query<AuthorityImportTransferRow>(
      `UPDATE authority_transfers
       SET state = 'prepared', expires_at = $2
       WHERE id = $1 AND state IN ('requested', 'prepared')
       RETURNING id, user_id, hosted_collection_id, local_collection_id, state,
                 final_head, next_authority_epoch, manifest_digest,
                 source_revision, expires_at`,
      [transferId, prepared.expires_at]
    );
    transfer = refreshed.rows[0];
    if (!transfer) {
      throw new RequestValidationError(
        "Authority transfer changed state while its import capability was prepared."
      );
    }
    return reply.code(existing.rows[0] ? 200 : 201).send({
      transfer: authorityImportTransferView(transfer!),
      import: authorityImportCapability(options.hostedProvider.url, transferId, importToken)
    });
  });

  app.post("/v1/connectors/authority-transfers/:transferId/complete", async (request, reply) => {
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return;
    if (!options.hostedProvider) {
      return reply.code(404).send(apiError(
        "remote_authority_unavailable",
        "This Connect server has no remote collection authority."
      ));
    }
    const { transferId } = z.object({ transferId: z.uuid() }).parse(request.params);
    const input = z.object({
      manifest_digest: z.string().regex(/^[a-f0-9]{64}$/),
      source_revision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      source_head: z.number().int().nonnegative()
    }).strict().parse(request.body);
    const found = await options.db.query<AuthorityImportTransferRow>(
      `SELECT transfer.id, transfer.user_id, transfer.hosted_collection_id,
              transfer.local_collection_id, transfer.state, transfer.final_head,
              transfer.next_authority_epoch, transfer.manifest_digest,
              transfer.source_revision, transfer.expires_at
       FROM authority_transfers transfer
       JOIN collections source ON source.id = transfer.local_collection_id
       WHERE transfer.id = $1 AND transfer.direction = 'to_hosted'
         AND source.connector_id = $2 AND transfer.user_id = $3`,
      [transferId, connector.id, connector.user_id]
    );
    const transfer = found.rows[0];
    if (!transfer) {
      return reply.code(404).send(apiError(
        "authority_transfer_not_found",
        "Authority transfer was not found for this connector."
      ));
    }
    if (transfer.state === "completed") {
      return {
        status: "completed",
        collection_id: transfer.hosted_collection_id,
        authority_epoch: Number(transfer.next_authority_epoch)
      };
    }
    if (
      !["prepared", "activating"].includes(transfer.state)
      || (
        transfer.state === "prepared"
        && new Date(transfer.expires_at).getTime() <= Date.now()
      )
    ) {
      return reply.code(409).send(apiError(
        "authority_transfer_inactive",
        "Authority transfer is no longer prepared."
      ));
    }
    if (
      transfer.state === "activating"
      && (
        transfer.manifest_digest !== input.manifest_digest
        || transfer.source_revision !== input.source_revision
        || Number(transfer.final_head) !== input.source_head
      )
    ) {
      return reply.code(409).send(apiError(
        "authority_transfer_snapshot_mismatch",
        "Authority activation must resume with the same fenced source snapshot."
      ));
    }
    if (transfer.state === "prepared") {
      const preflight = await options.db.connect();
      try {
        await preflight.query("BEGIN");
        const source = await preflight.query<{
          authority_state: string;
          authority_epoch: string | number;
        }>(
          `SELECT authority_state, authority_epoch FROM collections
           WHERE id = $1 AND connector_id = $2 FOR UPDATE`,
          [transfer.local_collection_id, connector.id]
        );
        if (
          source.rows[0]?.authority_state !== "active"
          || Number(source.rows[0].authority_epoch) + 1
            !== Number(transfer.next_authority_epoch)
        ) {
          throw new RequestValidationError(
            "The local authority epoch changed while the transfer was staged."
          );
        }
        const reserved = await preflight.query(
          `UPDATE authority_transfers
           SET state = 'activating', manifest_digest = $2,
               source_revision = $3, final_head = $4
           WHERE id = $1 AND state = 'prepared'`,
          [transferId, input.manifest_digest, input.source_revision, input.source_head]
        );
        if (reserved.rowCount !== 1) {
          throw new RequestValidationError(
            "Authority transfer changed state while activation was reserved."
          );
        }
        await preflight.query("COMMIT");
      } catch (error) {
        await preflight.query("ROLLBACK");
        throw error;
      } finally {
        preflight.release();
      }
    }
    const completed = await options.hostedProvider.completeAuthorityImport(
      transferId,
      input.manifest_digest,
      input.source_revision
    );
    if (
      completed.id !== transferId
      || completed.collection_id !== transfer.hosted_collection_id
      || completed.state !== "completed"
      || completed.authority_epoch !== Number(transfer.next_authority_epoch)
      || completed.manifest_digest !== input.manifest_digest
      || completed.source_revision !== input.source_revision
      || completed.source_head !== input.source_head
    ) {
      throw new RequestValidationError(
        "The remote authority activated a different transfer snapshot."
      );
    }
    const connection = await options.db.connect();
    try {
      await connection.query("BEGIN");
      const current = await connection.query<{ state: string }>(
        "SELECT state FROM authority_transfers WHERE id = $1 FOR UPDATE",
        [transferId]
      );
      if (current.rows[0]?.state === "completed") {
        await connection.query("COMMIT");
        return {
          status: "completed",
          collection_id: transfer.hosted_collection_id,
          authority_epoch: Number(transfer.next_authority_epoch)
        };
      }
      if (current.rows[0]?.state !== "activating") {
        throw new RequestValidationError(
          "Authority transfer is not reserved for activation."
        );
      }
      const source = await connection.query<{ authority_state: string; authority_epoch: string | number }>(
        `SELECT authority_state, authority_epoch FROM collections
         WHERE id = $1 AND connector_id = $2 FOR UPDATE`,
        [transfer.local_collection_id, connector.id]
      );
      if (
        source.rows[0]?.authority_state !== "active"
        || Number(source.rows[0].authority_epoch) + 1 !== completed.authority_epoch
      ) {
        throw new RequestValidationError(
          "The local authority epoch changed while the transfer was staged."
        );
      }
      const retired = await connection.query(
        `UPDATE collections
         SET authority_state = 'retired', enabled = false,
             authority_epoch = $2, last_seen_at = now()
         WHERE id = $1 AND authority_state = 'active'
           AND authority_epoch = $3`,
        [
          transfer.local_collection_id,
          completed.authority_epoch,
          completed.authority_epoch - 1
        ]
      );
      const activated = await connection.query(
        `UPDATE hosted_collections
         SET authority_state = 'active', authority_epoch = $2,
             transferred_collection_id = NULL
         WHERE id = $1 AND authority_state = 'importing'`,
        [transfer.hosted_collection_id, completed.authority_epoch]
      );
      if (retired.rowCount !== 1 || activated.rowCount !== 1) {
        throw new RequestValidationError(
          "Authority metadata changed while remote activation completed."
        );
      }
      const grants = await connection.query<{ id: string }>(
        "SELECT id FROM grants WHERE collection_id = $1 AND revoked_at IS NULL",
        [transfer.local_collection_id]
      );
      for (const grant of grants.rows) {
        await connection.query(
          "UPDATE access_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE grant_id = $1",
          [grant.id]
        );
        await connection.query(
          "UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE grant_id = $1",
          [grant.id]
        );
      }
      await connection.query(
        "UPDATE grants SET revoked_at = COALESCE(revoked_at, now()) WHERE collection_id = $1",
        [transfer.local_collection_id]
      );
      const committed = await connection.query(
        `UPDATE authority_transfers
         SET state = 'completed', completed_at = now()
         WHERE id = $1 AND state = 'activating'`,
        [transferId]
      );
      if (committed.rowCount !== 1) {
        throw new RequestValidationError(
          "Authority transfer changed state while completion was committed."
        );
      }
      await audit(connection, connector.user_id, "authority_transfer.completed", transferId, {
        collection_id: transfer.hosted_collection_id,
        direction: "to_hosted",
        connector_id: connector.id,
        authority_epoch: completed.authority_epoch,
        revoked_grants: grants.rows.length
      });
      await connection.query("COMMIT");
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
    await relay.pushPolicy(connector.id);
    return {
      status: "completed",
      collection_id: transfer.hosted_collection_id,
      authority_epoch: completed.authority_epoch
    };
  });

  app.delete("/v1/connectors/authority-transfers/:transferId", async (request, reply) => {
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return;
    if (!options.hostedProvider) {
      return reply.code(404).send(apiError(
        "remote_authority_unavailable",
        "This Connect server has no remote collection authority."
      ));
    }
    const { transferId } = z.object({ transferId: z.uuid() }).parse(request.params);
    const found = await options.db.query<AuthorityImportTransferRow>(
      `SELECT transfer.id, transfer.user_id, transfer.hosted_collection_id,
              transfer.local_collection_id, transfer.state, transfer.final_head,
              transfer.next_authority_epoch, transfer.manifest_digest,
              transfer.source_revision, transfer.expires_at
       FROM authority_transfers transfer
       JOIN collections source ON source.id = transfer.local_collection_id
       WHERE transfer.id = $1 AND transfer.direction = 'to_hosted'
         AND source.connector_id = $2 AND transfer.user_id = $3`,
      [transferId, connector.id, connector.user_id]
    );
    const transfer = found.rows[0];
    if (!transfer) {
      return reply.code(404).send(apiError(
        "authority_transfer_not_found",
        "Authority transfer was not found for this connector."
      ));
    }
    if (transfer.state === "completed") {
      return reply.code(409).send(apiError(
        "authority_transfer_completed",
        "Completed authority transfer cannot be cancelled."
      ));
    }
    if (!["requested", "prepared"].includes(transfer.state)) {
      return reply.code(409).send(apiError(
        "authority_transfer_activation_started",
        "Authority activation has started and can no longer be cancelled."
      ));
    }
    try {
      await options.hostedProvider.abortAuthorityImport(transferId);
    } catch (error) {
      if (
        !(error instanceof HostedProviderResponseError)
        || error.code !== "authority_import_not_found"
      ) {
        throw error;
      }
    }
    const connection = await options.db.connect();
    try {
      await connection.query("BEGIN");
      const cancelled = await connection.query(
        `UPDATE authority_transfers SET state = 'cancelled'
         WHERE id = $1 AND state IN ('requested', 'prepared')`,
        [transferId]
      );
      if (cancelled.rowCount !== 1) {
        throw new RequestValidationError(
          "Authority transfer changed state while cancellation was committed."
        );
      }
      await audit(connection, connector.user_id, "authority_transfer.cancelled", transferId, {
        collection_id: transfer.hosted_collection_id,
        direction: "to_hosted"
      });
      await connection.query(
        `UPDATE hosted_collections
         SET authority_state = 'transferred', authority_epoch = $2
         WHERE id = $1 AND authority_state = 'importing'
           AND transferred_collection_id IS NOT NULL`,
        [
          transfer.hosted_collection_id,
          Number(transfer.next_authority_epoch) - 1
        ]
      );
      await connection.query(
        `DELETE FROM hosted_collections
         WHERE id = $1 AND authority_state = 'importing'
           AND transferred_collection_id IS NULL`,
        [transfer.hosted_collection_id]
      );
      await connection.query("COMMIT");
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
    return { ok: true };
  });

  app.post("/v1/connectors/authority-conflicts/:collectionId/move", async (request, reply) => {
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return;
    const { collectionId } = z.object({ collectionId: z.uuid() }).parse(request.params);
    const connection = await options.db.connect();
    const affectedConnectors = new Set<string>([connector.id]);
    try {
      await connection.query("BEGIN");
      await connection.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [
        connector.user_id
      ]);
      const candidate = await connection.query<{
        id: string;
        reported_enabled: boolean;
        authority_epoch: string | number;
      }>(
        `SELECT id, reported_enabled, authority_epoch FROM collections
         WHERE connector_id = $1 AND user_id = $2 AND local_id = $3
           AND present = true AND authority_state = 'candidate'
         FOR UPDATE`,
        [connector.id, connector.user_id, collectionId]
      );
      if (!candidate.rows[0]) {
        await connection.query("ROLLBACK");
        return reply.code(404).send(apiError(
          "authority_conflict_not_found",
          "This folder no longer has an authority conflict."
        ));
      }
      const hosted = await connection.query<{ authority_state: string }>(
        `SELECT authority_state FROM hosted_collections
         WHERE id = $1 AND user_id = $2 AND authority_state <> 'transferred'`,
        [collectionId, connector.user_id]
      );
      if (hosted.rows[0]) {
        throw new RequestValidationError(
          "Use the hosted collection transfer flow before moving this authority."
        );
      }
      const current = await connection.query<{
        id: string;
        connector_id: string;
        authority_epoch: string | number;
      }>(
        `SELECT id, connector_id, authority_epoch FROM collections
         WHERE user_id = $1 AND local_id = $2 AND authority_state = 'active'
         FOR UPDATE`,
        [connector.user_id, collectionId]
      );
      const nextEpoch = Math.max(
        Number(candidate.rows[0].authority_epoch),
        ...current.rows.map((authority) => Number(authority.authority_epoch))
      ) + 1;
      for (const authority of current.rows) {
        affectedConnectors.add(authority.connector_id);
        await connection.query(
          `UPDATE collections SET authority_state = 'retired', enabled = false,
                                  authority_epoch = $2
           WHERE id = $1`,
          [authority.id, nextEpoch]
        );
        const revoked = await connection.query<{ id: string }>(
          `UPDATE grants SET revoked_at = COALESCE(revoked_at, now())
           WHERE collection_id = $1 AND revoked_at IS NULL RETURNING id`,
          [authority.id]
        );
        for (const grant of revoked.rows) {
          await connection.query(
            "UPDATE access_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE grant_id = $1",
            [grant.id]
          );
          await connection.query(
            "UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE grant_id = $1",
            [grant.id]
          );
        }
      }
      await connection.query(
        `UPDATE collections SET authority_state = 'active',
                                authority_epoch = $2,
                                enabled = reported_enabled
         WHERE id = $1`,
        [candidate.rows[0].id, nextEpoch]
      );
      await connection.query(
        `DELETE FROM authorization_collection_offers
         WHERE collection_id = $1 OR collection_id IN (
           SELECT id FROM collections
           WHERE user_id = $2 AND local_id = $3
         )`,
        [candidate.rows[0].id, connector.user_id, collectionId]
      );
      await audit(connection, connector.user_id, "collection.authority_moved", collectionId, {
        connector_id: connector.id,
        authority_epoch: nextEpoch
      });
      await connection.query("COMMIT");
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
    for (const connectorId of affectedConnectors) await relay.pushPolicy(connectorId);
    return { ok: true };
  });

  app.get("/v1/connectors/control", async (request, reply) => {
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return;
    const account = await options.db.query<{
      connector_id: string;
      connector_name: string;
      user_name: string;
      user_email: string;
    }>(
      `SELECT c.id AS connector_id, c.name AS connector_name,
              u.name AS user_name, COALESCE(i.email, '@' || i.login, u.email) AS user_email
       FROM connectors c
       JOIN users u ON u.id = c.user_id
       LEFT JOIN external_identities i ON i.user_id = u.id
       WHERE c.id = $1`,
      [connector.id]
    );
    const grants = await options.db.query(
      `SELECT g.id, g.application_id, a.name AS application_name,
              a.distribution AS application_distribution,
              a.homepage AS application_homepage,
              a.project_url AS application_project_url,
              CASE WHEN g.application_origin = '' THEN a.homepage
                   ELSE g.application_origin END AS application_origin,
              a.icon AS application_icon,
              col.local_id AS collection_id, col.display_name AS collection_name,
              g.operations, g.scope, g.encryption, g.created_at,
              g.notification_criteria
       FROM grants g
       JOIN applications a ON a.id = g.application_id
       JOIN collections col ON col.id = g.collection_id
       WHERE col.connector_id = $1 AND g.revoked_at IS NULL
         AND g.activated_at IS NOT NULL
       ORDER BY a.name, col.display_name`,
      [connector.id]
    );
    const pendingAuthorizations = await options.db.query(
      `SELECT ar.id, ar.application_id, a.name AS application_name,
              a.distribution AS application_distribution,
              a.homepage AS application_homepage,
              a.project_url AS application_project_url, a.icon AS application_icon,
              ar.flow, ar.user_code,
              ar.requested_operations, hinted.local_id AS collection_hint,
              ar.expires_at, a.requirements, a.provisions, a.notifications
       FROM authorization_requests ar
       JOIN applications a ON a.id = ar.application_id
       LEFT JOIN collections hinted
         ON hinted.id = ar.collection_hint AND hinted.connector_id = $2
       WHERE ar.user_id = $1 AND ar.completed_at IS NULL AND ar.denied_at IS NULL
         AND ar.expires_at > now()
       ORDER BY ar.expires_at`,
      [connector.user_id, connector.id]
    );
    const authorityConflicts = await options.db.query(
      `SELECT candidate.local_id AS collection_id,
              candidate.display_name,
              COALESCE(active_connector.name, 'mdbase cloud') AS active_connector_name
       FROM collections candidate
       LEFT JOIN collections active
         ON active.user_id = candidate.user_id
        AND active.local_id = candidate.local_id
        AND active.authority_state = 'active'
       LEFT JOIN connectors active_connector ON active_connector.id = active.connector_id
       WHERE candidate.connector_id = $1
         AND candidate.present = true
         AND candidate.authority_state = 'candidate'
       ORDER BY candidate.display_name`,
      [connector.id]
    );
    return {
      configured: true,
      online: true,
      account: account.rows[0],
      grants: grants.rows.map((grant) => ({
        ...grant,
        application_origin: normalizedApplicationOrigin(grant.application_origin)
      })),
      pending_authorizations: pendingAuthorizations.rows
        .filter((authorization) => !requiresHostedCollection(authorization.requirements)),
      authority_conflicts: authorityConflicts.rows
    };
  });

  app.get("/v1/connectors/apps/:applicationId", async (request, reply) => {
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return;
    const { applicationId } = z.object({ applicationId: z.uuid() }).parse(request.params);
    const application = await options.db.query(
      `SELECT id, distribution, name, homepage, project_url, icon,
              requirements, provisions, notifications
       FROM applications WHERE id = $1`,
      [applicationId]
    );
    if (!application.rows[0]) {
      return reply.code(404).send(apiError("application_not_found", "Application not found."));
    }
    return { application: application.rows[0] };
  });

  app.post("/v1/connectors/grants", async (request, reply) => {
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return;
    const input = z.object({
      application_id: z.uuid(),
      collection_id: z.uuid(),
      operations: z.array(operationSchema).min(1),
      contracts: z.array(contractRequirementSchema).max(100).optional()
    }).parse(request.body);
    if (input.contracts) {
      await options.db.query(
        `UPDATE collections SET contracts = $3::jsonb, last_seen_at = now()
         WHERE connector_id = $1 AND local_id = $2 AND enabled = true
           AND present = true AND authority_state = 'active'`,
        [connector.id, input.collection_id, JSON.stringify(input.contracts)]
      );
    }
    const collection = await options.db.query<{ id: string; contracts: ContractRequirement[]; spec_version: string }>(
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
    const scope = scopeForRequirements(application.rows[0].requirements);
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
      contracts: z.array(contractRequirementSchema).max(100).optional()
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

  app.get("/v1/connectors/hosted-control", async (request, reply) => {
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return;
    return hostedControlSnapshot(options, hostedReference, publicUrl, connector.user_id);
  });

  app.post("/v1/connectors/hosted/collections", async (request, reply) => {
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return;
    const input = z.object({
      display_name: z.string().trim().min(1).max(200),
      template: z.literal("mdbase").default("mdbase")
    }).strict().parse(request.body);
    const collection = await createHostedCollectionForUser(
      options,
      hostedReference,
      publicUrl,
      connector.user_id,
      input.display_name,
      input.template
    );
    return reply.code(201).send({ collection });
  });

  app.patch("/v1/connectors/hosted/collections/:collectionId", async (request, reply) => {
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return;
    const { collectionId } = z.object({ collectionId: z.uuid() }).parse(request.params);
    const input = z.object({
      display_name: z.string().trim().min(1).max(200)
    }).strict().parse(request.body);
    const collection = await renameHostedCollectionForUser(
      options,
      connector.user_id,
      collectionId,
      input.display_name
    );
    if (!collection) {
      return reply.code(404).send(apiError(
        "hosted_collection_not_found",
        "Hosted collection not found."
      ));
    }
    return { collection };
  });

  app.delete("/v1/connectors/hosted/collections/:collectionId", async (request, reply) => {
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return;
    const { collectionId } = z.object({ collectionId: z.uuid() }).parse(request.params);
    if (!await deleteHostedCollectionForUser(
      options,
      hostedReference,
      connector.user_id,
      collectionId
    )) {
      return reply.code(404).send(apiError(
        "hosted_collection_not_found",
        "Hosted collection not found."
      ));
    }
    return { ok: true };
  });

  app.post(
    "/v1/connectors/mirror-pairing-requests/:pairingId/approve",
    async (request, reply) => {
      const connector = await requireConnector(request, reply, options.db);
      if (!connector) return;
      const { pairingId } = z.object({ pairingId: z.uuid() }).parse(request.params);
      const input = z.object({ collection_id: z.uuid() }).strict().parse(request.body);
      const approved = await options.db.query<{
        id: string;
        mode: "read_only" | "read_write";
      }>(
        `UPDATE mirror_pairing_requests
         SET user_id = $2, collection_id = $3, approved_at = now()
         WHERE id = $1 AND approved_at IS NULL AND consumed_at IS NULL
           AND expires_at > now()
           AND EXISTS (
             SELECT 1 FROM hosted_collections
             WHERE id = $3 AND user_id = $2 AND authority_state = 'active'
           )
         RETURNING id, mode`,
        [pairingId, connector.user_id, input.collection_id]
      );
      if (!approved.rows[0]) {
        return reply.code(404).send(apiError(
          "mirror_pairing_not_found",
          "Mirror setup expired, was already used, or the collection was not found."
        ));
      }
      await audit(options.db, connector.user_id, "hosted_replica.pairing_approved", pairingId, {
        collection_id: input.collection_id,
        connector_id: connector.id,
        mode: approved.rows[0].mode,
        source: "desktop"
      });
      return { ok: true };
    }
  );

  app.delete("/v1/connectors/hosted/replicas/:replicaId", async (request, reply) => {
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return;
    const { replicaId } = z.object({ replicaId: z.uuid() }).parse(request.params);
    if (!await revokeHostedReplicaForUser(
      options,
      hostedReference,
      connector.user_id,
      replicaId
    )) {
      return reply.code(404).send(apiError("replica_not_found", "Active mirror not found."));
    }
    return { ok: true };
  });

  app.post(
    "/v1/connectors/hosted/authorization-requests/:requestId/approve",
    async (request, reply) => {
      const connector = await requireConnector(request, reply, options.db);
      if (!connector) return;
      const { requestId } = z.object({ requestId: z.uuid() }).parse(request.params);
      const input = z.object({
        collection_id: z.uuid(),
        operations: z.array(operationSchema).min(1)
      }).strict().parse(request.body);
      if (!options.hostedProvider) {
        return reply.code(503).send(apiError(
          "hosted_provider_unavailable",
          "Hosted application access is temporarily unavailable."
        ));
      }
      const hosted = await options.db.query<{
        id: string;
        template: HostedTemplate;
        display_name: string;
        contracts: CollectionContractDescriptor[];
      }>(
        `SELECT id, template, display_name, contracts FROM hosted_collections
         WHERE id = $1 AND user_id = $2 AND authority_state = 'active'`,
        [input.collection_id, connector.user_id]
      );
      const collection = hosted.rows[0];
      if (!collection) {
        return reply.code(404).send(apiError(
          "hosted_collection_not_found",
          "Hosted collection not found."
        ));
      }
      const approved = await approveHostedAuthorization(options.db, options.hostedProvider, {
        requestId,
        userId: connector.user_id,
        collectionId: collection.id,
        operations: input.operations,
        template: collection.template,
        displayName: collection.display_name,
        contracts: collection.contracts
      });
      if (!approved) {
        return reply.code(404).send(apiError(
          "authorization_not_found",
          "Authorization request expired or was not found."
        ));
      }
      return { ok: true };
    }
  );

  app.patch("/v1/connectors/hosted/grants/:grantId", async (request, reply) => {
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return;
    const { grantId } = z.object({ grantId: z.uuid() }).parse(request.params);
    const input = z.object({
      operations: z.array(operationSchema).min(1)
    }).strict().parse(request.body);
    const grant = await narrowHostedGrantForUser(
      options,
      connector.user_id,
      grantId,
      input.operations
    );
    if (!grant) {
      return reply.code(404).send(apiError("grant_not_found", "Active hosted grant not found."));
    }
    return { grant };
  });

  app.delete("/v1/connectors/hosted/grants/:grantId", async (request, reply) => {
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return;
    const { grantId } = z.object({ grantId: z.uuid() }).parse(request.params);
    if (!await revokeHostedGrantForUser(options, connector.user_id, grantId)) {
      return reply.code(404).send(apiError("grant_not_found", "Active hosted grant not found."));
    }
    return { ok: true };
  });

  app.post("/v1/hosted/collections", async (request, reply) => {
    const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
    if (!user) return;
    const input = z.object({
      display_name: z.string().trim().min(1).max(200),
      template: z.literal("mdbase").default("mdbase")
    }).strict().parse(request.body);
    const collectionId = randomUUID();
    try {
      if (options.hostedProvider) {
        await options.hostedProvider.createCollection(collectionId, input.template, input.display_name);
      } else {
        await hostedReference!.create(collectionId, input.template);
      }
      await options.db.query(
        `INSERT INTO hosted_collections (id, user_id, display_name, template, provider_url, contracts)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
          collectionId,
          user.id,
          input.display_name,
          input.template,
          options.hostedProvider?.url ?? null,
          JSON.stringify(hostedContractDescriptors(input.template))
        ]
      );
    } catch (error) {
      if (options.hostedProvider) {
        await options.hostedProvider.deleteCollection(collectionId).catch((cleanupError) => {
          request.log.error({ cleanupError, collectionId }, "Failed to compensate hosted collection creation");
        });
      } else {
        await hostedReference!.delete(collectionId).catch(() => undefined);
      }
      throw error;
    }
    await audit(options.db, user.id, "hosted_collection.created", collectionId, { template: input.template });
    return reply.code(201).send({
      collection: {
        id: collectionId,
        display_name: input.display_name,
        template: input.template,
        spec_version: "0.3.0",
        sync_url: authorityUrl(
          options.hostedProvider?.url ?? publicUrl,
          collectionId,
          "sync"
        )
      }
    });
  });

  app.post("/v1/hosted/collections/:collectionId/replicas", async (request, reply) => {
    const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
    if (!user) return;
    const { collectionId } = z.object({ collectionId: z.uuid() }).parse(request.params);
    const input = z.object({
      name: z.string().trim().min(1).max(200),
      mode: z.enum(["read_only", "read_write"]),
      allowed_types: z.array(z.string().min(1).max(100)).max(100).default([])
    }).strict().parse(request.body);
    if (!await ownsActiveHostedCollection(options.db, user.id, collectionId)) {
      return reply.code(404).send(apiError("hosted_collection_not_found", "Hosted collection not found."));
    }
    const replicaId = randomUUID();
    const token = randomToken("hsr");
    if (options.hostedProvider) {
      await options.hostedProvider.registerReplica(collectionId, {
        id: replicaId,
        name: input.name,
        mode: input.mode,
        allowedTypes: input.allowed_types,
        token
      });
    } else {
      await hostedReference!.registerReplica(collectionId, {
        id: replicaId,
        name: input.name,
        mode: input.mode,
        allowedTypes: input.allowed_types
      });
    }
    try {
      await options.db.query(
        `INSERT INTO hosted_replicas (id, collection_id, name, mode, allowed_types, token_hash)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
        [
          replicaId,
          collectionId,
          input.name,
          input.mode,
          JSON.stringify(input.allowed_types),
          options.hostedProvider ? null : tokenHash(token)
        ]
      );
    } catch (error) {
      if (options.hostedProvider) await options.hostedProvider.revokeReplica(replicaId);
      else await hostedReference!.revokeReplica(collectionId, replicaId);
      throw error;
    }
    await audit(options.db, user.id, "hosted_replica.created", replicaId, {
      collection_id: collectionId,
      mode: input.mode,
      allowed_types: input.allowed_types
    });
    return reply.code(201).send({
      replica: {
        id: replicaId,
        collection_id: collectionId,
        name: input.name,
        mode: input.mode
      },
      token,
      sync_url: authorityUrl(
        options.hostedProvider?.url ?? publicUrl,
        collectionId,
        "sync"
      )
    });
  });

  app.patch("/v1/hosted/collections/:collectionId", async (request, reply) => {
    const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
    if (!user) return;
    const { collectionId } = z.object({ collectionId: z.uuid() }).parse(request.params);
    const input = z.object({ display_name: z.string().trim().min(1).max(200) }).strict().parse(request.body);
    if (!await ownsHostedCollection(options.db, user.id, collectionId)) {
      return reply.code(404).send(apiError("hosted_collection_not_found", "Hosted collection not found."));
    }
    if (options.hostedProvider) {
      await options.hostedProvider.renameCollection(collectionId, input.display_name);
    }
    const renamed = await options.db.query<{ id: string; display_name: string }>(
      `UPDATE hosted_collections SET display_name = $3
       WHERE id = $1 AND user_id = $2 RETURNING id, display_name`,
      [collectionId, user.id, input.display_name]
    );
    if (!renamed.rows[0]) {
      return reply.code(404).send(apiError("hosted_collection_not_found", "Hosted collection not found."));
    }
    await audit(options.db, user.id, "hosted_collection.renamed", collectionId, {
      display_name: input.display_name
    });
    return { collection: renamed.rows[0] };
  });

  app.delete("/v1/hosted/collections/:collectionId", async (request, reply) => {
    const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
    if (!user) return;
    const { collectionId } = z.object({ collectionId: z.uuid() }).parse(request.params);
    if (!await ownsHostedCollection(options.db, user.id, collectionId)) {
      return reply.code(404).send(apiError("hosted_collection_not_found", "Hosted collection not found."));
    }
    if (options.hostedProvider) await options.hostedProvider.deleteCollection(collectionId);
    else await hostedReference!.delete(collectionId);
    const connection = await options.db.connect();
    try {
      await connection.query("BEGIN");
      await connection.query(
        "DELETE FROM grants WHERE hosted_collection_id = $1 AND user_id = $2",
        [collectionId, user.id]
      );
      await connection.query(
        "DELETE FROM hosted_collections WHERE id = $1 AND user_id = $2",
        [collectionId, user.id]
      );
      await audit(connection, user.id, "hosted_collection.deleted", collectionId, {});
      await connection.query("COMMIT");
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
    return { ok: true };
  });

  app.post("/v1/hosted/replicas/:replicaId/token", async (request, reply) => {
    const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
    if (!user) return;
    const { replicaId } = z.object({ replicaId: z.uuid() }).parse(request.params);
    const active = await options.db.query<{ id: string; collection_id: string }>(
      `SELECT r.id, r.collection_id FROM hosted_replicas r JOIN hosted_collections c ON c.id = r.collection_id
       WHERE r.id = $1 AND c.user_id = $2 AND r.revoked_at IS NULL`,
      [replicaId, user.id]
    );
    if (!active.rows[0]) return reply.code(404).send(apiError("replica_not_found", "Active replica not found."));
    const token = randomToken("hsr");
    if (options.hostedProvider) {
      await options.hostedProvider.rotateReplicaToken(replicaId, token);
    } else {
      await options.db.query("UPDATE hosted_replicas SET token_hash = $2 WHERE id = $1", [replicaId, tokenHash(token)]);
    }
    return {
      token,
      sync_url: authorityUrl(
        options.hostedProvider?.url ?? publicUrl,
        active.rows[0].collection_id,
        "sync"
      )
    };
  });

  app.delete("/v1/hosted/replicas/:replicaId", async (request, reply) => {
    const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
    if (!user) return;
    const { replicaId } = z.object({ replicaId: z.uuid() }).parse(request.params);
    const active = await options.db.query<{ collection_id: string }>(
      `SELECT r.collection_id FROM hosted_replicas r
       JOIN hosted_collections c ON c.id = r.collection_id
       WHERE r.id = $1 AND r.revoked_at IS NULL AND c.user_id = $2`,
      [replicaId, user.id]
    );
    if (!active.rows[0]) return reply.code(404).send(apiError("replica_not_found", "Active replica not found."));
    if (options.hostedProvider) await options.hostedProvider.revokeReplica(replicaId);
    else await hostedReference!.revokeReplica(active.rows[0].collection_id, replicaId);
    await options.db.query(
      "UPDATE hosted_replicas SET revoked_at = now(), token_hash = NULL WHERE id = $1",
      [replicaId]
    );
    await options.db.query("DELETE FROM mirror_pairing_requests WHERE replica_id = $1", [replicaId]);
    await audit(options.db, user.id, "hosted_replica.revoked", replicaId, {});
    return { ok: true };
  });

  app.post("/v1/hosted/collections/:collectionId/maintenance/compact", async (request, reply) => {
    const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
    if (!user) return;
    const { collectionId } = z.object({ collectionId: z.uuid() }).parse(request.params);
    const input = z.object({ through: z.number().int().nonnegative() }).strict().parse(request.body);
    if (!await ownsHostedCollection(options.db, user.id, collectionId)) {
      return reply.code(404).send(apiError("hosted_collection_not_found", "Hosted collection not found."));
    }
    if (options.hostedProvider) {
      await options.hostedProvider.compactThrough(collectionId, input.through);
    } else {
      await hostedReference!.compactThrough(collectionId, input.through);
    }
    return { ok: true };
  });

  app.post("/v1/authorities/:collectionId/sync/sessions", async (request, reply) => {
    const replica = await requireHostedReplica(request, reply, options.db);
    if (!replica) return;
    const { collectionId } = z.object({ collectionId: z.uuid() }).parse(request.params);
    if (collectionId !== replica.collection_id) return reply.code(403).send(apiError("replica_scope_denied", "Replica belongs to another collection."));
    return (await hostedReference!.transport(collectionId, replica.id)).openSession();
  });

  app.get("/v1/authorities/:collectionId/sync/snapshot", async (request, reply) => {
    const replica = await requireHostedReplica(request, reply, options.db);
    if (!replica) return;
    const { collectionId } = z.object({ collectionId: z.uuid() }).parse(request.params);
    const query = z.object({ snapshot_id: z.uuid(), page: z.string().regex(/^[1-9][0-9]*$/).optional() }).parse(request.query);
    if (collectionId !== replica.collection_id) return reply.code(403).send(apiError("replica_scope_denied", "Replica belongs to another collection."));
    return (await hostedReference!.transport(collectionId, replica.id)).snapshot(query.snapshot_id, query.page);
  });

  app.get("/v1/authorities/:collectionId/sync/changes", async (request, reply) => {
    const replica = await requireHostedReplica(request, reply, options.db);
    if (!replica) return;
    const { collectionId } = z.object({ collectionId: z.uuid() }).parse(request.params);
    const query = z.object({
      after: z.coerce.number().int().nonnegative(),
      limit: z.coerce.number().int().positive().max(500).default(200)
    }).parse(request.query);
    if (collectionId !== replica.collection_id) return reply.code(403).send(apiError("replica_scope_denied", "Replica belongs to another collection."));
    return (await hostedReference!.transport(collectionId, replica.id)).changes(query.after, query.limit);
  });

  app.post("/v1/authorities/:collectionId/sync/mutations", async (request, reply) => {
    const replica = await requireHostedReplica(request, reply, options.db);
    if (!replica) return;
    const { collectionId } = z.object({ collectionId: z.uuid() }).parse(request.params);
    const mutation = syncMutationSchema.parse(request.body);
    if (collectionId !== replica.collection_id || mutation.replica_id !== replica.id) {
      return reply.code(403).send(apiError("replica_scope_denied", "Mutation belongs to another replica."));
    }
    return (await hostedReference!.transport(collectionId, replica.id)).mutate(asSyncMutation(mutation));
  });

  app.get("/v1/relay", { websocket: true }, async (socket, request) => {
    const connector = await connectorFromRequest(request, options.db);
    if (!connector) {
      socket.close(4003, "Invalid connector credential");
      return;
    }
    await relay.attach(connector.id, socket);
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
      collection_hint: z.uuid().optional(),
      code_challenge: z.string().min(43).max(128),
      code_challenge_method: z.literal("S256"),
      relay_protocol: z.coerce.number().int(),
      application_public_key: z.string().min(80).max(200)
    }).strict().parse(request.body);
    if (
      input.relay_protocol !== ENCRYPTED_RELAY_PROTOCOL_VERSION
      || !isP256PublicKey(input.application_public_key)
    ) {
      return reply.code(400).send(apiError(
        "invalid_encryption_request",
        "Portable authorization requires encrypted relay protocol 1 and a valid P-256 public key."
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
          requested_operations, collection_hint, relay_protocol,
          application_public_key, device_code_hash, user_code, user_code_hash,
          poll_interval_seconds, expires_at)
       VALUES ($1, NULL, $2, 'device_code', NULL, NULL, $3, $4::jsonb, $5, $6,
               $7, $8, $9, $10, $11, now() + interval '10 minutes')`,
      [
        authorizationId,
        input.client_id,
        input.code_challenge,
        JSON.stringify(requestedOperations),
        input.collection_hint ?? null,
        ENCRYPTED_RELAY_PROTOCOL_VERSION,
        input.application_public_key,
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
    const ownership = await options.db.query<{ connector_id: string; contracts: ContractRequirement[]; spec_version: string }>(
      `SELECT col.connector_id, col.contracts, col.spec_version FROM collections col
       JOIN connectors c ON c.id = col.connector_id
       WHERE col.id = $1 AND c.user_id = $2`,
      [input.collection_id, user.id]
    );
    if (!ownership.rows[0]) return reply.code(404).send(apiError("collection_not_found", "Collection not found."));
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
    assertCollectionSupportsOperations(ownership.rows[0].spec_version, input.operations);
    const scope = scopeForRequirements(application.rows[0].requirements);
    if (!contractsSatisfy(
      ownership.rows[0].contracts,
      requiredContractsForRequirements(application.rows[0].requirements)
    )) {
      return reply.code(409).send(apiError(
        "incompatible_collection",
        "This collection does not provide the contracts required by the application."
      ));
    }
    const grant = await createOrUpdateGrant(options.db, {
      userId: user.id,
      applicationId: input.application_id,
      collectionId: input.collection_id,
      operations: input.operations,
      scope,
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
      const write = operations.some((operation) => ["create", "update", "delete", "rename", "create_type", "update_type", "create_view_source", "update_view_source", "delete_view_source", "put_timer", "cancel_timer", "reconcile_timers"].includes(operation));
      await options.hostedProvider.updateApplicationReplica(current.hosted_replica_id, {
        grantId,
        mode: write ? "read_write" : "read_only",
        allowedTypes: typesForContracts(
          effectiveHostedContractDescriptors(current.hosted_contracts, current.template!),
          current.scope.contracts
        ),
        fullCollection: current.scope.access === "full_collection",
        allowedOperations: operations
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
      await options.hostedProvider.revokeReplica(active.rows[0].hosted_replica_id);
      if (active.rows[0].hosted_collection_id) {
        await options.hostedProvider.revokeNotificationGrant(
          active.rows[0].hosted_collection_id,
          grantId
        );
      }
      await options.db.query(
        "UPDATE hosted_replicas SET revoked_at = now() WHERE id = $1",
        [active.rows[0].hosted_replica_id]
      );
    }
    await options.db.query("UPDATE grants SET revoked_at = now() WHERE id = $1", [grantId]);
    await options.db.query("UPDATE access_tokens SET revoked_at = now() WHERE grant_id = $1", [grantId]);
    await options.db.query("UPDATE refresh_tokens SET revoked_at = now() WHERE grant_id = $1", [grantId]);
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
      collection_hint: z.uuid().optional(),
      relay_protocol: z.coerce.number().int().optional(),
      application_public_key: z.string().min(80).max(200).optional()
    }).parse(request.query);
    const encryptionRequested = query.relay_protocol !== undefined
      || query.application_public_key !== undefined;
    if (encryptionRequested && (
      query.relay_protocol !== ENCRYPTED_RELAY_PROTOCOL_VERSION
      || !query.application_public_key
      || !isP256PublicKey(query.application_public_key)
    )) {
      return reply.code(400).send(apiError(
        "invalid_encryption_request",
        "Encrypted relay authorization requires protocol 1 and a valid P-256 public key."
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
          requested_operations, collection_hint, relay_protocol, application_public_key, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, now() + interval '10 minutes')`,
      [
        authorizationId,
        user.id,
        query.client_id,
        query.redirect_uri,
        query.state ?? null,
        query.code_challenge,
        JSON.stringify(requestedOperations),
        query.collection_hint ?? null,
        query.relay_protocol ?? null,
        query.application_public_key ?? null
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
              ar.collection_hint, ar.expires_at,
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
      ? await options.db.query<{
          id: string;
          display_name: string;
          spec_version?: string;
          template: HostedTemplate;
          contracts: CollectionContractDescriptor[];
        }>(
          `SELECT id, display_name, template, contracts FROM hosted_collections
           WHERE user_id = $1 AND authority_state = 'active' ORDER BY display_name`,
          [user.id]
        )
      : { rows: [] };
    const availableCollections = [
      ...local.collections,
      ...hosted.rows.map((collection) => ({
        ...collection,
        kind: "hosted" as const,
        connector_name: "Hosted by mdbase",
        spec_version: "0.3.0",
        contracts: contractRequirements(effectiveHostedContractDescriptors(collection.contracts, collection.template))
      }))
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
      const hosted = await options.db.query<{ id: string; template: string; display_name: string; contracts: CollectionContractDescriptor[] }>(
        `SELECT id, template, display_name, contracts FROM hosted_collections
         WHERE id = $1 AND user_id = $2 AND authority_state = 'active'`,
        [input.collection_id, user.id]
      );
      if (!hosted.rows[0] || !options.hostedProvider) {
        return reply.code(404).send(apiError("collection_not_found", "Collection not found."));
      }
      approved = await approveHostedAuthorization(options.db, options.hostedProvider, {
        requestId,
        userId: user.id,
        collectionId: input.collection_id,
        operations: input.operations,
        template: hosted.rows[0].template,
        displayName: hosted.rows[0].display_name,
        contracts: effectiveHostedContractDescriptors(hosted.rows[0].contracts, hosted.rows[0].template)
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
        `SELECT id, grant_id, application_id, redirect_uri, code_challenge
         FROM authorization_codes WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()`,
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
       WHERE rt.token_hash = $1 AND rt.used_at IS NULL AND rt.revoked_at IS NULL
         AND rt.expires_at > now() AND g.revoked_at IS NULL
         AND g.activated_at IS NOT NULL AND g.application_id = $2`,
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

  app.get("/v1/notifications/vapid-public-key", async (_request, reply) => {
    if (!options.notifications?.publicKey) {
      return reply.code(404).send(apiError("notifications_unavailable", "Push notifications are not configured."));
    }
    return { public_key: options.notifications.publicKey };
  });

  app.get("/v1/notifications/webhook-signing-keys", async (_request, reply) => {
    const webhook = options.notifications?.transports.webhook;
    if (!webhook) {
      return reply.code(404).send(apiError(
        "webhooks_unavailable",
        "Signed notification webhooks are not configured."
      ));
    }
    reply.header("cache-control", "public, max-age=300");
    return { keys: webhook.publicKeys() };
  });

  app.post("/v1/notifications/channels", async (request, reply) => {
    if (!notifications) {
      return reply.code(503).send(apiError("notifications_unavailable", "Push notifications are not configured."));
    }
    const bearer = bearerToken(request);
    if (!bearer) return reply.code(401).send(apiError("invalid_token", "Bearer token required."));
    const baseChannel = {
      installation_id: z.string().min(16).max(200),
      criteria: z.array(z.string().min(1).max(100)).min(1).max(100)
    } as const;
    const input = z.union([
      z.object({
        ...baseChannel,
        transport: z.literal("web_push").optional(),
        subscription: z.object({
          endpoint: z.url().refine((value) => new URL(value).protocol === "https:", "Push endpoint must use HTTPS."),
          expirationTime: z.number().int().positive().nullable().optional(),
          keys: z.object({
            p256dh: z.string().min(16).max(512),
            auth: z.string().min(8).max(256)
          }).strict()
        }).strict()
      }).strict(),
      z.object({
        ...baseChannel,
        transport: z.literal("fcm"),
        token: z.string().min(32).max(4_096)
      }).strict()
    ]).parse(request.body);
    const criteria = [...new Set(input.criteria)];
    const connection = await options.db.connect();
    try {
      await connection.query("BEGIN");
      const grant = await activeGrantForToken(connection, tokenHash(bearer));
      if (!grant) {
        await connection.query("ROLLBACK");
        return reply.code(401).send(apiError("invalid_token", "Access token is invalid or expired."));
      }
      const application = await connection.query<{
        notifications: ApplicationNotifications;
        notification_criteria: NotificationCriterion[];
      }>(
        `SELECT a.notifications, g.notification_criteria
         FROM grants g
         JOIN applications a ON a.id = g.application_id
         WHERE g.id = $1 AND g.revoked_at IS NULL
           AND g.activated_at IS NOT NULL`,
        [grant.grant_id]
      );
      const declared = new Set(
        application.rows[0]?.notification_criteria.map(
          (criterion) => criterion.id
        ) ?? []
      );
      const undeclared = criteria.find((criterion) => !declared.has(criterion));
      if (undeclared) {
        await connection.query("ROLLBACK");
        return reply.code(400).send(apiError(
          "notification_reauthorization_required",
          `The current grant does not authorize notification criterion ${undeclared}. Reauthorize the application to accept its updated notification criteria.`
        ));
      }
      const kind = input.transport === "fcm" ? "fcm" : "web_push";
      const fcmToken = input.transport === "fcm" ? input.token : null;
      const webSubscription = input.transport === "fcm"
        ? null
        : input.subscription;
      const nativeDelivery = application.rows[0]?.notifications.native_delivery;
      if (kind === "fcm") {
        if (nativeDelivery?.mode !== "managed_fcm") {
          await connection.query("ROLLBACK");
          return reply.code(400).send(apiError(
            "managed_fcm_not_declared",
            "The application manifest does not declare Connect-managed FCM delivery."
          ));
        }
        if (!options.notifications?.transports.fcm) {
          await connection.query("ROLLBACK");
          return reply.code(503).send(apiError(
            "managed_fcm_unavailable",
            "Connect-managed FCM delivery is not configured."
          ));
        }
        await connection.query(
          `DELETE FROM push_channels
           WHERE grant_id IN (
             SELECT id FROM grants WHERE application_id = $1
           )
             AND fcm_token_hash = $2
             AND NOT (grant_id = $3 AND installation_id = $4)`,
          [
            grant.application_id,
            tokenHash(fcmToken!),
            grant.grant_id,
            input.installation_id
          ]
        );
      } else if (!options.notifications?.transports.webPush) {
        await connection.query("ROLLBACK");
        return reply.code(503).send(apiError(
          "web_push_unavailable",
          "Web Push delivery is not configured."
        ));
      }
      const channel = await connection.query<{ id: string }>(
        `INSERT INTO push_channels
           (id, grant_id, installation_id, kind, endpoint, endpoint_hash,
            p256dh, auth, expires_at, fcm_project_id, fcm_token, fcm_token_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT(grant_id, installation_id) DO UPDATE SET
           kind = excluded.kind,
           endpoint = excluded.endpoint,
           endpoint_hash = excluded.endpoint_hash,
           p256dh = excluded.p256dh,
           auth = excluded.auth,
           expires_at = excluded.expires_at,
           fcm_project_id = excluded.fcm_project_id,
           fcm_token = excluded.fcm_token,
           fcm_token_hash = excluded.fcm_token_hash,
           disabled_at = NULL,
           last_seen_at = now(),
           updated_at = now()
         RETURNING id`,
        [
          randomUUID(),
          grant.grant_id,
          input.installation_id,
          kind,
          webSubscription?.endpoint ?? null,
          webSubscription ? tokenHash(webSubscription.endpoint) : null,
          webSubscription?.keys.p256dh ?? null,
          webSubscription?.keys.auth ?? null,
          webSubscription?.expirationTime
            ? new Date(webSubscription.expirationTime).toISOString()
            : null,
          kind === "fcm" && nativeDelivery?.mode === "managed_fcm"
            ? nativeDelivery.firebase_project_id
            : null,
          fcmToken,
          fcmToken ? tokenHash(fcmToken) : null
        ]
      );
      await connection.query(
        "DELETE FROM notification_subscriptions WHERE channel_id = $1 AND NOT (criterion_id = ANY($2::text[]))",
        [channel.rows[0].id, criteria]
      );
      for (const criterion of criteria) {
        await connection.query(
          `INSERT INTO notification_subscriptions (id, grant_id, channel_id, criterion_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT(channel_id, criterion_id) DO NOTHING`,
          [randomUUID(), grant.grant_id, channel.rows[0].id, criterion]
        );
      }
      await connection.query("COMMIT");
      return reply.code(201).send({
        channel_id: channel.rows[0].id,
        transport: kind,
        criteria
      });
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
  });

  app.put("/v1/notifications/subscriptions/:criterionId", async (request, reply) => {
    if (!notifications) {
      return reply.code(503).send(apiError("notifications_unavailable", "Push notifications are not configured."));
    }
    const params = z.object({ criterionId: z.string().min(1).max(100) }).parse(request.params);
    const input = z.object({ channel_id: z.uuid() }).strict().parse(request.body);
    const bearer = bearerToken(request);
    if (!bearer) return reply.code(401).send(apiError("invalid_token", "Bearer token required."));
    const grant = await activeGrantForToken(options.db, tokenHash(bearer));
    if (!grant) return reply.code(401).send(apiError("invalid_token", "Access token is invalid or expired."));
    const application = await options.db.query<{
      notification_criteria: NotificationCriterion[];
      channel_id: string | null;
    }>(
      `SELECT g.notification_criteria, pc.id AS channel_id
       FROM grants g
       LEFT JOIN push_channels pc
         ON pc.grant_id = g.id AND pc.id = $2 AND pc.disabled_at IS NULL
       WHERE g.id = $1 AND g.revoked_at IS NULL
         AND g.activated_at IS NOT NULL`,
      [grant.grant_id, input.channel_id]
    );
    const row = application.rows[0];
    if (!row?.channel_id) {
      return reply.code(404).send(apiError("channel_not_found", "The push channel is not active for this grant."));
    }
    if (!row.notification_criteria.some(
      (criterion) => criterion.id === params.criterionId
    )) {
      return reply.code(400).send(apiError(
        "notification_reauthorization_required",
        "The current grant does not authorize this notification criterion."
      ));
    }
    const subscription = await options.db.query<{ id: string }>(
      `INSERT INTO notification_subscriptions (id, grant_id, channel_id, criterion_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT(channel_id, criterion_id) DO UPDATE SET criterion_id = excluded.criterion_id
       RETURNING id`,
      [randomUUID(), grant.grant_id, input.channel_id, params.criterionId]
    );
    return { subscription_id: subscription.rows[0].id };
  });

  app.delete("/v1/notifications/channels/:channelId", async (request, reply) => {
    const params = z.object({ channelId: z.uuid() }).parse(request.params);
    const bearer = bearerToken(request);
    if (!bearer) return reply.code(401).send(apiError("invalid_token", "Bearer token required."));
    const grant = await activeGrantForToken(options.db, tokenHash(bearer));
    if (!grant) return reply.code(401).send(apiError("invalid_token", "Access token is invalid or expired."));
    const removed = await options.db.query(
      "DELETE FROM push_channels WHERE id = $1 AND grant_id = $2 RETURNING id",
      [params.channelId, grant.grant_id]
    );
    if (!removed.rows[0]) {
      return reply.code(404).send(apiError("channel_not_found", "The push channel was not found."));
    }
    return reply.code(204).send();
  });

  app.post("/internal/v1/hosted/notification-signals", async (request, reply) => {
    if (!notifications) {
      return reply.code(503).send(apiError("notifications_unavailable", "Push notifications are not configured."));
    }
    const bearer = bearerToken(request);
    if (!options.hostedProvider?.authorizesInternalToken(bearer)) {
      return reply.code(401).send(apiError("invalid_internal_token", "Hosted provider credential is invalid."));
    }
    const input = z.object({
      signal_id: z.string().min(16).max(200),
      grant_id: z.uuid(),
      criterion_id: z.string().min(1).max(100),
      cursor: z.string().min(1).max(200)
    }).strict().parse(request.body);
    const authorization = await options.db.query<{
      notification_criteria: NotificationCriterion[];
    }>(
      `SELECT g.notification_criteria
       FROM grants g
       WHERE g.id = $1 AND g.hosted_collection_id IS NOT NULL
         AND g.revoked_at IS NULL AND g.activated_at IS NOT NULL`,
      [input.grant_id]
    );
    const authorized = authorization.rows[0]?.notification_criteria.some(
      (criterion) => criterion.id === input.criterion_id
    );
    if (!authorized) {
      return reply.code(403).send(apiError(
        "notification_signal_denied",
        "The hosted grant does not authorize this notification criterion."
      ));
    }
    const outcome = await notifications.enqueue({
      signalId: input.signal_id,
      grantId: input.grant_id,
      criterionId: input.criterion_id,
      cursor: input.cursor
    });
    return reply.code(outcome.duplicate ? 200 : 202).send({
      accepted: true,
      duplicate: outcome.duplicate,
      deliveries: outcome.deliveries
    });
  });

  app.post("/v1/connectors/notification-signals", async (request, reply) => {
    if (!notifications) {
      return reply.code(503).send(apiError("notifications_unavailable", "Push notifications are not configured."));
    }
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return;
    const input = z.object({
      signal_id: z.string().min(16).max(200),
      grant_id: z.uuid(),
      criterion_id: z.string().min(1).max(100),
      cursor: z.string().min(1).max(200)
    }).strict().parse(request.body);
    const authorization = await options.db.query<{
      notification_criteria: NotificationCriterion[];
    }>(
      `SELECT g.notification_criteria
       FROM grants g
       JOIN collections c ON c.id = g.collection_id
       WHERE g.id = $1 AND c.connector_id = $2
         AND g.revoked_at IS NULL AND g.activated_at IS NOT NULL
         AND c.enabled = true AND c.present = true
         AND c.authority_state = 'active'`,
      [input.grant_id, connector.id]
    );
    const authorized = authorization.rows[0]?.notification_criteria.some(
      (criterion) => criterion.id === input.criterion_id
    );
    if (!authorized) {
      return reply.code(403).send(apiError(
        "notification_signal_denied",
        "The local grant does not authorize this notification criterion."
      ));
    }
    const outcome = await notifications.enqueue({
      signalId: input.signal_id,
      grantId: input.grant_id,
      criterionId: input.criterion_id,
      cursor: input.cursor
    });
    return reply.code(outcome.duplicate ? 200 : 202).send({
      accepted: true,
      duplicate: outcome.duplicate,
      deliveries: outcome.deliveries
    });
  });

  app.post("/v1/authorities/:collectionId/operations/:operation", async (request, reply) => {
    const params = z.object({ collectionId: z.uuid(), operation: operationSchema }).parse(request.params);
    const bearer = bearerToken(request);
    if (!bearer) return reply.code(401).send(apiError("invalid_token", "Bearer token required."));
    const authorized = await options.db.query<{
      grant_id: string;
      application_id: string;
      operations: string[];
      connector_id: string;
      local_id: string;
      encryption: GrantEncryption | null;
    }>(
      `SELECT g.id AS grant_id, g.application_id, g.operations, g.encryption,
              col.connector_id, col.local_id
       FROM access_tokens tok
       JOIN grants g ON g.id = tok.grant_id
       JOIN collections col ON col.id = g.collection_id
       WHERE tok.token_hash = $1 AND tok.expires_at > now() AND tok.revoked_at IS NULL
         AND g.revoked_at IS NULL AND g.activated_at IS NOT NULL
         AND col.id = $2 AND col.enabled = true AND col.present = true
         AND col.authority_state = 'active'`,
      [tokenHash(bearer), params.collectionId]
    );
    const grant = authorized.rows[0];
    if (!grant) {
      return reply.code(401).send(apiError("invalid_token", "Access token is invalid or expired."));
    }
    if (!grant.operations.includes(params.operation)) {
      return reply.code(403).send(apiError("insufficient_access", "The application is not allowed to perform this operation."));
    }
    try {
      if (grant.encryption) {
        let envelope: EncryptedRelayOperationRequest;
        try {
          envelope = encryptedRelayRequestSchema.parse(request.body) as EncryptedRelayOperationRequest;
        } catch {
          return reply.code(426).send(apiError(
            "encryption_required",
            "This grant requires encrypted relay protocol 1."
          ));
        }
        if (!matchesGrantEncryption(
          envelope,
          { ...grant, encryption: grant.encryption },
          params.operation
        )) {
          if (matchesGrantIdentity(envelope, grant, params.operation)) {
            return reply.code(409).send(apiError(
              "encryption_binding_stale",
              "The encrypted grant binding changed. Refresh authorization and retry."
            ));
          }
          return reply.code(400).send(apiError(
            "invalid_encrypted_envelope",
            "Encrypted relay metadata does not match the active grant."
          ));
        }
        const encryptedResponse = await relay.routeEncrypted(grant.connector_id, envelope);
        return { ok: true, envelope: encryptedResponse };
      }
      if ((request.body as { type?: unknown } | null)?.type === "encrypted_operation_request") {
        return reply.code(400).send(apiError(
          "encryption_not_configured",
          "This grant was not authorized for encrypted relay protocol 1."
        ));
      }
      const result = await relay.route({
        connectorId: grant.connector_id,
        localCollectionId: grant.local_id,
        grantId: grant.grant_id,
        applicationId: grant.application_id,
        operation: params.operation,
        operationInput: request.body ?? {}
      });
      return { ok: true, result };
    } catch (error) {
      if (error instanceof RelayUnavailableError) {
        return reply.code(503).send(apiError("connector_offline", error.message));
      }
      if (error instanceof ConnectorOperationError) {
        const denied = error.code === "access_paused" || error.code === "access_denied";
        return reply.code(denied ? 403 : 502).send(apiError(error.code, error.message));
      }
      throw error;
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
  const desiredScope = scopeForRequirements(application.requirements);
  const requiredContracts = requiredContractsForRequirements(application.requirements);
  const grants = await db.query<{
    id: string;
    user_id: string;
    connector_id: string | null;
    hosted_collection_id: string | null;
    hosted_replica_id: string | null;
    operations: string[];
    local_contracts: ContractRequirement[] | null;
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
    const availableContracts = grant.template
      ? contractRequirements(hostedDescriptors)
      : grant.local_contracts ?? [];
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
        const write = grant.operations.some((operation) => ["create", "update", "delete", "rename", "create_type", "update_type", "create_view_source", "update_view_source", "delete_view_source", "put_timer", "cancel_timer", "reconcile_timers"].includes(operation));
        await hostedProvider.updateApplicationReplica(grant.hosted_replica_id, {
          grantId: grant.id,
          mode: write ? "read_write" : "read_only",
          allowedTypes: desiredAllowedTypes,
          fullCollection: application.requirements.access === "full_collection",
          allowedOperations: grant.operations
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

interface LiveAuthorizationCollection {
  id: string;
  offer_id: string;
  kind: "local";
  connector_name: string;
  display_name: string;
  spec_version: string;
  contracts: ContractRequirement[];
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
  const connectors = await db.query<{
    id: string;
    name: string;
    inventory_revision: string | number;
  }>(
    `SELECT id, name, inventory_revision FROM connectors
     WHERE user_id = $1 ORDER BY created_at`,
    [userId]
  );
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
       WHERE user_id = $1 AND connector_id = $2
         AND present = true AND enabled = true AND authority_state = 'active'`,
      [userId, connector.id]
    );
    const byLocalId = new Map(authoritative.rows.map((collection) => [
      collection.local_id,
      collection
    ]));
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
      collections.push({
        id: collection.id,
        offer_id: offer.rows[0].id,
        kind: "local",
        connector_name: connector.name,
        display_name: offered.display_name,
        spec_version: offered.spec_version,
        contracts: offered.contracts
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
    operations: string[];
  }
): Promise<boolean> {
  const connection = await db.connect();
  const grantId = randomUUID();
  let connectorId = "";
  let localCollectionId = "";
  let requirements: ApplicationRequirements;
  let provisions: ApplicationProvisions;
  let grant: GrantPolicy;
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
      application_public_key: string | null;
      flow: "authorization_code" | "device_code";
      redirect_uri: string | null;
      grant_id: string | null;
      activation_started_at: string | Date | null;
    }>(
      `SELECT ar.application_id, a.name AS application_name,
              a.distribution, a.homepage AS application_homepage,
              a.project_url AS application_project_url, a.icon AS application_icon,
              ar.requested_operations, a.requirements, a.provisions, a.notifications,
              ar.relay_protocol, ar.application_public_key, ar.flow, ar.redirect_uri,
              ar.grant_id, ar.activation_started_at
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
        || !pending.application_public_key
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
    const operations = [...new Set(input.operations)];
    if (operations.some((operation) => !pending.requested_operations.includes(operation))) {
      throw new RequestValidationError(
        "Approved operations must be requested by the application."
      );
    }
    assertOperationsAllowedByRequirements(operations, pending.requirements);
    const offer = await connection.query<{
      connector_id: string;
      local_id: string;
      display_name: string;
      spec_version: string;
      relay_public_key: string | null;
      authority_epoch: string | number;
    }>(
      `SELECT offer.connector_id, offer.local_id, col.display_name, col.spec_version,
              con.relay_public_key, col.authority_epoch
       FROM authorization_collection_offers offer
       JOIN collections col ON col.id = offer.collection_id
       JOIN connectors con ON con.id = offer.connector_id
       WHERE offer.id = $1 AND offer.authorization_id = $2
         AND offer.user_id = $3 AND offer.collection_id = $4
         AND offer.consumed_at IS NULL AND offer.expires_at > now()
         AND col.user_id = $3 AND col.present = true AND col.enabled = true
         AND col.authority_state = 'active'
         AND col.authority_epoch = offer.authority_epoch
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
    assertCollectionSupportsOperations(selected.spec_version, operations);
    const scope = scopeForRequirements(pending.requirements);
    let encryption: GrantEncryption | undefined;
    if (pending.relay_protocol === ENCRYPTED_RELAY_PROTOCOL_VERSION) {
      if (!pending.application_public_key || !selected.relay_public_key) {
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
        application_public_key: pending.application_public_key,
        connector_public_key: selected.relay_public_key
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
        input.collectionId,
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
    await finalize.query(
      "UPDATE grants SET activated_at = now() WHERE id = $1 AND activated_at IS NULL",
      [grantId]
    );
    await finalize.query(
      `UPDATE authorization_collection_offers SET consumed_at = now()
       WHERE id = $1 AND authorization_id = $2`,
      [input.offerId, input.requestId]
    );
    await finalize.query(
      `UPDATE collections SET contracts = $2::jsonb, last_seen_at = now()
       WHERE id = $1`,
      [input.collectionId, JSON.stringify(activation.contracts)]
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
    application_public_key: string | null;
    flow: "authorization_code" | "device_code";
    redirect_uri: string | null;
  }>(
    `SELECT ar.application_id, a.distribution, a.homepage AS application_homepage,
            ar.requested_operations, a.requirements, a.notifications,
            ar.relay_protocol, ar.application_public_key, ar.flow, ar.redirect_uri
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
        || !pending.application_public_key
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
    contracts: ContractRequirement[];
    local_id: string;
    relay_public_key: string | null;
    spec_version: string;
    }>(
    `SELECT col.contracts, col.local_id, col.spec_version, con.relay_public_key
     FROM collections col JOIN connectors con ON con.id = col.connector_id
     WHERE col.id = $1 AND col.connector_id = $2 AND col.enabled = true
       AND col.present = true AND col.authority_state = 'active'`,
    [input.collectionId, input.connectorId]
    );
    scope = scopeForRequirements(pending.requirements);
    if (!collection.rows[0]) {
      throw new RequestValidationError(
        "This collection does not provide the contracts required by the application."
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
      if (!pending.application_public_key || !collection.rows[0].relay_public_key) {
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
        application_public_key: pending.application_public_key,
        connector_public_key: collection.rows[0].relay_public_key
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
    operations: string[];
    template: string;
    displayName: string;
    contracts: CollectionContractDescriptor[];
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
      application_public_key: string | null;
      flow: "authorization_code" | "device_code";
    }>(
      `SELECT ar.application_id, a.name AS application_name,
              a.distribution, a.homepage AS application_homepage,
              ar.redirect_uri, ar.requested_operations,
              a.requirements, a.provisions, a.notifications,
              ar.relay_protocol, ar.application_public_key, ar.flow
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
        || !pending.application_public_key
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
    if (input.operations.some((operation) => !pending.requested_operations.includes(operation))) {
      throw new RequestValidationError("Approved operations must be requested by the application.");
    }
    assertOperationsAllowedByRequirements(input.operations, pending.requirements);
    const scope = scopeForRequirements(pending.requirements);
    const requiredContracts = requiredContractsForRequirements(pending.requirements);
    let availableDescriptors = input.contracts;
    let availableContracts = contractRequirements(availableDescriptors);
    const provisions = requiredTypeProvisions(
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
      availableDescriptors = await provider.provisionTypes(input.collectionId, provisions);
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
    const allowedTypes = allowedTypesForRequirements(
      availableDescriptors,
      pending.requirements
    );
    await provider.renameCollection(input.collectionId, input.displayName);
    const operations = [...new Set(input.operations)];
    const write = operations.some((operation) => ["create", "update", "delete", "rename", "create_type", "update_type", "create_view_source", "update_view_source", "delete_view_source", "put_timer", "cancel_timer", "reconcile_timers"].includes(operation));
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
      mode: write ? "read_write" : "read_only",
      allowedTypes,
      fullCollection: pending.requirements.access === "full_collection",
      allowedOperations: operations,
      allowedOrigin,
      proofPublicKey: pending.flow === "device_code"
        ? pending.application_public_key!
        : undefined,
      grantId,
      token: bootstrapToken,
      tokenTtlSeconds: 3_600
    });
    await connection.query(
      `INSERT INTO hosted_replicas
         (id, collection_id, name, purpose, mode, allowed_types, token_hash)
       VALUES ($1, $2, $3, 'application', $4, $5::jsonb, NULL)`,
      [
        replicaId,
        input.collectionId,
        `${pending.application_name} application access`,
        write ? "read_write" : "read_only",
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
        pending.flow === "device_code" ? pending.application_public_key : null,
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
    collection_id: string;
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
    `SELECT COALESCE(g.collection_id, g.hosted_collection_id) AS collection_id,
            COALESCE(col.display_name, hosted.display_name) AS collection_name,
            g.hosted_collection_id, g.hosted_replica_id, hosted.provider_url,
            g.operations, g.scope, g.encryption, g.proof_public_key,
            CASE WHEN g.application_origin = '' THEN app.homepage
                 ELSE g.application_origin END AS application_origin
     FROM grants g
     JOIN applications app ON app.id = g.application_id
     LEFT JOIN collections col ON col.id = g.collection_id
     LEFT JOIN hosted_collections hosted ON hosted.id = g.hosted_collection_id
     WHERE g.id = $1 AND g.revoked_at IS NULL
       AND g.activated_at IS NOT NULL`,
    [grantId]
  );
  if (!grant.rows[0]) throw new RequestValidationError("The application grant is no longer active.");
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

function scopeForRequirements(requirements: ApplicationRequirements | null | undefined): GrantScope {
  if (requirements?.access === "full_collection") {
    return { access: "full_collection", contracts: [] };
  }
  const contracts = requirements?.contracts ?? [];
  return {
    access: "contract",
    contracts: [...new Map(contracts.map((contract) => [
      `${contract.id}@${contract.version}`,
      contract
    ])).values()]
  };
}

const FULL_COLLECTION_OPERATIONS = new Set([
  "validate",
  "list_views",
  "execute_view",
  "read_type",
  "create_type",
  "update_type"
]);

const PORTABLE_PROFILE_OPERATIONS = new Set([
  "query",
  "list_views",
  "execute_view",
  "read_type",
  "create_type",
  "update_type"
]);

function collectionSupportsOperations(specVersion: string, operations: readonly string[]): boolean {
  return /^0\.3(?:\.|$)/.test(specVersion)
    || operations.every((operation) => !PORTABLE_PROFILE_OPERATIONS.has(operation));
}

function assertCollectionSupportsOperations(specVersion: string, operations: readonly string[]): void {
  const unsupported = operations.find((operation) =>
    PORTABLE_PROFILE_OPERATIONS.has(operation) && !/^0\.3(?:\.|$)/.test(specVersion)
  );
  if (unsupported) {
    throw new RequestValidationError(
      `This collection uses mdbase ${specVersion} and does not support the ${unsupported} operation.`
    );
  }
}

function operationsAllowedByRequirements(
  operations: readonly string[],
  requirements: ApplicationRequirements | null | undefined
): boolean {
  return requirements?.access === "full_collection"
    || operations.every((operation) => !FULL_COLLECTION_OPERATIONS.has(operation));
}

function assertOperationsAllowedByRequirements(
  operations: readonly string[],
  requirements: ApplicationRequirements | null | undefined
): void {
  if (requirements?.access !== "full_collection" && (requirements?.contracts?.length ?? 0) === 0) {
    throw new RequestValidationError(
      "Contract-scoped application manifests must declare at least one required contract; use full_collection for collection-wide access."
    );
  }
  if (!operationsAllowedByRequirements(operations, requirements)) {
    throw new RequestValidationError(
      "Saved views, collection-wide validation, and type definitions require the application manifest to request full collection access."
    );
  }
}

function requiredContractsForRequirements(
  requirements: ApplicationRequirements | null | undefined
): ContractRequirement[] {
  const contracts = requirements?.contracts ?? [];
  return [...new Map(contracts.map((contract) => [
    `${contract.id}@${contract.version}`,
    contract
  ])).values()];
}

function allowedTypesForRequirements(
  descriptors: CollectionContractDescriptor[],
  requirements: ApplicationRequirements
): string[] {
  return requirements.access === "full_collection"
    ? []
    : typesForContracts(descriptors, requiredContractsForRequirements(requirements));
}

function requiresHostedCollection(
  requirements: ApplicationRequirements | null | undefined
): boolean {
  return requirements?.collection_kind === "hosted";
}

function matchesGrantEncryption(
  envelope: EncryptedRelayOperationRequest,
  grant: {
    grant_id: string;
    application_id: string;
    connector_id: string;
    local_id: string;
    encryption: GrantEncryption;
  },
  operation: string
): boolean {
  const encryption = grant.encryption;
  return envelope.protocol_version === encryption.protocol_version
    && envelope.suite === encryption.suite
    && envelope.grant_id === grant.grant_id
    && envelope.application_id === grant.application_id
    && envelope.connector_id === grant.connector_id
    && envelope.connector_id === encryption.connector_id
    && envelope.collection_id === grant.local_id
    && envelope.collection_id === encryption.collection_id
    && envelope.operation === operation
    && envelope.scope_epoch === encryption.scope_epoch
    && envelope.key_id === encryption.key_id;
}

function matchesGrantIdentity(
  envelope: EncryptedRelayOperationRequest,
  grant: {
    grant_id: string;
    application_id: string;
    connector_id: string;
    local_id: string;
    encryption: GrantEncryption | null;
  },
  operation: string
): boolean {
  return envelope.protocol_version === ENCRYPTED_RELAY_PROTOCOL_VERSION
    && envelope.suite === RELAY_ENCRYPTION_SUITE
    && envelope.grant_id === grant.grant_id
    && envelope.application_id === grant.application_id
    && envelope.connector_id === grant.connector_id
    && envelope.collection_id === grant.local_id
    && envelope.operation === operation;
}

async function rotateGrantEncryption(db: DatabasePool, grantId: string): Promise<void> {
  const grant = await db.query<{ encryption: GrantEncryption | null }>(
    `SELECT encryption FROM grants
     WHERE id = $1 AND revoked_at IS NULL AND activated_at IS NOT NULL`,
    [grantId]
  );
  const encryption = grant.rows[0]?.encryption;
  if (!encryption) return;
  const rotated: GrantEncryption = {
    ...encryption,
    key_id: `enc_${randomUUID()}`,
    scope_epoch: encryption.scope_epoch + 1
  };
  await db.query("UPDATE grants SET encryption = $2::jsonb WHERE id = $1", [
    grantId,
    JSON.stringify(rotated)
  ]);
}

function isP256PublicKey(value: string): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.length !== 65 || bytes[0] !== 4) return false;
    ECDH.convertKey(bytes, "prime256v1", undefined, undefined, "uncompressed");
    return true;
  } catch {
    return false;
  }
}

function contractsSatisfy(
  available: ContractRequirement[] | null | undefined,
  required: ContractRequirement[]
): boolean {
  const present = new Set((available ?? []).map((contract) => `${contract.id}@${contract.version}`));
  return required.every((contract) => present.has(`${contract.id}@${contract.version}`));
}

function requiredTypeProvisions(
  requirements: ApplicationRequirements,
  provisions: ApplicationProvisions,
  available: ContractRequirement[]
): TypeProvision[] | null {
  const missing = requirements.contracts.filter((required) =>
    !available.some((present) => present.id === required.id && present.version === required.version)
  );
  if (missing.some((required) => !provisions.types.some((provision) =>
    provision.provides.some((provided) => provided.id === required.id && provided.version === required.version)
  ))) return null;
  return provisions.types.filter((provision) =>
    provision.provides.length === 0
    || provision.provides.some((provided) =>
      missing.some((required) =>
        required.id === provided.id && required.version === provided.version
      )
    )
  );
}

class RequestValidationError extends Error {}
class OriginDeniedError extends Error {}

async function sessionUser(request: FastifyRequest, db: DatabasePool): Promise<User | null> {
  const token = sessionToken(request);
  if (!token) return null;
  const user = await db.query<User>(
    `SELECT u.id,
            COALESCE(i.email, e.email, u.email) AS email,
            u.name, i.login, s.provider AS authentication_provider
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN external_identities i ON i.user_id = u.id AND i.provider = s.provider
     LEFT JOIN email_identities e ON e.user_id = u.id
       AND e.is_primary = true AND e.retired_at IS NULL
     WHERE s.token_hash = $1
       AND s.expires_at > now()
       AND s.revoked_at IS NULL
       AND u.suspended_at IS NULL
       AND s.account_session_epoch = u.session_epoch`,
    [tokenHash(token)]
  );
  return user.rows[0] ?? null;
}

async function tailscaleUser(request: FastifyRequest, db: DatabasePool): Promise<User | null> {
  const loginHeader = request.headers["tailscale-user-login"];
  const nameHeader = request.headers["tailscale-user-name"];
  const login = (Array.isArray(loginHeader) ? loginHeader[0] : loginHeader)?.trim().toLowerCase();
  if (!login || login.length > 320) return null;
  const suppliedName = (Array.isArray(nameHeader) ? nameHeader[0] : nameHeader)?.trim();
  const fallbackName = login.split("@")[0] || login;
  const name = suppliedName && suppliedName.length <= 100 ? suppliedName : fallbackName.slice(0, 100);
  const user = await db.query<User & { suspended_at: string | null }>(
    `INSERT INTO users (id, email, name) VALUES ($1, $2, $3)
     ON CONFLICT(email) DO UPDATE SET name = excluded.name
     RETURNING id, email, name, suspended_at`,
    [randomUUID(), login, name]
  );
  if (!user.rows[0] || user.rows[0].suspended_at) return null;
  const { suspended_at: _suspendedAt, ...activeUser } = user.rows[0];
  return { ...activeUser, login: null, authentication_provider: "tailscale" };
}

async function authenticatedUser(
  request: FastifyRequest,
  db: DatabasePool,
  tailscaleAuth = false
): Promise<User | null> {
  return tailscaleAuth ? tailscaleUser(request, db) : sessionUser(request, db);
}

async function authorityPairing(
  db: DatabasePool,
  pairingId: string,
  secret: string | null
): Promise<AuthorityPairing | null> {
  if (!secret) return null;
  const result = await db.query<AuthorityPairing & {
    replica_collection_id: string;
    consumed_at: string | null;
    purpose: "mirror" | "application";
    revoked_at: string | null;
  }>(
    `SELECT pairing.id AS pairing_id, pairing.user_id,
            pairing.collection_id, pairing.replica_id, pairing.mode, pairing.consumed_at,
            replica.allowed_types, replica.collection_id AS replica_collection_id,
            replica.purpose, replica.revoked_at, hosted.authority_state
     FROM mirror_pairing_requests pairing
     JOIN hosted_replicas replica ON replica.id = pairing.replica_id
     JOIN hosted_collections hosted ON hosted.id = pairing.collection_id
     WHERE pairing.id = $1 AND pairing.secret_hash = $2`,
    [pairingId, tokenHash(secret)]
  );
  const pairing = result.rows[0];
  if (
    !pairing
    || !pairing.consumed_at
    || pairing.purpose !== "mirror"
    || pairing.revoked_at
    || pairing.replica_collection_id !== pairing.collection_id
  ) {
    return null;
  }
  const {
    replica_collection_id: _replicaCollectionId,
    consumed_at: _consumedAt,
    purpose: _purpose,
    revoked_at: _revokedAt,
    ...authenticated
  } = pairing;
  return authenticated;
}

async function mirrorAuthorityTransfer(
  db: DatabasePool,
  transferId: string,
  secret: string | null
): Promise<AuthorityTransferRow | null> {
  if (!secret) return null;
  const result = await db.query<AuthorityTransferRow>(
    `SELECT transfer.id, transfer.user_id, transfer.hosted_collection_id,
            transfer.pairing_id, transfer.replica_id, transfer.local_collection_id,
            transfer.state, transfer.final_head, transfer.next_authority_epoch,
            transfer.manifest_digest, transfer.expires_at
     FROM authority_transfers transfer
     JOIN mirror_pairing_requests pairing ON pairing.id = transfer.pairing_id
     WHERE transfer.id = $1 AND pairing.secret_hash = $2`,
    [transferId, tokenHash(secret)]
  );
  return result.rows[0] ?? null;
}

function authorityAdoptionSelect(): string {
  return `SELECT adoption.id, adoption.secret_hash, adoption.collection_id,
                 adoption.display_name, adoption.source_name,
                 adoption.retain_mirror, adoption.mirror_name,
                 adoption.user_id, adoption.state,
                 adoption.next_authority_epoch, adoption.final_head,
                 adoption.manifest_digest, adoption.source_revision,
                 adoption.contracts, adoption.expires_at,
                 adoption.approved_at, adoption.prepared_at,
                 adoption.completed_at
          FROM authority_adoption_requests adoption`;
}

async function authorityAdoptionBySecret(
  db: DatabasePool,
  adoptionId: string,
  secret: string
): Promise<AuthorityAdoptionRow | null> {
  const result = await db.query<AuthorityAdoptionRow>(
    `${authorityAdoptionSelect()}
     WHERE adoption.id = $1 AND adoption.secret_hash = $2`,
    [adoptionId, tokenHash(secret)]
  );
  return result.rows[0] ?? null;
}

function authorityAdoptionView(adoption: AuthorityAdoptionRow): Record<string, unknown> {
  return {
    id: adoption.id,
    collection_id: adoption.collection_id,
    display_name: adoption.display_name,
    source_name: adoption.source_name,
    retain_mirror: adoption.retain_mirror,
    mirror_name: adoption.mirror_name,
    state: adoption.state,
    authority_epoch: Number(adoption.next_authority_epoch),
    final_head: adoption.final_head === null ? null : Number(adoption.final_head),
    manifest_digest: adoption.manifest_digest,
    source_revision: adoption.source_revision,
    contracts: adoption.contracts ?? [],
    expires_at: new Date(adoption.expires_at).toISOString(),
    approved_at: adoption.approved_at
      ? new Date(adoption.approved_at).toISOString()
      : null,
    prepared_at: adoption.prepared_at
      ? new Date(adoption.prepared_at).toISOString()
      : null,
    completed_at: adoption.completed_at
      ? new Date(adoption.completed_at).toISOString()
      : null
  };
}

async function recoverExpiredAuthorityAdoptions(
  db: DatabasePool,
  hostedProvider?: HostedProviderClient
): Promise<void> {
  await db.query(
    `UPDATE authority_adoption_requests
     SET state = 'expired'
     WHERE expires_at <= now() AND state IN ('requested', 'approved', 'prepared')`
  );
  if (!hostedProvider) return;
  const pendingCleanup = await db.query<{ id: string; collection_id: string }>(
    `SELECT id, collection_id FROM authority_adoption_requests
     WHERE state = 'expired' AND cleanup_completed = false`
  );
  for (const adoption of pendingCleanup.rows) {
    try {
      await hostedProvider.abortAuthorityImport(adoption.id);
    } catch (error) {
      if (
        !(error instanceof HostedProviderResponseError)
        || !["authority_import_not_found", "authority_import_inactive"].includes(error.code)
      ) {
        throw error;
      }
    }
    const connection = await db.connect();
    try {
      await connection.query("BEGIN");
      await connection.query("DELETE FROM mirror_pairing_requests WHERE id = $1", [adoption.id]);
      await connection.query(
        `DELETE FROM hosted_collections
         WHERE id = $1 AND authority_state = 'importing'`,
        [adoption.collection_id]
      );
      await connection.query(
        `UPDATE authority_adoption_requests
         SET cleanup_completed = true WHERE id = $1 AND state = 'expired'`,
        [adoption.id]
      );
      await connection.query("COMMIT");
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
  }
}

async function recoverExpiredAuthorityTransfers(
  db: DatabasePool,
  hostedProvider?: HostedProviderClient,
  hostedReference?: HostedAuthorityRegistry
): Promise<void> {
  const prepared = await db.query<{
    id: string;
    hosted_collection_id: string;
    user_id: string;
    direction: "to_local" | "to_hosted";
    next_authority_epoch: string | number | null;
  }>(
    `SELECT id, hosted_collection_id, user_id, direction, next_authority_epoch
     FROM authority_transfers
     WHERE expires_at <= now()
       AND (
         (direction = 'to_hosted' AND state IN ('requested', 'prepared'))
         OR (direction = 'to_local' AND state = 'prepared')
       )`
  );
  for (const transfer of prepared.rows) {
    try {
      if (transfer.direction === "to_hosted") {
        if (!hostedProvider) continue;
        try {
          await hostedProvider.abortAuthorityImport(transfer.id);
        } catch (error) {
          if (
            !(error instanceof HostedProviderResponseError)
            || error.code !== "authority_import_not_found"
          ) {
            throw error;
          }
        }
      } else if (hostedProvider) {
        await hostedProvider.abortAuthorityTransfer(transfer.id);
      } else {
        await hostedReference?.abortAuthorityTransfer(transfer.id);
      }
    } catch (error) {
      if (
        (
          error instanceof HostedProviderResponseError
          || error instanceof SyncError
        )
        && ["authority_transfer_completed", "authority_import_completed"].includes(error.code)
      ) {
        // The provider committed but the control-plane transaction did not.
        // Keep the transfer resumable instead of incorrectly restoring epoch one.
        continue;
      }
      throw error;
    }
    const connection = await db.connect();
    try {
      await connection.query("BEGIN");
      if (transfer.direction === "to_hosted") {
        await connection.query(
          `UPDATE authority_transfers SET state = 'expired'
           WHERE id = $1 AND state IN ('requested', 'prepared')`,
          [transfer.id]
        );
        await connection.query(
          `UPDATE hosted_collections
           SET authority_state = 'transferred', authority_epoch = $2
           WHERE id = $1 AND authority_state = 'importing'
             AND transferred_collection_id IS NOT NULL`,
          [
            transfer.hosted_collection_id,
            Number(transfer.next_authority_epoch) - 1
          ]
        );
        await connection.query(
          `DELETE FROM hosted_collections
           WHERE id = $1 AND authority_state = 'importing'
             AND transferred_collection_id IS NULL`,
          [transfer.hosted_collection_id]
        );
      } else {
        await connection.query(
          `UPDATE authority_transfers SET state = 'expired'
           WHERE id = $1 AND state = 'prepared'`,
          [transfer.id]
        );
        await connection.query(
          `UPDATE hosted_collections SET authority_state = 'active'
           WHERE id = $1 AND authority_state = 'transferring'`,
          [transfer.hosted_collection_id]
        );
        await retireAuthorityCandidates(
          connection,
          transfer.user_id,
          transfer.hosted_collection_id
        );
      }
      await connection.query("COMMIT");
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
  }
  await db.query(
    `UPDATE authority_transfers SET state = 'expired'
     WHERE state IN ('requested', 'approved') AND expires_at <= now()`
  );
}

async function retireAuthorityCandidates(
  db: DatabaseQueryable,
  userId: string,
  hostedCollectionId: string
): Promise<void> {
  await db.query(
    `UPDATE collections
     SET authority_state = 'retired', enabled = false
     WHERE local_id = $1 AND authority_state = 'candidate'
       AND connector_id IN (SELECT id FROM connectors WHERE user_id = $2)`,
    [hostedCollectionId, userId]
  );
}

function authorityTransferView(
  transfer: AuthorityTransferDetails,
  publicUrl: string
): Record<string, unknown> {
  return {
    id: transfer.id,
    collection_id: transfer.hosted_collection_id,
    replica_id: transfer.replica_id,
    state: transfer.state,
    final_head: transfer.final_head === null ? null : Number(transfer.final_head),
    authority_epoch: transfer.next_authority_epoch === null
      ? null
      : Number(transfer.next_authority_epoch),
    manifest_digest: transfer.manifest_digest,
    expires_at: new Date(transfer.expires_at).toISOString(),
    verification_uri: `${publicUrl}/transfer/${transfer.id}`,
    ...(transfer.local_collection_id
      ? { local_collection_id: transfer.local_collection_id }
      : {}),
    ...(transfer.collection_name ? { collection_name: transfer.collection_name } : {}),
    ...(transfer.mirror_name ? { mirror_name: transfer.mirror_name } : {})
  };
}

function authorityTransferResponse(
  transfer: AuthorityTransferRow,
  publicUrl: string
): Record<string, unknown> {
  return {
    transfer: authorityTransferView(transfer, publicUrl),
    verification_uri: `${publicUrl}/transfer/${transfer.id}`,
    expires_in: Math.max(
      0,
      Math.floor((new Date(transfer.expires_at).getTime() - Date.now()) / 1_000)
    )
  };
}

function authorityImportTransferView(
  transfer: AuthorityImportTransferRow
): Record<string, unknown> {
  return {
    id: transfer.id,
    direction: "to_hosted",
    collection_id: transfer.hosted_collection_id,
    local_collection_id: transfer.local_collection_id,
    state: transfer.state,
    final_head: transfer.final_head === null ? null : Number(transfer.final_head),
    authority_epoch: Number(transfer.next_authority_epoch),
    manifest_digest: transfer.manifest_digest,
    source_revision: transfer.source_revision,
    expires_at: new Date(transfer.expires_at).toISOString()
  };
}

function authorityImportCapability(
  providerUrl: string,
  transferId: string,
  accessToken: string
): Record<string, string> {
  const base = new URL(providerUrl);
  const path = `/v1/authority-imports/${encodeURIComponent(transferId)}`;
  const endpoint = (suffix: string) => {
    const url = new URL(base);
    url.pathname = `${path}/${suffix}`;
    url.search = "";
    url.hash = "";
    return url.href;
  };
  return {
    manifest_url: endpoint("manifest"),
    records_url: endpoint("records"),
    finalize_url: endpoint("finalize"),
    access_token: accessToken
  };
}

async function hostedControlSnapshot(
  options: BuildOptions,
  hostedReference: HostedAuthorityRegistry | undefined,
  publicUrl: string,
  userId: string
): Promise<Record<string, unknown>> {
  if (!options.hostedCollections) {
    return {
      online: true,
      hosted_collections_available: false,
      hosted_collections: [],
      grants: [],
      pending_authorizations: []
    };
  }
  await recoverExpiredAuthorityTransfers(options.db, options.hostedProvider, hostedReference);
  const collections = await options.db.query<{
    id: string;
    display_name: string;
    template: HostedTemplate;
    contracts: CollectionContractDescriptor[];
    provider_url: string | null;
    authority_state: "active" | "transferring" | "transferred";
    authority_epoch: string | number;
    transferred_collection_id: string | null;
    created_at: string;
  }>(
    `SELECT id, display_name, template, provider_url, contracts, authority_state,
            authority_epoch, transferred_collection_id, created_at
     FROM hosted_collections WHERE user_id = $1 ORDER BY display_name`,
    [userId]
  );
  const replicas = collections.rows.length
    ? await options.db.query<{
        id: string;
        collection_id: string;
        name: string;
        mode: "read_only" | "read_write";
        allowed_types: string[];
        revoked_at: string | null;
        created_at: string;
      }>(
        `SELECT replica.id, replica.collection_id, replica.name, replica.mode,
                replica.allowed_types, replica.revoked_at, replica.created_at
         FROM hosted_replicas replica
         JOIN hosted_collections collection ON collection.id = replica.collection_id
         WHERE collection.user_id = $1 AND replica.purpose = 'mirror'
         ORDER BY replica.created_at`,
        [userId]
      )
    : { rows: [] };
  const statuses = new Map<string, {
    head: number;
    acknowledged_sequence: number;
    last_seen_at: string | null;
    token_expires_at: string;
  }>();
  if (options.hostedProvider) {
    const groups = await Promise.all(collections.rows.map(async (collection) => {
      try {
        return await options.hostedProvider!.replicaStatuses(collection.id);
      } catch {
        return [];
      }
    }));
    for (const status of groups.flat()) statuses.set(status.id, status);
  }
  const grants = await options.db.query(
    `SELECT g.id, g.application_id, a.family_identity AS application_family_id,
            a.name AS application_name,
            a.distribution AS application_distribution,
            a.homepage AS application_homepage,
            a.project_url AS application_project_url,
            CASE WHEN g.application_origin = '' THEN a.homepage
                 ELSE g.application_origin END AS application_origin,
            a.icon AS application_icon,
            h.id AS collection_id, h.display_name AS collection_name,
            'hosted' AS collection_kind,
            g.operations, g.scope, g.notification_criteria, g.created_at
     FROM grants g
     JOIN applications a ON a.id = g.application_id
     JOIN hosted_collections h ON h.id = g.hosted_collection_id
     WHERE g.user_id = $1 AND g.revoked_at IS NULL
       AND g.activated_at IS NOT NULL
     ORDER BY a.name, h.display_name`,
    [userId]
  );
  const pending = await options.db.query(
    `SELECT ar.id, ar.application_id,
            a.name AS application_name,
            a.distribution AS application_distribution,
            a.homepage AS application_homepage,
            a.project_url AS application_project_url,
            a.icon AS application_icon,
            ar.flow, ar.user_code, ar.requested_operations,
            ar.collection_hint, ar.expires_at,
            a.requirements, a.provisions, a.notifications
     FROM authorization_requests ar
     JOIN applications a ON a.id = ar.application_id
     WHERE ar.user_id = $1 AND ar.completed_at IS NULL
       AND ar.denied_at IS NULL AND ar.expires_at > now()
     ORDER BY ar.expires_at`,
    [userId]
  );
  return {
    online: true,
    hosted_collections_available: true,
    hosted_collections: collections.rows.map((collection) => ({
      ...collection,
      provider_url: collection.provider_url ?? publicUrl,
      spec_version: "0.3.0",
      authority_epoch: Number(collection.authority_epoch),
      contracts: contractRequirements(
        effectiveHostedContractDescriptors(collection.contracts, collection.template)
      ),
      replicas: replicas.rows
        .filter((replica) => replica.collection_id === collection.id)
        .map((replica) => ({
          ...replica,
          sync_status: statuses.get(replica.id) ?? null
        }))
    })),
    grants: grants.rows.map((grant) => ({
      ...grant,
      application_origin: normalizedApplicationOrigin(grant.application_origin)
    })),
    pending_authorizations: pending.rows.map((authorization) => ({
      ...authorization,
      compatible_collection_ids: [],
      provisionable_collection_ids: []
    }))
  };
}

async function createHostedCollectionForUser(
  options: BuildOptions,
  hostedReference: HostedAuthorityRegistry | undefined,
  publicUrl: string,
  userId: string,
  displayName: string,
  template: HostedTemplate
): Promise<Record<string, unknown>> {
  if (!options.hostedCollections) {
    throw new RequestValidationError("Hosted collections are not enabled.");
  }
  const collectionId = randomUUID();
  try {
    if (options.hostedProvider) {
      await options.hostedProvider.createCollection(collectionId, template, displayName);
    } else {
      await hostedReference!.create(collectionId, template);
    }
    await options.db.query(
      `INSERT INTO hosted_collections
         (id, user_id, display_name, template, provider_url, contracts)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        collectionId,
        userId,
        displayName,
        template,
        options.hostedProvider?.url ?? null,
        JSON.stringify(hostedContractDescriptors(template))
      ]
    );
  } catch (error) {
    if (options.hostedProvider) {
      await options.hostedProvider.deleteCollection(collectionId).catch(() => undefined);
    } else {
      await hostedReference?.delete(collectionId).catch(() => undefined);
    }
    throw error;
  }
  await audit(options.db, userId, "hosted_collection.created", collectionId, {
    template,
    source: "desktop"
  });
  return {
    id: collectionId,
    display_name: displayName,
    template,
    provider_url: options.hostedProvider?.url ?? publicUrl,
    spec_version: "0.3.0",
    contracts: contractRequirements(hostedContractDescriptors(template)),
    authority_state: "active",
    authority_epoch: 1,
    transferred_collection_id: null,
    created_at: new Date().toISOString(),
    replicas: []
  };
}

async function renameHostedCollectionForUser(
  options: BuildOptions,
  userId: string,
  collectionId: string,
  displayName: string
): Promise<{ id: string; display_name: string } | null> {
  if (!await ownsHostedCollection(options.db, userId, collectionId)) return null;
  if (options.hostedProvider) {
    await options.hostedProvider.renameCollection(collectionId, displayName);
  }
  const renamed = await options.db.query<{ id: string; display_name: string }>(
    `UPDATE hosted_collections SET display_name = $3
     WHERE id = $1 AND user_id = $2 RETURNING id, display_name`,
    [collectionId, userId, displayName]
  );
  await audit(options.db, userId, "hosted_collection.renamed", collectionId, {
    display_name: displayName,
    source: "desktop"
  });
  return renamed.rows[0] ?? null;
}

async function deleteHostedCollectionForUser(
  options: BuildOptions,
  hostedReference: HostedAuthorityRegistry | undefined,
  userId: string,
  collectionId: string
): Promise<boolean> {
  if (!await ownsHostedCollection(options.db, userId, collectionId)) return false;
  if (options.hostedProvider) await options.hostedProvider.deleteCollection(collectionId);
  else await hostedReference!.delete(collectionId);
  const connection = await options.db.connect();
  try {
    await connection.query("BEGIN");
    await connection.query(
      "DELETE FROM grants WHERE hosted_collection_id = $1 AND user_id = $2",
      [collectionId, userId]
    );
    await connection.query(
      "DELETE FROM hosted_collections WHERE id = $1 AND user_id = $2",
      [collectionId, userId]
    );
    await audit(connection, userId, "hosted_collection.deleted", collectionId, {
      source: "desktop"
    });
    await connection.query("COMMIT");
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
  return true;
}

async function revokeHostedReplicaForUser(
  options: BuildOptions,
  hostedReference: HostedAuthorityRegistry | undefined,
  userId: string,
  replicaId: string
): Promise<boolean> {
  const found = await options.db.query<{
    collection_id: string;
    revoked_at: string | null;
  }>(
    `SELECT replica.collection_id, replica.revoked_at FROM hosted_replicas replica
     JOIN hosted_collections collection ON collection.id = replica.collection_id
     WHERE replica.id = $1 AND replica.purpose = 'mirror'
       AND collection.user_id = $2`,
    [replicaId, userId]
  );
  const replica = found.rows[0];
  if (!replica) return false;
  if (replica.revoked_at) return true;
  if (options.hostedProvider) await options.hostedProvider.revokeReplica(replicaId);
  else await hostedReference!.revokeReplica(replica.collection_id, replicaId);
  await options.db.query(
    "UPDATE hosted_replicas SET revoked_at = now(), token_hash = NULL WHERE id = $1",
    [replicaId]
  );
  await options.db.query("DELETE FROM mirror_pairing_requests WHERE replica_id = $1", [replicaId]);
  await audit(options.db, userId, "hosted_replica.revoked", replicaId, {
    source: "desktop"
  });
  return true;
}

async function narrowHostedGrantForUser(
  options: BuildOptions,
  userId: string,
  grantId: string,
  requestedOperations: string[]
): Promise<{ id: string; operations: string[] } | null> {
  const active = await options.db.query<{
    id: string;
    hosted_replica_id: string;
    operations: string[];
    scope: GrantScope;
    requirements: ApplicationRequirements;
    template: HostedTemplate;
    hosted_contracts: CollectionContractDescriptor[];
  }>(
    `SELECT g.id, g.hosted_replica_id, g.operations, g.scope,
            a.requirements, h.template,
            h.contracts AS hosted_contracts
     FROM grants g
     JOIN applications a ON a.id = g.application_id
     JOIN hosted_collections h ON h.id = g.hosted_collection_id
     WHERE g.id = $1 AND g.user_id = $2 AND g.revoked_at IS NULL
       AND g.activated_at IS NOT NULL`,
    [grantId, userId]
  );
  const current = active.rows[0];
  if (!current) return null;
  const operations = [...new Set(requestedOperations)];
  if (operations.some((operation) => !current.operations.includes(operation))) {
    throw new RequestValidationError(
      "Existing access can be narrowed here, but broader access requires a new application request."
    );
  }
  assertOperationsAllowedByRequirements(operations, current.requirements);
  if (!options.hostedProvider) {
    throw new RequestValidationError("Hosted application access is temporarily unavailable.");
  }
  const write = operations.some((operation) => [
    "create",
    "update",
    "delete",
    "rename",
    "create_type",
    "update_type",
    "create_view_source",
    "update_view_source",
    "delete_view_source",
    "put_timer",
    "cancel_timer",
    "reconcile_timers"
  ].includes(operation));
  await options.hostedProvider.updateApplicationReplica(current.hosted_replica_id, {
    grantId,
    mode: write ? "read_write" : "read_only",
    allowedTypes: typesForContracts(
      effectiveHostedContractDescriptors(current.hosted_contracts, current.template),
      current.scope.contracts
    ),
    fullCollection: current.scope.access === "full_collection",
    allowedOperations: operations
  });
  const updated = await options.db.query<{ id: string; operations: string[] }>(
    "UPDATE grants SET operations = $2::jsonb WHERE id = $1 RETURNING id, operations",
    [grantId, JSON.stringify(operations)]
  );
  await audit(options.db, userId, "grant.narrowed", grantId, {
    previous_operations: current.operations,
    operations,
    source: "desktop"
  });
  return updated.rows[0] ?? null;
}

async function revokeHostedGrantForUser(
  options: BuildOptions,
  userId: string,
  grantId: string
): Promise<boolean> {
  const active = await options.db.query<{
    hosted_collection_id: string;
    hosted_replica_id: string;
  }>(
    `SELECT g.hosted_collection_id, g.hosted_replica_id
     FROM grants g
     JOIN hosted_collections h ON h.id = g.hosted_collection_id
     WHERE g.id = $1 AND g.user_id = $2 AND g.revoked_at IS NULL
       AND g.activated_at IS NOT NULL`,
    [grantId, userId]
  );
  const current = active.rows[0];
  if (!current) return false;
  if (!options.hostedProvider) {
    throw new RequestValidationError("Hosted application access is temporarily unavailable.");
  }
  await options.hostedProvider.revokeReplica(current.hosted_replica_id);
  await options.hostedProvider.revokeNotificationGrant(current.hosted_collection_id, grantId);
  await options.db.query(
    "UPDATE hosted_replicas SET revoked_at = now() WHERE id = $1",
    [current.hosted_replica_id]
  );
  await options.db.query("UPDATE grants SET revoked_at = now() WHERE id = $1", [grantId]);
  await options.db.query("UPDATE access_tokens SET revoked_at = now() WHERE grant_id = $1", [grantId]);
  await options.db.query("UPDATE refresh_tokens SET revoked_at = now() WHERE grant_id = $1", [grantId]);
  await audit(options.db, userId, "grant.revoked", grantId, { source: "desktop" });
  return true;
}

async function ownsHostedCollection(
  db: DatabasePool,
  userId: string,
  collectionId: string
): Promise<boolean> {
  const result = await db.query(
    "SELECT id FROM hosted_collections WHERE id = $1 AND user_id = $2",
    [collectionId, userId]
  );
  return Boolean(result.rows[0]);
}

async function ownsActiveHostedCollection(
  db: DatabasePool,
  userId: string,
  collectionId: string
): Promise<boolean> {
  const result = await db.query(
    `SELECT id FROM hosted_collections
     WHERE id = $1 AND user_id = $2 AND authority_state = 'active'`,
    [collectionId, userId]
  );
  return Boolean(result.rows[0]);
}

async function rotateMirrorPairingToken(
  options: BuildOptions,
  hostedReference: HostedAuthorityRegistry | undefined,
  publicUrl: string,
  replicaId: string,
  collectionId: string
) {
  const active = await options.db.query<{
    id: string;
    collection_id: string;
    name: string;
    mode: "read_only" | "read_write";
  }>(
    `SELECT id, collection_id, name, mode
     FROM hosted_replicas
     WHERE id = $1 AND collection_id = $2 AND purpose = 'mirror' AND revoked_at IS NULL`,
    [replicaId, collectionId]
  );
  const replica = active.rows[0];
  if (!replica) {
    throw new SyncError("replica_revoked", "This mirror has been revoked.");
  }
  const token = randomToken("hsr");
  if (options.hostedProvider) {
    await options.hostedProvider.rotateReplicaToken(replicaId, token);
  } else {
    await options.db.query(
      "UPDATE hosted_replicas SET token_hash = $2 WHERE id = $1 AND revoked_at IS NULL",
      [replicaId, tokenHash(token)]
    );
    if (!hostedReference) throw new Error("Hosted reference authority is unavailable.");
  }
  return {
    status: "paired" as const,
    replica: {
      id: replica.id,
      collection_id: replica.collection_id,
      name: replica.name,
      mode: replica.mode
    },
    token,
    token_expires_at: replicaTokenExpiry(),
    sync_url: authorityUrl(
      options.hostedProvider?.url ?? publicUrl,
      replica.collection_id,
      "sync"
    )
  };
}

function replicaTokenExpiry(): string {
  return new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000).toISOString();
}

async function requireHostedReplica(
  request: FastifyRequest,
  reply: FastifyReply,
  db: DatabasePool
): Promise<{ id: string; collection_id: string } | null> {
  const bearer = bearerToken(request);
  if (!bearer) {
    reply.code(401).send(apiError("invalid_replica_token", "Replica token required."));
    return null;
  }
  const result = await db.query<{ id: string; collection_id: string }>(
    `SELECT id, collection_id FROM hosted_replicas
     WHERE token_hash = $1 AND revoked_at IS NULL`,
    [tokenHash(bearer)]
  );
  if (!result.rows[0]) {
    reply.code(401).send(apiError("invalid_replica_token", "Replica token is invalid or revoked."));
    return null;
  }
  return result.rows[0];
}

async function requireUser(
  request: FastifyRequest,
  reply: FastifyReply,
  db: DatabasePool,
  tailscaleAuth = false
): Promise<User | null> {
  const user = await authenticatedUser(request, db, tailscaleAuth);
  if (!user) reply.code(401).send(apiError("not_authenticated", "Sign in to continue."));
  return user;
}

async function connectorFromRequest(request: FastifyRequest, db: DatabasePool): Promise<ConnectorIdentity | null> {
  const token = bearerToken(request);
  if (!token) return null;
  const connector = await db.query<ConnectorIdentity>(
    "SELECT id, user_id FROM connectors WHERE token_hash = $1",
    [tokenHash(token)]
  );
  return connector.rows[0] ?? null;
}

async function requireConnector(
  request: FastifyRequest,
  reply: FastifyReply,
  db: DatabasePool
): Promise<ConnectorIdentity | null> {
  const connector = await connectorFromRequest(request, db);
  if (!connector) reply.code(401).send(apiError("invalid_connector", "Connector credential is invalid."));
  return connector;
}

function bearerToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  return authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
}

function authorityUrl(
  baseUrl: string,
  collectionId: string,
  capability: "operations" | "sync"
): string {
  const base = new URL(baseUrl);
  base.pathname = `/v1/authorities/${encodeURIComponent(collectionId)}/${capability}`;
  base.search = "";
  base.hash = "";
  return base.href.replace(/\/$/, "");
}

function sessionToken(request: FastifyRequest): string | null {
  return request.cookies["__Host-mdbase_session"] ?? request.cookies.mdbase_session ?? null;
}

function setSessionCookie(reply: FastifyReply, token: string, publicUrl: string): void {
  reply.setCookie(sessionCookieName(publicUrl), token, {
    httpOnly: true,
    sameSite: "lax",
    secure: publicUrl.startsWith("https:"),
    path: "/",
    maxAge: 60 * 60 * 24 * 30
  });
}

function sessionCookieName(publicUrl: string): string {
  return publicUrl.startsWith("https:") ? "__Host-mdbase_session" : "mdbase_session";
}

function oauthStateCookieName(publicUrl: string, provider: "github" | "google"): string {
  return publicUrl.startsWith("https:")
    ? `__Host-mdbase_oauth_${provider}`
    : `mdbase_oauth_${provider}`;
}

function identityAllowed(
  registration: RegistrationMode,
  allowedSubjects: ReadonlySet<string>,
  subject: string
): boolean {
  return registration === "open" || allowedSubjects.has(subject);
}

function requireSameOrigin(request: FastifyRequest, publicUrl: string): void {
  if (request.headers.origin !== new URL(publicUrl).origin) {
    throw new OriginDeniedError();
  }
}

interface AuthenticationLimitAttempt {
  scope: string;
  key: string;
  rule: AuthRateLimitRule;
}

async function consumeAuthenticationLimits(
  limiter: AuthRateLimiter,
  attempts: AuthenticationLimitAttempt[],
  reply: FastifyReply
): Promise<boolean> {
  let retryAfterSeconds = 0;
  for (const attempt of attempts) {
    const decision = await limiter.consume(
      attempt.scope,
      attempt.key,
      attempt.rule
    );
    if (!decision.allowed) {
      retryAfterSeconds = Math.max(
        retryAfterSeconds,
        decision.retryAfterSeconds
      );
    }
  }
  if (retryAfterSeconds === 0) return true;
  reply.header("retry-after", String(retryAfterSeconds));
  await reply.code(429).send(apiError(
    "authentication_throttled",
    "Too many authentication attempts. Please try again later."
  ));
  return false;
}

function safeReturnTarget(requested: string | undefined, publicUrl: string): string {
  if (!requested) return "/";
  try {
    const origin = new URL(publicUrl).origin;
    const target = new URL(requested, origin);
    if (target.origin !== origin) return "/";
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return "/";
  }
}

async function audit(
  db: DatabaseQueryable,
  userId: string | null,
  eventType: string,
  subjectId: string | null,
  metadata: unknown
): Promise<void> {
  await db.query(
    `INSERT INTO audit_events (id, user_id, event_type, subject_id, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [randomUUID(), userId, eventType, subjectId, JSON.stringify(metadata)]
  );
}

function apiError(code: string, message: string) {
  return { error: { code, message } };
}

function httpErrorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) {
    return undefined;
  }
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" ? statusCode : undefined;
}

function oauthError(error: string, errorDescription: string) {
  return { error, error_description: errorDescription };
}
