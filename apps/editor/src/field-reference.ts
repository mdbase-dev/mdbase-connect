import type { CollectionTypeDescriptor, JsonObject } from "@mdbase-dev/connect";

type DisplayField = "name_field" | "description_field" | "color_field" | "icon";

const descriptorIndexes = new WeakMap<
  CollectionTypeDescriptor[],
  Map<string, CollectionTypeDescriptor>
>();

export function collectionDisplayField(
  type: CollectionTypeDescriptor | undefined,
  field: DisplayField
): string | undefined {
  const collection = objectValue(type?.collection) ?? objectValue(objectValue(type?.definition)?.collection);
  const display = objectValue(collection?.display);
  return typeof display?.[field] === "string" && display[field].trim()
    ? display[field].trim()
    : undefined;
}

/** Field schemas a type declares, by name. */
export function declaredFields(type: CollectionTypeDescriptor): Array<[string, JsonObject]> {
  return Object.entries(objectValue(type.schema.properties) ?? {})
    .flatMap(([name, schema]) => {
      const field = objectValue(schema);
      return field ? [[name, field] as [string, JsonObject]] : [];
    });
}

export function recordDisplayField(
  recordTypes: string[],
  types: CollectionTypeDescriptor[],
  field: DisplayField
): string | undefined {
  let descriptors = descriptorIndexes.get(types);
  if (!descriptors) {
    descriptors = new Map(types.map((type) => [type.name.toLowerCase(), type]));
    descriptorIndexes.set(types, descriptors);
  }
  for (const typeName of recordTypes) {
    const reference = collectionDisplayField(descriptors.get(typeName.toLowerCase()), field);
    if (reference) return reference;
  }
  return undefined;
}

export function fieldReferencePath(reference: string | undefined): string[] | undefined {
  if (!reference) return undefined;
  if (reference.startsWith("/")) {
    if (reference === "/") return [""];
    return reference.slice(1).split("/").map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
  }
  const tokens = reference.split(".");
  if (!tokens.length || tokens.some((token) => !token || token.endsWith("[]"))) return undefined;
  return tokens;
}

export function fieldReferenceName(reference: string | undefined): string | undefined {
  return fieldReferencePath(reference)?.at(-1);
}

export function readFieldReference(value: JsonObject, reference: string | undefined): unknown {
  const path = fieldReferencePath(reference);
  if (!path) return undefined;
  let current: unknown = value;
  for (const token of path) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(token)) return undefined;
      current = current[Number(token)];
    } else {
      const object = objectValue(current);
      if (!object) return undefined;
      current = object[token];
    }
  }
  return current;
}

export function writeFieldReference(
  value: JsonObject,
  reference: string,
  nextValue: unknown
): JsonObject {
  const path = fieldReferencePath(reference);
  if (!path?.length) return value;
  return writePath(value, path, nextValue) as JsonObject;
}

export function fieldReferencePatch(
  frontmatter: JsonObject,
  reference: string,
  nextValue: unknown
): JsonObject {
  const path = fieldReferencePath(reference);
  if (!path?.length) return {};
  const updated = writeFieldReference(frontmatter, reference, nextValue);
  return { [path[0]]: structuredClone(updated[path[0]]) };
}

function writePath(current: unknown, path: string[], nextValue: unknown): unknown {
  const [token, ...rest] = path;
  if (token === undefined) return structuredClone(nextValue);

  if (Array.isArray(current)) {
    if (!/^(?:0|[1-9]\d*)$/u.test(token)) return current;
    const index = Number(token);
    const next = [...current];
    next[index] = rest.length ? writePath(next[index], rest, nextValue) : structuredClone(nextValue);
    return next;
  }

  const object = objectValue(current) ?? {};
  return {
    ...object,
    [token]: rest.length ? writePath(object[token], rest, nextValue) : structuredClone(nextValue)
  };
}

function objectValue(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

export function resolveSchema(
  rootSchema?: JsonObject,
  schema?: JsonObject,
  visited: Set<string> = new Set()
): JsonObject | undefined {
  if (!schema) return undefined;
  let resolved = { ...schema };
  if (typeof schema.$ref === "string" && schema.$ref.startsWith("#/") && rootSchema && !visited.has(schema.$ref)) {
    const target = resolveLocalReference(rootSchema, schema.$ref);
    if (target) {
      const nextVisited = new Set(visited);
      nextVisited.add(schema.$ref);
      const base = resolveSchema(rootSchema, target, nextVisited) ?? {};
      resolved = mergeSchemas(base, resolved);
      delete resolved.$ref;
    }
  }
  const branches = Array.isArray(resolved.allOf)
    ? resolved.allOf.filter((branch): branch is JsonObject => isObject(branch))
    : [];
  for (const branch of branches) {
    resolved = mergeSchemas(resolved, resolveSchema(rootSchema, branch, visited) ?? {});
  }
  delete resolved.allOf;
  return resolved;
}

function resolveLocalReference(rootSchema: JsonObject, reference: string): JsonObject | undefined {
  let current: unknown = rootSchema;
  for (const encoded of reference.slice(2).split("/")) {
    if (!isObject(current)) return undefined;
    const segment = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    current = current[segment];
  }
  return isObject(current) ? current : undefined;
}

function mergeSchemas(base: JsonObject, overlay: JsonObject): JsonObject {
  const merged: JsonObject = { ...base, ...overlay };
  const baseProperties = isObject(base.properties) ? base.properties : {};
  const overlayProperties = isObject(overlay.properties) ? overlay.properties : {};
  if (Object.keys(baseProperties).length || Object.keys(overlayProperties).length) {
    merged.properties = { ...baseProperties, ...overlayProperties };
  }
  const required = [
    ...(Array.isArray(base.required) ? base.required : []),
    ...(Array.isArray(overlay.required) ? overlay.required : [])
  ].filter((field): field is string => typeof field === "string");
  if (required.length) merged.required = [...new Set(required)];
  return merged;
}

export function humanizeName(name: string): string {
  return name
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

export function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
