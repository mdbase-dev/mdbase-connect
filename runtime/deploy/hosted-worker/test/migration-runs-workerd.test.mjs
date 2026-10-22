// Exact native schema SQL on real workerd SQLite. No synthetic authority or
// successful provider effect: Driver retry eligibility is tested natively.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const runs = readFileSync(new URL("../../../crates/hosted-worker/src/migration_action_ledger/runs.rs", import.meta.url), "utf8");
const ledger = readFileSync(new URL("../../../crates/hosted-worker/src/migration_action_ledger.rs", import.meta.url), "utf8");
const literal = (source, name) => JSON.parse(source.match(new RegExp(`const ${name}: &str = ("[^\\n]*");`))[1]);
const run = literal(runs, "RUN");
const upgrade = runs.match(/const UPGRADE: &\[&str\] = &\[([\s\S]*?)\];/)[1].trim().split("\n")
  .map(line => line.trim().replace(/,$/, "")).map(line => line === "RUN" ? run : JSON.parse(line));
const schema = [...runs.match(/stmts.extend\(\[([\s\S]*?)\]\);/)[1].matchAll(/Stmt::new\(("[^\n]*?"|ACTIONS|GUARD|SETTLE), vec!\[\]\)/g)]
  .map(([, value]) => value.startsWith('"') ? JSON.parse(value) : literal(ledger, value));
assert.equal(schema.length, 12, "exercise every production schema statement");
const reset = [...runs.match(/let result = run\([\s\S]*?BatchMode::Transaction,\s*\);/)[0]
  .matchAll(/Stmt::new\(\s*("[^\n]*?")/g)].map(([, value]) => JSON.parse(value));
assert.equal(reset.length, 6, "exercise the exact atomic native archive/reset batch");
const script = `
import { DurableObject } from "cloudflare:workers";
const upgrade=${JSON.stringify(upgrade)}, schema=${JSON.stringify(schema)}, reset=${JSON.stringify(reset)};
export class Probe extends DurableObject {
  async fetch(request) {
    const q=new URL(request.url).searchParams, sql=this.ctx.storage.sql;
    const state=()=>({columns:sql.exec("PRAGMA table_info(mig_native_run)").toArray().map(r=>r.name),
      runs:sql.exec("SELECT driver,started FROM mig_native_run").toArray().map(r=>({driver:Array.from(new Uint8Array(r.driver)),started:r.started})),
      actions:sql.exec("SELECT seq,settled FROM mig_native_action ORDER BY seq").toArray(),
      checkpoint:Array.from(new Uint8Array(sql.exec("SELECT v FROM mig_checkpoint WHERE k=0").one().v)),
      temporary:sql.exec("SELECT name FROM sqlite_master WHERE name='mig_native_run_upgrade'").toArray().length,
      archives:sql.exec("SELECT name FROM sqlite_master WHERE name='mig_native_run_end'").toArray().length
        ?sql.exec("SELECT seq,checkpoint FROM mig_native_run_end").toArray().map(r=>({seq:r.seq,checkpoint:Array.from(new Uint8Array(r.checkpoint))})):[]});
    if(q.get("op")==="seed")this.ctx.storage.transactionSync(()=>{
      sql.exec("CREATE TABLE mig_native_run(k INTEGER PRIMARY KEY CHECK(k=0),driver BLOB,collection BLOB,owner BLOB,started TEXT,target BLOB)");
      sql.exec("INSERT INTO mig_native_run VALUES(0,?,?,?,?,?)",new Uint8Array(16).fill(1),new Uint8Array(16).fill(2),new Uint8Array(16).fill(3),"123",new Uint8Array(32).fill(4));
      sql.exec(${JSON.stringify(literal(ledger, "ACTIONS"))});
      sql.exec("CREATE TABLE mig_checkpoint(k INTEGER PRIMARY KEY,v BLOB)");
      sql.exec("INSERT INTO mig_checkpoint VALUES(0,?)",new Uint8Array([9,8,7]));
      for(const name of ["mig_claim","mig_place","mig_deferred"]){sql.exec("CREATE TABLE "+name+"(v INTEGER)");sql.exec("INSERT INTO "+name+" VALUES(1)");}
      sql.exec("INSERT INTO mig_native_action(seq,driver,action,kind,fingerprint,before_cp) VALUES(1,?,?,0,?,?)",new Uint8Array(16).fill(1),new Uint8Array(16).fill(5),new Uint8Array(32).fill(6),new Uint8Array([9,8,7]));
    });
    if(q.get("op")==="upgrade"){
      try{this.ctx.storage.transactionSync(()=>{
        let i=0;for(const statement of [...upgrade,...schema]){sql.exec(statement);if(i++===Number(q.get("fault")))throw Error("crash-in-upgrade");}
      });}catch(e){if(e.message!=="crash-in-upgrade")throw e;}
    }
    if(q.get("op")==="settle")sql.exec("UPDATE mig_native_action SET settled=1,after_cp=before_cp,result=fingerprint WHERE seq=1");
    if(q.get("op")==="reset"){
      try{this.ctx.storage.transactionSync(()=>{
        const params=[[1,new Uint8Array([9,8,7]),new Uint8Array(16).fill(1),new Uint8Array([9,8,7])],
          [new Uint8Array(16).fill(7),new Uint8Array(16).fill(2),new Uint8Array(16).fill(3),"123",new Uint8Array(32).fill(4),2],
          [new Uint8Array([6])],[],[],[]];
        reset.forEach((statement,i)=>sql.exec(statement,...params[i]));
      });}catch(error){return Response.json({refused:true,state:state()});}
    }
    if(q.get("op")==="protect"){
      let protectedCount=0;
      for(const statement of ["DELETE FROM mig_native_run","UPDATE mig_native_run SET started='456'","DELETE FROM mig_native_action"]){try{sql.exec(statement);}catch{protectedCount++;}}
      return Response.json({protectedCount});
    }
    await this.ctx.storage.sync();return Response.json(state());
  }
}
export default{fetch(request,env){return env.RUNS.getByName("fixture").fetch(request);}};
`;

test("singleton run upgrade is atomic at every DDL boundary and survives actual runtime reopen", async () => {
  const prefix = fileURLToPath(new URL("../.test-state/runs-", import.meta.url));
  mkdirSync(dirname(prefix), { recursive: true });
  const scratch = mkdtempSync(prefix), oldTmp = process.env.TMPDIR;
  process.env.TMPDIR = scratch;
  const options = () => convertV4MiniflareOptions({ name: "run-schema-test", modules: true, script,
    compatibilityDate: "2026-10-05", port: 0, durableObjects: { RUNS: { className: "Probe", useSQLite: true } },
    resourcePersistencePath: scratch, resourceTmpPath: scratch });
  let mf; let passed = false;
  try {
    mf = new Miniflare(options());
    const call = async query => {
      const response = await mf.dispatchFetch(`http://fixture.test/?${new URLSearchParams(query)}`);
      assert.equal(response.status, 200, await response.clone().text());return response.json();
    };
    const original = await call({ op: "seed" });
    for (let fault = 0; fault < upgrade.length + schema.length; fault++) {
      assert.deepEqual(await call({ op: "upgrade", fault: String(fault) }), original, `rollback after statement ${fault}`);
    }
    await mf.dispose();mf = new Miniflare(options());
    assert.deepEqual(await call({}), original, "interrupted upgrades retain original pending/checkpoint across eviction");
    const upgraded = await call({ op: "upgrade", fault: "-1" });
    assert.equal(upgraded.columns[0], "seq");
    assert.deepEqual(upgraded.runs, original.runs);assert.deepEqual(upgraded.actions, original.actions);
    assert.deepEqual(upgraded.checkpoint, original.checkpoint);assert.equal(upgraded.temporary, 0);
    assert.deepEqual(await call({ op: "protect" }), { protectedCount: 3 });
    await mf.dispose();mf = new Miniflare(options());
    assert.deepEqual(await call({}), upgraded, "committed upgrade persists even without retained in-memory acknowledgement");
    const refused = await call({ op: "reset" });assert.equal(refused.refused, true);assert.deepEqual(refused.state, upgraded);
    const settled = await call({ op: "settle" });assert.equal(settled.actions[0].settled, 1);
    const restarted = await call({ op: "reset" });assert.equal(restarted.runs.length, 2);
    assert.deepEqual(restarted.archives, [{ seq: 1, checkpoint: [9, 8, 7] }]);assert.deepEqual(restarted.checkpoint, [6]);
    assert.deepEqual(restarted.actions, settled.actions);
    assert.deepEqual((await call({ op: "reset" })).state, restarted, "duplicate old-sequence reset is atomic and refuses");
    await mf.dispose();mf = new Miniflare(options());assert.deepEqual(await call({}), restarted);
    passed = true;
  } finally {
    await mf?.dispose();if (oldTmp === undefined) delete process.env.TMPDIR;else process.env.TMPDIR = oldTmp;
    if (passed) rmSync(scratch, { recursive: true });else console.error(`Retained isolated schema fixture: ${scratch}`);
  }
});
