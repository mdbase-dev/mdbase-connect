import { groupAuthorizationOperations } from "@mdbase/connect-ui/access";
import type { PendingAuthorization } from "./api";

export function PermissionDelta({ existingAccess, collectionId, selected }: {
  existingAccess: PendingAuthorization["existing_access"];
  collectionId: string;
  selected: ReadonlySet<string>;
}) {
  const existing = new Set(existingAccess?.find((access) =>
    access.collection_id === collectionId)?.operations ?? []);
  if (existing.size === 0) return null;
  const approved = [...selected].filter((operation) => existing.has(operation)).length;
  const added = selected.size - approved;
  return <div className="permission-delta" role="note">
    <span><strong>{approved}</strong> already approved</span>
    <span><strong>{added}</strong> {added === 1 ? "action" : "actions"} added by this request</span>
  </div>;
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
  return (
    <div className="permission-groups" aria-label="Permissions">{groups.map((group) => (
      <fieldset className="permission-group" key={group.id}>
        <legend>{group.label}</legend>
        <div>{group.operations.map((operation) => (
          <label key={operation.id}>
            <input type="checkbox" checked={selected.has(operation.id)} onChange={() => onToggle(operation.id)} disabled={disabled} />
            <span>{operation.label}</span>
          </label>
        ))}</div>
      </fieldset>
    ))}</div>
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
    ? "All visible folders; hidden folders excluded."
    : `${files.scope.folders.join(", ")} only; hidden folders excluded.`;
  return (
    <details className="permission-review file-permission-review">
      <summary><strong>File access</strong></summary>
      <div className="permission-groups">
        <fieldset className="permission-group">
          <legend>Files</legend>
          <p>{scope}</p>
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
      <summary><strong>Change notifications</strong></summary>
      <ul>{notifications.criteria.map((criterion) => (
        <li key={criterion.id}>
          <span>{criterion.presentation.title}</span>
          <code>{criterion.event.id} v{criterion.event.version}</code>
        </li>
      ))}</ul>
    </details>
  );
}
