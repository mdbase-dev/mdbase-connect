import { randomBytes, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { createDatabase } from "../../db.js";

it("lists real installation consent as app access and preserves unknown/legacy computer rows", async () => {
  const db = await createDatabase("memory");
  const { app } = await buildApp({ db, devAuth: true, publicUrl: "http://connect.test" });
  try {
    const email = `${randomUUID()}@example.test`;
    const signedIn = await app.inject({ method: "POST", url: "/v1/dev/session", payload: { name: "Owner", email } });
    const raw = signedIn.headers["set-cookie"]!;
    const cookie = (Array.isArray(raw) ? raw[0] : raw).split(";")[0];
    const owner = (await db.query("SELECT id FROM users WHERE email=$1", [email])).rows[0].id;
    const other = randomUUID(), application = randomUUID(), collection = randomUUID(), hidden = randomUUID();
    await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Other')", [other, `${other}@example.test`]);
    await db.query(`INSERT INTO applications(id,canonical_identity,family_identity,name,homepage,redirect_uris)
      VALUES($1,$2,'bundle:dev.example.reader','Reader','https://reader.example','[]')`, [application, `fixture:${application}`]);
    for (const [id, account, name] of [[collection, owner, "Own collection"], [hidden, other, "Hidden collection name"]]) {
      await db.query(`INSERT INTO next_collections(collection_id,owner_user_id,runtime,sync,root_key_id,display_name)
        VALUES($1,$2,'next','cloud_copy',$3,$4)`, [id, account, randomBytes(16), name]);
    }
    const secretHashes: string[] = [];
    async function connector(account = owner, kind?: "app-runtime" | "mobile", appId = application, registered = true) {
      const id = randomUUID(), device = randomUUID(), installation = randomUUID(), secretHash = randomUUID();
      secretHashes.push(secretHash);
      await db.query("INSERT INTO connectors(id,user_id,name,token_hash) VALUES($1,$2,'mdbase Reader',$3)", [id, account, randomUUID()]);
      if (kind) {
        const sign = randomBytes(32), kem = randomBytes(32), noise = randomBytes(32);
        await db.query(`INSERT INTO next_devices(id,connector_id,user_id,kind,sign_pk,kem_pk,noise_pk)
          VALUES($1,$2,$3,$4,$5,$6,$7)`, [device, id, account, kind, sign, kem, noise]);
        if (registered) await db.query(`INSERT INTO installation_device_credentials(pairing_id,connector_id,device_id,installation_id,app_id,app_origin,kind,sign_pk,kem_pk,noise_pk,token_hash,create_collections)
          VALUES($1,$2,$3,$4,$5,'https://reader.example',$6,$7,$8,$9,$10,true)`, [randomUUID(), id, device, installation, appId, kind, sign, kem, noise, secretHash]);
      }
      return { id, installation };
    }
    const legacy = await connector();
    const mobile = await connector(owner, "mobile", application, false);
    const mobileApp = await connector(owner, "mobile");
    const unknown = await connector(owner, "app-runtime", "unregistered");
    const scoped = await connector(owner, "app-runtime");
    const empty = await connector(owner, "app-runtime");
    const foreign = await connector(other, "app-runtime");
    await db.query("INSERT INTO installation_collection_scopes(connector_id,collection_id,file_actions) VALUES($1,$2,'{add}')", [scoped.id, collection]);
    await db.query("INSERT INTO installation_collection_scopes(connector_id,collection_id) VALUES($1,$2),($3,$2)", [scoped.id, hidden, foreign.id]);
    expect((await app.inject({ url: "/v1/me" })).statusCode).toBe(401);
    const response = await app.inject({ url: "/v1/me", headers: { cookie } });
    expect(response.statusCode, response.body).toBe(200);
    const overview = response.json();
    expect(overview.connectors.map((row: { id: string }) => row.id).sort()).toEqual([legacy.id, mobile.id, unknown.id].sort());
    expect(overview.installation_access).toHaveLength(4);
    expect(overview.installation_access).toContainEqual(expect.objectContaining({ connector_id: mobileApp.id, device_kind: "mobile", collection_id: null }));
    expect(overview.installation_access).toContainEqual(expect.objectContaining({ connector_id: scoped.id, installation_id: scoped.installation, application_name: "Reader", collection_id: collection, collection_name: "Own collection", role: "owner", available: true, approved_optional_file_actions: ["add"] }));
    expect(overview.installation_access).toContainEqual(expect.objectContaining({ connector_id: empty.id, create_collections: true, collection_id: null, available: false, approved_optional_file_actions: [] }));
    expect(overview.installation_access).toContainEqual(expect.objectContaining({ collection_id: hidden, collection_name: "Unavailable collection", available: false, role: null }));
    expect(overview.grants).toEqual([]);
    expect(response.body).not.toContain("Hidden collection name");
    for (const hash of secretHashes) expect(response.body).not.toContain(hash);
    expect(response.body).not.toContain("sign_pk");
    expect(response.body).not.toContain("token_hash");
    expect((await db.query("SELECT id FROM next_policy_outbox")).rows).toEqual([]);
    const globalPath = `/v1/account/installations/${empty.id}`;
    expect((await app.inject({ method: "DELETE", url: globalPath })).statusCode).toBe(401);
    // Canonical sign-out uses PostgreSQL row locks (FOR UPDATE OF k), which
    // pg-mem cannot parse; positive lifecycle assertions live in the real-PG suite.
  } finally { await app.close(); await db.end(); }
});
