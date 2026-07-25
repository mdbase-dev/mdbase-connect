import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "./app.js";
import { createDatabase } from "./db.js";
import type { McpRuntimeConfig } from "./config.js";
import { SecretBox, pkceChallenge } from "./security.js";

const applicationId = "10000000-0000-4000-8000-000000000001";
const firstCollectionId = "20000000-0000-4000-8000-000000000001";
const secondCollectionId = "20000000-0000-4000-8000-000000000002";
const firstGrantId = "30000000-0000-4000-8000-000000000001";
const secondGrantId = "30000000-0000-4000-8000-000000000002";

afterEach(() => vi.restoreAllMocks());

describe("mdbase MCP gateway", () => {
  it("publishes OAuth metadata and challenges unauthenticated MCP requests", async () => {
    const db = await createDatabase("memory");
    const { app } = await buildApp({ db, config: testConfig() });
    const metadata = await app.inject({ method: "GET", url: "/.well-known/oauth-protected-resource/mcp" });
    expect(metadata.statusCode).toBe(200);
    expect(metadata.json()).toMatchObject({
      resource: "https://mcp.example/mcp",
      authorization_servers: ["https://mcp.example"],
      scopes_supported: ["mdbase:read", "mdbase:write"]
    });
    const manifest = await app.inject({ method: "GET", url: "/.well-known/mdbase-app.json" });
    expect(manifest.statusCode).toBe(200);
    expect(manifest.json().requirements).toEqual({
      access: "full_collection",
      contracts: []
    });
    const denied = await app.inject({
      method: "POST",
      url: "/mcp",
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" }
    });
    expect(denied.statusCode).toBe(401);
    expect(denied.headers["www-authenticate"]).toContain("oauth-protected-resource/mcp");
    await app.close();
    await db.end();
  });

  it("authorizes a host, adds multiple collections, and routes MCP tools by connection ID", async () => {
    const upstream = await fakeUpstream(globalThis.fetch);
    vi.stubGlobal("fetch", upstream.fetch);
    const db = await createDatabase("memory");
    const { app, oauth, gateway } = await buildApp({ db, config: testConfig() });

    const registration = await app.inject({
      method: "POST",
      url: "/oauth/register",
      payload: {
        client_name: "Test MCP host",
        redirect_uris: ["https://client.example/callback"],
        token_endpoint_auth_method: "none"
      }
    });
    expect(registration.statusCode).toBe(201);
    const clientId = registration.json().client_id as string;
    const verifier = "host-pkce-verifier-that-is-long-enough-for-s256-0001";
    const authorization = await app.inject({
      method: "GET",
      url: `/oauth/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: "https://client.example/callback",
        code_challenge: pkceChallenge(verifier),
        code_challenge_method: "S256",
        state: "host-state",
        scope: "mdbase:read mdbase:write",
        resource: "https://mcp.example/mcp"
      })}`
    });
    expect(authorization.statusCode).toBe(302);
    const firstUpstream = new URL(authorization.headers.location!);
    expect(firstUpstream.origin).toBe("https://connect.example");
    expect(firstUpstream.searchParams.get("operations")).toContain("create");
    expect(firstUpstream.searchParams.get("relay_protocol")).toBe("1");
    upstream.applicationPublicKeys.push(firstUpstream.searchParams.get("application_public_key")!);

    const firstCallback = await app.inject({
      method: "GET",
      url: `/oauth/connect/callback?${new URLSearchParams({
        state: firstUpstream.searchParams.get("state")!,
        code: "first-upstream-code"
      })}`
    });
    expect(firstCallback.statusCode).toBe(302);
    const hostCallback = new URL(firstCallback.headers.location!);
    expect(hostCallback.origin).toBe("https://client.example");
    expect(hostCallback.searchParams.get("state")).toBe("host-state");

    const token = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        code: hostCallback.searchParams.get("code")!,
        client_id: clientId,
        redirect_uri: "https://client.example/callback",
        code_verifier: verifier,
        resource: "https://mcp.example/mcp"
      }).toString()
    });
    expect(token.statusCode).toBe(200);
    const originalRefreshToken = token.json().refresh_token as string;
    const refreshed = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: originalRefreshToken,
        client_id: clientId,
        resource: "https://mcp.example/mcp"
      }).toString()
    });
    expect(refreshed.statusCode).toBe(200);
    const reusedRefresh = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: originalRefreshToken,
        client_id: clientId,
        resource: "https://mcp.example/mcp"
      }).toString()
    });
    expect(reusedRefresh.statusCode).toBe(400);
    expect(reusedRefresh.json().error).toBe("invalid_grant");
    const accessToken = refreshed.json().access_token as string;
    const context = await oauth.authenticate(accessToken);
    expect(context).not.toBeNull();

    const addUrl = await oauth.createConnectionTicket(context!);
    const additional = await app.inject({ method: "GET", url: `${new URL(addUrl).pathname}${new URL(addUrl).search}` });
    expect(additional.statusCode).toBe(302);
    const secondUpstream = new URL(additional.headers.location!);
    upstream.applicationPublicKeys.push(secondUpstream.searchParams.get("application_public_key")!);
    const secondCallback = await app.inject({
      method: "GET",
      url: `/oauth/connect/callback?${new URLSearchParams({
        state: secondUpstream.searchParams.get("state")!,
        code: "second-upstream-code"
      })}`
    });
    expect(secondCallback.statusCode).toBe(200);
    expect(secondCallback.body).toContain("Second collection");

    const connections = await gateway.listConnections(context!.connectionSetId);
    expect(connections.map((connection) => connection.display_name)).toEqual([
      "First collection",
      "Second collection"
    ]);

    const stored = await db.query<{ credentials_ciphertext: string }>(
      "SELECT credentials_ciphertext FROM mcp_connections"
    );
    expect(stored.rows).toHaveLength(2);
    expect(stored.rows.every((row) => !row.credentials_ciphertext.includes("upstream-access"))).toBe(true);

    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const client = new Client({ name: "gateway-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${address}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${accessToken}` } }
    });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("add_connection");
    expect(tools.tools.map((tool) => tool.name)).toContain("create_record");
    const listed = await client.callTool({ name: "list_connections", arguments: {} });
    expect((listed.structuredContent as any).connections).toHaveLength(2);
    const queried = await client.callTool({
      name: "query_records",
      arguments: { connection_id: connections[1].id, types: ["note"], limit: 10 }
    });
    expect(queried.structuredContent).toMatchObject({
      valid: true,
      result: { results: [{ path: "notes/second.md" }] }
    });
    expect(upstream.operationAuthorizations).toContain("Bearer hosted-access-two");
    const localQuery = await client.callTool({
      name: "query_records",
      arguments: { connection_id: connections[0].id, types: ["note"], limit: 5 }
    });
    expect(localQuery.structuredContent).toMatchObject({
      valid: true,
      result: { results: [{ path: "notes/local.md" }] }
    });
    expect(upstream.localInputs).toContainEqual({ types: ["note"], limit: 5 });
    expect(upstream.operationAuthorizations).toContain("Bearer upstream-access-one");

    await client.close();
    await app.close();
    await db.end();
  });
});

function testConfig(): McpRuntimeConfig {
  return {
    host: "127.0.0.1",
    port: 8790,
    publicUrl: "https://mcp.example",
    connectUrl: "https://connect.example",
    resource: "https://mcp.example/mcp",
    masterKey: new SecretBox(Buffer.alloc(32, 7)),
    trustProxy: false
  };
}

async function fakeUpstream(realFetch: typeof fetch) {
  const applicationPublicKeys: string[] = [];
  const operationAuthorizations: string[] = [];
  const localInputs: unknown[] = [];
  const connectorKeys = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  ) as CryptoKeyPair;
  const connectorPublicKey = Buffer.from(
    await crypto.subtle.exportKey("raw", connectorKeys.publicKey)
  ).toString("base64url");
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.href === "https://connect.example/v1/apps/register") {
      return Response.json({ application: { id: applicationId } });
    }
    if (url.href === "https://connect.example/oauth/token") {
      const body = new URLSearchParams(String(init?.body));
      const second = body.get("code") === "second-upstream-code";
      return Response.json({
        access_token: second ? "upstream-access-two" : "upstream-access-one",
        refresh_token: second ? "upstream-refresh-two" : "upstream-refresh-one",
        token_type: "Bearer",
        expires_in: 3_600,
        refresh_expires_in: 2_592_000,
        collection_id: second ? secondCollectionId : firstCollectionId,
        collection_name: second ? "Second collection" : "First collection",
        operations: ["describe", "changes", "read", "query", "validate", "read_type", "create", "update", "delete", "rename", "create_type", "update_type"],
        scope: { contracts: [] },
        grant_id: second ? secondGrantId : firstGrantId,
        encryption: second ? null : {
          protocol_version: 1,
          suite: "P256-HKDF-SHA256-AES256GCM",
          key_id: "local-key-1",
          scope_epoch: 1,
          connector_id: "50000000-0000-4000-8000-000000000001",
          collection_id: firstCollectionId,
          application_public_key: applicationPublicKeys[0],
          connector_public_key: connectorPublicKey
        },
        ...(second ? { hosted: {
          provider_url: "https://sync.example",
          replica_id: "40000000-0000-4000-8000-000000000002",
          access_token: "hosted-access-two"
        } } : {})
      });
    }
    if (url.origin === "https://connect.example" && url.pathname.endsWith("/operations/query")) {
      operationAuthorizations.push(new Headers(init?.headers).get("authorization")!);
      const envelope = JSON.parse(String(init?.body));
      const input = await decryptConnectorRequest(connectorKeys.privateKey, applicationPublicKeys[0], envelope);
      localInputs.push(input);
      const responseEnvelope = await encryptConnectorResponse(connectorKeys.privateKey, applicationPublicKeys[0], envelope, {
        valid: true,
        result: { results: [{ path: "notes/local.md", frontmatter: { title: "Local" }, types: ["note"] }] },
        diagnostics: []
      });
      return Response.json({ envelope: responseEnvelope });
    }
    if (url.origin === "https://sync.example" && url.pathname.endsWith("/operations/query")) {
      operationAuthorizations.push(new Headers(init?.headers).get("authorization")!);
      return Response.json({
        result: {
          valid: true,
          result: { results: [{ path: "notes/second.md", frontmatter: { title: "Second" }, types: ["note"] }] },
          diagnostics: []
        }
      });
    }
    if (url.hostname === "127.0.0.1") return realFetch(input, init);
    return Response.json({ error: { code: "unexpected_fetch", message: url.href } }, { status: 500 });
  });
  return { fetch: fetchMock, applicationPublicKeys, operationAuthorizations, localInputs };
}

async function decryptConnectorRequest(privateKey: CryptoKey, applicationPublicKey: string, envelope: any): Promise<unknown> {
  const key = await relayKey(privateKey, applicationPublicKey, envelope, "request");
  const plaintext = await crypto.subtle.decrypt({
    name: "AES-GCM",
    iv: nonce(envelope.counter),
    additionalData: new TextEncoder().encode(relayAad(envelope, "request")),
    tagLength: 128
  }, key, Uint8Array.from(Buffer.from(envelope.ciphertext, "base64url")).buffer);
  return JSON.parse(new TextDecoder().decode(plaintext));
}

async function encryptConnectorResponse(privateKey: CryptoKey, applicationPublicKey: string, envelope: any, result: unknown) {
  const key = await relayKey(privateKey, applicationPublicKey, envelope, "response");
  const ciphertext = await crypto.subtle.encrypt({
    name: "AES-GCM",
    iv: nonce(envelope.counter),
    additionalData: new TextEncoder().encode(relayAad(envelope, "response")),
    tagLength: 128
  }, key, new TextEncoder().encode(JSON.stringify({ ok: true, result })));
  return {
    ...envelope,
    type: "encrypted_operation_response",
    ciphertext: Buffer.from(ciphertext).toString("base64url")
  };
}

async function relayKey(privateKey: CryptoKey, applicationPublicKey: string, envelope: any, direction: "request" | "response") {
  const applicationPublic = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(Buffer.from(applicationPublicKey, "base64url")).buffer,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: applicationPublic }, privateKey, 256);
  const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const salt = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(relayContext(envelope)));
  return crypto.subtle.deriveKey({
    name: "HKDF",
    hash: "SHA-256",
    salt,
    info: new TextEncoder().encode(`mdbase-connect relay ${direction} key v1`)
  }, material, { name: "AES-GCM", length: 256 }, false, direction === "request" ? ["decrypt"] : ["encrypt"]);
}

function relayContext(envelope: any): string {
  return [
    "mdbase-connect",
    envelope.protocol_version,
    envelope.suite,
    envelope.grant_id,
    envelope.application_id,
    envelope.connector_id,
    envelope.collection_id,
    envelope.scope_epoch,
    envelope.key_id
  ].join("|");
}

function relayAad(envelope: any, direction: "request" | "response"): string {
  return [relayContext(envelope), envelope.request_id, direction, envelope.operation, envelope.counter].join("|");
}

function nonce(counter: string): Uint8Array<ArrayBuffer> {
  const value = new Uint8Array(new ArrayBuffer(12));
  new DataView(value.buffer).setBigUint64(4, BigInt(counter), false);
  return value;
}
