import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sessionClientName } from "../../account-sessions.js";
import type { AuthenticationPolicyStore } from "../../authentication-policy.js";
import type { DatabasePool } from "../../database-types.js";
import { createExternalSession } from "../../external-auth.js";
import {
  exchangeGitHubCode,
  GitHubIdentityError,
  type GitHubAuthConfig
} from "../../github-auth.js";
import {
  GoogleIdentityError,
  verifyGoogleCredential,
  type GoogleAuthConfig
} from "../../google-auth.js";
import type { RegistrationMode } from "../../runtime-config.js";
import {
  pkceChallenge,
  randomToken,
  safeEqual,
  tokenHash
} from "../../security.js";
import { apiError } from "../../platform/http-errors.js";
import {
  oauthStateCookieName,
  setSessionCookie
} from "../../platform/session-cookies.js";

interface ExternalAuthRoutesOptions {
  db: DatabasePool;
  publicUrl: string;
  authenticationPolicy: AuthenticationPolicyStore;
  githubAuth?: GitHubAuthConfig;
  googleAuth?: GoogleAuthConfig;
}

export function registerExternalAuthRoutes(
  app: FastifyInstance,
  options: ExternalAuthRoutesOptions
): void {
  app.get("/auth/github", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    if (!options.githubAuth) {
      return reply.code(404).send(apiError("not_found", "Not found."));
    }
    const query = z.object({
      return_to: z.string().max(2_048).optional()
    }).parse(request.query);
    const state = randomToken("oauth");
    const codeVerifier = randomToken("pkce");
    const authenticationSettings = await options.authenticationPolicy.current();
    await options.db.query(
      "DELETE FROM oauth_login_states WHERE expires_at <= now() OR consumed_at IS NOT NULL"
    );
    await options.db.query(
      `INSERT INTO oauth_login_states
         (id, provider, state_hash, return_to, code_verifier, expires_at)
       VALUES ($1, 'github', $2, $3, $4, now() + interval '10 minutes')`,
      [
        randomUUID(),
        tokenHash(state),
        safeReturnTarget(query.return_to, options.publicUrl),
        codeVerifier
      ]
    );
    reply.setCookie(oauthStateCookieName(options.publicUrl, "github"), state, {
      httpOnly: true,
      sameSite: "lax",
      secure: options.publicUrl.startsWith("https:"),
      path: "/",
      maxAge: 10 * 60
    });
    const authorize = new URL("https://github.com/login/oauth/authorize");
    authorize.searchParams.set("client_id", options.githubAuth.clientId);
    authorize.searchParams.set(
      "redirect_uri",
      `${options.publicUrl}/auth/github/callback`
    );
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
    if (!options.githubAuth) {
      return reply.code(404).send(apiError("not_found", "Not found."));
    }
    const query = z.object({
      code: z.string().min(1).max(500).optional(),
      state: z.string().min(1).max(200).optional(),
      error: z.string().max(200).optional()
    }).parse(request.query);
    const cookieName = oauthStateCookieName(options.publicUrl, "github");
    const cookieState = request.cookies[cookieName];
    reply.clearCookie(cookieName, {
      path: "/",
      secure: options.publicUrl.startsWith("https:")
    });
    if (
      query.error
      || !query.code
      || !query.state
      || !cookieState
      || !safeEqual(query.state, cookieState)
    ) {
      return reply.code(400).send(apiError(
        "invalid_login",
        "The GitHub sign-in request is invalid or expired."
      ));
    }
    const state = await options.db.query<{
      code_verifier: string;
      return_to: string;
    }>(
      `UPDATE oauth_login_states SET consumed_at = now()
       WHERE provider = 'github' AND state_hash = $1
         AND consumed_at IS NULL AND expires_at > now()
       RETURNING code_verifier, return_to`,
      [tokenHash(query.state)]
    );
    if (!state.rows[0]) {
      return reply.code(400).send(apiError(
        "invalid_login",
        "The GitHub sign-in request is invalid or expired."
      ));
    }
    const identity = await exchangeGitHubCode(options.githubAuth, {
      code: query.code,
      codeVerifier: state.rows[0].code_verifier,
      redirectUri: `${options.publicUrl}/auth/github/callback`
    });
    if (
      !/^[1-9][0-9]*$/.test(identity.id)
      || !identity.login
      || identity.login.length > 100
    ) {
      throw new GitHubIdentityError("GitHub returned an invalid user identity.");
    }
    const authenticationSettings = await options.authenticationPolicy.current();
    if (!identityAllowed(
      authenticationSettings.registrationMode,
      options.githubAuth.allowedUserIds,
      identity.id
    )) {
      request.log.warn(
        { github_user_id: identity.id },
        "GitHub user is not on the login allowlist"
      );
      return reply.code(403).send(apiError(
        "account_not_allowed",
        "This account does not have access."
      ));
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
    }, {
      clientName: sessionClientName(request.headers["user-agent"])
    });
    setSessionCookie(reply, session.token, options.publicUrl);
    return reply.redirect(state.rows[0].return_to);
  });

  app.get("/auth/google", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    if (!options.googleAuth) {
      return reply.code(404).send(apiError("not_found", "Not found."));
    }
    const query = z.object({
      return_to: z.string().max(2_048).optional()
    }).parse(request.query);
    const state = randomToken("oauth");
    const nonce = randomToken("nonce");
    await options.db.query(
      "DELETE FROM oauth_login_states WHERE expires_at <= now() OR consumed_at IS NOT NULL"
    );
    await options.db.query(
      `INSERT INTO oauth_login_states
         (id, provider, state_hash, return_to, code_verifier, expires_at)
       VALUES ($1, 'google', $2, $3, $4, now() + interval '10 minutes')`,
      [
        randomUUID(),
        tokenHash(state),
        safeReturnTarget(query.return_to, options.publicUrl),
        nonce
      ]
    );
    reply.setCookie(oauthStateCookieName(options.publicUrl, "google"), state, {
      httpOnly: true,
      sameSite: "lax",
      secure: options.publicUrl.startsWith("https:"),
      path: "/",
      maxAge: 10 * 60
    });
    reply.header("cache-control", "no-store");
    return {
      client_id: options.googleAuth.clientId,
      nonce
    };
  });

  app.post("/auth/google/callback", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    if (!options.googleAuth) {
      return reply.code(404).send(apiError("not_found", "Not found."));
    }
    if (
      request.headers.origin !== new URL(options.publicUrl).origin
      || request.headers["x-mdbase-auth"] !== "google"
    ) {
      return reply.code(403).send(apiError(
        "origin_denied",
        "The sign-in response origin is not allowed."
      ));
    }
    const input = z.object({
      credential: z.string().min(100).max(20_000)
    }).strict().parse(request.body);
    const cookieName = oauthStateCookieName(options.publicUrl, "google");
    const cookieState = request.cookies[cookieName];
    reply.clearCookie(cookieName, {
      path: "/",
      secure: options.publicUrl.startsWith("https:")
    });
    if (!cookieState) {
      return reply.code(400).send(apiError(
        "invalid_login",
        "The Google sign-in request is invalid or expired."
      ));
    }
    const state = await options.db.query<{
      code_verifier: string;
      return_to: string;
    }>(
      `UPDATE oauth_login_states SET consumed_at = now()
       WHERE provider = 'google' AND state_hash = $1
         AND consumed_at IS NULL AND expires_at > now()
       RETURNING code_verifier, return_to`,
      [tokenHash(cookieState)]
    );
    if (!state.rows[0]) {
      return reply.code(400).send(apiError(
        "invalid_login",
        "The Google sign-in request is invalid or expired."
      ));
    }
    const identity = await verifyGoogleCredential(options.googleAuth, {
      credential: input.credential,
      nonce: state.rows[0].code_verifier
    });
    if (!/^[A-Za-z0-9_-]{1,255}$/.test(identity.id)) {
      throw new GoogleIdentityError("Google returned an invalid account subject.");
    }
    const authenticationSettings = await options.authenticationPolicy.current();
    if (!identityAllowed(
      authenticationSettings.registrationMode,
      options.googleAuth.allowedSubjects,
      identity.id
    )) {
      request.log.warn(
        { google_subject: identity.id },
        "Google user is not on the login allowlist"
      );
      return reply.code(403).send(apiError(
        "account_not_allowed",
        "This account does not have access."
      ));
    }
    const name = identity.name.trim().slice(0, 100);
    if (!name) {
      throw new GoogleIdentityError("Google returned an invalid account name.");
    }
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
    }, {
      clientName: sessionClientName(request.headers["user-agent"])
    });
    setSessionCookie(reply, session.token, options.publicUrl);
    return { redirect_to: state.rows[0].return_to };
  });
}

function identityAllowed(
  registration: RegistrationMode,
  allowedSubjects: ReadonlySet<string>,
  subject: string
): boolean {
  return registration === "open" || allowedSubjects.has(subject);
}

function safeReturnTarget(
  requested: string | undefined,
  publicUrl: string
): string {
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
