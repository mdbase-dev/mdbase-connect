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
  if (value === "null") return "null";
  const url = new URL(value);
  if (["chrome-extension:", "moz-extension:"].includes(url.protocol)) {
    if (
      !url.hostname
      || url.username
      || url.password
      || (url.pathname !== "" && url.pathname !== "/")
      || url.search
      || url.hash
    ) {
      throw new TypeError("The browser extension origin is invalid.");
    }
    return `${url.protocol}//${url.host}`;
  }
  return url.origin;
}

export function applicationOriginForDeviceRequest(origin: string | undefined): string {
  if (!origin || origin === "null") return "null";
  return normalizedApplicationOrigin(origin);
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
