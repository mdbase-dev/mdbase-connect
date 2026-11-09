/**
 * The actions a user can take from the tray and Settings for an update status.
 * Checking is offered alongside opening an external update so a person can ask
 * again after a newer release lands or a check failed. An automatically staged
 * update is already complete, so it shows only its install action.
 */
export function updateActions(
  status: { phase: string; can_check: boolean; can_install: boolean }
): Array<{ action: "check" | "install"; enabled: boolean }> {
  const actions: Array<{ action: "check" | "install"; enabled: boolean }> = [];
  if (status.can_install === true) actions.push({ action: "install", enabled: true });
  if (status.phase !== "ready") actions.push({ action: "check", enabled: status.can_check === true });
  return actions;
}
