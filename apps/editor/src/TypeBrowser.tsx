import { ArrowLeft, CircleAlert, FileCode2, FilePlus2, Info, PanelLeft, Plus, RotateCcw, Search, Trash2, X } from "lucide-react";
import type { CollectionTypeDescriptor } from "@mdbase/connect";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CodeEditor } from "./CodeEditor";
import type { NoteSummary, TypeDocument } from "./model";
import { compareLines } from "./text-diff";
import {
  addTypeField,
  readVisualType,
  removeTypeField,
  renameTypeField,
  setTypeFieldKind,
  setTypeFieldRequired,
  typeImpact,
  updateTypeIdentity,
  type TypeFieldDefinition,
  type TypeFieldKind,
  type TypeImpact,
  type VisualTypeDefinition
} from "./type-schema";

export const NEW_TYPE_SOURCE = `---
kind: mdbase.type
name: new-type
version: 1
description: Describe when this type should be used.
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    additionalProperties: true
    properties:
      title:
        type: string
---
`;

export function TypeList({ types, selectedName, leadingActions, trailingActions, onSelect, onCreate, onCollections }: {
  types: CollectionTypeDescriptor[];
  selectedName?: string;
  leadingActions?: ReactNode;
  trailingActions?: ReactNode;
  onSelect: (name: string) => void;
  onCreate: () => void;
  onCollections: () => void;
}) {
  const [search, setSearch] = useState("");
  const visible = types.filter((type) => `${type.name} ${type.description ?? ""}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  return <section className="type-list-pane" aria-label="Types">
    <header className="list-header">
      <button className="mobile-collections icon-button" aria-label="Collections" onClick={onCollections}><PanelLeft aria-hidden="true" /></button>
      {leadingActions}
      <div><h1>Types</h1><p>{types.length} {types.length === 1 ? "definition" : "definitions"}</p></div>
      <button className="icon-button new-type-button" aria-label="New type" title="New type" onClick={onCreate}><FilePlus2 aria-hidden="true" /></button>
      {trailingActions}
    </header>
    <label className="search-field">
      <Search aria-hidden="true" /><span className="sr-only">Search types</span>
      <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search types" />
      {search && <button aria-label="Clear type search" onClick={() => setSearch("")}><X aria-hidden="true" /></button>}
    </label>
    <div className="type-list" role="listbox" aria-label="Collection types">
      {visible.map((type) => <button key={type.name} role="option" aria-selected={selectedName === type.name} className={`type-row${selectedName === type.name ? " selected" : ""}`} onClick={() => onSelect(type.name)}>
        <FileCode2 aria-hidden="true" /><span><strong>{type.name}</strong><small>{type.description || `${propertyCount(type)} schema properties`}</small></span>
      </button>)}
      {!visible.length && <p className="quiet-empty">{types.length ? "No types found." : "This collection has no type definitions yet."}</p>}
    </div>
  </section>;
}

export function TypeInspector({ type, document, source, notes, creating, loading, saving, error, leadingActions, onSourceChange, onSave, onRevert, onCancel, onCreate, onBack }: {
  type?: CollectionTypeDescriptor;
  document?: TypeDocument;
  source: string;
  notes: NoteSummary[];
  creating: boolean;
  loading: boolean;
  saving: boolean;
  error?: string;
  leadingActions?: ReactNode;
  onSourceChange: (source: string) => void;
  onSave: () => void;
  onRevert: () => void;
  onCancel: () => void;
  onCreate: () => void;
  onBack: () => void;
}) {
  const [view, setView] = useState<"visual" | "yaml">("visual");
  const [reviewing, setReviewing] = useState(false);
  const [visualError, setVisualError] = useState<string>();
  const dirty = creating ? source.trim().length > 0 : Boolean(document && source !== document.document);
  const parsed = useMemo(() => parseVisualType(source), [source]);
  const impact = useMemo(() => parsed.value
    ? typeImpact(document?.document, source, notes, type?.name)
    : undefined, [document?.document, notes, parsed.value, source, type?.name]);
  useEffect(() => {
    setView("visual");
    setReviewing(false);
    setVisualError(undefined);
  }, [creating, document?.revision]);

  function changeSource(change: (current: string) => string) {
    try {
      onSourceChange(change(source));
      setVisualError(undefined);
      setReviewing(false);
    } catch (changeError) {
      setVisualError(changeError instanceof Error ? changeError.message : "That field could not be changed.");
    }
  }

  if (!creating && !type) return <main className="type-inspector empty-type">{leadingActions && <div className="empty-pane-actions">{leadingActions}</div>}<div><p>This collection has no type definitions.</p><button className="empty-type-create" onClick={onCreate}>Create the first type</button></div></main>;
  const name = creating ? "New type" : type!.name;
  const path = creating ? "A path will be created from the type name" : document?.path ?? type!.path ?? `_types/${type!.name}.md`;
  return <main className="type-inspector" aria-label={`${name} type definition`}>
    <header className="type-inspector-bar">
      <button className="mobile-back icon-button" aria-label="Back to types" onClick={onBack}><ArrowLeft aria-hidden="true" /></button>
      {leadingActions}
      <span>{path}</span>
      <small>{loading ? "Loading" : saving ? "Saving" : creating ? "New" : dirty ? "Unsaved" : "Saved"}</small>
    </header>
    <section className="type-heading">
      <p className="eyebrow">{creating ? "Create type" : "Type definition"}</p>
      <h1>{name}</h1>
      {creating ? <p>Give the type a unique name and describe its fields in JSON Schema.</p> : type!.description && <p>{type!.description}</p>}
      {!creating && <dl>
        <div><dt>Version</dt><dd>{type!.version ?? "Unversioned"}</dd></div>
        <div><dt>Properties</dt><dd>{propertyCount(type!)}</dd></div>
        <div><dt>Extensions</dt><dd>{Object.keys(type!.extensions).length}</dd></div>
      </dl>}
    </section>
    <section className="type-source">
      <div className="type-source-context">
        <div><h2>Definition</h2><p>Edit common fields visually or work with the complete YAML source. Changes are reviewed before they replace the current definition.</p></div>
        <div className="type-view-switch" role="group" aria-label="Type editor view">
          <button className={view === "visual" ? "selected" : ""} aria-pressed={view === "visual"} onClick={() => { setView("visual"); setReviewing(false); }}>Fields</button>
          <button className={view === "yaml" ? "selected" : ""} aria-pressed={view === "yaml"} onClick={() => { setView("yaml"); setReviewing(false); }}>YAML</button>
        </div>
        <div className="type-compatibility-warning" role="note">
          <Info aria-hidden="true" />
          <p><strong>Collection-wide change</strong>Review checks existing notes before saving. Connected apps may also rely on this type’s current shape.</p>
        </div>
        {(error || visualError || parsed.error) && <p className="type-editor-error" role="alert">{error || visualError || parsed.error}</p>}
        <div className="type-editor-actions">
          <button onClick={creating ? onCancel : onRevert} disabled={saving || (!creating && !dirty)}><RotateCcw aria-hidden="true" />{creating ? "Cancel" : "Revert"}</button>
          <button className="save-type-button" onClick={() => setReviewing(true)} disabled={loading || saving || !dirty || !parsed.value}>{saving ? "Saving…" : "Review changes"}</button>
        </div>
      </div>
      {loading ? <div className="type-source-loading" aria-label="Loading type definition"><span /><span /><span /></div>
        : reviewing && impact ? <TypeChangeReview
          previousSource={document?.document}
          source={source}
          impact={impact}
          creating={creating}
          saving={saving}
          onBack={() => setReviewing(false)}
          onConfirm={onSave}
        />
          : view === "visual" && parsed.value ? <VisualTypeEditor definition={parsed.value} onChange={changeSource} />
            : view === "visual" ? <div className="visual-type-unavailable"><CircleAlert aria-hidden="true" /><p>Fix the YAML source before returning to the field editor.</p><button onClick={() => setView("yaml")}>Open YAML</button></div>
              : <CodeEditor
                key={`${document?.path ?? "new-type"}:yaml`}
                value={source}
                onChange={(next) => { onSourceChange(next); setVisualError(undefined); setReviewing(false); }}
                label={`${name} type YAML`}
                language="yaml"
                lineWrapping={false}
                autoFocus={creating}
              />}
    </section>
  </main>;
}

function VisualTypeEditor({ definition, onChange }: {
  definition: VisualTypeDefinition;
  onChange: (change: (source: string) => string) => void;
}) {
  return <div className="visual-type-editor">
    <div className="visual-type-basics">
      <label><span>Name</span><input value={definition.name} onChange={(event) => onChange((source) => updateTypeIdentity(source, "name", event.target.value))} spellCheck="false" /></label>
      <label><span>Description</span><input value={definition.description} onChange={(event) => onChange((source) => updateTypeIdentity(source, "description", event.target.value))} /></label>
    </div>
    <div className="visual-type-fields-heading"><div><h3>Fields</h3><p>Required fields must be present on every matching note.</p></div><button onClick={() => onChange(addTypeField)}><Plus aria-hidden="true" />Add field</button></div>
    <div className="visual-type-fields">
      {definition.fields.map((field) => <VisualFieldRow key={field.name} field={field} onChange={onChange} />)}
      {!definition.fields.length && <p className="quiet-empty">No fields are declared yet.</p>}
    </div>
    <p className="visual-type-footnote">Advanced constraints remain in the YAML source. Changing an advanced field’s kind replaces its structural constraints.</p>
  </div>;
}

function VisualFieldRow({ field, onChange }: {
  field: TypeFieldDefinition;
  onChange: (change: (source: string) => string) => void;
}) {
  return <div className="visual-field-row">
    <label><span className="sr-only">Field name</span><input defaultValue={field.name} onBlur={(event) => onChange((source) => renameTypeField(source, field.name, event.target.value))} spellCheck="false" /></label>
    <label><span className="sr-only">{field.name} field kind</span><select value={field.kind} onChange={(event) => {
      const kind = event.target.value as TypeFieldKind;
      if (kind !== "advanced") onChange((source) => setTypeFieldKind(source, field.name, kind));
    }}>
      {field.kind === "advanced" && <option value="advanced">Advanced</option>}
      <option value="string">Text</option>
      <option value="number">Number</option>
      <option value="integer">Integer</option>
      <option value="boolean">Checkbox</option>
      <option value="string-list">Text list</option>
      <option value="date">Date</option>
      <option value="datetime">Date and time</option>
      <option value="object">Object</option>
    </select></label>
    <label className="visual-field-required"><input type="checkbox" checked={field.required} onChange={(event) => onChange((source) => setTypeFieldRequired(source, field.name, event.target.checked))} /><span>Required</span></label>
    <button className="icon-button" aria-label={`Remove ${field.name} field`} title={`Remove ${field.name} field`} onClick={() => onChange((source) => removeTypeField(source, field.name))}><Trash2 aria-hidden="true" /></button>
  </div>;
}

function TypeChangeReview({ previousSource, source, impact, creating, saving, onBack, onConfirm }: {
  previousSource?: string;
  source: string;
  impact: TypeImpact;
  creating: boolean;
  saving: boolean;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const diff = compareLines(previousSource ?? "", source);
  const changeCount = impact.addedFields.length + impact.removedFields.length + impact.changedFields.length + impact.newlyRequired.length;
  return <div className="type-change-review">
    <p className="eyebrow">Review changes</p>
    <h2>{creating ? "Create this type?" : "Update this type?"}</h2>
    <p>{changeCount ? `${changeCount} field-level ${changeCount === 1 ? "change" : "changes"} detected.` : "The source changed without altering the common field shape."}</p>
    <dl>
      <div><dt>Matching notes</dt><dd>{impact.affectedNotes.toLocaleString()}</dd></div>
      <div><dt>Fields added</dt><dd>{impact.addedFields.length}</dd></div>
      <div><dt>Fields removed</dt><dd>{impact.removedFields.length}</dd></div>
      <div><dt>Kinds changed</dt><dd>{impact.changedFields.length}</dd></div>
    </dl>
    {impact.missingRequired.length > 0 && <div className="type-impact-warning" role="alert">
      <CircleAlert aria-hidden="true" />
      <div><strong>Existing notes need attention</strong>{impact.missingRequired.map((item) => <p key={item.field}>{item.count.toLocaleString()} {item.count === 1 ? "note is" : "notes are"} missing required field <code>{item.field}</code>.</p>)}</div>
    </div>}
    <p className="type-review-scope">Impact is based on the currently indexed notes. The collection validates the complete definition when you confirm.</p>
    <details><summary>Review YAML diff</summary><div className="line-diff" role="table" aria-label="Type source differences">{diff.map((line, index) => <div className={`diff-line ${line.kind}`} role="row" key={`${line.kind}:${index}`}><span className="diff-marker" aria-hidden="true">{line.kind === "local" ? "−" : line.kind === "remote" ? "+" : line.kind === "omitted" ? "···" : " "}</span><span className="diff-line-number" aria-hidden="true">{line.localLine ?? line.remoteLine ?? ""}</span><code role="cell">{line.text || " "}</code></div>)}</div></details>
    <div className="type-review-actions"><button onClick={onBack}>Back to editing</button><button className="confirm-type-button" disabled={saving} onClick={onConfirm}>{saving ? "Saving…" : creating ? "Create type" : "Confirm update"}</button></div>
  </div>;
}

function parseVisualType(source: string): { value?: VisualTypeDefinition; error?: string } {
  try {
    return { value: readVisualType(source) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "The YAML source could not be read." };
  }
}

function propertyCount(type: CollectionTypeDescriptor): number {
  const properties = type.schema.properties;
  return properties && !Array.isArray(properties) && typeof properties === "object" ? Object.keys(properties).length : 0;
}
