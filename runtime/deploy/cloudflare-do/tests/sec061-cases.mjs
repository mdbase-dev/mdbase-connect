// TEST ONLY: bounded, independently signed corpus through real handlers.
import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, createHmac, sign } from "node:crypto";

export async function sec061Cases({ base, token, transport, sha, h }) {
  const padCount = 2200;
  const key = (label) => createPrivateKey({ key: Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"), sha(Buffer.from(label)),
  ]), type: "pkcs8", format: "der" });
  const pub = (k) => createPublicKey(k).export({ type: "spki", format: "der" }).subarray(-32);
  const map = (entries) => new Map(entries);
  const chain = (bytes) => h("mdbase/v1/chain", bytes);
  function head(major, n) {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n <= 255) return Buffer.from([(major << 5) | 24, n]);
    if (n <= 65535) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
    const b = Buffer.alloc(9); b[0] = (major << 5) | 27; b.writeBigUInt64BE(BigInt(n), 1); return b;
  }
  function enc(v) {
    if (typeof v === "boolean") return Buffer.from([v ? 0xf5 : 0xf4]);
    if (typeof v === "number") return head(0, v);
    if (typeof v === "string") { const b = Buffer.from(v); return Buffer.concat([head(3, b.length), b]); }
    if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
    if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(enc)]);
    if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [enc(k), enc(x)])]);
    throw Error("unsupported SEC061 test value");
  }
  function dec(bytes) {
    let pos = 0;
    function read() {
      const tag = bytes[pos++], major = tag >> 5, a = tag & 31;
      let n = a;
      if (a === 24) n = bytes[pos++];
      else if (a === 25) { n = bytes.readUInt16BE(pos); pos += 2; }
      else if (a === 26) { n = bytes.readUInt32BE(pos); pos += 4; }
      else if (a === 27) { n = Number(bytes.readBigUInt64BE(pos)); pos += 8; }
      else assert.ok(a < 24);
      if (major === 0) return n;
      if (major === 2 || major === 3) { const b = bytes.subarray(pos, pos += n); return major === 2 ? b : b.toString(); }
      if (major === 4) return Array.from({ length: n }, read);
      if (major === 5) { const out = new Map(); for (let i = 0; i < n; i++) out.set(read(), read()); return out; }
      if (major === 7 && a === 20) return false;
      if (major === 7 && a === 21) return true;
      throw Error("unsupported SEC061 response");
    }
    const result = read(); assert.equal(pos, bytes.length); return result;
  }
  function padded(v, n = padCount) { const m = new Map(v); m.set(99, Array(n).fill(0)); return m; }
  function legal(bytes) {
    function nodes(v) {
      if (Array.isArray(v)) return 1 + v.reduce((n, x) => n + nodes(x), 0);
      if (v instanceof Map) return 1 + [...v].reduce((n, [k, x]) => n + nodes(k) + nodes(x), 0);
      return 1; // byte/text strings are opaque leaves
    }
    assert.ok(nodes(dec(bytes)) <= 4096, "each encoded decode boundary must be individually legal");
    return bytes;
  }
  const uuid = (c) => c.toString("hex").replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
  const collection = (name) => sha(Buffer.from(`sec061/${name}`)).subarray(0, 16);
  const nonce = async () => Buffer.from(await (await fetch(`${base}/v1/nonce`)).text(), "hex");
  const rootKey = key("conformance/root"), issuer = key("conformance/issuer");
  const rootId = sha(pub(rootKey)).subarray(0, 16), policyId = sha(pub(transport)).subarray(0, 16);
  const cert = map([[0, pub(transport)], [1, 0], [2, 2 ** 50], [3, rootId]]);
  cert.set(4, sign(null, h("mdbase/v1/cp-cert", enc(cert)), rootKey));
  function policy(c, seq, prev, ops, bodyPad = false, itemPad = false) {
    let body = map([[0, 1], [1, cert], [2, seq], [3, ops]]);
    if (bodyPad) body = padded(body);
    let item = map([[0, 1], [1, 2], [2, c], [3, seq], [4, prev], [6, policyId], [11, legal(enc(body))]]);
    item.set(12, sign(null, h("mdbase/v1/item-sig", enc(item)), transport));
    if (itemPad) item = padded(item);
    return legal(enc(item));
  }
  const genesis = (c, bodyPad = false, itemPad = false) => policy(c, 1, Buffer.alloc(32), [
    map([[0, 1], [1, collection("owner")], [2, rootId], [3, 0]]),
  ], bodyPad, itemPad);
  const freeze = () => map([[0, 11], [1, false]]);
  function request(method, params, rootPad = false) {
    let f = map([[0, 0], [1, 1], [2, method], [3, params]]);
    if (rootPad) f = padded(f);
    return legal(enc(f));
  }
  function auth(body, c, method, n, tok = token, proven = true, signer = transport) {
    return { authorization: `Bearer ${tok}`, "x-mdbase-nonce": n.toString("hex"),
      "x-mdbase-sig": proven ? sign(null, h("mdbase/v1/ls-http", Buffer.concat([
        Buffer.from(`${method}\0/v1/rpc\0`), c, sha(Buffer.from(tok)), sha(body), n,
      ])), signer).toString("hex") : "00".repeat(64) };
  }
  async function invoke(method, params, { actor = false, rootPad = false, tok = token, proven = true, signer = transport, resourceHeaders = {}, n } = {}) {
    const c = params.get(0), body = request(method, params, rootPad);
    n ??= await nonce();
    const r = await fetch(`${base}/__test/ingress`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: actor ? `https://do/v1/rpc?c=${uuid(c)}` : "https://worker/v1/rpc",
        ...(actor ? { actor: uuid(c) } : {}), size: body.length, prefix: body.toString("base64"),
        chunk: 127, headers: { ...auth(body, c, method, n, tok, proven, signer), ...resourceHeaders } }) });
    assert.equal(r.status, 200, "test wrapper");
    return { ...(await r.json()), nonce: n };
  }
  async function ordinary(method, params, options = {}) {
    const r = await invoke(method, params, options);
    assert.equal(r.status, 200);
    const frame = dec(Buffer.from(r.response));
    assert.ok(frame.has(2) && !frame.has(3), `honest ${method} failed`);
    return frame.get(2);
  }
  async function headIs(c, expected) {
    const r = await invoke("head", map([[0, c]]));
    assert.equal(r.status, 200);
    const frame = dec(Buffer.from(r.response));
    if (expected === undefined) assert.equal(frame.get(3)?.get(0), "not_found", "failed request created state");
    else assert.equal(frame.get(2)?.get(0), expected, "failed request moved head");
  }
  async function budgetFailure(r) {
    assert.ok(r.status === 200 || r.status === 400, `unexpected rejection status ${r.status}`);
    const b = Buffer.from(r.response);
    if (r.status === 200) {
      assert.ok(b.length > 0, `aggregate upload unexpectedly succeeded (status 200, R2 writes ${r.r2writes})`);
      const error = dec(b).get(3);
      assert.equal(error?.get(0), "invalid", `aggregate path reached ordinary dispatch (${error?.get(0) ?? "success"})`);
    }
    assert.ok(b.includes(Buffer.from("cbor_nodes")) || b.includes(Buffer.from("cbor_work"))
      || r.cborReason === "cbor_nodes" || r.cborReason === "cbor_work", "aggregate decode work unexpectedly accepted or failed for another reason");
    assert.equal(r.r2writes, 0);
    assert.equal(await (await fetch(`${base}/debug/ingress_budget`)).text(), "0", "lifetime credits leaked");
  }
  const failures = [];
  async function check(name, fn) {
    try { await fn(); console.log(`PASS SEC061: ${name}`); }
    catch (e) { failures.push(name); console.error(`FAIL SEC061: ${name}: ${e.message}`); }
  }
  // Actual transport resource headers; never authority or product debug hooks.
  const carry = (nodes, work, depth) => ({
    "x-logsvc-decode-nodes": String(nodes),
    "x-logsvc-decode-work": String(work),
    "x-logsvc-decode-depth": String(depth),
  });
  const invalidCarry = [
    { "x-logsvc-decode-nodes": "0" }, // partial
    { "x-logsvc-decode-work": "0", "x-logsvc-decode-depth": "0" },
    carry(-1, 0, 0), carry(0, -1, 0), carry(0, 0, -1),
    carry("18446744073709551616", 0, 0), carry(0, "18446744073709551616", 0),
    carry(4097, 0, 0), carry(0, 67108865, 0), carry(0, 0, 129),
    carry(0, 0, "0.5"),
  ];
  await check("actor rejects malformed/partial/out-of-range resource carry before ingress or nonce", async () => {
    const c = collection("carry/invalid");
    for (const resourceHeaders of invalidCarry) {
      const r = await invoke("head", map([[0, c]]), { actor: true, resourceHeaders });
      assert.equal(r.status, 400);
      assert.ok(Buffer.from(r.response).includes(Buffer.from("cbor_budget")));
      assert.equal(r.forwarded, 0); assert.equal(r.r2writes, 0);
      assert.equal(r.emitted, 0, "malformed carry must fail before body consumption");
      assert.equal(await (await fetch(`${base}/debug/ingress_budget`)).text(), "0");
      const retry = await invoke("head", map([[0, c]]), { actor: true, n: r.nonce });
      assert.equal(dec(Buffer.from(retry.response)).get(3)?.get(0), "not_found", "carry rejection must not consume nonce");
    }
  });
  await check("actor exact-spent carry cannot reset resources", async () => {
    const c = collection("carry/spent");
    for (const resourceHeaders of [carry(4096, 0, 0), carry(0, 67108864, 0)]) {
      const r = await invoke("head", map([[0, c]]), { actor: true, resourceHeaders });
      await budgetFailure(r);
      assert.equal(r.emitted, 0); assert.equal(r.forwarded, 0);
      const retry = await invoke("head", map([[0, c]]), { actor: true, n: r.nonce });
      assert.equal(dec(Buffer.from(retry.response)).get(3)?.get(0), "not_found");
    }
    const depthOnly = await invoke("head", map([[0, c]]), { actor: true, resourceHeaders: carry(0, 0, 128) });
    assert.equal(dec(Buffer.from(depthOnly.response)).get(3)?.get(0), "not_found", "maximum observed depth is not a depleted depth allowance");
  });
  await check("outer overwrites forged zero/high/partial resource headers", async () => {
    const c = collection("carry/overwrite");
    for (const resourceHeaders of [carry(0, 0, 0), ...invalidCarry]) {
      const r = await invoke("head", map([[0, c]]), { resourceHeaders });
      assert.equal(r.status, 200);
      assert.equal(dec(Buffer.from(r.response)).get(3)?.get(0), "not_found", "public carry must be replaced by actual outer usage");
      assert.equal(r.forwarded, 1); assert.equal(r.r2writes, 0);
      assert.equal(await (await fetch(`${base}/debug/ingress_budget`)).text(), "0");
    }
  });
  await check("outer fake-zero cannot erase genuine resource spend across actor hop", async () => {
    const c = collection("carry/zero-cannot-reset");
    // Each hop alone fits: the same ~2200-head root decoded across both hops
    // cannot fit the shared 4096 budget. A fresh/reset actor budget would admit.
    const r = await invoke("create_log", map([[0, c], [1, genesis(c)]]), {
      rootPad: true, resourceHeaders: carry(0, 0, 0),
    });
    await budgetFailure(r);
    assert.equal(r.forwarded, 1, "outer individually legal root must reach actor");
    await headIs(c, undefined);
    await ordinary("create_log", map([[0, c], [1, genesis(c)]]), { n: r.nonce });
    await headIs(c, 1);
  });
  await check("resource carry is not authentication or proof authority", async () => {
    for (const actor of [false, true]) {
      const c = collection(`carry/${actor}/not-authority`);
      const r = await invoke("create_log", map([[0, c], [1, genesis(c)]]), {
        actor, proven: false, resourceHeaders: carry(0, 0, 0),
      });
      assert.equal(r.status, 200);
      assert.equal(dec(Buffer.from(r.response)).get(3)?.get(0), "unauthenticated");
      assert.ok(Buffer.from(r.response).includes(Buffer.from("possession")));
      assert.equal(r.forwarded, actor ? 0 : 1); assert.equal(r.r2writes, 0);
      assert.equal(await (await fetch(`${base}/debug/ingress_budget`)).text(), "0");
      await headIs(c, undefined);
      const retry = await invoke("head", map([[0, c]]), { actor, n: r.nonce, resourceHeaders: carry(0, 0, 0) });
      assert.equal(dec(Buffer.from(retry.response)).get(3)?.get(0), "not_found");
    }
  });
  // Keep each input tiny (~2-10KiB) and individually under the 4096-head limit.
  // Only the accumulated actual decode boundaries exceed the request cap.
  for (const actor of [false, true]) {
    const where = actor ? "actor" : "outer";
    await check(`${where} root/auth claims aggregation and nonce preservation`, async () => {
      const c = collection(`${where}/auth`);
      const makeToken = (n) => {
        const claims = legal(enc(padded(map([[0, 1], [2, pub(transport)], [3, Date.now() + 900000], [4, "mdbase-log"]]), n)));
        return `${claims.toString("hex")}.${sign(null, h("mdbase/v1/ls-token", claims), issuer).toString("hex")}`;
      };
      const control = await invoke("head", map([[0, c]]), { actor, tok: makeToken(100) });
      assert.equal(control.status, 200);
      assert.equal(dec(Buffer.from(control.response)).get(3)?.get(0), "not_found", "valid padded token/proof control");
      const tok = makeToken(padCount);
      const r = await invoke("head", map([[0, c]]), { actor, rootPad: true, tok });
      await budgetFailure(r);
      assert.equal(r.forwarded, 0, "exhausted outer root/claims must not forward");
      // This rejection happens before verified dispatch: nonce may be retried.
      const retry = await invoke("head", map([[0, c]]), { actor, n: r.nonce });
      assert.equal(dec(Buffer.from(retry.response)).get(3)?.get(0), "not_found");
      await headIs(c, undefined);
    });
    await check(`${where} valid token/unproven possession rejects without state`, async () => {
      const c = collection(`${where}/proof`);
      const r = await invoke("create_log", map([[0, c], [1, genesis(c, true, true)]]), { actor, proven: false });
      assert.equal(r.r2writes, 0);
      // Outer performs token/header/bounded-root admission; the collection
      // actor verifies HTTP possession. One outer forward is intentional.
      assert.equal(r.forwarded, actor ? 0 : 1);
      assert.equal(dec(Buffer.from(r.response)).get(3)?.get(0), "unauthenticated");
      assert.ok(Buffer.from(r.response).includes(Buffer.from("possession")));
      assert.equal(await (await fetch(`${base}/debug/ingress_budget`)).text(), "0");
      await headIs(c, undefined);
      // Invalid possession must not burn a valid nonce.
      const retry = await invoke("head", map([[0, c]]), { actor, n: r.nonce });
      assert.equal(dec(Buffer.from(retry.response)).get(3)?.get(0), "not_found");
    });
    await check(`${where} create Item/policy aggregation atomicity`, async () => {
      const c = collection(`${where}/create`);
      await budgetFailure(await invoke("create_log", map([[0, c], [1, genesis(c, true, true)]]), { actor }));
      await headIs(c, undefined);
      await ordinary("create_log", map([[0, c], [1, genesis(c)]]), { actor });
      await headIs(c, 1);
    });
    await check(`${where} append retained sibling Items aggregation`, async () => {
      const c = collection(`${where}/append`), g = genesis(c);
      await ordinary("create_log", map([[0, c], [1, g]]), { actor });
      const a = policy(c, 2, chain(g), [freeze()], false, true);
      const b = policy(c, 3, chain(a), [freeze()], false, true);
      await budgetFailure(await invoke("append", map([[0, c], [1, 2], [2, chain(g)], [3, [a, b]]]), { actor }));
      await headIs(c, 1);
    });
    await check(`${where} positioned import aggregation atomicity`, async () => {
      const c = collection(`${where}/import`), a = genesis(c, false, true);
      const b = policy(c, 2, chain(a), [freeze()], false, true);
      await budgetFailure(await invoke("import", map([[0, c], [1, [[1, a], [2, b]]]]), { actor }));
      await headIs(c, undefined);
      await ordinary("create_log", map([[0, c], [1, genesis(c)]]), { actor });
    });
    for (const grant of [false, true]) {
      await check(`${where} ${grant ? "keygrant" : "rekey"} Item/payload aggregation`, async () => {
        const c = collection(`${where}/${grant ? "keygrant" : "rekey"}`), g = genesis(c);
        const device = collection(`${where}/device`), dk = key(`sec061/${where}/device`);
        const enrol = map([[0, 2], [1, device], [2, collection("owner")], [3, 0],
          [4, pub(dk)], [5, Buffer.alloc(32, 3)], [6, Buffer.alloc(32, 4)]]);
        await ordinary("create_log", map([[0, c], [1, g]]), { actor });
        const e = policy(c, 2, chain(g), [enrol]);
        await ordinary("append", map([[0, c], [1, 2], [2, chain(g)], [3, [e]]]), { actor });
        const claims = enc(map([[0, 0], [1, device], [2, pub(dk)], [3, Date.now() + 900000], [4, "mdbase-log"], [5, c]]));
        const tok = `${claims.toString("hex")}.${sign(null, h("mdbase/v1/ls-token", claims), issuer).toString("hex")}`;
        const options = { actor, tok, signer: dk };
        const wrap = map([[0, device], [1, Buffer.alloc(32, 5)], [2, Buffer.alloc(48, 7)]]);
        const rekey = map([[0, 1], [1, 1], [2, 0], [3, sha(Buffer.from("commit"))], [4, [wrap]],
          [5, map([[0, Buffer.alloc(16, 1)], [1, Buffer.alloc(32, 2)]])], [6, 0]]);
        function deviceItem(seq, prev, kind, body, malicious) {
          if (malicious) body = padded(body);
          let item = map([[0, 1], [1, kind], [2, c], [3, seq], [4, prev], [6, device], [11, legal(enc(body))]]);
          item.set(12, sign(null, h("mdbase/v1/item-sig", enc(item)), dk));
          if (malicious) item = padded(item);
          return legal(enc(item));
        }
        let prev = chain(e), seq = 3;
        if (grant) {
          const r = deviceItem(3, prev, 3, rekey, false);
          await ordinary("append", map([[0, c], [1, 3], [2, prev], [3, [r]]]), options);
          prev = chain(r); seq = 4;
        }
        const body = grant ? map([[0, 1], [1, device], [2, 1], [3, wrap]]) : rekey;
        const raw = deviceItem(seq, prev, grant ? 4 : 3, body, true);
        await budgetFailure(await invoke("append", map([[0, c], [1, seq], [2, prev], [3, [raw]]]), options));
        await headIs(c, seq - 1);
        const honest = deviceItem(seq, prev, grant ? 4 : 3, body, false);
        await ordinary("append", map([[0, c], [1, seq], [2, prev], [3, [honest]]]), options);
        await headIs(c, seq);
      });
    }
  }
  await check("direct PUT verifyUpload shared metadata work and opaque ciphertext", async () => {
    const c = collection("upload"), secret = sha(Buffer.from("conformance/url-secret"));
    // Body intentionally looks like an over-budget CBOR array: it is ciphertext.
    const opaque = enc(Array(4097).fill(0));
    const item = map([[0, 1], [1, 17], [2, c], [5, 1], [7, Buffer.alloc(16)], [11, opaque]]);
    async function put(bytes) {
      const ck = sha(bytes), dev = Buffer.alloc(16, 0x54), exp = Date.now() + 60000;
      const mac = createHmac("sha256", secret).update(`ls-direct|put|${c.toString("hex")}|${ck.toString("hex")}|${dev.toString("hex")}|${bytes.length}|${ck.toString("hex")}|${exp}`).digest("hex");
      const url = `https://worker/v1/o/${uuid(c)}/${ck.toString("hex")}?op=put&dev=${dev.toString("hex")}&size=${bytes.length}&ck=${ck.toString("hex")}&exp=${exp}&sig=${mac}`;
      const r = await fetch(`${base}/__test/ingress`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        method: "PUT", url, size: bytes.length, prefix: bytes.toString("base64"), chunk: 127,
        headers: { "x-amz-checksum-sha256": ck.toString("base64") },
      }) });
      assert.equal(r.status, 200); return r.json();
    }
    assert.equal((await put(enc(item))).status, 200, "never recursively decode ciphertext");
    await budgetFailure(await put(legal(enc(padded(item)))));
  });
  assert.deepEqual(failures, [], "SEC061 aggregate paths must all reject safely");
}
