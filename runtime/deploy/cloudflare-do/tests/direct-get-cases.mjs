// TEST-ONLY direct-download probes over actual local workerd/R2 bindings.
// R2 seeds isolate download behavior; these are NOT upload-verification evidence.
// The existing conformance blob case separately performs real PUT + commit.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
export async function directGetCases({ base, encode, map, sha }) {
  const secret = sha(Buffer.from("conformance/url-secret"));
  const collection = sha(Buffer.from("direct-get/collection")).subarray(0, 16);
  const hex = collection.toString("hex");
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const opaque = Buffer.from(Array.from({ length: 16384 }, (_, i) => (i * 17 + (i >> 8)) & 255));
  const bytes = encode(map([[0, 1], [1, 16], [2, collection], [5, 1], [7, Buffer.alloc(16, 7)], [11, opaque]]));
  const digest = sha(bytes), address = digest.toString("hex"), total = bytes.length;
  const metadata = { "mdbn-verified": "1", kind: "16", size: String(total), sha256: address };
  function cap({ a = address, size = total, ck = address, op = "get", expires = Date.now() + 60000 } = {}) {
    const dev = op === "put" ? Buffer.alloc(16, 0x54).toString("hex") : "";
    const sig = createHmac("sha256", secret).update(`ls-direct|${op}|${hex}|${a}|${dev}|${size}|${ck}|${expires}`).digest("hex");
    return `https://worker/v1/o/${uuid}/${a}?op=${op}&dev=${dev}&size=${size}&ck=${ck}&exp=${expires}&sig=${sig}`;
  }
  async function run(extra = {}) {
    const q = { directGet: true, method: "GET", url: cap(), size: 0, ...extra };
    const r = await fetch(`${base}/__test/ingress`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(q) });
    assert.equal(r.status, 200);
    return r.json();
  }
  const failures = [];
  async function check(name, f) {
    try { await f(); console.log(`PASS direct GET: ${name}`); }
    catch (e) { failures.push(name); console.error(`FAIL direct GET: ${name}: ${e.message}`); }
  }
  function noObject(r, status) {
    assert.equal(r.status, status);
    assert.equal(r.checksum, null, "refusal must not advertise object SHA");
    assert.ok(r.response.length < 128, "refusal must not emit sealed object bytes");
    assert.equal(r.emitted, 0, "refusal must not read incoming request body");
    assert.equal(r.r2writes, 0);
  }
  await check("full 200 exact length/bytes/WHOLE SHA and deterministic retry", async () => {
    const first = await run({ prefix: bytes.toString("base64"), seedR2: { key: `c/${uuid}/${address}`, sha256: digest.toString("base64"), metadata } });
    for (const r of [first, await run()]) {
      assert.equal(r.status, 200); assert.equal(r.contentLength, String(total));
      assert.equal(r.contentRange, null); assert.equal(r.checksum, digest.toString("base64"));
      assert.deepEqual(Buffer.from(r.response), bytes);
      assert.deepEqual(sha(Buffer.from(r.response)), digest);
      assert.equal(r.r2gets, 1); assert.equal(r.r2cancels, 0);
    }
  });
  await check("partial 206 exact endpoints/full total/length/bytes and full-object SHA", async () => {
    for (const [start, end] of [[100, 199], [0, 0], [total - 1, total - 1], [0, total - 1]]) {
      const r = await run({ headers: { range: `bytes=${start}-${end}` } });
      assert.equal(r.status, 206); assert.equal(r.contentRange, `bytes ${start}-${end}/${total}`);
      assert.equal(r.contentLength, String(end - start + 1));
      assert.equal(r.checksum, digest.toString("base64"));
      assert.deepEqual(Buffer.from(r.response), bytes.subarray(start, end + 1));
      assert.equal(r.r2gets, 1); assert.equal(r.r2cancels, 0);
    }
  });
  await check("strict 416 malformed/suffix/open/multi/reversed/overflow/both endpoints NO CLAMP", async () => {
    for (const range of ["bogus", "bytes=", "items=0-1", "bytes=-1", "bytes=1-", "bytes=0-1,2-3", "bytes=1-0", "bytes=+0-1", "bytes=0-+1", "bytes=0 -1", "bytes=18446744073709551616-18446744073709551616", "bytes=0-18446744073709551615", `bytes=${total}-${total}`, `bytes=0-${total}`, `bytes=${total - 1}-${total + 10}`]) {
      const r = await run({ headers: { range } });
      noObject(r, 416); assert.equal(r.contentRange, `bytes */${total}`);
      assert.equal(r.r2gets, 0, "invalid span must not acquire a body");
    }
  });
  await check("missing 404 and wrong operation/method/path never read or emit object body", async () => {
    noObject(await run({ url: cap({ a: Buffer.alloc(32, 3).toString("hex") }) }), 404);
    const wrongOp = await run({ url: cap({ op: "put" }) });
    noObject(wrongOp, 403); assert.equal(wrongOp.r2gets, 0);
    const wrongMethod = await run({ method: "POST", size: 4096 });
    noObject(wrongMethod, 405); assert.equal(wrongMethod.r2gets, 0);
    const wrong = new URL(cap()); wrong.pathname += "/extra";
    const wrongPath = await run({ method: "PUT", url: wrong.href, size: 4096 });
    noObject(wrongPath, 400); assert.equal(wrongPath.r2gets, 0);
  });
  await check("exact acquired-metadata snapshot admits full and partial native body without cancellation", async () => {
    for (const partial of [false, true]) {
      const r = await run({ getMetadata: metadata, ...(partial ? { headers: { range: "bytes=100-199" } } : {}) });
      assert.equal(r.status, partial ? 206 : 200);
      assert.equal(r.contentLength, String(partial ? 100 : total));
      assert.equal(r.contentRange, partial ? `bytes 100-199/${total}` : null);
      assert.equal(r.checksum, digest.toString("base64"));
      assert.deepEqual(Buffer.from(r.response), partial ? bytes.subarray(100, 200) : bytes);
      assert.equal(r.r2gets, 1); assert.equal(r.r2cancels, 0);
    }
  });
  await check("missing/changed acquired metadata cancels actual R2 body before response", async () => {
    for (const getMetadata of [{}, { ...metadata, size: String(total + 1) }, { ...metadata, sha256: Buffer.alloc(32, 9).toString("hex") }]) {
      const r = await run({ getMetadata });
      noObject(r, 502); assert.equal(r.r2gets, 1); assert.equal(r.r2cancels, 1);
    }
  });
  await check("signed size and whole SHA bind stored object metadata", async () => {
    for (const url of [cap({ size: total + 1 }), cap({ ck: Buffer.alloc(32, 9).toString("hex") })]) {
      noObject(await run({ url }), 502);
    }
  });
  await check("cap expiry after actual storage await cancels acquired native body", async () => {
    const r = await run({ url: cap({ expires: Date.now() + 1000 }), delayR2Get: 1600, headers: { range: "bytes=100-199" } });
    noObject(r, 403); assert.equal(r.r2gets, 1, "must pass initial admission and reach the await");
    assert.equal(r.r2cancels, 1);
    const retry = await run(); assert.equal(retry.status, 200);
    assert.deepEqual(sha(Buffer.from(retry.response)), digest);
  });
  await check("paused consumer abort cancels acquired native body; fresh retry has complete hash", async () => {
    const r = await run({ cancelResponse: true });
    assert.equal(r.status, 200); assert.equal(r.r2gets, 1);
    assert.equal(r.lockedBeforeCancel, false); assert.equal(r.r2cancels, 1);
    assert.deepEqual(r.response, []);
    const retry = await run(); assert.equal(retry.status, 200);
    assert.deepEqual(Buffer.from(retry.response), bytes);
    assert.deepEqual(sha(Buffer.from(retry.response)), digest);
  });
  assert.deepEqual(failures, [], "direct-download regressions");
}
