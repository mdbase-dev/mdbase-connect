export class SyncError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

export function asError(error: unknown): Error {
  return error instanceof Error ? error : Error(String(error));
}

export function errorCode(error: unknown, fallback: string): string {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : fallback;
}

export function invalidMirrorState(message: string): SyncError {
  return new SyncError("invalid_mirror_state", message);
}
