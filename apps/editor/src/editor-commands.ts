import { t } from "@lingui/core/macro";
export const commandDefinitions = {
  "quick-open": { get label() { return t`Quick open`; }, shortcut: "Mod P" },
  "command-palette": { get label() { return t`Commands`; }, shortcut: "Mod Shift P" },
  "new-note": { get label() { return t`New note`; }, shortcut: "Mod Shift N" },
  "new-note-in-folder": { get label() { return t`New note in current folder`; } },
  rename: { get label() { return t`Rename`; }, shortcut: "F2" },
  move: { get label() { return t`Move to…`; } },
  duplicate: { get label() { return t`Duplicate`; } },
  "copy-link": { get label() { return t`Copy link`; } },
  "copy-path": { get label() { return t`Copy path`; } },
  delete: { get label() { return t`Delete`; }, shortcut: "Mod Backspace", get scope() { return t`in the list`; } },
  pin: { get label() { return t`Pin`; }, get hint() { return t`Current note`; } },
  unpin: { get label() { return t`Unpin`; }, get hint() { return t`Current note`; } },
  "move-selected": { get label() { return t`Move to…`; }, get hint() { return t`Selected notes`; } },
  "delete-selected": { get label() { return t`Delete`; }, get hint() { return t`Selected notes`; } },
  "add-tag": { get label() { return t`Add tag`; }, get hint() { return t`Selected notes`; } },
  "remove-tag": { get label() { return t`Remove tag`; }, get hint() { return t`Selected notes`; } },
  "set-property": { get label() { return t`Set property`; }, get hint() { return t`Selected notes`; } },
  "clear-selection": { get label() { return t`Clear selection`; } },
  properties: { get label() { return t`Note properties`; } },
  outline: { get label() { return t`Document outline`; } },
  backlinks: { get label() { return t`Linked from`; } },
  focus: { get label() { return t`Focus mode`; }, shortcut: "Mod Shift F" },
  "toggle-list": { get label() { return t`Show or hide the notes sidebar`; }, shortcut: "Mod Shift L" },
  theme: { get label() { return t`Switch theme`; }, get hint() { return t`System → Light → Dark`; } },
  vim: { get label() { return t`Toggle Vim key bindings`; } },
  types: { get label() { return t`Open Types`; } },
  settings: { get label() { return t`Open Settings`; } },
  connect: { get label() { return t`Open Connect`; } },
  "switch-collection": { get label() { return t`Switch collection`; } },
  shortcuts: { get label() { return t`Keyboard shortcuts`; }, shortcut: "?", get scope() { return t`outside text inputs`; } },
  "check-note": { get label() { return t`Check note`; } }
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
