import type { ApplicationFileAction, PendingAuthorization } from "./api";
import type { AuthorizationCapabilityGroup } from "./authorization-capabilities";

export function PermissionDelta({ existingAccess, collectionId, groups, selected }: {
  existingAccess: PendingAuthorization["existing_access"];
  collectionId: string;
  groups: AuthorizationCapabilityGroup[];
  selected: ReadonlySet<string>;
}) {
  const existing = new Set(existingAccess?.find((access) =>
    access.collection_id === collectionId)?.operations ?? []);
  if (existing.size === 0) return null;
  const selectedGroups = groups.filter((group) =>
    group.operations.every((operation) => selected.has(operation))
  );
  const approved = selectedGroups.filter((group) =>
    group.operations.every((operation) => existing.has(operation))
  ).length;
  const added = selectedGroups.length - approved;
  const unit = groups.some((group) => group.semantics === "exact") ? "action" : "capability";
  return <div className="permission-delta" role="note">
    <span><strong>{approved}</strong> already approved</span>
    <span><strong>{added}</strong> {added === 1 ? unit : unit === "action" ? "actions" : "capabilities"} added by this request</span>
  </div>;
}

export function PermissionCapabilitySummary({
  groups,
  selected,
  files,
  selectedFiles
}: {
  groups: AuthorizationCapabilityGroup[];
  selected: ReadonlySet<string>;
  files?: PendingAuthorization["requirements"]["files"];
  selectedFiles: ReadonlySet<string>;
}) {
  const capabilities = groups.filter((group) =>
    group.operations.every((operation) => selected.has(operation))
  ).map((group) => ({
    id: group.id,
    label: group.label,
    description: group.description,
    higherImpact: group.higherImpact
  }));
  if (files && selectedFiles.size > 0) {
    capabilities.push({
      id: "files",
      label: selectedFiles.has("delete") ? "Manage and delete files" : "Work with files",
      description: files.scope.kind === "collection"
        ? "Use the approved file actions in every visible folder."
        : `Use the approved file actions in ${files.scope.folders.join(", ")}.`,
      higherImpact: selectedFiles.has("delete")
    });
  }
  return (
    <ul className="permission-capabilities" aria-label="What this application can do">
      {capabilities.map((capability) => <li className={capability.higherImpact ? "higher-impact" : undefined} key={capability.id}>
        <span className="capability-mark" aria-hidden="true">{capability.higherImpact ? "!" : "\u2713"}</span>
        <span><strong>{capability.label}</strong><small>{capability.description}</small></span>
        {capability.higherImpact && <b>Higher impact</b>}
      </li>)}
    </ul>
  );
}

export function PermissionChoices({ groups, selected, disabled, onToggle }: {
  groups: AuthorizationCapabilityGroup[];
  selected: ReadonlySet<string>;
  disabled: boolean;
  onToggle(group: AuthorizationCapabilityGroup): void;
}) {
  const exact = groups.some((group) => group.semantics === "exact");
  const optional = groups.filter((group) => !group.required);
  if (optional.length === 0) return null;
  return (
    <details className="permission-review">
      <summary>
        <span><strong>{exact ? "Review exact permissions" : "Optional capabilities"}</strong><small>{exact ? "Choose each requested action independently." : "Optional capabilities can only be allowed or denied as a complete group."}</small></span>
        <b>Review</b>
      </summary>
      <div className="permission-groups">{optional.map((group) => (
        <fieldset className="permission-group" key={group.id}>
          <legend>{group.label}</legend>
          <p>{group.description}</p>
          <div><label>
            <input
              type="checkbox"
              checked={group.operations.every((operation) => selected.has(operation))}
              onChange={() => onToggle(group)}
              disabled={disabled}
            />
            <span>{exact ? group.label : "Allow this capability"}</span>
          </label></div>
        </fieldset>
      ))}</div>
    </details>
  );
}

const FILE_ACTION_LABELS: Record<ApplicationFileAction, string> = {
  list: "List file names and metadata",
  read: "Read file contents",
  add: "Add new files",
  replace: "Replace existing files",
  move: "Move and rename files",
  delete: "Delete files"
};

export function FilePermissionSummary({ files, selected, disabled, onToggle }: {
  files: NonNullable<PendingAuthorization["requirements"]["files"]>;
  selected: ReadonlySet<string>;
  disabled: boolean;
  onToggle(action: ApplicationFileAction): void;
}) {
  if ("actions" in files) return <details className="permission-review file-permission-review">
    <summary><span><strong>Review exact file permissions</strong><small>{files.actions.length} requested actions, approved together.</small></span><b>Details</b></summary>
    <div className="permission-groups"><fieldset className="permission-group">
      <legend>Files</legend>
      <p>{files.scope.kind === "collection" ? "Every visible folder in this collection." : `Only ${files.scope.folders.join(", ")}.`} Hidden folders are always excluded. These actions are approved together.</p>
      <ul className="permission-action-list">{files.actions.map((action) => <li key={action}>{FILE_ACTION_LABELS[action]}</li>)}</ul>
    </fieldset></div>
  </details>;
  const scope = files.scope.kind === "collection"
    ? "Every visible folder in this collection. Hidden folders are always excluded."
    : `Only ${files.scope.folders.join(", ")}. Hidden folders are always excluded.`;
  return (
    <details className="permission-review file-permission-review">
      <summary>
        <span><strong>File access</strong><small>{selected.size} approved {selected.size === 1 ? "action" : "actions"}. {scope}</small></span>
        <b>Review</b>
      </summary>
      <div className="permission-groups">
        <fieldset className="permission-group">
          <legend>Files</legend>
          <p>{scope} Required actions stay enabled; optional actions can be denied.</p>
          <div>{files.required.map((action) => <label key={action}>
            <input type="checkbox" checked disabled />
            <span>{FILE_ACTION_LABELS[action]} (required)</span>
          </label>)}</div>
          {(files.optional ?? []).length > 0 && <div>{(files.optional ?? []).map((action) => <label key={action}>
            <input
              type="checkbox"
              checked={selected.has(action)}
              disabled={disabled}
              onChange={() => onToggle(action)}
            />
            <span>{FILE_ACTION_LABELS[action]} (optional)</span>
          </label>)}</div>}
        </fieldset>
      </div>
    </details>
  );
}

export function NotificationAccess({ notifications }: {
  notifications: PendingAuthorization["notifications"];
}) {
  if (notifications.criteria.length === 0) return null;
  return (
    <details className="notification-access">
      <summary>
        <span><strong>Change notifications</strong><small>{notifications.criteria.length} optional {notifications.criteria.length === 1 ? "rule" : "rules"}; pushes contain no record content.</small></span>
        <b>Details</b>
      </summary>
      <ul>{notifications.criteria.map((criterion) => (
        <li key={criterion.id}>
          <span>{criterion.presentation.title}</span>
          <code>{criterion.event.id} v{criterion.event.version}</code>
        </li>
      ))}</ul>
      <p>If you enable these in the application, the rules run inside the collection.</p>
    </details>
  );
}
