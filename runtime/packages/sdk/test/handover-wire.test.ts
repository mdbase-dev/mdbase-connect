import { describe, expect, it, vi } from "vitest";
import type { CborValue } from "../src/cbor.js";
import { decode, encode, toHex } from "../src/cbor.js";
import { connect } from "../src/index.js";
import { MemoryReplica } from "../src/testing/index.js";
import { appliedPrefix, appliedPrefixParams, confirmedHead, helloResult, syncStatus } from "../src/wire.js";
import { uint } from "../src/codec.js";

const head = { seq: 5, chain: `sha256:${"12".repeat(32)}`, policyGeneration: `sha256:${"34".repeat(32)}`, catalogGeneration: `sha256:${"56".repeat(32)}` };
const status = { mode: "synced" as const, confirmedThrough: 5, headKnown: 9, pending: 1, holds: 0, unresolved: 0, connection: "online" as const, incidents: [] };

describe("confirmed-prefix wire contract", () => {
  it("keeps all four required facts and Hash wire types, not typing uint generation", () => {
    const map = confirmedHead.enc(head) as Map<number, CborValue>;
    expect([...map.keys()]).toEqual([0, 1, 2, 3]);
    for (const key of [1, 2, 3]) expect(map.get(key)).toBeInstanceOf(Uint8Array);
    expect(confirmedHead.dec(decode(encode(map as never)))).toEqual(head);
    for (const key of [0, 1, 2, 3]) {
      const missing = new Map(map); missing.delete(key);
      expect(() => confirmedHead.dec(missing as never)).toThrow();
    }
    const integerGeneration = new Map(map); integerGeneration.set(3, 5);
    expect(() => confirmedHead.dec(integerGeneration as never)).toThrow();
    expect(() => confirmedHead.enc({ ...head, chain: "12".repeat(32) })).toThrow();
  });
  it("preserves legacy absence and additive status key11 without manufacturing a fence", () => {
    const old = syncStatus.enc(status) as Map<number, CborValue>;
    expect(old.has(11)).toBe(false);
    expect(syncStatus.dec(old as never).confirmedHead).toBeUndefined();
    const added = syncStatus.enc({ ...status, confirmedHead: head });
    const bytes = encode(added);
    expect(toHex(encode(syncStatus.enc(syncStatus.dec(decode(bytes)))))).toBe(toHex(bytes));
    expect(syncStatus.dec(decode(bytes)).confirmedHead).toEqual(head);
  });
  it.each([
    { appliedThrough: 9, seq: 5, chain: head.chain },
    { appliedThrough: 3, seq: 5 },
    { appliedThrough: 9, seq: 0 },
    { appliedThrough: 9, seq: 5 },
  ])("round-trips ahead/behind/zero/unretained historical proof %# without current generations", (proof) => {
    const wire = appliedPrefix.enc(proof) as Map<number, CborValue>;
    expect([...wire.keys()]).toEqual(proof.chain === undefined ? [0, 1] : [0, 1, 2]);
    expect(appliedPrefix.dec(decode(encode(wire as never)))).toEqual(proof);
    expect(appliedPrefixParams.dec(decode(encode(appliedPrefixParams.enc({ seq: proof.seq }))))).toEqual({ seq: proof.seq });
  });
  it("rejects unsafe uint64 without rounding in encode/decode and all prefix positions", () => {
    for (const value of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, 18_446_744_073_709_551_615n]) {
      expect(() => uint.dec(value)).toThrow();
      expect(() => confirmedHead.dec(new Map<number, CborValue>([[0, value], [1, new Uint8Array(32)], [2, new Uint8Array(32)], [3, new Uint8Array(32)]]))).toThrow();
      expect(() => appliedPrefix.dec(new Map([[0, value], [1, 5]]))).toThrow();
      expect(() => appliedPrefix.dec(new Map([[0, 9], [1, value]]))).toThrow();
      expect(() => appliedPrefixParams.dec(new Map([[0, value]]))).toThrow();
    }
    expect(() => appliedPrefixParams.enc({ seq: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
    expect(appliedPrefixParams.dec(new Map([[0, Number.MAX_SAFE_INTEGER]]))).toEqual({ seq: Number.MAX_SAFE_INTEGER });
    const unsafeWire = encode(new Map([[0, 18_446_744_073_709_551_615n]]));
    expect(() => appliedPrefixParams.dec(decode(unsafeWire))).toThrow();
  });
  it("requires historical reply positions and validates optional chain Hash", () => {
    expect(() => appliedPrefix.dec(new Map([[0, 9]]))).toThrow();
    expect(() => appliedPrefix.dec(new Map([[1, 5]]))).toThrow();
    expect(() => appliedPrefix.dec(new Map<number, CborValue>([[0, 9], [1, 5], [2, new Uint8Array(31)]]))).toThrow();
  });
});

describe("authenticated-session facade (no switching or attestation)", () => {
  async function client() { return connect({ connector: new MemoryReplica().connector(), app: { name: "prefix-test", version: "0" }, reconnect: false }); }
  it("sends exact READ method/params, signal and no automatic retry", async () => {
    const c = await client();
    try {
      const proof = { appliedThrough: 9, seq: 5, chain: head.chain };
      const call = vi.spyOn(c, "call").mockResolvedValue(proof);
      const signal = new AbortController().signal;
      expect(await c.appliedPrefix(5, signal)).toEqual(proof);
      expect(call).toHaveBeenCalledWith("applied_prefix", new Map([[0, 5]]), { codec: appliedPrefix, retry: false, signal });
      expect(c.status.confirmedHead).toBeUndefined();
    } finally { c.close(); }
  });
  it.each([{ appliedThrough: 9, seq: 6 }, { appliedThrough: 3, seq: 5, chain: head.chain }])("rejects inconsistent echo/behind chain %#", async (proof) => {
    const c = await client();
    try { vi.spyOn(c, "call").mockResolvedValue(proof); await expect(c.appliedPrefix(5)).rejects.toMatchObject({ reason: "prefix_response" }); }
    finally { c.close(); }
  });
  it("leaves absence/errors unchanged and refuses zero-position chain", async () => {
    const c = await client();
    try {
      const call = vi.spyOn(c, "call").mockResolvedValue({ appliedThrough: 9, seq: 5 });
      expect((await c.appliedPrefix(5)).chain).toBeUndefined();
      call.mockResolvedValue({ appliedThrough: 9, seq: 0, chain: head.chain });
      await expect(c.appliedPrefix(0)).rejects.toMatchObject({ reason: "prefix_response" });
      const unavailable = new Error("prefix unavailable"); call.mockRejectedValue(unavailable);
      await expect(c.appliedPrefix(5)).rejects.toBe(unavailable);
      const before = call.mock.calls.length;
      await expect(c.appliedPrefix(Number.MAX_SAFE_INTEGER + 1)).rejects.toThrow();
      expect(call.mock.calls.length).toBe(before);
    } finally { c.close(); }
  });
  it("retains signed witness bytes opaquely; decoding does NOT verify them", async () => {
    const c = await client();
    try {
      const opaque = encode(new Map<number, CborValue>([[0, 1], [8, new Uint8Array(32).fill(8)], [9, new Uint8Array(32).fill(9)], [77, "signed future extension"]]));
      const hello = { ...c.hello, status: { ...status, confirmedHead: head }, headWitness: opaque };
      const bytes = encode(helloResult.enc(hello));
      const parsed = helloResult.dec(decode(bytes));
      expect(toHex(parsed.headWitness!)).toBe(toHex(opaque));
      expect(toHex(encode(helloResult.enc(parsed)))).toBe(toHex(bytes));
    } finally { c.close(); }
  });
});
