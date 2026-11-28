const SERVICE_UNAVAILABLE = "update_service_unavailable";

export class UpdateServiceUnavailable extends Error {
  readonly code = SERVICE_UNAVAILABLE;
}

export function isUpdateServiceUnavailable(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === SERVICE_UNAVAILABLE;
}
