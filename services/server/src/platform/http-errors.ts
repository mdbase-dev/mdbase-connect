export class RequestValidationError extends Error {}

export class OriginDeniedError extends Error {}

export function apiError(code: string, message: string) {
  return { error: { code, message } };
}

export function oauthError(error: string, errorDescription: string) {
  return { error, error_description: errorDescription };
}

export function httpErrorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) {
    return undefined;
  }
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" ? statusCode : undefined;
}
