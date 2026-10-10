import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decode, encode, fromHex, toHex } from "../src/cbor.js";
import { approvalReadiness, pendingDevice } from "../src/private.js";

// Public synthetic contract shapes; decode-only compatibility clarification.
// The nil fixture device is NOT an enrollment/approval authority.
const vectors = JSON.parse(readFileSync(new URL("./fixtures/device-approval-wire-golden.json", import.meta.url), "utf8"));
const device = "00000000-0000-0000-0000-000000000000";
const account = "01010101-0101-0101-0101-010101010101";
const expected = { device, account, kind: "desktop", exchangeReady: true };

describe("code-free approval readiness contract", () => {
  it("decodes the exact public pending-device golden", () => {
    expect(pendingDevice.dec(decode(fromHex(vectors.pending_device.cbor_hex)))).toEqual(expected);
  });
  it("generates the exact pending-device bytes without reserved SAS key 3", () => {
    expect(toHex(encode(pendingDevice.enc(expected)))).toBe(vectors.pending_device.cbor_hex);
    expect(toHex(encode(pendingDevice.enc({ ...expected, sas: "123456" })))).toBe(vectors.pending_device.cbor_hex);
  });
  it("decodes and generates approval readiness key 2, never legacy key 1", () => {
    expect(approvalReadiness.dec(decode(fromHex(vectors.approval_ready.cbor_hex)))).toEqual({ device, exchangeReady: true });
    expect(toHex(encode(approvalReadiness.enc({ device, exchangeReady: true, sas: "123456" })))).toBe(vectors.approval_ready.cbor_hex);
  });
  it("legacy pending SAS is decode-only and cannot substitute for required readiness", () => {
    const legacy = pendingDevice.enc(expected) as Map<number, unknown>;
    legacy.set(3, "123456");
    const decoded = pendingDevice.dec(legacy as ReturnType<typeof pendingDevice.enc>);
    expect(decoded.sas).toBe("123456");
    expect((pendingDevice.enc(decoded) as Map<number, unknown>).has(3)).toBe(false);
    legacy.delete(4);
    expect(() => pendingDevice.dec(legacy as ReturnType<typeof pendingDevice.enc>)).toThrow(/exchangeReady/);
  });
  it("legacy approval SAS is decode-only, not readiness or a new-flow code", () => {
    const legacy = approvalReadiness.enc({ device, exchangeReady: false }) as Map<number, unknown>;
    legacy.set(1, "123456");
    const decoded = approvalReadiness.dec(legacy as ReturnType<typeof approvalReadiness.enc>);
    expect(decoded).toEqual({ device, exchangeReady: false, sas: "123456" });
    expect((approvalReadiness.enc(decoded) as Map<number, unknown>).has(1)).toBe(false);
    legacy.delete(2);
    expect(() => approvalReadiness.dec(legacy as ReturnType<typeof approvalReadiness.enc>)).toThrow(/exchangeReady/);
  });
  it("does not reinterpret a code string as the new readiness boolean", () => {
    const wrong = approvalReadiness.enc({ device, exchangeReady: true }) as Map<number, unknown>;
    wrong.set(2, "123456");
    expect(() => approvalReadiness.dec(wrong as ReturnType<typeof approvalReadiness.enc>)).toThrow();
  });
  it("false readiness round-trips and says nothing about key delivery", () => {
    const value = { ...expected, exchangeReady: false };
    expect(pendingDevice.dec(pendingDevice.enc(value))).toEqual(value);
  });
});
