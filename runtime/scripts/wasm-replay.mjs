// Replays a log with the WASM runtime (raw ABI, no bindgen) and prints the same
// JSON as the native `replay` binary (crates/conformance/src/bin/replay.rs).
// Usage: node scripts/wasm-replay.mjs <runtime.wasm> <log>
import { readFileSync } from 'node:fs';

const [wasmPath, logPath] = process.argv.slice(2);
if (!wasmPath || !logPath) {
  console.error('usage: node scripts/wasm-replay.mjs <runtime.wasm> <log>');
  process.exit(2);
}
const mod = await WebAssembly.compile(readFileSync(wasmPath));
// The replay path must need no host capabilities; any import call is a bug.
const imports = {};
for (const imp of WebAssembly.Module.imports(mod)) {
  imports[imp.module] ??= {};
  imports[imp.module][imp.name] = () => {
    throw new Error(`unexpected import ${imp.module}.${imp.name}`);
  };
}
const { exports: x } = await WebAssembly.instantiate(mod, imports);
const input = new TextEncoder().encode(readFileSync(logPath, 'utf8'));
const p = x.alloc(input.length);
new Uint8Array(x.memory.buffer, p, input.length).set(input);
const packed = x.replay(p, input.length); // BigInt: (ptr << 32) | len
const outPtr = Number(packed >> 32n);
const outLen = Number(packed & 0xffffffffn);
const out = new TextDecoder('utf-8', { fatal: true }).decode(
  new Uint8Array(x.memory.buffer, outPtr, outLen),
);
x.dealloc(outPtr, outLen);
console.log(out);
