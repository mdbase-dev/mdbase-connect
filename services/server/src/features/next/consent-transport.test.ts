import { generateKeyPairSync, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseNextNoiseAuthorization } from "./consent-transport.js";

function descriptor() {
  const { publicKey } = generateKeyPairSync("x25519");
  return { protocol_version: 1 as const, connector_id: randomUUID(), device_id: randomUUID(),
    collection_id: randomUUID(), device_noise_pk: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex") };
}
describe("explicit persisted Noise consent descriptor", () => {
  it("retains exactly the original tuple without coercion or an encryption inference", () => {
    const d = descriptor(); expect(parseNextNoiseAuthorization(d)).toEqual(d);
    expect(parseNextNoiseAuthorization(d)).not.toBe(d);
  });
  it("rejects absent, malformed, extra, weak and nil bindings rather than choosing legacy", () => {
    const d = descriptor();
    for (const value of [undefined, null, false, [], "next", {}, { ...d, extra: true },
      { ...d, protocol_version: "1" }, { ...d, protocol_version: 2 },
      { ...d, device_noise_pk: "00".repeat(32) }, { ...d, device_noise_pk: "01" + "00".repeat(31) },
      { ...d, device_noise_pk: d.device_noise_pk.toUpperCase() },
      { ...d, device_id: "00000000-0000-0000-0000-000000000000" },
      { ...d, connector_id: "" }, { ...d, collection_id: undefined }]) {
      expect(() => parseNextNoiseAuthorization(value)).toThrow();
    }
  });
});
