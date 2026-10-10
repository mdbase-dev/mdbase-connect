import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { encode, decode } from "../../../packages/sdk/src/cbor.ts";
import { fetchAttachment } from "../src/object-reads.ts";
import { ObjectOriginPolicy, DENY_OBJECT_ORIGINS } from "../src/object-origins.ts";
const origins = ObjectOriginPolicy.configured(["https://objects.test"]);
const collection = new Uint8Array(16).fill(4);
const address = new Uint8Array(32).fill(5);
const sha = (b) => new Uint8Array(createHash("sha256").update(b).digest());
function fixture(data, { direct = false, replyId = 3, uri = "https://objects.test/object" } = {}) {
  const checksum = sha(data); let allowed = true; let failed = false; let done = false; let reserved = 0; let maxWrite = 0; let total = 0;
  const copy = new Uint8Array(data.length);
  const lease = { ticket: 3, session: 7, expectedBytes: data.length, frame: encode(new Map([[0,0],[1,3],[2,"get_object"],[3,new Map([[0,collection],[1,address]])]])) };
  const engine = {
    signRpc: () => new Uint8Array(64),
    attachmentAllowed: (t) => t === 3 && allowed,
    attachmentReserve: (_t, n) => { reserved = n; return n === data.length; },
    attachmentWrite: (_t,b) => { maxWrite = Math.max(maxWrite,b.length); copy.set(b,total); total += b.length; return allowed; },
    attachmentComplete: (_t,c) => { done = total === data.length && Buffer.from(sha(copy)).equals(Buffer.from(c)); return done; },
    attachmentFailed: () => { failed = true; },
  };
  let calls = 0;
  const result = new Map([[direct ? 1 : 0, direct ? new Map([[0,uri],[1,new Map()],[2,Date.now()+60_000]]) : data.slice()], [2,data.length], [3,checksum]]);
  const log = { fetch: async (url, init) => {
    calls++;
    if (url.endsWith("/nonce")) return new Response("0".repeat(64));
    assert.equal(decode(new Uint8Array(init.body)).get(2),"get_object");
    return new Response(encode(new Map([[0,1],[1,replyId],[2,result]])));
  }};
  const headers = { "content-length": String(data.length), "content-range": `bytes 0-${data.length-1}/${data.length}`, "x-amz-checksum-sha256": Buffer.from(checksum).toString("base64") };
  return { engine, log, lease, headers, revoke: () => { allowed = false; }, facts: () => ({failed,done,reserved,maxWrite,total,calls}) };
}

test("inline ciphertext uses authenticated RPC and completes with exact checksum", async () => {
  const f = fixture(new Uint8Array(256).fill(9));
  await fetchAttachment(f.log,f.engine,"test-token",f.lease,()=>true,origins);
  assert.equal(f.facts().done,true,JSON.stringify(f.facts()));assert.equal(f.facts().failed,false);assert.equal(f.facts().calls,2);
});
test("a complete closed ciphertext range streams in <=1MiB segments", async () => {
  const bytes = new Uint8Array(8<<20).fill(9);const f=fixture(bytes,{direct:true});
  await fetchAttachment(f.log,f.engine,"test-token",f.lease,()=>true,origins,async (_url,init)=> {
    assert.equal(init.redirect,"manual");assert.equal(new Headers(init.headers).get("range"),`bytes=0-${bytes.length-1}`);
    return new Response(bytes.slice(),{status:206,headers:f.headers});
  });
  assert.equal(f.facts().done,true,JSON.stringify(f.facts()));assert.ok(f.facts().maxWrite<=1<<20);assert.equal(f.facts().total,bytes.length);
});
test("revocation after metadata await prevents allocation and direct fetch", async () => {
  const f=fixture(new Uint8Array(256).fill(9),{direct:true});const old=f.log.fetch;
  f.log.fetch=async (...args)=> {const response=await old(...args);if(args[0].endsWith("/rpc"))f.revoke();return response;};
  await fetchAttachment(f.log,f.engine,"test-token",f.lease,()=>true,origins,async ()=> {assert.fail("denied direct request");});
  assert.equal(f.facts().reserved,0);assert.equal(f.facts().done,false);assert.equal(f.facts().failed,true);
});
test("wrong response ID never becomes another read's object", async () => {
  const f=fixture(new Uint8Array(256).fill(9),{replyId:4});
  await fetchAttachment(f.log,f.engine,"test-token",f.lease,()=>true,origins);
  assert.equal(f.facts().reserved,0);assert.equal(f.facts().done,false);assert.equal(f.facts().failed,true);
});
test("whole-body fallback to an exact Range request is refused", async () => {
  const data=new Uint8Array(256).fill(9);const f=fixture(data,{direct:true});
  await fetchAttachment(f.log,f.engine,"test-token",f.lease,()=>true,origins,async ()=>new Response(data,{status:200,headers:f.headers}));
  assert.equal(f.facts().total,0);assert.equal(f.facts().done,false);assert.equal(f.facts().failed,true);
});

test("untrusted GET origin refuses before allocation or any direct fetch/write/completion", async () => {
  for (const uri of ["https://unconfigured.test/object", "https://sub.objects.test/object", "https://objects.test.evil.test/object",
    "https://objects.test:444/object", "https://objects.test./object", "https://127.0.0.1/object", "https://10.0.0.1/object",
    "https://169.254.169.254/object", "https://[::1]/object", "https://0x7f000001/object", "https://log.internal/direct",
    "https://user:secret@objects.test/object", "https://objects.test/object#", "https://objects.test\\\\object"]) {
    const f = fixture(new Uint8Array(256).fill(9), {direct: true, uri});let fetches = 0;
    await fetchAttachment(f.log, f.engine, "test-token", f.lease, () => true, origins, () => {fetches++;assert.fail("no untrusted GET");});
    assert.equal(fetches, 0);assert.equal(f.facts().reserved, 0);assert.equal(f.facts().total, 0);
    assert.equal(f.facts().done, false);assert.equal(f.facts().failed, true);assert.equal(f.facts().calls, 2);
    assert.equal(f.lease.frame.every(b => b === 0), true);
  }
});

test("missing origins deny direct GET; inline reads require no destination authority", async () => {
  for (const direct of [true, false]) {
    const f = fixture(new Uint8Array(256).fill(9), {direct});
    await fetchAttachment(f.log, f.engine, "test-token", f.lease, () => true, DENY_OBJECT_ORIGINS, () => {assert.fail("no direct GET");});
    assert.equal(f.facts().done, !direct);assert.equal(f.facts().failed, direct);
    if (direct) assert.equal(f.facts().reserved, 0);
  }
});

test("redirect GET is cancelled without consuming bytes or completing the object", async () => {
  const f = fixture(new Uint8Array(256).fill(9), {direct: true});let cancelled = false;
  await fetchAttachment(f.log, f.engine, "test-token", f.lease, () => true, origins, async (_u, init) => {
    assert.equal(init.redirect, "manual");
    return new Response(new ReadableStream({cancel() {cancelled = true;}}, {highWaterMark: 0}), {status: 307, headers: {location: "https://unconfigured.test/object"}});
  });
  assert.equal(cancelled, true);assert.equal(f.facts().total, 0);assert.equal(f.facts().failed, true);assert.equal(f.facts().done, false);
});

test("explicit LOG binding carries a direct object; ordinary fetch is never used", async () => {
  const bytes = new Uint8Array(256).fill(9), uri = "https://log.internal/direct?opaque=test-only";
  const f = fixture(bytes, {direct: true, uri}), old = f.log.fetch;let bindingReads = 0;
  f.log.fetch = async (u, init) => {
    if (u !== uri) return old(u, init);
    bindingReads++;assert.equal(init.method, "GET");assert.equal(init.redirect, "manual");
    return new Response(bytes.slice(), {status: 206, headers: f.headers});
  };
  await fetchAttachment(f.log, f.engine, "test-token", f.lease, () => true, ObjectOriginPolicy.configured([], true),
    () => {assert.fail("no ordinary log.internal fetch");});
  assert.equal(bindingReads, 1);assert.equal(f.facts().done, true);assert.equal(f.facts().failed, false);
});
