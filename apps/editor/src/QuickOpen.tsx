import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import type { CollectionTypeDescriptor } from "@mdbase-dev/connect";
import { Dialog } from "@mdbase-dev/ui/dialog";
import type { Command } from "@mdbase-dev/ui/command-palette";
import { noteTitle } from "./note";
import { searchNoteResults, searchTextRanges, type NoteSearchEntry, type NoteSearchResult } from "./note-search";
import { SearchMatchText } from "./SearchMatchText";
import { commandDefinitions, filterCommands, formatShortcut, rememberCommand, shortcutModifier, type EditorCommand } from "./editor-commands";

export function quickOpenResults({ index, recentPaths, types, commands, onSelect, onCreate }: {
  index: NoteSearchEntry[];
  recentPaths: string[];
  types: CollectionTypeDescriptor[];
  commands: EditorCommand[];
  onSelect: (path: string) => void;
  onCreate?: ((title: string) => void) | undefined;
}, query: string): Command[] {
  const commandMode = query.trimStart().startsWith(">");
  const commandQuery = (commandMode ? query.trimStart().slice(1) : query).trim();
  const results = commandMode ? [] : commandQuery ? searchNoteResults(index, commandQuery, 12) : recentNotes(index, recentPaths).slice(0, 12);
  const entries: Command[] = results.map(result => {
    const title = noteTitle(result.note, types);
    return {
      id: result.note.path, label: title, group: t`Notes`, detail: result.context.text,
      content: <><strong><SearchMatchText text={title} ranges={searchTextRanges(title, commandQuery)} /></strong>
        {result.context.kind === "title"
          ? <small className="search-result-context path"><SearchMatchText text={result.note.path} ranges={searchTextRanges(result.note.path, commandQuery)} /></small>
          : <small className={`search-result-context ${result.context.kind}`}><SearchMatchText text={result.context.text} ranges={result.context.ranges} /></small>}</>,
      run: () => onSelect(result.note.path)
    };
  });
  if (!commandMode && commandQuery && !results.length && onCreate) entries.push({ id: "create-note", label: t`Create note ‘${query.trim()}’`, group: t`Notes`, run: () => onCreate(commandQuery) });
  if (commandMode || !commandQuery || !results.length) entries.push(...filterCommands(commands, commandQuery).map(command => ({
    id: command.id, label: command.label, detail: command.hint, group: t`Actions`, shortcut: command.shortcut?.toLowerCase().replaceAll(" ", "+"),
    run: () => { rememberCommand(command.id); command.run(); }
  })));
  return entries;
}

function recentNotes(index: NoteSearchEntry[], paths: string[]): NoteSearchResult[] {
  const byPath = new Map(index.map((entry) => [entry.note.path, entry.note]));
  const recent = paths.flatMap((path) => {
    const note = byPath.get(path);
    return note ? [{ note, context: { kind: "path" as const, text: note.path, ranges: [] } }] : [];
  });
  if (recent.length) return recent;
  return index.slice(0, 12).map((entry) => ({
    note: entry.note,
    context: { kind: "path" as const, text: entry.note.path, ranges: [] }
  }));
}

export { shortcutModifier } from "./editor-commands";

export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  useLingui();
  const modifier = shortcutModifier();
  const shortcuts = [
    ...Object.values(commandDefinitions).flatMap((definition) => {
      const entry: { label: string; shortcut?: string; scope?: string } = definition;
      return entry.shortcut ? [[formatShortcut(entry.shortcut), entry.label + (entry.scope ? `, ${entry.scope}` : "")]] : [];
    }),
    [">", t`Actions in quick open`],
    [`${modifier} K`, t`Find a note or action`],
    ["Ctrl /", commandDefinitions.shortcuts.label],
    ["↑ / ↓", t`Move through the note list`],
    [`${modifier} F`, t`Find in note`],
    [`${modifier} B / I`, t`Bold or italic`],
    [`${modifier} K`, t`Add a link, in the note text`],
    ["/", t`Markdown commands`],
    ["Alt ← / →", t`Back or forward`],
    ["Alt J / K", t`Next or previous note`],
    ["Shift F10", t`Note actions, in the list`],
    ["Space", t`Peek at the focused note`],
    ["Esc", t`Exit focus mode`]
  ];
  return <Dialog open title={t`Shortcuts`} className="shortcut-help" onClose={onClose}>
      <dl>{shortcuts.map(([keys, label]) => <div key={label}><dt>{label}</dt><dd><kbd>{keys}</kbd></dd></div>)}</dl>
  </Dialog>;
}
