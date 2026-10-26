import { i18n } from "@lingui/core";
import { Trans } from "@lingui/react/macro";
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { MagnifyingGlassIcon as Search, XIcon as X } from "./icons";
import { Fragment, useEffect, useMemo, useState } from "react";
import type { CollectionTypeDescriptor } from "@mdbase-dev/connect";
import { Dialog } from "./Dialog";
import { noteTitle } from "./note";
import {
  searchNoteResults,
  searchTextRanges,
  type NoteSearchEntry,
  type NoteSearchResult
} from "./note-search";
import { SearchMatchText } from "./SearchMatchText";

import { commandDefinitions, filterCommands, formatShortcut, rememberCommand, type EditorCommand } from "./editor-commands";
export type QuickOpenCommand = EditorCommand;

type QuickOpenRow =
  | { kind: "note"; result: NoteSearchResult }
  | { kind: "command"; command: QuickOpenCommand };

interface QuickOpenSection {
  header?: string;
  row: QuickOpenRow;
}

export function QuickOpen({ index, recentPaths, types, commands = [], initialCommandMode = false, onSelect, onClose }: {
  index: NoteSearchEntry[];
  recentPaths: string[];
  types: CollectionTypeDescriptor[];
  commands?: QuickOpenCommand[];
  initialCommandMode?: boolean;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  useLingui();
  const [query, setQuery] = useState(initialCommandMode ? ">" : "");
  const [activeIndex, setActiveIndex] = useState(0);
  const commandMode = query.trimStart().startsWith(">");
  const commandQuery = (commandMode ? query.trimStart().slice(1) : query).trim();
  const results = useMemo(() => commandMode ? [] : commandQuery
    ? searchNoteResults(index, commandQuery, 12)
    : recentNotes(index, recentPaths).slice(0, 12), [commandMode, commandQuery, index, recentPaths, i18n.locale]);
  const filteredCommands = useMemo(() => filterCommands(commands, commandQuery), [commands, commandQuery, i18n.locale]);
  const showCommands = filteredCommands.length > 0 && (commandMode || !commandQuery || results.length === 0);
  const sections = useMemo(() => buildSections(results, filteredCommands, commandMode, showCommands),
    [commandMode, filteredCommands, results, showCommands, i18n.locale]);
  const rows = sections.map((section) => section.row);
  useEffect(() => setActiveIndex(0), [query]);
  useEffect(() => {
    document.getElementById(`quick-open-${activeIndex}`)?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, rows.length]);

  function choose(row: QuickOpenRow | undefined) {
    if (!row) return;
    if (row.kind === "command") {
      rememberCommand(row.command.id);
      onClose();
      row.command.run();
      return;
    }
    onSelect(row.result.note.path);
    onClose();
  }

  return <Dialog titleId="quick-open-title" className="quick-open" onClose={onClose}>
      <h2 id="quick-open-title" className="sr-only"><Trans>Quick open</Trans></h2>
      <div className="quick-open-search">
        <Search aria-hidden="true" />
        <label className="sr-only" htmlFor="quick-open-input"><Trans>Find a note or action</Trans></label>
        <input
          id="quick-open-input"
          data-autofocus
          role="combobox"
          aria-expanded="true"
          aria-controls="quick-open-results"
          aria-activedescendant={rows[activeIndex] ? `quick-open-${activeIndex}` : undefined}
          value={query}
          placeholder={t`Find a note by title or path, or type > for actions`}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActiveIndex((current) => Math.max(0, Math.min(rows.length - 1, current + 1)));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActiveIndex((current) => Math.max(0, current - 1));
            } else if (event.key === "Home" && rows.length) {
              event.preventDefault();
              setActiveIndex(0);
            } else if (event.key === "End" && rows.length) {
              event.preventDefault();
              setActiveIndex(rows.length - 1);
            } else if (event.key === "Enter") {
              event.preventDefault();
              choose(rows[activeIndex]);
            } else if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
        />
        <button className="icon-button" aria-label={t`Close quick open`} onClick={onClose}><X aria-hidden="true" /></button>
      </div>
      <p className="sr-only" aria-live="polite">{commandMode ? t`Matching actions` : commandQuery ? t`Best matches` : t`Recent notes and actions`}</p>
      <div id="quick-open-results" className="quick-open-results" role="listbox" aria-label={t`Matching notes and actions`}>
        {sections.map((section, rowIndex) => {
          const selected = activeIndex === rowIndex;
          const row = section.row;
          return <Fragment key={row.kind === "command" ? row.command.id : row.result.note.path}>
            {section.header && <div className="quick-open-section" aria-hidden="true">{section.header}</div>}
            {row.kind === "command" ? <button
              id={`quick-open-${rowIndex}`}
              role="option"
              aria-selected={selected}
              className={`quick-open-command${selected ? " selected" : ""}`}
              onMouseEnter={() => setActiveIndex(rowIndex)}
              onClick={() => choose(row)}
            ><span><strong>{row.command.label}</strong>{row.command.hint && <small className="search-result-context">{row.command.hint}</small>}</span>{row.command.shortcut && <kbd>{formatShortcut(row.command.shortcut)}</kbd>}</button> : (() => {
              const result = row.result;
              return <button
                id={`quick-open-${rowIndex}`}
                role="option"
                aria-selected={selected}
                className={selected ? "selected" : ""}
                onMouseEnter={() => setActiveIndex(rowIndex)}
                onClick={() => choose(row)}
              ><span>
                <strong><SearchMatchText text={noteTitle(result.note, types)} ranges={searchTextRanges(noteTitle(result.note, types), commandQuery)} /></strong>
                {result.context.kind === "title"
                  ? <small className="search-result-context path"><SearchMatchText text={result.note.path} ranges={searchTextRanges(result.note.path, commandQuery)} /></small>
                  : <small className={`search-result-context ${result.context.kind}`}><SearchMatchText text={result.context.text} ranges={result.context.ranges} /></small>}
              </span></button>;
            })()}
          </Fragment>;
        })}
        {!rows.length && <p>{commandMode ? t`No matching actions.` : t`No matching notes.`}</p>}
      </div>
      <footer><span><Trans><kbd>↑↓</kbd> choose · <kbd>Enter</kbd> open · <kbd>&gt;</kbd> actions · <kbd>Esc</kbd> close</Trans></span></footer>
  </Dialog>;
}

function buildSections(
  results: NoteSearchResult[],
  commands: QuickOpenCommand[],
  commandMode: boolean,
  showCommands: boolean
): QuickOpenSection[] {
  const sections: QuickOpenSection[] = [];
  if (commandMode) {
    if (commands.length) sections.push({ header: t`Actions`, row: { kind: "command", command: commands[0] } });
    for (let index = 1; index < commands.length; index += 1) {
      sections.push({ row: { kind: "command", command: commands[index] } });
    }
    return sections;
  }
  if (results.length) {
    sections.push({ header: t`Notes`, row: { kind: "note", result: results[0] } });
    for (let index = 1; index < results.length; index += 1) {
      sections.push({ row: { kind: "note", result: results[index] } });
    }
  }
  if (showCommands && commands.length) {
    sections.push({ header: t`Actions`, row: { kind: "command", command: commands[0] } });
    for (let index = 1; index < commands.length; index += 1) {
      sections.push({ row: { kind: "command", command: commands[index] } });
    }
  }
  return sections;
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

import { shortcutModifier } from "./editor-commands";
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
    ["↑ / ↓", t`Move through the note list`],
    [`${modifier} F`, t`Find in note`],
    [`${modifier} B / I`, t`Bold or italic`],
    [`${modifier} K`, t`Add a link, in the note text`],
    ["/", t`Markdown commands`],
    ["Alt ← / →", t`Back or forward`],
    ["Alt J / K", t`Next or previous note`],
    ["Shift F10", t`Note actions, in the list`],
    ["Esc", t`Exit focus mode`]
  ];
  return <Dialog titleId="shortcut-help-title" className="shortcut-help" onClose={onClose}>
      <header><h2 id="shortcut-help-title"><Trans>Shortcuts</Trans></h2><button className="icon-button" aria-label={t`Close keyboard shortcuts`} onClick={onClose}><X aria-hidden="true" /></button></header>
      <dl>{shortcuts.map(([keys, label]) => <div key={label}><dt>{label}</dt><dd><kbd>{keys}</kbd></dd></div>)}</dl>
  </Dialog>;
}
