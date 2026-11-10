import { describe, expect, it } from "vitest";
import { CONTRACT_SETUP_CAPABILITY, YAML_DOCUMENT_RECORDS_CAPABILITY } from "@mdbase-dev/connect-protocol";
import { connectorUpgradeError } from "./relay-routing.js";

function activation(applicationDeclaration: unknown): unknown {
  return {
    type: "authorization_activation_request",
    grant: { application_declaration: applicationDeclaration }
  };
}

const addsBaseRecords = activation({
  requirements: {
    configuration: [{
      id: "bases-as-records",
      path: "/settings/record_extensions",
      predicate: "contains",
      value: "base"
    }]
  },
  provisions: {
    configuration: [{
      requirement: "bases-as-records",
      operation: "set_add",
      path: "/settings/record_extensions",
      value: "base"
    }]
  }
});

describe("connector upgrade gating", () => {
  it("requires YAML document records when collection setup adds base record extensions", () => {
    expect(connectorUpgradeError(addsBaseRecords, [CONTRACT_SETUP_CAPABILITY])).toMatchObject({
      ok: false,
      error: { problem: { code: "connector_upgrade_required" } }
    });
    expect(connectorUpgradeError(addsBaseRecords, [YAML_DOCUMENT_RECORDS_CAPABILITY])).toBeUndefined();
  });

  it("requires contract setup support for activations that set up contracts", () => {
    const setup = { type: "authorization_activation_request", contract_setups: [{}] };
    expect(connectorUpgradeError(setup, [])).toMatchObject({
      error: { problem: { code: "connector_upgrade_required" } }
    });
    expect(connectorUpgradeError(setup, [CONTRACT_SETUP_CAPABILITY])).toBeUndefined();
  });

  it("does not gate other configuration, other messages, or declarations without setup", () => {
    expect(connectorUpgradeError(activation({
      provisions: {
        configuration: [{
          requirement: "base-sources",
          operation: "set_add",
          path: "/x-obsidian/bases/include",
          value: "views/**/*.base"
        }]
      }
    }), [])).toBeUndefined();
    expect(connectorUpgradeError(activation(null), [])).toBeUndefined();
    expect(connectorUpgradeError({ ...(addsBaseRecords as object), type: "encrypted_operation_request" }, []))
      .toBeUndefined();
  });
});
