import type { CollectionTypeDescriptor, JsonObject } from "@mdbase-dev/connect";
import type { NoteDocument, NoteSummary } from "./model";
import { pendingNoteRequestId } from "./pending-note-mutation";

export type BulkPropertyChange =
  | { kind: "add-tag" | "remove-tag"; tag: string }
  | { kind: "property"; field: string; value: unknown };

export interface BulkField {
  name: string;
  schema: JsonObject;
  rootSchema: JsonObject;
  shared: boolean;
}

/** Only declared fields, with one compatible contract across the selection. */
export function bulkFields(notes: readonly Pick<NoteSummary, "types">[], types: CollectionTypeDescriptor[]): BulkField[] {
  const perNote = notes.map((note) => {
    const fields = new Map<string, { schema: JsonObject; rootSchema: JsonObject }>();
    for (const name of note.types) {
      const rootSchema = types.find((type) => type.name.toLowerCase() === name.toLowerCase())?.schema;
      const properties = rootSchema?.properties;
      if (!properties || Array.isArray(properties) || typeof properties !== "object") continue;
      for (const [field, schema] of Object.entries(properties)) {
        if (schema && typeof schema === "object" && !Array.isArray(schema)) fields.set(field, { schema: schema as JsonObject, rootSchema: rootSchema! });
      }
    }
    return fields;
  });
  const names = [...new Set(perNote.flatMap((fields) => [...fields.keys()]))].sort();
  return names.map((name) => {
    const first = perNote.find((fields) => fields.has(name))!.get(name)!;
    return { name, ...first, shared: perNote.every((fields) => {
      const field = fields.get(name);
      return field && JSON.stringify(field.schema) === JSON.stringify(first.schema)
        && (!JSON.stringify(first.schema).includes('"$ref"') || JSON.stringify(field.rootSchema) === JSON.stringify(first.rootSchema));
    }) };
  });
}

export function bulkFrontmatter(document: NoteDocument, change: BulkPropertyChange): JsonObject {
  if (change.kind === "property") return { ...document.frontmatter, [change.field]: change.value };
  const current = document.frontmatter.tags;
  if (current !== undefined && current !== null && typeof current !== "string" && !(Array.isArray(current) && current.every((tag) => typeof tag === "string"))) throw new Error("Tags must be text or a list of text before they can be changed together.");
  const tags: string[] = Array.isArray(current) ? current as string[] : typeof current === "string" ? [current] : [];
  const normalize = (tag: string) => tag.replace(/^#/, "").trim();
  const tag = normalize(change.tag);
  const next = change.kind === "add-tag"
    ? tags.some((value) => normalize(value) === tag) ? tags : [...tags, tag]
    : tags.filter((value) => normalize(value) !== tag);
  if (JSON.stringify(next) === JSON.stringify(tags)) return document.frontmatter;
  return { ...document.frontmatter, tags: next };
}

export interface BatchResult<Value> {
  succeeded: Array<{ path: string; value: Value }>;
  failed: Array<{ path: string; error: unknown }>;
}

/** Serial batches respect the existing per-note operation queue; failures don't skip later notes. */
export async function runNoteBatch<Value>(paths: readonly string[], operation: (path: string) => Promise<Value | undefined>): Promise<BatchResult<Value>> {
  const result: BatchResult<Value> = { succeeded: [], failed: [] };
  const uniquePaths = [...new Set(paths)];
  for (const [index, path] of uniquePaths.entries()) {
    try {
      const value = await operation(path);
      if (value !== undefined) result.succeeded.push({ path, value });
    } catch (error) {
      result.failed.push({ path, error });
      if (pendingNoteRequestId(error)) {
        result.failed.push(...uniquePaths.slice(index + 1).map((path) => ({ path, error: new Error("Not attempted because an earlier note needs exact recovery.") })));
        break;
      }
    }
  }
  return result;
}
