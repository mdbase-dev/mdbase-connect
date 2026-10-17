import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { encode, decode } from "../../../packages/sdk/src/cbor.ts";

const bundle = await build({ stdin: { contents: 'export * from "./src/migration-objects.ts"; export {httpsLog} from "./src/log.ts";',
  resolveDir: new URL("../", import.meta.url).pathname, loader: "ts" }, bundle: true, write: false, format: "esm", platform: "node" });
const { putGen0Object, hasGen0Objects, httpsLog } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const COLLECTION = "0b6b7f4e-3c1d-4e2a-9f8b-5a6c7d8e9f01";
const hex = bytes => Buffer.from(bytes).toString("hex");
async function object(size) {
  const bytes = new Uint8Array(size).fill(7);
  return { address: hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))), kind: 1, bytes };
}
function setup(o, options = {}) {
  const calls = [], controller = new AbortController();
  let current = true, uploaded = false;
  const signer = { signRpc: () => new Uint8Array(64) };
  const log = { async fetch(input, init = {}) {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname === "/v1/nonce") return new Response("0".repeat(64));
    if (init.method === "PUT") {
      calls.push({ method: "PUT", url, init });
      assert.equal(url.origin, "https://log.internal", "minted origin is never an egress destination");
      assert.equal(init.headers.authorization, undefined, "RPC bearer never reaches the direct URL");
      assert.equal(init.body, o.bytes);
      assert.equal(init.redirect, "manual");
      assert.ok(url.searchParams.get("sig"));
      uploaded = true;
      if (options.fence) current = false;
      if (options.abort) controller.abort();
      if (options.lostPut) throw new Error("lost reply after bytes landed");
      return new Response(null, { status: options.redirect ? 307 : 200 });
    }
    assert.equal(url.pathname, "/v1/rpc");
    assert.equal(init.headers.authorization, "Bearer test-token");
    const request = decode(new Uint8Array(init.body)), method = request.get(2), params = request.get(3);
    calls.push({ method, params });
    let result;
    if (method === "put_object") {
      if (o.bytes.length <= 1 << 20) result = new Map([[0, options.inlineUpload ? 1 : 0]]);
      else if (options.exists || options.storedLarge) result = new Map([[0, options.exists ? 2 : 0]]);
      else {
        const expiry = Date.now() + (options.expired ? -1 : 60_000);
        const direct = new URL(`https://response-selected.invalid/v1/o/${COLLECTION}/${o.address}`);
        for (const [k,v] of Object.entries({ op: "put", dev: "1".repeat(32), size: o.bytes.length, ck: o.address, exp: expiry, sig: "2".repeat(64) })) direct.searchParams.set(k,String(v));
        if (options.wrongPath) direct.pathname = "/admin";
        if (options.wrongSize) direct.searchParams.set("size",String(o.bytes.length + 1));
        result = new Map([[0,1], [1,new Map([[0,direct.href], [1,new Map([["x-amz-checksum-sha256", options.wrongChecksum ? "bad" : Buffer.from(params.get(4)).toString("base64")]])], [2,expiry]])]]);
      }
    } else if (method === "commit_object") result = new Map([[0,uploaded && !options.commitFalse]]);
    else if (method === "has_objects") result = new Map([[0,params.get(1).map(() => options.missing ? false : true)]]);
    else throw new Error(`unexpected RPC ${method}`);
    return new Response(encode(new Map([[0,1], [1,request.get(1)], [2,result]])));
  } };
  return { calls, put: () => putGen0Object(log, signer, "test-token", COLLECTION, o, () => current, controller.signal),
    has: () => hasGen0Objects(log, signer, "test-token", COLLECTION, [o.address], () => current) };
}

test("<=1 MiB stays inline; >1 MiB uses bounded PUT and signed commit before HasObjects", async () => {
  for (const size of [1 << 20, (1 << 20)+1, (8 << 20)+128]) {
    const o = await object(size), s = setup(o);
    await s.put();
    assert.deepEqual(await s.has(), [true]);
    const methods = s.calls.map(c => c.method);
    assert.deepEqual(methods, size <= 1 << 20 ? ["put_object","has_objects"] : ["put_object","PUT","commit_object","has_objects"]);
    const params = s.calls[0].params;
    assert.equal(params.get(3),size);
    assert.equal(params.has(5),size <= 1 << 20);
    assert.equal(hex(params.get(4)),o.address);
  }
});

test("already-present large objects skip PUT; lost PUT replies require positive commit evidence", async () => {
  const o = await object((1 << 20)+1);
  const exists = setup(o,{ exists: true }); await exists.put();
  assert.deepEqual(exists.calls.map(c => c.method),["put_object"]);
  const lost = setup(o,{ lostPut: true }); await lost.put();
  assert.deepEqual(lost.calls.map(c => c.method),["put_object","PUT","commit_object"]);
  await assert.rejects(setup(o,{ lostPut: true, commitFalse: true }).put(),/commit_refused/);
  const invalidStored = setup(o,{ storedLarge: true });
  await assert.rejects(invalidStored.put(),/put_refused/);
  assert.deepEqual(invalidStored.calls.map(c => c.method),["put_object"]);
});

for (const option of ["wrongPath","wrongSize","wrongChecksum","expired","redirect","commitFalse","fence","abort"]) {
  test(`direct upload ${option} refuses, never fabricates a committed object`, async () => {
    const s = setup(await object((1 << 20)+1),{ [option]: true });
    await assert.rejects(s.put(),/migration_object_/);
    if (["wrongPath","wrongSize","wrongChecksum","expired"].includes(option)) assert.equal(s.calls.some(c => c.method === "PUT"),false);
    if (option !== "commitFalse") assert.equal(s.calls.some(c => c.method === "commit_object"),false);
  });
}

test("invalid ciphertext address and oversized objects refuse before an RPC", async () => {
  const o = await object(17); o.address = "0".repeat(64);
  const s = setup(o); await assert.rejects(s.put(),/object_invalid/); assert.deepEqual(s.calls,[]);
  const huge = setup({ address: "0".repeat(64), kind: 1, bytes: new Uint8Array((9 << 20)+1) });
  await assert.rejects(huge.put(),/object_invalid/); assert.deepEqual(huge.calls,[]);
});

test("httpsLog preserves signed direct URL query and pins the configured origin", async t => {
  const calls = [];
  t.mock.method(globalThis,"fetch",async (url,init) => { calls.push([url,init.redirect]); return new Response(null); });
  await httpsLog("https://configured-log.test").fetch("https://log.internal/v1/o/c/a?op=put&sig=abc",{ method: "PUT" });
  assert.deepEqual(calls,[["https://configured-log.test/v1/o/c/a?op=put&sig=abc","manual"]]);
});
