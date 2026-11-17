// Real DO SQLite: the body index (an FTS5 virtual table) is created, searched
// and maintained through the index host, and a reset drops it with its shadow
// tables, which refuse a direct DROP.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const root = fileURLToPath(new URL("../", import.meta.url));
const compiled = await build({ stdin: { resolveDir: root, contents: `
import { DurableObject } from "cloudflare:workers";
import { runIndex } from "./src/sql.ts";
const magic=[77,68,66,73,68,88,0,1], enc=new TextEncoder();
const u32=n=>{const b=new Uint8Array(4);new DataView(b.buffer).setUint32(0,n,true);return [...b];};
const text=s=>{const b=enc.encode(s);return [3,...u32(b.length),...b];};
function run(storage,statements){
 const request=Uint8Array.from([...magic,0,1,...u32(statements.length),...statements.flatMap(([sql,params=[]])=>{
  const b=enc.encode(sql);return [...u32(b.length),...b,...u32(params.length),...params.flatMap(text)];
 })]);
 return runIndex(storage,request)[8];
}
export class Probe extends DurableObject {
 fetch(){
  const storage=this.ctx.storage,sql=storage.sql;
  const names=()=>sql.exec("SELECT name FROM sqlite_master WHERE name LIKE 'st%' ORDER BY name").toArray().map(r=>r.name);
  const matches=needle=>sql.exec("SELECT b.id AS id FROM st_qbody_n b WHERE b.n IN (SELECT rowid FROM st_qbody WHERE st_qbody MATCH ?) ORDER BY b.id",needle).toArray().map(r=>r.id);
  const ddl=run(storage,[
   ["CREATE TABLE IF NOT EXISTS st_qbody_n(n INTEGER PRIMARY KEY, id BLOB NOT NULL UNIQUE)"],
   ["CREATE VIRTUAL TABLE IF NOT EXISTS st_qbody USING fts5(t, tokenize='trigram case_sensitive 1', content='', contentless_delete=1)"],
  ]);
  const writes=run(storage,[
   ["INSERT INTO st_qbody_n(id) VALUES(?)",["a"]],
   ["INSERT INTO st_qbody(rowid,t) SELECT n,? FROM st_qbody_n WHERE id=?",["meeting notes \\uFFFD café","a"]],
   ["INSERT INTO st_qbody_n(id) VALUES(?)",["b"]],
   ["INSERT INTO st_qbody(rowid,t) SELECT n,? FROM st_qbody_n WHERE id=?",["other notes","b"]],
  ]);
  const before=[matches('"notes"'),matches('"café"'),matches('"Notes"')];
  const deleted=run(storage,[
   ["DELETE FROM st_qbody WHERE rowid IN (SELECT n FROM st_qbody_n WHERE id=?)",["a"]],
   ["DELETE FROM st_qbody_n WHERE id=?",["a"]],
  ]);
  const after=matches('"notes"');
  const cleared=run(storage,[["DELETE FROM st_qbody_n"],["INSERT INTO st_qbody(st_qbody) VALUES('delete-all')"]]);
  const tables=names();
  const reset=runIndex(storage,Uint8Array.from([...magic,1]))[8];
  return Response.json({ops:[ddl,writes,deleted,cleared],before,after,tables,reset,left:names()});
 }
}
export default{fetch(r,e){return e.PROBE.getByName("one-store").fetch(r);}};
` }, bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:workers"] });

test("DO SQLite holds, searches and resets the FTS5 body index", async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ name: "body-index", modules: true,
    script: compiled.outputFiles[0].text, compatibilityDate: "2026-10-05", port: 0,
    durableObjects: { PROBE: { className: "Probe", useSQLite: true } } }));
  try {
    const response = await mf.dispatchFetch("http://fixture.test/");
    assert.equal(response.status, 200, await response.clone().text());
    const r = await response.json();
    assert.deepEqual(r.ops, [2, 2, 2, 2]);
    assert.deepEqual(r.before, [["a", "b"], ["a"], []], "case-sensitive trigram substrings");
    assert.deepEqual(r.after, ["b"], "a contentless row deletes");
    assert.ok(r.tables.includes("st_qbody_data"), "FTS5 shadow tables exist");
    assert.equal(r.reset, 4);
    assert.deepEqual(r.left, [], "reset drops the virtual table and its shadows");
  } finally {
    await mf.dispose();
  }
});
