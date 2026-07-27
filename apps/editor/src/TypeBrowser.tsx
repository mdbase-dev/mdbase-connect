import { ArrowLeft, ChevronDown, ChevronRight, CircleAlert, FileCode2, FilePlus2, Info, PanelLeft, Plus, RotateCcw, Search, Trash2, X } from "lucide-react";
import type { CollectionTypeDescriptor } from "@mdbase/connect";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { CodeEditor } from "./CodeEditor";
import type { NoteSummary, TypeDocument } from "./model";
import { compareLines } from "./text-diff";
import {
  addTypeField,
  readVisualType,
  removeTypeField,
  renameTypeField,
  setTypeFieldChoices,
  setTypeFieldConstraint,
  setTypeFieldDescription,
  setTypeFieldKind,
  setTypeFieldRequired,
  setTypeListItemKind,
  typeFieldConversionImpact,
  typeFieldPathLabel,
  typeImpact,
  updateTypeFieldsPresent,
  updateTypeIdentity,
  updateTypePathGlobs,
  type TypeFieldDefinition,
  type TypeFieldKind,
  type TypeImpact,
  type TypeSchemaNode,
  type VisualTypeDefinition
} from "./type-schema";

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
      {reviewing ? <div className="type-source-context reviewing">
        <div className="type-source-intro"><h2>Review changes</h2><p>Confirm the collection-wide effect before saving.</p></div>
      </div> : <div className="type-source-context">
          <div className="type-source-intro"><h2>Definition</h2><p>Design the note shape or work with its complete YAML source.</p></div>
          <div className="type-view-switch" role="group" aria-label="Type editor view">
            <button className={view === "visual" ? "selected" : ""} aria-pressed={view === "visual"} onClick={() => { setView("visual"); setReviewing(false); }}>Design</button>
            <button className={view === "yaml" ? "selected" : ""} aria-pressed={view === "yaml"} onClick={() => { setView("yaml"); setReviewing(false); }}>YAML</button>
          </div>
          <div className="type-editor-actions">
            <span className="type-change-scope">Collection-wide change</span>
            <button className="type-secondary-action" onClick={creating ? onCancel : onRevert} disabled={saving || (!creating && !dirty)}><RotateCcw aria-hidden="true" />{creating ? "Cancel" : "Revert"}</button>
            <button className="save-type-button" onClick={() => setReviewing(true)} disabled={loading || saving || !dirty || !parsed.value}>{saving ? "Saving…" : "Review changes"}</button>
          </div>
        </div>
      }
      {(error || visualError || parsed.error) && <p className="type-editor-error" role="alert">{error || visualError || parsed.error}</p>}
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
          : view === "visual" && parsed.value ? <VisualTypeEditor
            definition={parsed.value}
            source={source}
            impact={impact}
            onChange={changeSource}
            onOpenYaml={() => setView("yaml")}
          />
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

function VisualTypeEditor({ definition, source, impact, onChange, onOpenYaml }: {
  definition: VisualTypeDefinition;
  source: string;
  impact?: TypeImpact;
  onChange: (change: (source: string) => string) => void;
  onOpenYaml: () => void;
}) {
  return <div className="visual-type-editor">
    <section className="visual-type-section visual-type-basics">
      <div className="visual-section-heading"><div><h3>Identity</h3><p>The stable name used by records and connected apps.</p></div></div>
      <div className="visual-type-basics-fields">
        <label><span>Name</span><input value={definition.name} onChange={(event) => onChange((source) => updateTypeIdentity(source, "name", event.target.value))} spellCheck="false" /></label>
        <label><span>Description</span><input value={definition.description} onChange={(event) => onChange((source) => updateTypeIdentity(source, "description", event.target.value))} /></label>
      </div>
    </section>
    <section className="visual-type-section type-match-section">
      <div className="visual-section-heading">
        <div><h3>Type membership</h3><p>{impact?.affectedNotes.toLocaleString() ?? "No"} currently indexed {impact?.affectedNotes === 1 ? "note resolves" : "notes resolve"} to this type.</p></div>
      </div>
      <div className="type-membership-guide">
        <Info aria-hidden="true" />
        <div>
          <strong>Explicit membership comes first.</strong>
          <p>A record may name this type using the collection’s configured type keys, normally <code>type</code> or <code>types</code>. When it does, inferred rules are skipped.</p>
          <p>Without an explicit declaration, every inferred rule below must match. More than one type may match the same record.</p>
        </div>
      </div>
      <div className="type-match-rules">
        <StringListEditor
          label="Path patterns"
          values={definition.pathGlobs}
          itemLabel="Path pattern"
          addLabel="Add path pattern"
          placeholder="Journal/**/*.md"
          helper="Any one pattern may match the collection-relative record path."
          onChange={(values) => onChange((source) => updateTypePathGlobs(source, values))}
        />
        <StringListEditor
          label="Fields that must be present"
          values={definition.fieldsPresent}
          itemLabel="Required match field"
          addLabel="Add field selector"
          placeholder="status"
          helper="Every selector must resolve to a persisted, non-null frontmatter value."
          onChange={(values) => onChange((source) => updateTypeFieldsPresent(source, values))}
        />
      </div>
      {!definition.pathGlobs.length && !definition.fieldsPresent.length && !definition.advancedMatchKeys.length
        && <p className="type-explicit-only">No inferred rules. Records must declare this type explicitly.</p>}
      {definition.advancedMatch && <div className="advanced-match-note">
        <Info aria-hidden="true" />
        <div><strong>More inferred rules in YAML</strong><p>{definition.advancedMatchKeys.map(matchRuleLabel).join(" · ")}. These rules combine with the visual rules above.</p></div>
        <button onClick={onOpenYaml}>Open YAML</button>
      </div>}
    </section>
    <section className="visual-type-section">
      <div className="visual-type-fields-heading"><div><h3>Fields</h3><p>Objects and lists can contain fields at any depth.</p></div><button onClick={() => onChange((current) => addTypeField(current))}><Plus aria-hidden="true" />Add field</button></div>
      <div className="visual-field-columns" aria-hidden="true"><span>Field</span><span>Kind</span><span>Required</span><span /></div>
    </section>
    <div className="visual-type-fields">
      {definition.fields.map((field) => <VisualFieldRow key={typeFieldPathLabel(field.path)} field={field} source={source} depth={0} onChange={onChange} />)}
      {!definition.fields.length && <p className="quiet-empty">No fields are declared yet.</p>}
    </div>
    <p className="visual-type-footnote">Advanced JSON Schema rules remain intact and are identified in place. Review any structural conversion before applying it.</p>
  </div>;
}

function VisualFieldRow({ field, source, depth, onChange }: {
  field: TypeFieldDefinition;
  source: string;
  depth: number;
  onChange: (change: (source: string) => string) => void;
}) {
  const [expanded, setExpanded] = useState(field.kind === "object" || field.kind === "array");
  const [pendingKind, setPendingKind] = useState<Exclude<TypeFieldKind, "advanced">>();
  const conversionImpact = pendingKind ? typeFieldConversionImpact(source, field.path, pendingKind) : [];
  const fieldLabel = typeFieldPathLabel(field.path);
  function chooseKind(kind: TypeFieldKind) {
    if (kind === "advanced" || kind === field.kind) return;
    const nextKind = kind as Exclude<TypeFieldKind, "advanced">;
    if (typeFieldConversionImpact(source, field.path, nextKind).length) {
      setPendingKind(nextKind);
      setExpanded(true);
    } else {
      onChange((current) => setTypeFieldKind(current, field.path, nextKind));
      if (nextKind === "object" || nextKind === "array") setExpanded(true);
    }
  }
  return <div className="visual-field-branch" style={{ "--field-depth": depth } as CSSProperties}>
    <div className="visual-field-row">
      <button className="field-disclosure" aria-label={`${expanded ? "Collapse" : "Expand"} ${fieldLabel} field`} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
      </button>
      <label className="visual-field-name"><span className="sr-only">Field name</span><input defaultValue={field.name} onBlur={(event) => onChange((current) => renameTypeField(current, field.path, event.target.value))} spellCheck="false" /></label>
      <label className="visual-field-kind"><span className="sr-only">{fieldLabel} field kind</span><select value={field.kind} onChange={(event) => chooseKind(event.target.value as TypeFieldKind)}>
        <KindOptions current={field.kind} />
      </select></label>
      <label className="visual-field-required"><input type="checkbox" checked={field.required} onChange={(event) => onChange((current) => setTypeFieldRequired(current, field.path, event.target.checked))} /><span>Required</span></label>
      <button className="icon-button remove-type-field" aria-label={`Remove ${fieldLabel} field`} title={`Remove ${fieldLabel} field`} onClick={() => onChange((current) => removeTypeField(current, field.path))}><Trash2 aria-hidden="true" /></button>
    </div>
    {expanded && <div className="visual-field-details">
      <div className="field-path"><span>{fieldLabel}</span>{field.advancedKeys.length > 0 && <strong>Advanced YAML rules</strong>}</div>
      {pendingKind && <div className="field-conversion-warning" role="alert">
        <CircleAlert aria-hidden="true" />
        <div><strong>Convert this field to {kindLabel(pendingKind)}?</strong><p>{conversionImpact.length ? `This removes ${formatList(conversionImpact)}.` : "Its current structural rules will be replaced."}</p></div>
        <button onClick={() => setPendingKind(undefined)}>Cancel</button>
        <button className="confirm-field-conversion" onClick={() => {
          onChange((current) => setTypeFieldKind(current, field.path, pendingKind));
          setPendingKind(undefined);
        }}>Convert field</button>
      </div>}
      <label className="field-description"><span>Description</span><input aria-label={`${fieldLabel} description`} value={field.description ?? ""} placeholder="What belongs in this field?" onChange={(event) => onChange((current) => setTypeFieldDescription(current, field.path, event.target.value))} /></label>
      <FieldConstraints field={field} onChange={onChange} />
      {field.kind === "object" && <ObjectFields node={field} source={source} depth={depth + 1} onChange={onChange} />}
      {field.kind === "array" && field.item && <ListItemEditor item={field.item} source={source} depth={depth + 1} onChange={onChange} />}
    </div>}
  </div>;
}

function ObjectFields({ node, source, depth, onChange }: {
  node: TypeSchemaNode;
  source: string;
  depth: number;
  onChange: (change: (source: string) => string) => void;
}) {
  return <div className="nested-field-group">
    <div className="nested-field-heading"><div><strong>Nested fields</strong><span>{node.constraints.additionalProperties === false ? "Only declared fields are allowed" : "Other fields are allowed"}</span></div><button onClick={() => onChange((current) => addTypeField(current, node.path))}><Plus aria-hidden="true" />Add nested field</button></div>
    {node.fields.map((field) => <VisualFieldRow key={typeFieldPathLabel(field.path)} field={field} source={source} depth={depth} onChange={onChange} />)}
    {!node.fields.length && <p className="nested-field-empty">No nested fields yet.</p>}
  </div>;
}

function ListItemEditor({ item, source, depth, onChange }: {
  item: TypeSchemaNode;
  source: string;
  depth: number;
  onChange: (change: (source: string) => string) => void;
}) {
  const [pendingKind, setPendingKind] = useState<Exclude<TypeFieldKind, "advanced">>();
  const itemLabel = typeFieldPathLabel(item.path);
  const impact = pendingKind ? typeFieldConversionImpact(source, item.path, pendingKind) : [];
  return <div className="list-item-editor">
    <div className="list-item-heading">
      <div><strong>List items</strong><span>{itemLabel}</span></div>
      <label><span className="sr-only">{itemLabel} kind</span><select value={item.kind} onChange={(event) => {
        const kind = event.target.value as TypeFieldKind;
        if (kind === "advanced" || kind === item.kind) return;
        const nextKind = kind as Exclude<TypeFieldKind, "advanced">;
        if (typeFieldConversionImpact(source, item.path, nextKind).length) setPendingKind(nextKind);
        else onChange((current) => setTypeListItemKind(current, item.path.slice(0, -1), nextKind));
      }}><KindOptions current={item.kind} /></select></label>
    </div>
    {pendingKind && <div className="field-conversion-warning" role="alert">
      <CircleAlert aria-hidden="true" />
      <div><strong>Convert list items to {kindLabel(pendingKind)}?</strong><p>{impact.length ? `This removes ${formatList(impact)}.` : "Their current structural rules will be replaced."}</p></div>
      <button onClick={() => setPendingKind(undefined)}>Cancel</button>
      <button className="confirm-field-conversion" onClick={() => {
        onChange((current) => setTypeListItemKind(current, item.path.slice(0, -1), pendingKind));
        setPendingKind(undefined);
      }}>Convert items</button>
    </div>}
    {item.kind === "object" && <ObjectFields node={item} source={source} depth={depth} onChange={onChange} />}
    {item.kind === "array" && item.item && <ListItemEditor item={item.item} source={source} depth={depth + 1} onChange={onChange} />}
    {item.advancedKeys.length > 0 && <p className="advanced-item-note">Additional item rules remain in YAML.</p>}
  </div>;
}

function KindOptions({ current }: { current: TypeFieldKind }) {
  return <>
    {current === "advanced" && <option value="advanced">Advanced</option>}
    <option value="string">Text</option>
    <option value="number">Number</option>
    <option value="integer">Integer</option>
    <option value="boolean">Checkbox</option>
    <option value="array">List</option>
    <option value="date">Date</option>
    <option value="datetime">Date and time</option>
    <option value="object">Object</option>
  </>;
}

function StringListEditor({ label, values, itemLabel, addLabel, placeholder, helper, onChange }: {
  label: string;
  values: string[];
  itemLabel: string;
  addLabel: string;
  placeholder?: string;
  helper?: string;
  onChange: (values: string[]) => void;
}) {
  const valuesKey = JSON.stringify(values);
  const [drafts, setDrafts] = useState(values);
  const [dirty, setDirty] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const skipBlur = useRef(false);
  const focusLast = useRef(false);

  useEffect(() => {
    const currentKey = JSON.stringify(normalizedListStrings(drafts));
    if (!dirty || currentKey !== valuesKey) {
      setDrafts(values);
      setDirty(false);
    }
  }, [valuesKey]);

  useEffect(() => {
    if (!focusLast.current) return;
    const inputs = list.current?.querySelectorAll("input");
    inputs?.item(inputs.length - 1).focus();
    focusLast.current = false;
  }, [drafts]);

  function commit(next: string[], append = false) {
    const normalized = normalizedListStrings(next);
    onChange(normalized);
    setDrafts(append ? [...normalized, ""] : normalized);
    setDirty(append);
    focusLast.current = append;
  }

  function addItem() {
    if (drafts.at(-1) === "") {
      const inputs = list.current?.querySelectorAll("input");
      inputs?.item(inputs.length - 1).focus();
      return;
    }
    focusLast.current = true;
    setDrafts([...drafts, ""]);
    setDirty(true);
  }

  return <div className="string-list-editor">
    <div className="string-list-heading"><span>{label}</span><button onClick={addItem}><Plus aria-hidden="true" />{addLabel}</button></div>
    {helper && <small>{helper}</small>}
    <div className="string-list-items" ref={list}>
      {drafts.map((value, index) => <div className="string-list-item" key={index}>
        <span aria-hidden="true">{index + 1}</span>
        <label><span className="sr-only">{itemLabel} {index + 1}</span><input
          value={value}
          placeholder={placeholder}
          spellCheck="false"
          onChange={(event) => {
            setDrafts((current) => current.map((item, itemIndex) => itemIndex === index ? event.target.value : item));
            setDirty(true);
          }}
          onBlur={() => {
            if (skipBlur.current) {
              skipBlur.current = false;
              return;
            }
            commit(drafts);
          }}
          onPaste={(event) => {
            const pasted = event.clipboardData.getData("text");
            if (!/[\r\n]/.test(pasted)) return;
            event.preventDefault();
            const pastedItems = pasted.split(/\r?\n/).filter(Boolean);
            commit([...drafts.slice(0, index), ...pastedItems, ...drafts.slice(index + 1)]);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || !event.currentTarget.value.trim()) return;
            event.preventDefault();
            skipBlur.current = true;
            commit(drafts, true);
          }}
        /></label>
        <button className="string-list-remove" aria-label={`Remove ${itemLabel.toLocaleLowerCase()} ${index + 1}`} onMouseDown={(event) => event.preventDefault()} onClick={() => commit(drafts.filter((_, itemIndex) => itemIndex !== index))}><Trash2 aria-hidden="true" /></button>
      </div>)}
      {!drafts.length && <p>No entries.</p>}
    </div>
  </div>;
}

function FieldConstraints({ field, onChange }: {
  field: TypeFieldDefinition;
  onChange: (change: (source: string) => string) => void;
}) {
  const controls: ReactNode[] = [];
  const constraint = (key: string, label: string, value?: number) => controls.push(<label key={key}><span>{label}</span><input
    key={`${key}:${value ?? ""}`}
    type="number"
    defaultValue={value}
    min="0"
    onBlur={(event) => onChange((current) => setTypeFieldConstraint(current, field.path, key, event.target.value === "" ? undefined : Number(event.target.value)))}
  /></label>);
  if (field.kind === "string") {
    constraint("minLength", "Minimum length", field.constraints.minLength);
    constraint("maxLength", "Maximum length", field.constraints.maxLength);
    controls.push(<label key="pattern"><span>Pattern</span><input value={field.constraints.pattern ?? ""} placeholder="Optional regular expression" onChange={(event) => onChange((current) => setTypeFieldConstraint(current, field.path, "pattern", event.target.value || undefined))} /></label>);
    controls.push(<div className="field-choices" key="choices"><StringListEditor
      label="Choices"
      values={field.constraints.choices ?? []}
      itemLabel={`${typeFieldPathLabel(field.path)} choice`}
      addLabel="Add choice"
      placeholder="Choice value"
      helper="Saved values must equal one of these strings."
      onChange={(values) => onChange((current) => setTypeFieldChoices(current, field.path, values))}
    /></div>);
  }
  if (field.kind === "number" || field.kind === "integer") {
    controls.push(<label key="minimum"><span>Minimum</span><input key={`minimum:${field.constraints.minimum ?? ""}`} type="number" defaultValue={field.constraints.minimum} onBlur={(event) => onChange((current) => setTypeFieldConstraint(current, field.path, "minimum", event.target.value === "" ? undefined : Number(event.target.value)))} /></label>);
    controls.push(<label key="maximum"><span>Maximum</span><input key={`maximum:${field.constraints.maximum ?? ""}`} type="number" defaultValue={field.constraints.maximum} onBlur={(event) => onChange((current) => setTypeFieldConstraint(current, field.path, "maximum", event.target.value === "" ? undefined : Number(event.target.value)))} /></label>);
  }
  if (field.kind === "array") {
    constraint("minItems", "Minimum items", field.constraints.minItems);
    constraint("maxItems", "Maximum items", field.constraints.maxItems);
    controls.push(<label className="field-toggle" key="uniqueItems"><input type="checkbox" checked={field.constraints.uniqueItems === true} onChange={(event) => onChange((current) => setTypeFieldConstraint(current, field.path, "uniqueItems", event.target.checked || undefined))} /><span>Require unique items</span></label>);
  }
  if (field.kind === "object") {
    controls.push(<label className="field-toggle" key="additionalProperties"><input type="checkbox" checked={field.constraints.additionalProperties !== false} onChange={(event) => onChange((current) => setTypeFieldConstraint(current, field.path, "additionalProperties", event.target.checked))} /><span>Allow undeclared fields</span></label>);
  }
  if (!controls.length) return null;
  return <div className="field-constraint-grid">{controls}</div>;
}

function normalizedListStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function matchRuleLabel(key: string): string {
  if (key === "where") return "Structured frontmatter conditions";
  if (key === "expr") return "CEL expression";
  if (key === "path_glob") return "Path patterns with an unsupported value";
  if (key === "fields_present") return "Field selectors with an unsupported value";
  return key;
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
    <p>{changeCount ? `${changeCount} field-level ${changeCount === 1 ? "change" : "changes"} detected.` : "The source changed without altering declared fields."}</p>
    <dl>
      <div><dt>Matching notes</dt><dd>{impact.affectedNotes.toLocaleString()}</dd></div>
      <div><dt>Fields added</dt><dd>{impact.addedFields.length}</dd></div>
      <div><dt>Fields removed</dt><dd>{impact.removedFields.length}</dd></div>
      <div><dt>Fields changed</dt><dd>{impact.changedFields.length}</dd></div>
    </dl>
    {impact.definitionChanges.length > 0 && <div className="type-definition-changes"><strong>Definition changes</strong><p>{impact.definitionChanges.join(" · ")}</p></div>}
    {impact.missingRequired.length > 0 && <div className="type-impact-warning" role="alert">
      <CircleAlert aria-hidden="true" />
      <div><strong>Existing notes need attention</strong>{impact.missingRequired.map((item) => <p key={item.field}>{item.count.toLocaleString()} {item.count === 1 ? "note is" : "notes are"} missing required field <code>{item.field}</code>.</p>)}</div>
    </div>}
    <p className="type-review-scope">Impact is based on the currently indexed notes. The collection validates the complete definition when you confirm.</p>
    <details><summary>Review YAML diff</summary><div className="line-diff" role="table" aria-label="Type source differences">{diff.map((line, index) => <div className={`diff-line ${line.kind}`} role="row" key={`${line.kind}:${index}`}><span className="diff-marker" aria-hidden="true">{line.kind === "local" ? "−" : line.kind === "remote" ? "+" : line.kind === "omitted" ? "···" : " "}</span><span className="diff-line-number" aria-hidden="true">{line.localLine ?? line.remoteLine ?? ""}</span><code role="cell">{line.text || " "}</code></div>)}</div></details>
    <div className="type-review-actions"><button onClick={onBack}>Back to editing</button><button className="confirm-type-button" disabled={saving} onClick={onConfirm}>{saving ? "Saving…" : creating ? "Create type" : "Confirm update"}</button></div>
  </div>;
}

function kindLabel(kind: Exclude<TypeFieldKind, "advanced">): string {
  const labels: Record<Exclude<TypeFieldKind, "advanced">, string> = {
    string: "text",
    number: "number",
    integer: "integer",
    boolean: "checkbox",
    array: "a list",
    object: "an object",
    date: "a date",
    datetime: "a date and time"
  };
  return labels[kind];
}

function formatList(values: string[]): string {
  if (values.length <= 1) return values[0] ?? "the current rules";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
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
