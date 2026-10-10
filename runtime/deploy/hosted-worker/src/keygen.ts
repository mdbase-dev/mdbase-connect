/**
 * Hosted service-device keys, generated and derived inside the engine wasm
 * (`mdbn_hosted_worker::device_keys`). A fresh, engine-less instance per call: no
 * collection state, no SQL. Secret bytes are wiped in wasm memory before it is freed;
 * the caller wipes its own copy (`secret.fill(0)`) as soon as custody has wrapped it.
 */

import { encode } from "../../../packages/sdk/src/cbor.ts";

interface KeyExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  alloc(n: number): number;
  hd_generate_device(): bigint;
  hd_public_keys(p: number, n: number): bigint;
  hd_verify_hosted_genesis(p: number, n: number): number;
  hd_wipe_free(p: number, n: number): void;
}

export const SECRET_LEN = 96;

/** Public-only native policy/strict CP certificate check. Engine-less/NO SQL or
 * secret capabilities. Pins are ONLY the bundled shared signed release output. */
export function verifyHostedGenesis(module: WebAssembly.Module, collection: string, pins: Uint8Array, original: Uint8Array, hash: Uint8Array): boolean {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(collection)
      || !pins.length || pins.length > (64 << 10) || !original.length || original.length > (64 << 10) || hash.length !== 32) return false;
  const uuid = Uint8Array.from(collection.replace(/-/g, "").match(/../g)!, h => parseInt(h, 16));
  const input = encode([uuid, pins, original, hash]);
  try {
    const ex = instantiate(module);
    const p = ex.alloc(input.length);
    new Uint8Array(ex.memory.buffer, p, input.length).set(input);
    // Consumes/wipes the ABI allocation. No native state/keys carried forward.
    return ex.hd_verify_hosted_genesis(p, input.length) === 1;
  } catch {
    return false;
  } finally {
    input.fill(0);
  }
}


export interface DevicePublicKeys {
  signPk: Uint8Array;
  kemPk: Uint8Array;
  noisePk: Uint8Array;
}

export interface GeneratedDevice extends DevicePublicKeys {
  /** `signSeed ‖ kemSk ‖ noiseSk`, for KMS wrap only. */
  secret: Uint8Array;
}

function refused(): never {
  throw new Error("not available to key generation");
}

function instantiate(module: WebAssembly.Module): KeyExports {
  let ex: KeyExports | undefined;
  const instance = new WebAssembly.Instance(module, {
    env: {
      host_sql: refused,
      host_now_ms: () => Date.now(),
      host_random: (p: number, n: number) => {
        for (let off = 0; off < n; off += 65536) {
          crypto.getRandomValues(new Uint8Array(ex!.memory.buffer, p + off, Math.min(65536, n - off)));
        }
      },
      host_local_date: () => 0,
      host_default_zone: () => 0,
    },
  });
  ex = instance.exports as KeyExports;
  return ex;
}

/** Copy an output out of wasm memory, then wipe and free it there. */
function takeWiped(ex: KeyExports, out: bigint): Uint8Array {
  const p = Number(out >> 32n);
  const n = Number(out & 0xffffffffn);
  if (n === 0) return new Uint8Array(0);
  const copy = new Uint8Array(ex.memory.buffer, p, n).slice();
  ex.hd_wipe_free(p, n);
  return copy;
}

const split = (b: Uint8Array, at: number): DevicePublicKeys => ({
  signPk: b.slice(at, at + 32),
  kemPk: b.slice(at + 32, at + 64),
  noisePk: b.slice(at + 64, at + 96),
});

/** A new hosted service device from the platform CSPRNG. */
export function generateDeviceKeys(module: WebAssembly.Module): GeneratedDevice {
  const ex = instantiate(module);
  const all = takeWiped(ex, ex.hd_generate_device());
  if (all.length !== SECRET_LEN + 96) {
    all.fill(0);
    throw new Error("key generation failed");
  }
  const device = { secret: all.slice(0, SECRET_LEN), ...split(all, SECRET_LEN) };
  all.fill(0);
  return device;
}

/**
 * The public keys of an unwrapped 96-byte secret, for custody to compare with the
 * service record and the log's enrolment before handing any key to the engine.
 * Null when the secret is not 96 bytes. The caller still owns (and wipes) `secret`.
 */
export function devicePublicKeys(module: WebAssembly.Module, secret: Uint8Array): DevicePublicKeys | null {
  if (secret.length !== SECRET_LEN) return null;
  const ex = instantiate(module);
  const p = ex.alloc(SECRET_LEN);
  new Uint8Array(ex.memory.buffer, p, SECRET_LEN).set(secret);
  const out = takeWiped(ex, ex.hd_public_keys(p, SECRET_LEN));
  return out.length === 96 ? split(out, 0) : null;
}
