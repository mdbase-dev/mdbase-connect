import { test } from "node:test";
import assert from "node:assert/strict";
import { decode } from "../../../packages/sdk/src/cbor.ts";
import { migrationRollbackInput, decodeRollbackScope, MAX_ROLLBACK_INPUT } from "../src/migration-rollback-input.ts";
import { migrationOperatorRequest, migrationOperatorBody } from "../src/migration-operator.ts";

const id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12,"0")}`;
const token = "operator-service-token-for-fixtures-only";
const receipt = () => ({ collection_id: id(1), binding: { owner_account_id: id(2), provider_migration_id: id(3), authority_epoch: 17,
  fixed_head: 0, driver_id: id(4), action_id: id(5), replica_ids: [id(6), id(7)] }, restored_ids: [id(6)], recorded_at: "2026-10-12T22:00:00Z" });
const bytes = n => Uint8Array.from(id(n).replaceAll("-", "").match(/../g), h => Number.parseInt(h,16));

test("full original scope canonical encoding, not bare provider success", () => {
  const body = receipt(), value = decode(migrationRollbackInput(body));
  assert.equal(value.length, 10); assert.equal(value[3],17); assert.equal(value[4],0);
  assert.equal(value[7].length,2); assert.equal(value[8].length,1); assert.equal(value[9],body.recorded_at);
  for (const bad of [{ state:"active" }, { restored:[id(6)] }, { ok:true }, { ...body, extra: true }, { ...body, restored_ids:[id(8)] }]) {
    assert.throws(() => migrationRollbackInput(bad), /migration_rollback_input_invalid/);
  }
  for (const patch of [{ authority_epoch:0 }, { authority_epoch:Number.MAX_SAFE_INTEGER+1 }, { replica_ids:[id(6),id(6)] }, { driver_id:"00000000-0000-0000-0000-000000000000" }, { action_id:"not-a-uuid" }]) {
    assert.throws(() => migrationRollbackInput({ ...body, binding:{ ...body.binding, ...patch } }), /migration_rollback_input_invalid/);
  }
});

test("1000 requested and restored IDs fit the explicitly bounded native receipt", () => {
  const body = receipt(); body.binding.replica_ids = Array.from({length:1000},(_,i)=>id(i+10)); body.restored_ids = [...body.binding.replica_ids];
  const input = migrationRollbackInput(body);
  assert.ok(input.length < MAX_ROLLBACK_INPUT);
  body.binding.replica_ids.push(id(2000)); assert.throws(()=>migrationRollbackInput(body));
});

test("scope projection distinguishes fresh derived epoch from exact original lookup", () => {
  const fresh = decodeRollbackScope([bytes(3),0,bytes(4),bytes(5),[id(6)],null,false]);
  assert.equal(fresh.authorityEpoch,null); assert.equal(fresh.original,false);
  const original = decodeRollbackScope([bytes(3),0,bytes(4),bytes(5),[id(6)],17,true]);
  assert.equal(original.authorityEpoch,17); assert.equal(original.original,true);
  assert.throws(()=>decodeRollbackScope([bytes(3),0,bytes(4),bytes(5),[id(6)],0,true]));
});

test("operator parser only accepts bounded authorized intent and expected sequence", async () => {
  const request = body => new Request("https://fixture.test/internal/v1/migration/operator",{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify(body)});
  for (const operation of ["rollback","restart","resolve","abandon"]) {
    const key = ["rollback","restart"].includes(operation) ? "expected_run_sequence" : "expected_action_sequence";
    const body = {collection:id(1),operation,[key]:1};
    const input = await migrationOperatorRequest(request(body),token);
    assert.equal(input instanceof Response,false); assert.deepEqual(migrationOperatorBody(input),body);
    for (const bad of [{...body,[key]:0},{...body,[key]:Number.MAX_SAFE_INTEGER+1},{...body,found:true},{...body,ack:true},{...body,operation:"force"}]) {
      assert.equal((await migrationOperatorRequest(request(bad),token)).status,400);
    }
    assert.equal((await migrationOperatorRequest(request(body),"wrong-service-token-for-fixtures-only")).status,401);
  }
});
