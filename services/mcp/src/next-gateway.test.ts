import { createPublicKey, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { keyPairFromSecret, mdbaseError, type KeyPair, type MdbaseClient } from "@mdbase-dev/sdk";
import type { GrantKeyRecord, GrantKeyStore } from "@mdbase-dev/connect/crypto";
import { LEGACY, NextGateway, type NextConnection } from "./next-gateway.js";
import { clientKeyAttachMessage, clientNoiseKeyMessage, type NoiseKeyStore } from "./next-keys.js";

const connection: NextConnection = {
  id: "conn-1", upstream_url: "https://connect.example/v1/hosted/app", collection_id: "col-1",
  display_name: "Notes", operations: ["query"], key_handle: "gk-1"
};
const grantId = "4c18af2e-b04a-4b77-b83e-493c3695962e", authorizationId = "0b8f6a7e-3c1d-4e2f-9a0b-1c2d3e4f5a6b";

async function fixture(routes: Array<{ status: number; body: unknown }>, attachStatus = 200, hasNoise = false, sleep?: (ms: number) => Promise<void>, now?: () => number) {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const grantKey = { handle: "gk-1", signingPrivateKey: pair.privateKey, signingPublicKey: "" } as GrantKeyRecord;
  const verifier = createPublicKey({ key: await crypto.subtle.exportKey("jwk", pair.publicKey) as never, format: "jwk" });
  let stored: KeyPair | null = hasNoise ? keyPairFromSecret(new Uint8Array(32).fill(7)) : null;
  const noise = {
    get: async () => stored,
    create: async () => (stored = keyPairFromSecret(new Uint8Array(32).fill(7)))
  } as unknown as NoiseKeyStore;
  const calls: Array<{ url: string; body?: Record<string, string> }> = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (url.endsWith("/v1/next/grants/client-key")) return new Response("{}", { status: attachStatus });
    const next = routes.shift()!;
    if (next.status === 0) throw new TypeError("fetch failed");
    return new Response(JSON.stringify(next.body), { status: next.status });
  });
  const client = { query: vi.fn(async () => ({ records: [], complete: true, asOf: 1 })), close: vi.fn() } as unknown as MdbaseClient;
  const open = vi.fn<NonNullable<ConstructorParameters<typeof NextGateway>[0]["open"]>>(async () => client);
  const gateway = new NextGateway({ keyStore: { get: async () => grantKey } as unknown as GrantKeyStore, noise, version: "test", fetch: fetch as typeof globalThis.fetch, open, ...(sleep ? { sleep } : {}), ...(now ? { now } : {}) });
  return { gateway, calls, open, verifier, noiseKey: () => stored };
}

const keyRequired = { status: 409, body: { error: { code: "client_key_required", details: { grant_id: grantId, authorization_id: authorizationId } } } };
const routed = { status: 200, body: { collection: "col-1", grant: "log-grant", targets: [{ kind: "hosted" }] } };

describe("NextGateway", () => {
  const native = { ...connection, native: { collection: "col-1", authorizationGrant: grantId } };

  it.each(["no_device_registered", "device_offline", "sync_required", "access_removed"])("preserves native availability %s without legacy fallback", async reason => {
    const setup = await fixture([{ status: 200, body: { collection: "col-1", grant: grantId, targets: [], availability: { state: "unavailable", reason } } }]);
    await expect(setup.gateway.run(native, "access", "query", {}, "req-1")).rejects.toMatchObject({ code: reason });
    expect(setup.open).not.toHaveBeenCalled();
    expect(setup.calls).toHaveLength(1);
  });

  it.each([404, 405])("does not downgrade native routes on HTTP %s", async status => {
    const setup = await fixture([{ status, body: {} }]);
    await expect(setup.gateway.run(native, "access", "query", {}, "req-1")).rejects.toMatchObject({ code: "control_error" });
    expect(setup.open).not.toHaveBeenCalled();
  });

  it("ignores cached legacy routing for a native connection", async () => {
    const setup = await fixture([{ status: 404, body: {} }, { status: 200, body: { collection: "col-1", grant: grantId, targets: [] } }]);
    expect(await setup.gateway.run(connection, "access", "query", {}, "req-1")).toBe(LEGACY);
    await expect(setup.gateway.run(native, "access", "query", {}, "req-2")).rejects.toMatchObject({ code: "no_device_registered" });
    expect(setup.calls).toHaveLength(2);
  });

  it.each([
    { collection: "other", grant: grantId },
    { collection: "col-1", grant: "other" },
    { collection: "col-1", grant: "log-grant", authorization_grant: "other" }
  ])("rejects mismatched native routing bindings %j", async binding => {
    const setup = await fixture([{ status: 200, body: { ...binding, targets: [{ kind: "hosted" }] } }]);
    await expect(setup.gateway.run(native, "access", "query", {}, "req-1")).rejects.toMatchObject({ code: "authorization_changed" });
    expect(setup.open).not.toHaveBeenCalled();
  });

  it("opens a native target with its distinct log grant, not its OAuth grant", async () => {
    const ready = await fixture([{ status: 200, body: { ...routed.body, authorization_grant: grantId } }], 200, true);
    await expect(ready.gateway.run(native, "access", "query", {}, "req-1")).resolves.toEqual({ results: [], meta: { has_more: false } });
    expect(ready.open).toHaveBeenLastCalledWith(expect.objectContaining({ grant: "log-grant" }));
    ready.gateway.close();
  });

  it.each([
    { collection: "col-1", grant: grantId, targets: [], availability: { state: "unavailable", reason: "device_offline" }, code: "device_offline" },
    { collection: "other", grant: grantId, targets: [{ kind: "hosted" }], code: "authorization_changed" },
    { collection: "col-1", grant: "different-log-grant", authorization_grant: grantId, targets: [{ kind: "hosted" }], code: "authorization_changed" }
  ])("revalidates native discovery when opening the network session: $code", async response => {
    const setup = await fixture([
      { status: 200, body: { ...routed.body, grant: grantId } }, { status: 200, body: response }
    ], 200, true);
    await setup.gateway.run(native, "access", "query", {}, "req-1");
    await expect(setup.open.mock.calls[0]![0].resolveRoute!()).rejects.toMatchObject({ code: response.code });
    setup.gateway.close();
  });

  describe("a confirmed write whose receipt carries no record", () => {
    const record = {
      id: "0190aaaa-0000-7000-8000-000000000001", path: "notes/a.md", revision: "rev1",
      frontmatter: new Map([["title", "Persisted"]]), effective: new Map([["title", "Persisted"]]),
      body: "Body", types: ["note"], state: { pending: false }, mtime: Date.UTC(2026, 9, 1)
    };
    const writeOf = (records: unknown[], confirmed: unknown[] | undefined) => ({ records, confirmed: Promise.resolve({ state: "confirmed", ...(confirmed ? { records: confirmed } : {}) }) });
    async function writing(client: Record<string, unknown>) {
      const setup = await fixture([{ status: 200, body: { ...routed.body, targets: [{ kind: "desktop" }], authorization_grant: grantId } }], 200, true);
      setup.open.mockResolvedValueOnce({ close: vi.fn(), ...client } as unknown as MdbaseClient);
      return setup;
    }

    it("reads a created record back by the ID it minted", async () => {
      const create = vi.fn(async () => writeOf([], undefined)), find = vi.fn(async () => record);
      const setup = await writing({ create, find });
      await expect(setup.gateway.run(native, "access", "create", { path: "notes/a.md", body: "Body" }, "req-1")).resolves.toMatchObject({ path: "notes/a.md", revision: "rev1" });
      const id = (create.mock.calls[0] as unknown as [{ id: string }])[0].id;
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/u);
      expect(find).toHaveBeenCalledWith(id, { effective: true, body: true }, undefined);
      setup.gateway.close();
    });

    it("reads an updated record back by its ID", async () => {
      const update = vi.fn(async () => writeOf([], undefined));
      const find = vi.fn(async () => record);
      const setup = await writing({ update, find });
      await expect(setup.gateway.run(native, "access", "update", { path: "notes/a.md", body: "Body" }, "req-1")).resolves.toMatchObject({ path: "notes/a.md" });
      expect(find).toHaveBeenLastCalledWith(record.id, { effective: true, body: true }, undefined);
      setup.gateway.close();
    });

    it("uses the receipt's record when the replica sends one", async () => {
      const create = vi.fn(async () => writeOf([], [record])), find = vi.fn(async () => null);
      const setup = await writing({ create, find });
      await expect(setup.gateway.run(native, "access", "create", { path: "notes/a.md" }, "req-1")).resolves.toMatchObject({ path: "notes/a.md" });
      expect(find).not.toHaveBeenCalled();
      setup.gateway.close();
    });

    it("refuses when the confirmed record cannot be read back", async () => {
      const setup = await writing({ create: vi.fn(async () => writeOf([], undefined)), find: vi.fn(async () => null) });
      await expect(setup.gateway.run(native, "access", "create", { path: "notes/a.md" }, "req-1")).rejects.toMatchObject({ code: "invalid_operation_response" });
      setup.gateway.close();
    });
  });

  describe("a hosted replica that has not applied a new grant yet", () => {
    const handshakeClosed = () => mdbaseError("unavailable", "connection closed during the handshake");
    const hostedRoute = { status: 200, body: { ...routed.body, authorization_grant: grantId } };

    it("waits out a session closed during the handshake on a connection's first open", async () => {
      const sleep = vi.fn(async () => undefined);
      const setup = await fixture([hostedRoute], 200, true, sleep);
      setup.open.mockRejectedValueOnce(handshakeClosed()).mockRejectedValueOnce(handshakeClosed());
      await expect(setup.gateway.run(native, "access", "query", {}, "req-1")).resolves.toEqual({ results: [], meta: { has_more: false } });
      expect(setup.open).toHaveBeenCalledTimes(3);
      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1_000, 2_000]);
      setup.gateway.close();
    });

    it("gives up after the grace and never waits again for that connection", async () => {
      const sleep = vi.fn(async () => undefined);
      const setup = await fixture([hostedRoute, hostedRoute], 200, true, sleep);
      setup.open.mockRejectedValue(handshakeClosed());
      await expect(setup.gateway.run(native, "access", "query", {}, "req-1")).rejects.toMatchObject({ code: "unavailable" });
      expect(setup.open).toHaveBeenCalledTimes(7);
      expect(sleep).toHaveBeenCalledTimes(6);
      await expect(setup.gateway.run(native, "access", "query", {}, "req-2")).rejects.toMatchObject({ code: "unavailable" });
      expect(setup.open).toHaveBeenCalledTimes(8);
      expect(sleep).toHaveBeenCalledTimes(6);
    });

    it("waits again when a later open is closed during the handshake", async () => {
      const sleep = vi.fn(async () => undefined);
      const setup = await fixture([hostedRoute, hostedRoute], 200, true, sleep);
      await setup.gateway.run(native, "access", "query", {}, "req-1");
      setup.gateway.drop(native.id);
      setup.open.mockRejectedValueOnce(handshakeClosed());
      await expect(setup.gateway.run(native, "access", "query", {}, "req-2")).resolves.toEqual({ results: [], meta: { has_more: false } });
      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1_000]);
      setup.gateway.close();
    });

    it("waits again after a spent grace once the connection has opened", async () => {
      const sleep = vi.fn(async () => undefined);
      const setup = await fixture([hostedRoute, hostedRoute, hostedRoute], 200, true, sleep);
      for (let i = 0; i < 7; i++) setup.open.mockRejectedValueOnce(handshakeClosed());
      await expect(setup.gateway.run(native, "access", "query", {}, "req-1")).rejects.toMatchObject({ code: "unavailable" });
      await setup.gateway.run(native, "access", "query", {}, "req-2");
      expect(sleep).toHaveBeenCalledTimes(6);
      setup.gateway.drop(native.id);
      setup.open.mockRejectedValueOnce(handshakeClosed());
      await setup.gateway.run(native, "access", "query", {}, "req-3");
      expect(sleep).toHaveBeenCalledTimes(7);
      setup.gateway.close();
    });

    it("does not wait when Connect refuses the route during the open, and reports what Connect said", async () => {
      const sleep = vi.fn(async () => undefined);
      const setup = await fixture([hostedRoute, { status: 409, body: {} }], 200, true, sleep);
      // As the SDK does: a route that cannot be resolved surfaces as an unreachable replica.
      setup.open.mockImplementationOnce(async ({ resolveRoute }) => {
        await resolveRoute!().catch(() => { throw mdbaseError("unavailable", "cannot reach the replica"); });
        throw new Error("unreachable");
      });
      await expect(setup.gateway.run(native, "access", "query", {}, "req-1")).rejects.toMatchObject({ code: "reconnect_required" });
      expect(setup.open).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it("lets a caller that gives up leave the wait", async () => {
      const abort = new AbortController();
      const sleep = vi.fn(() => { abort.abort(); return new Promise<void>(() => undefined); });
      const setup = await fixture([hostedRoute], 200, true, sleep);
      setup.open.mockRejectedValueOnce(handshakeClosed());
      await expect(setup.gateway.run(native, "access", "query", {}, "req-1", abort.signal)).rejects.toMatchObject({ code: "cancelled" });
      expect(setup.open).toHaveBeenCalledTimes(1);
    });

    it.each([
      { name: "a device target", targets: [{ kind: "desktop" }], error: handshakeClosed(), code: "unavailable" },
      { name: "a refusal that names its reason", targets: [{ kind: "hosted" }], error: mdbaseError("unavailable", "no device", "no_device_online"), code: "no_device_online" },
      { name: "an authentication failure", targets: [{ kind: "hosted" }], error: mdbaseError("unauthenticated", "handshake failed"), code: "unauthenticated" }
    ])("does not wait for $name", async ({ targets, error, code }) => {
      const sleep = vi.fn(async () => undefined);
      const setup = await fixture([{ status: 200, body: { ...hostedRoute.body, targets } }], 200, true, sleep);
      setup.open.mockRejectedValueOnce(error);
      await expect(setup.gateway.run(native, "access", "query", {}, "req-1")).rejects.toMatchObject({ code });
      expect(setup.open).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });
  });

  describe("an open session", () => {
    const hostedRoute = { status: 200, body: { ...routed.body, authorization_grant: grantId } };
    const emptyPage = { results: [], meta: { has_more: false } };
    async function opened(routes: Array<{ status: number; body: unknown }>, target: NextConnection = native) {
      const setup = await fixture(routes, 200, true);
      const close = vi.fn();
      setup.open.mockResolvedValueOnce({ query: vi.fn(async () => ({ records: [], complete: true, asOf: 1 })), close } as unknown as MdbaseClient);
      await expect(setup.gateway.run(target, "access", "query", {}, "req-1")).resolves.toEqual(emptyPage);
      return { ...setup, close };
    }

    it("is reused only after Connect has routed the call again", async () => {
      const setup = await opened([hostedRoute, hostedRoute]);
      await expect(setup.gateway.run(native, "access", "query", {}, "req-2")).resolves.toEqual(emptyPage);
      expect(setup.open).toHaveBeenCalledTimes(1);
      expect(setup.calls).toHaveLength(2);
      setup.gateway.close();
    });

    it.each([
      { name: "the grant needs a new approval", route: { status: 409, body: {} }, code: "reconnect_required" },
      { name: "access was removed", route: { status: 200, body: { collection: "col-1", grant: grantId, targets: [], availability: { state: "unavailable", reason: "access_removed" } } }, code: "access_removed" },
      { name: "the routing grant changed", route: { status: 200, body: { ...routed.body, grant: "other-log-grant", authorization_grant: "other" } }, code: "authorization_changed" }
    ])("ends at once when $name", async ({ route, code }) => {
      const setup = await opened([hostedRoute, route]);
      await expect(setup.gateway.run(native, "access", "query", {}, "req-2")).rejects.toMatchObject({ code });
      await vi.waitFor(() => expect(setup.close).toHaveBeenCalled());
      expect(setup.open).toHaveBeenCalledTimes(1);
    });

    it("is replaced when Connect routes the collection under another grant", async () => {
      const setup = await opened([routed, { status: 200, body: { ...routed.body, grant: "newer-log-grant" } }], connection);
      await expect(setup.gateway.run(connection, "access", "query", {}, "req-2")).resolves.toEqual(emptyPage);
      await vi.waitFor(() => expect(setup.close).toHaveBeenCalled());
      expect(setup.open).toHaveBeenLastCalledWith(expect.objectContaining({ grant: "newer-log-grant" }));
      setup.gateway.close();
    });

    it("ends when Connect stops routing the collection on next", async () => {
      const setup = await opened([routed, { status: 200, body: { collection: "col-1", grant: "log-grant", targets: [] } }], connection);
      await expect(setup.gateway.run(connection, "access", "query", {}, "req-2")).resolves.toBe(LEGACY);
      await vi.waitFor(() => expect(setup.close).toHaveBeenCalled());
    });

    it.each([
      { name: "Connect being out of reach", route: { status: 0, body: null }, code: "control_unreachable" },
      { name: "an expired access token", route: { status: 401, body: {} }, code: "authority_authentication_expired" },
      { name: "a Connect error", route: { status: 503, body: {} }, code: "control_error" },
      { name: "its device going offline", route: { status: 200, body: { collection: "col-1", grant: grantId, targets: [], availability: { state: "unavailable", reason: "device_offline" } } }, code: "device_offline" }
    ])("survives $name, without serving the call", async ({ route, code }) => {
      const setup = await opened([hostedRoute, route, hostedRoute]);
      await expect(setup.gateway.run(native, "access", "query", {}, "req-2")).rejects.toMatchObject({ code });
      await expect(setup.gateway.run(native, "access", "query", {}, "req-3")).resolves.toEqual(emptyPage);
      expect(setup.open).toHaveBeenCalledTimes(1);
      expect(setup.close).not.toHaveBeenCalled();
      setup.gateway.close();
    });

    it("is not closed by a call that failed on the session before it", async () => {
      const device = { status: 200, body: { ...routed.body, targets: [{ kind: "desktop" }] } };
      const setup = await fixture([device, device, device], 200, true);
      let fail!: (error: unknown) => void;
      const firstClose = vi.fn(), secondClose = vi.fn();
      setup.open.mockResolvedValueOnce({ query: vi.fn(() => new Promise((_, reject) => { fail = reject; })), close: firstClose } as unknown as MdbaseClient);
      setup.open.mockResolvedValueOnce({ query: vi.fn(async () => ({ records: [], complete: true, asOf: 1 })), close: secondClose } as unknown as MdbaseClient);
      const slow = setup.gateway.run(connection, "access", "query", {}, "req-1");
      await vi.waitFor(() => expect(fail).toBeDefined());
      setup.gateway.drop(connection.id);
      await expect(setup.gateway.run(connection, "access", "query", {}, "req-2")).resolves.toEqual(emptyPage);
      fail(mdbaseError("unavailable", "connection to the replica closed"));
      await expect(slow).rejects.toMatchObject({ code: "unavailable" });
      await expect(setup.gateway.run(connection, "access", "query", {}, "req-3")).resolves.toEqual(emptyPage);
      expect(firstClose).toHaveBeenCalledTimes(1);
      expect(secondClose).not.toHaveBeenCalled();
      expect(setup.open).toHaveBeenCalledTimes(2);
      setup.gateway.close();
    });

    it("is not closed by the idle timer of the session before it", async () => {
      vi.useFakeTimers();
      try {
        const setup = await fixture([routed, routed, routed], 200, true);
        let finish!: (page: unknown) => void;
        const secondClose = vi.fn();
        setup.open.mockResolvedValueOnce({ query: vi.fn(() => new Promise((resolve) => { finish = resolve; })), close: vi.fn() } as unknown as MdbaseClient);
        setup.open.mockResolvedValueOnce({ query: vi.fn(async () => ({ records: [], complete: true, asOf: 1 })), close: secondClose } as unknown as MdbaseClient);
        const slow = setup.gateway.run(connection, "access", "query", {}, "req-1");
        await vi.waitFor(() => expect(finish).toBeDefined());
        setup.gateway.drop(connection.id);
        await setup.gateway.run(connection, "access", "query", {}, "req-2");
        finish({ records: [], complete: true, asOf: 1 });
        await slow;
        // Still in use after four minutes: only its own five idle minutes may close it.
        await vi.advanceTimersByTimeAsync(4 * 60_000);
        await setup.gateway.run(connection, "access", "query", {}, "req-3");
        await vi.advanceTimersByTimeAsync(2 * 60_000);
        expect(secondClose).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(4 * 60_000);
        expect(secondClose).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("a hosted replica that closes the session under a call", () => {
    const sessionClosed = () => mdbaseError("unavailable", "connection closed");
    const hostedRoute = { status: 200, body: { ...routed.body, authorization_grant: grantId } };
    const record = {
      id: "0190aaaa-0000-7000-8000-000000000001", path: "notes/a.md", revision: "rev1",
      frontmatter: new Map([["title", "Persisted"]]), effective: new Map([["title", "Persisted"]]),
      body: "Body", types: ["note"], state: { pending: false }, mtime: Date.UTC(2026, 9, 1)
    };
    const confirmed = () => ({ records: [], confirmed: Promise.resolve({ state: "confirmed" }) });
    async function sessions(clients: Array<Record<string, unknown>>, targets: unknown[] = [{ kind: "hosted" }]) {
      const sleep = vi.fn(async () => undefined);
      const setup = await fixture(clients.map(() => ({ status: 200, body: { ...hostedRoute.body, targets } })), 200, true, sleep);
      const closes = clients.map((client) => {
        const close = vi.fn();
        setup.open.mockResolvedValueOnce({ close, ...client } as unknown as MdbaseClient);
        return close;
      });
      return { ...setup, closes, sleep };
    }
    const emptyPage = { records: [], complete: true, asOf: 1 };

    it("reopens and runs a read again", async () => {
      const first = vi.fn(async () => { throw sessionClosed(); }), second = vi.fn(async () => emptyPage);
      const setup = await sessions([{ query: first }, { query: second }]);
      await expect(setup.gateway.run(native, "access", "query", {}, "req-1")).resolves.toEqual({ results: [], meta: { has_more: false } });
      expect(setup.open).toHaveBeenCalledTimes(2);
      await vi.waitFor(() => expect(setup.closes[0]).toHaveBeenCalled());
      expect(setup.closes[1]).not.toHaveBeenCalled();
      setup.gateway.close();
    });

    it("gives up after two more attempts", async () => {
      const query = vi.fn(async () => { throw sessionClosed(); });
      const setup = await sessions([{ query }, { query }, { query }]);
      await expect(setup.gateway.run(native, "access", "query", {}, "req-1")).rejects.toMatchObject({ code: "unavailable" });
      expect(query).toHaveBeenCalledTimes(3);
      expect(setup.open).toHaveBeenCalledTimes(3);
    });

    it.each([
      { name: "a device target", targets: [{ kind: "desktop" }], error: sessionClosed(), code: "unavailable" },
      { name: "a failure that names its reason", targets: [{ kind: "hosted" }], error: mdbaseError("unavailable", "no device", "no_device_online"), code: "no_device_online" },
      { name: "a revoked session", targets: [{ kind: "hosted" }], error: mdbaseError("unauthenticated", "the replica closed the session"), code: "unauthenticated" },
      { name: "a refused request", targets: [{ kind: "hosted" }], error: mdbaseError("invalid_request", "bad query"), code: "invalid_request" }
    ])("does not run a call again for $name", async ({ targets, error, code }) => {
      const query = vi.fn(async () => { throw error; });
      const setup = await sessions([{ query }], targets);
      await expect(setup.gateway.run(native, "access", "query", {}, "req-1")).rejects.toMatchObject({ code });
      expect(query).toHaveBeenCalledTimes(1);
      expect(setup.open).toHaveBeenCalledTimes(1);
      setup.gateway.close();
    });

    it("does not run a call again once the caller has given up", async () => {
      const abort = new AbortController();
      const query = vi.fn(async () => { abort.abort(); throw sessionClosed(); });
      const setup = await sessions([{ query }]);
      await expect(setup.gateway.run(native, "access", "query", {}, "req-1", abort.signal)).rejects.toMatchObject({ code: "unavailable" });
      expect(setup.open).toHaveBeenCalledTimes(1);
    });

    it("reopens once for calls that were running together", async () => {
      const fail = () => { throw sessionClosed(); };
      const second = vi.fn(async () => emptyPage);
      // Four routes: each call is routed, and routed again when it is run again.
      const setup = await sessions([{ query: vi.fn(async () => { await Promise.resolve(); return fail(); }) }, { query: second }, { query: second }, { query: second }]);
      const results = await Promise.all([
        setup.gateway.run(native, "access", "query", {}, "req-1"),
        setup.gateway.run(native, "access", "query", {}, "req-2")
      ]);
      expect(results).toEqual([{ results: [], meta: { has_more: false } }, { results: [], meta: { has_more: false } }]);
      expect(setup.open).toHaveBeenCalledTimes(2);
      expect(second).toHaveBeenCalledTimes(2);
      setup.gateway.close();
    });

    it("does not start another attempt 30 s after the call began", async () => {
      let clock = 1_000_000;
      const query = vi.fn(async () => { clock += 31_000; throw sessionClosed(); });
      const setup = await fixture([hostedRoute, hostedRoute], 200, true, vi.fn(async () => undefined), () => clock);
      setup.open.mockResolvedValue({ query, close: vi.fn() } as unknown as MdbaseClient);
      await expect(setup.gateway.run(native, "access", "query", {}, "req-1")).rejects.toMatchObject({ code: "unavailable" });
      expect(query).toHaveBeenCalledTimes(1);
    });

    it("gives the same create its record ID again when the client retries it", async () => {
      const busy = vi.fn(async () => { throw mdbaseError("unavailable", "busy", "busy"); });
      const create = vi.fn(async () => confirmed()), find = vi.fn(async () => record);
      const setup = await sessions([{ create: busy }, { create, find }, { create, find }]);
      await expect(setup.gateway.run(native, "access", "create", { path: "notes/a.md" }, "req-1")).rejects.toMatchObject({ code: "busy" });
      await setup.gateway.run(native, "access", "create", { path: "notes/a.md" }, "req-1");
      await setup.gateway.run(native, "access", "create", { path: "notes/a.md" }, "req-2");
      const ids = [busy.mock.calls[0], create.mock.calls[0], create.mock.calls[1]].map((call) => (call as unknown as [{ id: string }])[0].id);
      expect(ids[1]).toBe(ids[0]);
      expect(ids[2]).not.toBe(ids[0]);
      setup.gateway.close();
    });

    it("runs a create again as the same create", async () => {
      const first = vi.fn(async () => { throw sessionClosed(); }), second = vi.fn(async () => confirmed());
      const find = vi.fn(async () => record);
      const setup = await sessions([{ create: first }, { create: second, find }]);
      await expect(setup.gateway.run(native, "access", "create", { path: "notes/a.md" }, "req-1")).resolves.toMatchObject({ path: "notes/a.md" });
      const [input, options] = first.mock.calls[0] as unknown as [{ id: string }, { mutationId: string }];
      expect(second).toHaveBeenCalledWith(expect.objectContaining({ id: input.id }), expect.objectContaining({ mutationId: "req-1" }));
      expect(options.mutationId).toBe("req-1");
      expect(find).toHaveBeenCalledWith(input.id, { effective: true, body: true }, undefined);
      setup.gateway.close();
    });

    it("answers a delete whose first attempt was confirmed", async () => {
      const remove = vi.fn(async () => ({ records: [], confirmed: Promise.reject(sessionClosed()) }));
      const receipt = vi.fn(async () => ({ mutation: "req-1", state: "confirmed" }));
      const setup = await sessions([{ find: vi.fn(async () => record), delete: remove }, { find: vi.fn(async () => null), receipt }]);
      await expect(setup.gateway.run(native, "access", "delete", { path: "notes/a.md" }, "req-1")).resolves.toEqual({ path: "notes/a.md", deleted: true });
      expect(receipt).toHaveBeenCalledWith("req-1", undefined);
      setup.gateway.close();
    });

    it("waits for a delete that is still pending", async () => {
      const receipt = vi.fn(async () => ({ mutation: "req-1", state: "pending" }));
      const awaitReceipt = vi.fn(async () => ({ mutation: "req-1", state: "confirmed" }));
      const setup = await sessions([{ find: vi.fn(async () => null), receipt, awaitReceipt }]);
      await expect(setup.gateway.run(native, "access", "delete", { path: "notes/a.md" }, "req-1")).resolves.toEqual({ path: "notes/a.md", deleted: true });
      expect(awaitReceipt).toHaveBeenCalledWith("req-1", 30_000, undefined);
      setup.gateway.close();
    });

    it.each([
      { name: "unknown", receipt: async () => { throw mdbaseError("not_found", "no such mutation"); }, code: "record_not_found" },
      { name: "rejected", receipt: async () => ({ mutation: "req-1", state: "rejected" }), code: "record_not_found" }
    ])("reports a missing record when the delete is $name", async ({ receipt, code }) => {
      const setup = await sessions([{ find: vi.fn(async () => null), receipt: vi.fn(receipt) }]);
      await expect(setup.gateway.run(native, "access", "delete", { path: "notes/a.md" }, "req-1")).rejects.toMatchObject({ code });
      setup.gateway.close();
    });

    it("reports a delete that stays pending as unknown", async () => {
      const pending = vi.fn(async () => ({ mutation: "req-1", state: "pending" }));
      const setup = await sessions([{ find: vi.fn(async () => null), receipt: pending, awaitReceipt: pending }]);
      await expect(setup.gateway.run(native, "access", "delete", { path: "notes/a.md" }, "req-1")).rejects.toMatchObject({ code: "outcome_unknown" });
      setup.gateway.close();
    });

    it("answers a rename whose first attempt was confirmed with the record at its new path", async () => {
      const moved = { ...record, path: "notes/b.md" };
      const find = vi.fn(async (target: unknown) => (target as { path: string }).path === "notes/b.md" ? moved : null);
      const setup = await sessions([{ find, receipt: vi.fn(async () => ({ mutation: "req-1", state: "confirmed" })) }]);
      await expect(setup.gateway.run(native, "access", "rename", { from: "notes/a.md", to: "notes/b.md" }, "req-1")).resolves.toMatchObject({ path: "notes/b.md", from: "notes/a.md", to: "notes/b.md" });
      setup.gateway.close();
    });

    it("finds a renamed record by its ID when an earlier attempt saw it", async () => {
      const moved = { ...record, path: "notes/b.md" };
      const rename = vi.fn(async () => ({ records: [], confirmed: Promise.reject(sessionClosed()) }));
      const find = vi.fn(async (target: unknown) => target === record.id ? moved : null);
      const setup = await sessions([
        { find: vi.fn(async () => record), rename },
        { find, receipt: vi.fn(async () => ({ mutation: "req-1", state: "confirmed" })) }
      ]);
      await expect(setup.gateway.run(native, "access", "rename", { from: "notes/a.md", to: "notes/b" }, "req-1")).resolves.toMatchObject({ path: "notes/b.md", from: "notes/a.md", to: "notes/b.md" });
      expect(find).toHaveBeenLastCalledWith(record.id, { effective: true, body: true }, undefined);
      setup.gateway.close();
    });

    it("reports a missing record when a rename was never submitted", async () => {
      const setup = await sessions([{ find: vi.fn(async () => null), receipt: vi.fn(async () => { throw mdbaseError("not_found", "no such mutation"); }) }]);
      await expect(setup.gateway.run(native, "access", "rename", { from: "notes/a.md", to: "notes/b.md" }, "req-1")).rejects.toMatchObject({ code: "record_not_found" });
      setup.gateway.close();
    });
  });

  it("attaches a Noise key signed by the grant key when the route asks for one, then opens the session", async () => {
    const f = await fixture([keyRequired, routed]);
    expect(await f.gateway.run(connection, "access", "query", {}, "req-1")).toEqual({ results: [], meta: { has_more: false } });
    expect(f.calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/v1/next/collections/col-1/route", "/v1/next/grants/client-key", "/v1/next/collections/col-1/route"
    ]);
    const body = f.calls[1].body!, pk = Buffer.from(body.public_key, "base64url");
    expect(pk.equals(Buffer.from(f.noiseKey()!.publicKey))).toBe(true);
    expect(body.grant_id).toBe(grantId);
    const ok = (message: Buffer, signature: string) => verify("sha256", message, { key: f.verifier, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"));
    expect(ok(clientNoiseKeyMessage(authorizationId, pk), body.attestation)).toBe(true);
    expect(ok(clientKeyAttachMessage(grantId, pk, body.expires_at, Buffer.from(body.nonce, "base64url")), body.signature)).toBe(true);
    expect(Date.parse(body.expires_at) - Date.now()).toBeLessThanOrEqual(5 * 60_000);
    expect(f.open).toHaveBeenCalledWith(expect.objectContaining({ grant: "log-grant" }));
  });

  it("asks for re-approval when the attach is refused or the grant still needs a key", async () => {
    const refused = await fixture([keyRequired], 409);
    await expect(refused.gateway.run(connection, "access", "query", {}, "req-1")).rejects.toMatchObject({ code: "reconnect_required" });
    const again = await fixture([keyRequired, keyRequired]);
    await expect(again.gateway.run(connection, "access", "query", {}, "req-1")).rejects.toMatchObject({ code: "reconnect_required" });
    expect(again.calls.filter((call) => call.url.endsWith("/client-key"))).toHaveLength(1);
  });

  it("falls back to the legacy authority without a next control plane or route target", async () => {
    for (const route of [{ status: 404, body: {} }, { status: 405, body: {} }, { status: 200, body: { collection: "col-1", grant: "g", targets: [] } }]) {
      const f = await fixture([route]);
      expect(await f.gateway.run(connection, "access", "query", {}, "req-1")).toBe(LEGACY);
      expect(await f.gateway.run(connection, "access", "query", {}, "req-2")).toBe(LEGACY);
      expect(f.calls).toHaveLength(1); // cached
      expect(f.open).not.toHaveBeenCalled();
    }
  });

  it.each(["sync_required", "access_removed"])("asks for re-approval instead of the legacy path when the route reports %s", async (reason) => {
    const f = await fixture([{ status: 200, body: { collection: "col-1", grant: "g", targets: [], availability: { state: "unavailable", reason } } }]);
    await expect(f.gateway.run(connection, "access", "query", {}, "req-1")).rejects.toMatchObject({ code: "reconnect_required", details: { connection_id: "conn-1" } });
    expect(f.open).not.toHaveBeenCalled();
  });

  it("maps an expired access token to the refresh path", async () => {
    const f = await fixture([{ status: 401, body: {} }]);
    await expect(f.gateway.run(connection, "access", "query", {}, "req-1")).rejects.toMatchObject({ code: "authority_authentication_expired" });
  });
});

describe("Noise key messages", () => {
  it("are byte-identical to the control plane's (pinned in client-key-attach.postgres.test.ts)", () => {
    const message = clientKeyAttachMessage("4c18af2e-b04a-4b77-b83e-493c3695962e", Buffer.alloc(32, 0x0c), "2026-10-12T00:00:00.000Z", Buffer.alloc(32, 0x0d));
    expect(message.toString("hex")).toBe(
      Buffer.from("mdbase-next client noise key attach v1\0").toString("hex")
      + "00000010" + "4c18af2eb04a4b77b83e493c3695962e"
      + "00000020" + "0c".repeat(32)
      + "00000018" + Buffer.from("2026-10-12T00:00:00.000Z").toString("hex")
      + "00000020" + "0d".repeat(32)
    );
    expect(clientNoiseKeyMessage(grantId, Buffer.alloc(32, 1)).subarray(0, 32).toString()).toBe("mdbase-next client noise key v1\0");
  });
});
