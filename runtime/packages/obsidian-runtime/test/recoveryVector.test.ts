// The shared cross-implementation recovery-key vector:
// conformance/crypto/recovery-key/vector-1.json, also run by the Rust replica.
// A key printed in Obsidian must parse in the daemon and the other way round.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deriveRecoveryDevice } from "../src/keys/recoveryDevice.js";
import { formatRecoveryKey, parseRecoveryKey } from "../src/keys/recoveryKey.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "../../../conformance/crypto/recovery-key");
const files = readdirSync(dir).filter((f) => /^vector-\d+\.json$/.test(f)).sort();
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("recovery key: shared conformance vector", () => {
  it("has vectors", () => expect(files.length).toBeGreaterThan(0));
  for (const f of files) {
    const v = JSON.parse(readFileSync(join(dir, f), "utf8"));
    it(`${f}: every field`, async () => {
      const secret = Uint8Array.from(Buffer.from(v.secret, "hex"));
      expect(await formatRecoveryKey(secret)).toBe(v.text);
      expect(hex(await parseRecoveryKey(v.text))).toBe(v.secret);
      for (const s of v.also_parses) expect(hex(await parseRecoveryKey(s))).toBe(v.secret);
      for (const s of v.rejects) await expect(parseRecoveryKey(s)).rejects.toThrow();
      const d = await deriveRecoveryDevice(secret, v.collection);
      expect({ sign_pk: hex(d.signPk), kem_pk: hex(d.kemPk), device: d.device, noise_pk: hex(d.noisePk) }).toEqual({ sign_pk: v.sign_pk, kem_pk: v.kem_pk, device: v.device, noise_pk: v.noise_pk });
      // No field of the vector goes unchecked.
      expect(Object.keys(v).sort()).toEqual(["also_parses", "collection", "description", "device", "kem_pk", "noise_pk", "rejects", "secret", "sign_pk", "text"]);
    });
  }
});
