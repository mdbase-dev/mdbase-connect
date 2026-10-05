import { describe, expect, it } from "vitest";
import { NEXT_ACCOUNT_CAPABILITY, POLICY_FRESHNESS_LEASE_CAPABILITY, RELAY_REQUIRED_CAPABILITIES } from "@mdbase-dev/connect-protocol";
import { nextAccountNegotiated, relayCapabilityMismatch } from "../../relay-compatibility.js";
import { withAccountId } from "./devices.js";

const newMode = [...RELAY_REQUIRED_CAPABILITIES, "next_device_v1", NEXT_ACCOUNT_CAPABILITY, POLICY_FRESHNESS_LEASE_CAPABILITY];
describe("account wire prerequisites (no serving-authority inference)", () => {
  it("never advertises or requires the new mode for legacy clients", () => {
    expect(RELAY_REQUIRED_CAPABILITIES).not.toContain(NEXT_ACCOUNT_CAPABILITY);
    expect(relayCapabilityMismatch(RELAY_REQUIRED_CAPABILITIES)).toBeUndefined();
    expect(nextAccountNegotiated([...RELAY_REQUIRED_CAPABILITIES, "next_device_v1"])).toBe(false);
  });
  it("requires actual next-device support and both exact dependency capabilities, with no downgrade", () => {
    expect(relayCapabilityMismatch(newMode, true)).toBeUndefined();
    expect(nextAccountNegotiated(newMode)).toBe(true);
    expect(relayCapabilityMismatch(newMode, false)?.code).toBe("capability_contract_incompatible");
    for (const dependency of ["next_device_v1", POLICY_FRESHNESS_LEASE_CAPABILITY]) {
      const missing = newMode.filter((c) => c !== dependency);
      expect(nextAccountNegotiated(missing)).toBe(false);
      expect(relayCapabilityMismatch(missing, true)?.code).toBe("capability_contract_incompatible");
    }
    expect(nextAccountNegotiated([NEXT_ACCOUNT_CAPABILITY, "next_device_v1", "lease_v1"])).toBe(false);
  });
  it.each([undefined, null, 0, "", "SERVICE", "00000000-0000-0000-0000-000000000000", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"])("denies missing/noncanonical/nil/service identity %s", (value) => {
    expect(() => withAccountId({}, value)).toThrowError(/canonical nonzero account UUID/);
  });
  it("carries only the explicitly supplied authenticated record identity without rewriting it to owner", () => {
    const consenting = "11111111-1111-4111-8111-111111111111";
    expect(withAccountId({ owner: "22222222-2222-4222-8222-222222222222" }, consenting).account_id).toBe(consenting);
  });
});
