/** App origins the SDK can run under: https (and LAB loopback http) web
 * origins, Capacitor's iOS `capacitor://<host>` and browser-extension pages.
 * Browsers may report custom app schemes as an opaque "null" origin, so the
 * canonical form is always `<scheme>//<host>`. Exact match, no wildcards. */
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export type AppOriginPlatform = "web" | "mobile" | "extension";

/** Origin of a URL, including app schemes whose WHATWG origin is opaque. */
export function urlOrigin(url: URL): string {
  return url.protocol === "https:" || url.protocol === "http:" ? url.origin : `${url.protocol}//${url.host}`;
}

export function appOriginPlatform(value: unknown, loopbackHttp = false): AppOriginPlatform | null {
  if (typeof value !== "string" || value.length > 512) return null;
  let u: URL; try { u = new URL(value); } catch { return null; }
  if (u.username || u.password || u.search || u.hash || !["", "/"].includes(u.pathname) || urlOrigin(u) !== value) return null;
  switch (u.protocol) {
    case "https:": return "web";
    case "http:": return loopbackHttp && LOOPBACK.includes(u.hostname) ? "web" : null;
    case "capacitor:": return !u.port && /^[a-z0-9.-]{1,253}$/.test(u.hostname) ? "mobile" : null;
    case "chrome-extension:": return /^[a-p]{32}$/.test(u.host) ? "extension" : null;
    case "moz-extension:": return UUID.test(u.host) ? "extension" : null;
    default: return null;
  }
}
export const isAppOrigin = (value: unknown, loopbackHttp = false): boolean => appOriginPlatform(value, loopbackHttp) !== null;

/** This document's or Worker's own app origin, or null outside a browser. */
export function currentAppOrigin(): string | null {
  const location = globalThis.location as Location | undefined;
  if (!location) return null;
  if (typeof location.origin === "string" && location.origin !== "null") return location.origin;
  try { return urlOrigin(new URL(location.href)); } catch { return null; }
}
