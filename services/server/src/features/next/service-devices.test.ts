import { describe, expect, it } from "vitest";
import { generateServiceDevice, MAX_WRAPPED_KEYS_BYTES, parseServiceDevice, ServiceDeviceError, serviceDeviceWire } from "./service-devices.js";

const collection = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";
const wire = {
  kind: "hosted",
  device_id: "11111111-1111-4111-8111-111111111111",
  sign_pk: "aa".repeat(32),
  kem_pk: "bb".repeat(32),
  noise_pk: "cc".repeat(32),
  wrapped_keys: Buffer.from("sealed").toString("base64"),
  kms_key_arn: "arn:aws:kms:eu-west-1:000000000000:key/lab"
};
const deployment = { url: "https://hosted.example.test/", token: "t".repeat(40) };

describe("service device record", () => {
  it("round-trips its wire form", () => {
    expect(serviceDeviceWire(parseServiceDevice(wire))).toEqual(wire);
  });

  it("refuses an all-zero Noise key for escrow too (policy voids it)", () => {
    expect(() => parseServiceDevice({ ...wire, kind: "escrow", noise_pk: "00".repeat(32) })).toThrow(ServiceDeviceError);
    expect(parseServiceDevice({ ...wire, kind: "escrow" }).kind).toBe("escrow");
  });

  it("rejects malformed or oversized fields", () => {
    for (const bad of [
      { ...wire, kind: "owner" }, { ...wire, sign_pk: "aa".repeat(31) }, { ...wire, kem_pk: "AA".repeat(32) },
      { ...wire, wrapped_keys: "" }, { ...wire, wrapped_keys: "not base64!" }, { ...wire, wrapped_keys: "QQ" },
      { ...wire, wrapped_keys: Buffer.alloc(MAX_WRAPPED_KEYS_BYTES + 1).toString("base64") },
      { ...wire, kms_key_arn: "key" }, { ...wire, extra: 1 }, { ...wire, device_id: "nope" },
      { ...wire, sign_pk: "00".repeat(32) }, { ...wire, kem_pk: "01" + "00".repeat(31) }, { ...wire, noise_pk: "00".repeat(32) }, { ...wire, device_id: "00000000-0000-0000-0000-000000000000" }
    ]) expect(() => parseServiceDevice(bad), JSON.stringify(bad).slice(0, 80)).toThrow(ServiceDeviceError);
  });
});

describe("generateServiceDevice", () => {
  it("posts the collection with the deployment token and checks the kind", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const record = await generateServiceDevice(deployment, "hosted", collection, async (url, init) => {
      seen = { url: String(url), init: init! };
      return new Response(JSON.stringify(wire));
    });
    expect(seen!.url).toBe("https://hosted.example.test/internal/v1/service-devices");
    expect(new Headers(seen!.init.headers).get("authorization")).toBe(`Bearer ${deployment.token}`);
    expect(JSON.parse(String(seen!.init.body))).toEqual({ collection });
    expect(seen!.init.redirect).toBe("error");
    expect(record.device_id).toBe(wire.device_id);
    await expect(generateServiceDevice(deployment, "escrow", collection, async () => new Response(JSON.stringify(wire)))).rejects.toMatchObject({ code: "invalid_service_device" });
  });

  it("maps failures without echoing the response", async () => {
    await expect(generateServiceDevice({ ...deployment, url: "http://hosted.example.test" }, "hosted", collection, async () => new Response(JSON.stringify(wire)))).rejects.toMatchObject({ message: "The service deployment must use HTTPS." });
    await expect(generateServiceDevice(deployment, "hosted", collection, async () => { throw new Error("down"); })).rejects.toMatchObject({ status: 503 });
    await expect(generateServiceDevice(deployment, "hosted", collection, async () => new Response("secret detail", { status: 500 }))).rejects.toMatchObject({ status: 503, message: "The service deployment answered 500." });
    await expect(generateServiceDevice(deployment, "hosted", collection, async () => new Response("no", { status: 403 }))).rejects.toMatchObject({ status: 502 });
    await expect(generateServiceDevice(deployment, "hosted", collection, async () => new Response("{"))).rejects.toMatchObject({ code: "invalid_service_device" });
    await expect(generateServiceDevice(deployment, "hosted", collection, async () => new Response("x".repeat(3 * MAX_WRAPPED_KEYS_BYTES)))).rejects.toMatchObject({ message: "The service device record is too large." });
  });
});
