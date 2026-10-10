// Actual workerd FixedLengthStream/Request/backpressure/cancel primitives ONLY.
// Synthetic signer/log/object store; no native Replica/Noise/provider proof.
import { WorkerEntrypoint } from "cloudflare:workers";
import { stageSealedObject, type SealedObjectLease } from "../src/object-writes.ts";
import { ObjectOriginPolicy } from "../src/object-origins.ts";
const origins = ObjectOriginPolicy.configured([], true); // fixture-owned real SINK binding
import { encode, decode, type CborValue } from "../../../packages/sdk/src/cbor.ts";

function check(v: unknown, message: string): asserts v { if (!v) throw new Error(message); }
interface Env { SINK: Fetcher; }
export class ObjectSink extends WorkerEntrypoint<Env> {
  async fetch(r: Request): Promise<Response> {
    const mode = new URL(r.url).searchParams.get("mode");
    if (mode === "early-reject") return new Response(null, { status: 503 });
    if (mode === "redirect") return new Response(null, { status: 307 });
    const contentLength = r.headers.get("content-length");
    check(contentLength === String((8 << 20) + 29), "FixedLengthStream did not derive exact HTTP Content-Length");
    check(r.body, "missing fixed-length body");
    const reader = r.body.getReader();let received = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();if (done) break;
        check(value instanceof Uint8Array && value.length <= 64 << 10, "network piece over budget");
        check(value.every((b: number) => b === 0x29), "ciphertext corrupted/detached");
        received += value.length;
        if (received === value.length) await scheduler.wait(20);
      }
    } finally { reader.releaseLock(); }
    return Response.json({ contentLength, received });
  }
}
async function scenario(mode: string, env: Env) {
  const count = (8 << 20) + 29, ticket = 1;
  const collection = new Uint8Array(16).fill(6), hash = new Uint8Array(32).fill(7);
  const checksum = btoa(String.fromCharCode(...hash));
  const memory = new WebAssembly.Memory({ initial: 145 });
  new Uint8Array(memory.buffer, 0, count).fill(0x29);
  let live = true, windows = 0, maxWindow = 0, received = 0, maxLookahead = 0;
  let puts = 0, commits = 0, contentLength: string | null = null;
  let lookahead: Promise<void> = Promise.resolve();
  const request = (method: string, p: CborValue) => encode(new Map<number, CborValue>([[0, 0], [1, ticket], [2, method], [3, p]]));
  const reply = (p: CborValue) => encode(new Map<number, CborValue>([[0, 1], [1, ticket], [2, p]]));
  const lease: SealedObjectLease = {
    ticket, collection, cipherHash: hash, sealedBytes: count,
    putFrame: request("put_object", new Map<number, CborValue>([[0, collection], [1, hash], [2, 18], [3, count], [4, hash]])),
    commitFrame: request("commit_object", new Map<number, CborValue>([[0, collection], [1, hash]])),
    window(offset, size) {
      windows++; maxWindow = Math.max(maxWindow, size);
      if (windows === 1) lookahead = scheduler.wait(10).then(() => { maxLookahead = windows; });
      if (windows === 2) memory.grow(1); // every subsequent view must be reacquired
      if (mode === "window-revoke" && windows === 2) live = false;
      return new Uint8Array(memory.buffer, offset, size);
    },
  };
  const fetcher = { async fetch(url: string, init?: RequestInit): Promise<Response> {
    if (url.endsWith("/v1/nonce")) return new Response("ab".repeat(32));
    if (url.endsWith("/v1/rpc")) {
      const frame = decode(init!.body as Uint8Array) as Map<number, CborValue>;
      if (frame.get(2) === "commit_object") {
        commits++; if (mode === "lost-commit") throw new Error("synthetic lost reply");
        return new Response(reply(new Map([[0, true]])));
      }
      puts++;
      if (mode === "dedup") return new Response(reply(new Map([[0, 2]])));
      const uri = mode === "untrusted-origin" ? "https://unconfigured.test/sealed" : "https://log.internal/direct?mode=" + mode;
      const cap = new Map<number, CborValue>([[0, uri],
        [1, new Map([["x-amz-checksum-sha256", checksum]])], [2, Date.now() + 60_000]]);
      return new Response(reply(new Map<number, CborValue>([[0, 1], [1, cap]])));
    }
    // Actual local service-binding HTTP fetch, never an external provider.
    const response = await env.SINK.fetch(url, init);
    if (!response.ok) return response;
    const stats = await response.json<{ received: number; contentLength: string }>(); // fixture-owned small scalar response
    received = stats.received;contentLength = stats.contentLength;
    if (mode === "after-put-revoke") live = false;
    return new Response(null, { status: 204 });
  } };
  let successful = false, failure = "";
  try {
    const out = await stageSealedObject(fetcher as unknown as Fetcher,
      { signRpc: () => new Uint8Array(64) }, "synthetic-only", lease, () => live, origins,
      async () => { throw new Error("external fetch forbidden in hermetic fixture"); });
    out.put.fill(0);out.commit?.fill(0); successful = true;
  } catch (e) { failure = e instanceof Error ? e.message : "unknown fixture error"; }
  await lookahead;
  const expectedSuccess = mode === "full" || mode === "dedup";
  check(successful === expectedSuccess, `wrong transport completion ${mode}: ${failure}; windows=${windows},received=${received},length=${contentLength},puts=${puts},commits=${commits}`);
  check(puts === 1, "wrong metadata PUT count");
  check(commits === (mode === "full" || mode === "lost-commit" ? 1 : 0), "unexpected commit");
  if (mode === "full") {
    check(received === count && windows === 129, "incomplete bounded transfer");
    check(maxLookahead <= 4, "unbounded producer lookahead");
  }
  if (mode === "dedup" || mode === "untrusted-origin") check(windows === 0 && received === 0, "refused destination/dedup touched file region");
  return { mode, successful, received, windows, max_window_bytes: maxWindow,
    max_lookahead_windows: maxLookahead, content_length: contentLength, puts, commits };
}
export default { async fetch(_request: Request, env: Env): Promise<Response> {
  try {
    const results = [];
    for (const mode of ["full", "dedup", "untrusted-origin", "window-revoke", "after-put-revoke", "early-reject", "redirect", "lost-commit"])
      results.push(await scenario(mode, env));
    return Response.json({ actual_workerd: true, actual_fixed_length_request: true,
      synthetic_signer_and_log: true, native_noise_provider_memory_qualification: false, results });
  } catch (e) { return new Response(e instanceof Error ? e.message : "fixture failed", { status: 500 }); }
} };
