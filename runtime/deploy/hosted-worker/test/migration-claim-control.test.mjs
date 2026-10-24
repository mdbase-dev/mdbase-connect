import assert from "node:assert/strict";
import { test } from "node:test";
import { ControlClient, ControlError } from "../src/control.ts";

const collection = "11111111-1111-4111-8111-111111111111", device = "12121212-1212-4212-8212-121212121212";
const token = "synthetic-hosted-".repeat(4), challenge = "55".repeat(32), sig = "66".repeat(64);
const proof = () => ({ device_id: device, challenge, sig });
const data = () => ({ schema: "mdbase-migration-claim/1", collection_id: collection,
  owner_account: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", started_us: "10413792000000001",
  target: { runtime: "shadow", root_key_id: "13".repeat(16), hosted: { device_id: device,
    sign_pk: "43".repeat(32), kem_pk: "44".repeat(32), noise_pk: "47".repeat(32) } } });
const client = (fetch, extra = {}) => new ControlClient({ url: "https://cp.test", token, ...extra }, fetch);
const signal = () => new AbortController().signal;
const invalid = error => error instanceof ControlError && error.code === "invalid";

// Synthetic channel/DTO tests only: no actual native signer/FULL, trusted
// factory/HTTPS integration, physical namespace, pending or H1 authority.
test("challenge/read exact POST wire, existing role credential, no redirects/cache/retry, exact microseconds DATA", async () => {
  const calls = [];
  const cp = client(async (url, init) => {
    calls.push([url, init]);
    return Response.json(url.endsWith("/challenge") ? { challenge } : data());
  });
  assert.deepEqual(await cp.migrationClaimChallenge(collection, device, signal()), new Uint8Array(32).fill(0x55));
  assert.deepEqual(await cp.migrationClaimRead(collection, proof(), signal()), data());
  assert.equal(calls.length, 2);
  for (const [url, init] of calls) {
    assert.ok(url.startsWith(`https://cp.test/internal/v1/next/migration/collections/${collection}/claim/`));
    assert.equal(init.method, "POST"); assert.equal(init.redirect, "manual"); assert.equal(init.cache, "no-store");
    assert.equal(init.headers.authorization, `Bearer ${token}`);
  }
  assert.deepEqual(JSON.parse(calls[0][1].body), { device_id: device });
  assert.deepEqual(JSON.parse(calls[1][1].body), proof());
  assert.equal(await cp.migrationClaimRead(collection, proof(), signal()).then(r => r.started_us), "10413792000000001");
  assert.equal(calls.length, 3, "uncached fresh read");
});

test("closed role/origin/subject/proof inputs refuse before fetch", async () => {
  let calls = 0; const fetch = async () => { calls++; throw Error("unexpected fetch"); };
  for (const extra of [{ kind: "escrow" }, { url: "https://cp.test/path" }, { url: "https://u:p@cp.test" }, { url: "https://cp.test?q=1" }, { url: "https://[::1]" }]) {
    await assert.rejects(client(fetch, extra).migrationClaimChallenge(collection, device, signal()), invalid);
  }
  const cp = client(fetch);
  for (const bad of [collection + "\n", collection.toUpperCase(), "00000000-0000-0000-0000-000000000000", "../other", "bad"]) {
    if (bad === collection) continue;
    await assert.rejects(cp.migrationClaimChallenge(bad, device, signal()), invalid);
  }
  for (const bad of [{ ...proof(), sig: sig + "\n" }, { ...proof(), challenge: challenge + "\n" },
    { ...proof(), owner: data().owner_account }, { ...proof(), audience: "https://other.test" },
    { ...proof(), device_id: device + "\n" }, { ...proof(), sig: "AA".repeat(64) }, { ...proof(), sig: "00".repeat(65) }]) {
    await assert.rejects(cp.migrationClaimRead(collection, bad, signal()), invalid);
  }
  assert.equal(calls, 0);
});

test("challenge reply must be ONLY the canonical 32-byte nonce", async () => {
  for (const body of [null, [], {}, { challenge: challenge + "\n" }, { challenge: "AA".repeat(32) },
    { challenge: "55".repeat(33) }, { challenge, ttl: 10 }, { challenge, verified: true }]) {
    await assert.rejects(client(async () => Response.json(body)).migrationClaimChallenge(collection, device, signal()), invalid);
  }
});

test("claim DATA schema/collection/device/owner/start/current target/keys exact and closed", async () => {
  const cases = [r => { r.collection_id = device; }, r => { r.owner_account = "00000000-0000-0000-0000-000000000000"; },
    r => { r.started_us = 10413792000000001; }, r => { r.started_us += "\n"; }, r => { r.target = null; },
    r => { r.target.runtime = "next"; }, r => { r.target.hosted.device_id = collection; },
    r => { r.target.root_key_id += "\n"; }, r => { r.target.hosted.sign_pk = "0".repeat(64); },
    r => { r.target.hosted.kem_pk += "\n"; }, r => { r.target.hosted.noise_pk = "47".repeat(33); },
    r => { r.target.hosted.wrapped_keys = "must not leak"; }, r => { r.verified = true; }, r => { r.schema = "other"; }];
  for (const change of cases) {
    const r = data(); change(r);
    await assert.rejects(client(async () => Response.json(r)).migrationClaimRead(collection, proof(), signal()), invalid);
  }
});

test("bad status/redirect/network produce one attempt only, never renewal/read fallback", async () => {
  for (const status of [301, 302, 307, 308, 400, 401, 403, 404, 409, 429, 500, 503]) {
    let calls = 0;
    const cp = client(async () => { calls++; return new Response("not a claim", { status, headers: { location: "https://other.test" } }); });
    await assert.rejects(cp.migrationClaimRead(collection, proof(), signal()), ControlError);
    assert.equal(calls, 1);
  }
  let calls = 0;
  const cp = client(async () => { calls++; throw Error("private URL credential response text must not escape"); });
  await assert.rejects(cp.migrationClaimChallenge(collection, device, signal()), e => e instanceof ControlError && !e.message.includes("private"));
  assert.equal(calls, 1);
});

test("byte/read bounds, malformed JSON/UTF8 and body errors fail closed", async () => {
  for (const response of [new Response("x".repeat(4097)), new Response("not JSON"), new Response(new Uint8Array([0xff])),
    new Response(new ReadableStream({ start(c) { for (let n = 0; n < 65; n++) c.enqueue(Uint8Array.of(32)); c.close(); } }))]) {
    await assert.rejects(client(async () => response).migrationClaimRead(collection, proof(), signal()), ControlError);
  }
  await assert.rejects(client(async () => new Response("x".repeat(1025))).migrationClaimChallenge(collection, device, signal()), invalid);
});

test("already-aborted and abort during body await emit no challenge or DATA", async () => {
  const abort = new AbortController(); abort.abort(); let calls = 0;
  await assert.rejects(client(async () => { calls++; return Response.json({ challenge }); }).migrationClaimChallenge(collection, device, abort.signal), ControlError);
  assert.equal(calls, 0);
  const pendingAbort = new AbortController();
  const cp = client(async () => new Response(new ReadableStream({ pull() { pendingAbort.abort(); return new Promise(() => {}); } })));
  await assert.rejects(cp.migrationClaimRead(collection, proof(), pendingAbort.signal), ControlError);
});

test("hard CPP deadline bounds even a fetch implementation that ignores abort", { timeout: 7000 }, async () => {
  const start = Date.now(); let calls = 0;
  const cp = client(async () => { calls++; return new Promise(() => {}); });
  await assert.rejects(cp.migrationClaimChallenge(collection, device, signal()), ControlError);
  assert.equal(calls, 1); assert.ok(Date.now() - start < 6500);
});
