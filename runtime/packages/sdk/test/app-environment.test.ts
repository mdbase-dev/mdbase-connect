import { describe, expect, it, vi, afterEach } from "vitest";
import { webcrypto } from "node:crypto";
import { selectAppEnvironment } from "../src/app-host/app-environment.js";
import { AppProtectedInstallationSignIn } from "../src/app-host/installation-sign-in.js";
import { AppInstallationStore } from "../src/app-host/installation-store.js";
import type { AppBundledReleaseTrust } from "../src/app-host/cloud-copy-bootstrap.js";
const appOrigin = "http://127.0.0.1:48218", cpOrigin = "https://connect-lab.mdbase.dev";
function release(environment = "lab"): AppBundledReleaseTrust {
  return {schema: "mdbn-app-trust/release/1", environment, cpOrigin: environment === "lab" ? cpOrigin : "https://connect.example.test", logOrigin: "https://log.example.test", assetSha256: "11".repeat(32), source: {repository: "mdbase-dev/mdbase-connect", commit: "22".repeat(20), version: "0.1.0-beta.129"}, trustedRoots: [new Uint8Array(32).fill(3)], policyPins: Uint8Array.of(1)};
}
afterEach(() => {vi.restoreAllMocks(); vi.unstubAllGlobals();});
describe("explicit build environment selection (context validation, not authentication)", () => {
  it("selects immutable explicit LAB context and no production default", () => {
    const selected = selectAppEnvironment({environment: "lab", appOrigin, release: release()});
    expect(selected).toEqual({environment: "lab", appOrigin, cpOrigin, logOrigin: "https://log.example.test", assetSha256: "11".repeat(32), allowLoopbackHttp: true});
    expect(Object.isFrozen(selected)).toBe(true);
    expect(() => selectAppEnvironment({environment: undefined as never, appOrigin, release: release()})).toThrow();
    expect(() => selectAppEnvironment({environment: "production", appOrigin: undefined as never, release: release("production")})).toThrow();
  });
  it.each(["", "http://evil.test:48218", "https://app.tasknotes.dev", `${appOrigin}/`, `${appOrigin}/path`, "http://user:pass@127.0.0.1:48218"])("refuses bad/frozen app origin %s", origin => {
    expect(() => selectAppEnvironment({environment: "lab", appOrigin: origin, release: release()})).toThrow();
  });
  it("permits an explicit isolated LAB HTTPS origin; does not add a server allowlist", () => {
    const selected = selectAppEnvironment({environment: "lab", appOrigin: "https://isolated.example.test", release: release()});
    expect(selected.allowLoopbackHttp).toBe(false);
  });
  it("refuses LAB/production context swaps and production loopback", () => {
    expect(() => selectAppEnvironment({environment: "production", appOrigin: "https://next.example.test", release: release()})).toThrow();
    expect(() => selectAppEnvironment({environment: "lab", appOrigin, release: {...release(), cpOrigin: "https://connect.example.test"}})).toThrow();
    expect(() => selectAppEnvironment({environment: "production", appOrigin, release: release("production")})).toThrow();
    expect(() => selectAppEnvironment({environment: "production", appOrigin: "https://next.example.test", release: {...release("production"), cpOrigin}})).toThrow();
    expect(selectAppEnvironment({environment: "production", appOrigin: "https://app.tasknotes.dev", release: release("production")}).allowLoopbackHttp).toBe(false);
  });
  it.each(["assetSha256", "source", "trustedRoots", "policyPins", "logOrigin"])("refuses malformed build context %s", field => {
    expect(() => selectAppEnvironment({environment: "lab", appOrigin, release: {...release(), [field]: null}})).toThrow();
  });
  it("opens original protected LAB actor only with the exact selected origin/CP/environment", async () => {
    vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("location", {origin: appOrigin});
    const selection = selectAppEnvironment({environment: "lab", appOrigin, release: release()});
    let persisted: Uint8Array | null = null, current = true;
    const close = vi.fn(async () => {current = false;});
    const open = vi.spyOn(AppInstallationStore, "open").mockImplementation(async (options, create) => {
      expect(options.allowLoopbackHttp).toBe(true); persisted = create();
      return {store: {isCurrent: () => current, close} as unknown as AppInstallationStore, plaintext: new Uint8Array(persisted)};
    });
    const options = {environment: "lab" as const, environmentSelection: selection, origin: appOrigin, cpOrigin, appId: "tasknotes-web" as const, mode: "fresh" as const, signal: new AbortController().signal, locks: undefined};
    const flow = await AppProtectedInstallationSignIn.open(options); expect(flow.view().state).toBe("pending"); expect(open).toHaveBeenCalledOnce();
    const state = JSON.parse(new TextDecoder().decode(persisted!)); expect(state).toMatchObject({environment: "lab", origin: appOrigin, cpOrigin, requestedCreateCollections: false});
    await flow.close();
    for (const changed of [{origin: "http://127.0.0.1:48219"}, {cpOrigin: "https://foreign.test"}, {environment: "production" as const}, {environmentSelection: {...selection}}]) {
      await expect(AppProtectedInstallationSignIn.open({...options, ...changed})).rejects.toThrow("binding");
    }
    expect(open).toHaveBeenCalledOnce();
  });
});
