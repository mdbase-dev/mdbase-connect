import { describe, expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { encode, type CborValue } from "../src/cbor.js";
import { uuidToBytes } from "../src/codec.js";
import { AppLogPump, type AppLogCall, type AppLogRuntime, type AppLogTransport } from "../src/app-host/index.js";
const COLLECTION = "00000000-0000-4000-8000-000000000003";
const OTHER = "00000000-0000-4000-8000-000000000004";
function call(id: number | bigint = 1, method = "head", params = new Map<number, CborValue>([[0, uuidToBytes(COLLECTION)]])): AppLogCall {
  return { endpoint: 37, frame: encode(new Map<number, CborValue>([[0, 0], [1, id], [2, method], [3, params]])) };
}
function fixture(initial = [call()], maxRounds?: number) {
  const queue = [...initial];
  let current = true;
  const runtime: AppLogRuntime = {
    takeLogCalls: vi.fn(() => queue.splice(0)),
    acceptLogReply: vi.fn(() => true),
    logNoResponse: vi.fn(),
    retireLog: vi.fn(),
  };
  const transport: AppLogTransport = {
    endpoint: 37, collection: COLLECTION,
    isCurrent: vi.fn(() => current),
    send: vi.fn(async () => Uint8Array.of(1, 2, 3)),
  };
  const pump = new AppLogPump(runtime, transport, { endpoint: 37, collection: COLLECTION, maxRounds });
  return { runtime, transport, pump, queue, stale: () => { current = false; } };
}
function deferred<T>() { let resolve!: (x: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe("app log pump (immutable authenticated binding)", () => {
  it("sends only captured exact sealed frames and coalesces concurrent kicks", async () => {
    const original = call((1n << 64n) - 1n, "append");
    const frame = original.frame.slice();
    const f = fixture([original]);
    const gate = deferred<Uint8Array>();
    vi.mocked(f.transport.send).mockReturnValueOnce(gate.promise);
    const run = f.pump.pump();
    expect(f.pump.pump()).toBe(run);
    await flush();
    original.frame.fill(255); original.endpoint = 999;
    expect(vi.mocked(f.transport.send).mock.calls[0]![0]).toEqual({ endpoint: 37n, frame });
    const reply = Uint8Array.of(5, 6, 7);
    gate.resolve(reply);
    expect(await run).toEqual({ quiet: true });
    expect(f.runtime.acceptLogReply).toHaveBeenCalledWith((1n << 64n) - 1n, reply);
    expect([...reply]).toEqual([0, 0, 0]);
    expect(vi.mocked(f.transport.send).mock.calls[0]![0].frame.every((b) => b === 0)).toBe(true);
    expect(f.runtime.logNoResponse).not.toHaveBeenCalled();
    await f.pump.close();
  });
  it("captures the whole turn before an earlier reply can mutate later calls", async () => {
    const later = call(2);
    const exact = later.frame.slice();
    const f = fixture([call(1), later]);
    const sent: Uint8Array[] = [];
    vi.mocked(f.transport.send).mockImplementation(async (c) => {
      sent.push(c.frame.slice()); later.frame.fill(255);
      return Uint8Array.of(1);
    });
    await f.pump.pump(); expect(sent[1]).toEqual(exact); await f.pump.close();
  });
  it("treats network/abort/malformed replies only as no response, not a rejection", async () => {
    const f = fixture([call(1, "append"), call(2)]);
    vi.mocked(f.transport.send).mockRejectedValueOnce(new Error("secret token"));
    vi.mocked(f.runtime.acceptLogReply).mockReturnValueOnce(false);
    expect(await f.pump.pump()).toEqual({ quiet: true });
    expect(vi.mocked(f.runtime.logNoResponse).mock.calls).toEqual([[1n], [2n]]);
    expect(f.pump.fenced).toBe(false); await f.pump.close();
  });
  it("bounds remote replies without decoding a remote result tree in JS", async () => {
    const f = fixture();
    const reply = new Uint8Array(16 * 1024 * 1024 + 1).fill(3);
    vi.mocked(f.transport.send).mockResolvedValueOnce(reply);
    await f.pump.pump();
    expect(f.runtime.acceptLogReply).not.toHaveBeenCalled(); expect(f.runtime.logNoResponse).toHaveBeenCalledWith(1n);
    expect(reply.every((b) => b === 0)).toBe(true); await f.pump.close();
  });
  it("passes large sealed object sidecars only to a direct-transfer-capable port", async () => {
    const bytes = new Uint8Array(1024 * 1024 + 1).fill(7);
    const c = call(7, "put_object", new Map<number, CborValue>([[0, uuidToBytes(COLLECTION)], [1, new Uint8Array(32)], [2, 2], [3, bytes.length], [4, sha256(bytes)]]));
    c.sidecar = bytes;
    const f = fixture([c]);
    let sent: Uint8Array | undefined;
    vi.mocked(f.transport.send).mockImplementation(async (c) => { sent = c.sidecar!.slice(); return Uint8Array.of(1); });
    await f.pump.pump();
    // Vitest's object traversal over >1M indexed properties can exceed its
    // default timeout on contended CI. Check every byte, without materializing
    // an enormous matcher tree or weakening the exact-byte assertion.
    expect(sent!.length).toBe(bytes.length);
    expect(sent!.every((b, i) => b === bytes[i])).toBe(true);
    expect(bytes[0]).toBe(7); // Borrowed runtime input untouched.
    expect(vi.mocked(f.transport.send).mock.calls[0]![0].sidecar!.every((b) => b === 0)).toBe(true);
    await f.pump.close();
  });
  it.each([
    { endpoint: 38, collection: COLLECTION }, { endpoint: 37, collection: OTHER },
    { endpoint: -1, collection: COLLECTION }, { endpoint: 37, collection: "bad" },
  ])("refuses mismatched bindings before runtime calls", (binding) => {
    const f = fixture();
    expect(() => new AppLogPump(f.runtime, f.transport, binding)).toThrow("invalid_binding");
    expect(f.runtime.takeLogCalls).not.toHaveBeenCalled();
  });
  it("never dispatches an already-stale authenticated binding", async () => {
    const f = fixture(); f.stale();
    expect(await f.pump.pump()).toEqual({ quiet: true });
    expect(f.runtime.takeLogCalls).not.toHaveBeenCalled(); expect(f.transport.send).not.toHaveBeenCalled();
    expect(f.runtime.retireLog).toHaveBeenCalledOnce(); await f.pump.close();
  });
  it("late replies after account/device generation change cannot feed this runtime", async () => {
    const f = fixture([call(1, "append")]);
    const gate = deferred<Uint8Array>(); vi.mocked(f.transport.send).mockReturnValueOnce(gate.promise);
    const run = f.pump.pump(); await flush(); f.stale();
    const reply = Uint8Array.of(42); gate.resolve(reply);
    expect(await run).toEqual({ quiet: true });
    expect(f.runtime.acceptLogReply).not.toHaveBeenCalled(); expect(f.runtime.logNoResponse).not.toHaveBeenCalled();
    expect(reply[0]).toBe(0); expect(f.runtime.retireLog).toHaveBeenCalledOnce(); await f.pump.close();
  });
  it("close retires and aborts first, then waits for an abort-ignoring transport", async () => {
    const f = fixture(); const gate = deferred<Uint8Array>();
    let signal: AbortSignal | undefined;
    vi.mocked(f.transport.send).mockImplementation((_, options) => { signal = options.signal; return gate.promise; });
    const run = f.pump.pump(); await flush();
    let closed = false; const close = f.pump.close().then(() => { closed = true; });
    await flush(); expect(signal!.aborted).toBe(true); expect(closed).toBe(false);
    expect(f.runtime.retireLog).toHaveBeenCalledOnce();
    gate.resolve(Uint8Array.of(1)); await run; await close;
    expect(f.runtime.acceptLogReply).not.toHaveBeenCalled(); await f.pump.close();
    expect(f.runtime.retireLog).toHaveBeenCalledOnce(); expect(await f.pump.pump()).toEqual({ quiet: true });
  });
  it("cannot dynamically repoint a transport after awaiting a reply", async () => {
    const f = fixture(); const gate = deferred<Uint8Array>();
    vi.mocked(f.transport.send).mockReturnValueOnce(gate.promise);
    const run = f.pump.pump(); await flush();
    Object.assign(f.transport, { collection: OTHER }); gate.resolve(Uint8Array.of(1));
    await expect(run).rejects.toThrow("fenced"); expect(f.runtime.acceptLogReply).not.toHaveBeenCalled();
    expect(f.runtime.retireLog).toHaveBeenCalledOnce();
  });
  it("bounds a turn and lets the caller schedule subsequent work", async () => {
    const f = fixture([call(1)], 1);
    vi.mocked(f.runtime.acceptLogReply).mockImplementation(() => { f.queue.push(call(2)); return true; });
    expect(await f.pump.pump()).toEqual({ quiet: false }); expect(f.transport.send).toHaveBeenCalledOnce();
    vi.mocked(f.runtime.acceptLogReply).mockReturnValue(true);
    expect(await f.pump.pump()).toEqual({ quiet: false });
    expect(await f.pump.pump()).toEqual({ quiet: true }); await f.pump.close();
  });
  it.each([
    [call(), call()], [call(1), { ...call(2), endpoint: 38 }],
    [call(1, "hello")], [call(-1)], [call(1, "future")],
    [call(1, "head", new Map([[0, uuidToBytes(OTHER)]]))],
    [{ ...call(), frame: Uint8Array.of(255) }],
    [{ ...call(), sidecar: Uint8Array.of(1) }],
    [call(1), { ...call(2), frame: new Uint8Array(16 * 1024 * 1024 + 1) }],
    Array.from({ length: 65 }, (_, i) => call(i)),
  ].map((calls) => ({ calls })))("fences the entire malformed turn before dispatch", async ({ calls }) => {
    const f = fixture(calls);
    await expect(f.pump.pump()).rejects.toThrow("fenced");
    expect(f.transport.send).not.toHaveBeenCalled(); expect(f.runtime.acceptLogReply).not.toHaveBeenCalled();
    expect(f.runtime.retireLog).toHaveBeenCalledOnce(); await expect(f.pump.pump()).rejects.toThrow("fenced");
  });
  it("refuses invalid direct sidecar size/checksum rather than inventing completion", async () => {
    const bytes = new Uint8Array(1024 * 1024 + 1);
    const c = call(1, "put_object", new Map<number, CborValue>([[0, uuidToBytes(COLLECTION)], [3, bytes.length], [4, new Uint8Array(32)]]));
    c.sidecar = bytes; const f = fixture([c]);
    await expect(f.pump.pump()).rejects.toThrow("fenced"); expect(f.transport.send).not.toHaveBeenCalled();
  });
  it("never converts a runtime trap to a successful transport outcome", async () => {
    const f = fixture();
    vi.mocked(f.runtime.acceptLogReply).mockImplementation(() => { throw new Error("private runtime detail"); });
    await expect(f.pump.pump()).rejects.toThrow("app log host: fenced");
    expect(f.runtime.logNoResponse).not.toHaveBeenCalled(); expect(f.runtime.retireLog).toHaveBeenCalledOnce();
  });
});
