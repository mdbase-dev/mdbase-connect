import type { ConnectionOptions } from "node:tls";

// LAB internal PostgreSQL rotates its self-signed, SAN-less certificate on
// re-provisioning. Require encryption without certificate pinning for this
// internal migration source only. Never used by the control DB or stage/prod.
const HOSTS = new Set([
  "dpg-dabpdaon74is7380br1g-a",
  "dpg-dabpdaon74is7380br1g-a.own-d9fbuuv41pts73dspdcg.svc.cluster.local"
]);
const DATABASE = "mdbase_lab_beta94_202609020323211110102";
const ROLE = "mdbn_lab_migration_cli_reader";

function refused(): never { throw new Error("migration_lab_source_tls_refused"); }

/** Exact LAB source only; normal URLs retain the ordinary pg TLS policy. */
export function labLegacySourceConnection(
  databaseUrl: string, environment: string | undefined, labOwnerReadonlyRole?: string
): { url: string; ssl?: ConnectionOptions } {
  const url = new URL(databaseUrl);
  if (labOwnerReadonlyRole !== undefined && (environment !== "lab"
    || !/^[a-z_][a-z0-9_]{0,62}$/u.test(labOwnerReadonlyRole) || labOwnerReadonlyRole === ROLE
    || !HOSTS.has(url.hostname) || url.searchParams.getAll("options").length !== 1
    || url.searchParams.get("options") !== "-cdefault_transaction_read_only=on")) refused();
  if (!HOSTS.has(url.hostname)) return { url: databaseUrl };
  if (environment !== "lab" || !["postgres:", "postgresql:"].includes(url.protocol)
    || decodeURIComponent(url.pathname) !== `/${DATABASE}` || decodeURIComponent(url.username) !== (labOwnerReadonlyRole ?? ROLE)
    || !url.password || url.port !== "5432" || url.hash) refused();
  if ([...url.searchParams.keys()].some((key) => !["sslmode", "sslrootcert", "options"].includes(key))) refused();
  // URL TLS parameters replace explicit pg SSL options. Remove them so even
  // an absent/disable sslmode cannot turn off required encrypted transport.
  // Old sslrootcert paths are ignored, never read from disk.
  url.searchParams.delete("sslmode"); url.searchParams.delete("sslrootcert");
  return { url: url.href, ssl: { rejectUnauthorized: false } };
}
