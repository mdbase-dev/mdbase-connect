import type { PropertyInfo, PropertyScalar } from "@mdbase-dev/ui/properties";
import type { JsonObject } from "./connect-types";
import { isObject, resolveSchema } from "./field-reference";
import type { LinkProperty } from "./record-links";
import { schemaDateFormat } from "./schema-date";

/** How far a schema that describes itself through its own parts is followed. */
const DEPTH = 6;

/** A record's fields as the property list describes them: what its types declare, in their
 * order, then the fields it must have that no type describes. A field under a link rule is a
 * link, to one record or to several. `values` are what the record holds: a field that may be a
 * day or a moment is described as the one it holds. */
export function propertyInfos(
  properties: Readonly<Record<string, JsonObject>>,
  required: readonly string[],
  links?: ReadonlyMap<string, LinkProperty>,
  values: JsonObject = {}
): PropertyInfo[] {
  const described = Object.entries(properties).map(([name, schema]) => {
    const info = propertyInfo(name, schema, schema, required.includes(name), 0, values[name]);
    const link = links?.get(name);
    return link ? { ...info, link: { many: link.many } } : info;
  });
  const undescribed = required.filter((name) => !Object.hasOwn(properties, name));
  return [...described, ...undescribed.map((name): PropertyInfo => ({ name, kind: "other", required: true }))];
}

function propertyInfo(name: string, schema: JsonObject, root: JsonObject, required: boolean, depth: number, value?: unknown): PropertyInfo {
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
    ...(options.length ? { options } : {})
  };
  if (type === "object") {
    if (depth >= DEPTH) return { ...base, kind: "group" };
    const requiredParts = Array.isArray(resolved.required) ? resolved.required : [];
    const parts = Object.entries(isObject(resolved.properties) ? resolved.properties : {})
      .flatMap(([part, child]) => isObject(child) ? [propertyInfo(part, child, root, requiredParts.includes(part), depth + 1, isObject(value) ? value[part] : undefined)] : []);
    const additional = resolved.additionalProperties;
    const rest = additional === false ? false : isObject(additional) ? propertyInfo("", additional, root, false, depth + 1) : undefined;
    return { ...base, kind: "group", parts, ...(rest !== undefined ? { rest } : {}) };
  }
  if (type === "array") {
    const items = isObject(resolved.items) && depth < DEPTH ? propertyInfo("", resolved.items, root, false, depth + 1) : undefined;
    return { ...base, kind: "list", ...(items ? { items } : {}) };
  }
  if (type === "boolean") return { ...base, kind: "boolean" };
  if (type === "number" || type === "integer") return { ...base, kind: "number" };
  const format = schemaDateFormat(resolved, value);
  if (type !== "string" && !format) return { ...base, kind: "other" };
  return { ...base, kind: "text", ...(format ? { format } : {}) };
}
