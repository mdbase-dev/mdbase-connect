// Custody over control-plane records: reads only its own kind, opens with the stub
// bound to the record, mints its token through the CP, and refuses on any CP refusal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpCustody, combinedCustody } from "../src/cp-custody.ts";
import { ControlClient } from "../src/control.ts";
import { labStubUnwrap, labStubWrapper } from "../src/custody-stub.ts";

const K = "ab".repeat(32);
const col = "61616161-6161-4161-8161-616161616161";
const dev = "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c";
const token = "t".repeat(40);
// Structural/ordering mocks only; actual signatures are qualified natively.
const genesis = () => ({ seq: 1, item: Uint8Array.of(0xa0), hash: new Uint8Array(32).fill(0xdd) });
const publicKeys = () => ({ signPk: new Uint8Array(32).fill(0xaa), kemPk: new Uint8Array(32).fill(0xbb), noisePk: new Uint8Array(32).fill(0xcc) });
const unitRecord = () => ({ kind: "escrow", deviceId: dev, wrappedKeys: Uint8Array.of(1), kmsKeyArn: "arn:aws:kms:lab-stub:000000000000:key/x", ...publicKeys(), genesis: genesis() });
const pins = { roots: [new Uint8Array(32).fill(0x11)], policyPins: Uint8Array.of(0x80), verifyOriginal: () => true, derive: publicKeys };

async function cp(kind = "escrow", wrapCol = col) {
  const secret = Uint8Array.from({ length: 96 }, (_, i) => i + 1);
  const { envelope } = await labStubWrapper("escrow", K).wrapDeviceKeys({ collection: wrapCol, device: dev, secret }, AbortSignal.timeout(1000));
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, auth: init.headers.authorization, body: init.body });
    if (url.endsWith(`/collections/${col}/service-devices/escrow`)) {
      return Response.json({ kind, device_id: dev, sign_pk: "aa".repeat(32), kem_pk: "bb".repeat(32), noise_pk: "cc".repeat(32), wrapped_keys: Buffer.from(envelope).toString("base64"), kms_key_arn: "arn:aws:kms:lab-stub:000000000000:key/x", genesis: { seq: 1, item: "oA==", hash: "dd".repeat(32) } });
    }
    if (url.endsWith(`/service-devices/${dev}/log-token`)) return Response.json({ token: `${"ab".repeat(8)}.${"cd".repeat(64)}`, expires_at: Date.now() + 10 * 60_000 });
    return new Response("{}", { status: 409 });
  };
  const control = new ControlClient({ url: "https://cp.test", token, kind: "escrow" }, fetchImpl);
  return { seen, c: cpCustody({ kind: "escrow", control, ...pins,
    unwrap: (k, c2, d, e, s) => labStubUnwrap(K, k, c2, d, e, s) }) };
}

test("opens its own record with the stub and mints through the CP", async () => {
  const { c, seen } = await cp();
  const keys = await c.openSealer(col, AbortSignal.timeout(1000));
  assert.equal(keys.deviceId, dev);
  assert.deepEqual([...keys.signSk.subarray(0, 3)], [1, 2, 3]);
  assert.deepEqual([...keys.kemSk.subarray(0, 3)], [33, 34, 35]);
  assert.equal(keys.roots.length, 1);
  keys.zeroize();
  assert.ok(keys.signSk.every((b) => b === 0));
  assert.equal(await c.logToken(col, AbortSignal.timeout(1000)), `${"ab".repeat(8)}.${"cd".repeat(64)}`);
  assert.ok(seen.every((s) => s.auth === `Bearer ${token}`));
  assert.equal(JSON.parse(seen.find(s => s.body).body).collection, col);
});

test("refuses another kind, another collection's envelope and CP refusals", async () => {
  await assert.rejects((await cp("hosted")).c.openSealer(col, AbortSignal.timeout(1000)));
  await assert.rejects((await cp("escrow", "62626262-6262-4262-8262-626262626262")).c.openSealer(col, AbortSignal.timeout(1000)));
  await assert.rejects((await cp()).c.openSealer("63636363-6363-4363-8363-636363636363", AbortSignal.timeout(1000)));
  await assert.rejects((await cp()).c.openSealer("not-a-uuid", AbortSignal.timeout(1000)));
});

test("escrow public refusal means zero unwrap/derive/token effects", async () => {
  let unwraps = 0, derives = 0, issues = 0;
  const c = cpCustody({ kind: "escrow", ...pins, verifyOriginal: () => false,
    control: { serviceDevice: async () => unitRecord(), logToken: async () => { issues++; return { token: "x" }; } },
    unwrap: async () => { unwraps++; return new Uint8Array(96); }, derive: () => { derives++; return publicKeys(); } });
  await assert.rejects(c.openSealer(col, AbortSignal.timeout(1000)));
  await assert.rejects(c.logToken(col, AbortSignal.timeout(1000)));
  assert.equal(unwraps + derives + issues, 0);
});

test("fixture collections use the fixture; others the CP", async () => {
  const mark = (name) => ({ openSealer: async () => name, logToken: async () => name });
  const both = combinedCustody(mark("fixture"), (c) => c === col, mark("cp"));
  assert.equal(await both.openSealer(col), "fixture");
  assert.equal(await both.logToken("x"), "cp");
  assert.equal(await combinedCustody(mark("fixture"), () => false, null).openSealer("x"), "fixture");
});

test("an abort during unwrap or minting hands out nothing and wipes the secret", async () => {
  // Abort lands while the envelope is being opened.
  const ac = new AbortController();
  let opened;
  const { c } = await cp();
  const wrapped = cpCustody({
    kind: "escrow",
    control: { serviceDevice: async () => unitRecord(), logToken: async () => ({ token: "x" }) },
    ...pins,
    unwrap: async () => {
      opened = Uint8Array.from({ length: 96 }, () => 7);
      ac.abort();
      return opened;
    },
  });
  await assert.rejects(wrapped.openSealer(col, ac.signal));
  assert.ok(opened.every((b) => b === 0), "the unwrapped secret is wiped");
  // Abort lands while the token is being minted.
  const ac2 = new AbortController();
  const minting = cpCustody({
    kind: "escrow",
    control: { serviceDevice: async () => unitRecord(),
      logToken: async () => { ac2.abort(); return { token: "late" }; } },
    ...pins,
    unwrap: async () => new Uint8Array(96),
  });
  await assert.rejects(minting.logToken(col, ac2.signal));
  // The stub itself refuses after an abort, and wraps only a 96-byte secret.
  const done = new AbortController();
  done.abort();
  await assert.rejects(labStubUnwrap(K, "escrow", col, dev, new Uint8Array(64), done.signal));
  await assert.rejects(labStubWrapper("escrow", K).wrapDeviceKeys({ collection: col, device: dev, secret: new Uint8Array(32) }, AbortSignal.timeout(1000)));
  assert.ok(c);
});
