import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileCapability } from "@mdbase-dev/connect-protocol";
import { AuthorityFeatures, authorityCapabilities } from "./authority-features.js";
import { MdbaseConnect } from "./mdbase-connect.js";
import { ConnectionTransport } from "./connection-transport.js";
import { ConnectionFileTransport } from "./connection-file-transport.js";
import { connectError } from "./errors.js";
import { connectSuccess } from "./outcomes.js";
import type { MdbaseConnectionRoute } from "./connection-types.js";

const collectionId = "01933333-3333-7333-8333-333333333333";
const tokenKey = `mdbase-connect:https://connect.example:https://app.example/manifest.json:token:${collectionId}`;
const fileCapability: FileCapability = { kind: "files", protocol_version: 1, actions: ["list"], scope: { kind: "selected_folders", folders: ["Assets"] } };
const wireDescription = (flags?: unknown) => ({
  protocol_version: 1, collection_id: collectionId, display_name: "Notes", spec_version: "0.3.0",
  operations: ["describe", "query"], change_cursor: 0, types: [], contracts: [],
  ...(flags === undefined ? {} : { authority_capabilities: flags })
});
const descriptor = {
  file_id: "01911111-1111-7111-8111-111111111111", path: "Assets/book.pdf", revision: "opaque:1",
  content_digest: `sha256:${"0".repeat(64)}`, size: 1, media_class: "pdf", modified_at: "2026-08-01T02:03:04Z"
};
class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}
function fixture(operations = ["describe", "query"]) {
  const storage = new MemoryStorage();
  const token = {
    version: 1, accessToken: "test-token", clientId: "application", collectionId, collectionName: "Notes",
    operations, fileCapability, scope: { access: "full_collection", contracts: [] },
    expiresAt: Date.now() + 3_600_000, savedAt: 1
  };
  storage.setItem(tokenKey, JSON.stringify(token));
  const manager = new MdbaseConnect({ serverUrl: "https://connect.example", manifest: "https://app.example/manifest.json",
    redirectUri: "https://app.example/callback", storage, relayEncryption: "disabled", directAccess: "disabled" });
  return { connection: manager.connection(collectionId)!, manager, storage, token };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("connection-owned authority feature discovery", () => {
  for (const route of ["direct", "relay", "remote"] as const) {
    for (const authority of ["old", "new", "unknown", "v0.2"] as const) {
      it(`${route}: new SDK / ${authority} authority gates every extended request`, async () => {
        vi.spyOn(ConnectionTransport.prototype, "route", "get").mockReturnValue(route);
        const flags = authority === "new" ? ["files-stat-v1", "query-metadata-v1", "query-record-revisions-v1"]
          : authority === "unknown" ? ["future-feature-v42"] : undefined;
        const calls: Array<{ operation: string; input: any }> = [];
        const files: Array<{ method: string; path?: string; input: any }> = [];
        vi.spyOn(ConnectionTransport.prototype, "performOperation").mockImplementation(async <Result>(operation, input) => {
          calls.push({ operation, input });
          if (operation === "describe") return { ...wireDescription(flags), spec_version: authority === "v0.2" ? "0.2.0" : "0.3.0" } as Result;
          return { valid: true, result: { output: "metadata", results: [{ path: "a.md", types: [], revision: "opaque:1", values: {} }] }, diagnostics: [] } as Result;
        });
        vi.spyOn(ConnectionFileTransport.prototype, "control").mockImplementation(async <Result>(method, path, input) => {
          files.push({ method, path, input });
          return (path === "stat" ? { protocol_version: 1, type: "file_stat", file: descriptor }
            : { protocol_version: 1, type: "files_page", files: [descriptor] }) as Result;
        });
        const { connection } = fixture();
        const [stat, metadata] = await Promise.all([
          connection.files.stat({ path: "Assets/book.pdf" }), connection.query({ output: "metadata" })
        ]);
        expect(stat).toMatchObject({ ok: true, value: { path: "Assets/book.pdf" } });
        expect(metadata).toMatchObject(authority === "new" ? { ok: true, value: { output: "metadata" } }
          : { ok: false, problem: { code: "unsupported_operation" } });
        expect(calls.filter(call => call.operation === "describe")).toHaveLength(1);
        expect(calls.filter(call => call.input.output)).toHaveLength(authority === "new" ? 1 : 0);
        expect(files.filter(call => call.path === "stat")).toHaveLength(authority === "new" ? 1 : 0);
        expect(connection.authorityCapabilities).toEqual(authority === "new" ? flags : []);
        expect(Object.isFrozen(connection.authorityCapabilities)).toBe(true);
        const unknown = await connection.supportsAuthorityFeature("future-feature-v42");
        expect(unknown).toMatchObject({ ok: true, value: false });
        expect(calls.filter(call => call.operation === "describe")).toHaveLength(1);
      });
    }
    for (const authority of ["old", "new"] as const) {
      it(`${route}: N-1 query/list request contract accepts ${authority} responses without extensions`, async () => {
        vi.spyOn(ConnectionTransport.prototype, "route", "get").mockReturnValue(route);
        const query = vi.spyOn(ConnectionTransport.prototype, "performOperation").mockResolvedValue({
          valid: true, diagnostics: [], result: { results: [{ path: "a.md", types: [], file: { path: "a.md" },
            ...(authority === "new" ? { revision: "opaque:1" } : {}) }] }
        });
        const files = vi.spyOn(ConnectionFileTransport.prototype, "control").mockResolvedValue({
          protocol_version: 1, type: "files_page", files: [descriptor],
          ...(authority === "new" ? { authority_capabilities: ["files-stat-v1"] } : {})
        });
        const { connection } = fixture();
        // Predecessor consumers use the unchanged ordinary query/list API and
        // ignore additive response fields. Frozen reader fixtures cover N-1.
        const result = await connection.query({ types: ["note"], select: ["file.path"] });
        expect(result).toMatchObject({ ok: true, value: { results: [{ path: "a.md", types: [], file: { path: "a.md" } }] } });
        const inventory = [];
        for await (const file of connection.files.list({ pageSize: 1000 })) inventory.push(file);
        expect(inventory[0].path).toBe("Assets/book.pdf");
        expect(query.mock.calls[0].slice(0, 2)).toEqual(["query", { types: ["note"], select: ["file.path"] }]);
        expect(files.mock.calls[0].slice(0, 3)).toEqual(["GET", "?protocol_version=1&limit=1000", undefined]);
        expect(query).toHaveBeenCalledOnce(); expect(files).toHaveBeenCalledOnce();
      });
    }
  }

  it("file-only discovery uses one list page within the approved folder, including an empty inventory", async () => {
    const native = vi.spyOn(ConnectionTransport.prototype, "performOperation");
    const files = vi.spyOn(ConnectionFileTransport.prototype, "control").mockResolvedValue({
      protocol_version: 1, type: "files_page", files: [], authority_capabilities: ["files-stat-v1", "query-metadata-v1"]
    });
    const { connection } = fixture([]);
    expect(await connection.supportsAuthorityFeature("files-stat-v1")).toMatchObject({ ok: true, value: true });
    expect(await connection.supportsAuthorityFeature("query-metadata-v1")).toMatchObject({ ok: true, value: false });
    expect(files).toHaveBeenCalledOnce();
    expect(files.mock.calls[0].slice(0, 3)).toEqual(["GET", "?protocol_version=1&limit=1&folder=Assets", undefined]);
    expect(native).not.toHaveBeenCalled();
  });

  it("a grant with neither discovery permission never attempts unauthorized discovery", async () => {
    const native = vi.spyOn(ConnectionTransport.prototype, "performOperation");
    const files = vi.spyOn(ConnectionFileTransport.prototype, "control");
    const { connection, storage, token } = fixture(["query"]);
    storage.setItem(tokenKey, JSON.stringify({ ...token, fileCapability: { ...fileCapability, actions: ["read"] } }));
    expect(await connection.supportsAuthorityFeature("query-metadata-v1")).toMatchObject({ ok: true, value: false });
    expect(native).not.toHaveBeenCalled(); expect(files).not.toHaveBeenCalled();
  });

  it("clears successful discovery on route switch, reauthorization, authority replacement, and reconnect to predecessor", async () => {
    let route: MdbaseConnectionRoute = "direct";
    let flags: string[] | undefined = ["query-metadata-v1"];
    vi.spyOn(ConnectionTransport.prototype, "route", "get").mockImplementation(() => route);
    const describe = vi.spyOn(ConnectionTransport.prototype, "performOperation").mockImplementation(async <Result>() => wireDescription(flags) as Result);
    const { connection, storage, token } = fixture();
    const supported = () => connection.supportsAuthorityFeature("query-metadata-v1");
    expect(await supported()).toMatchObject({ ok: true, value: true });
    route = "relay"; flags = undefined;
    expect(connection.authorityCapabilities).toEqual([]);
    expect(await supported()).toMatchObject({ ok: true, value: false });
    storage.setItem(tokenKey, JSON.stringify({ ...token, savedAt: 2 })); flags = ["query-metadata-v1"];
    expect(await supported()).toMatchObject({ ok: true, value: true });
    storage.setItem(tokenKey, JSON.stringify({ ...token, grantId: "replacement", savedAt: 3 })); flags = undefined;
    expect(await supported()).toMatchObject({ ok: true, value: false });
    connection.notifyStorageChanged();
    expect(await supported()).toMatchObject({ ok: true, value: false });
    expect(describe).toHaveBeenCalledTimes(5);
  });

  it("retires cached evidence on every transport route event, including direct → relay → direct", async () => {
    let route: MdbaseConnectionRoute = "direct";
    vi.spyOn(ConnectionTransport.prototype, "route", "get").mockImplementation(() => route);
    const request = vi.spyOn(ConnectionTransport.prototype, "performOperation")
      .mockResolvedValueOnce(wireDescription(["files-stat-v1"]))
      .mockResolvedValueOnce(wireDescription());
    const { connection } = fixture();
    expect(await connection.supportsAuthorityFeature("files-stat-v1")).toMatchObject({ ok: true, value: true });
    // Exercise the actual transport callback, not the connection's explicit
    // storage invalidation API. No feature getter runs during the relay visit.
    route = "relay"; (connection as any).transport.notifyStorageChanged();
    route = "direct"; (connection as any).transport.notifyStorageChanged();
    expect(connection.authorityCapabilities).toEqual([]);
    expect(await connection.supportsAuthorityFeature("files-stat-v1")).toMatchObject({ ok: true, value: false });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("never persists discovery or borrows another connection's cached evidence", async () => {
    const request = vi.spyOn(ConnectionTransport.prototype, "performOperation")
      .mockResolvedValueOnce(wireDescription(["query-metadata-v1"]))
      .mockResolvedValueOnce(wireDescription());
    const { connection, storage } = fixture();
    const before = Array.from({ length: storage.length }, (_, i) => [storage.key(i), storage.getItem(storage.key(i)!)]);
    expect(await connection.supportsAuthorityFeature("query-metadata-v1")).toMatchObject({ ok: true, value: true });
    const next = new MdbaseConnect({ serverUrl: "https://connect.example", manifest: "https://app.example/manifest.json",
      redirectUri: "https://app.example/callback", storage, relayEncryption: "disabled", directAccess: "disabled" }).connection(collectionId)!;
    expect(next.authorityCapabilities).toEqual([]);
    expect(await next.supportsAuthorityFeature("query-metadata-v1")).toMatchObject({ ok: true, value: false });
    expect(Array.from({ length: storage.length }, (_, i) => [storage.key(i), storage.getItem(storage.key(i)!)])).toEqual(before);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not cache failures, malformed advertisements, or parse failure as legacy evidence", async () => {
    const describe = vi.spyOn(ConnectionTransport.prototype, "performOperation")
      .mockRejectedValueOnce(connectError("access_denied", "Denied"))
      .mockResolvedValueOnce(wireDescription(null))
      .mockResolvedValueOnce({ authority_capabilities: [] })
      .mockResolvedValueOnce({ ...wireDescription(["query-metadata-v1"]), collection_id: "01911111-1111-7111-8111-111111111111" })
      .mockResolvedValueOnce(wireDescription(["query-metadata-v1"]));
    const { connection } = fixture();
    for (const code of ["access_denied", "invalid_operation_response", "invalid_operation_response", "invalid_operation_response"]) {
      expect(await connection.supportsAuthorityFeature("query-metadata-v1")).toMatchObject({ ok: false, problem: { code } });
    }
    expect(await connection.supportsAuthorityFeature("query-metadata-v1")).toMatchObject({ ok: true, value: true });
    expect(describe).toHaveBeenCalledTimes(5);
  });

  it("feature support does not grant query permission and never retries denial as a probe", async () => {
    const request = vi.spyOn(ConnectionTransport.prototype, "performOperation").mockImplementation(async <Result>(operation) => {
      if (operation === "describe") return wireDescription(["query-metadata-v1"]) as Result;
      throw connectError("access_denied", "No query approval");
    });
    const { connection } = fixture(["describe"]);
    expect(await connection.query({ output: "metadata" })).toMatchObject({ ok: false, problem: { code: "access_denied" } });
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe("shared discovery lifetime and cancellation", () => {
  function discovery(describe: (options: any) => Promise<any>, lifetime = () => "one") {
    return new AuthorityFeatures({ lifetime, operations: () => ["describe"], fileCapability: () => null, describe, filesPage: async () => [] }, 1000);
  }
  it("shares work while each waiter retains its own cancellation", async () => {
    let complete!: (result: any) => void;
    let signal!: AbortSignal;
    const describe = vi.fn(options => { signal = options.signal; return new Promise(resolve => { complete = resolve; }); });
    const features = discovery(describe);
    const controller = new AbortController();
    const one = features.supports("query-metadata-v1", { signal: controller.signal });
    const two = features.supports("files-stat-v1");
    await vi.waitFor(() => expect(describe).toHaveBeenCalledOnce());
    controller.abort();
    expect(await one).toMatchObject({ ok: false, problem: { code: "operation_cancelled" } });
    expect(signal.aborted).toBe(false);
    complete(connectSuccess({ authorityCapabilities: ["query-metadata-v1", "files-stat-v1"] }));
    expect(await two).toMatchObject({ ok: true, value: true });
  });
  it("cancels shared work when all waiters leave and permits fresh discovery", async () => {
    let signal!: AbortSignal;
    const describe = vi.fn(options => {
      signal = options.signal;
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(connectError("operation_cancelled", "Cancelled")), { once: true }));
    });
    const features = discovery(describe);
    const controller = new AbortController();
    const pending = features.supports("query-metadata-v1", { signal: controller.signal });
    await vi.waitFor(() => expect(describe).toHaveBeenCalledOnce());
    controller.abort(); await pending;
    expect(signal.aborted).toBe(true);
    describe.mockImplementation(async () => connectSuccess({ authorityCapabilities: [] }));
    expect(await features.supports("query-metadata-v1")).toMatchObject({ ok: true, value: false });
    expect(describe).toHaveBeenCalledTimes(2);
  });
  it("retires in-flight evidence after route changes, even if the old response arrives last", async () => {
    let route = "direct";
    let complete!: (result: any) => void;
    const describe = vi.fn().mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }))
      .mockResolvedValue(connectSuccess({ authorityCapabilities: [] }));
    const features = discovery(describe, () => route);
    const old = features.supports("files-stat-v1");
    await vi.waitFor(() => expect(describe).toHaveBeenCalledOnce());
    route = "relay";
    expect(await features.supports("files-stat-v1")).toMatchObject({ ok: true, value: false });
    complete(connectSuccess({ authorityCapabilities: ["files-stat-v1"] }));
    expect(await old).toMatchObject({ ok: true, value: false });
    expect(features.capabilities).toEqual([]);
    expect(describe).toHaveBeenCalledTimes(2);
  });
  it("rediscoveries are bounded by the caller deadline and never persist capability state", async () => {
    vi.useFakeTimers();
    const features = discovery(() => new Promise(() => {}));
    const pending = features.supports("files-stat-v1", { timeoutMs: 5 });
    await vi.advanceTimersByTimeAsync(5);
    expect(await pending).toMatchObject({ ok: false, problem: { code: "timeout" } });
    expect(features.capabilities).toEqual([]);
  });
  it("normalizes unknown flags away without mutating the response", () => {
    const wire = ["query-metadata-v1", "future-feature-v42", "query-metadata-v1"];
    const normalized = authorityCapabilities(wire);
    expect(normalized).toEqual(["query-metadata-v1"]);
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(wire).toHaveLength(3);
  });
});
