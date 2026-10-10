import { describe, expect, it } from "vitest";
import { Write } from "../src/client.js";
import { decode, encode } from "../src/cbor.js";
import { receipt, submitParams } from "../src/wire.js";
import type { PublishState } from "../src/index.js";

// Synthetic receipt/codec tests only,
// not file publication, Native/OPFS durability, or acknowledgement behavior.
describe("published receipt behavior", () => {
  it("Write.published settles on published/not_published, at confirm without files, and rejects with the problem", async () => {
    const { Write } = await import("../src/client.js");
    const m = "0192f3a4-6000-7abc-8def-0123456789ab";
    const a = new Write({ mutation: m, state: "pending", published: "publishing" });
    let done = false;
    void a.published.then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    a.update({ mutation: m, state: "pending", published: "published" });
    await expect(a.published).resolves.toMatchObject({ published: "published" });
    // A later push without the field keeps it.
    a.update({ mutation: m, state: "confirmed", seq: 3 });
    expect(a.receipt.published).toBe("published");
    const b = new Write({ mutation: m, state: "pending" });
    b.update({ mutation: m, state: "confirmed" });
    await expect(b.published).resolves.toMatchObject({ state: "confirmed" });
    const c = new Write({ mutation: m, state: "pending", published: "publishing" });
    c.update({ mutation: m, state: "rejected", problem: { code: "conflict", recovery: "resolve_conflict", message: "x" } });
    await expect(c.published).rejects.toMatchObject({ code: "conflict" });
  });
  it.each(["published", "not_published"] as const)("keeps final %s through later publishing, opposite final, and missing fields", async (published) => {
    const { Write } = await import("../src/client.js");
    const mutation = "0192f3a4-6000-7abc-8def-0123456789ab";
    const write = new Write({ mutation, state: "pending", published });
    const delayed = Object.freeze({ mutation, state: "pending" as const, published: "publishing" as const });
    write.update(delayed);
    expect(write.receipt.published).toBe(published);
    expect(delayed.published).toBe("publishing");
    write.update({ mutation, state: "confirmed", published: published === "published" ? "not_published" : "published" });
    expect(write.receipt.published).toBe(published);
    const missing = Object.freeze({ mutation, state: "confirmed" as const });
    write.update(missing);
    expect(write.receipt.published).toBe(published);
    expect(missing).not.toHaveProperty("published");
    await expect(write.published).resolves.toMatchObject({ published });
  });
  it.each([
    ["rejected", "published"], ["rejected", "not_published"],
    ["unknown", "published"], ["unknown", "not_published"],
  ] as const)("rejects %s even when the same packet claims %s", async (state, published) => {
    const { Write } = await import("../src/client.js");
    const code = state === "unknown" ? "outcome_unknown" : "conflict";
    const write = new Write({ mutation: "0192f3a4-6000-7abc-8def-0123456789ab", state, published,
      problem: { code, recovery: state === "unknown" ? "resolve_outcome" : "resolve_conflict", message: "not successful" } });
    await expect(write.confirmed).rejects.toMatchObject({ code });
    await expect(write.published).rejects.toMatchObject({ code });
  });
  it("receipt keys 7/8 coexist and wait: published round-trips", async () => {
    const { receipt: rc, submitParams } = await import("../src/wire.js");
    const { decode: d, encode: e } = await import("../src/cbor.js");
    const r = rc.dec(d(e(rc.enc({ mutation: "0192f3a4-6000-7abc-8def-0123456789ab", state: "pending", published: "not_published", preflight: { rewrites: [], broken: [] } }))));
    expect(r.published).toBe("not_published");
    expect(r.preflight).toEqual({ rewrites: [], broken: [] });
    const p = submitParams.enc({ ops: [{ kind: "delete", id: "0192f3a4-6000-7abc-8def-0123456789ab" }], wait: "published" });
    expect((p as Map<number, unknown>).get(8)).toBe(2);
  });
});

const mutation = "0192f3a4-6000-7abc-8def-0123456789ab";
describe("publication parity on the current allocated SDK contract", () => {
  it("confirmation can settle while publication remains in progress across an omitted field", async () => {
    const write = new Write({ mutation, state: "pending", published: "publishing" });
    let publicationSettled = false;
    void write.published.then(() => { publicationSettled = true; });
    write.update({ mutation, state: "confirmed", seq: 10 });
    await expect(write.confirmed).resolves.toMatchObject({ seq: 10, published: "publishing" });
    await Promise.resolve();
    expect(publicationSettled).toBe(false);
    write.update({ mutation, state: "confirmed", seq: 10, published: "not_published" });
    await expect(write.published).resolves.toMatchObject({ published: "not_published" });
  });
  it("local publication does not settle log confirmation", async () => {
    const write = new Write({ mutation, state: "pending", published: "published" });
    let confirmationSettled = false;
    void write.confirmed.then(() => { confirmationSettled = true; });
    await expect(write.published).resolves.toMatchObject({ state: "pending" });
    expect(confirmationSettled).toBe(false);
    write.update({ mutation, state: "confirmed", seq: 11 });
    await expect(write.confirmed).resolves.toMatchObject({ seq: 11 });
  });
  it.each(["publishing", "published", "not_published"] as const)("round-trips current field7 %s alongside preflight8 and relocation9", (published: PublishState) => {
    const r = { mutation, state: "pending" as const, published, preflight: { rewrites: [], broken: [] }, relocatedFrom: 5 };
    expect(receipt.dec(decode(encode(receipt.enc(r))))).toEqual(r);
  });
  it.each([null, -1, 3, 1.5, "published"])("rejects malformed known publication field7 %s", (published) => {
    const r = receipt.enc({ mutation, state: "pending" }) as Map<number, unknown>;
    r.set(7, published);
    expect(() => receipt.dec(r as never)).toThrow();
  });
  it("keeps pre-publication wire compatibility and the allocated wait value", () => {
    expect(receipt.dec(receipt.enc({ mutation, state: "confirmed", seq: 2 }))).toEqual({ mutation, state: "confirmed", seq: 2 });
    const input = { ops: [{ kind: "delete" as const, id: mutation }], wait: "published" as const };
    expect(submitParams.dec(decode(encode(submitParams.enc(input))))).toEqual(input);
  });
});
