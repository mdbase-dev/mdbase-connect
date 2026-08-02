import { randomUUID } from "node:crypto";
import type { DatabaseQueryable } from "../../db.js";
import { randomToken, tokenHash } from "../../security.js";

export function deniedAuthorizationRedirect(input: { redirect_uri: string; state: string | null }): string {
  const redirect = new URL(input.redirect_uri);
  redirect.searchParams.set("error", "access_denied");
  if (input.state) redirect.searchParams.set("state", input.state);
  return redirect.href;
}

export function applicationOriginForRedirect(redirectUri: string, homepage: string): string {
  const redirect = new URL(redirectUri);
  return ["http:", "https:"].includes(redirect.protocol)
    ? redirect.origin
    : new URL(homepage).origin;
}

export function normalizedApplicationOrigin(value: string): string {
  return value === "null" ? "null" : new URL(value).origin;
}

export async function createAuthorizationRedirect(
  db: DatabaseQueryable,
  publicUrl: string,
  input: {
    application_id: string;
    grant_id: string;
    redirect_uri: string;
    state: string | null;
    code_challenge: string;
  }
): Promise<string> {
  const code = randomToken("code");
  await db.query(
    `INSERT INTO authorization_codes
       (id, code_hash, grant_id, application_id, redirect_uri, code_challenge, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + interval '2 minutes')`,
    [randomUUID(), tokenHash(code), input.grant_id, input.application_id, input.redirect_uri, input.code_challenge]
  );
  const redirect = new URL(input.redirect_uri);
  redirect.searchParams.set("code", code);
  if (input.state) redirect.searchParams.set("state", input.state);
  redirect.searchParams.set("iss", publicUrl);
  return redirect.href;
}
