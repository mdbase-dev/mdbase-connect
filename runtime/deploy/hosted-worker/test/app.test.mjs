// App-session helpers: prologue binding, frame reassembly/chunking, evidence decode.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FrameReader, MAX_APP_FRAME, MAX_PLAINTEXT, PROLOGUE_TAG, evidence, frameChunks, parsePrologue, uuidBytes } from "../src/app.ts";

const col = "61616161-6161-4161-8161-616161616161";
const dev = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";
const grant = "71717171-7171-4171-8171-717171717171";
const prologue = (c = col, g = grant, d = dev) => {
  const p = new Uint8Array(64);
  p.set(PROLOGUE_TAG, 0); p.set(uuidBytes(c), 16); p.set(uuidBytes(g), 32); p.set(uuidBytes(d), 48);
  return p;
};

test("the prologue must bind this collection, a grant and this device", () => {
  assert.equal(parsePrologue(prologue(), col, dev), grant);
  assert.equal(parsePrologue(prologue("62626262-6262-4262-8262-626262626262"), col, dev), null);
  assert.equal(parsePrologue(prologue(col, grant, "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c"), col, dev), null);
  assert.equal(parsePrologue(prologue(col, "00000000-0000-0000-0000-000000000000"), col, dev), null, "hosting session never over the app path");
  assert.equal(parsePrologue(prologue().subarray(0, 63), col, dev), null);
  const t = prologue(); t[0] ^= 1;
  assert.equal(parsePrologue(t, col, dev), null);
});

test("frames reassemble across chunks and are chunked to the transport limit", () => {
  const f = Uint8Array.from({ length: 200_000 }, (_, i) => i & 0xff);
  const chunks = frameChunks(f);
  assert.ok(chunks.every((c) => c.length <= MAX_PLAINTEXT));
  const r = new FrameReader();
  const got = [];
  for (const c of [...chunks, ...frameChunks(Uint8Array.of(1, 2, 3))]) got.push(...r.push(c));
  assert.equal(got.length, 2);
  assert.deepEqual(got[0], f);
  assert.deepEqual([...got[1]], [1, 2, 3]);
  const huge = new Uint8Array(4); new DataView(huge.buffer).setUint32(0, MAX_APP_FRAME + 1);
  const r2 = new FrameReader();
  r2.push(Uint8Array.of(0, 0, 0, 9, 1, 2)); // a partial frame held
  assert.equal(r2.buffered, 6);
  const tail = Uint8Array.of(3, 4, 5, 6, 7, 8, 9);
  const ok = r2.push(tail.subarray(0, 7));
  assert.equal(ok.length, 1);
  assert.equal(r2.push(huge), null);
  assert.equal(r2.buffered, 0, "wiped and dropped on refusal");
});

test("evidence decodes only a Verified observation", () => {
  assert.equal(evidence([0, "HeadUnproven"]), null);
  assert.equal(evidence(null), null);
  const b = (n, x) => new Uint8Array(n).fill(x);
  const m = new Map([[0, uuidBytes(col)], [1, uuidBytes(dev)], [2, b(32, 1)], [3, b(32, 2)], [4, b(32, 3)], [5, 9n], [6, 1], [7, 1],
    [8, [5, b(32, 4)]], [9, [5, b(32, 4)]], [10, b(16, 5)], [11, b(32, 6)], [12, b(32, 7)], [13, uuidBytes(dev)], [14, 2]]);
  const e = evidence([1, m]);
  assert.equal(e.collection, col);
  assert.equal(e.wake, 9n);
  assert.equal(e.applied.seq, 5n);
  assert.equal(e.keyDeliverySeq, 2n);
});
