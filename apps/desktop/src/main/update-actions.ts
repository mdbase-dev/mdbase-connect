export function updateActions(
  status: { can_check: boolean; can_install: boolean }
): Array<{ action: "check" | "install"; enabled: boolean }> {
  const actions: Array<{ action: "check" | "install"; enabled: boolean }> = [];
  if (status.can_install === true) actions.push({ action: "install", enabled: true });
  actions.push({ action: "check", enabled: status.can_check === true });
  return actions;
}
