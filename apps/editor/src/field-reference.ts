import type { CollectionTypeDescriptor, JsonObject } from "@mdbase-dev/connect";

export type DisplayField = "name_field" | "description_field" | "color_field";

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
