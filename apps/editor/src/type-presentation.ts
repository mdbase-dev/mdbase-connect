import { t } from "@lingui/core/macro";
import type { TypeFieldKind } from "./type-schema";

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
