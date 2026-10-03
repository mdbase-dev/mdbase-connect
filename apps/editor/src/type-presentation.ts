import type { TypeFieldKind } from "./type-schema";

export function kindLabel(kind: Exclude<TypeFieldKind, "advanced">): string {
  const labels: Record<Exclude<TypeFieldKind, "advanced">, string> = {
    string: "text",
    number: "number",
    integer: "integer",
    boolean: "checkbox",
    array: "a list",
    object: "an object",
    date: "a date",
    datetime: "a date and time"
  };
  return labels[kind];
}

export function kindName(kind: TypeFieldKind): string {
  if (kind === "advanced") return "Advanced";
  const label = kindLabel(kind);
  return `${label.charAt(0).toLocaleUpperCase()}${label.slice(1)}`;
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
