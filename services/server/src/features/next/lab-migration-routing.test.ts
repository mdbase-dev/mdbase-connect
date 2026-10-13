import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { DatabasePool, DatabaseQueryable } from "../../database-types.js";
import { migrationCollection, migrationDeployments, parseLabMigrationRouting } from "./lab-migration-routing.js";
import { parseNextControlPlaneEnv } from "./policy-keys.js";
import { activatePendingServices } from "./service-activation.js";
import { hostedRouteTarget } from "./hosted-route-target.js";
import { registerNextHostedRoutes } from "./hosted-routes.js";

const account = "11111111-1111-4111-8111-111111111111";
const foreign = "22222222-2222-4222-8222-222222222222";
const collection = "33333333-3333-4333-8333-333333333333";
const normal = { hosted: { url: "https://cp-lab.example", token: "h".repeat(40) }, escrow: { url: "https://escrow.example", token: "e".repeat(40) } };
const env = { MDBASE_CONNECT_ENVIRONMENT: "lab", PUBLIC_URL: "https://connect-lab.mdbase.dev", MDBASE_NEXT_CONTROL_PLANE: "1",
  MDBASE_NEXT_LAB_MIGRATION_ACCOUNT: account, MDBASE_NEXT_LAB_MIGRATION_HOSTED_URL: "https://mdbase-next-hosted-mig-lab.example.workers.dev",
  MDBASE_NEXT_LAB_MIGRATION_HOSTED_TOKEN: "m".repeat(40), MDBASE_NEXT_LAB_MIGRATION_INBOUND_TOKEN: "i".repeat(40) };
const routing = parseLabMigrationRouting(env)!;
function result(rows: object[]) { return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] }; }
function database(owners: string[]) {
  const query = vi.fn<DatabaseQueryable["query"]>().mockResolvedValue(result(owners.map(owner => ({ owner }))));
  return { query };
}

describe("exact LAB account routing", () => {
  it("is absent by default and requires the whole exact LAB configuration", () => {
    expect(parseLabMigrationRouting({})).toBeUndefined();
    expect(routing).toEqual({ account, hosted: { url: env.MDBASE_NEXT_LAB_MIGRATION_HOSTED_URL, token: env.MDBASE_NEXT_LAB_MIGRATION_HOSTED_TOKEN }, inboundToken: env.MDBASE_NEXT_LAB_MIGRATION_INBOUND_TOKEN });
    for (const name of Object.keys(env).filter(name => name.includes("LAB_MIGRATION"))) {
      expect(() => parseLabMigrationRouting({ ...env, [name]: "" })).toThrow();
    }
  });
  it.each([
    { MDBASE_CONNECT_ENVIRONMENT: "production" }, { PUBLIC_URL: "https://connect.mdbase.dev" }, { MDBASE_NEXT_CONTROL_PLANE: "0" },
    { MDBASE_NEXT_LAB_MIGRATION_ACCOUNT: "mig-rehearsal" }, { MDBASE_NEXT_LAB_MIGRATION_ACCOUNT: "00000000-0000-0000-0000-000000000000" },
    { MDBASE_NEXT_LAB_MIGRATION_HOSTED_URL: "https://mdbase-next-hosted-cp-lab.example.workers.dev" },
    { MDBASE_NEXT_LAB_MIGRATION_HOSTED_URL: `${env.MDBASE_NEXT_LAB_MIGRATION_HOSTED_URL}/prefix` },
    { MDBASE_NEXT_LAB_MIGRATION_HOSTED_URL: `${env.MDBASE_NEXT_LAB_MIGRATION_HOSTED_URL}?account=other` },
    { MDBASE_NEXT_LAB_MIGRATION_HOSTED_TOKEN: "short" }, { MDBASE_NEXT_LAB_MIGRATION_INBOUND_TOKEN: env.MDBASE_NEXT_LAB_MIGRATION_HOSTED_TOKEN },
  ])("refuses unsafe/partial configuration %j", bad => expect(() => parseLabMigrationRouting({ ...env, ...bad })).toThrow());
  it("checks token separation and factories at CP startup", () => {
    const full = { ...env, MDBASE_NEXT_ROOT_PUBLIC_KEY: "00".repeat(32), MDBASE_NEXT_POLICY_SIGNING_KEY: "pem", MDBASE_NEXT_POLICY_KEY_CERT: "{}",
      MDBASE_NEXT_LOG_SERVICE_URL: "https://log.example", MDBASE_NEXT_LOG_TOKEN_SIGNING_KEY: "pem", MDBASE_NEXT_LOG_TRANSPORT_KEY: "pem",
      MDBASE_NEXT_CLOUD_COPY_BOOTSTRAP: "1", MDBASE_NEXT_HOSTED_CLIENT_URL: normal.hosted.url,
      MDBASE_NEXT_HOSTED_INTERNAL_TOKEN: "H".repeat(40), MDBASE_NEXT_ESCROW_INTERNAL_TOKEN: "E".repeat(40), MDBASE_NEXT_MIGRATION_INTERNAL_TOKEN: "M".repeat(40),
      MDBASE_NEXT_HOSTED_SERVICE_URL: normal.hosted.url, MDBASE_NEXT_HOSTED_SERVICE_TOKEN: normal.hosted.token,
      MDBASE_NEXT_ESCROW_SERVICE_URL: normal.escrow.url, MDBASE_NEXT_ESCROW_SERVICE_TOKEN: normal.escrow.token };
    expect(parseNextControlPlaneEnv(full)?.labMigrationRouting).toEqual(routing);
    for (const name of ["MDBASE_NEXT_HOSTED_INTERNAL_TOKEN", "MDBASE_NEXT_ESCROW_INTERNAL_TOKEN", "MDBASE_NEXT_MIGRATION_INTERNAL_TOKEN", "MDBASE_NEXT_HOSTED_SERVICE_TOKEN", "MDBASE_NEXT_ESCROW_SERVICE_TOKEN"]) {
      expect(() => parseNextControlPlaneEnv({ ...full, MDBASE_NEXT_LAB_MIGRATION_INBOUND_TOKEN: full[name as keyof typeof full] })).toThrow();
    }
    expect(() => parseNextControlPlaneEnv({ ...full, MDBASE_NEXT_CLOUD_COPY_BOOTSTRAP: "0" })).toThrow();
  });
  it("uses authoritative collection ownership, not a creator spoof or missing mapping", async () => {
    const db = database([account]);
    expect(await migrationDeployments(db, normal, routing, collection)).toEqual({ ...normal, hosted: routing.hosted });
    expect(db.query.mock.calls[0]![1]).toEqual([collection]);
    for (const table of ["next_collections", "hosted_collections", "collections", "collection_identities"]) expect(db.query.mock.calls[0]![0]).toContain(table);
    expect(await migrationDeployments(database([foreign]), normal, routing, collection)).toBe(normal);
    expect(await migrationDeployments(database([]), normal, routing, collection)).toBe(normal);
    await expect(migrationCollection(database([foreign]), routing, collection, account)).rejects.toThrow("foreign_collection_owner");
    await expect(migrationCollection(database([account, foreign]), routing, collection)).rejects.toThrow("ambiguous_collection_owner");
    expect(await migrationCollection(database([]), routing, collection, foreign)).toBe(false);
    expect(await migrationCollection(database([]), routing, collection, account)).toBe(true);
    const disabled = database([]);
    expect(await migrationDeployments(disabled, normal, undefined, collection)).toBe(normal);
    expect(disabled.query).not.toHaveBeenCalled();
  });
  it.each([account, foreign])("policy wake selects only the owned hosted destination for %s", async owner => {
    const db = database([owner]);
    db.query.mockResolvedValueOnce(result([{ collection_id: collection, kind: "hosted", batch_id: "1" }, { collection_id: collection, kind: "escrow", batch_id: "1" }]));
    const seen: Request[] = [];
    await activatePendingServices(db, normal, async (url, init) => { seen.push(new Request(url, init)); return Response.json({ activated: true }); }, undefined, undefined, routing);
    expect(seen.map(r => r.url)).toEqual([`${owner === account ? routing.hosted.url : normal.hosted.url}/internal/v1/collections/activate`, `${normal.escrow.url}/internal/v1/collections/activate`]);
    expect(seen[0]!.headers.get("authorization")).toBe(`Bearer ${owner === account ? routing.hosted.token : normal.hosted.token}`);
  });
  it.each([account, foreign])("discovery derives account from the authenticated grant/parent SQL for %s", async owner => {
    const db = database([]);
    db.query.mockResolvedValueOnce(result([{ owner_account: owner, grant_id: "grant", authorization_grant: "grant", policy_required: true, policy_active: true, has_client_key: true,
      hosted_device: collection, hosted_noise_pk: Buffer.alloc(32, 1) }]));
    const target = await hostedRouteTarget(db, "opaque-token-hash", collection, normal.hosted.url, routing);
    expect(target!.target!.url).toBe(`${(owner === account ? routing.hosted.url : normal.hosted.url).replace("https:", "wss:")}/v1/hosted/app?collection=${collection}`);
    expect(db.query.mock.calls[0]![0]).toContain("parent.owner_user_id::text AS owner_account");
    expect(db.query.mock.calls[0]![0]).toContain("tok.token_hash = $1");
    db.query.mockResolvedValueOnce(result([]));
    expect(await hostedRouteTarget(db, "foreign-token-hash", collection, normal.hosted.url, routing)).toBeNull();
  });
  it.each([[account, "normal", 403], [foreign, "migration", 403], [account, "migration", 200], [foreign, "normal", 200]] as const)("inbound %s/%s is account scoped", async (owner, caller, status) => {
    const db = database([owner]);
    db.query.mockImplementation(async sql => sql.includes("UNION SELECT") ? result([{ owner }]) : result([]));
    const app = Fastify();
    // State reads never connect. A foreign scope must be refused before directory SQL.
    registerNextHostedRoutes(app, { db: db as unknown as DatabasePool, tokens: { hosted: "H".repeat(40), escrow: "E".repeat(40) }, labMigrationRouting: routing });
    try {
      const response = await app.inject({ method: "GET", url: `/internal/v1/next/collections/${collection}/state`, headers: { authorization: `Bearer ${caller === "migration" ? routing.inboundToken : "H".repeat(40)}` } });
      expect(response.statusCode).toBe(status);
      if (status === 403) expect(db.query).toHaveBeenCalledTimes(1);
      const spoof = await app.inject({ method: "POST", url: "/internal/v1/next/collections/states", headers: { authorization: `Bearer ${routing.inboundToken}` }, payload: { ids: [collection], account } });
      expect(spoof.statusCode).not.toBe(200);
    } finally { await app.close(); }
  });
});
