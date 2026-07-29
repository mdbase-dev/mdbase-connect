import { describe, expect, it } from "vitest";
import { createDatabase } from "./db.js";
import { PostgresGrantKeyStore } from "./key-store.js";
import { SecretBox } from "./security.js";

describe("PostgresGrantKeyStore", () => {
  it("persists encrypted P-256 keys and advances counters atomically", async () => {
    const db = await createDatabase("memory");
    const store = new PostgresGrantKeyStore(db, new SecretBox(Buffer.alloc(32, 9)));
    const created = await store.create("grant:test");
    expect(created.agreementPublicKey).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(created.signingPublicKey).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(created.signingPublicKey).not.toBe(created.agreementPublicKey);
    expect(created.agreementPrivateKey.extractable).toBe(false);
    expect(created.signingPrivateKey.extractable).toBe(false);
    const persisted = await db.query<{
      agreement_private_key_ciphertext: string;
      signing_private_key_ciphertext: string;
    }>(
      `SELECT agreement_private_key_ciphertext, signing_private_key_ciphertext
       FROM mcp_grant_keys WHERE handle = $1`,
      ["grant:test"]
    );
    expect(persisted.rows[0].agreement_private_key_ciphertext)
      .not.toContain(created.agreementPublicKey);
    expect(persisted.rows[0].signing_private_key_ciphertext)
      .not.toContain(created.signingPublicKey);
    const loaded = await store.get("grant:test");
    expect(loaded?.agreementPublicKey).toBe(created.agreementPublicKey);
    expect(loaded?.signingPublicKey).toBe(created.signingPublicKey);
    expect(await Promise.all([store.nextCounter("grant:test"), store.nextCounter("grant:test")])).toEqual(["1", "2"]);
    await store.delete("grant:test");
    expect(await store.get("grant:test")).toBeNull();
    await db.end();
  });
});
