import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { HostedProviderClient } from "../../hosted-provider.js";
import { buildApp } from "../../app.js";
import { createDatabase } from "../../db.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

it("discovers registry-only native metadata through the authenticated management route", async () => {
  const db = await createDatabase("memory");
  cleanup.push(() => db.end());
  const provider = { url: "https://provider.example", ready: vi.fn() } as unknown as HostedProviderClient;
  const { app } = await buildApp({ db, devAuth: true, hostedCollections: true, hostedSharing: true, hostedProvider: provider, publicUrl: "http://connect.test" });
  cleanup.push(() => app.close());
  const email = `${randomUUID()}@example.test`;
  const signedIn = await app.inject({ method: "POST", url: "/v1/dev/session", payload: { name: "Native owner", email } });
  expect(signedIn.statusCode, signedIn.body).toBe(200);
  const raw = signedIn.headers["set-cookie"]!;
  const cookie = (Array.isArray(raw) ? raw[0]! : raw).split(";")[0]!;
  const owner = (await db.query<{id:string}>("SELECT id FROM users WHERE email=$1", [email])).rows[0]!.id;
  const collection = randomUUID();
  await db.query("INSERT INTO next_collections(collection_id,owner_user_id,runtime,sync,root_key_id,display_name) VALUES($1,$2,'next','private',$3,'Native garden')", [collection, owner, Buffer.alloc(16)]);
  expect((await app.inject({ url: "/v1/me" })).statusCode).toBe(401);
  const response = await app.inject({ url: "/v1/me", headers: { cookie } });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().native_collections).toEqual([{ id: collection, display_name: "Native garden", sync: "private", access: { relationship: "owner", role: "owner", can_manage_members: true } }]);
  expect(response.json().collections).toEqual([]);
  expect(response.json().hosted_collections).toEqual([]);
  expect(response.json().grants).toEqual([]);
  expect((await db.query("SELECT id FROM hosted_collections")).rows).toEqual([]);
  expect((await db.query("SELECT id FROM next_policy_outbox")).rows).toEqual([]);
});
