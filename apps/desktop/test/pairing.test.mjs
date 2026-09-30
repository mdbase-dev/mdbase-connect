import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
const { ComputerPairing } = createRequire(import.meta.url)("../dist/main/pairing.js");

const creation = { pairing_id: "request", pairing_secret: "pair_123456789012345678901234", verification_uri: "https://connect.test/pair/request", expires_in: 600 };

function harness(t, exchange) {
  let exchanges = 0;
  let configurations = 0;
  let completed = 0;
  const browsers = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).endsWith("/v1/pairing-requests")) return Response.json(creation);
    exchanges++;
    return exchange(exchanges);
  });
  const pairing = new ComputerPairing({
    openBrowser: async (url) => { browsers.push(url); },
    configure: async () => { configurations++; },
    completed: () => { completed++; }
  });
  return { pairing, browsers, counts: () => ({ exchanges, configurations, completed }) };
}

test("retries a failed exchange and reopens the same trusted request", async (t) => {
  const { pairing, browsers, counts } = harness(t, (attempt) => {
    if (attempt === 1) throw new Error("Network unavailable");
    return Response.json({ status: "paired", token: "connector-token" });
  });
  const request = await pairing.begin("https://connect.test", "Computer");
  await pairing.reopen(request.pairingId);
  await assert.rejects(pairing.status(request.pairingId), /Network unavailable/);
  assert.deepEqual(await pairing.status(request.pairingId), { status: "paired", connector: undefined });
  assert.deepEqual(browsers, [creation.verification_uri]);
  assert.deepEqual(counts(), { exchanges: 2, configurations: 1, completed: 1 });
});

test("coalesces concurrent polls and retries local configuration without re-exchanging a consumed token", async (t) => {
  let release;
  let exchanges = 0;
  let attempts = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).endsWith("/v1/pairing-requests")) return Response.json(creation);
    exchanges++;
    await new Promise((resolve) => { release = resolve; });
    return Response.json({ status: "paired", token: "same-token" });
  });
  const pairing = new ComputerPairing({
    openBrowser: async () => {}, completed: () => {},
    configure: async (_server, token) => {
      assert.equal(token, "same-token");
      if (++attempts === 1) throw new Error("Connector still starting");
    }
  });
  await pairing.begin("https://connect.test", "Computer");
  const first = pairing.status("request");
  const second = pairing.status("request");
  release();
  const results = await Promise.allSettled([first, second]);
  assert.ok(results.every((result) => result.status === "rejected"));
  await pairing.status("request");
  assert.equal(exchanges, 1);
  assert.equal(attempts, 2);
});

test("rejects untrusted browser addresses and expired requests", async (t) => {
  const { pairing } = harness(t, () => Response.json({}, { status: 202 }));
  t.mock.method(globalThis, "fetch", async () => Response.json({ ...creation, verification_uri: "https://evil.test/pair/request" }));
  await assert.rejects(pairing.begin("https://connect.test", "Computer"), /untrusted/);
  t.mock.method(globalThis, "fetch", async () => Response.json(creation));
  await pairing.begin("https://connect.test", "Computer");
  t.mock.method(Date, "now", () => Number.MAX_SAFE_INTEGER);
  await assert.rejects(pairing.status("request"), /expired/);
  await assert.rejects(pairing.reopen("request"), /expired/);
});
