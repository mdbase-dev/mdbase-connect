import { describe, expect, it } from "vitest";
import type { AvailableCollection, PendingAuthorization } from "./api";
import { collectionCompatibility } from "./compatibility";

const contract = { id: "dev.mdbase.example.task", version: 1, digest: "sha256:example" };
const request = (collectionKind?: "local" | "hosted") => ({
  distribution: "web",
  requested_operations: ["read"],
  requirements: { contracts: [contract], ...(collectionKind ? { collection_kind: collectionKind } : {}) },
  provisions: { type_packs: [], configuration: [] }
}) as unknown as Pick<PendingAuthorization, "distribution" | "requirements" | "provisions" | "requested_operations">;
const collection = (kind: AvailableCollection["kind"]): AvailableCollection => ({
  id: "11111111-1111-4111-a111-111111111111", kind, connector_name: "Example", display_name: "Example",
  spec_version: "0.3.0", contracts: []
});

describe("collection compatibility at consent", () => {
  it("offers synced collections whose types are only checked once the app connects", () => {
    expect(collectionCompatibility(request(), collection("cloud_copy"))).toEqual({ compatible: true });
    expect(collectionCompatibility(request(), collection("private"))).toEqual({ compatible: true });
    expect(collectionCompatibility(request(), collection("local"))).toMatchObject({ compatible: false, code: "missing_contracts" });
  });

  it("treats a cloud copy as a hosted collection, but not a Private or local one", () => {
    expect(collectionCompatibility(request("hosted"), collection("cloud_copy"))).toEqual({ compatible: true });
    expect(collectionCompatibility(request("hosted"), collection("private"))).toMatchObject({ compatible: false, code: "collection_kind" });
    expect(collectionCompatibility(request("hosted"), collection("local"))).toMatchObject({ compatible: false, code: "collection_kind" });
  });
});
