import { describe, expect, it } from "vitest";
import { collectionModeExecutionEnabled } from "./collection-mode-execution.js";
import type { NextControlPlaneConfig } from "./policy-keys.js";

const next = {
  privateBootstrap: true,
  cloudCopyBootstrap: { hosted: { url: "https://hosted.test", token: "public-hosted-fixture".repeat(3) },
    escrow: { url: "https://escrow.test", token: "public-escrow-fixture".repeat(3) } },
} as NextControlPlaneConfig;

describe("collection mode execution gate", () => {
  it("does not mount execution merely because both bootstraps are configured", () => {
    expect(collectionModeExecutionEnabled(next)).toBe(false);
  });

  it("requires both private and cloud-copy bootstraps alongside the execution flag", () => {
    expect(collectionModeExecutionEnabled({ ...next, collectionModeExecution: true })).toBe(true);
    expect(collectionModeExecutionEnabled({ ...next, privateBootstrap: undefined, collectionModeExecution: true })).toBe(false);
    expect(collectionModeExecutionEnabled({ ...next, cloudCopyBootstrap: undefined, collectionModeExecution: true })).toBe(false);
  });
});
