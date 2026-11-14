import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { applicationOperationSelectionIsAtomic } from "@mdbase-dev/connect-protocol";
import { parseVersionedAppManifest } from "@mdbase-dev/connect-protocol/manifest";
import { projectNextAuthorizationGroups } from "@mdbase-dev/connect-protocol/next-authorization";
import { MAX_PENDING_AUTHORIZATIONS, READ_OPERATIONS, WRITE_OPERATIONS } from "./oauth.js";
import { ConnectGateway } from "./connect.js";
import { PostgresGrantKeyStore } from "./key-store.js";
import { applicationInstallationId } from "@mdbase-dev/connect/crypto";
import { buildApp } from "./app.js";
import { createDatabase } from "./db.js";
import type { McpRuntimeConfig } from "./config.js";
import { SecretBox, pkceChallenge } from "./security.js";

const MCP_CAPABILITIES = {
  contract_version: 2,
  required: ["collection.read"],
  optional: ["records.create", "records.edit", "records.delete", "definitions.manage"]
} satisfies Parameters<typeof applicationOperationSelectionIsAtomic>[0];

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
    expect(parseVersionedAppManifest(manifest.json()).contractVersion).toBe(2);
    expect(manifest.json().requirements).toEqual({
      access: "full_collection",
      contracts: [],
      capabilities: MCP_CAPABILITIES,
      files: { required: ["list", "read"], optional: ["add", "replace", "move", "delete"], scope: { kind: "collection" } }
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

  it.each([
    ["read-only", READ_OPERATIONS, ["list", "read"]],
    ["writing", [...READ_OPERATIONS, ...WRITE_OPERATIONS], ["list", "read", "add", "replace", "move", "delete"]]
  ] as const)("signs explicit v2 requests for new %s connections", async (_profile, operations, files) => {
    const upstream = await fakeUpstream(globalThis.fetch);
    vi.stubGlobal("fetch", upstream.fetch);
    const db = await createDatabase("memory");
    const config = testConfig();
    const { app, gateway } = await buildApp({ db, config });
    const keyStore = new PostgresGrantKeyStore(db, config.masterKey);
    const key = await keyStore.create("new-v2-key");
    await gateway.createAuthorizationRequest({
      authorizationId: randomUUID(), state: "new", codeChallenge: pkceChallenge("new-v2-verifier"),
      operations: [...operations], collectionId: null, grantKey: key, connectionSetId: randomUUID()
    });
    expect(upstream.authorizationProofs[0]!.binding.contracts).toMatchObject({ semantic_capabilities: 2 });
    expect(upstream.authorizationProofs[0]!.binding.requested_operations).toEqual(operations);
    const registered = JSON.parse(String(upstream.fetch.mock.calls.find(
      ([url]) => String(url).endsWith("/v1/apps/register")
    )![1]!.body));
    expect(registered.manifest.requirements.capabilities).toEqual(MCP_CAPABILITIES);
    expect(applicationOperationSelectionIsAtomic(MCP_CAPABILITIES, operations)).toBe(true);
    // Next consent pairs record and file access; a request without the pair is refused.
    expect(upstream.authorizationProofs[0]!.binding.requested_files).toEqual({ actions: files, scope: { kind: "collection" } });
    expect(projectNextAuthorizationGroups(registered.manifest.requirements, operations).error).toBeUndefined();
    await app.close();
    await db.end();
  });

  it("keeps retained v1 proofs and exact connections usable after loading the v2 application", async () => {
    const upstream = await fakeUpstream(globalThis.fetch);
    vi.stubGlobal("fetch", upstream.fetch);
    const db = await createDatabase("memory");
    const config = testConfig();
    const keyStore = new PostgresGrantKeyStore(db, config.masterKey);
    const key = await keyStore.create("retained-v1-key");
    const legacy = new ConnectGateway(db, config.masterKey, keyStore, config.connectUrl, {
      manifest_version: 1,
      id: "dev.mdbase.mcp",
      name: "mdbase",
      homepage: config.publicUrl,
      redirect_uris: [`${config.publicUrl}/oauth/connect/callback`],
      requirements: { access: "full_collection", contracts: [] }
    }, `${config.publicUrl}/oauth/connect/callback`);
    await legacy.createAuthorizationRequest({
      authorizationId: randomUUID(), state: "retained", codeChallenge: pkceChallenge("retained-v1-verifier"), operations: ["query", "update"],
      collectionId: null, grantKey: key, connectionSetId: randomUUID()
    });
    expect(upstream.authorizationProofs[0]!.binding.contracts).toMatchObject({ semantic_capabilities: 1 });
    expect(upstream.authorizationProofs[0]!.binding.requested_operations).toEqual(["query", "update"]);
    const setId = "90000000-0000-4000-8000-000000000001";
    await db.query("INSERT INTO mcp_connection_sets (id) VALUES ($1)", [setId]);
    const connection = await legacy.exchangeAuthorization({
      authorizationId: upstream.authorizationProofs[0]!.binding.authorization_id, manifestDigest: "a".repeat(64),
      code: "first-upstream-code", verifier: "verifier", applicationId,
      connectionSetId: setId, keyHandle: key.handle
    });
    const { app, gateway } = await buildApp({ db, config });
    expect(await gateway.listConnections(setId)).toEqual([connection]);
    await db.query("UPDATE mcp_connections SET access_expires_at = now() - interval '1 second'");
    await expect(gateway.operation(setId, connection.id, "query", {})).resolves.toMatchObject({ valid: true });
    expect(upstream.refreshProofs).toHaveLength(1);
    expect((await gateway.listConnections(setId))[0]).toMatchObject({
      id: connection.id, operations: ["query", "update"]
    });
    await expect(gateway.operation(setId, connection.id, "rename", {})).rejects.toMatchObject({
      code: "insufficient_collection_access"
    });
    expect(upstream.authorizationProofs).toHaveLength(1);
    expect(await keyStore.get(key.handle)).not.toBeNull();
    await app.close();
    await db.end();
  });

  it("completes native OAuth, preserves host state and PKCE, rejects replay, and refreshes the same grant", async () => {
    const fixture = await nativeOAuth();
    const { app, db, oauth, gateway, callback, clientId, verifier, upstream } = fixture;
    try {
      const response = await callback();
      expect(response.statusCode).toBe(302);
      const redirect = new URL(response.headers.location!);
      expect(redirect.origin).toBe("https://client.example");
      expect(redirect.searchParams.get("state")).toBe("host-state");
      const exchange = (client = clientId, key = verifier) => app.inject({
        method: "POST", url: "/oauth/token", payload: {
          grant_type: "authorization_code", code: redirect.searchParams.get("code"),
          client_id: client, redirect_uri: "https://client.example/callback", code_verifier: key
        }
      });
      expect((await exchange("another-client")).statusCode).toBe(400);
      expect((await exchange(clientId, "x".repeat(50))).statusCode).toBe(400);
      const token = await exchange();
      expect(token.statusCode).toBe(200);
      expect((await exchange()).statusCode).toBe(400);
      expect((await callback()).statusCode).toBe(400);
      const context = await oauth.authenticate(token.json().access_token);
      const [connection] = await gateway.listConnections(context!.connectionSetId);
      expect(connection).toMatchObject({ collection_id: firstCollectionId, authority: "remote" });
      const warning = vi.spyOn(app.log, "warn");
      await db.query("UPDATE mcp_connections SET access_expires_at = now() - interval '1 second'");
      await expect(gateway.operation(context!.connectionSetId, connection!.id, "query", {})).rejects.toMatchObject({
        code: "no_device_registered", message: expect.stringContaining("turn on sync")
      });
      expect(upstream.refreshProofs).toHaveLength(1);
      expect(upstream.localInputs).toEqual([]);
      expect(upstream.hostedInputs).toEqual([]);
      expect(upstream.operationAuthorizations).toEqual([]);
      expect(warning).toHaveBeenCalledWith({ event: "mcp_native_routing_failed", reason: "no_device_registered" }, "Native MCP routing failed");
    } finally { await app.close(); await db.end(); }
  });

  it("claims a native callback only once when duplicate callbacks race", async () => {
    const fixture = await nativeOAuth();
    try {
      const responses = await Promise.all([fixture.callback(), fixture.callback()]);
      expect(responses.map(response => response.statusCode).sort()).toEqual([302, 400]);
      expect((await fixture.db.query("SELECT id FROM mcp_connections")).rows).toHaveLength(1);
      expect((await fixture.db.query("SELECT id FROM mcp_authorization_codes")).rows).toHaveLength(1);
      expect(fixture.upstream.fetch.mock.calls.filter(([url]) => String(url).endsWith("/oauth/token"))).toHaveLength(1);
    } finally { await fixture.app.close(); await fixture.db.end(); }
  });

  it("presents each MCP sign-in to Connect as its own installation, kept for collections added in that sign-in", async () => {
    const fixture = await nativeOAuth();
    try {
      const sets = (await fixture.db.query<{ connection_set_id: string }>("SELECT connection_set_id FROM mcp_upstream_authorizations")).rows;
      await fixture.oauth.beginAuthorization(Object.fromEntries(authorizeQuery(fixture.clientId)));
      const ticket = new URL(await fixture.oauth.createConnectionTicket({
        clientId: fixture.clientId, connectionSetId: sets[0]!.connection_set_id, scopes: ["mdbase:read"]
      }));
      await fixture.oauth.consumeConnectionTicket(ticket.searchParams.get("ticket")!);
      const [first, second, added] = fixture.upstream.authorizationProofs.map(proof => proof.binding.application_installation_id);
      expect(first).not.toBe(second);
      expect(added).toBe(first);
    } finally { await fixture.app.close(); await fixture.db.end(); }
  });

  it("keeps native connections bound to the earlier gateway-wide installation working", async () => {
    let shared = "";
    const fixture = await nativeOAuth({ mutateToken: token => { token.native_completion.application_installation_id = shared; } });
    try {
      const keys = new PostgresGrantKeyStore(fixture.db, testConfig().masterKey);
      shared = await applicationInstallationId(await keys.create(`mcp-application-identity:v3:https://connect.example:${applicationId}`));
      expect((await fixture.callback()).statusCode).toBe(302);
      const row = (await fixture.db.query("SELECT id, connection_set_id FROM mcp_connections")).rows[0];
      await fixture.db.query("UPDATE mcp_connections SET access_expires_at = now() - interval '1 second'");
      // Binding and refresh pass; only the (fake) route has no device.
      await expect(fixture.gateway.operation(row.connection_set_id, row.id, "query", {})).rejects.toMatchObject({ code: "no_device_registered" });
      expect(fixture.upstream.refreshProofs).toHaveLength(1);
    } finally { await fixture.app.close(); await fixture.db.end(); }
  });

  it.each(["collection_id", "grant_id"])("binds native operations to the stored completion's %s", async field => {
    const fixture = await nativeOAuth();
    try {
      expect((await fixture.callback()).statusCode).toBe(302);
      const row = (await fixture.db.query("SELECT id, connection_set_id FROM mcp_connections")).rows[0];
      await fixture.db.query(`UPDATE mcp_connections SET ${field} = $1`, [randomUUID()]);
      const calls = fixture.upstream.fetch.mock.calls.length;
      await expect(fixture.gateway.operation(row.connection_set_id, row.id, "query", {})).rejects.toMatchObject({ code: "grant_key_mismatch" });
      expect(fixture.upstream.fetch.mock.calls).toHaveLength(calls);
    } finally { await fixture.app.close(); await fixture.db.end(); }
  });

  it.each(["grant-key", "noise-key", "host-expired"])("rejects a native callback when %s is missing or inactive", async failure => {
    const fixture = await nativeOAuth();
    try {
      if (failure === "host-expired") await fixture.db.query("UPDATE mcp_authorization_requests SET expires_at = now() - interval '1 second'");
      else {
        const pending = (await fixture.db.query("SELECT key_handle FROM mcp_upstream_authorizations")).rows[0];
        await fixture.db.query("DELETE FROM mcp_grant_keys WHERE handle = $1", [
          failure === "grant-key" ? pending.key_handle : `mcp-noise:${pending.key_handle}`
        ]);
      }
      expect((await fixture.callback()).statusCode).toBe(failure === "host-expired" ? 400 : 500);
      expect((await fixture.db.query("SELECT id FROM mcp_connections")).rows).toEqual([]);
    } finally { await fixture.app.close(); await fixture.db.end(); }
  });

  it.each([
    "authorization_request_id", "application_id", "application_declaration_id",
    "application_manifest_digest", "application_installation_id", "application_origin",
    "collection_id", "grant_id", "grant_signing_public_key", "client_noise_public_key"
  ])("rejects a native completion with a mismatched %s before saving a connection", async field => {
    const fixture = await nativeOAuth({ mutateToken: token => {
      const completion = token.native_completion;
      completion[field] = field.endsWith("public_key") ? "b".repeat(completion[field].length)
        : field === "application_manifest_digest" ? "b".repeat(64)
        : field === "application_origin" ? "https://other.example"
        : field === "application_declaration_id" ? "dev.other.app" : randomUUID();
    } });
    try {
      expect((await fixture.callback()).statusCode).toBe(500);
      expect((await fixture.db.query("SELECT id FROM mcp_connections")).rows).toEqual([]);
      expect((await fixture.db.query("SELECT id FROM mcp_authorization_codes")).rows).toEqual([]);
    } finally { await fixture.app.close(); await fixture.db.end(); }
  });

  it.each(["state", "expired", "replayed-code"])("rejects a native callback with %s", async failure => {
    const fixture = await nativeOAuth({ rejectCode: failure === "replayed-code" });
    try {
      if (failure === "expired") await fixture.db.query("UPDATE mcp_upstream_authorizations SET expires_at = now() - interval '1 second'");
      const response = await fixture.callback(failure === "state" ? "wrong-state" : undefined);
      expect(response.statusCode).toBe(failure === "replayed-code" ? 500 : 400);
      expect((await fixture.db.query("SELECT id FROM mcp_connections")).rows).toEqual([]);
      if (failure !== "replayed-code") expect(fixture.upstream.fetch.mock.calls.some(([url]) => String(url).endsWith("/oauth/token"))).toBe(false);
    } finally { await fixture.app.close(); await fixture.db.end(); }
  });

  it.each(["stripped-legacy", "native-with-legacy-encryption", "native-with-legacy-authority", "wrong-origin"])("rejects %s instead of skipping legacy checks", async attack => {
    const fixture = await nativeOAuth({ native: attack !== "stripped-legacy", mutateToken: token => {
      if (attack === "stripped-legacy") { token.encryption = null; delete token.authority; }
      if (attack === "native-with-legacy-encryption") token.encryption = {
        protocol_version: 1, suite: "P256-HKDF-SHA256-AES256GCM", key_id: "legacy", scope_epoch: 1,
        connector_id: randomUUID(), collection_id: token.collection_id,
        application_agreement_public_key: "a".repeat(87), connector_agreement_public_key: "a".repeat(87)
      };
      if (attack === "native-with-legacy-authority") token.authority = {
        operations_url: "https://legacy.example/operations", sync_url: "https://legacy.example/sync", files_url: "https://legacy.example/files",
        replica_id: randomUUID(), access_token: "legacy-token", proof_public_key: token.native_completion.grant_signing_public_key
      };
      if (attack === "wrong-origin") token.application_origin = "https://other.example";
    } });
    try {
      expect((await fixture.callback()).statusCode).toBe(500);
      expect((await fixture.db.query("SELECT id FROM mcp_connections")).rows).toEqual([]);
    } finally { await fixture.app.close(); await fixture.db.end(); }
  });

  it.each(["removed", "changed", "legacy-upgrade"])("rejects a %s native completion on refresh", async attack => {
    let refreshing = false;
    const fixture = await nativeOAuth({ native: () => attack !== "legacy-upgrade" || refreshing, mutateToken: token => {
      if (!refreshing) return;
      if (attack === "removed") delete token.native_completion;
      if (attack === "changed") token.native_completion.account_id = randomUUID();
    } });
    try {
      expect((await fixture.callback()).statusCode).toBe(302);
      const row = (await fixture.db.query("SELECT id, connection_set_id, credentials_ciphertext FROM mcp_connections")).rows[0];
      refreshing = true;
      await fixture.db.query("UPDATE mcp_connections SET access_expires_at = now() - interval '1 second'");
      const run = vi.spyOn(fixture.gateway.next, "run");
      await expect(fixture.gateway.operation(row.connection_set_id, row.id, "query", {})).rejects.toBeDefined();
      expect(run).not.toHaveBeenCalled();
      expect((await fixture.db.query("SELECT credentials_ciphertext FROM mcp_connections")).rows[0].credentials_ciphertext).toBe(row.credentials_ciphertext);
    } finally { await fixture.app.close(); await fixture.db.end(); }
  });

  it("keeps malformed and oversized request bodies out of the server-error path", async () => {
    const db = await createDatabase("memory");
    const { app } = await buildApp({ db, config: testConfig() });

    const malformed = await app.inject({
      method: "POST",
      url: "/oauth/register",
      headers: { "content-type": "application/json" },
      payload: "{"
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual({
      error: "invalid_request",
      error_description: "The request body is invalid."
    });

    const oversized = await app.inject({
      method: "POST",
      url: "/oauth/register",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ padding: "x".repeat(2 * 1024 * 1024 + 1) })
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json()).toEqual({
      error: "invalid_request",
      error_description: "The request body exceeds the allowed size."
    });

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
    expect(firstUpstream.pathname).toBe("/oauth/authorize");
    expect(firstUpstream.searchParams.get("request_id"))
      .toBe(upstream.authorizationProofs[0]?.binding.authorization_id);
    expect(upstream.authorizationProofs[0]?.binding).toMatchObject({
      protocol_version: 5,
      application_id: applicationId,
      application_declaration_id: "dev.mdbase.mcp",
      flow: "authorization_code",
      contracts: {
        operation_transport: 3,
        authorization_binding: 5,
        semantic_capabilities: 2,
        durable_mutation: 1
      }
    });
    expect(upstream.authorizationProofs[0]?.binding.requested_operations)
      .toEqual([...READ_OPERATIONS, ...WRITE_OPERATIONS]);
    expect(upstream.authorizationProofs[0]?.binding.requested_operations)
      .toContain("assess_type_pack");
    expect(upstream.authorizationProofs[0]?.binding.requested_operations)
      .not.toContain("create_view_source");

    const firstCallback = await app.inject({
      method: "GET",
      url: `/oauth/connect/callback?${new URLSearchParams({
        state: upstream.authorizationProofs[0]!.binding.state!,
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
    const accessToken = refreshed.json().access_token as string;
    const context = await oauth.authenticate(accessToken);
    expect(context).not.toBeNull();

    const addUrl = await oauth.createConnectionTicket(context!);
    const additional = await app.inject({ method: "GET", url: `${new URL(addUrl).pathname}${new URL(addUrl).search}` });
    expect(additional.statusCode).toBe(302);
    const secondUpstream = new URL(additional.headers.location!);
    expect(secondUpstream.searchParams.get("request_id"))
      .toBe(upstream.authorizationProofs[1]?.binding.authorization_id);
    const secondCallback = await app.inject({
      method: "GET",
      url: `/oauth/connect/callback?${new URLSearchParams({
        state: upstream.authorizationProofs[1]!.binding.state!,
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
    const reconnectUrl = await oauth.createConnectionTicket(context!, connections[0].id);
    const reconnect = await app.inject({
      method: "GET",
      url: `${new URL(reconnectUrl).pathname}${new URL(reconnectUrl).search}`
    });
    expect(reconnect.statusCode).toBe(302);
    expect(new URL(reconnect.headers.location!).searchParams.get("request_id"))
      .toBe(upstream.authorizationProofs[2]?.binding.authorization_id);
    expect(upstream.authorizationProofs[2]?.binding.collection_id)
      .toBe(connections[0].collection_id);

    const stored = await db.query<{ credentials_ciphertext: string }>(
      "SELECT credentials_ciphertext FROM mcp_connections"
    );
    expect(stored.rows).toHaveLength(2);
    expect(stored.rows.every((row) => !row.credentials_ciphertext.includes("upstream-access"))).toBe(true);
    await db.query(
      "UPDATE mcp_connections SET access_expires_at = now() - interval '1 second' WHERE collection_id = $1",
      [secondCollectionId]
    );

    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const client = new Client({ name: "gateway-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${address}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${accessToken}` } }
    });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("add_connection");
    expect(tools.tools.map((tool) => tool.name)).toContain("reconnect_collection");
    expect(tools.tools.map((tool) => tool.name)).toContain("create_record");
    expect(tools.tools.map((tool) => tool.name)).toContain("release_query_cursor");
    const readRecord = tools.tools.find((tool) => tool.name === "read_record")!;
    expect(readRecord.inputSchema.required).toContain("path");
    expect(readRecord.inputSchema.properties).not.toHaveProperty("output");
    expect(readRecord.inputSchema.properties).not.toHaveProperty("file_id");
    const createRecord = tools.tools.find((tool) => tool.name === "create_record")!;
    expect((createRecord.inputSchema.required as string[])).not.toContain("frontmatter");
    const listed = await client.callTool({ name: "list_connections", arguments: {} });
    expect((listed.structuredContent as any).connections).toHaveLength(2);
    const queried = await client.callTool({
      name: "query_records",
      arguments: {
        connection_id: connections[1].id,
        types: ["note"],
        limit: 10,
        pagination: "cursor"
      }
    });
    expect(queried.structuredContent).toMatchObject({
      valid: true,
      result: { results: [{ path: "notes/second.md" }] }
    });
    expect(upstream.operationAuthorizations).toContain("Bearer hosted-access-two-refreshed");
    expect(upstream.refreshProofs).toHaveLength(1);
    expect(upstream.operationProofs).toHaveLength(1);
    for (const proof of [...upstream.refreshProofs, ...upstream.operationProofs]) {
      expect(proof.version).toBe("1");
      expect(proof.timestamp).toMatch(/^\d+$/);
      expect(proof.nonce).toMatch(/^[0-9a-f-]{36}$/);
      expect(proof.signature).toMatch(/^[A-Za-z0-9_-]+$/);
    }
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
    expect(upstream.operationOrigins).toEqual([
      "https://mcp.example",
      "https://mcp.example"
    ]);

    const metadata = await client.callTool({ name: "query_records", arguments: { connection_id: connections[1].id, output: "metadata", select: ["title"] } });
    expect(metadata.isError).not.toBe(true);
    expect(metadata.structuredContent).toMatchObject({ result: { output: "metadata", results: [{ revision: "r1", values: { title: "Second" } }] } });
    expect((metadata.structuredContent as any).result.results[0]).not.toHaveProperty("frontmatter");
    const localBefore = upstream.localInputs.length;
    const unsupported = await client.callTool({ name: "query_records", arguments: { connection_id: connections[0].id, output: "metadata" } });
    expect(unsupported.structuredContent).toMatchObject({ error: { code: "unsupported_authority_feature" } });
    expect(upstream.localInputs.slice(localBefore)).toEqual([{}]); // discovery only; no extended query
    for (const flags of [[], ["query-metadata-v1"], ["future-feature"], null]) {
      upstream.features.hosted = flags;
      const before = upstream.hostedInputs.length;
      const result = await client.callTool({ name: "query_records", arguments: { connection_id: connections[1].id, output: "metadata" } });
      expect(result.isError).toBe(true);
      expect(upstream.hostedInputs.slice(before)).toEqual([{}]);
    }
    upstream.features.hosted = ["query-metadata-v1", "query-record-revisions-v1"];
    const invalidMetadata = await client.callTool({ name: "query_records", arguments: { connection_id: connections[1].id, output: "metadata", include_body: true } });
    expect(invalidMetadata.structuredContent).toMatchObject({ error: { code: "invalid_request" } });
    // Existing record-only grants (no file capability) keep read and query tools.
    for (const connection of connections) {
      const record = await client.callTool({ name: "read_record", arguments: { connection_id: connection.id, path: "notes/test.md" } });
      expect(record.isError).not.toBe(true);
      expect(record.structuredContent).toMatchObject({ valid: true, result: { path: "notes/test.md" } });
    }
    const changes = await client.callTool({ name: "list_changes", arguments: { connection_id: connections[1].id } });
    expect(changes.structuredContent).toMatchObject({ events: [changedEvent], typed_events: [
      { kind: "record.updated", revision: "r2", previousRevision: "r1", bodyChanged: false, changedFields: ["/title"], raw: changedEvent }
    ] });
    const hostedCalls = upstream.hostedInputs.length;
    await expect(gateway.operation("90000000-0000-4000-8000-000000000001", connections[1].id, "query", {})).rejects.toMatchObject({ code: "connection_not_found" });
    expect(upstream.hostedInputs).toHaveLength(hostedCalls);

    const released = await client.callTool({
      name: "release_query_cursor",
      arguments: { connection_id: connections[1].id, cursor: "query-cursor-two" }
    });
    expect(released.isError).not.toBe(true);
    expect(upstream.hostedInputs).toContainEqual({ release_cursor: "query-cursor-two" });

    const mutationId = "01977777-7777-7777-8777-777777777777";
    const created = await client.callTool({
      name: "create_record",
      arguments: {
        connection_id: connections[1].id,
        path: "notes/created.md",
        body: "Created through MCP.",
        mutation_id: mutationId
      }
    });
    expect(created.structuredContent).toMatchObject({
      mutation_receipt: { request_id: mutationId },
      outcome: { valid: true, result: { path: "notes/created.md" } }
    });
    await client.callTool({
      name: "create_record",
      arguments: {
        connection_id: connections[1].id,
        path: "notes/created.md",
        body: "Created through MCP.",
        mutation_id: mutationId
      }
    });
    expect(upstream.hostedRequestIds.slice(-2)).toEqual([mutationId, mutationId]);

    const documentMutationId = "01977777-7777-7777-8777-777777777778";
    const documentOnly = await client.callTool({
      name: "update_record",
      arguments: {
        connection_id: connections[1].id,
        path: "notes/created.md",
        document: "---\ntitle: Replaced\n---\nReplacement body.\n",
        mutation_id: documentMutationId
      }
    });
    expect(documentOnly.structuredContent).toMatchObject({
      mutation_receipt: { request_id: documentMutationId },
      outcome: { valid: true }
    });
    expect(upstream.hostedInputs).toContainEqual({
      path: "notes/created.md",
      document: "---\ntitle: Replaced\n---\nReplacement body.\n"
    });
    const emptyUpdate = await client.callTool({
      name: "update_record",
      arguments: { connection_id: connections[1].id, path: "notes/created.md" }
    });
    expect(emptyUpdate.isError).toBe(true);

    for (const [name, typeMutationId, arguments_] of [
      [
        "create_type",
        "01977777-7777-7777-8777-777777777779",
        { document: "---\nkind: mdbase.type\nname: note\n---\n" }
      ],
      [
        "update_type",
        "01977777-7777-7777-8777-777777777780",
        {
          name: "note",
          document: "---\nkind: mdbase.type\nname: note\n---\n",
          if_revision: "sha256:type-one"
        }
      ]
    ] as const) {
      const mutation = await client.callTool({
        name,
        arguments: {
          connection_id: connections[1].id,
          ...arguments_,
          mutation_id: typeMutationId
        }
      });
      expect(mutation.structuredContent).toMatchObject({
        mutation_receipt: { request_id: typeMutationId },
        outcome: { valid: true }
      });
      expect(upstream.hostedRequestIds).toContain(typeMutationId);
    }

    await expect(gateway.operation(
      context!.connectionSetId,
      connections[1].id,
      "query",
      { where: "__mismatched_response__" }
    )).rejects.toMatchObject({ code: "invalid_operation_response" });
    const cancellation = new AbortController();
    cancellation.abort(new DOMException("Cancelled by MCP host", "AbortError"));
    await expect(gateway.operation(
      context!.connectionSetId,
      connections[1].id,
      "query",
      {},
      { signal: cancellation.signal }
    )).rejects.toMatchObject({ name: "AbortError" });

    await client.close();
    await app.close();
    await db.end();
  });
});

describe("open OAuth endpoints", () => {
  it("limits registration and authorization per client address", async () => {
    const db = await createDatabase("memory");
    const { app } = await buildApp({ db, config: testConfig() });
    try {
      const register = () => app.inject({ method: "POST", url: "/oauth/register", payload: { redirect_uris: ["https://client.example/callback"] } });
      for (let attempt = 0; attempt < 30; attempt += 1) expect((await register()).statusCode).toBe(201);
      expect((await register()).statusCode).toBe(429);
      const authorize = () => app.inject({ method: "GET", url: `/oauth/authorize?${authorizeQuery("unregistered")}` });
      for (let attempt = 0; attempt < 30; attempt += 1) expect((await authorize()).statusCode).toBe(400);
      expect((await authorize()).statusCode).toBe(429);
      const oversized = await app.inject({ method: "POST", url: "/oauth/register", remoteAddress: "192.0.2.1", payload: {
        redirect_uris: ["https://client.example/callback"], client_uri: `https://client.example/${"x".repeat(16 * 1024)}`
      } });
      expect(oversized.statusCode).toBe(413);
      expect((await db.query("SELECT id FROM mcp_clients")).rows).toHaveLength(30);
    } finally { await app.close(); await db.end(); }
  });

  it("refuses new authorizations while too many are pending, before contacting Connect", async () => {
    const upstream = await fakeUpstream(globalThis.fetch, { native: true });
    vi.stubGlobal("fetch", upstream.fetch);
    const db = await createDatabase("memory");
    const { app, oauth } = await buildApp({ db, config: testConfig() });
    try {
      const { client_id: clientId } = await oauth.registerClient({ redirect_uris: ["https://client.example/callback"] }) as { client_id: string };
      const setId = randomUUID();
      await db.query("INSERT INTO mcp_connection_sets (id) VALUES ($1)", [setId]);
      const expires = new Date(Date.now() + 10 * 60_000);
      const rows = Array.from({ length: MAX_PENDING_AUTHORIZATIONS }, (_, index) =>
        `('${randomUUID()}', $1, $2, 'https://client.example/callback', 'challenge-${index}', 'https://mcp.example/mcp', '["mdbase:read"]'::jsonb, $3)`);
      await db.query(
        `INSERT INTO mcp_authorization_requests
           (id, client_id, connection_set_id, redirect_uri, code_challenge, resource, scopes, expires_at)
         VALUES ${rows.join(", ")}`,
        [clientId, setId, expires]
      );
      const refused = await app.inject({ method: "GET", url: `/oauth/authorize?${authorizeQuery(clientId)}` });
      expect(refused.statusCode).toBe(503);
      expect(refused.json()).toMatchObject({ error: "temporarily_unavailable" });
      expect(upstream.fetch).not.toHaveBeenCalled();

      await db.query("UPDATE mcp_authorization_requests SET completed_at = now() WHERE code_challenge = 'challenge-0'");
      expect((await app.inject({ method: "GET", url: `/oauth/authorize?${authorizeQuery(clientId)}` })).statusCode).toBe(302);
    } finally { await app.close(); await db.end(); }
  });

  it("removes expired authorizations and never-used registrations but keeps live connections", async () => {
    const fixture = await nativeOAuth();
    const { app, db, oauth, gateway } = fixture;
    try {
      const callback = new URL((await fixture.callback()).headers.location!);
      const token = await oauth.exchangeToken({
        grant_type: "authorization_code", code: callback.searchParams.get("code"), client_id: fixture.clientId,
        redirect_uri: "https://client.example/callback", code_verifier: fixture.verifier
      });
      const [connection] = (await db.query<{ key_handle: string; connection_set_id: string }>("SELECT key_handle, connection_set_id FROM mcp_connections")).rows;
      await oauth.beginAuthorization(Object.fromEntries(authorizeQuery(fixture.clientId)));
      const unused = await oauth.registerClient({ redirect_uris: ["https://other.example/callback"] });
      const authorizationKeys = "SELECT handle FROM mcp_grant_keys WHERE handle LIKE 'mcp:%' OR handle LIKE 'mcp-noise:%'";
      expect((await db.query(authorizationKeys)).rows).toHaveLength(4);
      expect((await db.query("SELECT handle FROM mcp_grant_keys WHERE handle LIKE 'mcp-installation:%'")).rows).toHaveLength(2);

      await oauth.pruneExpiredState(Date.now() + 8 * 24 * 60 * 60_000);

      const remaining = async (table: string, column = "id") =>
        (await db.query(`SELECT ${column} AS value FROM ${table}`)).rows.map(row => row.value).sort();
      expect(await remaining("mcp_connection_sets")).toEqual([connection!.connection_set_id]);
      expect(await remaining("mcp_authorization_requests")).toEqual([]);
      expect(await remaining("mcp_upstream_authorizations")).toEqual([]);
      expect(await remaining("mcp_clients")).toEqual([fixture.clientId]);
      expect(await remaining("mcp_clients")).not.toContain(unused.client_id);
      expect((await db.query(authorizationKeys)).rows.map(row => row.handle).sort()).toEqual(
        [connection!.key_handle, `mcp-noise:${connection!.key_handle}`].sort()
      );
      // Only the live set's installation identity is kept.
      expect((await remaining("mcp_grant_keys", "handle")).filter(handle => handle.startsWith("mcp-installation:")))
        .toEqual([`mcp-installation:${connection!.connection_set_id}`]);
      const context = await oauth.authenticate(token.access_token as string);
      expect(await gateway.listConnections(context!.connectionSetId)).toHaveLength(1);
    } finally { await app.close(); await db.end(); }
  });
});

describe("upstream PKCE verifier", () => {
  it("is stored encrypted and still completes the Connect exchange", async () => {
    const fixture = await nativeOAuth();
    try {
      const challenge = fixture.upstream.authorizationProofs[0]!.binding.code_challenge;
      const [stored] = (await fixture.db.query<{ code_verifier: string }>("SELECT code_verifier FROM mcp_upstream_authorizations")).rows;
      expect(pkceChallenge(stored!.code_verifier)).not.toBe(challenge);

      expect((await fixture.callback()).statusCode).toBe(302);
      const exchange = fixture.upstream.fetch.mock.calls.find(([url]) => String(url) === "https://connect.example/oauth/token");
      expect(pkceChallenge(new URLSearchParams(String(exchange![1]!.body)).get("code_verifier")!)).toBe(challenge);
    } finally { await fixture.app.close(); await fixture.db.end(); }
  });
});

describe("refresh token rotation", () => {
  it("revokes every token from the authorization when a rotated refresh token returns after the race window", async () => {
    const fixture = await nativeOAuth();
    const { app, db, oauth } = fixture;
    try {
      const callback = new URL((await fixture.callback()).headers.location!);
      const token = (body: Record<string, unknown>) => app.inject({ method: "POST", url: "/oauth/token", payload: body });
      const refresh = (refreshToken: unknown, clientId = fixture.clientId) =>
        token({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId });
      const first = (await token({
        grant_type: "authorization_code", code: callback.searchParams.get("code"), client_id: fixture.clientId,
        redirect_uri: "https://client.example/callback", code_verifier: fixture.verifier
      })).json();
      expect((await refresh(first.refresh_token, "another-client")).statusCode).toBe(400);
      const second = await refresh(first.refresh_token);
      expect(second.statusCode).toBe(200);
      const third = await refresh(second.json().refresh_token);
      expect(third.statusCode).toBe(200);
      expect(await oauth.authenticate(third.json().access_token)).not.toBeNull();

      // A second request with a token rotated moments ago is a client racing
      // itself: refused, and the tokens the first request received still work.
      const raced = await refresh(first.refresh_token);
      expect(raced.statusCode).toBe(400);
      expect(raced.json()).toMatchObject({ error: "invalid_grant" });
      expect(await oauth.authenticate(third.json().access_token)).not.toBeNull();

      await db.query("UPDATE mcp_refresh_tokens SET used_at = $1 WHERE used_at IS NOT NULL", [new Date(Date.now() - 60_000)]);
      const reused = await refresh(first.refresh_token);
      expect(reused.statusCode).toBe(400);
      expect(reused.json()).toMatchObject({ error: "invalid_grant" });
      expect(await oauth.authenticate(third.json().access_token)).toBeNull();
      expect(await oauth.authenticate(first.access_token)).toBeNull();
      expect((await refresh(third.json().refresh_token)).statusCode).toBe(400);
      for (const table of ["mcp_refresh_tokens", "mcp_access_tokens"]) {
        expect((await db.query(`SELECT id FROM ${table} WHERE revoked_at IS NULL`)).rows).toEqual([]);
      }
    } finally { await app.close(); await db.end(); }
  });
});

const authorizeQuery = (clientId: string) => new URLSearchParams({
  response_type: "code", client_id: clientId, redirect_uri: "https://client.example/callback",
  code_challenge: pkceChallenge("host-pkce-verifier-that-is-long-enough-for-s256-0002"), code_challenge_method: "S256"
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

async function nativeOAuth(options: Parameters<typeof fakeUpstream>[1] = {}) {
  const upstream = await fakeUpstream(globalThis.fetch, { native: true, ...options });
  vi.stubGlobal("fetch", upstream.fetch);
  const db = await createDatabase("memory");
  const runtime = await buildApp({ db, config: testConfig() });
  const client = await runtime.oauth.registerClient({ redirect_uris: ["https://client.example/callback"] });
  const clientId = client.client_id as string;
  const verifier = "host-pkce-verifier-that-is-long-enough-for-s256-0001";
  await runtime.oauth.beginAuthorization({
    response_type: "code", client_id: clientId, redirect_uri: "https://client.example/callback",
    code_challenge: pkceChallenge(verifier), code_challenge_method: "S256", state: "host-state"
  });
  const callback = (state = upstream.authorizationProofs[0]!.binding.state!) => runtime.app.inject({
    method: "GET", url: `/oauth/connect/callback?${new URLSearchParams({ state, code: "first-upstream-code" })}`
  });
  return { ...runtime, db, upstream, callback, clientId, verifier };
}

async function fakeUpstream(realFetch: typeof fetch, options: {
  native?: boolean | (() => boolean);
  mutateToken?: (token: any) => void;
  rejectCode?: boolean;
} = {}) {
  const applicationAgreementPublicKeys: string[] = [];
  const noiseKeys: string[] = [];
  const applicationSigningPublicKeys: string[] = [];
  const authorizationProofs: Array<{
    binding: {
      authorization_id: string;
      state?: string;
      grant_agreement_public_key: string;
      grant_signing_public_key: string;
      [key: string]: unknown;
    };
    signature: string;
  }> = [];
  const operationAuthorizations: string[] = [];
  const operationOrigins: string[] = [];
  const refreshProofs: AuthorityProofHeaders[] = [];
  const operationProofs: AuthorityProofHeaders[] = [];
  const localInputs: unknown[] = [];
  const hostedInputs: unknown[] = [];
  const hostedRequestIds: string[] = [];
  const features: { hosted: unknown } = { hosted: ["query-metadata-v1", "query-record-revisions-v1"] };
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
      return Response.json({
        application: {
          id: applicationId,
          manifest_digest: "a".repeat(64)
        }
      });
    }
    if (url.href === "https://connect.example/oauth/authorization_request") {
      const body = new URLSearchParams(String(init?.body));
      const proof = JSON.parse(
        body.get("application_authorization")!
      ) as typeof authorizationProofs[number];
      authorizationProofs.push(proof);
      noiseKeys.push(JSON.parse(body.get("client_noise_key")!).public_key);
      applicationAgreementPublicKeys.push(proof.binding.grant_agreement_public_key);
      applicationSigningPublicKeys.push(proof.binding.grant_signing_public_key);
      return Response.json({
        authorization_id: proof.binding.authorization_id,
        authorization_uri:
          `https://connect.example/oauth/authorize?request_id=${proof.binding.authorization_id}`,
        expires_in: 600
      });
    }
    if (url.href === "https://connect.example/oauth/token") {
      const body = new URLSearchParams(String(init?.body));
      const refreshing = body.get("grant_type") === "refresh_token";
      const second = body.get("code") === "second-upstream-code"
        || body.get("refresh_token")?.startsWith("upstream-refresh-two") === true;
      if (refreshing) refreshProofs.push(proofHeaders(init));
      if (options.rejectCode) return Response.json({ error: { code: "invalid_grant" } }, { status: 400 });
      const token: any = {
        access_token: second
          ? (refreshing ? "upstream-access-two-refreshed" : "upstream-access-two")
          : (refreshing ? "upstream-access-one-refreshed" : "upstream-access-one"),
        refresh_token: second
          ? (refreshing ? "upstream-refresh-two-refreshed" : "upstream-refresh-two")
          : (refreshing ? "upstream-refresh-one-refreshed" : "upstream-refresh-one"),
        token_type: "Bearer",
        expires_in: 3_600,
        refresh_expires_in: 2_592_000,
        collection_id: second ? secondCollectionId : firstCollectionId,
        collection_name: second ? "Second collection" : "First collection",
        operations: authorizationProofs[second ? 1 : 0]!.binding.requested_operations,
        scope: { contracts: [], access: "full_collection" },
        grant_id: second ? secondGrantId : firstGrantId,
        encryption: second ? null : {
          protocol_version: 1,
          suite: "P256-HKDF-SHA256-AES256GCM",
          key_id: "local-key-1",
          scope_epoch: 1,
          connector_id: "50000000-0000-4000-8000-000000000001",
          collection_id: firstCollectionId,
          application_agreement_public_key: applicationAgreementPublicKeys[0],
          connector_agreement_public_key: connectorPublicKey
        },
        ...(second ? { authority: {
          operations_url: `https://sync.example/v1/authorities/${secondCollectionId}/operations`,
          sync_url: `https://sync.example/v1/authorities/${secondCollectionId}/sync`,
          files_url: `https://sync.example/v1/authorities/${secondCollectionId}/files`,
          replica_id: "40000000-0000-4000-8000-000000000002",
          access_token: refreshing ? "hosted-access-two-refreshed" : "hosted-access-two",
          proof_public_key: applicationSigningPublicKeys[1]
        } } : {})
      };
      if (typeof options.native === "function" ? options.native() : options.native) {
        const binding = authorizationProofs[0]!.binding;
        token.encryption = null;
        delete token.authority;
        token.application_origin = "https://mcp.example";
        token.native_completion = {
          version: 1,
          account_id: "40000000-0000-4000-8000-000000000001",
          authorization_request_id: binding.authorization_id,
          application_id: applicationId,
          application_declaration_id: binding.application_declaration_id,
          application_manifest_digest: binding.application_manifest_digest,
          application_installation_id: binding.application_installation_id,
          application_origin: "https://mcp.example",
          collection_id: token.collection_id,
          grant_id: token.grant_id,
          grant_signing_public_key: binding.grant_signing_public_key,
          client_noise_public_key: noiseKeys[0]
        };
      }
      options.mutateToken?.(token);
      return Response.json(token);
    }
    if (url.origin === "https://connect.example" && url.pathname.includes("/operations/")) {
      const headers = new Headers(init?.headers);
      operationAuthorizations.push(headers.get("authorization")!);
      operationOrigins.push(headers.get("origin")!);
      const envelope = JSON.parse(String(init?.body));
      const input = await decryptConnectorRequest(
        connectorKeys.privateKey,
        applicationAgreementPublicKeys[0],
        envelope
      );
      localInputs.push(input);
      const operation = url.pathname.split("/").at(-1);
      const result = operation === "describe" ? { protocol_version: 1, collection_id: firstCollectionId }
        : operation === "read" ? { valid: true, diagnostics: [], result: { path: (input as any).path, revision: "r1", frontmatter: {} } }
        : { valid: true, result: { results: [{ path: "notes/local.md", frontmatter: { title: "Local" }, types: ["note"] }] }, diagnostics: [] };
      const responseEnvelope = await encryptConnectorResponse(connectorKeys.privateKey, applicationAgreementPublicKeys[0], envelope, result);
      return Response.json({ envelope: responseEnvelope });
    }
    if (url.origin === "https://sync.example" && url.pathname.includes("/operations/")) {
      const headers = new Headers(init?.headers);
      operationAuthorizations.push(headers.get("authorization")!);
      operationOrigins.push(headers.get("origin")!);
      operationProofs.push(proofHeaders(init));
      const request = JSON.parse(String(init?.body));
      if (init?.signal?.aborted) throw init.signal.reason;
      hostedInputs.push(request.input);
      hostedRequestIds.push(request.request_id);
      const operation = url.pathname.split("/").at(-1);
      const result = operation === "describe" ? { protocol_version: 1, collection_id: secondCollectionId, authority_capabilities: features.hosted }
        : operation === "changes" ? { events: [changedEvent], cursor: 2, has_more: false, reset: false }
        : operation === "read" ? { valid: true, diagnostics: [], result: { path: request.input.path, revision: "r1", frontmatter: {} } }
        : operation === "query" && request.input.output === "metadata" ? { valid: true, diagnostics: [], result: { output: "metadata", results: [{ path: "notes/second.md", types: ["note"], revision: "r1", values: { title: "Second" } }] } }
        : operation === "create"
        ? {
            valid: true,
            result: {
              path: request.input.path,
              revision: "created-revision",
              frontmatter: {},
              body: request.input.body,
              types: []
            },
            diagnostics: []
          }
        : operation === "query" && request.input.release_cursor
          ? { valid: true, result: { results: [], meta: { total_count: 0, has_more: false } }, diagnostics: [] }
          : {
              valid: true,
              result: {
                results: [{ path: "notes/second.md", frontmatter: { title: "Second" }, types: ["note"] }],
                meta: { total_count: 1, has_more: false }
              },
              diagnostics: []
            };
      return Response.json({
        protocol_version: request.protocol_version,
        request_id: request.input.where === "__mismatched_response__"
          ? "01988888-8888-7888-8888-888888888888"
          : request.request_id,
        ok: true,
        result
      });
    }
    // A control plane without mdbase-next routing: tools stay on the legacy path.
    if (url.origin === "https://connect.example" && /^\/v1\/next\/collections\/[^/]+\/route$/u.test(url.pathname)) {
      if (typeof options.native === "function" ? options.native() : options.native) return Response.json({
        collection: firstCollectionId, grant: firstGrantId, targets: [],
        availability: { state: "unavailable", reason: "no_device_registered" }
      });
      return Response.json({ error: { code: "not_found", message: "Not found" } }, { status: 404 });
    }
    if (url.hostname === "127.0.0.1") return realFetch(input, init);
    return Response.json({ error: { code: "unexpected_fetch", message: url.href } }, { status: 500 });
  });
  return {
    fetch: fetchMock,
    applicationAgreementPublicKeys,
    applicationSigningPublicKeys,
    authorizationProofs,
    operationAuthorizations,
    operationOrigins,
    refreshProofs,
    operationProofs,
    localInputs,
    hostedInputs,
    hostedRequestIds,
    features
  };
}

const changedEvent = { cursor: 2, type: "mdbase.record.modified", occurred_at: "2026-08-04T00:00:00Z", payload: { path: "note.md", revision: "r2", previous_revision: "r1", changed_fields: ["/title"], body_changed: false } };

interface AuthorityProofHeaders {
  version: string | null;
  timestamp: string | null;
  nonce: string | null;
  signature: string | null;
}

function proofHeaders(init?: RequestInit): AuthorityProofHeaders {
  const headers = new Headers(init?.headers);
  return {
    version: headers.get("x-mdbase-proof-version"),
    timestamp: headers.get("x-mdbase-proof-timestamp"),
    nonce: headers.get("x-mdbase-proof-nonce"),
    signature: headers.get("x-mdbase-proof-signature")
  };
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
