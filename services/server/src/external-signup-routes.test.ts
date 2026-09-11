import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { AuthenticationPolicyStore } from "./authentication-policy.js";
import { createDatabase } from "./db.js";
import { createExternalSession } from "./external-auth.js";
import { tokenHash } from "./security.js";
import { ExternalSignupService } from "./external-signup.js";

const resources: Array<() => Promise<void>> = [];
afterEach(async () => { while (resources.length) await resources.pop()?.(); });
const origin = "https://connect.example";
const payload = { name: "New Person", terms_version: "terms-v1", privacy_version: "privacy-v1", timezone: "Australia/Melbourne" };

describe("external public signup", () => {
  it.each(["google", "github"] as const)("completes %s signup with consent, email, entitlement, welcome and starter setup", async (provider) => {
    const f = await fixture();
    const config = await f.app.inject({ url: "/v1/auth/config" });
    expect(config.json()).toMatchObject({ external_public_registration: true, agreements: { terms: { version: "terms-v1" } } });
    expect(config.json().password_public_registration).toBeUndefined();
    const proof = await f.start(provider, "/authorize/transaction?request=one");
    expect(proof.redirect).toContain("/signup?external=1");
    expect(proof.cookie).toContain("__Host-mdbase-signup=");
    expect(proof.setCookie).toMatch(/HttpOnly/);
    expect(proof.setCookie).toMatch(/Secure/);
    expect(proof.setCookie).toMatch(/SameSite=Lax/);
    expect((await f.db.query("SELECT id FROM users")).rows).toHaveLength(0);
    expect((await f.db.query("SELECT id FROM sessions")).rows).toHaveLength(0);
    const stored = (await f.db.query("SELECT * FROM external_signup_challenges")).rows;
    expect(JSON.stringify(stored)).not.toContain(proof.cookie.split("=")[1]);
    const preview = await f.preview(proof.cookie);
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toEqual({ proof_id: expect.stringMatching(/^[a-f0-9]{64}$/), provider, email: "new@example.com", name: "Provider Name" });
    const complete = await f.complete(proof.cookie);
    expect(complete.statusCode).toBe(200);
    expect(complete.json().redirect_to).toBe("/authorize/transaction?request=one");
    expect(cookies(complete).some((cookie) => cookie.startsWith("__Host-mdbase_session="))).toBe(true);
    const rows = await f.db.query(`SELECT email.verified_at, entitlement.profile_code, onboarding.timezone, job.message_kind
      FROM email_identities email JOIN account_entitlement_grants entitlement ON entitlement.user_id = email.user_id
      JOIN account_onboarding onboarding ON onboarding.user_id = email.user_id
      JOIN email_jobs job ON job.user_id = email.user_id`);
    expect(rows.rows).toEqual([expect.objectContaining({ profile_code: "open_beta_v1", timezone: "Australia/Melbourne", message_kind: "open_beta_welcome" })]);
    expect(rows.rows[0].verified_at).not.toBeNull();
    expect((await f.db.query("SELECT document, acceptance_method FROM account_agreements ORDER BY document")).rows).toEqual([
      { document: "privacy", acceptance_method: "external_identity" },
      { document: "terms", acceptance_method: "external_identity" }
    ]);
    expect((await f.db.query("SELECT user_id FROM password_credentials")).rows).toHaveLength(0);
    expect((await f.db.query("SELECT * FROM external_signup_challenges")).rows).toHaveLength(0);
    expect((await f.complete(proof.cookie)).statusCode).toBe(400);
    const login = await f.start(provider);
    expect(login.redirect).toBe("/");
    expect((await f.db.query("SELECT id FROM users")).rows).toHaveLength(1);
    expect((await f.db.query("SELECT user_id FROM account_onboarding")).rows).toHaveLength(1);
  });

  it.each(["https://evil.example/steal", "https://connect.example//evil.example/steal", "//evil.example/steal"])("routes default entry to getting started and rejects unsafe return target %s", async (returnTo) => {
    const f = await fixture();
    const proof = await f.start("google", returnTo);
    expect((await f.complete(proof.cookie)).json().redirect_to).toBe("/getting-started");
  });

  it("rejects missing proof, expiry, cross-origin completion and stale legal versions", async () => {
    const f = await fixture();
    expect((await f.complete("")).statusCode).toBe(400);
    const proof = await f.start("google");
    expect((await f.complete(proof.cookie, { ...payload, terms_version: "old" })).statusCode).toBe(400);
    expect((await f.app.inject({ method: "POST", url: "/v1/auth/external/signup", headers: { cookie: proof.cookie, origin: "https://evil.example" }, payload })).statusCode).toBe(403);
    expect((await f.app.inject({ method: "POST", url: "/v1/auth/external/signup/preview", headers: { cookie: proof.cookie }, payload: {} })).statusCode).toBe(403);
    expect((await f.db.query("SELECT id FROM users")).rows).toHaveLength(0);
    await f.db.query("UPDATE external_signup_challenges SET expires_at = now() - interval '1 second'");
    expect((await f.preview(proof.cookie)).statusCode).toBe(400);
    expect((await f.complete(proof.cookie)).statusCode).toBe(400);
  });

  it("applies the registration kill switch to an in-flight proof without disabling existing login", async () => {
    const f = await fixture();
    const proof = await f.start("google");
    await f.policy.update({ ...f.settings, registrationMode: "invite", expectedRevision: 1 });
    expect((await f.complete(proof.cookie)).statusCode).toBe(503);
    expect((await f.db.query("SELECT id FROM users")).rows).toHaveLength(0);
    const config = await f.app.inject({ url: "/v1/auth/config" });
    expect(config.json().external_public_registration).toBeUndefined();
  });

  it.each(["google", "github"] as const)("rejects unverified %s email before creating a proof or account", async (provider) => {
    const f = await fixture({ verified: false });
    const started = await f.start(provider);
    if (provider === "google") {
      expect(started.response.statusCode).toBe(400);
      expect(started.response.json().error.code).toBe("invalid_external_signup");
    } else {
      expect(started.response.statusCode).toBe(302);
      expect(started.redirect).toContain("/signup?auth_error=verified_email_required");
    }
    expect((await f.db.query("SELECT * FROM external_signup_challenges")).rows).toHaveLength(0);
    expect((await f.db.query("SELECT id FROM users")).rows).toHaveLength(0);
  });

  it("returns cancelled GitHub authorization to sign-in without an account and consumes its state", async () => {
    const f = await fixture();
    const start = await f.app.inject({ url: "/auth/github?return_to=%2Fdevice" });
    const state = new URL(start.headers.location!).searchParams.get("state");
    const cookie = cookies(start).find((value) => value.startsWith("__Host-mdbase_oauth_github="))!.split(";")[0];
    const cancelled = await f.app.inject({ url: `/auth/github/callback?error=access_denied&state=${state}`, headers: { cookie } });
    expect(cancelled.statusCode).toBe(302);
    expect(cancelled.headers.location).toBe("/login?auth_error=cancelled&return_to=%2Fdevice");
    expect((await f.db.query("SELECT id FROM users")).rows).toHaveLength(0);
    const replay = await f.app.inject({ url: `/auth/github/callback?code=replayed&state=${state}`, headers: { cookie } });
    expect(replay.statusCode).toBe(400);
  });

  it("rejects an in-flight proof after its provider is deconfigured", async () => {
    const f = await fixture();
    const proof = await f.start("google");
    const token = proof.cookie.split("=")[1];
    const deconfigured = new ExternalSignupService(f.db, f.policy, new Set(["github"]));
    await expect(deconfigured.details(token)).rejects.toMatchObject({ name: "PublicSignupUnavailableError" });
    await expect(deconfigured.complete(token, {
      proofId: tokenHash(token), name: "New Person", termsVersion: "terms-v1", privacyVersion: "privacy-v1", timezone: "UTC", clientName: "Test"
    })).rejects.toMatchObject({ name: "PublicSignupUnavailableError" });
    expect((await f.db.query("SELECT id FROM users")).rows).toHaveLength(0);
  });

  it("does not infer linking from matching email", async () => {
    const f = await fixture();
    await createExternalSession(f.db, { provider: "google", subject: "different-subject", name: "Existing", email: "new@example.com", emailVerified: true, login: null, avatarUrl: null });
    const proof = await f.start("github");
    const completed = await f.complete(proof.cookie);
    expect(completed.statusCode).toBe(403);
    expect(completed.json().error.message).toContain("account settings");
    expect((await f.db.query("SELECT id FROM users")).rows).toHaveLength(1);
    expect((await f.db.query("SELECT provider FROM external_identities")).rows).toEqual([{ provider: "google" }]);
  });

  it("rejects confirmation when another tab replaced the displayed identity's cookie", async () => {
    const f = await fixture();
    const first = await f.start("google");
    const preview = (await f.preview(first.cookie)).json();
    const second = await f.start("github");
    const response = await f.app.inject({
      method: "POST", url: "/v1/auth/external/signup",
      headers: { origin, cookie: second.cookie }, payload: { ...payload, proof_id: preview.proof_id }
    });
    expect(response.statusCode).toBe(400);
    expect((await f.db.query("SELECT id FROM users")).rows).toHaveLength(0);
    expect((await f.complete(second.cookie)).statusCode).toBe(200);
  });

  it("does not duplicate onboarding when two independent proofs authenticate the same subject", async () => {
    const f = await fixture();
    const first = await f.start("google");
    const second = await f.start("google");
    expect((await f.complete(first.cookie)).statusCode).toBe(200);
    expect((await f.complete(second.cookie)).statusCode).toBe(200);
    expect((await f.db.query("SELECT id FROM users")).rows).toHaveLength(1);
    expect((await f.db.query("SELECT id FROM account_entitlement_grants")).rows).toHaveLength(1);
    expect((await f.db.query("SELECT id FROM email_jobs")).rows).toHaveLength(1);
  });

  it("fails closed without the shared limiter or runtime legal documents", async () => {
    for (const missing of ["limiter", "legal"] as const) {
      const f = await fixture({ missing });
      expect((await f.app.inject({ url: "/v1/auth/config" })).json().external_public_registration).toBeUndefined();
      expect((await f.start("google")).response.statusCode).toBe(503);
      expect((await f.db.query("SELECT id FROM users")).rows).toHaveLength(0);
    }
  });

  it("limits preview separately from redemption using only digested keys", async () => {
    const f = await fixture();
    const proof = await f.start("google");
    for (let attempt = 0; attempt < 10; attempt++) expect((await f.preview(proof.cookie)).statusCode).toBe(200);
    const limited = await f.preview(proof.cookie);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
    expect((await f.complete(proof.cookie)).statusCode).toBe(200);
    const buckets = JSON.stringify((await f.db.query("SELECT * FROM auth_rate_limit_buckets")).rows);
    expect(buckets).not.toContain("new@example.com");
    expect(buckets).not.toContain("127.0.0.1");
    expect(buckets).not.toContain(proof.cookie.split("=")[1]);
  });
});

async function fixture(options: { verified?: boolean; missing?: "limiter" | "legal" } = {}) {
  const db = await createDatabase("memory");
  resources.push(() => db.end());
  const policy = new AuthenticationPolicyStore(db, "closed");
  const settings = { registrationMode: "open" as const, passwordAuthEnabled: false, emailDeliveryEnabled: false, termsVersion: "terms-v1", privacyVersion: "privacy-v1", expectedRevision: 0, updatedBy: "operator:test", reason: "Test social signup" };
  await policy.update(settings);
  const { app } = await buildApp({
    db, publicUrl: origin,
    authRateLimitSecret: options.missing === "limiter" ? undefined : "test-social-signup-digest-secret-at-least-32-bytes",
    authenticationLegalDocuments: options.missing === "legal" ? undefined : { termsUrl: `${origin}/terms`, privacyUrl: `${origin}/privacy` },
    googleAuth: { clientId: "google-client", allowedSubjects: new Set(), verifyCredential: async () => ({ id: "google-person", name: "Provider Name", email: "new@example.com", emailVerified: options.verified !== false, avatarUrl: null }) },
    githubAuth: { clientId: "github-client", clientSecret: "test-secret", allowedUserIds: new Set(), exchangeCode: async () => ({ id: "12345", login: "person", name: "Provider Name", email: "new@example.com", emailVerified: options.verified !== false }) }
  });
  resources.push(() => app.close());
  return {
    db, app, policy, settings,
    async start(provider: "google" | "github", returnTo = "/") {
      const start = await app.inject({ url: `/auth/${provider}?return_to=${encodeURIComponent(returnTo)}` });
      const cookie = cookies(start).find((value) => value.startsWith(`__Host-mdbase_oauth_${provider}=`))!.split(";")[0];
      const response = provider === "google"
        ? await app.inject({ method: "POST", url: "/auth/google/callback", headers: { origin, cookie, "x-mdbase-auth": "google" }, payload: { credential: "credential".repeat(20) } })
        : await app.inject({ url: `/auth/github/callback?code=one-time-code&state=${new URL(start.headers.location!).searchParams.get("state")}`, headers: { cookie } });
      if (provider === "github") expect(new URL(start.headers.location!).searchParams.get("scope")).toBe("user:email");
      const setCookie = cookies(response).find((value) => value.startsWith("__Host-mdbase-signup=")) ?? "";
      return { response, cookie: setCookie.split(";")[0], setCookie, redirect: provider === "google" ? response.json().redirect_to : response.headers.location };
    },
    preview(cookie: string) { return app.inject({ method: "POST", url: "/v1/auth/external/signup/preview", headers: { origin, cookie }, payload: {} }); },
    complete(cookie: string, input = payload) { return app.inject({ method: "POST", url: "/v1/auth/external/signup", headers: { origin, cookie }, payload: { ...input, proof_id: tokenHash(cookie.split("=")[1] ?? "") } }); }
  };
}

function cookies(response: { headers: Record<string, unknown> }): string[] {
  const values = response.headers["set-cookie"];
  return Array.isArray(values) ? values as string[] : typeof values === "string" ? [values] : [];
}
