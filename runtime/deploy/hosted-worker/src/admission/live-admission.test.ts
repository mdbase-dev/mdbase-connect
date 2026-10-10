import assert from "node:assert/strict";
import test from "node:test";
import { LiveAdmission, type LiveHostedEvidence, type LiveAdmissionSource } from "./live-admission.ts";
// Public structural unit fixtures, NOT cryptographic producer proof.
const COL = "11111111-1111-4111-8111-111111111111";
const DEV = "22222222-2222-4222-8222-222222222222";
const ROOT = "33333333-3333-4333-8333-333333333333";
const GRANT = "44444444-4444-4444-8444-444444444444";
const bytes = (n: number) => new Uint8Array(32).fill(n);
const config = () => ({ collection: COL, device: DEV, signPk: bytes(1), kemPk: bytes(2), noisePk: bytes(3), roots: [{id: ROOT, pk: bytes(4)}] });
const proof = (): LiveHostedEvidence => ({ ...config(), kind: "verified", wake: 1n, generation: 0n, epoch: 1n,
  applied: {seq: 5n, chain: bytes(5)}, authenticated: {seq: 5n, chain: bytes(5)},
  rootId: ROOT, rootPk: bytes(4), controlChain: bytes(6), keyDeliveryDevice: DEV, keyDeliverySeq: 4n });
const ctx = (op: "hello" | "call" | "output" | "ack" | "wake" = "call") => ({collection: COL, op, grant: GRANT, clientPk: bytes(9)});
function setup() {
  let evidence: LiveHostedEvidence | null = proof(), wake = 1n, app = true, noise = true;
  const source: LiveAdmissionSource = { observe: () => evidence, wake: () => wake, noiseMatches: () => noise, authorizeApp: () => app };
  return { source, admission: new LiveAdmission(config(), source),
    set: (e: LiveHostedEvidence | null) => { evidence = e; },
    wake: (n: bigint) => { wake = n; }, app: (v: boolean) => { app = v; }, noise: (v: boolean) => { noise = v; } };
}

test("defaults deny; actual serving observation alone is not an app grant", () => {
  assert.equal(new LiveAdmission(config()).recheck(ctx()), "deny");
  const s = setup(); s.app(false);
  assert.equal(s.admission.recheck(ctx()), "deny");
  assert.equal(s.admission.recheck({collection: COL, op: "wake"}), "allow");
  assert.equal(s.admission.recheck({collection: COL, op: "call"}), "deny");
});

test("all public boundaries independently re-observe current state and Noise custody", () => {
  const s = setup();
  for (const op of ["hello", "call", "output", "ack", "wake"] as const) assert.equal(s.admission.recheck(ctx(op)), "allow");
  s.noise(false); assert.equal(s.admission.recheck(ctx()), "deny");
  s.noise(true); s.set(null); assert.equal(s.admission.recheck(ctx()), "deny");
});

test("wrong identity, collection, root, prefix, generation or bootstrap cannot serve", () => {
  const s = setup();
  for (const e of [
    {...proof(), collection: ROOT}, {...proof(), device: ROOT}, {...proof(), signPk: bytes(8)},
    {...proof(), kemPk: bytes(8)}, {...proof(), noisePk: bytes(8)}, {...proof(), rootPk: bytes(8)},
    {...proof(), rootId: DEV}, {...proof(), epoch: 0n}, {...proof(), generation: -1n},
    {...proof(), generation: 1n << 64n}, {...proof(), wake: 2n},
    {...proof(), keyDeliverySeq: 6n}, {...proof(), keyDeliveryDevice: "metadata"},
    {...proof(), applied: {seq: 4n, chain: bytes(5)}},
    {...proof(), authenticated: {seq: 5n, chain: bytes(8)}},
    {...proof(), kind: "eligible"},
  ]) { s.set(e as LiveHostedEvidence); assert.equal(s.admission.recheck(ctx()), "deny"); }
});

test("post-await revocation/wake requires final synchronous recheck, no cached allow", async () => {
  const s = setup();
  assert.equal(await s.admission.check(ctx()), "allow");
  s.app(false); assert.equal(s.admission.recheck(ctx("output")), "deny");
  s.app(true); s.wake(2n); assert.equal(s.admission.recheck(ctx("ack")), "deny");
  s.set({...proof(), wake: 2n}); assert.equal(s.admission.recheck(ctx()), "allow");
});

test("authorization callback cannot mutate bridge context into a stale permit", () => {
  const e = proof();
  const source: LiveAdmissionSource = {observe: () => e, wake: () => 1n, noiseMatches: () => true,
    authorizeApp: () => {e.generation++; return true;}};
  assert.equal(new LiveAdmission(config(), source).recheck(ctx()), "deny");
});

test("bridge exception/malformed fields deny without leaking errors", () => {
  const s = setup(); s.source.observe = () => {throw new Error("SENSITIVE_DATA");};
  assert.equal(s.admission.recheck(ctx()), "deny");
  s.source.observe = () => ({...proof(), applied: null} as unknown as LiveHostedEvidence);
  assert.equal(s.admission.recheck(ctx()), "deny");
});

test("final Noise callback cannot replace wake or policy state behind the verdict", () => {
  for (const change of ["wake", "generation", "controlChain", "epoch", "rootPk"] as const) {
    const e = proof(); let wake = 1n, calls = 0;
    const source: LiveAdmissionSource = {observe: () => e, wake: () => wake, authorizeApp: () => true,
      noiseMatches: () => {
        if (++calls === 2) {
          if (change === "wake") wake = 2n;
          else if (change === "generation" || change === "epoch") e[change]++;
          else e[change].fill(8);
        }
        return true;
      }};
    assert.equal(new LiveAdmission(config(), source).recheck(ctx("ack")), "deny", change);
    assert.equal(calls, 2);
  }
});

test("configuration is independently copied; empty/unbounded trust roots rejected", () => {
  assert.throws(() => new LiveAdmission({...config(), roots: []}));
  assert.throws(() => new LiveAdmission({...config(), roots: Array.from({length: 9}, () => ({id: ROOT, pk: bytes(4)}))}));
  const c = config(); const source = setup().source;
  const admission = new LiveAdmission(c, source); c.signPk.fill(0); c.roots[0].pk.fill(0);
  assert.equal(admission.recheck(ctx()), "allow");
});
