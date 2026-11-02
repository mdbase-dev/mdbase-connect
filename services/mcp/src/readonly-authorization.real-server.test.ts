// Read-only MCP authorization against the real Connect control plane (#1103).
// The MCP gateway signs only the file actions paired with its requested
// operations; the existing gateway tests use a fake upstream that accepts any
// proof, so they never compared that signature with the server's expectation.
// Only the hosted storage provider (a separate Rust service) is a test double.
import { afterEach, expect, it, vi } from "vitest";
import type { FileCapability } from "@mdbase-dev/connect-protocol";
import { buildApp as buildConnectServer } from "../../server/src/app.js";
import { createDatabase as createConnectDatabase } from "../../server/src/db.js";
import type { HostedProviderClient, HostedReplicaEnrollment } from "../../server/src/hosted-provider.js";
import { reconcileApplicationGrants } from "../../server/src/features/grants/service.js";
import type { RelayHub } from "../../server/src/relay.js";
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
    rotateReplicaToken: vi.fn(),
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

  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
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
  expect(enrolled).toHaveLength(1);
  expect(enrolled[0]).toMatchObject({
    mode: "read_only",
    fileCapability: { actions: ["list", "read"], scope: { kind: "collection" } }
  });
  // A write file action cannot be approved beyond what the application signed.
  const grants = await connectDb.query<{ id: string; file_capability: FileCapability }>(
    "SELECT id, file_capability FROM grants WHERE hosted_collection_id = $1 AND revoked_at IS NULL",
    [collectionId]
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
    application.rows[0]
  );
  const retained = await connectDb.query("SELECT revoked_at FROM grants WHERE id = $1", [grants.rows[0]!.id]);
  expect(retained.rows[0].revoked_at).toBeNull();
});

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
