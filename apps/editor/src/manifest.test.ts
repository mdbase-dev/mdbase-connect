import { describe, expect, it } from "vitest";
import {
  applicationFileRequest,
  applicationOperationSelectionIsAtomic,
  capabilityOperationsForContractVersion,
  operationsForApplicationCapabilities
} from "@mdbase-dev/connect-protocol";
import { parseVersionedAppManifest } from "@mdbase-dev/connect-protocol/manifest";
import retained from "../tests/fixtures/editor-manifest-v1.json";
import bundled from "../public/.well-known/mdbase-app.json";

describe("Editor application declarations", () => {
  it("declares complete feature groups and independently deniable file addition", () => {
    const parsed = parseVersionedAppManifest(bundled);
    expect(parsed.contractVersion).toBe(2);
    if (parsed.contractVersion !== 2) throw new Error("Expected semantic v2");
    const { capabilities, files } = parsed.manifest.requirements;
    expect(capabilities).toEqual({
      contract_version: 2,
      required: ["collection.read", "records.create", "records.edit", "records.delete", "definitions.manage"],
      optional: []
    });
    const operations = operationsForApplicationCapabilities(capabilities!);
    expect(operations).toEqual([
      "describe", "changes", "read", "query", "list_views", "execute_view", "read_view_source",
      "validate", "read_type", "create", "update", "rename", "delete", "create_type",
      "update_type", "assess_type_pack", "apply_type_pack"
    ]);
    expect(applicationOperationSelectionIsAtomic(capabilities!, operations.filter(op => op !== "rename"))).toBe(false);
    expect(applicationFileRequest(files!, { includeOptional: false })).toEqual({
      actions: ["list", "read"], scope: { kind: "collection" }
    });
    expect(applicationFileRequest(files!).actions).toEqual(["list", "read", "add"]);
    expect(parsed.manifest.provisions).toEqual({ type_packs: [], configuration: [] });
    expect(operations).not.toContain("apply_collection_setup");
  });

  it("retains the predecessor declaration and exact meanings without translating to v2", () => {
    const before = structuredClone(retained);
    const parsed = parseVersionedAppManifest(retained);
    expect(parsed.contractVersion).toBe(1);
    expect(parsed.manifest.requirements).toEqual({ configuration: [], ...retained.requirements });
    expect(retained).toEqual(before);
    expect(capabilityOperationsForContractVersion(1, "records.update")).toEqual(["update"]);
    expect(capabilityOperationsForContractVersion(1, "records.read")).toEqual(["read"]);
    expect(retained.requirements.capabilities.optional).toEqual(["files.add"]);
  });
});
