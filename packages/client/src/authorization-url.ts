import type { ConnectProblem } from "@mdbase-dev/connect-protocol";

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

export function authorizationReturnToFromProblem(problem: ConnectProblem): string | undefined {
  if (!problem.details
      || typeof problem.details !== "object"
      || Array.isArray(problem.details)) return undefined;
  const returnTo = (problem.details as { return_to?: unknown }).return_to;
  return typeof returnTo === "string" ? returnTo : undefined;
}
