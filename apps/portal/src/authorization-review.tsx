import {
  assessMapping,
  contractFields,
  guidedBindingSupported,
  propertyFields,
  setupLabel,
  suggestTypes,
  typeFields,
  type SetupContract,
  type SetupType
} from "@mdbase/connect-ui/contract-setup";
import { useMemo } from "react";
import { initialContractSetupChoice } from "./application-setup";
import type { ApplicationFileAction, PendingAuthorization } from "./api";
import { HIGHER_IMPACT_FILE_ACTIONS, type AuthorizationCapabilityGroup } from "./authorization-capabilities";

type FileRequirements = NonNullable<PendingAuthorization["requirements"]["files"]>;

const FILE_ACTION_LABELS: Record<ApplicationFileAction, string> = {
  list: "List file names and metadata",
  read: "Read file contents",
  add: "Add new files",
  replace: "Replace existing files",
  move: "Move and rename files",
  delete: "Delete files"
};

function fileScopeDescription(files: FileRequirements): string {
  return files.scope.kind === "collection"
    ? "Every visible folder. Hidden folders are always excluded."
    : `Only ${files.scope.folders.join(", ")}. Hidden folders are always excluded.`;
}

function groupSelected(group: AuthorizationCapabilityGroup, selected: ReadonlySet<string>) {
  return group.operations.every((operation) => selected.has(operation));
}

// A compact, read-only statement of what the request asks for, shown before a
// collection is chosen so the user can deny without choosing anything.
export function RequestedAccessSummary({ groups, files }: {
  groups: AuthorizationCapabilityGroup[];
  files?: FileRequirements;
}) {
  const items = groups.map((group) => ({ id: group.id, label: group.label, higherImpact: group.higherImpact }));
  if (files) {
    const actions = "actions" in files ? files.actions : [...files.required, ...(files.optional ?? [])];
    const deletes = actions.some((action) => HIGHER_IMPACT_FILE_ACTIONS.has(action));
    items.push({ id: "files", label: deletes ? "Manage and delete files" : "Work with files", higherImpact: deletes });
  }
  return (
    <ul className="requested-access" aria-label="Requested access">
      {items.map((item) => <li className={item.higherImpact ? "higher-impact" : undefined} key={item.id}>
        {item.label}
        {item.higherImpact && <span className="sr-only"> (higher impact)</span>}
      </li>)}
    </ul>
  );
}

// A locked row has no control: it is either required by the application or,
// for exact v1 file actions, approved together with the rest of the request.
function PermissionRow({ id, label, description, locked, required, checked, higherImpact, isNew, disabled, onToggle }: {
  id: string;
  label: string;
  description?: string;
  locked: boolean;
  required: boolean;
  checked: boolean;
  higherImpact: boolean;
  isNew: boolean;
  disabled: boolean;
  onToggle?(): void;
}) {
  const content = <>
    {locked
      ? <span className="permission-fixed" aria-hidden="true">✓</span>
      : <input type="checkbox" checked={checked} disabled={disabled} onChange={onToggle} />}
    <span className="permission-copy">
      <strong>{label}</strong>
      {description && <small>{description}</small>}
    </span>
    <span className="permission-tags">
      {isNew && <span className="permission-tag new">New</span>}
      {higherImpact && <span className="permission-tag impact"><i aria-hidden="true" />Higher impact</span>}
      {required && <span className="permission-tag">Required</span>}
    </span>
  </>;
  return <li className={`permission-row${higherImpact ? " higher-impact" : ""}`} data-permission={id}>
    {locked ? <div>{content}</div> : <label>{content}</label>}
  </li>;
}

export function PermissionList({
  groups,
  selected,
  existingOperations,
  files,
  selectedFiles,
  allowedFileActions,
  disabled,
  onToggleGroup,
  onToggleFile
}: {
  groups: AuthorizationCapabilityGroup[];
  selected: ReadonlySet<string>;
  existingOperations?: ReadonlySet<string>;
  files?: FileRequirements;
  selectedFiles: ReadonlySet<string>;
  allowedFileActions?: readonly ApplicationFileAction[];
  disabled: boolean;
  onToggleGroup(group: AuthorizationCapabilityGroup): void;
  onToggleFile(action: ApplicationFileAction): void;
}) {
  const reauthorizing = Boolean(existingOperations && existingOperations.size > 0);
  const fileRows = files ? "actions" in files
    ? files.actions.map((action) => ({ action, locked: true, required: false }))
    : [
        ...files.required.map((action) => ({ action, locked: true, required: true })),
        ...(files.optional ?? [])
          .filter((action) => !allowedFileActions || allowedFileActions.includes(action))
          .map((action) => ({ action, locked: false, required: false }))
      ] : [];
  return <>
    {groups.length > 0 && <ul className="permission-list" aria-label="Collection permissions">
      {groups.map((group) => <PermissionRow
        key={group.id}
        id={group.id}
        label={group.label}
        description={group.description}
        locked={group.required}
        required={group.required}
        checked={groupSelected(group, selected)}
        higherImpact={group.higherImpact}
        isNew={reauthorizing && !group.operations.every((operation) => existingOperations!.has(operation))}
        disabled={disabled}
        onToggle={() => onToggleGroup(group)}
      />)}
    </ul>}
    {files && <div className="permission-files">
      <p className="permission-files-heading">
        <strong>Files</strong>
        <small>{fileScopeDescription(files)}{"actions" in files ? " These actions are approved together." : ""}</small>
      </p>
      <ul className="permission-list" aria-label="File permissions">
        {fileRows.map(({ action, locked, required }) => <PermissionRow
          key={action}
          id={`files.${action}`}
          label={FILE_ACTION_LABELS[action]}
          locked={locked}
          required={required}
          checked={selectedFiles.has(action)}
          higherImpact={HIGHER_IMPACT_FILE_ACTIONS.has(action)}
          isNew={false}
          disabled={disabled}
          onToggle={() => onToggleFile(action)}
        />)}
      </ul>
    </div>}
  </>;
}

export function NotificationAccess({ applicationName, notifications }: {
  applicationName: string;
  notifications: PendingAuthorization["notifications"];
}) {
  if (notifications.criteria.length === 0) return null;
  return (
    <details className="notification-access">
      <summary>
        <span>
          <strong>Change notifications</strong>
          <small>{applicationName} can turn on {notifications.criteria.length === 1 ? "this rule" : `these ${notifications.criteria.length} rules`} after access is allowed. Notifications never contain record content.</small>
        </span>
        <b>Details</b>
      </summary>
      <ul>{notifications.criteria.map((criterion) => (
        <li key={criterion.id}>
          <span>{criterion.presentation.title}</span>
          <code>{criterion.event.id} v{criterion.event.version}</code>
        </li>
      ))}</ul>
      <p>The rules run inside the collection. A notification tells {applicationName} that something changed, not what changed.</p>
    </details>
  );
}

export type ContractSetupChoice = ReturnType<typeof initialContractSetupChoice>;

export function ContractSetupEditor({
  applicationName,
  contract,
  types,
  value,
  disabled,
  onChange
}: {
  applicationName: string;
  contract: SetupContract;
  types: SetupType[];
  value: ContractSetupChoice;
  disabled: boolean;
  onChange(value: ContractSetupChoice): void;
}) {
  const suggestions = useMemo(() => suggestTypes(contract, types), [contract, types]);
  const canGuideExistingType = guidedBindingSupported(contract);
  const canChooseExistingType = suggestions.length > 0 && canGuideExistingType;
  const selectedType = types.find((type) => type.name === value.typeName);
  const availableFields = selectedType ? typeFields(selectedType) : [];
  const fields = contractFields(contract);
  const bindingFields = contract.binding_schema ? propertyFields(contract.binding_schema) : [];
  const requiredBinding = new Set(
    Array.isArray(contract.binding_schema?.required)
      ? contract.binding_schema.required.filter((field): field is string => typeof field === "string")
      : []
  );

  function selectType(typeName: string) {
    const suggestion = suggestions.find((candidate) => candidate.type.name === typeName);
    onChange({ ...value, typeName, fields: suggestion?.fields ?? {} });
  }

  if (!canChooseExistingType) {
    return (
      <div className="contract-setup-consequence">
        <span className="setup-change-mark" aria-hidden="true">+</span>
        <div>
          <strong>{applicationName} needs a {setupLabel(contract).toLocaleLowerCase()} type</strong>
          <small>Allowing access adds a separate type supplied by {applicationName}. Existing records stay unchanged.</small>
          <details className="contract-expert-details">
            <summary>Expert details</summary>
            <code>{contract.id} · {contract.version}</code>
            {contract.description && <p>{contract.description}</p>}
            {!canGuideExistingType && suggestions.length > 0 && <p>This application uses advanced behavior settings, so an existing type cannot be connected during approval.</p>}
          </details>
        </div>
      </div>
    );
  }

  return (
    <div className="contract-setup-editor">
      <div className="contract-setup-heading">
        <div>
          <strong>Help {applicationName} understand {setupLabel(contract).toLocaleLowerCase()}</strong>
          <small>{contract.description ?? `Choose whether to add a new ${setupLabel(contract).toLocaleLowerCase()} type or use one you already have.`}</small>
        </div>
        <details className="contract-expert-details">
          <summary>Expert details</summary>
          <code>{contract.id} · {contract.version}</code>
        </details>
      </div>
      <div className="contract-setup-mode" role="radiogroup" aria-label={`Setup for ${setupLabel(contract)}`}>
        <label className={value.mode === "starter" ? "selected" : undefined}>
          <input type="radio" name={`setup-${contract.id}-${contract.version}`} checked={value.mode === "starter"} disabled={disabled} onChange={() => onChange({ ...value, mode: "starter" })} />
          <span><strong>Add a new {setupLabel(contract).toLocaleLowerCase()} type</strong><small>Create a separate type supplied by {applicationName}.</small></span>
        </label>
        <label className={value.mode === "existing" ? "selected" : undefined}>
          <input type="radio" name={`setup-${contract.id}-${contract.version}`} checked={value.mode === "existing"} disabled={disabled} onChange={() => onChange({ ...value, mode: "existing" })} />
          <span><strong>Use an existing type</strong><small>Keep your current records and explain which fields mean the same thing.</small></span>
        </label>
      </div>
      {value.mode === "existing" && canGuideExistingType && <div className="contract-mapping">
        <label className="contract-type-choice">
          <span>Existing type</span>
          <select value={value.typeName} disabled={disabled} onChange={(event) => selectType(event.target.value)}>
            {suggestions.map((suggestion, index) => <option value={suggestion.type.name} key={suggestion.type.name}>{suggestion.type.name}{index === 0 && suggestion.requiredMatched === suggestion.requiredTotal ? " · suggested" : ""}</option>)}
          </select>
        </label>
        <div className="contract-field-list">{fields.map((field) => {
          const mapped = value.fields[field.reference] ?? "";
          const typeField = availableFields.find((candidate) => candidate.reference === mapped);
          const assessment = assessMapping(field, typeField);
          return <label key={field.reference}>
            <span><strong>{field.label}{field.required ? " *" : ""}</strong><small>{field.description ?? `The application’s ${field.label.toLocaleLowerCase()} value.`}</small></span>
            <select value={mapped} disabled={disabled} aria-invalid={assessment.level === "error"} onChange={(event) => {
              const next = { ...value.fields };
              if (event.target.value) next[field.reference] = event.target.value;
              else delete next[field.reference];
              onChange({ ...value, fields: next });
            }}>
              <option value="">{field.required ? "Choose a field" : "Do not share"}</option>
              {availableFields.map((candidate) => <option key={candidate.reference} value={candidate.reference}>{candidate.label}</option>)}
            </select>
            <small className={`mapping-assessment ${assessment.level}`}>{assessment.label} · {assessment.message}</small>
          </label>;
        })}</div>
        {bindingFields.length > 0 && <fieldset className="contract-binding">
          <legend>How this type behaves in {applicationName}</legend>
          {bindingFields.map((field) => <SchemaInput key={field.name} field={field} required={requiredBinding.has(field.name)} value={value.binding[field.name]} disabled={disabled} onChange={(next) => onChange({ ...value, binding: { ...value.binding, [field.name]: next } })} />)}
        </fieldset>}
        <p className="field-note">Only this type definition changes. Existing records stay in place. Setup is validated before access becomes active.</p>
      </div>}
    </div>
  );
}

function SchemaInput({ field, required, value, disabled, onChange }: {
  field: ReturnType<typeof propertyFields>[number];
  required: boolean;
  value: unknown;
  disabled: boolean;
  onChange(value: unknown): void;
}) {
  const options = Array.isArray(field.schema.enum) ? field.schema.enum : undefined;
  return <label>
    <span>{field.label}{required ? " *" : ""}</span>
    {options ? <select value={value === undefined ? "" : String(value)} disabled={disabled} onChange={(event) => onChange(options.find((option) => String(option) === event.target.value))}>
      <option value="">Choose</option>
      {options.map((option) => <option key={String(option)} value={String(option)}>{String(option)}</option>)}
    </select> : field.kind === "boolean" ? <input type="checkbox" checked={value === true} disabled={disabled} onChange={(event) => onChange(event.target.checked)} /> : <input
      type={field.kind === "number" || field.kind === "integer" ? "number" : "text"}
      value={typeof value === "string" || typeof value === "number" ? value : ""}
      disabled={disabled}
      onChange={(event) => onChange(field.kind === "number" || field.kind === "integer" ? event.target.value === "" ? undefined : Number(event.target.value) : event.target.value)}
    />}
    {field.description && <small>{field.description}</small>}
  </label>;
}

export function contractSetupProblem(
  contract: SetupContract,
  choice: ContractSetupChoice | undefined,
  types: SetupType[]
): string | undefined {
  const label = setupLabel(contract);
  if (!choice) return `Choose how to set up ${label}.`;
  if (choice.mode === "starter") return undefined;
  const type = types.find((candidate) => candidate.name === choice.typeName);
  if (!type?.revision) return `Choose an existing type for ${label}.`;
  const available = typeFields(type);
  const unmapped = contractFields(contract).find((field) => {
    const candidate = available.find((value) => value.reference === choice.fields[field.reference]);
    return assessMapping(field, candidate).level === "error";
  });
  if (unmapped) return `Choose a matching field for ${unmapped.label} in ${label}.`;
  const requiredBinding = Array.isArray(contract.binding_schema?.required)
    ? contract.binding_schema.required.filter((field): field is string => typeof field === "string")
    : [];
  const missing = requiredBinding.find((field) => {
    const value = choice.binding[field];
    return value === undefined || value === null || value === "";
  });
  if (missing) {
    const field = contract.binding_schema
      ? propertyFields(contract.binding_schema).find((candidate) => candidate.name === missing)
      : undefined;
    return `Fill in ${field?.label ?? missing} in ${label}.`;
  }
  return undefined;
}
