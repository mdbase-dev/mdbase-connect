/** Explicit first-party build environment. This validates the public output of
 * the shared build verifier; it does NOT authenticate arbitrary caller context.
 * Release manifest/tool/asset authentication must precede this selection. */
import type { AppBundledReleaseTrust } from "./cloud-copy-bootstrap.js";
export interface AppEnvironmentSelection {
  readonly environment: "lab" | "production";
  readonly appOrigin: string;
  readonly cpOrigin: string;
  readonly logOrigin: string;
  readonly assetSha256: string;
  readonly allowLoopbackHttp: boolean;
}
const selections = new WeakSet<object>();
const invalid = () => new Error("app environment: explicit authenticated build context required");
function origin(value: unknown, loopbackAllowed: boolean): string {
  if (typeof value !== "string" || !value.length) throw invalid();
  const u = new URL(value);
  const loopback = loopbackAllowed && u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (u.origin !== value || u.username || u.password || (u.protocol !== "https:" && !loopback)) throw invalid();
  return value;
}
/** No environment or app-origin default. LAB loopback is explicit and bound to
 * the LAB CP; production cannot select LAB or loopback. Same-origin cutover
 * storage preservation is an app gate, never a legacy runtime fallback. */
export function selectAppEnvironment(input: {
  environment: "lab" | "production";
  appOrigin: string;
  release: AppBundledReleaseTrust;
}): AppEnvironmentSelection {
  const {environment, release} = input;
  if ((environment !== "lab" && environment !== "production") || !release ||
      release.schema !== "mdbn-app-trust/release/1" || release.environment !== environment ||
      !/^[0-9a-f]{64}$/.test(release.assetSha256) ||
      !release.source || release.source.repository !== "mdbase-dev/mdbase-connect" ||
      !/^[0-9a-f]{40}$/.test(release.source.commit) ||
      !/^[A-Za-z0-9.+-]{1,64}$/.test(release.source.version) ||
      !Array.isArray(release.trustedRoots) || !release.trustedRoots.length || release.trustedRoots.length > 64 ||
      release.trustedRoots.some(root => !(root instanceof Uint8Array) || root.length !== 32 || root.every(b => b === 0)) ||
      !(release.policyPins instanceof Uint8Array) || !release.policyPins.length || release.policyPins.length > 65536) throw invalid();
  const cpOrigin = origin(release.cpOrigin, false), logOrigin = origin(release.logOrigin, false);
  if ((environment === "lab") !== (cpOrigin === "https://connect-lab.mdbase.dev")) throw invalid();
  const appOrigin = origin(input.appOrigin, environment === "lab");
  if (environment === "lab" && appOrigin === "https://app.tasknotes.dev") throw invalid();
  const selected = Object.freeze({environment, appOrigin, cpOrigin, logOrigin, assetSha256: release.assetSha256,
    allowLoopbackHttp: new URL(appOrigin).protocol === "http:"});
  selections.add(selected); return selected;
}
/** Only a previously validated immutable selection, not a copied/redirect object.
 * Not a hostile same-origin JS boundary or native grant/READ authority. */
export function isAppEnvironmentSelection(value: unknown): value is AppEnvironmentSelection {
  return !!value && typeof value === "object" && selections.has(value);
}
