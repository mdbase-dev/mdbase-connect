import { describe, expect, it, vi } from "vitest";

// Exercise the actual local overlay, not a policy stub: the build changes just
// the source literal after verifying per-stack trust. This fixture is structural;
// signature/independent-root authentication is tested in the shared verifier.
vi.mock("../src/local-build.js", async () => {
  const {readFileSync} = await import("node:fs");
  const {transpileModule, ModuleKind, ScriptTarget} = await import("typescript");
  const source = readFileSync(new URL("../src/local-build.ts", import.meta.url), "utf8");
  const managed = "export const LOCAL_APPLICATION_BUILD: boolean = false;";
  if (source.split(managed).length !== 2) throw Error("local source literal missing");
  const output = transpileModule(source.replace(managed, "export const LOCAL_APPLICATION_BUILD: boolean = true;"),
    {compilerOptions: {module: ModuleKind.ES2022, target: ScriptTarget.ES2022}}).outputText;
  return await import(/* @vite-ignore */ "data:text/javascript;base64," + Buffer.from(output).toString("base64"));
});

import { selectAppEnvironment } from "../src/app-host/app-environment.js";
import { applicationDeclaration } from "../src/application/declaration.js";
import { applicationAssetLoader } from "../src/application/asset-loader.js";
import type { AppBundledReleaseTrust } from "../src/app-host/cloud-copy-bootstrap.js";
const appOrigin = "http://127.0.0.1:48218";
const release: AppBundledReleaseTrust = {schema: "mdbn-app-trust/release/1", environment: "local",
  cpOrigin: "http://127.0.0.1:48219", logOrigin: "http://127.0.0.1:48220", assetSha256: "11".repeat(32),
  source: {repository: "mdbase-dev/mdbase-connect", commit: "22".repeat(20), version: "local"},
  trustedRoots: [new Uint8Array(32).fill(3)], policyPins: Uint8Array.of(1)};

describe("explicit local application artifact", () => {
  it("selects only its local release and exact loopback origins", () => {
    expect(selectAppEnvironment({environment: "local", appOrigin, release})).toMatchObject({environment: "local", cpOrigin: release.cpOrigin, logOrigin: release.logOrigin, allowLoopbackHttp: true});
    for (const environment of ["lab", "production"] as const)
      expect(() => selectAppEnvironment({environment, appOrigin, release: {...release, environment}})).toThrow();
    for (const origin of ["http://localhost:48218", "http://127.0.0.1:0", "http://127.0.0.1:80", appOrigin + "/", "https://connect-lab.mdbase.dev", "http://127.1:48218"])
      for (const field of ["cpOrigin", "logOrigin"] as const)
        expect(() => selectAppEnvironment({environment: "local", appOrigin, release: {...release, [field]: origin}})).toThrow();
  });
  it("admits local declaration/assets without admitting managed context", () => {
    const declaration = {id: "test-local", name: "Local test", origin: appOrigin, environment: "local" as const, manifest: {id: "test-local"}};
    expect(applicationDeclaration(declaration).environment).toBe("local");
    for (const environment of ["lab", "production"] as const)
      expect(() => applicationDeclaration({...declaration, environment})).toThrow();
    expect(() => applicationAssetLoader({url: appOrigin + "/runtime.wasm", sha256: "11".repeat(32), bytes: 3, maxBytes: 3}, {origin: appOrigin, environment: "local"})).not.toThrow();
    expect(() => applicationAssetLoader({url: appOrigin + "/runtime.wasm", sha256: "11".repeat(32), bytes: 3, maxBytes: 3}, {origin: appOrigin, environment: "lab"})).toThrow();
  });
});
