import { it, expect } from "vitest";
import { receiptSummary, errorSummary, appendDiagnostic, shouldRunUI, validateScenarioMode, ownedCreationPath, creationDisposition, LabScenarioError } from "./diagnostics.mjs";
const nonce = "12345678-1234-4234-9234-123456789012";
it("requires the exact owned sanitized filename, not merely a relaxed test prefix", () => {
  const path = ownedCreationPath(nonce);
  expect(path).toBe(`test tasknotes-ui-${nonce}.md`);
  expect(() => ownedCreationPath("../unexpected")).toThrow("invalid LAB nonce");
  expect(creationDisposition(path, `test tasknotes-ui-other.md`, [path], 1).errorCode).toBe("unexpected_created_path");
});
it("a physical modal save without SDK create routing cannot pass", () => {
  const path = ownedCreationPath(nonce);
  expect(creationDisposition(path, path, [], 0)).toEqual({ creationPathMatched: true, sdkCreateRouted: false, createPublished: false, errorCode: "record_create_not_routed" });
});
it("SDK routing alone cannot replace final native publication", () => {
  const path = ownedCreationPath(nonce);
  expect(creationDisposition(path, path, [path], 0).errorCode).toBe("record_create_not_published");
  expect(creationDisposition(path, path, [path], 1).errorCode).toBe("");
});
it("scenario codes are bounded and cannot export arbitrary error text", () => {
  expect(new LabScenarioError("record_create_not_routed").code).toBe("record_create_not_routed");
  expect(new LabScenarioError("synthetic-private-error").code).toBe("full_ui_service_blocked");
});
it("negative initialization mode cannot authorize a UI scenario, even after successful initialization", () => {
  expect(shouldRunUI("negative_initialization")).toBe(false);
  expect(shouldRunUI("full_ui")).toBe(true);
});
it("unknown scenario modes fail closed at build and run boundaries", () => {
  expect(() => validateScenarioMode("unexpected")).toThrow("invalid LAB UI mode");
  expect(() => shouldRunUI(undefined)).toThrow("invalid LAB UI mode");
});
it("captures typed rejected receipt before the adapter reduces it to an Error", () => {
  expect(receiptSummary({ receipt: { state: "rejected", published: "not_published", status: "conflicted",
    problem: { code: "invalid_request", recovery: "fix_request", reason: "not_a_resource_path" } } })).toEqual({
    state: "rejected", publication: "not_published", status: "conflicted", code: "invalid_request", recovery: "fix_request",
    reason: "not_a_resource_path", hasIssues: false, issueCountCapped: 0,
  });
});
it("never emits raw messages, details, frames, mutation IDs or arbitrary code/reason strings", () => {
  const syntheticSecret = "synthetic_sensitive_value";
  const result = receiptSummary({ mutationId: syntheticSecret, receipt: { mutation: syntheticSecret, state: syntheticSecret,
    published: syntheticSecret, status: syntheticSecret, problem: { code: syntheticSecret, reason: syntheticSecret,
      recovery: syntheticSecret, message: syntheticSecret, details: { token: syntheticSecret }, traceId: syntheticSecret,
      issues: Array.from({ length: 20 }, () => ({ code: syntheticSecret, message: syntheticSecret })) } } });
  expect(JSON.stringify(result)).not.toContain(syntheticSecret);
  expect(result.issueCountCapped).toBe(8);
  expect(result.hasIssues).toBe(true);
  expect(result.reason).toBe("redacted_unknown");
});
it("captures typed SDK throws separately, while generic errors have no invented code", () => {
  expect(errorSummary({ code: "invalid_record", recovery: "fix_request", issues: [{}] })).toMatchObject({ code: "invalid_record", hasIssues: true });
  expect(errorSummary(new Error("synthetic-private-message"))).toMatchObject({ code: "absent", reason: "absent" });
});
it("bounds diagnostic count and preserves earlier submit failure when later initialization fails", () => {
  const target = [];
  for (let i = 0; i < 30; i++) appendDiagnostic(target, "resource_submit", "receipt", { state: "rejected" });
  expect(target).toHaveLength(8);
  expect(target[0]).toEqual({ phase: "resource_submit", disposition: "receipt", state: "rejected" });
});
