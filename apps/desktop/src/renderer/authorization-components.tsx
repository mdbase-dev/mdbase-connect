import {
  groupAuthorizationOperations
} from "@mdbase/connect-ui/access";
import React from "react";

export function RequestPermissionChoices({ groups, selected, onChange }: {
  groups: ReturnType<typeof groupAuthorizationOperations>;
  selected: string[];
  onChange(value: string[]): void;
}) {
  const selectedSet = new Set(selected);
  const total = groups.reduce((count, group) => count + group.operations.length, 0);
  const selectedTotal = groups.reduce(
    (count, group) =>
      count + group.operations.filter((operation) => selectedSet.has(operation.id)).length,
    0
  );
  const selectedGroups = groups.filter((group) =>
    group.operations.some((operation) => selectedSet.has(operation.id))
  );
  function toggle(operation: string, checked: boolean) {
    onChange(checked
      ? [...selected, operation]
      : selected.filter((value) => value !== operation));
  }
  return (
    <details className="request-permission-review">
      <summary>
        <span>
          <strong>{selectedGroups.map((group) => group.label).join(" · ")}</strong>
          <small>{selectedTotal} of {total} specific actions selected. Open details to narrow access.</small>
        </span>
        <b>Details</b>
      </summary>
      <div className="request-permission-groups">{groups.map((group) => (
        <fieldset key={group.id}>
          <legend>{group.label}</legend>
          <p>{group.description}</p>
          <div>{group.operations.map((operation) => (
            <label key={operation.id}>
              <input type="checkbox" checked={selectedSet.has(operation.id)} onChange={(event) => toggle(operation.id, event.target.checked)} />
              <span>{operation.label}</span>
            </label>
          ))}</div>
        </fieldset>
      ))}</div>
    </details>
  );
}

export function NotificationAccess({ notifications }: { notifications: ApplicationNotifications }) {
  if (notifications.criteria.length === 0) return null;
  return (
    <details className="notification-request">
      <summary><span><strong>Change notifications</strong><small>{notifications.criteria.length} optional {notifications.criteria.length === 1 ? "rule" : "rules"}; pushes contain no record content.</small></span><b>Details</b></summary>
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
