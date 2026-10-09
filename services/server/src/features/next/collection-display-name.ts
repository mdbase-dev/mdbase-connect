import { CreateError } from "./bootstrap-common.js";

export const DEFAULT_COLLECTION_DISPLAY_NAME = "New collection";

/** Display-only metadata: trim edges, but do not repair Unicode or normalize names. */
export function collectionDisplayName(value: unknown): string {
  if (typeof value !== "string" || /[\ud800-\udfff]/u.test(value) || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) {
    throw new CreateError(400, "invalid_display_name");
  }
  const name = value.trim();
  // Match the existing public naming limit: JavaScript UTF-16 code units.
  if (name.length === 0 || name.length > 200) throw new CreateError(400, "invalid_display_name");
  return name;
}
