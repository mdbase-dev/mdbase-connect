import { describe, expect, it } from "vitest";
import { hostedReplicaCollectionOperations } from "./hosted-replica-policy.js";

describe("hosted replica policy", () => {
  it("keeps transport capabilities on the grant side of the provider boundary", () => {
    const grantOperations = ["read", "sync", "changes", "update"];

    expect(hostedReplicaCollectionOperations(grantOperations)).toEqual([
      "read",
      "changes",
      "update"
    ]);
    expect(grantOperations).toEqual(["read", "sync", "changes", "update"]);
  });
});
