import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { exportNativeBackup, restoreNativeBackup, verifyNativeBackup, type NativeBackupStore } from "./native-backup-archive.js";
import { verifyNativeArchive } from "./native-backup-verifier.js";
import { decodeCbor, domainHash, encodeCbor, type Cbor, type Decoded } from "./policy-wire.js";
import type { LabNativeCaptureContext } from "./lab-native-backup.js";
vi.mock("./native-backup-verifier.js", async importOriginal => ({
  ...await importOriginal<typeof import("./native-backup-verifier.js")>(), verifyNativeArchive: vi.fn(async () => {}),
}));
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest();
const map = (values: Cbor[]): Cbor => ({struct: values.map((value, key) => [key, value])});
const fields = (raw: Uint8Array) => decodeCbor(raw) as Map<number, Decoded>;
const verifier = {executable: "/not-executed/unit-test-verifier", stageRoot: "/not-executed/unit-test-stage", trust: Buffer.of(1)};
async function fixture(name = "ordinary") {
  // Existing independent native verifier vectors, not an invented wire format.
  const text = await readFile(new URL(`../../../../../runtime/crates/backup-verify/tests/vectors/cut-${name}-v1.txt`, import.meta.url), "utf8");
  const vector = new Map(text.trim().split("\n").map(line => {const i = line.indexOf("="); return [line.slice(0,i), Buffer.from(line.slice(i+1), "hex")];}));
  const header = vector.get("header")!, h = fields(header), session = h.get(2) as Uint8Array;
  const id = Buffer.from(h.get(1) as Uint8Array).toString("hex");
  const collection = `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`;
  const pages = [...vector].filter(([name]) => /^page[0-9]+$/.test(name)).map(([,raw]) => raw);
  const genesis = (fields(pages[0]!).get(7) as Decoded[][])[0]![2] as Uint8Array;
  const key = generateKeyPairSync("ed25519"), publicKey = key.publicKey.export({format:"der",type:"spki"}).subarray(-32);
  const events: string[] = [], stored = new Map<string, Uint8Array>();
  const sink: NativeBackupStore = {
    async putIfAbsent(name, bytes) {events.push(`put:${name}`); if (stored.has(name)) throw new Error("exists"); stored.set(name, Buffer.from(bytes));},
    async read(name, max) {events.push(`read:${name}`); const b = stored.get(name); if (!b || b.length > max) throw new Error("missing-or-bound"); return Buffer.from(b);},
  };
  const capture: LabNativeCaptureContext = {collection, operationId: "11111111-1111-4111-8111-111111111111", sourceOrigin: "https://unit-test.invalid", runtimeRevision: "a".repeat(40),
    originalGenesis: genesis, signer: {privateKey:key.privateKey,cert:{policyPublicKey:publicKey,notBefore:0,notAfter:2**50,root:Buffer.alloc(16),signature:Buffer.alloc(64)}},
    denyFirst: vi.fn(async () => {events.push("deny");}), log: {
      async backupBegin() {events.push("begin"); return {raw:header,hash:sha(header)};},
      async backupPage(_c, _s, n, previous) {events.push(`page:${n}`); const raw = pages[n-1]!; expect(Buffer.from(fields(raw).get(5) as Uint8Array)).toEqual(Buffer.from(previous)); return {raw,hash:sha(raw)};},
      async nativeObjectRange(_c, address, offset, length) {events.push("object"); const bytes = vector.get(`object_${Buffer.from(address).toString("hex")}`)!; return {bytes:bytes.subarray(offset,offset+length),size:bytes.length,checksum:sha(bytes)};},
      async backupFinish(_c, _s, hash) {events.push("finish"); const f = fields(vector.get("finish")!); expect(Buffer.from(hash)).toEqual(Buffer.from(f.get(7) as Uint8Array)); return {raw:vector.get("finish")!,collection:h.get(1) as Uint8Array,session,
        head:h.get(3) as number,chain:h.get(4) as Uint8Array,revision:h.get(6) as number,pageCount:pages.length,finalHash:hash};},
    }};
  const calls: string[] = [];
  const target = {
    importNativeItems: vi.fn(async (_c: string, input: {items: ReadonlyArray<readonly [number, Uint8Array]>; final?: unknown}) => {
      calls.push(input.final ? "activate" : input.items[0]?.[0] === 1 ? "seed" : "items");
      return {head: input.final ? h.get(3) as number : input.items.at(-1)?.[0] ?? 1, chain:h.get(4) as Uint8Array,live:!!input.final,strict:true};
    }),
    importNativeObject: vi.fn(async () => {calls.push("object");}),
    importNativeSnapshot: vi.fn(async (_c: string, _pointer: readonly [number, Uint8Array, Uint8Array, number, boolean], _refs: readonly Uint8Array[]) => {calls.push("snapshot");}),
    restoreAuxBegin: vi.fn(async () => {calls.push("aux-begin"); return {page:0,hash:sha(header)};}),
    restoreAuxPage: vi.fn(async (_c: string, raw: Uint8Array) => {calls.push("aux-page"); return {page:fields(raw).get(4) as number,hash:sha(raw)};}),
    head: vi.fn(async () => {calls.push("head"); return {seq:h.get(3) as number,chain:h.get(4) as Uint8Array};}),
  };
  const admit = vi.fn(async (phase: string) => {calls.push(`admit:${phase}`);});
  return {capture,sink,stored,events,pages,target,calls,admit,publicKey:key.publicKey,vector};
}
describe("native independent archive composition (verifier boundary mocked)", () => {
  it.each(["ordinary","compacted","indexed-extra-publisher"])("captures %s bytes, independent roots, signed context and coverage LAST", async name => {
    const f = await fixture(name), result = await exportNativeBackup({...f,verifier});
    expect(result.scope).toBe("native-log-only"); expect(result.current_authority_verified).toBe(false);
    expect(result.S_final.item_root).toBe(Buffer.from((fields(f.vector.get("completion")!).get(7) as Decoded[])[5] as Uint8Array).toString("hex"));
    expect(f.events.indexOf("object")).toBeLessThan(f.events.indexOf("finish"));
    expect(f.events.filter(e => e.startsWith("put:")).at(-1)).toBe("put:coverage.json");
    const completion = fields(f.stored.get("completion.cbor")!);
    const unsigned = encodeCbor({struct:[...completion].filter(([n]) => n !== 12).map(([n,v]) => [n, v as Cbor])});
    expect(verify(null, domainHash("mdbase/v1/native-backup-completion",unsigned),f.publicKey,completion.get(12) as Uint8Array)).toBe(true);
    expect(await verifyNativeBackup(f.sink,verifier)).toEqual(result);
  });
  it("does not publish coverage if independent authentication refuses", async () => {
    const f = await fixture(); vi.mocked(verifyNativeArchive).mockRejectedValueOnce(new Error("untrusted"));
    await expect(exportNativeBackup({...f,verifier})).rejects.toThrow("untrusted"); expect(f.stored.has("coverage.json")).toBe(false);
  });
  it("readback corruption or ambiguous PUT leaves no usable manifest and is not retried", async () => {
    const f = await fixture(), read = vi.fn(async () => Buffer.of(0));
    await expect(exportNativeBackup({...f,sink:{...f.sink,read},verifier})).rejects.toThrow("readback");
    expect(read).toHaveBeenCalledTimes(1); expect(f.stored.has("coverage.json")).toBe(false);
    const g = await fixture(), putIfAbsent = vi.fn(async () => {throw new Error("unknown");});
    await expect(exportNativeBackup({...g,sink:{...g.sink,putIfAbsent},verifier})).rejects.toThrow("unknown"); expect(putIfAbsent).toHaveBeenCalledTimes(1);
  });
  it("same operation is create-only, never an overwrite/resume", async () => {
    const f = await fixture(); await exportNativeBackup({...f,verifier}); const original = f.stored.get("coverage.json");
    await expect(exportNativeBackup({...f,verifier})).rejects.toThrow("exists"); expect(f.stored.get("coverage.json")).toBe(original);
  });
  it.each(["ordinary","compacted","indexed-extra-publisher"])("strict %s restore replays every aux page before activation", async name => {
    const f = await fixture(name); const manifest = await exportNativeBackup({...f,verifier});
    expect(await restoreNativeBackup({...f,source:f.sink,verifier})).toEqual(manifest);
    expect(f.calls[0]).toBe("admit:empty"); expect(f.calls[1]).toBe("seed");
    expect(f.calls.filter(c => c === "aux-page")).toHaveLength(f.pages.length);
    expect(f.calls.indexOf("object")).toBeLessThan(f.calls.indexOf("items"));
    expect(f.calls.indexOf("snapshot")).toBeLessThan(f.calls.indexOf("aux-page"));
    expect(f.calls.slice(-3)).toEqual(["admit:activate","activate","head"]);
    const seqs = f.target.importNativeSnapshot.mock.calls.map(call => call[1][0]);
    expect(seqs).toEqual([...seqs].sort((a,b) => b-a));
  });
  it("checks full archive and S_final before any admission or target write", async () => {
    for (const change of ["bytes", "coverage", "traversal", "duplicate", "oversized"]) {
      const f = await fixture(); await exportNativeBackup({...f,verifier});
      if (change === "bytes") f.stored.set("cut/header.cbor", Buffer.of(0));
      else {
        const manifest = JSON.parse(Buffer.from(f.stored.get("coverage.json")!).toString());
        if (change === "coverage") manifest.S_final.head++;
        if (change === "traversal") manifest.entries[0].name = "../trust.cbor";
        if (change === "duplicate") manifest.entries.push(manifest.entries[0]);
        if (change === "oversized") manifest.entries[0].bytes = 2**40;
        f.stored.set("coverage.json",Buffer.from(JSON.stringify(manifest)));
      }
      await expect(restoreNativeBackup({...f,source:f.sink,verifier})).rejects.toThrow(); expect(f.calls).toEqual([]);
    }
  });
  it("EMPTY refusal or current denial prevents effects/activation", async () => {
    const f = await fixture(); await exportNativeBackup({...f,verifier}); f.admit.mockRejectedValueOnce(new Error("not-empty"));
    await expect(restoreNativeBackup({...f,source:f.sink,verifier})).rejects.toThrow("not-empty"); expect(f.target.importNativeItems).not.toHaveBeenCalled();
    const g = await fixture(); await exportNativeBackup({...g,verifier}); g.admit.mockImplementation(async phase => {if (phase === "activate") throw new Error("gone");});
    await expect(restoreNativeBackup({...g,source:g.sink,verifier})).rejects.toThrow("gone"); expect(g.calls).not.toContain("activate");
  });
  it("bad auxiliary acknowledgement leaves target Importing; never activates or retries", async () => {
    const f = await fixture(); await exportNativeBackup({...f,verifier}); f.target.restoreAuxPage.mockResolvedValueOnce({page:999,hash:Buffer.alloc(32)});
    await expect(restoreNativeBackup({...f,source:f.sink,verifier})).rejects.toThrow("aux_page"); expect(f.calls).not.toContain("activate"); expect(f.target.restoreAuxPage).toHaveBeenCalledTimes(1);
  });
});
