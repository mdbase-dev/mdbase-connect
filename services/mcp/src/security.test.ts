import { describe, expect, it } from "vitest";
import { createDatabase } from "./db.js";
import { SecretBox, verifyMasterKey } from "./security.js";

describe("SecretBox", () => {
  it("encrypts service credentials with authenticated random nonces", () => {
    const box = new SecretBox(Buffer.alloc(32, 3));
    const first = box.encrypt("sensitive-token");
    const second = box.encrypt("sensitive-token");
    expect(first).not.toBe(second);
    expect(first).not.toContain("sensitive-token");
    expect(box.decrypt(first)).toBe("sensitive-token");
    const [version, nonce, sealedText] = first.split(".");
    const sealed = Buffer.from(sealedText, "base64url");
    sealed[0] ^= 1;
    expect(() => box.decrypt(`${version}.${nonce}.${sealed.toString("base64url")}`)).toThrow();
  });

  it("fails closed when a deployment uses the wrong master key", async () => {
    const db = await createDatabase("memory");
    await expect(verifyMasterKey(db, new SecretBox(Buffer.alloc(32, 1)))).resolves.toBeUndefined();
    await expect(verifyMasterKey(db, new SecretBox(Buffer.alloc(32, 2))))
      .rejects.toThrow("does not match the gateway database");
    await db.end();
  });
});
