import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPkce,
  MdbaseCollectionClient,
  MdbaseConnect,
  MdbaseConnectError,
  MemoryGrantKeyStore
} from "./index.js";
import type { GrantEncryption } from "@mdbase/connect-protocol";

afterEach(() => vi.restoreAllMocks());

describe("PKCE", () => {
  it("creates an OAuth S256 verifier and challenge", async () => {
    const pair = await createPkce();
    expect(pair.verifier.length).toBeGreaterThanOrEqual(43);
    expect(pair.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("provider-neutral collection client", () => {
  it("sends the canonical v0.3 patch shape through an injected transport", async () => {
    const calls: Array<{ operation: string; input: unknown }> = [];
    const client = new MdbaseCollectionClient({
      async operation<Result>(operation: string, input: unknown) {
        calls.push({ operation, input });
        return { valid: true, result: { path: "task.md" }, diagnostics: [] } as Result;
      }
    });
    await client.update({ path: "task.md", patch: { status: "done" }, if_revision: "revision:1" });
    expect(calls).toEqual([{
      operation: "update",
      input: { path: "task.md", patch: { status: "done" }, if_revision: "revision:1" }
    }]);
  });

  it("exposes revision-safe type document operations", async () => {
    const calls: Array<{ operation: string; input: unknown }> = [];
    const client = new MdbaseCollectionClient({
      async operation<Result>(operation: string, input: unknown) {
        calls.push({ operation, input });
        return { valid: true, result: {}, diagnostics: [] } as Result;
      }
    });
    await client.readType({ name: "task" });
    await client.createType({ document: "---\nkind: mdbase.type\n---\n" });
    await client.updateType({
      path: "_types/task.md",
      document: "---\nkind: mdbase.type\n---\n",
      if_revision: "sha256:one"
    });
    expect(calls.map(({ operation }) => operation)).toEqual([
      "read_type",
      "create_type",
      "update_type"
    ]);
  });

  it("surfaces cursor resets from any transport", async () => {
    const client = new MdbaseCollectionClient({
      async operation<Result>() {
        return { events: [], cursor: 10, has_more: false, reset: true } as Result;
      }
    });
    const iterator = client.watch({ cursor: 1, pollIntervalMs: 100 });
    await expect(iterator.next()).rejects.toEqual(expect.objectContaining({
      code: "change_cursor_reset"
    }));
  });

  it("requires browser-dependent defaults only when callers omit them", () => {
    expect(() => new MdbaseConnect({ serverUrl: "https://connect.example" }))
      .toThrow(MdbaseConnectError);
    expect(() => new MdbaseConnect({
      serverUrl: "https://connect.example",
      manifestUrl: "https://tasks.example/manifest.json",
      redirectUri: "https://tasks.example/callback",
      storage: new MemoryStorage()
    })).not.toThrow();
  });
});

describe("authorization renewal", () => {
  it("uses injected navigation for native authorization", async () => {
    const storage = new MemoryStorage();
    const navigate = vi.fn();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      application: {
        id: "00000000-0000-0000-0000-000000000001",
        name: "TaskNotes",
        homepage: "https://tasks.example"
      }
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const connect = new MdbaseConnect({
      serverUrl: "https://connect.example",
      manifestUrl: "https://tasks.example/.well-known/mdbase-app.json",
      redirectUri: "dev.tasknotes.app://auth/mdbase/callback",
      storage,
      relayEncryption: "disabled",
      navigate
    });

    void connect.authorize(["query"]);
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    expect(new URL(navigate.mock.calls[0][0]).searchParams.get("redirect_uri"))
      .toBe("dev.tasknotes.app://auth/mdbase/callback");
  });

  it("sends hosted operations directly to the provider with its scoped capability", async () => {
    const storage = new MemoryStorage();
    const serverUrl = "https://connect.example";
    const providerUrl = "https://provider.example";
    const manifestUrl = "https://tasks.example/.well-known/mdbase-app.json";
    storage.setItem(`mdbase-connect:token:${serverUrl}:${manifestUrl}`, JSON.stringify({
      accessToken: "mdb_control",
      refreshToken: "ref_current",
      clientId: "00000000-0000-0000-0000-000000000001",
      collectionId: "00000000-0000-0000-0000-000000000002",
      operations: ["query"],
      scope: { contracts: [{ id: "tasknotes.task", version: 1 }] },
      expiresAt: Date.now() + 60_000,
      refreshExpiresAt: Date.now() + 120_000,
      hosted: {
        providerUrl,
        replicaId: "00000000-0000-0000-0000-000000000003",
        accessToken: "hsa_direct"
      }
    }));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      result: { valid: true, result: { results: [] }, diagnostics: [] }
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const connect = new MdbaseConnect({
      serverUrl,
      manifestUrl,
      redirectUri: "https://tasks.example/callback",
      storage
    });

    expect((await connect.query()).valid).toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      `${providerUrl}/v1/hosted/collections/00000000-0000-0000-0000-000000000002/operations/query`
    );
    expect((fetchMock.mock.calls[0][1]?.headers as Record<string, string>).authorization)
      .toBe("Bearer hsa_direct");
  });

  it("keeps hosted sync credentials private and refreshes them for the offline transport", async () => {
    const storage = new MemoryStorage();
    const serverUrl = "https://connect.example";
    const providerUrl = "https://provider.example";
    const manifestUrl = "https://tasks.example/.well-known/mdbase-app.json";
    storage.setItem(`mdbase-connect:token:${serverUrl}:${manifestUrl}`, JSON.stringify({
      accessToken: "mdb_control",
      refreshToken: "ref_current",
      clientId: "00000000-0000-0000-0000-000000000001",
      collectionId: "00000000-0000-0000-0000-000000000002",
      operations: ["query", "create", "update", "delete"],
      scope: { contracts: [{ id: "tasknotes.task", version: 1 }] },
      expiresAt: Date.now() + 60_000,
      refreshExpiresAt: Date.now() + 120_000,
      hosted: {
        providerUrl,
        replicaId: "00000000-0000-0000-0000-000000000003",
        accessToken: "hsa_direct"
      }
    }));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      protocol_version: 1,
      session_id: "00000000-0000-0000-0000-000000000004",
      replica_id: "00000000-0000-0000-0000-000000000003",
      collection_id: "00000000-0000-0000-0000-000000000002",
      mode: "read_write",
      scope_epoch: 1,
      retained_after: 0,
      head: 0,
      snapshot_id: "00000000-0000-0000-0000-000000000005",
      resources: { revision: "one", spec_version: "0.3.0", types: [], contracts: [] }
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const connect = new MdbaseConnect({
      serverUrl,
      manifestUrl,
      redirectUri: "https://tasks.example/callback",
      storage
    });

    const hosted = connect.hostedSync();
    expect(hosted).toEqual(expect.objectContaining({
      collectionId: "00000000-0000-0000-0000-000000000002",
      replicaId: "00000000-0000-0000-0000-000000000003"
    }));
    expect(JSON.stringify(hosted)).not.toContain("hsa_direct");
    expect((await hosted!.transport.openSession()).mode).toBe("read_write");
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      `${providerUrl}/v1/hosted/collections/00000000-0000-0000-0000-000000000002/sync/sessions`
    );
    expect((fetchMock.mock.calls[0][1]?.headers as Record<string, string>).authorization)
      .toBe("Bearer hsa_direct");
  });

  it("rotates an expired access token and retries with the renewed credential", async () => {
    const storage = new MemoryStorage();
    const serverUrl = "https://connect.example";
    const manifestUrl = "https://tasks.example/.well-known/mdbase-app.json";
    storage.setItem(`mdbase-connect:token:${serverUrl}:${manifestUrl}`, JSON.stringify({
      accessToken: "mdb_expired",
      refreshToken: "ref_current",
      clientId: "00000000-0000-0000-0000-000000000001",
      collectionId: "00000000-0000-0000-0000-000000000002",
      operations: ["query"],
      scope: { contracts: [{ id: "tasknotes.task", version: 1 }] },
      expiresAt: Date.now() - 1,
      refreshExpiresAt: Date.now() + 60_000
    }));
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "mdb_renewed",
        refresh_token: "ref_rotated",
        expires_in: 3600,
        refresh_expires_in: 2_592_000,
        collection_id: "00000000-0000-0000-0000-000000000002",
        operations: ["query"],
        scope: { contracts: [{ id: "tasknotes.task", version: 1 }] }
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        result: { valid: true, result: { results: [] }, diagnostics: [] }
      }), { status: 200, headers: { "content-type": "application/json" } }));

    const connect = new MdbaseConnect({
      serverUrl,
      manifestUrl,
      redirectUri: "https://tasks.example/callback",
      storage
    });
    const result = await connect.query();

    expect(result.valid).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${serverUrl}/oauth/token`);
    expect((fetchMock.mock.calls[1][1]?.headers as Record<string, string>).authorization)
      .toBe("Bearer mdb_renewed");
    expect(JSON.parse(storage.getItem(`mdbase-connect:token:${serverUrl}:${manifestUrl}`)!))
      .toEqual(expect.objectContaining({ accessToken: "mdb_renewed", refreshToken: "ref_rotated" }));
  });

  it("uses a refresh credential rotated by another browser tab", async () => {
    const storage = new MemoryStorage();
    const serverUrl = "https://connect.example";
    const manifestUrl = "https://tasks.example/.well-known/mdbase-app.json";
    const tokenKey = `mdbase-connect:token:${serverUrl}:${manifestUrl}`;
    const baseToken = {
      clientId: "00000000-0000-0000-0000-000000000001",
      collectionId: "00000000-0000-0000-0000-000000000002",
      operations: ["query"],
      scope: { contracts: [{ id: "tasknotes.task", version: 1 }] },
      refreshExpiresAt: Date.now() + 60_000
    };
    storage.setItem(tokenKey, JSON.stringify({
      ...baseToken,
      accessToken: "mdb_expired",
      refreshToken: "ref_old",
      expiresAt: Date.now() - 1
    }));
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () => {
        storage.setItem(tokenKey, JSON.stringify({
          ...baseToken,
          accessToken: "mdb_from_other_tab",
          refreshToken: "ref_from_other_tab",
          expiresAt: Date.now() + 3_600_000
        }));
        return new Response(JSON.stringify({
          error: { code: "invalid_grant", message: "Refresh token has already been used." }
        }), { status: 400, headers: { "content-type": "application/json" } });
      })
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        result: { valid: true, result: { results: [] }, diagnostics: [] }
      }), { status: 200, headers: { "content-type": "application/json" } }));

    const connect = new MdbaseConnect({
      serverUrl,
      manifestUrl,
      redirectUri: "https://tasks.example/callback",
      storage
    });
    const result = await connect.query();

    expect(result.valid).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1][1]?.headers as Record<string, string>).authorization)
      .toBe("Bearer mdb_from_other_tab");
    expect(JSON.parse(storage.getItem(tokenKey)!))
      .toEqual(expect.objectContaining({ refreshToken: "ref_from_other_tab" }));
  });
});

describe("direct loopback routing", () => {
  it("retries the exact encrypted envelope through the relay after an ambiguous direct failure", async () => {
    const fixture = await encryptedConnection();
    const requests: Array<{ url: string; body: string }> = [];
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(async (input, init) => {
        requests.push({ url: String(input), body: String(init?.body) });
        throw new TypeError("loopback response was lost");
      })
      .mockImplementationOnce(async (input, init) => {
        requests.push({ url: String(input), body: String(init?.body) });
        return new Response(JSON.stringify({
          error: { code: "connector_offline", message: "Connector offline." }
        }), { status: 503, headers: { "content-type": "application/json" } });
      });

    await expect(fixture.connect.create({
      path: "one.md",
      frontmatter: { title: "Only once" }
    })).rejects.toEqual(expect.objectContaining({ code: "direct_outcome_unknown" }));

    expect(requests.map(({ url }) => url)).toEqual([
      "http://127.0.0.1:28485/v1/operations",
      `${fixture.serverUrl}/v1/collections/${fixture.collectionId}/operations/create`
    ]);
    expect(requests[0].body).toBe(requests[1].body);
    expect(JSON.parse(requests[0].body)).toEqual(expect.objectContaining({
      type: "encrypted_operation_request",
      operation: "create",
      counter: "1"
    }));

    await expect(fixture.connect.createType({
      document: `---
kind: mdbase.type
name: different
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
---
`
    })).rejects.toEqual(expect.objectContaining({ code: "pending_mutation_unresolved" }));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock
      .mockImplementationOnce(async (input, init) => {
        requests.push({ url: String(input), body: String(init?.body) });
        return new Response(JSON.stringify({
          error: { code: "upgrade_required", message: "Use the relay." }
        }), { status: 426, headers: { "content-type": "application/json" } });
      })
      .mockImplementationOnce(async (input, init) => {
        requests.push({ url: String(input), body: String(init?.body) });
        return new Response(JSON.stringify({
          error: { code: "connector_offline", message: "Connector offline." }
        }), { status: 503, headers: { "content-type": "application/json" } });
      });
    await expect(fixture.connect.create({
      frontmatter: { title: "Only once" },
      path: "one.md"
    })).rejects.toEqual(expect.objectContaining({ code: "connector_offline" }));
    expect(requests[2].body).toBe(requests[0].body);
    expect(requests[3].body).toBe(requests[0].body);
  });

  it("does not bypass an explicit rejection from the local authorization boundary", async () => {
    const fixture = await encryptedConnection();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      error: { code: "direct_operation_rejected", message: "Rejected locally." }
    }), { status: 403, headers: { "content-type": "application/json" } }));

    await expect(fixture.connect.query()).rejects.toEqual(expect.objectContaining({
      code: "direct_operation_rejected"
    }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://127.0.0.1:28485/v1/operations");
  });

  it("backs off an unavailable loopback route while keeping relay operations usable", async () => {
    const fixture = await encryptedConnection();
    const urls: string[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(async (input) => {
        urls.push(String(input));
        throw new TypeError("connector absent");
      })
      .mockImplementation(async (input) => {
        urls.push(String(input));
        return new Response(JSON.stringify({
          error: { code: "connector_offline", message: "Connector offline." }
        }), { status: 503, headers: { "content-type": "application/json" } });
      });

    await expect(fixture.connect.query()).rejects.toEqual(expect.objectContaining({
      code: "connector_offline"
    }));
    await expect(fixture.connect.query()).rejects.toEqual(expect.objectContaining({
      code: "connector_offline"
    }));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(urls).toEqual([
      "http://127.0.0.1:28485/v1/operations",
      `${fixture.serverUrl}/v1/collections/${fixture.collectionId}/operations/query`,
      `${fixture.serverUrl}/v1/collections/${fixture.collectionId}/operations/query`
    ]);
  });

  it("renews a stale binding after an uncertain direct read without reporting an unknown write", async () => {
    const fixture = await encryptedConnection();
    const token = JSON.parse(fixture.storage.getItem(
      `mdbase-connect:token:${fixture.serverUrl}:${fixture.manifestUrl}`
    )!);
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("loopback response was lost"))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { code: "encryption_binding_stale", message: "Refresh authorization." }
      }), { status: 409, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "mdb_refreshed",
        refresh_token: "ref_refreshed",
        expires_in: 3_600,
        refresh_expires_in: 7_200,
        collection_id: token.collectionId,
        operations: token.operations,
        scope: token.scope,
        grant_id: token.grantId,
        encryption: token.encryption,
        application_origin: token.applicationOrigin
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { code: "connector_offline", message: "Connector offline." }
      }), { status: 503, headers: { "content-type": "application/json" } }));

    await expect(fixture.connect.query()).rejects.toEqual(expect.objectContaining({
      code: "connector_offline"
    }));
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("checks generic readiness from a user gesture without sending ambient credentials", async () => {
    const fixture = await encryptedConnection();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      service: "mdbase-connect",
      loopback_protocol_version: 1,
      encrypted_protocol_version: 3
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const changes: string[] = [];
    fixture.connect.onConnectionChange((connection) => {
      if (connection) changes.push(connection.directAccess);
    });

    await expect(fixture.connect.requestDirectAccess()).resolves.toBe("available");
    const init = fetchMock.mock.calls[0][1] as RequestInit & { targetAddressSpace?: string };
    expect(init.credentials).toBe("omit");
    expect(init.targetAddressSpace).toBe("loopback");
    expect(changes).toContain("checking");
    expect(changes.at(-1)).toBe("available");
  });

  it("lets a user re-enable direct access after disabling it", async () => {
    const fixture = await encryptedConnection();
    fixture.connect.disableDirectAccess();
    expect(fixture.connect.connection()?.directAccess).toBe("disabled");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      service: "mdbase-connect",
      loopback_protocol_version: 1,
      encrypted_protocol_version: 3
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(fixture.connect.requestDirectAccess()).resolves.toBe("available");
    expect(fixture.connect.connection()?.directAccess).toBe("available");
  });

  it("keeps direct grant proof usable after every cloud credential expires", async () => {
    const fixture = await encryptedConnection();
    const tokenKey = `mdbase-connect:token:${fixture.serverUrl}:${fixture.manifestUrl}`;
    const token = JSON.parse(fixture.storage.getItem(tokenKey)!);
    fixture.storage.setItem(tokenKey, JSON.stringify({
      ...token,
      expiresAt: Date.now() - 60_000,
      refreshExpiresAt: Date.now() - 30_000
    }));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      error: { code: "direct_operation_rejected", message: "Reached the connector." }
    }), { status: 403, headers: { "content-type": "application/json" } }));

    await expect(fixture.connect.query()).rejects.toEqual(expect.objectContaining({
      code: "direct_operation_rejected"
    }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://127.0.0.1:28485/v1/operations");
    expect(fixture.storage.getItem(tokenKey)).not.toBeNull();
  });

  it("rejects loopback overrides that could escape the local machine", () => {
    expect(() => new MdbaseConnect({
      serverUrl: "https://connect.example",
      manifestUrl: "https://tasks.example/manifest.json",
      redirectUri: "https://tasks.example/callback",
      storage: new MemoryStorage(),
      loopbackUrl: "http://connector.evil.example:28485"
    })).toThrow(expect.objectContaining({ code: "invalid_loopback_url" }));
  });
});

async function encryptedConnection() {
  const storage = new MemoryStorage();
  const keyStore = new MemoryGrantKeyStore();
  const connectorKeys = new MemoryGrantKeyStore();
  const application = await keyStore.create("grant-key");
  const connector = await connectorKeys.create("connector-key");
  const serverUrl = "https://connect.example";
  const manifestUrl = "https://tasks.example/.well-known/mdbase-app.json";
  const collectionId = "01944444-4444-7444-8444-444444444444";
  const encryption: GrantEncryption = {
    protocol_version: 3,
    suite: "P256-HKDF-SHA256-AES256GCM",
    key_id: "enc_direct",
    scope_epoch: 1,
    connector_id: "01933333-3333-7333-8333-333333333333",
    collection_id: collectionId,
    application_public_key: application.publicKey,
    connector_public_key: connector.publicKey
  };
  storage.setItem(`mdbase-connect:token:${serverUrl}:${manifestUrl}`, JSON.stringify({
    accessToken: "mdb_current",
    refreshToken: "ref_current",
    clientId: "01922222-2222-7222-8222-222222222222",
    collectionId,
    operations: [
      "describe", "changes", "read", "query", "validate", "create", "update", "delete", "rename",
      "read_type", "create_type", "update_type"
    ],
    scope: { contracts: [] },
    expiresAt: Date.now() + 60_000,
    refreshExpiresAt: Date.now() + 120_000,
    grantId: "01911111-1111-7111-8111-111111111111",
    encryption,
    applicationOrigin: "https://tasks.example",
    keyHandle: "grant-key"
  }));
  storage.setItem("mdbase-connect:direct:https://tasks.example", "enabled");
  return {
    serverUrl,
    manifestUrl,
    collectionId,
    storage,
    connect: new MdbaseConnect({
      serverUrl,
      manifestUrl,
      redirectUri: "https://tasks.example/callback",
      storage,
      keyStore
    })
  };
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
