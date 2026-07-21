import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPkce,
  MdbaseCollectionClient,
  MdbaseConnect,
  MdbaseConnectError
} from "./index.js";

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

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}
