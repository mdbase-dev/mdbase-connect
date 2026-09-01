import { describe, expect, it, vi } from "vitest";
import { isCanonicalGrantScope, parseGrantScope } from "./runtime-utils.js";
import { storedTokenFromResponse } from "./token-response.js";

const collectionId = "00000000-0000-0000-0000-000000000042";

function tokenBody(access: "contract" | "full_collection") {
  return {
    access_token: "access",
    expires_in: 900,
    collection_id: collectionId,
    collection_name: "Notes",
    operations: ["read"],
    scope: { access, contracts: [] }
  };
}

function parseToken(access: "contract" | "full_collection") {
  return storedTokenFromResponse({
    body: tokenBody(access),
    clientId: "client",
    previous: null,
    defaultApplicationOrigin: "https://app.example",
    pinConnectorIdentity: vi.fn()
  });
}

describe("canonical collection grant scope", () => {
  it("parses the legacy spelling only as diagnostic evidence", () => {
    const legacy = parseGrantScope(tokenBody("contract").scope);

    expect(legacy).toEqual({ access: "contract", contracts: [] });
    expect(legacy && isCanonicalGrantScope(legacy)).toBe(false);
    expect(() => parseToken("contract")).toThrow(
      "legacy contract-scoped grant. Reauthorize for the entire collection"
    );
  });

  it("rejects contradictory full_collection scope with retained contract limits", () => {
    expect(isCanonicalGrantScope({
      access: "full_collection",
      contracts: [{} as never]
    })).toBe(false);
  });

  it("accepts the N-1 full_collection wire spelling", () => {
    expect(parseToken("full_collection").scope).toEqual({
      access: "full_collection",
      contracts: []
    });
  });
});
