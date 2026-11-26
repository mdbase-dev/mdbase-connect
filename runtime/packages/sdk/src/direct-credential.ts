import { mdbaseError } from "./errors.js";

const SLOT_MS = 1_036_800_000;
const SLOT_COUNT = 32;
// WTP1, bearer, 1–16 decimal digits, and exactly 32 dot-prefixed SHA-256 hashes.
export const MIN_BUNDLE_BYTES = "WTP1.".length + 64 + 1 + 1 + SLOT_COUNT * 65;
export const MAX_BUNDLE_BYTES = MIN_BUNDLE_BYTES + 15;

function hex256(value: unknown): value is string {
  return typeof value === "string" && value.length === 64 && !/[^0-9a-f]/u.test(value);
}

interface Calendar { firstSlot: number; hashes: string[] }
interface Credential { bearer: string; calendar?: Calendar }

function parseBundle(server: string, bundle: unknown): Credential | undefined {
  if (typeof bundle !== "string" || bundle.length < MIN_BUNDLE_BYTES || bundle.length > MAX_BUNDLE_BYTES) return;
  const [version, bearer, decimal, ...hashes] = bundle.split(".");
  const firstSlot = Number(decimal);
  if (version !== "WTP1" || !hex256(bearer) || !Number.isSafeInteger(firstSlot) ||
      firstSlot < 0 || String(firstSlot) !== decimal || hashes.length !== SLOT_COUNT ||
      !hashes.every(hex256) || new Set(hashes).size !== SLOT_COUNT ||
      hashes[0] !== enrollmentPin(server)) return;
  return { bearer, calendar: { firstSlot, hashes } };
}

// Callers supply the exact descriptor already validated by directBackendOrigin.
export function enrollmentPin(server: string): string | undefined {
  return server.split("#sha256=")[1];
}

export function pairingGrant(server: string, response: unknown): string {
  if (enrollmentPin(server)) {
    if (parseBundle(server, response)) return JSON.stringify([server, response]);
  } else if (hex256(response)) return response;
  throw mdbaseError("invalid_request", "Invalid pairing response");
}

export function directCredential(server: string, token: unknown): Credential {
  if (enrollmentPin(server)) {
    // The canonical encoding contains only unescaped ASCII. Bound parsing even
    // for a credential supplied directly by a browser client.
    if (typeof token === "string" && token.length <= server.length + MAX_BUNDLE_BYTES + 7) {
      let envelope: unknown;
      try { envelope = JSON.parse(token); } catch { /* Invalid credential. */ }
      if (Array.isArray(envelope) && envelope.length === 2 && envelope[0] === server && typeof envelope[1] === "string" &&
          JSON.stringify(envelope) === token) {
        const credential = parseBundle(server, envelope[1]);
        if (credential) return credential;
      }
    }
  } else if (hex256(token)) return { bearer: token };
  throw mdbaseError("unauthenticated", "Invalid browser credential");
}

export function activePins(calendar?: Calendar): string[] {
  if (!calendar) return [];
  const index = Math.floor(Date.now() / SLOT_MS) - calendar.firstSlot;
  if (!Number.isSafeInteger(index) || index < 0 || index >= SLOT_COUNT) {
    throw mdbaseError("unavailable", "Local clock is outside the paired certificate calendar");
  }
  return calendar.hashes.slice(Math.max(0, index - 1), index + 2);
}
