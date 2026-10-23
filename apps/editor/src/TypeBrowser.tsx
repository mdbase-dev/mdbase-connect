import { i18n } from "@lingui/core";
import { displayLocale } from "./i18n/format";
import { Trans } from "@lingui/react/macro";
import { t, plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
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
import { ActionMenu } from "./ActionMenu";
import { ComboboxInput } from "./SelectionControls";
import { SaveNotice } from "@mdbase-dev/ui/save-notice";
import { PathLabel } from "./WorkspaceChrome";
import { useDelayedBusy } from "./use-delayed-busy";
import { kindLabel, kindName, countSummary, collectionBehaviourSummary } from "./type-presentation";
import { Select, type SelectItems, type SelectOption } from "@mdbase-dev/ui/select";
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
import { compareLines } from "@mdbase-dev/ui/text-diff";
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
  onCreate?: () => void;
  onCollections: () => void;
}) {
  useLingui();
  const [search, setSearch] = useState("");
  const visible = types.filter((type) => `${type.name} ${type.description ?? ""}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  return <section className="type-list-pane" aria-label={t`Types`}>
    <header className="list-header">
      <button className="mobile-collections icon-button" aria-label={t`Collections`} onClick={onCollections}><PanelLeft aria-hidden="true" /></button>
      {leadingActions}
      <div><h1><Trans>Types</Trans></h1><p>{plural(types.length, { one: "# definition", other: "# definitions" })}</p></div>
      {trailingActions}
    </header>
    <label className="search-field">
      <Search aria-hidden="true" /><span className="sr-only"><Trans>Search types</Trans></span>
      <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t`Search types`} />
      {search && <button aria-label={t`Clear type search`} onClick={() => setSearch("")}><X aria-hidden="true" /></button>}
    </label>
    <nav className="type-resource-nav" aria-label={t`Type resources`}>
      <button className={`type-pack-entry${packsSelected ? " selected" : ""}`} aria-current={packsSelected ? "page" : undefined} onClick={onPacks}>
        <span className="type-row-icon"><Package aria-hidden="true" /></span>
        <span className="type-row-copy"><strong><Trans>Add a type</Trans></strong><small>{onCreate ? t`Start blank or from a ready-made type` : t`Browse ready-made types`}</small></span>
        <ChevronRight aria-hidden="true" />
      </button>
    </nav>
    <div className={`type-list${!visible.length ? " empty" : ""}`} role="listbox" aria-label={t`Collection types`}>
      {visible.map((type) => <button key={type.name} role="option" aria-selected={selectedName === type.name} className={`type-row${selectedName === type.name ? " selected" : ""}`} onClick={() => onSelect(type.name)}>
        <span className="type-row-icon">{isPhosphorIconName(collectionTypeIcon(type))
          ? <PhosphorIcon name={collectionTypeIcon(type)} aria-hidden="true" />
          : <FileCode2 aria-hidden="true" />}</span>
        <span className="type-row-copy"><strong>{type.name}</strong><small>{type.description || t`${propertyCount(type)} schema properties`}</small></span>
      </button>)}
      {!visible.length && <p className="quiet-empty">{types.length ? t`No types found.` : t`This collection has no type definitions yet.`}</p>}
    </div>
  </section>;
}

export function TypePackBrowser({ types, contracts, catalog, loading = false, error, canInstall = false, leadingActions, onCreate, onInstall, onOpenType, onRequestAccess, onReload, onBack }: {
  types: CollectionTypeDescriptor[];
  contracts: CollectionContractDescriptor[];
  catalog?: ContractCatalog;
  loading?: boolean;
  error?: string;
  canInstall?: boolean;
  leadingActions?: ReactNode;
  onCreate?: () => void;
  onInstall?: (pack: ContractCatalogPack) => Promise<void>;
  onOpenType?: (name: string) => void;
  onRequestAccess?: () => void;
  onReload?: () => void;
  onBack: () => void;
}) {
  useLingui();
  return <main className="type-inspector type-pack-browser" aria-label={t`Add a type`}>
    <header className="type-inspector-bar">
      <button className="mobile-back icon-button" aria-label={t`Back to types`} onClick={onBack}><ArrowLeft aria-hidden="true" /></button>
      {leadingActions}
      <span><Trans>Collection resources</Trans></span>
      <small><Trans>Catalog</Trans></small>
    </header>
    <section className="type-heading">
      <p className="eyebrow"><Trans>Collection resources</Trans></p>
      <div className="type-heading-title">
        <Package aria-hidden="true" />
        <h1><Trans>Add a type</Trans></h1>
      </div>
      <p><Trans>Start from an empty definition, or choose a ready-made type and adapt its fields and contract mapping to fit your collection.</Trans></p>
    </section>
    <section className="type-pack-document">
      {onCreate && <button className="type-blank-button" aria-label={t`New type`} aria-describedby="type-blank-description" onClick={onCreate}><FilePlus2 aria-hidden="true" /><span><strong><Trans>New type</Trans></strong><small id="type-blank-description"><Trans>Start from an empty definition and add your own fields.</Trans></small></span><ChevronRight aria-hidden="true" /></button>}
      <div className="type-pack-intro">
        <h2><Trans>Ready-made types</Trans></h2>
        <p><Trans>Adding one creates a new editable type. Existing files are never overwritten.</Trans></p>
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

export function TypeInspector({ readOnly = false, type, availableTypes = [], contracts = [], document, source, notes, explicitTypeKeys = ["type", "types"], creating, loading, saving, error, leadingActions, onSourceChange, onSave, onRevert, onCancel, onCreate, onBrowsePacks, onOpenSettings, onBack }: {
  readOnly?: boolean;
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
  onCreate?: () => void;
  onBrowsePacks?: () => void;
  onOpenSettings?: () => void;
  onBack: () => void;
}) {
  useLingui();
  const slowSave = useDelayedBusy(saving, document?.path);
  const [view, setView] = useState<"visual" | "yaml">("visual");
  const [reviewing, setReviewing] = useState(false);
  const [visualError, setVisualError] = useState<string>();
  const dirty = creating ? source.trim().length > 0 : Boolean(document && source !== document.document);
  const parsed = useMemo(() => parseVisualType(source), [source, i18n.locale]);
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
  }, [contracts, parsed.value, source, type?.schema, i18n.locale]);
  const contractErrors = contractState.issues.filter((issue) => issue.level === "error");
  const impact = useMemo(() => parsed.value
    ? typeImpact(document?.document, source, notes, type?.name, explicitTypeKeys)
    : undefined, [document?.document, explicitTypeKeys.join("\u0000"), notes, parsed.value, source, type?.name, i18n.locale]);
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
      setVisualError(changeError instanceof Error ? changeError.message : t`That field could not be changed.`);
    }
  }

  if (!creating && !type) return <main className="type-inspector empty-type">{leadingActions && <div className="empty-pane-actions">{leadingActions}</div>}<div><p><Trans>This collection has no type definitions.</Trans></p>{onCreate && <button className="empty-type-create mdbase-button is-primary" onClick={onCreate}><Trans>Create the first type</Trans></button>}</div></main>;
  const name = creating ? t`New type` : type!.name;
  const path = creating ? t`A path will be created from the type name` : document?.path ?? type!.path ?? `_types/${type!.name}.md`;
  return <main className="type-inspector" aria-label={t`${name} type definition`}>
    <header className="type-inspector-bar mdbase-settle-host">
      <button className="mobile-back icon-button" aria-label={t`Back to types`} onClick={onBack}><ArrowLeft aria-hidden="true" /></button>
      {leadingActions}
      <details className="type-file-details">
        <summary><Trans>Details</Trans></summary>
        <PathLabel path={path} />
        {!creating && <p>{typeHeadingFacts(type!, contractState.implementations.length)}</p>}
      </details>
      {(error || slowSave) && <SaveNotice tone={error ? "attention" : "saving"} label={error ? t`Needs attention` : t`Saving…`} />}
    </header>
    <section className="type-heading">
      <div className="type-heading-title">
        {!creating && isPhosphorIconName(collectionTypeIcon(type)) && <PhosphorIcon name={collectionTypeIcon(type)} aria-hidden="true" />}
        <h1>{name}</h1>
      </div>
      {creating ? <p><Trans>Give the type a name, then add the fields its notes need.</Trans></p> : type!.description && <p>{type!.description}</p>}
      {!creating && <p className="type-heading-facts">{countSummary(propertyCount(type!), "field")}</p>}
    </section>
    <section className="type-source">
      {reviewing ? <div className="type-source-context reviewing">
        <div className="type-source-intro"><h2><Trans>Review changes</Trans></h2><p><Trans>Confirm the collection-wide effect before saving.</Trans></p></div>
      </div> : <div className="type-source-context">
          <div className="type-source-intro"><h2><Trans>Definition</Trans></h2><p><Trans>Design the note shape or work with its complete YAML source.</Trans></p></div>
          {!readOnly && <><div className="type-view-switch" role="group" aria-label={t`Type editor view`}>
            <button className={view === "visual" ? "selected" : ""} aria-pressed={view === "visual"} onClick={() => { setView("visual"); setReviewing(false); }}><Trans>Design</Trans></button>
            <button className={view === "yaml" ? "selected" : ""} aria-pressed={view === "yaml"} onClick={() => { setView("yaml"); setReviewing(false); }}><Trans>YAML</Trans></button>
          </div>
          <div className="type-editor-actions">
            {dirty && <span className="type-change-scope" id="type-change-scope"><CircleAlert aria-hidden="true" />{creating ? t`Saving affects every matching note` : <><Trans>Saving affects every note of type </Trans><code>{type!.name}</code></>}</span>}
            <button className="type-secondary-action mdbase-button is-tertiary" onClick={creating ? onCancel : onRevert} disabled={readOnly || saving || (!creating && !dirty)}><RotateCcw aria-hidden="true" />{creating ? t`Cancel` : t`Revert`}</button>
            <button className="save-type-button mdbase-button is-primary" aria-describedby={dirty ? "type-change-scope" : undefined} onClick={() => setReviewing(true)} disabled={readOnly || loading || saving || !dirty || !parsed.value || contractErrors.length > 0}>{saving ? t`Saving…` : t`Review changes`}</button>
          </div></>}
        </div>
      }
      {(error || visualError || (!loading && parsed.error)) && <p className="type-editor-error" role="alert">{error || visualError || parsed.error}</p>}
      {loading ? <div className="type-source-loading" role="status" aria-label={t`Loading type definition`}><Trans>Reading type definition…</Trans></div>
        : !readOnly && reviewing && impact ? <TypeChangeReview
          previousSource={document?.document}
          source={source}
          impact={impact}
          creating={creating}
          saving={saving}
          onBack={() => setReviewing(false)}
          onConfirm={onSave}
        />
          : !readOnly && view === "visual" && parsed.value ? <VisualTypeEditor
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
            : !readOnly && view === "visual" ? <div className="visual-type-unavailable"><CircleAlert aria-hidden="true" /><p><Trans>Fix the YAML source before returning to the field editor.</Trans></p><button onClick={() => setView("yaml")}><Trans>Open YAML</Trans></button></div>
              : <CodeEditor
                key={`${document?.path ?? "new-type"}:yaml`}
                value={source}
                onChange={(next) => { onSourceChange(next); setVisualError(undefined); setReviewing(false); }}
                label={t`${name} type YAML`}
                readOnly={readOnly}
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
  useLingui();
  const [activeField, setActiveField] = useState<string>();
  const linkedSchema = typeSchemaReference(source);
  const linkedSchemaFields = linkedSchema
    ? typeFieldsForContracts(source, typeSchema).filter((field) => !field.label.includes("."))
    : [];
  const fieldSuggestions = useMemo(
    () => membershipFieldSuggestions(source, typeSchema, notes, explicitTypeKeys),
    [explicitTypeKeys.join("\u0000"), notes, source, typeSchema, i18n.locale]
  );
  const pathSuggestions = useMemo(() => membershipPathSuggestions(notes), [notes, i18n.locale]);
  useEffect(() => setActiveField(undefined), [definition.name]);

  return <div className="visual-type-editor">
    <section className="visual-type-section visual-type-basics">
      <div className="visual-section-heading"><div><h3><Trans>Identity</Trans></h3><p><Trans>The stable name used by records and connected apps.</Trans></p></div></div>
      <div className="visual-type-basics-fields">
        <label><span><Trans>Name</Trans></span><input value={definition.name} onChange={(event) => onChange((source) => updateTypeIdentity(source, "name", event.target.value))} spellCheck="false" /></label>
        <label><span><Trans>Description</Trans></span><input value={definition.description} onChange={(event) => onChange((source) => updateTypeIdentity(source, "description", event.target.value))} /></label>
      </div>
    </section>
    <TypeEditorDisclosure
      className="type-match-section"
      title={t`Which notes use this type`}
      description={t`How notes are assigned to this type.`}
      summary={typeMembershipSummary(definition)}
    >
      <div className="type-membership-method type-explicit-membership">
        <div>
          <strong><Trans>Assigned by name</Trans></strong>
          {explicitTypeKeys.length
            ? <p><Trans>Notes can name <code>{definition.name}</code> through {explicitTypeKeys.map((key, index) => <span key={key}>{index ? ", " : ""}<code>{key}</code></span>)}. When any configured key is present, automatic rules are skipped.</Trans></p>
            : <p><Trans>This collection has explicit type assignment disabled. Every note is classified by automatic rules.</Trans></p>}
        </div>
        {onOpenSettings && <button onClick={onOpenSettings}><Trans>View settings</Trans></button>}
      </div>
      <div className="type-membership-method type-automatic-membership">
        <div>
          <strong><Trans>Automatic matching</Trans></strong>
          <p>{explicitTypeKeys.length
            ? t`Notes without an explicit assignment belong to this type when every configured condition group below matches.`
            : t`Notes belong to this type when every configured condition group below matches.`}</p>
        </div>
      </div>
      <div className={`type-match-rules${definition.pathGlobs.length && definition.fieldsPresent.length ? " combined" : ""}`}>
        <StringListEditor
          label={t`Path matches any`}
          values={definition.pathGlobs}
          itemLabel={t`Path pattern`}
          addLabel={t`Add path pattern`}
          placeholder={t`Journal/**/*.md`}
          helper="Optional. One pattern must match the collection-relative path."
          suggestions={pathSuggestions}
          onChange={(values) => onChange((source) => updateTypePathGlobs(source, values))}
        />
        {definition.pathGlobs.length > 0 && definition.fieldsPresent.length > 0 && <span className="type-match-operator"><Trans>and</Trans></span>}
        <StringListEditor
          label={t`Frontmatter contains all`}
          values={definition.fieldsPresent}
          itemLabel={t`Required match field`}
          addLabel={t`Add field selector`}
          placeholder={t`status`}
          helper="Optional. Every selector must have a persisted, non-null value."
          suggestions={fieldSuggestions}
          onChange={(values) => onChange((source) => updateTypeFieldsPresent(source, values))}
        />
      </div>
      {!definition.pathGlobs.length && !definition.fieldsPresent.length && !definition.advancedMatchKeys.length
        && <p className="type-explicit-only"><Trans>No inferred rules. Records must declare this type explicitly.</Trans></p>}
      {definition.advancedMatch && <div className="advanced-match-note">
        <Info aria-hidden="true" />
        <div><strong><Trans>More inferred rules in YAML</Trans></strong><p><Trans>{definition.advancedMatchKeys.map(matchRuleLabel).join(" · ")}. These rules combine with the visual rules above.</Trans></p></div>
        <button onClick={onOpenYaml}><Trans>Open YAML</Trans></button>
      </div>}
      {impact && <TypeMembershipPreview impact={impact.membership} advanced={definition.advancedMatch} />}
    </TypeEditorDisclosure>
    <section className="visual-type-section visual-type-fields-intro">
      <div className="visual-type-fields-heading">
        <div>
          <h3><Trans>Fields</Trans></h3>
          <p>{linkedSchema
            ? plural(linkedSchemaFields.length, { one: `# field is supplied by the installed schema.`, other: `# fields are supplied by the installed schema.` })
            : t`Objects and lists can contain fields at any depth.`}</p>
        </div>
        {linkedSchema
          ? <button className="mdbase-button is-tertiary" onClick={onOpenYaml}><FileCode2 aria-hidden="true" /><Trans>Edit reference</Trans></button>
          : <button className="mdbase-button" onClick={() => onChange((current) => addTypeField(current))}><Plus aria-hidden="true" /><Trans>Add field</Trans></button>}
      </div>
    </section>
    <div className="visual-type-fields">
      {linkedSchema ? <>
        <div className="linked-schema-notice">
          <Link2 aria-hidden="true" />
          <div><strong><Trans>Schema-managed fields</Trans></strong><p><Trans><code>{linkedSchema}</code> is installed with this type. Field structure is edited at the schema source.</Trans></p></div>
        </div>
        {linkedSchemaFields.map((field) => <div className="linked-schema-field" key={field.reference}>
          <div><span>{field.label}</span>{field.description && <small>{field.description}</small>}</div>
          <span>{kindName(field.kind)}</span>
          <span className={field.required ? "required" : ""}>{field.required ? t`Required` : t`Optional`}</span>
          <Link2 aria-label={t`Linked schema field`} />
        </div>)}
        {!linkedSchemaFields.length && <p className="quiet-empty"><Trans>The linked schema does not expose object fields.</Trans></p>}
      </> : <>
        {definition.fields.map((field) => <VisualFieldRow
          key={typeFieldPathLabel(field.path)}
          field={field}
          source={source}
          depth={0}
          typeKey={explicitTypeKeys.includes(field.name)}
          activeField={activeField}
          onActivate={setActiveField}
          onChange={onChange}
        />)}
        {!definition.fields.length && <p className="quiet-empty"><Trans>No fields are declared yet.</Trans></p>}
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
    <p className="visual-type-footnote"><Trans>Advanced JSON Schema rules remain intact and are identified in place. Review any structural conversion before applying it.</Trans></p>
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
  useLingui();
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
  useLingui();
  const implementations = useMemo(() => readTypeContractImplementations(source), [source, i18n.locale]);
  const implementedKeys = new Set(implementations.map((implementation) => `${implementation.contract}@${implementation.version}`));
  const available = contracts.filter((contract) => !implementedKeys.has(contractKey(contract)));
  const suggestions = useMemo(
    () => suggestContractsForType(source, contracts, typeSchema).slice(0, 3),
    [contracts, source, typeSchema, i18n.locale]
  );
  const typeFields = useMemo(() => typeFieldsForContracts(source, typeSchema), [source, typeSchema, i18n.locale]);
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
    ? plural(contractErrors, { one: `# issue need attention`, other: `# issues need attention` })
    : implementations.length
      ? plural(implementations.length, { one: "# connection configured", other: "# connections configured" })
      : contracts.length
        ? t`No connections`
        : t`No app contracts installed`;

  return <TypeEditorDisclosure
    className="type-contracts-section"
    title={t`Works with applications`}
    description={t`Tell compatible apps what this type’s fields mean.`}
    summary={contractSummary}
    attention={contractErrors > 0}
  >

    {!contracts.length && <div className="contract-empty">
      <Link2 aria-hidden="true" />
      <div><strong><Trans>No application contracts are installed</Trans></strong><p><Trans>Add a ready-made type to get app compatibility, or install a contract before connecting this type yourself.</Trans></p></div>
      {onBrowsePacks && <button onClick={onBrowsePacks}><Trans>Browse ready-made types</Trans></button>}
    </div>}

    {contracts.length > 0 && creating && implementations.length === 0 && <div className="contract-starter">
      <div><strong><Trans>Start with app compatibility</Trans></strong><p><Trans>Create fields that already match an installed contract. You can rename and remap them later.</Trans></p></div>
      <label><span><Trans>Contract</Trans></span><Select
        aria-label={t`Starting contract`}
        value={selected ? contractKey(selected) : ""}
        options={available.map((contract) => ({ value: contractKey(contract), label: `${contract.id} · ${contract.version}` }))}
        onChange={setSelectedKey}
      /></label>
      <button disabled={!selected} onClick={() => selected && onChange((current) => createTypeSourceFromContract(current, selected, typeNames))}><Trans>Use contract</Trans></button>
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
              <span>{errors.length ? t`Needs attention` : warnings.length ? t`Review recommended` : t`Mapping ready`}</span>
            </div>
            <div className="contract-identity">
              <strong>{implementation.contract}</strong>
              <span>{implementation.version}</span>
            </div>
            <button
              className="contract-remove"
              aria-label={t`Remove ${implementation.contract} contract`}
              onClick={() => onChange((current) => removeTypeContractImplementation(current, implementation.contract, implementation.version))}
            ><Trash2 aria-hidden="true" /><Trans>Remove</Trans></button>
          </header>
          {!contract ? <div className="contract-unavailable">
            <p><Trans>This exact contract is not available in the collection. Restore it or remove the implementation before saving.</Trans></p>
            <button onClick={onOpenYaml}><Trans>Open YAML</Trans></button>
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
                <span><Trans>Field mappings</Trans></span>
                <small>{requiredMapped}/{requiredFields.length} <Trans>required · </Trans>{mappedCount}/{fields.length} <Trans>total</Trans>{warnings.length ? t` · ${warnings.length} to review` : ""}</small>
                <ChevronRight aria-hidden="true" />
              </summary>
              {fields.length ? <div className="contract-mapping-list">
                <div className="contract-mapping-overview">
                  <div><strong>{requiredMapped === requiredFields.length ? t`Required fields covered` : plural(requiredFields.length - requiredMapped, { one: `# required field unmapped`, other: `# required fields unmapped` })}</strong><span><Trans>A mapping copies the source value directly. It does not coerce or transform data.</Trans></span></div>
                  <dl>
                    <div><dt><Trans>Required</Trans></dt><dd>{requiredMapped}/{requiredFields.length}</dd></div>
                    <div><dt><Trans>Optional</Trans></dt><dd>{mappedCount - requiredMapped}/{fields.length - requiredFields.length}</dd></div>
                  </dl>
                </div>
                <div className="contract-mapping-columns" aria-hidden="true"><span><Trans>Contract field</Trans></span><span><Trans>Source field</Trans></span><span><Trans>Validation</Trans></span></div>
                {fields.map((field) => {
                  const mapped = mappingForContractField(implementation, field);
                  const fieldIssue = implementationIssues.find((issue) => issue.field === field.reference);
                  const mappedField = matchingContractTypeField(typeFields, mapped);
                  const assessment = assessContractFieldMapping(field, mappedField);
                  const displayed = fieldIssue
                    ? {
                        level: fieldIssue.level,
                        label: fieldIssue.level === "error" ? t`Fix mapping` : t`Review`,
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
                      <div><code>{field.reference}</code><span className={field.required ? "required" : ""}>{field.required ? t`Required` : t`Optional`}</span></div>
                      <small>{field.description || t`${kindName(field.kind)} value`}</small>
                    </div>
                    <label className="contract-field-source">
                      <span className="sr-only"><Trans>{implementation.contract} {field.reference} source field</Trans></span>
                      <Select
                        aria-label={t`${implementation.contract} ${field.reference} type field`}
                        aria-invalid={displayed.level === "error" || undefined}
                        value={mapped}
                        options={[
                          { value: "", label: field.required ? "Choose a source field" : "Not exposed" },
                          ...(mappedMissing ? [{ value: mapped, label: t`Missing field: ${mapped}` }] : []),
                          ...mappingOptionGroup("Compatible fields", compatible),
                          ...mappingOptionGroup("Needs review", review),
                          ...mappingOptionGroup("Incompatible fields", incompatible, true)
                        ]}
                        onChange={(next) => onChange((current) => setTypeContractFieldMapping(
                          current,
                          implementation.contract,
                          implementation.version,
                          field.reference,
                          next || undefined
                        ))}
                      />
                      {mappedField && <small>{kindName(mappedField.kind)} · {mappedField.required ? t`always present` : t`optional in this type`}</small>}
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
                <p><Trans>This contract does not expose simple top-level properties. Configure its field references in YAML.</Trans></p>
                <button onClick={onOpenYaml}><Trans>Open YAML</Trans></button>
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
                <span><Trans>Contract settings</Trans></span>
                <small>{implementation.binding ? t`Configured` : bindingIssues.length ? t`Setup required` : t`Optional`}</small>
                <ChevronRight aria-hidden="true" />
              </summary>
              <div className="contract-settings-body">
                <div className="contract-settings-intro">
                  <div>
                    <strong><Trans>Application behavior</Trans></strong>
                    <p><Trans>Control how compatible apps interpret and act on this type. Values are checked against the contract’s schema.</Trans></p>
                  </div>
                  <button type="button" onClick={onOpenYaml}><Trans>Edit YAML</Trans></button>
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
                      <p><Trans>Set the contract’s required behavior choices before saving this type.</Trans></p>
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
                      }}><Trans>Configure settings</Trans></button>
                    </div>}
              </div>
            </details>}
            <details className="contract-view-preview">
              <summary>
                <span><Trans>Application view</Trans></span>
                <small>{plural(mappedCount, { one: "# value exposed", other: "# values exposed" })}</small>
                <ChevronRight aria-hidden="true" />
              </summary>
              <div className="contract-preview-body">
                <p><Trans>Apps read these contract field names while your notes keep their own field names.</Trans></p>
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
      <label><span><Trans>Installed contract</Trans></span><Select
        aria-label={t`Installed contract`}
        value={selected ? contractKey(selected) : ""}
        options={available.map((contract) => ({ value: contractKey(contract), label: `${contract.id} · ${contract.version}` }))}
        onChange={setSelectedKey}
      /></label>
      <button disabled={!selected} onClick={() => selected && addContract(selected)}><Plus aria-hidden="true" /><Trans>Connect application contract</Trans></button>
    </div>}

    {suggestions.length > 0 && <div className="contract-suggestions">
      <div className="contract-suggestion-heading"><div><strong><Trans>Possible app compatibility</Trans></strong><p><Trans>Suggested from field names and shapes only. Confirm that the meanings agree.</Trans></p></div></div>
      {suggestions.map((suggestion) => <div className="contract-suggestion" key={contractKey(suggestion.contract)}>
        <div><strong>{suggestion.contract.id}</strong><span>{suggestion.contract.version}</span></div>
        <p>{suggestion.matchedFields} <Trans>of </Trans>{suggestion.totalFields} <Trans>fields match</Trans>{suggestion.requiredFields ? t`, ${suggestion.requiredMatched} of ${suggestion.requiredFields} required` : ""}.</p>
        <button onClick={() => addContract(suggestion.contract)}><Trans>Review mapping</Trans></button>
      </div>)}
    </div>}

    {globalIssues.length > 0 && <div className="contract-global-issues">
      {globalIssues.map((issue, index) =>
        <p role={issue.level === "error" ? "alert" : undefined} key={`${issue.message}:${index}`}>{issue.message}</p>)}
      <button onClick={onOpenYaml}><Trans>Open YAML</Trans></button>
    </div>}
  </TypeEditorDisclosure>;
}

function mappingOptionGroup(label: string, options: Array<{
  option: ContractTypeField;
  assessment: ReturnType<typeof assessContractFieldMapping>;
}>, disabled = false): SelectItems {
  if (!options.length) return [];
  return [{
    label,
    options: options.map(({ option }) => ({
      value: option.reference,
      label: `${option.label} · ${kindName(option.kind)}${option.required ? " · required" : ""}`,
      disabled
    }))
  }];
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
  useLingui();
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
        message: error instanceof Error ? error.message : t`The type pack could not be installed.`
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
      ? pack.primaryType ? t`${pack.displayName} added` : t`Installed`
      : status === "partial"
        ? t`Partly installed`
        : pack.installedTypes.length === 1
          ? t`Adds 1 type`
          : t`Adds ${pack.installedTypes.length} types`;
    const confirming = confirmingKey === key;
    const installing = installingKey === key;
    const addLabel = status === "partial"
      ? t`Finish adding ${pack.displayName}`
      : pack.primaryType
        ? t`Add ${pack.displayName}`
        : t`Install runtime pack`;
    const icon = isPhosphorIconName(pack.icon)
      ? <PhosphorIcon name={pack.icon} aria-hidden="true" />
      : <Package aria-hidden="true" />;
    const primaryTypeLabel = pack.installedTypes
      .find(({ name }) => name === pack.primaryType)?.label ?? pack.displayName;
    const confirmationCopy = pack.primaryType
      ? t`Creates a ready-to-use ${primaryTypeLabel} type with standard fields and an editable contract mapping. Existing files will not be overwritten; installation stops if any target conflicts.`
      : t`Adds ${pack.installedTypes.length} internal types and ${pack.resourceCount} declared resources in one validated transaction. Existing files will not be overwritten; installation stops if any target conflicts.`;

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
            ? <button onClick={() => onOpenType(pack.primaryType!)}><Trans>Open {primaryTypeLabel}</Trans></button>
            : status !== "installed" && onInstall && (canInstall
              ? <button
                  disabled={installing}
                  onClick={() => {
                    setInstallError(undefined);
                    setConfirmingKey(key);
                  }}
                >{addLabel}</button>
              : onRequestAccess && <button onClick={onRequestAccess}><Trans>Allow installs</Trans></button>)}
        </div>
      </div>
      {pack.caution && <div className="contract-catalog-pack-caution">
        <CircleAlert aria-hidden="true" />
        <p>{pack.caution}</p>
      </div>}
      <details className="contract-catalog-pack-details">
        <summary><Trans>Technical details</Trans></summary>
        <div>
          <p><span><Trans>Pack</Trans></span><code>{pack.id}@{pack.version}</code></p>
          <p><span><Trans>Contents</Trans></span>{pack.provides.length} {pack.provides.length === 1 ? t`contract` : t`contracts`} · {pack.resourceCount} <Trans>resources</Trans></p>
          <a href={pack.provisionUrl} target="_blank" rel="noreferrer"><Trans>View pack JSON</Trans></a>
        </div>
      </details>
      {confirming && <div className="contract-catalog-install-confirm" role="alert">
        <div>
          <strong>{addLabel}?</strong>
          <p>{confirmationCopy}</p>
        </div>
        <button disabled={installing} onClick={() => setConfirmingKey(undefined)}><Trans>Cancel</Trans></button>
        <button className="confirm-pack-install" disabled={installing} onClick={() => void install(pack)}>
          {installing ? t`Installing…` : addLabel}
        </button>
      </div>}
      {installError?.key === key && <div className="contract-catalog-install-error" role="alert">
        <div><strong><Trans>Couldn’t install {pack.displayName}</Trans></strong><p>{installError.message}</p></div>
        <button onClick={() => setConfirmingKey(key)}><Trans>Try again</Trans></button>
      </div>}
    </div>;
  }

  return <div className="contract-catalog">
    <div className="contract-catalog-heading">
      <div>
        <strong>{catalog ? t`From ${catalog.publisher.name}` : t`mdbase catalog`}</strong>
        <p><Trans>Each choice includes its portable contract and an editable local mapping.</Trans></p>
      </div>
      {catalog && <a href={catalog.sourceUrl} target="_blank" rel="noreferrer"><Trans>Catalog source</Trans></a>}
    </div>
    {loading && <div className="contract-catalog-loading" role="status" aria-label={t`Loading contract catalog`}><Trans>Loading available compatibility packs…</Trans></div>}
    {error && !loading && <div className="contract-catalog-error" role="alert">
      <div><strong><Trans>Catalog unavailable</Trans></strong><p>{error}</p></div>
      {onReload && <button onClick={onReload}><Trans>Try again</Trans></button>}
    </div>}
    {catalog && !loading && <div className="contract-catalog-packs">
      {standardPacks.map(renderPack)}
      {!standardPacks.length && !advancedPacks.length
        && <p className="quiet-empty"><Trans>The catalog has no published types.</Trans></p>}
      {advancedPacks.length > 0 && <section className="contract-catalog-advanced">
        <button
          className="contract-catalog-advanced-toggle"
          aria-expanded={showAdvanced}
          onClick={() => setShowAdvanced((current) => !current)}
        >
          <span>
            <strong><Trans>Developer and infrastructure packs</Trans></strong>
            <small><Trans>For integrations and specialised setups</Trans></small>
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
  useLingui();
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
    ...collection.path.advancedKeys.map((key) => t`Path: ${collectionRuleLabel(key)}`)
  ];

  return <TypeEditorDisclosure
    className="collection-behaviour-section"
    title={t`Collection behaviour`}
    description={t`How this type appears and behaves across compatible tools.`}
    summary={collectionBehaviourSummary(definition)}
  >

    <div className="collection-behaviour-group">
      <div className="collection-group-heading">
        <div><h4><Trans>Display</Trans></h4><p><Trans>Advisory labels and colour used when records of this type are shown.</Trans></p></div>
      </div>
      <div className="collection-display-grid">
        <CollectionFieldSelect
          label={t`Name field`}
          value={collection.display.nameField ?? ""}
          fields={fields.filter(textLikeField)}
          onChange={(value) => onChange((source) => updateTypeCollectionDisplay(source, "name_field", value))}
        />
        <CollectionFieldSelect
          label={t`Description field`}
          value={collection.display.descriptionField ?? ""}
          fields={fields.filter(textLikeField)}
          onChange={(value) => onChange((source) => updateTypeCollectionDisplay(source, "description_field", value))}
        />
        <IconPicker
          value={collection.display.icon ?? ""}
          onChange={(value) => onChange((source) => updateTypeCollectionDisplay(source, "icon", value))}
        />
        <CollectionFieldSelect
          label={t`Colour field`}
          value={collection.display.colorField ?? ""}
          fields={fields}
          onChange={(value) => onChange((source) => updateTypeCollectionDisplay(source, "color_field", value))}
        />
      </div>
    </div>

    <div className="collection-behaviour-group">
      <div className="collection-group-heading">
        <div><h4><Trans>Read defaults</Trans></h4><p><Trans>Effective values for missing properties. Source files stay unchanged.</Trans></p></div>
        <button
          disabled={!nextDefault}
          onClick={() => nextDefault && onChange((source) => addTypeReadDefault(source, nextDefault.value, defaultValueForField(nextDefault.node)))}
        ><Plus aria-hidden="true" /><Trans>Add default</Trans></button>
      </div>
      <div className="collection-rule-list">
        {collection.readDefaults.map((entry, index) => {
          const option = topLevelFields.find((candidate) => candidate.value === entry.field);
          return <div className="collection-default-row" key={entry.field}>
            <CollectionFieldSelect
              label={t`Default field ${index + 1}`}
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
            <InlineRemoveButton className="collection-rule-remove" label={t`Remove read default for ${entry.field}`} onClick={() => onChange((source) => removeTypeReadDefault(source, entry.field))} />
          </div>;
        })}
        {!collection.readDefaults.length && <p className="collection-empty-rule"><Trans>Missing properties have no type-specific read defaults.</Trans></p>}
      </div>
    </div>

    <div className="collection-behaviour-group">
      <div className="collection-group-heading">
        <div><h4><Trans>Links</Trans></h4><p><Trans>Describe which properties point to other records and how targets are validated.</Trans></p></div>
        <button
          disabled={!nextLink}
          onClick={() => nextLink && onChange((source) => addTypeLinkRule(source, nextLink.value))}
        ><Plus aria-hidden="true" /><Trans>Add link rule</Trans></button>
      </div>
      <div className="collection-rule-list">
        {collection.links.map((rule, index) => <div className="collection-link-rule" key={rule.field}>
          <div className="collection-link-primary">
            <CollectionFieldSelect
              label={t`Link field ${index + 1}`}
              visibleLabel="Field"
              value={rule.field}
              fields={linkFields.filter((candidate) => candidate.value === rule.field || !usedLinks.has(candidate.value))}
              allowEmpty={false}
              onChange={(value) => onChange((source) => renameTypeLinkRule(source, rule.field, value))}
            />
            <label><span><Trans>Format</Trans></span><Select
              aria-label={t`${rule.field} link format`}
              value={rule.format ?? ""}
              options={linkFormatOptions}
              onChange={(next) => onChange((source) => setTypeLinkRule(source, rule.field, "format", (next || undefined) as TypeLinkFormat | undefined))}
            /></label>
            <label className="collection-toggle"><input
              className="mdbase-checkbox"
              type="checkbox"
              checked={rule.validateExists}
              onChange={(event) => onChange((source) => setTypeLinkRule(source, rule.field, "validate_exists", event.target.checked || undefined))}
            /><span><Trans>Require an existing target</Trans></span></label>
            <InlineRemoveButton className="collection-rule-remove" label={t`Remove link rule for ${rule.field}`} onClick={() => onChange((source) => removeTypeLinkRule(source, rule.field))} />
          </div>
          <StringListEditor
            label={t`Allowed target types`}
            values={rule.targetTypes}
            itemLabel={t`${rule.field} target type`}
            addLabel={t`Add target type`}
            placeholder={t`person or any`}
            helper="Leave empty to allow records of any type."
            suggestions={["any", ...typeNames]}
            onChange={(values) => onChange((source) => setTypeLinkTargets(source, rule.field, values))}
          />
          {rule.advancedKeys.length > 0 && <p className="collection-advanced-inline"><Trans>Additional link settings remain in YAML: {rule.advancedKeys.join(", ")}.</Trans></p>}
        </div>)}
        {!collection.links.length && <p className="collection-empty-rule"><Trans>No properties are marked as links.</Trans></p>}
      </div>
    </div>

    <div className="collection-behaviour-group">
      <div className="collection-group-heading">
        <div><h4><Trans>Uniqueness</Trans></h4><p><Trans>Require a property value to be unique across a deliberate comparison set.</Trans></p></div>
        <button
          disabled={!firstUnique}
          onClick={() => firstUnique && onChange((source) => addTypeUniqueRule(source, firstUnique.value))}
        ><Plus aria-hidden="true" /><Trans>Add unique rule</Trans></button>
      </div>
      <div className="collection-rule-list">
        {collection.unique.map((rule, index) => <div className={`collection-unique-rule${rule.scope === "path_glob" ? " has-path" : ""}`} key={`${rule.sourceIndex}:${rule.field}`}>
          <CollectionFieldSelect
            label={t`Unique field ${index + 1}`}
            visibleLabel="Field"
            value={rule.field}
            fields={fields}
            allowEmpty={false}
            onChange={(value) => onChange((source) => setTypeUniqueRule(source, rule.sourceIndex, "field", value))}
          />
          <label><span><Trans>Scope</Trans></span><Select
            aria-label={t`${rule.field} uniqueness scope`}
            value={rule.scope ?? ""}
            placeholder={t`Choose scope`}
            options={uniqueScopeOptions}
            onChange={(next) => onChange((source) => setTypeUniqueRule(source, rule.sourceIndex, "scope", next as TypeUniqueScope))}
          /></label>
          {rule.scope === "path_glob" && <label className="collection-unique-path"><span><Trans>Path pattern</Trans></span><input
            aria-label={t`${rule.field} uniqueness path pattern`}
            value={rule.pathGlob ?? ""}
            placeholder={t`Projects/**/*.md`}
            onChange={(event) => onChange((source) => setTypeUniqueRule(source, rule.sourceIndex, "path_glob", event.target.value || undefined))}
          /></label>}
          <InlineRemoveButton className="collection-rule-remove" label={t`Remove uniqueness rule for ${rule.field}`} onClick={() => onChange((source) => removeTypeUniqueRule(source, rule.sourceIndex))} />
          {rule.advancedKeys.length > 0 && <p className="collection-advanced-inline"><Trans>Additional uniqueness settings remain in YAML: {rule.advancedKeys.join(", ")}.</Trans></p>}
        </div>)}
        {!collection.unique.length && <p className="collection-empty-rule"><Trans>No cross-record uniqueness rules.</Trans></p>}
      </div>
    </div>

    <div className="collection-behaviour-group">
      <div className="collection-group-heading">
        <div><h4><Trans>Path policy</Trans></h4><p><Trans>Guide compatible tools when they create or rename records of this type.</Trans></p></div>
      </div>
      <div className="collection-path-grid">
        <label><span><Trans>Pattern</Trans></span><input
          aria-label={t`Path pattern`}
          value={collection.path.pattern ?? ""}
          placeholder={t`tasks/{id}.md`}
          onChange={(event) => onChange((source) => updateTypePathPolicy(source, "pattern", event.target.value))}
        /><small><Trans>Portable <code>{"{field}"}</code> placeholders.</Trans></small></label>
        <label><span><Trans>Folder</Trans></span><input
          aria-label={t`Path folder`}
          value={collection.path.folder ?? ""}
          placeholder={t`tasks`}
          onChange={(event) => onChange((source) => updateTypePathPolicy(source, "folder", event.target.value))}
        /></label>
        <label><span><Trans>Template</Trans></span><input
          aria-label={t`Path template`}
          value={collection.path.template ?? ""}
          placeholder={t`{title}.md`}
          onChange={(event) => onChange((source) => updateTypePathPolicy(source, "template", event.target.value))}
        /></label>
      </div>
    </div>

    {advancedKeys.length > 0 && <div className="advanced-match-note collection-advanced-note">
      <Info aria-hidden="true" />
      <div><strong><Trans>More collection behaviour in YAML</Trans></strong><p><Trans>{advancedKeys.join(" · ")}. These settings remain intact.</Trans></p></div>
      <button onClick={onOpenYaml}><Trans>Open YAML</Trans></button>
    </div>}
  </TypeEditorDisclosure>;
}

function typeMembershipSummary(definition: VisualTypeDefinition): string {
  const rules = [
    countSummary(definition.pathGlobs.length, "path pattern"),
    countSummary(definition.fieldsPresent.length, "field selector"),
    countSummary(definition.advancedMatchKeys.length, "YAML rule")
  ].filter((value): value is string => Boolean(value));
  return rules.length ? rules.join(" · ") : t`No automatic matching rules`;
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
  useLingui();
  if (!impact.complete) return <div className="type-membership-preview incomplete">
    <div>
      <strong>{plural(impact.current, { one: "# currently indexed note matches", other: "# currently indexed notes match" })}</strong>
      <p><Trans>The after-save preview is unavailable because </Trans>{advanced ? t`additional YAML rules` : t`some matching rules`} <Trans>must be evaluated by the collection.</Trans></p>
    </div>
  </div>;
  const next = impact.next ?? 0;
  const changed = impact.addedPaths.length + impact.removedPaths.length;
  return <div className="type-membership-preview">
    <div>
      <strong>{afterUpdate ? plural(next, { one: "# note after update", other: "# notes after update" }) : plural(next, { one: "# note with these rules", other: "# notes with these rules" })}</strong>
      <p><Trans>{impact.current.toLocaleString(displayLocale())} now · {impact.addedPaths.length.toLocaleString(displayLocale())} gain this type · {impact.removedPaths.length.toLocaleString(displayLocale())} lose it</Trans>{impact.overlapping ? plural(impact.overlapping, { one: ` · # also matches another type`, other: ` · # also match another type` }) : ""}</p>
    </div>
    {changed > 0 && <details>
      <summary><Trans>Show affected notes</Trans></summary>
      <div className="type-membership-paths">
        {impact.addedPaths.slice(0, 10).map((path) => <p key={`added:${path}`}><span><Trans>Gains</Trans></span><code>{path}</code></p>)}
        {impact.removedPaths.slice(0, 10).map((path) => <p key={`removed:${path}`}><span><Trans>Loses</Trans></span><code>{path}</code></p>)}
        {changed > 20 && <p><Trans><span>More</span>{(changed - 20).toLocaleString(displayLocale())} additional notes</Trans></p>}
      </div>
    </details>}
  </div>;
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
  useLingui();
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
  }, [query, i18n.locale]);

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
    <span><Trans>Icon</Trans></span>
    <div className={`icon-picker-control${open ? " open" : ""}${open ? query && !queryValid ? " invalid" : "" : value && !valid ? " invalid" : ""}`}>
      <span className="icon-picker-current" aria-hidden="true">
        {valid ? <PhosphorIcon name={normalized} /> : <FileCode2 />}
      </span>
      <input
        role="combobox"
        aria-label={t`Display icon`}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && options.length ? `${listId}-${activeIndex}` : undefined}
        value={open ? query : value}
        placeholder={t`Choose an icon`}
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
        aria-label={t`Clear display icon`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          onChange("");
          setQuery("");
        }}
      ><X aria-hidden="true" /></button>}
    </div>
    {open && <div className={`icon-picker-popover${dropUp ? " drop-up" : ""}`} id={listId} role="listbox" aria-label={t`Phosphor icons`}>
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
      </div> : <p><Trans>No matching icons.</Trans></p>}
      <footer>{query.trim() ? plural(options.length, { one: "# match", other: "# matches" }) : t`Common icons`}<span><Trans>Phosphor Regular</Trans></span></footer>
    </div>}
    {open
      ? query && !queryValid && <small className="icon-picker-error"><Trans>Choose an icon from the Phosphor library.</Trans></small>
      : value && !valid && <small className="icon-picker-error"><Trans>Choose an icon from the Phosphor library.</Trans></small>}
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
  useLingui();
  const options = fields.some((field) => field.value === value) || !value
    ? fields
    : [{ value, label: value, node: advancedFieldNode(value) }, ...fields];
  return <label><span>{visibleLabel ?? label}</span><Select
    aria-label={label}
    value={value}
    options={[...(allowEmpty ? [{ value: "", label: "Not set" }] : []), ...options.map((field) => ({ value: field.value, label: field.label }))]}
    onChange={onChange}
  /></label>;
}

function DefaultValueEditor({ field, node, value, onChange }: {
  field: string;
  node?: TypeSchemaNode;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  useLingui();
  if (node?.kind === "boolean" && typeof value === "boolean") {
    return <label><span><Trans>Default value</Trans></span><Select
      aria-label={t`Default value for ${field}`}
      value={String(value)}
      options={[{ value: "true", label: "True" }, { value: "false", label: "False" }]}
      onChange={(next) => onChange(next === "true")}
    /></label>;
  }
  if ((node?.kind === "string" || node?.kind === "date" || node?.kind === "datetime") && typeof value === "string") {
    return <label><span><Trans>Default value</Trans></span><input aria-label={t`Default value for ${field}`} value={value} onChange={(event) => onChange(event.target.value)} /></label>;
  }
  return <JsonValueInput field={field} value={value} onChange={onChange} />;
}

function JsonValueInput({ field, value, onChange }: { field: string; value: unknown; onChange: (value: unknown) => void }) {
  useLingui();
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
      setError(t`Enter a valid JSON value.`);
    }
  }

  return <label className="collection-json-value"><span><Trans>Default value</Trans></span><input
    aria-label={t`Default value for ${field}`}
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

function typeHeadingFacts(type: CollectionTypeDescriptor, appViews: number): string {
  const extensions = Object.keys(type.extensions).length;
  return [type.version === undefined ? t`Unversioned` : t`Version ${type.version}`,
    plural(propertyCount(type), { one: "# field", other: "# fields" }),
    appViews ? plural(appViews, { one: "# app view", other: "# app views" }) : "",
    extensions ? plural(extensions, { one: "# extension", other: "# extensions" }) : ""
  ].filter(Boolean).join(" · ");
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
  if (key === "projections") return t`Computed projections`;
  if (key === "runtime") return t`Runtime path handling`;
  if (key === "generated_by") return t`Generated path ownership`;
  if (key.startsWith("x-")) return key;
  return key.replaceAll("_", " ");
}

function VisualFieldRow({ field, source, depth, typeKey = false, activeField, onActivate, onChange }: {
  field: TypeFieldDefinition;
  source: string;
  depth: number;
  typeKey?: boolean; // The explicit type field: renaming, retyping, or removing it changes type membership.
  activeField?: string;
  onActivate: (field?: string) => void;
  onChange: (change: (source: string) => string) => void;
}) {
  useLingui();
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
      <button className="field-disclosure" aria-label={expanded ? t`Collapse ${fieldLabel} field` : t`Expand ${fieldLabel} field`} aria-expanded={expanded} onClick={() => onActivate(expanded ? undefined : fieldLabel)}>
        {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
      </button>
      <label className={`visual-field-name${typeKey ? " type-key" : ""}`}><span className="sr-only"><Trans>Field name</Trans></span><input aria-label={t`${fieldLabel} field name`} type="text" defaultValue={field.name} readOnly={typeKey} aria-describedby={typeKey ? `type-key-note-${fieldLabel}` : undefined} onBlur={(event) => { if (!typeKey) onChange((current) => renameTypeField(current, field.path, event.target.value)); }} spellCheck="false" />{typeKey && <small id={`type-key-note-${fieldLabel}`} title={t`Notes use this field to declare their type. Edit it in YAML if you need to change it.`}><Trans>Type key</Trans></small>}</label>
      <label className="visual-field-kind"><span className="sr-only"><Trans>{fieldLabel} field type</Trans></span><Select aria-label={t`${fieldLabel} field type`} value={field.kind} disabled={typeKey} options={kindOptions(field.kind)} onChange={chooseKind} /></label>
      <label className="visual-field-required"><input className="mdbase-checkbox" type="checkbox" checked={field.required} onChange={(event) => onChange((current) => setTypeFieldRequired(current, field.path, event.target.checked))} /><span><Trans>Required</Trans></span></label>
      <div className="type-field-actions">{!typeKey && <ActionMenu label={t`${fieldLabel} field options`} items={[
        { label: t`Remove ${fieldLabel} field`, icon: <Trash2 aria-hidden="true" />, tone: "danger", onSelect: () => onChange((current) => removeTypeField(current, field.path)) }
      ]} />}</div>
    </div>
    {expanded && <div className="visual-field-details">
      <div className="field-path"><span>{fieldLabel}</span>{field.advancedKeys.length > 0 && <strong><Trans>Advanced YAML rules</Trans></strong>}</div>
      {pendingKind && <div className="field-conversion-warning" role="alert">
        <CircleAlert aria-hidden="true" />
        <div><strong><Trans>Convert this field to {kindLabel(pendingKind)}?</Trans></strong><p>{conversionImpact.length ? t`This removes ${formatList(conversionImpact)}.` : t`Its current structural rules will be replaced.`}</p></div>
        <button onClick={() => setPendingKind(undefined)}><Trans>Cancel</Trans></button>
        <button className="confirm-field-conversion" onClick={() => {
          onChange((current) => setTypeFieldKind(current, field.path, pendingKind));
          setPendingKind(undefined);
        }}><Trans>Convert field</Trans></button>
      </div>}
      <label className="field-description"><span><Trans>Description</Trans></span><input aria-label={t`${fieldLabel} description`} value={field.description ?? ""} placeholder={t`What belongs in this field?`} onChange={(event) => onChange((current) => setTypeFieldDescription(current, field.path, event.target.value))} /></label>
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
  useLingui();
  return <div className="nested-field-group">
    <div className="nested-field-heading"><div><strong><Trans>Nested fields</Trans></strong><span>{node.constraints.additionalProperties === false ? t`Only declared fields are allowed` : t`Other fields are allowed`}</span></div><button onClick={() => onChange((current) => addTypeField(current, node.path))}><Plus aria-hidden="true" /><Trans>Add nested field</Trans></button></div>
    {node.fields.map((field) => <VisualFieldRow
      key={typeFieldPathLabel(field.path)}
      field={field}
      source={source}
      depth={depth}
      activeField={activeField}
      onActivate={onActivate}
      onChange={onChange}
    />)}
    {!node.fields.length && <p className="nested-field-empty"><Trans>No nested fields yet.</Trans></p>}
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
  useLingui();
  const [pendingKind, setPendingKind] = useState<Exclude<TypeFieldKind, "advanced">>();
  const itemLabel = typeFieldPathLabel(item.path);
  const impact = pendingKind ? typeFieldConversionImpact(source, item.path, pendingKind) : [];
  return <div className="list-item-editor">
    <div className="list-item-heading">
      <div><strong><Trans>List items</Trans></strong><span>{itemLabel}</span></div>
      <label><span className="sr-only"><Trans>{itemLabel} field type</Trans></span><Select aria-label={t`${itemLabel} field type`} value={item.kind} options={kindOptions(item.kind)} onChange={(kind) => {
        if (kind === "advanced" || kind === item.kind) return;
        const nextKind = kind as Exclude<TypeFieldKind, "advanced">;
        if (typeFieldConversionImpact(source, item.path, nextKind).length) setPendingKind(nextKind);
        else onChange((current) => setTypeListItemKind(current, item.path.slice(0, -1), nextKind));
      }} /></label>
    </div>
    {pendingKind && <div className="field-conversion-warning" role="alert">
      <CircleAlert aria-hidden="true" />
      <div><strong><Trans>Convert list items to {kindLabel(pendingKind)}?</Trans></strong><p>{impact.length ? t`This removes ${formatList(impact)}.` : t`Their current structural rules will be replaced.`}</p></div>
      <button onClick={() => setPendingKind(undefined)}><Trans>Cancel</Trans></button>
      <button className="confirm-field-conversion" onClick={() => {
        onChange((current) => setTypeListItemKind(current, item.path.slice(0, -1), pendingKind));
        setPendingKind(undefined);
      }}><Trans>Convert items</Trans></button>
    </div>}
    {item.kind === "object" && <ObjectFields node={item} source={source} depth={depth} activeField={activeField} onActivate={onActivate} onChange={onChange} />}
    {item.kind === "array" && item.item && <ListItemEditor item={item.item} source={source} depth={depth + 1} activeField={activeField} onActivate={onActivate} onChange={onChange} />}
    {item.advancedKeys.length > 0 && <p className="advanced-item-note"><Trans>Additional item rules remain in YAML.</Trans></p>}
  </div>;
}

function fieldBranchIsActive(activeField: string | undefined, field: string): boolean {
  return activeField === field
    || Boolean(activeField?.startsWith(`${field}.`))
    || Boolean(activeField?.startsWith(`${field}[]`));
}

const fieldKindOptions: SelectOption<TypeFieldKind>[] = [{ value: "string", get label() { return t`Text`; } }, { value: "number", get label() { return t`Number`; } }, { value: "integer", get label() { return t`Integer`; } }, { value: "boolean", get label() { return t`Checkbox`; } }, { value: "array", get label() { return t`List`; } }, { value: "date", get label() { return t`Date`; } }, { value: "datetime", get label() { return t`Date and time`; } }, { value: "object", get label() { return t`Object`; } }];

function kindOptions(current: TypeFieldKind): SelectOption<TypeFieldKind>[] {
  return current === "advanced" ? [{ value: "advanced", label: t`Advanced` }, ...fieldKindOptions] : fieldKindOptions;
}

const linkFormatOptions = [{ value: "", get label() { return t`Any supported format`; } }, { value: "wikilink", label: "Wikilink" }, { value: "markdown", get label() { return t`Markdown link`; } }, { value: "path", get label() { return t`Path`; } }, { value: "any", get label() { return t`Any`; } }];
const uniqueScopeOptions = [{ value: "type", get label() { return t`This type`; } }, { value: "collection", get label() { return t`Entire collection`; } }, { value: "path_glob", get label() { return t`Path pattern`; } }];

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
  useLingui();
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
            listLabel={t`${itemLabel} suggestions`}
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
        <InlineRemoveButton className="string-list-remove" label={t`Remove ${itemLabel.toLocaleLowerCase()} ${index + 1}`} onMouseDown={(event) => event.preventDefault()} onClick={() => commit(drafts.filter((_, itemIndex) => itemIndex !== index))} />
      </div>)}
      {!drafts.length && <p><Trans>No entries.</Trans></p>}
    </div>
  </div>;
}

function FieldConstraints({ field, onChange }: {
  field: TypeFieldDefinition;
  onChange: (change: (source: string) => string) => void;
}) {
  useLingui();
  const controls: ReactNode[] = [];
  const constraint = (key: string, label: string, value?: number) => controls.push(<label key={key}><span>{label}</span><input
    key={`${key}:${value ?? ""}`}
    type="number"
    defaultValue={value}
    min="0"
    onBlur={(event) => onChange((current) => setTypeFieldConstraint(current, field.path, key, event.target.value === "" ? undefined : Number(event.target.value)))}
  /></label>);
  if (field.kind === "string") {
    constraint("minLength", t`Minimum length`, field.constraints.minLength);
    constraint("maxLength", t`Maximum length`, field.constraints.maxLength);
    controls.push(<label key="pattern"><span><Trans>Pattern</Trans></span><input value={field.constraints.pattern ?? ""} placeholder={t`Optional regular expression`} onChange={(event) => onChange((current) => setTypeFieldConstraint(current, field.path, "pattern", event.target.value || undefined))} /></label>);
    controls.push(<div className="field-choices" key="choices"><StringListEditor
      label={t`Choices`}
      values={field.constraints.choices ?? []}
      itemLabel={t`${typeFieldPathLabel(field.path)} choice`}
      addLabel={t`Add choice`}
      placeholder={t`Choice value`}
      helper="Saved values must equal one of these strings."
      onChange={(values) => onChange((current) => setTypeFieldChoices(current, field.path, values))}
    /></div>);
  }
  if (field.kind === "number" || field.kind === "integer") {
    controls.push(<label key="minimum"><span><Trans>Minimum</Trans></span><input key={`minimum:${field.constraints.minimum ?? ""}`} type="number" defaultValue={field.constraints.minimum} onBlur={(event) => onChange((current) => setTypeFieldConstraint(current, field.path, "minimum", event.target.value === "" ? undefined : Number(event.target.value)))} /></label>);
    controls.push(<label key="maximum"><span><Trans>Maximum</Trans></span><input key={`maximum:${field.constraints.maximum ?? ""}`} type="number" defaultValue={field.constraints.maximum} onBlur={(event) => onChange((current) => setTypeFieldConstraint(current, field.path, "maximum", event.target.value === "" ? undefined : Number(event.target.value)))} /></label>);
  }
  if (field.kind === "array") {
    constraint("minItems", t`Minimum items`, field.constraints.minItems);
    constraint("maxItems", t`Maximum items`, field.constraints.maxItems);
    controls.push(<label className="field-toggle" key="uniqueItems"><input className="mdbase-checkbox" type="checkbox" checked={field.constraints.uniqueItems === true} onChange={(event) => onChange((current) => setTypeFieldConstraint(current, field.path, "uniqueItems", event.target.checked || undefined))} /><span><Trans>Require unique items</Trans></span></label>);
  }
  if (field.kind === "object") {
    controls.push(<label className="field-toggle" key="additionalProperties"><input className="mdbase-checkbox" type="checkbox" checked={field.constraints.additionalProperties !== false} onChange={(event) => onChange((current) => setTypeFieldConstraint(current, field.path, "additionalProperties", event.target.checked))} /><span><Trans>Allow undeclared fields</Trans></span></label>);
  }
  if (!controls.length) return null;
  return <div className="field-constraint-grid">{controls}</div>;
}

function normalizedListStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function matchRuleLabel(key: string): string {
  if (key === "where") return t`Structured frontmatter conditions`;
  if (key === "expr") return "CEL expression";
  if (key === "path_glob") return t`Path patterns with an unsupported value`;
  if (key === "fields_present") return t`Field selectors with an unsupported value`;
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
  useLingui();
  const diff = compareLines(previousSource ?? "", source);
  const changeCount = impact.addedFields.length + impact.removedFields.length + impact.changedFields.length + impact.newlyRequired.length;
  return <div className="type-change-review">
    <p className="eyebrow"><Trans>Review changes</Trans></p>
    <h2>{creating ? t`Create this type?` : t`Update this type?`}</h2>
    <p>{changeCount ? plural(changeCount, { one: `# field-level change detected.`, other: `# field-level changes detected.` }) : t`The source changed without altering declared fields.`}</p>
    <dl>
      <div><dt><Trans>Matching notes</Trans></dt><dd>{impact.affectedNotes.toLocaleString(displayLocale())}</dd></div>
      <div><dt><Trans>Fields added</Trans></dt><dd>{impact.addedFields.length}</dd></div>
      <div><dt><Trans>Fields removed</Trans></dt><dd>{impact.removedFields.length}</dd></div>
      <div><dt><Trans>Fields changed</Trans></dt><dd>{impact.changedFields.length}</dd></div>
    </dl>
    <TypeMembershipPreview impact={impact.membership} afterUpdate />
    {impact.definitionChanges.length > 0 && <div className="type-definition-changes"><strong><Trans>Definition changes</Trans></strong><p>{impact.definitionChanges.join(" · ")}</p></div>}
    {impact.collectionChanges.length > 0 && <div className="type-collection-changes">
      <strong><Trans>Collection behaviour</Trans></strong>
      <p>{impact.collectionChanges.join(" · ")}</p>
    </div>}
    {impact.collectionChanges.some((change) => change === "Link rules" || change === "Uniqueness rules") && <div className="type-impact-warning" role="alert">
      <CircleAlert aria-hidden="true" />
      <div><strong><Trans>Validation may change</Trans></strong><p><Trans>Link and uniqueness rules can make matching records valid or invalid without changing their source files.</Trans></p></div>
    </div>}
    {impact.collectionChanges.includes("Path policy") && <div className="type-impact-warning" role="alert">
      <CircleAlert aria-hidden="true" />
      <div><strong><Trans>Future file paths may change</Trans></strong><p><Trans>Compatible tools use this policy when creating and renaming records. Existing files are not moved by this update.</Trans></p></div>
    </div>}
    {impact.missingRequired.length > 0 && <div className="type-impact-warning" role="alert">
      <CircleAlert aria-hidden="true" />
      <div><strong><Trans>Existing notes need attention</Trans></strong>{impact.missingRequired.map((item) => <p key={item.field}>{plural(item.count, { one: `# note is missing required field ${item.field}.`, other: `# notes are missing required field ${item.field}.` })}</p>)}</div>
    </div>}
    <p className="type-review-scope"><Trans>Impact is based on the currently indexed notes. The collection validates the complete definition when you confirm.</Trans></p>
    <details><summary><Trans>Review YAML diff</Trans></summary><div className="line-diff" role="table" aria-label={t`Type source differences`}>{diff.map((line, index) => <div className={`diff-line ${line.kind}`} role="row" key={`${line.kind}:${index}`}><span className="diff-marker" aria-hidden="true">{line.kind === "local" ? "−" : line.kind === "remote" ? "+" : line.kind === "omitted" ? "···" : " "}</span><span className="diff-line-number" aria-hidden="true">{line.localLine ?? line.remoteLine ?? ""}</span><code role="cell">{line.text || " "}</code></div>)}</div></details>
    <div className="type-review-actions"><button className="mdbase-button is-tertiary" onClick={onBack}><Trans>Back to editing</Trans></button><button className="confirm-type-button mdbase-button is-primary" disabled={saving} onClick={onConfirm}>{saving ? t`Saving…` : creating ? t`Create type` : t`Confirm update`}</button></div>
  </div>;
}

function formatList(values: string[]): string {
  if (values.length <= 1) return values[0] ?? t`the current rules`;
  return new Intl.ListFormat(displayLocale(), { style: "long", type: "conjunction" }).format(values);
}

function parseVisualType(source: string): { value?: VisualTypeDefinition; error?: string } {
  try {
    return { value: readVisualType(source) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : t`The YAML source could not be read.` };
  }
}

function propertyCount(type: CollectionTypeDescriptor): number {
  const properties = type.schema.properties;
  return properties && !Array.isArray(properties) && typeof properties === "object" ? Object.keys(properties).length : 0;
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
