import type { JsonObject } from "@mdbase-dev/connect";

export type SchemaDateFormat = "date" | "date-time";

export function schemaDateFormat(schema?: JsonObject, value?: unknown): SchemaDateFormat | undefined {
  if (schema?.format === "date" || schema?.format === "date-time") return schema.format;
  // A date/date-time union is a declared temporal field, not arbitrary text.
  // Keep each persisted value in its own representation and use the same
  // local-time picker as a direct date-time declaration.
  const alternatives = schema?.anyOf ?? schema?.oneOf;
  if (!Array.isArray(alternatives) || !alternatives.length) return undefined;
  const formats: SchemaDateFormat[] = [];
  for (const alternative of alternatives) {
    if (!alternative || typeof alternative !== "object" || Array.isArray(alternative)) return undefined;
    if (alternative.type === "null") continue;
    const format = schemaDateFormat(alternative as JsonObject, value);
    if (!format) return undefined;
    formats.push(format);
  }
  if (!formats.length) return undefined;
  if (typeof value === "string" && value) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return formats.includes("date") ? "date" : undefined;
    if (/^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value))) return formats.includes("date-time") ? "date-time" : undefined;
    return undefined;
  }
  return formats.includes("date") ? "date" : "date-time";
}

export function schemaDateInputType(format: SchemaDateFormat): "date" | "datetime-local" {
  return format === "date" ? "date" : "datetime-local";
}

export function schemaDateInputValue(value: unknown, format: SchemaDateFormat): string {
  if (typeof value !== "string" || !value) return "";
  if (format === "date") return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 19);
}

export function schemaDateValue(input: string, format: SchemaDateFormat): string {
  if (!input || format === "date") return input;
  const date = new Date(input);
  return Number.isNaN(date.getTime()) ? input : date.toISOString();
}
