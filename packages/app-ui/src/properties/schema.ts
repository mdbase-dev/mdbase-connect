import type { PropertyInfo, PropertyScalar } from "./model.js";

/** A JSON Schema, or any part of one. */
export type JsonSchema = Readonly<Record<string, unknown>>;

/** How far a schema that describes itself through its own parts is followed. */
const DEPTH = 6;

/**
 * A record's fields as the property list describes them, from what its types declare in JSON
 * Schema: each declared property in order, then the fields it must have that nothing describes.
 * `links` marks the fields that link to other records. `values` are what the record holds: a field
 * that may be a day or a moment is described as the one it holds.
 */
export function propertiesFromSchema(
  properties: Readonly<Record<string, JsonSchema>>,
  required: readonly string[],
  links?: ReadonlyMap<string, { readonly many: boolean }>,
  values: Readonly<Record<string, unknown>> = {},
): PropertyInfo[] {
  const described = Object.entries(properties).map(([name, schema]) => {
    const info = describe(name, schema, schema, required.includes(name), 0, values[name]);
    const link = links?.get(name);
    return link ? { ...info, link: { many: link.many } } : info;
  });
  const undescribed = required.filter((name) => !Object.hasOwn(properties, name));
  return [...described, ...undescribed.map((name): PropertyInfo => ({ name, kind: "other", required: true }))];
}

/**
 * The properties and required fields several types declare together, as `propertiesFromSchema`
 * takes them: a later type's property replaces an earlier one's of the same name.
 */
export function mergeTypeSchemas(schemas: readonly JsonSchema[]): { properties: Record<string, JsonSchema>; required: string[] } {
  const properties: Record<string, JsonSchema> = {};
  const required = new Set<string>();
  for (const schema of schemas) {
    if (isObject(schema.properties)) {
      for (const [name, field] of Object.entries(schema.properties)) if (isObject(field)) properties[name] = field;
    }
    if (Array.isArray(schema.required)) for (const name of schema.required) if (typeof name === "string") required.add(name);
  }
  return { properties, required: [...required] };
}

function describe(name: string, schema: JsonSchema, root: JsonSchema, required: boolean, depth: number, value?: unknown): PropertyInfo {
  const resolved = resolveSchema(root, schema) ?? {};
  const declared = (Array.isArray(resolved.type) ? resolved.type : [resolved.type]).find((type) => typeof type === "string" && type !== "null");
  const type = declared
    ?? (isObject(resolved.properties) || Array.isArray(resolved.required) || "additionalProperties" in resolved ? "object" : undefined)
    ?? (isObject(resolved.items) ? "array" : undefined);
  const choices = "const" in resolved ? [resolved.const] : Array.isArray(resolved.enum) ? resolved.enum : [];
  const options = choices.filter((choice): choice is Exclude<PropertyScalar, null> => ["string", "number", "boolean"].includes(typeof choice));
  const base = {
    name,
    ...(required ? { required: true } : {}),
    ...(typeof resolved.description === "string" && resolved.description ? { description: resolved.description } : {}),
    ...(options.length ? { options } : {}),
  };
  if (type === "object") {
    if (depth >= DEPTH) return { ...base, kind: "group" };
    const requiredParts = Array.isArray(resolved.required) ? resolved.required : [];
    const parts = Object.entries(isObject(resolved.properties) ? resolved.properties : {})
      .flatMap(([part, child]) => isObject(child) ? [describe(part, child, root, requiredParts.includes(part), depth + 1, isObject(value) ? value[part] : undefined)] : []);
    const additional = resolved.additionalProperties;
    const rest = additional === false ? false : isObject(additional) ? describe("", additional, root, false, depth + 1) : undefined;
    return { ...base, kind: "group", parts, ...(rest !== undefined ? { rest } : {}) };
  }
  if (type === "array") {
    const items = isObject(resolved.items) && depth < DEPTH ? describe("", resolved.items, root, false, depth + 1) : undefined;
    return { ...base, kind: "list", ...(items ? { items } : {}) };
  }
  if (type === "boolean") return { ...base, kind: "boolean" };
  if (type === "number" || type === "integer") return { ...base, kind: "number" };
  const format = dateFormat(resolved, value);
  if (type !== "string" && !format) return { ...base, kind: "other" };
  return { ...base, kind: "text", ...(format ? { format } : {}) };
}

/** `date` or `date-time` when a schema declares one, or a union of only those; for a union, the one the value holds. */
function dateFormat(schema: JsonSchema, value?: unknown): "date" | "date-time" | undefined {
  if (schema.format === "date" || schema.format === "date-time") return schema.format;
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (!Array.isArray(alternatives) || !alternatives.length) return undefined;
  const formats: Array<"date" | "date-time"> = [];
  for (const alternative of alternatives) {
    if (!isObject(alternative)) return undefined;
    if (alternative.type === "null") continue;
    const format = dateFormat(alternative, value);
    if (!format) return undefined;
    formats.push(format);
  }
  if (!formats.length) return undefined;
  if (typeof value === "string" && value) {
    if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return formats.includes("date") ? "date" : undefined;
    if (/^\d{4}-\d{2}-\d{2}T/u.test(value) && !Number.isNaN(Date.parse(value))) return formats.includes("date-time") ? "date-time" : undefined;
    return undefined;
  }
  return formats.includes("date") ? "date" : "date-time";
}

/** A schema with its local `$ref` and `allOf` folded in. */
function resolveSchema(root: JsonSchema, schema: JsonSchema, visited: ReadonlySet<string> = new Set()): Record<string, unknown> {
  let resolved: Record<string, unknown> = { ...schema };
  if (typeof schema.$ref === "string" && schema.$ref.startsWith("#/") && !visited.has(schema.$ref)) {
    const target = localReference(root, schema.$ref);
    if (target) {
      resolved = merge(resolveSchema(root, target, new Set([...visited, schema.$ref])), resolved);
      delete resolved.$ref;
    }
  }
  const branches = Array.isArray(resolved.allOf) ? resolved.allOf.filter(isObject) : [];
  for (const branch of branches) resolved = merge(resolved, resolveSchema(root, branch, visited));
  delete resolved.allOf;
  return resolved;
}

function localReference(root: JsonSchema, reference: string): JsonSchema | undefined {
  let current: unknown = root;
  for (const encoded of reference.slice(2).split("/")) {
    if (!isObject(current)) return undefined;
    current = current[encoded.replaceAll("~1", "/").replaceAll("~0", "~")];
  }
  return isObject(current) ? current : undefined;
}

function merge(base: JsonSchema, overlay: JsonSchema): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base, ...overlay };
  const baseProperties = isObject(base.properties) ? base.properties : {};
  const overlayProperties = isObject(overlay.properties) ? overlay.properties : {};
  if (Object.keys(baseProperties).length || Object.keys(overlayProperties).length) merged.properties = { ...baseProperties, ...overlayProperties };
  const required = [...(Array.isArray(base.required) ? base.required : []), ...(Array.isArray(overlay.required) ? overlay.required : [])]
    .filter((field): field is string => typeof field === "string");
  if (required.length) merged.required = [...new Set(required)];
  return merged;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
