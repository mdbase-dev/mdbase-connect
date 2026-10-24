import { t, plural } from "@lingui/core/macro";
import type { TypeFieldKind, VisualTypeDefinition } from "./type-schema";

export function kindLabel(kind: Exclude<TypeFieldKind, "advanced">): string {
  const labels: Record<Exclude<TypeFieldKind, "advanced">, string> = {
    string: t`text`,
    number: t`number`,
    integer: t`integer`,
    boolean: t`checkbox`,
    array: t`a list`,
    object: t`an object`,
    date: t`a date`,
    datetime: t`a date and time`
  };
  return labels[kind];
}

export function kindName(kind: TypeFieldKind): string {
  const labels: Record<TypeFieldKind, string> = {
    string: t({ message: "Text", context: "property type" }),
    number: t({ message: "Number", context: "property type" }),
    integer: t({ message: "Integer", context: "property type" }),
    boolean: t({ message: "Checkbox", context: "property type" }),
    array: t({ message: "List", context: "property type" }),
    object: t({ message: "Object", context: "property type" }),
    date: t({ message: "Date", context: "property type" }),
    datetime: t({ message: "Date and time", context: "property type" }),
    advanced: t({ message: "Advanced", context: "property type" })
  };
  return labels[kind];
}

export function collectionBehaviourSummary(definition: VisualTypeDefinition): string {
  const collection = definition.collection;
  const displayConfigured = Object.values(collection.display).some(Boolean);
  const pathConfigured = Boolean(collection.path.pattern || collection.path.folder || collection.path.template);
  const settings = [
    displayConfigured ? t`Display` : undefined,
    countSummary(collection.readDefaults.length, "default"),
    countSummary(collection.links.length, "link"),
    countSummary(collection.unique.length, "unique rule"),
    pathConfigured ? t`Path policy` : undefined,
    countSummary(collection.advancedKeys.length + collection.path.advancedKeys.length, "YAML setting")
  ].filter((value): value is string => Boolean(value));
  return settings.length ? settings.join(" · ") : t`No custom behaviour`;
}

export function countSummary(count: number, kind: "default" | "link" | "unique rule" | "YAML setting" | "field" | "path pattern" | "field selector" | "YAML rule"): string | undefined {
  if (!count) return undefined;
  switch (kind) {
    case "field": return plural(count, { one: "# field", other: "# fields" });
    case "path pattern": return plural(count, { one: "# path pattern", other: "# path patterns" });
    case "field selector": return plural(count, { one: "# field selector", other: "# field selectors" });
    case "YAML rule": return plural(count, { one: "# YAML rule", other: "# YAML rules" });
    case "default": return plural(count, { one: "# default", other: "# defaults" });
    case "link": return plural(count, { one: "# link", other: "# links" });
    case "unique rule": return plural(count, { one: "# unique rule", other: "# unique rules" });
    case "YAML setting": return plural(count, { one: "# YAML setting", other: "# YAML settings" });
  }
}

export const NEW_TYPE_SOURCE = `---
kind: mdbase.type
name: new-type
version: 1
description: Describe when this type should be used.
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    additionalProperties: true
    properties:
      title:
        type: string
---
`;
