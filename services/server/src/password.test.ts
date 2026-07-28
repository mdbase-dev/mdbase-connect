import { hash } from "@node-rs/argon2";
import { describe, expect, it } from "vitest";
import {
  PASSWORD_HASH_PARAMETERS,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PasswordPolicyError,
  hashPassword,
  passwordHashNeedsUpgrade,
  validateNewPassword,
  verifyPassword
} from "./password.js";

describe("password credentials", () => {
  it("stores salted Argon2id hashes with the configured work factors", async () => {
    const password = "a durable beta passphrase";
    const first = await hashPassword(password);
    const second = await hashPassword(password);

    expect(first).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(first).not.toBe(second);
    expect(await verifyPassword(first, password)).toBe(true);
    expect(await verifyPassword(first, "not the password")).toBe(false);
    expect(passwordHashNeedsUpgrade(first)).toBe(false);
  });

  it("recognizes hashes that need a work-factor or algorithm upgrade", async () => {
    const weaker = await hash("a durable beta passphrase", {
      ...PASSWORD_HASH_PARAMETERS,
      memoryCost: 12_288
    });
    expect(passwordHashNeedsUpgrade(weaker)).toBe(true);
    expect(passwordHashNeedsUpgrade("$scrypt$not-an-argon-hash")).toBe(true);
  });

  it("allows spaces and Unicode without composition rules", () => {
    expect(() => validateNewPassword("correct horse battery 🔋")).not.toThrow();
  });

  it("rejects short and unbounded passwords without truncating", async () => {
    expect(() => validateNewPassword("x".repeat(PASSWORD_MIN_LENGTH - 1)))
      .toThrow(PasswordPolicyError);
    expect(() => validateNewPassword("x".repeat(PASSWORD_MAX_LENGTH + 1)))
      .toThrow(PasswordPolicyError);
    await expect(
      verifyPassword("not-a-valid-hash", "x".repeat(PASSWORD_MAX_LENGTH + 1))
    ).resolves.toBe(false);
  });
});
