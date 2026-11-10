import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { AuthenticationPolicyStore } from "../auth/authentication-policy.js";
import type { RelayHub } from "../relay/relay.js";
import { registerAccountOverviewRoute } from "./me-routes.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

/** An account with `size` local collections, owned hosted collections and grants
 * of each revocation state, served by the account overview route. */
async function account(size: number) {
  const db = await createDatabase("memory");
  cleanup.push(() => db.end());
  const app = Fastify();
  cleanup.push(() => app.close());
  registerAccountOverviewRoute(app, {
    db, relay: {} as RelayHub, publicUrl: "https://connect.example", tailscaleAuth: true,
    authenticationPolicy: new AuthenticationPolicyStore(db, "open"), hostedCollections: true, hostedSharing: true
  });
  const user = randomUUID(), email = `${user}@example.test`, connector = randomUUID();
  await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Owner')", [user, email]);
  await db.query("INSERT INTO connectors(id,user_id,name,token_hash) VALUES($1,$2,'Desktop',$3)", [connector, user, randomUUID()]);
  const grants: Record<"active" | "revoking" | "revoked" | "reauthorize", string[]> = { active: [], revoking: [], revoked: [], reauthorize: [] };
  for (let index = 0; index < size; index++) {
    const collection = randomUUID();
    await db.query(`INSERT INTO collections(id,user_id,connector_id,local_id,display_name,spec_version)
      VALUES($1,$2,$3,$4,$5,'0.3.0')`, [collection, user, connector, randomUUID(), `Local ${index}`]);
    await db.query("INSERT INTO hosted_collections(id,user_id,display_name,template) VALUES($1,$2,$3,'mdbase')",
      [randomUUID(), user, `Hosted ${index}`]);
    for (const state of Object.keys(grants) as Array<keyof typeof grants>) {
      const grant = randomUUID();
      await db.query("INSERT INTO applications(id,canonical_identity,name,homepage,redirect_uris) VALUES($1,$1::text,'App','https://app.example','[]')", [grant]);
      await db.query(`INSERT INTO grants(id,user_id,application_id,collection_id,operations,scope,application_installation_id,application_authorization,activated_at)
        VALUES($1,$2,$1,$3,'["read"]','{"access":"full_collection","contracts":[]}','installation',
        '{"binding":{"protocol_version":4,"contracts":{"semantic_capabilities":1}}}',now())`, [grant, user, collection]);
      if (state !== "active") await db.query(`UPDATE grants SET revoked_at=now(),
        revocation_confirmed_at=CASE WHEN $2 = 'revoking' THEN NULL ELSE now() END,
        reauthorization_required_at=CASE WHEN $2 = 'reauthorize' THEN now() ELSE NULL END WHERE id=$1`, [grant, state]);
      grants[state].push(grant);
    }
  }
  const overview = async () => {
    const response = await app.inject({ url: "/v1/me?native_storage=omit", headers: { "tailscale-user-login": email } });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  };
  return { db, grants, overview };
}

function countQueries(db: DatabasePool) {
  const query = vi.spyOn(db, "query");
  const connect = vi.spyOn(db, "connect");
  return () => ({ queries: query.mock.calls.length, connections: connect.mock.calls.length });
}

describe("account overview query budget", () => {
  it("reads a fixed number of queries however many collections and grants the account has", async () => {
    const counts = [];
    for (const size of [1, 4]) {
      const fixture = await account(size);
      await fixture.overview();
      const counted = countQueries(fixture.db);
      const body = await fixture.overview();
      expect(body.collections).toHaveLength(size);
      expect(body.hosted_collections).toHaveLength(size);
      expect(body.collections.every((collection: { access?: { relationship: string }; authority?: { kind: string } }) =>
        collection.access?.relationship === "owner" && collection.authority?.kind === "local")).toBe(true);
      expect(body.hosted_collections.every((collection: { access: { relationship: string } }) =>
        collection.access.relationship === "owner")).toBe(true);
      counts.push(counted());
    }
    expect(counts[1]).toEqual(counts[0]);
    expect(counts[0]!.connections).toBe(0);
    expect(counts[0]!.queries).toBeLessThanOrEqual(16);
  });

  it("omits only grants whose revocation is complete and that ask for nothing", async () => {
    const fixture = await account(2);
    const listed = (await fixture.overview()).grants as Array<{ id: string; revocation_status: string }>;
    const ids = new Set(listed.map(grant => grant.id));
    for (const grant of [...fixture.grants.active, ...fixture.grants.revoking, ...fixture.grants.reauthorize]) expect(ids.has(grant)).toBe(true);
    for (const grant of fixture.grants.revoked) expect(ids.has(grant)).toBe(false);
    expect(listed).toHaveLength(6);
    expect(new Set(listed.map(grant => grant.revocation_status))).toEqual(new Set(["active", "revoking", "revoked"]));
  });
});
