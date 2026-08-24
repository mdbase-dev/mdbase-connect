import { AUTHORITY_PROOF_HEADERS } from "@mdbase-dev/connect-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionTransport } from "./connection-transport.js";
import { MemoryGrantKeyStore, type GrantKeyStore } from "./crypto.js";
import {
  decodeCollaborationTicketResponse,
  requireCollaborationTicketAuthorization
} from "./experimental-collaboration-ticket.js";
import {
  EXPERIMENTAL_HOSTED_COLLABORATION_V1,
  getExperimentalHostedCollaborationBridge,
  installExperimentalHostedCollaborationBridge,
  requireExperimentalHostedCollaborationBridge
} from "./hosted-collaboration-internal.js";
import type { StoredToken } from "./internal-types.js";

const COLLECTION_ID = "00000000-0000-4000-8000-000000000002";
const TOKEN_KEY = "test-token";
const EXPIRES_AT = "2099-01-01T00:00:00.000Z";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("experimental hosted collaboration bridge", () => {
  it("installs one strict non-enumerable symbol bridge", async () => {
    const target = {};
    const issueTicket = vi.fn(async () => ({
      ticket: "ticket",
      webSocketUrl: "wss://provider.example/socket",
      expiresAt: EXPIRES_AT,
      profile: "markdown-body-yjs-v13" as const,
      mode: "read_only" as const,
      epoch: 1
    }));

    installExperimentalHostedCollaborationBridge(target, { issueTicket });

    expect(Object.keys(target)).toEqual([]);
    expect(Object.getOwnPropertyDescriptor(target, EXPERIMENTAL_HOSTED_COLLABORATION_V1))
      .toMatchObject({ enumerable: false, configurable: false, writable: false });
    expect(getExperimentalHostedCollaborationBridge(target)?.issueTicket).toBe(issueTicket);
    expect(requireExperimentalHostedCollaborationBridge(target).issueTicket).toBe(issueTicket);
    expect(() => installExperimentalHostedCollaborationBridge(target, { issueTicket })).toThrow();
    expect(() => requireExperimentalHostedCollaborationBridge({})).toThrow();
  });
});

describe("experimental hosted collaboration tickets", () => {
  it("rejects a local authority before network access", async () => {
    const fixture = await transportFixture({ authority: undefined, collaborationCapability: undefined });
    const fetch = vi.spyOn(globalThis, "fetch");

    await expect(fixture.transport.issueExperimentalCollaborationTicket({ path: "note.md" }))
      .rejects.toMatchObject({ code: "authority_authorization_changed" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects absent or wrong capabilities and mode escalation", async () => {
    const absent = await transportFixture({ collaborationCapability: undefined });
    await expect(absent.transport.issueExperimentalCollaborationTicket({ path: "note.md" }))
      .rejects.toMatchObject({ code: "insufficient_access" });

    expect(() => requireCollaborationTicketAuthorization({
      ...absent.token,
      collaborationCapability: {
        contract_version: 1,
        profiles: ["other-profile"]
      } as never
    }, COLLECTION_ID, undefined)).toThrow(expect.objectContaining({ code: "insufficient_access" }));

    const readOnly = await transportFixture({
      collaborationCapability: collaborationCapability("read_only")
    });
    await expect(readOnly.transport.issueExperimentalCollaborationTicket({
      path: "note.md",
      mode: "read_write"
    })).rejects.toMatchObject({ code: "insufficient_access" });
  });

  it("signs the exact concrete body and endpoint and defaults to maximum granted mode", async () => {
    const fixture = await transportFixture();
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(ticketResponse());

    await expect(fixture.transport.issueExperimentalCollaborationTicket({ path: "Notes/one.md" }))
      .resolves.toEqual({
        ticket: "opaque-ticket",
        webSocketUrl: "wss://provider.example/v1/collaboration",
        expiresAt: EXPIRES_AT,
        profile: "markdown-body-yjs-v13",
        mode: "read_write",
        epoch: 7
      });

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(
      `https://provider.example/v1/authorities/${COLLECTION_ID}/collaboration/tickets`
    );
    expect(init?.body).toBe(JSON.stringify({
      path: "Notes/one.md",
      profile: "markdown-body-yjs-v13",
      mode: "read_write"
    }));
    expect(init?.headers).toMatchObject({
      authorization: "Bearer authority-access",
      "content-type": "application/json",
      [AUTHORITY_PROOF_HEADERS.version]: "1"
    });
  });

  it("refreshes and revalidates exactly once after a 401", async () => {
    const fixture = await transportFixture({ refreshToken: "refresh-1" });
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/oauth/token")) return jsonResponse({
        rotated: true,
        collection_id: COLLECTION_ID
      }, 200);
      if (fetch.mock.calls.filter(([called]) => String(called).endsWith("/collaboration/tickets")).length === 1) {
        return new Response(null, { status: 401 });
      }
      return ticketResponse("read_only");
    });
    fixture.onStoreTokenResponse = () => ({
      ...fixture.token,
      accessToken: "relay-rotated",
      refreshToken: "refresh-2",
      collaborationCapability: collaborationCapability("read_only"),
      authority: { ...fixture.token.authority!, accessToken: "authority-rotated" }
    });

    await expect(fixture.transport.issueExperimentalCollaborationTicket({ path: "note.md" }))
      .resolves.toMatchObject({ mode: "read_only" });

    const ticketCalls = fetch.mock.calls.filter(([input]) =>
      String(input).endsWith("/collaboration/tickets"));
    expect(ticketCalls).toHaveLength(2);
    expect(ticketCalls[1]![1]?.body).toContain('"mode":"read_only"');
    expect(ticketCalls[1]![1]?.headers).toMatchObject({
      authorization: "Bearer authority-rotated"
    });
    expect(fetch.mock.calls.filter(([input]) => String(input).endsWith("/oauth/token")))
      .toHaveLength(1);
  });

  it("rejects extra response fields, missing no-store, and cross-origin endpoints", async () => {
    const provider = new URL(`https://provider.example/v1/authorities/${COLLECTION_ID}/sync`);
    const extra = ticketBody("read_write") as Record<string, unknown>;
    extra.token = "leak";
    await expect(decodeCollaborationTicketResponse(
      jsonResponse(extra, 201, { "cache-control": "private, no-store" }),
      "read_write",
      provider
    )).rejects.toMatchObject({ code: "invalid_operation_response" });
    await expect(decodeCollaborationTicketResponse(
      jsonResponse(ticketBody("read_write"), 201),
      "read_write",
      provider
    )).rejects.toMatchObject({ code: "invalid_operation_response" });
    await expect(decodeCollaborationTicketResponse(
      jsonResponse({
        ...ticketBody("read_write"),
        websocket_endpoint: "https://evil.example/socket"
      }, 201, { "cache-control": "no-store" }),
      "read_write",
      provider
    )).rejects.toMatchObject({ code: "invalid_operation_response" });
    await expect(decodeCollaborationTicketResponse(
      jsonResponse({
        ...ticketBody("read_write"),
        websocket_endpoint: "/v1/not-collaboration"
      }, 201, { "cache-control": "no-store" }),
      "read_write",
      provider
    )).rejects.toMatchObject({ code: "invalid_operation_response" });
    await expect(decodeCollaborationTicketResponse(
      jsonResponse({ ...ticketBody("read_write"), epoch: 0 }, 201, {
        "cache-control": "no-store"
      }),
      "read_write",
      provider
    )).rejects.toMatchObject({ code: "invalid_operation_response" });
  });

  it.each(["revoked", "replaced"] as const)(
    "does not fetch after the stored authorization is %s during signing",
    async (change) => {
      const keyStore = new MemoryGrantKeyStore();
      const fixture = await transportFixture({}, keyStore);
      const originalGet = keyStore.get.bind(keyStore);
      vi.spyOn(keyStore, "get").mockImplementation(async (handle) => {
        const key = await originalGet(handle);
        if (change === "revoked") fixture.storage.removeItem(TOKEN_KEY);
        else fixture.storage.setItem(TOKEN_KEY, JSON.stringify({
          ...fixture.token,
          accessToken: "replacement-relay-access",
          authority: { ...fixture.token.authority!, accessToken: "replacement-authority-access" }
        }));
        return key;
      });
      const fetch = vi.spyOn(globalThis, "fetch");

      await expect(fixture.transport.issueExperimentalCollaborationTicket({ path: "note.md" }))
        .rejects.toMatchObject({ code: "authority_authorization_changed" });
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it("validates path bytes and control characters before network access", async () => {
    const fixture = await transportFixture();
    const fetch = vi.spyOn(globalThis, "fetch");
    for (const path of ["", "bad\rpath.md", `x${"é".repeat(512)}`]) {
      await expect(fixture.transport.issueExperimentalCollaborationTicket({ path }))
        .rejects.toMatchObject({ code: "invalid_request" });
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

async function transportFixture(
  overrides: Partial<StoredToken> = {},
  keyStore: GrantKeyStore = new MemoryGrantKeyStore()
) {
  const storage = new MemoryStorage();
  const keyHandle = "grant-key";
  const key = await keyStore.create(keyHandle);
  const token: StoredToken = {
    version: 1,
    accessToken: "relay-access",
    clientId: "client-id",
    collectionId: COLLECTION_ID,
    collectionName: "Notes",
    operations: ["read", "update"],
    scope: { access: "full_collection", contracts: [] },
    expiresAt: Date.now() + 10 * 60_000,
    refreshExpiresAt: Date.now() + 60 * 60_000,
    grantId: "00000000-0000-4000-8000-000000000003",
    keyHandle,
    savedAt: Date.now(),
    collaborationCapability: collaborationCapability("read_write"),
    authority: {
      operationsUrl: `https://provider.example/v1/authorities/${COLLECTION_ID}/operations`,
      syncUrl: `https://provider.example/v1/authorities/${COLLECTION_ID}/sync`,
      filesUrl: `https://provider.example/v1/authorities/${COLLECTION_ID}/files`,
      replicaId: "00000000-0000-4000-8000-000000000005",
      accessToken: "authority-access",
      proofPublicKey: key.signingPublicKey
    },
    ...overrides
  };
  storage.setItem(TOKEN_KEY, JSON.stringify(token));
  const fixture: {
    transport: ConnectionTransport;
    storage: MemoryStorage;
    token: StoredToken;
    onStoreTokenResponse?: () => StoredToken;
  } = { transport: undefined as never, storage, token };
  fixture.transport = new ConnectionTransport({
    serverUrl: "https://connect.example",
    storage,
    keyStore,
    directAccessMode: "disabled",
    loopbackUrl: "http://127.0.0.1:47831",
    collectionId: COLLECTION_ID,
    internals: {
      relayEncryption: "disabled",
      removeToken: () => storage.removeItem(TOKEN_KEY),
      storeTokenResponse: () => {
        const stored = fixture.onStoreTokenResponse?.() ?? token;
        storage.setItem(TOKEN_KEY, JSON.stringify(stored));
        return stored;
      },
      acquireGrantKeyLease: async () => () => undefined,
      deleteGrantKeyWhenUnused: () => undefined,
      tokenKey: () => TOKEN_KEY,
      pendingMutationKey: () => "pending",
      directPreferenceKey: () => "direct"
    },
    onChange: () => undefined,
    timeouts: {
      requestMs: 5_000,
      watchStartMs: 5_000,
      fileIndexMs: 5_000,
      uploadMs: 5_000,
      syncMs: 5_000
    }
  });
  return fixture;
}

function collaborationCapability(access: "read_only" | "read_write") {
  return {
    contract_version: 1 as const,
    profiles: ["markdown-body-yjs-v13"] as ["markdown-body-yjs-v13"],
    access
  };
}

function ticketBody(mode: "read_only" | "read_write") {
  return {
    ticket: "opaque-ticket",
    expires_at: EXPIRES_AT,
    profile: "markdown-body-yjs-v13",
    mode,
    epoch: 7,
    websocket_endpoint: "/v1/collaboration"
  };
}

function ticketResponse(mode: "read_only" | "read_write" = "read_write") {
  return jsonResponse(ticketBody(mode), 201, { "cache-control": "private, no-store" });
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}
