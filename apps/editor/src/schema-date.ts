import type { JsonObject } from "@mdbase-dev/connect";

export type SchemaDateFormat = "date" | "date-time";

export function schemaDateFormat(schema?: JsonObject): SchemaDateFormat | undefined {
  return schema?.format === "date" || schema?.format === "date-time" ? schema.format : undefined;
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
