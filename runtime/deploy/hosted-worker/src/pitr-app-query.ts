/** Public query DATA only, not a caller constructor, CP result or effect permit.
 * Production obtains this exact tuple from its own native Noise handle/Engine.
 * Copies/decoding are not provenance; repeat native+CP+phase checks at each gate.
 */
import type { CborValue } from "../../../packages/sdk/src/cbor.js";
import type { PitrAppGrantIdentity } from "./control.ts";
const hex = (b: Uint8Array) => Array.from(b, v => v.toString(16).padStart(2, "0")).join("");
const uuid = (b: Uint8Array) => {
  const h = hex(b);
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
};
export function decodePitrAppQuery(value: CborValue): Readonly<PitrAppGrantIdentity> | null {
  const lengths = [16,16,32,32,16];
  if (!Array.isArray(value) || value.length !== lengths.length) return null;
  const fields: Uint8Array[] = [];
  for (let i = 0; i < lengths.length; i++) {
    const b = value[i];
    if (!(b instanceof Uint8Array) || b.length !== lengths[i] || !b.some(v => v !== 0)) return null;
    fields.push(b);
  }
  return Object.freeze({principal:"app-grant", collection:uuid(fields[0]!), grant:uuid(fields[1]!),
    clientPublicKey:hex(fields[2]!), genesisSha256:hex(fields[3]!), policyKeyId:hex(fields[4]!)});
}
