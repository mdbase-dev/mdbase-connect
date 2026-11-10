import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { createDatabase } from "../../db.js";
import { tokenHash } from "../../security.js";

const resources: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (resources.length) await resources.pop()!();
});

async function fixture() {
  const db = await createDatabase("memory");
  resources.push(() => db.end());
  const { app } = await buildApp({ db, publicUrl: "https://connect.example" });
  resources.push(() => app.close());
  const userId = randomUUID();
  const connectorId = randomUUID();
  const token = "connector_token_012345678901234567890123";
  await db.query("INSERT INTO users (id, email, name) VALUES ($1, $2, $3)", [userId, "user@example.test", "User"]);
  await db.query("INSERT INTO connectors (id, user_id, name, token_hash) VALUES ($1, $2, $3, $4)", [connectorId, userId, "Computer", tokenHash(token)]);
  const collection = async (name: string) => {
    const id = randomUUID();
    const localId = randomUUID();
    await db.query(
      `INSERT INTO collections (id, user_id, connector_id, local_id, display_name, spec_version, enabled)
       VALUES ($1, $2, $3, $4, $5, '0.3.0', true)`,
      [id, userId, connectorId, localId, name]
    );
    return { id, localId };
  };
  const application = async (name: string, homepage: string) => {
    const id = randomUUID();
    await db.query(
      `INSERT INTO applications (id, canonical_identity, manifest_version, name, homepage, redirect_uris, icon)
       VALUES ($1, $2, 1, $3, $4, $5::jsonb, $6)`,
      [id, `bundle:${name}:sha256:test`, name, homepage, JSON.stringify([`${homepage}callback`]), `${homepage}icon.png`]
    );
    return id;
  };
  const grant = async (applicationId: string, collection: { id: string }, state: { activated?: boolean; revoked?: boolean } = {}) => {
    await db.query(
      `INSERT INTO grants (id, user_id, application_id, collection_id, operations, scope, application_origin,
                           application_authorization, application_installation_id, activated_at, revoked_at)
       VALUES ($1, $2, $3, $4, '["read"]'::jsonb, '{"contracts":[]}'::jsonb, '',
               '{"binding":{"protocol_version":4}}'::jsonb, $5, $6, $7)`,
      [randomUUID(), userId, applicationId, collection.id, randomUUID(),
        state.activated === false ? null : new Date(), state.revoked ? new Date() : null]
    );
  };
  const list = (bearer = token) => app.inject({
    method: "GET",
    url: "/v1/connectors/self/applications",
    headers: { authorization: `Bearer ${bearer}` }
  });
  return { db, userId, collection, application, grant, list };
}

describe("GET /v1/connectors/self/applications", () => {
  it("lists each approved app once with the collections it can use", async () => {
    const { collection, application, grant, list } = await fixture();
    const notes = await collection("Notes");
    const tasks = await collection("Tasks");
    const tasknotes = await application("TaskNotes", "https://app.tasknotes.example/");
    const editor = await application("Editor", "https://editor.example/");
    const revoked = await application("Revoked", "https://revoked.example/");
    const unfinished = await application("Unfinished", "https://unfinished.example/");
    await grant(tasknotes, tasks);
    await grant(tasknotes, notes);
    await grant(tasknotes, notes);
    await grant(editor, notes);
    await grant(revoked, notes, { revoked: true });
    await grant(unfinished, notes, { activated: false });

    const response = await list();

    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      applications: [
        {
          id: editor, name: "Editor", distribution: "web", homepage: "https://editor.example/",
          icon: "https://editor.example/icon.png", collections: [{ id: notes.localId, name: "Notes" }]
        },
        {
          id: tasknotes, name: "TaskNotes", distribution: "web", homepage: "https://app.tasknotes.example/",
          icon: "https://app.tasknotes.example/icon.png",
          collections: [{ id: notes.localId, name: "Notes" }, { id: tasks.localId, name: "Tasks" }]
        }
      ]
    });
  });

  it("refuses callers without a computer credential", async () => {
    const { list } = await fixture();
    expect((await list("connector_token_not_registered_0000000000")).statusCode).toBe(401);
  });

  it("lists apps installed for the account and refuses their own credentials", async () => {
    const { db, userId, list } = await fixture();
    const application = randomUUID(), collection = randomUUID(), connector = randomUUID(), device = randomUUID();
    const installationToken = "installation_token_0123456789012345678901";
    await db.query(`INSERT INTO applications(id,canonical_identity,family_identity,name,homepage,redirect_uris)
      VALUES($1,$2,'bundle:dev.example.reader','Reader','https://reader.example/','[]')`, [application, `fixture:${application}`]);
    await db.query(`INSERT INTO next_collections(collection_id,owner_user_id,runtime,sync,root_key_id,display_name)
      VALUES($1,$2,'next','cloud_copy',$3,'Library')`, [collection, userId, randomBytes(16)]);
    await db.query("INSERT INTO connectors(id,user_id,name,token_hash) VALUES($1,$2,'mdbase Reader',$3)", [connector, userId, tokenHash(installationToken)]);
    const sign = randomBytes(32), kem = randomBytes(32), noise = randomBytes(32);
    await db.query(`INSERT INTO next_devices(id,connector_id,user_id,kind,sign_pk,kem_pk,noise_pk)
      VALUES($1,$2,$3,'app-runtime',$4,$5,$6)`, [device, connector, userId, sign, kem, noise]);
    await db.query(`INSERT INTO installation_device_credentials(pairing_id,connector_id,device_id,installation_id,app_id,app_origin,kind,sign_pk,kem_pk,noise_pk,token_hash,create_collections)
      VALUES($1,$2,$3,$4,$5,'https://reader.example','app-runtime',$6,$7,$8,$9,false)`,
      [randomUUID(), connector, device, randomUUID(), application, sign, kem, noise, randomUUID()]);
    await db.query("INSERT INTO installation_collection_scopes(connector_id,collection_id) VALUES($1,$2)", [connector, collection]);

    expect((await list()).json().applications).toEqual([{
      id: "bundle:dev.example.reader", name: "Reader", distribution: "web", homepage: "https://reader.example/",
      icon: null, collections: [{ id: collection, name: "Library" }]
    }]);
    const refused = await list(installationToken);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe("computer_credential_required");
  });
});
