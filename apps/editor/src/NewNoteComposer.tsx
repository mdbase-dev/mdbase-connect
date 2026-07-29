import { ArrowLeftIcon as ArrowLeft, CaretRightIcon as ChevronRight } from "./icons";
import type { CollectionTypeDescriptor, JsonObject } from "@mdbase/connect";
import { useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { CodeEditor } from "./CodeEditor";
import type { CreateNoteInput } from "./model";
import { safeRenamePath } from "./note";
import type { EditorPreferences } from "./preferences";
import { schemaValueComplete } from "./SchemaValueEditor";
import { StructuredPropertiesEditor } from "./StructuredPropertiesEditor";

export function NewNoteComposer({ types, defaultFolder, defaultTag, defaultType, purpose = "note", preferences, recordPaths = [], leadingActions, onCreate, onCancel, onDraftChange }: {
  types: CollectionTypeDescriptor[];
  defaultFolder?: string;
  defaultTag?: string;
  defaultType?: string;
  purpose?: "note" | "folder";
  preferences?: EditorPreferences;
  recordPaths?: string[];
  leadingActions?: ReactNode;
  onCreate: (input: CreateNoteInput) => Promise<void>;
  onCancel: (hasDraft: boolean) => void;
  onDraftChange?: (hasDraft: boolean) => void;
}) {
  const folderCreation = purpose === "folder";
  const initialType = types.find((candidate) => candidate.name === defaultType);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [folderName, setFolderName] = useState("");
  const [typeName, setTypeName] = useState(defaultType ?? "");
  const [path, setPath] = useState(() => suggestedPath("", defaultFolder ?? typeFolder(initialType)));
  const [pathEdited, setPathEdited] = useState(false);
  const [properties, setProperties] = useState<JsonObject>(() => seededProperties(initialType, defaultTag));
  const [requiredPropertiesValid, setRequiredPropertiesValid] = useState(true);
  const [optionalPropertiesValid, setOptionalPropertiesValid] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();
  const type = types.find((candidate) => candidate.name === typeName);
  const schema = schemaShape(type);
  const titleField = ["title", "name", "subject"].find((field) => isTextTitleField(schema.properties[field]));
  const required = schema.required.filter((field) => field !== "type" && field !== titleField && !schemaSuppliesValue(schema.properties[field]));
  const optional = [...new Set([
    ...Object.keys(schema.properties).filter((field) => field !== "type" && field !== titleField && !required.includes(field)),
    ...Object.keys(properties).filter((field) => field !== "type" && field !== titleField && !required.includes(field))
  ])];
  const selectedOptional = optional.filter((field) => field in properties).length;
  const resolvedPath = folderCreation
    ? suggestedPath(title, joinFolder(defaultFolder, normalizedFolder(folderName)))
    : path;
  const complete = Boolean(
    title.trim()
    && validPath(resolvedPath)
    && (!folderCreation || validFolder(folderName))
    && required.every((field) => schemaValueComplete(schema.properties[field], properties[field]))
    && requiredPropertiesValid
    && optionalPropertiesValid
  );
  const hasDraft = Boolean(
    title.trim()
    || body.trim()
    || folderName.trim()
    || typeName
    || pathEdited
    || Object.keys(properties).length
  );
  useEffect(() => onDraftChange?.(hasDraft), [hasDraft, onDraftChange]);

  const defaults = useMemo(() => seededProperties(type, defaultTag), [defaultTag, type]);

  function selectType(nextName: string) {
    const nextType = types.find((candidate) => candidate.name === nextName);
    const nextDefaults = seededProperties(nextType, defaultTag);
    setTypeName(nextName);
    setProperties(nextDefaults);
    setRequiredPropertiesValid(true);
    setOptionalPropertiesValid(true);
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
        body,
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

  function createWithShortcut(event: KeyboardEvent<HTMLFormElement>) {
    if (folderCreation || event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return;
    event.preventDefault();
    event.currentTarget.requestSubmit();
  }

  return <main
    className="new-note-composer"
    aria-label={folderCreation ? "Create folder" : "Create note"}
    style={{ "--editor-font-size": `${preferences?.fontSize ?? 17}px` } as CSSProperties}
  >
    <header className="editor-bar"><button className="mobile-back icon-button" aria-label={folderCreation ? "Cancel new folder" : "Cancel new note"} onClick={() => onCancel(hasDraft)}><ArrowLeft aria-hidden="true" /></button>{leadingActions}<span>{folderCreation ? "New folder" : "New note"}</span></header>
    <form className={folderCreation ? "new-folder-form" : "new-note-form"} onSubmit={(event) => void submit(event)} onKeyDown={createWithShortcut}>
      <p className="eyebrow">{folderCreation ? "Create folder" : "Create note"}</p>
      {folderCreation
        ? <label className="new-note-title"><span className="sr-only">Folder name</span><input autoFocus value={folderName} onChange={(event) => setFolderName(event.target.value)} placeholder="Folder name" spellCheck="false" /></label>
        : <label className="new-note-title"><span className="sr-only">Title</span><input autoFocus value={title} onChange={(event) => changeTitle(event.target.value)} placeholder="Untitled" /></label>}
      {folderCreation && <p className="new-note-intro">A folder appears when its first note is created.</p>}
      <div className="new-note-fields">
        {folderCreation
          ? <label><span>First note</span><input value={title} onChange={(event) => changeTitle(event.target.value)} placeholder="Untitled" /></label>
          : null}
        <label><span>Type</span><select value={typeName} onChange={(event) => selectType(event.target.value)}>
          <option value="">General note</option>
          {types.map((candidate) => <option key={candidate.name} value={candidate.name}>{candidate.name}</option>)}
        </select></label>
        {!folderCreation && <details className="new-note-path">
          <summary aria-label="Edit file path"><span>File path</span><output aria-label="Suggested path">{path}</output><ChevronRight aria-hidden="true" /></summary>
          <label><span className="sr-only">File path</span><input aria-label="Path" value={path} onChange={(event) => { setPathEdited(true); setPath(event.target.value); }} spellCheck="false" /><small>Where this Markdown file will live in the collection.</small></label>
        </details>}
        {folderCreation && <label className="new-folder-path"><span>Path</span><output>{resolvedPath}</output></label>}
      </div>
      {type?.description && <p className="new-note-type-help">{type.description}</p>}
      {!folderCreation && required.length > 0 && <section className="new-note-required-properties" aria-label="Required properties">
        <StructuredPropertiesEditor
          value={properties}
          contract={{ properties: schema.properties, required }}
          propertyNames={required}
          recordPaths={recordPaths}
          initializeRequired
          allowAdd={false}
          allowCustom={false}
          emptyMessage=""
          onChange={setProperties}
          onValidityChange={setRequiredPropertiesValid}
        />
      </section>}
      {!folderCreation && type && optional.length > 0 && <details className="new-note-properties">
        <summary>
          <span>Properties</span>
          <small>{selectedOptional > 0 ? `${selectedOptional} set` : `${optional.length} available`}</small>
          <ChevronRight aria-hidden="true" />
        </summary>
        <StructuredPropertiesEditor
          value={properties}
          contract={{ properties: schema.properties, required }}
          propertyNames={optional}
          recordPaths={recordPaths}
          allowCustom={false}
          emptyMessage="No optional properties selected."
          onChange={setProperties}
          onValidityChange={setOptionalPropertiesValid}
        />
      </details>}
      {!folderCreation && <CodeEditor
        value={body}
        onChange={setBody}
        label="Note body"
        language="markdown"
        variant="writer"
        placeholder="Start writing"
        vimEnabled={preferences?.vim}
        lineWrapping={preferences?.lineWrapping ?? true}
        quietMarkdown={preferences?.quietMarkdown ?? true}
        className="new-note-body-editor"
        currentPath={resolvedPath}
      />}
      {error && <p className="new-note-error" role="alert">{error}</p>}
      <div className="new-note-actions">
        {!folderCreation && <span>Draft stays here until the note is created.</span>}
        <button type="button" onClick={() => onCancel(hasDraft)}>Cancel</button>
        <button
          className="create-note-button"
          disabled={!complete || creating}
          aria-keyshortcuts={folderCreation ? undefined : "Control+Enter Meta+Enter"}
          title={folderCreation ? undefined : "Create note (Ctrl or Command + Enter)"}
        >{creating ? (folderCreation ? "Creating folder" : "Creating") : (folderCreation ? "Create folder" : "Create note")}</button>
      </div>
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

function seededProperties(type?: CollectionTypeDescriptor, tag?: string): JsonObject {
  const properties = schemaDefaults(type);
  if (!tag) return properties;
  const tagSchema = schemaShape(type).properties.tags;
  if (tagSchema?.type === "string") {
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

function isTextTitleField(schema?: JsonObject): boolean {
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

function joinFolder(parent: string | undefined, child: string): string {
  return [parent?.replace(/^\/+|\/+$/g, ""), child].filter(Boolean).join("/");
}

function validFolder(folder: string): boolean {
  const value = normalizedFolder(folder);
  return Boolean(value && value.split("/").every((part) => part && part !== "." && part !== ".."));
}
