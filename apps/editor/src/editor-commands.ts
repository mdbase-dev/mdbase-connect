import { t } from "@lingui/core/macro";
import { isApplePlatform } from "@mdbase-dev/ui/command-palette";
import { useSyncExternalStore } from "react";
export const commandDefinitions = {
  "sort-modified-desc": { get label() { return t`Modified newest`; } },
  "sort-modified-asc": { get label() { return t`Modified oldest`; } },
  "sort-title-asc": { get label() { return t`Title A–Z`; } },
  "sort-path-asc": { get label() { return t`Path A–Z`; } },
  "filter-tag": { get label() { return t`Filter by tag`; } },
  "filter-type": { get label() { return t`Filter by type`; } },
  "clear-filter": { get label() { return t`All notes`; } },
  "quick-open": { get label() { return t`Quick open`; }, shortcut: "mod+P", group: "Navigate" },
  "command-palette": { get label() { return t`Commands`; }, shortcut: "mod+K", aliases: ["mod+shift+P"], group: "Navigate", get scope() { return t`Adds a link in the note body`; } },
  "new-note": { get label() { return t`New note`; }, shortcut: "C", aliases: ["mod+shift+N"], group: "Note" },
  "new-note-of-type": { get label() { return t`New note of type…`; }, shortcut: "shift+C", group: "Note" },
  "upload-files": { get label() { return t`Upload files…`; }, group: "Note" },
  "focus-search": { get label() { return t`Search notes and files`; }, shortcut: "/", group: "Navigate" },
  notes: { get label() { return t`Open Notes`; }, shortcut: "g n", group: "Navigate" },
  "new-note-in-folder": { get label() { return t`New note in current folder`; } },
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
  comments: { get label() { return t`Comments`; } },
  "version-history": { get label() { return t`Version history`; } },
  comment: { get label() { return t`Comment on the selection`; }, shortcut: "mod+alt+M", group: "Text" },
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
  "open-in-new-tab": { get label() { return t`Open in new tab`; } },
  "open-beside": { get label() { return t`Open to the side`; } },
  "new-tab": { get label() { return t`Open a note in a new tab`; }, shortcut: "alt+T", group: "Navigate" },
  "close-tab": { get label() { return t`Close tab`; }, shortcut: "alt+W", group: "Navigate" },
  "next-tab": { get label() { return t`Next tab`; }, shortcut: "alt+PageDown", group: "Navigate" },
  "previous-tab": { get label() { return t`Previous tab`; }, shortcut: "alt+PageUp", group: "Navigate" },
  "split-right": { get label() { return t`Split right`; } },
  "split-down": { get label() { return t`Split down`; } },
  "focus-other-pane": { get label() { return t`Focus next pane`; }, shortcut: "alt+O", group: "Navigate" },
  "close-pane": { get label() { return t`Close pane`; } },
  "next-note": { get label() { return t`Next note`; }, shortcut: "alt+J", group: "Navigate" },
  "previous-note": { get label() { return t`Previous note`; }, shortcut: "alt+K", group: "Navigate" },
  "find-text": { get label() { return t`Find in note`; }, shortcut: "mod+F", group: "Text", fixed: true },
  bold: { get label() { return t`Bold`; }, shortcut: "mod+B", group: "Text" },
  italic: { get label() { return t`Italic`; }, shortcut: "mod+I", group: "Text" },
  code: { get label() { return t`Inline code`; }, shortcut: "mod+shift+C", group: "Text" },
  "markdown-commands": { get label() { return t`Markdown commands`; }, shortcut: "/", group: "Text", fixed: true },
  "check-note": { get label() { return t`Check note`; } }
} satisfies Record<string, CommandDefinition>;

/** `fixed` commands are bound by the editor itself (search panel, slash menu), so their keys can't be changed. */
export interface CommandDefinition { label: string; shortcut?: string; aliases?: readonly string[]; group?: "Navigate" | "Note" | "Text"; hint?: string; scope?: string; fixed?: boolean }
export type CommandId = keyof typeof commandDefinitions;
export interface EditorCommand extends CommandDefinition { id: string; context?: string; run: () => void }
export function isCommandId(id: string): id is CommandId {
  return Object.hasOwn(commandDefinitions, id);
}
export function command(id: CommandId, run: () => void, label?: string): EditorCommand {
  const [shortcut, ...aliases] = commandShortcuts(id);
  return { id, ...commandDefinitions[id], shortcut, aliases, ...(label ? { label } : {}), run };
}
export function buildEditorCommands(handlers: Partial<Record<CommandId, () => void>>, labels: Partial<Record<CommandId, string>> = {}): EditorCommand[] {
  return (Object.keys(commandDefinitions) as CommandId[]).flatMap((id) => {
    const run = handlers[id];
    return run ? [command(id, run, labels[id])] : [];
  });
}
type KeyPress = { key: string; code?: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean };

/** The pressed key, lower case. Option changes the character a Mac keyboard reports, so with Alt held a letter or digit goes by its physical key. */
function pressedKey(event: KeyPress): string {
  if (event.altKey && event.code && /^(Key[A-Z]|Digit\d)$/.test(event.code)) return event.code.slice(-1).toLowerCase();
  return event.key === " " ? "space" : event.key.toLocaleLowerCase();
}

/** Whether a key press completes a chord such as `mod+shift+P`, or the second step of a sequence such as `g n` after `prefix`. */
export function matchesChord(chord: string, event: KeyPress, prefix = ""): boolean {
  const sequence = chord.toLocaleLowerCase().split(" ");
  if (sequence.length > 1 && sequence[0] !== prefix) return false;
  const parts = sequence.at(-1)!.split("+");
  const key = pressedKey(event);
  return key === parts.at(-1)
    && Boolean(event.metaKey || event.ctrlKey) === (parts.includes("mod") || parts.includes("ctrl"))
    && (!parts.includes("ctrl") || event.ctrlKey && !event.metaKey)
    && event.altKey === parts.includes("alt")
    // Shift is what produced a symbol such as `?`, so it only counts for letters and named keys.
    && (isSymbol(key) || event.shiftKey === parts.includes("shift"));
}

function isSymbol(key: string): boolean {
  return key.length === 1 && key.toLocaleLowerCase() === key.toLocaleUpperCase();
}

export function matchesCommandShortcut(id: CommandId, event: KeyPress, prefix = ""): boolean {
  return commandShortcuts(id).some((chord) => matchesChord(chord, event, prefix));
}

/** The chord a key press makes, in the registry's spelling, or undefined while only modifiers are held. */
export function chordFromEvent(event: KeyPress): string | undefined {
  if (["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "Dead", "Process", "Unidentified"].includes(event.key)) return undefined;
  const key = pressedKey(event);
  const name = key === "space" ? "Space" : key.length === 1 ? key.toLocaleUpperCase() : event.key;
  const modifiers = isApplePlatform()
    ? [event.metaKey ? "mod" : event.ctrlKey ? "ctrl" : ""]
    : [event.metaKey || event.ctrlKey ? "mod" : ""];
  if (event.altKey) modifiers.push("alt");
  if (event.shiftKey && !isSymbol(key)) modifiers.push("shift");
  return [...modifiers.filter(Boolean), name].join("+");
}

/** Each chord's modifiers in one order and its key in lower case, so equal chords compare equal. */
function normalizeChord(chord: string): string {
  return chord.toLocaleLowerCase().split(" ").map((step) => {
    const parts = step.split("+");
    const key = parts.pop()!;
    return [...parts.sort(), key].join("+");
  }).join(" ");
}

// Per-device shortcut overrides: each changed command's whole list of chords, empty when it has none.
type ShortcutOverrides = Partial<Record<CommandId, readonly string[]>>;
const shortcutsKey = "mdbase-editor:shortcuts";
const shortcutListeners = new Set<() => void>();
let shortcutOverrides: ShortcutOverrides | undefined;

function loadShortcutOverrides(): ShortcutOverrides {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(shortcutsKey) ?? "{}");
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
    return Object.fromEntries(Object.entries(stored).filter(([id, chords]) => isCommandId(id) && !(commandDefinitions[id] as CommandDefinition).fixed
      && Array.isArray(chords) && chords.every((chord) => typeof chord === "string" && /^\S+( \S+)?$/.test(chord))));
  } catch { return {}; }
}

function overrides(): ShortcutOverrides {
  return shortcutOverrides ??= loadShortcutOverrides();
}

/** A command's chords on this device: its override, or else the registry's shortcut and aliases. */
export function commandShortcuts(id: CommandId): readonly string[] {
  const definition: CommandDefinition = commandDefinitions[id];
  return overrides()[id] ?? (definition.shortcut ? [definition.shortcut, ...(definition.aliases ?? [])] : []);
}

export function isShortcutChanged(id: CommandId): boolean {
  return Object.hasOwn(overrides(), id);
}

/** Replaces a command's chords on this device; `undefined` restores the registry's. */
export function setCommandShortcuts(id: CommandId, chords: readonly string[] | undefined): void {
  const definition: CommandDefinition = commandDefinitions[id];
  const defaults = definition.shortcut ? [definition.shortcut, ...(definition.aliases ?? [])] : [];
  const next = { ...overrides() };
  if (!chords || chords.length === defaults.length && chords.every((chord, index) => normalizeChord(chord) === normalizeChord(defaults[index]))) delete next[id];
  else next[id] = chords;
  storeShortcutOverrides(next);
}

export function resetShortcuts(): void {
  storeShortcutOverrides({});
}

function storeShortcutOverrides(next: ShortcutOverrides) {
  shortcutOverrides = next;
  if (Object.keys(next).length) localStorage.setItem(shortcutsKey, JSON.stringify(next));
  else localStorage.removeItem(shortcutsKey);
  for (const listener of shortcutListeners) listener();
}

/** Re-renders a component whenever this device's shortcuts change. */
export function useShortcuts(): ShortcutOverrides {
  return useSyncExternalStore(subscribeShortcuts, overrides);
}
function subscribeShortcuts(listener: () => void) {
  shortcutListeners.add(listener);
  return () => { shortcutListeners.delete(listener); };
}

/** The other command a chord already belongs to, including one that starts a sequence with it. */
export function shortcutOwner(chord: string, except: CommandId): CommandId | undefined {
  const wanted = normalizeChord(chord);
  return (Object.keys(commandDefinitions) as CommandId[]).find((id) => id !== except
    && commandShortcuts(id).some((other) => { const normal = normalizeChord(other); return normal === wanted || normal.startsWith(`${wanted} `); }));
}

/** Removes a chord from whichever command holds it. */
export function releaseChord(owner: CommandId, chord: string): void {
  const released = normalizeChord(chord);
  setCommandShortcuts(owner, commandShortcuts(owner).filter((other) => { const normal = normalizeChord(other); return normal !== released && !normal.startsWith(`${released} `); }));
}

/** The first keys of every sequence on this device, such as `g` for `g n`. */
export function sequencePrefixes(): Set<string> {
  return new Set((Object.keys(commandDefinitions) as CommandId[]).flatMap((id) => commandShortcuts(id).flatMap((chord) => {
    const [first, second] = chord.toLocaleLowerCase().split(" ");
    return second ? [first] : [];
  })));
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
