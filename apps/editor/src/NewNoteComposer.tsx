import { Trans } from "@lingui/react/macro";
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { ArrowLeftIcon as ArrowLeft, CaretRightIcon as ChevronRight } from "./icons";
import type { CollectionTypeDescriptor, JsonObject } from "@mdbase-dev/connect";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { CodeEditor } from "./CodeEditor";
import type { CreateNoteInput } from "./model";
import { safeRenamePath } from "./note";
import type { EditorPreferences } from "./preferences";
import {
  humanizeName,
  resolveSchema,
  schemaProperties,
  schemaRequired,
  schemaValueComplete
} from "./SchemaValueEditor";
import { StructuredPropertiesEditor } from "./StructuredPropertiesEditor";
import {
  collectionDisplayField,
  fieldReferenceName,
  fieldReferencePath,
  writeFieldReference
} from "./field-reference";
import { Select } from "@mdbase-dev/ui/select";

export function NewNoteComposer({ types, defaultFolder, defaultTag, defaultType, initialProperties, initialTitle = "", purpose = "note", preferences, recordPaths = [], leadingActions, onCreate, onCancel, onDraftChange }: {
  types: CollectionTypeDescriptor[];
  defaultFolder?: string;
  defaultTag?: string;
  defaultType?: string;
  initialProperties?: JsonObject;
  initialTitle?: string;
  purpose?: "note" | "folder";
  preferences?: EditorPreferences;
  recordPaths?: string[];
  leadingActions?: ReactNode;
  onCreate: (input: CreateNoteInput) => Promise<void>;
  onCancel: (hasDraft: boolean) => void;
  onDraftChange?: (hasDraft: boolean) => void;
}) {
  useLingui();
  const folderCreation = purpose === "folder";
  const initialType = folderCreation ? undefined : types.find((candidate) => candidate.name === defaultType);
  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState("");
  const [folderName, setFolderName] = useState("");
  const [typeName, setTypeName] = useState(folderCreation ? "" : defaultType ?? "");
  const [path, setPath] = useState(() => suggestedPath(initialTitle, defaultFolder ?? typeFolder(initialType)));
  const [pathEdited, setPathEdited] = useState(false);
  const [properties, setProperties] = useState<JsonObject>(() => ({ ...seededProperties(initialType, defaultTag), ...initialProperties }));
  const [requiredPropertiesValid, setRequiredPropertiesValid] = useState(true);
  const [optionalPropertiesValid, setOptionalPropertiesValid] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();
  /** One record ID per creation, kept across edits until the create is confirmed:
   * a retry reuses it, so the note lands once and later edits apply as an update. */
  const attempt = useRef<string>(undefined);
  const type = types.find((candidate) => candidate.name === typeName);
  const declaredDisplayField = collectionDisplayField(type, "name_field");
  const displaySchema = schemaAtFieldReference(type?.schema, declaredDisplayField);
  const displayField = isTextField(displaySchema) ? declaredDisplayField : undefined;
  const primaryLabel = displayField
    ? schemaFieldLabel(displayField, displaySchema)
    : t`Title`;
  const formSchema = useMemo(
    () => creationFormSchema(type?.schema, displayField),
    [displayField, type?.schema]
  );
  const schema = schemaShape(formSchema);
  const displayPath = fieldReferencePath(displayField);
  const displayRoot = displayPath?.length === 1
    ? displayPath[0]
    : undefined;
  const required = schema.required.filter((field) => field !== "type" && !schemaSuppliesValue(schema.properties[field]));
  const optional = [...new Set([
    ...Object.keys(schema.properties).filter((field) => field !== "type" && !required.includes(field)),
    ...Object.keys(properties).filter((field) => field !== "type" && field !== displayRoot && !required.includes(field))
  ])];
  const selectedOptional = optional.filter((field) => field in properties).length;
  const resolvedPath = folderCreation
    ? suggestedPath(title, joinFolder(defaultFolder, normalizedFolder(folderName)))
    : path;
  const complete = Boolean(
    title.trim()
    && validPath(resolvedPath)
    && (!folderCreation || validFolder(folderName))
    && required.every((field) => schemaValueComplete(schema.properties[field], properties[field], formSchema))
    && requiredPropertiesValid
    && optionalPropertiesValid
  );
  const incompleteReason = complete ? undefined : creationBlocker();
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

  function creationBlocker(): string {
    if (folderCreation && !validFolder(folderName)) return t`Name the folder to create it.`;
    if (!title.trim()) return folderCreation ? t`Title the first note to create the folder.` : t`Add a ${primaryLabel.toLocaleLowerCase()} to create the note.`;
    if (!validPath(resolvedPath)) return t`Use a Markdown file path ending in .md.`;
    if (!required.every((field) => schemaValueComplete(schema.properties[field], properties[field], formSchema))) return t`Fill in the required properties.`;
    return t`Fix the highlighted property values.`;
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
    let nextProperties = { ...defaults, ...properties };
    if (displayField) nextProperties = writeFieldReference(nextProperties, displayField, title.trim());
    const input = {
      title: title.trim(),
      body,
      path: safeRenamePath(resolvedPath),
      type: typeName || undefined,
      titleField: displayField,
      properties: nextProperties
    };
    attempt.current ??= crypto.randomUUID();
    try {
      await onCreate({ ...input, id: attempt.current });
      attempt.current = undefined;
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : t`The note could not be created.`);
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
    aria-label={folderCreation ? t`Create folder` : t`Create note`}
    style={{ "--editor-font-size": `${preferences?.fontSize ?? 17}px` } as CSSProperties}
  >
    <header className="editor-bar"><button className="mobile-back icon-button" aria-label={folderCreation ? t`Cancel new folder` : t`Cancel new note`} onClick={() => onCancel(hasDraft)}><ArrowLeft aria-hidden="true" /></button>{leadingActions}<span>{folderCreation ? t`New folder` : t`New note`}</span></header>
    <form className={folderCreation ? "new-folder-form" : "new-note-form"} onSubmit={(event) => void submit(event)} onKeyDown={createWithShortcut}>
      {folderCreation
        ? <><h1><Trans>New folder</Trans></h1><p className="new-note-intro"><Trans>Create it with a first note. Empty folders aren’t stored.</Trans></p></>
        : <label className="new-note-title"><span className="sr-only">{primaryLabel}</span><input autoFocus value={title} onChange={(event) => changeTitle(event.target.value)} placeholder={displayField ? primaryLabel : t`Untitled`} /></label>}
      <div className="new-note-fields">
        {folderCreation
          ? <><label><span><Trans>Folder name</Trans></span><input autoFocus value={folderName} onChange={(event) => setFolderName(event.target.value)} placeholder={t`e.g. Research`} spellCheck="false" /></label><label><span><Trans>First note</Trans></span><input value={title} onChange={(event) => changeTitle(event.target.value)} placeholder={t`e.g. Reading list`} /></label></>
          : null}
        {!folderCreation && <label><span><Trans>Type</Trans></span><Select aria-label={t`Type`} value={typeName} options={[
          { value: "", label: "General note" },
          ...types.map((candidate) => ({ value: candidate.name, label: candidate.name }))
        ]} onChange={selectType} /></label>}
        {!folderCreation && <details className="new-note-path">
          <summary aria-label={t`Edit file path`}><span><Trans>File path</Trans></span><output aria-label={t`Suggested path`}>{!pathEdited && !title.trim() ? <>{pathFolderPrefix(path)}<span className="path-pending"><Trans>‹title›</Trans></span><Trans>.md</Trans></> : path}</output><ChevronRight aria-hidden="true" /></summary>
          <label><span className="sr-only"><Trans>File path</Trans></span><input aria-label={t`Path`} value={path} onChange={(event) => { setPathEdited(true); setPath(event.target.value); }} spellCheck="false" /></label>
        </details>}
        {folderCreation && folderName.trim() && title.trim() && <div className="new-folder-path"><span><Trans>File path</Trans></span><output>{resolvedPath}</output></div>}
      </div>
      {type?.description && <p className="new-note-type-help">{type.description}</p>}
      {!folderCreation && required.length > 0 && <section className="new-note-required-properties" aria-label={t`Required properties`}>
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
          <span><Trans>Properties</Trans></span>
          <small>{selectedOptional > 0 ? t`${selectedOptional} set` : t`${optional.length} available`}</small>
          <ChevronRight aria-hidden="true" />
        </summary>
        <StructuredPropertiesEditor
          value={properties}
          contract={{ properties: schema.properties, required }}
          propertyNames={optional}
          recordPaths={recordPaths}
          allowCustom={false}
          emptyMessage={t`No optional properties selected.`}
          onChange={setProperties}
          onValidityChange={setOptionalPropertiesValid}
        />
      </details>}
      {!folderCreation && <CodeEditor
        value={body}
        onChange={setBody}
        label={t`Note body`}
        language="markdown"
        variant="writer"
        placeholder={t`Start writing`}
        vimEnabled={preferences?.vim}
        lineWrapping={preferences?.lineWrapping ?? true}
        quietMarkdown={preferences?.quietMarkdown ?? true}
        className="new-note-body-editor"
        currentPath={resolvedPath}
      />}
      {error && <p className="new-note-error" role="alert">{error}</p>}
      <div className="new-note-actions">
        <span id="new-note-status" className={incompleteReason && !creating ? "blocked" : undefined}>{incompleteReason && !creating ? incompleteReason : ""}</span>
        <button className="mdbase-button is-tertiary" type="button" onClick={() => onCancel(hasDraft)}><Trans>Cancel</Trans></button>
        <button
          className="create-note-button mdbase-button is-primary"
          disabled={!complete || creating}
          aria-describedby="new-note-status"
          aria-keyshortcuts={folderCreation ? undefined : "Control+Enter Meta+Enter"}
          title={folderCreation ? undefined : t`Create note (Ctrl or Command + Enter)`}
        >{creating ? (folderCreation ? t`Creating folder` : t`Creating`) : (folderCreation ? t`Create folder` : t`Create note`)}{!folderCreation && !creating && <kbd aria-hidden="true">{shortcutModifier()}↵</kbd>}</button>
      </div>
    </form>
  </main>;
}

function schemaShape(root?: JsonObject): { properties: Record<string, JsonObject>; required: string[] } {
  const schema = resolveSchema(root, root);
  return {
    properties: schemaProperties(schema),
    required: schemaRequired(schema)
  };
}

function schemaDefaults(type?: CollectionTypeDescriptor): JsonObject {
  const { properties } = schemaShape(type?.schema);
  return Object.fromEntries(Object.entries(properties).flatMap(([name, schema]) => {
    if ("default" in schema) return [[name, structuredClone(schema.default)]];
    if ("const" in schema) return [[name, structuredClone(schema.const)]];
    return [];
  }));
}

function seededProperties(type?: CollectionTypeDescriptor, tag?: string): JsonObject {
  const properties = schemaDefaults(type);
  if (!tag) return properties;
  const tagSchema = schemaShape(type?.schema).properties.tags;
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

function schemaAtFieldReference(root: JsonObject | undefined, reference: string | undefined): JsonObject | undefined {
  const path = fieldReferencePath(reference);
  if (!root || !path) return undefined;
  let current = resolveSchema(root, root);
  for (const token of path) {
    const properties = schemaProperties(current);
    const property = properties[token];
    if (!property) return undefined;
    current = resolveSchema(root, property);
  }
  return current;
}

function creationFormSchema(root: JsonObject | undefined, displayField: string | undefined): JsonObject {
  const resolved = structuredClone(resolveSchema(root, root) ?? { type: "object", properties: {} });
  const hiddenPaths = [
    ["type"],
    ...(fieldReferencePath(displayField) ? [fieldReferencePath(displayField)!] : [])
  ];
  for (const path of hiddenPaths) removeSchemaPath(resolved, root ?? resolved, path);
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

function pathFolderPrefix(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
}

function shortcutModifier(): string {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : t`Ctrl `;
}

function suggestedPath(title: string, folder = ""): string {
  const name = slug(title) || t`Untitled`;
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
