import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DatabasePool } from "./db.js";
import { ConnectGateway } from "./connect.js";
import type { GrantKeyStore } from "@mdbase-dev/connect";
import { pkceChallenge, randomToken, safeEqual, tokenHash } from "./security.js";

export const MCP_SCOPES = ["mdbase:read", "mdbase:write"] as const;
export type McpScope = typeof MCP_SCOPES[number];

export const READ_OPERATIONS = ["describe", "changes", "read", "query", "list_views", "execute_view", "read_view_source", "validate", "read_type"] as const;
export const WRITE_OPERATIONS = ["create", "update", "delete", "rename", "create_view_source", "update_view_source", "delete_view_source", "create_type", "update_type", "apply_type_pack"] as const;

interface ClientRow {
  id: string;
  client_name: string;
  redirect_uris: string[];
}

interface UpstreamAuthorizationRow {
  id: string;
  kind: "initial" | "additional";
  authorization_request_id: string | null;
  connection_set_id: string;
  scopes: McpScope[];
  code_verifier: string;
  key_handle: string;
  expires_at: Date | string;
  completed_at: Date | string | null;
}

interface AuthorizationRequestRow {
  id: string;
  client_id: string;
  connection_set_id: string;
  redirect_uri: string;
  state: string | null;
  code_challenge: string;
  resource: string;
  scopes: McpScope[];
  expires_at: Date | string;
  completed_at: Date | string | null;
  denied_at: Date | string | null;
}

export interface McpAuthContext {
  clientId: string;
  connectionSetId: string;
  scopes: McpScope[];
}

export class OAuthService {
  constructor(
    private readonly db: DatabasePool,
    private readonly gateway: ConnectGateway,
    private readonly keyStore: GrantKeyStore,
    private readonly publicUrl: string,
    readonly resource: string
  ) {}

  async registerClient(input: unknown): Promise<Record<string, unknown>> {
    const body = z.object({
      client_name: z.string().trim().min(1).max(200).default("MCP client"),
      redirect_uris: z.array(z.url()).min(1).max(20),
      token_endpoint_auth_method: z.literal("none").optional(),
      grant_types: z.array(z.string()).optional(),
      response_types: z.array(z.string()).optional()
    }).passthrough().parse(input);
    const redirectUris = [...new Set(body.redirect_uris.map(validRedirectUri))];
    if (body.grant_types && !body.grant_types.includes("authorization_code")) {
      throw new OAuthError("invalid_client_metadata", "Only the authorization_code grant is supported.");
    }
    if (body.response_types && !body.response_types.includes("code")) {
      throw new OAuthError("invalid_client_metadata", "Only the code response type is supported.");
    }
    const clientId = randomToken("client");
    await this.db.query(
      `INSERT INTO mcp_clients (id, client_name, redirect_uris) VALUES ($1, $2, $3::jsonb)`,
      [clientId, body.client_name, JSON.stringify(redirectUris)]
    );
    return {
      client_id: clientId,
      client_name: body.client_name,
      redirect_uris: redirectUris,
      client_id_issued_at: Math.floor(Date.now() / 1_000),
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none"
    };
  }

  async beginAuthorization(input: unknown): Promise<string> {
    const query = z.object({
      response_type: z.literal("code"),
      client_id: z.string().min(1),
      redirect_uri: z.url(),
      code_challenge: z.string().min(43).max(128),
      code_challenge_method: z.literal("S256"),
      state: z.string().max(1_000).optional(),
      scope: z.string().max(500).optional(),
      resource: z.url().optional()
    }).parse(input);
    const client = await this.client(query.client_id);
    if (!client.redirect_uris.includes(query.redirect_uri)) {
      throw new OAuthError("invalid_request", "The redirect_uri is not registered for this client.");
    }
    const resource = canonicalResource(query.resource ?? this.resource, this.resource);
    const scopes = parseScopes(query.scope);
    const setId = randomUUID();
    const requestId = randomUUID();
    await this.db.query("INSERT INTO mcp_connection_sets (id) VALUES ($1)", [setId]);
    await this.db.query(
      `INSERT INTO mcp_authorization_requests
         (id, client_id, connection_set_id, redirect_uri, state, code_challenge,
          resource, scopes, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      [
        requestId,
        client.id,
        setId,
        query.redirect_uri,
        query.state ?? null,
        query.code_challenge,
        resource,
        JSON.stringify(scopes),
        new Date(Date.now() + 10 * 60_000)
      ]
    );
    return this.beginUpstream("initial", setId, scopes, requestId, null);
  }

  async completeUpstream(input: { state?: string; code?: string; error?: string }): Promise<{
    kind: "initial" | "additional";
    redirect?: string;
    connectionName?: string;
    error?: string;
  }> {
    if (!input.state) throw new OAuthError("invalid_request", "The Connect callback is missing state.");
    const result = await this.db.query<UpstreamAuthorizationRow>(
      `SELECT id, kind, authorization_request_id, connection_set_id, scopes,
              code_verifier, key_handle, expires_at, completed_at
       FROM mcp_upstream_authorizations
       WHERE state_hash = $1`,
      [tokenHash(input.state)]
    );
    const pending = result.rows[0];
    if (!pending || pending.completed_at || new Date(pending.expires_at).getTime() <= Date.now()) {
      throw new OAuthError("invalid_request", "This Connect authorization has expired or was already used.");
    }
    if (input.error || !input.code) {
      await this.keyStore.delete(pending.key_handle);
      await this.db.query("UPDATE mcp_upstream_authorizations SET completed_at = now() WHERE id = $1", [pending.id]);
      if (pending.kind === "initial" && pending.authorization_request_id) {
        const authorization = await this.authorizationRequest(pending.authorization_request_id);
        await this.db.query("UPDATE mcp_authorization_requests SET denied_at = now() WHERE id = $1", [authorization.id]);
        return {
          kind: "initial",
          redirect: oauthRedirect(authorization.redirect_uri, {
            error: "access_denied",
            error_description: "Collection access was not approved.",
            state: authorization.state ?? undefined
          })
        };
      }
      return { kind: "additional", error: "Collection access was not approved." };
    }
    const application = await this.gateway.registerApplication();
    const connection = await this.gateway.exchangeAuthorization({
      code: input.code,
      verifier: pending.code_verifier,
      applicationId: application.id,
      connectionSetId: pending.connection_set_id,
      keyHandle: pending.key_handle
    });
    await this.db.query("UPDATE mcp_upstream_authorizations SET completed_at = now() WHERE id = $1", [pending.id]);
    if (pending.kind === "additional") {
      return { kind: "additional", connectionName: connection.display_name };
    }
    if (!pending.authorization_request_id) throw new OAuthError("server_error", "The OAuth request is incomplete.");
    const authorization = await this.authorizationRequest(pending.authorization_request_id);
    const code = randomToken("code");
    await this.db.query(
      `INSERT INTO mcp_authorization_codes
         (id, code_hash, client_id, connection_set_id, redirect_uri, code_challenge,
          resource, scopes, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      [
        randomUUID(),
        tokenHash(code),
        authorization.client_id,
        authorization.connection_set_id,
        authorization.redirect_uri,
        authorization.code_challenge,
        authorization.resource,
        JSON.stringify(authorization.scopes),
        new Date(Date.now() + 2 * 60_000)
      ]
    );
    await this.db.query("UPDATE mcp_authorization_requests SET completed_at = now() WHERE id = $1", [authorization.id]);
    return {
      kind: "initial",
      redirect: oauthRedirect(authorization.redirect_uri, {
        code,
        state: authorization.state ?? undefined,
        iss: this.publicUrl
      })
    };
  }

  async exchangeToken(input: unknown): Promise<Record<string, unknown>> {
    const body = z.discriminatedUnion("grant_type", [
      z.object({
        grant_type: z.literal("authorization_code"),
        code: z.string().min(1),
        client_id: z.string().min(1),
        redirect_uri: z.url(),
        code_verifier: z.string().min(43).max(128),
        resource: z.url().optional()
      }),
      z.object({
        grant_type: z.literal("refresh_token"),
        refresh_token: z.string().min(1),
        client_id: z.string().min(1),
        resource: z.url().optional()
      })
    ]).parse(input);
    if (body.grant_type === "authorization_code") {
      const result = await this.db.query<{
        id: string;
        client_id: string;
        connection_set_id: string;
        redirect_uri: string;
        code_challenge: string;
        resource: string;
        scopes: McpScope[];
      }>(
        `SELECT id, client_id, connection_set_id, redirect_uri, code_challenge, resource, scopes
         FROM mcp_authorization_codes
         WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()`,
        [tokenHash(body.code)]
      );
      const code = result.rows[0];
      if (!code
          || code.client_id !== body.client_id
          || code.redirect_uri !== body.redirect_uri
          || !safeEqual(code.code_challenge, pkceChallenge(body.code_verifier))
          || canonicalResource(body.resource ?? code.resource, this.resource) !== code.resource) {
        throw new OAuthError("invalid_grant", "The authorization code is invalid or expired.");
      }
      const used = await this.db.query(
        "UPDATE mcp_authorization_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id",
        [code.id]
      );
      if (!used.rows[0]) throw new OAuthError("invalid_grant", "The authorization code was already used.");
      return this.issueTokens(code);
    }
    const result = await this.db.query<{
      id: string;
      client_id: string;
      connection_set_id: string;
      resource: string;
      scopes: McpScope[];
    }>(
      `SELECT id, client_id, connection_set_id, resource, scopes
       FROM mcp_refresh_tokens
       WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()`,
      [tokenHash(body.refresh_token)]
    );
    const refresh = result.rows[0];
    if (!refresh
        || refresh.client_id !== body.client_id
        || canonicalResource(body.resource ?? refresh.resource, this.resource) !== refresh.resource) {
      throw new OAuthError("invalid_grant", "The refresh token is invalid or expired.");
    }
    const used = await this.db.query(
      "UPDATE mcp_refresh_tokens SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id",
      [refresh.id]
    );
    if (!used.rows[0]) throw new OAuthError("invalid_grant", "The refresh token was already used.");
    return this.issueTokens(refresh);
  }

  async authenticate(bearer: string): Promise<McpAuthContext | null> {
    const result = await this.db.query<{
      client_id: string;
      connection_set_id: string;
      resource: string;
      scopes: McpScope[];
    }>(
      `SELECT client_id, connection_set_id, resource, scopes FROM mcp_access_tokens
       WHERE token_hash = $1 AND expires_at > now() AND revoked_at IS NULL`,
      [tokenHash(bearer)]
    );
    const token = result.rows[0];
    if (!token || token.resource !== this.resource) return null;
    return {
      clientId: token.client_id,
      connectionSetId: token.connection_set_id,
      scopes: token.scopes
    };
  }

  async createConnectionTicket(
    context: McpAuthContext,
    connectionId?: string
  ): Promise<string> {
    let collectionId: string | null = null;
    if (connectionId) {
      const selected = await this.db.query<{ collection_id: string }>(
        `SELECT collection_id FROM mcp_connections
         WHERE id = $1 AND connection_set_id = $2`,
        [connectionId, context.connectionSetId]
      );
      if (!selected.rows[0]) {
        throw new OAuthError("invalid_request", "That collection connection is unavailable.");
      }
      collectionId = selected.rows[0].collection_id;
    }
    const token = randomToken("add");
    await this.db.query(
      `INSERT INTO mcp_connection_tickets
         (id, token_hash, connection_set_id, scopes, collection_id, expires_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
      [
        randomUUID(),
        tokenHash(token),
        context.connectionSetId,
        JSON.stringify(context.scopes),
        collectionId,
        new Date(Date.now() + 10 * 60_000)
      ]
    );
    return `${this.publicUrl}/connections/new?ticket=${encodeURIComponent(token)}`;
  }

  async consumeConnectionTicket(token: string): Promise<string> {
    const result = await this.db.query<{
      id: string;
      connection_set_id: string;
      scopes: McpScope[];
      collection_id: string | null;
    }>(
      `UPDATE mcp_connection_tickets SET used_at = now()
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
       RETURNING id, connection_set_id, scopes, collection_id`,
      [tokenHash(token)]
    );
    const ticket = result.rows[0];
    if (!ticket) throw new OAuthError("invalid_request", "This add-collection link is invalid or expired.");
    return this.beginUpstream(
      "additional",
      ticket.connection_set_id,
      ticket.scopes,
      null,
      ticket.collection_id
    );
  }

  private async beginUpstream(
    kind: "initial" | "additional",
    connectionSetId: string,
    scopes: McpScope[],
    authorizationRequestId: string | null,
    collectionId: string | null
  ): Promise<string> {
    const application = await this.gateway.registerApplication();
    const state = randomToken("state");
    const verifier = randomToken("pkce");
    const keyHandle = `mcp:${randomUUID()}`;
    const key = await this.keyStore.create(keyHandle);
    await this.db.query(
      `INSERT INTO mcp_upstream_authorizations
         (id, state_hash, kind, authorization_request_id, connection_set_id,
          scopes, code_verifier, key_handle, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`,
      [
        randomUUID(),
        tokenHash(state),
        kind,
        authorizationRequestId,
        connectionSetId,
        JSON.stringify(scopes),
        verifier,
        keyHandle,
        new Date(Date.now() + 10 * 60_000)
      ]
    );
    const authorize = new URL(`${this.gateway.connectUrl}/oauth/authorize`);
    authorize.searchParams.set("client_id", application.id);
    authorize.searchParams.set("redirect_uri", this.gateway.callbackUrl);
    authorize.searchParams.set("code_challenge", pkceChallenge(verifier));
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("operations", operationsForScopes(scopes).join(","));
    if (collectionId) authorize.searchParams.set("collection_id", collectionId);
    authorize.searchParams.set("relay_protocol", "1");
    authorize.searchParams.set(
      "application_agreement_public_key",
      key.agreementPublicKey
    );
    authorize.searchParams.set(
      "application_signing_public_key",
      key.signingPublicKey
    );
    return authorize.href;
  }

  private async issueTokens(input: {
    client_id: string;
    connection_set_id: string;
    resource: string;
    scopes: McpScope[];
  }): Promise<Record<string, unknown>> {
    const accessToken = randomToken("mcp");
    const refreshToken = randomToken("mrf");
    await this.db.query(
      `INSERT INTO mcp_access_tokens
         (id, token_hash, client_id, connection_set_id, resource, scopes, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        randomUUID(),
        tokenHash(accessToken),
        input.client_id,
        input.connection_set_id,
        input.resource,
        JSON.stringify(input.scopes),
        new Date(Date.now() + 60 * 60_000)
      ]
    );
    await this.db.query(
      `INSERT INTO mcp_refresh_tokens
         (id, token_hash, client_id, connection_set_id, resource, scopes, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        randomUUID(),
        tokenHash(refreshToken),
        input.client_id,
        input.connection_set_id,
        input.resource,
        JSON.stringify(input.scopes),
        new Date(Date.now() + 30 * 24 * 60 * 60_000)
      ]
    );
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: "Bearer",
      expires_in: 3_600,
      scope: input.scopes.join(" ")
    };
  }

  private async client(clientId: string): Promise<ClientRow> {
    const result = await this.db.query<ClientRow>(
      "SELECT id, client_name, redirect_uris FROM mcp_clients WHERE id = $1",
      [clientId]
    );
    if (!result.rows[0]) throw new OAuthError("invalid_request", "The OAuth client is not registered.");
    return result.rows[0];
  }

  private async authorizationRequest(id: string): Promise<AuthorizationRequestRow> {
    const result = await this.db.query<AuthorizationRequestRow>(
      `SELECT id, client_id, connection_set_id, redirect_uri, state, code_challenge,
              resource, scopes, expires_at, completed_at, denied_at
       FROM mcp_authorization_requests WHERE id = $1`,
      [id]
    );
    const request = result.rows[0];
    if (!request || request.completed_at || request.denied_at || new Date(request.expires_at).getTime() <= Date.now()) {
      throw new OAuthError("invalid_request", "The OAuth authorization request is no longer active.");
    }
    return request;
  }
}

export class OAuthError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

function operationsForScopes(scopes: McpScope[]): string[] {
  return scopes.includes("mdbase:write")
    ? [...READ_OPERATIONS, ...WRITE_OPERATIONS]
    : [...READ_OPERATIONS];
}

function parseScopes(value: string | undefined): McpScope[] {
  const requested = value?.trim() ? [...new Set(value.trim().split(/\s+/))] : [...MCP_SCOPES];
  if (requested.length === 0 || requested.some((scope) => !MCP_SCOPES.includes(scope as McpScope))) {
    throw new OAuthError("invalid_scope", "Supported scopes are mdbase:read and mdbase:write.");
  }
  return requested as McpScope[];
}

function canonicalResource(value: string, expected: string): string {
  const resource = new URL(value);
  if (resource.username || resource.password || resource.search || resource.hash || resource.href !== expected) {
    throw new OAuthError("invalid_target", "The OAuth resource does not identify this MCP server.");
  }
  return resource.href;
}

function validRedirectUri(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.hash) throw new OAuthError("invalid_redirect_uri", "Redirect URIs cannot contain credentials or fragments.");
  if (url.protocol === "https:") return value;
  if (url.protocol === "http:" && isLoopback(url.hostname)) return value;
  throw new OAuthError("invalid_redirect_uri", "Redirect URIs must use HTTPS or loopback HTTP.");
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function oauthRedirect(base: string, values: Record<string, string | undefined>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(values)) if (value !== undefined) url.searchParams.set(key, value);
  return url.href;
}
