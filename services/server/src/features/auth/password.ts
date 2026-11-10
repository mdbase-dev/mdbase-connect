import { Algorithm, Version, hash, verify } from "@node-rs/argon2";

export const PASSWORD_MIN_LENGTH = 15;
export const PASSWORD_MAX_LENGTH = 256;
export const PASSWORD_MAX_UTF8_BYTES = 1_024;

export const PASSWORD_HASH_PARAMETERS = Object.freeze({
  algorithm: Algorithm.Argon2id,
  version: Version.V0x13,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32
});

export class PasswordPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PasswordPolicyError";
  }
}

export function validateNewPassword(password: string): void {
  const characters = [...password].length;
  if (characters < PASSWORD_MIN_LENGTH) {
    throw new PasswordPolicyError(
      `Password must contain at least ${PASSWORD_MIN_LENGTH} characters.`
    );
  }
  if (
    characters > PASSWORD_MAX_LENGTH
    || Buffer.byteLength(password, "utf8") > PASSWORD_MAX_UTF8_BYTES
  ) {
    throw new PasswordPolicyError(
      `Password must contain no more than ${PASSWORD_MAX_LENGTH} characters.`
    );
  }
}

export async function hashPassword(password: string): Promise<string> {
  validateNewPassword(password);
  return hash(password, PASSWORD_HASH_PARAMETERS);
}

export async function verifyPassword(
  passwordHash: string,
  candidate: string
): Promise<boolean> {
  if (
    [...candidate].length > PASSWORD_MAX_LENGTH
    || Buffer.byteLength(candidate, "utf8") > PASSWORD_MAX_UTF8_BYTES
  ) {
    return false;
  }
  try {
    return await verify(passwordHash, candidate);
  } catch {
    return false;
  }
}

export function passwordHashNeedsUpgrade(passwordHash: string): boolean {
  const match = passwordHash.match(
    /^\$argon2id\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$/
  );
  if (!match) return true;
  const [, version, memoryCost, timeCost, parallelism] = match.map(Number);
  return version !== 19
    || memoryCost < PASSWORD_HASH_PARAMETERS.memoryCost
    || timeCost < PASSWORD_HASH_PARAMETERS.timeCost
    || parallelism < PASSWORD_HASH_PARAMETERS.parallelism;
}
