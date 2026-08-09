import {
  ArrowCounterClockwiseIcon as RotateCcw,
  ArrowLeftIcon as ArrowLeft,
  CaretDownIcon as ChevronDown,
  CaretRightIcon as ChevronRight,
  CheckIcon as Check,
  FileCodeIcon as FileCode2,
  FilePlusIcon as FilePlus2,
  InfoIcon as Info,
  LinkIcon as Link2,
  MagnifyingGlassIcon as Search,
  PackageIcon as Package,
  PlusIcon as Plus,
  SidebarSimpleIcon as PanelLeft,
  TrashIcon as Trash2,
  WarningCircleIcon as CircleAlert,
  XIcon as X
} from "./icons";
import type { CollectionContractDescriptor, CollectionTypeDescriptor, JsonObject } from "@mdbase-dev/connect";
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { CodeEditor } from "./CodeEditor";
import { SchemaValueEditor, schemaInitialValue } from "./SchemaValueEditor";
import { InlineRemoveButton } from "./InlineRemoveButton";
import { ComboboxInput, SelectControl } from "./SelectionControls";
import {
  contractCatalogPackStatus,
  type ContractCatalog,
  type ContractCatalogPack
} from "./contract-catalog";
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
  addTypeContractImplementation,
  assessContractFieldMapping,
  contractViewPreview,
  contractFields,
  contractKey,
  createTypeSourceFromContract,
  mappingForContractField,
  readTypeContractImplementations,
  removeTypeContractImplementation,
  setTypeContractBinding,
  setTypeContractFieldMapping,
  suggestContractsForType,
  typeFieldsForContracts,
  typeSchemaReference,
  validateTypeContractImplementations,
  type ContractTypeField,
  type ContractValidationIssue
} from "./type-contracts";
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
  type TypeMembershipImpact,
  type TypeSchemaNode,
  type TypeUniqueScope,
  type VisualTypeDefinition
} from "./type-schema";

export function TypeList({ types, selectedName, packsSelected = false, leadingActions, trailingActions, onSelect, onPacks, onCreate, onCollections }: {
  types: CollectionTypeDescriptor[];
  selectedName?: string;
  packsSelected?: boolean;
  leadingActions?: ReactNode;
  trailingActions?: ReactNode;
  onSelect: (name: string) => void;
  onPacks: () => void;
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
      {trailingActions}
      <button className="icon-button new-type-button" aria-label="New type" title="New type" onClick={onCreate}><FilePlus2 aria-hidden="true" /></button>
    </header>
    <label className="search-field">
      <Search aria-hidden="true" /><span className="sr-only">Search types</span>
      <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search types" />
      {search && <button aria-label="Clear type search" onClick={() => setSearch("")}><X aria-hidden="true" /></button>}
    </label>
    <nav className="type-resource-nav" aria-label="Type resources">
      <button className={`type-pack-entry${packsSelected ? " selected" : ""}`} aria-current={packsSelected ? "page" : undefined} onClick={onPacks}>
        <span className="type-row-icon"><Package aria-hidden="true" /></span>
        <span className="type-row-copy"><strong>Add a type</strong><small>Start with a ready-made type</small></span>
        <ChevronRight aria-hidden="true" />
      </button>
    </nav>
    <div className={`type-list${!visible.length ? " empty" : ""}`} role="listbox" aria-label="Collection types">
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

export function TypePackBrowser({ types, contracts, catalog, loading = false, error, canInstall = false, leadingActions, onInstall, onOpenType, onRequestAccess, onReload, onBack }: {
  types: CollectionTypeDescriptor[];
  contracts: CollectionContractDescriptor[];
  catalog?: ContractCatalog;
  loading?: boolean;
  error?: string;
  canInstall?: boolean;
  leadingActions?: ReactNode;
  onInstall?: (pack: ContractCatalogPack) => Promise<void>;
  onOpenType?: (name: string) => void;
  onRequestAccess?: () => void;
  onReload?: () => void;
  onBack: () => void;
}) {
  return <main className="type-inspector type-pack-browser" aria-label="Add a type">
    <header className="type-inspector-bar">
      <button className="mobile-back icon-button" aria-label="Back to types" onClick={onBack}><ArrowLeft aria-hidden="true" /></button>
      {leadingActions}
      <span>Collection resources</span>
      <small>Catalog</small>
    </header>
    <section className="type-heading">
      <p className="eyebrow">Collection resources</p>
      <div className="type-heading-title">
        <Package aria-hidden="true" />
        <h1>Add a type</h1>
      </div>
      <p>Choose a ready-made type, then adapt its fields and contract mapping to fit your collection.</p>
      <dl>
        <div><dt>Types</dt><dd>{types.length}</dd></div>
        <div><dt>Contracts</dt><dd>{contracts.length}</dd></div>
      </dl>
    </section>
    <section className="type-pack-document">
      <div className="type-pack-intro">
        <h2>Ready-made types</h2>
        <p>Adding one creates a new editable type. Existing files are never overwritten.</p>
      </div>
      <ContractCatalogBrowser
        catalog={catalog}
        contracts={contracts}
        types={types}
        loading={loading}
        error={error}
        canInstall={canInstall}
        onInstall={onInstall}
        onOpenType={onOpenType}
        onRequestAccess={onRequestAccess}
        onReload={onReload}
      />
    </section>
  </main>;
}

export function TypeInspector({ type, availableTypes = [], contracts = [], document, source, notes, explicitTypeKeys = ["type", "types"], creating, loading, saving, error, leadingActions, onSourceChange, onSave, onRevert, onCancel, onCreate, onBrowsePacks, onOpenSettings, onBack }: {
  type?: CollectionTypeDescriptor;
  availableTypes?: CollectionTypeDescriptor[];
  contracts?: CollectionContractDescriptor[];
  document?: TypeDocument;
  source: string;
  notes: NoteSummary[];
  explicitTypeKeys?: string[];
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
  onBrowsePacks?: () => void;
  onOpenSettings?: () => void;
  onBack: () => void;
}) {
  const [view, setView] = useState<"visual" | "yaml">("visual");
  const [reviewing, setReviewing] = useState(false);
  const [visualError, setVisualError] = useState<string>();
  const dirty = creating ? source.trim().length > 0 : Boolean(document && source !== document.document);
  const parsed = useMemo(() => parseVisualType(source), [source]);
  const contractState = useMemo(() => {
    if (!parsed.value) return { implementations: [], issues: [] };
    try {
      return {
        implementations: readTypeContractImplementations(source),
        issues: validateTypeContractImplementations(source, contracts, type?.schema)
      };
    } catch {
      return { implementations: [], issues: [] };
    }
  }, [contracts, parsed.value, source, type?.schema]);
  const contractErrors = contractState.issues.filter((issue) => issue.level === "error");
  const impact = useMemo(() => parsed.value
    ? typeImpact(document?.document, source, notes, type?.name, explicitTypeKeys)
    : undefined, [document?.document, explicitTypeKeys.join("\u0000"), notes, parsed.value, source, type?.name]);
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
        <div><dt>App views</dt><dd>{contractState.implementations.length}</dd></div>
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
            <button className="save-type-button" onClick={() => setReviewing(true)} disabled={loading || saving || !dirty || !parsed.value || contractErrors.length > 0}>{saving ? "Saving…" : "Review changes"}</button>
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
            contracts={contracts}
            typeSchema={type?.schema}
            notes={notes}
            explicitTypeKeys={explicitTypeKeys}
            creating={creating}
            contractIssues={contractState.issues}
            onChange={changeSource}
            onOpenYaml={() => setView("yaml")}
            onBrowsePacks={onBrowsePacks}
            onOpenSettings={onOpenSettings}
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

function VisualTypeEditor({ definition, source, impact, typeNames, contracts, typeSchema, notes, explicitTypeKeys, creating, contractIssues, onChange, onOpenYaml, onBrowsePacks, onOpenSettings }: {
  definition: VisualTypeDefinition;
  source: string;
  impact?: TypeImpact;
  typeNames: string[];
  contracts: CollectionContractDescriptor[];
  typeSchema?: CollectionTypeDescriptor["schema"];
  notes: NoteSummary[];
  explicitTypeKeys: string[];
  creating: boolean;
  contractIssues: ContractValidationIssue[];
  onChange: (change: (source: string) => string) => void;
  onOpenYaml: () => void;
  onBrowsePacks?: () => void;
  onOpenSettings?: () => void;
}) {
  const [activeField, setActiveField] = useState<string>();
  const linkedSchema = typeSchemaReference(source);
  const linkedSchemaFields = linkedSchema
    ? typeFieldsForContracts(source, typeSchema).filter((field) => !field.label.includes("."))
    : [];
  const fieldSuggestions = useMemo(
    () => membershipFieldSuggestions(source, typeSchema, notes, explicitTypeKeys),
    [explicitTypeKeys.join("\u0000"), notes, source, typeSchema]
  );
  const pathSuggestions = useMemo(() => membershipPathSuggestions(notes), [notes]);
  useEffect(() => setActiveField(undefined), [definition.name]);

  return <div className="visual-type-editor">
    <section className="visual-type-section visual-type-basics">
      <div className="visual-section-heading"><div><h3>Identity</h3><p>The stable name used by records and connected apps.</p></div></div>
      <div className="visual-type-basics-fields">
        <label><span>Name</span><input value={definition.name} onChange={(event) => onChange((source) => updateTypeIdentity(source, "name", event.target.value))} spellCheck="false" /></label>
        <label><span>Description</span><input value={definition.description} onChange={(event) => onChange((source) => updateTypeIdentity(source, "description", event.target.value))} /></label>
      </div>
    </section>
    <TypeEditorDisclosure
      className="type-match-section"
      title="Type membership"
      description="How notes are assigned to this type."
      summary={typeMembershipSummary(definition)}
    >
      <div className="type-membership-method type-explicit-membership">
        <div>
          <strong>Explicit assignment</strong>
          {explicitTypeKeys.length
            ? <p>Notes can name <code>{definition.name}</code> through {explicitTypeKeys.map((key, index) => <span key={key}>{index ? ", " : ""}<code>{key}</code></span>)}. When any configured key is present, automatic rules are skipped.</p>
            : <p>This collection has explicit type assignment disabled. Every note is classified by automatic rules.</p>}
        </div>
        {onOpenSettings && <button onClick={onOpenSettings}>View settings</button>}
      </div>
      <div className="type-membership-method type-automatic-membership">
        <div>
          <strong>Automatic matching</strong>
          <p>{explicitTypeKeys.length
            ? "Notes without an explicit assignment belong to this type when every configured condition group below matches."
            : "Notes belong to this type when every configured condition group below matches."}</p>
        </div>
      </div>
      <div className={`type-match-rules${definition.pathGlobs.length && definition.fieldsPresent.length ? " combined" : ""}`}>
        <StringListEditor
          label="Path matches any"
          values={definition.pathGlobs}
          itemLabel="Path pattern"
          addLabel="Add path pattern"
          placeholder="Journal/**/*.md"
          helper="Optional. One pattern must match the collection-relative path."
          suggestions={pathSuggestions}
          onChange={(values) => onChange((source) => updateTypePathGlobs(source, values))}
        />
        {definition.pathGlobs.length > 0 && definition.fieldsPresent.length > 0 && <span className="type-match-operator" aria-label="and">AND</span>}
        <StringListEditor
          label="Frontmatter contains all"
          values={definition.fieldsPresent}
          itemLabel="Required match field"
          addLabel="Add field selector"
          placeholder="status"
          helper="Optional. Every selector must have a persisted, non-null value."
          suggestions={fieldSuggestions}
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
      {impact && <TypeMembershipPreview impact={impact.membership} advanced={definition.advancedMatch} />}
    </TypeEditorDisclosure>
    <section className="visual-type-section">
      <div className="visual-type-fields-heading">
        <div>
          <h3>Fields</h3>
          <p>{linkedSchema
            ? `${linkedSchemaFields.length} ${linkedSchemaFields.length === 1 ? "field is" : "fields are"} supplied by the installed schema.`
            : "Objects and lists can contain fields at any depth."}</p>
        </div>
        {linkedSchema
          ? <button onClick={onOpenYaml}><FileCode2 aria-hidden="true" />Edit reference</button>
          : <button onClick={() => onChange((current) => addTypeField(current))}><Plus aria-hidden="true" />Add field</button>}
      </div>
      <div className="visual-field-columns" aria-hidden="true"><span>Field</span><span>Kind</span><span>Required</span><span /></div>
    </section>
    <div className="visual-type-fields">
      {linkedSchema ? <>
        <div className="linked-schema-notice">
          <Link2 aria-hidden="true" />
          <div><strong>Schema-managed fields</strong><p><code>{linkedSchema}</code> is installed with this type. Field structure is edited at the schema source.</p></div>
        </div>
        {linkedSchemaFields.map((field) => <div className="linked-schema-field" key={field.reference}>
          <div><code>{field.label}</code>{field.description && <small>{field.description}</small>}</div>
          <span>{kindName(field.kind)}</span>
          <span className={field.required ? "required" : ""}>{field.required ? "Required" : "Optional"}</span>
          <Link2 aria-label="Linked schema field" />
        </div>)}
        {!linkedSchemaFields.length && <p className="quiet-empty">The linked schema does not expose object fields.</p>}
      </> : <>
        {definition.fields.map((field) => <VisualFieldRow
          key={typeFieldPathLabel(field.path)}
          field={field}
          source={source}
          depth={0}
          activeField={activeField}
          onActivate={setActiveField}
          onChange={onChange}
        />)}
        {!definition.fields.length && <p className="quiet-empty">No fields are declared yet.</p>}
      </>}
    </div>
    <CollectionBehaviourEditor
      definition={definition}
      typeNames={typeNames}
      onChange={onChange}
      onOpenYaml={onOpenYaml}
    />
    <ContractEditor
      source={source}
      contracts={contracts}
      typeSchema={typeSchema}
      creating={creating}
      typeNames={typeNames}
      issues={contractIssues}
      onChange={onChange}
      onOpenYaml={onOpenYaml}
      onBrowsePacks={onBrowsePacks}
    />
    <p className="visual-type-footnote">Advanced JSON Schema rules remain intact and are identified in place. Review any structural conversion before applying it.</p>
  </div>;
}

function TypeEditorDisclosure({ className = "", title, description, summary, attention = false, children }: {
  className?: string;
  title: string;
  description: string;
  summary: string;
  attention?: boolean;
  children: ReactNode;
}) {
  const titleId = useId();
  return <details className={`visual-type-section type-editor-disclosure ${className}${attention ? " needs-attention" : ""}`}>
    <summary aria-labelledby={titleId}>
      <span className="type-disclosure-heading">
        <span className="type-disclosure-title" id={titleId} role="heading" aria-level={3}>{title}</span>
        <span className="type-disclosure-description">{description}</span>
      </span>
      <span className="type-disclosure-summary">{summary}</span>
      <ChevronRight aria-hidden="true" />
    </summary>
    <div className="type-disclosure-body">{children}</div>
  </details>;
}

function ContractEditor({ source, contracts, typeSchema, creating, typeNames, issues, onChange, onOpenYaml, onBrowsePacks }: {
  source: string;
  contracts: CollectionContractDescriptor[];
  typeSchema?: CollectionTypeDescriptor["schema"];
  creating: boolean;
  typeNames: string[];
  issues: ContractValidationIssue[];
  onChange: (change: (source: string) => string) => void;
  onOpenYaml: () => void;
  onBrowsePacks?: () => void;
}) {
  const implementations = useMemo(() => readTypeContractImplementations(source), [source]);
  const implementedKeys = new Set(implementations.map((implementation) => `${implementation.contract}@${implementation.version}`));
  const available = contracts.filter((contract) => !implementedKeys.has(contractKey(contract)));
  const suggestions = useMemo(
    () => suggestContractsForType(source, contracts, typeSchema).slice(0, 3),
    [contracts, source, typeSchema]
  );
  const typeFields = useMemo(() => typeFieldsForContracts(source, typeSchema), [source, typeSchema]);
  const implementationIndexes = new Set(implementations.map((implementation) => implementation.sourceIndex));
  const globalIssues = issues.filter((issue) =>
    issue.implementationIndex === undefined || !implementationIndexes.has(issue.implementationIndex));
  const [selectedKey, setSelectedKey] = useState("");
  const [openMappings, setOpenMappings] = useState<Set<string>>(() => new Set());
  const [openSettings, setOpenSettings] = useState<Set<string>>(() => new Set());
  const selected = available.find((contract) => contractKey(contract) === selectedKey) ?? available[0];
  const contractErrors = issues.filter((issue) => issue.level === "error").length;

  useEffect(() => {
    if (!available.length) {
      setSelectedKey("");
      return;
    }
    if (!available.some((contract) => contractKey(contract) === selectedKey)) {
      setSelectedKey(contractKey(available[0]));
    }
  }, [available.map(contractKey).join("\u0000"), selectedKey]);

  function addContract(contract: CollectionContractDescriptor) {
    onChange((current) => addTypeContractImplementation(current, contract, typeSchema));
  }

  const contractSummary = contractErrors
    ? `${contractErrors} ${contractErrors === 1 ? "issue" : "issues"} need attention`
    : implementations.length
      ? `${implementations.length} ${implementations.length === 1 ? "connection" : "connections"} configured`
      : contracts.length
        ? "No connections"
        : "No app contracts installed";

  return <TypeEditorDisclosure
    className="type-contracts-section"
    title="Works with applications"
    description="Tell compatible apps what this type’s fields mean."
    summary={contractSummary}
    attention={contractErrors > 0}
  >

    {!contracts.length && <div className="contract-empty">
      <Link2 aria-hidden="true" />
      <div><strong>No application contracts are installed</strong><p>Add a ready-made type to get app compatibility, or install a contract before connecting this type yourself.</p></div>
      {onBrowsePacks && <button onClick={onBrowsePacks}>Browse ready-made types</button>}
    </div>}

    {contracts.length > 0 && creating && implementations.length === 0 && <div className="contract-starter">
      <div><strong>Start with app compatibility</strong><p>Create fields that already match an installed contract. You can rename and remap them later.</p></div>
      <label><span>Contract</span><SelectControl
        aria-label="Starting contract"
        value={selected ? contractKey(selected) : ""}
        onChange={(event) => setSelectedKey(event.target.value)}
      >{available.map((contract) => <option key={contractKey(contract)} value={contractKey(contract)}>{contract.id} · {contract.version}</option>)}</SelectControl></label>
      <button disabled={!selected} onClick={() => selected && onChange((current) => createTypeSourceFromContract(current, selected, typeNames))}>Use contract</button>
    </div>}

    {implementations.length > 0 && <div className="contract-implementation-list">
      {implementations.map((implementation) => {
        const implementationKey = `${implementation.contract}@${implementation.version}:${implementation.sourceIndex}`;
        const contract = contracts.find((candidate) =>
          candidate.id === implementation.contract && candidate.version === implementation.version);
        const implementationIssues = issues.filter((issue) => issue.implementationIndex === implementation.sourceIndex);
        const errors = implementationIssues.filter((issue) => issue.level === "error");
        const warnings = implementationIssues.filter((issue) => issue.level === "warning");
        const bindingIssues = implementationIssues.filter((issue) =>
          !issue.field && issue.message.toLowerCase().includes("binding"));
        const fields = contract ? contractFields(contract) : [];
        const mappedCount = fields.filter((field) => mappingForContractField(implementation, field)).length;
        const requiredFields = fields.filter((field) => field.required);
        const requiredMapped = requiredFields.filter((field) =>
          mappingForContractField(implementation, field)).length;
        return <article className="contract-implementation" key={implementationKey}>
          <header>
            <div className={`contract-status${errors.length ? " invalid" : warnings.length ? " review" : ""}`}>
              {errors.length || warnings.length ? <CircleAlert aria-hidden="true" /> : <Check aria-hidden="true" />}
              <span>{errors.length ? "Needs attention" : warnings.length ? "Review recommended" : "Mapping ready"}</span>
            </div>
            <div className="contract-identity">
              <strong>{implementation.contract}</strong>
              <span>{implementation.version}</span>
            </div>
            <button
              className="contract-remove"
              aria-label={`Remove ${implementation.contract} contract`}
              onClick={() => onChange((current) => removeTypeContractImplementation(current, implementation.contract, implementation.version))}
            ><Trash2 aria-hidden="true" />Remove</button>
          </header>
          {!contract ? <div className="contract-unavailable">
            <p>This exact contract is not available in the collection. Restore it or remove the implementation before saving.</p>
            <button onClick={onOpenYaml}>Open YAML</button>
          </div> : <>
            <details
              open={errors.length > 0 || openMappings.has(implementationKey)}
              onToggle={(event) => {
                if (errors.length > 0) return;
                const open = event.currentTarget.open;
                setOpenMappings((current) => {
                  const next = new Set(current);
                  if (open) next.add(implementationKey);
                  else next.delete(implementationKey);
                  return next;
                });
              }}
            >
              <summary>
                <span>Field mappings</span>
                <small>{requiredMapped}/{requiredFields.length} required · {mappedCount}/{fields.length} total{warnings.length ? ` · ${warnings.length} to review` : ""}</small>
                <ChevronRight aria-hidden="true" />
              </summary>
              {fields.length ? <div className="contract-mapping-list">
                <div className="contract-mapping-overview">
                  <div><strong>{requiredMapped === requiredFields.length ? "Required fields covered" : `${requiredFields.length - requiredMapped} required ${requiredFields.length - requiredMapped === 1 ? "field" : "fields"} unmapped`}</strong><span>A mapping copies the source value directly. It does not coerce or transform data.</span></div>
                  <dl>
                    <div><dt>Required</dt><dd>{requiredMapped}/{requiredFields.length}</dd></div>
                    <div><dt>Optional</dt><dd>{mappedCount - requiredMapped}/{fields.length - requiredFields.length}</dd></div>
                  </dl>
                </div>
                <div className="contract-mapping-columns" aria-hidden="true"><span>Contract field</span><span>Source field</span><span>Validation</span></div>
                {fields.map((field) => {
                  const mapped = mappingForContractField(implementation, field);
                  const fieldIssue = implementationIssues.find((issue) => issue.field === field.reference);
                  const mappedField = matchingContractTypeField(typeFields, mapped);
                  const assessment = assessContractFieldMapping(field, mappedField);
                  const displayed = fieldIssue
                    ? {
                        level: fieldIssue.level,
                        label: fieldIssue.level === "error" ? "Fix mapping" : "Review",
                        message: fieldIssue.message
                      }
                    : assessment;
                  const options = typeFields.map((option) => ({
                    option,
                    assessment: assessContractFieldMapping(field, option)
                  }));
                  const compatible = options.filter((option) => option.assessment.level === "valid");
                  const review = options.filter((option) => option.assessment.level === "warning");
                  const incompatible = options.filter((option) => option.assessment.level === "error");
                  const mappedMissing = Boolean(mapped) && !mappedField;
                  return <div className={`contract-mapping-row ${displayed.level}`} key={field.reference}>
                    <div className="contract-field-definition">
                      <div><code>{field.reference}</code><span className={field.required ? "required" : ""}>{field.required ? "Required" : "Optional"}</span></div>
                      <small>{field.description || `${kindName(field.kind)} value`}</small>
                    </div>
                    <label className="contract-field-source">
                      <span className="sr-only">{implementation.contract} {field.reference} source field</span>
                      <SelectControl
                        aria-label={`${implementation.contract} ${field.reference} type field`}
                        aria-invalid={displayed.level === "error" || undefined}
                        value={mapped}
                        onChange={(event) => onChange((current) => setTypeContractFieldMapping(
                          current,
                          implementation.contract,
                          implementation.version,
                          field.reference,
                          event.target.value || undefined
                        ))}
                      >
                        <option value="">{field.required ? "Choose a source field" : "Not exposed"}</option>
                        {mappedMissing && <option value={mapped}>Missing field: {mapped}</option>}
                        <MappingOptionGroup label="Compatible fields" options={compatible} />
                        <MappingOptionGroup label="Needs review" options={review} />
                        <MappingOptionGroup label="Incompatible fields" options={incompatible} disabled />
                      </SelectControl>
                      {mappedField && <small>{kindName(mappedField.kind)} · {mappedField.required ? "always present" : "optional in this type"}</small>}
                    </label>
                    <div className={`contract-mapping-validation ${displayed.level}`} role={displayed.level === "error" ? "alert" : undefined}>
                      {displayed.level === "valid"
                        ? <Check aria-hidden="true" />
                        : displayed.level === "unmapped"
                          ? <span className="contract-status-dot" aria-hidden="true" />
                          : <CircleAlert aria-hidden="true" />}
                      <span><strong>{displayed.label}</strong><small>{displayed.message}</small></span>
                    </div>
                  </div>;
                })}
              </div> : <div className="contract-composed-schema">
                <p>This contract does not expose simple top-level properties. Configure its field references in YAML.</p>
                <button onClick={onOpenYaml}>Open YAML</button>
              </div>}
            </details>
            {contract.bindingSchema && <details
              className="contract-settings"
              open={bindingIssues.length > 0 || openSettings.has(implementationKey)}
              onToggle={(event) => {
                if (bindingIssues.length > 0) return;
                const open = event.currentTarget.open;
                setOpenSettings((current) => {
                  const next = new Set(current);
                  if (open) next.add(implementationKey);
                  else next.delete(implementationKey);
                  return next;
                });
              }}
            >
              <summary>
                <span>Contract settings</span>
                <small>{implementation.binding ? "Configured" : bindingIssues.length ? "Setup required" : "Optional"}</small>
                <ChevronRight aria-hidden="true" />
              </summary>
              <div className="contract-settings-body">
                <div className="contract-settings-intro">
                  <div>
                    <strong>Application behavior</strong>
                    <p>Control how compatible apps interpret and act on this type. Values are checked against the contract’s schema.</p>
                  </div>
                  <button type="button" onClick={onOpenYaml}>Edit YAML</button>
                </div>
                {implementation.binding || openSettings.has(implementationKey)
                  ? <SchemaValueEditor
                      name={`${implementation.contract} settings`}
                      schema={contract.bindingSchema}
                      rootSchema={contract.bindingSchema}
                      value={implementation.binding ?? {}}
                      required
                      hideLabel
                      onChange={(next) => {
                        if (!isJsonObject(next)) return;
                        onChange((current) => setTypeContractBinding(
                          current,
                          implementation.contract,
                          implementation.version,
                          next
                        ));
                      }}
                    />
                  : <div className="contract-settings-empty">
                      <p>Set the contract’s required behavior choices before saving this type.</p>
                      <button type="button" onClick={() => {
                        const initial = schemaInitialValue(contract.bindingSchema, contract.bindingSchema);
                        if (!isJsonObject(initial)) return;
                        setOpenSettings((current) => new Set(current).add(implementationKey));
                        onChange((current) => setTypeContractBinding(
                          current,
                          implementation.contract,
                          implementation.version,
                          initial
                        ));
                      }}>Configure settings</button>
                    </div>}
              </div>
            </details>}
            <details className="contract-view-preview">
              <summary>
                <span>Application view</span>
                <small>{mappedCount} {mappedCount === 1 ? "value" : "values"} exposed</small>
                <ChevronRight aria-hidden="true" />
              </summary>
              <div className="contract-preview-body">
                <p>Apps read these contract field names while your notes keep their own field names.</p>
                <pre>{JSON.stringify(contractViewPreview(implementation), null, 2)}</pre>
              </div>
            </details>
          </>}
          {implementationIssues.filter((issue) => !issue.field).map((issue, index) =>
            <p className={`contract-issue ${issue.level}`} role={issue.level === "error" ? "alert" : undefined} key={`${issue.message}:${index}`}>{issue.message}</p>)}
        </article>;
      })}
    </div>}

    {available.length > 0 && (!creating || implementations.length > 0) && <div className="contract-add">
      <label><span>Installed contract</span><SelectControl
        aria-label="Installed contract"
        value={selected ? contractKey(selected) : ""}
        onChange={(event) => setSelectedKey(event.target.value)}
      >{available.map((contract) => <option key={contractKey(contract)} value={contractKey(contract)}>{contract.id} · {contract.version}</option>)}</SelectControl></label>
      <button disabled={!selected} onClick={() => selected && addContract(selected)}><Plus aria-hidden="true" />Connect application contract</button>
    </div>}

    {suggestions.length > 0 && <div className="contract-suggestions">
      <div className="contract-suggestion-heading"><div><strong>Possible app compatibility</strong><p>Suggested from field names and shapes only. Confirm that the meanings agree.</p></div></div>
      {suggestions.map((suggestion) => <div className="contract-suggestion" key={contractKey(suggestion.contract)}>
        <div><strong>{suggestion.contract.id}</strong><span>{suggestion.contract.version}</span></div>
        <p>{suggestion.matchedFields} of {suggestion.totalFields} fields match{suggestion.requiredFields ? `, ${suggestion.requiredMatched} of ${suggestion.requiredFields} required` : ""}.</p>
        <button onClick={() => addContract(suggestion.contract)}>Review mapping</button>
      </div>)}
    </div>}

    {globalIssues.length > 0 && <div className="contract-global-issues">
      {globalIssues.map((issue, index) =>
        <p role={issue.level === "error" ? "alert" : undefined} key={`${issue.message}:${index}`}>{issue.message}</p>)}
      <button onClick={onOpenYaml}>Open YAML</button>
    </div>}
  </TypeEditorDisclosure>;
}

function MappingOptionGroup({ label, options, disabled = false }: {
  label: string;
  options: Array<{
    option: ContractTypeField;
    assessment: ReturnType<typeof assessContractFieldMapping>;
  }>;
  disabled?: boolean;
}) {
  if (!options.length) return null;
  return <optgroup label={label}>
    {options.map(({ option }) =>
      <option disabled={disabled} key={option.reference} value={option.reference}>
        {option.label} · {kindName(option.kind)}{option.required ? " · required" : ""}
      </option>)}
  </optgroup>;
}

function matchingContractTypeField(
  fields: ContractTypeField[],
  reference: string
): ContractTypeField | undefined {
  if (!reference) return undefined;
  const normalized = reference.startsWith("/")
    ? reference.slice(1).split("/")
      .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
      .join(".")
    : reference;
  return fields.find((field) =>
    field.reference === reference
    || field.label === reference
    || field.label === normalized);
}

function ContractCatalogBrowser({ catalog, contracts, types, loading, error, canInstall, onInstall, onOpenType, onRequestAccess, onReload }: {
  catalog?: ContractCatalog;
  contracts: CollectionContractDescriptor[];
  types: CollectionTypeDescriptor[];
  loading: boolean;
  error?: string;
  canInstall: boolean;
  onInstall?: (pack: ContractCatalogPack) => Promise<void>;
  onOpenType?: (name: string) => void;
  onRequestAccess?: () => void;
  onReload?: () => void;
}) {
  const [confirmingKey, setConfirmingKey] = useState<string>();
  const [installingKey, setInstallingKey] = useState<string>();
  const [installError, setInstallError] = useState<{ key: string; message: string }>();
  const [showAdvanced, setShowAdvanced] = useState(false);

  async function install(pack: ContractCatalogPack) {
    if (!onInstall) return;
    const key = `${pack.id}@${pack.version}`;
    setInstallingKey(key);
    setInstallError(undefined);
    try {
      await onInstall(pack);
      setConfirmingKey(undefined);
    } catch (error) {
      setInstallError({
        key,
        message: error instanceof Error ? error.message : "The type pack could not be installed."
      });
    } finally {
      setInstallingKey(undefined);
    }
  }

  const visiblePacks = catalog?.packs.filter((pack) => pack.visibility !== "hidden") ?? [];
  const standardPacks = visiblePacks.filter((pack) => pack.visibility === "default");
  const advancedPacks = visiblePacks.filter((pack) => pack.visibility === "advanced");

  function renderPack(pack: ContractCatalogPack) {
    const key = `${pack.id}@${pack.version}`;
    const status = contractCatalogPackStatus(pack, contracts, types);
    const statusLabel = status === "installed"
      ? pack.primaryType ? `${pack.displayName} added` : "Installed"
      : status === "partial"
        ? "Partly installed"
        : pack.installedTypes.length === 1
          ? "Adds 1 type"
          : `Adds ${pack.installedTypes.length} types`;
    const confirming = confirmingKey === key;
    const installing = installingKey === key;
    const addLabel = status === "partial"
      ? `Finish adding ${pack.displayName}`
      : pack.primaryType
        ? `Add ${pack.displayName}`
        : "Install runtime pack";
    const icon = isPhosphorIconName(pack.icon)
      ? <PhosphorIcon name={pack.icon} aria-hidden="true" />
      : <Package aria-hidden="true" />;
    const primaryTypeLabel = pack.installedTypes
      .find(({ name }) => name === pack.primaryType)?.label ?? pack.displayName;
    const confirmationCopy = pack.primaryType
      ? `Creates a ready-to-use ${primaryTypeLabel} type with standard fields and an editable contract mapping. Existing files will not be overwritten; installation stops if any target conflicts.`
      : `Adds ${pack.installedTypes.length} internal types and ${pack.resourceCount} declared resources in one validated transaction. Existing files will not be overwritten; installation stops if any target conflicts.`;

    return <div className={`contract-catalog-pack ${pack.visibility}`} key={key}>
      <div className="contract-catalog-pack-summary">
        <span className="contract-catalog-pack-icon">{icon}</span>
        <div className="contract-catalog-pack-copy">
          <div className="contract-catalog-pack-title">
            <strong>{pack.displayName}</strong>
            {pack.badges.map((badge) => <span key={badge}>{badge}</span>)}
          </div>
          <p>{pack.summary}</p>
          <div className={`contract-catalog-pack-status ${status}`}>
            {status === "installed" && <Check aria-hidden="true" />}
            <span>{statusLabel}</span>
          </div>
        </div>
        <div className="contract-catalog-pack-actions">
          {status === "installed" && pack.primaryType && onOpenType
            ? <button onClick={() => onOpenType(pack.primaryType!)}>Open {primaryTypeLabel}</button>
            : status !== "installed" && onInstall && (canInstall
              ? <button
                  disabled={installing}
                  onClick={() => {
                    setInstallError(undefined);
                    setConfirmingKey(key);
                  }}
                >{addLabel}</button>
              : onRequestAccess && <button onClick={onRequestAccess}>Allow installs</button>)}
        </div>
      </div>
      {pack.caution && <div className="contract-catalog-pack-caution">
        <CircleAlert aria-hidden="true" />
        <p>{pack.caution}</p>
      </div>}
      <details className="contract-catalog-pack-details">
        <summary>Technical details</summary>
        <div>
          <p><span>Pack</span><code>{pack.id}@{pack.version}</code></p>
          <p><span>Contents</span>{pack.provides.length} {pack.provides.length === 1 ? "contract" : "contracts"} · {pack.resourceCount} resources</p>
          <a href={pack.provisionUrl} target="_blank" rel="noreferrer">View pack JSON</a>
        </div>
      </details>
      {confirming && <div className="contract-catalog-install-confirm" role="alert">
        <div>
          <strong>{addLabel}?</strong>
          <p>{confirmationCopy}</p>
        </div>
        <button disabled={installing} onClick={() => setConfirmingKey(undefined)}>Cancel</button>
        <button className="confirm-pack-install" disabled={installing} onClick={() => void install(pack)}>
          {installing ? "Installing…" : addLabel}
        </button>
      </div>}
      {installError?.key === key && <div className="contract-catalog-install-error" role="alert">
        <div><strong>Couldn’t install {pack.displayName}</strong><p>{installError.message}</p></div>
        <button onClick={() => setConfirmingKey(key)}>Try again</button>
      </div>}
    </div>;
  }

  return <div className="contract-catalog">
    <div className="contract-catalog-heading">
      <div>
        <strong>{catalog ? `From ${catalog.publisher.name}` : "mdbase catalog"}</strong>
        <p>Each choice includes its portable contract and an editable local mapping.</p>
      </div>
      {catalog && <a href={catalog.sourceUrl} target="_blank" rel="noreferrer">Catalog source</a>}
    </div>
    {loading && <div className="contract-catalog-loading" role="status" aria-label="Loading contract catalog">
      <span /><span /><span />
    </div>}
    {error && !loading && <div className="contract-catalog-error" role="alert">
      <div><strong>Catalog unavailable</strong><p>{error}</p></div>
      {onReload && <button onClick={onReload}>Try again</button>}
    </div>}
    {catalog && !loading && <div className="contract-catalog-packs">
      {standardPacks.map(renderPack)}
      {!standardPacks.length && !advancedPacks.length
        && <p className="quiet-empty">The catalog has no published types.</p>}
      {advancedPacks.length > 0 && <section className="contract-catalog-advanced">
        <button
          className="contract-catalog-advanced-toggle"
          aria-expanded={showAdvanced}
          onClick={() => setShowAdvanced((current) => !current)}
        >
          <span>
            <strong>Developer and infrastructure packs</strong>
            <small>For integrations and specialised setups</small>
          </span>
          <span>{advancedPacks.length}</span>
          <ChevronDown aria-hidden="true" />
        </button>
        {showAdvanced && <div className="contract-catalog-advanced-packs">
          {advancedPacks.map(renderPack)}
        </div>}
      </section>}
    </div>}
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

  return <TypeEditorDisclosure
    className="collection-behaviour-section"
    title="Collection behaviour"
    description="How this type appears and behaves across compatible tools."
    summary={collectionBehaviourSummary(definition)}
  >

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
            <InlineRemoveButton className="collection-rule-remove" label={`Remove read default for ${entry.field}`} onClick={() => onChange((source) => removeTypeReadDefault(source, entry.field))} />
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
            <label><span>Format</span><SelectControl
              aria-label={`${rule.field} link format`}
              value={rule.format ?? ""}
              onChange={(event) => onChange((source) => setTypeLinkRule(source, rule.field, "format", (event.target.value || undefined) as TypeLinkFormat | undefined))}
            >
              <option value="">Any supported format</option>
              <option value="wikilink">Wikilink</option>
              <option value="markdown">Markdown link</option>
              <option value="path">Path</option>
              <option value="any">Any</option>
            </SelectControl></label>
            <label className="collection-toggle"><input
              type="checkbox"
              checked={rule.validateExists}
              onChange={(event) => onChange((source) => setTypeLinkRule(source, rule.field, "validate_exists", event.target.checked || undefined))}
            /><span>Require an existing target</span></label>
            <InlineRemoveButton className="collection-rule-remove" label={`Remove link rule for ${rule.field}`} onClick={() => onChange((source) => removeTypeLinkRule(source, rule.field))} />
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
          <label><span>Scope</span><SelectControl
            aria-label={`${rule.field} uniqueness scope`}
            value={rule.scope ?? ""}
            onChange={(event) => onChange((source) => setTypeUniqueRule(source, rule.sourceIndex, "scope", (event.target.value || undefined) as TypeUniqueScope | undefined))}
          >
            <option value="">Choose scope</option>
            <option value="type">This type</option>
            <option value="collection">Entire collection</option>
            <option value="path_glob">Path pattern</option>
          </SelectControl></label>
          {rule.scope === "path_glob" && <label className="collection-unique-path"><span>Path pattern</span><input
            aria-label={`${rule.field} uniqueness path pattern`}
            value={rule.pathGlob ?? ""}
            placeholder="Projects/**/*.md"
            onChange={(event) => onChange((source) => setTypeUniqueRule(source, rule.sourceIndex, "path_glob", event.target.value || undefined))}
          /></label>}
          <InlineRemoveButton className="collection-rule-remove" label={`Remove uniqueness rule for ${rule.field}`} onClick={() => onChange((source) => removeTypeUniqueRule(source, rule.sourceIndex))} />
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
  </TypeEditorDisclosure>;
}

function typeMembershipSummary(definition: VisualTypeDefinition): string {
  const rules = [
    countSummary(definition.pathGlobs.length, "path pattern"),
    countSummary(definition.fieldsPresent.length, "field selector"),
    countSummary(definition.advancedMatchKeys.length, "YAML rule")
  ].filter((value): value is string => Boolean(value));
  return rules.length ? rules.join(" · ") : "Explicit declarations only";
}

function membershipFieldSuggestions(
  source: string,
  typeSchema: CollectionTypeDescriptor["schema"] | undefined,
  notes: NoteSummary[],
  explicitTypeKeys: string[]
): string[] {
  const explicitKeys = new Set(explicitTypeKeys);
  const suggestions = new Set(
    typeFieldsForContracts(source, typeSchema)
      .map((field) => field.reference)
      .filter((reference) => !explicitKeys.has(reference))
  );
  for (const note of notes) {
    for (const key of Object.keys(note.frontmatter)) {
      if (!explicitKeys.has(key)) suggestions.add(key);
    }
  }
  return [...suggestions].sort((left, right) => left.localeCompare(right)).slice(0, 100);
}

function membershipPathSuggestions(notes: NoteSummary[]): string[] {
  const suggestions = new Set<string>();
  for (const note of notes) {
    const parts = note.path.replaceAll("\\", "/").split("/").slice(0, -1);
    if (!parts.length) continue;
    suggestions.add(`${parts[0]}/**/*.md`);
    if (parts.length > 1) suggestions.add(`${parts.join("/")}/**/*.md`);
  }
  return [...suggestions].sort((left, right) => left.localeCompare(right)).slice(0, 50);
}

function TypeMembershipPreview({ impact, advanced = false, afterUpdate = false }: {
  impact: TypeMembershipImpact;
  advanced?: boolean;
  afterUpdate?: boolean;
}) {
  if (!impact.complete) return <div className="type-membership-preview incomplete">
    <div>
      <strong>{impact.current.toLocaleString()} currently indexed {impact.current === 1 ? "note matches" : "notes match"}</strong>
      <p>The after-save preview is unavailable because {advanced ? "additional YAML rules" : "some matching rules"} must be evaluated by the collection.</p>
    </div>
  </div>;
  const next = impact.next ?? 0;
  const changed = impact.addedPaths.length + impact.removedPaths.length;
  return <div className="type-membership-preview">
    <div>
      <strong>{next.toLocaleString()} {next === 1 ? "note" : "notes"} {afterUpdate ? "after update" : "with these rules"}</strong>
      <p>{impact.current.toLocaleString()} now · {impact.addedPaths.length.toLocaleString()} gain this type · {impact.removedPaths.length.toLocaleString()} lose it{impact.overlapping ? ` · ${impact.overlapping.toLocaleString()} also ${impact.overlapping === 1 ? "matches" : "match"} another type` : ""}</p>
    </div>
    {changed > 0 && <details>
      <summary>Show affected notes</summary>
      <div className="type-membership-paths">
        {impact.addedPaths.slice(0, 10).map((path) => <p key={`added:${path}`}><span>Gains</span><code>{path}</code></p>)}
        {impact.removedPaths.slice(0, 10).map((path) => <p key={`removed:${path}`}><span>Loses</span><code>{path}</code></p>)}
        {changed > 20 && <p><span>More</span>{(changed - 20).toLocaleString()} additional notes</p>}
      </div>
    </details>}
  </div>;
}

function collectionBehaviourSummary(definition: VisualTypeDefinition): string {
  const collection = definition.collection;
  const displayConfigured = Object.values(collection.display).some(Boolean);
  const pathConfigured = Boolean(collection.path.pattern || collection.path.folder || collection.path.template);
  const settings = [
    displayConfigured ? "Display" : undefined,
    countSummary(collection.readDefaults.length, "default"),
    countSummary(collection.links.length, "link"),
    countSummary(collection.unique.length, "unique rule"),
    pathConfigured ? "Path policy" : undefined,
    countSummary(collection.advancedKeys.length + collection.path.advancedKeys.length, "YAML setting")
  ].filter((value): value is string => Boolean(value));
  return settings.length ? settings.join(" · ") : "No custom behaviour";
}

function countSummary(count: number, singular: string): string | undefined {
  if (!count) return undefined;
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
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
  return <label><span>{visibleLabel ?? label}</span><SelectControl aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
    {allowEmpty && <option value="">Not set</option>}
    {options.map((field) => <option key={field.value} value={field.value}>{field.label}</option>)}
  </SelectControl></label>;
}

function DefaultValueEditor({ field, node, value, onChange }: {
  field: string;
  node?: TypeSchemaNode;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  if (node?.kind === "boolean" && typeof value === "boolean") {
    return <label><span>Default value</span><SelectControl aria-label={`Default value for ${field}`} value={String(value)} onChange={(event) => onChange(event.target.value === "true")}>
      <option value="true">True</option>
      <option value="false">False</option>
    </SelectControl></label>;
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

function VisualFieldRow({ field, source, depth, activeField, onActivate, onChange }: {
  field: TypeFieldDefinition;
  source: string;
  depth: number;
  activeField?: string;
  onActivate: (field?: string) => void;
  onChange: (change: (source: string) => string) => void;
}) {
  const [pendingKind, setPendingKind] = useState<Exclude<TypeFieldKind, "advanced">>();
  const conversionImpact = pendingKind ? typeFieldConversionImpact(source, field.path, pendingKind) : [];
  const fieldLabel = typeFieldPathLabel(field.path);
  const expanded = fieldBranchIsActive(activeField, fieldLabel);
  function chooseKind(kind: TypeFieldKind) {
    if (kind === "advanced" || kind === field.kind) return;
    const nextKind = kind as Exclude<TypeFieldKind, "advanced">;
    if (typeFieldConversionImpact(source, field.path, nextKind).length) {
      setPendingKind(nextKind);
      onActivate(fieldLabel);
    } else {
      onChange((current) => setTypeFieldKind(current, field.path, nextKind));
      if (nextKind === "object" || nextKind === "array") onActivate(fieldLabel);
    }
  }
  return <div className="visual-field-branch" style={{ "--field-depth": depth } as CSSProperties}>
    <div className="visual-field-row">
      <button className="field-disclosure" aria-label={`${expanded ? "Collapse" : "Expand"} ${fieldLabel} field`} aria-expanded={expanded} onClick={() => onActivate(expanded ? undefined : fieldLabel)}>
        {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
      </button>
      <label className="visual-field-name"><span className="sr-only">Field name</span><input defaultValue={field.name} onBlur={(event) => onChange((current) => renameTypeField(current, field.path, event.target.value))} spellCheck="false" /></label>
      <label className="visual-field-kind"><span className="sr-only">{fieldLabel} field kind</span><SelectControl value={field.kind} onChange={(event) => chooseKind(event.target.value as TypeFieldKind)}>
        <KindOptions current={field.kind} />
      </SelectControl></label>
      <label className="visual-field-required"><input type="checkbox" checked={field.required} onChange={(event) => onChange((current) => setTypeFieldRequired(current, field.path, event.target.checked))} /><span>Required</span></label>
      <InlineRemoveButton className="remove-type-field" label={`Remove ${fieldLabel} field`} onClick={() => onChange((current) => removeTypeField(current, field.path))} />
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
      {field.kind === "object" && <ObjectFields node={field} source={source} depth={depth + 1} activeField={activeField} onActivate={onActivate} onChange={onChange} />}
      {field.kind === "array" && field.item && <ListItemEditor item={field.item} source={source} depth={depth + 1} activeField={activeField} onActivate={onActivate} onChange={onChange} />}
    </div>}
  </div>;
}

function ObjectFields({ node, source, depth, activeField, onActivate, onChange }: {
  node: TypeSchemaNode;
  source: string;
  depth: number;
  activeField?: string;
  onActivate: (field?: string) => void;
  onChange: (change: (source: string) => string) => void;
}) {
  return <div className="nested-field-group">
    <div className="nested-field-heading"><div><strong>Nested fields</strong><span>{node.constraints.additionalProperties === false ? "Only declared fields are allowed" : "Other fields are allowed"}</span></div><button onClick={() => onChange((current) => addTypeField(current, node.path))}><Plus aria-hidden="true" />Add nested field</button></div>
    {node.fields.map((field) => <VisualFieldRow
      key={typeFieldPathLabel(field.path)}
      field={field}
      source={source}
      depth={depth}
      activeField={activeField}
      onActivate={onActivate}
      onChange={onChange}
    />)}
    {!node.fields.length && <p className="nested-field-empty">No nested fields yet.</p>}
  </div>;
}

function ListItemEditor({ item, source, depth, activeField, onActivate, onChange }: {
  item: TypeSchemaNode;
  source: string;
  depth: number;
  activeField?: string;
  onActivate: (field?: string) => void;
  onChange: (change: (source: string) => string) => void;
}) {
  const [pendingKind, setPendingKind] = useState<Exclude<TypeFieldKind, "advanced">>();
  const itemLabel = typeFieldPathLabel(item.path);
  const impact = pendingKind ? typeFieldConversionImpact(source, item.path, pendingKind) : [];
  return <div className="list-item-editor">
    <div className="list-item-heading">
      <div><strong>List items</strong><span>{itemLabel}</span></div>
      <label><span className="sr-only">{itemLabel} kind</span><SelectControl value={item.kind} onChange={(event) => {
        const kind = event.target.value as TypeFieldKind;
        if (kind === "advanced" || kind === item.kind) return;
        const nextKind = kind as Exclude<TypeFieldKind, "advanced">;
        if (typeFieldConversionImpact(source, item.path, nextKind).length) setPendingKind(nextKind);
        else onChange((current) => setTypeListItemKind(current, item.path.slice(0, -1), nextKind));
      }}><KindOptions current={item.kind} /></SelectControl></label>
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
    {item.kind === "object" && <ObjectFields node={item} source={source} depth={depth} activeField={activeField} onActivate={onActivate} onChange={onChange} />}
    {item.kind === "array" && item.item && <ListItemEditor item={item.item} source={source} depth={depth + 1} activeField={activeField} onActivate={onActivate} onChange={onChange} />}
    {item.advancedKeys.length > 0 && <p className="advanced-item-note">Additional item rules remain in YAML.</p>}
  </div>;
}

function fieldBranchIsActive(activeField: string | undefined, field: string): boolean {
  return activeField === field
    || Boolean(activeField?.startsWith(`${field}.`))
    || Boolean(activeField?.startsWith(`${field}[]`));
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

  const suggestedValues = [...new Set(suggestions ?? [])];

  return <div className="string-list-editor">
    <div className="string-list-heading"><span>{label}</span><button onClick={addItem}><Plus aria-hidden="true" />{addLabel}</button></div>
    {helper && <small>{helper}</small>}
    <div className="string-list-items" ref={list}>
      {drafts.map((value, index) => <div className="string-list-item" key={index}>
        <span aria-hidden="true">{index + 1}</span>
        <div className="string-list-input">
          <ComboboxInput
            label={`${itemLabel} ${index + 1}`}
            listLabel={`${itemLabel} suggestions`}
            value={value}
            options={suggestedValues}
            placeholder={placeholder}
            spellCheck={false}
            onValueChange={(next) => {
              setDrafts((current) => current.map((item, itemIndex) => itemIndex === index ? next : item));
              setDirty(true);
            }}
            onOptionSelect={(suggestion) => {
              commit(drafts.map((item, itemIndex) => itemIndex === index ? suggestion : item));
            }}
            onInputBlur={() => {
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
            onInputKeyDown={(event) => {
              if (event.key !== "Enter" || !event.currentTarget.value.trim()) return;
              event.preventDefault();
              skipBlur.current = true;
              commit(drafts, true);
            }}
          />
        </div>
        <InlineRemoveButton className="string-list-remove" label={`Remove ${itemLabel.toLocaleLowerCase()} ${index + 1}`} onMouseDown={(event) => event.preventDefault()} onClick={() => commit(drafts.filter((_, itemIndex) => itemIndex !== index))} />
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
    <TypeMembershipPreview impact={impact.membership} afterUpdate />
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

function kindName(kind: TypeFieldKind): string {
  if (kind === "advanced") return "Advanced";
  const label = kindLabel(kind);
  return `${label.charAt(0).toLocaleUpperCase()}${label.slice(1)}`;
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

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
