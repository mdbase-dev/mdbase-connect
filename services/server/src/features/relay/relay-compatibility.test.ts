import { describe, expect, it } from "vitest";
import { CONNECT_CONTRACT_SUPPORT } from "@mdbase-dev/connect-protocol";
import { parseServingCollections, relayContractMismatch } from "./relay-compatibility.js";

describe("semantic bridge handshake", () => {
  it.each([[1], [2], [2, 1]])("accepts implemented peer semantics %j without selecting a grant", (...semantic_capabilities) => {
    expect(relayContractMismatch({ ...CONNECT_CONTRACT_SUPPORT, semantic_capabilities })).toBeUndefined();
  });
  it.each([[], [0], [3], [99]])("rejects missing or unknown semantic support %j", (...semantic_capabilities) => {
    expect(relayContractMismatch({ ...CONNECT_CONTRACT_SUPPORT, semantic_capabilities })?.code)
      .toBe("capability_contract_incompatible");
  });
});

describe("parseServingCollections", () => {
  const idA = "01900000-0000-7000-8000-0000000000aa";
  const idB = "01900000-0000-7000-8000-0000000000bb";

  it("normalizes and deduplicates valid UUID arrays", () => {
    expect(parseServingCollections([])).toEqual([]);
    expect(parseServingCollections([idA.toUpperCase(), idB, idA])).toEqual([idA, idB]);
  });

  it("rejects non-arrays, invalid entries, and oversized lists", () => {
    expect(parseServingCollections(undefined)).toBeUndefined();
    expect(parseServingCollections(null)).toBeUndefined();
    expect(parseServingCollections(["not-a-uuid"])).toBeUndefined();
    expect(parseServingCollections([idA, 123])).toBeUndefined();
    expect(parseServingCollections(Array.from({ length: 513 }, () => idA))).toBeUndefined();
  });
});
