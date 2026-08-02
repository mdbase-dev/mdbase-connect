import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  AccountSessionService,
  sessionClientName
} from "../../account-sessions.js";
import type { DatabasePool } from "../../database-types.js";
import { ensureDevelopmentEntitlement } from "../../entitlements.js";
import { randomToken, tokenHash } from "../../security.js";
import { apiError } from "../../platform/http-errors.js";
import {
  requireSessionContext,
  type User
} from "../../platform/request-authentication.js";
import { requireSameOrigin } from "../../platform/request-security.js";
import {
  clearSessionCookies,
  sessionToken,
  setSessionCookie
} from "../../platform/session-cookies.js";

interface AccountSessionRoutesOptions {
  db: DatabasePool;
  publicUrl: string;
  managementOrigins?: string[];
  developmentAuth?: boolean;
}

export function registerAccountSessionRoutes(
  app: FastifyInstance,
  options: AccountSessionRoutesOptions
): void {
  const accountSessions = new AccountSessionService(options.db);

  app.post("/v1/dev/session", async (request, reply) => {
    if (!options.developmentAuth) {
      return reply.code(404).send(apiError("not_found", "Not found."));
    }
    const input = z.object({
      email: z.email(),
      name: z.string().trim().min(1).max(100)
    }).parse(request.body);
    const user = await options.db.query<User>(
      `INSERT INTO users (id, email, name) VALUES ($1, $2, $3)
       ON CONFLICT(email) DO UPDATE SET name = excluded.name
       RETURNING id, email, name`,
      [randomUUID(), input.email.toLowerCase(), input.name]
    );
    const token = randomToken("ses");
    await ensureDevelopmentEntitlement(options.db, user.rows[0].id);
    await options.db.query(
      `INSERT INTO sessions
         (id, user_id, token_hash, account_session_epoch,
          expires_at, client_name)
       SELECT $1, id, $3, session_epoch,
              now() + interval '30 days', $4
       FROM users WHERE id = $2 AND suspended_at IS NULL`,
      [
        randomUUID(),
        user.rows[0].id,
        tokenHash(token),
        sessionClientName(request.headers["user-agent"])
      ]
    );
    setSessionCookie(reply, token, options.publicUrl);
    return { user: user.rows[0] };
  });

  app.post("/v1/logout", async (request, reply) => {
    const token = sessionToken(request);
    if (token) {
      await options.db.query(
        "DELETE FROM sessions WHERE token_hash = $1",
        [tokenHash(token)]
      );
    }
    clearSessionCookies(reply);
    return { ok: true };
  });

  app.get("/v1/account/sessions", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const authenticated = await requireSessionContext(
      request,
      reply,
      options.db
    );
    if (!authenticated) return;
    const sessions = await accountSessions.list(
      authenticated.user.id,
      authenticated.sessionId
    );
    return {
      sessions: sessions.map((session) => ({
        id: session.id,
        provider: session.provider,
        client_name: session.clientName,
        created_at: session.createdAt.toISOString(),
        last_seen_at: session.lastSeenAt.toISOString(),
        expires_at: session.expiresAt.toISOString(),
        current: session.current
      }))
    };
  });

  app.delete("/v1/account/sessions/:sessionId", async (request, reply) => {
    requireSameOrigin(request, options.publicUrl, options.managementOrigins);
    const authenticated = await requireSessionContext(
      request,
      reply,
      options.db
    );
    if (!authenticated) return;
    const params = z.object({ sessionId: z.uuid() }).parse(request.params);
    const revoked = await accountSessions.revoke(
      authenticated.user.id,
      params.sessionId
    );
    if (!revoked) {
      return reply.code(404).send(apiError(
        "session_not_found",
        "That browser session is no longer active."
      ));
    }
    const currentSessionRevoked =
      params.sessionId === authenticated.sessionId;
    if (currentSessionRevoked) {
      clearSessionCookies(reply);
    }
    return {
      ok: true,
      current_session_revoked: currentSessionRevoked
    };
  });

  app.post("/v1/account/sessions/revoke-others", async (request, reply) => {
    requireSameOrigin(request, options.publicUrl, options.managementOrigins);
    const authenticated = await requireSessionContext(
      request,
      reply,
      options.db
    );
    if (!authenticated) return;
    const revokedCount = await accountSessions.revokeOthers(
      authenticated.user.id,
      authenticated.sessionId
    );
    return { ok: true, revoked_count: revokedCount };
  });
}
