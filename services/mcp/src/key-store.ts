import type { GrantKeyRecord, GrantKeyStore } from "@mdbase-dev/connect";
import type { DatabasePool } from "./db.js";
import { SecretBox } from "./security.js";

const MAX_U64 = "18446744073709551615";

export class PostgresGrantKeyStore implements GrantKeyStore {
  constructor(
    private readonly db: DatabasePool,
    private readonly secrets: SecretBox
  ) {}

  async create(handle: string): Promise<GrantKeyRecord> {
    const agreement = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"]
    ) as CryptoKeyPair;
    const signing = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"]
    ) as CryptoKeyPair;
    const agreementPublicKey = await exportPublicKey(agreement.publicKey);
    const agreementPkcs8 = await exportPrivateKey(agreement.privateKey);
    const signingPublicKey = await exportPublicKey(signing.publicKey);
    const signingPkcs8 = await exportPrivateKey(signing.privateKey);
    await this.db.query(
      `INSERT INTO mcp_grant_keys
         (handle, public_key, private_key_ciphertext,
          agreement_public_key, agreement_private_key_ciphertext,
          signing_public_key, signing_private_key_ciphertext)
       VALUES ($1, $2, $3, $2, $3, $4, $5)`,
      [
        handle,
        agreementPublicKey,
        this.secrets.encrypt(agreementPkcs8.toString("base64url")),
        signingPublicKey,
        this.secrets.encrypt(signingPkcs8.toString("base64url"))
      ]
    );
    return {
      handle,
      agreementPublicKey,
      agreementPrivateKey: await importAgreementPrivateKey(agreementPkcs8),
      signingPublicKey,
      signingPrivateKey: await importSigningPrivateKey(signingPkcs8)
    };
  }

  async get(handle: string): Promise<GrantKeyRecord | null> {
    const result = await this.db.query<{
      agreement_public_key: string | null;
      agreement_private_key_ciphertext: string | null;
      signing_public_key: string | null;
      signing_private_key_ciphertext: string | null;
    }>(
      `SELECT agreement_public_key, agreement_private_key_ciphertext,
              signing_public_key, signing_private_key_ciphertext
       FROM mcp_grant_keys WHERE handle = $1`,
      [handle]
    );
    const row = result.rows[0];
    if (!row?.agreement_public_key
        || !row.agreement_private_key_ciphertext
        || !row.signing_public_key
        || !row.signing_private_key_ciphertext) return null;
    const agreementPkcs8 = Buffer.from(
      this.secrets.decrypt(row.agreement_private_key_ciphertext),
      "base64url"
    );
    const signingPkcs8 = Buffer.from(
      this.secrets.decrypt(row.signing_private_key_ciphertext),
      "base64url"
    );
    return {
      handle,
      agreementPublicKey: row.agreement_public_key,
      agreementPrivateKey: await importAgreementPrivateKey(agreementPkcs8),
      signingPublicKey: row.signing_public_key,
      signingPrivateKey: await importSigningPrivateKey(signingPkcs8)
    };
  }

  async nextCounter(handle: string): Promise<string> {
    const result = await this.db.query<{ counter: string }>(
      `UPDATE mcp_grant_keys SET counter = counter + 1
       WHERE handle = $1 AND counter < $2::numeric
       RETURNING counter::text`,
      [handle, MAX_U64]
    );
    if (!result.rows[0]) throw new Error("The encrypted grant key is missing or its counter is exhausted.");
    return result.rows[0].counter;
  }

  async delete(handle: string): Promise<void> {
    await this.db.query("DELETE FROM mcp_grant_keys WHERE handle = $1", [handle]);
  }
}

function exportPublicKey(key: CryptoKey): Promise<string> {
  return crypto.subtle.exportKey("raw", key)
    .then((value) => Buffer.from(value).toString("base64url"));
}

function exportPrivateKey(key: CryptoKey): Promise<Buffer> {
  return crypto.subtle.exportKey("pkcs8", key)
    .then((value) => Buffer.from(value));
}

function importAgreementPrivateKey(pkcs8: Buffer): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    Uint8Array.from(pkcs8).buffer,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"]
  );
}

function importSigningPrivateKey(pkcs8: Buffer): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    Uint8Array.from(pkcs8).buffer,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
}
