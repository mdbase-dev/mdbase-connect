import { describe, expect, it, vi } from "vitest";
import { appSaveState, appMutationSaveState, appStoragePolicy, probeAppStorage, type AppStorageProbeEnvironment, type ProbeSyncHandle } from "../src/app-host/index.js";

const ID = "00000000-0000-4000-8000-000000000001";
function fixture() {
  let data = new Uint8Array(4);
  const handle: ProbeSyncHandle = {
    write: vi.fn((b) => { data = b.slice(); return b.length; }),
    read: vi.fn((b) => { b.set(data); return data.length; }),
    flush: vi.fn(),
    close: vi.fn(),
  };
  const createSyncAccessHandle = vi.fn(async () => handle);
  const removeEntry = vi.fn(async () => {});
  const getFileHandle = vi.fn(async () => ({ createSyncAccessHandle }));
  const directory = { getFileHandle, removeEntry, getDirectoryHandle: vi.fn() };
  const getDirectoryHandle = vi.fn(async () => directory);
  const getDirectory = vi.fn(async () => ({ ...directory, getDirectoryHandle }));
  const env: AppStorageProbeEnvironment = { worker: true, storage: { getDirectory }, randomUUID: () => ID };
  return { env, handle, createSyncAccessHandle, removeEntry, getFileHandle, getDirectoryHandle, getDirectory };
}

describe("first-party app-host status", () => {
  it.each([[true, true], [true, false], [false, true], [false, false]])("pending counts and policy %s/%s", (persistent, installed) => {
    const policy = { persistent, installed };
    expect(appSaveState(0, policy)).toEqual({ kind: "no_pending_edits", unsynced: 0, warning: null });
    expect(appSaveState(3, policy)).toEqual({ kind: "not_yet_synced", unsynced: 3, warning: null });
    expect(appSaveState(3, policy, {pendingForMs: 30_000, connection: "online"}).warning).toBe(persistent ? null : "storage_may_be_evicted");
    expect(appSaveState(3, policy, {pendingForMs: 0, connection: "offline"}).warning).toBe(persistent ? null : "storage_may_be_evicted");
    expect(appSaveState(3, policy, {pendingForMs: 29_999, connection: "connecting"}).warning).toBeNull();
    expect(appSaveState(3, policy, {pendingForMs: 30_000, connection: "connecting"}).warning).toBe(persistent ? null : "storage_may_be_evicted");
    expect(appSaveState(0, policy, {pendingForMs: 30_000, connection: "connecting"}).warning).toBeNull();
    expect(appSaveState(0, policy, {pendingForMs: 30_000, connection: "offline"}).warning).toBeNull();
  });
  it("unknown outcomes and states cannot claim saved", () => {
    expect(appMutationSaveState("unknown")).toBe("outcome_unknown");
    expect(() => appMutationSaveState("online" as never)).toThrow(RangeError);
  });
  it.each([1.5])("rejects invalid count %s", (n) => {
    expect(() => appSaveState(n, { persistent: true, installed: true })).toThrow(RangeError);
  });
  it("does not request persistence implicitly", async () => {
    const persist = vi.fn(async () => true);
    expect(await appStoragePolicy({ persisted: async () => false, persist }, false)).toEqual({ persistent: false, installed: false });
    expect(persist).not.toHaveBeenCalled();
  });
  it("requests explicitly, distinguishes denial and skips already persistent", async () => {
    const persist = vi.fn(async () => true);
    expect(await appStoragePolicy({ persisted: async () => false, persist }, true, true)).toEqual({ persistent: true, installed: true });
    expect(persist).toHaveBeenCalledOnce();
    persist.mockClear();
    expect(await appStoragePolicy({ persisted: async () => true, persist }, true, true)).toEqual({ persistent: true, installed: true });
    expect(persist).not.toHaveBeenCalled();
    expect(await appStoragePolicy({ persisted: async () => false, persist: async () => false }, true, true)).toEqual({ persistent: false, installed: true });
  });
  it("unsupported and rejected storage APIs remain nonpersistent", async () => {
    expect(await appStoragePolicy(undefined, false, true)).toEqual({ persistent: false, installed: false });
    expect(await appStoragePolicy({ persisted: async () => { throw new Error("private detail"); } }, false)).toEqual({ persistent: false, installed: false });
    expect(await appStoragePolicy({ persisted: async () => false, persist: async () => { throw new Error("denied"); } }, true, true)).toEqual({ persistent: false, installed: true });
  });
});

describe("OPFS probe (not durability qualification)", () => {
  it("requires Worker and OPFS without touching storage", async () => {
    const f = fixture();
    expect(await probeAppStorage({ ...f.env, worker: false })).toEqual({ supported: false, reason: "worker_required" });
    expect(f.getDirectory).not.toHaveBeenCalled();
    expect(await probeAppStorage({ ...f.env, storage: {} })).toEqual({ supported: false, reason: "opfs_unavailable" });
  });
  it("writes, flushes, reads, closes and cleans only its scratch entry", async () => {
    const f = fixture();
    expect(await probeAppStorage(f.env)).toEqual({ supported: true, backend: "opfs_sahpool_candidate", crashDurability: "unqualified", eviction: "possible" });
    expect(f.getDirectoryHandle).toHaveBeenCalledWith(".mdbase-app-probes", { create: true });
    expect(f.getFileHandle).toHaveBeenCalledWith(ID, { create: true });
    expect(f.handle.flush).toHaveBeenCalledOnce();
    expect(f.handle.close).toHaveBeenCalledOnce();
    expect(f.removeEntry).toHaveBeenCalledWith(ID);
    expect(vi.mocked(f.handle.close).mock.invocationCallOrder[0]).toBeLessThan(f.removeEntry.mock.invocationCallOrder[0]!);
  });
  it("missing synchronous access is unavailable, not an IndexedDB fallback", async () => {
    const f = fixture();
    f.getFileHandle.mockResolvedValue({ createSyncAccessHandle: undefined } as never);
    expect(await probeAppStorage(f.env)).toEqual({ supported: false, reason: "sync_handle_unavailable" });
    expect(f.removeEntry).toHaveBeenCalledWith(ID);
  });
  it.each(["write"] as const)("cleans after %s failure without publishing exception details", async (method) => {
    const f = fixture();
    vi.mocked(f.handle[method]).mockImplementation(() => { throw new Error("private detail"); });
    expect(await probeAppStorage(f.env)).toEqual({ supported: false, reason: "probe_failed" });
    expect(f.handle.close).toHaveBeenCalledOnce();
    expect(f.removeEntry).toHaveBeenCalledOnce();
  });
  it("detects short writes and wrong readback", async () => {
    const short = fixture();
    vi.mocked(short.handle.write).mockReturnValue(1);
    expect(await probeAppStorage(short.env)).toEqual({ supported: false, reason: "probe_failed" });
    const wrong = fixture();
    vi.mocked(wrong.handle.read).mockImplementation(() => 4);
    expect(await probeAppStorage(wrong.env)).toEqual({ supported: false, reason: "probe_failed" });
  });
  it("close failure fences cleanup rather than deleting an open file", async () => {
    const f = fixture();
    vi.mocked(f.handle.close).mockImplementation(() => { throw new Error("close uncertain"); });
    expect(await probeAppStorage(f.env)).toEqual({ supported: false, reason: "cleanup_failed" });
    expect(f.removeEntry).not.toHaveBeenCalled();
  });
  it("cleanup failure cannot report supported", async () => {
    const f = fixture();
    f.removeEntry.mockRejectedValue(new Error("quota"));
    expect(await probeAppStorage(f.env)).toEqual({ supported: false, reason: "cleanup_failed" });
  });
});
