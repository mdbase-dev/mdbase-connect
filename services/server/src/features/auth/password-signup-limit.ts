import type { AuthRateLimitRule } from "../../auth-rate-limit.js";

export function passwordSignupIpRule(environment: string | undefined, maximum?: number): AuthRateLimitRule {
  if (maximum !== undefined) {
    if (environment !== "staging" && environment !== "lab") {
      throw new Error("MDBASE_CONNECT_PASSWORD_SIGNUP_IP_MAX_ATTEMPTS is only allowed in staging or lab.");
    }
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 10000) {
      throw new Error("MDBASE_CONNECT_PASSWORD_SIGNUP_IP_MAX_ATTEMPTS must be an integer from 1 to 10000.");
    }
  }
  return {
    maxAttempts: maximum ?? 10,
    windowSeconds: 60 * 60,
    baseBlockSeconds: 15 * 60,
    maxBlockSeconds: 6 * 60 * 60
  };
}

export function parsePasswordSignupIpMaxAttempts(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.MDBASE_CONNECT_PASSWORD_SIGNUP_IP_MAX_ATTEMPTS;
  if (raw === undefined) return undefined;
  const maximum = /^[1-9][0-9]{0,4}$/.test(raw) ? Number(raw) : NaN;
  passwordSignupIpRule(env.MDBASE_CONNECT_ENVIRONMENT?.trim(), maximum);
  return maximum;
}
