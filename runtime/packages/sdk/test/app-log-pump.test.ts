import { describe, expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { decode, encode, type CborValue } from "../src/cbor.js";
import { uuidToBytes } from "../src/codec.js";
import { AppLogPump, AppHttpLogError, appLogHealth, type AppLogCall, type AppLogRuntime, type AppLogTransport } from "../src/app-host/index.js";
import { appServerProblem } from "../src/app-host/cp-problem.js";
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
  it("treats network/abort/malformed replies only as no response, not a rejection", async () => {
    const f = fixture([call(1, "append"), call(2)]);
    vi.mocked(f.transport.send).mockRejectedValueOnce(new Error("secret token"));
    vi.mocked(f.runtime.acceptLogReply).mockReturnValueOnce(false);
    expect(await f.pump.pump()).toEqual({ quiet: true });
    expect(vi.mocked(f.runtime.logNoResponse).mock.calls).toEqual([[1n], [2n]]);
    expect(f.pump.fenced).toBe(false); await f.pump.close();
  });
  it("keeps a live server refusal visible until a reply is accepted again", async () => {
    const f = fixture([call(1)]);
    const server = appServerProblem(409, { error: { code: "collection_migrating", details: { retry_after_seconds: 60 } } });
    vi.mocked(f.transport.send).mockRejectedValueOnce(new AppHttpLogError("collection_migrating", server))
      .mockRejectedValueOnce(Object.assign(new Error("lookalike"), { server: { ...server } }));
    await f.pump.pump();
    expect(f.pump.serverProblem).toBe(server); expect(f.runtime.logNoResponse).toHaveBeenCalledWith(1n);
    f.queue.push(call(2)); await f.pump.pump();
    expect(f.pump.serverProblem).toBe(server); // forged problem objects are ignored
    f.queue.push(call(3)); await f.pump.pump();
    expect(f.pump.serverProblem).toBeNull(); await f.pump.close();
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
    { endpoint: 37, collection: OTHER },
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
  it("bounds a turn and lets the caller schedule subsequent work", async () => {
    const f = fixture([call(1)], 1);
    vi.mocked(f.runtime.acceptLogReply).mockImplementation(() => { f.queue.push(call(2)); return true; });
    expect(await f.pump.pump()).toEqual({ quiet: false }); expect(f.transport.send).toHaveBeenCalledOnce();
    vi.mocked(f.runtime.acceptLogReply).mockReturnValue(true);
    expect(await f.pump.pump()).toEqual({ quiet: false });
    expect(await f.pump.pump()).toEqual({ quiet: true }); await f.pump.close();
  });
  it.each([
    [call(), call()],
    [call(1, "head", new Map([[0, uuidToBytes(OTHER)]]))],
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
  it("sends order-insensitive runs together, keeps appends as barriers and accepts in call order", async () => {
    const f = fixture([call(1, "read"), call(2, "head"), call(3, "put_object"), call(4, "append"), call(5, "head")]);
    const gates = new Map<bigint, ReturnType<typeof deferred<Uint8Array>>>();
    vi.mocked(f.transport.send).mockImplementation(c => {
      const id = BigInt((decode(c.frame) as Map<number, CborValue>).get(1) as number);
      const g = deferred<Uint8Array>(); gates.set(id, g); return g.promise;
    });
    const run = f.pump.pump();
    await flush();
    expect([...gates.keys()]).toEqual([1n, 2n, 3n]); // the append waits for all three
    gates.get(3n)!.resolve(Uint8Array.of(3)); gates.get(2n)!.resolve(Uint8Array.of(2));
    await flush();
    expect(f.runtime.acceptLogReply).not.toHaveBeenCalled(); // call 1 is still out
    gates.get(1n)!.resolve(Uint8Array.of(1));
    for (let i = 0; i < 10 && !gates.has(4n); i++) await flush();
    expect(vi.mocked(f.runtime.acceptLogReply).mock.calls.map(c => c[0])).toEqual([1n, 2n, 3n]);
    expect(gates.has(5n)).toBe(false); // nothing after the barrier until it answers
    gates.get(4n)!.resolve(Uint8Array.of(4));
    for (let i = 0; i < 10 && !gates.has(5n); i++) await flush();
    gates.get(5n)!.resolve(Uint8Array.of(5));
    expect(await run).toEqual({ quiet: true });
    expect(vi.mocked(f.runtime.acceptLogReply).mock.calls.map(c => c[0])).toEqual([1n, 2n, 3n, 4n, 5n]);
    await f.pump.close();
  });
  it("reports typed transport health and clears it on the next accepted reply", async () => {
    const busy = appServerProblem(503, undefined, new Headers({ "retry-after": "30" }));
    expect(appLogHealth(new AppHttpLogError("unavailable", busy))).toEqual({ kind: "server_busy", retryAfterMs: 30_000 });
    expect(appLogHealth(new AppHttpLogError("unavailable", appServerProblem(429, undefined)))).toEqual({ kind: "rate_limited", retryAfterMs: null });
    expect(appLogHealth(new AppHttpLogError("unavailable", appServerProblem(401, undefined)))).toEqual({ kind: "auth" });
    expect(appLogHealth(new AppHttpLogError("unavailable"), false)).toEqual({ kind: "offline" });
    expect(appLogHealth(new AppHttpLogError("unavailable"), true)).toEqual({ kind: "unreachable" });
    expect(appLogHealth(new AppHttpLogError("fenced"), false)).toBeNull();
    const f = fixture([call(1)]);
    vi.mocked(f.transport.send).mockRejectedValueOnce(new AppHttpLogError("unavailable", busy));
    await f.pump.pump();
    expect(f.pump.transportHealth).toEqual({ kind: "server_busy", retryAfterMs: 30_000 });
    f.queue.push(call(2)); await f.pump.pump();
    expect(f.pump.transportHealth).toBeNull();
    await f.pump.close();
  });
});
