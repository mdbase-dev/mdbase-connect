import { i18n } from "@lingui/core";
import { Trans } from "@lingui/react/macro";
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import {
  MagnifyingGlassIcon as Search,
  PlusIcon as Plus,
  XIcon as X
} from "./icons";
import { useEffect, useMemo, useState } from "react";
import type { JsonObject } from "@mdbase-dev/connect";
import { CodeEditor } from "./CodeEditor";
import { InlineRemoveButton } from "./InlineRemoveButton";
import { schemaInitialValue, SchemaValueEditor } from "./SchemaValueEditor";
import { ComboboxInput } from "./SelectionControls";
import { Select } from "@mdbase-dev/ui/select";

type PropertyKind = "text" | "number" | "boolean" | "list" | "object";

const propertyKinds: ReadonlyArray<{ value: PropertyKind; label: string }> = [
  { value: "text", get label() { return t`Text`; } },
  { value: "number", get label() { return t`Number`; } },
  { value: "boolean", get label() { return t`Boolean`; } },
  { value: "list", get label() { return t`List`; } },
  { value: "object", get label() { return t`Object`; } }
];
type PropertyValue = unknown;

export interface PropertyContract {
  properties: Record<string, JsonObject>;
  required: string[];
}

export function StructuredPropertiesEditor({
  value,
  contract,
  propertyNames,
  effectiveValues,
  recordPaths = [],
  initializeRequired = false,
  allowAdd = true,
  allowCustom = true,
  emptyMessage = t`No properties yet.`,
  groupUndeclared = false,
  readOnly = false,
  onChange,
  onValidityChange
}: {
  value: JsonObject;
  contract: PropertyContract;
  propertyNames?: string[];
  effectiveValues?: JsonObject;
  recordPaths?: string[];
  initializeRequired?: boolean;
  allowAdd?: boolean;
  allowCustom?: boolean;
  emptyMessage?: string;
  groupUndeclared?: boolean;
  readOnly?: boolean;
  onChange: (value: JsonObject) => void;
  onValidityChange?: (valid: boolean) => void;
}) {
  useLingui();
  const included = useMemo(() => propertyNames ? new Set(propertyNames) : undefined, [propertyNames, i18n.locale]);
  const visible = (name: string) => !included || included.has(name);
  const required = contract.required.filter(visible);
  const [editorValidity, setEditorValidity] = useState<Record<string, boolean>>({});
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState("");
  const [customizing, setCustomizing] = useState(false);
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<PropertyKind>("text");
  const [additionalOpen, setAdditionalOpen] = useState(false);
  const entries = Object.entries(value).filter(([name]) => visible(name));
  const described = (name: string) => Object.hasOwn(contract.properties, name) || required.includes(name);
  const primary = groupUndeclared ? entries.filter(([name]) => described(name)) : entries;
  const additional = groupUndeclared ? entries.filter(([name]) => !described(name)) : [];
  const available = Object.keys(contract.properties)
    .filter(visible)
    .filter((name) => !(name in value))
    .filter((name) => !search.trim() || name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const missingRequired = required.filter((name) => !(name in value));
  const fieldErrors = propertyValidationErrors(value, { properties: contract.properties, required }, editorValidity, visible);
  const effective = Object.entries(effectiveValues ?? {}).filter(([name, effectiveValue]) =>
    visible(name) && (!(name in value) || JSON.stringify(value[name]) !== JSON.stringify(effectiveValue))
  );
  const validityFingerprint = JSON.stringify(fieldErrors);

  useEffect(() => {
    if (!initializeRequired || !missingRequired.length) return;
    const next = { ...value };
    for (const name of missingRequired) next[name] = schemaInitialValue(contract.properties[name]);
    onChange(next);
  }, [contract.properties, initializeRequired, missingRequired, onChange, value]);

  useEffect(() => {
    onValidityChange?.(Object.keys(fieldErrors).length === 0);
  }, [onValidityChange, validityFingerprint]);

  function updateField(name: string, next: PropertyValue) {
    onChange({ ...value, [name]: next });
  }

  function removeField(name: string) {
    const next = { ...value };
    delete next[name];
    onChange(next);
  }

  function addSchemaProperty(name: string) {
    updateField(name, schemaInitialValue(contract.properties[name]));
    setSearch("");
    setAdding(false);
  }

  function addCustomProperty() {
    const name = newName.trim();
    if (!name || name in value) return;
    updateField(name, initialValue(newKind));
    setNewName("");
    setCustomizing(false);
    setAdding(false);
    setAdditionalOpen(true);
  }

  const renderProperty = ([name, propertyValue]: [string, unknown]) => <PropertyRow
    key={name}
    name={name}
    value={propertyValue}
    schema={contract.properties[name]}
    required={required.includes(name)}
    error={fieldErrors[name]}
    recordPaths={recordPaths}
    onChange={(next) => updateField(name, next)}
    onValidityChange={(valid) => setEditorValidity((current) => ({ ...current, [name]: valid }))}
    onRemove={initializeRequired && required.includes(name) ? undefined : () => removeField(name)}
    readOnly={readOnly}
  />;

  return <div className="structured-properties-editor">
    {!initializeRequired && missingRequired.length > 0 && <section className="missing-properties" aria-label={t`Missing required properties`}>
      <h3><Trans>Required</Trans></h3>
      <p><Trans>These properties must be persisted before this record is valid.</Trans></p>
      {missingRequired.map((name) => <button type="button" key={name} onClick={() => addSchemaProperty(name)}>
        <span><strong>{name}</strong>{description(contract.properties[name]) && <small>{description(contract.properties[name])}</small>}</span>
        <Plus aria-hidden="true" />
      </button>)}
    </section>}

    {primary.map(renderProperty)}
    {additional.length > 0 && <details className="additional-properties" open={additionalOpen} onToggle={(event) => setAdditionalOpen(event.currentTarget.open)}>
      <summary><Trans>Additional properties</Trans></summary>
      <p><Trans>These properties are not described by this note's type. Other apps may use them.</Trans></p>
      {additional.map(renderProperty)}
    </details>}

    {!entries.length && !missingRequired.length && emptyMessage && <p className="quiet-empty">{emptyMessage}</p>}

    {allowAdd && (adding ? <div className="property-picker">
      <label className="property-search"><Search aria-hidden="true" /><span className="sr-only"><Trans>Find a property</Trans></span><input
        autoFocus
        type="search"
        value={search}
        placeholder={t`Find a property`}
        onChange={(event) => setSearch(event.target.value)}
      /></label>
      {!customizing ? <>
        <div className="property-options">
          {available.map((name) => <button type="button" key={name} onClick={() => addSchemaProperty(name)}>
            <span><strong>{name}</strong><small>{description(contract.properties[name]) || schemaKind(contract.properties[name])}</small></span>
            {required.includes(name) && <em><Trans>Required</Trans></em>}
          </button>)}
          {!available.length && <p><Trans>No matching schema properties.</Trans></p>}
        </div>
        {allowCustom && <button type="button" className="custom-property-trigger" onClick={() => { setNewName(search); setCustomizing(true); }}><Trans>Add a custom property…</Trans></button>}
      </> : <div className="custom-property">
        <label><span><Trans>Name</Trans></span><input autoFocus value={newName} onChange={(event) => setNewName(event.target.value)} /></label>
        <label><span><Trans>Field type</Trans></span><Select aria-label={t`Field type`} value={newKind} options={propertyKinds} onChange={setNewKind} /></label>
        <div><button type="button" onClick={() => setCustomizing(false)}><Trans>Back</Trans></button><button type="button" className="small-button" disabled={!newName.trim() || newName.trim() in value} onClick={addCustomProperty}><Trans>Add</Trans></button></div>
      </div>}
      <button type="button" className="property-picker-close" onClick={() => { setAdding(false); setCustomizing(false); }}><X aria-hidden="true" /> <Trans>Cancel</Trans></button>
    </div> : (available.length > 0 || allowCustom) && <button type="button" className="add-property" onClick={() => setAdding(true)}><Plus aria-hidden="true" /> <Trans>Add property</Trans></button>)}

    {effective.length > 0 && <section className="effective-properties" aria-label={t`Automatic properties`}>
      <div><h3><Trans>Automatic</Trans></h3><p><Trans>Provided by the note's type, not stored in this file.</Trans></p></div>
      {effective.map(([name, effectiveValue]) => <div className="effective-property" key={name}>
        <span><strong>{name}</strong><small>{Object.prototype.hasOwnProperty.call(contract.properties[name] ?? {}, "default") ? t`Default` : t`Calculated`}</small></span>
        <output>{formatValue(effectiveValue)}</output>
      </div>)}
    </section>}
  </div>;
}

function PropertyRow({ name, value, schema, required, error, recordPaths, onChange, onValidityChange, onRemove, readOnly }: {
  name: string;
  value: PropertyValue;
  schema?: JsonObject;
  required: boolean;
  error?: string;
  recordPaths: string[];
  onChange: (value: PropertyValue) => void;
  onValidityChange: (valid: boolean) => void;
  onRemove?: () => void;
  readOnly: boolean;
}) {
  useLingui();
  const defined = Boolean(schema);
  const kind = propertyKind(value);
  return <div className={`property-row${error ? " invalid" : ""}`}>
    <div className="property-row-label">
      <span><strong>{name}</strong>{required && <small><Trans>Required</Trans></small>}</span>
      {defined
        ? <span className="property-kind" title={t`Defined by this note's type`}>{schemaKind(schema)}</span>
        : <Select className="is-compact" aria-label={t`${name} property type`} value={kind === "null" ? "" : kind} placeholder={t`Null`} options={propertyKinds} onChange={(next) => onChange(initialValue(next))} />}
    </div>
    {description(schema) && <p className="property-description">{description(schema)}</p>}
    <PropertyValue name={name} value={value} schema={schema} recordPaths={recordPaths} onChange={onChange} onValidityChange={onValidityChange} readOnly={readOnly} />
    {schemaAllowsNull(schema) && value !== null && <button type="button" className="set-null-property" onClick={() => onChange(null)}><Trans>Set to null</Trans></button>}
    {error && <p className="field-error" role="alert">{error}</p>}
    {onRemove && <InlineRemoveButton className="remove-property" label={t`Remove ${name} property`} onClick={onRemove} />}
  </div>;
}

function PropertyValue({ name, value, schema, recordPaths, onChange, onValidityChange, readOnly }: {
  name: string;
  value: PropertyValue;
  schema?: JsonObject;
  recordPaths: string[];
  onChange: (value: PropertyValue) => void;
  onValidityChange: (valid: boolean) => void;
  readOnly: boolean;
}) {
  useLingui();
  if (value === null) return <div className="null-property"><span><Trans>Persisted null</Trans></span><button type="button" onClick={() => onChange(schemaInitialValue(schema))}><Trans>Set a value</Trans></button></div>;
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
    return <ComboboxInput
      label={t`${name} value`}
      listLabel={t`${name} note suggestions`}
      value={value}
      options={recordPaths}
      emptyMessage={t`No matching notes.`}
      spellCheck={false}
      onValueChange={onChange}
    />;
  }
  if (schema) {
    return <SchemaValueEditor name={`${name} value`} schema={schema} value={value} hideLabel onChange={onChange} onValidityChange={onValidityChange} />;
  }
  if (typeof value === "boolean") {
    return <label className="boolean-property"><input className="mdbase-checkbox" type="checkbox" checked={value} onChange={(event) => onChange(event.target.checked)} /><span>{value ? t`True` : t`False`}</span></label>;
  }
  if (typeof value === "number") {
    return <input aria-label={t`${name} value`} type="number" value={value} onChange={(event) => onChange(Number(event.target.value))} />;
  }
  if (typeof value === "string") {
    return <input aria-label={t`${name} value`} value={value} onChange={(event) => onChange(event.target.value)} />;
  }
  return <JsonValueEditor name={name} value={value} onChange={onChange} onValidityChange={onValidityChange} readOnly={readOnly} />;
}

function StringListEditor({ name, value, suggestions, onChange }: { name: string; value: string[]; suggestions: string[]; onChange: (value: unknown) => void }) {
  useLingui();
  return <div className="property-string-list" role="group" aria-label={name}>
    {value.map((item, index) => <div key={index}>
      <ComboboxInput
        label={t`${name} value item ${index + 1}`}
        listLabel={t`${name} item suggestions`}
        value={item}
        options={suggestions}
        emptyMessage={t`No matching notes.`}
        spellCheck={false}
        onValueChange={(next) => onChange(value.map((current, itemIndex) => itemIndex === index ? next : current))}
      />
      <InlineRemoveButton
        className="property-list-remove"
        label={t`Remove ${name} item ${index + 1}`}
        onClick={() => onChange(value.filter((_, itemIndex) => itemIndex !== index))}
      />
    </div>)}
    <button type="button" onClick={() => onChange([...value, ""])}><Plus aria-hidden="true" /> <Trans>Add </Trans>{name === "tags" ? t`tag` : t`item`}</button>
  </div>;
}

function JsonValueEditor({ name, value, onChange, onValidityChange, readOnly }: {
  name: string;
  value: PropertyValue;
  onChange: (value: PropertyValue) => void;
  onValidityChange: (valid: boolean) => void;
  readOnly: boolean;
}) {
  useLingui();
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [invalid, setInvalid] = useState(false);
  return <div className={`nested-property${invalid ? " invalid" : ""}`}>
    <CodeEditor value={text} label={t`${name} JSON value`} language="json" lineWrapping={false} readOnly={readOnly} onChange={(next) => {
      if (readOnly) return;
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

export function propertyValidationErrors(
  value: JsonObject,
  contract: PropertyContract,
  editorValidity: Record<string, boolean> = {},
  include: (name: string) => boolean = () => true
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const [name, propertyValue] of Object.entries(value)) {
    if (!include(name)) continue;
    const message = validateValue(contract.properties[name], propertyValue, name);
    if (message) errors[name] = message;
  }
  for (const name of contract.required) {
    if (include(name) && !(name in value)) errors[name] = t`This required property is missing.`;
  }
  for (const [name, valid] of Object.entries(editorValidity)) {
    if (include(name) && !valid) errors[name] = t`Fix the JSON value before saving.`;
  }
  return errors;
}

function validateValue(schema: JsonObject | undefined, value: unknown, path: string): string | undefined {
  if (!schema) return undefined;
  if (value === null) {
    const nullable = schema.type === "null" || (Array.isArray(schema.type) && schema.type.includes("null")) || (Array.isArray(schema.enum) && schema.enum.includes(null));
    return nullable ? undefined : t`${path} cannot be null.`;
  }
  if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    return t`Use the required value ${formatValue(schema.const)}.`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((choice) => JSON.stringify(choice) === JSON.stringify(value))) {
    return t`Choose one of the allowed values.`;
  }
  const declaredType = Array.isArray(schema.type) ? schema.type.find((item) => item !== "null") : schema.type;
  const type = declaredType
    ?? (isObject(schema.properties) || Array.isArray(schema.required) || "additionalProperties" in schema ? "object" : undefined)
    ?? (isObject(schema.items) ? "array" : undefined);
  if (type === "string") {
    if (typeof value !== "string") return t`Enter text.`;
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return t`Enter at least ${schema.minLength} characters.`;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return t`Enter no more than ${schema.maxLength} characters.`;
    if (typeof schema.pattern === "string") {
      try { if (!new RegExp(schema.pattern).test(value)) return t`This value does not match the required format.`; } catch { /* schema validation reports invalid patterns */ }
    }
  }
  if (type === "number" || type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) return t`Enter a number.`;
    if (type === "integer" && !Number.isInteger(value)) return t`Enter a whole number.`;
    if (typeof schema.minimum === "number" && value < schema.minimum) return t`Enter ${schema.minimum} or more.`;
    if (typeof schema.maximum === "number" && value > schema.maximum) return t`Enter ${schema.maximum} or less.`;
  }
  if (type === "boolean" && typeof value !== "boolean") return t`Choose true or false.`;
  if (type === "array") {
    if (!Array.isArray(value)) return t`Enter a list.`;
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return t`Add at least ${schema.minItems} items.`;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return t`Use no more than ${schema.maxItems} items.`;
    const itemSchema = isObject(schema.items) ? schema.items : undefined;
    for (let index = 0; index < value.length; index += 1) {
      const error = validateValue(itemSchema, value[index], `${path} item ${index + 1}`);
      if (error) return error;
    }
  }
  if (type === "object") {
    if (!isObject(value)) return t`Enter an object.`;
    const properties = isObject(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
    for (const name of required) {
      if (!(name in value)) return t`${name} is required.`;
    }
    const propertyNameSchema = isObject(schema.propertyNames) ? schema.propertyNames : undefined;
    const additionalSchema = isObject(schema.additionalProperties) ? schema.additionalProperties : undefined;
    for (const [name, childValue] of Object.entries(value)) {
      const nameError = validateValue(propertyNameSchema, name, `${path} key`);
      if (nameError) return nameError;
      const declaredSchema = isObject(properties[name]) ? properties[name] : undefined;
      if (!declaredSchema && schema.additionalProperties === false) return t`${name} is not an allowed property.`;
      const error = validateValue(declaredSchema ?? additionalSchema, childValue, `${path}.${name}`);
      if (error) return error;
    }
    const alternatives = Array.isArray(schema.anyOf) ? schema.anyOf.filter(isObject) : [];
    if (alternatives.length && !alternatives.some((alternative) => !validateValue(alternative, value, path))) {
      return t`Complete one of the allowed field combinations.`;
    }
    const exclusiveAlternatives = Array.isArray(schema.oneOf) ? schema.oneOf.filter(isObject) : [];
    if (exclusiveAlternatives.length && exclusiveAlternatives.filter((alternative) => !validateValue(alternative, value, path)).length !== 1) {
      return t`Complete exactly one of the allowed field combinations.`;
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
  if (!schema) return t`Custom`;
  if (Array.isArray(schema.enum)) return t`Choice`;
  if (schema.format === "date") return t`Date`;
  if (schema.format === "date-time") return t`Date & time`;
  if (isLinkSchema(schema)) return t`Record link`;
  const type = Array.isArray(schema.type) ? schema.type.filter((item) => item !== "null").join(" or ") : schema.type;
  if (type === "array") return t`List`;
  if (type === "boolean") return t`Boolean`;
  if (type === "integer") return t`Integer`;
  if (type === "number") return t`Number`;
  if (type === "object") return t`Object`;
  return t`Text`;
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
