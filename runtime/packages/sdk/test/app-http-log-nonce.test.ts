// W5: piggybacked next nonce. Steady-state RPCs are one request; old workers
// (no header), stale or refused spares fall back to GET /v1/nonce.
import { describe, expect, it, vi } from "vitest";
import { AppHttpLogTransport, type AppLogHttpAuthority } from "../src/app-host/http-log.js";
import { decode, encode, type CborValue } from "../src/cbor.js";
import { uuidToBytes } from "../src/codec.js";

const COLLECTION = "22222222-2222-2222-2222-222222222222", ORIGIN = "https://log.test";
type M = Map<CborValue, CborValue>;
const call = (id = 1) => ({ endpoint: 37, frame: encode(new Map<number, CborValue>([[0, 0], [1, id], [2, "head"], [3, new Map([[0, uuidToBytes(COLLECTION)]])]])) });
const ok = (id: CborValue) => encode(new Map<number, CborValue>([[0, 1], [1, id], [2, null]]));
const refused = (id: CborValue, why: string) => encode(new Map<number, CborValue>([[0, 1], [1, id], [3, new Map<number, CborValue>([[0, "unauthenticated"], [1, why]])]]));
let seq = 0;
const nonce = () => (++seq).toString(16).padStart(64, "0");

function fixture(opts: { piggyback?: boolean | string; reply?: (id: CborValue, nonce: string) => Uint8Array } = {}) {
  let now = 1_800_000_000_000;
  const sent: string[] = [], gets: string[] = [];
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    const next = opts.piggyback === false ? null : typeof opts.piggyback === "string" ? opts.piggyback : nonce();
    if (String(url).endsWith("/v1/nonce")) { const n = nonce(); gets.push(n); return new Response(n); }
    if (next !== null) headers["x-mdbase-next-nonce"] = next;
    const used = new Headers(init!.headers).get("x-mdbase-nonce")!; sent.push(used);
    const id = (decode(init!.body as Uint8Array) as M).get(1)!;
    return new Response((opts.reply ?? ok)(id, used).slice() as BodyInit, { headers });
  });
  const auth: AppLogHttpAuthority = { endpoint: 37, collection: COLLECTION, origin: ORIGIN, directOrigins: [], isCurrent: () => true,
    accessToken: async () => "token", signLogProof: async () => new Uint8Array(64) };
  const transport = new AppHttpLogTransport(auth, { fetch, now: () => now });
  const send = (id = 1) => transport.send(call(id), { signal: new AbortController().signal });
  const urls = () => fetch.mock.calls.map(([u]) => new URL(String(u)).pathname);
  return { send, urls, sent, gets, fetch, advance: (ms: number) => { now += ms; } };
}

describe("piggybacked next nonce", () => {
  it("uses the previous response's nonce: one request per steady-state RPC", async () => {
    const f = fixture();
    await f.send(1); await f.send(2); await f.send(3);
    expect(f.urls()).toEqual(["/v1/nonce", "/v1/rpc", "/v1/rpc", "/v1/rpc"]);
    expect(new Set(f.sent).size).toBe(3);
    expect(f.sent[0]).toBe(f.gets[0]);
  });
  it("lets the RPC POST use the CORS preflight cache; GETs stay no-store", async () => {
    // Chrome skips its preflight cache for cache: "no-store"/"no-cache" requests.
    const f = fixture();
    await f.send(1);
    expect(f.fetch.mock.calls.map(([u, i]) => [new URL(String(u)).pathname, i?.cache])).toEqual([["/v1/nonce", "no-store"], ["/v1/rpc", "default"]]);
  });
  it("falls back to GET /v1/nonce against a worker without the header", async () => {
    const f = fixture({ piggyback: false });
    await f.send(1); await f.send(2);
    expect(f.urls()).toEqual(["/v1/nonce", "/v1/rpc", "/v1/nonce", "/v1/rpc"]);
  });
  it("ignores a malformed header", async () => {
    const f = fixture({ piggyback: "zz".repeat(32) });
    await f.send(1); await f.send(2);
    expect(f.urls()).toEqual(["/v1/nonce", "/v1/rpc", "/v1/nonce", "/v1/rpc"]);
  });
  it("discards a spare too old to outlive signing and transit", async () => {
    const f = fixture();
    await f.send(1); f.advance(41_000); await f.send(2);
    expect(f.urls()).toEqual(["/v1/nonce", "/v1/rpc", "/v1/nonce", "/v1/rpc"]);
  });
  it("retries once with a fresh nonce when the server refuses a spare, never loops", async () => {
    // The server refuses every piggybacked nonce (e.g. client clock far ahead).
    const f: ReturnType<typeof fixture> = fixture({ reply: (id, used) => (f.gets.includes(used) ? ok(id) : refused(id, "nonce")) });
    await f.send(1); f.fetch.mockClear();
    expect((decode(await f.send(2)) as M).has(2)).toBe(true);
    expect(f.urls()).toEqual(["/v1/rpc", "/v1/nonce", "/v1/rpc"]);
    // A refused FRESH nonce is returned as-is: no retry loop.
    const g = fixture({ reply: id => refused(id, "replay") });
    expect(((decode(await g.send(1)) as M).get(3) as M).get(1)).toBe("replay");
    expect(g.urls()).toEqual(["/v1/nonce", "/v1/rpc"]);
  });
  it("never hands one spare to two concurrent RPCs", async () => {
    const f = fixture();
    await f.send(1);
    await Promise.all([f.send(2), f.send(3), f.send(4)]);
    expect(new Set(f.sent).size).toBe(f.sent.length);
    expect(f.urls().filter(u => u === "/v1/rpc")).toHaveLength(4);
  });
  it("keeps one spare per reply so a concurrent round needs no nonce fetch", async () => {
    const f = fixture();
    await Promise.all([f.send(1), f.send(2), f.send(3)]);
    f.fetch.mockClear();
    await Promise.all([f.send(4), f.send(5), f.send(6)]);
    expect(f.urls()).toEqual(["/v1/rpc", "/v1/rpc", "/v1/rpc"]);
    expect(new Set(f.sent).size).toBe(f.sent.length);
  });
});
