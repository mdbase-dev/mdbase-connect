import { expect, it } from "vitest";
import { localBuild, localDeployment } from "./local-deployment.js";
import { labTargetBootstrap } from "./features/next/migration-lab-target.js";
import { labWorkerClient } from "./features/next/migration-lab.js";
import { parseNextControlPlaneEnv } from "./features/next/policy-keys.js";
import { configuredClaimAudience } from "./features/next/migration-claim-auth.js";

it("managed build refuses runtime local configuration, canonical loopback targets and factories", () => {
  expect(localBuild()).toBe(false);
  expect(() => configuredClaimAudience("http://127.0.0.1:8111")).toThrow();
  const origin = "http://127.0.0.1:8111";
  for (const environment of ["local", "lab", "staging", "production"]) {
    expect(localDeployment(environment, origin)).toBe(false);
    expect(() => labWorkerClient({ environment, url: origin, token: "t".repeat(40) })).toThrow();
  }
  expect(() => labTargetBootstrap({ environment: "local", url: origin, token: "t".repeat(40), account: "10000000-0000-4000-8000-000000000001" })).toThrow();
  expect(() => parseNextControlPlaneEnv({ MDBASE_NEXT_CONTROL_PLANE: "1", MDBASE_CONNECT_ENVIRONMENT: "local", PUBLIC_URL: origin })).toThrow(/explicit local build/);
});
