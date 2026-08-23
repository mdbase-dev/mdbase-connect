import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { authorizationSigningMessage } from "../packages/protocol/dist/index.js";

const directory = resolve(import.meta.dirname, "../packages/protocol/test/fixtures");
const source = JSON.parse(await readFile(resolve(directory, "application-authorization-v4.json"), "utf8"));
const binding = structuredClone(source.binding);
binding.protocol_version = 6;
binding.contracts.authorization_binding = 6;
binding.contracts.collaboration = 1;
binding.requested_collaboration = {
  contract_version: 1,
  profiles: ["markdown-body-yjs-v13"]
};
const message = authorizationSigningMessage(binding);
const publicBytes = Buffer.from(binding.installation_signing_public_key, "base64url");
const key = createPrivateKey({
  format: "jwk",
  key: {
    kty: "EC",
    crv: "P-256",
    d: source.installation_signing_private_key,
    x: publicBytes.subarray(1, 33).toString("base64url"),
    y: publicBytes.subarray(33, 65).toString("base64url")
  }
});
let signature = sign("sha256", message, { key, dsaEncoding: "ieee-p1363" });
const order = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const s = BigInt(`0x${signature.subarray(32).toString("hex")}`);
if (s > order / 2n) {
  const normalized = (order - s).toString(16).padStart(64, "0");
  signature = Buffer.concat([signature.subarray(0, 32), Buffer.from(normalized, "hex")]);
}
await writeFile(resolve(directory, "application-authorization-v6.json"), `${JSON.stringify({
  binding,
  installation_signing_private_key: source.installation_signing_private_key,
  signing_message_sha256: createHash("sha256").update(message).digest("hex"),
  signature: signature.toString("base64url")
}, null, 2)}\n`);
