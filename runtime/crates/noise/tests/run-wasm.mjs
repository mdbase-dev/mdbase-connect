// Public synthetic conformance only; never reads identities, grants or keychains.
// Build via rcargo, pulling target/wasm32-unknown-unknown/debug/mdbn_noise.wasm:
// cargo rustc -p mdbn-noise --lib --crate-type cdylib --target wasm32-unknown-unknown -- --cfg test
// Then: node crates/noise/tests/run-wasm.mjs <pulled test-only wasm>
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

assert.equal(process.argv.length, 3, 'expected test-only WASM path');
const module = await WebAssembly.compile(await readFile(process.argv[2]));
assert.deepEqual(WebAssembly.Module.imports(module), [], 'no entropy, clocks or I/O imports');
const instance = await WebAssembly.instantiate(module, {});
assert.equal(typeof instance.exports.noise_conformance, 'function');
const cases = ['cacophony transcript/hash/transport', 'wrong prologue/key', 'frame/session budgets and tamper nonce', 'weak DH both directions'];
for (let i = 0; i < cases.length; i++) {
  assert.equal(instance.exports.noise_conformance(i), 1, cases[i]);
  console.log(`PASS wasm: ${cases[i]}`);
}
assert.equal(instance.exports.noise_conformance(cases.length), 0);
console.log('PASS wasm: zero host imports; 4 identical native/WASM cases');
