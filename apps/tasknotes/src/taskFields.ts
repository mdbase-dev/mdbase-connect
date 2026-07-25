import type {
  TaskFieldDefinition,
  TaskFrontmatter,
  TasknotesContract
} from "@mdbase/tasknotes";
import type { JsonObject } from "@mdbase/connect";

const EDITABLE_CORE_ROLES = new Set([
  "due",
  "scheduled",
  "contexts",
  "projects",
  "timeEstimate",
  "tags",
  "recurrence",
  "recurrenceAnchor"
]);

const INTERNAL_FIELDS = new Set(["id", "type", "types"]);

export function editableTaskFields(contract: TasknotesContract): TaskFieldDefinition[] {
  return contract.fields.filter((field) => {
    if (field.readOnly || field.kind === "unsupported" || INTERNAL_FIELDS.has(field.key)) {
      return false;
    }
    if (field.kind === "list" && field.itemKind !== "text" && field.itemKind !== "enum") {
      return false;
    }
    return field.role ? EDITABLE_CORE_ROLES.has(field.role) : true;
  });
}

export function requiredCreateFields(contract: TasknotesContract): TaskFieldDefinition[] {
  return editableTaskFields(contract).filter(
    (field) => field.required && field.defaultValue === undefined
  );
}

export function taskFieldValue(
  frontmatter: TaskFrontmatter,
  field: TaskFieldDefinition
): string | boolean {
  const value = getPath(frontmatter, field.key);
  if (field.kind === "boolean") return value === true;
  if (field.kind === "list") {
    return Array.isArray(value)
      ? value.filter((item) => typeof item === "string").join(", ")
      : "";
  }
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

export function taskFieldPatch(
  fields: readonly TaskFieldDefinition[],
  values: Record<string, string | boolean>
): JsonObject {
  const patch: JsonObject = {};
  for (const field of fields) {
    const value = values[field.key];
    if (field.kind === "boolean") {
      patch[field.key] = value === true;
      continue;
    }
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) {
      patch[field.key] = null;
      continue;
    }
    if (field.kind === "number" || field.kind === "integer") {
      const number = Number(text);
      if (!Number.isFinite(number) || (field.kind === "integer" && !Number.isInteger(number))) {
        throw new Error(`${field.label} must be a valid ${field.kind}.`);
      }
      patch[field.key] = number;
      continue;
    }
    if (field.kind === "list") {
      patch[field.key] = text
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      continue;
    }
    patch[field.key] = text;
  }
  return patch;
}

export function missingRequiredFields(
  fields: readonly TaskFieldDefinition[],
  values: Record<string, string | boolean>
): string[] {
  return fields
    .filter((field) => {
      const value = values[field.key];
      return field.kind === "boolean" ? false : !String(value ?? "").trim();
    })
    .map((field) => field.label);
}

function getPath(value: JsonObject, path: string): unknown {
  let current: unknown = value;
  for (const segment of path.split(".")) {
    if (!isObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
