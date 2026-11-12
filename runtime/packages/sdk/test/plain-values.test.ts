// What a client method answers is plain JSON; the wire codecs stay exact.
import { afterEach, describe, expect, it } from "vitest";
import { Float64, type CborValue } from "../src/cbor.js";
import { decodePlain } from "../src/codec.js";
import { attachmentContentV1 } from "../src/attachment-wire.js";
import { connect, toPlain, wire, type MdbaseClient, type Plain, type RecordView } from "../src/index.js";
import type * as p from "../src/plain.js";
import { MemoryReplica } from "../src/testing/index.js";

const BIG = 2n ** 60n;
const id = "0192f3a4-6000-7abc-8def-0123456789ab";
const exact: wire.RecordView = {
  id, path: "notes/a.md", revision: `sha256:${"ab".repeat(32)}`, types: ["note"],
  state: { state: "confirmed", confirmedSeq: 1 },
  frontmatter: new Map<string, CborValue>([
    ["title", "A"], ["rating", new Float64(1)], ["half", new Float64(0.5)], ["big", BIG],
    ["nested", new Map<string, CborValue>([["2024", "later"], ["a", [new Float64(2), new Map([["__proto__", "field"]])]]])],
  ]),
  effective: new Map<string, CborValue>([["rating", new Float64(1)]]),
  diagnostics: [{ code: "schema_type", severity: "warning", message: "m", details: { at: "/rating" } }],
};

/** Every value reachable from `v` that an app could not put through JSON. */
function exactForms(v: unknown, at = "$"): string[] {
  if (v instanceof Map || v instanceof Float64 || typeof v === "bigint") return [at];
  if (Array.isArray(v)) return v.flatMap((x, i) => exactForms(x, `${at}[${i}]`));
  if (v !== null && typeof v === "object" && !(v instanceof Uint8Array)) return Object.entries(v).flatMap(([k, x]) => exactForms(x, `${at}.${k}`));
  return [];
}

describe("plain decode", () => {
  it("turns every value and data map of an answer into JSON", () => {
    const plain = decodePlain(wire.recordView, wire.recordView.enc(exact));
    expect(exactForms(plain)).toEqual([]);
    expect(plain.frontmatter).toEqual({
      title: "A", rating: 1, half: 0.5, big: BIG.toString(),
      nested: { 2024: "later", a: [2, { ["__proto__"]: "field" }] },
    });
    expect(plain.effective).toEqual({ rating: 1 });
    expect(JSON.parse(JSON.stringify(plain))).toEqual(plain);
  });

  it("keeps a key named __proto__ as a field, never as a prototype", () => {
    const plain = toPlain(new Map<string, CborValue>([["__proto__", new Map([["polluted", true]])]])) as Record<string, unknown>;
    expect(Object.keys(plain)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(plain)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("leaves the wire codecs exact, before and after a plain decode, and after one that failed", () => {
    const encoded = wire.recordView.enc(exact);
    decodePlain(wire.recordView, encoded);
    expect(wire.recordView.dec(encoded)).toEqual(exact);
    expect(() => decodePlain(wire.recordView, new Map([[0, "not a uuid"]]))).toThrow();
    const again = wire.recordView.dec(encoded);
    expect(again.frontmatter.get("rating")).toBeInstanceOf(Float64);
    expect(again.frontmatter.get("big")).toBe(BIG);
    expect([...(again.frontmatter.get("nested") as Map<string, CborValue>).keys()]).toEqual(["2024", "a"]);
  });

  it("does not touch a 64-bit number that is part of the answer's structure", () => {
    const content = {
      reference: { collection: id, keyEpoch: BIG, attachmentId: new Uint8Array(32).fill(7), manifestCipherHash: `sha256:${"cd".repeat(32)}` },
      wholePlainHash: `sha256:${"ef".repeat(32)}`, totalPlainBytes: BIG + 1n,
    };
    expect(decodePlain(attachmentContentV1, attachmentContentV1.enc(content))).toEqual(content);
  });

  it("reads a problem's details as JSON from the wire codec too", () => {
    const problem: wire.Problem = { code: "conflict", recovery: "resolve_conflict", message: "m", details: { current: "r", n: 1 } };
    expect(wire.problem.dec(wire.problem.enc(problem))).toEqual(problem);
  });
});

describe("a client over plain values", () => {
  const clients: MdbaseClient[] = [];
  afterEach(() => { for (const c of clients.splice(0)) c.close(); });
  async function open() {
    const replica = new MemoryReplica({ confirmDelayMs: 0 });
    const seeded = replica.seed({ path: "notes/a.md", types: ["note"], body: "a", frontmatter: { title: "A", rating: new Float64(1), big: BIG, tags: ["x"] } });
    const client = await connect({ connector: replica.connector(), app: { name: "plain-values-test", version: "test" }, reconnect: false });
    clients.push(client);
    return { replica, client, seeded };
  }

  it("answers get, query and a write's receipt in JSON", async () => {
    const { client, seeded } = await open();
    const record = await client.get(seeded.id, { include: { body: true } });
    expect(record.frontmatter).toEqual({ title: "A", rating: 1, big: BIG.toString(), tags: ["x"] });
    const page = await client.query({ types: ["note"] });
    const write = await client.update(record, { patch: { title: "B" } }, { wait: "confirmed" });
    expect(exactForms([record, page, write.receipt, await write.confirmed])).toEqual([]);
  });

  it("builds a write's base from the plain record and leaves a value that was only read alone", async () => {
    const { client, seeded } = await open();
    const record = await client.get(seeded.id);
    expect(client.updateOp(record, { patch: { title: "B" }, unset: ["tags", "absent"] })).toMatchObject({
      patch: new Map([["title", "B"]]),
      base: [{ key: "title", observed: "A" }, { key: "tags", observed: ["x"] }, { key: "absent" }],
    });
    // Sending back what was read changes nothing: the stored 1.0 and the integer
    // beyond 2^53 are never rewritten as 1 and as a string.
    const echoed = client.updateOp(record, { patch: { ...record.frontmatter } });
    expect(echoed.patch).toBeUndefined();
    expect(echoed.base).toBeUndefined();
    // An exact value is a change the app asked for.
    expect(client.updateOp(record, { patch: { rating: new Float64(2) } })).toMatchObject({
      patch: new Map([["rating", new Float64(2)]]), base: [{ key: "rating", observed: 1 }],
    });
  });

  it("still serves the exact form: call without a codec, then a wire codec", async () => {
    const { client, seeded } = await open();
    const record: RecordView = await client.get(seeded.id);
    await client.update(record, { patch: { title: "B" } }, { wait: "confirmed" });
    const answer = await client.call("query", new Map<number, CborValue>([[0, new Map([["types", ["note"]]])]]), { retry: true });
    const [stored] = wire.queryResult.dec(answer).records;
    expect(stored!.frontmatter.get("title")).toBe("B");
    expect(stored!.frontmatter.get("rating")).toBeInstanceOf(Float64);
    expect(stored!.frontmatter.get("big")).toBe(BIG);
  });
});

// Compile-time: each named plain type is exactly `Plain` of its wire type.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const namesMatch: [
  Same<p.RecordView, Plain<wire.RecordView>>, Same<p.Conflict, Plain<wire.Conflict>>, Same<p.ConflictEntry, Plain<wire.ConflictEntry>>,
  Same<p.Receipt, Plain<wire.Receipt>>, Same<p.PendingMutation, Plain<wire.PendingMutation>>, Same<p.QueryGroup, Plain<wire.QueryGroup>>,
  Same<p.QueryMetadata, Plain<wire.QueryMetadata>>, Same<p.QueryResult, Plain<wire.QueryResult>>, Same<p.QueryUpdate, Plain<wire.QueryUpdate>>,
  Same<p.Backlink, Plain<wire.Backlink>>, Same<p.BacklinksResult, Plain<wire.BacklinksResult>>,
  Same<p.ContractImplementation, Plain<wire.ContractImplementation>>, Same<p.ContractSummary, Plain<wire.ContractSummary>>,
  Same<p.TypeSummary, Plain<wire.TypeSummary>>, Same<p.DescribeResult, Plain<wire.DescribeResult>>, Same<p.Peer, Plain<wire.Peer>>,
  Same<p.ViewDescriptor, Plain<wire.ViewDescriptor>>, Same<p.ViewSource, Plain<wire.ViewSource>>,
] extends true[] ? true : never = true;
void namesMatch;
