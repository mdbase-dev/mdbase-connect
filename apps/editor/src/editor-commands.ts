export const commandDefinitions = {
  "quick-open": { label: "Quick open", shortcut: "Mod P" },
  "command-palette": { label: "Commands", shortcut: "Mod Shift P" },
  "new-note": { label: "New note", shortcut: "Mod Shift N" },
  "new-note-in-folder": { label: "New note in current folder" },
  rename: { label: "Rename", shortcut: "F2" },
  move: { label: "Move to…" },
  duplicate: { label: "Duplicate" },
  "copy-link": { label: "Copy link" },
  "copy-path": { label: "Copy path" },
  delete: { label: "Delete", shortcut: "Mod Backspace", scope: "in the list" },
  pin: { label: "Pin", hint: "Current note" },
  unpin: { label: "Unpin", hint: "Current note" },
  "move-selected": { label: "Move to…", hint: "Selected notes" },
  "delete-selected": { label: "Delete", hint: "Selected notes" },
  "add-tag": { label: "Add tag", hint: "Selected notes" },
  "remove-tag": { label: "Remove tag", hint: "Selected notes" },
  "set-property": { label: "Set property", hint: "Selected notes" },
  "clear-selection": { label: "Clear selection" },
  properties: { label: "Note properties" },
  outline: { label: "Document outline" },
  backlinks: { label: "Linked from" },
  focus: { label: "Focus mode", shortcut: "Mod Shift F" },
  "toggle-list": { label: "Show or hide the notes sidebar", shortcut: "Mod Shift L" },
  theme: { label: "Switch theme", hint: "System → Light → Dark" },
  vim: { label: "Toggle Vim key bindings" },
  types: { label: "Open Types" },
  settings: { label: "Open Settings" },
  connect: { label: "Open Connect" },
  "switch-collection": { label: "Switch collection" },
  shortcuts: { label: "Keyboard shortcuts", shortcut: "?", scope: "outside text inputs" },
  "check-note": { label: "Check note" }
} satisfies Record<string, CommandDefinition>;

interface CommandDefinition { label: string; shortcut?: string; hint?: string; scope?: string }
export type CommandId = keyof typeof commandDefinitions;
export interface EditorCommand extends CommandDefinition { id: string; run: () => void }
export function command(id: CommandId, run: () => void, label?: string): EditorCommand {
  return { id, ...commandDefinitions[id], ...(label ? { label } : {}), run };
}
export function buildEditorCommands(handlers: Partial<Record<CommandId, () => void>>, labels: Partial<Record<CommandId, string>> = {}): EditorCommand[] {
  return (Object.keys(commandDefinitions) as CommandId[]).flatMap((id) => {
    const run = handlers[id];
    return run ? [command(id, run, labels[id])] : [];
  });
}
export function shortcutModifier(): string {
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform) ? "⌘" : "Ctrl";
}
export function formatShortcut(shortcut: string): string { return shortcut.replace("Mod", shortcutModifier()); }
export function matchesCommandShortcut(id: CommandId, event: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): boolean {
  const definition: CommandDefinition = commandDefinitions[id];
  const parts = definition.shortcut?.toLocaleLowerCase().split(" ");
  if (!parts || event.altKey) return false;
  const shiftedCharacter = parts.at(-1) === "?";
  return event.key.toLocaleLowerCase() === parts.at(-1)
    && Boolean(event.metaKey || event.ctrlKey) === parts.includes("mod")
    && (shiftedCharacter || event.shiftKey === parts.includes("shift"));
}

const recentCommandKey = "mdbase-editor:recent-commands";
export function loadRecentCommands(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(recentCommandKey) ?? "[]");
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string").slice(0, 20) : [];
  } catch { return []; }
}
export function rememberCommand(id: string): void {
  localStorage.setItem(recentCommandKey, JSON.stringify([id, ...loadRecentCommands().filter((recent) => recent !== id)].slice(0, 20)));
}

/** Token-wise fuzzy matching; recency breaks equal scores, and leads the empty palette. */
export function filterCommands(commands: EditorCommand[], query: string, recent = loadRecentCommands()): EditorCommand[] {
  const tokens = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const score = (command: EditorCommand) => tokens.reduce((total, token) => {
    const text = `${command.label} ${command.hint ?? ""}`.toLocaleLowerCase();
    const at = text.indexOf(token);
    if (at >= 0) return total + at / 100;
    let next = 0, gaps = 0, last = -1;
    for (let i = 0; i < text.length && next < token.length; i++) {
      if (text[i] === token[next]) { gaps += last < 0 ? i : i - last - 1; last = i; next++; }
    }
    return total + (next === token.length ? 2 + gaps / 10 : Infinity);
  }, 0);
  const recency = (id: string) => { const at = recent.indexOf(id); return at < 0 ? Infinity : at; };
  return commands.map((command, order) => ({ command, order, score: score(command) }))
    .filter((candidate) => Number.isFinite(candidate.score))
    .sort((a, b) => a.score - b.score || recency(a.command.id) - recency(b.command.id) || a.order - b.order)
    .map(({ command }) => command);
}
