import { AuthorityAdoptionError } from "./adoption-errors.js";

export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function requiredUuid(value: string, label: string): string {
  if (!UUID.test(value)) {
    throw new AuthorityAdoptionError(
      "invalid_authority_adoption",
      `${label} must be a UUID.`
    );
  }
  return value.toLowerCase();
}
