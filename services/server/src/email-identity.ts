import { domainToASCII } from "node:url";

export const EMAIL_NORMALIZATION_VERSION = 1;

/**
 * Produces the stable account-identity key used for uniqueness and rate limits.
 *
 * This intentionally does not apply provider-specific rules such as removing
 * dots or plus-tags. Those rules can make distinct mailboxes collide. Callers
 * must still validate that the input is a syntactically valid email address.
 */
export function normalizeEmailAddress(value: string): string {
  const trimmed = value.trim().normalize("NFC");
  const separator = trimmed.lastIndexOf("@");
  if (
    separator <= 0
    || separator === trimmed.length - 1
    || trimmed.slice(0, separator).includes("@")
  ) {
    throw new InvalidEmailAddressError();
  }

  const localPart = trimmed.slice(0, separator).toLowerCase();
  const domain = domainToASCII(trimmed.slice(separator + 1)).toLowerCase();
  const normalized = `${localPart}@${domain}`;
  if (
    !domain
    || /\s/u.test(normalized)
    || normalized.length > 320
    || Buffer.byteLength(normalized, "utf8") > 320
  ) {
    throw new InvalidEmailAddressError();
  }
  return normalized;
}

export class InvalidEmailAddressError extends Error {
  constructor() {
    super("Email address cannot be normalized.");
    this.name = "InvalidEmailAddressError";
  }
}
