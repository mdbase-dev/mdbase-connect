// Real engine key generation and LAB envelope, platform import replaced only.
// No SQL, provider, CP, bookmark or PITR execution: this is Node routing evidence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { PITR_RUN } from "../src/pitr-phase.ts";
import { labStubUnwrap } from "../src/custody-stub.ts";
import { devicePublicKeys } from "../src/keygen.ts";
const bytes = readFileSync(new URL("../hosted.wasm", import.meta.url));
const engine = new WebAssembly.Module(bytes);
const compiled = await build({ entryPoints: [new URL("../src/pitr-worker.ts", import.meta.url).pathname], bundle: true, write: false, format: "esm", platform: "node", plugins: [{
  name: "platform-only", setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "platform", namespace: "fake" }));
    b.onLoad({ filter: /.*/, namespace: "fake" }, () => ({ contents: "export class DurableObject {}" }));
    b.onLoad({ filter: /hosted\.wasm$/ }, () => ({ contents: `export default new WebAssembly.Module(Uint8Array.from(atob('${bytes.toString("base64")}'), c => c.charCodeAt(0)));` }));
  }
}] });
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);
const A = "11111111-1111-4111-8111-111111111111", D = "22222222-2222-4222-8222-222222222222";
const binding = { run: PITR_RUN, active: A, deleted: D, codeConfigSha256: "c".repeat(64), members: [
  { kind: "log", collection: A, namespace: "a".repeat(32), object: "1".repeat(64) },
  { kind: "log", collection: D, namespace: "a".repeat(32), object: "2".repeat(64) },
  { kind: "registry", collection: "00000000-0000-0000-0000-000000000000", namespace: "a".repeat(32), object: "3".repeat(64) },
  { kind: "hosted", collection: A, namespace: "b".repeat(32), object: "4".repeat(64) },
  { kind: "hosted", collection: D, namespace: "b".repeat(32), object: "5".repeat(64) }
] };
const hostedToken = "h".repeat(40), escrowToken = "e".repeat(40), wrapKey = "7e".repeat(32);
const hostedPath = "/internal/v1/service-devices", escrowPath = "/pitr-escrow/internal/v1/service-devices";
function fixture(phase = "seed") {
  let reads = 0, actors = 0;
  const env = { LAB: "1", SERVICE_KIND: "hosted", HOSTED_SERVICE_TOKEN: hostedToken, PITR_ESCROW_SERVICE_TOKEN: escrowToken,
    LAB_CUSTODY_WRAP_KEY: wrapKey, PITR_BINDING: JSON.stringify(binding), PITR_MINIMUM_EPOCH: "7",
    PITR_PHASE: { async get(key) {
      reads++; assert.equal(key, `${PITR_RUN}/phase.json`); const now = Date.now();
      const value = new TextEncoder().encode(JSON.stringify({ schema: "mdbn-lab-pitr-phase/1", binding, epoch: 7, phase, issuedAt: now - 1, expiresAt: now + 60000 }));
      return { size: value.length, body: new ReadableStream({ start(c) { c.enqueue(value); c.close(); } }) };
    } }, COLLECTIONS: { idFromName() { actors++; throw Error("unexpected actor lookup"); }, get() { actors++; throw Error("unexpected actor get"); } }
  };
  return { env, counts: () => ({ reads, actors }) };
}
function request(path, token = hostedToken, collection = A) {
  return new Request(`https://synthetic.test${path}`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ collection }) });
}
test("one Worker generates distinct real hosted/escrow records without creating either actor", async () => {
  const f = fixture(); const devices = new Set();
  for (const collection of [A, D]) for (const [role, path, token] of [["hosted", hostedPath, hostedToken], ["escrow", escrowPath, escrowToken]]) {
    const response = await worker.fetch(request(path, token, collection), f.env); assert.equal(response.status, 200);
    const record = await response.json(); assert.equal(record.kind, role); devices.add(record.device_id);
    const secret = await labStubUnwrap(wrapKey, role, collection, record.device_id, Buffer.from(record.wrapped_keys, "base64"));
    try {
      assert.equal(secret.length, 96); const publicKeys = devicePublicKeys(engine, secret);
      for (const [wire, key] of [["sign_pk", "signPk"], ["kem_pk", "kemPk"], ["noise_pk", "noisePk"]]) assert.equal(record[wire], Buffer.from(publicKeys[key]).toString("hex"));
      await assert.rejects(labStubUnwrap(wrapKey, role === "hosted" ? "escrow" : "hosted", collection, record.device_id, Buffer.from(record.wrapped_keys, "base64")));
    } finally { secret.fill(0); }
  }
  assert.equal(devices.size, 4); assert.deepEqual(f.counts(), { reads: 8, actors: 0 });
});
test("credentials cannot cross factory roles, and duplicate role configuration closes", async () => {
  const f = fixture();
  for (const [path, token] of [[hostedPath, escrowToken], [escrowPath, hostedToken]]) assert.equal((await worker.fetch(request(path, token), f.env)).status, 401);
  assert.equal((await worker.fetch(request(escrowPath, escrowToken), { ...f.env, PITR_ESCROW_SERVICE_TOKEN: hostedToken })).status, 503);
  assert.deepEqual(f.counts(), { reads: 0, actors: 0 });
});
test("closed phase, foreign UUID and partial configuration deny generation", async () => {
  const f = fixture("closed"); assert.equal((await worker.fetch(request(escrowPath, escrowToken), f.env)).status, 503);
  assert.equal((await worker.fetch(request(hostedPath, hostedToken, "33333333-3333-4333-8333-333333333333"), f.env)).status, 503);
  for (const change of [{ PITR_BINDING: undefined }, { PITR_PHASE: undefined }, { PITR_MINIMUM_EPOCH: undefined }, { LAB_HOSTED_CONFIG: "synthetic" }]) assert.equal((await worker.fetch(request(hostedPath), { ...f.env, ...change })).status, 503);
  assert.equal(f.counts().actors, 0);
});
test("activation/migration/app entries remain closed; escrow has no actor endpoint", async () => {
  const f = fixture();
  for (const path of ["/internal/v1/collections/activate", "/internal/v1/migration-admission", `/v1/hosted/status?collection=${A}`]) assert.equal((await worker.fetch(request(path), f.env)).status, 503);
  assert.equal((await worker.fetch(request("/pitr-escrow/internal/v1/collections/activate", escrowToken), f.env)).status, 404);
  assert.deepEqual(f.counts(), { reads: 0, actors: 0 });
});
