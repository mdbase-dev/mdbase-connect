import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { createDatabase } from "../../db.js";
import { certToJson, ed25519RawPublicKey, type NextControlPlaneConfig } from "./policy-keys.js";
import { certDigest, keyId } from "./policy-wire.js";

const pem = (key: KeyObject) => key.export({ format: "pem", type: "pkcs8" }).toString();
function nextConfig(): NextControlPlaneConfig {
  const root = generateKeyPairSync("ed25519").privateKey, policy = generateKeyPairSync("ed25519").privateKey;
  const cert = { policyPublicKey: ed25519RawPublicKey(policy), root: keyId(ed25519RawPublicKey(root)), notBefore: Date.now() - 60_000, notAfter: Date.now() + 30 * 86_400_000 };
  return { rootPublicKey: ed25519RawPublicKey(root), policyPrivateKeyPem: pem(policy), policyCert: certToJson({ ...cert, signature: sign(null, certDigest(cert), root) }),
    serviceTokens: { hosted: "h".repeat(40), escrow: "e".repeat(40) },
    logService: { url: "https://synthetic-log.example.test", tokenIssuerKeyPem: pem(policy), transportKeyPem: pem(generateKeyPairSync("ed25519").privateKey) } };
}

describe("migration record route mounting", () => {
  it.each([false, true])("mounts only with the next control plane, without depending on a migration token: enabled=%s", async enabled => {
    const db = await createDatabase("memory"), { app } = await buildApp({ db, ...(enabled ? { nextControlPlane: nextConfig() } : {}) });
    try {
      const response = await app.inject({ method: "GET", url: `/v1/next/collections/${randomUUID()}/migration-record` });
      expect(response.statusCode).toBe(enabled ? 401 : 404);
      if (enabled) expect(response.headers["cache-control"]).toBe("no-store");
    } finally { await app.close(); await db.end(); }
  });
});
