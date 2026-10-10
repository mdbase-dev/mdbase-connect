/** Real loopback HTTP, static PUBLIC fixture device; never LAB/live credentials. */
import { createServer, type Server, type IncomingMessage } from "node:http";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { AppHttpLogTransport } from "../src/app-host/http-log.js";
import { decode, encode, fromHex, type CborValue } from "../src/cbor.js";
import { uuidToBytes } from "../src/codec.js";
import type { AppLogCall } from "../src/app-host/log-pump.js";
const COLLECTION = "22222222-2222-2222-2222-222222222222", SEED = new Uint8Array(32).fill(0x33), TOKEN = "public-fixture-token";
type M = Map<CborValue, CborValue>;
async function listen(server: Server): Promise<string> { server.listen(0, "127.0.0.1"); await once(server, "listening"); return `http://127.0.0.1:${(server.address() as { port: number }).port}`; }
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
async function collect(req: IncomingMessage) { const parts: Buffer[] = []; let count = 0; for await (const p of req) { count += p.length; if (count > 16 * 1024 * 1024) throw new Error("test body budget"); parts.push(p); } return new Uint8Array(Buffer.concat(parts)); }
function frame(method: string, params: Map<number, CborValue>, sidecar?: Uint8Array): AppLogCall { return { endpoint: 37, frame: encode(new Map<number, CborValue>([[0, 0], [1, 7], [2, method], [3, params]])), ...(sidecar ? { sidecar } : {}) }; }
function digest(method: string, raw: Uint8Array, nonce: Uint8Array): Uint8Array {
  const b = Buffer.concat([Buffer.from([17]), Buffer.from("mdbase/v1/ls-http"), Buffer.from(method), Buffer.from([0]), Buffer.from("/v1/rpc"), Buffer.from([0]), uuidToBytes(COLLECTION), sha256(Buffer.from(TOKEN)), sha256(raw), nonce]); return sha256(b);
}

describe("actual loopback HTTP object transfer", () => {
  it("signs LS requests, PUTs exact >1MiB bytes, commits, and resumes a terminated GET without bearer leakage", async () => {
    const sealed = Uint8Array.from({ length: 2 * 1024 * 1024 + 7 }, (_, i) => i % 251), checksum = sha256(sealed), address = new Uint8Array(32).fill(7);
    let staged: Uint8Array | null = null, committed = false, reads = 0, putCount = 0, commitCount = 0;
    const issues: unknown[] = [], nonces = new Set<string>(), seenMethods: string[] = [];
    const objectServer = createServer(async (req, res) => {
      try {
        expect(req.headers.authorization).toBeUndefined(); expect(req.headers.cookie).toBeUndefined(); expect(req.headers["x-mdbase-sig"]).toBeUndefined();
        if (req.method === "PUT") { staged = await collect(req); expect(staged.length).toBe(sealed.length); expect(staged.every((b, i) => b === sealed[i])).toBe(true); putCount++; res.writeHead(200); res.end(); return; }
        expect(committed).toBe(true); reads++;
        if (reads === 1) { res.writeHead(200, { "content-length": String(sealed.length) }); res.write(sealed.slice(0, 100)); setTimeout(() => res.destroy(), 20); return; }
        const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range!); expect(match).not.toBeNull();
        const start = Number(match![1]); expect(start).toBe(100); expect(Number(match![2])).toBe(sealed.length - 1);
        res.writeHead(206, { "content-length": String(sealed.length - start), "content-range": `bytes ${start}-${sealed.length - 1}/${sealed.length}`, "x-amz-checksum-sha256": Buffer.from(checksum).toString("base64") }); res.end(sealed.slice(start));
      } catch (e) { issues.push(e); res.writeHead(500); res.end(); }
    });
    const objectOrigin = await listen(objectServer);
    const logServer = createServer(async (req, res) => {
      try {
        if (req.url === "/v1/nonce") { const n = randomBytes(32).toString("hex"); nonces.add(n); res.end(n); return; }
        expect(req.url).toBe("/v1/rpc"); expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
        const nonce = req.headers["x-mdbase-nonce"] as string; expect(nonces.delete(nonce)).toBe(true);
        const raw = await collect(req), m = decode(raw) as M, method = m.get(2) as string; seenMethods.push(method);
        expect(ed25519.verify(fromHex(req.headers["x-mdbase-sig"] as string), digest(method, raw, fromHex(nonce)), ed25519.getPublicKey(SEED))).toBe(true);
        let result: CborValue;
        const target = new Map<number, CborValue>([[0, `${objectOrigin}/sealed?signature=public-test-target`], [1, new Map<string, CborValue>([["x-amz-checksum-sha256", Buffer.from(checksum).toString("base64")]])], [2, Date.now() + 120_000]]);
        if (method === "put_object") result = new Map<number, CborValue>([[0, 1], [1, target]]);
        else if (method === "commit_object") { expect(staged !== null && sha256(staged).every((b, i) => b === checksum[i])).toBe(true); committed = true; commitCount++; result = true; }
        else { expect(method).toBe("get_object"); result = new Map<number, CborValue>([[1, target], [2, sealed.length], [3, checksum]]); }
        const reply = encode(new Map<number, CborValue>([[0, 1], [1, m.get(1)!], [2, result]])); res.writeHead(200, { "content-length": String(reply.length) }); res.end(reply);
      } catch (e) { issues.push(e); res.writeHead(500); res.end(); }
    });
    const logOrigin = await listen(logServer);
    try {
      const transport = new AppHttpLogTransport({ endpoint: 37, collection: COLLECTION, origin: logOrigin, directOrigins: [objectOrigin], isCurrent: () => true, accessToken: async () => TOKEN, signLogProof: async p => ed25519.sign(p.digest, SEED) }, { allowLoopbackHttp: true });
      const put = frame("put_object", new Map<number, CborValue>([[0, uuidToBytes(COLLECTION)], [1, address], [2, 2], [3, sealed.length], [4, checksum]]), sealed);
      const uploaded = decode(await transport.send(put, { signal: new AbortController().signal })) as M;
      expect((uploaded.get(2) as M).get(0)).toBe(0); expect(uploaded.get(1)).toBe(7);
      const get = frame("get_object", new Map<number, CborValue>([[0, uuidToBytes(COLLECTION)], [1, address]]));
      const downloaded = decode(await transport.send(get, { signal: new AbortController().signal })) as M;
      const received = (downloaded.get(2) as M).get(0) as Uint8Array;
      expect(received.length).toBe(sealed.length); expect(received.every((b, i) => b === sealed[i])).toBe(true);
      expect(seenMethods).toEqual(["put_object", "commit_object", "get_object"]); expect({ putCount, commitCount, reads }).toEqual({ putCount: 1, commitCount: 1, reads: 2 }); expect(issues).toEqual([]);
    } finally { await close(logServer); await close(objectServer); }
  }, 15_000);
});
