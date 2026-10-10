import { describe, expect, it, vi } from "vitest";
import { ATTACHMENT_RANGE_BYTES, AttachmentRangeOpenError, BoundedRangeSource, type RangeBackend, type RangeSnapshot } from "../src/attachments/range.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function backend(over: Partial<RangeBackend> = {}) {
  const snapshot: RangeSnapshot = { kind: "file", identity: "file1", version: "v1", size: 20 };
  return {
    close: vi.fn(over.close ?? (async () => {})),
    snapshot: vi.fn(over.snapshot ?? (async () => ({ ...snapshot }))),
    readInto: vi.fn(over.readInto ?? (async (offset: number, target: Uint8Array) => {
      target.forEach((_, i) => { target[i] = offset + i; });
      return target.length;
    })),
  };
}

describe("bounded range source", () => {
  it("handles short native reads, EOF, and wipes a released lease", async () => {
    const b = backend({ readInto: async (offset, target) => { target[0] = offset; return 1; } });
    const source = await BoundedRangeSource.open(b);
    const lease = await source.readAt(17, 8);
    const borrowed = lease.bytes;
    expect([...borrowed]).toEqual([17, 18, 19]);
    await expect(source.readAt(0, 1)).rejects.toMatchObject({ code: "busy" });
    lease.release(); lease.release();
    expect(borrowed.byteLength === 0 || borrowed.every(v => v === 0)).toBe(true);
    expect(() => lease.bytes).toThrow();
    const eof = await source.readAt(20, 1);
    expect(eof.bytes.length).toBe(0);
    eof.release();
    await source.close(); await source.close();
    expect(b.close).toHaveBeenCalledOnce();
  });
  it("older hosts without ArrayBuffer.transfer still wipe released bytes", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "transfer");
    Object.defineProperty(ArrayBuffer.prototype, "transfer", { value: undefined, configurable: true });
    let source: BoundedRangeSource | undefined;
    try {
      source = await BoundedRangeSource.open(backend());
      const lease = await source.readAt(0, 4);
      const view = lease.bytes;
      lease.release();
      expect([...view]).toEqual([0, 0, 0, 0]);
    } finally {
      await source?.close();
      if (descriptor) Object.defineProperty(ArrayBuffer.prototype, "transfer", descriptor);
      else Reflect.deleteProperty(ArrayBuffer.prototype, "transfer");
    }
  });
  it("rejects oversize/unsafe/negative inputs BEFORE backend IO or buffer allocation", async () => {
    const b = backend();
    const source = await BoundedRangeSource.open(b);
    for (const [offset, length] of [[-1, 1], [0, -1], [0.5, 1], [21, 1], [Number.MAX_SAFE_INTEGER + 1, 1], [0, NaN]])
      await expect(source.readAt(offset!, length!)).rejects.toMatchObject({ code: "invalid_range" });
    await expect(source.readAt(0, ATTACHMENT_RANGE_BYTES + 1)).rejects.toMatchObject({ code: "full" });
    expect(b.readInto).not.toHaveBeenCalled();
    expect(b.snapshot).toHaveBeenCalledOnce();
    await source.close();
  });
  it("has a configurable total-size bound without increasing the chunk bound", async () => {
    const b = backend({ snapshot: async () => ({ kind: "file", identity: "f", version: "v", size: 1024 ** 3 + 1 }) });
    await expect(BoundedRangeSource.open(b)).rejects.toMatchObject({ code: "full" });
    const larger = await BoundedRangeSource.open(backend({ snapshot: b.snapshot }), { maxFileBytes: 2 * 1024 ** 3 });
    await expect(larger.readAt(0, ATTACHMENT_RANGE_BYTES + 1)).rejects.toMatchObject({ code: "full" });
    await larger.close();
  });
  it("closes ownership on invalid metadata/open IO/invalid config without exposing provider errors", async () => {
    for (const snapshot of [
      { kind: "other", identity: "f", version: "v", size: 20 },
      { kind: "file", identity: "", version: "v", size: 20 },
      { kind: "file", identity: "f", version: "v", size: Infinity },
    ] as RangeSnapshot[]) {
      const b = backend({ snapshot: async () => snapshot });
      await expect(BoundedRangeSource.open(b)).rejects.toMatchObject({ code: "unsupported" });
      expect(b.close).toHaveBeenCalledOnce();
    }
    const b = backend({ snapshot: async () => { throw new Error("private provider path"); } });
    await expect(BoundedRangeSource.open(b)).rejects.toMatchObject({ code: "io", message: "attachment range: io" });
    expect(b.close).toHaveBeenCalledOnce();
    const bad = backend();
    await expect(BoundedRangeSource.open(bad, { maxFileBytes: -1 })).rejects.toMatchObject({ code: "invalid_range" });
    expect(bad.close).toHaveBeenCalledOnce();
  });
  it("failed-open close retains an explicit cleanup retry without serializing the backend", async () => {
    const b = backend({ snapshot: async () => { throw new Error("private backend"); } });
    b.close.mockRejectedValueOnce(new Error("private close"));
    let error: unknown;
    try { await BoundedRangeSource.open(b); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(AttachmentRangeOpenError);
    expect(JSON.stringify(error)).not.toMatch(/private backend|private close|snapshot|readInto/);
    await (error as AttachmentRangeOpenError).retryCleanup();
    expect(b.close).toHaveBeenCalledTimes(2);
  });
  it("detects pre-read substitution without calling read", async () => {
    const b = backend();
    const source = await BoundedRangeSource.open(b);
    b.snapshot.mockResolvedValue({ kind: "file", identity: "replaced", version: "v1", size: 20 });
    await expect(source.readAt(0, 10)).rejects.toMatchObject({ code: "source_changed" });
    expect(b.readInto).not.toHaveBeenCalled();
    await source.close();
  });
  it("wipes data and fails stop on mutation during the read", async () => {
    let buffer!: Uint8Array;
    const b = backend({ readInto: async (_, target) => { buffer = target; target.fill(42); return target.length; } });
    b.snapshot.mockResolvedValueOnce({ kind: "file", identity: "f", version: "v", size: 20 })
      .mockResolvedValueOnce({ kind: "file", identity: "f", version: "v", size: 20 })
      .mockResolvedValue({ kind: "file", identity: "f", version: "changed", size: 20 });
    const source = await BoundedRangeSource.open(b);
    await expect(source.readAt(0, 10)).rejects.toMatchObject({ code: "source_changed" });
    expect(buffer.byteLength === 0 || buffer.every(v => v === 0)).toBe(true);
    await expect(source.readAt(0, 1)).rejects.toMatchObject({ code: "closed" });
    await source.close();
  });
  it.each([0, -1, 100, NaN])("rejects invalid provider read count %s", async (count) => {
    const source = await BoundedRangeSource.open(backend({ readInto: async () => count }));
    await expect(source.readAt(0, 10)).rejects.toMatchObject({ code: "source_changed" });
    await source.close();
  });
  it("rejects concurrent pulls rather than queuing chunk buffers", async () => {
    const pending = deferred<number>();
    const started = deferred<void>();
    const source = await BoundedRangeSource.open(backend({ readInto: async (_, target) => { started.resolve(); target.fill(7); return pending.promise; } }));
    const first = source.readAt(0, 4);
    await started.promise;
    await expect(source.readAt(4, 4)).rejects.toMatchObject({ code: "busy" });
    pending.resolve(4);
    (await first).release();
    await source.close();
  });
  it.each(["close", "abort"])("%s fences a late read completion and wipes its target", async (action) => {
    const pending = deferred<number>();
    const started = deferred<void>();
    let buffer!: Uint8Array;
    const b = backend({ readInto: async (_, target) => { buffer = target; started.resolve(); return pending.promise; } });
    const source = await BoundedRangeSource.open(b);
    const controller = new AbortController();
    const result = source.readAt(0, 4, controller.signal);
    const failure = expect(result).rejects.toMatchObject({ code: "closed" });
    await started.promise;
    if (action === "abort") controller.abort(); else void source.close();
    expect(b.close).not.toHaveBeenCalled(); // no handle close during outstanding IO
    buffer.fill(123); // simulate an operation completing AFTER cancellation
    pending.resolve(4);
    await failure;
    await source.close();
    expect(buffer.byteLength === 0 || buffer.every(v => v === 0)).toBe(true);
    expect(b.close).toHaveBeenCalledOnce();
  });
  it("does no provider IO for an already aborted request", async () => {
    const b = backend();
    const source = await BoundedRangeSource.open(b);
    const controller = new AbortController(); controller.abort();
    await expect(source.readAt(0, 4, controller.signal)).rejects.toMatchObject({ code: "closed" });
    expect(b.readInto).not.toHaveBeenCalled();
    await source.close();
  });
  it("close invalidates a delivered lease and retains retryable cleanup", async () => {
    const b = backend();
    b.close.mockRejectedValueOnce(new Error("close failure"));
    const source = await BoundedRangeSource.open(b);
    const lease = await source.readAt(0, 4);
    const view = lease.bytes;
    await expect(source.close()).rejects.toThrow("close failure");
    expect(view.byteLength === 0 || view.every(v => v === 0)).toBe(true);
    await source.close();
    expect(b.close).toHaveBeenCalledTimes(2);
    await expect(source.readAt(0, 1)).rejects.toMatchObject({ code: "closed" });
  });
});
