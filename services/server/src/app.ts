import { ECDH, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
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
  TypeProvision
} from "@mdbase/connect-protocol";
import {
  ENCRYPTED_RELAY_PROTOCOL_VERSION,
  RELAY_ENCRYPTION_SUITE
} from "@mdbase/connect-protocol";
import { z, ZodError } from "zod";
import { SyncError } from "@mdbase/connect-sync";
import type { DatabasePool, DatabaseQueryable } from "./db.js";
import { fetchManifest } from "./manifest.js";
import { ConnectorOperationError, RelayHub, RelayUnavailableError } from "./relay.js";
import type { RelayBroker } from "./relay-broker.js";
import { pkceChallenge, randomToken, safeEqual, tokenHash } from "./security.js";
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
  exchangeGitHubCode,
  GitHubIdentityError,
  type GitHubAuthConfig
} from "./github-auth.js";
import { createExternalSession } from "./external-auth.js";
import {
  GoogleIdentityError,
  verifyGoogleCredential,
  type GoogleAuthConfig
} from "./google-auth.js";
import type { RegistrationMode } from "./runtime-config.js";
import {
  activeGrantForToken,
  NotificationService,
  type PushTransport
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
  "update_type"
] as const;
const operationSchema = z.enum(OPERATIONS);
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
  hostedCollections?: boolean;
  hostedProvider?: HostedProviderClient;
  hostedReferenceAuthority?: boolean;
  publicUrl?: string;
  portalDist?: string;
  allowInsecureManifests?: boolean;
  trustProxy?: boolean;
  relayBroker?: RelayBroker;
  notifications?: {
    publicKey: string;
    transport: PushTransport;
    pollIntervalMs?: number;
  };
}

interface User {
  id: string;
  email: string | null;
  name: string;
  login: string | null;
  authentication_provider?: "github" | "google" | "session" | "tailscale";
}

interface ConnectorIdentity {
  id: string;
  user_id: string;
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
  const registration = options.registration ?? "closed";
  const relay = new RelayHub(options.db, options.relayBroker);
  const notifications = options.notifications
    ? new NotificationService(
        options.db,
        options.notifications.transport,
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
    if (!options.hostedCollections && request.url.startsWith("/v1/hosted/")) {
      return reply.code(404).send(apiError("not_found", "Not found."));
    }
    if (
      options.hostedProvider
      && request.url.startsWith("/v1/hosted/collections/")
      && request.url.includes("/sync/")
    ) {
      return reply.code(421).send({
        ...apiError(
          "sync_provider_direct_required",
          "Connect directly to the collection's hosted storage provider."
        ),
        sync_url: options.hostedProvider.url
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
    if (error instanceof ZodError) {
      return reply.code(400).send(apiError("invalid_request", error.issues[0]?.message ?? "Invalid request."));
    }
    if (error instanceof RequestValidationError) {
      return reply.code(400).send(apiError("invalid_request", error.message));
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
    request.log.error(error);
    return reply.code(500).send(apiError("internal_error", "The request could not be completed."));
  });

  app.get("/health", async () => ({
    ok: true,
    service: "mdbase-connect",
    protocol_version: 2,
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

  app.get("/v1/auth/config", async () => {
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
      registration,
      development_login: options.devAuth === true,
      ...(providers.length === 1 ? { login_url: providers[0].login_url } : {})
    };
  });

  app.get("/auth/github", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    if (!options.githubAuth) return reply.code(404).send(apiError("not_found", "Not found."));
    const query = z.object({ return_to: z.string().max(2_048).optional() }).parse(request.query);
    const state = randomToken("oauth");
    const codeVerifier = randomToken("pkce");
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
    authorize.searchParams.set("allow_signup", registration === "open" ? "true" : "false");
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
    if (!identityAllowed(registration, options.githubAuth.allowedUserIds, identity.id)) {
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
    if (!identityAllowed(registration, options.googleAuth.allowedSubjects, identity.id)) {
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
      `INSERT INTO sessions (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + interval '30 days')`,
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
    const { authentication_provider: authenticationProvider, ...user } = authenticated;
    const connectors = await options.db.query(
      `SELECT c.id, c.name, c.last_seen_at, c.created_at
       FROM connectors c WHERE c.user_id = $1 ORDER BY c.created_at`,
      [user.id]
    );
    const collections = await options.db.query(
      `SELECT col.id, col.connector_id, col.local_id, col.display_name, col.spec_version, col.enabled,
              col.contracts, col.last_seen_at,
              c.name AS connector_name
       FROM collections col JOIN connectors c ON c.id = col.connector_id
       WHERE c.user_id = $1 ORDER BY col.display_name`,
      [user.id]
    );
    const hostedCollections = options.hostedCollections
      ? await options.db.query<{
          id: string;
          display_name: string;
          template: string;
          contracts: CollectionContractDescriptor[];
          provider_url: string | null;
          created_at: string;
        }>(
          `SELECT id, display_name, template, provider_url, contracts, created_at
           FROM hosted_collections WHERE user_id = $1 ORDER BY display_name`,
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
    const grants = await options.db.query(
      `SELECT g.id, g.operations, g.scope, g.created_at, g.revoked_at,
              CASE WHEN g.application_origin = '' THEN a.homepage
                   ELSE g.application_origin END AS application_origin,
              COALESCE(g.collection_id, g.hosted_collection_id) AS collection_id,
              a.id AS application_id, a.name AS application_name, a.homepage, a.icon,
              COALESCE(col.display_name, hosted.display_name) AS collection_name,
              CASE WHEN g.hosted_collection_id IS NULL THEN 'local' ELSE 'hosted' END AS collection_kind
       FROM grants g
       JOIN applications a ON a.id = g.application_id
       LEFT JOIN collections col ON col.id = g.collection_id
       LEFT JOIN hosted_collections hosted ON hosted.id = g.hosted_collection_id
       WHERE g.user_id = $1 ORDER BY g.created_at DESC`,
      [user.id]
    );
    const pendingAuthorizations = await options.db.query(
      `SELECT ar.id, ar.requested_operations, ar.expires_at,
              a.id AS application_id, a.name AS application_name, a.homepage, a.icon,
              a.requirements, a.provisions
       FROM authorization_requests ar
       JOIN applications a ON a.id = ar.application_id
       WHERE ar.user_id = $1 AND ar.completed_at IS NULL AND ar.denied_at IS NULL
         AND ar.expires_at > now()
       ORDER BY ar.expires_at`,
      [user.id]
    );
    return {
      user,
      authentication: {
        provider: authenticationProvider ?? (options.tailscaleAuth ? "tailscale" : "session"),
        registration
      },
      connectors: connectors.rows,
      collections: collections.rows,
      hosted_collections: hostedCollections.rows.map((collection) => ({
        ...collection,
        provider_url: collection.provider_url ?? publicUrl,
        spec_version: "0.3.0",
        contracts: contractRequirements(effectiveHostedContractDescriptors(collection.contracts, collection.template)),
        replicas: hostedReplicas.rows.filter((replica) => replica.collection_id === collection.id)
      })),
      grants: grants.rows.map((grant) => ({
        ...grant,
        application_origin: new URL(grant.application_origin).origin
      })),
      pending_authorizations: pendingAuthorizations.rows
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
      collections: z.array(z.object({
        id: z.uuid(),
        display_name: z.string().min(1).max(200),
        spec_version: z.string().min(1).max(30),
        enabled: z.boolean(),
        contracts: z.array(contractRequirementSchema).max(100).default([])
      })).max(1_000)
    }).parse(request.body);
    if (input.relay_public_key) {
      await options.db.query(
        "UPDATE connectors SET relay_public_key = $2 WHERE id = $1",
        [connector.id, input.relay_public_key]
      );
    }
    const synchronized = [];
    for (const collection of input.collections) {
      const row = await options.db.query<{ id: string; local_id: string }>(
        `INSERT INTO collections (id, connector_id, local_id, display_name, spec_version, enabled, contracts)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         ON CONFLICT(connector_id, local_id) DO UPDATE SET
           display_name = excluded.display_name,
           spec_version = excluded.spec_version,
           enabled = excluded.enabled,
           contracts = excluded.contracts,
           last_seen_at = now()
         RETURNING id, local_id`,
        [
          randomUUID(),
          connector.id,
          collection.id,
          collection.display_name,
          collection.spec_version,
          collection.enabled,
          JSON.stringify(collection.contracts)
        ]
      );
      synchronized.push(row.rows[0]);
    }
    await options.db.query("UPDATE connectors SET last_seen_at = now() WHERE id = $1", [connector.id]);
    return { collections: synchronized };
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
              a.homepage AS application_homepage,
              CASE WHEN g.application_origin = '' THEN a.homepage
                   ELSE g.application_origin END AS application_origin,
              a.icon AS application_icon,
              col.local_id AS collection_id, col.display_name AS collection_name,
              g.operations, g.scope, g.encryption, g.created_at,
              a.notifications->'criteria' AS notification_criteria
       FROM grants g
       JOIN applications a ON a.id = g.application_id
       JOIN collections col ON col.id = g.collection_id
       WHERE col.connector_id = $1 AND g.revoked_at IS NULL
       ORDER BY a.name, col.display_name`,
      [connector.id]
    );
    const pendingAuthorizations = await options.db.query(
      `SELECT ar.id, ar.application_id, a.name AS application_name,
              a.homepage AS application_homepage, a.icon AS application_icon,
              ar.requested_operations, ar.expires_at, a.requirements, a.provisions
       FROM authorization_requests ar
       JOIN applications a ON a.id = ar.application_id
       WHERE ar.user_id = $1 AND ar.completed_at IS NULL AND ar.denied_at IS NULL
         AND ar.expires_at > now()
       ORDER BY ar.expires_at`,
      [connector.user_id]
    );
    return {
      configured: true,
      online: true,
      account: account.rows[0],
      grants: grants.rows.map((grant) => ({
        ...grant,
        application_origin: new URL(grant.application_origin).origin
      })),
      pending_authorizations: pendingAuthorizations.rows
        .filter((authorization) => !requiresHostedCollection(authorization.requirements))
    };
  });

  app.post("/v1/connectors/apps/discover", async (request, reply) => {
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return;
    const input = z.object({ manifest_url: z.url() }).parse(request.body);
    const discovered = await fetchManifest(input.manifest_url, options.allowInsecureManifests);
    const application = await upsertApplication(options.db, discovered);
    await audit(options.db, connector.user_id, "application.discovered", application.id, {
      manifest_url: input.manifest_url,
      connector_id: connector.id
    });
    return { application };
  });

  app.get("/v1/connectors/apps/:applicationId", async (request, reply) => {
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return;
    const { applicationId } = z.object({ applicationId: z.uuid() }).parse(request.params);
    const application = await options.db.query(
      `SELECT id, name, homepage, icon, requirements, provisions, notifications
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
         WHERE connector_id = $1 AND local_id = $2 AND enabled = true`,
        [connector.id, input.collection_id, JSON.stringify(input.contracts)]
      );
    }
    const collection = await options.db.query<{ id: string; contracts: ContractRequirement[]; spec_version: string }>(
      `SELECT id, contracts, spec_version FROM collections WHERE connector_id = $1 AND local_id = $2 AND enabled = true`,
      [connector.id, input.collection_id]
    );
    if (!collection.rows[0]) return reply.code(404).send(apiError("collection_not_found", "Collection is not synchronized yet."));
    const application = await options.db.query<{
      id: string;
      homepage: string;
      requirements: ApplicationRequirements;
    }>(
      "SELECT id, homepage, requirements FROM applications WHERE id = $1",
      [input.application_id]
    );
    if (!application.rows[0]) return reply.code(404).send(apiError("application_not_found", "Application not found."));
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
      applicationOrigin: new URL(application.rows[0].homepage).origin
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
       WHERE g.id = $1 AND g.revoked_at IS NULL AND g.collection_id IN
         (SELECT id FROM collections WHERE connector_id = $2)`,
      [grantId, connector.id]
    );
    if (!current.rows[0]) return reply.code(404).send(apiError("grant_not_found", "Active grant not found."));
    assertOperationsAllowedByRequirements(input.operations, current.rows[0].requirements);
    assertCollectionSupportsOperations(current.rows[0].spec_version, input.operations);
    const grant = await options.db.query(
      `UPDATE grants SET operations = $3::jsonb
       WHERE id = $1 AND revoked_at IS NULL AND collection_id IN
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
       WHERE id = $1 AND revoked_at IS NULL AND collection_id IN
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
         WHERE connector_id = $1 AND local_id = $2 AND enabled = true`,
        [connector.id, input.collection_id, JSON.stringify(input.contracts)]
      );
    }
    const collection = await options.db.query<{ id: string }>(
      `SELECT id FROM collections
       WHERE connector_id = $1 AND local_id = $2 AND enabled = true`,
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

  app.post("/v1/hosted/collections", async (request, reply) => {
    const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
    if (!user) return;
    const input = z.object({
      display_name: z.string().trim().min(1).max(200),
      template: z.enum(["mdbase", "tasknotes"]).default("mdbase")
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
        sync_url: options.hostedProvider?.url ?? publicUrl
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
    if (!await ownsHostedCollection(options.db, user.id, collectionId)) {
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
      sync_url: options.hostedProvider?.url ?? publicUrl
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
    const active = await options.db.query<{ id: string }>(
      `SELECT r.id FROM hosted_replicas r JOIN hosted_collections c ON c.id = r.collection_id
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
    return { token, sync_url: options.hostedProvider?.url ?? publicUrl };
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

  app.post("/v1/hosted/collections/:collectionId/sync/sessions", async (request, reply) => {
    const replica = await requireHostedReplica(request, reply, options.db);
    if (!replica) return;
    const { collectionId } = z.object({ collectionId: z.uuid() }).parse(request.params);
    if (collectionId !== replica.collection_id) return reply.code(403).send(apiError("replica_scope_denied", "Replica belongs to another collection."));
    return (await hostedReference!.transport(collectionId, replica.id)).openSession();
  });

  app.get("/v1/hosted/collections/:collectionId/sync/snapshot", async (request, reply) => {
    const replica = await requireHostedReplica(request, reply, options.db);
    if (!replica) return;
    const { collectionId } = z.object({ collectionId: z.uuid() }).parse(request.params);
    const query = z.object({ snapshot_id: z.uuid(), page: z.string().regex(/^[1-9][0-9]*$/).optional() }).parse(request.query);
    if (collectionId !== replica.collection_id) return reply.code(403).send(apiError("replica_scope_denied", "Replica belongs to another collection."));
    return (await hostedReference!.transport(collectionId, replica.id)).snapshot(query.snapshot_id, query.page);
  });

  app.get("/v1/hosted/collections/:collectionId/sync/changes", async (request, reply) => {
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

  app.post("/v1/hosted/collections/:collectionId/sync/mutations", async (request, reply) => {
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

  app.post("/v1/apps/discover", async (request, reply) => {
    const input = z.object({ manifest_url: z.url() }).parse(request.body);
    const discovered = await fetchManifest(input.manifest_url, options.allowInsecureManifests);
    const application = await upsertApplication(options.db, discovered);
    await reconcileApplicationGrants(options.db, relay, options.hostedProvider, application);
    return { application };
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
      homepage: string;
      requirements: ApplicationRequirements;
    }>(
      "SELECT id, homepage, requirements FROM applications WHERE id = $1",
      [input.application_id]
    );
    if (!application.rows[0]) return reply.code(404).send(apiError("application_not_found", "Application not found."));
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
      applicationOrigin: new URL(application.rows[0].homepage).origin
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
       WHERE g.id = $1 AND g.user_id = $2 AND g.revoked_at IS NULL`,
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
      const write = operations.some((operation) => ["create", "update", "delete", "rename", "create_type", "update_type", "create_view_source", "update_view_source", "delete_view_source"].includes(operation));
      await options.hostedProvider.updateApplicationReplica(current.hosted_replica_id, {
        mode: write ? "read_write" : "read_only",
        allowedTypes: typesForContracts(
          effectiveHostedContractDescriptors(current.hosted_contracts, current.template!),
          current.scope.contracts
        ),
        fullCollection: scopeAccess(current.scope) === "full_collection",
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
       WHERE g.id = $1 AND g.user_id = $2 AND g.revoked_at IS NULL`,
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
        "Encrypted relay authorization requires protocol 3 and a valid P-256 public key."
      ));
    }
    const application = await options.db.query<{
      id: string;
      redirect_uris: string[];
      requirements: ApplicationRequirements;
    }>(
      "SELECT id, redirect_uris, requirements FROM applications WHERE id = $1",
      [query.client_id]
    );
    if (!application.rows[0] || !application.rows[0].redirect_uris.includes(query.redirect_uri)) {
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
          requested_operations, relay_protocol, application_public_key, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, now() + interval '10 minutes')`,
      [
        authorizationId,
        user.id,
        query.client_id,
        query.redirect_uri,
        query.state ?? null,
        query.code_challenge,
        JSON.stringify(requestedOperations),
        query.relay_protocol ?? null,
        query.application_public_key ?? null
      ]
    );
    return reply.redirect(`/authorize/${authorizationId}`);
  });

  app.get("/v1/authorization-requests/:requestId", async (request, reply) => {
    const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
    if (!user) return;
    const { requestId } = z.object({ requestId: z.uuid() }).parse(request.params);
    const authorization = await options.db.query(
      `SELECT ar.id, ar.requested_operations, ar.expires_at,
              a.id AS application_id, a.name AS application_name, a.homepage, a.icon,
              a.requirements, a.provisions
       FROM authorization_requests ar JOIN applications a ON a.id = ar.application_id
       WHERE ar.id = $1 AND ar.user_id = $2 AND ar.expires_at > now()`,
      [requestId, user.id]
    );
    if (!authorization.rows[0]) return reply.code(404).send(apiError("authorization_not_found", "Authorization request expired or was not found."));
    const collections = await options.db.query(
      `SELECT col.id, col.display_name, col.spec_version, col.contracts,
              c.name AS connector_name
       FROM collections col JOIN connectors c ON c.id = col.connector_id
       WHERE c.user_id = $1 AND col.enabled = true ORDER BY col.display_name`,
      [user.id]
    );
    const hosted = options.hostedCollections
      ? await options.db.query<{
          id: string;
          display_name: string;
          spec_version?: string;
          template: HostedTemplate;
          contracts: CollectionContractDescriptor[];
        }>(
          `SELECT id, display_name, template, contracts FROM hosted_collections
           WHERE user_id = $1 ORDER BY display_name`,
          [user.id]
        )
      : { rows: [] };
    const availableCollections = [
      ...collections.rows.map((collection) => ({ ...collection, kind: "local" as const })),
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
      application_id: string;
      grant_id: string | null;
      redirect_uri: string;
      state: string | null;
      code_challenge: string;
    }>(
      `SELECT completed_at, denied_at, expires_at, application_id, grant_id,
              redirect_uri, state, code_challenge
       FROM authorization_requests
       WHERE id = $1 AND user_id = $2 AND expires_at > now()`,
      [requestId, user.id]
    );
    const value = authorization.rows[0];
    if (!value) return reply.code(404).send(apiError("authorization_not_found", "Authorization request expired or was not found."));
    if (value.denied_at) {
      return { status: "denied", redirect_uri: deniedAuthorizationRedirect(value) };
    }
    if (value.completed_at && value.grant_id) {
      return {
        status: "approved",
        redirect_uri: await createAuthorizationRedirect(options.db, publicUrl, {
          ...value,
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
    const input = z.object({ collection_id: z.uuid(), operations: z.array(operationSchema).min(1) }).parse(request.body);
    const collection = await options.db.query<{ connector_id: string }>(
      `SELECT col.connector_id FROM collections col JOIN connectors c ON c.id = col.connector_id
       WHERE col.id = $1 AND c.user_id = $2 AND col.enabled = true`,
      [input.collection_id, user.id]
    );
    let approved: boolean;
    if (collection.rows[0]) {
      approved = await approveAuthorization(options.db, relay, {
        requestId,
        userId: user.id,
        connectorId: collection.rows[0].connector_id,
        collectionId: input.collection_id,
        operations: input.operations,
        source: "portal"
      });
    } else {
      const hosted = await options.db.query<{ id: string; template: string; display_name: string; contracts: CollectionContractDescriptor[] }>(
        "SELECT id, template, display_name, contracts FROM hosted_collections WHERE id = $1 AND user_id = $2",
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
      })
    ]).parse(request.body);

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

    const refresh = await options.db.query<{ id: string; grant_id: string }>(
      `SELECT rt.id, rt.grant_id
       FROM refresh_tokens rt
       JOIN grants g ON g.id = rt.grant_id
       WHERE rt.token_hash = $1 AND rt.used_at IS NULL AND rt.revoked_at IS NULL
         AND rt.expires_at > now() AND g.revoked_at IS NULL AND g.application_id = $2`,
      [tokenHash(input.refresh_token), input.client_id]
    );
    const current = refresh.rows[0];
    if (!current) {
      return reply.code(400).send(apiError("invalid_grant", "Refresh token is invalid or expired."));
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
    if (!options.notifications) {
      return reply.code(404).send(apiError("notifications_unavailable", "Push notifications are not configured."));
    }
    return { public_key: options.notifications.publicKey };
  });

  app.post("/v1/notifications/channels", async (request, reply) => {
    if (!notifications) {
      return reply.code(503).send(apiError("notifications_unavailable", "Push notifications are not configured."));
    }
    const bearer = bearerToken(request);
    if (!bearer) return reply.code(401).send(apiError("invalid_token", "Bearer token required."));
    const input = z.object({
      installation_id: z.string().min(16).max(200),
      criteria: z.array(z.string().min(1).max(100)).min(1).max(100),
      subscription: z.object({
        endpoint: z.url().refine((value) => new URL(value).protocol === "https:", "Push endpoint must use HTTPS."),
        expirationTime: z.number().int().positive().nullable().optional(),
        keys: z.object({
          p256dh: z.string().min(16).max(512),
          auth: z.string().min(8).max(256)
        }).strict()
      }).strict()
    }).strict().parse(request.body);
    const criteria = [...new Set(input.criteria)];
    const connection = await options.db.connect();
    try {
      await connection.query("BEGIN");
      const grant = await activeGrantForToken(connection, tokenHash(bearer));
      if (!grant) {
        await connection.query("ROLLBACK");
        return reply.code(401).send(apiError("invalid_token", "Access token is invalid or expired."));
      }
      const application = await connection.query<{ notifications: ApplicationNotifications }>(
        `SELECT a.notifications
         FROM grants g
         JOIN applications a ON a.id = g.application_id
         WHERE g.id = $1 AND g.revoked_at IS NULL`,
        [grant.grant_id]
      );
      const declared = new Set(
        application.rows[0]?.notifications.criteria.map((criterion) => criterion.id) ?? []
      );
      const undeclared = criteria.find((criterion) => !declared.has(criterion));
      if (undeclared) {
        await connection.query("ROLLBACK");
        return reply.code(400).send(apiError(
          "notification_criterion_not_declared",
          `The application manifest does not declare notification criterion ${undeclared}.`
        ));
      }
      const channel = await connection.query<{ id: string }>(
        `INSERT INTO push_channels
           (id, grant_id, installation_id, endpoint, endpoint_hash, p256dh, auth, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT(grant_id, installation_id) DO UPDATE SET
           endpoint = excluded.endpoint,
           endpoint_hash = excluded.endpoint_hash,
           p256dh = excluded.p256dh,
           auth = excluded.auth,
           expires_at = excluded.expires_at,
           disabled_at = NULL,
           updated_at = now()
         RETURNING id`,
        [
          randomUUID(),
          grant.grant_id,
          input.installation_id,
          input.subscription.endpoint,
          tokenHash(input.subscription.endpoint),
          input.subscription.keys.p256dh,
          input.subscription.keys.auth,
          input.subscription.expirationTime
            ? new Date(input.subscription.expirationTime).toISOString()
            : null
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
      return reply.code(201).send({ channel_id: channel.rows[0].id, criteria });
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
      notifications: ApplicationNotifications;
      channel_id: string | null;
    }>(
      `SELECT a.notifications, pc.id AS channel_id
       FROM grants g
       JOIN applications a ON a.id = g.application_id
       LEFT JOIN push_channels pc
         ON pc.grant_id = g.id AND pc.id = $2 AND pc.disabled_at IS NULL
       WHERE g.id = $1 AND g.revoked_at IS NULL`,
      [grant.grant_id, input.channel_id]
    );
    const row = application.rows[0];
    if (!row?.channel_id) {
      return reply.code(404).send(apiError("channel_not_found", "The push channel is not active for this grant."));
    }
    if (!row.notifications.criteria.some((criterion) => criterion.id === params.criterionId)) {
      return reply.code(400).send(apiError(
        "notification_criterion_not_declared",
        "The application manifest does not declare this notification criterion."
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
      notifications: ApplicationNotifications;
    }>(
      `SELECT a.notifications
       FROM grants g
       JOIN applications a ON a.id = g.application_id
       WHERE g.id = $1 AND g.hosted_collection_id IS NOT NULL
         AND g.revoked_at IS NULL`,
      [input.grant_id]
    );
    const authorized = authorization.rows[0]?.notifications.criteria.some(
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
      notifications: ApplicationNotifications;
    }>(
      `SELECT a.notifications
       FROM grants g
       JOIN collections c ON c.id = g.collection_id
       JOIN applications a ON a.id = g.application_id
       WHERE g.id = $1 AND c.connector_id = $2
         AND g.revoked_at IS NULL AND c.enabled = true`,
      [input.grant_id, connector.id]
    );
    const authorized = authorization.rows[0]?.notifications.criteria.some(
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

  app.post("/v1/collections/:collectionId/operations/:operation", async (request, reply) => {
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
         AND g.revoked_at IS NULL AND col.id = $2 AND col.enabled = true`,
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
            "This grant requires encrypted relay protocol 3."
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
          "This grant was not authorized for encrypted relay protocol 3."
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
  discovered: Awaited<ReturnType<typeof fetchManifest>>
): Promise<{
  id: string;
  name: string;
  homepage: string;
  icon: string | null;
  redirect_uris: string[];
  canonical_identity: string;
  requirements: ApplicationRequirements;
  provisions: ApplicationProvisions;
  notifications: ApplicationNotifications;
}> {
  const application = await db.query<{
    id: string;
    name: string;
    homepage: string;
    icon: string | null;
    redirect_uris: string[];
    canonical_identity: string;
    requirements: ApplicationRequirements;
    provisions: ApplicationProvisions;
    notifications: ApplicationNotifications;
  }>(
    `INSERT INTO applications
       (id, canonical_identity, manifest_url, manifest_version, name, homepage, icon,
        redirect_uris, requirements, provisions, notifications)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb)
     ON CONFLICT(canonical_identity) DO UPDATE SET
       manifest_url = excluded.manifest_url,
       manifest_version = excluded.manifest_version,
       name = excluded.name,
       homepage = excluded.homepage,
       icon = excluded.icon,
       redirect_uris = excluded.redirect_uris,
       requirements = excluded.requirements,
       provisions = excluded.provisions,
       notifications = excluded.notifications,
       updated_at = now()
     RETURNING id, name, homepage, icon, redirect_uris, canonical_identity, requirements,
               provisions, notifications`,
    [
      randomUUID(),
      discovered.canonicalIdentity,
      discovered.manifestUrl,
      discovered.manifest.manifest_version,
      discovered.manifest.name,
      discovered.manifest.homepage,
      discovered.manifest.icon ?? null,
      JSON.stringify(discovered.manifest.redirect_uris),
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
  }
): Promise<{ id: string; operations: string[]; scope: GrantScope }> {
  const operations = [...new Set(input.operations)];
  const existing = await db.query<{ id: string; encryption: GrantEncryption | null }>(
    `SELECT id, encryption FROM grants WHERE user_id = $1 AND application_id = $2
     AND collection_id = $3 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    [input.userId, input.applicationId, input.collectionId]
  );
  const grant = existing.rows[0]
    ? await db.query<{ id: string; operations: string[]; scope: GrantScope }>(
        `UPDATE grants SET operations = $2::jsonb, scope = $3::jsonb,
                           application_origin = $4
         WHERE id = $1 RETURNING id, operations, scope`,
        [
          existing.rows[0].id,
          JSON.stringify(operations),
          JSON.stringify(input.scope),
          input.applicationOrigin
        ]
      )
    : await db.query<{ id: string; operations: string[]; scope: GrantScope }>(
        `INSERT INTO grants
           (id, user_id, application_id, collection_id, operations, scope, application_origin)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
         RETURNING id, operations, scope`,
        [
          randomUUID(),
          input.userId,
          input.applicationId,
          input.collectionId,
          JSON.stringify(operations),
          JSON.stringify(input.scope),
          input.applicationOrigin
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
    notifications: ApplicationNotifications;
    created_at: string | Date;
  }>(
    `SELECT g.id, g.application_id, a.name AS application_name,
            a.homepage AS application_homepage,
            CASE WHEN g.application_origin = '' THEN a.homepage
                 ELSE g.application_origin END AS application_origin,
            a.icon AS application_icon,
            g.hosted_collection_id AS collection_id,
            hosted.display_name AS collection_name,
            g.operations, g.scope, a.notifications, g.created_at
     FROM grants g
     JOIN applications a ON a.id = g.application_id
     JOIN hosted_collections hosted ON hosted.id = g.hosted_collection_id
     WHERE g.id = $1 AND g.revoked_at IS NULL`,
    [grantId]
  );
  const row = result.rows[0];
  if (!row) return;
  if (row.notifications.criteria.length === 0) {
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
    notification_criteria: row.notifications.criteria,
    created_at: new Date(row.created_at).toISOString()
  };
  await provider.upsertNotificationGrant(row.collection_id, grant);
}

async function reconcileApplicationGrants(
  db: DatabasePool,
  relay: RelayHub,
  hostedProvider: HostedProviderClient | undefined,
  application: { id: string; requirements: ApplicationRequirements }
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
  }>(
    `SELECT g.id, g.user_id, col.connector_id, g.hosted_collection_id, g.hosted_replica_id,
            g.operations, col.contracts AS local_contracts, col.spec_version,
            hosted.contracts AS hosted_contracts, hosted.template,
            replica.allowed_types, g.scope
     FROM grants g
     LEFT JOIN collections col ON col.id = g.collection_id
     LEFT JOIN hosted_collections hosted ON hosted.id = g.hosted_collection_id
     LEFT JOIN hosted_replicas replica ON replica.id = g.hosted_replica_id
     WHERE g.application_id = $1 AND g.revoked_at IS NULL`,
    [application.id]
  );
  const changedConnectors = new Set<string>();
  for (const grant of grants.rows) {
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
        const write = grant.operations.some((operation) => ["create", "update", "delete", "rename", "create_type", "update_type", "create_view_source", "update_view_source", "delete_view_source"].includes(operation));
        await hostedProvider.updateApplicationReplica(grant.hosted_replica_id, {
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
  return scopeAccess(left) === scopeAccess(right)
    && isContractSubset(left.contracts, right.contracts)
    && isContractSubset(right.contracts, left.contracts);
}

function scopeAccess(scope: GrantScope): "contract" | "full_collection" {
  return scope.access ?? (scope.contracts.length === 0 ? "full_collection" : "contract");
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
  const authorization = await db.query<{
    application_id: string;
    application_homepage: string;
    requested_operations: string[];
    requirements: ApplicationRequirements;
    relay_protocol: number | null;
    application_public_key: string | null;
    redirect_uri: string;
  }>(
    `SELECT ar.application_id, a.homepage AS application_homepage,
            ar.requested_operations, a.requirements,
            ar.relay_protocol, ar.application_public_key, ar.redirect_uri
     FROM authorization_requests ar
     JOIN applications a ON a.id = ar.application_id
     WHERE ar.id = $1 AND ar.user_id = $2 AND ar.completed_at IS NULL AND ar.expires_at > now()`,
    [input.requestId, input.userId]
  );
  const pending = authorization.rows[0];
  if (!pending) return false;
  if (requiresHostedCollection(pending.requirements)) {
    throw new RequestValidationError("This application requires an mdbase cloud collection.");
  }
  if (input.operations.some((operation) => !pending.requested_operations.includes(operation))) {
    throw new RequestValidationError("Approved operations must be requested by the application.");
  }
  assertOperationsAllowedByRequirements(input.operations, pending.requirements);
  const collection = await db.query<{
    contracts: ContractRequirement[];
    local_id: string;
    relay_public_key: string | null;
    spec_version: string;
  }>(
    `SELECT col.contracts, col.local_id, col.spec_version, con.relay_public_key
     FROM collections col JOIN connectors con ON con.id = col.connector_id
     WHERE col.id = $1 AND col.connector_id = $2 AND col.enabled = true`,
    [input.collectionId, input.connectorId]
  );
  const scope = scopeForRequirements(pending.requirements);
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
  const grantId = randomUUID();
  let encryption: GrantEncryption | null = null;
  if (pending.relay_protocol === ENCRYPTED_RELAY_PROTOCOL_VERSION) {
    if (!pending.application_public_key || !collection.rows[0].relay_public_key) {
      throw new RequestValidationError(
        "Encrypted relay protocol 3 requires an up-to-date connector."
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
  await db.query(
    `INSERT INTO grants
       (id, user_id, application_id, collection_id, operations, scope, encryption,
        application_origin)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8)`,
    [
      grantId,
      input.userId,
      pending.application_id,
      input.collectionId,
      JSON.stringify(input.operations),
      JSON.stringify(scope),
      encryption ? JSON.stringify(encryption) : null,
      applicationOriginForRedirect(pending.redirect_uri, pending.application_homepage)
    ]
  );
  await db.query(
    "UPDATE authorization_requests SET completed_at = now(), grant_id = $2 WHERE id = $1",
    [input.requestId, grantId]
  );
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
      redirect_uri: string;
      requested_operations: string[];
      requirements: ApplicationRequirements;
      provisions: ApplicationProvisions;
    }>(
      `SELECT ar.application_id, a.name AS application_name, a.homepage AS application_homepage,
              ar.redirect_uri, ar.requested_operations,
              a.requirements, a.provisions
       FROM authorization_requests ar
       JOIN applications a ON a.id = ar.application_id
       WHERE ar.id = $1 AND ar.user_id = $2 AND ar.completed_at IS NULL
         AND ar.expires_at > now()
       FOR UPDATE`,
      [input.requestId, input.userId]
    );
    const pending = authorization.rows[0];
    if (!pending) {
      await connection.query("ROLLBACK");
      return false;
    }
    if (input.operations.some((operation) => !pending.requested_operations.includes(operation))) {
      throw new RequestValidationError("Approved operations must be requested by the application.");
    }
    assertOperationsAllowedByRequirements(input.operations, pending.requirements);
    const scope = scopeForRequirements(pending.requirements);
    const requiredContracts = requiredContractsForRequirements(pending.requirements);
    let availableDescriptors = input.contracts;
    let availableContracts = contractRequirements(availableDescriptors);
    if (!contractsSatisfy(availableContracts, requiredContracts)) {
      const provisions = requiredTypeProvisions(pending.requirements, pending.provisions, availableContracts);
      if (!provisions) {
        throw new RequestValidationError(
          "This hosted collection does not provide the contracts required by the application."
        );
      }
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
    const write = operations.some((operation) => ["create", "update", "delete", "rename", "create_type", "update_type", "create_view_source", "update_view_source", "delete_view_source"].includes(operation));
    const applicationUrl = new URL(pending.redirect_uri);
    const allowedOrigin = ["http:", "https:"].includes(applicationUrl.protocol)
      ? applicationUrl.origin
      : undefined;
    const applicationOrigin = applicationOriginForRedirect(
      pending.redirect_uri,
      pending.application_homepage
    );
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
      token: bootstrapToken,
      tokenTtlSeconds: 3_600
    });
    const grantId = randomUUID();
    notificationGrantId = grantId;
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
          operations, scope, encryption, application_origin)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, NULL, $8)`,
      [
        grantId,
        input.userId,
        pending.application_id,
        input.collectionId,
        replicaId,
        JSON.stringify(operations),
        JSON.stringify(scope),
        applicationOrigin
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
     WHERE id = $1 AND user_id = $2 AND completed_at IS NULL AND expires_at > now()
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
  db: DatabasePool,
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
  hosted?: {
    provider_url: string;
    replica_id: string;
    access_token: string;
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
    application_origin: string;
  }>(
    `SELECT COALESCE(g.collection_id, g.hosted_collection_id) AS collection_id,
            COALESCE(col.display_name, hosted.display_name) AS collection_name,
            g.hosted_collection_id, g.hosted_replica_id, hosted.provider_url,
            g.operations, g.scope, g.encryption,
            CASE WHEN g.application_origin = '' THEN app.homepage
                 ELSE g.application_origin END AS application_origin
     FROM grants g
     JOIN applications app ON app.id = g.application_id
     LEFT JOIN collections col ON col.id = g.collection_id
     LEFT JOIN hosted_collections hosted ON hosted.id = g.hosted_collection_id
     WHERE g.id = $1 AND g.revoked_at IS NULL`,
    [grantId]
  );
  if (!grant.rows[0]) throw new RequestValidationError("The application grant is no longer active.");
  const accessToken = randomToken("mdb");
  const refreshToken = randomToken("ref");
  let hosted: { provider_url: string; replica_id: string; access_token: string } | undefined;
  if (grant.rows[0].hosted_collection_id) {
    if (!hostedProvider || !grant.rows[0].hosted_replica_id || !grant.rows[0].provider_url) {
      throw new RequestValidationError("The hosted application capability is unavailable.");
    }
    const providerToken = randomToken("hsa");
    await hostedProvider.rotateReplicaToken(grant.rows[0].hosted_replica_id, providerToken, 3_600);
    hosted = {
      provider_url: grant.rows[0].provider_url,
      replica_id: grant.rows[0].hosted_replica_id,
      access_token: providerToken
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
    application_origin: new URL(grant.rows[0].application_origin).origin,
    ...(hosted ? { hosted } : {})
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
    "SELECT encryption FROM grants WHERE id = $1 AND revoked_at IS NULL",
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
  return provisions.types.filter((provision) => provision.provides.some((provided) =>
    missing.some((required) => required.id === provided.id && required.version === provided.version)
  ));
}

class RequestValidationError extends Error {}

async function sessionUser(request: FastifyRequest, db: DatabasePool): Promise<User | null> {
  const token = sessionToken(request);
  if (!token) return null;
  const user = await db.query<User>(
    `SELECT u.id,
            CASE WHEN i.provider IS NULL THEN u.email ELSE i.email END AS email,
            u.name, i.login, s.provider AS authentication_provider
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN external_identities i ON i.user_id = u.id AND i.provider = s.provider
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
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
  const user = await db.query<User>(
    `INSERT INTO users (id, email, name) VALUES ($1, $2, $3)
     ON CONFLICT(email) DO UPDATE SET name = excluded.name
     RETURNING id, email, name`,
    [randomUUID(), login, name]
  );
  return { ...user.rows[0], login: null, authentication_provider: "tailscale" };
}

async function authenticatedUser(
  request: FastifyRequest,
  db: DatabasePool,
  tailscaleAuth = false
): Promise<User | null> {
  return tailscaleAuth ? tailscaleUser(request, db) : sessionUser(request, db);
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
