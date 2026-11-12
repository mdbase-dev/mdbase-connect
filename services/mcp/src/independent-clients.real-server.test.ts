// Two MCP clients of one Connect user approving the same collection, against
// the real Connect control plane. Connect keeps one live grant per application
// installation and collection, so the gateway must present each connection set
// (one MCP client sign-in) as its own installation; otherwise the second
// approval replaced the first client's grant. Only the hosted storage provider
// (a separate Rust service) is a test double.
import { afterEach, expect, it, vi } from "vitest";
import { OPERATION_TRANSPORT_PROTOCOL_VERSION } from "@mdbase-dev/connect-protocol";
import { buildApp as buildConnectServer } from "../../server/src/app.js";
import { createDatabase as createConnectDatabase } from "../../server/src/db.js";
import type { HostedProviderClient } from "../../server/src/features/hosted/hosted-provider.js";
import { buildApp } from "./app.js";
import { createDatabase } from "./db.js";
import type { McpRuntimeConfig } from "./config.js";
import { SecretBox, pkceChallenge } from "./security.js";

const CONNECT = "http://connect.test";
const resources: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  while (resources.length) await resources.pop()!();
});

it("keeps one MCP client's collection access when another client of the same user approves the same collection", async () => {
  const hostedProvider = {
    url: "https://sync.example",
    ready: vi.fn(),
    assertFreshV2AuthorizationSupport: vi.fn(),
    upsertAccount: vi.fn().mockResolvedValue({}),
    createCollection: vi.fn(),
    collectionContracts: vi.fn().mockResolvedValue([]),
    provisionApplicationSetup: vi.fn(),
    registerReplica: vi.fn(),
    updateApplicationReplica: vi.fn(),
    rotateReplicaToken: vi.fn(),
    revokeReplica: vi.fn(),
    upsertNotificationGrant: vi.fn(),
    revokeNotificationGrant: vi.fn(),
    compactThrough: vi.fn()
  } as unknown as HostedProviderClient;
  const connectDb = await createConnectDatabase("memory");
  resources.push(() => connectDb.end());
  const { app: connect } = await buildConnectServer({
    db: connectDb, devAuth: true, hostedCollections: true, hostedProvider, publicUrl: CONNECT
  });
  resources.push(() => connect.close());

  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.origin === "https://sync.example" && url.pathname.includes("/operations/")) {
      const request = JSON.parse(String(init?.body));
      return Response.json({ protocol_version: OPERATION_TRANSPORT_PROTOCOL_VERSION, request_id: request.request_id, ok: true,
        result: { valid: true, diagnostics: [], result: { path: request.input.path, revision: "r1", frontmatter: {}, types: [] } } });
    }
    if (url.origin !== CONNECT) return realFetch(input, init);
    const response = await connect.inject({
      method: (init?.method ?? "GET") as "GET" | "POST",
      url: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(new Headers(init?.headers)),
      ...(init?.body === undefined ? {} : { payload: String(init.body) })
    });
    return new Response(response.body, {
      status: response.statusCode,
      headers: { "content-type": String(response.headers["content-type"] ?? "application/json") }
    });
  });

  const mcpDb = await createDatabase("memory");
  resources.push(() => mcpDb.end());
  const { app: mcp, oauth } = await buildApp({ db: mcpDb, config: mcpConfig() });
  resources.push(() => mcp.close());

  const session = await connect.inject({
    method: "POST", url: "/v1/dev/session", payload: { name: "Owner", email: "mcp-two-clients@example.test" }
  });
  const setCookie = session.headers["set-cookie"]!;
  const cookie = (Array.isArray(setCookie) ? setCookie[0]! : setCookie).split(";")[0]!;
  const created = await connect.inject({
    method: "POST", url: "/v1/hosted/collections", headers: { cookie },
    payload: { display_name: "Shared MCP notes", template: "mdbase", timezone: "UTC" }
  });
  expect(created.statusCode, created.body).toBe(201);
  const collectionId = created.json().collection.id as string;

  /** The user approves the collection in Connect for an upstream authorization the gateway started. */
  const approveUpstream = async (location: string) => {
    const upstream = new URL(location);
    const requestId = upstream.searchParams.get("request_id")!;
    const claimed = await connect.inject({ method: "GET", url: `${upstream.pathname}${upstream.search}`, headers: { cookie } });
    expect(claimed.statusCode, claimed.body).toBe(302);
    const consent = await connect.inject({ method: "GET", url: `/v1/authorization-requests/${requestId}`, headers: { cookie } });
    expect(consent.statusCode, consent.body).toBe(200);
    const approved = await connect.inject({
      method: "POST", url: `/v1/authorization-requests/${requestId}/approve`, headers: { cookie },
      payload: { collection_id: collectionId, operations: consent.json().authorization.requested_operations, contract_setups: [] }
    });
    expect(approved.statusCode, approved.body).toBe(200);
    const status = await connect.inject({ method: "GET", url: `/v1/authorization-requests/${requestId}/status`, headers: { cookie } });
    const callback = new URL(status.json().redirect_uri);
    return mcp.inject({ method: "GET", url: `${callback.pathname}${callback.search}` });
  };

  /** One MCP client registers, signs in to the gateway and approves the collection. */
  const signIn = async (clientName: string) => {
    const registration = await mcp.inject({
      method: "POST", url: "/oauth/register",
      payload: { client_name: clientName, redirect_uris: ["https://client.example/callback"], token_endpoint_auth_method: "none" }
    });
    const clientId = registration.json().client_id as string;
    const verifier = `${clientName.replaceAll(" ", "-")}-pkce-verifier-long-enough-for-s256-000000`;
    const authorize = await mcp.inject({
      method: "GET",
      url: `/oauth/authorize?${new URLSearchParams({
        response_type: "code", client_id: clientId, redirect_uri: "https://client.example/callback",
        code_challenge: pkceChallenge(verifier), code_challenge_method: "S256",
        scope: "mdbase:read", resource: "https://mcp.example/mcp"
      })}`
    });
    expect(authorize.statusCode, authorize.body).toBe(302);
    const completed = await approveUpstream(authorize.headers.location!);
    expect(completed.statusCode, completed.body).toBe(302);
    const token = await mcp.inject({
      method: "POST", url: "/oauth/token", headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "authorization_code", code: new URL(completed.headers.location!).searchParams.get("code")!,
        client_id: clientId, redirect_uri: "https://client.example/callback", code_verifier: verifier,
        resource: "https://mcp.example/mcp"
      }).toString()
    });
    expect(token.statusCode, token.body).toBe(200);
    const accessToken = token.json().access_token as string;
    const context = (await oauth.authenticate(accessToken))!;
    return { accessToken, context };
  };

  const rpc = async (accessToken: string, method: string, params: unknown) => {
    const response = await mcp.inject({ method: "POST", url: "/mcp",
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json, text/event-stream" },
      payload: { jsonrpc: "2.0", id: 1, method, params } });
    expect(response.statusCode, response.body).toBe(200);
    const data = response.body.split("\n").find((line) => line.startsWith("data: "));
    return (data ? JSON.parse(data.slice(6)) : response.json()).result;
  };
  /** Reads after forcing the gateway to renew its Connect tokens for that client. */
  const readAfterRenewal = async (client: Awaited<ReturnType<typeof signIn>>) => {
    await mcpDb.query("UPDATE mcp_connections SET access_expires_at = now() - interval '1 second' WHERE connection_set_id = $1",
      [client.context.connectionSetId]);
    const [connection] = (await rpc(client.accessToken, "tools/call", { name: "list_connections", arguments: {} }))
      .structuredContent.connections;
    return rpc(client.accessToken, "tools/call", { name: "read_record", arguments: { connection_id: connection.id, path: "note.md" } });
  };
  const liveGrants = async () => (await connectDb.query<{ id: string; application_installation_id: string }>(
    "SELECT id, application_installation_id FROM grants WHERE hosted_collection_id = $1 AND revoked_at IS NULL ORDER BY created_at",
    [collectionId]
  )).rows;

  const chatgpt = await signIn("ChatGPT");
  const [first] = await liveGrants();
  const scanner = await signIn("Plugin portal scanner");

  // Each sign-in is its own installation with its own live grant.
  const grants = await liveGrants();
  expect(grants).toHaveLength(2);
  expect(grants[0]).toEqual(first);
  expect(new Set(grants.map((grant) => grant.application_installation_id)).size).toBe(2);
  for (const client of [chatgpt, scanner]) {
    const read = await readAfterRenewal(client);
    expect(read.isError, JSON.stringify(read)).not.toBe(true);
  }

  // Reconnecting the collection inside one sign-in replaces only that sign-in's grant.
  const reconnect = await oauth.createConnectionTicket(chatgpt.context,
    (await rpc(chatgpt.accessToken, "tools/call", { name: "list_connections", arguments: {} })).structuredContent.connections[0].id);
  const additional = await mcp.inject({ method: "GET", url: `${new URL(reconnect).pathname}${new URL(reconnect).search}` });
  expect(additional.statusCode, additional.body).toBe(302);
  expect((await approveUpstream(additional.headers.location!)).statusCode).toBe(200);
  const reconnected = await liveGrants();
  expect(reconnected).toHaveLength(2);
  expect(reconnected.map((grant) => grant.application_installation_id).sort())
    .toEqual(grants.map((grant) => grant.application_installation_id).sort());
  for (const client of [chatgpt, scanner]) {
    const read = await readAfterRenewal(client);
    expect(read.isError, JSON.stringify(read)).not.toBe(true);
  }
}, 30_000);

function mcpConfig(): McpRuntimeConfig {
  return {
    host: "127.0.0.1",
    port: 8790,
    publicUrl: "https://mcp.example",
    connectUrl: CONNECT,
    resource: "https://mcp.example/mcp",
    masterKey: new SecretBox(Buffer.alloc(32, 7)),
    trustProxy: false
  };
}
