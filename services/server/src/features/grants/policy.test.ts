import { describe, expect, it } from "vitest";
import { operationsAllowedByRequirements } from "./policy.js";

describe("application capability policy", () => {
  const requirements = {
    contracts: [],
    access: "full_collection" as const,
    capabilities: {
      contract_version: 1 as const,
      required: ["collection.inspect", "records.read"] as const,
      optional: ["records.update"] as const
    }
  };

  it("accepts only operations compiled from declared semantic capabilities", () => {
    expect(operationsAllowedByRequirements(["describe", "read", "update"], requirements)).toBe(true);
    expect(operationsAllowedByRequirements(["delete"], requirements)).toBe(false);
    expect(operationsAllowedByRequirements(["apply_type_pack"], requirements)).toBe(false);
  });

  it("retains the access ceiling after semantic compilation", () => {
    expect(operationsAllowedByRequirements(["read_type"], {
      ...requirements,
      access: "contract",
      capabilities: {
        contract_version: 1,
        required: ["definitions.read"]
      }
    })).toBe(false);
  });
});
