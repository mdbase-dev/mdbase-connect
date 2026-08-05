import { groupAuthorizationOperations } from "@mdbase/connect-ui/access";
import type { PendingAuthorization } from "./api";

export function PermissionCapabilitySummary({
  groups,
  selected,
  files
}: {
  groups: ReturnType<typeof groupAuthorizationOperations>;
  selected: ReadonlySet<string>;
  files?: PendingAuthorization["requirements"]["files"];
}) {
  const capabilities = groups.flatMap((group) => {
    const selectedOperations = group.operations.filter((operation) => selected.has(operation.id));
    return selectedOperations.length > 0 ? [{
      id: group.id,
      label: group.label,
      description: group.description,
      higherImpact: group.id === "delete" || group.id === "manage"
    }] : [];
  });
  if (files) {
    capabilities.push({
      id: "files",
      label: files.actions.includes("delete") ? "Manage and delete files" : "Work with files",
      description: files.scope.kind === "collection"
        ? "Use the requested file actions in every visible folder."
        : `Use the requested file actions in ${files.scope.folders.join(", ")}.`,
      higherImpact: files.actions.includes("delete")
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

export function PermissionChoices({
  groups,
  selected,
  disabled,
  onToggle
}: {
  groups: ReturnType<typeof groupAuthorizationOperations>;
  selected: ReadonlySet<string>;
  disabled: boolean;
  onToggle(operation: string): void;
}) {
  const total = groups.reduce((count, group) => count + group.operations.length, 0);
  const selectedTotal = groups.reduce(
    (count, group) =>
      count + group.operations.filter((operation) => selected.has(operation.id)).length,
    0
  );
  const selectedGroups = groups.filter((group) =>
    group.operations.some((operation) => selected.has(operation.id))
  );
  return (
    <details className="permission-review">
      <summary>
        <span><strong>Review exact permissions</strong><small>{selectedTotal} of {total} requested actions selected{selectedGroups.length > 0 ? ` across ${selectedGroups.length} ${selectedGroups.length === 1 ? "capability" : "capabilities"}` : ""}.</small></span>
        <b>Details</b>
      </summary>
      <div className="permission-groups">{groups.map((group) => (
        <fieldset className="permission-group" key={group.id}>
          <legend>{group.label}</legend>
          <p>{group.description}</p>
          <div>{group.operations.map((operation) => (
            <label key={operation.id}>
              <input type="checkbox" checked={selected.has(operation.id)} onChange={() => onToggle(operation.id)} disabled={disabled} />
              <span>{operation.label}</span>
            </label>
          ))}</div>
        </fieldset>
      ))}</div>
    </details>
  );
}

const FILE_ACTION_LABELS: Record<
  PendingAuthorization["requirements"]["files"] extends infer Files
    ? Files extends { actions: Array<infer Action> }
      ? Action & string
      : never
    : never,
  string
> = {
  list: "List file names and metadata",
  read: "Read file contents",
  add: "Add new files",
  replace: "Replace existing files",
  move: "Move and rename files",
  delete: "Delete files"
};

export function FilePermissionSummary({ files }: {
  files: NonNullable<PendingAuthorization["requirements"]["files"]>;
}) {
  const scope = files.scope.kind === "collection"
    ? "Every visible folder in this collection. Hidden folders are always excluded."
    : `Only ${files.scope.folders.join(", ")}. Hidden folders are always excluded.`;
  return (
    <details className="permission-review file-permission-review">
      <summary>
        <span><strong>Review exact file permissions</strong><small>{files.actions.length} required {files.actions.length === 1 ? "action" : "actions"}. {scope}</small></span>
        <b>Details</b>
      </summary>
      <div className="permission-groups">
        <fieldset className="permission-group">
          <legend>Files</legend>
          <p>{scope} These actions are required together by the application.</p>
          <ul className="permission-action-list">{files.actions.map((action) => (
            <li key={action}>{FILE_ACTION_LABELS[action]}</li>
          ))}</ul>
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
