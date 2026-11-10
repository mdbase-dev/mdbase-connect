import { describe, expect, it } from "vitest";
import {
  grantIdFromMessage,
  hasPendingOperationCapacity,
  type PendingOperationAdmission
} from "./relay-admission.js";

function pending(
  count: number,
  connectorId = "connector-a",
  grantId = "grant-a",
  requestBytes = 1
): PendingOperationAdmission[] {
  return Array.from({ length: count }, () => ({ connectorId, grantId, requestBytes }));
}

describe("relay operation admission", () => {
  it("bounds one grant without consuming an independent grant's capacity", () => {
    const saturated = pending(8);
    expect(hasPendingOperationCapacity(saturated, "connector-a", "grant-a", 1)).toBe(false);
    expect(hasPendingOperationCapacity(saturated, "connector-a", "grant-b", 1)).toBe(true);
  });

  it("bounds retained request bytes and ignores priority control traffic", () => {
    const sevenMiB = 7 * 1024 * 1024;
    const requests: PendingOperationAdmission[] = [
      ...pending(1, "connector-a", "grant-a", sevenMiB),
      { connectorId: "connector-a" }
    ];
    expect(hasPendingOperationCapacity(requests, "connector-a", "grant-a", 1024 * 1024)).toBe(true);
    expect(hasPendingOperationCapacity(requests, "connector-a", "grant-a", 1024 * 1024 + 1)).toBe(false);
  });

  it("extracts only non-empty grant identifiers", () => {
    expect(grantIdFromMessage({ grant_id: "grant-a" })).toBe("grant-a");
    expect(grantIdFromMessage({ grant_id: "" })).toBeUndefined();
    expect(grantIdFromMessage(null)).toBeUndefined();
  });
});
