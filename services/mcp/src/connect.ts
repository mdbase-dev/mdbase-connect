import { randomBytes, randomUUID } from "node:crypto";
import {
  applicationInstallationId,
  decryptRelayResponse,
  encryptRelayRequest,
  signApplicationAuthorization,
  type GrantKeyRecord,
  type GrantKeyStore
} from "@mdbase-dev/connect/crypto";
import {
  APPLICATION_AUTHORIZATION_PROTOCOL_VERSION,
  authorizationContractRequirements,
  type CollectionOperation,
  type EncryptedRelayOperationResponse,
  type GrantEncryption,
  type GrantScope,
  type MdbaseAppManifest
} from "@mdbase-dev/connect-protocol";
import { z } from "zod";
import type { DatabasePool } from "./db.js";
import { SecretBox } from "./security.js";

const grantEncryptionSchema = z.object({
  protocol_version: z.literal(1),
  suite: z.literal("P256-HKDF-SHA256-AES256GCM"),
  key_id: z.string().min(1),
  scope_epoch: z.number().int().positive(),
  connector_id: z.uuid(),
  collection_id: z.uuid(),
  application_agreement_public_key: z.string().min(80),
  connector_agreement_public_key: z.string().min(80)
}).strict();

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  token_type: z.literal("Bearer"),
  expires_in: z.number().int().positive(),
  refresh_expires_in: z.number().int().positive(),
  collection_id: z.uuid(),
  collection_name: z.string().trim().min(1).max(200).optional(),
  operations: z.array(z.string()),
  scope: z.object({
    contracts: z.array(z.object({ id: z.string(), version: z.number().int().positive() }))
  }),
  grant_id: z.uuid(),
  encryption: grantEncryptionSchema.nullable(),
  authority: z.object({
    operations_url: z.url(),
    sync_url: z.url(),
    replica_id: z.uuid(),
    access_token: z.string().min(1),
    proof_public_key: z.string().min(80).max(200)
  }).optional()
}).passthrough();

type ConnectTokenResponse = z.infer<typeof tokenResponseSchema>;

interface StoredCredentials {
  accessToken: string;
  refreshToken: string;
  authority?: {
    operationsUrl: string;
    replicaId: string;
    accessToken: string;
  };
}

export interface ConnectionSummary {
  id: string;
  collection_id: string;
  display_name: string;
  operations: CollectionOperation[];
  scope: GrantScope;
  authority: "local" | "remote";
}

interface ConnectionRow {
  id: string;
  connection_set_id: string;
  upstream_url: string;
  upstream_client_id: string;
  collection_id: string;
  grant_id: string;
  display_name: string;
  operations: CollectionOperation[];
  scope: GrantScope;
  encryption: GrantEncryption | null;
  key_handle: string | null;
  credentials_ciphertext: string;
  access_expires_at: Date | string;
  refresh_expires_at: Date | string;
}

export class ConnectGateway {
  private readonly applicationOrigin: string;

  constructor(
    private readonly db: DatabasePool,
    private readonly secrets: SecretBox,
    private readonly keyStore: GrantKeyStore,
    readonly connectUrl: string,
    private readonly manifest: MdbaseAppManifest,
    readonly callbackUrl: string
  ) {
    this.applicationOrigin = new URL(callbackUrl).origin;
  }

  async registerApplication(): Promise<{ id: string; manifestDigest: string }> {
    const response = await fetch(`${this.connectUrl}/v1/apps/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest: this.manifest })
    });
    const body = await response.json().catch(() => null);
    if (
      !response.ok
      || typeof body?.application?.id !== "string"
      || typeof body?.application?.manifest_digest !== "string"
      || !/^[0-9a-f]{64}$/u.test(body.application.manifest_digest)
    ) {
      throw upstreamError(body, "Connect could not register the MCP application.");
    }
    return {
      id: body.application.id,
      manifestDigest: body.application.manifest_digest
    };
  }

  async createAuthorizationRequest(input: {
    state: string;
    codeChallenge: string;
    operations: CollectionOperation[];
    collectionId: string | null;
    grantKey: GrantKeyRecord;
  }): Promise<string> {
    const application = await this.registerApplication();
    const installation = await this.applicationIdentity(application.id);
    const issuedAt = new Date();
    const proof = await signApplicationAuthorization({
      protocol_version: APPLICATION_AUTHORIZATION_PROTOCOL_VERSION,
      authorization_id: randomUUID(),
      application_id: application.id,
      application_declaration_id: this.manifest.id,
      application_manifest_digest: application.manifestDigest,
      application_installation_id: await applicationInstallationId(installation),
      installation_signing_public_key: installation.signingPublicKey,
      grant_agreement_public_key: input.grantKey.agreementPublicKey,
      grant_signing_public_key: input.grantKey.signingPublicKey,
      flow: "authorization_code",
      authorization_nonce: randomBytes(32).toString("base64url"),
      issued_at: issuedAt.toISOString(),
      expires_at: new Date(issuedAt.getTime() + 10 * 60_000).toISOString(),
      redirect_uri: this.callbackUrl,
      state: input.state,
      code_challenge: input.codeChallenge,
      contracts: authorizationContractRequirements(
        input.operations,
        this.manifest.requirements?.files
      ),
      requested_operations: input.operations,
      ...(this.manifest.requirements?.files
        ? { requested_files: this.manifest.requirements.files }
        : {}),
      ...(input.collectionId ? { collection_id: input.collectionId } : {})
    }, installation);
    const response = await fetch(`${this.connectUrl}/oauth/authorization_request`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: application.id,
        redirect_uri: this.callbackUrl,
        code_challenge: input.codeChallenge,
        code_challenge_method: "S256",
        state: input.state,
        operations: input.operations.join(","),
        ...(input.collectionId ? { collection_id: input.collectionId } : {}),
        application_authorization: JSON.stringify(proof)
      })
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || typeof body?.authorization_uri !== "string") {
      throw upstreamError(body, "Connect authorization could not be started.");
    }
    return z.url().parse(body.authorization_uri);
  }

  async exchangeAuthorization(input: {
    code: string;
    verifier: string;
    applicationId: string;
    connectionSetId: string;
    keyHandle: string;
  }): Promise<ConnectionSummary> {
    const response = await fetch(`${this.connectUrl}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: input.code,
        client_id: input.applicationId,
        redirect_uri: this.callbackUrl,
        code_verifier: input.verifier
      })
    });
    const raw = await response.json().catch(() => null);
    if (!response.ok) throw upstreamError(raw, "Connect authorization could not be completed.");
    const token = tokenResponseSchema.parse(raw);
    await this.assertTokenBinding(token, input.keyHandle, input.applicationId);
    const connection = await this.saveConnection(input.connectionSetId, input.applicationId, input.keyHandle, token);
    return summary(connection);
  }

  private async applicationIdentity(applicationId: string): Promise<GrantKeyRecord> {
    const handle = `mcp-application-identity:v3:${this.connectUrl}:${applicationId}`;
    const existing = await this.keyStore.get(handle);
    if (existing) return existing;
    try {
      return await this.keyStore.create(handle);
    } catch (error) {
      const raced = await this.keyStore.get(handle);
      if (raced) return raced;
      throw error;
    }
  }

  async listConnections(connectionSetId: string): Promise<ConnectionSummary[]> {
    const result = await this.db.query<ConnectionRow>(
      `SELECT id, connection_set_id, upstream_url, upstream_client_id, collection_id,
              grant_id, display_name, operations, scope, encryption, key_handle,
              credentials_ciphertext, access_expires_at, refresh_expires_at
       FROM mcp_connections WHERE connection_set_id = $1 ORDER BY display_name, id`,
      [connectionSetId]
    );
    return result.rows.map(summary);
  }

  async operation<Result>(
    connectionSetId: string,
    connectionId: string,
    operation: CollectionOperation,
    input: unknown
  ): Promise<Result> {
    let connection = await this.freshConnection(connectionSetId, connectionId, false);
    if (!connection.operations.includes(operation)) {
      throw new GatewayOperationError(
        "insufficient_collection_access",
        `${connection.display_name} was not approved for ${operation}. Reconnect it with broader access.`
      );
    }
    let attempt = await this.sendOperation<Result>(connection, operation, input);
    if (attempt.status === 401) {
      connection = await this.freshConnection(connectionSetId, connectionId, true);
      attempt = await this.sendOperation<Result>(connection, operation, input);
    }
    if (!attempt.ok) throw upstreamError(attempt.body, `The ${operation} operation failed.`);
    if (!attempt.request) return attempt.body?.result as Result;
    if (!connection.encryption || !connection.key_handle) {
      throw new GatewayOperationError("missing_grant_key", "The encrypted collection grant is incomplete.");
    }
    const envelope = attempt.body?.envelope as EncryptedRelayOperationResponse | undefined;
    if (!envelope) throw new GatewayOperationError("invalid_encrypted_response", "Connect returned no encrypted response.");
    const decrypted = await decryptRelayResponse<Result>(
      this.keyStore,
      connection.key_handle,
      {
        grantId: connection.grant_id,
        applicationId: connection.upstream_client_id,
        encryption: connection.encryption
      },
      attempt.request,
      envelope
    );
    if (!decrypted.ok) {
      throw new GatewayOperationError(
        decrypted.problem.code === "unknown"
          ? decrypted.problem.server_code
          : decrypted.problem.code,
        decrypted.problem.message
      );
    }
    return decrypted.result;
  }

  private async sendOperation<Result>(
    connection: ConnectionRow,
    operation: CollectionOperation,
    input: unknown
  ): Promise<{
    ok: boolean;
    status: number;
    body: any;
    request?: Awaited<ReturnType<typeof encryptRelayRequest>>;
  }> {
    const credentials = this.credentials(connection);
    let request: Awaited<ReturnType<typeof encryptRelayRequest>> | undefined;
    let body: unknown = input ?? {};
    let url: string;
    let bearer: string;
    if (credentials.authority) {
      url = `${credentials.authority.operationsUrl}/${operation}`;
      bearer = credentials.authority.accessToken;
    } else {
      if (!connection.encryption || !connection.key_handle) {
        throw new GatewayOperationError("encryption_required", "Local collection access requires an encrypted grant.");
      }
      request = await encryptRelayRequest(
        this.keyStore,
        connection.key_handle,
        {
          grantId: connection.grant_id,
          applicationId: connection.upstream_client_id,
          encryption: connection.encryption
        },
        operation,
        input
      );
      body = request;
      url = `${connection.upstream_url}/v1/authorities/${encodeURIComponent(connection.collection_id)}/operations/${operation}`;
      bearer = credentials.accessToken;
    }
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
        origin: this.applicationOrigin
      },
      body: JSON.stringify(body)
    });
    return {
      ok: response.ok,
      status: response.status,
      body: await response.json().catch(() => null),
      request
    };
  }

  private async freshConnection(setId: string, connectionId: string, force: boolean): Promise<ConnectionRow> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query<ConnectionRow>(
        `SELECT id, connection_set_id, upstream_url, upstream_client_id, collection_id,
                grant_id, display_name, operations, scope, encryption, key_handle,
                credentials_ciphertext, access_expires_at, refresh_expires_at
         FROM mcp_connections WHERE id = $1 AND connection_set_id = $2 FOR UPDATE`,
        [connectionId, setId]
      );
      let connection = selected.rows[0];
      if (!connection) throw new GatewayOperationError("connection_not_found", "That collection connection is unavailable.");
      if (!force && new Date(connection.access_expires_at).getTime() > Date.now() + 30_000) {
        await client.query("COMMIT");
        return connection;
      }
      if (new Date(connection.refresh_expires_at).getTime() <= Date.now()) {
        throw new GatewayOperationError("connection_expired", `Reconnect ${connection.display_name} to continue.`);
      }
      const credentials = this.credentials(connection);
      const response = await fetch(`${connection.upstream_url}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: credentials.refreshToken,
          client_id: connection.upstream_client_id
        })
      });
      const raw = await response.json().catch(() => null);
      if (!response.ok) throw upstreamError(raw, `Reconnect ${connection.display_name} to continue.`);
      const token = tokenResponseSchema.parse(raw);
      if (token.collection_id !== connection.collection_id || token.grant_id !== connection.grant_id) {
        throw new GatewayOperationError("authorization_changed", "Connect returned a different collection grant.");
      }
      await this.assertTokenBinding(token, connection.key_handle, connection.upstream_client_id);
      const updated = await client.query<ConnectionRow>(
        `UPDATE mcp_connections
         SET display_name = $2, operations = $3::jsonb, scope = $4::jsonb,
             encryption = $5::jsonb, credentials_ciphertext = $6,
             access_expires_at = $7, refresh_expires_at = $8, updated_at = now()
         WHERE id = $1
         RETURNING id, connection_set_id, upstream_url, upstream_client_id, collection_id,
                   grant_id, display_name, operations, scope, encryption, key_handle,
                   credentials_ciphertext, access_expires_at, refresh_expires_at`,
        [
          connection.id,
          token.collection_name ?? connection.display_name,
          JSON.stringify(token.operations),
          JSON.stringify(token.scope),
          token.encryption ? JSON.stringify(token.encryption) : null,
          this.secrets.encrypt(JSON.stringify(credentialsFromToken(token))),
          new Date(Date.now() + token.expires_in * 1_000),
          new Date(Date.now() + token.refresh_expires_in * 1_000)
        ]
      );
      connection = updated.rows[0];
      await client.query("COMMIT");
      return connection;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async assertTokenBinding(
    token: ConnectTokenResponse,
    keyHandle: string | null,
    applicationId: string
  ): Promise<void> {
    if (token.authority) {
      const key = keyHandle ? await this.keyStore.get(keyHandle) : null;
      if (
        !key
        || token.authority.proof_public_key !== key.signingPublicKey
      ) {
        throw new GatewayOperationError(
          "grant_key_mismatch",
          "Connect returned a remote authority grant for a different signing key."
        );
      }
      return;
    }
    if (!token.encryption || !keyHandle) {
      throw new GatewayOperationError("encryption_required", "Connect did not establish encrypted local access.");
    }
    const key = await this.keyStore.get(keyHandle);
    if (
      !key
      || key.agreementPublicKey
        !== token.encryption.application_agreement_public_key
    ) {
      throw new GatewayOperationError("grant_key_mismatch", "Connect returned a grant for a different encryption key.");
    }
    if (token.encryption.connector_id.length === 0 || applicationId.length === 0) {
      throw new GatewayOperationError("invalid_encryption_binding", "Connect returned an incomplete encryption binding.");
    }
  }

  private async saveConnection(
    setId: string,
    applicationId: string,
    keyHandle: string,
    token: ConnectTokenResponse
  ): Promise<ConnectionRow> {
    const previous = await this.db.query<{ key_handle: string | null }>(
      `SELECT key_handle FROM mcp_connections
       WHERE connection_set_id = $1 AND upstream_url = $2 AND collection_id = $3`,
      [setId, this.connectUrl, token.collection_id]
    );
    const previousKey = previous.rows[0]?.key_handle ?? null;
    const storedKey = token.authority ? null : keyHandle;
    if (token.authority) await this.keyStore.delete(keyHandle);
    const result = await this.db.query<ConnectionRow>(
      `INSERT INTO mcp_connections
         (id, connection_set_id, upstream_url, upstream_client_id, collection_id,
          grant_id, display_name, operations, scope, encryption, key_handle,
          credentials_ciphertext, access_expires_at, refresh_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, $13, $14)
       ON CONFLICT(connection_set_id, upstream_url, collection_id) DO UPDATE
       SET upstream_client_id = excluded.upstream_client_id,
           grant_id = excluded.grant_id,
           display_name = excluded.display_name,
           operations = excluded.operations,
           scope = excluded.scope,
           encryption = excluded.encryption,
           key_handle = excluded.key_handle,
           credentials_ciphertext = excluded.credentials_ciphertext,
           access_expires_at = excluded.access_expires_at,
           refresh_expires_at = excluded.refresh_expires_at,
           updated_at = now()
       RETURNING id, connection_set_id, upstream_url, upstream_client_id, collection_id,
                 grant_id, display_name, operations, scope, encryption, key_handle,
                 credentials_ciphertext, access_expires_at, refresh_expires_at`,
      [
        randomUUID(),
        setId,
        this.connectUrl,
        applicationId,
        token.collection_id,
        token.grant_id,
        token.collection_name ?? `Collection ${token.collection_id.slice(0, 8)}`,
        JSON.stringify(token.operations),
        JSON.stringify(token.scope),
        token.encryption ? JSON.stringify(token.encryption) : null,
        storedKey,
        this.secrets.encrypt(JSON.stringify(credentialsFromToken(token))),
        new Date(Date.now() + token.expires_in * 1_000),
        new Date(Date.now() + token.refresh_expires_in * 1_000)
      ]
    );
    if (previousKey && previousKey !== storedKey) await this.keyStore.delete(previousKey);
    return result.rows[0];
  }

  private credentials(connection: ConnectionRow): StoredCredentials {
    return JSON.parse(this.secrets.decrypt(connection.credentials_ciphertext)) as StoredCredentials;
  }
}

export class GatewayOperationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

function credentialsFromToken(token: ConnectTokenResponse): StoredCredentials {
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    ...(token.authority ? {
      authority: {
        operationsUrl: token.authority.operations_url,
        replicaId: token.authority.replica_id,
        accessToken: token.authority.access_token
      }
    } : {})
  };
}

function summary(connection: ConnectionRow): ConnectionSummary {
  return {
    id: connection.id,
    collection_id: connection.collection_id,
    display_name: connection.display_name,
    operations: connection.operations,
    scope: connection.scope,
    authority: connection.encryption ? "local" : "remote"
  };
}

function upstreamError(body: any, fallback: string): GatewayOperationError {
  return new GatewayOperationError(
    typeof body?.error?.code === "string" ? body.error.code : "upstream_error",
    typeof body?.error?.message === "string" ? body.error.message : fallback
  );
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/$/, "");
}
