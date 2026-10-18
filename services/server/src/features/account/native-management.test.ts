import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { createDatabase } from "../../db.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

it("offers Native creation only for the account's own linked desktop or CLI, never an app runtime", async () => {
  const db = await createDatabase("memory"); cleanup.push(() => db.end());
  const { app } = await buildApp({ db, devAuth: true, publicUrl: "http://connect.test" }); cleanup.push(() => app.close());
  const email = `${randomUUID()}@example.test`;
  const response = await app.inject({ method: "POST", url: "/v1/dev/session", payload: { name: "Native owner", email } });
  const raw = response.headers["set-cookie"]!;
  const cookie = (Array.isArray(raw) ? raw[0]! : raw).split(";")[0]!;
  const owner = (await db.query<{id:string}>("SELECT id FROM users WHERE email=$1",[email])).rows[0]!.id;
  const other = randomUUID();
  await db.query("INSERT INTO users(id,email,name) VALUES($1,'other-creator@example.test','Other')",[other]);
  const linked = async (account: string, kind: string) => {
    const connector = randomUUID();
    await db.query("INSERT INTO connectors(id,user_id,name,token_hash) VALUES($1,$2,'Registered device',$3)",[connector,account,randomUUID()]);
    await db.query("INSERT INTO next_devices(id,connector_id,user_id,kind,sign_pk,kem_pk,noise_pk) VALUES($1,$2,$3,$4,$5,$5,$5)",[randomUUID(),connector,account,kind,Buffer.alloc(32,1)]);
    return connector;
  };
  await linked(other,"desktop"); await linked(owner,"app-runtime");
  const available = async () => (await app.inject({ url: "/v1/me", headers: { cookie } })).json().native_collection_creation_available;
  expect(await available()).toBe(false);
  const desktop = await linked(owner,"desktop");
  expect(await available()).toBe(true);
  await db.query("UPDATE connectors SET revoked_at=now() WHERE id=$1",[desktop]);
  expect(await available()).toBe(false);
  await linked(owner,"cli");
  expect(await available()).toBe(true);
  expect((await db.query("SELECT id FROM hosted_collections")).rows).toEqual([]);
  expect((await db.query("SELECT id FROM next_policy_outbox")).rows).toEqual([]);
});
