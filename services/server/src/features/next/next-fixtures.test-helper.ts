// A user, connector, local collection, application and activated-pending grant, all
// sharing one ID (as local-grant-revocation.test.ts's fixture). Kept in a helper so
// importing it doesn't re-register another file's tests.
import { randomUUID } from "node:crypto";
import type { DatabaseQueryable } from "../../database-types.js";

export async function localGrantFixture(db: DatabaseQueryable): Promise<string> {
  const id = randomUUID();
  await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Fixture')", [id, `${id}@example.test`]);
  await db.query("INSERT INTO connectors(id,user_id,name,token_hash,relay_generation) VALUES($1,$2,'Fixture connector',$3,1)", [id, id, id]);
  await db.query("INSERT INTO collections(id,user_id,connector_id,local_id,display_name,spec_version) VALUES($1,$2,$3,$4,'Fixture collection','0.3.0')", [id, id, id, id]);
  await db.query("INSERT INTO applications(id,canonical_identity,name,homepage,redirect_uris) VALUES($1,$2,'Fixture app','https://example.test','[]')", [id, id]);
  await db.query(`INSERT INTO grants(id,user_id,application_id,collection_id,operations,scope,application_installation_id,application_authorization)
    VALUES($1,$2,$3,$4,'["read"]','{"access":"full_collection","contracts":[]}','fixture-installation',
    '{"binding":{"protocol_version":4,"contracts":{"semantic_capabilities":1}}}')`, [id, id, id, id]);
  return id;
}
