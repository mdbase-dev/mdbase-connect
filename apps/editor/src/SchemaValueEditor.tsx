import { Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { JsonObject } from "@mdbase/connect";
import { CodeEditor } from "./CodeEditor";
import { schemaDateFormat, schemaDateInputType, schemaDateInputValue, schemaDateValue } from "./schema-date";

export function SchemaValueEditor({ name, schema, value, required = false, hideLabel = false, onChange }: {
  name: string;
  schema?: JsonObject;
  value: unknown;
  required?: boolean;
  hideLabel?: boolean;
  onChange: (value: unknown) => void;
}) {
  const supplied = suppliedValue(schema);
  useEffect(() => {
    if (value === undefined && (required || supplied !== undefined)) onChange(supplied ?? schemaInitialValue(schema));
  }, [onChange, required, schema, supplied, value]);

  const type = schemaType(schema, value);
  const label = hideLabel ? <span className="sr-only">{name}</span> : <span>{name}{required && <small aria-hidden="true">Required</small>}</span>;
  if (schema && "const" in schema) {
    return <div className="schema-value schema-constant">{label}<output>{formatValue(schema.const)}</output></div>;
  }
  if (type === "object" && canEditObject(schema)) {
    return <ObjectValueEditor name={name} schema={schema} value={value} required={required} hideLabel={hideLabel} onChange={onChange} />;
  }
  if (type === "array" && canEditArray(schema)) {
    return <ArrayValueEditor name={name} schema={schema} value={value} required={required} hideLabel={hideLabel} onChange={onChange} />;
  }
  if (type === "object" || type === "array") {
    return <JsonSchemaValueEditor name={name} type={type} label={label} value={value} onChange={onChange} />;
  }
  const choices = Array.isArray(schema?.enum) ? schema.enum.filter((item): item is string => typeof item === "string") : [];
  if (choices.length) return <label className="schema-value">{label}<select aria-label={name} value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value)}>
    <option value="">Choose</option>{choices.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
  </select></label>;
  const dateFormat = schemaDateFormat(schema);
  if (dateFormat) return <label className="schema-value">{label}<input
    aria-label={name}
    type={schemaDateInputType(dateFormat)}
    step={dateFormat === "date-time" ? 1 : undefined}
    value={schemaDateInputValue(value, dateFormat)}
    onChange={(event) => onChange(schemaDateValue(event.target.value, dateFormat))}
  /></label>;
  if (type === "boolean") return <label className="schema-value schema-boolean">{label}<span><input aria-label={name} type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} />{value === true ? "True" : "False"}</span></label>;
  if (type === "number" || type === "integer") return <label className="schema-value">{label}<input
    aria-label={name}
    type="number"
    step={type === "integer" ? 1 : "any"}
    value={typeof value === "number" ? value : ""}
    onChange={(event) => onChange(event.target.value === "" ? undefined : Number(event.target.value))}
  /></label>;
  return <label className="schema-value">{label}<input aria-label={name} value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value)} /></label>;
}

function ObjectValueEditor({ name, schema, value, required, hideLabel, onChange }: {
  name: string;
  schema?: JsonObject;
  value: unknown;
  required: boolean;
  hideLabel: boolean;
  onChange: (value: unknown) => void;
}) {
  const properties = schemaProperties(schema);
  const requiredFields = schemaRequired(schema);
  const objectValue = isObject(value) ? value : {};
  const optionalFields = Object.keys(properties).filter((field) => !requiredFields.includes(field) && !(field in objectValue));
  const [adding, setAdding] = useState(false);
  const [fieldToAdd, setFieldToAdd] = useState(optionalFields[0] ?? "");
  const visibleFields = Object.keys(properties).filter((field) => requiredFields.includes(field) || field in objectValue);
  const label = hideLabel ? <span className="sr-only">{name}</span> : <span>{name}{required && <small aria-hidden="true">Required</small>}</span>;

  function updateField(field: string, next: unknown) {
    onChange({ ...objectValue, [field]: next });
  }

  function removeField(field: string) {
    const next = { ...objectValue };
    delete next[field];
    onChange(next);
  }

  function addField() {
    const field = fieldToAdd || optionalFields[0];
    if (!field) return;
    onChange({ ...objectValue, [field]: schemaInitialValue(properties[field]) });
    setAdding(false);
  }

  return <fieldset className="schema-value schema-object">
    <legend>{label}</legend>
    <div className="schema-object-fields">
      {visibleFields.map((field) => <div className="schema-nested-value" key={field}>
        <SchemaValueEditor
          name={field}
          schema={properties[field]}
          value={objectValue[field]}
          required={requiredFields.includes(field)}
          onChange={(next) => updateField(field, next)}
        />
        {!requiredFields.includes(field) && <button type="button" className="schema-remove-value" aria-label={`Remove ${field}`} onClick={() => removeField(field)}><Trash2 aria-hidden="true" /></button>}
      </div>)}
      {!visibleFields.length && <p className="schema-empty-value">No declared values.</p>}
    </div>
    {optionalFields.length > 0 && (adding ? <div className="schema-add-value">
      <label><span className="sr-only">Optional field</span><select value={fieldToAdd || optionalFields[0]} onChange={(event) => setFieldToAdd(event.target.value)}>{optionalFields.map((field) => <option key={field} value={field}>{field}</option>)}</select></label>
      <button type="button" onClick={addField}>Add</button>
      <button type="button" onClick={() => setAdding(false)}>Cancel</button>
    </div> : <button type="button" className="schema-add-trigger" onClick={() => { setFieldToAdd(optionalFields[0]); setAdding(true); }}><Plus aria-hidden="true" />Add optional field</button>)}
  </fieldset>;
}

function ArrayValueEditor({ name, schema, value, required, hideLabel, onChange }: {
  name: string;
  schema?: JsonObject;
  value: unknown;
  required: boolean;
  hideLabel: boolean;
  onChange: (value: unknown) => void;
}) {
  const items = isObject(schema?.items) ? schema.items as JsonObject : undefined;
  const list = Array.isArray(value) ? value : [];
  const label = hideLabel ? <span className="sr-only">{name}</span> : <span>{name}{required && <small aria-hidden="true">Required</small>}</span>;
  function updateItem(index: number, next: unknown) {
    onChange(list.map((item, itemIndex) => itemIndex === index ? next : item));
  }
  function removeItem(index: number) {
    onChange(list.filter((_, itemIndex) => itemIndex !== index));
  }
  return <fieldset className="schema-value schema-array">
    <legend>{label}</legend>
    <div className="schema-array-items">
      {list.map((item, index) => <div className="schema-array-item" key={index}>
        <span className="schema-item-number">{index + 1}</span>
        <SchemaValueEditor name={`${name} item ${index + 1}`} schema={items} value={item} hideLabel={!isStructuredSchema(items)} onChange={(next) => updateItem(index, next)} />
        <button type="button" className="schema-remove-value" aria-label={`Remove ${name} item ${index + 1}`} onClick={() => removeItem(index)}><Trash2 aria-hidden="true" /></button>
      </div>)}
      {!list.length && <p className="schema-empty-value">No items yet.</p>}
    </div>
    <button type="button" className="schema-add-trigger" onClick={() => onChange([...list, schemaInitialValue(items)])}><Plus aria-hidden="true" />Add item</button>
  </fieldset>;
}

function JsonSchemaValueEditor({ name, type, label, value, onChange }: {
  name: string;
  type: "array" | "object";
  label: ReactNode;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const initial = useMemo(() => value ?? (type === "array" ? [] : {}), [type, value]);
  const [text, setText] = useState(() => JSON.stringify(initial, null, 2));
  const [error, setError] = useState<string>();
  return <label className="schema-value schema-json-value">{label}<CodeEditor value={text} label={`${name} JSON value`} language="json" lineWrapping={false} onChange={(next) => {
    setText(next);
    try {
      const parsed = JSON.parse(next) as unknown;
      if ((type === "array" && !Array.isArray(parsed)) || (type === "object" && !isObject(parsed))) throw new Error(`Enter a JSON ${type}.`);
      onChange(parsed);
      setError(undefined);
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : "Invalid JSON.");
    }
  }} />{error && <small className="schema-value-error" role="alert">{error}</small>}</label>;
}

export function schemaInitialValue(schema?: JsonObject): unknown {
  const supplied = suppliedValue(schema);
  if (supplied !== undefined) return supplied;
  const type = schemaType(schema);
  if (type === "object") {
    const properties = schemaProperties(schema);
    const required = new Set(schemaRequired(schema));
    return Object.fromEntries(Object.entries(properties).flatMap(([name, child]) => {
      const childSupplied = suppliedValue(child);
      return required.has(name) || childSupplied !== undefined ? [[name, childSupplied ?? schemaInitialValue(child)]] : [];
    }));
  }
  if (type === "array") {
    const items = isObject(schema?.items) ? schema.items as JsonObject : undefined;
    const minimum = typeof schema?.minItems === "number" ? Math.max(0, Math.floor(schema.minItems)) : 0;
    return Array.from({ length: minimum }, () => schemaInitialValue(items));
  }
  if (type === "boolean") return false;
  if (type === "number" || type === "integer") return 0;
  return "";
}

export function schemaValueComplete(schema: JsonObject | undefined, value: unknown): boolean {
  if (value === undefined || value === null) return false;
  const type = schemaType(schema, value);
  if (type === "string") {
    if (typeof value !== "string" || !value.length) return false;
    if (typeof schema?.minLength === "number" && value.length < schema.minLength) return false;
    if (typeof schema?.maxLength === "number" && value.length > schema.maxLength) return false;
    const choices = Array.isArray(schema?.enum) ? schema.enum : undefined;
    return !choices || choices.includes(value);
  }
  if (type === "number" || type === "integer") return typeof value === "number" && Number.isFinite(value) && (type !== "integer" || Number.isInteger(value));
  if (type === "boolean") return typeof value === "boolean";
  if (type === "array") {
    if (!Array.isArray(value)) return false;
    if (typeof schema?.minItems === "number" && value.length < schema.minItems) return false;
    const items = isObject(schema?.items) ? schema.items as JsonObject : undefined;
    return value.every((item) => schemaValueComplete(items, item));
  }
  if (type === "object") {
    if (!isObject(value)) return false;
    const properties = schemaProperties(schema);
    return schemaRequired(schema).every((field) => field in value && schemaValueComplete(properties[field], value[field]));
  }
  return true;
}

export function isStructuredSchema(schema?: JsonObject): boolean {
  const type = schemaType(schema);
  return (type === "object" && canEditObject(schema)) || (type === "array" && canEditArray(schema));
}

function schemaType(schema?: JsonObject, value?: unknown): string {
  if (typeof schema?.type === "string") return schema.type;
  if (Array.isArray(value)) return "array";
  if (isObject(value)) return "object";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "string";
}

function schemaProperties(schema?: JsonObject): Record<string, JsonObject> {
  if (!isObject(schema?.properties)) return {};
  return Object.fromEntries(Object.entries(schema.properties).filter((entry): entry is [string, JsonObject] => isObject(entry[1])));
}

function schemaRequired(schema?: JsonObject): string[] {
  return Array.isArray(schema?.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
}

function canEditObject(schema?: JsonObject): boolean {
  return isObject(schema?.properties);
}

function canEditArray(schema?: JsonObject): boolean {
  return isObject(schema?.items);
}

function suppliedValue(schema?: JsonObject): unknown {
  if (!schema) return undefined;
  if ("const" in schema) return structuredClone(schema.const);
  if ("default" in schema) return structuredClone(schema.default);
  return undefined;
}

function formatValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
