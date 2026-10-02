import { useState } from "react";
import { Select } from "@mdbase-dev/ui/select";
import { SchemaValueEditor } from "./SchemaValueEditor";
import { propertyValidationErrors } from "./StructuredPropertiesEditor";
import type { BulkField, BulkPropertyChange } from "./bulk-note-actions";

/** A small inline continuation of selection actions, not another modal workspace. */
export function BulkNoteProperties({ kind, fields, busy, onApply, onClose }: {
  kind: BulkPropertyChange["kind"];
  fields: BulkField[];
  busy: boolean;
  onApply: (change: BulkPropertyChange) => Promise<void>;
  onClose: () => void;
}) {
  const [fieldName, setFieldName] = useState(fields.find((field) => field.shared)?.name ?? "");
  const [value, setValue] = useState<unknown>();
  const [tag, setTag] = useState("");
  const [valid, setValid] = useState(true);
  const field = fields.find((field) => field.name === fieldName);
  const error = field && value !== undefined ? Object.values(propertyValidationErrors({ [fieldName]: value }, { properties: { [fieldName]: field.schema }, required: [] }))[0] : undefined;
  const canApply = kind === "property" ? field?.shared && value !== undefined && valid && !error : Boolean(tag.replace(/^#/, "").trim());
  return <form className="bulk-properties" aria-label={kind === "property" ? "Set property" : kind === "add-tag" ? "Add tag" : "Remove tag"} onSubmit={(event) => {
    event.preventDefault();
    if (!canApply || busy) return;
    void onApply(kind === "property" ? { kind, field: fieldName, value } : { kind, tag }).then(onClose);
  }}>
    {kind === "property" ? <>
      <label>Property<Select aria-label="Property" value={fieldName} disabled={busy} options={fields.map((field) => ({ value: field.name, label: field.shared ? field.name : `${field.name} (not shared)`, disabled: !field.shared }))} onChange={(name) => { setFieldName(name); setValue(undefined); setValid(true); }} /></label>
      {field?.shared && <SchemaValueEditor key={fieldName} name={fieldName} schema={field.schema} rootSchema={field.rootSchema} value={value} onChange={setValue} onValidityChange={setValid} />}
      <p>{error ?? "Only properties declared by every selected note’s type can be set."}</p>
    </> : <label>{kind === "add-tag" ? "Add tag" : "Remove tag"}<input aria-label="Tag" value={tag} disabled={busy} onChange={(event) => setTag(event.target.value)} autoFocus /></label>}
    <div className="bulk-property-actions"><button className="mdbase-button is-tertiary" type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="mdbase-button is-primary" disabled={busy || !canApply}>{busy ? "Applying…" : "Apply"}</button></div>
  </form>;
}
