import { t } from "@lingui/core/macro";
import type { CollectionTypeDescriptor, JsonObject } from "@mdbase-dev/connect";
import {
  collectionDisplayField,
  fieldReferenceName,
  fieldReferencePath,
  humanizeName,
  resolveSchema,
  writeFieldReference
} from "./field-reference";
import type { CreateNoteInput } from "./model";
import { folder, safeRenamePath, untitledPath } from "./note";
import type { NoteFilter } from "./note-list-view";
import { schemaInitialValue, schemaProperties, schemaRequired, schemaValueComplete } from "./SchemaValueEditor";

/**
 * A note that is open in the editor but not written yet. It is written the
 * first time it has something to keep and its type's required fields are
 * filled; until then it exists only in this tab.
 */
export interface NewNote {
  /** Names the create, so a retry lands once, and keys the editor, which survives the first save. */
  id: string;
  type?: string;
  folder?: string;
  title: string;
  body: string;
  properties: JsonObject;
  /** What the type and context supplied: a note whose properties still match is untouched. */
  initialProperties: JsonObject;
  /** The property fields report their own validity (formats, patterns). */
  propertiesValid: boolean;
}

export interface NewNoteContext {
  title?: string;
  folder?: string;
  tag?: string;
  type?: string;
  /** Values the note starts with, over its type's defaults: a person record's link to its account. */
  properties?: JsonObject;
}

/** What a type asks of a new note: its name field and the fields that must be filled before it can be written. */
export interface NewNoteForm {
  type?: CollectionTypeDescriptor;
  /** The declared `collection.display.name_field`, when it is text the title input can write. */
  titleField?: string;
  titleLabel?: string;
  /** The name field's label when the type requires it: the note needs a title before it can be written. */
  requiredTitle?: string;
  schema: JsonObject;
  properties: Record<string, JsonObject>;
  required: string[];
}

export function newNoteEditorKey(note: Pick<NewNote, "id">): string {
  return `new-note-${note.id}`;
}

/**
 * Where a new note starts from the list being looked at: its folder, tag or
 * type, and the type that claims the folder or the tag when there is one.
 */
export function newNoteContext(filter: NoteFilter | undefined, types: CollectionTypeDescriptor[]): NewNoteContext {
  if (filter?.kind === "tag") {
    const claiming = types.find((type) => typeTag(type) === filter.value);
    return { tag: filter.value, ...(claiming ? { type: claiming.name } : {}) };
  }
  if (filter?.kind === "type") return { type: filter.value };
  if (filter?.kind !== "folder") return {};
  const claiming = types
    .map((type) => ({ name: type.name, folder: typeFolder(type) }))
    .filter((type) => type.folder && (filter.value === type.folder || filter.value.startsWith(`${type.folder}/`)))
    .sort((left, right) => right.folder!.length - left.folder!.length)[0];
  return { folder: filter.value, ...(claiming ? { type: claiming.name } : {}) };
}

export function beginNewNote(context: NewNoteContext, types: CollectionTypeDescriptor[]): NewNote {
  const type = types.find((candidate) => candidate.name === context.type);
  const form = newNoteForm(type?.name, types);
  const properties = { ...seededProperties(type, context.tag), ...context.properties };
  for (const field of form.required) properties[field] ??= schemaInitialValue(form.properties[field], form.schema) as JsonObject[string];
  return {
    id: crypto.randomUUID(),
    ...(type ? { type: type.name } : {}),
    ...(context.folder === undefined ? {} : { folder: context.folder }),
    title: context.title ?? "",
    body: "",
    properties,
    initialProperties: properties,
    propertiesValid: true
  };
}

/** The note with `change` applied, or the same note when it changes nothing: the property fields report their validity on every render. */
export function changedNewNote(note: NewNote, change: Partial<NewNote>): NewNote {
  const unchanged = (Object.keys(change) as (keyof NewNote)[]).every((key) => Object.is(note[key], change[key]));
  return unchanged ? note : { ...note, ...change };
}

export function newNoteForm(typeName: string | undefined, types: CollectionTypeDescriptor[]): NewNoteForm {
  const type = types.find((candidate) => candidate.name === typeName);
  const declared = collectionDisplayField(type, "name_field");
  const declaredSchema = schemaAtFieldReference(type?.schema, declared);
  const titleField = isTextField(declaredSchema) ? declared : undefined;
  const titlePath = fieldReferencePath(titleField);
  const titleLabel = titleField && schemaFieldLabel(titleField, declaredSchema);
  const titleRequired = titlePath?.length === 1 && schemaRequired(resolveSchema(type?.schema, type?.schema)).includes(titlePath[0]);
  const schema = creationSchema(type?.schema, titleField);
  const resolved = resolveSchema(schema, schema);
  const properties = schemaProperties(resolved);
  const setOnCreate = fieldsSetOnCreate(type);
  return {
    ...(type ? { type } : {}),
    ...(titleField ? { titleField, titleLabel } : {}),
    ...(titleRequired ? { requiredTitle: titleLabel } : {}),
    schema,
    properties,
    required: schemaRequired(resolved).filter((field) => field !== "type" && !schemaSuppliesValue(properties[field]) && !setOnCreate.has(field))
  };
}

/** Top-level fields the type's `lifecycle.on_create` assigns: the runtime sets them before it validates the new record. */
function fieldsSetOnCreate(type?: CollectionTypeDescriptor): Set<string> {
  const actions = type?.lifecycle?.on_create;
  if (!Array.isArray(actions)) return new Set();
  return new Set(actions.flatMap((action) => {
    const set = action && typeof action === "object" && !Array.isArray(action) ? action.set : undefined;
    if (!set || typeof set !== "object" || Array.isArray(set)) return [];
    return Object.keys(set).flatMap((field) => {
      const path = fieldReferencePath(field);
      return path?.length === 1 ? path : [];
    });
  }));
}

/** Whether there is anything to keep: an untouched new note is dropped when it is left. */
export function newNoteStarted(note: NewNote): boolean {
  return Boolean(note.title.trim() || note.body.trim() || JSON.stringify(note.properties) !== JSON.stringify(note.initialProperties));
}

/** Why the note cannot be written yet, in the person's terms. */
export function newNoteBlocker(note: NewNote, form: NewNoteForm): string | undefined {
  const label = form.requiredTitle;
  if (label && !note.title.trim()) return t`${label} is needed to save this note.`;
  if (!form.required.every((field) => schemaValueComplete(form.properties[field], note.properties[field], form.schema))) {
    return t`Fill in the required properties.`;
  }
  return note.propertiesValid ? undefined : t`Fix the highlighted property values.`;
}

/** Every path in use, as the file-name search compares them: without case. */
export function occupiedPaths(paths: Iterable<string>): Set<string> {
  const occupied = new Set<string>();
  for (const path of paths) occupied.add(path.toLocaleLowerCase());
  return occupied;
}

/** The create for this note. `occupied` (see `occupiedPaths`) keeps its file name off every path in use. */
export function newNoteInput(note: NewNote, form: NewNoteForm, occupied: ReadonlySet<string>): CreateNoteInput {
  const title = note.title.trim();
  const properties = title && form.titleField
    ? writeFieldReference({ ...note.properties }, form.titleField, title)
    : { ...note.properties };
  return {
    id: note.id,
    title,
    body: note.body,
    path: newNotePath(note, form, occupied),
    ...(form.type ? { type: form.type.name } : {}),
    ...(form.titleField ? { titleField: form.titleField } : {}),
    properties
  };
}

/** Where the note will be written: its folder, then its title, or "Untitled" until it has one. */
export function newNotePath(note: Pick<NewNote, "folder" | "title">, form: Pick<NewNoteForm, "type">, occupied: ReadonlySet<string>): string {
  return freePath(note.folder ?? typeFolder(form.type) ?? "", fileStem(note.title) || "Untitled", occupied);
}

/**
 * The path an untitled note takes the first time it is given a title, or
 * nothing when the note already has a name of its own.
 */
export function titledPath(path: string, title: string, occupied: ReadonlySet<string>): string | undefined {
  const stem = fileStem(title);
  if (!untitledPath(path) || !stem || untitledPath(`${stem}.md`)) return undefined;
  return freePath(folder(path), stem, occupied);
}

/** A file stem from a title: the characters file systems refuse become hyphens. */
function fileStem(title: string): string {
  return title.trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").replace(/^\.+/, "");
}

/** Suffixes follow the collection runtime's own allocation: "Name (2).md". */
function freePath(directory: string, stem: string, occupied: ReadonlySet<string>): string {
  const prefix = safeRenamePath(directory).replace(/\/+$/g, "");
  const candidate = (name: string) => prefix ? `${prefix}/${name}.md` : `${name}.md`;
  let path = candidate(stem);
  for (let suffix = 2; occupied.has(path.toLocaleLowerCase()); suffix += 1) path = candidate(`${stem} (${suffix})`);
  return path;
}

function typeFolder(type?: CollectionTypeDescriptor): string | undefined {
  const match = type?.definition?.match;
  if (!match || Array.isArray(match) || typeof match !== "object") return undefined;
  const glob = (match as Record<string, unknown>).path_glob;
  if (typeof glob !== "string") return undefined;
  const prefix = glob.split(/[?*[{]/, 1)[0].replace(/\/+$/g, "");
  return prefix && !prefix.includes(".") ? prefix : undefined;
}

/**
 * The tag that alone puts a note under the type: a `match` that asks only for
 * `tags` to contain it. The runtime gives a note with that tag the type
 * whatever the editor calls it, so the note has to start as one.
 */
function typeTag(type: CollectionTypeDescriptor): string | undefined {
  const match = type.definition?.match;
  if (!isObject(match) || Object.keys(match).length !== 1 || !isObject(match.where)) return undefined;
  const tags = match.where.tags;
  if (Object.keys(match.where).length !== 1 || !isObject(tags) || Object.keys(tags).length !== 1) return undefined;
  return typeof tags.contains === "string" ? tags.contains : undefined;
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The runtime persists no read defaults, so a new note carries its type's defaults itself. */
function seededProperties(type?: CollectionTypeDescriptor, tag?: string): JsonObject {
  const shape = resolveSchema(type?.schema, type?.schema);
  const declared = schemaProperties(shape);
  const properties: JsonObject = Object.fromEntries(Object.entries(declared).flatMap(([name, schema]) => {
    if ("default" in schema) return [[name, structuredClone(schema.default)]];
    if ("const" in schema) return [[name, structuredClone(schema.const)]];
    return [];
  }));
  if (!tag) return properties;
  if (declared.tags?.type === "string") {
    properties.tags = tag;
    return properties;
  }
  const existing = properties.tags;
  const values = Array.isArray(existing)
    ? existing.filter((value): value is string => typeof value === "string")
    : typeof existing === "string" ? [existing] : [];
  properties.tags = [...new Set([...values, tag])];
  return properties;
}

function schemaSuppliesValue(schema?: JsonObject): boolean {
  return Boolean(schema && ("default" in schema || "const" in schema));
}

function schemaAtFieldReference(root: JsonObject | undefined, reference: string | undefined): JsonObject | undefined {
  const path = fieldReferencePath(reference);
  if (!root || !path) return undefined;
  let current = resolveSchema(root, root);
  for (const token of path) {
    const property = schemaProperties(current)[token];
    if (!property) return undefined;
    current = resolveSchema(root, property);
  }
  return current;
}

/** The type's schema without the fields the editor writes itself: `type` and the title's name field. */
function creationSchema(root: JsonObject | undefined, titleField: string | undefined): JsonObject {
  const resolved = structuredClone(resolveSchema(root, root) ?? { type: "object", properties: {} });
  const hidden = [["type"], ...(fieldReferencePath(titleField) ? [fieldReferencePath(titleField)!] : [])];
  for (const path of hidden) removeSchemaPath(resolved, root ?? resolved, path);
  return resolved;
}

function removeSchemaPath(schema: JsonObject, root: JsonObject, path: string[]) {
  const [field, ...rest] = path;
  if (!field) return;
  const properties = schemaProperties(schema);
  const child = properties[field];
  if (!child) return;
  if (rest.length) {
    const resolvedChild = structuredClone(resolveSchema(root, child) ?? child);
    removeSchemaPath(resolvedChild, root, rest);
    schema.properties = { ...properties, [field]: resolvedChild };
    return;
  }
  const nextProperties = { ...properties };
  delete nextProperties[field];
  schema.properties = nextProperties;
  const nextRequired = schemaRequired(schema).filter((required) => required !== field);
  if (nextRequired.length) schema.required = nextRequired;
  else delete schema.required;
}

function schemaFieldLabel(reference: string, schema: JsonObject | undefined): string {
  if (typeof schema?.title === "string" && schema.title.trim()) return schema.title.trim();
  return humanizeName(fieldReferenceName(reference) ?? reference);
}

function isTextField(schema?: JsonObject): boolean {
  if (!schema || "const" in schema) return false;
  if (schema.type === "string") return true;
  if (Array.isArray(schema.type)) {
    const types = schema.type.filter((type) => type !== "null");
    return types.length === 1 && types[0] === "string";
  }
  return !("type" in schema)
    && !("properties" in schema)
    && !("items" in schema)
    && (!Array.isArray(schema.enum) || schema.enum.every((value) => typeof value === "string"));
}
