import type { GrantKeyRecord, GrantKeyStore } from "@mdbase/connect";
import type { DatabasePool } from "./db.js";
import { SecretBox } from "./security.js";

const MAX_U64 = "18446744073709551615";

export class PostgresGrantKeyStore implements GrantKeyStore {
  constructor(
    private readonly db: DatabasePool,
    private readonly secrets: SecretBox
  ) {}

  async create(handle: string): Promise<GrantKeyRecord> {
    const generated = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"]
    ) as CryptoKeyPair;
    const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", generated.publicKey)).toString("base64url");
    const privatePkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", generated.privateKey));
    await this.db.query(
      `INSERT INTO mcp_grant_keys (handle, public_key, private_key_ciphertext)
       VALUES ($1, $2, $3)`,
      [handle, publicKey, this.secrets.encrypt(privatePkcs8.toString("base64url"))]
    );
    return {
      handle,
      publicKey,
      privateKey: await importPrivateKey(privatePkcs8)
    };
  }

  async get(handle: string): Promise<GrantKeyRecord | null> {
    const result = await this.db.query<{ public_key: string; private_key_ciphertext: string }>(
      "SELECT public_key, private_key_ciphertext FROM mcp_grant_keys WHERE handle = $1",
      [handle]
    );
    const row = result.rows[0];
    if (!row) return null;
    const privatePkcs8 = Buffer.from(this.secrets.decrypt(row.private_key_ciphertext), "base64url");
    return {
      handle,
      publicKey: row.public_key,
      privateKey: await importPrivateKey(privatePkcs8)
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

function importPrivateKey(pkcs8: Buffer): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    Uint8Array.from(pkcs8).buffer,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"]
  );
}
