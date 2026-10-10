// Actual hosted WASM export, metadata only; no live Worker or database.
// HOSTED_WASM=<fresh hosted.wasm> node --experimental-transform-types --test test/migration-wasm.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { encode, decode } from "../../../packages/sdk/src/cbor.ts";

const wasmPath = process.env.HOSTED_WASM;
assert.ok(wasmPath, "pass the freshly built hosted.wasm path");
const module = new WebAssembly.Module(readFileSync(wasmPath));
const noHost = () => { throw new Error("preflight must not call host capabilities"); };
const ex = new WebAssembly.Instance(module, {
  env: Object.fromEntries(WebAssembly.Module.imports(module).map(({ name }) => [name, noHost])),
}).exports;
const fields = (entries) => new Map(entries);
const uuid = "0192f0c1-7e1a-7b3c-8d4e-000000000001";
function resolve(bytes) {
  const ptr = ex.alloc(bytes.length);
  new Uint8Array(ex.memory.buffer, ptr, bytes.length).set(bytes);
  const packed = ex.mig_resolve(ptr, bytes.length);
  const outPtr = Number(packed >> 32n);
  const outLen = Number(packed & 0xffffffffn);
  assert.ok(outLen > 0, "canonical Outcome must be returned");
  const out = new Uint8Array(ex.memory.buffer, outPtr, outLen).slice();
  ex.dealloc(outPtr, outLen);
  assert.ok(new Uint8Array(ex.memory.buffer, outPtr, outLen).every((v) => v === 0));
  return decode(out);
}

test("mig_resolve renames paths without opening an engine or calling a host", () => {
  const read = fields([[1, [fields([[1, "mdbase.yaml"]])]],
    [2, [fields([[1, uuid], [2, "notes/why?.md"]])]], [3, []]]);
  const result = resolve(encode(read));
  assert.equal(result.get(0), 1);
  assert.equal(result.get(2)[0].get(2), "notes/why_.md");
  assert.equal(result.get(4)[0].get(3), "forbidden_character");
});

test("mig_resolve reports an unresolvable path rather than truncating it", () => {
  const read = fields([[1, []], [2, []],
    [3, [fields([[1, uuid], [2, `${"a/".repeat(600)}x.png`]])]]]);
  const result = resolve(encode(read));
  assert.equal(result.get(0), 2);
  assert.equal(result.get(1).length, 1);
});

test("mig_resolve returns Failed for malformed metadata", () => {
  const result = resolve(new TextEncoder().encode("nonsense"));
  assert.equal(result.get(0), 3);
  assert.match(result.get(1), /^input:/);
});
