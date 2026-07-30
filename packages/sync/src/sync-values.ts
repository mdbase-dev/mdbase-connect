import type { JsonObject } from "@mdbase/connect-protocol";
import { SyncError } from "./sync-error.js";

export function explicitTypes(frontmatter: JsonObject): string[] {
  return [frontmatter.type, frontmatter.types]
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .filter((value): value is string => typeof value === "string");
}

export function assertSafePath(path: string): void {
  if (path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new SyncError("invalid_path", "Record paths must be safe collection-relative paths.");
  }
}

export function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyncError("invalid_input", "Expected an object.");
  return clone(value as JsonObject);
}

export function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new SyncError("invalid_input", `${name} must be a non-empty string.`);
  return value;
}

export function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string") throw new SyncError("invalid_input", `${name} must be a string.`);
  return value;
}

export function optionalText(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : requiredText(value, name);
}

export function stringList(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) {
    throw new SyncError("invalid_input", "types must be a list of non-empty strings.");
  }
  return [...new Set(value)];
}

export function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new SyncError("invalid_input", `${name} must be a non-negative integer.`);
  return value;
}

export function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new SyncError("invalid_input", `${name} must be a positive integer.`);
  return value;
}

export function positiveIntegerString(value: string, name: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw new SyncError("invalid_input", `${name} is invalid.`);
  return positiveInteger(Number(value), name);
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}
