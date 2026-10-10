import { describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { AppHttpLogTransport, type AppLogHttpAuthority, type AppLogHttpProof } from "../src/app-host/http-log.js";
import { decode, encode, toHex, type CborValue } from "../src/cbor.js";
import { uuidToBytes } from "../src/codec.js";
import { AppLogPump, type AppLogCall, type AppLogRuntime } from "../src/app-host/log-pump.js";

const COLLECTION = "22222222-2222-2222-2222-222222222222", ORIGIN = "https://log.test", OBJECT_ORIGIN = "https://objects.test", NOW = 1_800_000_000_000;
type M = Map<CborValue, CborValue>;
const response = (id: CborValue, result: CborValue) => encode(new Map<number, CborValue>([[0, 1], [1, id], [2, result]]));
const request = (method = "head", p: Map<number, CborValue> = new Map([[0, uuidToBytes(COLLECTION)]]), id: number | bigint = 1): AppLogCall => ({ endpoint: 37, frame: encode(new Map<number, CborValue>([[0, 0], [1, id], [2, method], [3, p]])) });
const body = (init?: RequestInit) => decode(init!.body as Uint8Array) as M;
const binary = (bytes: Uint8Array) => new Response(bytes.slice(), { headers: { "content-length": String(bytes.length) } });
const target = (headers = new Map<string, CborValue>(), url = `${OBJECT_ORIGIN}/sealed?signature=private-capability`, expires = NOW + 120_000) => new Map<number, CborValue>([[0, url], [1, headers], [2, expires]]);
function fixture(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  let current = true; const proofs: AppLogHttpProof[] = [];
  const auth: AppLogHttpAuthority = { endpoint: 37, collection: COLLECTION, origin: ORIGIN, directOrigins: [OBJECT_ORIGIN], isCurrent: () => current,
    accessToken: vi.fn(async () => "public-fixture-token"), signLogProof: vi.fn(async p => { proofs.push({ ...p, nonce: p.nonce.slice(), digest: p.digest.slice(), bodyHash: p.bodyHash.slice(), tokenHash: p.tokenHash.slice() }); return ed25519.sign(p.digest, new Uint8Array(32).fill(0x33)); }) };
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => String(url).endsWith("/v1/nonce") ? new Response("11".repeat(32)) : handler(String(url), init));
  const transport = new AppHttpLogTransport(auth, { fetch, now: () => NOW });
  const send = (call: AppLogCall) => transport.send(call, { signal: new AbortController().signal });
  return { transport, auth, fetch, proofs, send, stale: () => { current = false; } };
}
function put(object: Uint8Array): AppLogCall {
  return { ...request("put_object", new Map<number, CborValue>([[0, uuidToBytes(COLLECTION)], [1, new Uint8Array(32).fill(7)], [2, 2], [3, object.length], [4, sha256(object)]])), sidecar: object };
}
function get() { return request("get_object", new Map<number, CborValue>([[0, uuidToBytes(COLLECTION)], [1, new Uint8Array(32).fill(7)]])); }
const base64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

describe("actual HTTP framing/authentication port", () => {
  it.each(["br", "gzip", "hidden", "absent"])("admits decoded nonce/RPC %s with wire-length hints, retaining exact call echo", async encoding => {
    const f = fixture((_url, init) => {
      const bytes = response(body(init).get(1)!, null), headers: Record<string,string> = {};
      if (encoding !== "absent") headers["content-length"] = "1";
      if (encoding === "br" || encoding === "gzip") headers["content-encoding"] = encoding;
      return new Response(bytes.slice(), {headers});
    });
    vi.mocked(f.fetch).mockImplementation(async (input,init) => {
      const headers: Record<string,string> = encoding === "absent" ? {} : {"content-length":"4"};
      if (encoding === "br" || encoding === "gzip") headers["content-encoding"] = encoding;
      return String(input).endsWith('/v1/nonce') ? new Response("11".repeat(32),{headers}) : new Response(response(body(init).get(1)!,null).slice(),{headers});
    });
    expect((decode(await f.send(request())) as M).get(1)).toBe(1);
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it("cancels nonce decoded overflow even when wire length is small", async () => {
    const f = fixture(() => {throw Error("RPC must not run");}), cancel = vi.fn();let sent=false;
    vi.mocked(f.fetch).mockResolvedValue(new Response(new ReadableStream({pull(controller){if(!sent){sent=true;controller.enqueue(new Uint8Array(129).fill(65));}},cancel}), {headers:{"content-length":"4","content-encoding":"br"}}));
    await expect(f.send(request())).rejects.toMatchObject({reason:"integrity"});
    await vi.waitFor(()=>expect(cancel).toHaveBeenCalledOnce());expect(f.fetch).toHaveBeenCalledOnce();
  });
  it("matches the public native ls-http vector and captures exact signed/sent bytes", async () => {
    let signature = "", sent = "";
    const f = fixture((_url, init) => { sent = toHex(init!.body as Uint8Array); signature = new Headers(init!.headers).get("x-mdbase-sig")!; return binary(response(1, new Map())); });
    const call = request(); await f.send(call);
    expect(sent).toBe("a40000010102646865616403a1005022222222222222222222222222222222");
    expect(toHex(f.proofs[0]!.digest)).toBe("754b42cd0f5ffd33c1a5a25fc6b65bfe3d6dbe6f712ae38561fcfad7421c7bdb");
    expect(signature).toBe("3920af542e0d7ea4bf756f8aed0d7c71c4e84d22812a40a4004528798f3ba46f58f14b7b4562383e8240964aceabb42aadad596cce36c5414f7dfb9fbe529a03");
    for (const [, init] of f.fetch.mock.calls) expect(init).toMatchObject({ redirect: "error", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" });
  });
  it("captures mutable input before awaiting the token/signature", async () => {
    const f = fixture((_url, init) => binary(response((body(init)).get(1)!, null))), call = request(); const original = call.frame.slice();
    const sent = f.send(call); call.frame.fill(0); await sent;
    expect(f.proofs[0]!.bodyHash).toEqual(sha256(original));
  });
  it("refuses endpoint/collection/ID/sidecar misuse before token/HTTP effects", async () => {
    const f = fixture(() => { throw new Error("must not fetch"); });
    const calls = [{ ...request(), endpoint: 38 }, request("head", new Map([[0, new Uint8Array(16)]])), { ...request(), sidecar: new Uint8Array(1) }];
    for (const call of calls) await expect(f.send(call)).rejects.toMatchObject({ reason: "shape" });
    expect(f.auth.accessToken).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
  });
  it("refuses unsafe numeric IDs, retains actual u64 ID without rounding", async () => {
    const id = (1n << 64n) - 3n;
    const f = fixture((_url, init) => binary(response(body(init).get(1)!, null)));
    const out = decode(await f.send(request("head", undefined, id))) as M; expect(out.get(1)).toBe(id);
    const bad = request(); bad.endpoint = Number.MAX_SAFE_INTEGER + 1;
    await expect(f.send(bad)).rejects.toMatchObject({ reason: "shape" });
  });
  it("checks generation after token and signer awaits, never posts stale requests", async () => {
    const f = fixture(() => { throw new Error("must not POST"); });
    vi.mocked(f.auth.accessToken).mockImplementation(async () => { f.stale(); return "token"; });
    await expect(f.send(request())).rejects.toMatchObject({ reason: "fenced" }); expect(f.fetch).not.toHaveBeenCalled();
    const g = fixture(() => { throw new Error("must not POST"); });
    vi.mocked(g.auth.signLogProof).mockImplementation(async () => { g.stale(); return new Uint8Array(64); });
    await expect(g.send(request())).rejects.toMatchObject({ reason: "fenced" }); expect(g.fetch).toHaveBeenCalledTimes(1);
  });
  it("sanitizes token/signer/network errors and refuses malformed/mis-correlated RPC replies", async () => {
    for (const fail of [new Error("private bearer URL"), null]) {
      const f = fixture((_url, _init) => { if (fail) throw fail; return binary(response(9, null)); });
      await expect(f.send(request())).rejects.toThrow(/^app log transport: (unavailable|shape)$/);
    }
    const f = fixture(() => binary(new Uint8Array())); vi.mocked(f.auth.signLogProof).mockRejectedValue(new Error("private seed"));
    await expect(f.send(request())).rejects.toThrow("app log transport: unavailable");
  });
  it("limits streamed RPC replies before full allocation and aborts stale reads", async () => {
    const chunk = new Uint8Array(1024);
    const f = fixture(() => new Response(new ReadableStream({ pull(c) { f.stale(); c.enqueue(chunk); } })));
    await expect(f.send(request())).rejects.toMatchObject({ reason: "fenced" }); expect(chunk.every(v => v === 0)).toBe(true);
    const g = fixture(() => new Response(new Uint8Array(), { headers: { "content-length": String(16 * 1024 * 1024 + 1) } }));
    await expect(g.send(request())).rejects.toMatchObject({ reason: "integrity" });
  });
});

describe("staged upload + authoritative commit", () => {
  it("keeps small inline Stored/Exists replies and exact bytes without a direct request", async () => {
    const object = Uint8Array.of(1, 2, 3), ck = sha256(object);
    for (const status of [0, 2]) {
      const f = fixture((_url, init) => { expect((body(init).get(3) as M).get(5)).toEqual(object); return binary(response(body(init).get(1)!, new Map([[0, status]]))); });
      const call = request("put_object", new Map<number, CborValue>([[0, uuidToBytes(COLLECTION)], [1, new Uint8Array(32)], [2, 2], [3, 3], [4, ck], [5, object]]));
      expect(((decode(await f.send(call)) as M).get(2) as M).get(0)).toBe(status); expect(f.fetch).toHaveBeenCalledTimes(2);
    }
  });
  it("unknown commit and late successful commit never become a completed original put", async () => {
    for (const late of [false, true]) {
      const object = new Uint8Array(1024 * 1024 + 1), f = fixture((url, init) => {
        if (url.startsWith(OBJECT_ORIGIN)) return new Response(null);
        const m = body(init);
        if (m.get(2) === "put_object") return binary(response(m.get(1)!, new Map<number, CborValue>([[0, 1], [1, target()]])));
        if (late) { f.stale(); return binary(response(m.get(1)!, true)); } throw new Error("commit uncertain private URL");
      });
      await expect(f.send(put(object))).rejects.toMatchObject({ reason: late ? "fenced" : "unavailable" });
    }
  });
  it.each(["success", "unknown"] as const)("normalizes original put only after commit_object true (%s PUT)", async outcome => {
    const object = new Uint8Array(1024 * 1024 + 1).fill(42), events: string[] = []; let commitId: CborValue | undefined;
    const f = fixture((url, init) => {
      if (url.startsWith(OBJECT_ORIGIN)) { events.push("PUT"); expect(init!.method).toBe("PUT"); expect(new Headers(init!.headers).has("authorization")).toBe(false); expect(new Headers(init!.headers).has("cookie")).toBe(false); expect(sha256(init!.body as Uint8Array)).toEqual(sha256(object)); if (outcome === "unknown") throw new Error("unknown PUT URL"); return new Response(null, { status: 200 }); }
      const m = body(init), method = m.get(2); events.push(method as string);
      if (method === "put_object") return binary(response(m.get(1)!, new Map<number, CborValue>([[0, 1], [1, target(new Map([["x-amz-checksum-sha256", base64(sha256(object))]]))]])));
      expect(method).toBe("commit_object"); commitId = m.get(1); expect((m.get(3) as M).get(0)).toEqual(uuidToBytes(COLLECTION)); return binary(response(commitId!, true));
    });
    const result = decode(await f.send(put(object))) as M;
    expect(events).toEqual(["put_object", "PUT", "commit_object"]); expect(commitId).not.toBe(1); expect(result.get(1)).toBe(1); expect((result.get(2) as M).get(0)).toBe(0); expect(object[0]).toBe(42);
  });
  it.each([false, null])("does not report a staged target/negative commit as stored (%s)", async committed => {
    const object = new Uint8Array(1024 * 1024 + 1).fill(7);
    const f = fixture((url, init) => url.startsWith(OBJECT_ORIGIN) ? new Response(null) : binary(response(body(init).get(1)!, body(init).get(2) === "put_object" ? new Map<number, CborValue>([[0, 1], [1, target()]]) : committed)));
    await expect(f.send(put(object))).rejects.toMatchObject({ reason: "unavailable" });
  });
  it("refuses wrong size/hash before effects and invalid direct origins/headers/expiry before PUT", async () => {
    const object = new Uint8Array(1024 * 1024 + 1).fill(7), bad = put(object); bad.sidecar = new Uint8Array(object.length + 1);
    const no = fixture(() => { throw new Error("must not fetch"); }); await expect(no.send(bad)).rejects.toMatchObject({ reason: "integrity" }); expect(no.fetch).not.toHaveBeenCalled();
    const targets = [target(new Map(), "https://foreign.test/object"), target(new Map([["Authorization", "Bearer secret"]])), target(new Map([["Cookie", "secret"]])), target(new Map([["range", "bytes=1-2"]])), target(new Map([["x-amz-checksum-sha256", "wrong"]])), target(new Map(), `${OBJECT_ORIGIN}/object`, NOW + 4_999), target(new Map(), `https://user:password@objects.test/object`), target(new Map([["X-Custom", "a"], ["x-custom", "b"]]))];
    for (const t of targets) { const f = fixture((_url, init) => binary(response(body(init).get(1)!, new Map<number, CborValue>([[0, 1], [1, t]])))); await expect(f.send(put(object))).rejects.toBeInstanceOf(Error); expect(f.fetch.mock.calls.some(([url]) => String(url).startsWith(OBJECT_ORIGIN))).toBe(false); }
  });
  it("generation movement after PUT prevents commit even if upload succeeded", async () => {
    const object = new Uint8Array(1024 * 1024 + 1);
    const f = fixture((url, init) => { if (url.startsWith(OBJECT_ORIGIN)) { f.stale(); return new Response(null); } return binary(response(body(init).get(1)!, new Map<number, CborValue>([[0, 1], [1, target()]]))); });
    await expect(f.send(put(object))).rejects.toMatchObject({ reason: "fenced" }); expect(f.fetch.mock.calls.filter(([u]) => String(u).endsWith("/v1/rpc"))).toHaveLength(1);
  });
});

describe("bounded verified ranged download", () => {
  it("pump.close aborts/drains an in-flight transfer before retirement is complete", async () => {
    let began!: () => void; const begun = new Promise<void>(resolve => { began = resolve; });
    const f = fixture((url, init) => {
      if (!url.startsWith(OBJECT_ORIGIN)) return binary(response(body(init).get(1)!, new Map<number, CborValue>([[1, target()], [2, 2048], [3, new Uint8Array(32)]])));
      began(); return new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("abort")), { once: true }));
    });
    let calls = [get()];
    const runtime: AppLogRuntime = { takeLogCalls: () => { const out = calls; calls = []; return out; }, acceptLogReply: vi.fn(() => true), logNoResponse: vi.fn(), retireLog: vi.fn() };
    const pump = new AppLogPump(runtime, f.transport, { endpoint: 37, collection: COLLECTION });
    const work = pump.pump(); await begun; await pump.close(); await work;
    expect(runtime.retireLog).toHaveBeenCalledOnce(); expect(runtime.acceptLogReply).not.toHaveBeenCalled(); expect(runtime.logNoResponse).not.toHaveBeenCalled();
  });
  const object = Uint8Array.from({ length: 2048 }, (_, i) => i % 251), ck = sha256(object);
  function directResult() { return new Map<number, CborValue>([[1, target()], [2, object.length], [3, ck]]); }
  it("resumes one interrupted stream with exact closed Range, verifies whole object before delivery", async () => {
    let gets = 0;
    const f = fixture((url, init) => {
      if (!url.startsWith(OBJECT_ORIGIN)) return binary(response(body(init).get(1)!, directResult()));
      if (++gets === 1) { let read = false; return new Response(new ReadableStream({ pull(c) { if (!read) { read = true; c.enqueue(object.slice(0, 100)); } else c.error(new Error("interrupted")); } }), { headers: { "content-length": String(object.length) } }); }
      expect(new Headers(init!.headers).get("range")).toBe(`bytes=100-${object.length - 1}`);
      return new Response(object.slice(100), { status: 206, headers: { "content-length": String(object.length - 100), "content-range": `bytes 100-${object.length - 1}/${object.length}`, "x-amz-checksum-sha256": base64(ck) } });
    });
    const result = decode(await f.send(get())) as M; expect((result.get(2) as M).get(0)).toEqual(object); expect(gets).toBe(2);
  });
  it.each(["length", "checksum", "overflow", "encoding", "unexpected-range"] as const)("refuses malformed %s without unverified delivery", async bad => {
    const f = fixture((url, init) => {
      if (!url.startsWith(OBJECT_ORIGIN)) return binary(response(body(init).get(1)!, directResult()));
      const headers: Record<string, string> = { "content-length": bad === "length" ? "2049" : "2048" };
      if (bad === "checksum") headers["x-amz-checksum-sha256"] = "wrong";
      if (bad === "encoding") headers["content-encoding"] = "gzip";
      if (bad === "unexpected-range") headers["content-range"] = "bytes 0-2047/2048";
      return new Response(bad === "overflow" ? new Uint8Array(2049) : object.slice(), { headers });
    });
    await expect(f.send(get())).rejects.toMatchObject({ reason: "integrity" });
  });
  it("rejects short-body resume served as 200 or wrong Content-Range", async () => {
    for (const wrongStatus of [true, false]) {
      let gets = 0;
      const f = fixture((url, init) => { if (!url.startsWith(OBJECT_ORIGIN)) return binary(response(body(init).get(1)!, directResult())); if (++gets === 1) return new Response(object.slice(0, 10), { headers: { "content-length": "2048" } }); return new Response(object.slice(10), { status: wrongStatus ? 200 : 206, headers: { "content-length": "2038", "content-range": "bytes 11-2047/2048" } }); });
      await expect(f.send(get())).rejects.toMatchObject({ reason: "integrity" }); expect(gets).toBe(2);
    }
  });
  it("whole-hash mismatch fails and requested subset is only emitted after whole verification", async () => {
    const f = fixture((url, init) => url.startsWith(OBJECT_ORIGIN) ? new Response(object.slice(), { headers: { "content-length": "2048" } }) : binary(response(body(init).get(1)!, directResult())));
    const call = request("get_object", new Map<number, CborValue>([[0, uuidToBytes(COLLECTION)], [1, new Uint8Array(32)], [2, [100, 10]]]));
    expect(((decode(await f.send(call)) as M).get(2) as M).get(0)).toEqual(object.slice(100, 110));
    const g = fixture((url, init) => url.startsWith(OBJECT_ORIGIN) ? new Response(new Uint8Array(2048), { headers: { "content-length": "2048" } }) : binary(response(body(init).get(1)!, directResult())));
    await expect(g.send(get())).rejects.toMatchObject({ reason: "integrity" });
  });
  it("refuses oversized object before allocation/direct fetch and bounds stalled GETs", async () => {
    const f = fixture((_url, init) => binary(response(body(init).get(1)!, new Map<number, CborValue>([[1, target()], [2, 9 * 1024 * 1024 + 1], [3, ck]]))));
    await expect(f.send(get())).rejects.toMatchObject({ reason: "shape" }); expect(f.fetch).toHaveBeenCalledTimes(2);
    let gets = 0; const g = fixture((url, init) => { if (!url.startsWith(OBJECT_ORIGIN)) return binary(response(body(init).get(1)!, directResult())); gets++; return new Response(null, { status: 503 }); });
    await expect(g.send(get())).rejects.toMatchObject({ reason: "unavailable" }); expect(gets).toBe(5);
  });
});
