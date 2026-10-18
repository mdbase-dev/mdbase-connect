// Invoked only by the ignored, disposable-loopback Rust integration test.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createDatabase } from "../../services/server/dist/db.js";
import { HostedProviderClient } from "../../services/server/dist/hosted-provider.js";
import { registerMigrationReplicaRoutes } from "../../services/server/dist/features/next/migration-replicas.js";

assert.equal(Number(process.versions.node.split(".")[0]), 24, "Node24 fixture runtime required");
assert.equal(process.env.MDBASE_APPROVE_DESTRUCTIVE_HOSTED_TESTS, "operation_dispatch_uuid_schema_v1");
const f = JSON.parse(process.env.MDBASE_ROLLBACK_OWNER_FIXTURE);
const url = new URL(f.database_url), providerUrl = new URL(f.provider_url);
assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
assert.equal(url.searchParams.size, 1);
assert.equal(url.hash, "");
// The registered adversarial suite names its disposable database `mdbase`.
// The ownership boundary is its explicit approval + loopback-only connection
// and Rust-created unique schema, not a heuristic substring in a DB name.
assert.match(url.searchParams.get("options"), /^-csearch_path=mdbase_operation_dispatch_[a-f0-9]{32}$/);
assert.equal(providerUrl.hostname, "127.0.0.1");
const require = createRequire(new URL("../../services/server/package.json", import.meta.url));
const app = require("fastify")();
const db = await createDatabase(url.toString());
const owner = randomUUID(), cohort = `test-${randomUUID().slice(0, 8)}`;
const token = "rollback-owner-cp-loopback-token-".repeat(2);
const originalFetch = globalThis.fetch, providerCalls = [];
try {
  assert.notEqual(owner, f.physical_owner);
  await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Test')", [owner, `${owner}@example.test`]);
  await db.query("INSERT INTO account_storage_accounts(user_id,provider_account_id) VALUES($1,$2)", [owner, f.physical_owner]);
  await db.query("INSERT INTO next_migration_cohorts(name,released_at,frozen_at) VALUES($1,now(),now())", [cohort]);
  await db.query("INSERT INTO next_migration_cohort_members(account_id,cohort,started_at) VALUES($1,$2,now())", [owner, cohort]);
  await db.query("INSERT INTO hosted_collections(id,user_id,display_name,template,authority_epoch) VALUES($1,$2,'Source','mdbase',$3)", [f.collection, owner, f.epoch]);
  await db.query("INSERT INTO next_collections(collection_id,owner_user_id,runtime,sync,root_key_id) VALUES($1,$2,'shadow','cloud_copy',$3)", [f.collection, owner, Buffer.alloc(16, 7)]);
  const started = (await db.query("SELECT (extract(epoch FROM started_at)*1000000)::bigint::text AS started_us FROM next_migration_cohort_members WHERE account_id=$1", [owner])).rows[0].started_us;
  const binding = { owner_account_id: owner, provider_migration_id: f.migration_id, authority_epoch: f.epoch,
    fixed_head: f.head, driver_id: randomUUID(), action_id: randomUUID(), replica_ids: [] };
  // Model the already recorded original v1 intent: do not replace its owner,
  // action, run, epoch or payload when selecting the new physical envelope.
  await db.query("INSERT INTO audit_events(id,user_id,event_type,subject_id,metadata) VALUES($1,$2,'next_migration.rollback_intent',$3,$4)",
    [randomUUID(), owner, f.collection, JSON.stringify({ migration_id: f.migration_id, binding })]);
  const intent = async () => (await db.query("SELECT id,metadata FROM audit_events WHERE event_type='next_migration.rollback_intent' AND subject_id=$1", [f.collection])).rows;
  const before = await intent();
  const providerPath = `${f.provider_url}/internal/v1/collections/${f.collection}/legacy-migration`;
  for (const route of ["rollback-v2", "rollback-receipt-v2"]) {
    const denied = await originalFetch(`${providerPath}/${route}`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider_account_id: f.physical_owner, binding }) });
    assert.equal(denied.status, 401, "v2 never bypasses internal producer authentication");
  }
  const old = await originalFetch(`${providerPath}/rollback`, { method: "POST", headers: { authorization: `Bearer ${f.provider_token}`, "content-type": "application/json" }, body: JSON.stringify(binding) });
  assert.equal(old.status, 409);
  assert.equal((await old.json()).error.code, "legacy_rollback_binding_conflict");
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith(f.provider_url)) providerCalls.push(String(input));
    return originalFetch(input, init);
  };
  registerMigrationReplicaRoutes(app, { db, token, provider: new HostedProviderClient({ url: f.provider_url, internalToken: f.provider_token }),
    log: { head: async () => ({ seq: f.head, chain: new Uint8Array(32) }) }, emitter: { drainCollection: async () => 0 } });
  const cp = await app.listen({ host: "127.0.0.1", port: 0 });
  const body = { owner_account: owner, started_us: started, migration_id: f.migration_id, fixed_head: f.head,
    driver_id: binding.driver_id, action_id: binding.action_id, replica_ids: [] };
  const call = async kind => {
    const response = await originalFetch(`${cp}/internal/v1/next/migration/collections/${f.collection}/${kind}`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const made = await call("rollback");
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.deepEqual(made.body.binding, binding);
  assert.deepEqual(await intent(), before);
  const physicalRecords = (await db.query("SELECT metadata FROM audit_events WHERE event_type='next_migration.rollback_provider_binding' AND subject_id=$1", [f.collection])).rows;
  assert.deepEqual(physicalRecords.map(r => r.metadata), [{ migration_id: f.migration_id, binding, provider_account_id: f.physical_owner }]);
  for (let i = 0; i < 2; i++) assert.deepEqual(await call("rollback-receipt"), made);
  // Mapping drift is not receipt authority and cannot move the original intent.
  await db.query("UPDATE account_storage_accounts SET provider_account_id=$2 WHERE user_id=$1", [owner, randomUUID()]);
  const calls = providerCalls.length;
  const changed = await call("rollback-receipt");
  assert.equal(changed.status, 409);
  assert.equal(changed.body.error.code, "migration_rollback_binding_conflict");
  assert.equal(providerCalls.length, calls, "an uncertain original effect cannot be retargeted");
  await db.query("UPDATE account_storage_accounts SET provider_account_id=$2 WHERE user_id=$1", [owner, f.physical_owner]);
  assert.deepEqual(await call("rollback-receipt"), made);
  assert.deepEqual(await intent(), before);
  assert.equal(providerCalls.filter(p => p.endsWith("/rollback-v2")).length, 1);
  assert.ok(providerCalls.every(p => /\/rollback(-receipt)?-v2$/.test(p)), "new CP never falls back to v1");
  console.log(JSON.stringify({ connect_owner: owner, non_identity: true, original_intent_unchanged: true,
    receipt_echo_unchanged: true, v1_original_binding_status: old.status, v2_provider_mutations: 1 }));
} finally {
  globalThis.fetch = originalFetch;
  await app.close();
  await db.end();
}
