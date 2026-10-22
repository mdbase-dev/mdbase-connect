import { createHash, createPrivateKey, createPublicKey, hkdfSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deriveRecoveryDevice, recoveryEnrolMatches } from "../src/keys/recoveryDevice.js";

const COL = "0f8e3c3a-7d2b-4c55-9d7e-0b6f3d2a1c11";
const R = new Uint8Array(32).map((_, i) => i);

// Independent implementation with node:crypto (OpenSSL), straight from sealed-envelope §5.4.
function reference(secret: Uint8Array, collection: string) {
  const salt = Buffer.from(collection.replace(/-/g, ""), "hex");
  const seedSign = Buffer.from(hkdfSync("sha256", secret, salt, "mdbase/v1/recovery-sign", 32));
  const seedKem = Buffer.from(hkdfSync("sha256", secret, salt, "mdbase/v1/recovery-kem", 32));
  const raw = (alg: "ed25519" | "x25519", seed: Buffer) => {
    const prefix = Buffer.from(alg === "ed25519" ? "302e020100300506032b657004220420" : "302e020100300506032b656e04220420", "hex");
    const pub = createPublicKey(createPrivateKey({ key: Buffer.concat([prefix, seed]), format: "der", type: "pkcs8" })).export({ format: "der", type: "spki" });
    return pub.subarray(pub.length - 32);
  };
  const signPk = raw("ed25519", seedSign);
  const kemPk = raw("x25519", seedKem);
  const tag = Buffer.from("mdbase/v1/recovery-id");
  const id = createHash("sha256").update(Buffer.concat([Buffer.from([tag.length]), tag, salt, signPk])).digest().subarray(0, 16).toString("hex");
  return { signPk: signPk.toString("hex"), kemPk: kemPk.toString("hex"), device: `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}` };
}

describe("recovery device derivation (sealed-envelope §5.4)", () => {
  it("matches an independent OpenSSL implementation", async () => {
    const d = await deriveRecoveryDevice(R, COL);
    expect({ signPk: Buffer.from(d.signPk).toString("hex"), kemPk: Buffer.from(d.kemPk).toString("hex"), device: d.device }).toEqual(reference(R, COL));
    expect(d.noisePk).toEqual(new Uint8Array(32));
  });

  it("checks an enrol item against the derived keys", async () => {
    const d = await deriveRecoveryDevice(R, COL);
    const item = { device: d.device, signPk: d.signPk, kemPk: d.kemPk, noisePk: new Uint8Array(32) };
    expect(recoveryEnrolMatches(d, item)).toBe(true);
    expect(recoveryEnrolMatches(d, { ...item, kemPk: new Uint8Array(32).fill(1) })).toBe(false);
    expect(recoveryEnrolMatches(d, { ...item, noisePk: new Uint8Array(32).fill(1) })).toBe(false);
    expect(recoveryEnrolMatches(d, { ...item, device: "11111111-2222-4333-8444-555555555555" })).toBe(false);
  });
});
