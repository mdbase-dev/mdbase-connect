// Exact operator-owned LAB account override. No labels, request fields or defaults.
import type { DatabaseQueryable } from "../../database-types.js";

export interface LabMigrationRouting {
  account: string;
  hosted: { url: string; token: string };
  inboundToken: string;
}
const ERROR = "invalid_lab_migration_routing";
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u;
const NAMES = ["MDBASE_NEXT_LAB_MIGRATION_ACCOUNT", "MDBASE_NEXT_LAB_MIGRATION_HOSTED_URL", "MDBASE_NEXT_LAB_MIGRATION_HOSTED_TOKEN", "MDBASE_NEXT_LAB_MIGRATION_INBOUND_TOKEN"] as const;
export function parseLabMigrationRouting(env: NodeJS.ProcessEnv): LabMigrationRouting | undefined {
  const values = NAMES.map(name => env[name]?.trim() ?? "");
  if (!values.some(Boolean)) return undefined;
  const [account, url, token, inboundToken] = values;
  if (env.MDBASE_CONNECT_ENVIRONMENT !== "lab" || env.PUBLIC_URL !== "https://connect-lab.mdbase.dev"
      || env.MDBASE_NEXT_CONTROL_PLANE !== "1" || !account || !UUID.test(account)
      || account === "00000000-0000-0000-0000-000000000000" || !url || !token || !inboundToken
      || token.length < 32 || inboundToken.length < 32 || token === inboundToken) throw new Error(ERROR);
  let origin: URL;
  try { origin = new URL(url); } catch { throw new Error(ERROR); }
  if (origin.origin !== url || origin.protocol !== "https:" || origin.username || origin.password || origin.port
      || origin.pathname !== "/" || origin.search || origin.hash
      || !/^mdbase-next-hosted-mig-lab\.[a-z0-9-]+\.workers\.dev$/u.test(origin.hostname)) throw new Error(ERROR);
  return { account, hosted: { url, token }, inboundToken };
}

/** All retained authoritative ownership mappings must agree. Missing/ambiguous is
 * never a migration match. A pre-registration creator is an authenticated identity,
 * checked by the caller before/after the network call, not an HTTP account field. */
export async function migrationCollection(db: DatabaseQueryable, routing: LabMigrationRouting | undefined, collection: string, authenticatedCreator?: string): Promise<boolean> {
  if (!routing) return false;
  const result = await db.query<{ owner: string }>(
    `SELECT owner_user_id::text AS owner FROM next_collections WHERE collection_id=$1
     UNION SELECT user_id::text FROM hosted_collections WHERE id=$1
     UNION SELECT user_id::text FROM collections WHERE local_id=$1
     UNION SELECT owner_user_id::text FROM collection_identities WHERE id=$1`, [collection]);
  if (result.rows.length > 1) throw new Error("ambiguous_collection_owner");
  const owner = result.rows[0]?.owner ?? authenticatedCreator;
  if (authenticatedCreator && owner && owner !== authenticatedCreator) throw new Error("foreign_collection_owner");
  return owner === routing.account;
}

type Deployments = { hosted: { url: string; token: string }; escrow: { url: string; token: string } };
export async function migrationDeployments(db: DatabaseQueryable, normal: Deployments, routing: LabMigrationRouting | undefined, collection: string, authenticatedCreator?: string): Promise<Deployments> {
  return await migrationCollection(db, routing, collection, authenticatedCreator) ? { ...normal, hosted: routing!.hosted } : normal;
}
