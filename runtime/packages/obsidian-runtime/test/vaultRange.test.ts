import { describe, expect, it, vi } from "vitest";
import { BoundedRangeSource, type RangeBackend, type RangeSnapshot } from "../src/attachments/range.js";
import { VaultPlatform } from "../src/vault/platform.js";
import { FakeVault } from "./fakeVault.js";
const desktop = { isMobileApp: false, isAndroidApp: false, isIosApp: false };
const snapshot: RangeSnapshot = { kind: "file", identity: "file", version: "v", size: 10 };
function backend(over: Partial<RangeBackend> = {}) {
  return {
    snapshot: vi.fn(over.snapshot ?? (async () => snapshot)),
    readInto: vi.fn(over.readInto ?? (async (_, target) => { target.fill(12); return target.length; })),
    close: vi.fn(over.close ?? (async () => {})),
  };
}
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

describe("VaultPlatform explicitly bounded ReadRange", () => {
  it("never falls back to whole-file readBinary even for small files", async () => {
    const fv = new FakeVault(); fv.setText("a.md", "abc");
    const whole = vi.spyOn(fv.app.vault.adapter, "readBinary");
    const platform = new VaultPlatform(fv.app, { root: "", platform: desktop });
    expect(await platform.perform({ op: "ReadRange", path: "a.md", offset: 0, len: 1 })).toMatchObject({ ok: false, error: { kind: "Unsupported" } });
    expect(whole).not.toHaveBeenCalled();
  });
  it("validates collection paths/ranges before provider open", async () => {
    const fv = new FakeVault();
    const provider = vi.fn(async () => BoundedRangeSource.open(backend()));
    const platform = new VaultPlatform(fv.app, { root: "Tasks", platform: desktop, openRangeSource: provider });
    for (const path of ["../private", "C:secret", "x\u0000y"]) {
      expect(await platform.perform({ op: "ReadRange", path, offset: 0, len: 1 })).toMatchObject({ ok: false, error: { kind: "InvalidPath" } });
    }
    for (const [offset, len] of [[-1, 1], [0, NaN], [0, 8 * 1024 * 1024 + 1], [Number.MAX_SAFE_INTEGER, 1]]) {
      expect((await platform.perform({ op: "ReadRange", path: "a.bin", offset: offset!, len: len! })).ok).toBe(false);
    }
    expect(provider).not.toHaveBeenCalled();
  });
  it("uses the explicit provider, returns a bounded output copy, and keeps capabilities honest", async () => {
    const fv = new FakeVault();
    let borrowed!: Uint8Array;
    const b = backend({ readInto: async (_, target) => { borrowed = target; target.fill(12); return target.length; } });
    const provider = vi.fn(async () => BoundedRangeSource.open(b));
    const platform = new VaultPlatform(fv.app, { root: "Tasks", platform: desktop, openRangeSource: provider });
    const result = await platform.perform({ op: "ReadRange", path: "a.bin", offset: 8, len: 5 });
    expect(provider).toHaveBeenCalledWith("Tasks/a.bin");
    expect(result).toMatchObject({ ok: true, value: { kind: "Bytes", value: new Uint8Array([12, 12]) } });
    expect(borrowed.byteLength === 0 || borrowed.every(v => v === 0)).toBe(true);
    expect(b.close).toHaveBeenCalledOnce();
    expect(platform.capabilities).toMatchObject({ durability: "None", fileIds: false, exclusiveCreate: false });
    await platform.closeRangeReads();
  });
  it("fails busy for concurrent operations instead of accumulating chunk sources", async () => {
    const started = deferred<void>(), read = deferred<number>();
    const b = backend({ readInto: async (_, target) => { started.resolve(); target.fill(1); return read.promise; } });
    const platform = new VaultPlatform(new FakeVault().app, { root: "", platform: desktop, openRangeSource: () => BoundedRangeSource.open(b) });
    const first = platform.perform({ op: "ReadRange", path: "a.bin", offset: 0, len: 4 });
    await started.promise;
    expect(await platform.perform({ op: "ReadRange", path: "b.bin", offset: 0, len: 4 })).toMatchObject({ ok: false, error: { kind: "Busy" } });
    read.resolve(4);
    expect((await first).ok).toBe(true);
    await platform.closeRangeReads();
  });
  it("close during provider open fences the late source and waits its cleanup", async () => {
    const pending = deferred<BoundedRangeSource>();
    const b = backend();
    const platform = new VaultPlatform(new FakeVault().app, { root: "", platform: desktop, openRangeSource: () => pending.promise });
    const read = platform.perform({ op: "ReadRange", path: "a.bin", offset: 0, len: 4 });
    const closing = platform.closeRangeReads();
    pending.resolve(await BoundedRangeSource.open(b));
    expect(await read).toMatchObject({ ok: false, error: { kind: "BadHandle" } });
    await closing;
    expect(b.readInto).not.toHaveBeenCalled();
    expect(b.close).toHaveBeenCalledOnce();
  });
  it("close during native read prevents late plaintext delivery", async () => {
    const started = deferred<void>(), pending = deferred<number>();
    let target!: Uint8Array;
    const b = backend({ readInto: async (_, bytes) => { target = bytes; started.resolve(); return pending.promise; } });
    const platform = new VaultPlatform(new FakeVault().app, { root: "", platform: desktop, openRangeSource: () => BoundedRangeSource.open(b) });
    const read = platform.perform({ op: "ReadRange", path: "a.bin", offset: 0, len: 4 });
    await started.promise;
    const closing = platform.closeRangeReads();
    target.fill(123); pending.resolve(4);
    expect(await read).toMatchObject({ ok: false, error: { kind: "BadHandle" } });
    await closing;
    expect(target.byteLength === 0 || target.every(v => v === 0)).toBe(true);
  });
  it("shutdown during final cleanup fences the already copied output and wipes it", async () => {
    const startedClose = deferred<void>(), finishClose = deferred<void>();
    const b = backend({ close: async () => { startedClose.resolve(); await finishClose.promise; } });
    const platform = new VaultPlatform(new FakeVault().app, { root: "", platform: desktop, openRangeSource: () => BoundedRangeSource.open(b) });
    const slice = Uint8Array.prototype.slice;
    let copied!: Uint8Array<ArrayBuffer>;
    const spy = vi.spyOn(Uint8Array.prototype, "slice").mockImplementation(function (this: Uint8Array, start, end) {
      copied = slice.call(this, start, end);
      return copied;
    });
    try {
      const read = platform.perform({ op: "ReadRange", path: "synthetic.bin", offset: 0, len: 4 });
      await startedClose.promise;
      expect([...copied]).toEqual([12, 12, 12, 12]);
      const shutdown = platform.closeRangeReads();
      finishClose.resolve();
      expect(await read).toMatchObject({ ok: false, error: { kind: "BadHandle" } });
      await shutdown;
      expect([...copied]).toEqual([0, 0, 0, 0]);
      expect(b.close).toHaveBeenCalledOnce();
    } finally { spy.mockRestore(); finishClose.resolve(); await platform.closeRangeReads(); }
  });
  it("retains failed source-close cleanup, denies reuse and allows retry", async () => {
    const b = backend(); b.close.mockRejectedValueOnce(new Error("close failed"));
    const provider = vi.fn(async () => BoundedRangeSource.open(b));
    const platform = new VaultPlatform(new FakeVault().app, { root: "", platform: desktop, openRangeSource: provider });
    expect(await platform.perform({ op: "ReadRange", path: "a.bin", offset: 0, len: 4 })).toMatchObject({ ok: false, error: { kind: "Other", detail: "range cleanup pending" } });
    expect(await platform.perform({ op: "ReadRange", path: "b.bin", offset: 0, len: 4 })).toMatchObject({ ok: false, error: { kind: "Busy" } });
    expect(provider).toHaveBeenCalledOnce();
    await platform.closeRangeReads();
    expect(b.close).toHaveBeenCalledTimes(2);
    expect(await platform.perform({ op: "ReadRange", path: "a.bin", offset: 0, len: 4 })).toMatchObject({ ok: false, error: { kind: "BadHandle" } });
  });
  it("retains failed-open cleanup tokens rather than dropping ownership in error mapping", async () => {
    const b = backend({ snapshot: async () => { throw new Error("PRIVATE provider details"); } });
    b.close.mockRejectedValueOnce(new Error("PRIVATE close"));
    const platform = new VaultPlatform(new FakeVault().app, { root: "", platform: desktop, openRangeSource: () => BoundedRangeSource.open(b) });
    const result = await platform.perform({ op: "ReadRange", path: "a.bin", offset: 0, len: 4 });
    expect(result).toMatchObject({ ok: false, error: { kind: "Other", detail: "io" } });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    await platform.closeRangeReads();
    expect(b.close).toHaveBeenCalledTimes(2);
  });
  it("does not echo provider error text across the host boundary", async () => {
    const platform = new VaultPlatform(new FakeVault().app, { root: "", platform: desktop, openRangeSource: async () => { throw new Error("PRIVATE capped URL"); } });
    expect(await platform.perform({ op: "ReadRange", path: "a.bin", offset: 0, len: 4 })).toMatchObject({ ok: false, error: { kind: "Other", detail: "range provider IO" } });
    await platform.closeRangeReads();
  });
});
