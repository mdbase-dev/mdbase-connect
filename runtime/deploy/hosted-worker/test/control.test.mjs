// The deployment's control-plane client, over a fake fetch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ControlClient } from "../src/control.ts";

const collection = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";
const device = "11111111-1111-4111-8111-111111111111";
const record = { kind: "hosted", device_id: device, sign_pk: "aa".repeat(32), kem_pk: "bb".repeat(32), noise_pk: "cc".repeat(32), wrapped_keys: Buffer.from("env").toString("base64"), kms_key_arn: "arn:aws:kms:x", genesis: { seq: 1, item: Buffer.from("unit-origin").toString("base64"), hash: "dd".repeat(32) } };
const config = { url: "https://cp.test/", token: "t".repeat(40) };
const signal = () => new AbortController().signal;

function fake(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url: String(url), init }); return handler(String(url), init); };
  return { calls, fetchImpl };
}

test("reads and validates the hosted record", async () => {
  const { calls, fetchImpl } = fake(() => new Response(JSON.stringify(record)));
  const r = await new ControlClient(config, fetchImpl).serviceDevice(collection, signal());
  assert.equal(calls[0].url, `https://cp.test/internal/v1/next/collections/${collection}/service-devices/hosted`);
  assert.equal(calls[0].init.headers.authorization, `Bearer ${config.token}`);
  assert.equal(calls[0].init.redirect, "manual", "workerd rejects redirect: error; never follow");
  assert.equal(r.deviceId, device);
  assert.equal(Buffer.from(r.wrappedKeys).toString(), "env");
  for (const bad of [{ ...record, kind: "escrow" }, { ...record, sign_pk: "AA".repeat(32) }, { ...record, wrapped_keys: "" }, { ...record, extra: 1 }, { ...record, kms_key_arn: "x" }]) {
    const { fetchImpl: f } = fake(() => new Response(JSON.stringify(bad)));
    await assert.rejects(new ControlClient(config, f).serviceDevice(collection, signal()), { code: "invalid" });
  }
});

test("original genesis is mandatory exact bounded canonical structure, not authority", async () => {
  for (const genesis of [undefined, {}, { ...record.genesis, seq: 2 }, { ...record.genesis, hash: "DD".repeat(32) },
    { ...record.genesis, item: "" }, { ...record.genesis, item: "Zh==" }, { ...record.genesis, extra: true },
    { ...record.genesis, item: Buffer.alloc(65537).toString("base64") }]) {
    const { fetchImpl } = fake(() => Response.json({ ...record, genesis }));
    await assert.rejects(new ControlClient(config, fetchImpl).serviceDevice(collection, signal()), { code: "invalid" });
  }
  const { fetchImpl } = fake(() => Response.json(record));
  const g = (await new ControlClient(config, fetchImpl).serviceDevice(collection, signal())).genesis;
  assert.equal(g.seq, 1);
  assert.equal(Buffer.from(g.item).toString(), "unit-origin");
  assert.deepEqual(g.hash, new Uint8Array(32).fill(0xdd));
});

test("maps statuses, bounds answers, refuses http", async () => {
  for (const [status, code] of [[409, "not_standard"], [404, "not_found"], [503, "unavailable"], [403, "refused"]]) {
    const { fetchImpl } = fake(() => new Response("x", { status }));
    await assert.rejects(new ControlClient(config, fetchImpl).serviceDevice(collection, signal()), { code });
  }
  const { fetchImpl: big } = fake(() => new Response("x".repeat(200 * 1024)));
  await assert.rejects(new ControlClient(config, big).serviceDevice(collection, signal()), { code: "invalid" });
  const { fetchImpl: down } = fake(() => { throw new TypeError("down"); });
  await assert.rejects(new ControlClient(config, down).serviceDevice(collection, signal()), { code: "unavailable" });
  assert.throws(() => new ControlClient({ ...config, url: "http://cp.test" }));
  assert.throws(() => new ControlClient({ ...config, token: "short" }));
});

test("GET and POST invoke fetch without a ControlClient receiver (Workers native fetch)", async () => {
  let calls = 0;
  function fetchImpl(_url, init) {
    assert.equal(this, undefined, "Workers native fetch rejects an object receiver");
    calls += 1;
    return Promise.resolve(new Response(JSON.stringify(init.method === "GET" ? record : {
      token: `ab.${"cd".repeat(64)}`, expires_at: Date.now() + 15 * 60_000,
    })));
  }
  const client = new ControlClient(config, fetchImpl);
  assert.equal((await client.serviceDevice(collection, signal())).kind, "hosted");
  await client.logToken(device, collection, signal());
  assert.equal(calls, 2);
});

test("unreachable diagnostics are fixed categories, never arbitrary fetch messages", async () => {
  const privateText = "Bearer do-not-expose-token https://cp.test/private?collection=hidden";
  for (const [error, reason] of [
    [new TypeError(privateText), "type_error"],
    [new Error(privateText), "network"],
    [new DOMException(privateText, "TimeoutError"), "timeout"],
    [new DOMException(privateText, "AbortError"), "aborted"],
    [new Error(`Cannot perform I/O on behalf of a different request: ${privateText}`), "io_context"],
    [new TypeError(`signal is not an AbortSignal: ${privateText}`), "signal_type"],
  ]) {
    const { fetchImpl } = fake(() => { throw error; });
    await assert.rejects(new ControlClient(config, fetchImpl).serviceDevice(collection, signal()), {
      code: "unavailable", message: `control plane unreachable (${reason})`,
    });
  }
  const controller = new AbortController();
  controller.abort(privateText);
  const { fetchImpl } = fake(() => { throw new Error(privateText); });
  await assert.rejects(new ControlClient(config, fetchImpl).serviceDevice(collection, controller.signal), {
    code: "unavailable", message: "control plane unreachable (caller_aborted)",
  });
});

test("caches the log token and refreshes it a minute before expiry", async () => {
  let now = 1_000_000;
  let n = 0;
  const { calls, fetchImpl } = fake((_url, init) => {
    assert.deepEqual(JSON.parse(init.body), { collection });
    n += 1;
    return new Response(JSON.stringify({ token: `${"ab".repeat(n)}.${"cd".repeat(64)}`, expires_at: now + 15 * 60_000 }));
  });
  const client = new ControlClient(config, fetchImpl, () => now);
  const first = await client.logToken(device, collection, signal());
  assert.equal(calls[0].url, `https://cp.test/internal/v1/next/service-devices/${device}/log-token`);
  assert.deepEqual(await client.logToken(device, collection, signal()), first);
  now += 14 * 60_000 - 1;
  assert.deepEqual(await client.logToken(device, collection, signal()), first);
  now += 2;
  assert.notDeepEqual(await client.logToken(device, collection, signal()), first);
  assert.equal(calls.length, 2);
  client.forget(collection);
  await client.logToken(device, collection, signal());
  assert.equal(calls.length, 3);
});

test("refuses malformed or over-long tokens", async () => {
  const now = 5_000_000;
  for (const body of [{ token: "zz.zz", expires_at: now + 600_000 }, { token: `ab.${"cd".repeat(64)}`, expires_at: now + 60 * 60_000 }, { token: `ab.${"cd".repeat(64)}`, expires_at: now }]) {
    const { fetchImpl } = fake(() => new Response(JSON.stringify(body)));
    await assert.rejects(new ControlClient(config, fetchImpl, () => now).logToken(device, collection, signal()), { code: "invalid" });
  }
});

test("refuses redirects explicitly (the bearer is never forwarded)", async () => {
  for (const status of [301, 302, 307, 308]) {
    const { fetchImpl, calls } = fake(() => new Response(null, { status, headers: { location: "https://evil.test/" } }));
    await assert.rejects(new ControlClient(config, fetchImpl).serviceDevice(collection, signal()), { code: "refused" });
    assert.equal(calls.length, 1, "not followed");
  }
  const opaque = { type: "opaqueredirect", status: 0, ok: false, body: null };
  const { fetchImpl } = fake(() => opaque);
  await assert.rejects(new ControlClient(config, fetchImpl).logToken(device, collection, signal()), { code: "refused" });
});

test("an escrow deployment reads only escrow records", async () => {
  const esc = { ...record, kind: "escrow" };
  const { calls, fetchImpl } = fake(() => new Response(JSON.stringify(esc)));
  const r = await new ControlClient({ ...config, kind: "escrow" }, fetchImpl).serviceDevice(collection, signal());
  assert.equal(r.kind, "escrow");
  assert.ok(calls[0].url.endsWith("/service-devices/escrow"));
  const { fetchImpl: f } = fake(() => new Response(JSON.stringify(record)));
  await assert.rejects(new ControlClient({ ...config, kind: "escrow" }, f).serviceDevice(collection, signal()), { code: "invalid" });
});
