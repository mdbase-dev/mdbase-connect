import {isNativeLoopbackOrigin} from "@mdbase-dev/connect-protocol/manifest";
/** App origins the SDK can run under: https web origins, loopback http (an
 * application under development, or a native one), Capacitor's iOS
 * `capacitor://<host>` and browser-extension pages.
 * Browsers may report custom app schemes as an opaque "null" origin, so the
 * canonical form is always `<scheme>//<host>`. Exact match, no wildcards. */
import { loopbackHttpOrigin } from "../application/local-build.js";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export type AppOriginPlatform = "web" | "mobile" | "extension" | "native";

/** Origin of a URL, including app schemes whose WHATWG origin is opaque. */
export function urlOrigin(url: URL): string {
  return url.protocol === "https:" || url.protocol === "http:" ? url.origin : `${url.protocol}//${url.host}`;
}

/** The platform an app origin runs on, or null when it is not an app origin.
 * A manifest that declares `platform: "native"` is held to the canonical IPv4
 * loopback origin its manifest rule requires. */
export function appOriginPlatform(value: unknown, declared?: "native"): AppOriginPlatform | null {
  if (typeof value !== "string" || value.length > 512) return null;
  let u: URL; try { u = new URL(value); } catch { return null; }
  if (u.username || u.password || u.search || u.hash || !["", "/"].includes(u.pathname) || urlOrigin(u) !== value) return null;
  switch (u.protocol) {
    case "https:": return "web";
    case "http:": return declared === "native" ? (isNativeLoopbackOrigin(value) ? "native" : null) : loopbackHttpOrigin(value) ? "web" : null;
    case "capacitor:": return !u.port && /^[a-z0-9.-]{1,253}$/.test(u.hostname) ? "mobile" : null;
    case "chrome-extension:": return /^[a-p]{32}$/.test(u.host) ? "extension" : null;
    case "moz-extension:": return UUID.test(u.host) ? "extension" : null;
    default: return null;
  }
}
export const isAppOrigin = (value: unknown): boolean => appOriginPlatform(value) !== null;

/** This document's or Worker's own app origin, or null outside a browser. */
export function currentAppOrigin(): string | null {
  const location = globalThis.location as Location | undefined;
  if (!location) return null;
  if (typeof location.origin === "string" && location.origin !== "null") return location.origin;
  try { return urlOrigin(new URL(location.href)); } catch { return null; }
}
