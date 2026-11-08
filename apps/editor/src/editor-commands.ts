import { t } from "@lingui/core/macro";
export const commandDefinitions = {
  "sort-modified-desc": { get label() { return t`Modified newest`; } },
  "sort-modified-asc": { get label() { return t`Modified oldest`; } },
  "sort-title-asc": { get label() { return t`Title A–Z`; } },
  "sort-path-asc": { get label() { return t`Path A–Z`; } },
  "filter-tag": { get label() { return t`Filter by tag`; } },
  "filter-type": { get label() { return t`Filter by type`; } },
  "clear-filter": { get label() { return t`All notes`; } },
  "quick-open": { get label() { return t`Quick open`; }, shortcut: "mod+P", group: "Navigate" },
  "command-palette": { get label() { return t`Commands`; }, shortcut: "mod+K", aliases: ["mod+shift+P"], group: "Navigate", get scope() { return t`outside text; add a link while typing`; } },
  "new-note": { get label() { return t`New note`; }, shortcut: "C", aliases: ["mod+shift+N"], group: "Note" },
  "focus-search": { get label() { return t`Search notes and files`; }, shortcut: "/", group: "Navigate" },
  notes: { get label() { return t`Open Notes`; }, shortcut: "g n", group: "Navigate" },
  "new-note-in-folder": { get label() { return t`New note in current folder`; } },
  "create-note": { get label() { return t`Create note`; }, shortcut: "mod+Enter", group: "Note", get scope() { return t`in the note composer`; } },
  rename: { get label() { return t`Rename`; }, shortcut: "R", aliases: ["F2"], group: "Note" },
  undo: { get label() { return t`Undo`; }, shortcut: "mod+Z", group: "Note", get scope() { return t`in the list`; } },
  move: { get label() { return t`Move to…`; } },
  duplicate: { get label() { return t`Duplicate`; } },
  "copy-link": { get label() { return t`Copy link`; } },
  "copy-path": { get label() { return t`Copy path`; } },
  "attach-file": { get label() { return t`Attach file…`; } },
  delete: { get label() { return t`Delete`; }, shortcut: "mod+Backspace", group: "Note", get scope() { return t`in the list`; } },
  pin: { get label() { return t`Pin`; } },
  unpin: { get label() { return t`Unpin`; } },
  "move-selected": { get label() { return t`Move to…`; }, get hint() { return t`Selected notes`; } },
  "delete-selected": { get label() { return t`Delete`; }, get hint() { return t`Selected notes`; } },
  "add-tag": { get label() { return t`Add tag`; }, get hint() { return t`Selected notes`; } },
  "remove-tag": { get label() { return t`Remove tag`; }, get hint() { return t`Selected notes`; } },
  "set-property": { get label() { return t`Set property`; }, get hint() { return t`Selected notes`; } },
  "clear-selection": { get label() { return t`Clear selection`; } },
  properties: { get label() { return t`Note properties`; } },
  outline: { get label() { return t`Document outline`; } },
  backlinks: { get label() { return t`Linked from`; } },
  focus: { get label() { return t`Focus mode`; }, shortcut: "mod+shift+F", group: "Navigate" },
  "toggle-list": { get label() { return t`Show or hide the notes sidebar`; }, shortcut: "mod+shift+L", group: "Navigate" },
  theme: { get label() { return t`Switch theme`; }, get hint() { return t`System → Light → Dark`; } },
  vim: { get label() { return t`Toggle Vim key bindings`; } },
  types: { get label() { return t`Open Types`; }, shortcut: "g t", group: "Navigate" },
  settings: { get label() { return t`Open Settings`; }, shortcut: "g s", group: "Navigate" },
  connect: { get label() { return t`Open Connect`; } },
  "switch-collection": { get label() { return t`Switch collection`; } },
  shortcuts: { get label() { return t`Keyboard shortcuts`; }, shortcut: "?", aliases: ["ctrl+/"], group: "Navigate", get scope() { return t`outside text inputs`; } },
  "list-next": { get label() { return t`Next note in the list`; }, shortcut: "J", aliases: ["ArrowDown"], group: "Note" },
  "list-previous": { get label() { return t`Previous note in the list`; }, shortcut: "K", aliases: ["ArrowUp"], group: "Note" },
  peek: { get label() { return t`Peek at the focused note`; }, shortcut: "Space", group: "Note" },
  "note-actions": { get label() { return t`Note actions, in the list`; }, shortcut: "shift+F10", aliases: ["ContextMenu"], group: "Note" },
  "history-back": { get label() { return t`Back`; }, shortcut: "alt+ArrowLeft", group: "Navigate" },
  "history-forward": { get label() { return t`Forward`; }, shortcut: "alt+ArrowRight", group: "Navigate" },
  "next-note": { get label() { return t`Next note`; }, shortcut: "alt+J", group: "Navigate" },
  "previous-note": { get label() { return t`Previous note`; }, shortcut: "alt+K", group: "Navigate" },
  "find-text": { get label() { return t`Find in note`; }, shortcut: "mod+F", group: "Text" },
  bold: { get label() { return t`Bold`; }, shortcut: "mod+B", group: "Text" },
  italic: { get label() { return t`Italic`; }, shortcut: "mod+I", group: "Text" },
  code: { get label() { return t`Inline code`; }, shortcut: "mod+shift+C", group: "Text" },
  "markdown-commands": { get label() { return t`Markdown commands`; }, shortcut: "/", group: "Text" },
  "check-note": { get label() { return t`Check note`; } }
} satisfies Record<string, CommandDefinition>;

export interface CommandDefinition { label: string; shortcut?: string; aliases?: readonly string[]; group?: "Navigate" | "Note" | "Text"; hint?: string; scope?: string }
export type CommandId = keyof typeof commandDefinitions;
export interface EditorCommand extends CommandDefinition { id: string; context?: string; run: () => void }
export function command(id: CommandId, run: () => void, label?: string): EditorCommand {
  return { id, ...commandDefinitions[id], ...(label ? { label } : {}), run };
}
export function buildEditorCommands(handlers: Partial<Record<CommandId, () => void>>, labels: Partial<Record<CommandId, string>> = {}): EditorCommand[] {
  return (Object.keys(commandDefinitions) as CommandId[]).flatMap((id) => {
    const run = handlers[id];
    return run ? [command(id, run, labels[id])] : [];
  });
}
export function matchesCommandShortcut(id: CommandId, event: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }, prefix = ""): boolean {
  const definition: CommandDefinition = commandDefinitions[id];
  return [definition.shortcut, ...(definition.aliases ?? [])].some((shortcut) => {
    if (!shortcut) return false;
    const sequence = shortcut.toLocaleLowerCase().split(" ");
    if (sequence.length > 1 && sequence[0] !== prefix) return false;
    const parts = sequence.at(-1)!.split("+");
    const key = event.key === " " ? "space" : event.key.toLocaleLowerCase();
    return key === parts.at(-1)
      && Boolean(event.metaKey || event.ctrlKey) === (parts.includes("mod") || parts.includes("ctrl"))
      && (!parts.includes("ctrl") || event.ctrlKey && !event.metaKey)
      && event.altKey === parts.includes("alt")
      && (key === "?" || event.shiftKey === parts.includes("shift"));
  });
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
    .sort((a, b) => a.score - b.score || Number(b.command.id === "undo") - Number(a.command.id === "undo") || Number(Boolean(b.command.context)) - Number(Boolean(a.command.context)) || recency(a.command.id) - recency(b.command.id) || a.order - b.order)
    .map(({ command }) => command);
}
