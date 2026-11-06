import { t } from "@lingui/core/macro";
import type { CollectionTypeDescriptor, JsonObject } from "@mdbase-dev/connect";
import { collectionDisplayField, declaredFields, fieldReferenceName } from "./field-reference";
import type { NoteSummary } from "./model";
import { humanizeName, resolveSchema } from "./SchemaValueEditor";

export type SortDirection = "asc" | "desc";
export type SortField = { name: string; label: string } & (
  | { kind: "date" | "date-time" | "number" | "text" }
  | { kind: "choice"; choices: ReadonlyArray<string | number> }
);

/** What the user chose. A field may be absent from the current scope. */
export interface NoteSortPreference {
  key: string;
  direction: SortDirection;
}

/** The order applied to the list, resolved against the fields in scope. */
export type NoteSort =
  | { key: "modified" | "title" | "path"; direction: SortDirection }
  | { key: "field"; field: SortField; direction: SortDirection };

export const defaultNoteSort: NoteSort = { key: "modified", direction: "desc" };

const fieldKeyPrefix = "field:";
const kindOrder: Array<SortField["kind"]> = ["date", "date-time", "choice", "number", "text"];
const storageKey = (collectionId: string) => `mdbase-editor:note-sort:${collectionId}`;

export function noteSortKey(sort: NoteSort): string {
  return sort.key === "field" ? `${fieldKeyPrefix}${sort.field.name}` : sort.key;
}

export function resolveNoteSort(preference: NoteSortPreference, fields: readonly SortField[]): NoteSort {
  const { key, direction } = preference;
  if (key === "modified" || key === "title" || key === "path") return { key, direction };
  const field = fields.find((candidate) => `${fieldKeyPrefix}${candidate.name}` === key);
  return field ? { key: "field", field, direction } : defaultNoteSort;
}

export function noteSortOptions(fields: readonly SortField[]) {
  return {
    properties: [
      { key: "modified", label: t`Modified` },
      { key: "title", label: t`Title` },
      { key: "path", label: t`Path` }
    ],
    fields: fields.map((field) => ({ key: `${fieldKeyPrefix}${field.name}`, label: field.label }))
  };
}

export function defaultSortDirection(key: string): SortDirection {
  return key === "modified" ? "desc" : "asc";
}

export function noteSortDirections(sort: NoteSort): Array<{ direction: SortDirection; label: string }> {
  const kind = sort.key === "field" ? sort.field.kind : sort.key;
  if (kind === "modified") return [
    { direction: "desc", label: t`Newest first` },
    { direction: "asc", label: t`Oldest first` }
  ];
  if (kind === "date" || kind === "date-time") return [
    { direction: "asc", label: t`Earliest first` },
    { direction: "desc", label: t`Latest first` }
  ];
  if (kind === "number") return [
    { direction: "asc", label: t`Low to high` },
    { direction: "desc", label: t`High to low` }
  ];
  if (kind === "choice") return [
    { direction: "asc", label: t`Listed order` },
    { direction: "desc", label: t`Reversed` }
  ];
  return [
    { direction: "asc", label: "A–Z" },
    { direction: "desc", label: "Z–A" }
  ];
}

/** Empty for the default order, which the list does not need to mention. */
export function noteSortSummary(sort: NoteSort): string {
  if (sort.key === defaultNoteSort.key && sort.direction === defaultNoteSort.direction) return "";
  const name = sort.key === "field" ? sort.field.label
    : noteSortOptions([]).properties.find((option) => option.key === sort.key)!.label;
  const direction = noteSortDirections(sort).find((option) => option.direction === sort.direction)!.label;
  return `${name}: ${direction}`;
}

export function loadNoteSort(collectionId: string): NoteSortPreference {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey(collectionId)) ?? "null");
    const { key, direction } = (value ?? {}) as Partial<NoteSortPreference>;
    if (typeof key === "string" && (direction === "asc" || direction === "desc")) return { key, direction };
  } catch { /* An unreadable preference falls back to the default order. */ }
  return { key: defaultNoteSort.key, direction: defaultNoteSort.direction };
}

export function saveNoteSort(collectionId: string, preference: NoteSortPreference): void {
  try { localStorage.setItem(storageKey(collectionId), JSON.stringify(preference)); }
  catch { /* Sorting still works for this session when storage is unavailable. */ }
}

/**
 * Fields declared by the types in scope that at least one note has a value for.
 * A name declared differently by two types has no single order, so it is left out.
 */
export function sortableFields(notes: readonly NoteSummary[], types: readonly CollectionTypeDescriptor[]): SortField[] {
  const scopedTypes = new Set(notes.flatMap((note) => note.types.map((name) => name.toLowerCase())));
  const declared = new Map<string, JsonObject | null>();
  for (const type of types) {
    if (!scopedTypes.has(type.name.toLowerCase())) continue;
    const nameField = fieldReferenceName(collectionDisplayField(type, "name_field"));
    for (const [name, schema] of declaredFields(type)) {
      if (name === nameField) continue;
      const resolved = resolveSchema(type.schema, schema) ?? schema;
      const previous = declared.get(name);
      declared.set(name, previous === undefined || JSON.stringify(previous) === JSON.stringify(resolved) ? resolved : null);
    }
  }
  return [...declared]
    .flatMap(([name, schema]) => {
      const field = schema && sortField(name, schema);
      return field && notes.some((note) => noteFieldValue(note, field) !== undefined) ? [field] : [];
    })
    .sort((left, right) => kindOrder.indexOf(left.kind) - kindOrder.indexOf(right.kind) || left.label.localeCompare(right.label));
}

function sortField(name: string, schema: JsonObject): SortField | undefined {
  const label = humanizeName(name);
  if (Array.isArray(schema.enum)) {
    const choices = schema.enum.filter((choice): choice is string | number => typeof choice === "string" || typeof choice === "number");
    return choices.length ? { name, label, kind: "choice", choices } : undefined;
  }
  const type = Array.isArray(schema.type) ? schema.type.find((item) => item !== "null") : schema.type;
  if (type === "number" || type === "integer") return { name, label, kind: "number" };
  if (type !== "string") return undefined;
  return { name, label, kind: schema.format === "date" || schema.format === "date-time" ? schema.format : "text" };
}

/** A comparable value: a timestamp, number, choice position or text. */
export function noteFieldValue(note: NoteSummary, field: SortField): number | string | undefined {
  const value = note.effectiveFrontmatter[field.name];
  if (field.kind === "choice") {
    const index = field.choices.indexOf(value as string | number);
    return index < 0 ? undefined : index;
  }
  if (field.kind === "number") return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || !value.trim()) return undefined;
  if (field.kind === "text") return value;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}
