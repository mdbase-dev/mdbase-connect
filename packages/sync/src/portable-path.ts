import { SyncError } from "./sync-error.js";

const EMPTY_OR_DOT_COMPONENT = /(?:^|\/)(?:\.{1,2}|)(?:\/|$)/u;
const PLATFORM_UNSAFE_CHARACTER = /[\p{Cc}:?<>|*"]/u;
const PLATFORM_UNSAFE_ENDING = /[. ](?:\/|$)/u;
const RESERVED_WINDOWS_DEVICE =
  /(?:^|\/)(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|\/|$)/iu;

export function validatePortableMirrorPath(path: string): void {
  if (
    !path
    || path.startsWith("/")
    || path.includes("\\")
    || EMPTY_OR_DOT_COMPONENT.test(path)
    || PLATFORM_UNSAFE_CHARACTER.test(path)
    || PLATFORM_UNSAFE_ENDING.test(path)
    || RESERVED_WINDOWS_DEVICE.test(path)
  ) {
    throw new SyncError("invalid_path", `Mirror received an unsafe path: ${path}.`);
  }
}

/**
 * A conservative physical-filesystem identity shared by every mirror target.
 *
 * Windows and common macOS volumes are case-insensitive, while macOS also
 * aliases canonically equivalent Unicode spellings. Reject those collisions
 * before writing even when the current adapter happens to be case-sensitive.
 */
export function portableMirrorPathKey(path: string): string {
  validatePortableMirrorPath(path);
  return portableMirrorPathKeyForValidatedPath(path);
}

/** Internal fast path for callers that already enforced the portable policy. */
export function portableMirrorPathKeyForValidatedPath(path: string): string {
  if (/^[\x20-\x7e]+$/u.test(path)) {
    return /[A-Z]/u.test(path) ? path.toLowerCase() : path;
  }
  return path.normalize("NFC").toLowerCase().normalize("NFC");
}
