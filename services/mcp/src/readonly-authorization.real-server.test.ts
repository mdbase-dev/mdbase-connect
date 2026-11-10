// Read-only MCP authorization against the real Connect control plane (#1103).
// The MCP gateway signs only the file actions paired with its requested
// operations; the existing gateway tests use a fake upstream that accepts any
// proof, so they never compared that signature with the server's expectation.
// Only the hosted storage provider (a separate Rust service) is a test double.
import { afterEach, expect, it, vi } from "vitest";
import { OPERATION_TRANSPORT_PROTOCOL_VERSION, type FileCapability } from "@mdbase-dev/connect-protocol";
import { MdbaseConnect } from "@mdbase-dev/connect";
import { MemoryApplicationIdentityStore, MemoryGrantKeyStore } from "@mdbase-dev/connect/crypto";
import { buildApp as buildConnectServer } from "../../server/src/app.js";
import { createDatabase as createConnectDatabase } from "../../server/src/db.js";
import type { HostedProviderClient, HostedReplicaEnrollment } from "../../server/src/features/hosted/hosted-provider.js";
import { reconcileApplicationGrants } from "../../server/src/features/grants/service.js";
import type { RelayHub } from "../../server/src/features/relay/relay.js";
import { registerNextRouteRoutes } from "../../server/src/features/next/route-routes.js";
import { buildApp } from "./app.js";
import { createDatabase } from "./db.js";
import type { McpRuntimeConfig } from "./config.js";
import { READ_OPERATIONS } from "./oauth.js";
import { SecretBox, pkceChallenge } from "./security.js";

const CONNECT = "http://connect.test";
const resources: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  while (resources.length) await resources.pop()!();
});

it("completes read-only (mdbase:read) MCP authorization and consent with exactly the signed file actions", async () => {
  const enrolled: HostedReplicaEnrollment[] = [];
  const providerTokens = new Map<string, string>();
  const records = new Map<string, unknown>();
  const hostedProvider = {
    url: "https://sync.example",
    ready: vi.fn(),
    assertFreshV2AuthorizationSupport: vi.fn(),
    upsertAccount: vi.fn().mockResolvedValue({}),
    createCollection: vi.fn(),
    collectionContracts: vi.fn().mockResolvedValue([]),
    provisionApplicationSetup: vi.fn(),
    registerReplica: vi.fn(async (_collectionId: string, replica: HostedReplicaEnrollment) => {
      // The provider admits a replica only when its file capability is within
      // the signed request (connect-hosted-provider verified_setup_evidence).
      const signed = replica.applicationAuthorization?.binding.requested_files;
      const files = replica.fileCapability as FileCapability | undefined;
      if (files && !files.actions.every((action) => signed?.actions.includes(action))) {
        throw new Error("application_declaration_mismatch");
      }
      enrolled.push(replica);
    }),
    updateApplicationReplica: vi.fn(),
    rotateReplicaToken: vi.fn(async (replica: string, token: string) => { providerTokens.set(token, replica); }),
    revokeReplica: vi.fn(),
    upsertNotificationGrant: vi.fn(),
    revokeNotificationGrant: vi.fn(),
    compactThrough: vi.fn()
  } as unknown as HostedProviderClient;
  const connectDb = await createConnectDatabase("memory");
  resources.push(() => connectDb.end());
  const { app: connect } = await buildConnectServer({
    db: connectDb,
    devAuth: true,
    hostedCollections: true,
    hostedProvider,
    publicUrl: CONNECT
  });
  resources.push(() => connect.close());
  registerNextRouteRoutes(connect, {
    db: connectDb,
    publicUrl: CONNECT,
    broker: { request: vi.fn().mockRejectedValue(new Error("Unexpected relay request")) }
  });

  const realFetch = globalThis.fetch;
  const routes: number[] = [];
  const reads: unknown[] = [];
  let routeBearer = "";
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.origin === "https://sync.example" && url.pathname.includes("/operations/")) {
      const replica = providerTokens.get(new Headers(init?.headers).get("authorization")!.slice(7));
      const enrollment = enrolled.find((candidate) => candidate.id === replica);
      const operation = url.pathname.split("/").at(-1)!;
      expect(enrollment?.allowedOperations).toContain(operation);
      const request = JSON.parse(String(init?.body));
      if (operation === "create") records.set(request.input.path, { ...request.input, revision: "r1", types: [] });
      if (operation === "read") reads.push(request.input);
      return Response.json({ protocol_version: OPERATION_TRANSPORT_PROTOCOL_VERSION, request_id: request.request_id, ok: true,
        result: { valid: true, diagnostics: [], result: records.get(request.input.path) } });
    }
    if (url.origin !== CONNECT) return realFetch(input, init);
    const response = await connect.inject({
      method: (init?.method ?? "GET") as "GET" | "POST",
      url: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(new Headers(init?.headers)),
      ...(init?.body === undefined ? {} : { payload: String(init.body) })
    });
    if (url.pathname.endsWith("/route")) {
      routes.push(response.statusCode);
      routeBearer = new Headers(init?.headers).get("authorization")!;
    }
    return new Response(response.body, {
      status: response.statusCode,
      headers: { "content-type": String(response.headers["content-type"] ?? "application/json") }
    });
  });

  const mcpDb = await createDatabase("memory");
  resources.push(() => mcpDb.end());
  const { app: mcp } = await buildApp({ db: mcpDb, config: mcpConfig() });
  resources.push(() => mcp.close());

  const session = await connect.inject({
    method: "POST",
    url: "/v1/dev/session",
    payload: { name: "Owner", email: "mcp-readonly-owner@example.test" }
  });
  const setCookie = session.headers["set-cookie"]!;
  const cookie = (Array.isArray(setCookie) ? setCookie[0]! : setCookie).split(";")[0]!;
  const created = await connect.inject({
    method: "POST",
    url: "/v1/hosted/collections",
    headers: { cookie },
    payload: { display_name: "Read-only MCP notes", template: "mdbase", timezone: "UTC" }
  });
  expect(created.statusCode, created.body).toBe(201);
  const collectionId = created.json().collection.id as string;
  expect((await connectDb.query("SELECT collection_id FROM next_collections WHERE collection_id = $1", [collectionId])).rows).toEqual([]);

  const values = new Map<string, string>();
  const sdk = new MdbaseConnect({ serverUrl: CONNECT, directAccess: "disabled",
    keyStore: new MemoryGrantKeyStore(), identityStore: new MemoryApplicationIdentityStore(),
    storage: { get length() { return values.size; }, key: (index) => [...values.keys()][index] ?? null,
      getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); },
      removeItem: (key) => { values.delete(key); }, clear: () => values.clear() },
    manifest: { manifest_version: 1, id: "dev.mdbase.hosted-route-test", name: "Hosted route seed",
      distribution: "portable", project_url: "https://example.test",
      requirements: { access: "full_collection", contracts: [], capabilities: {
        contract_version: 2, required: ["collection.read", "records.create"], optional: [] } },
      provisions: { type_packs: [] }, notifications: { criteria: [] } }
  });
  const authorized = await sdk.authorize({ target: { kind: "collection", collectionId },
    capabilities: ["collection.read", "records.create"], openVerification: async (authorization) => {
      const lookup = await connect.inject({ method: "POST", url: "/v1/device-authorization-requests/lookup",
        headers: { cookie }, payload: { user_code: authorization.userCode } });
      expect(lookup.statusCode, lookup.body).toBe(200);
      const pending = await connect.inject({ method: "GET", url: `/v1/authorization-requests/${lookup.json().request_id}`, headers: { cookie } });
      const approved = await connect.inject({ method: "POST", url: `/v1/authorization-requests/${lookup.json().request_id}/approve`,
        headers: { cookie }, payload: { collection_id: collectionId,
          operations: pending.json().authorization.requested_operations, contract_setups: [] } });
      expect(approved.statusCode, approved.body).toBe(200);
    }
  });
  expect(authorized.ok, authorized.ok ? undefined : authorized.problem.code).toBe(true);
  if (!authorized.ok || authorized.value.kind !== "connected") throw new Error("SDK authorization failed");
  const document = { path: "staging-acceptance.md", frontmatter: { title: "Hosted MCP record" }, body: "Hosted MCP record\n" };
  expect((await authorized.value.connection.create(document)).ok).toBe(true);
  expect(await authorized.value.connection.read({ path: document.path })).toMatchObject({ ok: true, value: document });

  const registration = await mcp.inject({
    method: "POST",
    url: "/oauth/register",
    payload: {
      client_name: "Read-only MCP host",
      redirect_uris: ["https://client.example/callback"],
      token_endpoint_auth_method: "none"
    }
  });
  expect(registration.statusCode).toBe(201);
  const clientId = registration.json().client_id as string;
  const verifier = "read-only-host-pkce-verifier-long-enough-for-s256-01";
  const authorize = await mcp.inject({
    method: "GET",
    url: `/oauth/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "https://client.example/callback",
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: "S256",
      state: "read-only-host-state",
      scope: "mdbase:read",
      resource: "https://mcp.example/mcp"
    })}`
  });
  // Before #1103 the real server refused the read-only proof here with
  // durable_mutation_unsupported, surfacing as an HTTP 500 from MCP.
  expect(authorize.statusCode, authorize.body).toBe(302);
  const upstream = new URL(authorize.headers.location!);
  expect(upstream.origin).toBe(CONNECT);
  expect(upstream.pathname).toBe("/oauth/authorize");
  const requestId = upstream.searchParams.get("request_id")!;

  const pending = await connectDb.query<{ application_authorization: { binding: Record<string, any> } }>(
    "SELECT application_authorization FROM authorization_requests WHERE id = $1",
    [requestId]
  );
  const binding = pending.rows[0]!.application_authorization.binding;
  expect(binding.requested_operations).toEqual([...READ_OPERATIONS]);
  expect(binding.requested_files).toEqual({ actions: ["list", "read"], scope: { kind: "collection" } });
  expect(binding.contracts).not.toHaveProperty("durable_mutation");

  const claimed = await connect.inject({ method: "GET", url: `${upstream.pathname}${upstream.search}`, headers: { cookie } });
  expect(claimed.statusCode, claimed.body).toBe(302);
  const consent = await connect.inject({ method: "GET", url: `/v1/authorization-requests/${requestId}`, headers: { cookie } });
  expect(consent.statusCode, consent.body).toBe(200);
  const offered = consent.json().collections.find((candidate: { id: string }) => candidate.id === collectionId);
  // Consent offers the signed subset, not the declaration's optional writes.
  expect(offered.authorization).toEqual({
    available: true,
    operations: [...READ_OPERATIONS],
    file_actions: ["list", "read"]
  });

  // Approve as staging extended acceptance does: the requested operations,
  // no explicit file choice, no contract setup.
  const approved = await connect.inject({
    method: "POST",
    url: `/v1/authorization-requests/${requestId}/approve`,
    headers: { cookie },
    payload: {
      collection_id: collectionId,
      operations: consent.json().authorization.requested_operations,
      contract_setups: []
    }
  });
  expect(approved.statusCode, approved.body).toBe(200);
  expect(enrolled).toHaveLength(2);
  expect(enrolled[1]).toMatchObject({
    mode: "read_only",
    fileCapability: { actions: ["list", "read"], scope: { kind: "collection" } }
  });
  // A write file action cannot be approved beyond what the application signed.
  const grants = await connectDb.query<{ id: string; file_capability: FileCapability }>(
    "SELECT id, file_capability FROM grants WHERE hosted_collection_id = $1 AND application_id = $2 AND revoked_at IS NULL",
    [collectionId, binding.application_id]
  );
  expect(grants.rows).toHaveLength(1);
  expect(grants.rows[0]!.file_capability.actions).toEqual(["list", "read"]);

  const status = await connect.inject({ method: "GET", url: `/v1/authorization-requests/${requestId}/status`, headers: { cookie } });
  expect(status.json().status).toBe("approved");
  const callback = new URL(status.json().redirect_uri);
  expect(`${callback.origin}${callback.pathname}`).toBe("https://mcp.example/oauth/connect/callback");
  const completed = await mcp.inject({ method: "GET", url: `${callback.pathname}${callback.search}` });
  expect(completed.statusCode, completed.body).toBe(302);
  const hostCallback = new URL(completed.headers.location!);
  expect(hostCallback.searchParams.get("state")).toBe("read-only-host-state");
  const token = await mcp.inject({
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
  expect(token.statusCode, token.body).toBe(200);
  expect(token.json().scope).toBe("mdbase:read");

  const rpc = async (method: string, params: unknown) => {
    const response = await mcp.inject({ method: "POST", url: "/mcp",
      headers: { authorization: `Bearer ${token.json().access_token}`, accept: "application/json, text/event-stream" },
      payload: { jsonrpc: "2.0", id: 1, method, params } });
    expect(response.statusCode, response.body).toBe(200);
    const data = response.body.split("\n").find((line) => line.startsWith("data: "));
    return (data ? JSON.parse(data.slice(6)) : response.json()).result;
  };
  const connections = await rpc("tools/call", { name: "list_connections", arguments: {} });
  expect(connections.structuredContent.connections).toHaveLength(1);
  const connection = connections.structuredContent.connections[0];
  expect(connection.collection_id).toBe(collectionId);
  const read = await rpc("tools/call", { name: "read_record", arguments: {
    connection_id: connection.id, path: "staging-acceptance.md"
  } });
  expect(read.isError, JSON.stringify({ routes, read })).not.toBe(true);
  expect(read.structuredContent).toMatchObject({ valid: true,
    result: { path: "staging-acceptance.md", body: "Hosted MCP record\n" } });
  expect(routes).toEqual([404]);
  expect(reads).toEqual([{ path: document.path }, { path: document.path }]);

  const route = (collection = collectionId, authorization = routeBearer) => connect.inject({ method: "GET",
    url: `/v1/next/collections/${collection}/route`, headers: { authorization } });
  expect((await route(collectionId, "Bearer invalid-token")).statusCode).toBe(401);
  expect((await route("00000000-0000-4000-8000-000000000001")).statusCode).toBe(401);
  await connectDb.query("UPDATE access_tokens SET expires_at = now() - interval '1 hour' WHERE grant_id = $1", [grants.rows[0]!.id]);
  expect((await route()).statusCode).toBe(401);
  await connectDb.query("UPDATE access_tokens SET expires_at = now() + interval '1 hour' WHERE grant_id = $1", [grants.rows[0]!.id]);

  // Periodic application reconciliation keeps the approved subset; it is a
  // permitted selection, not a manifest change.
  const application = await connectDb.query(
    "SELECT id, family_identity, manifest_digest, requirements, notifications FROM applications WHERE id = $1",
    [binding.application_id]
  );
  await reconcileApplicationGrants(
    connectDb,
    { pushPolicy: vi.fn() } as unknown as RelayHub,
    hostedProvider,
    application.rows[0],
    grants.rows[0]!.id
  );
  const retained = await connectDb.query("SELECT revoked_at FROM grants WHERE id = $1", [grants.rows[0]!.id]);
  expect(retained.rows[0].revoked_at).toBeNull();
  await connectDb.query("UPDATE grants SET revoked_at = now() WHERE id = $1", [grants.rows[0]!.id]);
  expect((await route()).statusCode).toBe(401);
}, 20_000);

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
