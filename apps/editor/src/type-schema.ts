import { parseDocument, type Document } from "yaml";
import type { NoteSummary } from "./model";

export type TypeFieldKind = "string" | "number" | "integer" | "boolean" | "string-list" | "date" | "datetime" | "object" | "advanced";

export interface TypeFieldDefinition {
  name: string;
  kind: TypeFieldKind;
  required: boolean;
  description?: string;
}

export interface VisualTypeDefinition {
  name: string;
  description: string;
  fields: TypeFieldDefinition[];
}

export interface TypeImpact {
  addedFields: string[];
  removedFields: string[];
  changedFields: string[];
  newlyRequired: string[];
  affectedNotes: number;
  missingRequired: Array<{ field: string; count: number }>;
}

interface ParsedTypeSource {
  document: Document;
  tail: string;
  value: Record<string, unknown>;
}

export function readVisualType(source: string): VisualTypeDefinition {
  const { value } = parseTypeSource(source);
  const schema = record(record(value.schema).value);
  const properties = record(schema.properties);
  const required = new Set(array(schema.required).filter((item): item is string => typeof item === "string"));
  return {
    name: typeof value.name === "string" ? value.name : "",
    description: typeof value.description === "string" ? value.description : "",
    fields: Object.entries(properties).map(([name, definition]) => ({
      name,
      kind: fieldKind(record(definition)),
      required: required.has(name),
      ...(typeof record(definition).description === "string" ? { description: record(definition).description as string } : {})
    }))
  };
}

export function updateTypeIdentity(source: string, field: "name" | "description", value: string): string {
  return mutate(source, (document) => document.setIn([field], value));
}

export function addTypeField(source: string): string {
  const visual = readVisualType(source);
  const existing = new Set(visual.fields.map((field) => field.name));
  let index = 1;
  let name = "field";
  while (existing.has(name)) name = `field-${++index}`;
  return mutate(source, (document) => document.setIn(["schema", "value", "properties", name], { type: "string" }));
}

export function renameTypeField(source: string, from: string, to: string): string {
  const name = to.trim();
  if (!name || name === from) return source;
  const visual = readVisualType(source);
  if (visual.fields.some((field) => field.name === name)) throw new Error(`A field named “${name}” already exists.`);
  return mutate(source, (document) => {
    const path = ["schema", "value", "properties"];
    const definition = document.getIn([...path, from]);
    document.setIn([...path, name], definition);
    document.deleteIn([...path, from]);
    const required = requiredFields(document).map((field) => field === from ? name : field);
    setRequiredFields(document, required);
  });
}

export function setTypeFieldKind(source: string, name: string, kind: Exclude<TypeFieldKind, "advanced">): string {
  return mutate(source, (document) => {
    const path = ["schema", "value", "properties", name];
    for (const key of ["type", "const", "enum", "format", "items", "properties", "additionalProperties"]) {
      document.deleteIn([...path, key]);
    }
    const definition = kindDefinition(kind);
    for (const [key, value] of Object.entries(definition)) document.setIn([...path, key], value);
  });
}

export function setTypeFieldRequired(source: string, name: string, required: boolean): string {
  return mutate(source, (document) => {
    const fields = new Set(requiredFields(document));
    if (required) fields.add(name);
    else fields.delete(name);
    setRequiredFields(document, [...fields]);
  });
}

export function removeTypeField(source: string, name: string): string {
  return mutate(source, (document) => {
    document.deleteIn(["schema", "value", "properties", name]);
    setRequiredFields(document, requiredFields(document).filter((field) => field !== name));
  });
}

export function typeImpact(previousSource: string | undefined, nextSource: string, notes: NoteSummary[], currentTypeName?: string): TypeImpact {
  const previous = previousSource ? readVisualType(previousSource) : { name: "", description: "", fields: [] };
  const next = readVisualType(nextSource);
  const before = new Map(previous.fields.map((field) => [field.name, field]));
  const after = new Map(next.fields.map((field) => [field.name, field]));
  const addedFields = [...after.keys()].filter((name) => !before.has(name));
  const removedFields = [...before.keys()].filter((name) => !after.has(name));
  const changedFields = [...after].filter(([name, field]) => before.has(name) && before.get(name)?.kind !== field.kind).map(([name]) => name);
  const newlyRequired = [...after].filter(([name, field]) => field.required && !before.get(name)?.required).map(([name]) => name);
  const typeNames = new Set([currentTypeName, previous.name, next.name].filter((name): name is string => Boolean(name)));
  const affected = notes.filter((note) => note.types.some((name) => typeNames.has(name)) || (typeof note.frontmatter.type === "string" && typeNames.has(note.frontmatter.type)));
  return {
    addedFields,
    removedFields,
    changedFields,
    newlyRequired,
    affectedNotes: affected.length,
    missingRequired: newlyRequired.map((field) => ({
      field,
      count: affected.filter((note) => !hasValue(note.frontmatter[field])).length
    })).filter((item) => item.count > 0)
  };
}

function parseTypeSource(source: string): ParsedTypeSource {
  const match = source.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---([\s\S]*)$/);
  if (!match) throw new Error("Type definitions need YAML frontmatter between --- markers.");
  const document = parseDocument(match[1]);
  if (document.errors.length) throw new Error(document.errors[0].message);
  const value = document.toJS();
  if (!isRecord(value)) throw new Error("The type definition must be a YAML object.");
  if (value.kind !== "mdbase.type") throw new Error("Type definitions must declare kind: mdbase.type.");
  return { document, tail: match[2], value };
}

function mutate(source: string, change: (document: Document) => void): string {
  const parsed = parseTypeSource(source);
  change(parsed.document);
  return `---\n${parsed.document.toString({ lineWidth: 0 })}---${parsed.tail}`;
}

function requiredFields(document: Document): string[] {
  const required = document.getIn(["schema", "value", "required"]);
  return Array.isArray(required) ? required.filter((item): item is string => typeof item === "string") : [];
}

function setRequiredFields(document: Document, fields: string[]) {
  if (fields.length) document.setIn(["schema", "value", "required"], fields);
  else document.deleteIn(["schema", "value", "required"]);
}

function fieldKind(definition: Record<string, unknown>): TypeFieldKind {
  if (definition.type === "string" && definition.format === "date") return "date";
  if (definition.type === "string" && definition.format === "date-time") return "datetime";
  if (definition.type === "array" && record(definition.items).type === "string") return "string-list";
  if (["string", "number", "integer", "boolean", "object"].includes(String(definition.type))) return definition.type as TypeFieldKind;
  return "advanced";
}

function kindDefinition(kind: Exclude<TypeFieldKind, "advanced">): Record<string, unknown> {
  if (kind === "date") return { type: "string", format: "date" };
  if (kind === "datetime") return { type: "string", format: "date-time" };
  if (kind === "string-list") return { type: "array", items: { type: "string" } };
  if (kind === "object") return { type: "object", additionalProperties: true };
  return { type: kind };
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
