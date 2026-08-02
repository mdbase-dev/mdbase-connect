import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type {
  ApplicationAuthorizationBinding,
  ApplicationAuthorizationProof
} from "@mdbase-dev/connect-protocol";
import {
  applicationInstallationId,
  authorizationSigningMessage,
  signApplicationAuthorization
} from "./application-identity.js";
import { MemoryGrantKeyStore } from "./crypto.js";

interface Fixture {
  binding: ApplicationAuthorizationBinding;
  signing_message_sha256: string;
}

const fixture = JSON.parse(readFileSync(
  new URL("../../protocol/test/fixtures/application-authorization-v1.json", import.meta.url),
  "utf8"
)) as Fixture;

describe("application authorization identity", () => {
  it("matches the shared Rust installation id and transcript fixture", async () => {
    await expect(applicationInstallationId({
      agreementPublicKey: fixture.binding.installation_agreement_public_key,
      signingPublicKey: fixture.binding.installation_signing_public_key
    })).resolves.toBe(fixture.binding.application_installation_id);
    const digest = new Uint8Array(await crypto.subtle.digest(
      "SHA-256",
      authorizationSigningMessage(fixture.binding) as BufferSource
    ));
    expect(hex(digest)).toBe(fixture.signing_message_sha256);
  });

  it("creates a canonical P-256 proof that verifies and rejects tampering", async () => {
    const store = new MemoryGrantKeyStore();
    const identity = await store.create("installation");
    const grant = await store.create("grant");
    const binding: ApplicationAuthorizationBinding = {
      ...fixture.binding,
      application_installation_id: await applicationInstallationId(identity),
      installation_agreement_public_key: identity.agreementPublicKey,
      installation_signing_public_key: identity.signingPublicKey,
      grant_agreement_public_key: grant.agreementPublicKey,
      grant_signing_public_key: grant.signingPublicKey
    };
    const proof = await signApplicationAuthorization(binding, identity);
    expect(base64UrlBytes(proof.signature)).toHaveLength(64);
    await expect(verify(proof)).resolves.toBe(true);
    await expect(verify({
      ...proof,
      binding: { ...binding, state: "substituted" }
    })).resolves.toBe(false);
  });

  it("rejects invalid flow shapes, repeated operations, and noncanonical values", () => {
    expect(() => authorizationSigningMessage({
      ...fixture.binding,
      flow: "device_code"
    })).toThrow("binding is invalid");
    expect(() => authorizationSigningMessage({
      ...fixture.binding,
      requested_operations: ["read", "read"]
    })).toThrow("binding is invalid");
    expect(() => authorizationSigningMessage({
      ...fixture.binding,
      authorization_nonce: `${fixture.binding.authorization_nonce}=`
    })).toThrow("base64url");
    expect(() => authorizationSigningMessage({
      ...fixture.binding,
      flow: "invalid" as "authorization_code"
    })).toThrow("binding is invalid");
  });
});

async function verify(proof: ApplicationAuthorizationProof): Promise<boolean> {
  const publicKey = await crypto.subtle.importKey(
    "raw",
    base64UrlBytes(proof.binding.installation_signing_public_key) as BufferSource,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"]
  );
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    base64UrlBytes(proof.signature) as BufferSource,
    authorizationSigningMessage(proof.binding) as BufferSource
  );
}

function base64UrlBytes(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
