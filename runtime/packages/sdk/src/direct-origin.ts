import { mdbaseError } from "./errors.js";

// Called only after the IPv4 literal matches the URL parser's canonical hostname.
function privateIPv4(host: string): boolean {
  const [a, b = -1] = host.split(".").map(Number);
  return a === 127 || a === 10 || (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127);
}

/** The immutable enrollment descriptor, including the initial certificate pin when present. */
export function directBackendOrigin(server: string): string {
  if (!globalThis.location?.origin.startsWith("https://") || typeof server !== "string" || /[\u0000-\u0020\u007f]/u.test(server)) {
    throw mdbaseError("invalid_request", "Expected an HTTPS backend origin or pinned invitation");
  }
  let backend: URL;
  try { backend = new URL(server); }
  catch { throw mdbaseError("invalid_request", "Invalid HTTPS backend origin"); }
  const host = backend.hostname.replace(/\.$/u, "");
  if (backend.origin === location.origin || /(?:^|\.)(?:tasknotes\.dev|mdbase\.dev|tasknotes-app\.pages\.dev)$/u.test(host) || host === "mdbase-connect-candidate-b.onrender.com") {
    throw mdbaseError("invalid_request", "Choose a self-hosted backend separate from the app and managed services");
  }
  if (server.includes("#")) {
    const match = /^https:\/\/([0-9]+(?:\.[0-9]+){3}):([1-9][0-9]{0,4})#sha256=([0-9a-f]{64})$/u.exec(server);
    if (!match || backend.hostname !== match[1] || !privateIPv4(backend.hostname)) {
      throw mdbaseError("invalid_request", "Invalid pinned backend invitation");
    }
    return server; // Retain the explicit port, including :443, in the encrypted grant binding.
  }
  if (!/^https:\/\/[^/?#@\\\s]+\/?$/u.test(server)) throw mdbaseError("invalid_request", "Expected an HTTPS backend origin without a path or credentials");
  return backend.origin;
}
