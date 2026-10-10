import assert from "node:assert/strict";
import { createHmac, sign } from "node:crypto";
export async function ingressCases({
  base,
  token,
  transport,
  c,
  cid,
  encode,
  map,
  sha,
  h,
}) {
  const cap = 10 * 1024 * 1024,
    objectCap = 9 * 1024 * 1024;
  const normal = encode(
    map([
      [0, 0],
      [1, 1],
      [2, "head"],
      [3, map([[0, c]])],
    ]),
  );
  const nonce = async () =>
    Buffer.from(await (await fetch(`${base}/v1/nonce`)).text(), "hex");
  function headers(body, n) {
    return {
      authorization: `Bearer ${token}`,
      "x-mdbase-nonce": n.toString("hex"),
      "x-mdbase-sig": sign(
        null,
        h(
          "mdbase/v1/ls-http",
          Buffer.concat([
            Buffer.from("head\0/v1/rpc\0"),
            c,
            sha(Buffer.from(token)),
            sha(body),
            n,
          ]),
        ),
        transport,
      ).toString("hex"),
    };
  }
  async function run(q) {
    const r = await fetch(`${base}/__test/ingress`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(q),
    });
    assert.equal(r.status, 200);
    return r.json();
  }
  async function retry(n) {
    const r = await fetch(`${base}/v1/rpc`, {
      method: "POST",
      headers: headers(normal, n),
      body: normal,
    });
    assert.equal(r.status, 200);
    const b = Buffer.from(await r.arrayBuffer());
    assert.ok(b.includes(Buffer.from("not_found")));
    assert.ok(!b.includes(Buffer.from("replay")));
  }
  // Determine the prefix without transferring the large zero payload in JSON.
  function padded(size) {
    let n = size - 64,
      b;
    for (;;) {
      b = encode(
        map([
          [0, 0],
          [1, 1],
          [2, "head"],
          [
            3,
            map([
              [0, c],
              [99, Buffer.alloc(n)],
            ]),
          ],
        ]),
      );
      if (b.length === size)
        return { b, prefix: b.subarray(0, size - n).toString("base64") };
      n += size - b.length;
    }
  }
  const exact = padded(cap),
    over = padded(cap + 1);
  for (const actor of [false, true]) {
    const where = actor
      ? { actor: cid, url: `https://do/v1/rpc?c=${cid}` }
      : { url: "https://worker/v1/rpc" };
    const wide = Buffer.from([0x9a, 0, 0x60, 0, 0]);
    const global = Buffer.concat([
      Buffer.from([0x82, 0x99, 8, 0]),
      Buffer.alloc(2048, 0xf6),
      Buffer.from([0x99, 8, 0]),
      Buffer.alloc(2048, 0xf6),
    ]);
    const deep = Buffer.concat([Buffer.alloc(129, 0x81), Buffer.from([0xf6])]);
    for (const [prefix, size, reason, nodes] of [
      [wide, 6 * 1024 * 1024 + 5, "cbor_nodes", 1],
      [global, global.length, "cbor_nodes", undefined],
      [deep, deep.length, "cbor_depth", undefined],
    ]) {
      const n = await nonce();
      const r = await run({
        ...where,
        size,
        prefix: prefix.toString("base64"),
        fill: 0xf6,
        headers: headers(normal, n),
        chunk: 65536,
      });
      assert.equal(r.status, 400);
      assert.equal(r.cborReason, reason);
      assert.equal(r.cborDecoded, "0");
      assert.ok(Number(r.cborNodes) <= 4096);
      if (nodes !== undefined) assert.equal(Number(r.cborNodes), nodes);
      assert.equal(r.forwarded, 0);
      assert.equal(r.r2writes, 0);
      await retry(n);
      assert.equal(
        await (await fetch(`${base}/debug/ingress_budget`)).text(),
        "0",
      );
    }
    for (const length of [undefined, "1", String(cap * 3)]) {
      const n = await nonce();
      const hd = headers(over.b, n);
      if (length !== undefined) hd["content-length"] = length;
      const r = await run({
        ...where,
        size: cap + 1,
        prefix: over.prefix,
        chunk: 7000,
        headers: hd,
      });
      assert.equal(r.status, 413);
      assert.equal(r.emitted, cap + 1);
      assert.ok(r.maxView <= 65536);
      assert.equal(
        r.cancelled,
        true,
        JSON.stringify({ actor, length, ...r, response: undefined }),
      );
      assert.equal(r.forwarded, 0);
      assert.equal(r.r2writes, 0);
      await retry(n);
    }
    for (const length of [undefined, "1", String(cap * 3)]) {
      const n = await nonce(),
        hd = headers(exact.b, n);
      if (length !== undefined) hd["content-length"] = length;
      const r = await run({
        ...where,
        size: cap,
        prefix: exact.prefix,
        chunk: 4093,
        headers: hd,
      });
      assert.equal(
        r.status,
        200,
        JSON.stringify({ ...r, response: Buffer.from(r.response).toString() }),
      );
      assert.equal(r.emitted, cap);
      assert.ok(Buffer.from(r.response).includes(Buffer.from("not_found")));
      assert.ok(!r.cancelled);
    }
    const bigNonce = await nonce();
    const big = await run({
      ...where,
      size: cap + 1,
      prefix: over.prefix,
      chunk: cap + 1,
      oversizedChunk: true,
      headers: headers(over.b, bigNonce),
    });
    assert.equal(big.status, 413);
    assert.ok(big.maxView <= 65536);
    assert.ok(big.cancelled);
    await retry(bigNonce);
    for (const abort of [false, true]) {
      const n = await nonce();
      const r = await run({
        ...where,
        size: cap,
        prefix: exact.prefix,
        chunk: 4096,
        errorAt: 8192,
        abort,
        headers: headers(exact.b, n),
      });
      assert.equal(r.status, 400);
      assert.equal(r.emitted, 8192);
      assert.equal(r.forwarded, 0);
      assert.equal(r.r2writes, 0);
      await retry(n);
    }
    const early = await run({ ...where, size: cap + 1, headers: {} });
    assert.equal(early.status, 401);
    assert.equal(early.emitted, 0);
    assert.equal(early.pulls, 0);
    assert.ok(early.cancelled);
  }
  // Nonwaiting lifetime credits: simultaneous reads reject before any bytes;
  // after cancellation/error every credit must be released, including actors
  // sharing this module/isolate. No queued waiter may retain a partial body.
  for (const mode of ["outer", "actor", "multi-actor"]) {
    const ns = await Promise.all([nonce(), nonce(), nonce()]);
    const qs = ns.map((n, i) => ({
      url: `https://do/v1/rpc?c=${cid}`,
      size: cap,
      prefix: exact.prefix,
      headers: headers(exact.b, n),
      chunk: 4096,
      errorAt: 8192,
      delay: 25,
      ...(mode === "outer"
        ? {}
        : {
            actor:
              mode === "multi-actor"
                ? `7d7d7d7d-7d7d-7d7d-7d7d-${String(i + 1).padStart(12, "0")}`
                : cid,
          }),
    }));
    const rs = await run({ parallel: qs });
    assert.deepEqual(
      rs.map((r) => r.status),
      [400, 503, 503],
      mode,
    );
    for (const r of rs) {
      assert.equal(r.forwarded, 0);
      assert.equal(r.r2writes, 0);
    }
    assert.equal(rs[1].emitted, 0);
    assert.equal(rs[2].emitted, 0);
    for (const n of ns) await retry(n);
  }
  // Actual network chunked transfer, rather than the instrumented native
  // streams above. No Content-Length is supplied; real Worker ingress is used.
  for (const whole of [normal, over.b]) {
    const n = await nonce();
    let offset = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (offset === whole.length) {
          controller.close();
          return;
        }
        const end = Math.min(offset + 16384, whole.length);
        controller.enqueue(whole.subarray(offset, end));
        offset = end;
      },
    });
    const r = await fetch(`${base}/v1/rpc`, {
      method: "POST",
      headers: headers(whole, n),
      body: stream,
      duplex: "half",
    });
    assert.equal(r.status, whole === normal ? 200 : 413);
    if (whole !== normal) await retry(n);
  }
  // Signed direct PUT: the URL authenticates the expected size before reading.
  const dev = Buffer.alloc(16, 0x54),
    secret = sha(Buffer.from("conformance/url-secret"));
  function objectUrl(bytes, size = bytes.length) {
    const ck = sha(bytes),
      address = sha(bytes),
      exp = Date.now() + 60000;
    const mac = createHmac("sha256", secret)
      .update(
        `ls-direct|put|${c.toString("hex")}|${address.toString("hex")}|${dev.toString("hex")}|${size}|${ck.toString("hex")}|${exp}`,
      )
      .digest("hex");
    return {
      url: `https://worker/v1/o/${cid}/${address.toString("hex")}?op=put&dev=${dev.toString("hex")}&size=${size}&ck=${ck.toString("hex")}&exp=${exp}&sig=${mac}`,
      headers: { "x-amz-checksum-sha256": ck.toString("base64") },
    };
  }
  let n = objectCap - 64,
    object;
  for (;;) {
    object = encode(
      map([
        [0, 1],
        [1, 17],
        [2, c],
        [5, 1],
        [7, Buffer.alloc(16)],
        [11, Buffer.alloc(n)],
      ]),
    );
    if (object.length === objectCap) break;
    n += objectCap - object.length;
  }
  const prefix = object.subarray(0, objectCap - n).toString("base64");
  // Inject PUT rather than POST in the wrapper.
  const exactPut = await run({
    ...objectUrl(object),
    method: "PUT",
    size: objectCap,
    prefix,
    chunk: 7000,
  });
  assert.equal(exactPut.status, 200);
  assert.equal(exactPut.emitted, objectCap);
  for (const length of [undefined, "1", String(objectCap + 100)]) {
    const spec = objectUrl(object);
    if (length !== undefined) spec.headers["content-length"] = length;
    const r = await run({
      ...spec,
      method: "PUT",
      size: objectCap + 1,
      prefix,
      chunk: 7000,
    });
    assert.equal(r.status, 413);
    assert.equal(r.emitted, objectCap + 1);
    assert.ok(r.cancelled);
    assert.equal(r.r2writes, 0);
  }
  const declared = await run({
    ...objectUrl(object, objectCap + 1),
    method: "PUT",
    size: objectCap + 1,
    prefix,
    chunk: 4096,
  });
  assert.equal(declared.status, 413);
  assert.equal(declared.emitted, 0);
  const badUrl = await run({
    method: "PUT",
    url: `https://worker/v1/o/${cid}/${sha(object).toString("hex")}?op=put`,
    size: objectCap + 1,
  });
  assert.equal(badUrl.status, 403);
  assert.equal(badUrl.emitted, 0);
  // Keep lifetime credits while R2 holds its JS/WASM copies after the input
  // reader has completed. A concurrent maximum RPC must fail without reading.
  const heldNonce = await nonce();
  const held = await run({
    afterPut: [
      {
        ...objectUrl(object),
        method: "PUT",
        size: objectCap,
        prefix,
        chunk: 65536,
        delayPut: 100,
      },
      { size: cap, prefix: exact.prefix, headers: headers(exact.b, heldNonce) },
    ],
  });
  assert.deepEqual(
    held.map((r) => r.status),
    [200, 503],
  );
  assert.equal(held[1].emitted, 0);
  assert.equal(held[1].r2writes, 0);
  await retry(heldNonce);
  console.log(
    "PASS: bounded ingress outer+actor RPC/PUT; absent/lying lengths, exact cap/cap+1, oversized chunks, error/abort, early auth and nonce preservation",
  );
}
