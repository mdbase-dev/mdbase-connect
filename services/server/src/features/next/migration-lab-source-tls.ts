import { createHash, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ConnectionOptions } from "node:tls";

// LAB internal PostgreSQL presents one self-signed certificate without SANs.
// Coordinator 2026-10-14T00:48 authorizes this exact connection-local identity
// pin with CA validation retained. Remove when Render supplies hostname-valid
// certificates. Never used by the control DB, Worker reader or stage/prod.
const HOSTS = new Set([
  "dpg-dabpdaon74is7380br1g-a",
  "dpg-dabpdaon74is7380br1g-a.own-d9fbuuv41pts73dspdcg.svc.cluster.local"
]);
const DATABASE = "mdbase_lab_beta94_202609020323211110102";
const ROLE = "mdbn_lab_migration_cli_reader";
export const LAB_LEGACY_SOURCE_CERT_SHA256 = "C8EA98CCEB4EE74DAFD97F3C170965CF02680FBE9F2236D43A8AA77A07172545";

function refused(): never { throw new Error("migration_lab_source_tls_pin_refused"); }
const fingerprint = (raw: Buffer): string => createHash("sha256").update(raw).digest("hex").toUpperCase();

/** Exact LAB source only; normal URLs retain the ordinary pg TLS policy. */
export function labLegacySourceConnection(
  databaseUrl: string, environment: string | undefined
): { url: string; ssl?: ConnectionOptions } {
  const url = new URL(databaseUrl);
  if (!HOSTS.has(url.hostname)) return { url: databaseUrl };
  if (environment !== "lab" || !["postgres:", "postgresql:"].includes(url.protocol)
    || decodeURIComponent(url.pathname) !== `/${DATABASE}` || decodeURIComponent(url.username) !== ROLE
    || !url.password || url.port !== "5432" || url.hash) refused();
  if ([...url.searchParams.keys()].some((key) => !["sslmode", "sslrootcert", "options"].includes(key))
    || url.searchParams.getAll("sslmode").length !== 1 || url.searchParams.get("sslmode") !== "verify-ca"
    || url.searchParams.getAll("sslrootcert").length !== 1) refused();
  const rootPath = url.searchParams.get("sslrootcert");
  if (!rootPath?.startsWith("/")) refused();
  let certificate: X509Certificate;
  try { certificate = new X509Certificate(readFileSync(rootPath)); } catch { refused(); }
  if (fingerprint(certificate.raw) !== LAB_LEGACY_SOURCE_CERT_SHA256) refused();
  const host = url.hostname;
  // pg-connection-string replaces config.ssl when URL TLS parameters remain.
  // Strip only those two parameters AFTER validating the exact scoped policy.
  url.searchParams.delete("sslmode"); url.searchParams.delete("sslrootcert");
  return {
    url: url.href,
    ssl: {
      ca: certificate.toString(), rejectUnauthorized: true,
      checkServerIdentity: (actualHost, peer) => {
        if (actualHost !== host || typeof peer.fingerprint256 !== "string"
          || peer.fingerprint256.replace(/:/gu, "").toUpperCase() !== LAB_LEGACY_SOURCE_CERT_SHA256) {
          return new Error("migration_lab_source_tls_pin_mismatch");
        }
        return undefined;
      }
    }
  };
}
