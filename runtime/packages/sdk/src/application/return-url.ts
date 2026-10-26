import {isNativeLoopbackOrigin} from "@mdbase-dev/connect-protocol/manifest";
/** The sign-in opener's `return_url` (RFC 8252 §7.1 / §8.1). It must exactly
 * equal one of the canonical manifest's `redirect_uris` (no prefix, pattern or
 * normalisation match) and be either an https URL on the homepage origin, LAB
 * loopback http, or a private-use reverse-DNS scheme derived from the manifest
 * ID (the same rule the CP applies at registration). It carries no credential:
 * sign-in still completes by the SDK's own pairing poll. */
import { LOCAL_APPLICATION_BUILD, localApplicationHttpOrigin } from "../application/local-build.js";
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];
const RESERVED = ["http", "https", "file", "javascript", "data", "blob", "about", "capacitor", "chrome-extension", "moz-extension"];

export function declaredReturnUrl(value: unknown, manifest: unknown, loopbackHttp: boolean): boolean {
  if (typeof value !== "string" || !value || value.length > 2048 || value.includes("*")) return false;
  const declared = manifest && typeof manifest === "object" ? (manifest as {redirect_uris?: unknown}).redirect_uris : undefined;
  if (!Array.isArray(declared) || !declared.includes(value)) return false;
  const {id, homepage, platform} = manifest as {id?: unknown; homepage?: unknown; platform?: unknown};
  let url: URL; try { url = new URL(value); } catch { return false; }
  if (url.username || url.password || url.hash) return false;
  if (url.protocol === "https:" || url.protocol === "http:") {
    let home: URL; try { home = new URL(String(homepage)); } catch { return false; }
    return url.origin === home.origin && (url.protocol === "https:" || (platform === "native" && isNativeLoopbackOrigin(url.origin)) || (loopbackHttp && (LOCAL_APPLICATION_BUILD ? localApplicationHttpOrigin(url.origin) : LOOPBACK.includes(url.hostname))));
  }
  const scheme = url.protocol.slice(0, -1);
  return typeof id === "string" && scheme.includes(".") && /^[a-z][a-z0-9+.-]*$/.test(scheme) && !RESERVED.includes(scheme)
    && (scheme === id || scheme.startsWith(`${id}.`)) && url.hostname.length > 0;
}
