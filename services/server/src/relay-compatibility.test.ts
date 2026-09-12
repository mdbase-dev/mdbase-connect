import { describe, expect, it } from "vitest";
import { CONNECT_CONTRACT_SUPPORT } from "@mdbase-dev/connect-protocol";
import { relayContractMismatch } from "./relay-compatibility.js";

describe("semantic bridge handshake", () => {
  it.each([[1], [2], [2, 1]])("accepts implemented peer semantics %j without selecting a grant", (...semantic_capabilities) => {
    expect(relayContractMismatch({ ...CONNECT_CONTRACT_SUPPORT, semantic_capabilities })).toBeUndefined();
  });
  it.each([[], [0], [3], [99]])("rejects missing or unknown semantic support %j", (...semantic_capabilities) => {
    expect(relayContractMismatch({ ...CONNECT_CONTRACT_SUPPORT, semantic_capabilities })?.code)
      .toBe("capability_contract_incompatible");
  });
});
