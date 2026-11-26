import { expect, it } from "vitest";
import { localBuild, localDeployment } from "./local-deployment.js";
import { parseNextControlPlaneEnv } from "../features/next/policy-keys.js";

it("managed build refuses runtime local configuration, canonical loopback targets and factories", () => {
  expect(localBuild()).toBe(false);
  const origin = "http://127.0.0.1:8111";
  for (const environment of ["local", "lab", "staging", "production"]) {
    expect(localDeployment(environment, origin)).toBe(false);
  }
  expect(() => parseNextControlPlaneEnv({ MDBASE_NEXT_CONTROL_PLANE: "1", MDBASE_CONNECT_ENVIRONMENT: "local", PUBLIC_URL: origin })).toThrow(/explicit local build/);
});
