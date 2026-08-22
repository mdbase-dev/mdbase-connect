import { describe, expect, it } from "vitest";
import {
  APPLICATION_CAPABILITY_DEFINITIONS,
  COLLECTION_OPERATIONS,
  MDBASE_TIMER_FIRED_CONTRACT,
  operationRequiresTimerCriterion,
  operationsForApplicationCapabilities,
  type ApplicationCapabilityId
} from "@mdbase-dev/connect-protocol";
import {
  assertOperationsAllowedByApplication,
  operationsAllowedByRequirements
} from "./policy.js";

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

  it("fails closed when persisted grants contain a non-protocol operation", () => {
    expect(operationsAllowedByRequirements(
      ["read", "future_unclassified_operation"],
      requirements
    )).toBe(false);
  });

  it("keeps timer operations available to applications that declare them", () => {
    const timerCapabilities = Object.keys(APPLICATION_CAPABILITY_DEFINITIONS)
      .filter((capability): capability is ApplicationCapabilityId => capability.startsWith("timers."));
    const timerOperations = operationsForApplicationCapabilities({
      contract_version: 1,
      required: timerCapabilities
    });
    const requirements = {
      contracts: [],
      access: "full_collection" as const,
      capabilities: { contract_version: 1 as const, required: timerCapabilities }
    };
    expect(() => assertOperationsAllowedByApplication(
      timerOperations,
      requirements,
      {
        criteria: [{
          id: "reminder.due",
          event: MDBASE_TIMER_FIRED_CONTRACT,
          presentation: { title: "Reminder due" }
        }]
      }
    )).not.toThrow();
  });

  it("rejects timer requests without criteria even for legacy full-access manifests", () => {
    expect(() => assertOperationsAllowedByApplication(
      ["put_timer"],
      { contracts: [], access: "full_collection" },
      { criteria: [] }
    )).toThrow("Timer operations require an mdbase.runtime.timer.fired notification criterion.");
  });

  it("does not let non-timer semantic capabilities authorize timers", () => {
    expect(() => assertOperationsAllowedByApplication(
      ["put_timer"],
      requirements,
      {
        criteria: [{
          id: "reminder.due",
          event: MDBASE_TIMER_FIRED_CONTRACT,
          presentation: { title: "Reminder due" }
        }]
      }
    )).toThrow("exceed the application's declared capabilities");
  });

  it("keeps operation timer metadata aligned with semantic capabilities", () => {
    const timerCapabilities = Object.keys(APPLICATION_CAPABILITY_DEFINITIONS)
      .filter((capability): capability is ApplicationCapabilityId => capability.startsWith("timers."));
    expect(new Set(COLLECTION_OPERATIONS.filter(operationRequiresTimerCriterion))).toEqual(
      new Set(operationsForApplicationCapabilities({
        contract_version: 1,
        required: timerCapabilities
      }))
    );
  });
});
