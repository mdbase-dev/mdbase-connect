/** Fixed isolated LAB routing only. This configuration is not serving authority. */
import type { DatabaseQueryable } from "../../database-types.js";
export interface LabPitrConfig {
  run: "gate4-pitr-lab-20261009-01";
  active: string;
  deleted: string;
  owner: string;
  /** Immutable admission time; older shared LAB rows cannot be relabelled into the run. */
  createdAfter: number;
  logUrl: string;
  hostedUrl: string;
}
const RUN = "gate4-pitr-lab-20261009-01";
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const NIL = "00000000-0000-0000-0000-000000000000";
function refuse(): never { throw new Error("invalid_lab_pitr_configuration"); }
function origin(value: unknown, worker: string): string {
  if (typeof value !== "string" || value.length > 256) return refuse();
  let url: URL;
  try { url = new URL(value); } catch { return refuse(); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash
      || url.pathname !== "/" || url.origin !== value
      || !new RegExp(`^${worker}\\.[a-z0-9-]+\\.workers\\.dev$`).test(url.hostname)) return refuse();
  return value;
}
export function parseLabPitrConfig(env: NodeJS.ProcessEnv): LabPitrConfig | undefined {
  const text = env.MDBASE_NEXT_LAB_PITR;
  if (text === undefined || text === "") return undefined;
  if (env.MDBASE_CONNECT_ENVIRONMENT !== "lab" || env.PUBLIC_URL !== "https://connect-lab.mdbase.dev"
      || Buffer.byteLength(text, "utf8") > 2048) return refuse();
  let v: unknown;
  try { v = JSON.parse(text); } catch { return refuse(); }
  if (!v || typeof v !== "object" || Array.isArray(v)) return refuse();
  const x = v as Record<string, unknown>;
  const keys = ["run", "active", "deleted", "owner", "createdAfter", "logUrl", "hostedUrl"];
  if (Object.keys(x).length !== keys.length || !keys.every(k => Object.hasOwn(x, k)) || x.run !== RUN) return refuse();
  for (const key of ["active", "deleted", "owner"]) {
    if (typeof x[key] !== "string" || x[key] === NIL || !UUID.test(x[key])) return refuse();
  }
  if (x.active === x.deleted || typeof x.createdAfter !== "number" || !Number.isSafeInteger(x.createdAfter) || x.createdAfter < 1) return refuse();
  const logUrl = origin(x.logUrl, "mdbase-next-log-pitr-lab-20261009-01");
  const hostedUrl = origin(x.hostedUrl, "mdbase-next-hosted-pitr-lab-20261009-01");
  if (new URL(logUrl).hostname.split(".")[1] !== new URL(hostedUrl).hostname.split(".")[1]) return refuse();
  return Object.freeze({ run: RUN, active: x.active as string, deleted: x.deleted as string,
    owner: x.owner as string, createdAfter: x.createdAfter, logUrl, hostedUrl });
}
export const pitrLabel = (pitr: LabPitrConfig, collection: string): string => `[test] ${pitr.run} ${collection === pitr.active ? "ACTIVE" : "DELETED"}`;
/** Startup guard before constructing mapped log clients/emission. Empty original UUIDs
 * may be seeded; an existing row must already be the newly-created run fixture. */
export async function validatePitrCollections(db: DatabaseQueryable, pitr: LabPitrConfig | undefined): Promise<void> {
  if (!pitr) return;
  const bad = await db.query(`SELECT 1 FROM next_collections WHERE collection_id=ANY($1::uuid[])
    AND (owner_user_id<>$2::uuid OR created_at<to_timestamp($3::double precision/1000)
      OR (collection_id=$4::uuid AND display_name<>$5) OR (collection_id=$6::uuid AND display_name<>$7)) LIMIT 1`,
    [[pitr.active,pitr.deleted],pitr.owner,pitr.createdAfter,pitr.active,pitrLabel(pitr,pitr.active),pitr.deleted,pitrLabel(pitr,pitr.deleted)]);
  if (bad.rows.length) return refuse();
}
export function pitrCollection(pitr: LabPitrConfig | undefined, collection: string): boolean {
  const id = collection.toLowerCase();
  return pitr !== undefined && (id === pitr.active || id === pitr.deleted);
}
export function pitrLogUrl(normal: string, pitr: LabPitrConfig | undefined, collection: string): string {
  return pitrCollection(pitr, collection) ? pitr!.logUrl : normal;
}
/** Existing real factories/tokens, narrowed to the two configured collection UUIDs.
 * Escrow generation is stateless at the isolated Worker; escrow activation is excluded.
 */
type Deployments = { hosted: { url: string; token: string }; escrow: { url: string; token: string } };
export function pitrDeployments(normal: Deployments, pitr: LabPitrConfig | undefined, collection: string): Deployments {
  if (!pitrCollection(pitr, collection)) return normal;
  return { ...normal, hosted: { ...normal.hosted, url: pitr!.hostedUrl },
    escrow: { ...normal.escrow, url: `${pitr!.hostedUrl}/pitr-escrow` } };
}
