import {
  ArrowCounterClockwiseIcon as RotateCcw,
  ArrowLeftIcon as ArrowLeft,
  CaretDownIcon as ChevronDown,
  CaretRightIcon as ChevronRight,
  FileCodeIcon as FileCode2,
  FilePlusIcon as FilePlus2,
  InfoIcon as Info,
  MagnifyingGlassIcon as Search,
  PlusIcon as Plus,
  SidebarSimpleIcon as PanelLeft,
  TrashIcon as Trash2,
  WarningCircleIcon as CircleAlert,
  XIcon as X
} from "./icons";
import type { CollectionTypeDescriptor } from "@mdbase/connect";
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { CodeEditor } from "./CodeEditor";
import type { NoteSummary, TypeDocument } from "./model";
import {
  collectionTypeIcon,
  isPhosphorIconName,
  normalizePhosphorIconName,
  PHOSPHOR_ICON_NAMES,
  PhosphorIcon
} from "./PhosphorIcon";
import { compareLines } from "./text-diff";
import {
  addTypeField,
  addTypeLinkRule,
  addTypeReadDefault,
  addTypeUniqueRule,
  readVisualType,
  removeTypeLinkRule,
  removeTypeReadDefault,
  removeTypeField,
  removeTypeUniqueRule,
  renameTypeLinkRule,
  renameTypeReadDefault,
  renameTypeField,
  setTypeLinkRule,
  setTypeLinkTargets,
  setTypeReadDefault,
  setTypeFieldChoices,
  setTypeFieldConstraint,
  setTypeFieldDescription,
  setTypeFieldKind,
  setTypeFieldRequired,
  setTypeListItemKind,
  setTypeUniqueRule,
  typeFieldConversionImpact,
  typeFieldPathLabel,
  typeImpact,
  updateTypeFieldsPresent,
  updateTypeCollectionDisplay,
  updateTypeIdentity,
  updateTypePathPolicy,
  updateTypePathGlobs,
  type TypeFieldDefinition,
  type TypeFieldKind,
  type TypeImpact,
  type TypeLinkFormat,
  type TypeSchemaNode,
  type TypeUniqueScope,
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
        <span className="type-row-icon">{isPhosphorIconName(collectionTypeIcon(type))
          ? <PhosphorIcon name={collectionTypeIcon(type)} aria-hidden="true" />
          : <FileCode2 aria-hidden="true" />}</span>
        <span className="type-row-copy"><strong>{type.name}</strong><small>{type.description || `${propertyCount(type)} schema properties`}</small></span>
      </button>)}
      {!visible.length && <p className="quiet-empty">{types.length ? "No types found." : "This collection has no type definitions yet."}</p>}
    </div>
  </section>;
}

export function TypeInspector({ type, availableTypes = [], document, source, notes, creating, loading, saving, error, leadingActions, onSourceChange, onSave, onRevert, onCancel, onCreate, onBack }: {
  type?: CollectionTypeDescriptor;
  availableTypes?: CollectionTypeDescriptor[];
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
      <div className="type-heading-title">
        {!creating && isPhosphorIconName(collectionTypeIcon(type)) && <PhosphorIcon name={collectionTypeIcon(type)} aria-hidden="true" />}
        <h1>{name}</h1>
      </div>
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
            typeNames={availableTypes.map((candidate) => candidate.name)}
            onChange={changeSource}
            onOpenYaml={() => setView("yaml")}
          />
            : view === "visual" ? <div className="visual-type-unavailable"><CircleAlert aria-hidden="true" /><p>Fix the YAML source before returning to the field editor.</p><button onClick={() => setView("yaml")}>Open YAML</button></div>
              : <CodeEditor
                key={`${document?.path ?? "new-type"}:yaml`}
                value={source}
                onChange={(next) => { onSourceChange(next); setVisualError(undefined); setReviewing(false); }}
                label={`${name} type YAML`}
                language="yaml-frontmatter"
                lineWrapping={false}
                autoFocus={creating}
              />}
    </section>
  </main>;
}

function VisualTypeEditor({ definition, source, impact, typeNames, onChange, onOpenYaml }: {
  definition: VisualTypeDefinition;
  source: string;
  impact?: TypeImpact;
  typeNames: string[];
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
    <CollectionBehaviourEditor
      definition={definition}
      typeNames={typeNames}
      onChange={onChange}
      onOpenYaml={onOpenYaml}
    />
    <p className="visual-type-footnote">Advanced JSON Schema rules remain intact and are identified in place. Review any structural conversion before applying it.</p>
  </div>;
}

interface TypeFieldOption {
  value: string;
  label: string;
  node: TypeSchemaNode;
}

function CollectionBehaviourEditor({ definition, typeNames, onChange, onOpenYaml }: {
  definition: VisualTypeDefinition;
  typeNames: string[];
  onChange: (change: (source: string) => string) => void;
  onOpenYaml: () => void;
}) {
  const collection = definition.collection;
  const fields = typeFieldOptions(definition.fields);
  const topLevelFields = definition.fields.map((field) => ({
    value: field.name,
    label: field.name,
    node: field
  }));
  const linkFields = fields.filter((option) => option.node.kind === "string");
  const usedDefaults = new Set(collection.readDefaults.map((entry) => entry.field));
  const usedLinks = new Set(collection.links.map((rule) => rule.field));
  const nextDefault = topLevelFields.find((option) => !usedDefaults.has(option.value));
  const nextLink = linkFields.find((option) => !usedLinks.has(option.value));
  const firstUnique = fields[0];
  const advancedKeys = [
    ...collection.advancedKeys.map(collectionRuleLabel),
    ...collection.path.advancedKeys.map((key) => `Path: ${collectionRuleLabel(key)}`)
  ];

  return <section className="visual-type-section collection-behaviour-section">
    <div className="visual-section-heading">
      <div><h3>Collection behaviour</h3><p>How this type appears and behaves across compatible tools.</p></div>
    </div>

    <div className="collection-behaviour-group">
      <div className="collection-group-heading">
        <div><h4>Display</h4><p>Advisory labels and colour used when records of this type are shown.</p></div>
      </div>
      <div className="collection-display-grid">
        <CollectionFieldSelect
          label="Name field"
          value={collection.display.nameField ?? ""}
          fields={fields.filter(textLikeField)}
          onChange={(value) => onChange((source) => updateTypeCollectionDisplay(source, "name_field", value))}
        />
        <CollectionFieldSelect
          label="Description field"
          value={collection.display.descriptionField ?? ""}
          fields={fields.filter(textLikeField)}
          onChange={(value) => onChange((source) => updateTypeCollectionDisplay(source, "description_field", value))}
        />
        <IconPicker
          value={collection.display.icon ?? ""}
          onChange={(value) => onChange((source) => updateTypeCollectionDisplay(source, "icon", value))}
        />
        <CollectionFieldSelect
          label="Colour field"
          value={collection.display.colorField ?? ""}
          fields={fields}
          onChange={(value) => onChange((source) => updateTypeCollectionDisplay(source, "color_field", value))}
        />
      </div>
    </div>

    <div className="collection-behaviour-group">
      <div className="collection-group-heading">
        <div><h4>Read defaults</h4><p>Effective values for missing properties. Source files stay unchanged.</p></div>
        <button
          disabled={!nextDefault}
          onClick={() => nextDefault && onChange((source) => addTypeReadDefault(source, nextDefault.value, defaultValueForField(nextDefault.node)))}
        ><Plus aria-hidden="true" />Add default</button>
      </div>
      <div className="collection-rule-list">
        {collection.readDefaults.map((entry, index) => {
          const option = topLevelFields.find((candidate) => candidate.value === entry.field);
          return <div className="collection-default-row" key={entry.field}>
            <CollectionFieldSelect
              label={`Default field ${index + 1}`}
              visibleLabel="Field"
              value={entry.field}
              fields={topLevelFields.filter((candidate) => candidate.value === entry.field || !usedDefaults.has(candidate.value))}
              allowEmpty={false}
              onChange={(value) => onChange((source) => renameTypeReadDefault(source, entry.field, value))}
            />
            <DefaultValueEditor
              field={entry.field}
              node={option?.node}
              value={entry.value}
              onChange={(value) => onChange((source) => setTypeReadDefault(source, entry.field, value))}
            />
            <button className="icon-button collection-rule-remove" aria-label={`Remove read default for ${entry.field}`} title={`Remove read default for ${entry.field}`} onClick={() => onChange((source) => removeTypeReadDefault(source, entry.field))}><Trash2 aria-hidden="true" /></button>
          </div>;
        })}
        {!collection.readDefaults.length && <p className="collection-empty-rule">Missing properties have no type-specific read defaults.</p>}
      </div>
    </div>

    <div className="collection-behaviour-group">
      <div className="collection-group-heading">
        <div><h4>Links</h4><p>Describe which properties point to other records and how targets are validated.</p></div>
        <button
          disabled={!nextLink}
          onClick={() => nextLink && onChange((source) => addTypeLinkRule(source, nextLink.value))}
        ><Plus aria-hidden="true" />Add link rule</button>
      </div>
      <div className="collection-rule-list">
        {collection.links.map((rule, index) => <div className="collection-link-rule" key={rule.field}>
          <div className="collection-link-primary">
            <CollectionFieldSelect
              label={`Link field ${index + 1}`}
              visibleLabel="Field"
              value={rule.field}
              fields={linkFields.filter((candidate) => candidate.value === rule.field || !usedLinks.has(candidate.value))}
              allowEmpty={false}
              onChange={(value) => onChange((source) => renameTypeLinkRule(source, rule.field, value))}
            />
            <label><span>Format</span><select
              aria-label={`${rule.field} link format`}
              value={rule.format ?? ""}
              onChange={(event) => onChange((source) => setTypeLinkRule(source, rule.field, "format", (event.target.value || undefined) as TypeLinkFormat | undefined))}
            >
              <option value="">Any supported format</option>
              <option value="wikilink">Wikilink</option>
              <option value="markdown">Markdown link</option>
              <option value="path">Path</option>
              <option value="any">Any</option>
            </select></label>
            <label className="collection-toggle"><input
              type="checkbox"
              checked={rule.validateExists}
              onChange={(event) => onChange((source) => setTypeLinkRule(source, rule.field, "validate_exists", event.target.checked || undefined))}
            /><span>Require an existing target</span></label>
            <button className="icon-button collection-rule-remove" aria-label={`Remove link rule for ${rule.field}`} title={`Remove link rule for ${rule.field}`} onClick={() => onChange((source) => removeTypeLinkRule(source, rule.field))}><Trash2 aria-hidden="true" /></button>
          </div>
          <StringListEditor
            label="Allowed target types"
            values={rule.targetTypes}
            itemLabel={`${rule.field} target type`}
            addLabel="Add target type"
            placeholder="person or any"
            helper="Leave empty to allow records of any type."
            suggestions={["any", ...typeNames]}
            onChange={(values) => onChange((source) => setTypeLinkTargets(source, rule.field, values))}
          />
          {rule.advancedKeys.length > 0 && <p className="collection-advanced-inline">Additional link settings remain in YAML: {rule.advancedKeys.join(", ")}.</p>}
        </div>)}
        {!collection.links.length && <p className="collection-empty-rule">No properties are marked as links.</p>}
      </div>
    </div>

    <div className="collection-behaviour-group">
      <div className="collection-group-heading">
        <div><h4>Uniqueness</h4><p>Require a property value to be unique across a deliberate comparison set.</p></div>
        <button
          disabled={!firstUnique}
          onClick={() => firstUnique && onChange((source) => addTypeUniqueRule(source, firstUnique.value))}
        ><Plus aria-hidden="true" />Add unique rule</button>
      </div>
      <div className="collection-rule-list">
        {collection.unique.map((rule, index) => <div className={`collection-unique-rule${rule.scope === "path_glob" ? " has-path" : ""}`} key={`${rule.sourceIndex}:${rule.field}`}>
          <CollectionFieldSelect
            label={`Unique field ${index + 1}`}
            visibleLabel="Field"
            value={rule.field}
            fields={fields}
            allowEmpty={false}
            onChange={(value) => onChange((source) => setTypeUniqueRule(source, rule.sourceIndex, "field", value))}
          />
          <label><span>Scope</span><select
            aria-label={`${rule.field} uniqueness scope`}
            value={rule.scope ?? ""}
            onChange={(event) => onChange((source) => setTypeUniqueRule(source, rule.sourceIndex, "scope", (event.target.value || undefined) as TypeUniqueScope | undefined))}
          >
            <option value="">Choose scope</option>
            <option value="type">This type</option>
            <option value="collection">Entire collection</option>
            <option value="path_glob">Path pattern</option>
          </select></label>
          {rule.scope === "path_glob" && <label className="collection-unique-path"><span>Path pattern</span><input
            aria-label={`${rule.field} uniqueness path pattern`}
            value={rule.pathGlob ?? ""}
            placeholder="Projects/**/*.md"
            onChange={(event) => onChange((source) => setTypeUniqueRule(source, rule.sourceIndex, "path_glob", event.target.value || undefined))}
          /></label>}
          <button className="icon-button collection-rule-remove" aria-label={`Remove uniqueness rule for ${rule.field}`} title={`Remove uniqueness rule for ${rule.field}`} onClick={() => onChange((source) => removeTypeUniqueRule(source, rule.sourceIndex))}><Trash2 aria-hidden="true" /></button>
          {rule.advancedKeys.length > 0 && <p className="collection-advanced-inline">Additional uniqueness settings remain in YAML: {rule.advancedKeys.join(", ")}.</p>}
        </div>)}
        {!collection.unique.length && <p className="collection-empty-rule">No cross-record uniqueness rules.</p>}
      </div>
    </div>

    <div className="collection-behaviour-group">
      <div className="collection-group-heading">
        <div><h4>Path policy</h4><p>Guide compatible tools when they create or rename records of this type.</p></div>
      </div>
      <div className="collection-path-grid">
        <label><span>Pattern</span><input
          aria-label="Path pattern"
          value={collection.path.pattern ?? ""}
          placeholder="tasks/{id}.md"
          onChange={(event) => onChange((source) => updateTypePathPolicy(source, "pattern", event.target.value))}
        /><small>Portable <code>{"{field}"}</code> placeholders.</small></label>
        <label><span>Folder</span><input
          aria-label="Path folder"
          value={collection.path.folder ?? ""}
          placeholder="tasks"
          onChange={(event) => onChange((source) => updateTypePathPolicy(source, "folder", event.target.value))}
        /></label>
        <label><span>Template</span><input
          aria-label="Path template"
          value={collection.path.template ?? ""}
          placeholder="{title}.md"
          onChange={(event) => onChange((source) => updateTypePathPolicy(source, "template", event.target.value))}
        /></label>
      </div>
    </div>

    {advancedKeys.length > 0 && <div className="advanced-match-note collection-advanced-note">
      <Info aria-hidden="true" />
      <div><strong>More collection behaviour in YAML</strong><p>{advancedKeys.join(" · ")}. These settings remain intact.</p></div>
      <button onClick={onOpenYaml}>Open YAML</button>
    </div>}
  </section>;
}

const FEATURED_PHOSPHOR_ICONS = [
  "note",
  "notebook",
  "book-open",
  "article",
  "text-aa",
  "list-checks",
  "check-circle",
  "bookmark-simple",
  "tag",
  "folder",
  "archive",
  "calendar",
  "clock",
  "user",
  "users",
  "address-book",
  "chat-circle",
  "envelope",
  "phone",
  "link",
  "paperclip",
  "image",
  "camera",
  "map-pin",
  "globe",
  "house",
  "building-office",
  "briefcase",
  "projector-screen-chart",
  "chart-line-up",
  "target",
  "lightbulb",
  "brain",
  "sparkle",
  "star",
  "heart",
  "flag",
  "push-pin",
  "bell",
  "warning-circle",
  "info",
  "question",
  "check",
  "x",
  "plus",
  "minus",
  "gear-six",
  "wrench",
  "code",
  "terminal",
  "database",
  "cloud",
  "lock",
  "shield-check",
  "key",
  "rocket-launch",
  "plant",
  "leaf",
  "coffee",
  "music-notes",
  "palette",
  "pencil-simple",
  "graduation-cap"
] as const;

function IconPicker({ value, onChange }: {
  value: string;
  onChange: (value: string) => void;
}) {
  const listId = useId();
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const [query, setQuery] = useState(value);
  const [activeIndex, setActiveIndex] = useState(0);
  const normalized = normalizePhosphorIconName(value);
  const valid = isPhosphorIconName(value);
  const queryValid = isPhosphorIconName(query);
  const options = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    if (!search) return [...FEATURED_PHOSPHOR_ICONS];
    const terms = search.split(/[\s-]+/).filter(Boolean);
    return PHOSPHOR_ICON_NAMES
      .filter((name) => terms.every((term) => name.includes(term)))
      .sort((left, right) => {
        const leftStarts = left.startsWith(search) ? 0 : 1;
        const rightStarts = right.startsWith(search) ? 0 : 1;
        return leftStarts - rightStarts || left.length - right.length || left.localeCompare(right);
      })
      .slice(0, 72);
  }, [query]);

  useEffect(() => setQuery(value), [value]);
  useEffect(() => setActiveIndex(0), [query]);

  function choose(name: string) {
    onChange(name);
    setQuery(name);
    setOpen(false);
  }

  function openPicker() {
    const bounds = root.current?.getBoundingClientRect();
    if (!open) setQuery("");
    setDropUp(Boolean(bounds && window.innerHeight - bounds.bottom < 270 && bounds.top > 270));
    setOpen(true);
  }

  return <div
    className="icon-picker"
    ref={root}
    onBlur={(event) => {
      if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
      setOpen(false);
      if (query.trim() && queryValid) onChange(normalizePhosphorIconName(query));
      setQuery(value);
    }}
  >
    <span>Icon</span>
    <div className={`icon-picker-control${open ? " open" : ""}${open ? query && !queryValid ? " invalid" : "" : value && !valid ? " invalid" : ""}`}>
      <span className="icon-picker-current" aria-hidden="true">
        {valid ? <PhosphorIcon name={normalized} /> : <FileCode2 />}
      </span>
      <input
        role="combobox"
        aria-label="Display icon"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && options.length ? `${listId}-${activeIndex}` : undefined}
        value={open ? query : value}
        placeholder="Choose an icon"
        spellCheck="false"
        autoComplete="off"
        onFocus={openPicker}
        onClick={openPicker}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            openPicker();
            setActiveIndex((current) => Math.min(current + 1, Math.max(0, options.length - 1)));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            openPicker();
            setActiveIndex((current) => Math.max(0, current - 1));
          } else if (event.key === "Enter" && open && options[activeIndex]) {
            event.preventDefault();
            choose(options[activeIndex]);
          } else if (event.key === "Escape") {
            event.preventDefault();
            setOpen(false);
          }
        }}
      />
      {(value || open && query) && <button
        type="button"
        className="icon-picker-clear"
        aria-label="Clear display icon"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          onChange("");
          setQuery("");
        }}
      ><X aria-hidden="true" /></button>}
    </div>
    {open && <div className={`icon-picker-popover${dropUp ? " drop-up" : ""}`} id={listId} role="listbox" aria-label="Phosphor icons">
      {options.length ? <div className="icon-picker-grid">
        {options.map((name, index) => <button
          id={`${listId}-${index}`}
          key={name}
          type="button"
          role="option"
          aria-selected={normalized === name}
          className={activeIndex === index ? "active" : ""}
          title={name}
          onMouseEnter={() => setActiveIndex(index)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => choose(name)}
        ><PhosphorIcon name={name} aria-hidden="true" /><span className="sr-only">{name}</span></button>)}
      </div> : <p>No matching icons.</p>}
      <footer>{query.trim() ? `${options.length} ${options.length === 1 ? "match" : "matches"}` : "Common icons"}<span>Phosphor Regular</span></footer>
    </div>}
    {open
      ? query && !queryValid && <small className="icon-picker-error">Choose an icon from the Phosphor library.</small>
      : value && !valid && <small className="icon-picker-error">Choose an icon from the Phosphor library.</small>}
  </div>;
}

function CollectionFieldSelect({ label, visibleLabel, value, fields, allowEmpty = true, onChange }: {
  label: string;
  visibleLabel?: string;
  value: string;
  fields: TypeFieldOption[];
  allowEmpty?: boolean;
  onChange: (value: string) => void;
}) {
  const options = fields.some((field) => field.value === value) || !value
    ? fields
    : [{ value, label: value, node: advancedFieldNode(value) }, ...fields];
  return <label><span>{visibleLabel ?? label}</span><select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
    {allowEmpty && <option value="">Not set</option>}
    {options.map((field) => <option key={field.value} value={field.value}>{field.label}</option>)}
  </select></label>;
}

function DefaultValueEditor({ field, node, value, onChange }: {
  field: string;
  node?: TypeSchemaNode;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  if (node?.kind === "boolean" && typeof value === "boolean") {
    return <label><span>Default value</span><select aria-label={`Default value for ${field}`} value={String(value)} onChange={(event) => onChange(event.target.value === "true")}>
      <option value="true">True</option>
      <option value="false">False</option>
    </select></label>;
  }
  if ((node?.kind === "string" || node?.kind === "date" || node?.kind === "datetime") && typeof value === "string") {
    return <label><span>Default value</span><input aria-label={`Default value for ${field}`} value={value} onChange={(event) => onChange(event.target.value)} /></label>;
  }
  return <JsonValueInput field={field} value={value} onChange={onChange} />;
}

function JsonValueInput({ field, value, onChange }: { field: string; value: unknown; onChange: (value: unknown) => void }) {
  const valueKey = JSON.stringify(value) ?? "null";
  const [draft, setDraft] = useState(valueKey);
  const [error, setError] = useState<string>();
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (dirty) return;
    setDraft(valueKey);
  }, [dirty, valueKey]);

  function commit() {
    try {
      onChange(JSON.parse(draft));
      setError(undefined);
      setDirty(false);
    } catch {
      setError("Enter a valid JSON value.");
    }
  }

  return <label className="collection-json-value"><span>Default value</span><input
    aria-label={`Default value for ${field}`}
    aria-invalid={error ? "true" : undefined}
    value={draft}
    onChange={(event) => { setDraft(event.target.value); setDirty(true); setError(undefined); }}
    onBlur={commit}
  />{error && <small role="alert">{error}</small>}</label>;
}

function typeFieldOptions(fields: TypeFieldDefinition[]): TypeFieldOption[] {
  const options: TypeFieldOption[] = [];
  const visitNode = (node: TypeSchemaNode, includeNode: boolean) => {
    if (includeNode) {
      const value = typeFieldPathLabel(node.path);
      options.push({ value, label: value, node });
    }
    node.fields.forEach((field) => visitNode(field, true));
    if (node.item) visitNode(node.item, true);
  };
  fields.forEach((field) => visitNode(field, true));
  return options.filter((option, index) => options.findIndex((candidate) => candidate.value === option.value) === index);
}

function textLikeField(option: TypeFieldOption): boolean {
  return option.node.kind === "string" || option.node.kind === "date" || option.node.kind === "datetime";
}

function defaultValueForField(field: TypeSchemaNode): unknown {
  if (field.kind === "boolean") return false;
  if (field.kind === "number" || field.kind === "integer") return 0;
  if (field.kind === "array") return [];
  if (field.kind === "object") return {};
  return "";
}

function advancedFieldNode(value: string): TypeSchemaNode {
  return { path: [value], valuePath: [value], kind: "advanced", fields: [], constraints: {}, advancedKeys: [], raw: {} };
}

function collectionRuleLabel(key: string): string {
  if (key === "projections") return "Computed projections";
  if (key === "runtime") return "Runtime path handling";
  if (key === "generated_by") return "Generated path ownership";
  if (key.startsWith("x-")) return key;
  return key.replaceAll("_", " ");
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

function StringListEditor({ label, values, itemLabel, addLabel, placeholder, helper, suggestions, onChange }: {
  label: string;
  values: string[];
  itemLabel: string;
  addLabel: string;
  placeholder?: string;
  helper?: string;
  suggestions?: string[];
  onChange: (values: string[]) => void;
}) {
  const suggestionsId = useId();
  const valuesKey = JSON.stringify(values);
  const [drafts, setDrafts] = useState(values);
  const [dirty, setDirty] = useState(false);
  const [openSuggestions, setOpenSuggestions] = useState<number>();
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const [suggestionsDropUp, setSuggestionsDropUp] = useState(false);
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

  const suggestedValues = [...new Set(suggestions ?? [])];
  const matchingSuggestions = (value: string) => {
    const search = value.trim().toLocaleLowerCase();
    return suggestedValues.filter((suggestion) => !search || suggestion.toLocaleLowerCase().includes(search));
  };
  const chooseSuggestion = (index: number, suggestion: string) => {
    const next = drafts.map((item, itemIndex) => itemIndex === index ? suggestion : item);
    setOpenSuggestions(undefined);
    setActiveSuggestion(0);
    commit(next);
  };
  const openSuggestionList = (index: number, input: HTMLInputElement) => {
    const bounds = input.getBoundingClientRect();
    setSuggestionsDropUp(window.innerHeight - bounds.bottom < 180 && bounds.top > 180);
    setOpenSuggestions(index);
  };

  return <div className="string-list-editor">
    <div className="string-list-heading"><span>{label}</span><button onClick={addItem}><Plus aria-hidden="true" />{addLabel}</button></div>
    {helper && <small>{helper}</small>}
    <div className="string-list-items" ref={list}>
      {drafts.map((value, index) => <div className="string-list-item" key={index}>
        <span aria-hidden="true">{index + 1}</span>
        <div className="string-list-input">
          <label><span className="sr-only">{itemLabel} {index + 1}</span><input
            value={value}
            role={suggestions?.length ? "combobox" : undefined}
            aria-autocomplete={suggestions?.length ? "list" : undefined}
            aria-expanded={suggestions?.length ? openSuggestions === index : undefined}
            aria-controls={suggestions?.length ? `${suggestionsId}-${index}` : undefined}
            aria-activedescendant={suggestions?.length && openSuggestions === index && matchingSuggestions(value).length
              ? `${suggestionsId}-${index}-${activeSuggestion}`
              : undefined}
            placeholder={placeholder}
            spellCheck="false"
            autoComplete="off"
            onFocus={(event) => {
              if (suggestions?.length) {
                openSuggestionList(index, event.currentTarget);
                setActiveSuggestion(0);
              }
            }}
            onChange={(event) => {
              setDrafts((current) => current.map((item, itemIndex) => itemIndex === index ? event.target.value : item));
              setDirty(true);
              openSuggestionList(index, event.currentTarget);
              setActiveSuggestion(0);
            }}
            onBlur={() => {
              setOpenSuggestions(undefined);
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
              const matches = matchingSuggestions(event.currentTarget.value);
              if (suggestions?.length && event.key === "ArrowDown") {
                event.preventDefault();
                openSuggestionList(index, event.currentTarget);
                setActiveSuggestion((current) => Math.min(current + 1, Math.max(0, matches.length - 1)));
                return;
              }
              if (suggestions?.length && event.key === "ArrowUp") {
                event.preventDefault();
                openSuggestionList(index, event.currentTarget);
                setActiveSuggestion((current) => Math.max(0, current - 1));
                return;
              }
              if (event.key === "Escape" && openSuggestions === index) {
                event.preventDefault();
                setOpenSuggestions(undefined);
                return;
              }
              if (event.key === "Enter" && openSuggestions === index && matches[activeSuggestion]) {
                event.preventDefault();
                chooseSuggestion(index, matches[activeSuggestion]);
                return;
              }
              if (event.key !== "Enter" || !event.currentTarget.value.trim()) return;
              event.preventDefault();
              skipBlur.current = true;
              commit(drafts, true);
            }}
          /></label>
          {suggestions?.length && openSuggestions === index && <div
            className={`string-list-suggestions${suggestionsDropUp ? " drop-up" : ""}`}
            id={`${suggestionsId}-${index}`}
            role="listbox"
            aria-label={`${itemLabel} suggestions`}
          >
            {matchingSuggestions(value).map((suggestion, suggestionIndex) => <button
              id={`${suggestionsId}-${index}-${suggestionIndex}`}
              type="button"
              role="option"
              aria-selected={value === suggestion}
              className={activeSuggestion === suggestionIndex ? "active" : ""}
              key={suggestion}
              onMouseEnter={() => setActiveSuggestion(suggestionIndex)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => chooseSuggestion(index, suggestion)}
            >{suggestion}</button>)}
            {!matchingSuggestions(value).length && <p>No matches.</p>}
          </div>}
        </div>
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
    {impact.collectionChanges.length > 0 && <div className="type-collection-changes">
      <strong>Collection behaviour</strong>
      <p>{impact.collectionChanges.join(" · ")}</p>
    </div>}
    {impact.collectionChanges.some((change) => change === "Link rules" || change === "Uniqueness rules") && <div className="type-impact-warning" role="alert">
      <CircleAlert aria-hidden="true" />
      <div><strong>Validation may change</strong><p>Link and uniqueness rules can make matching records valid or invalid without changing their source files.</p></div>
    </div>}
    {impact.collectionChanges.includes("Path policy") && <div className="type-impact-warning" role="alert">
      <CircleAlert aria-hidden="true" />
      <div><strong>Future file paths may change</strong><p>Compatible tools use this policy when creating and renaming records. Existing files are not moved by this update.</p></div>
    </div>}
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
