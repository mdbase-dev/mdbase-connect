import { OAuth2Client } from "google-auth-library";
import { safeEqual } from "./security.js";

const googleVerifier = new OAuth2Client();

export interface GoogleIdentity {
  id: string;
  name: string;
  email: string | null;
  emailVerified: boolean;
  avatarUrl: string | null;
}

export interface GoogleCredentialVerification {
  credential: string;
  nonce: string;
}

export interface GoogleAuthConfig {
  clientId: string;
  allowedSubjects: ReadonlySet<string>;
  verifyCredential?: (input: GoogleCredentialVerification) => Promise<GoogleIdentity>;
}

export class GoogleIdentityError extends Error {}

export async function verifyGoogleCredential(
  config: GoogleAuthConfig,
  input: GoogleCredentialVerification
): Promise<GoogleIdentity> {
  if (config.verifyCredential) return config.verifyCredential(input);

  try {
    const ticket = await googleVerifier.verifyIdToken({
      idToken: input.credential,
      audience: config.clientId
    });
    const payload = ticket.getPayload();
    const subject = stringProperty(payload, "sub");
    const nonce = stringProperty(payload, "nonce");
    if (!subject || !nonce || !safeEqual(nonce, input.nonce)) {
      throw new GoogleIdentityError("Google returned an invalid identity or login nonce.");
    }
    const email = nullableStringProperty(payload, "email");
    const name = nullableStringProperty(payload, "name")
      ?? email?.split("@", 1)[0]
      ?? "Google account";
    return {
      id: subject,
      name,
      email,
      emailVerified: payload?.email_verified === true,
      avatarUrl: nullableStringProperty(payload, "picture")
    };
  } catch (error) {
    if (error instanceof GoogleIdentityError) throw error;
    throw new GoogleIdentityError("Google did not return a verifiable identity.");
  }
}

function stringProperty(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") return null;
  const property = (value as Record<string, unknown>)[key];
  return typeof property === "string" && property.length > 0 ? property : null;
}

function nullableStringProperty(value: unknown, key: string): string | null {
  return stringProperty(value, key);
}
