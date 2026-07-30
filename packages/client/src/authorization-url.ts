import { MdbaseConnectError } from "./errors.js";

export function cleanAuthorizationParameters(url: URL): URL {
  for (const parameter of ["code", "state", "error", "error_description"]) {
    url.searchParams.delete(parameter);
  }
  return url;
}

export function isAuthorizationCallbackUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.searchParams.has("state")
    && (url.searchParams.has("code") || url.searchParams.has("error"));
}

export function authorizationReturnToFromError(error: unknown): string | undefined {
  if (!(error instanceof MdbaseConnectError)
      || !error.details
      || typeof error.details !== "object"
      || Array.isArray(error.details)) return undefined;
  const returnTo = (error.details as { returnTo?: unknown }).returnTo;
  return typeof returnTo === "string" ? returnTo : undefined;
}
