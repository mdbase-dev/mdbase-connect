import {
  BracketsCurlyIcon as Braces,
  FileCodeIcon as FileCode2,
  MagnifyingGlassIcon as Search,
  PlusIcon as Plus,
  TrashIcon as Trash2,
  XIcon as X
} from "./icons";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CollectionTypeDescriptor, JsonObject } from "@mdbase/connect";
import { CodeEditor } from "./CodeEditor";
import type { NoteDocument } from "./model";
import { composeRecordSource } from "./record-source";
import { schemaInitialValue, SchemaValueEditor } from "./SchemaValueEditor";

type PropertyKind = "text" | "number" | "boolean" | "list" | "object";
type PropertyValue = unknown;

interface PropertiesPanelProps {
  note: NoteDocument;
  types: CollectionTypeDescriptor[];
  recordPaths?: string[];
  error?: string;
  onClose: () => void;
  onSave: (path: string, value: JsonObject) => Promise<void>;
  onSaveDocument?: (document: string, previousDocument: string) => Promise<boolean> | boolean | void;
}

export function PropertiesPanel({
  note,
  types,
  recordPaths = [],
  error,
  onClose,
  onSave,
  onSaveDocument
}: PropertiesPanelProps) {
  const initial = useMemo(() => structuredClone(note.frontmatter), [note]);
  const initialDocument = note.document ?? composeRecordSource(note.frontmatter, note.body ?? "");
  const contract = useMemo(() => mergedSchema(note.types, types), [note.types, types]);
  const [draft, setDraft] = useState<JsonObject>(initial);
  const [mode, setMode] = useState<"fields" | "json" | "source">("fields");
  const [raw, setRaw] = useState(() => JSON.stringify(initial, null, 2));
  const [source, setSource] = useState(initialDocument);
  const sourceBaseline = useRef(initialDocument);
  const latestSource = useRef(source);
  const sourceSaveCallback = useRef(onSaveDocument);
  const sourceSavePromise = useRef<Promise<boolean> | undefined>(undefined);
  const lastSourceSubmitted = useRef(initialDocument);
  const [rawError, setRawError] = useState<string>();
  const [editorValidity, setEditorValidity] = useState<Record<string, boolean>>({});
  const [autoSaveState, setAutoSaveState] = useState<"saved" | "waiting" | "saving">("saved");
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState("");
  const [customizing, setCustomizing] = useState(false);
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<PropertyKind>("text");
  const [saving, setSaving] = useState(false);
  const changed = JSON.stringify(draft) !== JSON.stringify(initial);
  const sourceChanged = source !== initialDocument;
  const available = Object.keys(contract.properties)
    .filter((name) => !(name in draft))
    .filter((name) => !search.trim() || name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const missingRequired = contract.required.filter((name) => !(name in draft));
  const fieldErrors = Object.fromEntries(Object.entries(draft).flatMap(([name, value]) => {
    const message = validateValue(contract.properties[name], value, name);
    return message ? [[name, message]] : [];
  }));
  for (const name of missingRequired) fieldErrors[name] = "This required property is missing.";
  for (const [name, valid] of Object.entries(editorValidity)) {
    if (!valid) fieldErrors[name] = "Fix the JSON value before saving.";
  }
  const effective = Object.entries(note.effective_frontmatter).filter(([name, value]) =>
    !(name in draft) || JSON.stringify(draft[name]) !== JSON.stringify(value)
  );
  const initialFingerprint = JSON.stringify(initial);
  const draftFingerprint = JSON.stringify(draft);
  const fieldErrorFingerprint = JSON.stringify(fieldErrors);
  const fieldsInvalid = Boolean(rawError) || Object.keys(fieldErrors).length > 0;
  const latestDraft = useRef(draft);
  const latestFieldsInvalid = useRef(fieldsInvalid);
  const saveCallback = useRef(onSave);
  const lastSubmitted = useRef(initialFingerprint);
  const saveGeneration = useRef(0);

  useEffect(() => { latestDraft.current = draft; }, [draft]);
  useEffect(() => { latestFieldsInvalid.current = fieldsInvalid; }, [fieldsInvalid]);
  useEffect(() => { saveCallback.current = onSave; }, [onSave]);
  latestSource.current = source;
  sourceSaveCallback.current = onSaveDocument;
  useEffect(() => {
    const previous = sourceBaseline.current;
    sourceBaseline.current = initialDocument;
    setSource((current) => {
      if (current !== previous) return current;
      latestSource.current = initialDocument;
      lastSourceSubmitted.current = initialDocument;
      return initialDocument;
    });
  }, [initialDocument]);
  useEffect(() => {
    if (!changed || fieldsInvalid) {
      if (!changed) {
        lastSubmitted.current = draftFingerprint;
        setAutoSaveState("saved");
      }
      return;
    }
    setAutoSaveState("waiting");
    const generation = ++saveGeneration.current;
    const timer = window.setTimeout(() => {
      lastSubmitted.current = draftFingerprint;
      setAutoSaveState("saving");
      void Promise.resolve(saveCallback.current(note.path, draft)).then(() => {
        if (generation === saveGeneration.current) setAutoSaveState("saved");
      }).catch(() => {
        if (generation === saveGeneration.current) setAutoSaveState("waiting");
      });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [changed, draft, draftFingerprint, fieldErrorFingerprint, fieldsInvalid, note.path]);
  useEffect(() => () => {
    const latest = latestDraft.current;
    const fingerprint = JSON.stringify(latest);
    if (!latestFieldsInvalid.current && fingerprint !== lastSubmitted.current) {
      void Promise.resolve(saveCallback.current(note.path, latest)).catch(() => undefined);
    }
  }, [note.path]);
  useEffect(() => () => {
    const latest = latestSource.current;
    const baseline = sourceBaseline.current;
    if (latest === baseline || latest === lastSourceSubmitted.current || sourceSavePromise.current) return;
    lastSourceSubmitted.current = latest;
    void Promise.resolve(sourceSaveCallback.current?.(latest, baseline)).catch(() => undefined);
  }, [note.path]);

  function change(next: JsonObject) {
    setDraft(next);
    setRaw(JSON.stringify(next, null, 2));
    setRawError(undefined);
  }

  function updateField(name: string, value: PropertyValue) {
    change({ ...draft, [name]: value });
  }

  function removeField(name: string) {
    const next = { ...draft };
    delete next[name];
    change(next);
  }

  function addSchemaProperty(name: string) {
    updateField(name, schemaInitialValue(contract.properties[name]));
    setSearch("");
    setAdding(false);
  }

  function addCustomProperty() {
    const name = newName.trim();
    if (!name || name in draft) return;
    updateField(name, initialValue(newKind));
    setNewName("");
    setCustomizing(false);
    setAdding(false);
  }

  function updateRaw(value: string) {
    setRaw(value);
    try {
      const parsed = JSON.parse(value) as unknown;
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
        throw new Error("Frontmatter must be a JSON object.");
      }
      setDraft(parsed as JsonObject);
      setRawError(undefined);
    } catch (parseError) {
      setRawError(parseError instanceof Error ? parseError.message : "Invalid JSON.");
    }
  }

  async function saveSource(closeAfterSave = false) {
    if (!sourceChanged) {
      if (closeAfterSave) onClose();
      return;
    }
    if (sourceSavePromise.current) {
      const succeeded = await sourceSavePromise.current;
      if (succeeded && closeAfterSave) onClose();
      return;
    }
    const next = source;
    const baseline = sourceBaseline.current;
    lastSourceSubmitted.current = next;
    setSaving(true);
    const pending = Promise.resolve(onSaveDocument?.(next, baseline))
      .then((result) => result !== false)
      .catch(() => false);
    sourceSavePromise.current = pending;
    const succeeded = await pending;
    sourceSavePromise.current = undefined;
    setSaving(false);
    if (!succeeded) lastSourceSubmitted.current = baseline;
    if (succeeded && closeAfterSave) onClose();
  }

  function closePanel() {
    if (mode === "source" && sourceChanged) {
      void saveSource(true);
      return;
    }
    onClose();
  }

  return <aside className="properties-panel" aria-label="Note properties">
    <header className="panel-header">
      <div><h2>Properties</h2><p>{note.types.length ? note.types.join(", ") : "Untyped record"}</p></div>
      <button className="icon-button" aria-label="Close properties" onClick={closePanel}><X aria-hidden="true" /></button>
    </header>

    <dl className="file-facts">
      <div><dt>Path</dt><dd>{note.path}</dd></div>
      <div><dt>Size</dt><dd>{formatBytes(note.file?.size)}</dd></div>
      <div><dt>Modified</dt><dd>{formatDate(note.file?.mtime)}</dd></div>
    </dl>

    <div className="panel-tabs" role="tablist" aria-label="Record view" onKeyDown={(event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const modes = ["fields", "json", "source"] as const;
      const offset = event.key === "ArrowRight" ? 1 : -1;
      const next = modes[(modes.indexOf(mode) + offset + modes.length) % modes.length];
      setMode(next);
      document.getElementById(`properties-${next}-tab`)?.focus();
    }}>
      <button id="properties-fields-tab" role="tab" aria-controls="properties-fields-panel" aria-selected={mode === "fields"} tabIndex={mode === "fields" ? 0 : -1} onClick={() => setMode("fields")}>Fields</button>
      <button id="properties-json-tab" role="tab" aria-controls="properties-json-panel" aria-selected={mode === "json"} tabIndex={mode === "json" ? 0 : -1} onClick={() => setMode("json")}><Braces aria-hidden="true" /> JSON</button>
      <button id="properties-source-tab" role="tab" aria-controls="properties-source-panel" aria-selected={mode === "source"} tabIndex={mode === "source" ? 0 : -1} onClick={() => setMode("source")}><FileCode2 aria-hidden="true" /> Source</button>
    </div>

    {mode === "fields" ? <div id="properties-fields-panel" className="property-fields" role="tabpanel" aria-labelledby="properties-fields-tab">
      {missingRequired.length > 0 && <section className="missing-properties" aria-label="Missing required properties">
        <h3>Required</h3>
        <p>These properties must be persisted before this record is valid.</p>
        {missingRequired.map((name) => <button key={name} onClick={() => addSchemaProperty(name)}>
          <span><strong>{name}</strong>{description(contract.properties[name]) && <small>{description(contract.properties[name])}</small>}</span>
          <Plus aria-hidden="true" />
        </button>)}
      </section>}
      {Object.entries(draft).map(([name, value]) => <PropertyRow
        key={name}
        name={name}
        value={value}
        schema={contract.properties[name]}
        required={contract.required.includes(name)}
        error={fieldErrors[name]}
        recordPaths={recordPaths}
        onChange={(next) => updateField(name, next)}
        onValidityChange={(valid) => setEditorValidity((current) => ({ ...current, [name]: valid }))}
        onRemove={() => removeField(name)}
      />)}
      {!Object.keys(draft).length && !missingRequired.length && <p className="quiet-empty">This note has no persisted properties.</p>}

      {adding ? <div className="property-picker">
        <label className="property-search"><Search aria-hidden="true" /><span className="sr-only">Find a property</span><input
          autoFocus
          type="search"
          value={search}
          placeholder="Find a property"
          onChange={(event) => setSearch(event.target.value)}
        /></label>
        {!customizing ? <>
          <div className="property-options">
            {available.map((name) => <button key={name} onClick={() => addSchemaProperty(name)}>
              <span><strong>{name}</strong><small>{description(contract.properties[name]) || schemaKind(contract.properties[name])}</small></span>
              {contract.required.includes(name) && <em>Required</em>}
            </button>)}
            {!available.length && <p>No matching schema properties.</p>}
          </div>
          <button className="custom-property-trigger" onClick={() => { setNewName(search); setCustomizing(true); }}>Add a custom property…</button>
        </> : <div className="custom-property">
          <label><span>Name</span><input autoFocus value={newName} onChange={(event) => setNewName(event.target.value)} /></label>
          <label><span>Kind</span><select value={newKind} onChange={(event) => setNewKind(event.target.value as PropertyKind)}>
            <option value="text">Text</option><option value="number">Number</option><option value="boolean">Boolean</option>
            <option value="list">List</option><option value="object">Object</option>
          </select></label>
          <div><button onClick={() => setCustomizing(false)}>Back</button><button className="small-button" disabled={!newName.trim() || newName.trim() in draft} onClick={addCustomProperty}>Add</button></div>
        </div>}
        <button className="property-picker-close" onClick={() => { setAdding(false); setCustomizing(false); }}><X aria-hidden="true" /> Cancel</button>
      </div> : <button className="add-property" onClick={() => setAdding(true)}><Plus aria-hidden="true" /> Add property</button>}
      {effective.length > 0 && <section className="effective-properties" aria-label="Computed and defaulted properties">
        <div><h3>Effective values</h3><p>Calculated at read time and not stored in this file.</p></div>
        {effective.map(([name, value]) => <div className="effective-property" key={name}>
          <span><strong>{name}</strong><small>{Object.prototype.hasOwnProperty.call(contract.properties[name] ?? {}, "default") ? "Default" : "Computed"}</small></span>
          <output>{formatValue(value)}</output>
        </div>)}
      </section>}
    </div> : mode === "json" ? <div id="properties-json-panel" className="raw-properties" role="tabpanel" aria-labelledby="properties-json-tab">
      <p className="raw-properties-note">Persisted frontmatter only. For the complete Markdown record, use Source.</p>
      <CodeEditor value={raw} onChange={updateRaw} label="Raw frontmatter JSON" language="json" lineWrapping={false} />
      {rawError && <p className="property-error" role="alert">{rawError}</p>}
    </div> : <div id="properties-source-panel" className="record-source" role="tabpanel" aria-labelledby="properties-source-tab">
      <p>Exact Markdown source, including YAML frontmatter and body.</p>
      <CodeEditor value={source} onChange={setSource} onBlur={() => void saveSource()} label="Complete record source" language="markdown" lineWrapping={false} />
    </div>}

    <div className="property-footer">
      {error && <p className="property-error" role="alert">{error}</p>}
      {mode === "source"
        ? <div className="source-save-actions">
          <p className="property-save-state" aria-live="polite">{saving
            ? "Saving source…"
            : sourceChanged
              ? "Source saves when focus leaves the editor"
              : "Source saved"}</p>
          <button className="property-save" disabled={!sourceChanged || saving} onClick={() => void saveSource(true)}>{saving ? "Saving…" : "Save source"}</button>
        </div>
        : <p className="property-save-state" aria-live="polite">{rawError
          ? "Fix the JSON to continue saving"
          : Object.keys(fieldErrors).length > 0
            ? "Fix invalid fields to continue saving"
            : autoSaveState === "saving"
              ? "Saving changes…"
              : autoSaveState === "waiting"
                ? "Changes save automatically"
                : "All changes saved"}</p>}
    </div>
  </aside>;
}

function PropertyRow({ name, value, schema, required, error, recordPaths, onChange, onValidityChange, onRemove }: {
  name: string;
  value: PropertyValue;
  schema?: JsonObject;
  required: boolean;
  error?: string;
  recordPaths: string[];
  onChange: (value: PropertyValue) => void;
  onValidityChange: (valid: boolean) => void;
  onRemove: () => void;
}) {
  const defined = Boolean(schema);
  const kind = propertyKind(value);
  return <div className={`property-row${error ? " invalid" : ""}`}>
    <div className="property-row-label">
      <span><strong>{name}</strong>{required && <small>Required</small>}</span>
      {defined
        ? <span className="property-kind" title="Defined by the mdbase schema">{schemaKind(schema)}</span>
        : <select aria-label={`${name} property kind`} value={kind} onChange={(event) => onChange(initialValue(event.target.value as PropertyKind))}>
          {kind === "null" && <option value="null" disabled>Null</option>}
          <option value="text">Text</option><option value="number">Number</option><option value="boolean">Boolean</option>
          <option value="list">List</option><option value="object">Object</option>
        </select>}
    </div>
    {description(schema) && <p className="property-description">{description(schema)}</p>}
    <PropertyValue name={name} value={value} schema={schema} recordPaths={recordPaths} onChange={onChange} onValidityChange={onValidityChange} />
    {schemaAllowsNull(schema) && value !== null && <button className="set-null-property" onClick={() => onChange(null)}>Set to null</button>}
    {error && <p className="field-error" role="alert">{error}</p>}
    <button className="remove-property" aria-label={`Remove ${name} property`} onClick={onRemove}><Trash2 aria-hidden="true" /></button>
  </div>;
}

function PropertyValue({ name, value, schema, recordPaths, onChange, onValidityChange }: {
  name: string;
  value: PropertyValue;
  schema?: JsonObject;
  recordPaths: string[];
  onChange: (value: PropertyValue) => void;
  onValidityChange: (valid: boolean) => void;
}) {
  if (value === null) return <div className="null-property"><span>Persisted null</span><button onClick={() => onChange(schemaInitialValue(schema))}>Set a value</button></div>;
  if (isStringList(name, schema, value)) {
    const itemSchema = isObject(schema?.items) ? schema.items : undefined;
    return <StringListEditor
      name={name}
      value={Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []}
      suggestions={isLinkSchema(itemSchema) ? recordPaths : []}
      onChange={onChange}
    />;
  }
  if (isLinkSchema(schema) && typeof value === "string") {
    return <><input aria-label={`${name} value`} list="record-property-paths" value={value} onChange={(event) => onChange(event.target.value)} />
      <datalist id="record-property-paths">{recordPaths.map((path) => <option key={path} value={path} />)}</datalist></>;
  }
  if (schema) {
    return <SchemaValueEditor name={`${name} value`} schema={schema} value={value} hideLabel onChange={onChange} onValidityChange={onValidityChange} />;
  }
  if (typeof value === "boolean") {
    return <label className="boolean-property"><input type="checkbox" checked={value} onChange={(event) => onChange(event.target.checked)} /><span>{value ? "True" : "False"}</span></label>;
  }
  if (typeof value === "number") {
    return <input aria-label={`${name} value`} type="number" value={value} onChange={(event) => onChange(Number(event.target.value))} />;
  }
  if (typeof value === "string") {
    return <input aria-label={`${name} value`} value={value} onChange={(event) => onChange(event.target.value)} />;
  }
  return <JsonValueEditor name={name} value={value} onChange={onChange} onValidityChange={onValidityChange} />;
}

function StringListEditor({ name, value, suggestions, onChange }: { name: string; value: string[]; suggestions: string[]; onChange: (value: unknown) => void }) {
  const listId = `property-${name.replace(/[^a-z0-9_-]+/gi, "-")}-suggestions`;
  return <div className="property-string-list" role="group" aria-label={name}>
    {value.map((item, index) => <div key={index}>
      <input aria-label={`${name} value item ${index + 1}`} list={suggestions.length ? listId : undefined} value={item} onChange={(event) => onChange(value.map((current, itemIndex) => itemIndex === index ? event.target.value : current))} />
      <button aria-label={`Remove ${name} item ${index + 1}`} onClick={() => onChange(value.filter((_, itemIndex) => itemIndex !== index))}><X aria-hidden="true" /></button>
    </div>)}
    {suggestions.length > 0 && <datalist id={listId}>{suggestions.map((path) => <option key={path} value={path} />)}</datalist>}
    <button onClick={() => onChange([...value, ""])}><Plus aria-hidden="true" /> Add {name === "tags" ? "tag" : "item"}</button>
  </div>;
}

function JsonValueEditor({ name, value, onChange, onValidityChange }: {
  name: string;
  value: PropertyValue;
  onChange: (value: PropertyValue) => void;
  onValidityChange: (valid: boolean) => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [invalid, setInvalid] = useState(false);
  return <div className={`nested-property${invalid ? " invalid" : ""}`}>
    <CodeEditor value={text} label={`${name} JSON value`} language="json" lineWrapping={false} onChange={(next) => {
      setText(next);
      try {
        onChange(JSON.parse(next) as unknown);
        setInvalid(false);
        onValidityChange(true);
      } catch {
        setInvalid(true);
        onValidityChange(false);
      }
    }} />
  </div>;
}

function mergedSchema(typeNames: string[], types: CollectionTypeDescriptor[]): { properties: Record<string, JsonObject>; required: string[] } {
  const properties: Record<string, JsonObject> = {};
  const required = new Set<string>();
  for (const typeName of typeNames) {
    const descriptor = types.find((type) => type.name.toLocaleLowerCase() === typeName.toLocaleLowerCase());
    const declared = descriptor?.schema.properties;
    if (declared && !Array.isArray(declared) && typeof declared === "object") {
      for (const [name, schema] of Object.entries(declared)) {
        if (schema && !Array.isArray(schema) && typeof schema === "object") properties[name] = schema as JsonObject;
      }
    }
    if (Array.isArray(descriptor?.schema.required)) {
      for (const name of descriptor.schema.required) if (typeof name === "string") required.add(name);
    }
  }
  return { properties, required: [...required] };
}

function validateValue(schema: JsonObject | undefined, value: unknown, path: string): string | undefined {
  if (!schema) return undefined;
  if (value === null) {
    const nullable = schema.type === "null" || (Array.isArray(schema.type) && schema.type.includes("null")) || (Array.isArray(schema.enum) && schema.enum.includes(null));
    return nullable ? undefined : `${path} cannot be null.`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((choice) => JSON.stringify(choice) === JSON.stringify(value))) {
    return `Choose one of the allowed values.`;
  }
  const type = Array.isArray(schema.type) ? schema.type.find((item) => item !== "null") : schema.type;
  if (type === "string") {
    if (typeof value !== "string") return "Enter text.";
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return `Enter at least ${schema.minLength} characters.`;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return `Enter no more than ${schema.maxLength} characters.`;
    if (typeof schema.pattern === "string") {
      try { if (!new RegExp(schema.pattern).test(value)) return "This value does not match the required format."; } catch { /* schema validation reports invalid patterns */ }
    }
  }
  if (type === "number" || type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) return "Enter a number.";
    if (type === "integer" && !Number.isInteger(value)) return "Enter a whole number.";
    if (typeof schema.minimum === "number" && value < schema.minimum) return `Enter ${schema.minimum} or more.`;
    if (typeof schema.maximum === "number" && value > schema.maximum) return `Enter ${schema.maximum} or less.`;
  }
  if (type === "boolean" && typeof value !== "boolean") return "Choose true or false.";
  if (type === "array") {
    if (!Array.isArray(value)) return "Enter a list.";
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return `Add at least ${schema.minItems} items.`;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return `Use no more than ${schema.maxItems} items.`;
    const itemSchema = isObject(schema.items) ? schema.items : undefined;
    for (let index = 0; index < value.length; index += 1) {
      const error = validateValue(itemSchema, value[index], `${path} item ${index + 1}`);
      if (error) return error;
    }
  }
  if (type === "object") {
    if (!isObject(value)) return "Enter an object.";
    const properties = isObject(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
    for (const name of required) {
      if (!(name in value)) return `${name} is required.`;
      const error = validateValue(isObject(properties[name]) ? properties[name] : undefined, value[name], `${path}.${name}`);
      if (error) return error;
    }
  }
  return undefined;
}

function propertyKind(value: PropertyValue): PropertyKind | "null" {
  if (value === null) return "null";
  if (Array.isArray(value)) return "list";
  if (typeof value === "object") return "object";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "text";
}

function initialValue(kind: PropertyKind): PropertyValue {
  if (kind === "number") return 0;
  if (kind === "boolean") return false;
  if (kind === "list") return [];
  if (kind === "object") return {};
  return "";
}

function schemaKind(schema?: JsonObject): string {
  if (!schema) return "Custom";
  if (Array.isArray(schema.enum)) return "Choice";
  if (schema.format === "date") return "Date";
  if (schema.format === "date-time") return "Date & time";
  if (isLinkSchema(schema)) return "Record link";
  const type = Array.isArray(schema.type) ? schema.type.filter((item) => item !== "null").join(" or ") : schema.type;
  if (type === "array") return "List";
  if (type === "boolean") return "Boolean";
  if (type === "integer") return "Integer";
  if (type === "number") return "Number";
  if (type === "object") return "Object";
  return "Text";
}

function description(schema?: JsonObject): string {
  return typeof schema?.description === "string" ? schema.description : "";
}

function isLinkSchema(schema?: JsonObject): boolean {
  const format = typeof schema?.format === "string" ? schema.format.toLocaleLowerCase() : "";
  return format.includes("link") || format.includes("record") || schema?.["x-mdbase-kind"] === "record-link";
}

function schemaAllowsNull(schema?: JsonObject): boolean {
  return schema?.type === "null"
    || (Array.isArray(schema?.type) && schema.type.includes("null"))
    || (Array.isArray(schema?.enum) && schema.enum.includes(null));
}

function isStringList(name: string, schema: JsonObject | undefined, value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  if (name.toLocaleLowerCase() === "tags") return value.every((item) => typeof item === "string");
  return schema?.type === "array"
    && isObject(schema.items)
    && (schema.items as JsonObject).type === "string"
    && !Array.isArray((schema.items as JsonObject).enum);
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function formatBytes(value?: number): string {
  if (value === undefined) return "Unknown";
  if (value < 1_000) return `${value} B`;
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)} KB`;
  return `${(value / 1_000_000).toFixed(1)} MB`;
}

function formatDate(value?: string): string {
  if (!value) return "Unknown";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
