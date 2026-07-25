import { Braces, Plus, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { CollectionTypeDescriptor, JsonObject } from "@mdbase/connect";
import { CodeEditor } from "./CodeEditor";
import type { NoteDocument } from "./model";
import { schemaDateFormat, schemaDateInputType, schemaDateInputValue, schemaDateValue } from "./schema-date";
import { isStructuredSchema, SchemaValueEditor } from "./SchemaValueEditor";

type PropertyKind = "text" | "number" | "boolean" | "list" | "object" | "null";
type PropertyValue = unknown;

interface PropertiesPanelProps {
  note: NoteDocument;
  types: CollectionTypeDescriptor[];
  error?: string;
  onClose: () => void;
  onSave: (value: JsonObject) => void;
}

export function PropertiesPanel({ note, types, error, onClose, onSave }: PropertiesPanelProps) {
  const initial = useMemo(() => structuredClone(note.raw_frontmatter ?? {}), [note]);
  const [draft, setDraft] = useState<JsonObject>(initial);
  const [mode, setMode] = useState<"fields" | "json">("fields");
  const [raw, setRaw] = useState(() => JSON.stringify(initial, null, 2));
  const [rawError, setRawError] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<PropertyKind>("text");
  const schemaProperties = mergedSchemaProperties(note.types, types);
  const changed = JSON.stringify(draft) !== JSON.stringify(initial);

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

  function addField() {
    const name = newName.trim();
    if (!name || name in draft) return;
    updateField(name, initialValue(newKind));
    setNewName("");
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

  return <aside className="properties-panel" aria-label="Note properties">
    <header className="panel-header">
      <div><h2>Properties</h2><p>{note.types.length ? note.types.join(", ") : "Untyped record"}</p></div>
      <button className="icon-button" aria-label="Close properties" onClick={onClose}><X aria-hidden="true" /></button>
    </header>

    <dl className="file-facts">
      <div><dt>Path</dt><dd>{note.path}</dd></div>
      <div><dt>Size</dt><dd>{formatBytes(note.file?.size)}</dd></div>
      <div><dt>Modified</dt><dd>{formatDate(note.file?.mtime)}</dd></div>
    </dl>

    <div className="panel-tabs" role="tablist" aria-label="Frontmatter view">
      <button role="tab" aria-selected={mode === "fields"} onClick={() => setMode("fields")}>Fields</button>
      <button role="tab" aria-selected={mode === "json"} onClick={() => setMode("json")}><Braces aria-hidden="true" /> JSON</button>
    </div>

    {mode === "fields" ? <div className="property-fields">
      {Object.entries(draft).map(([name, value]) => <PropertyRow
        key={name}
        name={name}
        value={value}
        schema={schemaProperties[name]}
        onChange={(next) => updateField(name, next)}
        onRemove={() => removeField(name)}
      />)}
      {!Object.keys(draft).length && <p className="quiet-empty">This note has no persisted properties.</p>}
      {adding ? <div className="add-property-row">
        <label><span>Name</span><input autoFocus list="available-properties" value={newName} onChange={(event) => setNewName(event.target.value)} /></label>
        <datalist id="available-properties">
          {Object.keys(schemaProperties).filter((name) => !(name in draft)).map((name) => <option key={name} value={name} />)}
        </datalist>
        <label><span>Kind</span><select value={newKind} onChange={(event) => setNewKind(event.target.value as PropertyKind)}>
          <option value="text">Text</option><option value="number">Number</option><option value="boolean">Boolean</option>
          <option value="list">List</option><option value="object">Object</option><option value="null">Null</option>
        </select></label>
        <button className="small-button" disabled={!newName.trim() || newName.trim() in draft} onClick={addField}>Add</button>
        <button className="icon-button" aria-label="Cancel adding property" onClick={() => setAdding(false)}><X aria-hidden="true" /></button>
      </div> : <button className="add-property" onClick={() => setAdding(true)}><Plus aria-hidden="true" /> Add property</button>}
    </div> : <div className="raw-properties">
      <CodeEditor value={raw} onChange={updateRaw} label="Raw frontmatter JSON" language="json" lineWrapping={false} />
      {rawError && <p className="property-error" role="alert">{rawError}</p>}
    </div>}

    {(error || (!rawError && changed)) && <div className="property-footer">
      {error && <p className="property-error" role="alert">{error}</p>}
      <button className="property-save" disabled={!changed || Boolean(rawError)} onClick={() => onSave(draft)}>Save properties</button>
    </div>}
  </aside>;
}

function PropertyRow({ name, value, schema, onChange, onRemove }: {
  name: string;
  value: PropertyValue;
  schema?: JsonObject;
  onChange: (value: PropertyValue) => void;
  onRemove: () => void;
}) {
  const kind = propertyKind(value);
  const dateFormat = schemaDateFormat(schema);
  return <div className="property-row">
    <div className="property-row-label"><span>{name}</span>{dateFormat
      ? <select aria-label={`${name} property kind`} value={dateFormat} disabled title="Defined by the mdbase schema">
        <option value={dateFormat}>{dateFormat === "date" ? "Date" : "Date & time"}</option>
      </select>
      : <select aria-label={`${name} property kind`} value={kind} onChange={(event) => onChange(initialValue(event.target.value as PropertyKind))}>
        <option value="text">Text</option><option value="number">Number</option><option value="boolean">Boolean</option>
        <option value="list">List</option><option value="object">Object</option><option value="null">Null</option>
      </select>}</div>
    <PropertyValue name={name} value={value} schema={schema} onChange={onChange} />
    <button className="remove-property" aria-label={`Remove ${name} property`} onClick={onRemove}><Trash2 aria-hidden="true" /></button>
  </div>;
}

function PropertyValue({ name, value, schema, onChange }: {
  name: string;
  value: PropertyValue;
  schema?: JsonObject;
  onChange: (value: PropertyValue) => void;
}) {
  if (isStructuredSchema(schema) && (Array.isArray(value) || (value && typeof value === "object"))) {
    return <SchemaValueEditor name={`${name} value`} schema={schema} value={value} hideLabel onChange={onChange} />;
  }
  if (typeof value === "boolean") {
    return <label className="boolean-property"><input type="checkbox" checked={value} onChange={(event) => onChange(event.target.checked)} /><span>{value ? "True" : "False"}</span></label>;
  }
  if (typeof value === "number") {
    return <input aria-label={`${name} value`} type="number" value={value} onChange={(event) => onChange(Number(event.target.value))} />;
  }
  if (typeof value === "string") {
    const choices = Array.isArray(schema?.enum) ? schema.enum.filter((item): item is string => typeof item === "string") : [];
    if (choices.length) return <select aria-label={`${name} value`} value={value} onChange={(event) => onChange(event.target.value)}>
      {!choices.includes(value) && <option value={value}>{value}</option>}
      {choices.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
    </select>;
    const dateFormat = schemaDateFormat(schema);
    if (dateFormat) return <input
      aria-label={`${name} value`}
      type={schemaDateInputType(dateFormat)}
      step={dateFormat === "date-time" ? 1 : undefined}
      value={schemaDateInputValue(value, dateFormat)}
      onChange={(event) => onChange(schemaDateValue(event.target.value, dateFormat))}
    />;
    return <input aria-label={`${name} value`} value={value} onChange={(event) => onChange(event.target.value)} />;
  }
  if (value === null) return <span className="null-property">null</span>;
  return <JsonValueEditor name={name} value={value} onChange={onChange} />;
}

function JsonValueEditor({ name, value, onChange }: { name: string; value: PropertyValue; onChange: (value: PropertyValue) => void }) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState(false);
  return <div className={`nested-property${error ? " invalid" : ""}`}>
    <CodeEditor value={text} label={`${name} JSON value`} language="json" lineWrapping={false} onChange={(next) => {
      setText(next);
      try {
        onChange(JSON.parse(next) as unknown);
        setError(false);
      } catch {
        setError(true);
      }
    }} />
  </div>;
}

function mergedSchemaProperties(typeNames: string[], types: CollectionTypeDescriptor[]): Record<string, JsonObject> {
  const result: Record<string, JsonObject> = {};
  for (const typeName of typeNames) {
    const descriptor = types.find((type) => type.name.toLocaleLowerCase() === typeName.toLocaleLowerCase());
    const properties = descriptor?.schema.properties;
    if (!properties || Array.isArray(properties) || typeof properties !== "object") continue;
    for (const [name, schema] of Object.entries(properties)) {
      if (schema && !Array.isArray(schema) && typeof schema === "object") result[name] = schema as JsonObject;
    }
  }
  return result;
}

function propertyKind(value: PropertyValue): PropertyKind {
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
  if (kind === "null") return null;
  return "";
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
