/** Managed artifact literal. Only a signature-verified per-stack local build
 * replaces this literal; never a runtime environment/config option. Thin-safe. */
export const LOCAL_APPLICATION_BUILD: boolean = false;

/** Transport admission only: never authenticates release context or authority.
 * Kept behind the compiled literal so runtime flags cannot relax managed TLS. */
export function localApplicationHttpOrigin(value: string): boolean {
  if (!LOCAL_APPLICATION_BUILD) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      && Number(url.port) > 0 && url.origin === value && !url.username && !url.password;
  } catch { return false; }
}

/** A loopback HTTP origin; local builds narrow it to {@link localApplicationHttpOrigin}.
 * As an application's own origin it is admitted in every environment: it is
 * where an application runs while it is developed. As one of mdbase's origins
 * (control plane, log) it also needs the caller's LAB flag, see
 * `serviceLoopbackAllowed`. Not the native exception, which is canonical
 * 127.0.0.1 only (`isNativeLoopbackOrigin`). */
export function loopbackHttpOrigin(value: string): boolean {
  if (LOCAL_APPLICATION_BUILD) return localApplicationHttpOrigin(value);
  try {
    const url = new URL(value);
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch { return false; }
}

/** The relay's local equivalent of TLS; credentials still travel in the first
 * frame, never in a URL. Managed relays continue to require wss. */
export function localApplicationWebSocketUrl(value: string): boolean {
  if (!LOCAL_APPLICATION_BUILD) return false;
  try {
    const url = new URL(value);
    return url.protocol === "ws:" && !url.username && !url.password && !url.hash
      && (url.origin === value || url.href === value)
      && localApplicationHttpOrigin(`http://${url.host}`);
  } catch { return false; }
}

