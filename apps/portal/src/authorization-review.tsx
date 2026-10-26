import { t, plural } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useLocaleRevision, i18n } from "@mdbase-dev/ui/i18n";
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
import { HIGHER_IMPACT_FILE_ACTIONS, HIGHER_IMPACT_PEOPLE_PERMISSIONS, type AuthorizationCapabilityGroup } from "./authorization-capabilities";
import { Select } from "@mdbase-dev/ui/select";

type FileRequirements = NonNullable<PendingAuthorization["requirements"]["files"]>;
type PeopleRequirement = import("@mdbase-dev/connect-protocol").ApplicationPeopleRequirement;

const PEOPLE_PERMISSION_LABELS: Record<string, string> = {
  get identity() { return t(i18n)({ message: "See your account identity and display name" }); },
  get members() { return t(i18n)({ message: "See collection members' account identities, names and roles" }); }
};

const FILE_ACTION_LABELS: Record<ApplicationFileAction, string> = {
  get list() { return t(i18n)({ message: "List file names and metadata" }); },
  get read() { return t(i18n)({ message: "Read file contents", context: "Application access approval" }); },
  get add() { return t(i18n)({ message: "Add new files", context: "Application access approval" }); },
  get replace() { return t(i18n)({ message: "Replace existing files", context: "Application access approval" }); },
  get move() { return t(i18n)({ message: "Move and rename files", context: "Application access approval" }); },
  get delete() { return t(i18n)({ message: "Delete files", context: "Application access approval" }); }
};

/** Standalone permission labels also used by the exact-file consent screen. */
export function fileActionLabel(action: ApplicationFileAction): string {
  return FILE_ACTION_LABELS[action];
}

function fileScopeDescription(files: FileRequirements): string {
  return files.scope.kind === "collection"
    ? t(i18n)({ message: "Every visible folder. Hidden folders are always excluded." })
    : t(i18n)`Only ${files.scope.folders.join(", ")}. Hidden folders are always excluded.`;
}

function groupSelected(group: AuthorizationCapabilityGroup, selected: ReadonlySet<string>) {
  return group.operations.every((operation) => selected.has(operation));
}

// A compact, read-only statement of what the request asks for, shown before a
// collection is chosen so the user can deny without choosing anything.
export function RequestedAccessSummary({ groups, files, people }: {
  groups: AuthorizationCapabilityGroup[];
  files?: FileRequirements;
  people?: PeopleRequirement;
}) {
  useLocaleRevision();
  const items = groups.map((group) => ({ id: group.id, label: group.label, higherImpact: group.higherImpact }));
  if (files && !groups.some(group => group.fileActions !== undefined)) {
    const actions = "actions" in files ? files.actions : [...files.required, ...(files.optional ?? [])];
    const deletes = actions.some((action) => HIGHER_IMPACT_FILE_ACTIONS.has(action));
    items.push({ id: "files", label: deletes ? t(i18n)({ message: "Manage and delete files", context: "Application access approval" }) : t(i18n)({ message: "Work with files", context: "Application access approval" }), higherImpact: deletes });
  }
  for (const permission of [...(people?.required ?? []), ...(people?.optional ?? [])]) {
    items.push({ id: `people.${permission}`, label: PEOPLE_PERMISSION_LABELS[permission], higherImpact: HIGHER_IMPACT_PEOPLE_PERMISSIONS.has(permission) });
  }
  return (
    <ul className="requested-access" aria-label={t(i18n)({ message: "Requested access", context: "Application access approval" })}>
      {items.map((item) => <li className={item.higherImpact ? "higher-impact" : undefined} key={item.id}>
        {item.label}
        {item.higherImpact && <span className="sr-only"><Trans> (higher impact)</Trans></span>}
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
  useLocaleRevision();
  const content = <>
    {locked
      ? <span className="permission-fixed" aria-hidden="true">✓</span>
      : <input type="checkbox" checked={checked} disabled={disabled} onChange={onToggle} />}
    <span className="permission-copy">
      <strong>{label}</strong>
      {description && <small>{description}</small>}
    </span>
    <span className="permission-tags">
      {isNew && <span className="permission-tag new"><Trans>New</Trans></span>}
      {higherImpact && <span className="permission-tag impact"><Trans><i aria-hidden="true" />Higher impact</Trans></span>}
      {required && <span className="permission-tag"><Trans>Required</Trans></span>}
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
  people,
  selectedPeople,
  disabled,
  onToggleGroup,
  onToggleFile,
  onTogglePeople
}: {
  groups: AuthorizationCapabilityGroup[];
  selected: ReadonlySet<string>;
  existingOperations?: ReadonlySet<string>;
  files?: FileRequirements;
  selectedFiles: ReadonlySet<string>;
  allowedFileActions?: readonly ApplicationFileAction[];
  people?: PeopleRequirement;
  selectedPeople: ReadonlySet<string>;
  disabled: boolean;
  onToggleGroup(group: AuthorizationCapabilityGroup): void;
  onToggleFile(action: ApplicationFileAction): void;
  onTogglePeople(permission: string): void;
}) {
  useLocaleRevision();
  const reauthorizing = Boolean(existingOperations && existingOperations.size > 0);
  const jointPermissions = groups.some(group => group.fileActions !== undefined);
  const fileRows = files ? "actions" in files
    ? files.actions.map((action) => ({ action, locked: true, required: false }))
    : [
        ...files.required.map((action) => ({ action, locked: true, required: true })),
        ...(files.optional ?? [])
          .filter((action) => !allowedFileActions || allowedFileActions.includes(action))
          .map((action) => ({ action, locked: false, required: false }))
      ] : [];
  return <>
    {groups.length > 0 && <ul className="permission-list" aria-label={t(i18n)({ message: "Collection permissions", context: "Application access approval" })}>
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
        <strong>{jointPermissions ? t(i18n)({ message: "File scope", context: "Application access approval" }) : t(i18n)({ message: "Files", context: "Application access approval" })}</strong>
        <small>{fileScopeDescription(files)}{jointPermissions ? t(i18n)({ message: " File actions are included in the collection permissions above." }) : "actions" in files ? t(i18n)({ message: " These actions are approved together." }) : ""}</small>
      </p>
      {!jointPermissions && <ul className="permission-list" aria-label={t(i18n)({ message: "File permissions", context: "Application access approval" })}>
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
      </ul>}
    </div>}
    {people && <div className="permission-files">
      <p className="permission-files-heading">
        <strong><Trans>People</Trans></strong>
        <small><Trans>Account identifiers are the same in every collection, so this application can recognise the same person elsewhere. Email addresses and pending invitations are never shared, and this does not let it manage membership.</Trans></small>
      </p>
      <ul className="permission-list" aria-label={t(i18n)({ message: "People permissions", context: "Application access approval" })}>
        {[...(people.required ?? []).map((permission) => ({ permission, required: true })),
          ...(people.optional ?? []).map((permission) => ({ permission, required: false }))]
          .map(({ permission, required }) => <PermissionRow
            key={permission}
            id={`people.${permission}`}
            label={PEOPLE_PERMISSION_LABELS[permission]}
            locked={required}
            required={required}
            checked={selectedPeople.has(permission)}
            higherImpact={HIGHER_IMPACT_PEOPLE_PERMISSIONS.has(permission)}
            isNew={false}
            disabled={disabled}
            onToggle={() => onTogglePeople(permission)}
          />)}
      </ul>
    </div>}
  </>;
}

export function NotificationAccess({ applicationName, notifications }: {
  applicationName: string;
  notifications: PendingAuthorization["notifications"];
}) {
  useLocaleRevision();
  if (notifications.criteria.length === 0) return null;
  return (
    <details className="notification-access">
      <summary>
        <span>
          <strong><Trans>Change notifications</Trans></strong>
          <small>{plural(notifications.criteria.length, {
            one: `${applicationName} can turn on this rule after access is allowed. Notifications never contain record content.`,
            other: `${applicationName} can turn on these # rules after access is allowed. Notifications never contain record content.`,
          })}</small>
        </span>
        <b>{t(i18n)({ message: "Details", context: "Application access approval" })}</b>
      </summary>
      <ul>{notifications.criteria.map((criterion) => (
        <li key={criterion.id}>
          <span>{criterion.presentation.title}</span>
          <code>{criterion.event.id}  {t(i18n)({ message: "v", context: "Application access approval" })}{criterion.event.version}</code>
        </li>
      ))}</ul>
      <p><Trans>The rules run inside the collection. A notification tells {applicationName} that something changed, not what changed.</Trans></p>
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
  useLocaleRevision();
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
          <strong><Trans>{applicationName} needs a {setupLabel(contract).toLocaleLowerCase()} type</Trans></strong>
          <small><Trans>Allowing access adds a separate type supplied by {applicationName}. Existing records stay unchanged.</Trans></small>
          <details className="contract-expert-details">
            <summary><Trans>Expert details</Trans></summary>
            <code>{contract.id} · {contract.version}</code>
            {contract.description && <p>{contract.description}</p>}
            {!canGuideExistingType && suggestions.length > 0 && <p><Trans>This application uses advanced behavior settings, so an existing type cannot be connected during approval.</Trans></p>}
          </details>
        </div>
      </div>
    );
  }

  return (
    <div className="contract-setup-editor">
      <div className="contract-setup-heading">
        <div>
          <strong><Trans>Help {applicationName} understand {setupLabel(contract).toLocaleLowerCase()}</Trans></strong>
          <small>{contract.description ?? t(i18n)`Choose whether to add a new ${setupLabel(contract).toLocaleLowerCase()} type or use one you already have.`}</small>
        </div>
        <details className="contract-expert-details">
          <summary><Trans>Expert details</Trans></summary>
          <code>{contract.id} · {contract.version}</code>
        </details>
      </div>
      <div className="contract-setup-mode" role="radiogroup" aria-label={t(i18n)`Setup for ${setupLabel(contract)}`}>
        <label className={value.mode === "starter" ? "selected" : undefined}>
          <input type="radio" name={`setup-${contract.id}-${contract.version}`} checked={value.mode === "starter"} disabled={disabled} onChange={() => onChange({ ...value, mode: "starter" })} />
          <span><strong><Trans>Add a new {setupLabel(contract).toLocaleLowerCase()} type</Trans></strong><small><Trans>Create a separate type supplied by {applicationName}.</Trans></small></span>
        </label>
        <label className={value.mode === "existing" ? "selected" : undefined}>
          <input type="radio" name={`setup-${contract.id}-${contract.version}`} checked={value.mode === "existing"} disabled={disabled} onChange={() => onChange({ ...value, mode: "existing" })} />
          <span><strong><Trans>Use an existing type</Trans></strong><small><Trans>Keep your current records and explain which fields mean the same thing.</Trans></small></span>
        </label>
      </div>
      {value.mode === "existing" && canGuideExistingType && <div className="contract-mapping">
        <label className="contract-type-choice">
          <span><Trans>Existing type</Trans></span>
          <Select
            aria-label={t(i18n)({ message: "Existing type", context: "Application access approval" })}
            value={value.typeName}
            disabled={disabled}
            options={suggestions.map((suggestion, index) => ({ value: suggestion.type.name, label: index === 0 && suggestion.requiredMatched === suggestion.requiredTotal ? t(i18n)`${suggestion.type.name} · suggested` : suggestion.type.name }))}
            onChange={selectType}
          />
        </label>
        <div className="contract-field-list">{fields.map((field) => {
          const mapped = value.fields[field.reference] ?? "";
          const typeField = availableFields.find((candidate) => candidate.reference === mapped);
          const assessment = assessMapping(field, typeField);
          return <label key={field.reference}>
            <span><strong>{field.label}{field.required ? " *" : ""}</strong><small>{field.description ?? t(i18n)`The application’s ${field.label.toLocaleLowerCase()} value.`}</small></span>
            <Select
              aria-label={field.label}
              value={mapped}
              disabled={disabled}
              aria-invalid={assessment.level === "error"}
              options={[
                { value: "", label: field.required ? t(i18n)`Choose a field` : t(i18n)`Do not share` },
                ...availableFields.map((candidate) => ({ value: candidate.reference, label: candidate.label }))
              ]}
              onChange={(chosen) => {
                const next = { ...value.fields };
                if (chosen) next[field.reference] = chosen;
                else delete next[field.reference];
                onChange({ ...value, fields: next });
              }}
            />
            <small className={`mapping-assessment ${assessment.level}`}>{assessment.label} · {assessment.message}</small>
          </label>;
        })}</div>
        {bindingFields.length > 0 && <fieldset className="contract-binding">
          <legend><Trans>How this type behaves in {applicationName}</Trans></legend>
          {bindingFields.map((field) => <SchemaInput key={field.name} field={field} required={requiredBinding.has(field.name)} value={value.binding[field.name]} disabled={disabled} onChange={(next) => onChange({ ...value, binding: { ...value.binding, [field.name]: next } })} />)}
        </fieldset>}
        <p className="field-note"><Trans>Only this type definition changes. Existing records stay in place. Setup is validated before access becomes active.</Trans></p>
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
  useLocaleRevision();
  const options = Array.isArray(field.schema.enum) ? field.schema.enum : undefined;
  return <label>
    <span>{field.label}{required ? " *" : ""}</span>
    {options ? <Select
      aria-label={field.label}
      value={value === undefined ? "" : String(value)}
      disabled={disabled}
      placeholder={t(i18n)({ message: "Choose", context: "Application access approval" })}
      options={options.map((option) => ({ value: String(option), label: String(option) }))}
      onChange={(chosen) => onChange(options.find((option) => String(option) === chosen))}
    /> : field.kind === "boolean" ? <input type="checkbox" checked={value === true} disabled={disabled} onChange={(event) => onChange(event.target.checked)} /> : <input
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
  if (!choice) return t(i18n)`Choose how to set up ${label}.`;
  if (choice.mode === "starter") return undefined;
  const type = types.find((candidate) => candidate.name === choice.typeName);
  if (!type?.revision) return t(i18n)`Choose an existing type for ${label}.`;
  const available = typeFields(type);
  const unmapped = contractFields(contract).find((field) => {
    const candidate = available.find((value) => value.reference === choice.fields[field.reference]);
    return assessMapping(field, candidate).level === "error";
  });
  if (unmapped) return t(i18n)`Choose a matching field for ${unmapped.label} in ${label}.`;
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
    return t(i18n)`Fill in ${field?.label ?? missing} in ${label}.`;
  }
  return undefined;
}
