import { PlusIcon as Plus } from "./icons";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { JsonObject } from "@mdbase-dev/connect";
import { CodeEditor } from "./CodeEditor";
import { InlineRemoveButton } from "./InlineRemoveButton";
import { SelectControl } from "./SelectionControls";
import { schemaDateFormat, schemaDateInputType, schemaDateInputValue, schemaDateValue } from "./schema-date";

export function SchemaValueEditor({ name, schema, rootSchema, value, required = false, hideLabel = false, onChange, onValidityChange }: {
  name: string;
  schema?: JsonObject;
  rootSchema?: JsonObject;
  value: unknown;
  required?: boolean;
  hideLabel?: boolean;
  onChange: (value: unknown) => void;
  onValidityChange?: (valid: boolean) => void;
}) {
  const root = rootSchema ?? schema;
  const resolved = useMemo(() => resolveSchema(root, schema), [root, schema]);
  const supplied = suppliedValue(resolved);
  useEffect(() => {
    if (value === undefined && (required || supplied !== undefined)) {
      onChange(supplied ?? schemaInitialValue(resolved, root));
    }
  }, [onChange, required, resolved, root, supplied, value]);

  const type = schemaType(resolved, value);
  const label = schemaLabel(name, required, hideLabel, resolved);
  if (resolved && "const" in resolved) {
    return <div className="schema-value schema-constant">{label}<output>{formatValue(resolved.const)}</output></div>;
  }
  if (type === "object" && canEditObject(resolved)) {
    return <ObjectValueEditor name={name} schema={resolved} rootSchema={root} value={value} required={required} hideLabel={hideLabel} onChange={onChange} onValidityChange={onValidityChange} />;
  }
  if (type === "object" && canEditObjectMap(resolved)) {
    return <ObjectMapValueEditor name={name} schema={resolved} rootSchema={root} value={value} required={required} hideLabel={hideLabel} onChange={onChange} onValidityChange={onValidityChange} />;
  }
  if (type === "array" && canEditArray(resolved)) {
    return <ArrayValueEditor name={name} schema={resolved} rootSchema={root} value={value} required={required} hideLabel={hideLabel} onChange={onChange} onValidityChange={onValidityChange} />;
  }
  if (type === "object" || type === "array") {
    return <JsonSchemaValueEditor name={name} type={type} label={label} value={value} onChange={onChange} onValidityChange={onValidityChange} />;
  }
  const choices = Array.isArray(resolved?.enum) ? resolved.enum.filter((item) => item === null || ["string", "number", "boolean"].includes(typeof item)) : [];
  if (choices.length) return <label className="schema-value">{label}<SelectControl
    aria-label={name}
    value={choiceKey(value)}
    onChange={(event) => {
      const choice = choices.find((item) => choiceKey(item) === event.target.value);
      if (choice !== undefined || event.target.value === choiceKey(null)) onChange(structuredClone(choice));
    }}
  >
    <option value="">Choose</option>{choices.map((choice, index) => <option key={`${choiceKey(choice)}:${index}`} value={choiceKey(choice)}>{formatValue(choice)}</option>)}
  </SelectControl></label>;
  const dateFormat = schemaDateFormat(resolved);
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
    min={typeof resolved?.minimum === "number" ? resolved.minimum : undefined}
    max={typeof resolved?.maximum === "number" ? resolved.maximum : undefined}
    value={typeof value === "number" ? value : ""}
    onChange={(event) => onChange(event.target.value === "" ? undefined : Number(event.target.value))}
  /></label>;
  return <label className="schema-value">{label}<input
    aria-label={name}
    minLength={typeof resolved?.minLength === "number" ? resolved.minLength : undefined}
    maxLength={typeof resolved?.maxLength === "number" ? resolved.maxLength : undefined}
    pattern={typeof resolved?.pattern === "string" ? resolved.pattern : undefined}
    value={typeof value === "string" ? value : ""}
    onChange={(event) => onChange(event.target.value)}
  /></label>;
}

function ObjectValueEditor({ name, schema, rootSchema, value, required, hideLabel, onChange, onValidityChange }: {
  name: string;
  schema?: JsonObject;
  rootSchema?: JsonObject;
  value: unknown;
  required: boolean;
  hideLabel: boolean;
  onChange: (value: unknown) => void;
  onValidityChange?: (valid: boolean) => void;
}) {
  const properties = schemaProperties(schema);
  const requiredFields = schemaRequired(schema);
  const objectValue = isObject(value) ? value : {};
  const optionalFields = Object.keys(properties).filter((field) => !requiredFields.includes(field) && !(field in objectValue));
  const [adding, setAdding] = useState(false);
  const [fieldToAdd, setFieldToAdd] = useState(optionalFields[0] ?? "");
  const visibleFields = [
    ...Object.keys(objectValue).filter((field) => field in properties),
    ...requiredFields.filter((field) => field in properties && !(field in objectValue))
  ];
  const label = schemaLabel(name, required, hideLabel, schema);

  function updateField(field: string, next: unknown) {
    onChange({ ...objectValue, [field]: next });
  }

  function removeField(field: string) {
    const next = { ...objectValue };
    delete next[field];
    onChange(next);
  }

  function addField() {
    const field = optionalFields.includes(fieldToAdd) ? fieldToAdd : optionalFields[0];
    if (!field) return;
    onChange({ ...objectValue, [field]: schemaInitialValue(properties[field], rootSchema) });
    setAdding(false);
  }

  return <fieldset className="schema-value schema-object">
    <legend>{label}</legend>
    <div className="schema-object-fields">
      {visibleFields.map((field) => <div className="schema-nested-value" key={field}>
        <SchemaValueEditor
          name={field}
          schema={properties[field]}
          rootSchema={rootSchema}
          value={objectValue[field]}
          required={requiredFields.includes(field)}
          onChange={(next) => updateField(field, next)}
          onValidityChange={onValidityChange}
        />
        {!requiredFields.includes(field) && <InlineRemoveButton className="schema-remove-value" label={`Remove ${field}`} onClick={() => removeField(field)} />}
      </div>)}
      {!visibleFields.length && <p className="schema-empty-value">No declared values.</p>}
    </div>
    {optionalFields.length > 0 && (adding ? <div className="schema-add-value">
      <label><span className="sr-only">Optional field</span><SelectControl value={fieldToAdd || optionalFields[0]} onChange={(event) => setFieldToAdd(event.target.value)}>{optionalFields.map((field) => <option key={field} value={field}>{humanizeName(field)}</option>)}</SelectControl></label>
      <button type="button" onClick={addField}>Add</button>
      <button type="button" onClick={() => setAdding(false)}>Cancel</button>
    </div> : <button type="button" className="schema-add-trigger" onClick={() => { setFieldToAdd(optionalFields[0]); setAdding(true); }}><Plus aria-hidden="true" />Add optional field</button>)}
  </fieldset>;
}

function ArrayValueEditor({ name, schema, rootSchema, value, required, hideLabel, onChange, onValidityChange }: {
  name: string;
  schema?: JsonObject;
  rootSchema?: JsonObject;
  value: unknown;
  required: boolean;
  hideLabel: boolean;
  onChange: (value: unknown) => void;
  onValidityChange?: (valid: boolean) => void;
}) {
  const items = isObject(schema?.items) ? schema.items as JsonObject : undefined;
  const list = Array.isArray(value) ? value : [];
  const minimum = typeof schema?.minItems === "number" ? Math.max(0, Math.floor(schema.minItems)) : 0;
  const maximum = typeof schema?.maxItems === "number" ? Math.max(0, Math.floor(schema.maxItems)) : undefined;
  const label = schemaLabel(name, required, hideLabel, schema);
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
        <SchemaValueEditor name={`${name} item ${index + 1}`} schema={items} rootSchema={rootSchema} value={item} hideLabel={!isStructuredSchema(items, rootSchema)} onChange={(next) => updateItem(index, next)} onValidityChange={onValidityChange} />
        <InlineRemoveButton
          className="schema-remove-value"
          label={`Remove ${name} item ${index + 1}`}
          disabled={list.length <= minimum}
          title={list.length <= minimum ? `At least ${minimum} ${minimum === 1 ? "item is" : "items are"} required.` : undefined}
          onClick={() => removeItem(index)}
        />
      </div>)}
      {!list.length && <p className="schema-empty-value">No items yet.</p>}
    </div>
    <button type="button" className="schema-add-trigger" disabled={maximum !== undefined && list.length >= maximum} onClick={() => onChange([...list, schemaInitialValue(items, rootSchema)])}><Plus aria-hidden="true" />Add item</button>
  </fieldset>;
}

function ObjectMapValueEditor({ name, schema, rootSchema, value, required, hideLabel, onChange, onValidityChange }: {
  name: string;
  schema?: JsonObject;
  rootSchema?: JsonObject;
  value: unknown;
  required: boolean;
  hideLabel: boolean;
  onChange: (value: unknown) => void;
  onValidityChange?: (valid: boolean) => void;
}) {
  const objectValue = isObject(value) ? value : {};
  const entries = Object.entries(objectValue);
  const entrySchema = isObject(schema?.additionalProperties) ? schema.additionalProperties as JsonObject : undefined;
  const label = schemaLabel(name, required, hideLabel, schema);

  function renameEntry(previousName: string, nextName: string) {
    if (nextName === previousName || (nextName in objectValue && nextName !== previousName)) return;
    onChange(Object.fromEntries(entries.map(([entryName, entryValue]) =>
      entryName === previousName ? [nextName, entryValue] : [entryName, entryValue]
    )));
  }

  function updateEntry(entryName: string, next: unknown) {
    onChange({ ...objectValue, [entryName]: next });
  }

  function removeEntry(entryName: string) {
    const next = { ...objectValue };
    delete next[entryName];
    onChange(next);
  }

  function addEntry() {
    let candidate = "entry";
    let suffix = 2;
    while (candidate in objectValue) candidate = `entry-${suffix++}`;
    onChange({ ...objectValue, [candidate]: schemaInitialValue(entrySchema, rootSchema) });
  }

  return <fieldset className="schema-value schema-object schema-object-map">
    <legend>{label}</legend>
    <div className="schema-map-entries">
      {entries.map(([entryName, entryValue], index) => <div className="schema-map-entry" key={index}>
        <label className="schema-map-key">
          <span className="sr-only">{name} entry {index + 1} key</span>
          <input
            aria-label={`${name} entry ${index + 1} key`}
            value={entryName}
            placeholder="Key"
            spellCheck={false}
            onChange={(event) => renameEntry(entryName, event.target.value)}
          />
        </label>
        <SchemaValueEditor
          name={`${entryName || `Entry ${index + 1}`} value`}
          schema={entrySchema}
          rootSchema={rootSchema}
          value={entryValue}
          hideLabel
          onChange={(next) => updateEntry(entryName, next)}
          onValidityChange={onValidityChange}
        />
        <InlineRemoveButton className="schema-remove-value" label={`Remove ${entryName || `entry ${index + 1}`}`} onClick={() => removeEntry(entryName)} />
      </div>)}
      {!entries.length && <p className="schema-empty-value">No entries yet.</p>}
    </div>
    <button type="button" className="schema-add-trigger" onClick={addEntry}><Plus aria-hidden="true" />Add entry</button>
  </fieldset>;
}

function JsonSchemaValueEditor({ name, type, label, value, onChange, onValidityChange }: {
  name: string;
  type: "array" | "object";
  label: ReactNode;
  value: unknown;
  onChange: (value: unknown) => void;
  onValidityChange?: (valid: boolean) => void;
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
      onValidityChange?.(true);
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : "Invalid JSON.");
      onValidityChange?.(false);
    }
  }} />{error && <small className="schema-value-error" role="alert">{error}</small>}</label>;
}

export function schemaInitialValue(schema?: JsonObject, rootSchema: JsonObject | undefined = schema): unknown {
  const resolved = resolveSchema(rootSchema, schema);
  const supplied = suppliedValue(resolved);
  if (supplied !== undefined) return supplied;
  const type = schemaType(resolved);
  if (type === "object") {
    const properties = schemaProperties(resolved);
    const required = new Set(schemaRequired(resolved));
    return Object.fromEntries(Object.entries(properties).flatMap(([name, child]) => {
      const resolvedChild = resolveSchema(rootSchema, child);
      const childSupplied = suppliedValue(resolvedChild);
      return required.has(name) || childSupplied !== undefined ? [[name, childSupplied ?? schemaInitialValue(resolvedChild, rootSchema)]] : [];
    }));
  }
  if (type === "array") {
    const items = isObject(resolved?.items) ? resolved.items as JsonObject : undefined;
    const minimum = typeof resolved?.minItems === "number" ? Math.max(0, Math.floor(resolved.minItems)) : 0;
    return Array.from({ length: minimum }, () => schemaInitialValue(items, rootSchema));
  }
  if (type === "boolean") return false;
  if (type === "number" || type === "integer") return 0;
  return "";
}

export function schemaValueComplete(schema: JsonObject | undefined, value: unknown, rootSchema: JsonObject | undefined = schema): boolean {
  const resolved = resolveSchema(rootSchema, schema);
  if (value === undefined || value === null) return false;
  const type = schemaType(resolved, value);
  if (type === "string") {
    if (typeof value !== "string" || !value.length) return false;
    if (typeof resolved?.minLength === "number" && value.length < resolved.minLength) return false;
    if (typeof resolved?.maxLength === "number" && value.length > resolved.maxLength) return false;
    const choices = Array.isArray(resolved?.enum) ? resolved.enum : undefined;
    return !choices || choices.includes(value);
  }
  if (type === "number" || type === "integer") return typeof value === "number" && Number.isFinite(value) && (type !== "integer" || Number.isInteger(value));
  if (type === "boolean") return typeof value === "boolean";
  if (type === "array") {
    if (!Array.isArray(value)) return false;
    if (typeof resolved?.minItems === "number" && value.length < resolved.minItems) return false;
    const items = isObject(resolved?.items) ? resolved.items as JsonObject : undefined;
    return value.every((item) => schemaValueComplete(items, item, rootSchema));
  }
  if (type === "object") {
    if (!isObject(value)) return false;
    const properties = schemaProperties(resolved);
    const requiredFields = schemaRequired(resolved);
    return requiredFields.every((field) => field in value)
      && Object.entries(properties).every(([field, childSchema]) => (
        !(field in value) || schemaValueComplete(childSchema, value[field], rootSchema)
      ));
  }
  return true;
}

export function isStructuredSchema(schema?: JsonObject, rootSchema: JsonObject | undefined = schema): boolean {
  const resolved = resolveSchema(rootSchema, schema);
  const type = schemaType(resolved);
  return (type === "object" && (canEditObject(resolved) || canEditObjectMap(resolved)))
    || (type === "array" && canEditArray(resolved));
}

function schemaType(schema?: JsonObject, value?: unknown): string {
  if (typeof schema?.type === "string") return schema.type;
  if (Array.isArray(value)) return "array";
  if (isObject(value)) return "object";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "string";
}

export function schemaProperties(schema?: JsonObject): Record<string, JsonObject> {
  if (!isObject(schema?.properties)) return {};
  return Object.fromEntries(Object.entries(schema.properties).filter((entry): entry is [string, JsonObject] => isObject(entry[1])));
}

export function schemaRequired(schema?: JsonObject): string[] {
  return Array.isArray(schema?.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
}

function canEditObject(schema?: JsonObject): boolean {
  return isObject(schema?.properties);
}

function canEditObjectMap(schema?: JsonObject): boolean {
  return schema?.additionalProperties === true || isObject(schema?.additionalProperties);
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

export function resolveSchema(
  rootSchema?: JsonObject,
  schema?: JsonObject,
  visited: Set<string> = new Set()
): JsonObject | undefined {
  if (!schema) return undefined;
  let resolved = { ...schema };
  if (typeof schema.$ref === "string" && schema.$ref.startsWith("#/") && rootSchema && !visited.has(schema.$ref)) {
    const target = resolveLocalReference(rootSchema, schema.$ref);
    if (target) {
      const nextVisited = new Set(visited);
      nextVisited.add(schema.$ref);
      const base = resolveSchema(rootSchema, target, nextVisited) ?? {};
      resolved = mergeSchemas(base, resolved);
      delete resolved.$ref;
    }
  }
  const branches = Array.isArray(resolved.allOf)
    ? resolved.allOf.filter((branch): branch is JsonObject => isObject(branch))
    : [];
  for (const branch of branches) {
    resolved = mergeSchemas(resolved, resolveSchema(rootSchema, branch, visited) ?? {});
  }
  delete resolved.allOf;
  return resolved;
}

function resolveLocalReference(rootSchema: JsonObject, reference: string): JsonObject | undefined {
  let current: unknown = rootSchema;
  for (const encoded of reference.slice(2).split("/")) {
    if (!isObject(current)) return undefined;
    const segment = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    current = current[segment];
  }
  return isObject(current) ? current : undefined;
}

function mergeSchemas(base: JsonObject, overlay: JsonObject): JsonObject {
  const merged: JsonObject = { ...base, ...overlay };
  const baseProperties = isObject(base.properties) ? base.properties : {};
  const overlayProperties = isObject(overlay.properties) ? overlay.properties : {};
  if (Object.keys(baseProperties).length || Object.keys(overlayProperties).length) {
    merged.properties = { ...baseProperties, ...overlayProperties };
  }
  const required = [
    ...(Array.isArray(base.required) ? base.required : []),
    ...(Array.isArray(overlay.required) ? overlay.required : [])
  ].filter((field): field is string => typeof field === "string");
  if (required.length) merged.required = [...new Set(required)];
  return merged;
}

function schemaLabel(name: string, required: boolean, hideLabel: boolean, schema?: JsonObject): ReactNode {
  if (hideLabel) return <span className="sr-only">{name}</span>;
  return <span className="schema-value-label">
    <span>{humanizeName(name)}{required && <small aria-hidden="true">Required</small>}</span>
    {typeof schema?.description === "string" && <small>{schema.description}</small>}
  </span>;
}

export function humanizeName(name: string): string {
  return name
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function formatValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function choiceKey(value: unknown): string {
  return value === undefined ? "" : `${typeof value}:${JSON.stringify(value)}`;
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
