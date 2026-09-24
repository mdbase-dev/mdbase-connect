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

export function fileScopeDescription(files: FileRequirements): string {
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
