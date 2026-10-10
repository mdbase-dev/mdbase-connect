import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { encode } from "../../../packages/sdk/src/cbor.ts";
import { wakeCollectionTag, hasGrantAppend, wakeLog } from "../src/wake-observe.ts";
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
