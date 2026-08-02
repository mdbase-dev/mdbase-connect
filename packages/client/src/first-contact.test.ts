import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { FirstContactBinding } from "@mdbase-dev/connect-protocol";
import {
  deriveFirstContactSas,
  FirstContactCryptoError
} from "./first-contact.js";

interface Fixture {
  binding: FirstContactBinding;
  application_private_key: string;
  connector_private_key: string;
  sas: string;
}

const fixture = JSON.parse(readFileSync(
  new URL("../../protocol/test/fixtures/first-contact-v1.json", import.meta.url),
  "utf8"
)) as Fixture;

describe("first-contact authentication string", () => {
  it("matches the shared Rust fixture from both endpoint roles", async () => {
    const application = await identity(
      fixture.application_private_key,
      fixture.binding.application_agreement_public_key
    );
    const connector = await identity(
      fixture.connector_private_key,
      fixture.binding.connector_agreement_public_key
    );
    await expect(deriveFirstContactSas(
      fixture.binding,
      "application",
      application
    )).resolves.toBe(fixture.sas);
    await expect(deriveFirstContactSas(
      fixture.binding,
      "connector",
      connector
    )).resolves.toBe(fixture.sas);
  });

  it("changes under control-plane key substitution", async () => {
    const application = await identity(
      fixture.application_private_key,
      fixture.binding.application_agreement_public_key
    );
    const attacker = await generatedIdentity();
    const substituted: FirstContactBinding = {
      ...fixture.binding,
      connector_agreement_public_key: attacker.agreementPublicKey
    };
    await expect(deriveFirstContactSas(
      substituted,
      "application",
      application
    )).resolves.not.toBe(fixture.sas);
  });

  it("rejects the wrong role and reused or malformed keys", async () => {
    const application = await identity(
      fixture.application_private_key,
      fixture.binding.application_agreement_public_key
    );
    await expect(deriveFirstContactSas(
      fixture.binding,
      "connector",
      application
    )).rejects.toMatchObject({ code: "identity_mismatch" });
    await expect(deriveFirstContactSas(
      {
        ...fixture.binding,
        application_signing_public_key:
          fixture.binding.application_agreement_public_key
      },
      "application",
      application
    )).rejects.toMatchObject({ code: "invalid_public_key" });
    await expect(deriveFirstContactSas(
      { ...fixture.binding, connector_agreement_public_key: "not-a-key" },
      "application",
      application
    )).rejects.toBeInstanceOf(FirstContactCryptoError);
  });
});

async function identity(
  privateKey: string,
  publicKey: string
): Promise<{ agreementPrivateKey: CryptoKey; agreementPublicKey: string }> {
  const raw = base64UrlBytes(publicKey);
  const agreementPrivateKey = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: bytesBase64Url(raw.slice(1, 33)),
      y: bytesBase64Url(raw.slice(33, 65)),
      d: privateKey,
      ext: true,
      key_ops: ["deriveBits"]
    },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"]
  );
  return { agreementPrivateKey, agreementPublicKey: publicKey };
}

async function generatedIdentity(): Promise<{
  agreementPrivateKey: CryptoKey;
  agreementPublicKey: string;
}> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  ) as CryptoKeyPair;
  const agreementPublicKey = bytesBase64Url(new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey)
  ));
  return { agreementPrivateKey: pair.privateKey, agreementPublicKey };
}

function base64UrlBytes(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function bytesBase64Url(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}
