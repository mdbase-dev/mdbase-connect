import { randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { DatabasePool } from "../database-types.js";
import { tokenHash } from "../security.js";
import { apiError } from "./http-errors.js";
import { sessionToken } from "./session-cookies.js";

export interface User {
  id: string;
  email: string | null;
  name: string;
  login: string | null;
  authentication_provider?: "github" | "google" | "password" | "session" | "tailscale";
}

export interface SessionContext {
  user: User;
  sessionId: string;
}

export interface ConnectorIdentity {
  id: string;
  user_id: string;
}

export function bearerToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  return authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
}

export async function sessionUser(
  request: FastifyRequest,
  db: DatabasePool
): Promise<User | null> {
  return (await sessionContext(request, db))?.user ?? null;
}

export async function sessionContext(
  request: FastifyRequest,
  db: DatabasePool
): Promise<SessionContext | null> {
  const token = sessionToken(request);
  if (!token) return null;
  const result = await db.query<User & {
    session_id: string;
    last_seen_at: Date | string;
  }>(
    `SELECT u.id, s.id AS session_id, s.last_seen_at,
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
  const row = result.rows[0];
  if (!row) return null;
  if (Date.now() - new Date(row.last_seen_at).getTime() >= 5 * 60 * 1_000) {
    await db.query(
      `UPDATE sessions SET last_seen_at = now()
       WHERE id = $1
         AND revoked_at IS NULL
         AND expires_at > now()
         AND last_seen_at < now() - interval '5 minutes'`,
      [row.session_id]
    );
  }
  const {
    session_id: sessionId,
    last_seen_at: _lastSeenAt,
    ...user
  } = row;
  return { user, sessionId };
}

export async function tailscaleUser(
  request: FastifyRequest,
  db: DatabasePool
): Promise<User | null> {
  const loginHeader = request.headers["tailscale-user-login"];
  const nameHeader = request.headers["tailscale-user-name"];
  const login = (
    Array.isArray(loginHeader) ? loginHeader[0] : loginHeader
  )?.trim().toLowerCase();
  if (!login || login.length > 320) return null;
  const suppliedName = (
    Array.isArray(nameHeader) ? nameHeader[0] : nameHeader
  )?.trim();
  const fallbackName = login.split("@")[0] || login;
  const name = suppliedName && suppliedName.length <= 100
    ? suppliedName
    : fallbackName.slice(0, 100);
  const user = await db.query<User & { suspended_at: string | null }>(
    `INSERT INTO users (id, email, name) VALUES ($1, $2, $3)
     ON CONFLICT(email) DO UPDATE SET name = excluded.name
     RETURNING id, email, name, suspended_at`,
    [randomUUID(), login, name]
  );
  if (!user.rows[0] || user.rows[0].suspended_at) return null;
  const { suspended_at: _suspendedAt, ...activeUser } = user.rows[0];
  return {
    ...activeUser,
    login: null,
    authentication_provider: "tailscale"
  };
}

export async function authenticatedUser(
  request: FastifyRequest,
  db: DatabasePool,
  tailscaleAuth = false
): Promise<User | null> {
  return tailscaleAuth ? tailscaleUser(request, db) : sessionUser(request, db);
}

export async function requireUser(
  request: FastifyRequest,
  reply: FastifyReply,
  db: DatabasePool,
  tailscaleAuth = false
): Promise<User | null> {
  const user = await authenticatedUser(request, db, tailscaleAuth);
  if (!user) {
    reply.code(401).send(apiError("not_authenticated", "Sign in to continue."));
  }
  return user;
}

export async function requireSessionContext(
  request: FastifyRequest,
  reply: FastifyReply,
  db: DatabasePool
): Promise<SessionContext | null> {
  const authenticated = await sessionContext(request, db);
  if (!authenticated) {
    reply.code(401).send(apiError("not_authenticated", "Sign in to continue."));
  }
  return authenticated;
}

export async function connectorFromRequest(
  request: FastifyRequest,
  db: DatabasePool
): Promise<ConnectorIdentity | null> {
  const token = bearerToken(request);
  if (!token) return null;
  const connector = await db.query<ConnectorIdentity>(
    `SELECT c.id, c.user_id
     FROM connectors c
     JOIN users u ON u.id = c.user_id
     WHERE c.token_hash = $1 AND c.revoked_at IS NULL
       AND u.suspended_at IS NULL`,
    [tokenHash(token)]
  );
  return connector.rows[0] ?? null;
}

export async function requireConnector(
  request: FastifyRequest,
  reply: FastifyReply,
  db: DatabasePool
): Promise<ConnectorIdentity | null> {
  const connector = await connectorFromRequest(request, db);
  if (!connector) {
    reply.code(401).send(apiError(
      "invalid_connector",
      "Connector credential is invalid."
    ));
  }
  return connector;
}
