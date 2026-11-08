import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import type { CollectionTypeDescriptor } from "@mdbase-dev/connect";
import { Dialog } from "@mdbase-dev/ui/dialog";
import { shortcutLabel, type Command } from "@mdbase-dev/ui/command-palette";
import { noteTitle } from "./note";
import { searchNoteResults, searchTextRanges, type NoteSearchEntry, type NoteSearchResult } from "./note-search";
import { SearchMatchText } from "./SearchMatchText";
import { commandDefinitions, filterCommands, rememberCommand, type CommandDefinition, type CommandId, type EditorCommand } from "./editor-commands";

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
    id: command.id, label: command.label, detail: command.hint, group: t`Actions`, shortcut: command.shortcut, context: commandQuery ? undefined : command.context,
    content: <><strong><SearchMatchText text={command.label} ranges={searchTextRanges(command.label, commandQuery)} /></strong>
      {command.hint && <small><SearchMatchText text={command.hint} ranges={searchTextRanges(command.hint, commandQuery)} /></small>}</>,
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
  return [...recent, ...index.filter(entry => !paths.includes(entry.note.path)).slice(0, 12).map((entry) => ({
    note: entry.note,
    context: { kind: "path" as const, text: entry.note.path, ranges: [] }
  }))];
}

export function ShortcutHelp({ onClose, canRename }: { onClose: () => void; canRename: boolean }) {
  useLingui();
  const groups = { Navigate: t`Navigate`, Note: t`Note`, Text: t`Text` };
  return <Dialog open title={t`Shortcuts`} className="shortcut-help" onClose={onClose}>
    <div className="shortcut-groups">{Object.entries(groups).map(([group, label]) => <section key={group}><h3>{label}</h3><dl>
      {(Object.entries(commandDefinitions) as [CommandId, CommandDefinition][]).filter(([id, entry]) => entry.group === group && entry.shortcut && (id !== "rename" || canRename)).map(([, entry]) => <div key={entry.label}>
        <dt>{entry.label}{entry.scope && <small>{entry.scope}</small>}</dt>
        <dd>{[entry.shortcut!, ...(entry.aliases ?? [])].map(keys => <kbd key={keys}>{shortcutLabel(keys)}</kbd>)}</dd>
      </div>)}
    </dl></section>)}</div>
  </Dialog>;
}
