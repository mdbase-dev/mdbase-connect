import { describe, expect, it } from "vitest";
import { mdbaseError, MdbaseError } from "@mdbase-dev/sdk";
import { gatewayError, missingCoreCapabilities, missingTypeCapabilities } from "./gateway";
import { pendingNoteRequestId } from "./pending-note-mutation";

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

describe("SDK errors at the Editor boundary", () => {
  it("preserves Editor-owned actionable error messages", () => {
    expect(gatewayError(new Error("The note index could not be read."))).toBe("The note index could not be read.");
  });

  it("uses SDK problem copy rather than replica developer diagnostics", () => {
    const diagnostic = "Provider internal details must not be shown";
    const presented = gatewayError(mdbaseError("unavailable", diagnostic));
    expect(presented).not.toContain(diagnostic);
    expect(presented.length).toBeGreaterThan(0);
  });

  it("uses the SDK's captured mutation identity, not an invented request", () => {
    const error = new MdbaseError(mdbaseError("outcome_unknown", "Lost reply").toProblem(), { mutationId: "original-mutation" });
    expect(pendingNoteRequestId(error)).toBe("original-mutation");
    expect(pendingNoteRequestId(mdbaseError("forbidden", "Denied"))).toBeUndefined();
    expect(pendingNoteRequestId(new MdbaseError(mdbaseError("forbidden", "Denied").toProblem(), { mutationId: "refused-mutation" }))).toBeUndefined();
    expect(pendingNoteRequestId(new Error("Lost reply"))).toBeUndefined();
  });
});
