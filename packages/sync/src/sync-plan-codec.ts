import { SyncError } from "./sync-error.js";

type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

/** RFC-8785-shaped JSON for the deliberately I-JSON-only sync domain. */
export function canonicalSyncJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function syncFingerprint(
  value: unknown,
  digest: (value: string) => string
): string {
  return `sha256:${digest(canonicalSyncJson(value))}`;
}

function canonicalize(value: unknown): CanonicalValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new SyncError(
        "invalid_sync_plan",
        "Sync plans contain only safe integer numeric values."
      );
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const output: { [key: string]: CanonicalValue } = {};
    for (const key of Object.keys(value as object).sort()) {
      const member = (value as Record<string, unknown>)[key];
      if (member === undefined) {
        throw new SyncError(
          "invalid_sync_plan",
          `Sync plan field ${key} is undefined rather than an explicit state.`
        );
      }
      output[key] = canonicalize(member);
    }
    return output;
  }
  throw new SyncError(
    "invalid_sync_plan",
    "Sync plans contain only canonical I-JSON values."
  );
}
