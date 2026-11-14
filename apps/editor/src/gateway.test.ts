import { describe, expect, it } from "vitest";
import { missingCoreCapabilities, missingTypeCapabilities } from "./gateway";

describe("bridge declaration readiness", () => {
  it("keeps legacy edit, file, and definition authority visible without v2 expansion", () => {
    const connection = {
      collectionId: "legacy", operations: ["read"],
      missingCapabilities: ["records.update", "files.read", "definitions.read"]
    };
    expect(missingCoreCapabilities(connection)).toEqual(["records.update", "files.read"]);
    expect(missingTypeCapabilities(connection)).toEqual(["definitions.read"]);
  });
});
