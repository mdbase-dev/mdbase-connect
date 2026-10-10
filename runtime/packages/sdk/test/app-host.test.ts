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
  it.each([[false, false], [false, true], [true, false], [true, true]])("pending counts and policy %s/%s", (persistent, installed) => {
    const policy = { persistent, installed };
    expect(appSaveState(0, policy)).toEqual({ kind: "no_pending_edits", unsynced: 0, warning: null });
    expect(appSaveState(3, policy)).toEqual({ kind: "not_yet_synced", unsynced: 3, warning: persistent && installed ? null : "storage_may_be_evicted" });
  });
  it.each([
    ["pending", "not_yet_synced"], ["confirmed", "saved"],
    ["rejected", "rejected"], ["unknown", "outcome_unknown"],
  ] as const)("receipt %s means %s", (receipt, expected) => {
    expect(appMutationSaveState(receipt)).toBe(expected);
  });
  it("unknown states cannot claim saved", () => {
    expect(() => appMutationSaveState("online" as never)).toThrow(RangeError);
  });
  it.each([-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid count %s", (n) => {
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
  it("refuses malformed random identity before touching storage", async () => {
    const f = fixture();
    expect(await probeAppStorage({ ...f.env, randomUUID: () => "../replica" })).toEqual({ supported: false, reason: "probe_failed" });
    expect(f.getDirectory).not.toHaveBeenCalled();
  });
  it("missing synchronous access is unavailable, not an IndexedDB fallback", async () => {
    const f = fixture();
    f.getFileHandle.mockResolvedValue({ createSyncAccessHandle: undefined } as never);
    expect(await probeAppStorage(f.env)).toEqual({ supported: false, reason: "sync_handle_unavailable" });
    expect(f.removeEntry).toHaveBeenCalledWith(ID);
  });
  it.each(["write", "flush", "read"] as const)("cleans after %s failure without publishing exception details", async (method) => {
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
  it("directory and handle-open errors never expose their messages", async () => {
    const f = fixture();
    f.getDirectory.mockRejectedValue(new Error("private origin"));
    expect(await probeAppStorage(f.env)).toEqual({ supported: false, reason: "probe_failed" });
    const g = fixture();
    g.createSyncAccessHandle.mockRejectedValue(new Error("private path"));
    expect(await probeAppStorage(g.env)).toEqual({ supported: false, reason: "probe_failed" });
    expect(g.removeEntry).toHaveBeenCalledOnce();
  });
});
