import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const electron = require("electron");

// Electron's BoringSSL, unlike Node's OpenSSL, has no default digest for EC
// keys. Sigstore's TUF root and transparency-log helpers call crypto.verify
// without one, so the updater rejected every release in the shipped app while
// passing under Node (issue #426). These checks run in Electron's own runtime
// against the dependency tree the main-process bundle is built from.
const script = `
const crypto = require("node:crypto");
const { Key } = require(${JSON.stringify(require.resolve("@tufjs/models"))});
const { crypto: core } = require(${JSON.stringify(require.resolve("@sigstore/core"))});

const data = { a: 1, b: "signed" };
const bytes = Buffer.from(JSON.stringify(data));
const tampered = Buffer.from(JSON.stringify({ ...data, a: 2 }));

function tufVerifies(type, scheme, keyType, digest, payload) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync(type, type === "ec" ? { namedCurve: "P-256" } : {});
  const key = Key.fromJSON("k", {
    keytype: keyType,
    scheme,
    keyval: { public: publicKey.export({ type: "spki", format: "pem" }) }
  });
  const sig = crypto.sign(digest, payload, privateKey).toString("hex");
  try {
    key.verifySignature({ signatures: { k: { sig } }, signed: { toJSON: () => data } });
    return true;
  } catch {
    return false;
  }
}

function coreVerifies(type, digest, payload) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync(type, type === "ec" ? { namedCurve: "P-256" } : {});
  return core.verify(bytes, publicKey, crypto.sign(digest, payload, privateKey));
}

console.log(JSON.stringify({
  runtime: process.versions.electron ?? null,
  tufEcdsa: tufVerifies("ec", "ecdsa-sha2-nistp256", "ecdsa", "sha256", bytes),
  tufEcdsaTampered: tufVerifies("ec", "ecdsa-sha2-nistp256", "ecdsa", "sha256", tampered),
  tufEd25519: tufVerifies("ed25519", "ed25519", "ed25519", null, bytes),
  coreEcdsa: coreVerifies("ec", "sha256", bytes),
  coreEcdsaTampered: coreVerifies("ec", "sha256", tampered),
  coreEd25519: coreVerifies("ed25519", null, bytes)
}));
`;

test("Sigstore and TUF signature helpers verify ECDSA in Electron's runtime", () => {
  const output = execFileSync(electron, ["-e", script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf8"
  });
  const result = JSON.parse(output.trim().split("\n").at(-1));
  assert.equal(typeof result.runtime, "string");
  assert.deepEqual(
    { ...result, runtime: undefined },
    {
      runtime: undefined,
      tufEcdsa: true,
      tufEcdsaTampered: false,
      tufEd25519: true,
      coreEcdsa: true,
      coreEcdsaTampered: false,
      coreEd25519: true
    }
  );
});
