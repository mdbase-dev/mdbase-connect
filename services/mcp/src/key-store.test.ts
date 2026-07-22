import { describe, expect, it } from "vitest";
import { createDatabase } from "./db.js";
import { PostgresGrantKeyStore } from "./key-store.js";
import { SecretBox } from "./security.js";

describe("PostgresGrantKeyStore", () => {
  it("persists encrypted P-256 keys and advances counters atomically", async () => {
    const db = await createDatabase("memory");
    const store = new PostgresGrantKeyStore(db, new SecretBox(Buffer.alloc(32, 9)));
    const created = await store.create("grant:test");
    expect(created.publicKey).toMatch(/^[A-Za-z0-9_-]+$/);
    const persisted = await db.query<{ private_key_ciphertext: string }>(
      "SELECT private_key_ciphertext FROM mcp_grant_keys WHERE handle = $1",
      ["grant:test"]
    );
    expect(persisted.rows[0].private_key_ciphertext).not.toContain(created.publicKey);
    const loaded = await store.get("grant:test");
    expect(loaded?.publicKey).toBe(created.publicKey);
    expect(await Promise.all([store.nextCounter("grant:test"), store.nextCounter("grant:test")])).toEqual(["1", "2"]);
    await store.delete("grant:test");
    expect(await store.get("grant:test")).toBeNull();
    await db.end();
  });
});
