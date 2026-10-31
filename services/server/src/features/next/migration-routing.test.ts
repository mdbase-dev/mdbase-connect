import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { DatabasePool, DatabaseQueryable } from "../../database-types.js";
import { MigrationRoutingRefused, PRODUCTION_MIGRATION_ROUTING_ENABLED, migrationDeployments, migrationRoute, migrationRoutingEnvironment, parseMigrationRouting } from "./migration-routing.js";
import { parseNextControlPlaneEnv } from "./policy-keys.js";
import { activatePendingServices } from "./service-activation.js";
import { hostedRouteTarget } from "./hosted-route-target.js";
import { registerNextHostedRoutes } from "./hosted-routes.js";
import { registerNextRouteRoutes } from "./route-routes.js";

const account = "11111111-1111-4111-8111-111111111111";
const foreign = "22222222-2222-4222-8222-222222222222";
const collection = "33333333-3333-4333-8333-333333333333";
const normal = { hosted: { url: "https://cp-lab.example", token: "h".repeat(40) }, escrow: { url: "https://escrow.example", token: "e".repeat(40) } };
const env = { MDBASE_CONNECT_ENVIRONMENT: "lab", PUBLIC_URL: "https://connect-lab.mdbase.dev", MDBASE_NEXT_CONTROL_PLANE: "1",
  MDBASE_NEXT_LAB_MIGRATION_ACCOUNT: account, MDBASE_NEXT_LAB_MIGRATION_HOSTED_URL: "https://mdbase-next-hosted-mig-lab.example.workers.dev",
  MDBASE_NEXT_LAB_MIGRATION_HOSTED_TOKEN: "m".repeat(40), MDBASE_NEXT_LAB_MIGRATION_INBOUND_TOKEN: "i".repeat(40) };
const routing = parseMigrationRouting(env)!;
function result(rows: object[]) { return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] }; }
// `legacy`: the collection is a legacy hosted_collections id (a migrated collection).
function database(owners: string[], legacy = true) {
  const query = vi.fn<DatabaseQueryable["query"]>().mockResolvedValue(result(owners.map(owner => ({ owner, legacy }))));
  return { query };
}

describe("exact LAB account routing", () => {
  it("admits DB-backed cohorts without a per-run account environment edit", () => {
    expect(parseMigrationRouting({ ...env, MDBASE_NEXT_LAB_MIGRATION_ACCOUNT: undefined })!.accounts.size).toBe(0);
  });
  it.each(["bootstrap", "discovery", "inbound"])("routes a fresh authoritative cohort member through %s, not CSV", async consumer => {
    const scoped = { ...routing, accounts: new Set<string>() };
    const db = database([]);
    db.query.mockImplementation(async sql => {
      if (sql.includes("next_migration_cohort_members")) return result([{ eligible: true }]);
      if (sql.includes("UNION SELECT")) return result([{ owner: foreign, legacy: true }]);
      if (sql.includes("parent.owner_user_id::text AS owner_account")) return result([{ owner_account: foreign,
        grant_id: "grant", authorization_grant: "grant", policy_required: true, policy_active: true, has_client_key: true,
        hosted_device: collection, hosted_noise_pk: Buffer.alloc(32, 1) }]);
      return result([]);
    });
    if (consumer === "bootstrap") expect(await migrationDeployments(db, normal, scoped, collection)).toEqual({ ...normal, hosted: scoped.hosted });
    if (consumer === "discovery") expect((await hostedRouteTarget(db, "opaque", collection, normal.hosted.url, scoped))!.target!.url).toContain(scoped.hosted.url.replace("https:", "wss:"));
    if (consumer === "inbound") {
      const app = Fastify();
      registerNextHostedRoutes(app, { db: db as unknown as DatabasePool, tokens: { hosted: "H".repeat(40) }, migrationRouting: scoped });
      try {
        const request = (token: string) => app.inject({ method: "GET", url: `/internal/v1/next/collections/${collection}/state`, headers: { authorization: `Bearer ${token}` } });
        expect((await request(scoped.inboundToken)).statusCode).toBe(200);
        expect((await request("H".repeat(40))).statusCode).toBe(403);
      } finally { await app.close(); }
    }
    expect(db.query.mock.calls.some(([, values]) => JSON.stringify(values) === JSON.stringify([foreign]))).toBe(true);
  });
  it.each(["bootstrap", "wake", "discovery", "inbound"])("keeps a routed owner's non-legacy collection on the CP deployments through %s", async consumer => {
    const db = database([]);
    db.query.mockImplementation(async sql => {
      if (sql.includes("UNION SELECT")) return result([{ owner: account, legacy: false }]);
      if (sql.includes("parent.owner_user_id::text AS owner_account")) return result([{ owner_account: account,
        grant_id: "grant", authorization_grant: "grant", policy_required: true, policy_active: true, has_client_key: true,
        hosted_device: collection, hosted_noise_pk: Buffer.alloc(32, 1) }]);
      if (sql.includes("next_service_devices")) return result([{ collection_id: collection, kind: "hosted", batch_id: "1" }]);
      return result([]);
    });
    if (consumer === "bootstrap") expect(await migrationDeployments(db, normal, routing, collection)).toBe(normal);
    if (consumer === "wake") {
      const seen: string[] = [];
      await activatePendingServices(db, normal, async url => { seen.push(String(url)); return Response.json({ activated: true }); }, undefined, undefined, routing);
      expect(seen).toEqual([`${normal.hosted.url}/internal/v1/collections/activate`]);
    }
    if (consumer === "discovery") expect((await hostedRouteTarget(db, "opaque", collection, normal.hosted.url, routing))!.target!.url).toContain(normal.hosted.url.replace("https:", "wss:"));
    if (consumer === "inbound") {
      const app = Fastify();
      registerNextHostedRoutes(app, { db: db as unknown as DatabasePool, tokens: { hosted: "H".repeat(40) }, migrationRouting: routing });
      try {
        const request = (token: string) => app.inject({ method: "GET", url: `/internal/v1/next/collections/${collection}/state`, headers: { authorization: `Bearer ${token}` } });
        expect((await request(routing.inboundToken)).statusCode).toBe(403);
        expect((await request("H".repeat(40))).statusCode).not.toBe(403);
      } finally { await app.close(); }
    }
  });
  it("is absent by default and requires the whole exact LAB configuration", () => {
    expect(parseMigrationRouting({})).toBeUndefined();
    expect(routing).toEqual({ environment: "lab", accounts: new Set([account]), hosted: { url: env.MDBASE_NEXT_LAB_MIGRATION_HOSTED_URL, token: env.MDBASE_NEXT_LAB_MIGRATION_HOSTED_TOKEN }, inboundToken: env.MDBASE_NEXT_LAB_MIGRATION_INBOUND_TOKEN });
    for (const name of Object.keys(env).filter(name => name.includes("LAB_MIGRATION") && name !== "MDBASE_NEXT_LAB_MIGRATION_ACCOUNT")) {
      expect(() => parseMigrationRouting({ ...env, [name]: "" })).toThrow();
    }
  });
  it.each([
    { MDBASE_CONNECT_ENVIRONMENT: "production" }, { PUBLIC_URL: "https://connect.mdbase.dev" }, { MDBASE_NEXT_CONTROL_PLANE: "0" },
    { MDBASE_NEXT_LAB_MIGRATION_ACCOUNT: "mig-rehearsal" }, { MDBASE_NEXT_LAB_MIGRATION_ACCOUNT: "00000000-0000-0000-0000-000000000000" },
    { MDBASE_NEXT_LAB_MIGRATION_HOSTED_URL: "https://mdbase-next-hosted-cp-lab.example.workers.dev" },
    { MDBASE_NEXT_LAB_MIGRATION_HOSTED_URL: `${env.MDBASE_NEXT_LAB_MIGRATION_HOSTED_URL}/prefix` },
    { MDBASE_NEXT_LAB_MIGRATION_HOSTED_URL: `${env.MDBASE_NEXT_LAB_MIGRATION_HOSTED_URL}?account=other` },
    { MDBASE_NEXT_LAB_MIGRATION_HOSTED_TOKEN: "short" }, { MDBASE_NEXT_LAB_MIGRATION_INBOUND_TOKEN: env.MDBASE_NEXT_LAB_MIGRATION_HOSTED_TOKEN },
  ])("refuses unsafe/partial configuration %j", bad => expect(() => parseMigrationRouting({ ...env, ...bad })).toThrow());
  it("routes an explicit multi-account rehearsal list through ownership, discovery and inbound guards", async () => {
    const multi = parseMigrationRouting({ ...env, MDBASE_NEXT_LAB_MIGRATION_ACCOUNT: `${account}, ${foreign}` })!;
    expect(multi.accounts).toEqual(new Set([account, foreign]));
    for (const owner of [account, foreign]) {
      expect(await migrationDeployments(database([owner]), normal, multi, collection)).toEqual({ ...normal, hosted: multi.hosted });
      expect(await migrationRoute(database([owner]), multi, collection)).toBe("migration");
      const db = database([owner]);
      db.query.mockResolvedValueOnce(result([{ owner_account: owner, grant_id: "grant", authorization_grant: "grant", policy_required: true,
        policy_active: true, has_client_key: true, hosted_device: collection, hosted_noise_pk: Buffer.alloc(32, 1) }]));
      expect((await hostedRouteTarget(db, "opaque", collection, undefined, multi))!.target!.url).toContain(multi.hosted.url.replace("https:", "wss:"));
      const inbound = database([owner]);
      inbound.query.mockImplementation(async sql => sql.includes("UNION SELECT") ? result([{ owner, legacy: true }]) : result([]));
      const app = Fastify();
      registerNextHostedRoutes(app, { db: inbound as unknown as DatabasePool, tokens: { hosted: "H".repeat(40), escrow: "E".repeat(40) }, migrationRouting: multi });
      try {
        expect((await app.inject({ method: "GET", url: `/internal/v1/next/collections/${collection}/state`,
          headers: { authorization: `Bearer ${multi.inboundToken}` } })).statusCode).toBe(200);
        expect((await app.inject({ method: "GET", url: `/internal/v1/next/collections/${collection}/state`,
          headers: { authorization: `Bearer ${"H".repeat(40)}` } })).statusCode).toBe(403);
      } finally { await app.close(); }
    }
    const outsider = "44444444-4444-4444-8444-444444444444";
    expect(await migrationDeployments(database([outsider]), normal, multi, collection)).toBe(normal);
    await expect(migrationRoute(database([account, foreign]), multi, collection)).rejects.toThrow("ambiguous_collection_owner");
  });
  it.each([`${account},`, `,${account}`, `${account},${account}`, `${account},[test]`, `${account},00000000-0000-0000-0000-000000000000`])(
    "refuses malformed or duplicate allowlist %s", value => expect(() => parseMigrationRouting({ ...env, MDBASE_NEXT_LAB_MIGRATION_ACCOUNT: value })).toThrow());
  it("bounds account count and configuration bytes without widening environment admission", () => {
    const ids = Array.from({ length: 129 }, (_, n) => `55555555-5555-4555-8555-${(n + 1).toString(16).padStart(12, "0")}`);
    const allowed = { ...env, MDBASE_NEXT_LAB_MIGRATION_ACCOUNT: ids.slice(0, 128).join(",") };
    expect(parseMigrationRouting(allowed)!.accounts.size).toBe(128);
    expect(() => parseMigrationRouting({ ...env, MDBASE_NEXT_LAB_MIGRATION_ACCOUNT: ids.join(",") })).toThrow();
    expect(() => parseMigrationRouting({ ...env, MDBASE_NEXT_LAB_MIGRATION_ACCOUNT: `${account},${" ".repeat(8193)}${foreign}` })).toThrow();
    for (const environment of ["production", "staging", "LAB"]) expect(() => parseMigrationRouting({ ...allowed, MDBASE_CONNECT_ENVIRONMENT: environment })).toThrow();
  });
  it("checks token separation and factories at CP startup", () => {
    const full = { ...env, MDBASE_NEXT_ROOT_PUBLIC_KEY: "00".repeat(32), MDBASE_NEXT_POLICY_SIGNING_KEY: "pem", MDBASE_NEXT_POLICY_KEY_CERT: "{}",
      MDBASE_NEXT_LOG_SERVICE_URL: "https://log.example", MDBASE_NEXT_LOG_TOKEN_SIGNING_KEY: "pem", MDBASE_NEXT_LOG_TRANSPORT_KEY: "pem",
      MDBASE_NEXT_CLOUD_COPY_BOOTSTRAP: "1", MDBASE_NEXT_HOSTED_CLIENT_URL: normal.hosted.url,
      MDBASE_NEXT_HOSTED_INTERNAL_TOKEN: "H".repeat(40), MDBASE_NEXT_ESCROW_INTERNAL_TOKEN: "E".repeat(40), MDBASE_NEXT_MIGRATION_INTERNAL_TOKEN: "M".repeat(40),
      MDBASE_NEXT_HOSTED_SERVICE_URL: normal.hosted.url, MDBASE_NEXT_HOSTED_SERVICE_TOKEN: normal.hosted.token,
      MDBASE_NEXT_ESCROW_SERVICE_URL: normal.escrow.url, MDBASE_NEXT_ESCROW_SERVICE_TOKEN: normal.escrow.token };
    expect(parseNextControlPlaneEnv(full)?.migrationRouting).toEqual(routing);
    const noGlobal = parseNextControlPlaneEnv({ ...full, MDBASE_NEXT_HOSTED_CLIENT_URL: undefined });
    expect(noGlobal?.migrationRouting).toEqual(routing);
    expect(noGlobal?.hostedClientUrl).toBeUndefined();
    expect(noGlobal?.cloudCopyBootstrap).toEqual(normal);
    expect(() => parseNextControlPlaneEnv({ ...full, MDBASE_NEXT_MIGRATION_INTERNAL_TOKEN: undefined })).toThrow();
    for (const name of ["MDBASE_NEXT_HOSTED_INTERNAL_TOKEN", "MDBASE_NEXT_ESCROW_INTERNAL_TOKEN", "MDBASE_NEXT_MIGRATION_INTERNAL_TOKEN", "MDBASE_NEXT_HOSTED_SERVICE_TOKEN", "MDBASE_NEXT_ESCROW_SERVICE_TOKEN"]) {
      expect(() => parseNextControlPlaneEnv({ ...full, MDBASE_NEXT_LAB_MIGRATION_INBOUND_TOKEN: full[name as keyof typeof full] })).toThrow();
    }
    expect(() => parseNextControlPlaneEnv({ ...full, MDBASE_NEXT_CLOUD_COPY_BOOTSTRAP: "0" })).toThrow();
  });
  it("routes only a routed owner's legacy hosted collection, by authoritative ownership", async () => {
    const db = database([account]);
    expect(await migrationDeployments(db, normal, routing, collection)).toEqual({ ...normal, hosted: routing.hosted });
    expect(db.query.mock.calls[0]![1]).toEqual([collection]);
    for (const table of ["next_collections", "hosted_collections", "collections", "collection_identities"]) expect(db.query.mock.calls[0]![0]).toContain(table);
    expect(await migrationDeployments(database([foreign]), normal, routing, collection)).toBe(normal);
    await expect(migrationRoute(database([account, foreign]), routing, collection)).rejects.toThrow("ambiguous_collection_owner");
    // A not-yet-registered collection (a new collection being created) has no owner
    // mapping and is never migration routed, whoever creates it.
    expect(await migrationDeployments(database([]), normal, routing, collection)).toBe(normal);
    expect(await migrationRoute(database([]), routing, collection)).toBe("default");
    // A routed owner's collection that is not a legacy hosted id (created after the
    // flip, or a CP-native cloud copy it already had) stays on the CP deployments.
    expect(await migrationDeployments(database([account], false), normal, routing, collection)).toBe(normal);
    expect(await migrationRoute(database([account], false), routing, collection)).toBe("default");
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
    const db = database([owner]);
    db.query.mockResolvedValueOnce(result([{ owner_account: owner, grant_id: "grant", authorization_grant: "grant", policy_required: true, policy_active: true, has_client_key: true,
      hosted_device: collection, hosted_noise_pk: Buffer.alloc(32, 1) }]));
    const target = await hostedRouteTarget(db, "opaque-token-hash", collection, normal.hosted.url, routing);
    expect(target!.target!.url).toBe(`${(owner === account ? routing.hosted.url : normal.hosted.url).replace("https:", "wss:")}/v1/hosted/app?collection=${collection}`);
    expect(db.query.mock.calls[0]![0]).toContain("parent.owner_user_id::text AS owner_account");
    expect(db.query.mock.calls[0]![0]).toContain("tok.token_hash = $1");
    db.query.mockResolvedValueOnce(result([]));
    expect(await hostedRouteTarget(db, "foreign-token-hash", collection, normal.hosted.url, routing)).toBeNull();
  });
  it.each([[account, undefined, 200], [foreign, undefined, 401], [foreign, normal.hosted.url, 200]] as const)("HTTP discovery preserves an absent/configured default for %s/%s", async (owner, globalUrl, status) => {
    const db = database([]);
    db.query.mockImplementation(async sql => sql.includes("parent.owner_user_id::text AS owner_account")
      ? result([{ owner_account: owner, grant_id: "grant", authorization_grant: "grant", policy_required: true, policy_active: true,
        has_client_key: true, hosted_device: collection, hosted_noise_pk: Buffer.alloc(32, 1) }])
      : sql.includes("UNION SELECT") ? result([{ owner, legacy: true }]) : result([]));
    const app = Fastify();
    const broker = { request: vi.fn() };
    registerNextRouteRoutes(app, { db, broker, publicUrl: "https://connect-lab.mdbase.dev", hostedClientUrl: globalUrl, migrationRouting: routing });
    try {
      const response = await app.inject({ method: "GET", url: `/v1/next/collections/${collection}/route`, headers: { authorization: "Bearer opaque" } });
      expect(response.statusCode).toBe(status);
      if (status === 200) {
        const origin = owner === account ? routing.hosted.url : normal.hosted.url;
        expect(response.json().targets[0].url).toBe(`${origin.replace("https:", "wss:")}/v1/hosted/app?collection=${collection}`);
      }
      expect(broker.request).not.toHaveBeenCalled();
    } finally { await app.close(); }
    db.query.mockResolvedValue(result([]));
    expect(await hostedRouteTarget(db, "foreign-token-hash", collection, globalUrl, routing)).toBeNull();
    const disabled = database([]);
    expect(await hostedRouteTarget(disabled, "opaque", collection, undefined)).toBeNull();
    expect(disabled.query).not.toHaveBeenCalled();
  });
  it.each([[account, "normal", 403], [foreign, "migration", 403], [account, "migration", 200], [foreign, "normal", 200]] as const)("inbound %s/%s is account scoped", async (owner, caller, status) => {
    const db = database([owner]);
    db.query.mockImplementation(async sql => sql.includes("UNION SELECT") ? result([{ owner, legacy: true }]) : result([]));
    const app = Fastify();
    // State reads never connect. A foreign scope must be refused before directory SQL.
    registerNextHostedRoutes(app, { db: db as unknown as DatabasePool, tokens: { hosted: "H".repeat(40), escrow: "E".repeat(40) }, migrationRouting: routing });
    try {
      const response = await app.inject({ method: "GET", url: `/internal/v1/next/collections/${collection}/state`, headers: { authorization: `Bearer ${caller === "migration" ? routing.inboundToken : "H".repeat(40)}` } });
      expect(response.statusCode).toBe(status);
      if (status === 403) expect(db.query).toHaveBeenCalledTimes(2);
      const spoof = await app.inject({ method: "POST", url: "/internal/v1/next/collections/states", headers: { authorization: `Bearer ${routing.inboundToken}` }, payload: { ids: [collection], account } });
      expect(spoof.statusCode).not.toBe(200);
    } finally { await app.close(); }
  });
});

describe("migration routing environment gate (deployment configuration only)", () => {
  const generic = (environment: string, publicUrl: string, worker: string) => ({ MDBASE_CONNECT_ENVIRONMENT: environment, PUBLIC_URL: publicUrl, MDBASE_NEXT_CONTROL_PLANE: "1",
    MDBASE_NEXT_MIGRATION_HOSTED_URL: `https://${worker}.example.workers.dev`, MDBASE_NEXT_MIGRATION_HOSTED_TOKEN: "m".repeat(40), MDBASE_NEXT_MIGRATION_INBOUND_TOKEN: "i".repeat(40) });
  const lab = generic("lab", "https://connect-lab.mdbase.dev", "mdbase-next-hosted-mig-lab");
  const staging = generic("staging", "https://connect-staging.mdbase.dev", "mdbase-next-hosted-mig-staging");
  const production = generic("production", "https://connect.mdbase.dev", "mdbase-next-hosted-mig-production");
  const refusal = (fn: () => unknown) => { try { fn(); } catch (error) { return error instanceof MigrationRoutingRefused ? error.code : "other"; } return "admitted"; };

  it.each([["lab", "lab"], ["staging", "staging"], ["production", "production"], ["local", "migration_routing_environment_refused"],
    [undefined, "migration_routing_environment_refused"], ["", "migration_routing_environment_refused"], ["LAB", "migration_routing_environment_refused"],
    ["Staging", "migration_routing_environment_refused"], ["staging ", "migration_routing_environment_refused"]] as const)("%j -> %s", (environment, expected) => {
    let verdict: string;
    try { verdict = migrationRoutingEnvironment(environment); } catch (error) { verdict = (error as MigrationRoutingRefused).code; }
    expect(verdict).toBe(expected);
  });
  it("admits LAB and staging with each deployment's own origin and Worker", () => {
    expect(parseMigrationRouting(lab)).toEqual({ environment: "lab", accounts: new Set(), hosted: { url: lab.MDBASE_NEXT_MIGRATION_HOSTED_URL, token: "m".repeat(40) }, inboundToken: "i".repeat(40) });
    expect(parseMigrationRouting(staging)).toEqual({ environment: "staging", accounts: new Set(), hosted: { url: staging.MDBASE_NEXT_MIGRATION_HOSTED_URL, token: "m".repeat(40) }, inboundToken: "i".repeat(40) });
    expect(parseMigrationRouting({ MDBASE_CONNECT_ENVIRONMENT: "staging" })).toBeUndefined();
    expect(parseMigrationRouting({ MDBASE_CONNECT_ENVIRONMENT: "production" })).toBeUndefined();
  });
  it("refuses production by name while the single switch is off, and local always", () => {
    expect(PRODUCTION_MIGRATION_ROUTING_ENABLED).toBe(true);
    const off = { productionEnabled: false };
    expect(refusal(() => parseMigrationRouting(production, off))).toBe("migration_routing_production_disabled");
    // A request or flag cannot enable it: only the deployment environment is read.
    expect(refusal(() => parseMigrationRouting({ ...production, MDBASE_NEXT_MIGRATION_PRODUCTION: "1" }, off))).toBe("migration_routing_production_disabled");
    for (const environment of ["local", "development", "test"]) {
      expect(refusal(() => parseMigrationRouting({ ...staging, MDBASE_CONNECT_ENVIRONMENT: environment }))).toBe("migration_routing_environment_refused");
      expect(refusal(() => parseMigrationRouting({ ...staging, MDBASE_CONNECT_ENVIRONMENT: environment }, { productionEnabled: true }))).toBe("migration_routing_environment_refused");
    }
  });
  it("the production switch, once enabled, admits only production's own origin and Worker", () => {
    expect(parseMigrationRouting(production, { productionEnabled: true })?.environment).toBe("production");
    expect(migrationRoutingEnvironment("production", true)).toBe("production");
    expect(refusal(() => parseMigrationRouting({ ...production, PUBLIC_URL: "https://connect-staging.mdbase.dev" }, { productionEnabled: true }))).toBe("invalid_migration_routing");
    expect(refusal(() => parseMigrationRouting({ ...production, MDBASE_NEXT_MIGRATION_HOSTED_URL: staging.MDBASE_NEXT_MIGRATION_HOSTED_URL }, { productionEnabled: true }))).toBe("invalid_migration_routing");
  });
  it.each([
    ["another deployment's origin", { PUBLIC_URL: "https://connect-lab.mdbase.dev" }],
    ["the LAB migration Worker", { MDBASE_NEXT_MIGRATION_HOSTED_URL: lab.MDBASE_NEXT_MIGRATION_HOSTED_URL }],
    ["the ordinary hosted Worker", { MDBASE_NEXT_MIGRATION_HOSTED_URL: "https://mdbase-next-hosted-cp-staging.example.workers.dev" }],
    ["a look-alike Worker", { MDBASE_NEXT_MIGRATION_HOSTED_URL: "https://mdbase-next-hosted-mig-staging.example.workers.dev.evil.example" }],
    ["a path", { MDBASE_NEXT_MIGRATION_HOSTED_URL: `${staging.MDBASE_NEXT_MIGRATION_HOSTED_URL}/x` }],
    ["a disabled control plane", { MDBASE_NEXT_CONTROL_PLANE: "0" }],
    ["a missing inbound token", { MDBASE_NEXT_MIGRATION_INBOUND_TOKEN: "" }],
    ["shared credentials", { MDBASE_NEXT_MIGRATION_INBOUND_TOKEN: "m".repeat(40) }],
    ["a short token", { MDBASE_NEXT_MIGRATION_HOSTED_TOKEN: "short" }],
    ["the LAB-only account list", { MDBASE_NEXT_LAB_MIGRATION_ACCOUNT: account }],
    ["the LAB compatibility names", { MDBASE_NEXT_LAB_MIGRATION_INBOUND_TOKEN: "j".repeat(40) }],
  ])("refuses staging with %s", (_name, bad) => expect(refusal(() => parseMigrationRouting({ ...staging, ...bad }))).toBe("invalid_migration_routing"));
  it("refuses mixing the LAB compatibility names with the current names", () => {
    expect(refusal(() => parseMigrationRouting({ ...env, MDBASE_NEXT_MIGRATION_HOSTED_URL: env.MDBASE_NEXT_LAB_MIGRATION_HOSTED_URL }))).toBe("invalid_migration_routing");
    expect(parseMigrationRouting({ ...lab, MDBASE_NEXT_LAB_MIGRATION_ACCOUNT: account })!.accounts).toEqual(new Set([account]));
  });
  it("staging control-plane startup carries the staging routing and keeps every credential distinct", () => {
    const full = { ...staging, MDBASE_NEXT_ROOT_PUBLIC_KEY: "00".repeat(32), MDBASE_NEXT_POLICY_SIGNING_KEY: "pem", MDBASE_NEXT_POLICY_KEY_CERT: "{}",
      MDBASE_NEXT_LOG_SERVICE_URL: "https://log.example", MDBASE_NEXT_LOG_TOKEN_SIGNING_KEY: "pem", MDBASE_NEXT_LOG_TRANSPORT_KEY: "pem", MDBASE_NEXT_CLOUD_COPY_BOOTSTRAP: "1",
      MDBASE_NEXT_HOSTED_INTERNAL_TOKEN: "H".repeat(40), MDBASE_NEXT_ESCROW_INTERNAL_TOKEN: "E".repeat(40), MDBASE_NEXT_MIGRATION_INTERNAL_TOKEN: "M".repeat(40),
      MDBASE_NEXT_HOSTED_SERVICE_URL: normal.hosted.url, MDBASE_NEXT_HOSTED_SERVICE_TOKEN: normal.hosted.token,
      MDBASE_NEXT_ESCROW_SERVICE_URL: normal.escrow.url, MDBASE_NEXT_ESCROW_SERVICE_TOKEN: normal.escrow.token };
    expect(parseNextControlPlaneEnv(full)?.migrationRouting?.environment).toBe("staging");
    expect(() => parseNextControlPlaneEnv({ ...full, MDBASE_NEXT_MIGRATION_INBOUND_TOKEN: "M".repeat(40) })).toThrow();
    expect(() => parseNextControlPlaneEnv({ ...full, MDBASE_NEXT_MIGRATION_INTERNAL_TOKEN: undefined })).toThrow();
    expect(parseNextControlPlaneEnv({ ...full, MDBASE_CONNECT_ENVIRONMENT: "production", PUBLIC_URL: "https://connect.mdbase.dev",
      MDBASE_NEXT_MIGRATION_HOSTED_URL: production.MDBASE_NEXT_MIGRATION_HOSTED_URL })?.migrationRouting?.environment).toBe("production");
    expect(() => parseNextControlPlaneEnv({ ...full, MDBASE_CONNECT_ENVIRONMENT: "production", PUBLIC_URL: "https://connect.mdbase.dev" })).toThrow();
  });
  it.each(["moving", "moved"] as const)("a hosting move decides first: %s", async move => {
    const grant = { owner_account: account, grant_id: "grant", authorization_grant: "grant", policy_required: true, policy_active: true,
      has_client_key: true, hosted_device: collection, hosted_noise_pk: Buffer.alloc(32, 1) };
    const db = database([]);
    db.query.mockImplementation(async sql => sql.includes("parent.owner_user_id::text AS owner_account") ? result([grant])
      : sql.includes("UNION SELECT") ? result([{ owner: account, legacy: true, move }]) : result([]));
    expect(await migrationRoute(db, routing, collection)).toBe(move === "moving" ? "moving" : "default");
    // Moving: no deployment for bootstrap or wakes, and no hosted app target, though the grant stands.
    expect(await migrationDeployments(db, normal, routing, collection)).toEqual(move === "moving" ? null : normal);
    const route = await hostedRouteTarget(db, "opaque", collection, normal.hosted.url, routing);
    expect(route!.grant).toEqual(grant);
    if (move === "moving") expect(route!.target).toBeNull();
    else expect(route!.target!.url).toContain(normal.hosted.url.replace("https:", "wss:"));
    // Inbound: moving refuses both Workers; moved admits only the CP's hosted deployment.
    const app = Fastify();
    registerNextHostedRoutes(app, { db: db as unknown as DatabasePool, tokens: { hosted: "H".repeat(40) }, migrationRouting: routing });
    try {
      const request = (token: string) => app.inject({ method: "GET", url: `/internal/v1/next/collections/${collection}/state`, headers: { authorization: `Bearer ${token}` } });
      expect((await request(routing.inboundToken)).statusCode).toBe(403);
      expect((await request("H".repeat(40))).statusCode).toBe(move === "moving" ? 403 : 200);
    } finally { await app.close(); }
    // Without migration routing a move row is never read.
    const disabled = database([]);
    expect(await migrationRoute(disabled, undefined, collection)).toBe("default");
    expect(disabled.query).not.toHaveBeenCalled();
  });
  it("a retired route has no deployments, while other routes are unchanged", async () => {
    const db = database([]);
    db.query.mockImplementation(async sql => sql.includes("UNION SELECT") ? result([{ owner: account, legacy: true }])
      : sql.includes("next_migration_routing_retirements") ? result([{ retired: true }]) : result([]));
    expect(await migrationRoute(db, routing, collection)).toBe("retired");
    expect(await migrationDeployments(db, normal, routing, collection)).toBeNull();
  });
});
