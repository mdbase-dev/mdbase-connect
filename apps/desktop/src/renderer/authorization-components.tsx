import React from "react";
import type { RequestCapabilityGroup } from "./application-capabilities";

export function RequestPermissionChoices({ groups, selected, onChange }: {
  groups: RequestCapabilityGroup[];
  selected: string[];
  onChange(value: string[]): void;
}) {
  const selectedSet = new Set(selected);
  const selectedGroups = groups.filter((group) =>
    group.operations.every((operation) => selectedSet.has(operation))
  );
  function toggle(group: RequestCapabilityGroup, checked: boolean) {
    const groupOperations = new Set(group.operations);
    onChange(checked
      ? [...new Set([...selected, ...group.operations])]
      : selected.filter((operation) => !groupOperations.has(operation)));
  }
  return (
    <details className="request-permission-review">
      <summary>
        <span>
          <strong>{selectedGroups.map((group) => group.label).join(" · ")}</strong>
          <small>{selectedGroups.length} of {groups.length} capabilities enabled. Optional capabilities can only be removed as complete groups.</small>
        </span>
        <b>Details</b>
      </summary>
      <div className="request-permission-groups">{groups.map((group) => (
        <fieldset key={group.id}>
          <legend>{group.label}</legend>
          <p>{group.description}</p>
          <div><label>
            <input
              type="checkbox"
              checked={group.operations.every((operation) => selectedSet.has(operation))}
              disabled={group.required}
              onChange={(event) => toggle(group, event.target.checked)}
            />
            <span>{group.required ? "Required by this application" : "Allow this capability"}</span>
          </label></div>
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
