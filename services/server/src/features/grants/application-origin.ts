import { normalizedApplicationOrigin } from "../authorizations/redirects.js";

type GrantWithOpaqueOrigin = Record<string, unknown> & {
  application_origin?: unknown;
};

/**
 * Keeps grant presentation usable when a persisted origin is absent or malformed.
 * Omitting the field grants no browser-origin authority, while the legacy `"null"`
 * sentinel remains compatible with older connectors.
 */
export function grantWithCompatibleApplicationOrigin<T extends GrantWithOpaqueOrigin>(
  grant: T
): Omit<T, "application_origin"> & { application_origin?: string } {
  const { application_origin: origin, ...rest } = grant;
  if (typeof origin !== "string") return rest;

  try {
    const normalized = normalizedApplicationOrigin(origin);
    if (normalized === "null" && origin !== "null") return rest;
    return { ...rest, application_origin: normalized };
  } catch {
    return rest;
  }
}
