import { ArrowLeft } from "lucide-react";
import type { CollectionTypeDescriptor, JsonObject } from "@mdbase/connect";
import { useMemo, useState, type ReactNode } from "react";
import type { CreateNoteInput } from "./model";
import { safeRenamePath } from "./note";
import { SchemaValueEditor, schemaValueComplete } from "./SchemaValueEditor";

export function NewNoteComposer({ types, defaultFolder, purpose = "note", leadingActions, onCreate, onCancel }: {
  types: CollectionTypeDescriptor[];
  defaultFolder?: string;
  purpose?: "note" | "folder";
  leadingActions?: ReactNode;
  onCreate: (input: CreateNoteInput) => Promise<void>;
  onCancel: () => void;
}) {
  const folderCreation = purpose === "folder";
  const [title, setTitle] = useState("");
  const [folderName, setFolderName] = useState("");
  const [typeName, setTypeName] = useState("");
  const [path, setPath] = useState(() => suggestedPath("", defaultFolder));
  const [pathEdited, setPathEdited] = useState(false);
  const [properties, setProperties] = useState<JsonObject>({});
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();
  const type = types.find((candidate) => candidate.name === typeName);
  const schema = schemaShape(type);
  const titleField = ["title", "name", "subject"].find((field) => field in schema.properties);
  const required = schema.required.filter((field) => field !== "type" && field !== titleField && !schemaSuppliesValue(schema.properties[field]));
  const resolvedPath = folderCreation ? suggestedPath(title, normalizedFolder(folderName)) : path;
  const complete = Boolean(
    title.trim()
    && validPath(resolvedPath)
    && (!folderCreation || validFolder(folderName))
    && required.every((field) => schemaValueComplete(schema.properties[field], properties[field]))
  );

  const defaults = useMemo(() => schemaDefaults(type), [type]);

  function selectType(nextName: string) {
    const nextType = types.find((candidate) => candidate.name === nextName);
    const nextDefaults = schemaDefaults(nextType);
    setTypeName(nextName);
    setProperties(nextDefaults);
    if (!pathEdited) setPath(suggestedPath(title, defaultFolder ?? typeFolder(nextType)));
  }

  function changeTitle(next: string) {
    setTitle(next);
    if (!pathEdited) setPath(suggestedPath(next, defaultFolder ?? typeFolder(type)));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!complete || creating) return;
    setCreating(true);
    setError(undefined);
    const nextProperties = { ...defaults, ...properties };
    if (titleField) nextProperties[titleField] = title.trim();
    try {
      await onCreate({
        title: title.trim(),
        path: safeRenamePath(resolvedPath),
        type: typeName || undefined,
        titleField,
        properties: nextProperties
      });
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "The note could not be created.");
      setCreating(false);
    }
  }

  return <main className="new-note-composer" aria-label={folderCreation ? "Create folder" : "Create note"}>
    <header className="editor-bar"><button className="mobile-back icon-button" aria-label={folderCreation ? "Cancel new folder" : "Cancel new note"} onClick={onCancel}><ArrowLeft aria-hidden="true" /></button>{leadingActions}<span>{folderCreation ? "New folder" : "New note"}</span></header>
    <form onSubmit={(event) => void submit(event)}>
      <p className="eyebrow">{folderCreation ? "New folder with its first note" : "New Markdown record"}</p>
      {folderCreation
        ? <label className="new-note-title"><span className="sr-only">Folder name</span><input autoFocus value={folderName} onChange={(event) => setFolderName(event.target.value)} placeholder="Folder name" spellCheck="false" /></label>
        : <label className="new-note-title"><span className="sr-only">Title</span><input autoFocus value={title} onChange={(event) => changeTitle(event.target.value)} placeholder="Untitled" /></label>}
      <div className="new-note-fields">
        {folderCreation
          ? <label><span>First note</span><input value={title} onChange={(event) => changeTitle(event.target.value)} placeholder="Untitled" /></label>
          : <label><span>Path</span><input value={path} onChange={(event) => { setPathEdited(true); setPath(event.target.value); }} spellCheck="false" /></label>}
        <label><span>Type</span><select value={typeName} onChange={(event) => selectType(event.target.value)}>
          <option value="">No explicit type</option>
          {types.map((candidate) => <option key={candidate.name} value={candidate.name}>{candidate.name}</option>)}
        </select></label>
        {folderCreation && <label className="new-folder-path"><span>Path</span><output>{resolvedPath}</output></label>}
        {required.map((field) => <SchemaValueEditor
          key={`${typeName}:${field}`}
          name={field}
          schema={schema.properties[field]}
          value={properties[field]}
          required
          onChange={(value) => setProperties((current) => ({ ...current, [field]: value }))}
        />)}
      </div>
      {folderCreation && <p className="new-folder-help">Folders are created when their first note is saved.</p>}
      {type?.description && <p className="new-note-type-help">{type.description}</p>}
      {error && <p className="new-note-error" role="alert">{error}</p>}
      <div className="new-note-actions"><button type="button" onClick={onCancel}>Cancel</button><button className="create-note-button" disabled={!complete || creating}>{creating ? (folderCreation ? "Creating folder" : "Creating") : (folderCreation ? "Create folder" : "Create note")}</button></div>
    </form>
  </main>;
}

function schemaShape(type?: CollectionTypeDescriptor): { properties: Record<string, JsonObject>; required: string[] } {
  const rawProperties = type?.schema.properties;
  const properties: Record<string, JsonObject> = {};
  if (rawProperties && !Array.isArray(rawProperties) && typeof rawProperties === "object") {
    for (const [name, schema] of Object.entries(rawProperties)) {
      if (schema && !Array.isArray(schema) && typeof schema === "object") properties[name] = schema as JsonObject;
    }
  }
  const required = Array.isArray(type?.schema.required) ? type.schema.required.filter((item): item is string => typeof item === "string") : [];
  return { properties, required };
}

function schemaDefaults(type?: CollectionTypeDescriptor): JsonObject {
  const { properties } = schemaShape(type);
  return Object.fromEntries(Object.entries(properties).flatMap(([name, schema]) => {
    if ("default" in schema) return [[name, structuredClone(schema.default)]];
    if ("const" in schema) return [[name, structuredClone(schema.const)]];
    return [];
  }));
}

function schemaSuppliesValue(schema?: JsonObject): boolean {
  return Boolean(schema && ("default" in schema || "const" in schema));
}

function suggestedPath(title: string, folder = ""): string {
  const name = slug(title) || "Untitled";
  const cleanFolder = folder.replace(/^\/+|\/+$/g, "");
  return cleanFolder ? `${cleanFolder}/${name}.md` : `${name}.md`;
}

function typeFolder(type?: CollectionTypeDescriptor): string | undefined {
  const match = type?.definition?.match;
  if (!match || Array.isArray(match) || typeof match !== "object") return undefined;
  const glob = (match as Record<string, unknown>).path_glob;
  if (typeof glob !== "string") return undefined;
  const prefix = glob.split(/[?*[{]/, 1)[0].replace(/\/+$/g, "");
  return prefix && !prefix.includes(".") ? prefix : undefined;
}

function slug(value: string): string {
  return value.trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ") || "";
}

function validPath(path: string): boolean {
  const value = safeRenamePath(path);
  return Boolean(value && value.toLocaleLowerCase().endsWith(".md") && !value.split("/").includes(".."));
}

function normalizedFolder(folder: string): string {
  return safeRenamePath(folder).replace(/\/+$/g, "");
}

function validFolder(folder: string): boolean {
  const value = normalizedFolder(folder);
  return Boolean(value && value.split("/").every((part) => part && part !== "." && part !== ".."));
}
