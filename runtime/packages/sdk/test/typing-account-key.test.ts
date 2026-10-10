/** `describe_typing` and the AK1 §6 account-key operations. */
import { describe, expect, it } from "vitest";
import { decode, encode } from "../src/cbor.js";
import { connect, wire } from "../src/index.js";
import { accountKeyStatus } from "../src/private.js";
import { MemoryReplica } from "../src/testing/index.js";

const app = { name: "t", version: "0" };
const open = async (r: MemoryReplica) => connect({ app, connector: r.connector(), reconnect: false });
const R = new Uint8Array(32).map((_, i) => i);

describe("describe_typing", () => {
  it("answers one hint per requested path, in order, bound to a catalog generation", async () => {
    const r = new MemoryReplica({
      confirmDelayMs: null,
      typing: (types, path) => (path === "due" && types.every((t) => t === "task") ? "date" : path === "created" ? "date_time" : "none"),
    });
    const c = await open(r);
    const t = await c.describeTyping(["task"], ["due", "created", "title", "nested.field"]);
    expect(t.fields).toEqual([
      { path: "due", hint: "date" }, { path: "created", hint: "date_time" }, { path: "title", hint: "none" }, { path: "nested.field", hint: "none" },
    ]);
    expect(Number.isSafeInteger(t.catalogGeneration)).toBe(true);
    // Disagreement across the OR list is `none`, never a guess.
    expect((await c.describeTyping(["task", "note"], ["due"])).fields).toEqual([{ path: "due", hint: "none" }]);
    // Empty types: the truthful answer is `none`.
    expect((await c.describeTyping([], ["due"])).fields).toEqual([{ path: "due", hint: "none" }]);
  });
  it("refuses out-of-bounds requests locally and a mismatched answer", async () => {
    const r = new MemoryReplica({ confirmDelayMs: null });
    const c = await open(r);
    await expect(c.describeTyping(new Array(65).fill("t"), ["a"])).rejects.toMatchObject({ code: "invalid_request", reason: "typing_bounds" });
    await expect(c.describeTyping(["t"], new Array(257).fill("a"))).rejects.toMatchObject({ code: "invalid_request", reason: "typing_bounds" });
    await expect(c.describeTyping(["t"], [""])).rejects.toMatchObject({ code: "invalid_request" });
    r.typingAnswer = () => ({ catalogGeneration: 1, fields: [{ path: "other", hint: "none" }] });
    await expect(c.describeTyping(["t"], ["a"])).rejects.toMatchObject({ code: "internal", reason: "invalid_typing_response" });
  });
  it("codec round-trips the allocated shape with integer enums", () => {
    const v = { catalogGeneration: 7, fields: [{ path: "due", hint: "date" as const }, { path: "x", hint: "date_time" as const }] };
    const bytes = encode(wire.describeTypingResult.enc(v));
    expect(wire.describeTypingResult.dec(decode(bytes))).toEqual(v);
    const m = decode(bytes) as Map<number, unknown>;
    const first = (m.get(1) as Map<number, unknown>[])[0] as Map<number, unknown>;
    expect(first.get(1)).toBe(1); // date = 1
  });
});

describe("account key ops (AK1 §6)", () => {
  it("setup is a mutation; unlock with the same secret keys this device; status is polled", async () => {
    const r = new MemoryReplica({ confirmDelayMs: null });
    const c = await open(r);
    expect(await c.accountKey.status()).toEqual({ state: "idle" });
    const w = await c.accountKey.setup(R);
    expect(w.state).toBe("pending");
    r.confirmAll();
    expect((await w.confirmed).state).toBe("confirmed");
    await c.accountKey.unlock(R);
    expect(await c.accountKey.status()).toEqual({ state: "keyed" });
  });
  it("a different secret, or no enrolled recovery device, is refused with a typed problem", async () => {
    const r = new MemoryReplica({ confirmDelayMs: null });
    const c = await open(r);
    await c.accountKey.unlock(R);
    const missing = await c.accountKey.status();
    expect(missing.state).toBe("refused");
    expect(missing.problem).toMatchObject({ code: "forbidden", recovery: "reauthorize" });
    expect((missing.problem!.details as Map<string, string>).get("reason")).toBe("device_missing");
    await c.accountKey.setup(R);
    r.confirmAll();
    await c.accountKey.unlock(new Uint8Array(32).fill(9));
    expect(((await c.accountKey.status()).problem!.details as Map<string, string>).get("reason")).toBe("enrolment_mismatch");
  });
  it("refuses a secret that is not 32 bytes before any request", async () => {
    const r = new MemoryReplica({ confirmDelayMs: null });
    const c = await open(r);
    await expect(c.accountKey.setup(new Uint8Array(31))).rejects.toMatchObject({ code: "invalid_request", reason: "account_secret_length" });
    await expect(c.accountKey.unlock(new Uint8Array(33))).rejects.toMatchObject({ code: "invalid_request", reason: "account_secret_length" });
    expect(await c.accountKey.status()).toEqual({ state: "idle" });
  });
  it("status codec round-trips with the allocated enum values", () => {
    const refused = { state: "refused" as const, problem: { code: "forbidden" as const, recovery: "reauthorize" as const, message: "no", details: new Map([["reason", "not_keyed"]]) } };
    const bytes = encode(accountKeyStatus.enc(refused));
    expect(accountKeyStatus.dec(decode(bytes))).toEqual(refused);
    expect((decode(bytes) as Map<number, unknown>).get(0)).toBe(4);
    expect((decode(encode(accountKeyStatus.enc({ state: "pending_grant" }))) as Map<number, unknown>).get(0)).toBe(2);
  });
});
