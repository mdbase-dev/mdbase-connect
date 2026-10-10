import { afterEach, describe, expect, it, vi } from "vitest";
import { AppIndexedDbNoiseProtectedStore } from "../src/app-host/noise-idb.js";
const origin = "https://app.example.test";
function fixture() {
  const open = vi.fn(() => { throw new Error("private platform diagnostic"); });
  vi.stubGlobal("location", { origin });
  vi.stubGlobal("indexedDB", { open });
  const source = { connectorId: "66666666-6666-6666-6666-666666666666", deviceId: "44444444-4444-4444-4444-444444444444", installationId: "88888888-8888-8888-8888-888888888888", isCurrent: () => true };
  return { open, options: { origin, source, mode: "existing" as const, signal: new AbortController().signal } };
}
afterEach(() => vi.unstubAllGlobals());
describe("opaque IndexedDB Noise store entry boundary", () => {
  it.each(["https://foreign.test", "http://app.example.test", "https://app.example.test/path", "https://user:secret@app.example.test", "not-an-origin"])("denies unapproved or non-origin %s before IO", async value => {
    const f = fixture(); await expect(AppIndexedDbNoiseProtectedStore.open({ ...f.options, origin: value, allowLoopbackHttp: true })).rejects.toThrow("app noise custody store unavailable"); expect(f.open).not.toHaveBeenCalled();
  });
  it.each(["connectorId", "deviceId", "installationId"] as const)("denies nil %s before IO", async key => {
    const f = fixture(); f.options.source[key] = "00000000-0000-0000-0000-000000000000"; await expect(AppIndexedDbNoiseProtectedStore.open(f.options)).rejects.toThrow("unavailable"); expect(f.open).not.toHaveBeenCalled();
  });
  it("denies aborted/missing/throwing native host scope and absent browser before IO", async () => {
    const f = fixture(), abort = new AbortController(); abort.abort(); await expect(AppIndexedDbNoiseProtectedStore.open({ ...f.options, signal: abort.signal })).rejects.toThrow("unavailable");
    f.options.source.isCurrent = () => false; await expect(AppIndexedDbNoiseProtectedStore.open(f.options)).rejects.toThrow("unavailable");
    f.options.source.isCurrent = () => { throw Error("private diagnostic"); }; await expect(AppIndexedDbNoiseProtectedStore.open(f.options)).rejects.toThrow("unavailable");
    vi.stubGlobal("location", undefined); await expect(AppIndexedDbNoiseProtectedStore.open(f.options)).rejects.toThrow("unavailable"); expect(f.open).not.toHaveBeenCalled();
  });
  it("sanitizes platform open failure without fallback, deletion or retry", async () => {
    const f = fixture(); await expect(AppIndexedDbNoiseProtectedStore.open(f.options)).rejects.toThrow("app noise custody store unavailable"); expect(f.open).toHaveBeenCalledTimes(1); expect(f.open.mock.calls[0]).toEqual(["mdbase.app.noise.v1.88888888-8888-8888-8888-888888888888.66666666-6666-6666-6666-666666666666.44444444-4444-4444-4444-444444444444", 1]);
  });
});
