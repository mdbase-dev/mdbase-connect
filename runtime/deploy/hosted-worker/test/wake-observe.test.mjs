import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { encode } from "../../../packages/sdk/src/cbor.ts";
import { wakeCollectionTag, hasGrantAppend, grantRecipients, wakeLog } from "../src/wake-observe.ts";
test("Worker wake tags match CP domain separation without disclosing identifiers", async () => {
 const collection="0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";
 const tag=await wakeCollectionTag(collection);
 assert.equal(tag,createHash("sha256").update(`mdbase-service-wake-v1:${collection}`).digest("hex").slice(0,24));
 const prior=console.info;const logs=[];console.info=(line)=>logs.push(line);
 try {wakeLog(tag,"hosted","wake_received");wakeLog(collection,"hosted","wake_received");} finally {console.info=prior;}
 assert.equal(logs.length,1);assert.equal(JSON.parse(logs[0]).collection_tag,tag);assert.ok(!logs[0].includes(collection));
});
test("grant emission detects only append Item4, not acceptance or wrap contents",()=> {
 const request=(method,kind)=>encode(new Map([[0,0],[1,1],[2,method],[3,new Map([[3,[encode(new Map([[1,kind],[11,new Uint8Array([9,8,7])]]))]]])]]));
 assert.equal(hasGrantAppend(request("append",4)),true);
 assert.equal(hasGrantAppend(request("append",3)),false);
 assert.equal(hasGrantAppend(request("read",4)),false);
 assert.equal(hasGrantAppend(new Uint8Array(65537)),false);
 assert.equal(hasGrantAppend(new Uint8Array([255])),false);
});
test("grant recipients: 4-byte device prefix per Item4 payload, nothing from other kinds or junk",()=> {
 const dev=(b)=>new Uint8Array(16).fill(b);
 const grant=(r)=>encode(new Map([[1,4],[11,encode(new Map([[1,r],[2,3],[3,new Uint8Array([1])]]))]]));
 const other=encode(new Map([[1,3],[11,encode(new Map([[1,dev(5)]]))]]));
 const frame=(items)=>encode(new Map([[0,0],[1,1],[2,"append"],[3,new Map([[3,items]])]]));
 assert.deepEqual(grantRecipients(frame([grant(dev(0xab)),other,grant(dev(1))])),["abababab","01010101"]);
 assert.deepEqual(grantRecipients(frame([grant(new Uint8Array(4))])),[]);
 assert.deepEqual(grantRecipients(new Uint8Array([255])),[]);
 const prior=console.info;const logs=[];console.info=(line)=>logs.push(line);
 try {wakeLog("a".repeat(24),"hosted","grant_emitted",undefined,["abababab"]);} finally {console.info=prior;}
 assert.deepEqual(JSON.parse(logs[0]).recipients,["abababab"]);
});
