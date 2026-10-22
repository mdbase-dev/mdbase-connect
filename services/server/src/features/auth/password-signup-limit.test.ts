import { describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { AuthenticationPolicyStore } from "../../authentication-policy.js";
import { createDatabase } from "../../db.js";
import { runtimeConfigFromEnv } from "../../runtime-config.js";
import { parsePasswordSignupIpMaxAttempts, passwordSignupIpRule } from "./password-signup-limit.js";

const setting = "MDBASE_CONNECT_PASSWORD_SIGNUP_IP_MAX_ATTEMPTS";
const startupEnv = { MDBASE_CONNECT_AUTH_RATE_LIMIT_SECRET: "x".repeat(32) };

describe("password signup IP rule", () => {
  it.each([{ environment: "production", maximum: undefined, allowed: 10 }, { environment: "staging", maximum: 12, allowed: 12 }, { environment: "lab", maximum: 12, allowed: 12 }])("shares the actual preview/signup HTTP budget in $environment", async ({ environment, maximum, allowed }) => {
    const db = await createDatabase("memory");
    let app: Awaited<ReturnType<typeof buildApp>>["app"] | undefined;
    const origin = "https://connect.example";
    try {
      const policy = new AuthenticationPolicyStore(db, "closed");
      await policy.update({ registrationMode: "invite", passwordAuthEnabled: true, emailDeliveryEnabled: false, termsVersion: "terms-test", privacyVersion: "privacy-test", expectedRevision: 0, updatedBy: "operator:test", reason: "Signup limit HTTP test" });
      ({ app } = await buildApp({ db, publicUrl: origin, environment, passwordSignupIpMaxAttempts: maximum, authRateLimitSecret: startupEnv.MDBASE_CONNECT_AUTH_RATE_LIMIT_SECRET, authenticationLegalDocuments: { termsUrl: "https://mdbase.dev/terms/", privacyUrl: "https://mdbase.dev/privacy/" } }));
      for (let attempt = 0; attempt <= allowed; attempt++) {
        const preview = attempt % 2 === 0;
        const payload = { invitation_token: `missing-invitation-${attempt}`, ...(!preview ? { name: "Synthetic test", password: "a durable synthetic test password", terms_version: "terms-test", privacy_version: "privacy-test" } : {}) };
        const response = await app.inject({ method: "POST", url: `/v1/auth/password/${preview ? "invitation" : "signup"}`, headers: { origin }, payload });
        if (attempt < allowed) expect(response.statusCode).not.toBe(429);
        else expect(response.statusCode).toBe(429);
      }
      const count = await db.query<{ attempt_count: number }>("SELECT attempt_count FROM auth_rate_limit_buckets WHERE scope = 'password.signup.ip'");
      expect(count.rows).toHaveLength(1);
      expect(count.rows[0].attempt_count).toBe(allowed + 1);
    } finally {
      await app?.close();
      await db.end();
    }
  });

  it.each([undefined, "production", "staging", "lab", "unspecified", "custom"])("keeps the unchanged default when unset in %s", environment => {
    const env = { MDBASE_CONNECT_ENVIRONMENT: environment };
    expect(parsePasswordSignupIpMaxAttempts(env)).toBeUndefined();
    expect(passwordSignupIpRule(environment)).toEqual({ maxAttempts: 10, windowSeconds: 3600, baseBlockSeconds: 900, maxBlockSeconds: 21600 });
    expect(runtimeConfigFromEnv({ ...startupEnv, ...env }).passwordSignupIpMaxAttempts).toBeUndefined();
  });

  it.each(["staging", "lab"])("allows a bounded override only in %s", environment => {
    const config = runtimeConfigFromEnv({ ...startupEnv, MDBASE_CONNECT_ENVIRONMENT: environment, [setting]: "2000" });
    expect(config.passwordSignupIpMaxAttempts).toBe(2000);
    expect(passwordSignupIpRule(config.environment, config.passwordSignupIpMaxAttempts)).toEqual({ maxAttempts: 2000, windowSeconds: 3600, baseBlockSeconds: 900, maxBlockSeconds: 21600 });
    for (const maximum of [1, 10000]) expect(passwordSignupIpRule(environment, maximum).maxAttempts).toBe(maximum);
  });

  it.each([undefined, "production", "unspecified", "custom", "Staging", "staging-copy"])("refuses startup with a set override in %s", environment => {
    expect(() => runtimeConfigFromEnv({ ...startupEnv, MDBASE_CONNECT_ENVIRONMENT: environment, [setting]: "2000" })).toThrow();
    expect(() => passwordSignupIpRule(environment, 2000)).toThrow(/only allowed in staging or lab/);
  });

  it.each(["", "0", "-1", "+10", "010", "1.5", "1e3", "Infinity", "NaN", "10001", "99999999999999999999", " 2000 "])("rejects malformed or unbounded setting %j", raw => {
    expect(() => runtimeConfigFromEnv({ ...startupEnv, MDBASE_CONNECT_ENVIRONMENT: "staging", [setting]: raw })).toThrow(/must be an integer from 1 to 10000/);
  });

  it.each(["", "10", "bad"])("refuses a production setting even if default-valued or malformed (%j)", raw => {
    expect(() => runtimeConfigFromEnv({ ...startupEnv, MDBASE_CONNECT_ENVIRONMENT: "production", [setting]: raw })).toThrow(/only allowed in staging or lab/);
  });

  it.each([0, -1, 1.5, Infinity, NaN, 10001])("rejects invalid programmatic override %s", maximum => {
    expect(() => passwordSignupIpRule("lab", maximum)).toThrow(/must be an integer from 1 to 10000/);
  });
});
