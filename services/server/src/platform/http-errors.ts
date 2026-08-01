export class RequestValidationError extends Error {}

export class OriginDeniedError extends Error {}

export function apiError(code: string, message: string, details?: unknown) {
  return {
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details })
    }
  };
}

export function insufficientAccessError(
  requiredOperations: readonly string[],
  grantedOperations: readonly string[],
  message: string
) {
  const granted = new Set(grantedOperations);
  return apiError("insufficient_access", message, {
    required_operations: [...requiredOperations],
    granted_operations: [...grantedOperations],
    missing_operations: requiredOperations.filter((operation) => !granted.has(operation))
  });
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
